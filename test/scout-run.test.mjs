import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { SUBMIT_SCHEMA, fetchOutcomes, progressFromBlock, progressLog, runScoutStep, probeScout, operatorDetail, planAfterSegment, stuckAction, KICK_AFTER_MS, STALL_AFTER_MS } from '../api/_lib/scout.js';
import { runHardMaxUsd, runMaxUsd, DEFAULT_RUN_MAX_USD, DEFAULT_RUN_HARD_MAX_USD } from '../api/_lib/scout-budget.js';
import { fakeDb } from './_fake-db.mjs';

const BRIEF = {
  id: 'b1', lang: 'en', status: 'searching', user_id: 'u1',
  brief: {
    must_haves: ['pool'], deal_breakers: [], nice_to_haves: [],
    budget: { comfortable: 250000, max: 300000, currency: 'USD', financing: null },
    location: { areas: ['Playa del Carmen'], anchors: [] }, purpose: 'invest', timeline: '6 months',
    buyer_profile: {}, lifestyle_words: []
  }
};
const baseRun = (over = {}) => ({
  id: 'r1', brief_id: 'b1', trigger: 'auto', status: 'queued', steps: 0, attempts: 0, started_at: null,
  lease_until: null, messages: [], input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
  web_searches: 0, web_fetches: 0, cost_usd: 0, created_at: new Date().toISOString(), user_id: 'u1', charged: 'credit', ...over
});
const world = (runOver) => fakeDb({ scout_runs: [baseRun(runOver)], buyer_briefs: [{ ...BRIEF }], scout_candidates: [], listings: [] });

const PORTAL_URL = 'https://www.inmuebles24.com/propiedades/casa-1';
const research = (cost = 'low') => ({
  stop_reason: 'pause_turn',
  content: [
    { type: 'text', text: 'Searching the portals.' },
    { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'casa playa del carmen alberca' } },
    { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: PORTAL_URL, title: 'Casa 1' }] }
  ],
  usage: cost === 'huge'
    ? { input_tokens: 250000, output_tokens: 8000, server_tool_use: { web_search_requests: 6 } }
    : { input_tokens: 20000, output_tokens: 800, server_tool_use: { web_search_requests: 2 } }
});
const candidate = (urls) => ({
  proplync_listing_id: null, title: 'Casa con alberca en Gonzalo Guerrero', operation: 'sale', property_type: 'house',
  town: 'Playa del Carmen', neighborhood: 'Gonzalo Guerrero', bedrooms: 3, bathrooms: 2, built_m2: 180, land_m2: null,
  sources: urls.map((u) => ({ url: u, site: 'inmuebles24.com', listed_by: 'Agencia Mar', price: 285000, currency: 'USD' })),
  photos: [], must_haves: [{ item: 'pool', status: 'met', evidence: 'the listing says private pool' }], deal_breakers: [],
  summary: 'Three bedrooms with a private pool.', questions_for_agent: ['Is it still available?']
});
const submission = (urls, notes = 'Searched the portals.') => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 'u1', name: 'submit_candidates', input: { candidates: [candidate(urls)], search_notes: notes } }],
  usage: { input_tokens: 5000, output_tokens: 600 }
});
const proseOnly = () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'I think I found some places.' }], usage: { input_tokens: 3000, output_tokens: 200 } });

/** A client that plays back scripted segments and records exactly what it was asked. */
function fakeClient(script) {
  const calls = [];
  return {
    calls,
    beta: { messages: { stream: (params) => {
      calls.push(params);
      const handlers = [];
      return { on: (ev, fn) => { if (ev === 'contentBlock') handlers.push(fn); }, finalMessage: async () => {
        const next = script.shift();
        if (next instanceof Error) throw next;
        if (!next) throw new Error('script ran out');
        for (const b of next.content || []) handlers.forEach((h) => h(b));
        return next;
      } };
    } } }
  };
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  Object.assign(process.env, vars);
  for (const k of Object.keys(vars)) if (vars[k] === undefined) delete process.env[k];
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
}
const KEY = { ANTHROPIC_API_KEY: 'test-key', SCOUT_RUN_MAX_USD: undefined, SCOUT_RUN_HARD_MAX_USD: undefined, SCOUT_FX_USD_MXN: '18' };

