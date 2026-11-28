/**
 * PropLync Mini · "Agendar cita": the owner's settings, the free times, one request
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * Clients book from the Mini page (mini/api/agenda.js); the owner approves in the
 * panel (mini/api/panel.js ?resource=agenda). This file is the shared, pure part:
 * what settings are allowed, which times are free, and what a request must carry.
 *
 * WHY TIME ZONES
 * Mexico has several (Cancún is UTC-5, CDMX UTC-6, Tijuana UTC-8 most of the
 * year). The owner's hours are local; appointments are stored as UTC instants
 * (mini_appointments.starts_at) and shown back in the owner's zone. Offsets come
 * from Intl, so a zone that changes rules stays right without code changes.
 * -----------------------------------------------------------------------------
 */

export const TIME_ZONES = ['America/Mexico_City', 'America/Cancun', 'America/Merida', 'America/Monterrey',
  'America/Chihuahua', 'America/Mazatlan', 'America/Hermosillo', 'America/Tijuana'];
export const DEFAULT_AGENDA = { enabled: false, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', slot: 60, ahead: 30, notice: 2, tz: 'America/Mexico_City' };
export const APPOINTMENT_FIELDS = 'id, service_id, starts_at, minutes, client_name, client_phone, note, status, created_at';
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE = /^[0-9+()\-\s]{6,30}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mins = (s) => { const m = HHMM.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
const hhmm = (n) => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');

/** Stored settings (or nothing) → complete settings. Pure. */
export function agendaConfig(raw) {
  return { ...DEFAULT_AGENDA, ...(raw && typeof raw === 'object' ? raw : {}) };
}

/** The owner's form → clean settings, or { error }. Pure, for tests. */
export function cleanAgenda(body) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  if (b.enabled !== undefined) { if (typeof b.enabled !== 'boolean') return { error: 'invalid_enabled' }; out.enabled = b.enabled; }
  if (b.days !== undefined) {
    if (!Array.isArray(b.days) || !b.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return { error: 'invalid_days' };
    out.days = [...new Set(b.days)].sort();
    if (!out.days.length) return { error: 'invalid_days' };
  }
  for (const k of ['start', 'end']) if (b[k] !== undefined) { if (!HHMM.test(String(b[k]))) return { error: 'invalid_' + k }; out[k] = b[k]; }
  if (b.slot !== undefined) { if (![15, 20, 30, 45, 60, 90, 120].includes(b.slot)) return { error: 'invalid_slot' }; out.slot = b.slot; }
  if (b.ahead !== undefined) { if (!Number.isInteger(b.ahead) || b.ahead < 1 || b.ahead > 90) return { error: 'invalid_ahead' }; out.ahead = b.ahead; }
  if (b.notice !== undefined) { if (!Number.isInteger(b.notice) || b.notice < 0 || b.notice > 72) return { error: 'invalid_notice' }; out.notice = b.notice; }
  if (b.tz !== undefined) { if (!TIME_ZONES.includes(b.tz)) return { error: 'invalid_tz' }; out.tz = b.tz; }
  const merged = { ...DEFAULT_AGENDA, ...out };
  if ((out.start !== undefined || out.end !== undefined) && mins(merged.end) - mins(merged.start) < 15) return { error: 'invalid_hours' };
  return { agenda: out };
}

/** Minutes a zone is ahead of UTC at an instant (negative for Mexico). */
export function tzOffset(tz, instant) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(instant)).reduce((a, x) => (a[x.type] = x.value, a), {});
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60000);
}
/** A local date + time in a zone → the UTC instant (ms). */
export function localToUtc(date, time, tz) {
  const [y, mo, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d, Math.floor(mins(time) / 60), mins(time) % 60);
  const first = guess - tzOffset(tz, guess) * 60000;
  return guess - tzOffset(tz, first) * 60000;
}
/** A UTC instant → { date: 'YYYY-MM-DD', time: 'HH:MM', weekday 0-6 } in a zone. */
export function utcToLocal(instant, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
    .formatToParts(new Date(instant)).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${String(+p.hour % 24).padStart(2, '0')}:${p.minute}`,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}

/**
 * The free times for the next `ahead` days: [{ date, weekday, times: ['09:00', …] }], one entry per day in the
 * window (empty times = not bookable; the page strikes it through). `taken` are instants already requested or
 * confirmed. Times closer than `notice` hours from now are not offered. Pure, for tests.
 */
export function freeSlots(rawConfig, taken = [], now = Date.now()) {
  const c = agendaConfig(rawConfig);
  const busy = new Set(taken.map((x) => new Date(x).getTime()));
  const startM = mins(c.start), endM = mins(c.end);
  const today = utcToLocal(now, c.tz).date;
  const out = [];
  for (let i = 0; i <= c.ahead; i++) {
    const base = Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10) + i, 12);
    const date = new Date(base).toISOString().slice(0, 10);
    const weekday = new Date(base).getUTCDay();
    const times = [];
    if (c.enabled && c.days.includes(weekday)) {
      for (let m = startM; m + c.slot <= endM; m += c.slot) {
        const t = hhmm(m), at = localToUtc(date, t, c.tz);
        if (at < now + c.notice * 3600000 || busy.has(at)) continue;
        times.push(t);
      }
    }
    out.push({ date, weekday, times });
  }
  return out;
}

/** A client's request → a clean row, or { error }. The slot itself is checked against freeSlots by the caller. Pure. */
export function cleanBooking(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!DATE.test(String(b.date || ''))) return { error: 'invalid_date' };
  if (!HHMM.test(String(b.time || ''))) return { error: 'invalid_time' };
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > 120) return { error: 'invalid_name' };
  const phone = typeof b.phone === 'string' ? b.phone.trim() : '';
  if (!PHONE.test(phone) || phone.replace(/\D/g, '').length < 8) return { error: 'invalid_phone' };
  const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 500) : null;
  let service_id = null;
  if (b.service_id) { if (!UUID.test(String(b.service_id))) return { error: 'invalid_service' }; service_id = b.service_id; }
  return { booking: { date: b.date, time: b.time, client_name: name, client_phone: phone, note, service_id } };
}
