/**
 * Proplync.mx · Listing and agency field rules (shared)
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * Every field an agency saves is rendered later on buyer-facing pages, so one
 * set of rules decides what may be stored. The dashboard (api/my-listings.js),
 * the /mini signup (api/onboard.js) and the separate PropLync Mini project
 * (mini/api) all validate through here.
 *
 * WHY NOT LEAVE IT IN my-listings.js
 * Importing my-listings.js pulled in the search index writer, stock photos and
 * Redis just to validate a title. This file has no imports, so any function,
 * in either Vercel project, can use it cheaply.
 * -----------------------------------------------------------------------------
 */

// phone..bio are the agent's card on /agencia/:slug (migration 018): call,
// email, location, services and a line about them. business_type (migration 019)
// picks the Mini page's template.
export const AGENCY_WRITABLE_FIELDS = ['name', 'logo_url', 'cover_url', 'primary_color', 'whatsapp_number',
  'phone', 'public_email', 'address', 'maps_url', 'services', 'bio', 'business_type',
  'profession', 'instagram', 'facebook', 'tiktok', 'website'];
export const AGENCY_SELECT = 'id, name, slug, logo_url, cover_url, primary_color, whatsapp_number, ' +
  'phone, public_email, address, maps_url, services, bio, business_type, profession, instagram, facebook, tiktok, website, ' +
  'plan, plan_expires_at';

// The same closed list as the agencies_business_type_check constraint (019) and
// the templates in mini/js/business-types.js. Written out because this file has
// no imports; test/mini-services.test.mjs fails if the three disagree.
export const BUSINESS_TYPE_KEYS = ['real_estate', 'professional', 'trades', 'beauty', 'general'];

export function pickAgencyWritable(body) {
  const out = {};
  for (const key of AGENCY_WRITABLE_FIELDS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

/* ── Field validation ──
   Everything an agency saves here is rendered later on buyer-facing pages:
   /search, /propiedad/:id, /agencia/:slug, the home page. The pages escape what
   they print (js/escape.js), and this is the other half: only well-typed
   values, and only URLs a page can safely load, get stored at all. Text is not
   stripped of characters; "Casa & Mar <vista>" is a fine title once escaped.
   Each check throws a BadField whose message is the 400 error code. */
export class BadField extends Error {}

const IMAGE_URL = /^(https?:\/\/|data:image\/(png|jpe?g|webp|gif|avif);base64,)/i;
const TEXT_LIMITS = {
  title_es: 300, title_en: 300, town: 120, neighborhood: 120,
  description_es: 10000, description_en: 10000, property_type: 60,
  name: 120, address: 200, bio: 600, profession: 80
};
const NUMERIC = ['bedrooms', 'bathrooms', 'parking', 'size', 'amount', 'lat', 'lng'];

function checkText(key, value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') throw new BadField('invalid_' + key);
  if (value.length > TEXT_LIMITS[key]) throw new BadField(key + '_too_long');
  return value;
}

function checkImageUrl(key, value) {
  if (value === null || value === undefined || value === '') return value;
  if (typeof value !== 'string' || !IMAGE_URL.test(value.trim())) throw new BadField('invalid_' + key);
  return value.trim();
}

/** The /mini signup and the Mini project save listings under exactly these rules. */
export function validateListingFields(fields) {
  const out = { ...fields };
  for (const key of Object.keys(TEXT_LIMITS)) {
    if (key in out) out[key] = checkText(key, out[key]);
  }
  for (const key of NUMERIC) {
    const v = out[key];
    // '' and null are left for the column default/constraint to decide, as before.
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'number' ? !Number.isFinite(v) : !(typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))) {
      throw new BadField('invalid_' + key);
    }
  }
  if ('currency' in out && out.currency != null) {
    if (typeof out.currency !== 'string' || !/^[A-Za-z]{3}$/.test(out.currency.trim())) throw new BadField('invalid_currency');
    out.currency = out.currency.trim().toUpperCase();
  }
  if ('image' in out) out.image = checkImageUrl('image', out.image);
  if ('images' in out && out.images != null) {
    if (!Array.isArray(out.images)) throw new BadField('invalid_images');
    out.images = out.images.map((u) => checkImageUrl('images', u)).filter(Boolean);
  }
  if ('features' in out && out.features != null) {
    if (!Array.isArray(out.features) || out.features.length > 60) throw new BadField('invalid_features');
    out.features = out.features.map((f) => {
      if (typeof f !== 'string' || f.length > 120) throw new BadField('invalid_features');
      return f.trim();
    }).filter(Boolean);
  }
  return out;
}

