import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* js/concierge.js is a browser script (an IIFE that attaches to window). Load it with a stub window and take flat() from it. */
const src = readFileSync(new URL('../js/concierge.js', import.meta.url), 'utf8');
const win = { document: { documentElement: { lang: 'es' }, addEventListener() {}, createElement: () => ({}) }, localStorage: {}, sessionStorage: {}, speechSynthesis: null, addEventListener() {} };
new Function('window', 'document', 'self', src.replace(/\}\)\(typeof window[^;]*;?\s*$/, '})(window);') )(win, win.document, win);
const flat = (win.PropLyncConcierge || {}).flat;

test('flat: a budget reads as a figure, not as raw values', () => {
  assert.ok(flat, 'PropLyncConcierge.flat is exposed');
  assert.equal(flat({ max: 300000, currency: 'USD', financing: null, comfortable: null }), 'USD 300,000');
  assert.equal(flat({ max: 1000000, currency: 'MXN', financing: 'contado', comfortable: 800000 }), 'MXN 1,000,000 · MXN 800,000 · contado');
  assert.equal(flat({ max: null, currency: 'USD', financing: null, comfortable: null }), '');
});

test('flat: nested lists keep their spaces', () => {
  assert.equal(flat({ areas: ['Tulum', 'Aldea Zama'], anchors: [] }), 'Tulum, Aldea Zama');
  assert.equal(flat(['2 recámaras', 'alberca']), '2 recámaras, alberca');
  assert.equal(flat({ areas: ['Playa del Carmen'], anchors: ['cerca de la 5ta'] }), 'Playa del Carmen · cerca de la 5ta');
});

test('flat: empties and plain values', () => {
  for (const empty of [null, undefined, '', [], {}, { a: null, b: '' }]) assert.equal(flat(empty), '');
  assert.equal(flat('vivir parte del año'), 'vivir parte del año');
  assert.equal(flat(12000), '12,000');
});
