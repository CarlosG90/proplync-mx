/**
 * Pexels → Proplync.mx  ·  real estate photo proxy
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * Pexels' API needs a key sent as a header. You must never put that key in
 * front-end code (anyone could read it and burn your quota). This tiny proxy
 * holds the key on the server, searches Pexels for a matching real photo per
 * property, and returns clean JSON the page can fetch().
 *
 * SET ONE ENV VAR:
 *   PEXELS_API_KEY = your key
 *   Get a free key instantly (no approval wait) at https://www.pexels.com/api/
 * -----------------------------------------------------------------------------
 */

const PEXELS_SEARCH = 'https://api.pexels.com/v1/search';

async function searchPhoto(key, query) {
  const url = `${PEXELS_SEARCH}?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`;
  const r = await fetch(url, { headers: { Authorization: key } });
  if (!r.ok) throw new Error(`Pexels responded ${r.status} for "${query}"`);
  const data = await r.json();
  const photo = data.photos && data.photos[0];
  if (!photo) return null;
  return {
    query,
    image: photo.src.large,
    photographer: photo.photographer,
    photographer_url: photo.photographer_url
  };
}

// --- Vercel / Netlify style handler ------------------------------------------
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');       // tighten to your domain in prod
  res.setHeader('Cache-Control', 's-maxage=86400');         // photos rarely change; cache 1 day

  const key = process.env.PEXELS_API_KEY;
  if (!key) {
    res.status(500).json({ error: 'missing_pexels_api_key' });
    return;
  }

  // Accept ?q=single+query or ?q=query+one,query+two,query+three (comma-separated batch)
  const raw = req.query.q;
  if (!raw) {
    res.status(400).json({ error: 'missing_query_param_q' });
    return;
  }
  const queries = String(raw).split(',').map(s => s.trim()).filter(Boolean).slice(0, 12);

  try {
    const photos = await Promise.all(queries.map(q => searchPhoto(key, q)));
    res.status(200).json({ photos });
  } catch (err) {
    res.status(502).json({ error: 'photos_unavailable', detail: String(err.message) });
  }
}
