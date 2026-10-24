import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchRun } from '../api/_lib/scout-watch.js';
import { KICK_AFTER_MS, STALL_AFTER_MS } from '../api/_lib/scout.js';
import { fakeDb } from './_fake-db.mjs';

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const run = (over = {}) => ({ id: 'r1', brief_id: 'b1', status: 'running', created_at: ago(2 * 60 * 1000), lease_until: null, user_id: 'u1', charged: 'credit', ...over });
const brief = { id: 'b1' };

function effects(over = {}) {
  const log = { kicked: [], marked: [], refunded: [], notified: [] };
  return {
    log,
    fx: {
      recentlyKicked: async () => false,
      markKicked: async (id) => { log.marked.push(id); },
      kick: (id) => { log.kicked.push(id); },
      refund: async (r) => { log.refunded.push(r.id); },
      notify: (m) => { log.notified.push(m); },
      ...over
    }
  };
}
const world = (r) => fakeDb({ scout_runs: [r], buyer_briefs: [{ id: 'b1', status: 'searching' }] });

test('a healthy run is left alone', async () => {
  const { fx, log } = effects();
  const { from } = world(run({ created_at: ago(10000) }));
  assert.equal(await watchRun({ from }, run({ created_at: ago(10000) }), brief, fx), 'wait');
  assert.deepEqual(log.kicked, []);
});

test('a run nobody picked up is restarted once, and the next poll is throttled', async () => {
  const stuck = run({ created_at: ago(KICK_AFTER_MS + 5000) });
  const { from } = world(stuck);
  const first = effects();
  assert.equal(await watchRun({ from }, stuck, brief, first.fx), 'kicked');
  assert.deepEqual(first.log.kicked, ['r1']);
  assert.deepEqual(first.log.marked, ['r1']);

  const second = effects({ recentlyKicked: async () => true });
  assert.equal(await watchRun({ from }, stuck, brief, second.fx), 'throttled');
  assert.deepEqual(second.log.kicked, [], 'a page left open cannot flood the function');
});

test('a segment that died mid-way (its lease ran out) is restarted', async () => {
  const dead = run({ lease_until: ago(90000) });
  const { from } = world(dead);
  const { fx, log } = effects();
  assert.equal(await watchRun({ from }, dead, brief, fx), 'kicked');
  assert.deepEqual(log.kicked, ['r1']);
});

test('a run stuck for far too long is closed, the buyer is refunded once, and the operator is told', async () => {
  const dead = run({ created_at: ago(STALL_AFTER_MS + 60000) });
  const { db, from } = world(dead);
  const { fx, log } = effects();
  assert.equal(await watchRun({ from }, dead, brief, fx), 'failed');
  assert.equal(db.scout_runs[0].status, 'failed');
  assert.equal(db.scout_runs[0].error, 'stalled');
  assert.equal(db.buyer_briefs[0].status, 'review');
  assert.deepEqual(log.refunded, ['r1']);
  assert.equal(log.notified.length, 1);
  assert.match(log.notified[0].text, /devolvió el crédito/);
});

test('two polls at once cannot refund twice: only the one that closes the run refunds', async () => {
  const dead = run({ created_at: ago(STALL_AFTER_MS + 60000) });
  const { db, from } = world(dead);
  const a = effects();
  const b = effects();
  // The second poll still holds the old, "running" copy of the row, as it would in real life.
  const [ra, rb] = [await watchRun({ from }, { ...dead }, brief, a.fx), await watchRun({ from }, { ...dead }, brief, b.fx)];
  assert.deepEqual([ra, rb].sort(), ['already_closed', 'failed']);
  assert.equal(a.log.refunded.length + b.log.refunded.length, 1);
  assert.equal(db.scout_runs[0].status, 'failed');
});

test('a finished run is never touched', async () => {
  const done = run({ status: 'done', created_at: ago(STALL_AFTER_MS * 2) });
  const { from } = world(done);
  const { fx, log } = effects();
  assert.equal(await watchRun({ from }, done, brief, fx), 'none');
  assert.deepEqual(log.refunded, []);
});
