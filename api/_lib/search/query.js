/**
 * Proplync.mx · Understanding what a buyer typed
 * -----------------------------------------------------------------------------
 * "depa de 2 recámaras cerca de la playa bajo 400k" has to become: 2+
 * bedrooms, a price ceiling (in which currency?), a preference for the beach,
 * and whatever words are left to match against descriptions. The old parser
 * (api/generate.js nlsearch) threw away "cerca de la playa" and "con alberca"
 * because the search behind it could only match titles. The index can now
 * rank on amenities, distance and description text, so nothing is dropped.
 *
 * TWO PASSES, CHEAPEST FIRST
 *   1. A deterministic parser: bedrooms, prices, currency, rent vs sale, known
 *      towns, and every amenity phrase in amenities.js. Free and instant, and
 *      it covers most real queries completely.
 *   2. Groq (free tier, gpt-oss-20b pinned to search) only when words are left
 *      over that pass 1 could not place, like "tranquilo para trabajar remoto".
 *      Its answer is validated against the same vocabulary and merged in.
 * Parses are cached for a day by normalized text. Groq's free quota is 1,000
 * requests a day per model; this is what keeps search inside it.
 *
 * CURRENCY IS NEVER SILENTLY ASSUMED
 * When a price has no currency the parser guesses from magnitude and says so
 * (currency_assumed: true); the page shows that guess as a chip the buyer can
 * flip.
 * -----------------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import { AMENITIES, amenitiesFrom, fold } from './amenities.js';
import { parsePrice, parsePropertyType } from './normalize.js';
import { groqChat, messageText } from '../groq.js';
import { redisGet, redisSet } from '../redis.js';
import { logDegraded } from '../health.js';

export const SEARCH_MODEL = 'openai/gpt-oss-20b';

const STOPWORDS = new Set(('de del la las el los en y o a con sin para por que un una unos unas al mi me quiero busco ' +
  'buscando necesito tengo cerca menos mas hasta bajo sobre entre desde maximo minimo precio presupuesto ' +
  'the a an of in on and or with for to near under over below above max min from between i want looking need ' +
  'casa casas depa depas departamento departamentos depto deptos house houses apartment apartments condo condos mes ' +
  'venta renta rent sale buy comprar rentar propiedad propiedades property properties home homes').split(/\s+/));

const NUM_WORDS = { un: 1, una: 1, uno: 1, one: 1, dos: 2, two: 2, tres: 3, three: 3, cuatro: 4, four: 4, cinco: 5, five: 5 };

/* Phrases that mean "near the beach" without naming an amenity. Until places
   (beaches, landmarks) are loaded per market, they become a preference for
   beach-related amenities and stay in the text that descriptions are ranked on. */
const NEAR_BEACH = /cerca (?:de )?(?:la )?playa|a pasos (?:de )?(?:la )?playa|caminando a la playa|near (?:the )?beach|walk(?:ing distance)? to (?:the )?beach|close to (?:the )?beach/;

// Longest magnitude words first: "6 millones" must not be read as "6 mil".
const MONEY = '((?:us\\$|\\$|mxn|usd)?\\s*\\d[\\d.,]*\\s*(?:millones|millon|mdp|mil|k|m\\b)?\\s*(?:de\\s+)?(?:usd|us\\$|dolares|dollars|mxn|pesos|mn)?)';

/* The bare number in a price phrase, before any magnitude word. */
function num0(s) {
  const m = String(s || '').match(/\d+(?:[.,]\d+)?/);
  return m ? Number(m[0].replace(',', '.')) : null;
}

function clean(text) {
  return fold(text).replace(/[¿?¡!;]/g, ' ').replace(/\s+/g, ' ').trim();
}

function currencyIn(s) {
  if (/usd|us\$|dolar|dollar/.test(s)) return 'USD';
  if (/mxn|pesos|\bmn\b/.test(s)) return 'MXN';
  return null;
}

