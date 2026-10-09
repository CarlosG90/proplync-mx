// Scout's merge and validation rules: the code that keeps Finder's promises
// (one card per property, every price side by side, no relaxed must-haves,
// no invented links) whatever the model reports. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeCandidates, normalizeUrl, parseMoney, toMxn } from '../api/_lib/scout-merge.js';
import { validateSubmission, seenUrls } from '../api/_lib/scout.js';

const FX = 18;
const brief = { budget: { max: 300000, currency: 'USD' }, location: { areas: ['Tulum'] } };

function web(over = {}) {
  return {
    proplync_listing_id: null, title: 'Depto 2 rec Aldea Zama', operation: 'sale', property_type: 'departamento',
    town: 'Tulum', neighborhood: 'Aldea Zamá', bedrooms: 2, bathrooms: 2, built_m2: 90, land_m2: null,
    sources: [{ url: 'https://www.inmuebles24.com/propiedades/depto-123.html', site: 'Inmuebles24', listed_by: 'Agencia A', price: 245000, currency: 'USD' }],
    photos: [], must_haves: [{ item: 'alberca', status: 'met', evidence: 'alberca comun' }], deal_breakers: [],
    summary: 'Cerca de la ciclovia', questions_for_agent: ['Acepta mascotas?'], ...over
  };
}

test('normalizeUrl ignores scheme, www, trailing slash, fragment and tracking params', () => {
  assert.equal(
    normalizeUrl('http://www.Lamudi.com.mx/casa-1/?utm_source=x&id=7#fotos'),
    normalizeUrl('https://lamudi.com.mx/casa-1?id=7'));
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
});

test('parseMoney reads the ways a budget gets said', () => {
  assert.equal(parseMoney(450000), 450000);
  assert.equal(parseMoney('450k'), 450000);
  assert.equal(parseMoney('500 mil'), 500000);
  assert.equal(parseMoney('1.2 millones'), 1200000);
  assert.equal(parseMoney('$5,000,000 MXN'), 5000000);
  assert.equal(parseMoney('lo que sea'), null);
  assert.equal(toMxn(100, 'USD', FX), 1800);
  assert.equal(toMxn(100, 'EUR', FX), null, 'no rate configured: not comparable, not guessed');
});

test('the same unit on two portals becomes one card with both prices', () => {
  const a = web();
  const b = web({
    title: 'Departamento en Aldea Zama',
    built_m2: 91,
    sources: [{ url: 'https://www.lamudi.com.mx/depto-zama-99', site: 'Lamudi', listed_by: 'Agencia B', price: 4500000, currency: 'MXN' }]
  });
  const { cards } = mergeCandidates({ candidates: [a, b], inventory: [], brief, fx: FX });
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].sources.map((s) => s.site).sort(), ['Inmuebles24', 'Lamudi']);
  assert.equal(cards[0].lowest_price_mxn, 4410000);
});

test('neighbouring units in one building stay separate', () => {
  const a = web();
  const b = web({ built_m2: 120, sources: [{ url: 'https://lamudi.com.mx/otro', site: 'Lamudi', price: 310000, currency: 'USD' }] });
  const c = web({ bedrooms: 3, sources: [{ url: 'https://lamudi.com.mx/tercero', site: 'Lamudi', price: 246000, currency: 'USD' }] });
  const { cards } = mergeCandidates({ candidates: [a, b, c], inventory: [], brief: { budget: {} }, fx: FX });
  assert.equal(cards.length, 3);
});

test('a shared URL merges even when the facts disagree', () => {
  const a = web();
  const b = web({ bedrooms: null, built_m2: null, summary: null });
  const { cards } = mergeCandidates({ candidates: [a, b], inventory: [], brief, fx: FX });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].bedrooms, 2, 'the known fact survives the merge');
});

test('hard limits are enforced in code: budget, must-haves, deal-breakers', () => {
  const over = web({ sources: [{ url: 'https://x.mx/1', site: 'X', price: 400000, currency: 'USD' }] });
  // Different sizes on purpose: same-size units this close in price would
  // rightly be merged as one property.
  const missing = web({ built_m2: 60, sources: [{ url: 'https://x.mx/2', site: 'X', price: 200000, currency: 'USD' }],
    must_haves: [{ item: 'alberca', status: 'no', evidence: 'sin alberca' }] });
  const breaker = web({ built_m2: 150, sources: [{ url: 'https://x.mx/3', site: 'X', price: 210000, currency: 'USD' }],
    deal_breakers: [{ item: 'planta baja', status: 'present', evidence: 'ubicado en planta baja' }] });
  const unknownPrice = web({ sources: [{ url: 'https://x.mx/4', site: 'X', price: null, currency: null }], built_m2: 300 });
  const { cards, dropped } = mergeCandidates({ candidates: [over, missing, breaker, unknownPrice], inventory: [], brief, fx: FX });
  assert.deepEqual(dropped.map((d) => d.reason).sort(), ['deal_breaker', 'must_have_missing', 'over_budget']);
  assert.equal(cards.length, 1, 'an unknown price is a question for the agent, not a reason to drop');
});

test('a PropLync listing keeps database facts and absorbs its portal copy', () => {
  const inventory = [{ public_id: 'PL-abc12345', title_es: 'Depto Zama', town: 'Tulum', neighborhood: 'Aldea Zamá',
    bedrooms: 2, bathrooms: 2, size: 90, operation: 'sale', currency: 'USD', amount: 244000, image: 'https://img.x/a.jpg', agency_name: 'Casa Tulum' }];
  const ours = web({ proplync_listing_id: 'PL-abc12345', title: 'model wrote something else', sources: [] });
  const portalCopy = web();
  const { cards } = mergeCandidates({ candidates: [ours, portalCopy], inventory, brief, fx: FX, siteOrigin: 'https://proplync.test' });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].origin, 'proplync');
  assert.equal(cards[0].title, 'Depto Zama');
  assert.equal(cards[0].sources[0].url, 'https://proplync.test/propiedad/PL-abc12345');
  assert.equal(cards[0].sources.length, 2);
});

test('validateSubmission drops links the model never saw and unknown inventory ids', () => {
  const transcript = [
    { role: 'user', content: 'brief' },
    { role: 'assistant', content: [
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://www.inmuebles24.com/propiedades/depto-123.html', title: 't' }] },
      { type: 'web_fetch_tool_result', content: { type: 'web_fetch_result', url: 'https://lamudi.com.mx/depto-zama-99', content: { type: 'document', source: { type: 'text', data: 'see also https://agencia.mx/listing/5' } } } }
    ] }
  ];
  const seen = seenUrls(transcript);
  assert.ok(seen.has(normalizeUrl('https://agencia.mx/listing/5')), 'URLs written inside fetched pages count as seen');
  const input = { search_notes: 'ok', candidates: [
    web(),
    web({ sources: [{ url: 'https://made-up.mx/casa', site: 'X', price: 1, currency: 'USD' }] }),
    web({ proplync_listing_id: 'PL-not-ours', sources: [] }),
    web({ bedrooms: 999, sources: [{ url: 'https://lamudi.com.mx/depto-zama-99/', site: 'Lamudi', price: -5, currency: 'BTC' }] })
  ] };
  const { candidates, droppedUrls } = validateSubmission(input, { seen, inventoryIds: new Set(['PL-abc12345']) });
  assert.equal(candidates.length, 2);
  assert.equal(droppedUrls, 1);
  assert.equal(candidates[1].bedrooms, null, 'out-of-range numbers become unknown');
  assert.equal(candidates[1].sources[0].price, null);
  assert.equal(candidates[1].sources[0].currency, null);
});
