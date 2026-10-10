/**
 * Proplync.mx · Scout: one card per real property
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * In Mexico one property is advertised on several portals, by several agents,
 * at several prices. Finder's promise (finder.html) is that the buyer sees it
 * once, with every price side by side. The model groups what it sees, but it
 * reads pages one at a time and misses some matches, and it has no idea which
 * of our own agencies' listings are the same house. So the final grouping is
 * done here, deterministically, where it can be tested.
 *
 * It is also where the brief's hard limits are enforced in code rather than
 * trusted to the prompt: over the maximum budget, a must-have the source says
 * is missing, or a deal-breaker the source says is present, and the card is
 * dropped. Concierge promises never to relax a must-have; this is what keeps
 * that promise when the model is generous.
 *
 * Pure functions, no I/O: api/_lib/scout.js does the reading and writing.
 * -----------------------------------------------------------------------------
 */

const MAX_CARDS = 20;
const MAX_PHOTOS = 12;

/* Two ads describe the same property when they agree on town and bedrooms and
   are this close on built area and price. Portals round m² and agents quote
   slightly different prices for the same unit; wider than this starts merging
   neighbouring units in the same building, which is the worse mistake. */
const M2_TOLERANCE = 0.03;
const PRICE_TOLERANCE = 0.07;

/* Query parameters that track the click, not identify the listing. */
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|ref$|source$|mc_)/i;

export function normalizeUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
    }
    return 'https://' + host + u.pathname.replace(/\/+$/, '') + u.search;
  } catch (e) {
    return null;
  }
}

function norm(value) {
  return String(value == null ? '' : value)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * A budget as Concierge captured it: 450000, "450000", "450k", "1.2 millones".
 * Returns a number or null. Never guesses a currency.
 */
export function parseMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.toLowerCase().replace(/,/g, '');
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  let n = Number(m[1]);
  if (/\d\s*k\b|\bmil\b/.test(s)) n *= 1e3;
  else if (/\d\s*m\b|mill|mdp|\bmm\b/.test(s)) n *= 1e6;
  return n > 0 ? n : null;
}

/** Price in MXN for comparison only; the card keeps every original price. */
export function toMxn(price, currency, fxUsdMxn) {
  const p = num(price);
  if (p === null) return null;
  const c = String(currency || 'MXN').toUpperCase();
  if (c === 'MXN') return p;
  if (c === 'USD') return fxUsdMxn > 0 ? p * fxUsdMxn : null;
  return null; // EUR, CAD…: no rate configured, so not comparable and not guessed
}

function close(a, b, tolerance) {
  if (a === null || b === null) return false;
  const hi = Math.max(a, b);
  return hi === 0 ? a === b : Math.abs(a - b) / hi <= tolerance;
}

function lowestMxn(card, fx) {
  const prices = card.sources.map((s) => toMxn(s.price, s.currency, fx)).filter((p) => p !== null);
  return prices.length ? Math.min(...prices) : null;
}

/** Same property, judged on facts alone (shared URLs are matched separately). */
export function sameProperty(a, b, fx) {
  if (!a.town || norm(a.town) !== norm(b.town)) return false;
  if (a.neighborhood && b.neighborhood && norm(a.neighborhood) !== norm(b.neighborhood)) return false;
  if (a.operation && b.operation && a.operation !== b.operation) return false;
  if (num(a.bedrooms) === null || num(a.bedrooms) !== num(b.bedrooms)) return false;
  if (!close(num(a.built_m2), num(b.built_m2), M2_TOLERANCE)) return false;
  return close(lowestMxn(a, fx), lowestMxn(b, fx), PRICE_TOLERANCE);
}

