/**
 * Proplync.mx · Leads (CRM inbox)
 * -----------------------------------------------------------------------------
 * GET/PATCH/DELETE: auth-protected, own-agency inbox (RLS + explicit agency_id
 * filter). POST: public — a buyer contacting an agency needs no account. Uses
 * the service client to look up the listing by public_id server-side and derive
 * agency_id/listing_id itself; never trusts a client-supplied agency id.
 * Only listings with status='published' and agency-owned (source lives in
 * the listings table, not EasyBroker/sample) can receive leads here.
 *
 * Notes live on this route rather than their own file so the deployment stays
 * under Vercel's function count; `action=note` selects them. That makes the
 * method/auth split load-bearing, so it is written to fail closed: the ONLY
 * unauthenticated paths are POSTs (no `action`, `download`, `contact` and `event`), and
 * all of them are checked before anything that needs a session.
 * -----------------------------------------------------------------------------
 */

import { requireAgencyUser } from './_lib/auth.js';
import { getUserClient, getServiceClient } from './_lib/supabase.js';
import { safeDetail } from './_lib/health.js';
import { enforceRateLimit } from './_lib/ratelimit.js';
import { notifyNewLead, notifyOperator } from './_lib/notify.js';

const STATUSES = ['new', 'contacted', 'won', 'lost'];

/* The funnel (LANDING-PAGES-PLAN §7). A fixed list, so the table cannot be filled with arbitrary names. */
const EVENT_NAMES = new Set([
  'landing_view', 'cta_click', 'concierge_start', 'concierge_complete', 'brief_approved',
  'scout_result_viewed', 'verification_requested', 'agent_signup_start', 'agent_signup_complete', 'agent_request_sent'
]);

/** A short, plain label (campaign tags): letters, digits and a few separators. Anything else is dropped, not repaired. */
function cleanLabel(v, max) {
  const s = String(v == null ? '' : v).trim();
  return s && s.length <= max && /^[\w .:/+~-]+$/.test(s) ? s : null;
}

/** Event properties: a few short, plain values. Anything that looks like contact data is dropped. */
function cleanProps(p) {
  const out = {};
  if (!p || typeof p !== 'object' || Array.isArray(p)) return out;
  for (const [k, v] of Object.entries(p).slice(0, 8)) {
    if (!/^[a-z_]{1,30}$/.test(k) || k === 'page') continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') {
      const s = v.trim().slice(0, 100);
      if (s && !/@|\d{7,}/.test(s)) out[k] = s;   // no emails, no phone numbers
    }
  }
  return out;
}

/**
 * True when a write failed because the row is not this agency's (or does not
 * exist). Postgres reports the two cases differently and neither is a fault:
 *   PGRST116 - .single() matched no row, because the agency_id filter or RLS
 *              removed it
 *   42501    - RLS WITH CHECK rejected the row (a note whose parent lead the
 *              trigger resolved to someone else's agency)
 *   P0001    - the lead_notes trigger's own "lead not found" raise
 */
function isNotOursOrMissing(error) {
  if (!error) return false;
  const code = error.code || '';
  return code === 'PGRST116' || code === '42501' || code === 'P0001';
}