// ---------- pure rules ----------
test('planAfterSegment: results in hand are always taken, whatever the cost', () => {
  assert.deepEqual(planAfterSegment({ stopReason: 'tool_use', hasSubmit: true, costUsd: 99, hardMaxUsd: 6, nudged: false }), { action: 'submit' });
});

test('planAfterSegment: crossing the soft cap mid-research keeps going (this used to end the run with zero candidates)', () => {
  const plan = planAfterSegment({ stopReason: 'pause_turn', hasSubmit: false, costUsd: 3.4, hardMaxUsd: 6, nudged: false });
  assert.deepEqual(plan, { action: 'continue' });
});

test('planAfterSegment: the hard cap fails the run so the buyer is refunded', () => {
  const plan = planAfterSegment({ stopReason: 'pause_turn', hasSubmit: false, costUsd: 6, hardMaxUsd: 6, nudged: false });
  assert.deepEqual(plan, { action: 'fail', reason: 'cost_limit' });
});

test('planAfterSegment: prose gets one nudge, then a failure; refusals and truncation fail', () => {
  const base = { hasSubmit: false, costUsd: 1, hardMaxUsd: 6 };
  assert.deepEqual(planAfterSegment({ ...base, stopReason: 'end_turn', nudged: false }), { action: 'nudge' });
  assert.deepEqual(planAfterSegment({ ...base, stopReason: 'end_turn', nudged: true }), { action: 'fail', reason: 'no_submission' });
  assert.deepEqual(planAfterSegment({ ...base, stopReason: 'refusal', nudged: false }), { action: 'fail', reason: 'refusal' });
  assert.deepEqual(planAfterSegment({ ...base, stopReason: 'max_tokens', nudged: false }), { action: 'fail', reason: 'stopped:max_tokens' });
});

test('limits: soft default 1, hard default 1.5, and the hard cap is never below 1.5x the soft one', () => {
  assert.equal(DEFAULT_RUN_MAX_USD, 1);
  assert.equal(DEFAULT_RUN_HARD_MAX_USD, 1.5);
  assert.equal(runHardMaxUsd({}), 1.5);
  assert.equal(runHardMaxUsd({ SCOUT_RUN_MAX_USD: '10' }), 15);          // a high soft cap drags the hard cap up with it
  assert.equal(runHardMaxUsd({ SCOUT_RUN_HARD_MAX_USD: '1.2' }), 1.5);   // a hard cap set too low is lifted to 1.5x the soft cap, not obeyed
  assert.equal(runMaxUsd({ SCOUT_RUN_MAX_USD: 'oops' }), 1);
});

test('stuckAction: a healthy run waits; a lost hand-off is kicked; a dead run fails', () => {
  const now = Date.now();
  const iso = (ms) => new Date(now + ms).toISOString();
  const run = (o) => ({ status: 'running', created_at: iso(-60000), lease_until: null, ...o });
  assert.equal(stuckAction(null, now), 'none');
  assert.equal(stuckAction(run({ status: 'done' }), now), 'none');
  assert.equal(stuckAction(run({ created_at: iso(-10000) }), now), 'wait');                       // brand new
  assert.equal(stuckAction(run({ lease_until: iso(200000) }), now), 'wait');                      // a segment is working
  assert.equal(stuckAction(run({ lease_until: iso(-5000) }), now), 'wait');                       // lease only just ended
  assert.equal(stuckAction(run({ lease_until: iso(-60000) }), now), 'kick');                      // the segment died
  assert.equal(stuckAction(run({ created_at: iso(-(KICK_AFTER_MS + 1000)) }), now), 'kick');      // nobody picked it up
  assert.equal(stuckAction(run({ status: 'queued', created_at: iso(-(STALL_AFTER_MS + 1000)) }), now), 'fail');
});

