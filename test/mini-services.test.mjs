/* PropLync Mini for any service business (supabase/019): business types, the services catalog,
   and how a services-only page renders. Database faked, no network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';

const { buildModel, renderPage } = await import('../mini/api/page.js');
const { cleanService, handleServices, MAX_SERVICES } = await import('../mini/api/_services.js');
const { BUSINESS_TYPES, BUSINESS_TYPE_KEYS, typeFor } = await import('../mini/api/_business-types.js');
const { BUSINESS_TYPE_KEYS: FIELD_KEYS, validateAgencyFields } = await import('../api/_lib/listing-fields.js');
const { handleMiniSignup, miniServiceFields } = await import('../api/onboard.js');

const TEMPLATE = readFileSync(new URL('../mini/p.html', import.meta.url), 'utf8');
const SQL = readFileSync(new URL('../supabase/019_business_pages.sql', import.meta.url), 'utf8');
const FUTURE = new Date(Date.now() + 30 * 864e5).toISOString();
const agency = (over = {}) => ({
  id: 'a1', name: 'Gestoria Ejemplo', slug: 'gestoria', plan: 'mini', plan_expires_at: FUTURE, whatsapp_number: '+52 238 000 0000',
  services: [], bio: '', business_type: 'professional', ...over
});
const svcRow = (over = {}) => ({ id: 's1', title_es: 'Avalúo comercial', price: 3500, price_kind: 'from', currency: 'MXN', sort: 0, ...over });

// ---------- business types ----------

test('one list of business types: templates, field rules and the SQL check agree', () => {
  assert.deepEqual(BUSINESS_TYPE_KEYS, FIELD_KEYS);
  assert.deepEqual(Object.keys(BUSINESS_TYPES).sort(), [...FIELD_KEYS].sort());
  const inSql = SQL.match(/business_type in \(([^)]+)\)/)[1].match(/'([a-z_]+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual(inSql, FIELD_KEYS);
});

test('every template is bilingual and every case type has at least two stages', () => {
  for (const k of BUSINESS_TYPE_KEYS) {
    const ty = BUSINESS_TYPES[k];
    for (const f of ['label', 'hint', 'eyebrow', 'greeting']) {
      assert.equal(ty[f].length, 2, `${k}.${f}`);
      assert.ok(ty[f][0] && ty[f][1], `${k}.${f} ES and EN`);
    }
    for (const s of ty.services) assert.ok(s.title_es && s.title_en && s.title_es.length <= 120, k);
    assert.ok(ty.cases.length >= 1, k);
    for (const c of ty.cases) assert.ok(c.name && c.stages.length >= 2, `${k}: ${c.name}`);
  }
  assert.equal(BUSINESS_TYPES.real_estate.services.length, 8, 'the eight services of the first customer');
});

test('typeFor: an old row with no type is real estate; an unknown type falls back to general', () => {
  assert.equal(typeFor(null).key, 'real_estate');
  assert.equal(typeFor('').key, 'real_estate');
  assert.equal(typeFor('beauty').key, 'beauty');
  assert.equal(typeFor('circus').key, 'general');
});

test('the agency card accepts only a known business type', () => {
  assert.equal(validateAgencyFields({ business_type: 'trades' }).business_type, 'trades');
  assert.throws(() => validateAgencyFields({ business_type: 'circus' }), /invalid_business_type/);
  assert.throws(() => validateAgencyFields({ business_type: null }), /invalid_business_type/);
});

// ---------- cleanService ----------

test('cleanService: a title is required; a price with no kind is fixed; "a cotizar" drops the number', () => {
  assert.equal(cleanService({}).error, 'missing_title');
  assert.equal(cleanService({ title_es: '   ' }).error, 'missing_title');
  assert.deepEqual(cleanService({ title_es: ' Planos ' }).service, { title_es: 'Planos', price_kind: 'quote' });
  assert.equal(cleanService({ title_es: 'Visita', price: '450' }).service.price_kind, 'fixed');
  assert.equal(cleanService({ title_es: 'Visita', price: 450, price_kind: 'quote' }).service.price, null);
  assert.equal(cleanService({ title_es: 'Medición', price: 12.345, price_kind: 'per_m2' }).service.price, 12.35);
});

test('cleanService: refuses bad values with a code the panel can show', () => {
  const t = 'Servicio';
  for (const [b, code] of [
    [{ title_es: 'x'.repeat(121) }, 'title_too_long'],
    [{ title_es: t, description_es: 'x'.repeat(1201) }, 'description_too_long'],
    [{ title_es: t, price: -1 }, 'invalid_price'],
    [{ title_es: t, price: 'mucho' }, 'invalid_price'],
    [{ title_es: t, price_kind: 'gratis' }, 'invalid_price_kind'],
    [{ title_es: t, currency: 'EUR' }, 'invalid_currency'],
    [{ title_es: t, duration_min: 2 }, 'invalid_duration'],
    [{ title_es: t, image: 'javascript:alert(1)' }, 'invalid_image'],
    [{ title_es: t, image: 'http://plain.example.com/a.jpg' }, 'invalid_image'],
    [{ title_es: t, status: 'deleted' }, 'invalid_status'],
    [{ title_es: 5 }, 'invalid_title']
  ]) assert.equal(cleanService(b).error, code, code);
});

test('cleanService partial (PUT): only what was sent, and the title cannot be blanked', () => {
  assert.deepEqual(cleanService({ sort: 20 }, { partial: true }).service, { sort: 20 });
  assert.equal(cleanService({ title_es: '' }, { partial: true }).error, 'missing_title');
});

// ---------- handleServices ----------

/* A stand-in for the service client that records the filters on every query. */
function fakeSvc({ rows = [], count = 0 } = {}) {
  const calls = [];
  const from = (table) => {
    const call = { table, filters: [], op: 'select' };
    calls.push(call);
    const q = {
      select(_f, opts) { if (opts && opts.head) call.head = true; return q; },
      eq(k, v) { call.filters.push([k, v]); return q; },
      order() { return q; },
      insert(v) { call.op = 'insert'; call.value = v; return q; },
      update(v) { call.op = 'update'; call.value = v; return q; },
      delete() { call.op = 'delete'; return q; },
      single: async () => ({ data: { id: 'new', ...call.value }, error: null }),
      maybeSingle: async () => ({ data: rows[0] || null, error: null }),
      then(resolve) {
        if (call.head) return resolve({ count, error: null });
        if (call.op === 'delete') return resolve({ data: rows.map((r) => ({ id: r.id })), error: null });
        return resolve({ data: rows, error: null });
      }
    };
    return q;
  };
  return { from, calls };
}
const res = () => ({ statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} });
const auth = { agencyId: 'agency-1' };
const ID = '11111111-2222-3333-4444-555555555555';

