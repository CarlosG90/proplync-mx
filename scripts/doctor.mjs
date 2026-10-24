#!/usr/bin/env node
/**
 * Proplync.mx · Are the AI agents ready? ("doctor")
 * -----------------------------------------------------------------------------
 * Asks the deployed site to check itself and prints the answer: which providers accept their keys and still
 * list the models we call, whether Scout can start a run, its limits and spending, whether the tables exist,
 * whether any run is stuck, and what would silently not happen. It spends nothing.
 *
 *   node scripts/doctor.mjs                      # production
 *   node scripts/doctor.mjs --url https://<preview>.vercel.app
 *   node scripts/doctor.mjs --probe              # also sends Scout's real request once (a few cents)
 *
 * Proves who you are by sending a hash of SUPABASE_SERVICE_ROLE_KEY (from .env.local). The key itself is
 * never sent. Exit code 1 when there are problems, so it can gate a deploy.
 * -----------------------------------------------------------------------------
 */

import { loadDotEnv, parseArgs, die, siteOrigin } from './_lib.mjs';
import { doctorToken } from '../api/_lib/health-check.js';

loadDotEnv();
const args = parseArgs(process.argv.slice(2), ['probe']);
const probe = args.flags.has('probe');
const base = String(args.url || siteOrigin()).replace(/\/+$/, '');

const headers = {};
if (process.env.SCOUT_STEP_SECRET) headers['x-scout-secret'] = process.env.SCOUT_STEP_SECRET;
else if (process.env.SUPABASE_SERVICE_ROLE_KEY) headers['x-doctor-token'] = doctorToken(process.env.SUPABASE_SERVICE_ROLE_KEY);
else die('Needs SUPABASE_SERVICE_ROLE_KEY (or SCOUT_STEP_SECRET) in .env.local or the environment.');

let res;
try { res = await fetch(`${base}/api/finder?action=health${probe ? '&probe=1' : ''}`, { headers, signal: AbortSignal.timeout(30000) }); }
catch (e) { die(`Could not reach ${base}: ${e.message}`); }

if (res.status === 401) die(`${base} refused the check (401). Either this deployment does not have the doctor yet, or its SUPABASE_SERVICE_ROLE_KEY differs from the one in your .env.local.`);
if (res.status === 404 || res.status === 400) die(`${base} answered ${res.status}: this deployment predates the doctor. Deploy the branch that adds it.`);
if (!res.ok) die(`${base} answered ${res.status}.`);
const r = await res.json();

const yes = (b) => (b ? '✓' : '✗');
const line = (label, ok, text) => console.log(`  ${yes(ok)} ${label.padEnd(26)} ${text || ''}`);
const money = (n) => (n == null ? '—' : `US$${Number(n).toFixed(2)}`);

console.log(`\n  PropLync AI readiness · ${base}\n  ${r.checked_at}\n`);

console.log('  Concierge (the buyer conversation)');
const nv = r.providers.nvidia, gq = r.providers.groq;
line('NVIDIA (first choice)', nv.ok, `${nv.model}${nv.detail ? ' · ' + nv.detail : ''}`);
line('Groq (fallback)', gq.ok, gq.detail || `${gq.primary && gq.primary.model}`);
line('Voice notes (Groq STT)', gq.speech && gq.speech.listed, gq.speech && gq.speech.model);

console.log('\n  Scout (the research agent)');
const an = r.providers.anthropic;
line('Anthropic key + model', an.ok, `${an.model}${an.detail ? ' · ' + an.detail : ''}`);
line('Listing import (PDF/photo)', r.providers.extractor.ok, r.providers.extractor.model + (r.providers.extractor.detail ? ' · ' + r.providers.extractor.detail : ''));
line('Can start runs', r.scout.can_start_runs, `automatic runs ${r.scout.paid_runs_switch}`);
line('Today', true, `${r.scout.runs_started_today ?? '—'} of ${r.scout.limits.daily_run_cap} runs`);
line('This month', true, `${money(r.scout.spent_this_month_usd)} of ${money(r.scout.limits.monthly_budget_usd)}`);
line('Per-run caps', true, `wrap up at ${money(r.scout.limits.run_soft_cap_usd)}, stop at ${money(r.scout.limits.run_hard_cap_usd)}`);

console.log('\n  Database');
for (const [t, v] of Object.entries(r.database.tables)) line(t, v.exists, v.exists ? `${v.rows} rows` : `missing (${v.error})`);
line('Active runs', r.database.stuck_runs === 0, `${r.database.active_runs ?? '—'} active, ${r.database.stuck_runs ?? '—'} stuck`);

console.log('\n  Email alerts to you');
line('Resend + from + operator', r.email.resend_key && r.email.from && r.email.operator, r.email.resend_key && r.email.from && r.email.operator ? 'configured' : 'NOT configured: you will not be told about approvals or verification requests');

if (r.scout_request) {
  console.log('\n  Scout\'s real request, sent once');
  line('Accepted by Anthropic', r.scout_request.ok, r.scout_request.ok ? `${r.scout_request.model} · stop: ${r.scout_request.stop_reason}` : r.scout_request.detail);
}
if (r.recent_failures && r.recent_failures.length) {
  console.log('\n  Last failed Scout runs (the real error)');
  r.recent_failures.forEach((x) => console.log(`   ${String(x.at).slice(0, 19)}  ${x.id.slice(0, 8)}  ${x.error}`));
}
if (r.problems.length) { console.log('\n  PROBLEMS (something will not work)'); r.problems.forEach((p) => console.log('   ✗ ' + p)); }
if (r.notes.length) { console.log('\n  NOTES'); r.notes.forEach((n) => console.log('   · ' + n)); }
console.log(r.ok ? '\n  ✓ Ready.\n' : '\n  ✗ Not ready: fix the problems above.\n');
process.exit(r.ok ? 0 : 1);
