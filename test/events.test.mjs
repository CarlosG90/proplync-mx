import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/leads.js';
import { buildFunnel, BUYER_STAGES, AGENT_STAGES } from '../api/_lib/funnel.js';

function run(body, method = 'POST') {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, setHeader() {},
      status(c) { this.statusCode = c; return this; },
      json(o) { resolve({ status: this.statusCode, body: o }); return this; },
      end() { resolve({ status: this.statusCode, body: null }); }
    };
    handler({ method, query: { action: 'event' }, body, headers: {}, socket: {} }, res);
  });
}

/* supabase-js talks to PostgREST over fetch, so a fake fetch lets us read exactly what would be stored. */
async function send(body, dbStatus = 201) {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
  const real = globalThis.fetch;
  let stored = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/rest/v1/events')) {
      stored = JSON.parse(init.body);
      return dbStatus < 300
        ? new Response('[]', { status: dbStatus, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ code: '42P01', message: 'relation "events" does not exist' }), { status: dbStatus, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200 });
  };
  try { return { r: await run(body), stored }; } finally { globalThis.fetch = real; }
}

const GOOD = { name: 'concierge_start', page: 'invest', session: 'a1b2c3d4e5f6a1b2c3d4e5f6', lang: 'es' };

test('event: a good event is stored with exactly the anonymous fields', async () => {
  const { r, stored } = await send({ ...GOOD, utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'invest-test', ref_host: 'www.google.com', props: { button: 'hero_start_search' } });
  assert.equal(r.status, 202);
  assert.deepEqual(r.body, { ok: true });
  assert.deepEqual(stored, {
    name: 'concierge_start', page: 'invest', session: 'a1b2c3d4e5f6a1b2c3d4e5f6', lang: 'es',
    utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'invest-test', ref_host: 'www.google.com', props: { button: 'hero_start_search' }
  });
});

test('event: only the funnel events are accepted, so the table cannot be filled with arbitrary names', async () => {
  const { r, stored } = await send({ ...GOOD, name: 'drop_table_events' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'unknown_event');
  assert.equal(stored, null);
  assert.equal((await send({ ...GOOD, name: undefined })).r.status, 400);
});

test('event: a malformed session id is rejected (it must be the random id the page made)', async () => {
  for (const session of ['', 'short', 'HAS CAPS AND SPACES', 'a'.repeat(41), 'ok-but; drop table', undefined]) {
    const { r, stored } = await send({ ...GOOD, session });
    assert.equal(r.status, 400, String(session));
    assert.equal(r.body.error, 'invalid_session');
    assert.equal(stored, null);
  }
});

test('event: contact data can never be stored, even if a page sends it by mistake', async () => {
  const { stored } = await send({ ...GOOD, props: {
    button: 'hero', email: 'ana@example.com', note: 'call me on 9841234567', ok_number: 3, ok_flag: true,
    contact: 'ana@example.com', nested: { a: 1 }, list: [1, 2], Bad_Key: 'x', page: 'sneaky'
  } });
  assert.deepEqual(stored.props, { button: 'hero', ok_number: 3, ok_flag: true });
  assert.equal(JSON.stringify(stored).includes('@'), false);
  assert.equal(JSON.stringify(stored).includes('9841234567'), false);
});

test('event: properties are capped (8 keys, 100 characters)', async () => {
  const many = Object.fromEntries('abcdefghijkl'.split('').map((k) => [k, 'v']));
  assert.equal(Object.keys((await send({ ...GOOD, props: many })).stored.props).length, 8);
  assert.equal((await send({ ...GOOD, props: { long: 'x'.repeat(500) } })).stored.props.long.length, 100);
});

test('event: odd campaign tags, hosts, languages and pages are dropped, not stored', async () => {
  const { stored } = await send({ ...GOOD, page: 'Not A Page!', lang: 'fr', utm_source: '<script>', utm_medium: 'x'.repeat(200), utm_campaign: 'spring sale', ref_host: 'evil.com/path?x=1' });
  assert.equal(stored.page, 'unknown');
  assert.equal(stored.lang, null);
  assert.equal(stored.utm_source, null);
  assert.equal(stored.utm_medium, null);
  assert.equal(stored.utm_campaign, 'spring sale');
  assert.equal(stored.ref_host, null);
});

test('event: a database failure answers 500, never a fake success', async () => {
  const { r } = await send(GOOD, 404);
  assert.equal(r.status, 500);
  assert.equal(r.body.error, 'event_failed');
});

test('event: only POST is accepted', async () => {
  const r = await run(GOOD, 'GET');
  assert.notEqual(r.status, 202);
});

// ---- the funnel ----
test('funnel: each step shows its share of the step before and of the first', () => {
  const rows = [
    { name: 'landing_view', sessions: 200 }, { name: 'concierge_start', sessions: 50 }, { name: 'concierge_complete', sessions: 20 },
    { name: 'brief_approved', sessions: 10 }, { name: 'scout_result_viewed', sessions: 9 }, { name: 'verification_requested', sessions: 3 }
  ];
  const f = buildFunnel(rows, BUYER_STAGES);
  assert.deepEqual(f.map((s) => s.sessions), [200, 50, 20, 10, 9, 3]);
  assert.equal(f[0].of_previous, null);
  assert.equal(f[1].of_previous, 25);
  assert.equal(f[2].of_previous, 40);
  assert.equal(f[5].of_previous, 33.3);
  assert.equal(f[5].of_first, 1.5);
});

test('funnel: an empty table or a missing stage shows zeros, never NaN or a crash', () => {
  const none = buildFunnel([], BUYER_STAGES);
  assert.ok(none.every((s) => s.sessions === 0));
  assert.ok(none.slice(1).every((s) => s.of_previous === null && s.of_first === null));
  const gap = buildFunnel([{ name: 'landing_view', sessions: 10 }, { name: 'agent_request_sent', sessions: 2 }], AGENT_STAGES);
  assert.equal(gap[1].sessions, 0);
  assert.equal(gap[2].sessions, 2);
  assert.equal(gap[2].of_previous, null, 'no divide by zero when the step before has none');
  assert.equal(gap[2].of_first, 20);
});