// ---------- the run loop, end to end ----------
test('a normal run: research, then submit; candidates are stored and an invented link is dropped', async () => {
  await withEnv(KEY, async () => {
    const { db, from } = world();
    const client = fakeClient([research(), submission([PORTAL_URL, 'https://made-up.example.com/never-seen'])]);

    const first = await runScoutStep({ from }, 'r1', { client });
    assert.equal(first.state, 'continue');
    assert.equal(db.scout_runs[0].status, 'running');
    assert.equal(db.scout_runs[0].lease_until, null, 'the lease is released between segments');
    assert.equal(db.scout_runs[0].steps, 1);
    assert.equal(db.scout_runs[0].web_searches, 2);

    const second = await runScoutStep({ from }, 'r1', { client });
    assert.equal(second.state, 'done');
    assert.equal(second.candidates, 1);
    assert.equal(db.scout_runs[0].status, 'done');
    assert.equal(db.buyer_briefs[0].status, 'review');
    assert.equal(db.scout_candidates.length, 1);
    const stored = db.scout_candidates[0];
    assert.equal(stored.run_id, 'r1');
    assert.equal(stored.sources.length, 1, 'only the link Scout actually saw survives');
    assert.equal(stored.sources[0].url, PORTAL_URL);
    assert.match(db.scout_runs[0].search_notes, /1 source link\(s\) dropped/);
    assert.ok(db.scout_runs[0].cost_usd > 0);
  });
});

test('past the soft cap the next segment is told to wrap up, and the run still delivers', async () => {
  await withEnv(KEY, async () => {
    const { db, from } = world({ cost_usd: 3.2, steps: 2, messages: [{ role: 'user', content: 'brief' }, { role: 'assistant', content: research().content }] });
    const client = fakeClient([submission([PORTAL_URL])]);
    const out = await runScoutStep({ from }, 'r1', { client });
    assert.equal(out.state, 'done');
    assert.equal(db.scout_candidates.length, 1);
    const system = client.calls[0].system;
    assert.equal(system.length, 2);
    assert.match(system[1].text, /BUDGET/);
  });
});

test('under the soft cap there is no wrap-up instruction', async () => {
  await withEnv(KEY, async () => {
    const { from } = world({ cost_usd: 0.4 });
    const client = fakeClient([submission([PORTAL_URL])]);
    await runScoutStep({ from }, 'r1', { client });
    assert.equal(client.calls[0].system.length, 1);
  });
});

test('the cost-cap bug: a run that crosses the soft cap mid-research is NOT ended with nothing', async () => {
  await withEnv(KEY, async () => {
    const { db, from } = world();
    const out = await runScoutStep({ from }, 'r1', { client: fakeClient([research('huge')]) });   // about US$1.2 in one segment: over the US$1 soft cap, under the US$1.5 hard cap
    assert.equal(out.state, 'continue');
    assert.notEqual(db.scout_runs[0].status, 'done');
    assert.equal(db.scout_candidates.length, 0);
    assert.ok(db.scout_runs[0].cost_usd >= 1 && db.scout_runs[0].cost_usd < 1.5);
  });
});

test('a run that blows through the hard cap without submitting fails, so it is refunded', async () => {
  await withEnv(KEY, async () => {
    // Cost is recomputed from the cumulative token columns, so seed those (about US$4.8) as production data would be.
    const { db, from } = world({ input_tokens: 1200000, cost_usd: 4.8 });
    const out = await runScoutStep({ from }, 'r1', { client: fakeClient([research('huge')]) });
    assert.equal(out.state, 'failed');
    assert.equal(out.detail, 'cost_limit');
    assert.equal(db.scout_runs[0].status, 'failed');
    assert.equal(db.scout_runs[0].error, 'cost_limit');
    assert.equal(db.buyer_briefs[0].status, 'review');
  });
});

test('prose instead of a submission is nudged once, then fails', async () => {
  await withEnv(KEY, async () => {
    const { db, from } = world();
    const client = fakeClient([proseOnly(), proseOnly()]);
    const first = await runScoutStep({ from }, 'r1', { client });
    assert.equal(first.state, 'continue');
    assert.match(JSON.stringify(db.scout_runs[0].messages), /Research is finished/);
    const second = await runScoutStep({ from }, 'r1', { client });
    assert.equal(second.state, 'failed');
    assert.equal(second.detail, 'no_submission');
    assert.equal(db.scout_runs[0].status, 'failed');
  });
});