test('services: every query is scoped to the caller\'s agency; agency_id in the body is ignored', async () => {
  const svc = fakeSvc({ count: 3 }); const r = res();
  await handleServices({ method: 'POST', query: {}, body: { title_es: 'Planos', agency_id: 'someone-else' } }, r, { auth, svc });
  assert.equal(r.statusCode, 201);
  const ins = svc.calls.find((c) => c.op === 'insert');
  assert.equal(ins.value.agency_id, 'agency-1');
  assert.equal(ins.value.sort, 30, 'new services go last');
  assert.ok(svc.calls.filter((c) => c.op === 'select').every((c) => c.filters.some(([k, v]) => k === 'agency_id' && v === 'agency-1')));
});

test('services: the cap is enforced on create', async () => {
  const r = res();
  await handleServices({ method: 'POST', query: {}, body: { title_es: 'Uno más' } }, r, { auth, svc: fakeSvc({ count: MAX_SERVICES }) });
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, 'service_limit_reached');
});

test('services: update and delete need an id, filter on it and on the agency, and 404 when nothing matched', async () => {
  let r = res();
  await handleServices({ method: 'PUT', query: {}, body: { sort: 1 } }, r, { auth, svc: fakeSvc() });
  assert.equal(r.body.error, 'missing_id');
  r = res();
  await handleServices({ method: 'PUT', query: { id: 'not-a-uuid' }, body: { sort: 1 } }, r, { auth, svc: fakeSvc() });
  assert.equal(r.body.error, 'invalid_id');
  const svc = fakeSvc({ rows: [svcRow()] }); r = res();
  await handleServices({ method: 'PUT', query: { id: ID }, body: { price: 4000 } }, r, { auth, svc });
  assert.equal(r.statusCode, 200);
  const up = svc.calls.find((c) => c.op === 'update');
  assert.deepEqual(up.filters, [['id', ID], ['agency_id', 'agency-1']]);
  r = res();
  await handleServices({ method: 'DELETE', query: { id: ID } }, r, { auth, svc: fakeSvc({ rows: [] }) });
  assert.equal(r.statusCode, 404);
});

