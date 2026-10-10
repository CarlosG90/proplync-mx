/**
 * Proplync.mx · Writes listings into the search index
 * -----------------------------------------------------------------------------
 * Every source ends up here: the crawler (ingest/run.mjs) with portal ads, and
 * our own agencies' listings (syncProplync, also called by api/my-listings.js
 * after an agency saves). One path means one dedupe rule: an ad joins an
 * existing property when it is the same URL, or when scout-merge's
 * sameProperty() says the facts describe the same unit. That is how a portal
 * copy of a PropLync listing lands on the PropLync card instead of becoming a
 * second, unverified one.
 *
 * What it never does: overwrite a fact a better source already gave (facts
 * only fill blanks), or copy photos (they stay links to the source).
 * -----------------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import { normalizeUrl, sameProperty, toMxn } from '../scout-merge.js';
import { amenitiesFrom } from './amenities.js';
import { resolveMarket } from './normalize.js';
import { logDegraded } from '../health.js';

const PAGE = 1000;
const MAX_PHOTOS = 8;
const INDEX_COLUMNS = 'id, origin, market_id, town, neighborhood, operation, bedrooms, built_m2, price_mxn_min, title, description, photos, amenities, lat, lng, bathrooms, parking, land_m2, property_type';

export function fxRate() {
  const n = Number(process.env.SCOUT_FX_USD_MXN);
  return Number.isFinite(n) && n > 0 ? n : 18;
}

export async function loadMarkets(svc, { enabledOnly = true } = {}) {
  let q = svc.from('search_markets').select('*');
  if (enabledOnly) q = q.eq('enabled', true);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

/* What dedupe needs to know about every active property in the markets a run
   touches. A few MB even at tens of thousands of rows, loaded once per run. */
async function loadIndex(svc, marketIds) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await svc.from('search_properties')
      .select(INDEX_COLUMNS)
      .in('market_id', marketIds).eq('status', 'active')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

function asCard(p, priceMxn) {
  return {
    town: p.town, neighborhood: p.neighborhood, operation: p.operation,
    bedrooms: p.bedrooms, built_m2: p.built_m2,
    sources: [{ price: priceMxn, currency: 'MXN' }]
  };
}

/* Facts only fill blanks: the first source to state a fact keeps it, so a
   crawled ad never overwrites what one of our agencies entered. */
export function mergeFacts(existing, listing) {
  const patch = {};
  for (const k of ['title', 'operation', 'property_type', 'town', 'neighborhood', 'bedrooms', 'bathrooms',
                   'parking', 'built_m2', 'land_m2', 'lat', 'lng']) {
    if ((existing[k] === null || existing[k] === undefined || existing[k] === '') && listing[k] !== null && listing[k] !== undefined) {
      patch[k] = listing[k];
    }
  }
  if (!existing.description && listing.description) patch.description = listing.description;
  const photos = [...new Set([...(existing.photos || []), ...(listing.photos || [])])].slice(0, MAX_PHOTOS);
  if (photos.length !== (existing.photos || []).length) patch.photos = photos;
  const amenities = [...new Set([...(existing.amenities || []), ...(listing.amenities || [])])].sort();
  if (amenities.length !== (existing.amenities || []).length) patch.amenities = amenities;
  if (patch.description || patch.amenities || patch.title) {
    // the text changed, so the vector describes the old property
    patch.embedding = null;
    patch.embedding_hash = null;
  }
  return patch;
}

/**
 * Upsert normalized listings (from normalize.js) for one source.
 * @returns {Promise<{offers_updated:number, offers_added:number, properties_created:number, merged_into_existing:number, touched:string[]}>}
 */
