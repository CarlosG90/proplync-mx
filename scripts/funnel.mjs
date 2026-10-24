#!/usr/bin/env node
/**
 * Proplync.mx · The funnel, last 30 days
 * -----------------------------------------------------------------------------
 * Reads the events table (supabase/014_events.sql) through its funnel views and prints how many visitors
 * reached each step, for buyers and for agents. These are the numbers BUSINESS-MODEL R7 says to watch weekly
 * before spending on ads.
 *
 *   node scripts/funnel.mjs               # buyers and agents
 *   node scripts/funnel.mjs --by-source   # split by campaign tag, referring site or direct
 *
 * A "visitor" is a browser tab session (an anonymous id kept only in the tab), not a person: someone who
 * returns on another day, or on another device, counts again. Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 * from .env.local.
 * -----------------------------------------------------------------------------
 */

import { parseArgs, serviceClient, die } from './_lib.mjs';
import { buildFunnel, BUYER_STAGES, AGENT_STAGES } from '../api/_lib/funnel.js';

const args = parseArgs(process.argv.slice(2), ['by-source']);
const svc = serviceClient();

function print(title, rows) {
  console.log(`\n  ${title}`);
  for (const r of rows) {
    const share = r.of_previous === null ? '' : `  ${String(r.of_previous).padStart(5)}% of the step before · ${String(r.of_first).padStart(5)}% of the first`;
    console.log(`   ${String(r.sessions).padStart(6)}  ${r.label}${share}`);
  }
}

if (args.flags.has('by-source')) {
  const { data, error } = await svc.from('event_funnel_by_source_30d').select('*');
  if (error) die(error.message);
  const groups = {};
  for (const r of data) (groups[`${r.source}${r.campaign ? ' / ' + r.campaign : ''}`] ||= []).push(r);
  console.log('\n  Last 30 days, by where visitors came from');
  for (const [key, rows] of Object.entries(groups).sort()) print(key, buildFunnel(rows, BUYER_STAGES));
} else {
  const { data, error } = await svc.from('event_funnel_30d').select('*');
  if (error) die(error.message);
  if (!data.length) console.log('\n  No events yet. They start arriving once the site that sends them is deployed.');
  console.log('\n  Last 30 days, distinct visitors (browser-tab sessions)');
  print('Buyers', buildFunnel(data, BUYER_STAGES));
  print('Agents', buildFunnel(data, AGENT_STAGES));
}
console.log('');
