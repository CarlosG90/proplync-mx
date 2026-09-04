/**
 * Proplync.mx · Property Search API
 * -----------------------------------------------------------------------------
 * Searches the cached EasyBroker inventory with server-side filters.
 * Falls back to the sample properties when no API key is configured.
 * Uses Upstash Redis for caching (5 min TTL).
 *
 * Also merges in published listings created by agencies through /dashboard
 * (Supabase-backed, Phase 1 multi-tenant SaaS pivot). Agency rows are mapped
 * to this exact same object shape and tagged source:'agency' — the existing
 * filter logic below runs over the merged array unmodified.
 * -----------------------------------------------------------------------------
 */

import { getServiceClient } from './_lib/supabase.js';
import { redisGet, redisSet } from './_lib/redis.js';

const EB_URL = 'https://api.easybroker.com/v1';
const PAGE_LIMIT = 50;
const MAX_PAGES = 40;
const PAGE_DELAY_MS = 120;

/* ---------- sample data (same as index.html) ---------- */
const SAMPLES = [
  {public_id:'EB-T2451',title_es:'Departamento en preventa',title_en:'Pre-sale apartment',town:'Tulum',neighborhood:'Aldea Zamá',bedrooms:2,bathrooms:2,parking:1,size:78,operation:'sale',currency:'USD',amount:245000,formatted:'245,000',image:'https://images.pexels.com/photos/35877931/pexels-photo-35877931.jpeg?auto=compress&cs=tinysrgb&w=800',lat:20.2114,lng:-87.4654},
  {public_id:'EB-P8830',title_es:'Casa con alberca en Playacar',title_en:'House with pool in Playacar',town:'Playa del Carmen',neighborhood:'Playacar Fase II',bedrooms:3,bathrooms:4,parking:2,size:240,operation:'sale',currency:'USD',amount:685000,formatted:'685,000',image:'https://images.pexels.com/photos/8134849/pexels-photo-8134849.jpeg?auto=compress&cs=tinysrgb&w=800',lat:20.6116,lng:-87.0739},
  {public_id:'EB-M1207',title_es:'Studio frente al mar',title_en:'Beachfront studio',town:'Puerto Morelos',neighborhood:'Zona Hotelera',bedrooms:1,bathrooms:1,parking:1,size:45,operation:'sale',currency:'USD',amount:189000,formatted:'189,000',image:'https://images.pexels.com/photos/6312076/pexels-photo-6312076.jpeg?auto=compress&cs=tinysrgb&w=800',lat:20.8460,lng:-86.8756},
  {public_id:'EB-C4062',title_es:'Penthouse vista al Caribe',title_en:'Penthouse with Caribbean view',town:'Cancún',neighborhood:'Puerto Cancún',bedrooms:3,bathrooms:3,parking:2,size:180,operation:'sale',currency:'USD',amount:1150000,formatted:'1,150,000',image:'https://images.pexels.com/photos/6775268/pexels-photo-6775268.jpeg?auto=compress&cs=tinysrgb&w=800',lat:21.1394,lng:-86.7649},
  {public_id:'EB-P5519',title_es:'Departamento amueblado',title_en:'Furnished apartment',town:'Playa del Carmen',neighborhood:'Centro',bedrooms:2,bathrooms:2,parking:1,size:90,operation:'rental',currency:'USD',amount:2200,formatted:'2,200',image:'https://images.pexels.com/photos/6969824/pexels-photo-6969824.jpeg?auto=compress&cs=tinysrgb&w=800',lat:20.6296,lng:-87.0739},
  {public_id:'EB-T3388',title_es:'Villa en la selva',title_en:'Villa in the jungle',town:'Tulum',neighborhood:'Región 15',bedrooms:4,bathrooms:4,parking:3,size:320,operation:'sale',currency:'USD',amount:890000,formatted:'890,000',image:'https://images.pexels.com/photos/4940760/pexels-photo-4940760.jpeg?auto=compress&cs=tinysrgb&w=800',lat:20.1950,lng:-87.4550},
  {public_id:'EB-P9214',title_es:'Penthouse con vista al mar en Coco Beach',title_en:'Oceanview penthouse in Coco Beach',town:'Playa del Carmen',neighborhood:'Coco Beach',bedrooms:2,bathrooms:2,parking:1,size:204,operation:'sale',currency:'USD',amount:839000,formatted:'839,000',image:'https://images.pexels.com/photos/36362/pexels-photo.jpg?auto=compress&cs=tinysrgb&w=800',lat:20.6455,lng:-87.0625},
  {public_id:'EB-T6720',title_es:'Estudio frente al mar en Tankah Bay',title_en:'Beachfront studio in Tankah Bay',town:'Tulum',neighborhood:'Tankah Bay',bedrooms:1,bathrooms:1,parking:1,size:51,operation:'sale',currency:'USD',amount:672190,formatted:'672,190',image:'https://images.pexels.com/photos/31688473/pexels-photo-31688473.jpeg?auto=compress&cs=tinysrgb&w=800',lat:20.2970,lng:-87.4280}
];

