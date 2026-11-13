import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFor, pageActive, miniState, marketingAccess, reelAccess } from '../api/_lib/plans.js';
import { extendUntil } from '../scripts/mini.mjs';
import { validateAgencyFields } from '../api/my-listings.js';

// ---------- the mini plan (migration 018) ----------

test('mini is a page, not the SaaS: 10 listings, no marketing, no Reels, one agent', () => {
  const p = planFor({ plan: 'mini' });
  assert.equal(p.id, 'mini');
  assert.equal(p.listings, 10);
  assert.equal(p.marketing, false);
  assert.equal(p.reelsPerMonth, 0);
  assert.equal(p.agents, 1);
  assert.equal(marketingAccess({ plan: 'mini' }).allowed, false);
  assert.equal(reelAccess({ plan: 'mini' }, 0).allowed, false);
});

test('an unknown or missing plan still falls back to free', () => {
  assert.equal(planFor({ plan: 'gold' }).id, 'free');
  assert.equal(planFor(null).id, 'free');
});

test('every plan except mini is always live; a mini page only while paid for', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  assert.equal(pageActive({ plan: 'pro' }, now), true);
  assert.equal(pageActive({ plan: 'free', plan_expires_at: '2020-01-01T00:00:00Z' }, now), true, 'only mini expires');
  assert.equal(pageActive(null, now), true);
  assert.equal(pageActive({ plan: 'mini', plan_expires_at: null }, now), false, 'not paid yet');
  assert.equal(pageActive({ plan: 'mini', plan_expires_at: '2027-02-11T12:00:00Z' }, now), true);
  assert.equal(pageActive({ plan: 'mini', plan_expires_at: '2026-11-13T11:59:59Z' }, now), false, 'period over');
  assert.equal(pageActive({ plan: 'mini', plan_expires_at: 'not a date' }, now), false, 'shown only on proof of payment');
});

test('the dashboard gets the Mini state: pending, active or expired', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  assert.equal(miniState({ plan: 'pro' }, now), null);
  assert.equal(miniState({ plan: 'mini', plan_expires_at: null }, now).state, 'pending');
  assert.equal(miniState({ plan: 'mini', plan_expires_at: '2027-01-01T00:00:00Z' }, now).state, 'active');
  assert.equal(miniState({ plan: 'mini', plan_expires_at: '2026-01-01T00:00:00Z' }, now).state, 'expired');
});

test('a payment adds 3 months from today, or from the current end while still running', () => {
  const now = Date.parse('2026-11-13T00:00:00Z');
  const day = 86400000;
  assert.equal(Date.parse(extendUntil(null, 1, now)), now + 90 * day, 'first payment');
  assert.equal(Date.parse(extendUntil('2026-01-01T00:00:00Z', 1, now)), now + 90 * day, 'lapsed: from today');
  assert.equal(Date.parse(extendUntil('2026-12-13T00:00:00Z', 1, now)), Date.parse('2026-12-13T00:00:00Z') + 90 * day, 'early renewal keeps the days left');
  assert.equal(Date.parse(extendUntil(null, 2, now)), now + 180 * day);
});

// ---------- the agent's card fields ----------

test('card fields are validated like everything else an agency saves', () => {
  const ok = validateAgencyFields({
    phone: '+52 998 123 4567', public_email: ' Hola@Agencia.MX ', address: 'Av. 10 Norte 123, Playa del Carmen',
    maps_url: 'https://maps.app.goo.gl/abc', services: [' Venta ', 'Renta', ''], bio: 'Veinte anos en la Riviera Maya.'
  });
  assert.equal(ok.public_email, 'hola@agencia.mx');
  assert.deepEqual(ok.services, ['Venta', 'Renta']);
  assert.equal(ok.maps_url, 'https://maps.app.goo.gl/abc');
});

test('bad card fields are refused with a code the dashboard can show', () => {
  assert.throws(() => validateAgencyFields({ public_email: 'not an email' }), /invalid_public_email/);
  assert.throws(() => validateAgencyFields({ public_email: 'a"b@x.com' }), /invalid_public_email/);
  assert.throws(() => validateAgencyFields({ maps_url: 'javascript:alert(1)' }), /invalid_maps_url/);
  assert.throws(() => validateAgencyFields({ services: new Array(9).fill('x') }), /invalid_services/);
  assert.throws(() => validateAgencyFields({ services: ['x'.repeat(41)] }), /invalid_services/);
  assert.throws(() => validateAgencyFields({ bio: 'x'.repeat(601) }), /bio_too_long/);
  assert.throws(() => validateAgencyFields({ address: 'x'.repeat(201) }), /address_too_long/);
  assert.throws(() => validateAgencyFields({ phone: 'call me' }), /invalid_phone/);
});

test('empty strings clear a card field rather than failing', () => {
  const out = validateAgencyFields({ phone: '', public_email: '', maps_url: '', address: '', bio: '' });
  assert.deepEqual(out, { phone: '', public_email: '', maps_url: '', address: '', bio: '' });
});