test('a refusal fails the run with its category', async () => {
  await withEnv(KEY, async () => {
    const { db, from } = world();
    const out = await runScoutStep({ from }, 'r1', { client: fakeClient([{ stop_reason: 'refusal', stop_details: { category: 'policy' }, content: [], usage: { input_tokens: 10, output_tokens: 1 } }]) });
    assert.equal(out.state, 'failed');
    assert.equal(out.detail, 'refusal:policy');
    assert.equal(db.scout_runs[0].status, 'failed');
  });
});

test('a timeout or overload is retried from the same transcript: nothing is lost, the lease is freed', async () => {
  await withEnv(KEY, async () => {
    const { db, from } = world({ messages: [{ role: 'user', content: 'brief' }], steps: 1 });
    const out = await runScoutStep({ from }, 'r1', { client: fakeClient([new Error('Overloaded')]) });
    assert.equal(out.state, 'retry');
    assert.equal(db.scout_runs[0].lease_until, null);
    assert.equal(db.scout_runs[0].status, 'running');
    assert.equal(db.scout_runs[0].steps, 1, 'a failed segment does not count as a completed step');
    assert.equal(db.scout_runs[0].messages.length, 1);
    assert.ok(db.scout_runs[0].error);
  });
});

test('a bad or revoked API key fails the run at once instead of retrying forever', async () => {
  await withEnv(KEY, async () => {
    const { db, from } = world();
    const authError = Object.assign(Object.create(Anthropic.AuthenticationError.prototype), { message: '401 invalid x-api-key' });
    const out = await runScoutStep({ from }, 'r1', { client: fakeClient([authError]) });
    assert.equal(out.state, 'failed');
    assert.equal(db.scout_runs[0].status, 'failed');
  });
});

test('two workers cannot run the same segment: the second gets "busy"', async () => {
  await withEnv(KEY, async () => {
    const { from } = world();
    let release;
    const slow = { beta: { messages: { stream: () => ({ finalMessage: () => new Promise((r) => { release = () => r(research()); }) }) } } };
    const firstRun = runScoutStep({ from }, 'r1', { client: slow });
    await new Promise((r) => setTimeout(r, 20));
    const second = await runScoutStep({ from }, 'r1', { client: fakeClient([research()]) });
    assert.equal(second.state, 'busy');
    release();
    assert.equal((await firstRun).state, 'continue');
  });
});

test('a run past its step limit fails instead of looping', async () => {
  await withEnv(KEY, async () => {
    const { db, from } = world({ steps: 5 });
    const out = await runScoutStep({ from }, 'r1', { client: fakeClient([research()]) });
    assert.equal(out.state, 'failed');
    assert.equal(out.detail, 'step_limit');
    assert.equal(db.scout_runs[0].status, 'failed');
  });
});

test('without an Anthropic key Scout says so and does nothing', async () => {
  await withEnv({ ...KEY, ANTHROPIC_API_KEY: undefined }, async () => {
    const { db, from } = world();
    const out = await runScoutStep({ from }, 'r1', { client: fakeClient([]) });
    assert.deepEqual(out, { state: 'failed', detail: 'scout_unconfigured' });
    assert.equal(db.scout_runs[0].status, 'queued');
  });
});

// ---------- seeing why a run failed ----------
const rejection = (status, type, message) => Object.assign(Object.create(Anthropic.BadRequestError.prototype), {
  status, message: `${status} ${message}`, error: { type: 'error', error: { type, message } }
});

test('operatorDetail keeps the provider\'s status, type and message (the generic sentence hid three failed runs)', () => {
  const d = operatorDetail(rejection(400, 'invalid_request_error', 'fallbacks: unknown field'));
  assert.match(d, /^HTTP 400 invalid_request_error: /);
  assert.match(d, /unknown field/);
  assert.equal(/contact support/i.test(d), false);
  assert.ok(operatorDetail(new Error('x'.repeat(2000))).length <= 400, 'capped');
  assert.ok(operatorDetail(undefined).length > 0);
});

