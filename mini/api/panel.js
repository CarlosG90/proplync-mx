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

import listingsHandler from '../../api/my-listings.js';
import { requireAgencyUser } from '../../api/_lib/auth.js';
import { getServiceClient } from '../../api/_lib/supabase.js';
import { enforceRateLimit } from '../../api/_lib/ratelimit.js';
import { safeDetail, logDegraded } from '../../api/_lib/health.js';
import { miniState, MINI_PRICE_MXN } from '../../api/_lib/plans.js';
import { notifyOperator } from '../../api/_lib/notify.js';

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

export default async function handler(req, res) {
  if (req.query && req.query.action === 'paid-notice') return handlePaidNotice(req, res);
  return listingsHandler(req, res);
}
