#!/usr/bin/env node
/**
 * Proplync.mx · Scout from the command line
 * -----------------------------------------------------------------------------
 * The operator side of Finder: start Scout on an approved brief, read what it
 * found, and record what the listing agent said, candidate by candidate. The
 * buyer sees nothing until `ready`.
 *
 *   node scripts/scout.mjs list [--status approved|searching|review|ready|closed]
 *   node scripts/scout.mjs new --file brief.json --name "Ana" --email ana@x.com [--lang en]
 *   node scripts/scout.mjs run <briefId>
 *   node scripts/scout.mjs review <briefId>
 *   node scripts/scout.mjs confirm <candidateId> --answers '{"available":"si","price":"USD 245,000","can_visit":"si","listing_agent":"Ana, Casa Tulum","restrictions":"sin mascotas"}' [--notes "..."] [--by "Carlos"]
 *   node scripts/scout.mjs reject <candidateId> --reason "vendido en agosto" [--by "Carlos"]
 *   node scripts/scout.mjs unreachable <candidateId> [--notes "..."]
 *   node scripts/scout.mjs ready <briefId>
 *
 * `run` is the same engine the Vercel chain uses (api/_lib/scout.js), looped
 * here with no time limit. It spends real money: roughly US$1-3 a run, and it
 * prints the running cost after every segment.
 *
 * Reads SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and ANTHROPIC_API_KEY from
 * .env.local or the environment.
 * -----------------------------------------------------------------------------
 */

import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

import { createRun, runScoutStep, scoutConfigured } from '../api/_lib/scout.js';
import { parseArgs, serviceClient, siteOrigin, die } from './_lib.mjs';

