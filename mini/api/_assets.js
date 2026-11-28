/**
 * PropLync Mini · the owner's material (mini_assets, supabase/020)
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * Service businesses already have their offer as infographics and PDFs (what an
 * appraisal includes, the documents a notary needs, a price list). This keeps
 * them on the page as they are: the panel uploads the file to Storage, then
 * saves its URL here through mini/api/panel.js ?resource=assets.
 *
 * WHY THE URL MUST BE IN THE OWNER'S FOLDER
 * The page shows these to every visitor and offers them for download. Accepting
 * any https URL would let a page point visitors at a file on another site, or at
 * another agency's files. So a URL is accepted only when it is a public object of
 * the listing-photos bucket inside this agency's own folder, with an image or PDF
 * extension; the storage policy already lets a member write only there.
 * -----------------------------------------------------------------------------
 */

export const ASSET_FIELDS = 'id, url, kind, title, sort, service_id';

/** "This table doesn't exist yet" (migration 020 not applied): Postgres 42P01, or PostgREST's schema-cache miss.
 *  The page and the preview then show no material instead of failing for every visitor. */
export function missingTable(err) {
  return !!err && (err.code === '42P01' || err.code === 'PGRST205' || /mini_assets/.test(String(err.message || '')) && /does not exist|schema cache/.test(String(err.message || '')));
}
export const MAX_ASSETS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXT_KIND = { jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', pdf: 'pdf' };

/** The public URL prefix of one agency's folder. */
export function folderPrefix(supabaseUrl, agencyId) {
  return String(supabaseUrl || '').replace(/\/$/, '') + '/storage/v1/object/public/listing-photos/' + agencyId + '/';
}

/**
 * The panel's body → a clean row, or { error }. `partial` for a PUT (title, sort
 * and linked service only: the file itself never changes, the owner deletes and
 * uploads again).
 * Pure, for tests.
 */
export function cleanAsset(body, { agencyId, supabaseUrl, partial = false } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  if (!partial) {
    const url = typeof b.url === 'string' ? b.url.trim() : '';
    const prefix = folderPrefix(supabaseUrl, agencyId);
    if (!url || url.length > 1000 || !url.startsWith(prefix)) return { error: 'invalid_asset_url' };
    const name = url.slice(prefix.length);
    // One plain file name inside the folder: no sub-paths, no query, no traversal.
    const m = /^[A-Za-z0-9_-]{1,120}\.([A-Za-z0-9]{2,5})$/.exec(name);
    const kind = m && EXT_KIND[m[1].toLowerCase()];
    if (!kind) return { error: 'invalid_asset_type' };
    out.url = url;
    out.kind = kind;
  }
  if (b.title !== undefined) {
    if (b.title === null || b.title === '') out.title = null;
    else if (typeof b.title !== 'string') return { error: 'invalid_title' };
    else {
      const t = b.title.trim();
      if (t.length > 120) return { error: 'title_too_long' };
      out.title = t || null;
    }
  }
  if (b.service_id !== undefined) {
    if (b.service_id === null || b.service_id === '') out.service_id = null;
    else if (typeof b.service_id !== 'string' || !UUID.test(b.service_id)) return { error: 'invalid_service' };
    else out.service_id = b.service_id;
  }
  if (b.sort !== undefined) {
    const n = Number(b.sort);
    if (!Number.isInteger(n) || n < 0 || n > 10000) return { error: 'invalid_sort' };
    out.sort = n;
  }
  return { asset: out };
}

/** A linked service must be one of this owner's services. */
async function ownService(svc, agencyId, serviceId) {
  if (!serviceId) return true;
  const { data, error } = await svc.from('mini_services').select('id').eq('id', serviceId).eq('agency_id', agencyId).maybeSingle();
  if (error) throw error;
  return !!data;
}

/** GET / POST / PUT ?id= / DELETE ?id= on the signed-in owner's material. */
export async function handleAssets(req, res, { auth, svc, supabaseUrl = process.env.SUPABASE_URL }) {
  const id = req.query && req.query.id;
  if (id !== undefined && !UUID.test(String(id))) { res.status(400).json({ error: 'invalid_id' }); return; }
  const mine = () => svc.from('mini_assets');

  if (req.method === 'GET') {
    const { data, error } = await mine().select(ASSET_FIELDS).eq('agency_id', auth.agencyId)
      .order('sort', { ascending: true }).order('created_at', { ascending: true });
    if (error) throw error;
    res.status(200).json({ assets: data || [], limit: MAX_ASSETS });
    return;
  }

  if (req.method === 'POST') {
    const { asset, error } = cleanAsset(req.body, { agencyId: auth.agencyId, supabaseUrl });
    if (error) { res.status(400).json({ error }); return; }
    if (!(await ownService(svc, auth.agencyId, asset.service_id))) { res.status(400).json({ error: 'invalid_service' }); return; }
    const { count, error: cErr } = await mine().select('id', { count: 'exact', head: true }).eq('agency_id', auth.agencyId);
    if (cErr) throw cErr;
    if ((count || 0) >= MAX_ASSETS) { res.status(403).json({ error: 'asset_limit_reached', limit: MAX_ASSETS }); return; }
    if (asset.sort === undefined) asset.sort = (count || 0) * 10;
    const { data, error: iErr } = await mine().insert({ ...asset, agency_id: auth.agencyId }).select(ASSET_FIELDS).single();
    if (iErr) throw iErr;
    res.status(201).json({ asset: data });
    return;
  }

  if (req.method === 'PUT' || req.method === 'PATCH') {
    if (!id) { res.status(400).json({ error: 'missing_id' }); return; }
    const { asset, error } = cleanAsset(req.body, { partial: true });
    if (error) { res.status(400).json({ error }); return; }
    if (!Object.keys(asset).length) { res.status(400).json({ error: 'nothing_to_update' }); return; }
    if (!(await ownService(svc, auth.agencyId, asset.service_id))) { res.status(400).json({ error: 'invalid_service' }); return; }
    const { data, error: uErr } = await mine().update(asset).eq('id', id).eq('agency_id', auth.agencyId)
      .select(ASSET_FIELDS).maybeSingle();
    if (uErr) throw uErr;
    if (!data) { res.status(404).json({ error: 'not_found' }); return; }
    res.status(200).json({ asset: data });
    return;
  }

  if (req.method === 'DELETE') {
    if (!id) { res.status(400).json({ error: 'missing_id' }); return; }
    const { data, error } = await mine().delete().eq('id', id).eq('agency_id', auth.agencyId).select('id, url');
    if (error) throw error;
    if (!data || !data.length) { res.status(404).json({ error: 'not_found' }); return; }
    // The file itself is removed from Storage by the panel with the owner's session (storage policy
    // listing_photos_agency_delete); a leftover file is harmless, a missing row is what hides it.
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'method_not_allowed' });
}
