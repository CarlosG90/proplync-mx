/**
 * EasyBroker → InmoContent OS  ·  listings proxy
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * EasyBroker's API is back-end only and needs a SECRET key. You must never put
 * that key in front-end code (anyone could read it). This tiny proxy holds the
 * key on the server, fetches your listings, reshapes them to the exact format
 * the website expects, and returns clean JSON the page can fetch().
 *
 * DEPLOY (pick one — the handler works on all three):
 *   • Vercel   → save as /api/listings.js
 *   • Netlify  → save as /netlify/functions/listings.js
 *   • Node/Express → see the express snippet at the bottom
 *
 * SET ONE ENV VAR:
 *   EASYBROKER_API_KEY = your key
 *   - Real data:  get your key at app.easybroker.com → Settings → API
 *   - Testing:    EasyBroker publishes a sandbox key (fictional data) in their
 *                 docs playground at dev.easybroker.com — use it to try this out
 *                 with no account.
 * -----------------------------------------------------------------------------
 */

const EB_BASE = 'https://api.easybroker.com/v1';

// Map one EasyBroker property to the shape the site's cards use.
function mapProperty(p) {
  const op = (p.operations && p.operations[0]) || {};
  // EasyBroker "location" is a single string, e.g. "Aldea Zamá, Tulum, Q. Roo".
  const parts = (p.location || '').split(',').map(s => s.trim());
  return {
    public_id: p.public_id,
    title_es: p.title || 'Propiedad',
    title_en: p.title || 'Property',           // EB stores one title; translate later if needed
    neighborhood: parts[0] || '',
    town: parts[1] || parts[0] || '',
    bedrooms: p.bedrooms || 0,
    bathrooms: p.bathrooms || 0,
    parking: p.parking_spaces || 0,
    size: p.construction_size || p.lot_size || 0,
    operation: op.type === 'rental' ? 'rental' : 'sale',
    currency: op.currency || 'USD',
    amount: op.amount || 0,
    formatted: op.formatted_amount || (op.amount ? op.amount.toLocaleString('en-US') : ''),
    image: p.title_image_full || p.title_image_thumb || ''
  };
}

// Pagination settings. EasyBroker caps `limit` at 50 per page, so to pull more
// we walk the pages. Caps below stop a runaway loop and keep us under EB's
// 20 requests/second limit.
const PAGE_LIMIT   = 50;    // max EasyBroker allows per page
const MAX_PAGES    = 40;    // safety cap → up to 2,000 listings
const PAGE_DELAY_MS = 120;  // pause between page requests (well under 20 req/s)
// Note: serverless functions have execution limits (Vercel/Netlify ~10s by default).
// A large crawl can exceed that — the Cache-Control header below means the full
// walk only runs once per cache window, not on every visitor. If you have many
// hundreds of listings, lower MAX_PAGES, raise your function timeout, or cache
// results in a KV/database instead of crawling on-request.

const sleep = ms => new Promise(res => setTimeout(res, ms));

async function fetchPage(key, page) {
  const url = `${EB_BASE}/properties?page=${page}&limit=${PAGE_LIMIT}&search[statuses][]=published`;
  const r = await fetch(url, {
    headers: {
      'accept': 'application/json',
      'Country-Code': 'MX',
      'X-Authorization': key
    }
  });
  if (!r.ok) throw new Error(`EasyBroker responded ${r.status} on page ${page}`);
  return r.json(); // { content: [...], pagination: { limit, page, total, next_page, previous_page } }
}

async function fetchListings() {
  const key = process.env.EASYBROKER_API_KEY;
  if (!key) throw new Error('Missing EASYBROKER_API_KEY');

  const all = [];
  let page = 1;

  while (page <= MAX_PAGES) {
    const data = await fetchPage(key, page);
    const batch = data.content || [];
    all.push(...batch);

    // Decide whether another page exists. EasyBroker returns pagination.next_page
    // (a page number or null); we also stop if the batch came back short or empty.
    const pg = data.pagination || {};
    const hasNext = pg.next_page != null && batch.length === PAGE_LIMIT;
    if (!hasNext) break;

    page += 1;
    await sleep(PAGE_DELAY_MS); // be polite to the rate limit
  }

  return all.map(mapProperty);
}

// --- Vercel / Netlify style handler ------------------------------------------
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');      // tighten to your domain in prod
  res.setHeader('Cache-Control', 's-maxage=300');          // cache 5 min; respects EB's 20 req/s limit
  try {
    const listings = await fetchListings();
    res.status(200).json({ listings });
  } catch (err) {
    res.status(502).json({ error: 'listings_unavailable', detail: String(err.message) });
  }
}

/* -----------------------------------------------------------------------------
 * FRONT-END: swap the hard-coded sample array for a live fetch.
 * In the site's <script>, replace `const properties = [ ...sample... ]` with:
 *
 *     let properties = [];
 *     async function loadListings(){
 *       try{
 *         const r = await fetch('/api/listings');
 *         const { listings } = await r.json();
 *         if (listings && listings.length){
 *           properties = listings;
 *           activeProp = properties[0];
 *           renderProperties();
 *           updateHeroListing();
 *           renderPreview();
 *         }
 *       }catch(e){ console.warn('Falling back to sample listings', e); }
 *     }
 *     loadListings();   // call once on load
 *
 * Keep a small sample array as a fallback so the page still looks complete if
 * the proxy is unreachable.
 * -----------------------------------------------------------------------------
 *
 * EXPRESS variant:
 *
 *     const express = require('express');
 *     const app = express();
 *     app.get('/api/listings', async (req, res) => {
 *       try { res.json({ listings: await fetchListings() }); }
 *       catch (e) { res.status(502).json({ error: String(e.message) }); }
 *     });
 *     app.listen(3000);
 */
