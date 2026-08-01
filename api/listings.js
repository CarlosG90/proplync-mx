/**
 * MercadoLibre → Proplync.mx  ·  listings proxy
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * MercadoLibre's real-estate search (site MLM, category "Inmuebles") is free
 * but requires an OAuth access_token — anonymous requests to
 * /sites/MLM/search now get a 403. Access tokens expire every 6 hours and the
 * refresh_token that renews them is single-use (MercadoLibre issues a new one
 * on every refresh), so it can't live in a plain env var. This proxy keeps the
 * current access_token and refresh_token in Upstash Redis (see api/ml-callback.js
 * for the one-time setup that seeds the first pair) and refreshes them itself
 * whenever the cached access_token has expired.
 *
 * SET THESE ENV VARS:
 *   ML_CLIENT_ID, ML_CLIENT_SECRET   — from developers.mercadolibre.com.mx
 *   KV_REST_API_URL, KV_REST_API_TOKEN — from the Upstash Marketplace integration
 * Then do the one-time browser authorization described in api/ml-callback.js
 * before this endpoint has anything to refresh.
 * -----------------------------------------------------------------------------
 */

const ML_SITE = 'MLM';                 // Mexico
const CATEGORY = 'MLM1459';             // Inmuebles (real estate)
const TOWNS = ['Tulum', 'Playa del Carmen', 'Puerto Morelos', 'Cancún'];
const PER_TOWN = 8;

async function kvGet(key) {
  const r = await fetch(`${process.env.KV_REST_API_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
  });
  if (!r.ok) throw new Error(`KV get failed for ${key}: HTTP ${r.status}`);
  const { result } = await r.json();
  return result;
}

async function kvSet(key, value) {
  const url = `${process.env.KV_REST_API_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` } });
  if (!r.ok) throw new Error(`KV set failed for ${key}: HTTP ${r.status}`);
}

async function refreshAccessToken() {
  const refreshToken = await kvGet('ml:refresh_token');
  if (!refreshToken) throw new Error('No refresh_token in Redis — complete the one-time setup in api/ml-callback.js first');

  const r = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'accept': 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.ML_CLIENT_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
      refresh_token: refreshToken
    })
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) throw new Error(`MercadoLibre token refresh failed: ${JSON.stringify(data)}`);

  await kvSet('ml:access_token', data.access_token);
  await kvSet('ml:access_token_expires_at', String(Date.now() + (data.expires_in - 300) * 1000));
  if (data.refresh_token) await kvSet('ml:refresh_token', data.refresh_token); // single-use, always rotates

  return data.access_token;
}

async function getAccessToken() {
  const [token, expiresAt] = await Promise.all([kvGet('ml:access_token'), kvGet('ml:access_token_expires_at')]);
  if (token && expiresAt && Date.now() < Number(expiresAt)) return token;
  return refreshAccessToken();
}

// Pull the attribute value_name for a given attribute id, if MercadoLibre included it in search results.
function attr(item, id) {
  const found = (item.attributes || []).find(a => a.id === id);
  return found ? found.value_name : null;
}

function mapItem(item, town) {
  const bedrooms = Number(attr(item, 'BEDROOMS')) || 0;
  const bathrooms = Number(attr(item, 'FULL_BATHROOMS') || attr(item, 'BATHROOMS')) || 0;
  const size = Number(attr(item, 'COVERED_AREA') || attr(item, 'TOTAL_AREA')) || 0;
  const opRaw = (attr(item, 'OPERATION') || '').toLowerCase();
  const operation = opRaw.includes('renta') || opRaw.includes('arriendo') || opRaw.includes('alquiler') ? 'rental' : 'sale';

  return {
    public_id: item.id,
    title_es: item.title,
    title_en: item.title,
    neighborhood: (item.address && item.address.city_name) || '',
    town,
    bedrooms,
    bathrooms,
    parking: Number(attr(item, 'PARKING_LOTS')) || 0,
    size,
    operation,
    currency: item.currency_id || 'MXN',
    amount: item.price || 0,
    formatted: item.price ? item.price.toLocaleString('en-US') : '',
    image: item.thumbnail ? item.thumbnail.replace(/^http:/, 'https:') : ''
  };
}

async function fetchTown(token, town) {
  const url = `https://api.mercadolibre.com/sites/${ML_SITE}/search?category=${CATEGORY}&q=${encodeURIComponent(town)}&limit=${PER_TOWN}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, accept: 'application/json' } });
  if (!r.ok) throw new Error(`MercadoLibre search responded ${r.status} for "${town}"`);
  const data = await r.json();
  return (data.results || []).map(item => mapItem(item, town));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300');
  try {
    const token = await getAccessToken();
    const perTown = await Promise.all(TOWNS.map(town => fetchTown(token, town)));
    res.status(200).json({ listings: perTown.flat() });
  } catch (err) {
    res.status(502).json({ error: 'listings_unavailable', detail: String(err.message) });
  }
}
