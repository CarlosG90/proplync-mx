/**
 * Proplync.mx · Source adapters for the crawler
 * -----------------------------------------------------------------------------
 * One adapter per source. Each knows two things only: how to fetch a market's
 * listings (fetch) and how to map one of its items into the loose shape
 * api/_lib/search/normalize.js reads (toRaw). Everything else (validation,
 * currency, amenities, dedupe) is shared, so adding a portal is this file
 * plus one row in search_sources.
 *
 * The portals that block bots go through Apify's ready-made scrapers, paid
 * per result. Their output formats come from each actor's documentation
 * (apify.com/<actor>); when an actor changes its fields, toRaw is the only
 * place to update, and the run's health check (ingest/run.mjs) notices first.
 *
 * Start URLs per market can be set without a deploy in
 * search_sources.config.urls; the defaults below are a starting point to
 * verify with a 10-listing dry run (free on Apify's free plan).
 * -----------------------------------------------------------------------------
 */

const APIFY = 'https://api.apify.com/v2';

/** Run an Apify actor to completion and return its dataset items and cost. */
async function runApifyActor(actorId, input, { timeoutSec = 1800 } = {}) {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error('APIFY_TOKEN is not set');
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };

  const start = await fetch(`${APIFY}/acts/${encodeURIComponent(actorId)}/runs?waitForFinish=60`, {
    method: 'POST', headers, body: JSON.stringify(input)
  });
  if (!start.ok) throw new Error(`apify start ${actorId}: HTTP ${start.status} ${(await start.text()).slice(0, 200)}`);
  let run = (await start.json()).data;

  const deadline = Date.now() + timeoutSec * 1000;
  while (['READY', 'RUNNING'].includes(run.status)) {
    if (Date.now() > deadline) throw new Error(`apify run ${run.id} still ${run.status} after ${timeoutSec}s`);
    const r = await fetch(`${APIFY}/actor-runs/${run.id}?waitForFinish=60`, { headers });
    if (!r.ok) throw new Error(`apify poll ${run.id}: HTTP ${r.status}`);
    run = (await r.json()).data;
  }
  if (run.status !== 'SUCCEEDED') throw new Error(`apify run ${run.id} ended ${run.status}`);

  const items = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${APIFY}/datasets/${run.defaultDatasetId}/items?clean=true&format=json&offset=${offset}&limit=1000`, { headers });
    if (!r.ok) throw new Error(`apify dataset ${run.defaultDatasetId}: HTTP ${r.status}`);
    const page = await r.json();
    items.push(...page);
    if (page.length < 1000) break;
  }
  return { items, costUsd: Number(run.usageTotalUsd) || 0, runId: run.id };
}

const first = (...vals) => vals.find((v) => v !== null && v !== undefined && v !== '');

/* ── Inmuebles24 (actor gio21/inmuebles24-scraper, ~US$4 per 1,000) ──
   Output: id, title, operationType, price, currency, propertyType, areaBuilt,
   areaLot, bedrooms, bathrooms, address, neighborhood, city, state,
   publisher, image, url. */
const inmuebles24 = {
  actor: 'gio21~inmuebles24-scraper',
  defaultUrls: {
    'riviera-maya': ['https://www.inmuebles24.com/inmuebles-en-venta-en-quintana-roo.html'],
    'yucatan': ['https://www.inmuebles24.com/inmuebles-en-venta-en-yucatan.html']
  },
  async fetch({ urls, max, config }) {
    return runApifyActor(config.actor || this.actor, { startUrls: urls, maxItems: max });
  },
  toRaw(it) {
    return {
      url: it.url,
      external_id: it.id,
      title: it.title,
      operation: it.operationType,
      price: it.price,
      currency: it.currency,
      property_type: it.propertyType,
      built_m2: it.areaBuilt,
      land_m2: it.areaLot,
      bedrooms: it.bedrooms,
      bathrooms: it.bathrooms,
      town: first(it.city, it.state),
      neighborhood: first(it.neighborhood, it.address),
      listed_by: it.publisher,
      photos: it.image ? [it.image] : []
    };
  }
};

/* ── Lamudi (actor scrapers_lat/lamudi-scraper, ~US$6.15 per 1,000) ──
   Output includes coordinates, amenities, description and photos when
   withDetails is on, plus the agent's phone (kept internal, for Finder). */
const lamudi = {
  actor: 'scrapers_lat~lamudi-scraper',
  defaultUrls: {
    'riviera-maya': ['https://www.lamudi.com.mx/quintana-roo/for-sale/'],
    'yucatan': ['https://www.lamudi.com.mx/yucatan/for-sale/']
  },
  async fetch({ urls, max, config }) {
    return runApifyActor(config.actor || this.actor, { startUrls: urls, maxListings: max, withDetails: true });
  },
  toRaw(it) {
    const coords = it.coordinates || {};
    const baths = Number(it.bathrooms) || 0;
    const half = Number(it.halfBathrooms) || 0;
    return {
      url: it.url,
      external_id: it.listingId,
      title: it.title,
      operation: it.operation,
      price: it.price,
      currency: it.currency,
      property_type: it.propertyType,
      built_m2: first(it.builtAreaM2, it.areaM2),
      land_m2: it.plotAreaM2,
      bedrooms: it.bedrooms,
      bathrooms: baths || half ? baths + half * 0.5 : null,
      parking: it.parkingSpaces,
      town: first(it.city, it.municipality, it.region),
      neighborhood: first(it.neighborhood, it.location),
      lat: coords.lat,
      lng: coords.lng,
      description: it.description,
      features: Array.isArray(it.amenities) ? it.amenities : (it.amenities ? [String(it.amenities)] : []),
      photos: Array.isArray(it.photos) && it.photos.length ? it.photos : (it.imageUrl ? [it.imageUrl] : []),
      listed_by: first(it.agencyName, it.publishedBy),
      contact: it.agentPhone || it.publishedBy ? { name: it.publishedBy || null, phone: it.agentPhone || null } : null
    };
  }
};

export const ADAPTERS = { inmuebles24, lamudi };
