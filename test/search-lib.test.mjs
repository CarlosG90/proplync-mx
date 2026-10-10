// Search v2 building blocks: how listings are read (normalize, amenities) and
// how buyers are understood (query). These are the rules that decide what a
// search finds, so they are pinned here. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { amenitiesFrom } from '../api/_lib/search/amenities.js';
import { normalizeListing, parsePrice, parseCurrency, num, resolveMarket } from '../api/_lib/search/normalize.js';
import { parseDeterministic, toRankParams, guessCurrency } from '../api/_lib/search/query.js';
import { shapeCard } from '../api/_lib/search/api.js';
import { mergeFacts } from '../api/_lib/search/index-writer.js';

const markets = [
  { id: 'riviera-maya', towns: ['Tulum', 'Cancún', 'Playa del Carmen'], min_lng: -88.3, min_lat: 18, max_lng: -86.7, max_lat: 21.7 },
  { id: 'yucatan', towns: ['Mérida'], min_lng: -90.5, min_lat: 19.5, max_lng: -87.5, max_lat: 21.7 }
];
const towns = ['Tulum', 'Playa del Carmen', 'Cancún', 'Mérida', 'Aldea Zamá', 'Holbox', 'Bacalar'];

test('prices: every way a portal or a buyer writes one', () => {
  for (const [input, want] of [['$4,200,000', 4200000], ['US$ 245,000.00', 245000], ['4.2 mdp', 4200000], ['450k', 450000],
    ['1.5 millones', 1500000], ['4.200.000', 4200000], [3900000, 3900000], ['Consultar', null]]) {
    assert.equal(parsePrice(input), want, String(input));
  }
  assert.equal(parseCurrency('USD'), 'USD');
  assert.equal(parseCurrency('MN'), 'MXN');
  assert.equal(parseCurrency(null), null);
});

test('numbers keep their decimals: 2.5 bathrooms is not 25', () => {
  assert.equal(num('2.5 baños'), 2.5);
  assert.equal(num('2,5'), 2.5);
  assert.equal(num('95 m²'), 95);
  assert.equal(num(''), null);
});

test('amenities: one tag per meaning, no false friends', () => {
  assert.deepEqual(amenitiesFrom('Casa con alberca privada y vista al mar, pet friendly'), ['ocean_view', 'pet_friendly', 'pool', 'private_pool']);
  assert.deepEqual(amenitiesFrom('Departamento con roof garden y alberca'), ['pool', 'roof_garden'], 'roof garden is not a garden');
  assert.deepEqual(amenitiesFrom('Casa con jardín y roof garden'), ['garden', 'roof_garden']);
  assert.ok(!amenitiesFrom('alberca privada').includes('gated'), '"privada" in "alberca privada" is not a gated community');
  assert.ok(amenitiesFrom('en privada con seguridad').includes('gated'));
  assert.deepEqual(amenitiesFrom('gymnastics school nearby'), []);
  assert.ok(amenitiesFrom('frente al mar').includes('beach_access'), 'beachfront implies beach access');
});

test('normalize: canonical listing, unsafe bits dropped, outside markets skipped', () => {
  const n = normalizeListing({
    url: 'https://www.inmuebles24.com/propiedades/x-123.html?utm_source=a', title: 'Depto en venta Aldea Zamá',
    price: 'US$ 245,000', bedrooms: '2', bathrooms: '2.5 baños', built_m2: '95 m²', town: 'Tulum',
    description: 'Alberca y roof garden', photos: ['https://img/a.jpg', 'javascript:x']
  }, { sourceId: 'inmuebles24', fx: 18, markets });
  assert.equal(n.currency, 'USD');
  assert.equal(n.price_mxn, 4410000);
  assert.equal(n.bathrooms, 2.5);
  assert.equal(n.market_id, 'riviera-maya');
  assert.equal(n.property_type, 'departamento');
  assert.deepEqual(n.photos, ['https://img/a.jpg']);
  assert.equal(n.url_key, 'https://inmuebles24.com/propiedades/x-123.html');
  assert.equal(normalizeListing({ url: 'https://x.mx/1', price: 1e6, town: 'Puebla' }, { sourceId: 's', fx: 18, markets }), null);
  assert.equal(normalizeListing({ url: 'notaurl', price: 1e6, town: 'Tulum' }, { sourceId: 's', fx: 18, markets }), null);
  assert.equal(resolveMarket(markets, { town: null, lat: 20.97, lng: -89.62 }), 'yucatan', 'coordinates resolve when the town does not');
});

