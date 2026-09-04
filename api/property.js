/**
 * Proplync.mx · Single Property API
 * -----------------------------------------------------------------------------
 * Fetches a single property by ID. Checks a Supabase agency listing first
 * (cheap indexed lookup by public_id, Phase 1 multi-tenant SaaS pivot), then
 * Redis cache, then EasyBroker, then falls back to sample data.
 * -----------------------------------------------------------------------------
 */

import { getServiceClient } from './_lib/supabase.js';
import { redisGet, redisSet } from './_lib/redis.js';

const EB_URL = 'https://api.easybroker.com/v1';

const SAMPLES = [
  {public_id:'EB-T2451',title_es:'Departamento en preventa',title_en:'Pre-sale apartment',town:'Tulum',neighborhood:'Aldea Zamá',bedrooms:2,bathrooms:2,parking:1,size:78,operation:'sale',currency:'USD',amount:245000,formatted:'245,000',image:'https://images.pexels.com/photos/35877931/pexels-photo-35877931.jpeg?auto=compress&cs=tinysrgb&w=800',description_es:'Departamento moderno en preventa en la exclusiva zona de Aldea Zamá, Tulum. Acabados de primera calidad, amenidades completas y ubicación inmejorable.',description_en:'Modern pre-sale apartment in the exclusive Aldea Zamá area of Tulum. Premium finishes, full amenities, and unbeatable location.',lat:20.2114,lng:-87.4654,images:[]},
  {public_id:'EB-P8830',title_es:'Casa con alberca en Playacar',title_en:'House with pool in Playacar',town:'Playa del Carmen',neighborhood:'Playacar Fase II',bedrooms:3,bathrooms:4,parking:2,size:240,operation:'sale',currency:'USD',amount:685000,formatted:'685,000',image:'https://images.pexels.com/photos/8134849/pexels-photo-8134849.jpeg?auto=compress&cs=tinysrgb&w=800',description_es:'Espectacular casa con alberca privada en la residencial Playacar Fase II.',description_en:'Spectacular house with private pool in Playacar Phase II residential.',lat:20.6116,lng:-87.0739,images:[]},
  {public_id:'EB-M1207',title_es:'Studio frente al mar',title_en:'Beachfront studio',town:'Puerto Morelos',neighborhood:'Zona Hotelera',bedrooms:1,bathrooms:1,parking:1,size:45,operation:'sale',currency:'USD',amount:189000,formatted:'189,000',image:'https://images.pexels.com/photos/6312076/pexels-photo-6312076.jpeg?auto=compress&cs=tinysrgb&w=800',description_es:'Studio con vista directa al mar Caribe en Puerto Morelos.',description_en:'Studio with direct Caribbean Sea views in Puerto Morelos.',lat:20.8460,lng:-86.8756,images:[]},
  {public_id:'EB-C4062',title_es:'Penthouse vista al Caribe',title_en:'Penthouse with Caribbean view',town:'Cancún',neighborhood:'Puerto Cancún',bedrooms:3,bathrooms:3,parking:2,size:180,operation:'sale',currency:'USD',amount:1150000,formatted:'1,150,000',image:'https://images.pexels.com/photos/6775268/pexels-photo-6775268.jpeg?auto=compress&cs=tinysrgb&w=800',description_es:'Penthouse de lujo con vista panorámica al Caribe en Puerto Cancún.',description_en:'Luxury penthouse with panoramic Caribbean views in Puerto Cancún.',lat:21.1394,lng:-86.7649,images:[]},
  {public_id:'EB-P5519',title_es:'Departamento amueblado',title_en:'Furnished apartment',town:'Playa del Carmen',neighborhood:'Centro',bedrooms:2,bathrooms:2,parking:1,size:90,operation:'rental',currency:'USD',amount:2200,formatted:'2,200',image:'https://images.pexels.com/photos/6969824/pexels-photo-6969824.jpeg?auto=compress&cs=tinysrgb&w=800',description_es:'Departamento completamente amueblado en el centro de Playa del Carmen.',description_en:'Fully furnished apartment in downtown Playa del Carmen.',lat:20.6296,lng:-87.0739,images:[]},
  {public_id:'EB-T3388',title_es:'Villa en la selva',title_en:'Villa in the jungle',town:'Tulum',neighborhood:'Región 15',bedrooms:4,bathrooms:4,parking:3,size:320,operation:'sale',currency:'USD',amount:890000,formatted:'890,000',image:'https://images.pexels.com/photos/4940760/pexels-photo-4940760.jpeg?auto=compress&cs=tinysrgb&w=800',description_es:'Impresionante villa rodeada de selva en la exclusiva Región 15 de Tulum.',description_en:'Stunning villa surrounded by jungle in exclusive Región 15, Tulum.',lat:20.1950,lng:-87.4550,images:[]},
  {public_id:'EB-P9214',title_es:'Penthouse con vista al mar en Coco Beach',title_en:'Oceanview penthouse in Coco Beach',town:'Playa del Carmen',neighborhood:'Coco Beach',bedrooms:2,bathrooms:2,parking:1,size:204,operation:'sale',currency:'USD',amount:839000,formatted:'839,000',image:'https://images.pexels.com/photos/36362/pexels-photo.jpg?auto=compress&cs=tinysrgb&w=800',description_es:'Penthouse de 2 recámaras en Coco Beach, Playa del Carmen, con terraza privada en la azotea y vista al mar Caribe.',description_en:'2-bedroom penthouse in Coco Beach, Playa del Carmen, with a private rooftop terrace and Caribbean Sea views.',lat:20.6455,lng:-87.0625,images:[]},
  {public_id:'EB-T6720',title_es:'Estudio frente al mar en Tankah Bay',title_en:'Beachfront studio in Tankah Bay',town:'Tulum',neighborhood:'Tankah Bay',bedrooms:1,bathrooms:1,parking:1,size:51,operation:'sale',currency:'USD',amount:672190,formatted:'672,190',image:'https://images.pexels.com/photos/31688473/pexels-photo-31688473.jpeg?auto=compress&cs=tinysrgb&w=800',description_es:'Estudio frente al mar en Tankah Bay, Tulum, con vistas directas al Caribe.',description_en:'Beachfront studio in Tankah Bay, Tulum, with direct Caribbean views.',lat:20.2970,lng:-87.4280,images:[]}
];

