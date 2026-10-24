import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectHealth, doctorToken } from '../api/_lib/health-check.js';
import { PRIMARY_MODEL, FALLBACK_MODEL } from '../api/_lib/groq.js';
import { NVIDIA_MODEL } from '../api/_lib/nvidia-concierge.js';
import { SCOUT_MODEL } from '../api/_lib/scout.js';
import { EXTRACT_MODEL } from '../api/extract.js';

const json = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj });
const HEALTHY_FETCH = async (url) => String(url).includes('nvidia')
  ? json({ data: [{ id: NVIDIA_MODEL }, { id: 'other/model' }] })
  : json({ data: [{ id: PRIMARY_MODEL }, { id: FALLBACK_MODEL }, { id: 'whisper-large-v3' }] });

function stubSvc(cfg = {}) {
  return { from(table) {
    const state = { head: false, count: false, cols: '' };
    const q = {
      select(cols, opts) { state.cols = cols || ''; state.head = Boolean(opts && opts.head); state.count = Boolean(opts && opts.count); return q; },
      in() { return q; }, gte() { return q; }, limit() { return q; }, eq() { return q; }, order() { return q; },
      then(res, rej) {
        let out;
        if ((cfg.missing || []).includes(table)) out = { data: null, count: null, error: { code: '42P01', message: 'relation does not exist' } };
        else if (state.count) out = { data: [], count: (cfg.counts || {})[table] ?? 5, error: null };
        else if (table === 'scout_runs' && state.cols.includes('created_at, error')) out = { data: cfg.failedRuns || [], error: null };
        else if (table === 'scout_runs' && state.cols.includes('lease_until')) out = { data: cfg.active || [], error: null };
        else out = { data: cfg.costRows || [], error: null };
        return Promise.resolve(out).then(res, rej);
      }
    };
    return q;
  } };
}

const ENV = { ANTHROPIC_API_KEY: 'sk-secret-anthropic', NVIDIA_API_KEY: 'nv-secret', GROQ_API_KEY: 'gq-secret', SCOUT_STEP_SECRET: 'step-secret', KV_REST_API_URL: 'x' };
const okAnthropic = async () => ({ configured: true, ok: true, model: SCOUT_MODEL });
const base = (over = {}) => ({ env: ENV, svc: stubSvc(), checkAnthropic: okAnthropic, scoutCanRun: true, stepOriginSet: true, dailyCap: 5, fetchImpl: HEALTHY_FETCH, ...over });

test('everything in place: ok, no problems, and the only note is about email', async () => {
  const r = await collectHealth(base());
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
  assert.ok(r.notes.some((n) => /Nobody is emailed/.test(n)));
  assert.equal(r.providers.nvidia.listed, true);
  assert.equal(r.scout.can_start_runs, true);
  assert.deepEqual(r.scout.limits, { run_soft_cap_usd: 3, run_hard_cap_usd: 6, monthly_budget_usd: 50, daily_run_cap: 5 });
});

test('the report never contains a secret', async () => {
  const text = JSON.stringify(await collectHealth(base()));
  for (const secret of ['sk-secret-anthropic', 'nv-secret', 'gq-secret', 'step-secret']) assert.equal(text.includes(secret), false, secret);
});

test('with email configured there is no email note', async () => {
  const r = await collectHealth(base({ env: { ...ENV, RESEND_API_KEY: 'r', LEAD_NOTIFY_FROM: 'a@b.co', OPERATOR_EMAIL: 'me@b.co' } }));
  assert.equal(r.notes.some((n) => /Nobody is emailed/.test(n)), false);
});

test('migration 013 not applied is a problem that says what to do', async () => {
  const r = await collectHealth(base({ svc: stubSvc({ missing: ['contact_requests'] }) }));
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /Migration 013 is not applied/.test(p)));
});

test('a retired NVIDIA model is a note (Groq covers), not an outage', async () => {
  const r = await collectHealth(base({ fetchImpl: async (u) => String(u).includes('nvidia') ? json({ data: [{ id: 'some/other-model' }] }) : HEALTHY_FETCH(u) }));
  assert.equal(r.providers.nvidia.ok, false);
  assert.equal(r.ok, true);
  assert.ok(r.notes.some((n) => /Concierge will use Groq only/.test(n)));
});

