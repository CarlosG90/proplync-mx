/**
 * Nominatim (OpenStreetMap) → Proplync.mx · free geocoding proxy
 * -----------------------------------------------------------------------------
 * Nominatim's usage policy requires a descriptive User-Agent and caps clients
 * at ~1 request/sec — browsers can't set a custom User-Agent, so this proxy
 * holds that header server-side and caches results (coordinates for a given
 * neighborhood don't change).
 *
 * Free, no key required: https://nominatim.org/release-docs/latest/api/Search/
 * -----------------------------------------------------------------------------
 */


import { safeDetail } from './_lib/health.js';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=2592000'); // 30 days

  const q = req.query.q;
  if (!q) {
    res.status(400).json({ error: 'missing_query_param_q' });
    return;
  }

  try {
    const url = `${NOMINATIM_URL}?q=${encodeURIComponent(q)}&format=json&limit=1`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Proplync.mx/1.0 (hola@proplync.mx)' }
    });
    if (!r.ok) throw new Error(`Nominatim responded ${r.status}`);
    const data = await r.json();
    const hit = data[0];
    if (!hit) {
      res.status(200).json({ lat: null, lng: null });
      return;
    }
    res.status(200).json({ lat: parseFloat(hit.lat), lng: parseFloat(hit.lon) });
  } catch (err) {
    res.status(502).json({ error: 'geocode_unavailable', detail: safeDetail(err) });
  }
}