test('a rejected request fails the run AND records the real reason for the operator', async () => {
  await withEnv(KEY, async () => {
    const { db, from } = world();
    const out = await runScoutStep({ from }, 'r1', { client: fakeClient([rejection(400, 'invalid_request_error', 'output_config.effort: not supported for this model')]) });
    assert.equal(out.state, 'failed');
    assert.equal(db.scout_runs[0].status, 'failed');
    assert.match(db.scout_runs[0].error, /output_config\.effort: not supported/);
  });
});

test('a retried (transient) failure also records its real reason', async () => {
  await withEnv(KEY, async () => {
    const { db, from } = world({ messages: [{ role: 'user', content: 'brief' }], steps: 1 });
    await runScoutStep({ from }, 'r1', { client: fakeClient([new Error('Overloaded: try again')]) });
    assert.match(db.scout_runs[0].error, /Overloaded: try again/);
  });
});

test('the probe sends the same request a real segment sends, with a tiny output cap', async () => {
  await withEnv(KEY, async () => {
    const seen = [];
    const client = { beta: { messages: { create: async (p) => { seen.push(p); return { stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } }; } } } };
    const real = fakeClient([submission([PORTAL_URL])]);
    const { from } = world({ messages: [{ role: 'user', content: 'brief' }] });
    await runScoutStep({ from }, 'r1', { client: real });
    const out = await probeScout({ client });
    assert.equal(out.ok, true);
    assert.equal(seen[0].max_tokens, 64);
    for (const k of ['model', 'tools', 'output_config', 'betas', 'fallbacks', 'cache_control', 'system']) {
      assert.deepEqual(seen[0][k], real.calls[0][k], `${k} must match what a real segment sends`);
    }
  });
});

test('the probe reports Anthropic\'s own words when the request is rejected', async () => {
  const client = { beta: { messages: { create: async () => { throw rejection(400, 'invalid_request_error', 'tools.2.strict: not allowed'); } } } };
  const out = await probeScout({ client });
  assert.equal(out.ok, false);
  assert.match(out.detail, /HTTP 400 invalid_request_error: .*tools\.2\.strict/);
});

test('the probe says so when there is no key', async () => {
  await withEnv({ ANTHROPIC_API_KEY: undefined }, async () => {
    const out = await probeScout();
    assert.equal(out.ok, false);
    assert.match(out.detail, /ANTHROPIC_API_KEY is not set/);
  });
});

test('Scout\'s first request carries everything Concierge captured: areas, budget, must-haves, purpose and language', async () => {
  await withEnv(KEY, async () => {
    const { from } = world();   // a queued run with no transcript yet: the first segment builds it from the brief
    const client = fakeClient([submission([PORTAL_URL])]);
    await runScoutStep({ from }, 'r1', { client });
    const first = client.calls[0].messages[0];
    assert.equal(first.role, 'user');
    const text = first.content;
    assert.match(text, /Buyer language: English/);
    const sent = JSON.parse(text.slice(text.indexOf('<brief>') + 7, text.indexOf('</brief>')));
    assert.deepEqual(sent, BRIEF.brief, 'the brief reaches Scout exactly as Concierge saved it');
    for (const needle of ['Playa del Carmen', '300000', 'pool', 'invest']) assert.ok(text.includes(needle), needle);
  });
});

test('submit_candidates schema stays under Anthropic\'s limit of 16 union-typed fields', () => {
  let unions = 0;
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n.anyOf) || Array.isArray(n.type)) unions++;
    Object.values(n).forEach(walk);
  };
  walk(SUBMIT_SCHEMA);
  assert.ok(unions <= 12, `${unions} union-typed fields; Anthropic rejects more than 16 with HTTP 400, keep a margin`);
});

