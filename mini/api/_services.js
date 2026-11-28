/**
 * PropLync Mini · the services catalog (mini_services, supabase/019)
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * A Mini page now serves any business that sells services, not only properties.
 * This is the validation and the CRUD for the customer's services, called from
 * mini/api/panel.js ?resource=services (no new function: the panel already has
 * the session, the rate limit and the error style).
 *
 * WHY status IS ONLY "SHOW / HIDE"
 * Listings start as drafts because they also reach PropLync search and the
 * agency page. Services appear only on the Mini page, which plans.js pageActive
 * already hides until it is paid, so activation never has to publish them. A
 * draft service is one the customer chose to hide.
 *
 * WHY THE SERVICE CLIENT AND agency_id FROM THE TOKEN
 * Same model as api/my-listings.js: the agency comes from the verified session,
 * never from the body, and every query filters on it. RLS on mini_services (019)
 * is the second lock.
 * -----------------------------------------------------------------------------
 */

export const SERVICE_FIELDS = 'id, title_es, title_en, description_es, description_en, price, price_kind, currency, ' +
  'duration_min, image, images, sort, status';
export const PUBLIC_SERVICE_FIELDS = 'id, title_es, title_en, description_es, description_en, price, price_kind, currency, duration_min, image, images, sort';
// Several photos per service (supabase/022 mini_services.images); `image` mirrors the first, the cover.
export const MAX_SERVICE_PHOTOS = 8;
export const MAX_SERVICES = 20;
export const PRICE_KINDS = ['fixed', 'from', 'per_m2', 'quote'];
const IMAGE_URL = /^https:\/\/\S+$/i;

const text = (v, max, code) => {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string') throw new Error('invalid_' + code);
  const s = v.trim();
  if (s.length > max) throw new Error(code + '_too_long');
  return s || null;
};

/**
 * The customer's form → a clean row, or { error }. `partial` for a PUT: only the
 * fields sent are checked and returned. Pure, for tests.
 */
export function cleanService(body, { partial = false } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  try {
    const title = text(b.title_es, 120, 'title');
    if (title !== undefined) out.title_es = title;
    if (!partial || 'title_es' in b) { if (!out.title_es) return { error: 'missing_title' }; }
    for (const [k, max] of [['title_en', 120], ['description_es', 1200], ['description_en', 1200]]) {
      const v = text(b[k], max, k.startsWith('title') ? 'title' : 'description');
      if (v !== undefined) out[k] = v;
    }
    if (b.price_kind !== undefined) {
      if (!PRICE_KINDS.includes(b.price_kind)) return { error: 'invalid_price_kind' };
      out.price_kind = b.price_kind;
    }
    if (b.price !== undefined) {
      if (b.price === null || b.price === '') out.price = null;
      else {
        const n = Number(b.price);
        if (!Number.isFinite(n) || n < 0 || n > 1e10) return { error: 'invalid_price' };
        out.price = Math.round(n * 100) / 100;
      }
    }
    // "A cotizar" carries no number, and a number with no kind is a fixed price.
    if (out.price_kind === 'quote') out.price = null;
    else if (out.price != null && !out.price_kind && !partial) out.price_kind = 'fixed';
    if (!partial && out.price_kind === undefined) out.price_kind = 'quote';
    if (b.currency !== undefined) {
      if (!['MXN', 'USD'].includes(b.currency)) return { error: 'invalid_currency' };
      out.currency = b.currency;
    }
    if (b.duration_min !== undefined) {
      if (b.duration_min === null || b.duration_min === '') out.duration_min = null;
      else {
        const d = Number(b.duration_min);
        if (!Number.isInteger(d) || d < 5 || d > 1440) return { error: 'invalid_duration' };
        out.duration_min = d;
      }
    }
    if (b.image !== undefined) {
      if (b.image === null || b.image === '') out.image = null;
      else if (typeof b.image !== 'string' || b.image.length > 1000 || !IMAGE_URL.test(b.image.trim())) return { error: 'invalid_image' };
      else out.image = b.image.trim();
    }
    if (b.images !== undefined) {
      if (b.images === null) out.images = [];
      else if (!Array.isArray(b.images) || b.images.length > MAX_SERVICE_PHOTOS) return { error: 'invalid_images' };
      else {
        out.images = [];
        for (const u of b.images) {
          if (typeof u !== 'string' || u.length > 1000 || !IMAGE_URL.test(u.trim())) return { error: 'invalid_image' };
          if (!out.images.includes(u.trim())) out.images.push(u.trim());
        }
      }
      // The cover is always the first photo, so pages that read only `image` stay right.
      out.image = out.images[0] || null;
    }
    if (b.sort !== undefined) {
      const n = Number(b.sort);
      if (!Number.isInteger(n) || n < 0 || n > 10000) return { error: 'invalid_sort' };
      out.sort = n;
    }
    if (b.status !== undefined) {
      if (!['published', 'draft'].includes(b.status)) return { error: 'invalid_status' };
      out.status = b.status;
    }
  } catch (err) {
    return { error: err.message };
  }
  return { service: out };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET / POST / PUT ?id= / DELETE ?id= on the signed-in customer's own services. */
export async function handleServices(req, res, { auth, svc }) {
  const id = req.query && req.query.id;
  if (id !== undefined && !UUID.test(String(id))) { res.status(400).json({ error: 'invalid_id' }); return; }
  const mine = () => svc.from('mini_services');

  if (req.method === 'GET') {
    const { data, error } = await mine().select(SERVICE_FIELDS).eq('agency_id', auth.agencyId)
      .order('sort', { ascending: true }).order('created_at', { ascending: true });
    if (error) throw error;
    res.status(200).json({ services: data || [], limit: MAX_SERVICES });
    return;
  }

  if (req.method === 'POST') {
    const { service, error } = cleanService(req.body);
    if (error) { res.status(400).json({ error }); return; }
    const { count, error: cErr } = await mine().select('id', { count: 'exact', head: true }).eq('agency_id', auth.agencyId);
    if (cErr) throw cErr;
    if ((count || 0) >= MAX_SERVICES) { res.status(403).json({ error: 'service_limit_reached', limit: MAX_SERVICES }); return; }
    if (service.sort === undefined) service.sort = (count || 0) * 10;
    const { data, error: iErr } = await mine().insert({ ...service, agency_id: auth.agencyId }).select(SERVICE_FIELDS).single();
    if (iErr) throw iErr;
    res.status(201).json({ service: data });
    return;
  }

  if (req.method === 'PUT' || req.method === 'PATCH') {
    if (!id) { res.status(400).json({ error: 'missing_id' }); return; }
    const { service, error } = cleanService(req.body, { partial: true });
    if (error) { res.status(400).json({ error }); return; }
    if (!Object.keys(service).length) { res.status(400).json({ error: 'nothing_to_update' }); return; }
    const { data, error: uErr } = await mine().update(service).eq('id', id).eq('agency_id', auth.agencyId)
      .select(SERVICE_FIELDS).maybeSingle();
    if (uErr) throw uErr;
    if (!data) { res.status(404).json({ error: 'not_found' }); return; }
    res.status(200).json({ service: data });
    return;
  }

  if (req.method === 'DELETE') {
    if (!id) { res.status(400).json({ error: 'missing_id' }); return; }
    const { data, error } = await mine().delete().eq('id', id).eq('agency_id', auth.agencyId).select('id');
    if (error) throw error;
    if (!data || !data.length) { res.status(404).json({ error: 'not_found' }); return; }
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'method_not_allowed' });
}
