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
 *   node scripts/mini.mjs login-link <email>        one-time sign-in link to that customer's panel
 *   node scripts/mini.mjs create <email> --name "<business>" [--type real_estate|professional|trades|beauty|general]
 *        [--whatsapp "+52 …"] [--phone "+52 …"] [--public-email <addr>] [--tags "A, B"] [--suggested] [--dry-run]
 *                                                   set up a page for a customer, unpaid, ready for them to finish
 *
 * create exists because the fastest way to sell a page is often to build it for the
 * customer: the operator makes the account (email confirmed, no password: they sign
 * in with an email code), the page with their contact data and, with --suggested,
 * the template's services (mini/js/business-types.js). The page stays unpaid, so
 * nothing is public until `activate`. The customer finishes it from /panel.
 *
 * login-link exists because the project still sends auth email through Supabase's
 * built-in mailer (only team addresses, 2 an hour). For a demo or a customer who
 * never got their email, the operator generates the link and hands it over.
 *
 * It writes to the PRODUCTION database. Activate only after the payment is in.
 * -----------------------------------------------------------------------------
 */

import { parseArgs, serviceClient, die } from './_lib.mjs';
import { MINI_PERIOD_DAYS, MINI_PRICE_MXN, pageActive } from '../api/_lib/plans.js';
import { provisionAgency } from '../api/_lib/agency.js';
import { validateAgencyFields } from '../api/_lib/listing-fields.js';
import { typeFor, BUSINESS_TYPE_KEYS } from '../mini/api/_business-types.js';

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
  // "Ya pagué" / "Pedir datos de pago" from the Mini panel (mini/api/panel.js) are events rows,
  // so a notice is never lost to a failed email. Show each page's latest one.
  const { data: notices } = await svc.from('events')
    .select('session, created_at, props').eq('name', 'mini_paid_notice')
    .gt('created_at', new Date(Date.now() - 120 * 864e5).toISOString())
    .order('created_at', { ascending: false }).limit(500);
  const lastNotice = latestNoticeByAgency(notices || []);
  console.log('\n  Mini pages (newest first)\n');
  for (const a of data) {
    const state = !a.plan_expires_at ? 'PENDING' : pageActive({ plan: 'mini', plan_expires_at: a.plan_expires_at }) ? 'active' : 'lapsed';
    console.log(`    ${state.padEnd(8)} until ${day(a.plan_expires_at)}  ${String(a.slug).padEnd(28)} ${a.whatsapp_number || '-'}  ${a.name}`);
    const n = lastNotice.get(a.id);
    if (n && (!a.plan_expires_at || Date.parse(n.created_at) > Date.parse(a.plan_expires_at) - MINI_PERIOD_DAYS * 864e5)) {
      const p = n.props || {};
      console.log(`             ↳ payment notice ${day(n.created_at)}: ${p.method || '-'}${p.reference ? ' · ref ' + p.reference : ''}`);
    }
  }
  console.log(`\n  Activate a paid page: node scripts/mini.mjs activate <slug>   (MXN ${MINI_PRICE_MXN} = ${MINI_PERIOD_DAYS} days)\n`);
}

/** Latest payment notice per agency id, from events rows ordered newest first. Pure, for tests. */
export function latestNoticeByAgency(rows) {
  const out = new Map();
  for (const r of rows) if (r && r.session && !out.has(r.session)) out.set(r.session, r);
  return out;
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

  // For the funnel (scripts/funnel.mjs): an activation is the paid step.
  const { error: evErr } = await svc.from('events').insert({
    name: 'mini_activated', page: 'operator', session: agency.id, props: { slug: agency.slug, periods, until }
  });
  const site = (process.env.MINI_SITE_URL || '').replace(/\/$/, '');
  console.log(`\n  ✓ ${agency.name} is live until ${day(until)}`);
  console.log(`    Published ${published.length} draft(s). Page: ${site}/${agency.slug}`);
  if (evErr) console.log(`    (the funnel event was not recorded: ${evErr.message})`);
  console.log('    Tell the customer: their page is live, and the date it runs until.\n');
}

async function loginLink(svc, email) {
  const site = (process.env.MINI_SITE_URL || 'https://proplync-mini.vercel.app').replace(/\/$/, '');
  const { data, error } = await svc.auth.admin.generateLink({ type: 'magiclink', email, options: { redirectTo: site + '/panel' } });
  if (error) die(`Could not create a sign-in link for ${email}: ${error.message}`);
  console.log(`\n  One-time sign-in link for ${email} (works once, expires in about an hour):\n\n  ${data.properties.action_link}\n`);
}

/** No admin getUserByEmail exists, so page listUsers until the address turns up. */
async function findUser(svc, email) {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = (data.users || []).find((u) => (u.email || '').toLowerCase() === email);
    if (hit) return hit;
    if (!data.users || data.users.length < 200) return null;
  }
  return null;
}

