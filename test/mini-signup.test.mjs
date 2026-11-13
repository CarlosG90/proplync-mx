import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMiniSignup, miniSignupOpen, miniListingFields } from '../api/onboard.js';
import { listingLimit, planStatus } from '../api/_lib/plans.js';

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
const quiet = async () => ({ sent: false });   // the operator alert, stubbed

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

test('success: nothing public before payment — page not paid, up to 10 listings saved as drafts, operator told', async () => {
  const svc = fakeSvc(); const res = fakeRes();
  let provisioned = null; let alert = null;
  const many = Array.from({ length: 12 }, (_, i) => listing({ title: 'Casa ' + i }));
  await handleMiniSignup(req(body({ listings: many })), res, {
    env: OPEN, svc,
    provisionAgency: async (_svc, args) => { provisioned = args; return provision(); },
    notifyOperator: async (m) => { alert = m; return { sent: true }; }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.slug, 'nadia-dominguez');
  assert.equal(res.body.status, 'pending_payment');
  assert.equal(res.body.saved, 10);
  assert.equal(res.body.price_mxn, 249);
  assert.equal(provisioned.plan, 'mini');
  assert.equal(provisioned.userId, 'u1');
  const up = svc.writes.updates.find((w) => w.table === 'agencies').v;
  assert.equal(up.plan_expires_at, null, 'not paid: no live period');
  assert.equal(up.whatsapp_number, '+52 998 123 4567');
  const rows = svc.writes.inserts.find((w) => w.table === 'listings').rows;
  assert.equal(rows.length, 10);
  assert.ok(rows.every((r) => r.agency_id === 'a1' && r.status === 'draft'));
  assert.match(alert.subject, /cobrar/);
  assert.match(alert.text, /scripts\/mini\.mjs activate nadia-dominguez/);
});

test('a failed operator alert never fails the signup', async () => {
  const res = fakeRes();
  await handleMiniSignup(req(body()), res, { env: OPEN, svc: fakeSvc(), provisionAgency: provision, notifyOperator: async () => { throw new Error('resend down'); } });
  assert.equal(res.statusCode, 200);
});

test('listing fields go through the dashboard rules', () => {
  const f = miniListingFields(listing({ features: 'alberca, roof, ', operation: 'rental', currency: 'usd' }));
  assert.equal(f.title_es, 'Casa en Centro');
  assert.deepEqual(f.features, ['alberca', 'roof']);
  assert.equal(f.operation, 'rental');
  assert.equal(f.currency, 'USD');
  assert.throws(() => miniListingFields(listing({ amount: 'mucho' })), /invalid_amount/);
});

// ---------- the Mini cap and state (plans.js) ----------

test('a Mini page holds 10 listings, paid or not; other plans unchanged', () => {
  assert.equal(listingLimit({ plan: 'mini', plan_expires_at: null }), 10);
  assert.equal(listingLimit({ plan: 'mini', plan_expires_at: '2027-01-01T00:00:00Z' }), 10);
  assert.equal(listingLimit({ plan: 'pro' }), Infinity);
  const s = planStatus({ plan: 'mini', plan_expires_at: null }, 4);
  assert.equal(s.listingsLimit, 10);
  assert.equal(s.mini.state, 'pending');
  assert.equal(planStatus({ plan: 'pro' }, 1).mini, null);
});
