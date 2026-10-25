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

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeUrl } from '../../api/_lib/scout-merge.js';

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


/* ── Agency sites, read by our own scraper (free; source id `scraper_web`) ──
   A Python worker (mexico_scout_platform/src/worker.py) lists each site's listing URLs from its sitemap and scrapes the pages we ask
   for. Per run we read only what is NEW, plus one seventh of the known listings (so every price is refreshed weekly), up to the
   source's max_results_per_run. Every other listing the sitemap still names is reported as "still listed" (seenUrls), which keeps it
   from being marked stale without a request to the site. See supabase/017_scraper_web_source.sql to switch it on. */

const WORKER_DIR = fileURLToPath(new URL('../../mexico_scout_platform/', import.meta.url));

/** Small stable hash, so the weekly refresh slice of a URL never changes. */
export function hashKey(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Decide which sitemap entries to read now.
 * @param {{url:string, lastmod?:string|null}[]} sitemap  every listing URL the sites name
 * @param {Set<string>} known  url_keys already in the index for this source
 * @param {{day:number, cap:number, refreshDays?:number}} opts  day: any integer that changes daily (days since epoch)
 * @returns {{fetch: object[], seenUrls: string[]}}  entries to scrape, and URLs to mark as still listed
 */
export function pickPages(sitemap, known, { day, cap, refreshDays = 7 }) {
  const fresh = [], due = [], others = [];
  for (const entry of sitemap) {
    const key = normalizeUrl(entry.url);
    if (!key) continue;
    if (!known.has(key)) fresh.push(entry);
    else if (hashKey(key) % refreshDays === ((day % refreshDays) + refreshDays) % refreshDays) due.push(entry);
    else others.push(entry);
  }
  // Newest changes first among the new ones; the refresh slice only uses what room is left.
  fresh.sort((a, b) => String(b.lastmod || '').localeCompare(String(a.lastmod || '')));
  const toFetch = [...fresh, ...due].slice(0, Math.max(0, cap));
  const fetched = new Set(toFetch.map((e) => e.url));
  const seenUrls = [...due, ...others].filter((e) => !fetched.has(e.url)).map((e) => e.url);
  return { fetch: toFetch, seenUrls };
}

/** Run the Python worker. stdout is pure JSON; its log lines (stderr) go straight to this process's stderr. */
export function callWorker(args, input = '', { maxPages = 20 } = {}) {
  const python = process.env.SCOUT_WORKER_PYTHON || 'python3';
  return new Promise((resolve, reject) => {
    // The worker caps how many pages one process may fetch (politeness); size that cap to what this run asked for.
    const env = { ...process.env, MAX_PAGES_PER_RUN: String(Math.max(20, maxPages)) };
    const child = spawn(python, ['-m', 'src.worker', ...args], { cwd: WORKER_DIR, env, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`worker ${args[0]} exited ${code}`))));
    child.stdin.end(input);
  });
}

async function knownKeys(svc, sourceId) {
  const known = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc.from('search_offers').select('url_key').eq('source_id', sourceId).range(from, from + 999);
    if (error) throw error;
    for (const row of data || []) known.add(row.url_key);
    if (!data || data.length < 1000) break;
  }
  return known;
}

const scraperWeb = {
  defaultUrls: { 'riviera-maya': ['sitemaps'] },   // the worker owns the real addresses; this only lets the market loop start
  async fetch({ max, svc, sourceId = 'scraper_web', run = callWorker, now = Date.now() }) {
    const sitemap = JSON.parse(await run(['sitemap']) || '[]');
    const known = await knownKeys(svc, sourceId);
    const plan = pickPages(sitemap, known, { day: Math.floor(now / 86_400_000), cap: Number(max) || 80 });
    console.log(`  scraper_web: ${sitemap.length} URL(s) in the sitemaps, ${known.size} known, reading ${plan.fetch.length}, ${plan.seenUrls.length} still listed`);
    const items = plan.fetch.length
      ? (await run(['scrape'], JSON.stringify(plan.fetch), { maxPages: plan.fetch.length + 5 })).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
      : [];
    return { items, costUsd: 0, seenUrls: plan.seenUrls };
  },
  toRaw(it) {
    return {
      url: it.url, external_id: it.external_id, title: it.title, operation: it.operation,
      price: it.price, currency: it.currency, property_type: it.property_type,
      built_m2: it.built_m2, land_m2: it.land_m2, bedrooms: it.bedrooms, bathrooms: it.bathrooms,
      town: it.town, neighborhood: it.neighborhood, description: it.description, listed_by: it.listed_by, photos: it.photos || []
    };
  }
};

export const ADAPTERS = { inmuebles24, lamudi, scraper_web: scraperWeb };