const ANSWER_KEYS = ['available', 'price', 'can_visit', 'listing_agent', 'restrictions'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function money(n, cur) {
  return n == null ? '—' : `${cur || ''} $${Number(n).toLocaleString('en-US')}`.trim();
}

async function cmdList(svc, args) {
  let q = svc.from('buyer_briefs').select('id, status, contact_name, contact_email, lang, created_at, brief')
    .order('created_at', { ascending: false }).limit(30);
  if (args.status) q = q.eq('status', args.status);
  const { data, error } = await q;
  if (error) die(error.message);
  if (!data.length) { console.log('\n  No briefs.\n'); return; }
  console.log('');
  for (const b of data) {
    const budget = b.brief.budget || {};
    const areas = [].concat((b.brief.location || {}).areas || []).join(', ') || '—';
    console.log(`  ${b.id}  ${b.status.padEnd(9)}  ${b.created_at.slice(0, 10)}  ${b.contact_name} <${b.contact_email}>`);
    console.log(`  ${' '.repeat(36)}  ${areas} · max ${budget.max ?? '—'} ${budget.currency || ''}`);
  }
  console.log('');
}

async function cmdNew(svc, args) {
  if (!args.file || !args.name || !args.email) die('new needs --file, --name and --email');
  let brief;
  try { brief = JSON.parse(readFileSync(args.file, 'utf8')); } catch (e) { die('could not read ' + args.file + ': ' + e.message); }
  const token = randomBytes(32).toString('base64url');
  const { data, error } = await svc.from('buyer_briefs').insert({
    access_token_hash: createHash('sha256').update(token).digest('hex'),
    lang: args.lang === 'en' ? 'en' : 'es',
    brief, contact_name: args.name, contact_email: args.email,
    // Operator-created briefs come from a buyer who agreed in person or by phone.
    consent_at: new Date().toISOString()
  }).select('id').single();
  if (error) die(error.message);
  console.log(`\n  ✓ Brief ${data.id}`);
  console.log(`  Buyer link (shown once, send it to them): ${siteOrigin()}/brief?b=${token}\n`);
}

async function cmdRun(svc, briefId) {
  if (!briefId) die('run needs a brief id');
  if (!scoutConfigured()) die('ANTHROPIC_API_KEY is not set.');
  const { run, existing } = await createRun(svc, briefId, 'operator');
  console.log(`\n  ${existing ? 'Continuing' : 'Started'} run ${run.id}\n`);
  let busyWaits = 0;
  for (;;) {
    const out = await runScoutStep(svc, run.id);
    const cost = out.cost_usd != null ? `  ~US$${out.cost_usd.toFixed(2)} so far` : '';
    console.log(`  · ${out.state}${out.detail ? ' (' + out.detail + ')' : ''}${cost}`);
    if (out.state === 'continue') continue;
    if (out.state === 'retry') { await sleep(15000); continue; }
    if (out.state === 'busy') {
      // Another runner (the Vercel chain) holds this run. Wait for it rather than race it.
      if (++busyWaits > 30) die('the run stayed busy for 10 minutes; check scout_runs.lease_until');
      await sleep(20000); continue;
    }
    if (out.state === 'done') console.log(`\n  ✓ ${out.candidates} candidate(s) to confirm. Next: node scripts/scout.mjs review ${briefId}\n`);
    else console.log(`\n  ✗ Run ended: ${out.detail}. The run row keeps the transcript and error.\n`);
    return;
  }
}

async function cmdReview(svc, briefId) {
  if (!briefId) die('review needs a brief id');
  const { data: brief, error } = await svc.from('buyer_briefs').select('*').eq('id', briefId).single();
  if (error) die(error.message);
  const { data: runs } = await svc.from('scout_runs')
    .select('id, status, steps, web_searches, web_fetches, cost_usd, search_notes, error')
    .eq('brief_id', briefId).order('created_at', { ascending: false }).limit(1);
  const { data: cands } = await svc.from('scout_candidates').select('*')
    .eq('brief_id', briefId).order('fit_score', { ascending: false, nullsFirst: false });

  console.log(`\n  Brief ${brief.id} · ${brief.status} · ${brief.contact_name} <${brief.contact_email}> · ${brief.lang}`);
  console.log('  ' + JSON.stringify(brief.brief));
  const run = runs && runs[0];
  if (run) {
    console.log(`\n  Last run ${run.id}: ${run.status}, ${run.steps} segments, ${run.web_searches} searches, ${run.web_fetches} fetches, ~US$${Number(run.cost_usd).toFixed(2)}${run.error ? ', error: ' + run.error : ''}`);
    if (run.search_notes) console.log('  Notes: ' + run.search_notes.replace(/\n/g, '\n         '));
  }
  console.log('');
  for (const c of cands || []) {
    console.log(`  [${c.verification}] ${c.id}  fit ${c.fit_score ?? '—'}  ${c.origin}${c.listing_public_id ? ' ' + c.listing_public_id : ''}`);
    console.log(`     ${c.title || '(no title)'} · ${[c.neighborhood, c.town].filter(Boolean).join(', ') || '—'}`);
    console.log(`     ${c.bedrooms ?? '?'} rec · ${c.bathrooms ?? '?'} baños · ${c.built_m2 ?? '?'} m² const · ${c.land_m2 ?? '?'} m² terreno`);
    for (const s of c.sources) console.log(`     - ${s.site || 'source'}: ${money(s.price, s.currency)}${s.listed_by ? ' · ' + s.listed_by : ''}\n       ${s.url}`);
    for (const m of (c.match.must_haves || [])) console.log(`     ${m.status === 'met' ? '✓' : '?'} ${m.item}${m.evidence ? ' — "' + m.evidence + '"' : ''}`);
    if ((c.match.questions_for_agent || []).length) console.log('     Ask: ' + c.match.questions_for_agent.join(' | '));
    if (c.answers) console.log('     Answers: ' + JSON.stringify(c.answers));
    console.log('');
  }
  if (!cands || !cands.length) console.log('  No candidates.\n');
}

async function setVerification(svc, id, fields) {
  if (!id) die('needs a candidate id');
  const { data, error } = await svc.from('scout_candidates')
    .update({ ...fields, verified_at: new Date().toISOString() }).eq('id', id).select('id, verification').single();
  if (error) die(error.message);
  console.log(`\n  ✓ ${data.id} → ${data.verification}\n`);
}

async function cmdConfirm(svc, id, args) {
  let answers;
  try { answers = JSON.parse(args.answers || ''); } catch (e) { die('--answers must be JSON with ' + ANSWER_KEYS.join(', ')); }
  const missing = ANSWER_KEYS.filter((k) => !String(answers[k] || '').trim());
  // Confirmed means all five were asked. A blank is a call not finished.
  if (missing.length) die('answers missing: ' + missing.join(', '));
  const clean = Object.fromEntries(ANSWER_KEYS.map((k) => [k, String(answers[k]).trim().slice(0, 300)]));
  await setVerification(svc, id, { verification: 'confirmed', answers: clean, verification_notes: args.notes || null, verified_by: args.by || null });
}

async function cmdReady(svc, briefId) {
  if (!briefId) die('ready needs a brief id');
  const { count } = await svc.from('scout_candidates').select('id', { count: 'exact', head: true })
    .eq('brief_id', briefId).eq('verification', 'confirmed');
  if (!count) die('no confirmed candidates yet; confirm at least one before releasing the brief');
  const { error } = await svc.from('buyer_briefs').update({ status: 'ready', updated_at: new Date().toISOString() }).eq('id', briefId);
  if (error) die(error.message);
  console.log(`\n  ✓ Brief ${briefId} is ready: the buyer's link now shows ${count} confirmed propert${count === 1 ? 'y' : 'ies'}.\n`);
}

const args = parseArgs(process.argv.slice(2));
const [cmd, id] = args._;
const svc = serviceClient();

switch (cmd) {
  case 'list': await cmdList(svc, args); break;
  case 'new': await cmdNew(svc, args); break;
  case 'run': await cmdRun(svc, id); break;
  case 'review': await cmdReview(svc, id); break;
  case 'confirm': await cmdConfirm(svc, id, args); break;
  case 'reject':
    if (!args.reason) die('reject needs --reason');
    await setVerification(svc, id, { verification: 'rejected', verification_notes: args.reason, verified_by: args.by || null });
    break;
  case 'unreachable':
    await setVerification(svc, id, { verification: 'unreachable', verification_notes: args.notes || null, verified_by: args.by || null });
    break;
  case 'ready': await cmdReady(svc, id); break;
  default:
    die('usage: scout.mjs list | new | run <briefId> | review <briefId> | confirm|reject|unreachable <candidateId> | ready <briefId>');
}
