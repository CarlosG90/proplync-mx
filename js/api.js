/* Proplync.mx · Shared API wrappers
   ─────────────────────────────────── */

const API = {
  listings: '/api/listings',
  photos: '/api/photos',
  geocode: '/api/geocode',
  amenities: '/api/amenities',
  describe: '/api/describe',
  search: '/api/search',
  property: '/api/property'
};

async function fetchListings() {
  const r = await fetch(API.listings, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const data = await r.json();
  return data.listings || data;
}

async function fetchPhotos(queries) {
  const q = Array.isArray(queries) ? queries.join(',') : queries;
  const r = await fetch(API.photos + '?q=' + encodeURIComponent(q), { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const data = await r.json();
  return data.photos || [];
}

async function fetchGeocode(query) {
  const r = await fetch(API.geocode + '?q=' + encodeURIComponent(query));
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function fetchAmenities(lat, lng) {
  const r = await fetch(API.amenities + '?lat=' + lat + '&lng=' + lng);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const data = await r.json();
  return data.places || [];
}

async function fetchDescription(payload) {
  const r = await fetch(API.describe, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const data = await r.json();
  return data.description;
}

async function fetchSearch(params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(API.search + '?' + qs, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function fetchProperty(id) {
  const r = await fetch(API.property + '?id=' + encodeURIComponent(id), { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
