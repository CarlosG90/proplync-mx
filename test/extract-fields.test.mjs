import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, parseCount, parseCurrency } from '../api/_lib/extract-fields.js';

test('amounts read the way flyers write them', () => {
  const cases = [
    [4500000, 4500000], ['$4,500,000', 4500000], ['4.500.000', 4500000], ['$4,500,000 MXN', 4500000],
    ['4.5 millones', 4500000], ['4,5 millones', 4500000], ['3 mdp', 3000000], ['850 mil', 850000],
    ['US$ 385,000', 385000], ['1,250.75', 1250.75], ['1.250,75', 1250.75], ['4 500 000', 4500000],
    ['120 m²', 120], ['2.5', 2.5], ['', null], ['consultar', null], [null, null], [-5, null]
  ];
  for (const [input, want] of cases) assert.equal(parseAmount(input), want, JSON.stringify(input));
});

test('counts keep half baths separate instead of becoming 25', () => {
  assert.deepEqual(parseCount('2.5'), { value: 2, half: true });
  assert.deepEqual(parseCount(2.5), { value: 2, half: true });
  assert.deepEqual(parseCount('3 recámaras'), { value: 3, half: false });
  assert.deepEqual(parseCount('1,5'), { value: 1, half: true });
  assert.deepEqual(parseCount('n/a'), { value: null, half: false });
  assert.deepEqual(parseCount('2500'), { value: null, half: false });
});

test('currency is read, never assumed', () => {
  for (const v of ['USD', 'usd', 'dólares', 'DLLS', 'US$']) assert.equal(parseCurrency(v), 'USD', v);
  for (const v of ['MXN', 'mxn', 'pesos', 'M.N.', 'MN']) assert.equal(parseCurrency(v), 'MXN', v);
  for (const v of ['', null, '$', 'unknown']) assert.equal(parseCurrency(v), '', String(v));
});
