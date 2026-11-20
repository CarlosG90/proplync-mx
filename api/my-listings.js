/**
 * Proplync.mx · Agent's own listings — CRUD
 * -----------------------------------------------------------------------------
 * Auth-protected (requireAgencyUser). Uses the caller's own token
 * (getUserClient) so RLS enforces tenant isolation on every query — but note
 * RLS's select policy is "published OR own agency" (needed for the public
 * buyer-facing side), so GET here still explicitly filters .eq('agency_id', ...)
 * to show only this agency's rows (including drafts), not every published
 * listing site-wide.
 *
 * agency_id is always taken from the verified token server-side, never from
 * the request body — an agent can only ever write into their own agency.
 * -----------------------------------------------------------------------------
 */

import { requireAgencyUser } from './_lib/auth.js';
import { getUserClient, getServiceClient } from './_lib/supabase.js';
import { findStockPhoto } from './_lib/photos.js';
import { safeDetail } from './_lib/health.js';
import { planFor, planStatus, listingLimit } from './_lib/plans.js';
import { waitUntil } from '@vercel/functions';
import { syncProplync, embedPending } from './_lib/search/index-writer.js';
import { logDegraded } from './_lib/health.js';
import {
  BadField, AGENCY_SELECT, pickAgencyWritable, validateAgencyFields,
  validateListingFields, capPhotos, pickWritable
} from './_lib/listing-fields.js';

/* Search reads the index (api/_lib/search), not this table, so every saved
   change is mirrored there right away, in the background: the agent's save
   never waits on it, and the nightly crawl reconciles anything missed. */
function reindex(publicId) {
  if (!publicId) return;
  const svc = getServiceClient();
  waitUntil(syncProplync(svc, { publicIds: [publicId] })
    .then(() => embedPending(svc, { limit: 5 }))
    .catch((err) => logDegraded('search:reindex', err)));
}

// Agency profile (branding + WhatsApp for the public mini-site). Folded into
// this file rather than a standalone api/agency-settings.js to stay under
// Vercel Hobby's 12-serverless-function cap. PATCH uses the service client:
// agencies has no update RLS policy (schema.sql: agency writes only happen
// server-side), and agency_id is always taken from the verified token, never
// the request body — same rule as the listings handlers below.
async function handleAgencyResource(req, res, auth) {
  if (req.method === 'GET') {
    const db = getUserClient(auth.token);
    const { data, error } = await db
      .from('agencies')
      .select(AGENCY_SELECT)
      .eq('id', auth.agencyId)
      .single();
    if (error) throw error;
    res.status(200).json({ agency: data });
    return;
  }

  if (req.method === 'PATCH') {
    const fields = validateAgencyFields(pickAgencyWritable(req.body || {}));
    const svc = getServiceClient();
    const { data, error } = await svc
      .from('agencies')
      .update(fields)
      .eq('id', auth.agencyId)
      .select(AGENCY_SELECT)
      .single();
    if (error) throw error;
    res.status(200).json({ agency: data });
    return;
  }

  res.status(405).json({ error: 'method_not_allowed' });
}

// Agents who create a listing without uploading their own photo would
// otherwise ship with a blank image on /search and /property. Only runs on
// create (not on update) so an agent who deliberately clears a photo via PUT
// isn't silently overridden.
function buildPhotoQuery(fields) {
  const kind = fields.operation === 'rental' ? 'apartment for rent interior' : 'house for sale exterior';
  const place = [fields.neighborhood, fields.town].filter(Boolean).join(' ');
  return `${kind} ${place}`.trim();
}

async function fillMissingPhoto(fields) {
  if (fields.image) return fields;
  const query = buildPhotoQuery(fields);
  if (!query) return fields;
  const photo = await findStockPhoto(query);
  if (photo && photo.image) return { ...fields, image: photo.image };
  return fields;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const auth = await requireAgencyUser(req);
  if (!auth) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const db = getUserClient(auth.token);

  try {
    if (req.query.resource === 'agency') {
      await handleAgencyResource(req, res, auth);
      return;
    }

    if (req.method === 'GET') {
      const { data, error } = await db
        .from('listings')
        .select('*')
        .eq('agency_id', auth.agencyId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      // Usage travels with the list so the dashboard can show "3 de 10" and
      // disable the create button without a second round trip.
      const { data: agencyRow } = await getServiceClient()
        .from('agencies').select('plan, marketing_trials_used, plan_expires_at').eq('id', auth.agencyId).maybeSingle();
      res.status(200).json({
        listings: data,
        plan: planStatus(agencyRow, (data || []).length)
      });
      return;
    }

    if (req.method === 'POST') {
      let fields = validateListingFields(pickWritable(req.body || {}));
      if (!fields.operation) {
        res.status(400).json({ error: 'missing_operation' });
        return;
      }

      // Plan caps. Enforced here rather than only in the dashboard, because a
      // limit the client draws but the server ignores is decoration — the
      // /generate publish handoff and any direct API call walk straight past it.
      const svc = getServiceClient();
      const [agencyRes, countRes] = await Promise.all([
        svc.from('agencies').select('plan, marketing_trials_used, plan_expires_at').eq('id', auth.agencyId).maybeSingle(),
        svc.from('listings').select('id', { count: 'exact', head: true }).eq('agency_id', auth.agencyId)
      ]);
      const plan = planFor(agencyRes.data);
      const limit = listingLimit(agencyRes.data);
      const used = countRes.count || 0;
      if (used >= limit) {
        res.status(409).json({
          error: 'listing_limit_reached', plan: plan.id, limit, used
        });
        return;
      }
      fields = capPhotos(fields, plan);

      // A Mini page is one agent showing their own inventory to buyers; a stock photo of some
      // other house on it would read as that property. Mini cards show a "no photo yet" tile instead.
      if (plan.id !== 'mini') fields = await fillMissingPhoto(fields);
      const { data, error } = await db
        .from('listings')
        .insert({ ...fields, agency_id: auth.agencyId })
        .select('*')
        .single();
      if (error) throw error;
      reindex(data && data.public_id);
      res.status(200).json({ listing: data });
      return;
    }

    if (req.method === 'PUT' || req.method === 'PATCH') {
      const id = req.query.id;
      if (!id) {
        res.status(400).json({ error: 'missing_id' });
        return;
      }
      let fields = validateListingFields(pickWritable(req.body || {}));
      // The photo cap applies on edit too, or it would be trivially bypassed by
      // creating within the limit and then adding more.
      const { data: agencyRow } = await getServiceClient()
        .from('agencies').select('plan, marketing_trials_used, plan_expires_at').eq('id', auth.agencyId).maybeSingle();
      fields = capPhotos(fields, planFor(agencyRow));
      fields.updated_at = new Date().toISOString();
      const { data, error } = await db
        .from('listings')
        .update(fields)
        .eq('id', id)
        .eq('agency_id', auth.agencyId)
        .select('*')
        .single();
      if (error) throw error;
      reindex(data && data.public_id);
      res.status(200).json({ listing: data });
      return;
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) {
        res.status(400).json({ error: 'missing_id' });
        return;
      }
      // Remember which listing it was, so search can retire it once it is gone.
      const { data: gone } = await db.from('listings').select('public_id').eq('id', id).eq('agency_id', auth.agencyId).maybeSingle();
      const { error } = await db
        .from('listings')
        .delete()
        .eq('id', id)
        .eq('agency_id', auth.agencyId);
      if (error) throw error;
      reindex(gone && gone.public_id);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    if (err instanceof BadField) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: 'listings_operation_failed', detail: safeDetail(err) });
  }
}
