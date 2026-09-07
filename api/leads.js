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
 * unauthenticated path is a POST with no `action`, and it is checked first.
 * -----------------------------------------------------------------------------
 */

import { requireAgencyUser } from './_lib/auth.js';
import { getUserClient, getServiceClient } from './_lib/supabase.js';
import { safeDetail } from './_lib/health.js';
import { enforceRateLimit } from './_lib/ratelimit.js';
import { notifyNewLead } from './_lib/notify.js';

const STATUSES = ['new', 'contacted', 'won', 'lost'];

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

    const { listingPublicId, name, email, phone, message } = req.body || {};
    if (!listingPublicId || !name || !email) {
      res.status(400).json({ error: 'missing_required_fields' });
      return;
    }

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
        source: 'web'
      })
      .select('id, name, email, phone, message, created_at')
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
      res.status(500).json({ error: 'lead_update_failed', detail: safeDetail(error) });
      return;
    }
    res.status(200).json({ lead: data });
    return;
  }

  res.status(405).json({ error: 'method_not_allowed' });
}