test('progressFromBlock turns streamed blocks into short, safe events', () => {
  const ctx = {};
  assert.deepEqual(
    (({ at, ...e }) => e)(progressFromBlock({ type: 'server_tool_use', name: 'web_search', input: { query: '  casa   tulum\n2 recamaras ' } }, ctx)),
    { k: 'search', q: 'casa tulum 2 recamaras' });
  const results = progressFromBlock({ type: 'web_search_tool_result', content: [
    { url: 'https://www.inmuebles24.com/a' }, { url: 'https://inmuebles24.com/b' }, { url: 'https://lamudi.com.mx/c' }, { url: 'not a url' }] }, ctx);
  assert.equal(results.n, 4);
  assert.deepEqual(results.sites, ['inmuebles24.com', 'lamudi.com.mx']);
  assert.equal(progressFromBlock({ type: 'server_tool_use', name: 'web_fetch', input: { url: 'https://www.sienteei.com/p/1' } }, ctx).host, 'sienteei.com');
  const page = progressFromBlock({ type: 'web_fetch_tool_result', content: { type: 'web_fetch_result', url: 'https://www.sienteei.com/p/1', content: { title: 'Departamento <b>3</b>' } } }, ctx);
  assert.equal(page.k, 'page');
  assert.equal(page.host, 'sienteei.com');
  // a refused fetch carries no URL: the last host opened names it
  progressFromBlock({ type: 'server_tool_use', name: 'web_fetch', input: { url: 'https://departamento.mercadolibre.com.mx/MLM-1' } }, ctx);
  const refused = progressFromBlock({ type: 'web_fetch_tool_result', content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_allowed' } }, ctx);
  assert.deepEqual([refused.k, refused.host], ['skipped', 'departamento.mercadolibre.com.mx']);
  // thinking, prose and code execution are not shown
  assert.equal(progressFromBlock({ type: 'text', text: 'hola' }, ctx), null);
  assert.equal(progressFromBlock({ type: 'server_tool_use', name: 'code_execution', input: {} }, ctx), null);
  assert.equal(progressFromBlock(null, ctx), null);
});

test('progressLog drops immediate repeats, keeps the last 40 and writes to the run', async () => {
  const { db, from } = world();
  const svc = { from };
  const log = progressLog(svc, 'r1', []);
  log.add({ k: 'search', q: 'a' });
  log.add({ k: 'search', q: 'a' });
  assert.equal(log.events().length, 1, 'the same step twice in a row is shown once');
  for (let i = 0; i < 60; i++) log.add({ k: 'search', q: 'q' + i });
  assert.equal(log.events().length, 40);
  assert.equal(log.events()[39].q, 'q59');
  await log.flush();
  assert.equal(db.scout_runs[0].progress.length, 40);
});

test('a segment records what it searched and read, and tells the buyer', async () => {
  await withEnv(KEY, async () => {
  const { db, from } = world({ messages: [{ role: 'user', content: 'brief' }], steps: 1 });
  const client = fakeClient([{
    stop_reason: 'tool_use',
    content: [
      { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'casa playa del carmen alberca' } },
      { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: PORTAL_URL, title: 'Casa 1' }] },
      { type: 'tool_use', id: 'u1', name: 'submit_candidates', input: { candidates: [candidate([PORTAL_URL])], search_notes: 'ok' } }
    ],
    usage: { input_tokens: 5000, output_tokens: 600 }
  }]);
  const out = await runScoutStep({ from }, 'r1', { client });
  assert.equal(out.state, 'done');
  assert.deepEqual(db.scout_runs[0].progress.map((e) => e.k), ['search', 'results']);
  assert.equal(db.scout_runs[0].progress[0].q, 'casa playa del carmen alberca');
  });
});

test('Scout may not repeat itself, and its allowances are the ones we planned', async () => {
  await withEnv(KEY, async () => {
  const { from } = world();
  const client = fakeClient([submission([PORTAL_URL])]);
  await runScoutStep({ from }, 'r1', { client });
  const sent = client.calls[0];
  const search = sent.tools.find((t) => t.name === 'web_search');
  const fetch = sent.tools.find((t) => t.name === 'web_fetch');
  assert.equal(search.max_uses, 10);
  assert.equal(fetch.max_uses, 14);
  const system = sent.system.map((b) => b.text).join('\n');
  assert.match(system, /Never run the same query twice/);
  assert.match(system, /Never open an address twice/);
  assert.match(system, /cut after about 3,000 tokens/);
  for (const site of ['mercadolibre.com.mx', 'lamudi.com.mx', 'vivanuncios.com.mx', 'inmuebles24.com']) {
    assert.ok(fetch.blocked_domains.includes(site), site + ' is refused by fetch, so do not spend an open on it');
    assert.ok(!search.blocked_domains.includes(site), site + ' must stay searchable: its snippets are valid sources');
  }
  });
});