function mapProperty(p) {
  const loc = (p.location || {});
  const ops = p.operations || [];
  const op = ops[0] || {};
  const fmt = op.formatted_amount || String(op.amount || 0);
  const parts = (loc.name || '').split(',').map(s => s.trim());
  return {
    public_id: p.public_id,
    title_es: p.title || '',
    title_en: p.title || '',
    town: parts[1] || parts[0] || '',
    neighborhood: parts[0] || '',
    bedrooms: p.bedrooms || 0,
    bathrooms: p.bathrooms || 0,
    parking: p.parking_spaces || 0,
    size: p.lot_size || p.construction_size || 0,
    operation: op.type === 'rental' ? 'rental' : 'sale',
    currency: op.currency || 'MXN',
    amount: op.amount || 0,
    formatted: fmt.replace(/[^0-9,.]/g, ''),
    image: (p.title_image_full || p.title_image_thumb || ''),
    lat: loc.latitude || null,
    lng: loc.longitude || null
  };
}

async function fetchAllFromEB(key) {
  const all = [];
  let page = 1;
  while (page <= MAX_PAGES) {
    const url = `${EB_URL}/properties?page=${page}&limit=${PAGE_LIMIT}&search[statuses][]=published`;
    const r = await fetch(url, {
      headers: { accept: 'application/json', 'Country-Code': 'MX', 'X-Authorization': key }
    });
    if (!r.ok) throw new Error(`EB responded ${r.status}`);
    const data = await r.json();
    const batch = (data.content || []).map(mapProperty);
    all.push(...batch);
    if (batch.length < PAGE_LIMIT || !data.pagination?.next_page) break;
    page++;
    if (page <= MAX_PAGES) await new Promise(ok => setTimeout(ok, PAGE_DELAY_MS));
  }
  return all;
}

function formatAmount(amount) {
  return Number(amount || 0).toLocaleString('en-US');
}

async function fetchAgencyListings() {
  try {
    const svc = getServiceClient();
    const { data, error } = await svc.from('listings').select('*').eq('status', 'published');
    if (error || !data) return [];
    return data.map(row => ({
      public_id: row.public_id,
      title_es: row.title_es,
      title_en: row.title_en,
      town: row.town,
      neighborhood: row.neighborhood,
      bedrooms: row.bedrooms,
      bathrooms: row.bathrooms,
      parking: row.parking,
      size: row.size,
      operation: row.operation,
      currency: row.currency,
      amount: row.amount,
      formatted: formatAmount(row.amount),
      image: row.image,
      images: row.images,
      description_es: row.description_es,
      description_en: row.description_en,
      lat: row.lat,
      lng: row.lng,
      features: row.features,
      source: 'agency'
    }));
  } catch {
    return [];
  }
}

async function getInventory() {
  const agencyListings = await fetchAgencyListings();

  // 1. Try Redis cache
  const cached = await redisGet('eb:listings:all');
  if (cached && cached.length) return [...agencyListings, ...cached];

  // 2. Try EasyBroker
  const ebKey = process.env.EASYBROKER_API_KEY;
  if (ebKey) {
    const live = await fetchAllFromEB(ebKey);
    if (live.length) {
      await redisSet('eb:listings:all', live, 300);
      return [...agencyListings, ...live];
    }
  }

  // 3. Fall back to samples
  return [...agencyListings, ...SAMPLES];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60');

  try {
    let listings = await getInventory();

    // filters
    const { op, town, minPrice, maxPrice, beds, minSize, maxSize, q } = req.query;

    if (op && op !== 'all') {
      listings = listings.filter(p => p.operation === op);
    }
    if (town) {
      const t = town.toLowerCase();
      listings = listings.filter(p => p.town.toLowerCase().includes(t));
    }
    if (minPrice) {
      const min = parseFloat(minPrice);
      if (Number.isFinite(min)) listings = listings.filter(p => p.amount >= min);
    }
    if (maxPrice) {
      const max = parseFloat(maxPrice);
      if (Number.isFinite(max)) listings = listings.filter(p => p.amount <= max);
    }
    if (beds) {
      const b = parseInt(beds);
      if (b > 0) listings = listings.filter(p => p.bedrooms >= b);
    }
    if (minSize) {
      const ms = parseFloat(minSize);
      if (Number.isFinite(ms)) listings = listings.filter(p => p.size >= ms);
    }
    if (maxSize) {
      const ms = parseFloat(maxSize);
      if (Number.isFinite(ms)) listings = listings.filter(p => p.size <= ms);
    }
    if (q) {
      const term = q.toLowerCase();
      listings = listings.filter(p =>
        (p.title_es + ' ' + p.title_en + ' ' + p.town + ' ' + p.neighborhood).toLowerCase().includes(term)
      );
    }

    // extract unique towns for filter dropdown
    const allListings = await getInventory();
    const towns = [...new Set(allListings.map(p => p.town).filter(Boolean))].sort();

    res.status(200).json({ listings, towns, total: listings.length });
  } catch (err) {
    res.status(502).json({ error: 'search_unavailable', detail: String(err.message) });
  }
}