// ---------- the public page ----------

test('page model: services ride along on a paid page and stay hidden on a paused one', () => {
  const live = buildModel(agency(), [], Date.now(), { services: [svcRow()] });
  assert.equal(live.state, 'active');
  assert.equal(live.services.length, 1);
  assert.equal(live.agency.business_type, 'professional');
  const paused = buildModel(agency({ plan_expires_at: null }), [], Date.now(), { services: [svcRow()] });
  assert.equal(paused.state, 'paused');
  assert.deepEqual(paused.services, []);
  assert.equal(buildModel(agency({ business_type: undefined }), []).agency.business_type, 'real_estate');
});

test('link preview of a services page names what it offers, never "0 propiedades"', () => {
  const html = renderPage(TEMPLATE, buildModel(agency(), [], Date.now(), { services: [svcRow(), svcRow({ id: 's2', title_es: 'Planos' })] }), { origin: 'https://m.test' });
  assert.match(html, /<title>Gestoria Ejemplo · Servicios profesionales<\/title>/);
  assert.match(html, /Avalúo comercial, Planos/);
  assert.doesNotMatch(html, /0 propiedades/);
});

test('a property-only page keeps its original preview', () => {
  const html = renderPage(TEMPLATE, buildModel(agency({ business_type: 'real_estate' }), [{ public_id: 'PL-1', title_es: 'Casa', town: 'Tulum', amount: 1 }]), { origin: 'https://m.test' });
  assert.match(html, /<title>Gestoria Ejemplo · Propiedades<\/title>/);
  assert.match(html, /1 propiedad en Tulum/);
});

test('service text from the database cannot break out of the page data', () => {
  const evil = '</script><img src=x onerror=alert(1)>';
  const html = renderPage(TEMPLATE, buildModel(agency(), [], Date.now(), { services: [svcRow({ title_es: evil })] }), { origin: 'https://m.test' });
  assert.ok(!html.includes(evil));
});

// ---------- signup for a services business ----------

function signupSvc() {
  const writes = [];
  const from = (table) => {
    const q = {
      select() { return q; }, eq() { return q; }, limit() { return q; },
      maybeSingle: async () => ({ data: null }),
      update(v) { writes.push({ table, op: 'update', v }); return { eq: async () => ({ error: null }) }; },
      insert(rows) {
        writes.push({ table, op: 'insert', rows });
        const p = Promise.resolve({ data: rows.map((_, i) => ({ id: 'x' + i, public_id: 'P' + i })), error: null });
        p.select = () => p;
        return p;
      }
    };
    return q;
  };
  return { writes, from, auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'test@example.com' } }, error: null }) } };
}
const signupReq = (body) => ({ method: 'POST', query: {}, body, socket: { remoteAddress: '127.0.0.1' }, headers: { authorization: 'Bearer good' } });
const deps = (svc) => ({ env: { MINI_SIGNUP: 'on' }, svc, provisionAgency: async () => ({ id: 'a1', slug: 'gestoria' }), notifyOperator: async () => ({ sent: false }) });

test('signup: a services business needs no properties', async () => {
  const svc = signupSvc(); const r = res();
  await handleMiniSignup(signupReq({ agencyName: 'Gestoria', whatsapp_number: '+52 238 000 0000', business_type: 'professional',
    services: ['Avalúo comercial', { title_es: 'Planos', price: 5000, price_kind: 'from' }] }), r, deps(svc));
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.services_saved, 2);
  assert.equal(r.body.saved, 0);
  assert.equal(svc.writes.find((w) => w.table === 'agencies').v.business_type, 'professional');
  assert.ok(!svc.writes.some((w) => w.table === 'listings'), 'no empty listings insert');
  const rows = svc.writes.find((w) => w.table === 'mini_services').rows;
  assert.deepEqual(rows.map((x) => [x.title_es, x.price, x.price_kind, x.sort, x.agency_id]),
    [['Avalúo comercial', null, 'quote', 0, 'a1'], ['Planos', 5000, 'from', 10, 'a1']]);
});

