/**
 * Proplync.mx · The search endpoint behind /search (api/search.js?action=query)
 * -----------------------------------------------------------------------------
 * One request does the whole loop: understand the words (query.js), turn them
 * into a vector (the `embed` edge function), rank (search_properties_v1), and
 * shape each card for the buyer. Lives in _lib and is dispatched from
 * api/search.js because the project is at Vercel Hobby's 12-function cap.
 *
 * WHAT A CARD MAY SHOW
 * Each source has a display mode (search_sources). The most permissive mode
 * among a property's offers decides what its card carries: the full card,
 * facts with one photo and a link, or facts only. The listing agent's
 * contact never leaves the database.
 *
 * WHEN RESULTS ARE THIN
 * Fewer than three results and the response says which single change would
 * help, with counts ("12 if you include Playa del Carmen"), and offers Scout,
 * which turns the search into a Finder brief. A search never ends at an empty
 * page with nothing to do.
 * -----------------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { getServiceClient } from '../supabase.js';
import { redisGet, redisSet } from '../redis.js';
import { logDegraded } from '../health.js';
import { parseQuery, toRankParams } from './query.js';
import { embedTexts, fxRate } from './index-writer.js';
import { AMENITY_LABELS } from './amenities.js';

const TOWNS_KEY = 'search:towns:v2';

/** Every town and neighborhood a query can name: markets plus what the index holds. */
export async function searchableTowns(svc) {
  const cached = await redisGet(TOWNS_KEY);
  if (Array.isArray(cached) && cached.length) return cached;
  const names = new Set();
  const { data: markets } = await svc.from('search_markets').select('towns');
  for (const m of markets || []) for (const t of m.towns || []) names.add(t);
  const { data: rows } = await svc.from('search_properties').select('town, neighborhood').eq('status', 'active').limit(5000);
  for (const r of rows || []) {
    for (const v of [r.town, r.neighborhood]) {
      // "Merida, Yucatan" is a town and a state; offer both halves
      for (const part of String(v || '').split(',')) if (part.trim().length >= 3) names.add(part.trim());
    }
  }
  const list = [...names];
  await redisSet(TOWNS_KEY, list, 600);
  return list;
}

async function queryEmbedding(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const key = 'qe:v1:' + createHash('sha1').update(t.toLowerCase()).digest('hex');
  const cached = await redisGet(key);
  if (Array.isArray(cached) && cached.length === 384) return cached;
  try {
    const out = await embedTexts([t]);
    const v = out && out[0];
    if (Array.isArray(v) && v.length === 384) {
      // rounded: a quarter of the cache size, no measurable ranking change
      const compact = v.map((x) => Math.round(x * 1e5) / 1e5);
      await redisSet(key, compact, 86400);
      return compact;
    }
  } catch (err) {
    // Without a vector, ranking falls back to words and filters.
    logDegraded('search:query-embedding', err);
  }
  return null;
}

/* The card a buyer sees, cut down to what the most permissive source allows. */
export function shapeCard(r, lang) {
  const mode = r.origin === 'proplync' ? 'full' : ({ 1: 'full', 2: 'facts_link', 3: 'facts_only' }[r.best_mode] || 'facts_only');
  const card = {
    id: r.id,
    origin: r.origin,
    verified: !!r.verified,
    listing_public_id: r.listing_public_id,
    display_mode: mode,
    title: r.title,
    operation: r.operation,
    property_type: r.property_type,
    town: r.town,
    neighborhood: r.neighborhood,
    bedrooms: r.bedrooms,
    bathrooms: r.bathrooms,
    parking: r.parking,
    built_m2: r.built_m2,
    land_m2: r.land_m2,
    price_mxn_min: r.price_mxn_min,
    price_mxn_max: r.price_mxn_max,
    lat: r.lat,
    lng: r.lng,
    amenities: (r.amenities || []).map((a) => ({ tag: a, label: (AMENITY_LABELS[a] || [a, a])[lang === 'en' ? 1 : 0] })),
    offers: (r.offers || []).map((o) => ({
      source: o.source, source_name: o.source_name, price: o.price, currency: o.currency,
      url: mode === 'facts_only' && r.origin !== 'proplync' ? null : o.url,
      listed_by: o.listed_by, last_seen_at: o.last_seen_at
    })),
    reasons: {
      ...(r.reasons || {}),
      amenities_met: ((r.reasons && r.reasons.amenities_met) || []).map((a) => ({ tag: a, label: (AMENITY_LABELS[a] || [a, a])[lang === 'en' ? 1 : 0] })),
      amenities_missing: ((r.reasons && r.reasons.amenities_missing) || []).map((a) => ({ tag: a, label: (AMENITY_LABELS[a] || [a, a])[lang === 'en' ? 1 : 0] }))
    },
    score: r.score
  };
  if (mode === 'full') {
    card.description = r.description;
    card.photos = r.photos || [];
  } else if (mode === 'facts_link') {
    card.photos = (r.photos || []).slice(0, 1);
  } else {
    card.photos = [];
  }
  return card;
}