/** YYYY-MM-DD, or null to clear. Anything else is a client bug, not a date. */
function parseFollowUp(v) {
  if (v === null || v === '') return { ok: true, value: null };
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { ok: false };
  const d = new Date(v + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return { ok: false };
  return { ok: true, value: v };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const action = req.query.action || '';

  // -------------------------------------------------------------------------
  // Public: a buyer submitting the contact form on a property page.
  // Deliberately the first branch and narrowly guarded — no `action`, POST only.
  // -------------------------------------------------------------------------
  if (req.method === 'POST' && !action) {
    // An agent's CRM is worth little if anyone can flood it.
    if (await enforceRateLimit(req, res, { bucket: 'leads', limit: 8, windowSec: 3600 })) return;

    const { listingPublicId, name, email, phone, message,
            paymentMethod, purpose, mortgageHistory } = req.body || {};
    if (!listingPublicId || !name || !email) {
      res.status(400).json({ error: 'missing_required_fields' });
      return;
    }

    /* Las tres respuestas de calificacion son opcionales y de catalogo cerrado.
       Se filtran contra el catalogo en vez de rechazar la peticion: un valor
       raro aqui significa formulario viejo en cache o alguien jugando con la
       consola, y ninguno de los dos casos justifica tirar un lead real. El
       check de la tabla rechazaria el insert completo. */
    const oneOf = (value, allowed) => (allowed.includes(value) ? value : null);
    const qualification = {
      payment_method: oneOf(paymentMethod, ['efectivo', 'credito', 'no_se']),
      purpose: oneOf(purpose, ['habitar', 'inversion', 'reventa', 'renta']),
      mortgage_history: oneOf(mortgageHistory, ['tiene', 'tuvo', 'nunca'])
    };

    const svc = getServiceClient();
    const { data: listing } = await svc
      .from('listings')
      .select('id, agency_id, title_es, public_id')
      .eq('public_id', listingPublicId)
      .eq('status', 'published')
      .maybeSingle();
    if (!listing) {
      res.status(404).json({ error: 'agency_listing_required' });
      return;
    }

    const { data: lead, error } = await svc
      .from('leads')
      .insert({
        agency_id: listing.agency_id,
        listing_id: listing.id,
        listing_public_id: listingPublicId,
        name,
        email,
        phone: phone || null,
        message: message || null,
        source: 'web',
        ...qualification
      })
      .select('id, name, email, phone, message, created_at, payment_method, purpose, mortgage_history')
      .single();
    if (error) {
      res.status(500).json({ error: 'lead_capture_failed', detail: safeDetail(error) });
      return;
    }

    // The lead is already saved. Notification is best-effort on purpose: an
    // email provider being down must never turn a captured lead into a 500
    // that tells the buyer to try again.
    try {
      await notifyNewLead({ lead, listing, agencyId: listing.agency_id });
    } catch (e) {
      console.error('lead_notify_failed', safeDetail(e));
    }

    res.status(200).json({ ok: true });
    return;
  }

  // -------------------------------------------------------------------------
  // Public: a visitor downloading generated content leaves a contact first.
  // These are prospects for Proplync itself, not an agency's buyers, which is
  // why they land in download_leads rather than `leads`.
  // -------------------------------------------------------------------------
  if (req.method === 'POST' && action === 'download') {
    if (await enforceRateLimit(req, res, { bucket: 'download-lead', limit: 12, windowSec: 3600 })) return;

    const { name, email, phone, listingPublicId } = req.body || {};
    if (!email || !phone) {
      res.status(400).json({ error: 'email_and_phone_required' });
      return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email))) {
      res.status(400).json({ error: 'invalid_email' });
      return;
    }
    // Loose on purpose: Mexican numbers get written half a dozen ways and a
    // strict pattern here costs real leads to save a little tidiness.
    if (String(phone).replace(/\D/g, '').length < 8) {
      res.status(400).json({ error: 'invalid_phone' });
      return;
    }

    // Attribute it to the agency when a signed-in one is downloading, so these
    // can be told apart from cold traffic later.
    let agencyId = null;
    try {
      const auth = await requireAgencyUser(req);
      if (auth) agencyId = auth.agencyId;
    } catch { /* anonymous is the normal case here */ }

    const { error } = await getServiceClient().from('download_leads').insert({
      name: name ? String(name).slice(0, 120) : null,
      email: String(email).slice(0, 200).toLowerCase(),
      phone: String(phone).slice(0, 40),
      listing_public_id: listingPublicId ? String(listingPublicId).slice(0, 60) : null,
      agency_id: agencyId,
      source: 'generate'
    });
    if (error) {
      res.status(500).json({ error: 'download_lead_failed', detail: safeDetail(error) });
      return;
    }
    res.status(200).json({ ok: true });
    return;
  }

  // -------------------------------------------------------------------------
  // Public: the "request a diagnosis" form on /agencias. Prospects for Proplync
  // itself, like download_leads, but with the company, type and message the
  // call needs. Before this existed the form only showed a success message and
  // opened a mailto window, so a visitor who closed it was lost without knowing.
  // -------------------------------------------------------------------------
  if (req.method === 'POST' && action === 'contact') {
    if (await enforceRateLimit(req, res, { bucket: 'contact-request', limit: 6, windowSec: 3600 })) return;

    const { name, company, email, phone, type, message, lang, website, source } = req.body || {};

    // Honeypot: the form carries a field no person sees. Bots fill it; answer
    // as if it worked so they learn nothing, and store nothing.
    if (website) {
      res.status(200).json({ ok: true });
      return;
    }

    const cleanName = String(name || '').trim();
    if (!cleanName || !email) {
      res.status(400).json({ error: 'name_and_email_required' });
      return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email))) {
      res.status(400).json({ error: 'invalid_email' });
      return;
    }
    // Phone is optional here; when given it only has to look like a number.
    if (phone && String(phone).replace(/\D/g, '').length < 8) {
      res.status(400).json({ error: 'invalid_phone' });
      return;
    }

    const kind = ['agency', 'owner', 'developer', 'agent', 'other'].includes(type) ? type : 'other';
    const row = {
      name: cleanName.slice(0, 120),
      company: company ? String(company).trim().slice(0, 160) : null,
      email: String(email).trim().slice(0, 200).toLowerCase(),
      phone: phone ? String(phone).trim().slice(0, 40) : null,
      kind,
      message: message ? String(message).trim().slice(0, 2000) : null,
      lang: lang === 'en' ? 'en' : 'es',
      /* Which form it came from, from a short list: the client never gets to invent a label. */
      source: ['agencias', 'agents'].includes(source) ? source : 'agencias'
    };

    const { error } = await getServiceClient().from('contact_requests').insert(row);
    if (error) {
      res.status(500).json({ error: 'contact_request_failed', detail: safeDetail(error) });
      return;
    }

    // The row is the record; the email is only a nudge. It can fail or be
    // unconfigured without the visitor's request being lost.
    try {
      await notifyOperator({
        subject: `Solicitud de diagnóstico: ${row.name}${row.company ? ' · ' + row.company : ''}`,
        text: [
          `Nombre: ${row.name}`,
          `Empresa: ${row.company || '-'}`,
          `Email: ${row.email}`,
          `WhatsApp: ${row.phone || '-'}`,
          `Tipo: ${row.kind}`,
          `Idioma: ${row.lang}`,
          '',
          row.message || '(sin mensaje)'
        ].join('\n')
      });
    } catch (e) {
      console.error('contact_notify_failed', safeDetail(e));
    }

    res.status(200).json({ ok: true });
    return;
  }

  // -------------------------------------------------------------------------
  // Public: one funnel event from a visitor's browser (supabase/014_events.sql). Anonymous by design: a random
  // id that lives in the visitor's tab, never an IP, a name or an email. Write-only: nothing is read back.
  // -------------------------------------------------------------------------
  if (req.method === 'POST' && action === 'event') {
    if (await enforceRateLimit(req, res, { bucket: 'event', limit: 240, windowSec: 3600 })) return;
    const b = req.body || {};
    if (!EVENT_NAMES.has(b.name)) { res.status(400).json({ error: 'unknown_event' }); return; }
    const session = String(b.session || '');
    if (!/^[a-z0-9-]{8,40}$/.test(session)) { res.status(400).json({ error: 'invalid_session' }); return; }
    const host = String(b.ref_host || '').toLowerCase();
    const row = {
      name: b.name,
      page: /^[a-z0-9_-]{1,40}$/.test(String(b.page || '')) ? b.page : 'unknown',
      session,
      lang: b.lang === 'en' ? 'en' : b.lang === 'es' ? 'es' : null,
      utm_source: cleanLabel(b.utm_source, 80),
      utm_medium: cleanLabel(b.utm_medium, 80),
      utm_campaign: cleanLabel(b.utm_campaign, 80),
      ref_host: /^[a-z0-9.-]{1,100}$/.test(host) ? host : null,
      props: cleanProps(b.props)
    };
    const { error } = await getServiceClient().from('events').insert(row);
    if (error) {
      res.status(500).json({ error: 'event_failed', detail: safeDetail(error) });
      return;
    }
    res.status(202).json({ ok: true });
    return;
  }

  // -------------------------------------------------------------------------
  // Everything below requires an authenticated agency user.
  // -------------------------------------------------------------------------
  const auth = await requireAgencyUser(req);
  if (!auth) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const db = getUserClient(auth.token);

  // ---- Notes -------------------------------------------------------------
  if (action === 'note') {
    const leadId = req.query.id;

    if (req.method === 'GET') {
      if (!leadId) { res.status(400).json({ error: 'lead_id_required' }); return; }
      const { data, error } = await db
        .from('lead_notes')
        .select('id, body, created_at, author_id')
        .eq('lead_id', leadId)
        .order('created_at', { ascending: false });
      if (error) {
        res.status(500).json({ error: 'notes_fetch_failed', detail: safeDetail(error) });
        return;
      }
      res.status(200).json({ notes: data });
      return;
    }

    if (req.method === 'POST') {
      const body = String((req.body || {}).body || '').trim();
      if (!leadId || !body) { res.status(400).json({ error: 'lead_id_and_body_required' }); return; }
      if (body.length > 4000) { res.status(400).json({ error: 'note_too_long' }); return; }

      // agency_id is omitted deliberately: the lead_notes_set_agency trigger
      // derives it from the parent lead, so a note cannot be filed against
      // another agency's lead even though RLS alone would allow the shape.
      const { data, error } = await db
        .from('lead_notes')
        .insert({ lead_id: leadId, author_id: auth.user.id, body })
        .select('id, body, created_at, author_id')
        .single();
      if (error) {
        // 404 rather than 403 for a lead that belongs to someone else: telling
        // a caller "that exists but isn't yours" turns this into an oracle for
        // enumerating other agencies' lead ids.
        if (isNotOursOrMissing(error)) {
          res.status(404).json({ error: 'lead_not_found' });
          return;
        }
        res.status(500).json({ error: 'note_create_failed', detail: safeDetail(error) });
        return;
      }

      // Writing a note IS contact. Stamping it here means the agent never has
      // to remember to also tick a "contacted" box for the chase list to work.
      await db
        .from('leads')
        .update({ last_contacted_at: new Date().toISOString() })
        .eq('id', leadId)
        .eq('agency_id', auth.agencyId);

      res.status(200).json({ note: data });
      return;
    }

    if (req.method === 'DELETE') {
      // Here `id` addresses the NOTE, not the lead. No agency filter is added:
      // the lead_notes_delete_own RLS policy is the check, and `db` is the
      // user-scoped client, so another agency's note simply matches no row.
      const noteId = req.query.id;
      if (!noteId) { res.status(400).json({ error: 'note_id_required' }); return; }
      const { error } = await db.from('lead_notes').delete().eq('id', noteId);
      if (error) {
        res.status(500).json({ error: 'note_delete_failed', detail: safeDetail(error) });
        return;
      }
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  // ---- Lead list ---------------------------------------------------------
  if (req.method === 'GET') {
    const { data, error } = await db
      .from('leads')
      .select('*, lead_notes(count)')
      .eq('agency_id', auth.agencyId)
      .order('created_at', { ascending: false });
    if (error) {
      res.status(500).json({ error: 'leads_fetch_failed', detail: safeDetail(error) });
      return;
    }
    // Flatten the embedded aggregate so the client reads `noteCount`
    // instead of digging through a one-element relation array.
    const leads = (data || []).map(l => {
      const { lead_notes, ...rest } = l;
      return { ...rest, noteCount: (lead_notes && lead_notes[0] && lead_notes[0].count) || 0 };
    });
    res.status(200).json({ leads });
    return;
  }

  // ---- Lead update -------------------------------------------------------
  if (req.method === 'PATCH') {
    const id = req.query.id;
    if (!id) { res.status(400).json({ error: 'lead_id_required' }); return; }

    const body = req.body || {};
    const patch = {};

    if ('status' in body) {
      if (!STATUSES.includes(body.status)) {
        res.status(400).json({ error: 'invalid_status_update' });
        return;
      }
      patch.status = body.status;
      // Moving a lead off 'new' is an admission that someone reached out.
      if (body.status !== 'new') patch.last_contacted_at = new Date().toISOString();
    }

    if ('nextFollowUp' in body) {
      const parsed = parseFollowUp(body.nextFollowUp);
      if (!parsed.ok) { res.status(400).json({ error: 'invalid_follow_up_date' }); return; }
      patch.next_follow_up = parsed.value;
    }

    if (body.markContacted === true) patch.last_contacted_at = new Date().toISOString();

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'nothing_to_update' });
      return;
    }

    const { data, error } = await db
      .from('leads')
      .update(patch)
      .eq('id', id)
      .eq('agency_id', auth.agencyId)
      .select('*')
      .single();
    if (error) {
      // Same reasoning as the note insert, and it also covers the ordinary
      // case of patching a lead that was deleted in another tab.
      if (isNotOursOrMissing(error)) {
        res.status(404).json({ error: 'lead_not_found' });
        return;
      }
      res.status(500).json({ error: 'lead_update_failed', detail: safeDetail(error) });
      return;
    }
    res.status(200).json({ lead: data });
    return;
  }

  res.status(405).json({ error: 'method_not_allowed' });
}