/* No currency stated: a sale under 2M or a rent under 8k is far more likely
   dollars in these markets. Shown to the buyer as an assumption. */
export function guessCurrency(amount, operation) {
  if (!amount) return null;
  if (operation === 'rental') return amount < 8000 ? 'USD' : 'MXN';
  return amount < 2_000_000 ? 'USD' : 'MXN';
}

/**
 * Pass 1. Pure, synchronous, testable.
 * @param {string} text
 * @param {{towns: string[]}} ctx  every town or neighborhood search can resolve
 */
export function parseDeterministic(text, { towns = [] } = {}) {
  const s = clean(text);
  const used = [];                       // spans already explained
  const take = (m) => { if (m) used.push(m[0]); return m; };
  const out = { hard: {}, prefs: { amenities: [] }, residual: '' };

  if (take(s.match(/\b(?:en )?(?:renta|rentar|alquiler|for rent|to rent|rent)\b|\/mes|\/mo\b|al mes|por mes|mensual(?:es)?|per month|a month/))) out.hard.operation = 'rental';
  else if (take(s.match(/\b(?:en )?(?:venta|comprar|for sale|to buy|buy)\b/))) out.hard.operation = 'sale';

  const beds = take(s.match(/(\d+|un|una|uno|dos|tres|cuatro|cinco|one|two|three|four|five)\s*\+?\s*(?:recamaras?|rec\b|habitaciones?|hab\b|cuartos?|dormitorios?|bedrooms?|beds?|br\b|bd\b)/));
  if (beds) out.hard.beds_min = Number(beds[1]) || NUM_WORDS[beds[1]] || null;

  const between = take(s.match(new RegExp('entre\\s+' + MONEY + '\\s+y\\s+' + MONEY + '|between\\s+' + MONEY + '\\s+and\\s+' + MONEY)));
  const below = !between && take(s.match(new RegExp('(?:bajo|menos de|maximo|max|hasta|under|below|less than|up to|<)\\s*(?:de\\s*)?' + MONEY)));
  const above = take(s.match(new RegExp('(?:desde|mas de|minimo|min|from|over|more than|at least|>)\\s*(?:de\\s*)?' + MONEY)));
  let priceText = '';
  if (between) {
    let a = parsePrice(between[1] || between[3]);
    const b = parsePrice(between[2] || between[4]);
    const bRaw = num0(between[2] || between[4]);
    if (a && b && a < 1000 && bRaw && b / bRaw >= 1000) a = a * (b / bRaw);
    if (a) out.hard.price_min = Math.min(a, b || a);
    if (b) out.hard.price_max = Math.max(a || b, b);
    priceText = between[0];
  } else {
    if (below) { out.hard.price_max = parsePrice(below[1]); priceText += below[0]; }
    if (above) { out.hard.price_min = parsePrice(above[1]); priceText += ' ' + above[0]; }
  }
  if (!between && !below && !above) {
    // "4.5 mdp maximo", "450k usd", "6 millones": a price stated with a unit
    // but no "bajo"/"hasta" is the buyer's budget, so it is the ceiling.
    const bare = take(s.match(new RegExp(MONEY.replace(/\?\\s\*\(\?:de/, '\\s*(?:de') + '(?=\\s*(?:maximo|max|tope|o menos|or less|budget|presupuesto)?\\b)')));
    const unit = bare && /millones|millon|mdp|mil\b|k\b|usd|us\$|dolares|dollars|mxn|pesos|\$/.test(bare[1]);
    if (unit && parsePrice(bare[1])) { out.hard.price_max = parsePrice(bare[1]); priceText = bare[0]; }
    else if (bare) used.pop();
    const tail = s.match(/\b(?:maximo|max|tope|o menos|or less)\b/);
    if (tail && out.hard.price_max) used.push(tail[0]);
  }
  if (out.hard.price_max || out.hard.price_min) {
    const stated = currencyIn(priceText) || currencyIn(s);
    out.hard.currency = stated || guessCurrency(out.hard.price_max || out.hard.price_min, out.hard.operation);
    out.hard.currency_assumed = !stated;
  }

  const type = s.match(/\b(terrenos?|lotes?|casas?|villas?|departamentos?|deptos?|depas?|studios?|estudios?|penthouse|loft|locales?|oficinas?|land|lots?|houses?|apartments?|condos?)\b/);
  if (type) {
    out.hard.property_type = parsePropertyType(type[1]);
    used.push(type[0]);
  }

  const size = take(s.match(/(\d{2,5})\s*(?:m2|m²|mts|metros|sqm|square meters)/));
  if (size) out.hard.size_min = Number(size[1]);

  // Towns and neighborhoods we have listings in, longest first so
  // "playa del carmen" wins over "playa".
  const found = [];
  for (const t of [...towns].sort((a, b) => b.length - a.length)) {
    const ft = fold(t);
    if (ft.length >= 3 && new RegExp('(^|[^a-z])' + ft.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z])').test(s) && !found.some((f) => fold(f).includes(ft))) {
      found.push(t);
      used.push(ft);
    }
  }
  if (found.length) out.hard.towns = found;

  out.prefs.amenities = amenitiesFrom(s);
  for (const phrases of Object.values(AMENITIES)) for (const ph of phrases) if (s.includes(ph)) used.push(ph);
  const nearBeach = s.match(NEAR_BEACH);
  if (nearBeach) {
    used.push(nearBeach[0]);
    out.prefs.near = 'beach';
    out.prefs.amenities = [...new Set([...out.prefs.amenities, 'beach_access'])].sort();
  }

  let rest = s;
  for (const u of used.sort((a, b) => b.length - a.length)) rest = rest.split(u).join(' ');
  out.residual = rest.split(/\s+/).filter((w) => w && !STOPWORDS.has(w) && !/^\d+$/.test(w) && w.length > 2).join(' ');
  return out;
}