test('signup: nothing to show, or an unknown type, is refused before anything is created', async () => {
  for (const [body, code] of [
    [{ business_type: 'trades', services: [] }, 'no_services'],
    [{ listings: [] }, 'no_listings'],
    [{ business_type: 'circus', services: ['x'] }, 'invalid_business_type'],
    [{ business_type: 'trades', services: [{ title_es: '' }] }, 'missing_service_title']
  ]) {
    const svc = signupSvc(); const r = res();
    await handleMiniSignup(signupReq({ agencyName: 'Gestoria', whatsapp_number: '+52 238 000 0000', ...body }), r, deps(svc));
    assert.equal(r.statusCode, 400, code);
    assert.equal(r.body.error, code);
    assert.equal(svc.writes.length, 0);
  }
});

test('miniServiceFields: prices are checked like the panel\'s', () => {
  assert.throws(() => miniServiceFields({ title_es: 'x', price: -5 }), /invalid_service_price/);
  assert.equal(miniServiceFields({ title_es: 'x', price: 10, price_kind: 'quote' }).price, null);
});

// ---------- the operator's `create` (scripts/mini.mjs) ----------

test('operator create: the card flags go through the panel\'s rules', async () => {
  const { createCard } = await import('../scripts/mini.mjs');
  const ok = createCard({ name: ' Gestoria ', type: 'professional', whatsapp: '+52 238 000 0000', tags: 'Avalúos, Planos, ' });
  assert.equal(ok.name, 'Gestoria');
  assert.equal(ok.card.business_type, 'professional');
  assert.deepEqual(ok.card.services, ['Avalúos', 'Planos']);
  assert.equal(createCard({ name: 'X' }).card.business_type, 'real_estate', 'default type');
  assert.throws(() => createCard({ name: 'X', type: 'circus' }), /invalid_business_type/);
  assert.throws(() => createCard({ type: 'trades' }), /missing --name/);
  assert.throws(() => createCard({ name: 'X', whatsapp: 'llamame' }), /invalid_whatsapp_number/);
  assert.throws(() => createCard({ name: 'X', 'public-email': 'no-es-correo' }), /invalid_public_email/);
});

// ---------- the easy start (PR C): address and "what I do" at signup ----------

test('signup: a services page can carry its business address and one line about what they do', async () => {
  const svc = signupSvc(); const r = res();
  await handleMiniSignup(signupReq({ agencyName: 'Ana López', whatsapp_number: '+52 238 000 0000', business_type: 'general',
    services: ['Sesión de retrato'], address: '  Av. Reforma 10, Tehuacán ', bio: ' Fotografía de bodas ' }), r, deps(svc));
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const up = svc.writes.find((w) => w.table === 'agencies').v;
  assert.equal(up.address, 'Av. Reforma 10, Tehuacán');
  assert.equal(up.bio, 'Fotografía de bodas');
});

test('signup: no address means none is written; a too-long one is refused before anything is created', async () => {
  let svc = signupSvc(); let r = res();
  await handleMiniSignup(signupReq({ agencyName: 'X', whatsapp_number: '+52 238 000 0000', business_type: 'trades', services: ['Plomería'], address: '   ' }), r, deps(svc));
  assert.equal(r.statusCode, 200);
  assert.ok(!('address' in svc.writes.find((w) => w.table === 'agencies').v));
  svc = signupSvc(); r = res();
  await handleMiniSignup(signupReq({ agencyName: 'X', whatsapp_number: '+52 238 000 0000', business_type: 'trades', services: ['Plomería'], address: 'x'.repeat(201) }), r, deps(svc));
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, 'address_too_long');
  assert.equal(svc.writes.length, 0);
});

test('the business-type pick is an allowed funnel event and a funnel step', async () => {
  const { MINI_EVENTS } = await import('../mini/api/signup.js');
  const { MINI_STAGES } = await import('../api/_lib/funnel.js');
  assert.ok(MINI_EVENTS.has('mini_type'));
  assert.deepEqual(MINI_STAGES.map((s) => s[0]).slice(0, 3), ['mini_view', 'mini_type', 'mini_preview']);
});

// ---------- material: infographics and PDFs (mini_assets, supabase/020) ----------

const { cleanAsset, handleAssets, folderPrefix, MAX_ASSETS } = await import('../mini/api/_assets.js');
const SB = 'https://proj.supabase.co';
const AG = '11111111-aaaa-bbbb-cccc-222222222222';
const own = (name) => folderPrefix(SB, AG) + name;