test('both Concierge providers down is a problem', async () => {
  const r = await collectHealth(base({ fetchImpl: async () => json({}, 401) }));
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /no working provider/.test(p)));
});

test('a provider that throws is reported, and does not stop the other checks', async () => {
  const r = await collectHealth(base({ fetchImpl: async (u) => { if (String(u).includes('groq')) throw new Error('network down'); return HEALTHY_FETCH(u); } }));
  assert.equal(r.providers.groq.ok, false);
  assert.equal(r.providers.nvidia.ok, true);
  assert.equal(r.database.tables.buyer_briefs.exists, true);
});

test('Scout cannot research without a working Anthropic key', async () => {
  const r = await collectHealth(base({ checkAnthropic: async () => ({ configured: true, ok: false, model: SCOUT_MODEL, detail: 'authentication failed' }) }));
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /Scout cannot research: authentication failed/.test(p)));
});

test('a missing speech model means voice notes will fail, and says so', async () => {
  const r = await collectHealth(base({ fetchImpl: async (u) => String(u).includes('nvidia') ? HEALTHY_FETCH(u) : json({ data: [{ id: PRIMARY_MODEL }, { id: FALLBACK_MODEL }] }) }));
  assert.ok(r.problems.some((p) => /Voice notes will fail/.test(p)));
});

test('Scout configured but unable to start runs is a problem', async () => {
  const r = await collectHealth(base({ scoutCanRun: false }));
  assert.ok(r.problems.some((p) => /cannot start runs/.test(p)));
});

test('a stuck run is reported', async () => {
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const r = await collectHealth(base({ svc: stubSvc({ active: [{ id: 'r1', status: 'running', created_at: old, lease_until: null }] }) }));
  assert.equal(r.database.stuck_runs, 1);
  assert.ok(r.problems.some((p) => /look stuck/.test(p)));
});

test('spending near the monthly budget is flagged before it blocks anyone', async () => {
  const r = await collectHealth(base({ svc: stubSvc({ costRows: [{ cost_usd: 45 }] }) }));
  assert.ok(r.notes.some((n) => /monthly budget/.test(n)));
});

// ---- the real handler: only the operator can ask ----
function call(handler, req) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, body: o }); return this; }, end() { resolve({ status: this.statusCode, body: null }); } };
    handler({ headers: {}, socket: {}, body: {}, ...req }, res);
  });
}

test('handler: health answers 401 without the step secret, and 405 for a POST', async () => {
  process.env.SCOUT_STEP_SECRET = 'real-secret';
  const { default: handler } = await import('../api/finder.js');
  assert.equal((await call(handler, { method: 'GET', query: { action: 'health' } })).status, 401);
  assert.equal((await call(handler, { method: 'GET', query: { action: 'health' }, headers: { 'x-scout-secret': 'wrong' } })).status, 401);
  assert.equal((await call(handler, { method: 'POST', query: { action: 'health' }, headers: { 'x-scout-secret': 'real-secret' } })).status, 405);
});

test('handler: health with the right secret returns a report (provider calls mocked)', async () => {
  process.env.SCOUT_STEP_SECRET = 'real-secret';
  process.env.NVIDIA_API_KEY = 'x'; process.env.GROQ_API_KEY = 'y'; process.env.ANTHROPIC_API_KEY = '';
  process.env.SUPABASE_URL = 'https://example.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('integrate.api.nvidia.com') || u.includes('api.groq.com')) return HEALTHY_FETCH(u);
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json', 'content-range': '*/2' } });
  };
  try {
    const { default: handler } = await import('../api/finder.js');
    const r = await call(handler, { method: 'GET', query: { action: 'health' }, headers: { 'x-scout-secret': 'real-secret' } });
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.ok, 'boolean');
    assert.ok(r.body.providers.nvidia && r.body.providers.groq && r.body.providers.anthropic);
    assert.equal(r.body.providers.anthropic.configured, false);
    assert.ok(r.body.problems.some((p) => /Scout cannot research/.test(p)));
    assert.equal(JSON.stringify(r.body).includes('real-secret'), false);
  } finally { globalThis.fetch = real; }
});