const PHONE = /^[0-9+()\-\s]{6,25}$/;
// Quotes and angle brackets are kept out so a mailto: built from this is one plain address.
const EMAIL = /^[^\s"'<>@]+@[^\s"'<>@]+\.[^\s"'<>@]+$/;

/** Exported for test/plans.test.mjs: the card fields are the newest buyer-visible text. */
export function validateAgencyFields(fields) {
  const out = { ...fields };
  if ('name' in out) out.name = checkText('name', out.name);
  if ('logo_url' in out) out.logo_url = checkImageUrl('logo_url', out.logo_url);
  if ('cover_url' in out) out.cover_url = checkImageUrl('cover_url', out.cover_url);
  if ('primary_color' in out && out.primary_color != null && out.primary_color !== '') {
    if (typeof out.primary_color !== 'string' || !/^#[0-9a-f]{3,8}$/i.test(out.primary_color.trim())) {
      throw new BadField('invalid_primary_color');
    }
    out.primary_color = out.primary_color.trim();
  }
  for (const key of ['whatsapp_number', 'phone']) {
    if (key in out && out[key] != null && out[key] !== '') {
      if (typeof out[key] !== 'string' || !PHONE.test(out[key])) throw new BadField('invalid_' + key);
    }
  }
  if ('public_email' in out && out.public_email != null && out.public_email !== '') {
    if (typeof out.public_email !== 'string' || out.public_email.length > 120 || !EMAIL.test(out.public_email.trim())) {
      throw new BadField('invalid_public_email');
    }
    out.public_email = out.public_email.trim().toLowerCase();
  }
  if ('address' in out) out.address = checkText('address', out.address);
  if ('profession' in out) out.profession = checkText('profession', out.profession);
  // Social profiles (migration 023): a handle or the network's own profile URL, so the page's link can only
  // ever open that network. Website: any http(s) page.
  for (const [key, host] of [['instagram', 'instagram.com'], ['facebook', 'facebook.com'], ['tiktok', 'tiktok.com']]) {
    if (key in out && out[key] != null && out[key] !== '') {
      const v = typeof out[key] === 'string' ? out[key].trim() : '';
      const handle = /^@?[A-Za-z0-9._-]{1,60}$/.test(v);
      const url = /^https:\/\/(www\.|m\.)?([a-z]+\.)?/.test(v) && v.length <= 200 && (() => {
        try { const u = new URL(v); return u.protocol === 'https:' && (u.hostname === host || u.hostname.endsWith('.' + host) || (key === 'facebook' && u.hostname === 'fb.me')); } catch { return false; }
      })();
      if (!handle && !url) throw new BadField('invalid_' + key);
      out[key] = v;
    } else if (key in out) out[key] = null;
  }
  if ('website' in out && out.website != null && out.website !== '') {
    if (typeof out.website !== 'string' || out.website.length > 300 || !/^https?:\/\/[^\s<>"']+\.[^\s<>"']+$/i.test(out.website.trim())) {
      throw new BadField('invalid_website');
    }
    out.website = out.website.trim();
  }
  if ('bio' in out) out.bio = checkText('bio', out.bio);
  // A page link only: http(s), so the "Ubicacion" button can never run script.
  if ('maps_url' in out && out.maps_url != null && out.maps_url !== '') {
    if (typeof out.maps_url !== 'string' || out.maps_url.length > 500 || !/^https?:\/\/\S+$/i.test(out.maps_url.trim())) {
      throw new BadField('invalid_maps_url');
    }
    out.maps_url = out.maps_url.trim();
  }
  if ('business_type' in out) {
    if (!BUSINESS_TYPE_KEYS.includes(out.business_type)) throw new BadField('invalid_business_type');
  }
  if ('services' in out && out.services != null) {
    if (!Array.isArray(out.services) || out.services.length > 8) throw new BadField('invalid_services');
    out.services = out.services.map((s) => {
      if (typeof s !== 'string' || s.length > 40) throw new BadField('invalid_services');
      return s.trim();
    }).filter(Boolean);
  }
  return out;
}

export const WRITABLE_FIELDS = [
  'title_es', 'title_en', 'town', 'neighborhood', 'bedrooms', 'bathrooms',
  'parking', 'size', 'operation', 'currency', 'amount', 'image', 'images',
  'description_es', 'description_en', 'lat', 'lng', 'features', 'status',
  'property_type'
];

/** Trim the gallery to what the plan allows, keeping the cover photo first. */
export function capPhotos(fields, plan) {
  if (!Array.isArray(fields.images)) return fields;
  if (fields.images.length <= plan.photos) return fields;
  const images = fields.images.slice(0, plan.photos);
  return { ...fields, images, image: fields.image || images[0] };
}

export function pickWritable(body) {
  const out = {};
  for (const key of WRITABLE_FIELDS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}
