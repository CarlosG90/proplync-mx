/* PropLync Mini · the client CRM ("Clientes", supabase/022): steps per service, job rules, totals, the
   monthly add-on gate, and WhatsApp inquiries becoming leads. Database faked, no network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';

const { stagesFor, cleanStages, cleanCase, summarize, handleCases, leadFromWhatsApp, GENERIC_STAGES } = await import('../mini/api/_cases.js');
const { crmActive } = await import('../api/_lib/plans.js');
const wa = await import('../mini/api/whatsapp.js');

const FUTURE = new Date(Date.now() + 20 * 864e5).toISOString();
const PAST = new Date(Date.now() - 864e5).toISOString();
const SVC = '11111111-2222-3333-4444-555555555555';

test('crmActive: only with a future crm_until', () => {
  assert.equal(crmActive({ crm_until: FUTURE }), true);
  assert.equal(crmActive({ crm_until: PAST }), false);
  assert.equal(crmActive({ crm_until: null }), false);
  assert.equal(crmActive(null), false);
});

test('stagesFor: the service\'s own steps, else its template twin\'s (Gael\'s 8 services), else generic', () => {
  assert.deepEqual(stagesFor({ title_es: 'Levantamiento topográfico' }, 'real_estate'), ['Agendado', 'Trabajo de campo', 'Procesamiento', 'Plano entregado']);
  assert.equal(stagesFor({ title_es: 'Gestión ante notaría' }, 'real_estate').at(-1), 'Escritura entregada');
  assert.equal(stagesFor({ title_es: 'AVALUOS comerciales e hipotecarios (Infonavit, Fovissste)' }, 'real_estate')[0], 'Solicitud y documentos', 'accents and case ignored');
  assert.deepEqual(stagesFor({ title_es: 'Planos', stages: ['A', 'B'] }, 'real_estate'), ['A', 'B']);
  assert.deepEqual(stagesFor({ title_es: 'Algo propio' }, 'real_estate'), GENERIC_STAGES);
  assert.deepEqual(stagesFor(null, 'trades'), GENERIC_STAGES);
});

test('cleanStages: 2 to 12 short, distinct steps', () => {
  assert.deepEqual(cleanStages([' Recibido ', 'En proceso', 'En proceso', '', 'Entregado']).stages, ['Recibido', 'En proceso', 'Entregado']);
  assert.equal(cleanStages(['Solo uno']).error, 'invalid_stages');
  assert.equal(cleanStages(['a', 'x'.repeat(81)]).error, 'stage_too_long');
  assert.equal(cleanStages('a,b').error, 'invalid_stages');
  assert.deepEqual(cleanStages(null), { stages: null }, 'back to the template\'s steps');
});

test('cleanCase: the paper sheet\'s fields, with the money and date rules', () => {
  const { row } = cleanCase({ client_name: ' Ana Pérez ', client_phone: '+52 238 000 0000', address: 'Calle 3 Sur 12', service_id: SVC,
    stage: 'Visita al inmueble', started_on: '2026-11-01', finished_on: '2026-11-20', fee: '3500', advance: 1000, sale_price: '', commission: 0 },
    { stages: ['Solicitud y documentos', 'Visita al inmueble', 'Entregado'] });
  assert.deepEqual(row, { service_id: SVC, stage: 'Visita al inmueble', client_name: 'Ana Pérez', client_phone: '+52 238 000 0000',
    address: 'Calle 3 Sur 12', started_on: '2026-11-01', finished_on: '2026-11-20', fee: 3500, advance: 1000, sale_price: null, commission: 0 });
  assert.ok(!('balance' in row), 'the balance is computed by Postgres, never sent');
  for (const [b, code] of [
    [{ stage: 'Otro paso' }, 'invalid_stage'],
    [{ fee: 1000, advance: 2000 }, 'advance_over_fee'],
    [{ started_on: '2026-11-20', finished_on: '2026-11-01' }, 'finished_before_start'],
    [{ started_on: '20/11/2026' }, 'invalid_started_on'],
    [{ fee: -5 }, 'invalid_fee'],
    [{ client_phone: 'llámame' }, 'invalid_client_phone'],
    [{ status: 'archived' }, 'invalid_status'],
    [{ service_id: 'x' }, 'invalid_service'],
    [{ notes: 'x'.repeat(4001) }, 'notes_too_long']
  ]) assert.equal(cleanCase(b, { stages: ['Recibido', 'Entregado'] }).error, code, code);
});

test('summarize: leads, open jobs, what clients owe and unpaid commissions, per service', () => {
  const s = summarize([
    { status: 'lead', service_id: SVC },
    { status: 'open', service_id: SVC, balance: 2500, commission: 800 },
    { status: 'done', service_id: null, balance: 0, commission: 500, commission_paid_on: '2026-11-10' },
    { status: 'cancelled', service_id: SVC, balance: 999, commission: 999 }
  ]);
  assert.deepEqual(s, { leads: 1, open: 1, done: 1, owed: 2500, commissions_pending: 800, by_service: { [SVC]: 3, none: 1 } });
});

/* A fake service client keyed by table: rows to return, inserts and updates recorded with their filters. */
function fakeDb({ agency = { id: 'a1', business_type: 'real_estate', crm_until: FUTURE }, service = { id: SVC, title_es: 'Planos arquitectónicos', stages: null },
  cases = [], existingLead = [], services = [] } = {}) {
  const writes = [];
  const from = (table) => {
    const st = { table, op: 'select', filters: [] };
    const q = {
      select() { return q; }, eq(k, v) { st.filters.push([k, v]); return q; }, in() { return q; }, order() { return q; }, limit() { return q; },
      insert(v) { st.op = 'insert'; writes.push({ table, op: 'insert', v }); return q; },
      update(v) { st.op = 'update'; writes.push({ table, op: 'update', v, filters: st.filters }); return q; },
      delete() { st.op = 'delete'; return q; },
      single: async () => ({ data: { id: 'new', ...(writes.at(-1) || {}).v }, error: null }),
      maybeSingle: async () => {
        if (table === 'agencies') return { data: agency, error: null };
        if (table === 'mini_services') return { data: st.filters.some(([k, v]) => k === 'agency_id' && v === 'a1') ? service : null, error: null };
        if (table === 'mini_cases') return { data: { id: 'c1', service_id: null }, error: null };
        return { data: null, error: null };
      },
      then(resolve) {
        if (table === 'mini_cases' && st.op === 'select') return resolve({ data: st.filters.some(([k]) => k === 'client_phone') ? existingLead : cases, error: null });
        if (table === 'mini_services') return resolve({ data: services.length ? services : [service], error: null });
        return resolve({ data: [{ id: 'x' }], error: null });
      }
    };
    return q;
  };
  return { from, writes };
}
const res = () => ({ statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} });
const auth = { agencyId: 'a1' };

