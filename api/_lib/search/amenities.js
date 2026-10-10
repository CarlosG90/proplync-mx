/**
 * Proplync.mx · Amenity tags from listing text
 * -----------------------------------------------------------------------------
 * Buyers search for "con alberca", "pet friendly", "frente al mar". Listings
 * say the same things a hundred ways across portals and languages. This turns
 * any of them into one tag the index can filter and rank on (`pool`,
 * `pet_friendly`, `beachfront`), so "alberca", "piscina" and "pool" all find
 * the same houses.
 *
 * Deterministic on purpose: it runs over every crawled listing every day, and
 * a dictionary is free, instant, and testable. The query parser maps buyer
 * words through the same table, so a tag means the same thing on both sides.
 * (generate.html has its own amenity chip list for the agency form; the text
 * it produces, "Alberca, Vista al mar", is exactly what this reads.)
 * -----------------------------------------------------------------------------
 */

/* Each tag lists the phrases that mean it, already folded (lowercase, no
   accents), matched as whole words or phrases. */
export const AMENITIES = {
  pool:          ['alberca', 'piscina', 'pool', 'swimming pool', 'chapoteadero', 'infinity pool', 'alberca infinita'],
  private_pool:  ['alberca privada', 'piscina privada', 'private pool', 'plunge pool', 'alberca propia'],
  ocean_view:    ['vista al mar', 'vista mar', 'vista al caribe', 'ocean view', 'sea view', 'oceanview', 'vista panoramica al mar'],
  beachfront:    ['frente al mar', 'frente a la playa', 'beachfront', 'oceanfront', 'pie de playa', 'acceso directo a la playa', 'beach front'],
  beach_access:  ['acceso a la playa', 'beach access', 'beach club', 'club de playa'],
  furnished:     ['amueblado', 'amueblada', 'furnished', 'equipado y amueblado', 'totalmente amueblado'],
  pet_friendly:  ['pet friendly', 'se aceptan mascotas', 'acepta mascotas', 'mascotas permitidas', 'pets allowed'],
  roof_garden:   ['roof garden', 'rooftop', 'roof top', 'terraza en azotea', 'roofgarden', 'roof privado'],
  gym:           ['gimnasio', 'gym', 'fitness center'],
  security:      ['seguridad 24', 'vigilancia 24', 'security 24', 'seguridad privada', 'caseta de vigilancia', '24/7 security'],
  // Not bare "privada": it would fire on "alberca privada". In Mexico a gated
  // development is "una privada", so match the phrases it appears in.
  gated:         ['en privada', 'dentro de privada', 'privada residencial', 'residencial privado', 'fraccionamiento cerrado', 'coto', 'gated community', 'acceso controlado', 'condominio cerrado'],
  garden:        ['jardin', 'garden', 'patio'],
  terrace:       ['terraza', 'terrace', 'balcon', 'balcony'],
  parking:       ['estacionamiento', 'cochera', 'parking', 'cajon de estacionamiento', 'garage'],
  elevator:      ['elevador', 'ascensor', 'elevator'],
  air_conditioning: ['aire acondicionado', 'minisplit', 'mini split', 'air conditioning', 'a/c'],
  jungle_view:   ['vista a la selva', 'jungle view', 'en la selva', 'rodeado de selva'],
  cenote:        ['cenote'],
  coworking:     ['coworking', 'co-working', 'business center', 'area de trabajo'],
  new_build:     ['preventa', 'pre-venta', 'presale', 'pre-sale', 'a estrenar', 'nuevo desarrollo', 'new development'],
  golf:          ['campo de golf', 'golf course', 'golf'],
  marina:        ['marina', 'muelle', 'boat slip']
};

/* Bilingual labels for the chips the search page shows: [es, en]. */
export const AMENITY_LABELS = {
  pool: ['Alberca', 'Pool'], private_pool: ['Alberca privada', 'Private pool'],
  ocean_view: ['Vista al mar', 'Ocean view'], beachfront: ['Frente al mar', 'Beachfront'],
  beach_access: ['Acceso a playa', 'Beach access'], furnished: ['Amueblado', 'Furnished'],
  pet_friendly: ['Pet friendly', 'Pet friendly'], roof_garden: ['Roof garden', 'Roof garden'],
  gym: ['Gimnasio', 'Gym'], security: ['Seguridad 24h', '24h security'], gated: ['Privada', 'Gated'],
  garden: ['Jardín', 'Garden'], terrace: ['Terraza', 'Terrace'], parking: ['Estacionamiento', 'Parking'],
  elevator: ['Elevador', 'Elevator'], air_conditioning: ['Aire acondicionado', 'A/C'],
  jungle_view: ['Vista a la selva', 'Jungle view'], cenote: ['Cenote', 'Cenote'],
  coworking: ['Coworking', 'Coworking'], new_build: ['Preventa / nuevo', 'Pre-sale / new'],
  golf: ['Golf', 'Golf'], marina: ['Marina', 'Marina']
};

export function fold(value) {
  return String(value == null ? '' : value)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/* One regex per tag, built once. A phrase must stand alone: "gym" does not
   fire inside a longer word, and "a/c" or "pre-venta" still match whole. */
const MATCHERS = Object.entries(AMENITIES).map(([tag, phrases]) => [
  tag,
  new RegExp('(?:^|[^a-z0-9])(?:' + phrases.map(escapeRe).join('|') + ')(?=$|[^a-z0-9])')
]);

/**
 * Tags found in any of the given texts (title, description, feature lists).
 * @param {...(string|string[]|null|undefined)} texts
 * @returns {string[]} sorted, unique
 */
export function amenitiesFrom(...texts) {
  const hay = fold(texts.flat().filter(Boolean).join(' . '));
  if (!hay) return [];
  const found = new Set();
  for (const [tag, re] of MATCHERS) if (re.test(hay)) found.add(tag);
  // "roof garden" is not a garden: only count `garden` if it survives
  // removing the roof-garden phrases.
  if (found.has('garden') && found.has('roof_garden')) {
    const rest = hay.replace(/roof ?garden|roof top|rooftop/g, ' ');
    if (!MATCHERS.find(([t]) => t === 'garden')[1].test(rest)) found.delete('garden');
  }
  // A private pool is a pool; a beachfront home has beach access.
  if (found.has('private_pool')) found.add('pool');
  if (found.has('beachfront')) found.add('beach_access');
  return [...found].sort();
}