const LLM_PROMPT = (towns, tags) => `You turn a home buyer's search in Mexico (Spanish or English) into JSON. Return ONLY:
{"operation":"sale"|"rental"|null,"towns":[],"beds_min":null,"price_min":null,"price_max":null,"currency":"MXN"|"USD"|null,"size_min":null,"amenities":[],"near":"beach"|null,"semantic_text":""}
Rules:
- towns: only from this list, spelled exactly: ${towns.join(', ')}.
- amenities: only these tags: ${tags.join(', ')}.
- prices are plain numbers ("400k" = 400000, "4.2 mdp" = 4200000). currency only if the text says it.
- semantic_text: the buyer's descriptive wishes in a few Spanish words (e.g. "tranquilo, para trabajar remoto, cerca de cafes"), without prices, bedrooms or towns. Empty if none.
- Never invent anything the text does not say; use null or [] instead.`;

async function parseWithLlm(text, towns) {
  const tags = Object.keys(AMENITIES);
  const data = await groqChat({
    messages: [
      { role: 'system', content: LLM_PROMPT(towns.slice(0, 120), tags) },
      { role: 'user', content: String(text).slice(0, 300) }
    ],
    temperature: 0,
    max_tokens: 300,
    response_format: { type: 'json_object' }
  }, { model: SEARCH_MODEL });
  const raw = JSON.parse(messageText(data));
  const townSet = new Map(towns.map((t) => [fold(t), t]));
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  return {
    operation: raw.operation === 'sale' || raw.operation === 'rental' ? raw.operation : null,
    towns: (Array.isArray(raw.towns) ? raw.towns : []).map((t) => townSet.get(fold(t))).filter(Boolean),
    beds_min: n(raw.beds_min),
    price_min: n(raw.price_min),
    price_max: n(raw.price_max),
    currency: raw.currency === 'USD' || raw.currency === 'MXN' ? raw.currency : null,
    size_min: n(raw.size_min),
    amenities: (Array.isArray(raw.amenities) ? raw.amenities : []).filter((a) => tags.includes(a)),
    near: raw.near === 'beach' ? 'beach' : null,
    semantic_text: typeof raw.semantic_text === 'string' ? raw.semantic_text.slice(0, 200) : ''
  };
}

