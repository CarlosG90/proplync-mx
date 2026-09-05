/**
 * Overpass API (OpenStreetMap) → Proplync.mx · nearby amenities proxy
 * -----------------------------------------------------------------------------
 * Queries a radius around a listing's coordinates for restaurants, cafes,
 * supermarkets, pharmacies, gyms, and beaches so buyers see what's actually
 * nearby — no invented "5 min from the beach" copy.
 *
 * Free, no key required: https://wiki.openstreetmap.org/wiki/Overpass_API
 * -----------------------------------------------------------------------------
 */


import { safeDetail } from './_lib/health.js';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const RADIUS_M = 1200;

const CATEGORIES = {
  restaurant: ['amenity', 'restaurant'],
  cafe: ['amenity', 'cafe'],
  supermarket: ['shop', 'supermarket'],
  pharmacy: ['amenity', 'pharmacy'],
  gym: ['leisure', 'fitness_centre'],
  beach: ['natural', 'beach']
};

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function categoryFor(tags) {
  for (const [key, [tag, val]] of Object.entries(CATEGORIES)) {
    if (tags[tag] === val) return key;
  }
  return 'place';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=86400');

  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    res.status(400).json({ error: 'missing_lat_lng' });
    return;
  }

  const filters = Object.values(CATEGORIES)
    .map(([tag, val]) => `node[${tag}=${val}](around:${RADIUS_M},${lat},${lng});`)
    .join('');
  const query = `[out:json][timeout:15];(${filters});out center 30;`;

  try {
    const r = await fetch(OVERPASS_URL, {
      method: 'POST',
      // Overpass's Apache front-end 406s any request with no User-Agent
      // (content-negotiation fallback) — Node's fetch sends none by default.
      headers: { 'content-type': 'text/plain', 'user-agent': 'Proplync.mx/1.0 (hola@proplync.mx)' },
      body: query
    });
    if (!r.ok) throw new Error(`Overpass responded ${r.status}`);
    const data = await r.json();
    const places = (data.elements || [])
      .filter(el => el.tags && el.tags.name)
      .map(el => ({
        name: el.tags.name,
        category: categoryFor(el.tags),
        distance_m: haversineMeters(lat, lng, el.lat, el.lon)
      }))
      .sort((a, b) => a.distance_m - b.distance_m)
      .slice(0, 12);
    res.status(200).json({ places });
  } catch (err) {
    res.status(502).json({ error: 'amenities_unavailable', detail: safeDetail(err) });
  }
}