test('handler: the operator can also prove who they are with a hash of the service key, which never travels', async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'the-service-key';
  process.env.SCOUT_STEP_SECRET = 'real-secret';
  const { default: handler } = await import('../api/finder.js');
  const good = doctorToken('the-service-key');
  assert.notEqual(good, 'the-service-key');
  assert.equal((await call(handler, { method: 'GET', query: { action: 'health' }, headers: { 'x-doctor-token': 'nope' } })).status, 401);
  assert.equal((await call(handler, { method: 'GET', query: { action: 'health' }, headers: { 'x-doctor-token': 'the-service-key' } })).status, 401, 'the raw key is not accepted');
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => /nvidia|groq/.test(String(url)) ? HEALTHY_FETCH(String(url)) : new Response('[]', { status: 200, headers: { 'content-type': 'application/json', 'content-range': '*/1' } });
  try {
    assert.equal((await call(handler, { method: 'GET', query: { action: 'health' }, headers: { 'x-doctor-token': good } })).status, 200);
  } finally { globalThis.fetch = real; }
});

test('regression: a missing table is reported missing even when the server answers with an empty 404 (the HEAD trap)', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key';
  const { getServiceClient } = await import('../api/_lib/supabase.js');
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (/nvidia|groq/.test(u)) return HEALTHY_FETCH(u);
    if (u.includes('/rest/v1/contact_requests')) {
      return init && init.method === 'HEAD'
        ? new Response('', { status: 404 })                                                    // what made it look present
        : new Response(JSON.stringify({ code: 'PGRST205', message: 'Could not find the table' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json', 'content-range': '0-0/7' } });
  };
  try {
    const r = await collectHealth(base({ svc: getServiceClient() }));
    assert.equal(r.database.tables.contact_requests.exists, false);
    assert.equal(r.database.tables.buyer_briefs.exists, true);
    assert.equal(r.database.tables.buyer_briefs.rows, 7);
    assert.ok(r.problems.some((p) => /Migration 013 is not applied/.test(p)));
  } finally { globalThis.fetch = real; }
});

test('the extractor uses a different Claude model from Scout, and a retired one is reported as its own problem', async () => {
  assert.notEqual(EXTRACT_MODEL, SCOUT_MODEL);
  const r = await collectHealth(base({
    checkAnthropic: async (models) => models[0] === EXTRACT_MODEL
      ? { configured: true, ok: false, model: EXTRACT_MODEL, detail: `${EXTRACT_MODEL}: not found` }
      : { configured: true, ok: true, model: SCOUT_MODEL }
  }));
  assert.equal(r.providers.anthropic.ok, true, 'Scout is fine');
  assert.ok(r.problems.some((p) => /Listing import from PDFs and photos will fail/.test(p)));
  assert.equal(r.problems.some((p) => /Scout cannot research/.test(p)), false, 'and the message does not blame Scout');
});

test('migration 014 not applied is a problem that says what is lost', async () => {
  const r = await collectHealth(base({ svc: stubSvc({ missing: ['events'] }) }));
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /Migration 014 is not applied/.test(p)));
});

test('a failed Scout run shows its real error in the report, and points to the probe', async () => {
  const failedRuns = [{ id: 'abcdef12-0000-0000-0000-000000000000', created_at: '2026-10-24T16:18:06Z', error: 'HTTP 400 invalid_request_error: bad field' }];
  const r = await collectHealth(base({ svc: stubSvc({ failedRuns }) }));
  assert.equal(r.recent_failures[0].error, 'HTTP 400 invalid_request_error: bad field');
  assert.ok(r.notes.some((n) => /--probe/.test(n)));
  assert.equal(r.scout_request, null);
});

test('with the probe, a rejected real request is a problem that carries the provider\'s words', async () => {
  const r = await collectHealth(base({ probeScout: async () => ({ ok: false, model: SCOUT_MODEL, detail: 'HTTP 400 invalid_request_error: bad field' }) }));
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /rejects Scout's real request: HTTP 400 invalid_request_error: bad field/.test(p)));
});

test('with the probe, an accepted real request is ok and recorded', async () => {
  const r = await collectHealth(base({ probeScout: async () => ({ ok: true, model: SCOUT_MODEL, stop_reason: 'end_turn' }) }));
  assert.equal(r.ok, true);
  assert.equal(r.scout_request.ok, true);
});
