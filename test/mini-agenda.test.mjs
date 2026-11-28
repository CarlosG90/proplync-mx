/* PropLync Mini · "Agendar cita" (supabase/024): settings, Mexico's time zones, free times, the client's
   request, and the public endpoint (no double booking, CRM lead). Database faked, no network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';

const A = await import('../mini/api/_agenda.js');
const { default: agenda } = await import('../mini/api/agenda.js');

test('cleanAgenda: only sane settings', () => {
  assert.deepEqual(A.cleanAgenda({ enabled: true, days: [5, 1, 1], start: '09:00', end: '14:00', slot: 30, ahead: 20, notice: 3, tz: 'America/Cancun' }).agenda,
    { enabled: true, days: [1, 5], start: '09:00', end: '14:00', slot: 30, ahead: 20, notice: 3, tz: 'America/Cancun' });
  for (const [b, code] of [[{ days: [] }, 'invalid_days'], [{ days: [7] }, 'invalid_days'], [{ start: '9am' }, 'invalid_start'],
    [{ start: '18:00', end: '09:00' }, 'invalid_hours'], [{ slot: 50 }, 'invalid_slot'], [{ ahead: 200 }, 'invalid_ahead'],
    [{ tz: 'Europe/Madrid' }, 'invalid_tz'], [{ enabled: 'si' }, 'invalid_enabled']]) assert.equal(A.cleanAgenda(b).error, code, code);
});

test('time zones: CDMX is UTC-6, Cancún UTC-5, both ways', () => {
  assert.equal(new Date(A.localToUtc('2026-12-04', '10:00', 'America/Mexico_City')).toISOString(), '2026-12-04T16:00:00.000Z');
  assert.equal(new Date(A.localToUtc('2026-12-04', '10:00', 'America/Cancun')).toISOString(), '2026-12-04T15:00:00.000Z');
  assert.deepEqual(A.utcToLocal(Date.parse('2026-12-04T16:00:00Z'), 'America/Mexico_City'), { date: '2026-12-04', time: '10:00', weekday: 5 });
});

test('freeSlots: working days only, inside hours, not too soon, not taken, within the window', () => {
  const now = Date.parse('2026-11-30T15:30:00Z');   // Monday 09:30 in CDMX
  const cfg = { enabled: true, days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00', slot: 60, ahead: 7, notice: 1, tz: 'America/Mexico_City' };
  const taken = [new Date(A.localToUtc('2026-12-01', '10:00', cfg.tz)).toISOString()];
  const days = A.freeSlots(cfg, taken, now);
  assert.equal(days.length, 8, 'today + 7');
  assert.deepEqual(days[0], { date: '2026-11-30', weekday: 1, times: ['11:00'] }, 'today at 09:30 with 1 h notice: 09:00 and 10:00 are too soon');
  assert.deepEqual(days[1].times, ['09:00', '11:00'], 'tomorrow: 10:00 is taken');
  assert.deepEqual(days.find((d) => d.date === '2026-12-05').times, [], 'Saturday off');
  assert.ok(A.freeSlots({ ...cfg, enabled: false }, [], now).every((d) => !d.times.length), 'switched off: nothing');
});

test('cleanBooking: date, time, a name and a real phone', () => {
  assert.deepEqual(A.cleanBooking({ date: '2026-12-01', time: '09:00', name: ' Ana ', phone: '238 000 0000', note: ' Avalúo ' }).booking,
    { date: '2026-12-01', time: '09:00', client_name: 'Ana', client_phone: '238 000 0000', note: 'Avalúo', service_id: null });
  for (const [b, code] of [[{ time: '09:00', name: 'a', phone: '2380000000' }, 'invalid_date'], [{ date: '2026-12-01', time: '9', name: 'a', phone: '2380000000' }, 'invalid_time'],
    [{ date: '2026-12-01', time: '09:00', name: ' ', phone: '2380000000' }, 'invalid_name'], [{ date: '2026-12-01', time: '09:00', name: 'a', phone: '123' }, 'invalid_phone'],
    [{ date: '2026-12-01', time: '09:00', name: 'a', phone: '2380000000', service_id: 'x' }, 'invalid_service']]) assert.equal(A.cleanBooking(b).error, code, code);
});

/* Public endpoint with a fake database. */
const FUT = new Date(Date.now() + 60 * 864e5).toISOString();
function db({ agency = { id: 'a1', slug: 'gael', name: 'Gael', plan: 'mini', plan_expires_at: FUT, crm_until: FUT,
  agenda: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '18:00', slot: 60, ahead: 14, notice: 0, tz: 'America/Mexico_City' } },
  taken = [], dup = false } = {}) {
  const inserts = [];
  return { inserts, from(table) {
    const st = { op: 'select' };
    const q = { select() { return q; }, eq() { return q; }, in() { return q; }, gte() { return q; }, order() { return q; }, limit() { return q; },
      insert(v) { st.op = 'insert'; inserts.push({ table, v }); return q; },
      single: async () => (dup && table === 'mini_appointments' ? { data: null, error: { code: '23505' } } : { data: { id: 'n1', starts_at: inserts.at(-1).v.starts_at }, error: null }),
      maybeSingle: async () => ({ data: table === 'agencies' ? agency : null, error: null }),
      then(r) { if (st.op === 'insert') return r({ error: null }); return r({ data: table === 'mini_appointments' ? taken.map((s) => ({ starts_at: s })) : [], error: null }); } };
    return q;
  } };
}
const res = () => ({ statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} });
const deps = (svc, now) => ({ getServiceClient: () => svc, enforceRateLimit: async () => false, now: () => now });
const NOW = Date.parse('2026-11-30T15:30:00Z');