async function rank(svc, params) {
  const { data, error } = await svc.rpc('search_properties_v1', { p: params });
  if (error) throw error;
  return data || { total: 0, results: [] };
}

/* Which one change would turn a thin page into a useful one, with counts. */
async function relaxations(svc, params, total) {
  const base = { ...params, limit: 1, offset: 0 };
  delete base.embedding;
  const tries = [];
  if (base.towns) tries.push({ drop: 'towns', label: { es: 'Incluir otras zonas', en: 'Include other areas' }, p: { ...base, towns: undefined } });
  if (base.price_max_mxn) tries.push({ drop: 'price_max', label: { es: 'Subir el presupuesto 25%', en: 'Raise the budget 25%' }, p: { ...base, price_max_mxn: base.price_max_mxn * 1.25 } });
  if (base.beds_min) tries.push({ drop: 'beds_min', label: { es: 'Una recámara menos', en: 'One bedroom fewer' }, p: { ...base, beds_min: Math.max(0, base.beds_min - 1) || undefined } });
  if (base.operation) tries.push({ drop: 'operation', label: { es: 'Venta y renta', en: 'Sale and rent' }, p: { ...base, operation: undefined } });
  if (base.amenities_required) tries.push({ drop: 'amenities_required', label: { es: 'Amenidades como preferencia', en: 'Amenities as a preference' }, p: { ...base, amenities_required: undefined } });
  const out = [];
  for (const t of tries) {
    const p = Object.fromEntries(Object.entries(t.p).filter(([, v]) => v !== undefined));
    try {
      const r = await rank(svc, p);
      if (r.total > total) out.push({ drop: t.drop, label: t.label, total: r.total });
    } catch (err) { logDegraded('search:relax', err); }
  }
  return out.sort((a, b) => b.total - a.total).slice(0, 3);
}

/**
 * POST { q?, overrides?: {hard, prefs, q}, sort?, offset?, limit?, bbox?, lang?, via? }
 */
export async function handleSearchQuery(req, res) {
  const body = req.body || {};
  const lang = body.lang === 'en' ? 'en' : 'es';
  const q = typeof body.q === 'string' ? body.q.trim().slice(0, 300) : '';
  const overrides = body.overrides && typeof body.overrides === 'object' ? body.overrides : {};
  const svc = getServiceClient();

  const towns = await searchableTowns(svc);
  const parsed = q ? await parseQuery(q, { towns }) : { hard: {}, prefs: { amenities: [] }, semantic_text: '', via: 'none' };
  const semantic = [overrides.q, parsed.semantic_text, (overrides.hard && overrides.hard.property_type) || parsed.hard.property_type]
    .filter(Boolean).join(' ') || (q || '');
  const embedding = await queryEmbedding(semantic);

  const params = toRankParams(parsed, {
    fx: fxRate(), overrides,
    sort: body.sort, limit: Math.min(Number(body.limit) || 24, 60), offset: Math.max(Number(body.offset) || 0, 0),
    bbox: body.bbox, embedding
  });

  const data = await rank(svc, params);
  const results = (data.results || []).map((r) => shapeCard(r, lang));
  const thin = data.total < 3 && !params.offset;
  const suggestions = thin ? await relaxations(svc, params, data.total) : [];

  // What buyers look for, for agencies' demand insights. Filters only:
  // no IP, no free text, nothing that points to a person.
  const { embedding: _e, q: _q, limit: _l, offset: _o, ...filters } = params;
  waitUntil(svc.from('search_queries').insert({
    market_id: params.market || null,
    filters, prefs: parsed.prefs || {},
    result_count: data.total || 0, sort: params.sort,
    via: ['nl', 'filters', 'map', 'facet'].includes(body.via) ? body.via : (q ? 'nl' : 'filters')
  }).then(({ error }) => { if (error) logDegraded('search:log', error); }));

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    parsed: { hard: { ...parsed.hard, ...(overrides.hard || {}) }, prefs: parsed.prefs, semantic_text: parsed.semantic_text, via: parsed.via, semantic: !!embedding },
    total: data.total || 0,
    offset: params.offset || 0,
    results,
    suggestions,
    // Few or no matches: Scout can search the whole market as a Finder brief.
    scout: (data.total || 0) < 5
  });
}
