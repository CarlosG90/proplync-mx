#!/usr/bin/env node
/**
 * Proplync.mx · Buyer credits by hand
 * -----------------------------------------------------------------------------
 * For pilot buyers who pay by transfer, refunds outside the automatic ones,
 * and support. Every change goes through add_credits() (migration 012), so it
 * lands in credit_ledger like a purchase does.
 *
 *   node scripts/credits.mjs show  <email>
 *   node scripts/credits.mjs grant <email> <n> --note "transferencia 12 oct, paquete 10"
 *
 * The buyer must have signed in once (Google or email code) so the account
 * exists. Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.local.
 * -----------------------------------------------------------------------------
 */

import { parseArgs, serviceClient, die } from './_lib.mjs';

async function userByEmail(svc, email) {
  const target = email.toLowerCase();
  for (let page = 1; page < 50; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 200 });
    if (error) die(error.message);
    const hit = data.users.find((u) => (u.email || '').toLowerCase() === target);
    if (hit) return hit;
    if (data.users.length < 200) break;
  }
  return null;
}

const args = parseArgs(process.argv.slice(2));
const [cmd, email, n] = args._;
if (!cmd || !email) die('usage: credits.mjs show <email> | grant <email> <n> --note "..."');
const svc = serviceClient();
const user = await userByEmail(svc, email);
if (!user) die(`no account for ${email}; they need to sign in on /brief once`);

if (cmd === 'grant') {
  const amount = Number(n);
  if (!Number.isInteger(amount) || amount < 1 || amount > 500) die('grant needs a whole number of credits between 1 and 500');
  if (!args.note) die('grant needs --note (what it was for); it goes in the ledger');
  const { data, error } = await svc.rpc('add_credits', { p_user: user.id, p_delta: amount, p_reason: 'manual', p_ref: String(args.note).slice(0, 200) });
  if (error) die(error.message);
  console.log(`\n  ✓ ${email}: +${amount} → ${data.credits} credits\n`);
} else if (cmd !== 'show') {
  die('unknown command ' + cmd);
}

const { data: wallet } = await svc.from('buyer_wallets').select('credits, free_search_used').eq('user_id', user.id).maybeSingle();
const { data: ledger } = await svc.from('credit_ledger').select('created_at, reason, delta, balance_after, ref')
  .eq('user_id', user.id).order('created_at', { ascending: false }).limit(15);
console.log(`  ${email}: ${wallet ? wallet.credits : 0} credits, free search ${wallet && wallet.free_search_used ? 'used' : 'available'}`);
for (const l of ledger || []) console.log(`   ${l.created_at.slice(0, 16)}  ${l.reason.padEnd(11)} ${String(l.delta).padStart(3)} → ${l.balance_after}  ${l.ref || ''}`);
console.log('');
