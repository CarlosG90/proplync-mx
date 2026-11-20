/* The separate PropLync Mini project (mini/): its public page renderer, the payment notice,
   and the operator script's notice lookup. Network and database are faked. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';

const { buildModel, renderPage, jsonForScript } = await import('../mini/api/page.js');
const { cleanNotice, handlePaidNotice } = await import('../mini/api/panel.js');
const { latestNoticeByAgency } = await import('../scripts/mini.mjs');

const TEMPLATE = readFileSync(new URL('../mini/p.html', import.meta.url), 'utf8');
const FUTURE = new Date(Date.now() + 30 * 864e5).toISOString();
const agency = (over = {}) => ({
  id: 'a1', name: 'Nadia', slug: 'nadia', plan: 'mini', plan_expires_at: FUTURE, whatsapp_number: '+52 998 1', phone: '998',
  public_email: 'n@x.com', address: 'Tulum', maps_url: null, services: ['Venta'], bio: 'Hola', logo_url: null,
  cover_url: 'https://cdn.example.com/c.jpg', primary_color: '#123456', ...over
});
const listing = (over = {}) => ({ public_id: 'PL-1', title_es: 'Casa', town: 'Tulum', amount: 100, currency: 'MXN', operation: 'sale', image: 'https://cdn.example.com/p.jpg', ...over });

test('page model: a paid page shows its card and listings, never internal columns', () => {
  const m = buildModel(agency(), [listing()]);
  assert.equal(m.state, 'active');
  assert.equal(m.listings.length, 1);
  assert.equal(m.agency.whatsapp_number, '+52 998 1');
  assert.equal(m.agency.plan, undefined);
  assert.equal(m.agency.plan_expires_at, undefined);
  assert.equal(m.agency.id, undefined);
});

test('page model: unpaid or lapsed hides listings and every contact', () => {
  for (const over of [{ plan_expires_at: null }, { plan_expires_at: '2020-01-01T00:00:00Z' }]) {
    const m = buildModel(agency(over), [listing()]);
    assert.equal(m.state, 'paused');
    assert.deepEqual(m.listings, []);
    assert.equal(m.agency.whatsapp_number, undefined);
    assert.equal(m.agency.phone, undefined);
    assert.equal(m.agency.public_email, undefined);
  }
  assert.equal(buildModel(null).state, 'not_found');
});

test('render: agent text is escaped in meta tags and cannot close the data script', () => {
  const evil = '</script><img src=x onerror=alert(1)>"';
  const html = renderPage(TEMPLATE, buildModel(agency({ name: evil, bio: evil }), [listing({ title_es: evil })]), { origin: 'https://m.test' });
  assert.ok(!html.includes('<img src=x'), 'no raw markup from agent text');
  const data = html.split('id="mp-data">')[1].split('</script>')[0];
  assert.equal(JSON.parse(data).agency.name, evil, 'the JSON still carries the exact text');
  assert.ok(html.includes('<title>&lt;/script&gt;'), 'title escaped');
});

test('render: link previews for the page and for one property; hidden pages are noindex', () => {
  const page = renderPage(TEMPLATE, buildModel(agency(), [listing()]), { origin: 'https://m.test' });
  assert.match(page, /og:title" content="Nadia · Propiedades"/);
  assert.match(page, /og:image" content="https:\/\/cdn\.example\.com\/c\.jpg"/);
  assert.match(page, /rel="canonical" href="https:\/\/m\.test\/nadia"/);
  assert.ok(!page.includes('noindex'));

  const one = renderPage(TEMPLATE, buildModel(agency(), [listing()]), { origin: 'https://m.test', focus: 'PL-1' });
  assert.match(one, /og:title" content="Casa · Nadia"/);
  assert.match(one, /og:image" content="https:\/\/cdn\.example\.com\/p\.jpg"/);
  assert.match(one, /"focus":"PL-1"/);

  const paused = renderPage(TEMPLATE, buildModel(agency({ plan_expires_at: null }), [listing()]), { origin: 'https://m.test' });
  assert.match(paused, /name="robots" content="noindex"/);
  assert.ok(!paused.includes('og:image'), 'a hidden page previews nothing of its listings');
});

test('render: an unknown focus id is ignored, and non-https images never become previews', () => {
  const html = renderPage(TEMPLATE, buildModel(agency({ cover_url: 'http://plain.example.com/c.jpg' }), [listing({ image: 'data:image/png;base64,AAAA' })]), { focus: 'PL-404' });
  assert.match(html, /"focus":null/);
  assert.ok(!html.includes('og:image'));
});

test('jsonForScript escapes the characters that end a script or a JS line', () => {
  assert.equal(jsonForScript({ a: '</script>\u2028' }), '{"a":"\\u003c/script>\\u2028"}');
});

test('payment notice: only known methods, bounded text', () => {
  assert.equal(cleanNotice({ method: 'bitcoin' }).error, 'invalid_method');
  assert.equal(cleanNotice({ method: 'transfer', reference: 'x'.repeat(81) }).error, 'reference_too_long');
  assert.equal(cleanNotice({ method: 'oxxo', note: 'x'.repeat(301) }).error, 'note_too_long');
  assert.deepEqual(cleanNotice({ method: 'transfer', reference: ' 123 ', note: ' ok ' }).notice, { method: 'transfer', reference: '123', note: 'ok' });
});

function fakeRes() {
  return { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
}
function fakeSvc(agencyRow) {
  const inserts = [];
  return {
    inserts,
    from(table) {
      const q = {
        select() { return q; }, eq() { return q; },
        maybeSingle: async () => ({ data: table === 'agencies' ? agencyRow : null, error: null }),
        insert: async (row) => { inserts.push({ table, row }); return { error: null }; }
      };
      return q;
    }
  };
}
const deps = (svc, user = { id: 'u1', email: 'n@x.com' }, mail = []) => ({
  enforceRateLimit: async () => false,
  requireAgencyUser: async () => (user ? { user, agencyId: 'a1' } : null),
  getServiceClient: () => svc,
  notifyOperator: async (m) => { mail.push(m); return { sent: true }; }
});

test('payment notice handler: POST only, signed in, Mini pages only', async () => {
  let res = fakeRes();
  await handlePaidNotice({ method: 'GET', body: {} }, res, deps(fakeSvc(agency())));
  assert.equal(res.statusCode, 405);
  res = fakeRes();
  await handlePaidNotice({ method: 'POST', body: { method: 'transfer' } }, res, deps(fakeSvc(agency()), null));
  assert.equal(res.statusCode, 401);
  res = fakeRes();
  await handlePaidNotice({ method: 'POST', body: { method: 'cash?' } }, res, deps(fakeSvc(agency())));
  assert.equal(res.body.error, 'invalid_method');
  res = fakeRes();
  await handlePaidNotice({ method: 'POST', body: { method: 'transfer' } }, res, deps(fakeSvc(agency({ plan: 'pro' }))));
  assert.equal(res.body.error, 'not_a_mini_page');
});

test('payment notice handler: the notice is stored before the email, so it is never lost', async () => {
  const svc = fakeSvc(agency({ plan_expires_at: null })), mail = [];
  const res = fakeRes();
  await handlePaidNotice({ method: 'POST', body: { method: 'transfer', reference: 'SPEI-42' } }, res, deps(svc, undefined, mail));
  assert.equal(res.statusCode, 200);
  assert.equal(svc.inserts.length, 1);
  const ev = svc.inserts[0];
  assert.equal(ev.table, 'events');
  assert.equal(ev.row.name, 'mini_paid_notice');
  assert.equal(ev.row.session, 'a1');
  assert.deepEqual(ev.row.props, { slug: 'nadia', method: 'transfer', reference: 'SPEI-42', state: 'pending' });
  assert.equal(mail.length, 1);
  assert.match(mail[0].text, /scripts\/mini\.mjs activate nadia/);
});

test('operator list: the newest notice per page wins', () => {
  const m = latestNoticeByAgency([
    { session: 'a1', created_at: '2026-11-20', props: { method: 'oxxo' } },
    { session: 'a2', created_at: '2026-11-19', props: {} },
    { session: 'a1', created_at: '2026-11-01', props: { method: 'transfer' } }
  ]);
  assert.equal(m.get('a1').props.method, 'oxxo');
  assert.equal(m.size, 2);
});

const { buildEventRow } = await import('../api/_lib/events.js');
const { handleEvent, MINI_EVENTS } = await import('../mini/api/signup.js');

test('events: fixed names, anonymous session, contact-looking values dropped', () => {
  const names = new Set(['mini_view']);
  assert.equal(buildEventRow({ name: 'x', session: 'abcdefgh' }, names).error, 'unknown_event');
  assert.equal(buildEventRow({ name: 'mini_view', session: 'short' }, names).error, 'invalid_session');
  const { row } = buildEventRow({ name: 'mini_view', session: 'abc-12345', page: 'mini', utm_source: 'facebook ads', ref_host: 'L.FACEBOOK.COM',
    props: { slug: 'nadia', email: 'a@b.com', phone: '9981234567', ok: 3 } }, names);
  assert.equal(row.utm_source, 'facebook ads');
  assert.equal(row.ref_host, 'l.facebook.com');
  assert.deepEqual(row.props, { slug: 'nadia', ok: 3 });
});

test('Mini events endpoint: only Mini names, POST only, payment steps are server-side only', async () => {
  assert.ok(!MINI_EVENTS.has('mini_paid_notice') && !MINI_EVENTS.has('mini_activated'));
  const inserts = [];
  const deps = { enforceRateLimit: async () => false, getServiceClient: () => ({ from: () => ({ insert: async (r) => { inserts.push(r); return { error: null }; } }) }) };
  let res = fakeRes();
  await handleEvent({ method: 'GET', body: {} }, res, deps);
  assert.equal(res.statusCode, 405);
  res = fakeRes();
  await handleEvent({ method: 'POST', body: { name: 'landing_view', session: 'abcdefgh' } }, res, deps);
  assert.equal(res.body.error, 'unknown_event');
  res = fakeRes();
  await handleEvent({ method: 'POST', body: { name: 'mini_view', session: 'abcdefgh', page: 'mini' } }, res, deps);
  assert.equal(res.statusCode, 202);
  assert.equal(inserts[0].name, 'mini_view');
});
