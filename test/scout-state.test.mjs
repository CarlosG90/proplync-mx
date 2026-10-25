import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoutState, stableStringify, sameBrief } from '../api/_lib/scout-state.js';

const spent = { credits: 0, free_search_used: true };

test('a run in progress, finished or failed decides the state, whatever the wallet says', () => {
  assert.deepEqual(scoutState({ run: { status: 'running' }, wallet: spent }), { state: 'searching' });
  assert.deepEqual(scoutState({ run: { status: 'queued' }, wallet: spent }), { state: 'searching' });
  assert.deepEqual(scoutState({ run: { status: 'done' }, wallet: spent }), { state: 'done' });
  assert.deepEqual(scoutState({ run: { status: 'failed' }, wallet: spent }), { state: 'failed' });
});

test('no run and no free search left, no credits: not started because a credit is needed', () => {
  assert.deepEqual(scoutState({ run: null, wallet: spent }), { state: 'not_started', reason: 'needs_credit' });
  assert.deepEqual(scoutState({ run: null, wallet: { credits: '0', free_search_used: true } }), { state: 'not_started', reason: 'needs_credit' });
});

test('a buyer who can pay (a credit, or the free search still unused) is never told they need credits', () => {
  assert.equal(scoutState({ run: null, wallet: { credits: 2, free_search_used: true } }).reason, 'unknown');
  assert.equal(scoutState({ run: null, wallet: { credits: 0, free_search_used: false } }).reason, 'unknown');
  assert.equal(scoutState({ run: null, wallet: null }).reason, 'unknown', 'no wallet yet = the free search is still there');
});

test('other reasons it cannot start: switched off, or the day\'s limit reached', () => {
  assert.equal(scoutState({ run: null, wallet: null, canRun: false }).reason, 'unavailable');
  assert.equal(scoutState({ run: null, wallet: null, startedToday: 10, cap: 10 }).reason, 'busy');
  assert.equal(scoutState({ run: null, wallet: null, startedToday: 9, cap: 10 }).reason, 'unknown');
  assert.equal(scoutState({ run: null, wallet: spent, canRun: false }).reason, 'needs_credit', 'the credit is the first thing to fix');
});

test('briefs compare equal whatever order Postgres stores their keys in, and different when anything differs', () => {
  const a = { budget: { max: 300000, currency: 'USD' }, location: { areas: ['Tulum'] }, must_haves: ['alberca'], purpose: 'rentar' };
  const reordered = { purpose: 'rentar', must_haves: ['alberca'], location: { areas: ['Tulum'] }, budget: { currency: 'USD', max: 300000 } };
  assert.equal(stableStringify(a), stableStringify(reordered));
  assert.ok(sameBrief(a, reordered));
  assert.ok(!sameBrief(a, { ...a, must_haves: ['alberca', 'roof'] }));
  assert.ok(!sameBrief(a, { ...a, budget: { max: 250000, currency: 'USD' } }));
  assert.ok(!sameBrief(a, { ...a, location: { areas: ['Tulum', 'Playa'] } }), 'array order and length matter');
  assert.ok(sameBrief(null, null) && !sameBrief(a, null));
});