test('agenda endpoint: free times only (never who booked); off or unpaid → 404', async () => {
  let r = res();
  await agenda({ method: 'GET', query: { slug: 'gael' } }, r, deps(db(), NOW));
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.slots.length > 0 && !JSON.stringify(r.body).includes('client'));
  r = res();
  await agenda({ method: 'GET', query: { slug: 'gael' } }, r, deps(db({ agency: { id: 'a1', plan: 'mini', plan_expires_at: FUT, agenda: { enabled: false } } }), NOW));
  assert.equal(r.statusCode, 404);
  r = res();
  await agenda({ method: 'GET', query: { slug: 'gael' } }, r, deps(db({ agency: { id: 'a1', plan: 'mini', plan_expires_at: null, agenda: { enabled: true } } }), NOW));
  assert.equal(r.statusCode, 404, 'unpaid page');
});

test('booking: saved as requested in the owner\'s time zone, also a CRM lead; a taken time is refused', async () => {
  const svc = db(); let r = res();
  await agenda({ method: 'POST', body: { slug: 'gael', date: '2026-12-01', time: '10:00', name: 'Ana', phone: '238 000 0000' } }, r, deps(svc, NOW));
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  const appt = svc.inserts.find((i) => i.table === 'mini_appointments').v;
  assert.equal(appt.starts_at, '2026-12-01T16:00:00.000Z');
  assert.equal(appt.status, 'requested');
  const lead = svc.inserts.find((i) => i.table === 'mini_cases').v;
  assert.deepEqual([lead.source, lead.status, lead.client_name], ['agenda', 'lead', 'Ana']);
  r = res();
  await agenda({ method: 'POST', body: { slug: 'gael', date: '2026-12-01', time: '10:00', name: 'Bo', phone: '238 000 0001' } }, r,
    deps(db({ taken: ['2026-12-01T16:00:00.000Z'] }), NOW));
  assert.equal(r.body.error, 'slot_taken', 'already taken');
  r = res();
  await agenda({ method: 'POST', body: { slug: 'gael', date: '2026-12-01', time: '10:00', name: 'Bo', phone: '238 000 0001' } }, r, deps(db({ dup: true }), NOW));
  assert.equal(r.body.error, 'slot_taken', 'two at once: the unique index wins');
  r = res();
  await agenda({ method: 'POST', body: { slug: 'gael', date: '2026-12-01', time: '10:30', name: 'Bo', phone: '238 000 0001' } }, r, deps(db(), NOW));
  assert.equal(r.body.error, 'slot_taken', 'not a slot of the owner\'s hours');
});
