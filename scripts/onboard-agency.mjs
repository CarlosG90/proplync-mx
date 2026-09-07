#!/usr/bin/env node
/**
 * Proplync.mx · Onboard an agency from the command line
 * -----------------------------------------------------------------------------
 * Public signup is invite-gated, so this is how an agency actually gets created:
 * they give you an email address, you run one command, you hand back a login.
 *
 *   node scripts/onboard-agency.mjs --email ana@casatulum.mx --agency "Casa Tulum"
 *
 * Options
 *   --email <addr>      Required. The address they gave you.
 *   --agency <name>     Required. Display name; the slug is derived from it.
 *   --password <pw>     Optional. Omit and one is generated for you.
 *   --link-existing     Attach an account that already exists to a new agency
 *                       instead of failing. Never deletes anything on error.
 *   --dry-run           Print what would happen and touch nothing.
 *
 * Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.local or the
 * environment. The service key bypasses RLS entirely, which is why this is a
 * local script and not an endpoint — there is no request it could authenticate
 * that would be safer than the operator's own laptop.
 * -----------------------------------------------------------------------------
 */

import { randomInt } from 'node:crypto';

import { provisionAgency } from '../api/_lib/agency.js';
import { parseArgs, serviceClient, siteOrigin, die } from './_lib.mjs';

/* Ambiguous glyphs removed: this gets read off a screen and typed once. */
const PW_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generatePassword(len = 16) {
  let s = '';
  for (let i = 0; i < len; i++) s += PW_ALPHABET[randomInt(PW_ALPHABET.length)];
  return s;
}

/** No admin getUserByEmail exists, so page listUsers until the address turns up. */
async function findUserByEmail(svc, email) {
  const target = email.toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = (data.users || []).find(u => (u.email || '').toLowerCase() === target);
    if (hit) return hit;
    if (!data.users || data.users.length < 200) return null;
  }
  return null;
}

/* --- main ---------------------------------------------------------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2), ['link-existing', 'dry-run', 'help']);
  if (args.flags.has('help') || !args.email || !args.agency) {
    console.log(`
  Onboard an agency

    node scripts/onboard-agency.mjs --email <addr> --agency "<name>"

    --password <pw>   use this instead of a generated one
    --link-existing   attach an existing account to a new agency
    --dry-run         show the plan, change nothing
`);
    process.exit(args.flags.has('help') ? 0 : 1);
  }

  const svc = serviceClient();

  const email = String(args.email).trim().toLowerCase();
  const agencyName = String(args.agency).trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) die(`"${email}" does not look like an email address.`);
  if (!agencyName) die('--agency cannot be empty.');

  const password = args.password || generatePassword();
  if (password.length < 6) die('Password must be at least 6 characters.');

  const site = siteOrigin();

  const existing = await findUserByEmail(svc, email);

  if (args.flags.has('dry-run')) {
    console.log(`
  DRY RUN — nothing was changed

    email        ${email}
    agency       ${agencyName}
    account      ${existing ? 'already exists (needs --link-existing)' : 'would be created'}
    password     ${existing ? '(unchanged)' : password}
`);
    return;
  }

  let userId;
  let createdHere = false;

  if (existing) {
    if (!args.flags.has('link-existing')) {
      die(`${email} already has an account.\n    Re-run with --link-existing to attach it to a new agency,\n    or use a different address.`);
    }
    const { data: member } = await svc
      .from('agency_members').select('agency_id').eq('user_id', existing.id).maybeSingle();
    if (member) die(`${email} is already a member of an agency. One account belongs to one agency.`);
    userId = existing.id;
  } else {
    const { data: created, error } = await svc.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // no confirmation mail; you are vouching for them
      user_metadata: { agency_name: agencyName }
    });
    if (error) die(`Could not create the account: ${error.message}`);
    userId = created.user.id;
    createdHere = true;
  }

  let agency;
  try {
    agency = await provisionAgency(svc, { userId, agencyName });
  } catch (err) {
    // Only clean up what this run created. An account that existed before is
    // someone's real login and must survive a failed provisioning attempt.
    if (createdHere) await svc.auth.admin.deleteUser(userId).catch(() => {});
    die(`Could not create the agency: ${err.message || err}\n    ${createdHere ? 'The new account was rolled back.' : 'The existing account was left untouched.'}`);
  }

  // A set-your-own-password link means you never have to send the temporary
  // one over WhatsApp. Best-effort: if link generation is unavailable the
  // temporary password below still works.
  let recoveryLink = null;
  try {
    const { data, error } = await svc.auth.admin.generateLink({
      type: 'recovery', email, options: { redirectTo: `${site}/reset` }
    });
    if (!error) recoveryLink = data?.properties?.action_link || null;
  } catch { /* fall back to the password */ }

  console.log(`
  ✓ ${agencyName} is onboarded

    Agency        ${agencyName}
    Mini-site     ${site}/agencia/${agency.slug}
    Log in at     ${site}/login

    Email         ${email}${createdHere ? `
    Password      ${password}   (temporary — they change it at ${site}/reset)` : `
    Password      unchanged (this account already existed)`}
${recoveryLink ? `
    Or send them this instead of the password — it lets them set their own
    on first use, so the temporary one never leaves your machine:

    ${recoveryLink}
` : ''}
  Note: the recovery link only works if ${site}/reset is on the Supabase
  redirect allowlist (Authentication -> URL Configuration).
`);
}

main().catch(err => die(err.stack || String(err)));