/** The card fields from the flags, checked by the same rules as a panel save. Pure, for tests. Throws with the code. */
export function createCard(args) {
  const type = args.type || 'real_estate';
  if (!BUSINESS_TYPE_KEYS.includes(type)) throw new Error(`invalid_business_type (use ${BUSINESS_TYPE_KEYS.join(', ')})`);
  const name = String(args.name || '').trim();
  if (!name) throw new Error('missing --name');
  const tags = args.tags ? String(args.tags).split(',').map((t) => t.trim()).filter(Boolean) : [];
  const card = validateAgencyFields({
    business_type: type,
    whatsapp_number: args.whatsapp || null, phone: args.phone || null,
    public_email: args['public-email'] || null, services: tags
  });
  return { name, card };
}

async function create(svc, email, args, dryRun) {
  let plan;
  try { plan = createCard(args); } catch (err) { die(err.message); }
  const { name, card } = plan;
  const suggested = args.flags.has('suggested') ? typeFor(card.business_type).services : [];
  console.log(`\n  ${dryRun ? 'DRY RUN, nothing written.' : 'Creating'} Mini page "${name}" (${card.business_type}) for ${email}`);
  console.log(`  Card: WhatsApp ${card.whatsapp_number || '-'} · phone ${card.phone || '-'} · public email ${card.public_email || '-'} · tags ${card.services.join(', ') || '-'}`);
  console.log(`  Services to add: ${suggested.length ? '\n    - ' + suggested.map((x) => x.title_es).join('\n    - ') : 'none'}`);
  if (dryRun) { console.log(''); return; }

  let user = await findUser(svc, email);
  if (user) {
    const { data: member } = await svc.from('agency_members').select('agency_id').eq('user_id', user.id).limit(1).maybeSingle();
    if (member) die(`${email} already has a page (agency ${member.agency_id}). Nothing created.`);
  } else {
    // Confirmed, no password: the customer signs in to /panel with an email code. No email is sent now.
    const { data, error } = await svc.auth.admin.createUser({ email, email_confirm: true });
    if (error) die(`Could not create the account: ${error.message}`);
    user = data.user;
  }
  const agency = await provisionAgency(svc, { userId: user.id, agencyName: name, plan: 'mini' });
  // plan_expires_at stays null: unpaid, nothing public until `activate`.
  const { error: upErr } = await svc.from('agencies').update({ ...card, plan_expires_at: null }).eq('id', agency.id);
  if (upErr) die(`Page ${agency.slug} created but the card did not save: ${upErr.message}`);
  if (suggested.length) {
    const rows = suggested.map((x, i) => ({ agency_id: agency.id, title_es: x.title_es, title_en: x.title_en, price_kind: 'quote', sort: i * 10 }));
    const { error: sErr } = await svc.from('mini_services').insert(rows);
    if (sErr) die(`Page ${agency.slug} created but the services did not save: ${sErr.message}`);
  }
  const site = (process.env.MINI_SITE_URL || 'https://proplync-mini.vercel.app').replace(/\/$/, '');
  console.log(`\n  ✓ Page ready, unpaid: ${site}/${agency.slug}  (agency ${agency.id}, user ${user.id})`);
  console.log(`    The customer signs in at ${site}/panel with ${email} (email code), or hand them:`);
  console.log(`      node scripts/mini.mjs login-link ${email}`);
  console.log(`    After payment: node scripts/mini.mjs activate ${agency.slug}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['help', 'suggested', 'dry-run']);
  const [cmd, slug] = args._;
  if (!cmd || args.flags.has('help')) {
    console.log('\n  node scripts/mini.mjs list\n  node scripts/mini.mjs activate <slug> [--periods n]\n  node scripts/mini.mjs login-link <email>\n' +
      '  node scripts/mini.mjs create <email> --name "<business>" [--type ' + BUSINESS_TYPE_KEYS.join('|') + ']\n' +
      '       [--whatsapp "+52 …"] [--phone "+52 …"] [--public-email <addr>] [--tags "A, B"] [--suggested] [--dry-run]\n');
    return;
  }
  if (cmd === 'create') {
    if (!slug || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(slug)) die('Which email? node scripts/mini.mjs create <email> --name "<business>"');
    if (args.flags.has('dry-run')) return create(null, slug.toLowerCase(), args, true);
    return create(serviceClient(), slug.toLowerCase(), args, false);
  }
  const svc = serviceClient();
  if (cmd === 'list') return list(svc);
  if (cmd === 'activate') {
    if (!slug) die('Which page? node scripts/mini.mjs activate <slug>');
    const periods = Number(args.periods || 1);
    if (!Number.isInteger(periods) || periods < 1 || periods > 8) die('--periods must be a whole number from 1 to 8.');
    return activate(svc, slug, periods);
  }
  if (cmd === 'login-link') {
    if (!slug || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(slug)) die('Which email? node scripts/mini.mjs login-link <email>');
    return loginLink(svc, slug.toLowerCase());
  }
  die(`Unknown command "${cmd}". Use list, activate, login-link or create.`);
}

// Run only from the command line, so the tests can import extendUntil.
if (import.meta.url === `file://${process.argv[1]}`) main().catch((err) => die(err.stack || String(err)));