function mapEBProperty(p) {
  const loc = p.location || {};
  const ops = p.operations || [];
  const op = ops[0] || {};
  const fmt = op.formatted_amount || String(op.amount || 0);
  const parts = (loc.name || '').split(',').map(s => s.trim());
  const images = (p.property_images || []).map(img => img.url);
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
    images,
    description_es: p.description || '',
    description_en: p.description || '',
    lat: loc.latitude || null,
    lng: loc.longitude || null,
    features: (p.features || []),
    updated_at: p.updated_at || null
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=600');

  const { id } = req.query;
  if (!id) {
    res.status(400).json({ error: 'missing_property_id' });
    return;
  }

  try {
    // 1. Try a Supabase agency listing first (cheap indexed lookup)
    try {
      const svc = getServiceClient();
      const { data: row } = await svc.from('listings').select('*').eq('public_id', id).maybeSingle();
      if (row) {
        // Join the owning agency so the mini-site can show its brand and a
        // WhatsApp click-to-chat CTA instead of generic Proplync branding.
        const { data: agencyRow } = await svc
          .from('agencies')
          .select('name, logo_url, primary_color, whatsapp_number')
          .eq('id', row.agency_id)
          .maybeSingle();
        res.status(200).json({
          property: {
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
            formatted: Number(row.amount || 0).toLocaleString('en-US'),
            image: row.image,
            images: row.images,
            description_es: row.description_es,
            description_en: row.description_en,
            lat: row.lat,
            lng: row.lng,
            features: row.features,
            source: 'agency',
            agency: agencyRow || null
          }
        });
        return;
      }
    } catch { /* fall through to the existing EB/sample chain */ }

    // 2. Redis cache
    const cacheKey = `eb:property:${id}`;
    const cached = await redisGet(cacheKey);
    if (cached) {
      res.status(200).json({ property: cached });
      return;
    }

    // 3. Try EasyBroker direct fetch
    const ebKey = process.env.EASYBROKER_API_KEY;
    if (ebKey) {
      const r = await fetch(`${EB_URL}/properties/${id}`, {
        headers: { accept: 'application/json', 'Country-Code': 'MX', 'X-Authorization': ebKey }
      });
      if (r.ok) {
        const data = await r.json();
        const property = mapEBProperty(data);
        await redisSet(cacheKey, property, 600);
        res.status(200).json({ property });
        return;
      }
    }

    // 4. Fall back to sample
    const sample = SAMPLES.find(p => p.public_id === id);
    if (sample) {
      res.status(200).json({ property: sample });
      return;
    }

    res.status(404).json({ error: 'property_not_found' });
  } catch (err) {
    res.status(502).json({ error: 'property_unavailable', detail: String(err.message) });
  }
}
