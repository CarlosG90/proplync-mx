/**
 * Proplync.mx · Leads (CRM inbox)
 * -----------------------------------------------------------------------------
 * GET/PATCH: auth-protected, own-agency inbox (RLS + explicit agency_id filter).
 * POST: public — a buyer contacting an agency needs no account. Uses the
 * service client to look up the listing by public_id server-side and derive
 * agency_id/listing_id itself; never trusts a client-supplied agency id.
 * Only listings with status='published' and agency-owned (source lives in
 * the listings table, not EasyBroker/sample) can receive leads here.
 * -----------------------------------------------------------------------------
 */

import { requireAgencyUser } from './_lib/auth.js';
import { getUserClient, getServiceClient } from './_lib/supabase.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'POST') {
    const { listingPublicId, name, email, phone, message } = req.body || {};
    if (!listingPublicId || !name || !email) {
      res.status(400).json({ error: 'missing_required_fields' });
      return;
    }

    const svc = getServiceClient();
    const { data: listing } = await svc
      .from('listings')
      .select('id, agency_id')
      .eq('public_id', listingPublicId)
      .eq('status', 'published')
      .maybeSingle();
    if (!listing) {
      res.status(404).json({ error: 'agency_listing_required' });
      return;
    }

    const { error } = await svc.from('leads').insert({
      agency_id: listing.agency_id,
      listing_id: listing.id,
      listing_public_id: listingPublicId,
      name,
      email,
      phone: phone || null,
      message: message || null
    });
    if (error) {
      res.status(500).json({ error: 'lead_capture_failed', detail: String(error.message) });
      return;
    }
    res.status(200).json({ ok: true });
    return;
  }

  const auth = await requireAgencyUser(req);
  if (!auth) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const db = getUserClient(auth.token);

  if (req.method === 'GET') {
    const { data, error } = await db
      .from('leads')
      .select('*')
      .eq('agency_id', auth.agencyId)
      .order('created_at', { ascending: false });
    if (error) {
      res.status(500).json({ error: 'leads_fetch_failed', detail: String(error.message) });
      return;
    }
    res.status(200).json({ leads: data });
    return;
  }

  if (req.method === 'PATCH') {
    const id = req.query.id;
    const { status } = req.body || {};
    if (!id || !['new', 'contacted', 'won', 'lost'].includes(status)) {
      res.status(400).json({ error: 'invalid_status_update' });
      return;
    }
    const { data, error } = await db
      .from('leads')
      .update({ status })
      .eq('id', id)
      .eq('agency_id', auth.agencyId)
      .select('*')
      .single();
    if (error) {
      res.status(500).json({ error: 'lead_update_failed', detail: String(error.message) });
      return;
    }
    res.status(200).json({ lead: data });
    return;
  }

  res.status(405).json({ error: 'method_not_allowed' });
}
