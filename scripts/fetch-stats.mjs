#!/usr/bin/env node
/**
 * Proplync.mx · Which sites can Scout open?
 * -----------------------------------------------------------------------------
 * Tallies, per site, how many page opens worked and how many failed across every stored Scout run, so the
 * FETCH_REFUSED list in api/_lib/scout.js rests on what happened and not on a guess. Read-only, spends nothing.
 *
 *   node scripts/fetch-stats.mjs
 *
 * A site that has failed every time is a candidate for the list; one that has ever opened should stay off it.
 * Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.local or the environment.
 * -----------------------------------------------------------------------------
 */

import { fetchOutcomes } from '../api/_lib/scout.js';
import { loadDotEnv, serviceClient } from './_lib.mjs';

loadDotEnv();
const svc = serviceClient();
const { data: runs, error } = await svc.from('scout_runs').select('messages').gt('steps', 0);
if (error) { console.error(error.message); process.exit(1); }

const tally = new Map();
for (const r of runs) fetchOutcomes(r.messages, tally);

console.log(`\n  Page opens by site, ${runs.length} run(s)\n`);
console.log('  ok  fail  site');
[...tally].sort((a, b) => b[1].fail - a[1].fail || b[1].ok - a[1].ok).forEach(([host, s]) =>
  console.log(`  ${String(s.ok).padStart(2)}  ${String(s.fail).padStart(4)}  ${host}${s.fail && !s.ok ? '   never opened: ' + [...s.codes].join(', ') : ''}`));
console.log('');