test('cases: reading never stops; writing needs the monthly add-on (402)', async () => {
  const lapsed = fakeDb({ agency: { id: 'a1', business_type: 'real_estate', crm_until: PAST }, cases: [{ status: 'open', balance: 100 }] });
  let r = res();
  await handleCases({ method: 'GET', query: {} }, r, { auth, svc: lapsed });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.active, false);
  assert.equal(r.body.cases.length, 1);
  assert.equal(r.body.services[0].stages.at(-1), 'Entregado', 'Planos arquitectónicos: template steps');
  r = res();
  await handleCases({ method: 'POST', query: {}, body: { client_name: 'Ana' } }, r, { auth, svc: lapsed });
  assert.equal(r.statusCode, 402);
  assert.equal(r.body.error, 'upgrade_required');
});

test('cases: a new job is the owner\'s, manual, open, and its stage must be one of its service\'s steps', async () => {
  const db = fakeDb(); let r = res();
  await handleCases({ method: 'POST', query: {}, body: { client_name: 'Ana', service_id: SVC, stage: 'Anteproyecto', agency_id: 'other', source: 'whatsapp' } }, r, { auth, svc: db });
  assert.equal(r.statusCode, 201);
  const ins = db.writes.find((w) => w.op === 'insert').v;
  assert.equal(ins.agency_id, 'a1');
  assert.equal(ins.source, 'manual');
  assert.equal(ins.status, 'open');
  r = res();
  await handleCases({ method: 'POST', query: {}, body: { client_name: 'Ana', service_id: SVC, stage: 'Paso inventado' } }, r, { auth, svc: fakeDb() });
  assert.equal(r.body.error, 'invalid_stage');
  r = res();
  await handleCases({ method: 'POST', query: {}, body: { service_id: SVC } }, r, { auth, svc: fakeDb() });
  assert.equal(r.body.error, 'missing_client');
  r = res();
  await handleCases({ method: 'POST', query: {}, body: { client_name: 'Ana', service_id: SVC } }, r, { auth: { agencyId: 'a2' }, svc: fakeDb({ agency: { id: 'a2', crm_until: FUTURE } }) });
  assert.equal(r.body.error, 'invalid_service', 'another owner\'s service');
});