/**
 * Parse a buyer's query. Deterministic first; Groq only for leftover words.
 * @returns {Promise<{hard:object, prefs:object, semantic_text:string, via:'rules'|'rules+llm', cached?:boolean}>}
 */
export async function parseQuery(text, { towns = [] } = {}) {
  const key = 'sq:v1:' + createHash('sha1').update(clean(text)).digest('hex');
  const cached = await redisGet(key);
  if (cached) return { ...cached, cached: true };

  const det = parseDeterministic(text, { towns });
  let result = { hard: det.hard, prefs: det.prefs, semantic_text: det.residual, via: 'rules' };

  if (det.residual && process.env.GROQ_API_KEY) {
    try {
      const llm = await parseWithLlm(text, towns);
      const hard = { ...det.hard };
      // Rules win where both answered: they are exact. The model fills gaps.
      for (const k of ['operation', 'beds_min', 'price_min', 'price_max', 'size_min']) {
        if (hard[k] == null && llm[k] != null) hard[k] = llm[k];
      }
      if (!hard.towns && llm.towns.length) hard.towns = llm.towns;
      if ((hard.price_max || hard.price_min) && !hard.currency) {
        hard.currency = llm.currency || guessCurrency(hard.price_max || hard.price_min, hard.operation);
        hard.currency_assumed = !llm.currency;
      }
      const prefs = {
        amenities: [...new Set([...det.prefs.amenities, ...llm.amenities])].sort(),
        near: det.prefs.near || llm.near || undefined
      };
      result = { hard, prefs, semantic_text: llm.semantic_text || det.residual, via: 'rules+llm' };
    } catch (err) {
      // Busy or down: the rules already gave a usable search.
      logDegraded('search:parse-llm', err);
    }
  }
  await redisSet(key, result, 86400);
  return result;
}

/**
 * Turn a parse plus the page's own controls into search_properties_v1 params.
 * Prices become MXN here, once, with the same rate the index used.
 */
export function toRankParams(parsed, { fx, overrides = {}, sort, limit, offset, bbox, embedding } = {}) {
  const hard = { ...(parsed && parsed.hard), ...overrides.hard };
  const prefs = { ...(parsed && parsed.prefs), ...overrides.prefs };
  const toMxn = (v) => (v == null ? null : (hard.currency === 'USD' ? v * fx : v));
  const p = {
    operation: hard.operation || null,
    towns: hard.towns && hard.towns.length ? hard.towns : null,
    beds_min: hard.beds_min || null,
    price_min_mxn: toMxn(hard.price_min),
    price_max_mxn: toMxn(hard.price_max),
    size_min: hard.size_min || null,
    size_max: hard.size_max || null,
    amenities_preferred: prefs.amenities && prefs.amenities.length ? prefs.amenities : null,
    amenities_required: hard.amenities_required && hard.amenities_required.length ? hard.amenities_required : null,
    q: overrides.q != null ? overrides.q
      : [hard.property_type, parsed && parsed.semantic_text].filter(Boolean).join(' ') || null,
    sort: ['relevance', 'price_asc', 'price_desc', 'newest'].includes(sort) ? sort : 'relevance',
    limit: limit || 24,
    offset: offset || 0,
    bbox: Array.isArray(bbox) && bbox.length === 4 && bbox.every((x) => Number.isFinite(Number(x))) ? bbox.map(Number) : null,
    embedding: Array.isArray(embedding) && embedding.length === 384 ? embedding : null,
    market: hard.market || null
  };
  // The RPC treats a missing key and a null the same, but keep the payload small.
  return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== null && v !== undefined));
}
