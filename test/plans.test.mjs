import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFor, planExpired, marketingAccess, reelAccess } from '../api/_lib/plans.js';
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

test('only a row with a past plan_expires_at is expired; existing agencies never are', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  assert.equal(planExpired({ plan: 'pro' }, now), false, 'no date: never expires');
  assert.equal(planExpired({ plan: 'mini', plan_expires_at: null }, now), false);
  assert.equal(planExpired({ plan: 'mini', plan_expires_at: '2026-12-13T12:00:00Z' }, now), false);
  assert.equal(planExpired({ plan: 'mini', plan_expires_at: '2026-11-13T11:59:59Z' }, now), true);
  assert.equal(planExpired({ plan: 'mini', plan_expires_at: 'not a date' }, now), false, 'garbage must not take a page down');
  assert.equal(planExpired(null, now), false);
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