test('cases: a service\'s own steps are saved only for the owner\'s service', async () => {
  const db = fakeDb(); const r = res();
  await handleCases({ method: 'PUT', query: { service: SVC, stages: '1' }, body: { stages: ['Recibido', 'Dibujo', 'Entregado'] } }, r, { auth, svc: db });
  assert.equal(r.statusCode, 200);
  const up = db.writes.find((w) => w.table === 'mini_services');
  assert.deepEqual(up.v, { stages: ['Recibido', 'Dibujo', 'Entregado'] });
  assert.deepEqual(up.filters, [['id', SVC], ['agency_id', 'a1']]);
});

test('WhatsApp → CRM: a new number becomes one lead with the service asked about; no duplicates; nothing without the add-on', async () => {
  let db = fakeDb({ services: [{ id: SVC, title_es: 'Avalúos comerciales e hipotecarios (Infonavit, Fovissste)' }] });
  let out = await leadFromWhatsApp(db, { agencyId: 'a1', phone: '5212380000000', serviceTitle: 'avaluos comerciales e hipotecarios (infonavit, fovissste)' });
  assert.equal(out.created, 'new');
  const ins = db.writes.find((w) => w.op === 'insert').v;
  assert.deepEqual([ins.source, ins.status, ins.client_phone, ins.service_id], ['whatsapp', 'lead', '5212380000000', SVC]);

  db = fakeDb({ existingLead: [{ id: 'c9', service_id: null, status: 'lead' }] });
  out = await leadFromWhatsApp(db, { agencyId: 'a1', phone: '5212380000000', serviceTitle: 'Planos arquitectónicos' });
  assert.deepEqual(out, { existing: 'c9' });
  assert.ok(!db.writes.some((w) => w.op === 'insert'), 'no second lead for the same client');
  assert.deepEqual(db.writes.find((w) => w.op === 'update').v, { service_id: SVC }, 'the unknown service is filled in');

  db = fakeDb({ agency: { id: 'a1', crm_until: null } });
  assert.deepEqual(await leadFromWhatsApp(db, { agencyId: 'a1', phone: '52123' }), { skipped: 'crm_inactive' });
  assert.equal(db.writes.length, 0);
});

test('the webhook files every inquiry in the CRM, even when the assistant is switched off', async () => {
  const calls = [];
  const bot = { agency_id: 'a1', enabled: false, monthly_cap: 950 };
  const svc = { from: (table) => {
    const q = { select() { return q; }, eq() { return q; }, insert() { return Promise.resolve({ error: null }); },
      maybeSingle: async () => ({ data: table === 'mini_bot' ? bot : null, error: null }) };
    return q;
  } };
  const m = { phoneNumberId: 'PN1', from: '5212380000000', id: 'wamid.9', type: 'text', text: 'Hola' };
  const out = await wa.handleMessage(m, { svc, leadFromWhatsApp: async (_svc, args) => { calls.push(args); return { created: 'x' }; } });
  assert.equal(out.skipped, 'disabled');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].phone, '5212380000000');
});

test('operator crm: extends from the current end while it runs, else from today', async () => {
  const { extendCrm } = await import('../scripts/mini.mjs');
  const now = Date.parse('2026-11-28T12:00:00Z');
  assert.equal(extendCrm(null, 30, now), '2026-12-28T12:00:00.000Z');
  assert.equal(extendCrm('2026-12-10T00:00:00Z', 30, now), '2027-01-09T00:00:00.000Z');
  assert.equal(extendCrm('2026-11-01T00:00:00Z', 30, now), '2026-12-28T12:00:00.000Z', 'lapsed: from today');
});