test('a rerun does not store a listing the brief already holds', async () => {
  await withEnv(KEY, async () => {
    const { db, from } = world({ messages: [{ role: 'user', content: 'brief' }], steps: 1 });
    // an earlier run of this brief already stored this very listing
    db.scout_candidates.push({ id: 'old1', run_id: 'r0', brief_id: 'b1', listing_public_id: null, town: 'Playa del Carmen', neighborhood: 'Gonzalo Guerrero',
      operation: 'sale', bedrooms: 3, built_m2: 180, verification: 'rejected', sources: [{ url: PORTAL_URL, price: 285000, currency: 'USD' }] });
    const out = await runScoutStep({ from }, 'r1', { client: fakeClient([research(), submission([PORTAL_URL])]) });
    assert.equal(out.state, 'continue');
    const second = await runScoutStep({ from }, 'r1', { client: fakeClient([submission([PORTAL_URL])]) });
    assert.equal(second.state, 'done');
    assert.equal(second.candidates, 0, 'nothing new to add');
    assert.equal(db.scout_candidates.length, 1, 'the rejected one is not brought back as a new card');
    assert.match(db.scout_runs[0].search_notes, /already found in an earlier search/);
  });
});

test('the refused-site list: bare domains, in the prompt, fetch-only, and never a site that has opened', async () => {
  await withEnv(KEY, async () => {
    const { from } = world();
    const client = fakeClient([submission([PORTAL_URL])]);
    await runScoutStep({ from }, 'r1', { client });
    const sent = client.calls[0];
    const search = sent.tools.find((t) => t.name === 'web_search');
    const fetch = sent.tools.find((t) => t.name === 'web_fetch');
    const refused = fetch.blocked_domains.filter((d) => !search.blocked_domains.includes(d));
    assert.ok(refused.length >= 10, 'the evidence-based list is in place');
    const system = sent.system.map((b) => b.text).join('\n');
    for (const d of refused) {
      assert.match(d, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, d + ' is a bare domain: no scheme, no path');
      assert.ok(system.includes(d), d + ' is named in the prompt, so Scout does not spend an open on it');
    }
    // these opened in every real run: they must never end up on the list
    for (const ok of ['propiedades.com', 'bestcaribbeanproperty.com', 'sienteei.com', 'hausrealestate.com.mx', 'selvacorealty.com', 'mudafy.com.mx']) {
      assert.ok(!fetch.blocked_domains.includes(ok), ok + ' opens fine, do not block it');
    }
  });
});

test('fetchOutcomes tallies, per site, the opens that worked and the ones that failed, with the error code', () => {
  const run = (url, id, content) => [
    { role: 'assistant', content: [
      { type: 'server_tool_use', id, name: 'web_fetch', input: { url } },
      { type: 'web_fetch_tool_result', tool_use_id: id, content }
    ] }
  ];
  const ok = { type: 'web_fetch_result', url: 'x', content: {} };
  const tally = new Map();
  fetchOutcomes(run('https://www.propiedades.com/a', 't1', ok), tally);
  fetchOutcomes(run('https://propiedades.com/b', 't2', ok), tally);
  fetchOutcomes(run('https://www.lamudi.com.mx/x', 't3', { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' }), tally);
  fetchOutcomes(run('https://www.lamudi.com.mx/y', 't4', { type: 'web_fetch_tool_result_error' }), tally);
  assert.deepEqual([tally.get('propiedades.com').ok, tally.get('propiedades.com').fail], [2, 0]);
  const lamudi = tally.get('lamudi.com.mx');
  assert.deepEqual([lamudi.ok, lamudi.fail], [0, 2]);
  assert.deepEqual([...lamudi.codes].sort(), ['unknown', 'url_not_accessible']);
  assert.equal(fetchOutcomes(null).size, 0, 'a run with no transcript is just empty');
});
