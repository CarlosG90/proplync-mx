/* The Mini project's copy of PropLync code (mini/api/_proplync) must match api/ exactly,
   and mini/package.json must declare every package that code imports. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { drift, graph } from '../scripts/sync-mini-shared.mjs';

test('mini/api/_proplync is an exact copy of what it uses from api/', () => {
  assert.deepEqual(drift(), [], 'run: node scripts/sync-mini-shared.mjs');
});

test('mini/package.json declares every npm package the copied code imports', () => {
  const deps = JSON.parse(readFileSync(new URL('../mini/package.json', import.meta.url), 'utf8')).dependencies || {};
  for (const p of graph().packages) assert.ok(deps[p], `mini/package.json is missing ${p}`);
});
