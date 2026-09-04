/**
 * Proplync.mx · Stock photo lookup (Pexels primary, Pixabay fallback)
 * -----------------------------------------------------------------------------
 * findStockPhoto(query) returns a real, free-to-use photo for a text query
 * (e.g. "modern condo balcony jungle"), or null if nothing is configured/found.
 *
 * Pexels is tried first (better curated architecture/interior results). If
 * Pexels has no key set, errors, or rate-limits (its free tier caps at 200
 * req/hour), we fall back to Pixabay automatically — no code branching needed
 * by callers. Results are cached in Redis for 30 days per query text, so a
 * given listing only ever costs one external call across both providers.
 *
 * SET UP TO ONE OR BOTH:
 *   PEXELS_API_KEY  — free, instant signup at https://www.pexels.com/api/
 *   PIXABAY_API_KEY — free, instant signup at https://pixabay.com/api/docs/
 * -----------------------------------------------------------------------------
 */

import { redisGet, redisSet } from './redis.js';

const PEXELS_SEARCH = 'https://api.pexels.com/v1/search';
const PIXABAY_SEARCH = 'https://pixabay.com/api/';
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days — stock photos don't change

async function searchPexels(query) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return null;
  const url = `${PEXELS_SEARCH}?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`;
  const r = await fetch(url, { headers: { Authorization: key } });
  if (!r.ok) return null; // covers 429 (rate limit) too — falls through to Pixabay
  const data = await r.json();
  const photo = data.photos && data.photos[0];
  if (!photo) return null;
  return {
    query,
    image: photo.src.large,
    photographer: photo.photographer,
    photographer_url: photo.photographer_url,
    source: 'pexels'
  };
}

async function searchPixabay(query) {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) return null;
  const url = `${PIXABAY_SEARCH}?key=${key}&q=${encodeURIComponent(query)}` +
    `&image_type=photo&orientation=horizontal&category=buildings&safesearch=true&per_page=3`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const data = await r.json();
  const hit = data.hits && data.hits[0];
  if (!hit) return null;
  return {
    query,
    image: hit.largeImageURL,
    photographer: hit.user,
    photographer_url: `https://pixabay.com/users/${hit.user}-${hit.user_id}/`,
    source: 'pixabay'
  };
}

export async function findStockPhoto(query) {
  const q = (query || '').trim();
  if (!q) return null;

  const cacheKey = `photo:${q.toLowerCase()}`;
  const cached = await redisGet(cacheKey);
  if (cached) return cached;

  let result = null;
  try { result = await searchPexels(q); } catch { result = null; }
  if (!result) {
    try { result = await searchPixabay(q); } catch { result = null; }
  }

  if (result) await redisSet(cacheKey, result, CACHE_TTL_SECONDS);
  return result;
}
