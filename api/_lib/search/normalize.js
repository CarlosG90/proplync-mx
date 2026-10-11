/**
 * Proplync.mx · One listing shape for every source
 * -----------------------------------------------------------------------------
 * Each crawler adapter (ingest/adapters/*) maps its portal's JSON into a loose
 * "raw" object; this turns any raw object into the canonical listing the index
 * stores. Every portal writes numbers, currencies and operations differently
 * ("2.5 baños", "95 m²", "US$ 245,000", "MN", "Venta"); every one of those is
 * handled here, once, with tests, instead of in each adapter.
 *
 * It also decides what is not worth keeping: no usable URL, no price and no
 * size, or a place outside every enabled market. Crawled data is untrusted:
 * strings are capped, URLs must be http(s), numbers must be plausible.
 * -----------------------------------------------------------------------------
 */

import { normalizeUrl, toMxn } from '../scout-merge.js';
import { amenitiesFrom, fold } from './amenities.js';

const MAX_PHOTOS = 8;
const MAX_DESCRIPTION = 1000;

function cap(value, n) {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, n) : null;
}

/** "2.5", "2,5", "95 m²", "3 rec", 4 → number; anything else → null. */
export function num(value, { min = 0, max = 1e12 } = {}) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= min && value <= max ? value : null;
  const m = String(value).replace(/\s/g, '').match(/-?\d+(?:[.,]\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(',', '.'));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/** "$4,200,000", "US$ 245,000.00", "4.2 mdp", "450k" → number. */
export function parsePrice(value) {
  if (typeof value === 'number') return value > 0 && value < 1e11 ? value : null;
  if (value === null || value === undefined) return null;
  const s = fold(value);
  const m = s.match(/\d[\d,.\s]*/);
  if (!m) return null;
  let digits = m[0].replace(/\s/g, '');
  // "4.2 mdp" / "1.5 millones": a decimal number with a magnitude word
  const scaled = /mdp|millon|mill\b|\d\s*m\b/.test(s) ? 1e6 : /\d\s*k\b|\bmil\b/.test(s) ? 1e3 : 1;
  if (scaled > 1) {
    const n = Number(digits.replace(/,(?=\d{1,2}$)/, '.').replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n * scaled : null;
  }
  // Thousands separators: "4,200,000", "4.200.000", "245,000.00"
  digits = digits.replace(/[.,](\d{2})$/, '');      // drop cents
  digits = digits.replace(/[.,]/g, '');
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 && n < 1e11 ? n : null;
}

export function parseCurrency(value, priceText) {
  const s = fold([value, priceText].filter(Boolean).join(' '));
  if (/\busd\b|us\$|u\$s|dolar|dollar/.test(s)) return 'USD';
  if (/\bmxn\b|\bmn\b|m\.n\.|peso|\bmxp\b/.test(s)) return 'MXN';
  if (/\beur\b|€|euro/.test(s)) return 'EUR';
  return null;
}

export function parseOperation(value) {
  const s = fold(value);
  if (/renta|\brent|alquiler|arriendo|lease/.test(s)) return 'rental';
  if (/venta|\bsale\b|for sale|vende|compra/.test(s)) return 'sale';
  return null;
}

const TYPES = [
  ['departamento', /departamento|depto|\bdepa\b|apartment|condo|\bflat\b|loft|studio|estudio|penthouse|\bph\b/],
  ['casa', /\bcasa\b|house|\bhome\b|villa|residencia|townhouse/],
  ['terreno', /terreno|\blote\b|\bland\b|\blot\b|parcela/],
  ['local', /local comercial|\blocal\b|commercial|oficina|office|bodega/]
];

export function parsePropertyType(...texts) {
  const s = fold(texts.filter(Boolean).join(' '));
  for (const [type, re] of TYPES) if (re.test(s)) return type;
  return null;
}

/**
 * The enabled market a listing belongs to, by town name first, then by
 * coordinates. Null means outside everything we cover: not stored.
 */
export function resolveMarket(markets, { town, neighborhood, lat, lng }) {
  const place = fold([town, neighborhood].filter(Boolean).join(' '));
  for (const m of markets) {
    if (place && (m.towns || []).some((t) => place.includes(fold(t)))) return m.id;
  }
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    for (const m of markets) {
      if (lng >= m.min_lng && lng <= m.max_lng && lat >= m.min_lat && lat <= m.max_lat) return m.id;
    }
  }
  return null;
}

/**
 * @param {object} raw     an adapter's loose listing
 * @param {object} ctx     { sourceId, fx, markets }
 * @returns {object|null}  the canonical listing, or null when not worth keeping
 */
export function normalizeListing(raw, { sourceId, fx, markets }) {
  if (!raw || typeof raw !== 'object') return null;
  const url = String(raw.url || '').trim();
  const urlKey = normalizeUrl(url);
  if (!urlKey) return null;

  const price = parsePrice(raw.price);
  const currency = parseCurrency(raw.currency, typeof raw.price === 'string' ? raw.price : null) || (price ? 'MXN' : null);
  const built = num(raw.built_m2 ?? raw.size, { min: 5, max: 100000 });
  const land = num(raw.land_m2, { min: 5, max: 10000000 });
  if (!price && !built) return null; // nothing a buyer could filter on

  const lat = num(raw.lat, { min: -90, max: 90 });
  const lng = num(raw.lng, { min: -180, max: 180 });
  const town = cap(raw.town, 120);
  const neighborhood = cap(raw.neighborhood, 120);
  const marketId = resolveMarket(markets || [], { town, neighborhood, lat, lng });
  if (!marketId) return null;

  const title = cap(raw.title, 200);
  const description = cap(raw.description, MAX_DESCRIPTION);
  const features = Array.isArray(raw.features) ? raw.features.map((f) => cap(f, 80)).filter(Boolean).slice(0, 60) : [];

  return {
    source_id: sourceId,
    url,
    url_key: urlKey,
    external_id: cap(raw.external_id, 80),
    title,
    description,
    operation: parseOperation(raw.operation) || parseOperation(title) || 'sale',
    property_type: parsePropertyType(raw.property_type) || parsePropertyType(title, description),
    price,
    currency,
    price_mxn: toMxn(price, currency, fx),
    bedrooms: num(raw.bedrooms, { min: 0, max: 50 }),
    bathrooms: num(raw.bathrooms, { min: 0, max: 50 }),
    parking: num(raw.parking, { min: 0, max: 50 }),
    built_m2: built,
    land_m2: land,
    town,
    neighborhood,
    market_id: marketId,
    lat,
    lng,
    photos: (Array.isArray(raw.photos) ? raw.photos : [])
      .map((p) => String(p || '').trim())
      .filter((p) => /^https?:\/\//i.test(p))
      .slice(0, MAX_PHOTOS),
    amenities: amenitiesFrom(title, description, features),
    listed_by: cap(raw.listed_by, 120),
    // Kept for the Finder operator only; never returned by the search API.
    contact: raw.contact && typeof raw.contact === 'object'
      ? { name: cap(raw.contact.name, 120), phone: cap(raw.contact.phone, 40), email: cap(raw.contact.email, 160) }
      : null
  };
}