test('cleanAsset: only image or PDF files inside the owner\'s own folder', () => {
  const ok = cleanAsset({ url: own('asset-abc_1.PNG'), title: ' Requisitos avalúo ' }, { agencyId: AG, supabaseUrl: SB });
  assert.deepEqual(ok.asset, { url: own('asset-abc_1.PNG'), kind: 'image', title: 'Requisitos avalúo' });
  assert.equal(cleanAsset({ url: own('lista.pdf') }, { agencyId: AG, supabaseUrl: SB }).asset.kind, 'pdf');
  for (const [url, code] of [
    ['https://evil.example.com/x.png', 'invalid_asset_url'],
    [folderPrefix(SB, '99999999-aaaa-bbbb-cccc-222222222222') + 'x.png', 'invalid_asset_url'],   // another agency
    [own('x.svg'), 'invalid_asset_type'],
    [own('x.html'), 'invalid_asset_type'],
    [own('sub/x.png'), 'invalid_asset_type'],
    [own('../other/x.png'), 'invalid_asset_type'],
    [own('x.png?download=1'), 'invalid_asset_type'],
    ['', 'invalid_asset_url']
  ]) assert.equal(cleanAsset({ url }, { agencyId: AG, supabaseUrl: SB }).error, code, url);
  assert.equal(cleanAsset({ url: own('x.png'), title: 'x'.repeat(121) }, { agencyId: AG, supabaseUrl: SB }).error, 'title_too_long');
});

test('cleanAsset partial (PUT): title and order only; the file never changes', () => {
  assert.deepEqual(cleanAsset({ title: 'Nuevo', sort: 20, url: 'https://evil.example.com/x.png' }, { partial: true }).asset, { title: 'Nuevo', sort: 20 });
});

test('assets: scoped to the caller\'s agency, capped, and the URL is checked against that agency', async () => {
  const svc = fakeSvc({ count: 2 }); let r = res();
  await handleAssets({ method: 'POST', query: {}, body: { url: own('asset-1.jpg'), agency_id: 'someone-else' } }, r, { auth: { agencyId: AG }, svc, supabaseUrl: SB });
  assert.equal(r.statusCode, 201);
  const ins = svc.calls.find((c) => c.op === 'insert');
  assert.equal(ins.value.agency_id, AG);
  assert.equal(ins.value.sort, 20);
  r = res();
  await handleAssets({ method: 'POST', query: {}, body: { url: own('asset-1.jpg') } }, r, { auth: { agencyId: 'other-agency' }, svc: fakeSvc(), supabaseUrl: SB });
  assert.equal(r.body.error, 'invalid_asset_url', 'a file in someone else\'s folder');
  r = res();
  await handleAssets({ method: 'POST', query: {}, body: { url: own('asset-1.jpg') } }, r, { auth: { agencyId: AG }, svc: fakeSvc({ count: MAX_ASSETS }), supabaseUrl: SB });
  assert.equal(r.body.error, 'asset_limit_reached');
  const del = fakeSvc({ rows: [] }); r = res();
  await handleAssets({ method: 'DELETE', query: { id: ID } }, r, { auth: { agencyId: AG }, svc: del, supabaseUrl: SB });
  assert.equal(r.statusCode, 404);
  assert.deepEqual(del.calls.find((c) => c.op === 'delete').filters, [['id', ID], ['agency_id', AG]]);
});

test('page model: material rides along on a paid page, hidden on a paused one, and only its public fields', () => {
  const a = { id: 'x1', url: own('asset-1.png'), kind: 'image', title: 'Requisitos', sort: 0, agency_id: AG };
  const live = buildModel(agency(), [], Date.now(), { assets: [a] });
  assert.deepEqual(live.assets, [{ id: 'x1', url: a.url, kind: 'image', title: 'Requisitos' }]);
  assert.deepEqual(buildModel(agency({ plan_expires_at: null }), [], Date.now(), { assets: [a] }).assets, []);
});

test('missingTable: a page without migration 020 shows no material instead of failing', async () => {
  const { missingTable } = await import('../mini/api/_assets.js');
  assert.equal(missingTable({ code: '42P01' }), true);
  assert.equal(missingTable({ code: 'PGRST205', message: "Could not find the table 'public.mini_assets' in the schema cache" }), true);
  assert.equal(missingTable({ code: '57014', message: 'canceling statement due to statement timeout' }), false);
  assert.equal(missingTable(null), false);
});
