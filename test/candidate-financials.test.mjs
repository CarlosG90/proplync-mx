import { test } from 'node:test';
import assert from 'node:assert/strict';
import { investorBrief, loadRentComps, financialsFor } from '../api/_lib/candidate-financials.js';

const FX = 18;
const rent = (mxn, over = {}) => ({ operation: 'rental_long', town: 'Tulum', neighborhood: 'Aldea Zama', bedrooms: 2, priceUsd: mxn / FX, ...over });
const candidate = (over = {}) => ({ operation: 'sale', town: 'Tulum', neighborhood: 'Aldea Zama', bedrooms: 2, lowest_price_mxn: 4_500_000, ...over });

test('only a brief about renting or investing gets a yield estimate', () => {
  assert.equal(investorBrief({ purpose: 'Inversión directa para renta' }), true);
  assert.equal(investorBrief({ purpose: 'vivir parte del año y rentar a largo plazo' }), true);
  assert.equal(investorBrief({ purpose: 'invest', must_haves: [] }), true);
  assert.equal(investorBrief({ purpose: 'Vivir con mi familia', must_haves: ['jardín', 'escuela cerca'] }), false);
  assert.equal(investorBrief({}), false);
  assert.equal(investorBrief(null), false);
});

test('with three rent comps in the neighbourhood the long-term track is shown, from real comps', () => {
  const f = financialsFor(candidate(), [rent(32_400), rent(34_200), rent(36_000)], FX);   // US$1,800 / 1,900 / 2,000 a month
  assert.equal(f.comps_scope, 'neighborhood');
  assert.equal(f.comps_used, 3);
  assert.equal(f.long_term.monthly_rent_usd, 1900);
  assert.equal(f.short_term, null, 'the index has no nightly rates: a short-term number would be a default, so it is not shown');
  assert.ok(f.long_term.cap_rate > 0 && f.long_term.gross_yield > 0);
  assert.equal(f.purchase_price_usd, 250_000);
});

test('too few comps, or none, show nothing instead of a default', () => {
  assert.equal(financialsFor(candidate(), [rent(32_400), rent(34_200)], FX), null);
  assert.equal(financialsFor(candidate(), [], FX), null);
  assert.equal(financialsFor(candidate({ town: 'Cancún', neighborhood: 'Zona Hotelera Cancun' }), [rent(32_400), rent(34_200), rent(36_000)], FX), null, 'comps from another town do not count');
});

test('the town is used, and said so, when the neighbourhood has too few comps', () => {
  const comps = [rent(32_400, { neighborhood: 'La Veleta' }), rent(34_200, { neighborhood: 'Region 15' }), rent(36_000, { neighborhood: 'La Veleta' })];
  assert.equal(financialsFor(candidate(), comps, FX).comps_scope, 'town');
});

test('bedrooms within one of the candidate\'s are comparable, others are not', () => {
  const two = [rent(32_400, { bedrooms: 1 }), rent(34_200, { bedrooms: 3 }), rent(36_000, { bedrooms: 5 }), rent(90_000, { bedrooms: 6 })];
  assert.equal(financialsFor(candidate(), two, FX), null, 'only the 1 and 3 bedroom comps qualify: two is not enough');
  const three = [...two, rent(30_600, { bedrooms: 2 })];
  const f = financialsFor(candidate(), three, FX);
  assert.equal(f.comps_used, 3, 'the 5 and 6 bedroom rentals are left out');
  // per bedroom: 1 bd US$1,800, 3 bd US$633, 2 bd US$850 -> median 850 x 2 bedrooms
  assert.equal(f.long_term.monthly_rent_usd, 1700);
});

test('rentals and unpriced candidates get no estimate', () => {
  const comps = [rent(32_400), rent(34_200), rent(36_000)];
  assert.equal(financialsFor(candidate({ operation: 'rental' }), comps, FX), null);
  assert.equal(financialsFor(candidate({ lowest_price_mxn: null }), comps, FX), null);
  assert.equal(financialsFor(null, comps, FX), null);
});

test('loadRentComps converts monthly MXN to USD and survives a missing column or empty list', async () => {
  const svc = { from: () => ({ select: () => ({ eq: () => ({ in: () => ({ not: () => ({ limit: async () => ({ data: [
    { town: 'Tulum', neighborhood: 'Aldea Zama', bedrooms: '2', price_mxn_min: '36000' },
    { town: 'Tulum', neighborhood: null, bedrooms: null, price_mxn_min: '0' }
  ], error: null }) }) }) }) }) }) };
  const out = await loadRentComps(svc, ['Tulum', 'Tulum', null], FX);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].operation, out[0].bedrooms, out[0].priceUsd], ['rental_long', 2, 2000]);
  assert.deepEqual(await loadRentComps(svc, [], FX), []);
  const failing = { from: () => ({ select: () => ({ eq: () => ({ in: () => ({ not: () => ({ limit: async () => ({ data: null, error: new Error('boom') }) }) }) }) }) }) };
  await assert.rejects(loadRentComps(failing, ['Tulum'], FX), /boom/);
});