export async function indexListings(svc, listings, { origin = 'web', verified = false } = {}) {
  const stats = { offers_updated: 0, offers_added: 0, properties_created: 0, merged_into_existing: 0, touched: [] };
  if (!listings.length) return stats;
  const now = new Date().toISOString();
  const marketIds = [...new Set(listings.map((l) => l.market_id))];
  const index = await loadIndex(svc, marketIds);
  const byId = new Map(index.map((p) => [p.id, p]));
  const touched = new Set();

  // Existing offers for these URLs, in batches the query string can carry.
  const existing = new Map();
  const keys = [...new Set(listings.map((l) => l.url_key))];
  for (let i = 0; i < keys.length; i += 150) {
    const { data, error } = await svc.from('search_offers')
      .select('id, property_id, url_key, price, currency, price_history')
      .in('url_key', keys.slice(i, i + 150));
    if (error) throw error;
    for (const o of data) existing.set(o.url_key, o);
  }

  for (const l of listings) {
    const offerFields = {
      source_id: l.source_id, url: l.url, external_id: l.external_id, raw_title: l.title,
      price: l.price, currency: l.currency, price_mxn: l.price_mxn,
      listed_by: l.listed_by, contact: l.contact, status: 'active', last_seen_at: now
    };
    const prev = existing.get(l.url_key);
    let propertyId;

    if (prev) {
      // Seen before: refresh it, and remember a price change.
      const history = Array.isArray(prev.price_history) ? prev.price_history : [];
      if (prev.price !== null && l.price !== null && (Number(prev.price) !== l.price || prev.currency !== l.currency)) {
        history.push({ price: Number(prev.price), currency: prev.currency, at: now });
      }
      const { error } = await svc.from('search_offers')
        .update({ ...offerFields, price_history: history.slice(-20) }).eq('id', prev.id);
      if (error) throw error;
      propertyId = prev.property_id;
      stats.offers_updated++;
    } else {
      // Join the first property this ad describes (our own listings included,
      // so a portal copy lands on the PropLync card), or start a new one.
      const match = index.find((p) => p.market_id === l.market_id &&
        sameProperty(asCard(p, p.price_mxn_min), asCard(l, l.price_mxn), 1));
      if (match) {
        propertyId = match.id;
        stats.merged_into_existing++;
      } else {
        const { data: created, error } = await svc.from('search_properties').insert({
          origin, verified, market_id: l.market_id,
          title: l.title, operation: l.operation, property_type: l.property_type,
          town: l.town, neighborhood: l.neighborhood,
          bedrooms: l.bedrooms, bathrooms: l.bathrooms, parking: l.parking,
          built_m2: l.built_m2, land_m2: l.land_m2,
          price_mxn_min: l.price_mxn, price_mxn_max: l.price_mxn,
          description: l.description, amenities: l.amenities, photos: l.photos,
          lat: l.lat, lng: l.lng
        }).select(INDEX_COLUMNS).single();
        if (error) throw error;
        index.push(created);
        byId.set(created.id, created);
        propertyId = created.id;
        stats.properties_created++;
      }
      const { error } = await svc.from('search_offers').insert({ ...offerFields, property_id: propertyId, url_key: l.url_key, first_seen_at: now });
      if (error) throw error;
      stats.offers_added++;
    }

    const prop = byId.get(propertyId);
    const patch = prop ? mergeFacts(prop, l) : {};
    const { error: upErr } = await svc.from('search_properties')
      .update({ ...patch, status: 'active', last_seen_at: now, updated_at: now }).eq('id', propertyId);
    if (upErr) throw upErr;
    if (prop) Object.assign(prop, patch);
    touched.add(propertyId);
  }

  const ids = [...touched];
  for (let i = 0; i < ids.length; i += 500) {
    const { error } = await svc.rpc('search_refresh_prices', { p_ids: ids.slice(i, i + 500) });
    if (error) logDegraded('search:refresh-prices', error);
  }
  stats.touched = ids;
  return stats;
}

/** Offers a source stopped showing go inactive; see 011_search_maintenance.sql. */
export async function markStale(svc, sourceId, cutoffIso) {
  const { data, error } = await svc.rpc('search_mark_stale', { p_source: sourceId, p_cutoff: cutoffIso });
  if (error) throw error;
  return data;
}

/**
 * Mirror our agencies' published listings into the index. With publicIds,
 * only those (after an agency saves); without, all of them (daily, from the
 * crawler run), which also retires listings no longer published.
 */
