/**
 * PropLync Mini · the customer's panel API
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * mini/panel.html is where a Mini customer edits their page: their card, up to
 * 10 properties, photos, and telling us they paid. Everything here needs the
 * customer's session (email code; Supabase Auth shared with PropLync).
 *
 * WHAT IT DOES
 *   GET/POST/PUT/DELETE  (?resource=agency, ?id=)  the agency card and listings.
 *       Delegated to api/my-listings.js, so plan caps (10 listings, photo cap),
 *       field validation (api/_lib/listing-fields.js), RLS and the search mirror
 *       are the same rules the PropLync dashboard runs.
 *   POST ?action=paid-notice  "Ya pagué": the customer reports a payment.
 *   GET/POST/PUT/DELETE ?resource=services (&id=)  the services catalog
 *       (mini_services, supabase/019; rules in api/_services.js).
 *   GET ?action=preview&slug=  the customer's own page as buyers will see it,
 *       drafts included, before it is paid. Only for the signed-in owner of that
 *       slug: the preview address (/:slug?vista=1) carries no secret, so a shared
 *       link shows nothing to anyone else (api/page.js).
 *
 * WHY THE PAYMENT NOTICE IS AN EVENTS ROW, NOT ONLY AN EMAIL
 * Payment is collected by hand until Mercado Pago is connected, and the operator
 * email (Resend) can be unconfigured or fail. A notice that only lived in an
 * email could be lost, and the customer would wait for nothing. So it is written
 * to the events table first (supabase/014_events.sql: service role only, no
 * schema change) and `node scripts/mini.mjs list` shows it; the email is the
 * nudge.
 * -----------------------------------------------------------------------------
 */

import listingsHandler from './_proplync/my-listings.js';
import { requireAgencyUser } from './_proplync/_lib/auth.js';
import { getServiceClient } from './_proplync/_lib/supabase.js';
import { enforceRateLimit } from './_proplync/_lib/ratelimit.js';
import { safeDetail, logDegraded } from './_proplync/_lib/health.js';
import { miniState, MINI_PRICE_MXN } from './_proplync/_lib/plans.js';
import { notifyOperator } from './_proplync/_lib/notify.js';
import { buildModel, AGENCY_FIELDS, LISTING_FIELDS } from './_page-model.js';
import { handleServices, PUBLIC_SERVICE_FIELDS } from './_services.js';

export const PAY_METHODS = ['transfer', 'deposit', 'oxxo', 'other'];

/** The customer's report → a clean notice, or an error code. Pure, for tests. */
export function cleanNotice(body) {
  const b = body && typeof body === 'object' ? body : {};
  const method = String(b.method || '');
  if (!PAY_METHODS.includes(method)) return { error: 'invalid_method' };
  const reference = String(b.reference || '').trim();
  if (reference.length > 80) return { error: 'reference_too_long' };
  const note = String(b.note || '').trim();
  if (note.length > 300) return { error: 'note_too_long' };
  return { notice: { method, reference, note } };
}