function inventoryCard(listing, lang, siteOrigin) {
  const title = lang === 'en'
    ? (listing.title_en || listing.title_es)
    : (listing.title_es || listing.title_en);
  const photos = [listing.image].concat(Array.isArray(listing.images) ? listing.images : []);
  return {
    origin: 'proplync',
    listing_public_id: listing.public_id,
    title: title || null,
    operation: listing.operation || null,
    property_type: listing.property_type || null,
    town: listing.town || null,
    neighborhood: listing.neighborhood || null,
    // 0 in our table means "not filled in", not "zero bedrooms".
    bedrooms: num(listing.bedrooms) || null,
    bathrooms: num(listing.bathrooms) || null,
    built_m2: num(listing.size) || null,
    land_m2: null,
    sources: [{
      url: siteOrigin.replace(/\/+$/, '') + '/propiedad/' + listing.public_id,
      site: 'proplync.mx',
      listed_by: listing.agency_name || null,
      price: num(listing.amount),
      currency: listing.currency || null
    }],
    photos: photos.filter((p) => /^https?:\/\//i.test(String(p || '')))
  };
}

function modelCard(c, inventoryById, lang, siteOrigin) {
  const listing = c.proplync_listing_id && inventoryById.get(c.proplync_listing_id);
  // Our own listing: the database is the source of truth for its facts, and
  // the model only contributes the fit assessment and any portal copies it saw.
  const base = listing ? inventoryCard(listing, lang, siteOrigin) : {
    origin: 'web',
    listing_public_id: null,
    title: c.title || null,
    operation: c.operation || null,
    property_type: c.property_type || null,
    town: c.town || null,
    neighborhood: c.neighborhood || null,
    bedrooms: num(c.bedrooms), bathrooms: num(c.bathrooms),
    built_m2: num(c.built_m2), land_m2: num(c.land_m2),
    sources: [], photos: []
  };
  return {
    ...base,
    sources: base.sources.concat(c.sources || []),
    photos: base.photos.concat(c.photos || []),
    must_haves: c.must_haves || [],
    deal_breakers: c.deal_breakers || [],
    summary: c.summary || null,
    questions_for_agent: c.questions_for_agent || []
  };
}

const MUST_RANK = { no: 3, met: 2, unknown: 1 };
const DEAL_RANK = { present: 3, absent: 2, unknown: 1 };

/* When two ads disagree about a must-have, the stricter reading wins: a "no"
   from any source drops the card, and a person can still ask about it. */
function mergeChecks(lists, rank) {
  const byItem = new Map();
  for (const list of lists) {
    for (const check of list) {
      const key = norm(check.item);
      const prev = byItem.get(key);
      if (!prev || (rank[check.status] || 0) > (rank[prev.status] || 0)) byItem.set(key, check);
    }
  }
  return [...byItem.values()];
}

function firstNonNull(cards, field) {
  for (const c of cards) if (c[field] !== null && c[field] !== undefined && c[field] !== '') return c[field];
  return null;
}

function mergeGroup(group, fx) {
  // Our own listing first, so its facts win over a portal's copy of them.
  const cards = [...group].sort((a, b) => (b.origin === 'proplync') - (a.origin === 'proplync'));
  const sources = [];
  const seen = new Set();
  for (const s of cards.flatMap((c) => c.sources)) {
    const key = normalizeUrl(s.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    sources.push(s);
  }
  const merged = {
    origin: cards.some((c) => c.origin === 'proplync') ? 'proplync' : 'web',
    listing_public_id: firstNonNull(cards, 'listing_public_id'),
    title: firstNonNull(cards, 'title'),
    operation: firstNonNull(cards, 'operation'),
    property_type: firstNonNull(cards, 'property_type'),
    town: firstNonNull(cards, 'town'),
    neighborhood: firstNonNull(cards, 'neighborhood'),
    bedrooms: firstNonNull(cards, 'bedrooms'),
    bathrooms: firstNonNull(cards, 'bathrooms'),
    built_m2: firstNonNull(cards, 'built_m2'),
    land_m2: firstNonNull(cards, 'land_m2'),
    sources,
    photos: [...new Set(cards.flatMap((c) => c.photos))].slice(0, MAX_PHOTOS),
    match: {
      must_haves: mergeChecks(cards.map((c) => c.must_haves || []), MUST_RANK),
      deal_breakers: mergeChecks(cards.map((c) => c.deal_breakers || []), DEAL_RANK),
      summary: firstNonNull(cards, 'summary'),
      questions_for_agent: [...new Set(cards.flatMap((c) => c.questions_for_agent || []))].slice(0, 10)
    }
  };
  merged.lowest_price_mxn = lowestMxn(merged, fx);
  const checks = merged.match.must_haves;
  merged.fit_score = checks.length
    ? Math.round(100 * checks.reduce((sum, c) => sum + (c.status === 'met' ? 1 : c.status === 'unknown' ? 0.5 : 0), 0) / checks.length)
    : null;
  return merged;
}

/**
 * @param {object} p
 * @param {object[]} p.candidates  validated submit_candidates entries
 * @param {object[]} p.inventory   PropLync listings the model was shown
 * @param {object}   p.brief       the approved Concierge brief
 * @param {number}   p.fx          MXN per USD, for comparison only
 * @param {string}   p.lang        'es' | 'en'
 * @param {string}   p.siteOrigin  for links to our own property pages
 * @returns {{cards: object[], dropped: {reason: string, title: string|null}[]}}
 */
export function mergeCandidates({ candidates, inventory, brief, fx, lang = 'es', siteOrigin = 'https://proplync-mx.vercel.app' }) {
  const inventoryById = new Map((inventory || []).map((l) => [l.public_id, l]));
  const cards = (candidates || []).map((c) => modelCard(c, inventoryById, lang, siteOrigin));

  // Union-find: two cards join when they share a listing URL or our listing
  // id, or when their facts say they are the same unit.
  const parent = cards.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a, b) => { parent[find(a)] = find(b); };
  const byUrl = new Map();
  cards.forEach((card, i) => {
    for (const s of card.sources) {
      const key = normalizeUrl(s.url);
      if (!key) continue;
      if (byUrl.has(key)) join(i, byUrl.get(key)); else byUrl.set(key, i);
    }
  });
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i], b = cards[j];
      if ((a.listing_public_id && a.listing_public_id === b.listing_public_id) || sameProperty(a, b, fx)) join(i, j);
    }
  }
  const groups = new Map();
  cards.forEach((card, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(card);
  });

  const budget = (brief && brief.budget) || {};
  const maxMxn = toMxn(parseMoney(budget.max), budget.currency || 'MXN', fx);

  const kept = [];
  const dropped = [];
  for (const group of groups.values()) {
    const card = mergeGroup(group, fx);
    if (!card.sources.length) { dropped.push({ reason: 'no_source', title: card.title }); continue; }
    if (card.match.must_haves.some((c) => c.status === 'no')) { dropped.push({ reason: 'must_have_missing', title: card.title }); continue; }
    if (card.match.deal_breakers.some((c) => c.status === 'present')) { dropped.push({ reason: 'deal_breaker', title: card.title }); continue; }
    if (maxMxn !== null && card.lowest_price_mxn !== null && card.lowest_price_mxn > maxMxn) {
      dropped.push({ reason: 'over_budget', title: card.title }); continue;
    }
    kept.push(card);
  }

  kept.sort((a, b) =>
    (b.fit_score ?? -1) - (a.fit_score ?? -1) ||
    (a.lowest_price_mxn ?? Infinity) - (b.lowest_price_mxn ?? Infinity));
  return { cards: kept.slice(0, MAX_CARDS), dropped };
}
