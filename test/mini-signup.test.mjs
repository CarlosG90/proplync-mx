import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMiniSignup, miniSignupOpen, miniListingFields } from '../api/onboard.js';
import { listingLimit, isMiniTrial, planStatus } from '../api/_lib/plans.js';

const OPEN = { MINI_SIGNUP: 'on' };

function fakeRes() {
  return { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
}

/* A stand-in for the service client: records writes, answers the member lookup. */
function fakeSvc({ user = { id: 'u1' }, member = null } = {}) {
  const writes = { updates: [], inserts: [] };
  const chain = (table) => {
    const q = {
      select() { return q; }, eq() { return q; }, limit() { return q; },
      maybeSingle: async () => ({ data: table === 'agency_members' ? member : null }),
      update(v) { writes.updates.push({ table, v }); return { eq: async () => ({ error: null }) }; },
      insert: async (rows) => { writes.inserts.push({ table, rows }); return { error: null }; }
    };
    return q;
  };
  return {
    writes,
    auth: { getUser: async (token) => (token === 'good' && user ? { data: { user }, error: null } : { data: null, error: new Error('bad') }) },
    from: chain
  };
}

const req = (body, token = 'good') => ({
  method: 'POST', query: { action: 'mini' }, body, socket: { remoteAddress: '127.0.0.1' },
  headers: token ? { authorization: 'Bearer ' + token } : {}
});
const listing = (over = {}) => ({ title: 'Casa en Centro', town: 'Leon', amount: 3450000, currency: 'MXN', operation: 'sale', bedrooms: 3, ...over });
const body = (over = {}) => ({ agencyName: 'Nadia Dominguez', whatsapp_number: '+52 998 123 4567', listings: [listing()], ...over });
const provision = async () => ({ id: 'a1', slug: 'nadia-dominguez', plan: 'mini' });

test('closed by default: MINI_SIGNUP must be "on"', () => {
  assert.equal(miniSignupOpen({}), false);
  assert.equal(miniSignupOpen({ MINI_SIGNUP: 'off' }), false);
  assert.equal(miniSignupOpen({ MINI_SIGNUP: 'ON' }), true);
});

test('when closed, nothing is read or written', async () => {
  const svc = fakeSvc(); const res = fakeRes();
  await handleMiniSignup(req(body()), res, { env: {}, svc, provisionAgency: provision });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'mini_closed');
  assert.equal(svc.writes.inserts.length + svc.writes.updates.length, 0);
});

test('a proven email is required (no session, no page)', async () => {
  const res = fakeRes();
  await handleMiniSignup(req(body(), null), res, { env: OPEN, svc: fakeSvc(), provisionAgency: provision });
  assert.equal(res.statusCode, 401);
});

test('bad input is refused before anything is created', async () => {
  for (const [b, code] of [
    [body({ agencyName: '' }), 'missing_agency_name'],
    [body({ whatsapp_number: 'llamame' }), 'invalid_whatsapp_number'],
    [body({ listings: [] }), 'no_listings'],
    [body({ listings: [listing({ currency: '' })] }), 'invalid_currency'],
    [body({ listings: [listing({ title: ' ' })] }), 'missing_title']
  ]) {
    const svc = fakeSvc(); const res = fakeRes();
    await handleMiniSignup(req(b), res, { env: OPEN, svc, provisionAgency: provision });
    assert.equal(res.statusCode, 400, code);
    assert.equal(res.body.error, code);
    assert.equal(svc.writes.inserts.length, 0);
  }
});

test('one agency per account: an existing member goes to their dashboard', async () => {
  const svc = fakeSvc({ member: { agency_id: 'a0' } }); const res = fakeRes();
  await handleMiniSignup(req(body()), res, { env: OPEN, svc, provisionAgency: provision });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'already_has_agency');
});

test('success: a mini trial that expires in 30 days, with at most 3 published listings', async () => {
  const svc = fakeSvc(); const res = fakeRes();
  let provisioned = null;
  const many = Array.from({ length: 5 }, (_, i) => listing({ title: 'Casa ' + i }));
  await handleMiniSignup(req(body({ listings: many })), res, {
    env: OPEN, svc, provisionAgency: async (_svc, args) => { provisioned = args; return provision(); }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.slug, 'nadia-dominguez');
  assert.equal(res.body.published, 3);
  assert.equal(provisioned.plan, 'mini');
  assert.equal(provisioned.userId, 'u1');
  const up = svc.writes.updates.find((w) => w.table === 'agencies').v;
  const days = (Date.parse(up.plan_expires_at) - Date.now()) / 86400000;
  assert.ok(days > 29.9 && days <= 30, 'about 30 days');
  assert.equal(up.whatsapp_number, '+52 998 123 4567');
  const rows = svc.writes.inserts.find((w) => w.table === 'listings').rows;
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.agency_id === 'a1' && r.status === 'published'));
});

test('listing fields go through the dashboard rules', () => {
  const f = miniListingFields(listing({ features: 'alberca, roof, ', operation: 'rental', currency: 'usd' }));
  assert.equal(f.title_es, 'Casa en Centro');
  assert.deepEqual(f.features, ['alberca', 'roof']);
  assert.equal(f.operation, 'rental');
  assert.equal(f.currency, 'USD');
  assert.throws(() => miniListingFields(listing({ amount: 'mucho' })), /invalid_amount/);
});

// ---------- the trial cap (plans.js) ----------

test('a mini trial allows 3 listings; a paid mini 10; other plans unchanged', () => {
  const trial = { plan: 'mini', plan_expires_at: '2026-12-13T00:00:00Z' };
  assert.equal(isMiniTrial(trial), true);
  assert.equal(listingLimit(trial), 3);
  assert.equal(listingLimit({ plan: 'mini', plan_expires_at: null }), 10);
  assert.equal(listingLimit({ plan: 'free' }), 10);
  assert.equal(listingLimit({ plan: 'pro', plan_expires_at: '2026-12-13T00:00:00Z' }), Infinity, 'only mini has a trial');
  const s = planStatus(trial, 3);
  assert.equal(s.listingsLimit, 3);
  assert.equal(s.atListingLimit, true);
  assert.equal(s.trial.endsAt, trial.plan_expires_at);
  assert.equal(planStatus({ plan: 'pro' }, 1).trial, null);
});