export async function syncProplync(svc, { publicIds = null, siteOrigin = process.env.PUBLIC_SITE_URL || 'https://proplync-mx.vercel.app' } = {}) {
  const fx = fxRate();
  const markets = await loadMarkets(svc, { enabledOnly: false });
  let q = svc.from('listings')
    .select('public_id, title_es, title_en, town, neighborhood, bedrooms, bathrooms, parking, size, operation, property_type, currency, amount, image, images, features, description_es, description_en, lat, lng, status, agencies(name)');
  if (publicIds) q = q.in('public_id', publicIds);
  const { data: rows, error } = await q;
  if (error) throw error;

  const listings = [];
  for (const r of (rows || []).filter((x) => x.status === 'published')) {
    // Markets limit what we crawl, never what our own agencies can list: a
    // listing in a town no market covers yet (Puebla, today) is indexed with
    // no market and still found by town, text and filters.
    const marketId = resolveMarket(markets, { town: r.town, neighborhood: r.neighborhood, lat: r.lat, lng: r.lng });
    const url = siteOrigin.replace(/\/+$/, '') + '/propiedad/' + r.public_id;
    const description = String(r.description_es || r.description_en || '').slice(0, 1000) || null;
    const price = Number(r.amount) || null;
    listings.push({
      source_id: 'proplync', listing_public_id: r.public_id,
      url, url_key: normalizeUrl(url), external_id: r.public_id,
      title: r.title_es || r.title_en || null, description,
      operation: r.operation, property_type: r.property_type || null,
      price, currency: r.currency || 'MXN', price_mxn: toMxn(price, r.currency || 'MXN', fx),
      // 0 in our table means "not filled in"
      bedrooms: Number(r.bedrooms) || null, bathrooms: Number(r.bathrooms) || null,
      parking: Number(r.parking) || null, built_m2: Number(r.size) || null, land_m2: null,
      town: r.town, neighborhood: r.neighborhood || null, market_id: marketId,
      lat: r.lat ?? null, lng: r.lng ?? null,
      photos: [r.image].concat(Array.isArray(r.images) ? r.images : []).filter((p) => /^https?:\/\//i.test(String(p || ''))).slice(0, MAX_PHOTOS),
      amenities: amenitiesFrom(r.title_es, r.title_en, description, r.features),
      listed_by: (r.agencies && r.agencies.name) || null, contact: null
    });
  }

  // Our listing is the source of truth for its own row: refresh every fact,
  // then let indexListings attach (or refresh) its offer.
  for (const l of listings) {
    const fields = {
      origin: 'proplync', verified: true, market_id: l.market_id, status: 'active',
      title: l.title, operation: l.operation, property_type: l.property_type, town: l.town, neighborhood: l.neighborhood,
      bedrooms: l.bedrooms, bathrooms: l.bathrooms, parking: l.parking, built_m2: l.built_m2,
      description: l.description, amenities: l.amenities, photos: l.photos, lat: l.lat, lng: l.lng,
      updated_at: new Date().toISOString()
    };
    const { data: row, error: findErr } = await svc.from('search_properties').select('id, embedding_hash').eq('listing_public_id', l.listing_public_id).maybeSingle();
    if (findErr) throw findErr;
    // Re-embed only when the text a vector is made from actually changed:
    // the daily sync touches every listing, and most never change.
    const hash = createHash('sha1').update(embedText(l)).digest('hex');
    if (!row || row.embedding_hash !== hash) { fields.embedding = null; fields.embedding_hash = null; }
    const { error: e } = row
      ? await svc.from('search_properties').update(fields).eq('id', row.id)
      : await svc.from('search_properties').insert({ ...fields, listing_public_id: l.listing_public_id, price_mxn_min: l.price_mxn, price_mxn_max: l.price_mxn });
    if (e) throw e;
  }
  const stats = await indexListingsForProplync(svc, listings);

  // Retire what is no longer published (within the scope of this sync).
  const live = new Set(listings.map((l) => l.listing_public_id));
  const { data: mirrored, error: mErr } = await svc.from('search_properties')
    .select('id, listing_public_id').eq('origin', 'proplync').eq('status', 'active');
  if (mErr) throw mErr;
  const retire = (mirrored || [])
    .filter((m) => !live.has(m.listing_public_id) && (!publicIds || publicIds.includes(m.listing_public_id)))
    .map((m) => m.id);
  if (retire.length) {
    await svc.from('search_properties').update({ status: 'inactive', updated_at: new Date().toISOString() }).in('id', retire);
    await svc.from('search_offers').update({ status: 'inactive' }).in('property_id', retire).eq('source_id', 'proplync');
  }
  return { ...stats, synced: listings.length, retired: retire.length };
}

/* indexListings, with each PropLync listing pinned to its own row. */
async function indexListingsForProplync(svc, listings) {
  if (!listings.length) return { offers_updated: 0, offers_added: 0, properties_created: 0, merged_into_existing: 0, touched: [] };
  const { data: own, error } = await svc.from('search_properties')
    .select('id, listing_public_id').in('listing_public_id', listings.map((l) => l.listing_public_id));
  if (error) throw error;
  const idByPublic = new Map((own || []).map((r) => [r.listing_public_id, r.id]));
  const now = new Date().toISOString();
  let added = 0, updated = 0;
  for (const l of listings) {
    const propertyId = idByPublic.get(l.listing_public_id);
    if (!propertyId) continue;
    const fields = {
      property_id: propertyId, source_id: 'proplync', url: l.url, external_id: l.external_id, raw_title: l.title,
      price: l.price, currency: l.currency, price_mxn: l.price_mxn, listed_by: l.listed_by,
      status: 'active', last_seen_at: now
    };
    const { data: prev } = await svc.from('search_offers').select('id').eq('url_key', l.url_key).maybeSingle();
    const { error: e } = prev
      ? await svc.from('search_offers').update(fields).eq('id', prev.id)
      : await svc.from('search_offers').insert({ ...fields, url_key: l.url_key, first_seen_at: now });
    if (e) throw e;
    prev ? updated++ : added++;
  }
  const ids = [...idByPublic.values()];
  if (ids.length) await svc.rpc('search_refresh_prices', { p_ids: ids });
  return { offers_updated: updated, offers_added: added, properties_created: 0, merged_into_existing: 0, touched: ids };
}

/* ── Embeddings ── */

export function embedText(p) {
  return [p.title, p.property_type, p.neighborhood, p.town, (p.amenities || []).join(' '), p.description]
    .filter(Boolean).join('. ').slice(0, 1500);
}

/** Vectors from the `embed` edge function (gte-small, 384 dims, normalized).
    It accepts only the service-role key, which every server caller has. */
export async function embedTexts(texts) {
  const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;
  const r = await fetch(base + '/functions/v1/embed', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ inputs: texts })
  });
  if (!r.ok) throw new Error('embed responded ' + r.status);
  const data = await r.json();
  return Array.isArray(data.embeddings) ? data.embeddings : null;
}

/** Embed active properties that have no vector yet, in small batches. */
export async function embedPending(svc, { limit = 500, batch = 16 } = {}) {
  const { data: rows, error } = await svc.from('search_properties')
    .select('id, title, property_type, neighborhood, town, amenities, description')
    .eq('status', 'active').is('embedding', null).limit(limit);
  if (error) throw error;
  let done = 0;
  for (let i = 0; i < (rows || []).length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const texts = chunk.map(embedText);
    const vectors = await embedTexts(texts);
    if (!vectors) break; // embedding not configured: search still works on text and filters
    for (let j = 0; j < chunk.length; j++) {
      if (!Array.isArray(vectors[j]) || vectors[j].length !== 384) continue;
      const { error: e } = await svc.from('search_properties').update({
        embedding: JSON.stringify(vectors[j]),
        embedding_hash: createHash('sha1').update(texts[j]).digest('hex')
      }).eq('id', chunk[j].id);
      if (!e) done++;
    }
  }
  return { embedded: done, pending: (rows || []).length - done };
}
