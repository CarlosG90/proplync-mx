/**
 * PropLync Mini · what a public page shows (shared by api/page.js and api/panel.js)
 * -----------------------------------------------------------------------------
 * WHY A SEPARATE FILE
 * page.js reads the p.html template when it loads, which only its own function
 * bundle carries (vercel.json includeFiles). The panel's preview needs the same
 * model, so the model lives here and both functions import it.
 * -----------------------------------------------------------------------------
 */

import { pageActive, MINI_PRICE_MXN } from './_proplync/_lib/plans.js';

export const AGENCY_FIELDS = 'id, name, slug, logo_url, cover_url, primary_color, whatsapp_number, phone, ' +
  'public_email, address, maps_url, services, bio, plan, plan_expires_at';
export const LISTING_FIELDS = 'public_id, title_es, title_en, town, neighborhood, bedrooms, bathrooms, size, ' +
  'parking, operation, currency, amount, image, images, features, description_es, description_en, property_type';

/** What the page shows, from the rows. Internal columns never reach the browser. Pure, for tests. */
export function buildModel(agency, listings, now = Date.now(), { preview = false } = {}) {
  if (!agency) return { state: 'not_found' };
  const active = pageActive(agency, now);
  const card = {
    name: agency.name || '', slug: agency.slug,
    logo_url: agency.logo_url || null, cover_url: agency.cover_url || null, primary_color: agency.primary_color || null
  };
  if (!active && !preview) return { state: 'paused', agency: card, listings: [] };
  return {
    state: active ? 'active' : 'preview',
    agency: {
      ...card,
      whatsapp_number: agency.whatsapp_number || null, phone: agency.phone || null,
      public_email: agency.public_email || null, address: agency.address || null, maps_url: agency.maps_url || null,
      services: Array.isArray(agency.services) ? agency.services : [], bio: agency.bio || ''
    },
    listings: (listings || []).map((l) => ({ ...l })),
    ...(active ? {} : { publish: { price: MINI_PRICE_MXN } })
  };
}

