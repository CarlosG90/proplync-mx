#!/usr/bin/env node
/**
 * Proplync.mx · PropLync Mini: see who is waiting to pay, and activate a page by hand
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * A Mini page goes live only once it is paid (MXN 249 for 3 months; plans.js).
 * Until Mercado Pago is connected, the agent pays by transfer or WhatsApp and a
 * person releases the page. This is that release, so it is done the same way
 * every time: the paid period is extended (never shortened) and the drafts the
 * agent prepared on /mini are published.
 *
 *   node scripts/mini.mjs list                      pages waiting, active and lapsed
 *   node scripts/mini.mjs activate <slug>           one paid period (3 months)
 *   node scripts/mini.mjs activate <slug> --periods 2
 *
 * It writes to the PRODUCTION database. Activate only after the payment is in.
 * -----------------------------------------------------------------------------
 */

import { parseArgs, serviceClient, die } from './_lib.mjs';
import { MINI_PERIOD_DAYS, MINI_PRICE_MXN, pageActive } from '../api/_lib/plans.js';

const day = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '-');

/** The new end of the paid period: from today, or from the current end if it is still running. */
export function extendUntil(currentIso, periods = 1, now = Date.now()) {
  const current = Date.parse(currentIso || '');
  const from = Number.isFinite(current) && current > now ? current : now;
  return new Date(from + periods * MINI_PERIOD_DAYS * 86400000).toISOString();
}

async function list(svc) {
  const { data, error } = await svc.from('agencies')
    .select('id, name, slug, whatsapp_number, plan_expires_at, created_at')
    .eq('plan', 'mini').order('created_at', { ascending: false }).limit(100);
  if (error) die(`Could not read Mini pages: ${error.message}`);
  if (!data.length) { console.log('\n  No Mini pages yet.\n'); return; }
  console.log('\n  Mini pages (newest first)\n');
  for (const a of data) {
    const state = !a.plan_expires_at ? 'PENDING' : pageActive({ plan: 'mini', plan_expires_at: a.plan_expires_at }) ? 'active' : 'lapsed';
    console.log(`    ${state.padEnd(8)} until ${day(a.plan_expires_at)}  ${String(a.slug).padEnd(28)} ${a.whatsapp_number || '-'}  ${a.name}`);
  }
  console.log(`\n  Activate a paid page: node scripts/mini.mjs activate <slug>   (MXN ${MINI_PRICE_MXN} = ${MINI_PERIOD_DAYS} days)\n`);
}

async function activate(svc, slug, periods) {
  const { data: agency, error } = await svc.from('agencies')
    .select('id, name, slug, plan, plan_expires_at').eq('slug', slug).maybeSingle();
  if (error) die(`Could not read the agency: ${error.message}`);
  if (!agency) die(`No agency with slug "${slug}".`);
  if (agency.plan !== 'mini') die(`"${slug}" is on plan ${agency.plan}, not mini. Nothing changed.`);

  const until = extendUntil(agency.plan_expires_at, periods);
  const { error: upErr } = await svc.from('agencies').update({ plan_expires_at: until }).eq('id', agency.id);
  if (upErr) die(`Could not extend the page: ${upErr.message}`);
  const { data: published, error: pubErr } = await svc.from('listings')
    .update({ status: 'published' }).eq('agency_id', agency.id).eq('status', 'draft').select('public_id');
  if (pubErr) die(`Period extended to ${day(until)}, but publishing the drafts failed: ${pubErr.message}`);

  console.log(`\n  ✓ ${agency.name} is live until ${day(until)}`);
  console.log(`    Published ${published.length} draft(s). Page: /agencia/${agency.slug}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['help']);
  const [cmd, slug] = args._;
  if (!cmd || args.flags.has('help')) {
    console.log('\n  node scripts/mini.mjs list\n  node scripts/mini.mjs activate <slug> [--periods n]\n');
    return;
  }
  const svc = serviceClient();
  if (cmd === 'list') return list(svc);
  if (cmd === 'activate') {
    if (!slug) die('Which page? node scripts/mini.mjs activate <slug>');
    const periods = Number(args.periods || 1);
    if (!Number.isInteger(periods) || periods < 1 || periods > 8) die('--periods must be a whole number from 1 to 8.');
    return activate(svc, slug, periods);
  }
  die(`Unknown command "${cmd}". Use list or activate.`);
}

// Run only from the command line, so the tests can import extendUntil.
if (import.meta.url === `file://${process.argv[1]}`) main().catch((err) => die(err.stack || String(err)));
