/**
 * PropLync Mini · "Agendar cita" for clients (public)
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * The Mini page's "Agendar cita": a client sees the free days and times and asks
 * for one; the owner approves it in the panel and answers on WhatsApp.
 *
 *   GET  ?slug=           the free times for the next days, and the services to pick
 *   POST { slug, date, time, name, phone, service_id?, note? }   one request
 *
 * WHAT IS PUBLIC
 * Only a paid page with the agenda switched on. Free times only: never who booked.
 * The slot is checked against the owner's settings and the times already taken,
 * and the database's partial unique index refuses a second booking of the same
 * time even when two clients press at once (409 slot_taken).
 * With the CRM add-on active, a request also becomes a lead under its service.
 * -----------------------------------------------------------------------------
 */
import { getServiceClient } from './_proplync/_lib/supabase.js';
import { pageActive, crmActive } from './_proplync/_lib/plans.js';
import { enforceRateLimit } from './_proplync/_lib/ratelimit.js';
import { safeDetail, logDegraded } from './_proplync/_lib/health.js';
import { agendaConfig, freeSlots, cleanBooking, localToUtc } from './_agenda.js';

const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

async function loadPage(svc, slug) {
  const { data: agency, error } = await svc.from('agencies').select('id, slug, name, plan, plan_expires_at, crm_until, agenda').eq('slug', slug).maybeSingle();
  if (error) throw error;
  if (!agency || String(agency.plan || '').toLowerCase() !== 'mini' || !pageActive(agency)) return null;
  const config = agendaConfig(agency.agenda);
  return config.enabled ? { agency, config } : null;
}
async function takenTimes(svc, agencyId, now) {
  const { data, error } = await svc.from('mini_appointments').select('starts_at').eq('agency_id', agencyId)
    .in('status', ['requested', 'confirmed']).gte('starts_at', new Date(now).toISOString()).limit(2000);
  if (error) throw error;
  return (data || []).map((r) => r.starts_at);
}

export default async function handler(req, res, deps = {}) {
  const svc = (deps.getServiceClient || getServiceClient)();
  const now = (deps.now || Date.now)();
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      if (await (deps.enforceRateLimit || enforceRateLimit)(req, res, { bucket: 'mini-agenda-read', limit: 300, windowSec: 3600 })) return;
      const slug = String((req.query && req.query.slug) || '').toLowerCase();
      if (!SLUG.test(slug)) { res.status(400).json({ error: 'invalid_slug' }); return; }
      const page = await loadPage(svc, slug);
      if (!page) { res.status(404).json({ error: 'agenda_off' }); return; }
      const { data: svcs, error } = await svc.from('mini_services').select('id, title_es, title_en')
        .eq('agency_id', page.agency.id).eq('status', 'published').order('sort', { ascending: true }).limit(40);
      if (error) throw error;
      res.status(200).json({
        tz: page.config.tz, slot: page.config.slot, days: page.config.days, ahead: page.config.ahead,
        slots: freeSlots(page.config, await takenTimes(svc, page.agency.id, now), now),
        services: (svcs || []).map((x) => ({ id: x.id, title_es: x.title_es, title_en: x.title_en }))
      });
      return;
    }
    if (req.method === 'POST') {
      if (await (deps.enforceRateLimit || enforceRateLimit)(req, res, { bucket: 'mini-agenda-book', limit: 6, windowSec: 3600 })) return;
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const slug = String(body.slug || '').toLowerCase();
      if (!SLUG.test(slug)) { res.status(400).json({ error: 'invalid_slug' }); return; }
      const { booking, error } = cleanBooking(body);
      if (error) { res.status(400).json({ error }); return; }
      const page = await loadPage(svc, slug);
      if (!page) { res.status(404).json({ error: 'agenda_off' }); return; }
      const free = freeSlots(page.config, await takenTimes(svc, page.agency.id, now), now);
      const day = free.find((d) => d.date === booking.date);
      if (!day || !day.times.includes(booking.time)) { res.status(409).json({ error: 'slot_taken' }); return; }
      if (booking.service_id) {
        const { data: s } = await svc.from('mini_services').select('id').eq('id', booking.service_id).eq('agency_id', page.agency.id).maybeSingle();
        if (!s) booking.service_id = null;
      }
      const startsAt = new Date(localToUtc(booking.date, booking.time, page.config.tz)).toISOString();
      const { data, error: iErr } = await svc.from('mini_appointments').insert({
        agency_id: page.agency.id, service_id: booking.service_id, starts_at: startsAt, minutes: page.config.slot,
        client_name: booking.client_name, client_phone: booking.client_phone, note: booking.note, status: 'requested'
      }).select('id, starts_at').single();
      if (iErr) {
        if (iErr.code === '23505') { res.status(409).json({ error: 'slot_taken' }); return; }
        throw iErr;
      }
      // The CRM add-on also files it as a lead under its service (never blocks the booking).
      if (crmActive(page.agency, now)) {
        const { error: cErr } = await svc.from('mini_cases').insert({
          agency_id: page.agency.id, source: 'agenda', status: 'lead', client_name: booking.client_name, client_phone: booking.client_phone,
          service_id: booking.service_id, notes: `Cita solicitada: ${booking.date} ${booking.time}` + (booking.note ? ` · ${booking.note}` : '')
        });
        if (cErr) logDegraded('mini:agenda-lead', cErr);
      }
      res.status(201).json({ ok: true, id: data.id, starts_at: data.starts_at });
      return;
    }
    res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    logDegraded('mini:agenda', err);
    res.status(500).json({ error: 'agenda_failed', detail: safeDetail(err) });
  }
}