test('query: the search box example is fully understood without the LLM', () => {
  const r = parseDeterministic('depa de 2 recamaras cerca de la playa bajo 400k', { towns });
  assert.equal(r.hard.beds_min, 2);
  assert.equal(r.hard.price_max, 400000);
  assert.equal(r.hard.currency, 'USD');
  assert.equal(r.hard.currency_assumed, true, 'a guessed currency is flagged, never silent');
  assert.equal(r.hard.property_type, 'departamento');
  assert.equal(r.prefs.near, 'beach');
  assert.equal(r.residual, '', 'nothing left over, so no LLM call');
});

test('query: prices, currencies, operations and places', () => {
  const p = (q) => parseDeterministic(q, { towns }).hard;
  assert.equal(p('casa con alberca en Tulum hasta 6 millones de pesos').price_max, 6000000);
  assert.equal(p('casa con alberca en Tulum hasta 6 millones de pesos').currency_assumed, false);
  assert.deepEqual([p('terreno en merida entre 1 y 2 mdp').price_min, p('terreno en merida entre 1 y 2 mdp').price_max], [1000000, 2000000]);
  assert.equal(p('casa en tulum 4.5 mdp maximo').price_max, 4500000);
  assert.equal(p('depa 450k usd tulum').currency, 'USD');
  assert.equal(p('renta amueblado en cancun menos de 25000 al mes').operation, 'rental');
  assert.deepEqual(p('3 bedroom house in Playa del Carmen').towns, ['Playa del Carmen']);
  assert.deepEqual(p('casa en merida').towns, ['Mérida'], 'accent-blind');
  assert.equal(p('casa 3 recamaras merida').price_max, undefined, 'a bedroom count is not a price');
  assert.equal(p('2 recamaras 95 m2 cancun').size_min, 95);
  assert.equal(guessCurrency(25000, 'rental'), 'MXN');
  assert.equal(guessCurrency(3000, 'rental'), 'USD');
});

test('query: leftover descriptive words are what goes to the LLM', () => {
  assert.equal(parseDeterministic('algo tranquilo para trabajar remoto en bacalar', { towns }).residual, 'algo tranquilo trabajar remoto');
});

test('rank params: USD budgets become MXN once; overrides win; empty means removed', () => {
  const parsed = parseDeterministic('depa de 2 recamaras en tulum bajo 400k', { towns });
  const p = toRankParams(parsed, { fx: 18 });
  assert.equal(p.price_max_mxn, 7200000);
  assert.deepEqual(p.towns, ['Tulum']);
  const q = toRankParams(parsed, { fx: 18, overrides: { hard: { towns: [], beds_min: null, currency: 'MXN' } } });
  assert.equal(q.towns, undefined, 'a removed town chip searches everywhere');
  assert.equal(q.beds_min, undefined);
  assert.equal(q.price_max_mxn, 400000, 'flipping the currency chip to MXN');
});

test('cards: a source display mode decides what a crawled card may show', () => {
  const base = { id: 'x', origin: 'web', photos: ['https://a/1.jpg', 'https://a/2.jpg'], description: 'd', amenities: ['pool'],
    offers: [{ source: 'inmuebles24', source_name: 'Inmuebles24', price: 1, currency: 'MXN', url: 'https://i24/x' }], reasons: { amenities_met: ['pool'] } };
  const full = shapeCard({ ...base, best_mode: 1 }, 'es');
  assert.equal(full.photos.length, 2); assert.equal(full.description, 'd');
  const link = shapeCard({ ...base, best_mode: 2 }, 'es');
  assert.equal(link.photos.length, 1); assert.equal(link.description, undefined); assert.equal(link.offers[0].url, 'https://i24/x');
  const facts = shapeCard({ ...base, best_mode: 3 }, 'es');
  assert.equal(facts.photos.length, 0); assert.equal(facts.offers[0].url, null);
  assert.equal(full.reasons.amenities_met[0].label, 'Alberca');
  assert.equal(shapeCard({ ...base, origin: 'proplync', best_mode: 3 }, 'en').display_mode, 'full', 'our own listings always show in full');
  assert.equal(JSON.stringify(full).includes('contact'), false, 'the agent contact never reaches a card');
});

test('index facts only fill blanks: a crawled ad never overwrites what an agency entered', () => {
  const patch = mergeFacts({ title: 'Ours', bedrooms: 2, description: null, photos: ['a'], amenities: ['pool'] },
                           { title: 'Theirs', bedrooms: 3, built_m2: 90, description: 'portal text', photos: ['a', 'b'], amenities: ['gym'] });
  assert.equal(patch.title, undefined);
  assert.equal(patch.bedrooms, undefined);
  assert.equal(patch.built_m2, 90);
  assert.equal(patch.description, 'portal text');
  assert.deepEqual(patch.photos, ['a', 'b']);
  assert.deepEqual(patch.amenities, ['gym', 'pool']);
  assert.equal(patch.embedding, null, 'changed text drops the stale vector');
});
