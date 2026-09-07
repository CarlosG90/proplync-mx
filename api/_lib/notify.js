/**
 * Proplync.mx · Lead notifications
 * -----------------------------------------------------------------------------
 * A lead that lands in Postgres and tells nobody is a lost lead. This sends the
 * agency owner an email the moment a buyer submits the form, with a wa.me link
 * so replying is one tap from the phone they already have in their hand.
 *
 * Every failure path is deliberately silent-but-logged. The caller has already
 * committed the lead to the database by the time this runs; an unconfigured or
 * unreachable email provider must never surface to the buyer as an error that
 * makes them think the message didn't send.
 *
 * Provider is Resend, chosen for a free tier and a single-POST API with no SDK.
 * Sending requires a verified domain — until proplync.mx is registered and
 * verified, RESEND_API_KEY should stay unset and this no-ops cleanly rather
 * than bouncing mail from an unverified sender.
 * -----------------------------------------------------------------------------
 */

import { getServiceClient } from './supabase.js';
import { logDegraded } from './health.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** Public site origin, used to build dashboard links inside the email. */
function siteOrigin() {
  return process.env.PUBLIC_SITE_URL || 'https://proplync-mx.vercel.app';
}

/** Digits-only E.164 for wa.me, which rejects '+' and spaces. */
function waNumber(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  return digits.length >= 10 ? digits : null;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Resolve who to email for an agency: the owner's auth email.
 * `agencies` carries no contact column, and inventing one would create a
 * second source of truth that drifts from the account people actually log in
 * with. The owner's login email is the address we know is real.
 */
async function ownerEmailFor(agencyId) {
  const svc = getServiceClient();

  const { data: member, error } = await svc
    .from('agency_members')
    .select('user_id')
    .eq('agency_id', agencyId)
    .eq('role', 'owner')
    .limit(1)
    .maybeSingle();
  if (error || !member) {
    logDegraded('notify:owner_lookup', error || new Error('no owner row'));
    return null;
  }

  const { data, error: userErr } = await svc.auth.admin.getUserById(member.user_id);
  if (userErr || !data || !data.user) {
    logDegraded('notify:owner_email', userErr || new Error('no auth user'));
    return null;
  }
  return data.user.email || null;
}

function renderEmail({ lead, listing }) {
  const origin = siteOrigin();
  const wa = waNumber(lead.phone);
  const listingTitle = listing.title_es || listing.public_id || 'una propiedad';

  const rows = [
    ['Nombre', lead.name],
    ['Email', lead.email],
    ['Teléfono', lead.phone || '—'],
    ['Propiedad', listingTitle]
  ].map(([k, v]) =>
    `<tr>
       <td style="padding:6px 12px 6px 0;color:#6b7280;font-size:13px;white-space:nowrap">${escapeHtml(k)}</td>
       <td style="padding:6px 0;color:#111827;font-size:14px;font-weight:600">${escapeHtml(v)}</td>
     </tr>`
  ).join('');

  const actions = [
    `<a href="${origin}/dashboard/leads" style="display:inline-block;padding:11px 18px;background:#111827;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600">Abrir el CRM</a>`,
    wa
      ? `<a href="https://wa.me/${wa}" style="display:inline-block;padding:11px 18px;background:#25d366;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;margin-left:8px">Responder por WhatsApp</a>`
      : ''
  ].join('');

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px">
  <p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#b45309">Nuevo prospecto</p>
  <h1 style="margin:0 0 16px;font-size:22px;color:#111827">${escapeHtml(lead.name)} preguntó por ${escapeHtml(listingTitle)}</h1>
  <table style="border-collapse:collapse;margin-bottom:16px">${rows}</table>
  ${lead.message ? `<div style="padding:14px 16px;background:#f9fafb;border-left:3px solid #d1d5db;border-radius:4px;margin-bottom:20px;color:#374151;font-size:14px;line-height:1.6">${escapeHtml(lead.message)}</div>` : ''}
  <div>${actions}</div>
  <p style="margin:24px 0 0;font-size:12px;color:#9ca3af">Los prospectos se responden mejor en la primera hora. Proplync.mx</p>
</div>`;

  // Plain-text alternative: some agents read mail in clients that strip HTML,
  // and a lead alert is exactly the message that must survive that.
  const text = [
    `Nuevo prospecto: ${lead.name}`,
    `Propiedad: ${listingTitle}`,
    `Email: ${lead.email}`,
    `Teléfono: ${lead.phone || '—'}`,
    lead.message ? `\nMensaje:\n${lead.message}` : '',
    `\nAbrir el CRM: ${origin}/dashboard/leads`,
    wa ? `Responder por WhatsApp: https://wa.me/${wa}` : ''
  ].filter(Boolean).join('\n');

  return { html, text, subject: `Nuevo prospecto: ${lead.name} · ${listingTitle}` };
}

/**
 * Best-effort alert for a freshly captured lead.
 * Returns a small result object for logging/tests; never throws.
 */
export async function notifyNewLead({ lead, listing, agencyId }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.LEAD_NOTIFY_FROM;

  // Not configured is a normal state before the sending domain exists, so it
  // is reported as a skip rather than logged as a degradation every time.
  if (!apiKey || !from) return { sent: false, reason: 'not_configured' };

  const to = await ownerEmailFor(agencyId);
  if (!to) return { sent: false, reason: 'no_recipient' };

  const { html, text, subject } = renderEmail({ lead, listing });

  try {
    const r = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ from, to: [to], subject, html, text, reply_to: lead.email })
    });
    if (!r.ok) {
      logDegraded('notify:resend', new Error(`${r.status} ${await r.text().catch(() => '')}`.slice(0, 300)));
      return { sent: false, reason: 'provider_error' };
    }
    return { sent: true };
  } catch (err) {
    logDegraded('notify:resend', err);
    return { sent: false, reason: 'network_error' };
  }
}
