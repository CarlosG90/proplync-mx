#!/usr/bin/env node
/**
 * Proplync.mx · Issue a signup invite code
 * -----------------------------------------------------------------------------
 * Gives an agency a code they redeem themselves at /signup, choosing their own
 * password as they go — so no password ever passes through you.
 *
 *   node scripts/create-invite.mjs --email ana@casatulum.mx --agency "Casa Tulum"
 *
 * Use this when you want the agency to set themselves up. Use
 * onboard-agency.mjs instead when you want the account to exist immediately.
 *
 * Options
 *   --email <addr>    Bind the code to one address. Strongly recommended: a
 *                     forwarded code is then a dead code.
 *   --agency <name>   Recorded on the invite so you know who it was for.
 *   --days <n>        Validity, default 14.
 *   --note <text>     Anything you want to read back later.
 *   --list            Show outstanding invites and exit.
 *   --revoke <id>     Delete an invite by id and exit.
 *
 * Only the sha256 of the code is stored. Nobody — including you, after this
 * prints — can recover it from the database. Lost code, issue a new one.
 * -----------------------------------------------------------------------------
 */

import { createHash, randomInt } from 'node:crypto';
import { parseArgs, serviceClient, siteOrigin, die, loadDotEnv } from './_lib.mjs';

/* Unambiguous alphabet: this gets read aloud over the phone often enough. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function block(n = 4) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}
const newCode = () => `PL-${block()}-${block()}`;
const hash = (c) => createHash('sha256').update(String(c)).digest('hex');

function fmtDate(iso) {
  return new Date(iso).toISOString().slice(0, 10);
}

async function list(svc) {
  const { data, error } = await svc
    .from('signup_invites')
    .select('id, email, agency_name, note, expires_at, used_at, created_at')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) die(`Could not read invites: ${error.message}`);
  if (!data.length) { console.log('\n  No invites issued.\n'); return; }

  const now = new Date();
  console.log('\n  Invites (newest first)\n');
  for (const i of data) {
    const state = i.used_at ? 'used'
      : new Date(i.expires_at) <= now ? 'EXPIRED'
      : 'open';
    console.log(`    ${state.padEnd(8)} ${fmtDate(i.expires_at)}  ${(i.agency_name || '-').padEnd(22)} ${i.email || 'any address'}`);
    console.log(`             id ${i.id}${i.note ? `  · ${i.note}` : ''}`);
  }
  console.log('\n  Codes are hashed and cannot be shown. Revoke with --revoke <id>.\n');
}

async function revoke(svc, id) {
  const { data, error } = await svc
    .from('signup_invites').delete().eq('id', id).select('id, agency_name').maybeSingle();
  if (error) die(`Could not revoke: ${error.message}`);
  if (!data) die(`No invite with id ${id}.`);
  console.log(`\n  ✓ Revoked invite ${data.id}${data.agency_name ? ` (${data.agency_name})` : ''}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['list', 'help']);
  if (args.flags.has('help')) {
    console.log(`
  Issue a signup invite

    node scripts/create-invite.mjs --email <addr> --agency "<name>"
    node scripts/create-invite.mjs --list
    node scripts/create-invite.mjs --revoke <id>

    --days <n>    validity in days (default 14)
    --note <text> reminder for your own benefit
`);
    return;
  }

  loadDotEnv();
  const svc = serviceClient();

  if (args.flags.has('list')) return list(svc);
  if (args.revoke) return revoke(svc, args.revoke);

  const email = args.email ? String(args.email).trim().toLowerCase() : null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) die(`"${email}" does not look like an email address.`);

  const days = Number(args.days || 14);
  if (!Number.isFinite(days) || days < 1 || days > 365) die('--days must be between 1 and 365.');

  const code = newCode();
  const expiresAt = new Date(Date.now() + days * 86400_000).toISOString();

  const { error } = await svc.from('signup_invites').insert({
    code_hash: hash(code),
    email,
    agency_name: args.agency ? String(args.agency).trim() : null,
    note: args.note ? String(args.note) : null,
    expires_at: expiresAt
  });
  if (error) die(`Could not create the invite: ${error.message}`);

  const site = siteOrigin();
  console.log(`
  ✓ Invite created

    Code          ${code}
    Sign up at    ${site}/signup
    Valid until   ${fmtDate(expiresAt)}  (${days} days)
    Locked to     ${email || 'any address — anyone with the code can register'}
${args.agency ? `    For           ${args.agency}\n` : ''}
  Send them the code and the link. They pick their own password, so nothing
  secret comes back through you. The code works once and then it is spent.
${email ? '' : `
  Consider --email next time: an unbound code still works if it gets forwarded.
`}`);
}

main().catch(err => die(err.stack || String(err)));
