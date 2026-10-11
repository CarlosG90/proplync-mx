/**
 * Overpass API (OpenStreetMap) → Proplync.mx · nearby amenities proxy
 * -----------------------------------------------------------------------------
 * Queries a radius around a listing's coordinates for restaurants, cafes,
 * supermarkets, pharmacies, gyms, and beaches so buyers see what's actually
 * nearby — no invented "5 min from the beach" copy.
 *
 * Free, no key required: https://wiki.openstreetmap.org/wiki/Overpass_API
 *
 * Public Overpass servers are often overloaded (504s after ~7s were turning
 * every property page's "nearby" panel into an error). So: two servers in
 * turn, each with a short timeout; answers cached for 30 days per ~100 m
 * cell, because what is around a building barely changes; and if no server
 * answers, an empty list (briefly cached) instead of a 502.
 * -----------------------------------------------------------------------------
 */

import { logDegraded, safeDetail } from './_lib/health.js';
import { redisGet, redisSet } from './_lib/redis.js';

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];
const RADIUS_M = 1200;
const TRY_MS = 6000;

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

  const cacheKey = `amenities:v2:${lat.toFixed(3)}:${lng.toFixed(3)}`;
  const cached = await redisGet(cacheKey);
  if (cached && Array.isArray(cached.places)) { res.status(200).json(cached); return; }

  // Beaches are mapped as areas, so they need ways too; `out center` gives them a point.
  const filters = Object.values(CATEGORIES)
    .map(([tag, val]) => `${val === 'beach' ? 'nwr' : 'node'}[${tag}=${val}](around:${RADIUS_M},${lat},${lng});`)
    .join('');
  const query = `[out:json][timeout:10];(${filters});out center 40;`;

  let lastErr = null;
  for (const url of OVERPASS_URLS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        // Overpass's Apache front-end 406s any request with no User-Agent
        // (content-negotiation fallback) — Node's fetch sends none by default.
        headers: { 'content-type': 'text/plain', 'user-agent': 'Proplync.mx/1.0 (hola@proplync.mx)' },
        body: query,
        signal: AbortSignal.timeout(TRY_MS)
      });
      if (!r.ok) throw new Error(`Overpass ${new URL(url).host} responded ${r.status}`);
      const data = await r.json();
      const places = (data.elements || [])
        .filter(el => el.tags && el.tags.name && (el.lat != null || el.center))
        .map(el => ({
          name: el.tags.name,
          category: categoryFor(el.tags),
          distance_m: haversineMeters(lat, lng, el.lat ?? el.center.lat, el.lon ?? el.center.lon)
        }))
        .sort((a, b) => a.distance_m - b.distance_m)
        .slice(0, 12);
      const body = { places };
      await redisSet(cacheKey, body, 30 * 86400);
      res.status(200).json(body);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  // Nothing answered. The panel shows "nothing nearby found" instead of an
  // error, and we ask again in an hour rather than hammering a busy server.
  logDegraded('amenities:overpass', safeDetail(lastErr));
  const empty = { places: [], degraded: true };
  await redisSet(cacheKey, empty, 3600);
  res.setHeader('Cache-Control', 's-maxage=600');
  res.status(200).json(empty);
}
