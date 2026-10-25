import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embedAdaptive, embedPending } from '../api/_lib/search/index-writer.js';

const vec = () => Array.from({ length: 384 }, () => 0.01);
const refused = (status = 546) => Object.assign(new Error('embed responded ' + status), { status });

test('a refused batch is split in half and retried, and the vectors come back in the original order', async () => {
  const calls = [];
  const embed = async (texts) => {
    calls.push(texts.length);
    if (texts.length > 2) throw refused(546);
    return texts.map((t) => [Number(t)]);
  };
  const out = await embedAdaptive(['1', '2', '3', '4', '5', '6', '7'], embed);
  assert.deepEqual(out.map((v) => v[0]), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(calls.slice(0, 4), [7, 4, 2, 2], 'whole, then halves (4 then 3)');
});

test('a text that is refused even alone comes back as null, and a non-load error is not retried or split', async () => {
  let calls = 0;
  assert.deepEqual(await embedAdaptive(['only'], async () => { calls++; throw refused(546); }), [null]);
  assert.equal(calls, 1, 'a single text cannot be split any further');
  const mixed = await embedAdaptive(['ok1', 'bad', 'ok2'], async (texts) => {
    if (texts.length > 1 || texts[0] === 'bad') throw refused(546);
    return texts.map((t) => [t]);
  });
  assert.deepEqual(mixed, [['ok1'], null, ['ok2']], 'the good ones keep their vectors');
  calls = 0;
  await assert.rejects(embedAdaptive(['a', 'b'], async () => { calls++; throw refused(401); }), (e) => e.status === 401);
  assert.equal(calls, 1, 'a 401 is a configuration problem, not a load problem: no splitting');
});

function fakeSvc(rows) {
  const updates = [];
  return { updates, from: () => ({
    select: () => ({ eq: () => ({ is: () => ({ limit: async () => ({ data: rows, error: null }) }) }) }),
    update: (patch) => ({ eq: async (c, id) => { updates.push({ id, patch }); return { error: null }; } })
  }) };
}
const row = (id) => ({ id, title: 'Depto ' + id, property_type: 'apartment', neighborhood: 'Aldea Zama', town: 'Tulum', amenities: [], description: 'x'.repeat(900) });

test('embedPending: small batches by default, every property gets its own vector', async () => {
  const svc = fakeSvc(Array.from({ length: 10 }, (_, i) => row('p' + i)));
  const sizes = [];
  const out = await embedPending(svc, { embed: async (texts) => { sizes.push(texts.length); return texts.map(vec); } });
  assert.deepEqual(sizes, [4, 4, 2], 'four at a time, so one call stays inside the edge function\'s time limit');
  assert.deepEqual(out, { embedded: 10, pending: 0, failed: 0 });
  assert.equal(svc.updates.length, 10);
});

test('embedPending: one property that cannot be embedded does not stop the rest', async () => {
  const svc = fakeSvc(Array.from({ length: 6 }, (_, i) => row('p' + i)));
  const embed = async (texts) => {
    if (texts.some((t) => t.includes('Depto p2'))) { if (texts.length === 1) throw refused(546); throw refused(546); }
    return texts.map(vec);
  };
  const out = await embedPending(svc, { batch: 3, embed });
  assert.equal(out.embedded, 5);
  assert.equal(out.failed, 1, 'the one that failed alone is left for the next run');
  assert.equal(out.pending, 1);
  assert.ok(!svc.updates.some((u) => u.id === 'p2'));
});

test('embedPending: with embedding not configured it stops quietly and search keeps working on text', async () => {
  const svc = fakeSvc([row('a'), row('b')]);
  const out = await embedPending(svc, { embed: async () => null });
  assert.deepEqual(out, { embedded: 0, pending: 2, failed: 0 });
});
