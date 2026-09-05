/**
 * Proplync.mx  ·  real estate photo proxy
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * Stock-photo providers need a key sent server-side. You must never put that
 * key in front-end code (anyone could read it and burn your quota). This tiny
 * proxy holds the keys, searches for a matching real photo per property via
 * api/_lib/photos.js (Pexels primary, Pixabay fallback, Redis-cached), and
 * returns clean JSON the page can fetch().
 *
 * SET UP TO ONE OR BOTH (works with just one configured):
 *   PEXELS_API_KEY  — free, instant signup at https://www.pexels.com/api/
 *   PIXABAY_API_KEY — free, instant signup at https://pixabay.com/api/docs/
 * -----------------------------------------------------------------------------
 */

import { findStockPhoto } from './_lib/photos.js';
import { safeDetail } from './_lib/health.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');       // tighten to your domain in prod
  res.setHeader('Cache-Control', 's-maxage=86400');         // photos rarely change; cache 1 day

  // Accept ?q=single+query or ?q=query+one,query+two,query+three (comma-separated batch)
  const raw = req.query.q;
  if (!raw) {
    res.status(400).json({ error: 'missing_query_param_q' });
    return;
  }
  const queries = String(raw).split(',').map(s => s.trim()).filter(Boolean).slice(0, 12);

  try {
    const photos = await Promise.all(queries.map(q => findStockPhoto(q)));
    res.status(200).json({ photos });
  } catch (err) {
    res.status(502).json({ error: 'photos_unavailable', detail: safeDetail(err) });
  }
}
