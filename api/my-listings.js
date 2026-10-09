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
import { planFor, planStatus } from './_lib/plans.js';

const AGENCY_WRITABLE_FIELDS = ['name', 'logo_url', 'cover_url', 'primary_color', 'whatsapp_number'];

function pickAgencyWritable(body) {
  const out = {};
  for (const key of AGENCY_WRITABLE_FIELDS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

/* ── Field validation ──
   Everything an agency saves here is rendered later on buyer-facing pages:
   /search, /propiedad/:id, /agencia/:slug, the home page. The pages escape what
   they print (js/escape.js), and this is the other half: only well-typed
   values, and only URLs a page can safely load, get stored at all. Text is not
   stripped of characters; "Casa & Mar <vista>" is a fine title once escaped.
   Each check throws a BadField whose message is the 400 error code. */
class BadField extends Error {}

const IMAGE_URL = /^(https?:\/\/|data:image\/(png|jpe?g|webp|gif|avif);base64,)/i;
const TEXT_LIMITS = {
  title_es: 300, title_en: 300, town: 120, neighborhood: 120,
  description_es: 10000, description_en: 10000, property_type: 60,
  name: 120
};
const NUMERIC = ['bedrooms', 'bathrooms', 'parking', 'size', 'amount', 'lat', 'lng'];

function checkText(key, value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') throw new BadField('invalid_' + key);
  if (value.length > TEXT_LIMITS[key]) throw new BadField(key + '_too_long');
  return value;
}

function checkImageUrl(key, value) {
  if (value === null || value === undefined || value === '') return value;
  if (typeof value !== 'string' || !IMAGE_URL.test(value.trim())) throw new BadField('invalid_' + key);
  return value.trim();
}

function validateListingFields(fields) {
  const out = { ...fields };
  for (const key of Object.keys(TEXT_LIMITS)) {
    if (key in out) out[key] = checkText(key, out[key]);
  }
  for (const key of NUMERIC) {
    const v = out[key];
    // '' and null are left for the column default/constraint to decide, as before.
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'number' ? !Number.isFinite(v) : !(typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))) {
      throw new BadField('invalid_' + key);
    }
  }
  if ('currency' in out && out.currency != null) {
    if (typeof out.currency !== 'string' || !/^[A-Za-z]{3}$/.test(out.currency.trim())) throw new BadField('invalid_currency');
    out.currency = out.currency.trim().toUpperCase();
  }
  if ('image' in out) out.image = checkImageUrl('image', out.image);
  if ('images' in out && out.images != null) {
    if (!Array.isArray(out.images)) throw new BadField('invalid_images');
    out.images = out.images.map((u) => checkImageUrl('images', u)).filter(Boolean);
  }
  if ('features' in out && out.features != null) {
    if (!Array.isArray(out.features) || out.features.length > 60) throw new BadField('invalid_features');
    out.features = out.features.map((f) => {
      if (typeof f !== 'string' || f.length > 120) throw new BadField('invalid_features');
      return f.trim();
    }).filter(Boolean);
  }
  return out;
}

function validateAgencyFields(fields) {
  const out = { ...fields };
  if ('name' in out) out.name = checkText('name', out.name);
  if ('logo_url' in out) out.logo_url = checkImageUrl('logo_url', out.logo_url);
  if ('cover_url' in out) out.cover_url = checkImageUrl('cover_url', out.cover_url);
  if ('primary_color' in out && out.primary_color != null && out.primary_color !== '') {
    if (typeof out.primary_color !== 'string' || !/^#[0-9a-f]{3,8}$/i.test(out.primary_color.trim())) {
      throw new BadField('invalid_primary_color');
    }
    out.primary_color = out.primary_color.trim();
  }
  if ('whatsapp_number' in out && out.whatsapp_number != null && out.whatsapp_number !== '') {
    if (typeof out.whatsapp_number !== 'string' || !/^[0-9+()\-\s]{6,25}$/.test(out.whatsapp_number)) {
      throw new BadField('invalid_whatsapp_number');
    }
  }
  return out;
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
      .select('id, name, slug, logo_url, cover_url, primary_color, whatsapp_number')
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
      .select('id, name, slug, logo_url, cover_url, primary_color, whatsapp_number')
      .single();
    if (error) throw error;
    res.status(200).json({ agency: data });
    return;
  }

  res.status(405).json({ error: 'method_not_allowed' });
}

const WRITABLE_FIELDS = [
  'title_es', 'title_en', 'town', 'neighborhood', 'bedrooms', 'bathrooms',
  'parking', 'size', 'operation', 'currency', 'amount', 'image', 'images',
  'description_es', 'description_en', 'lat', 'lng', 'features', 'status',
  'property_type'
];

/** Trim the gallery to what the plan allows, keeping the cover photo first. */
function capPhotos(fields, plan) {
  if (!Array.isArray(fields.images)) return fields;
  if (fields.images.length <= plan.photos) return fields;
  const images = fields.images.slice(0, plan.photos);
  return { ...fields, images, image: fields.image || images[0] };
}

function pickWritable(body) {
  const out = {};
  for (const key of WRITABLE_FIELDS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
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
        .from('agencies').select('plan, marketing_trials_used').eq('id', auth.agencyId).maybeSingle();
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
        svc.from('agencies').select('plan, marketing_trials_used').eq('id', auth.agencyId).maybeSingle(),
        svc.from('listings').select('id', { count: 'exact', head: true }).eq('agency_id', auth.agencyId)
      ]);
      const plan = planFor(agencyRes.data);
      const used = countRes.count || 0;
      if (used >= plan.listings) {
        res.status(409).json({
          error: 'listing_limit_reached', plan: plan.id, limit: plan.listings, used
        });
        return;
      }
      fields = capPhotos(fields, plan);

      fields = await fillMissingPhoto(fields);
      const { data, error } = await db
        .from('listings')
        .insert({ ...fields, agency_id: auth.agencyId })
        .select('*')
        .single();
      if (error) throw error;
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
        .from('agencies').select('plan, marketing_trials_used').eq('id', auth.agencyId).maybeSingle();
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
      res.status(200).json({ listing: data });
      return;
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) {
        res.status(400).json({ error: 'missing_id' });
        return;
      }
      const { error } = await db
        .from('listings')
        .delete()
        .eq('id', id)
        .eq('agency_id', auth.agencyId);
      if (error) throw error;
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