export async function handlePaidNotice(req, res, deps = {}) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  if (await (deps.enforceRateLimit || enforceRateLimit)(req, res, { bucket: 'mini-paid', limit: 5, windowSec: 3600 })) return;

  const auth = await (deps.requireAgencyUser || requireAgencyUser)(req);
  if (!auth) { res.status(401).json({ error: 'unauthorized' }); return; }

  const { notice, error } = cleanNotice(req.body);
  if (error) { res.status(400).json({ error }); return; }

  const svc = (deps.getServiceClient || getServiceClient)();
  try {
    const { data: agency, error: agErr } = await svc.from('agencies')
      .select('id, name, slug, plan, plan_expires_at, whatsapp_number').eq('id', auth.agencyId).maybeSingle();
    if (agErr) throw agErr;
    if (!agency || String(agency.plan || '').toLowerCase() !== 'mini') { res.status(400).json({ error: 'not_a_mini_page' }); return; }

    const state = miniState(agency);
    const { error: evErr } = await svc.from('events').insert({
      name: 'mini_paid_notice',
      page: 'panel',
      session: agency.id,
      props: { slug: agency.slug, method: notice.method, reference: notice.reference.slice(0, 80), state: state && state.state }
    });
    if (evErr) throw evErr;

    await (deps.notifyOperator || notifyOperator)({
      subject: `Mini: aviso de pago (${agency.name})`,
      text: `${agency.name} dice que ya pago (MXN ${MINI_PRICE_MXN}).\n` +
        `Metodo: ${notice.method}\nReferencia: ${notice.reference || '-'}\nNota: ${notice.note || '-'}\n` +
        `Correo: ${auth.user && auth.user.email || '-'}\nWhatsApp: ${agency.whatsapp_number || '-'}\n` +
        `Estado actual: ${state ? state.state : '-'}\nSlug: ${agency.slug}\n\n` +
        `Verifica el pago y luego: node scripts/mini.mjs activate ${agency.slug}`
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    logDegraded('mini:paid-notice', err);
    res.status(500).json({ error: 'paid_notice_failed', detail: safeDetail(err) });
  }
}

/** The owner's page as it will look, before it is paid. Signed in, own page only, never cached. */
export async function handlePreview(req, res, deps = {}) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  if (await (deps.enforceRateLimit || enforceRateLimit)(req, res, { bucket: 'mini-preview', limit: 120, windowSec: 3600 })) return;
  res.setHeader('Cache-Control', 'no-store');

  const auth = await (deps.requireAgencyUser || requireAgencyUser)(req);
  if (!auth) { res.status(401).json({ error: 'unauthorized' }); return; }

  const svc = (deps.getServiceClient || getServiceClient)();
  try {
    const { data: agency, error } = await svc.from('agencies')
      .select(AGENCY_FIELDS).eq('id', auth.agencyId).maybeSingle();
    if (error) throw error;
    if (!agency || String(agency.plan || '').toLowerCase() !== 'mini') { res.status(400).json({ error: 'not_a_mini_page' }); return; }
    // Signed in, but as someone else: the preview of another page is not theirs to see.
    const slug = String((req.query && req.query.slug) || '').toLowerCase();
    if (slug && slug !== agency.slug) { res.status(403).json({ error: 'not_your_page' }); return; }
    const { data: listings, error: lErr } = await svc.from('listings').select(LISTING_FIELDS)
      .eq('agency_id', agency.id).in('status', ['published', 'draft']).order('created_at', { ascending: false }).limit(30);
    if (lErr) throw lErr;
    // Hidden services stay hidden in the preview too: it shows what clients will see.
    const { data: services, error: sErr } = await svc.from('mini_services').select(PUBLIC_SERVICE_FIELDS)
      .eq('agency_id', agency.id).eq('status', 'published').order('sort', { ascending: true }).limit(40);
    if (sErr) throw sErr;
    res.status(200).json(buildModel(agency, listings || [], Date.now(), { preview: true, services: services || [] }));
  } catch (err) {
    logDegraded('mini:preview', err);
    res.status(500).json({ error: 'preview_failed', detail: safeDetail(err) });
  }
}

/** The services catalog. Signed in; only the caller's own agency's rows. */
export async function handleServicesRoute(req, res, deps = {}) {
  if (await (deps.enforceRateLimit || enforceRateLimit)(req, res, req.method === 'GET'
    ? { bucket: 'mini-services-read', limit: 240, windowSec: 3600 }
    : { bucket: 'mini-services-write', limit: 90, windowSec: 3600 })) return;
  res.setHeader('Cache-Control', 'no-store');
  const auth = await (deps.requireAgencyUser || requireAgencyUser)(req);
  if (!auth) { res.status(401).json({ error: 'unauthorized' }); return; }
  const svc = (deps.getServiceClient || getServiceClient)();
  try {
    await handleServices(req, res, { auth, svc });
  } catch (err) {
    logDegraded('mini:services', err);
    res.status(500).json({ error: 'services_failed', detail: safeDetail(err) });
  }
}

export default async function handler(req, res) {
  if (req.query && req.query.resource === 'services') return handleServicesRoute(req, res);
  if (req.query && req.query.action === 'paid-notice') return handlePaidNotice(req, res);
  if (req.query && req.query.action === 'preview') return handlePreview(req, res);
  return listingsHandler(req, res);
}
