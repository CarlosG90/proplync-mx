/**
 * Proplync.mx · Agency onboarding
 * -----------------------------------------------------------------------------
 * POST { agencyName, email, password } — public, no auth header (the account
 * doesn't exist yet). Creates the Supabase auth user via the admin API with
 * email_confirm:true (sidesteps needing to disable "Confirm email" in the
 * Supabase dashboard), then creates the agency + owner membership.
 *
 * The client calls this first, then signs in itself with
 * supabase.auth.signInWithPassword() to get a session — this endpoint never
 * hands back a session directly (the admin API doesn't produce one).
 *
 * If agency/membership creation fails after the auth user was created, the
 * auth user is deleted so signup can be retried cleanly (no orphaned account
 * stuck with no agency).
 *
 * INVITE-ONLY. This endpoint is the only way an account gets created, and it
 * creates users through the service-role admin API — which bypasses Supabase's
 * own "allow new users to sign up" setting. Turning that toggle off in the
 * dashboard does NOT close this door, so the gate has to live here.
 *
 * Two ways in, both fail CLOSED. A row in signup_invites is the normal one:
 * single-use, expiring, optionally bound to one address, revoked by deletion,
 * and issued without a redeploy. SIGNUP_INVITE_CODE remains as a master
 * override for when you want one shared code. With no invite rows and no env
 * var, every request is refused.
 * -----------------------------------------------------------------------------
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import { getServiceClient } from './_lib/supabase.js';
import { enforceRateLimit } from './_lib/ratelimit.js';
import { safeDetail } from './_lib/health.js';
import { provisionAgency } from './_lib/agency.js';

/** sha256 hex — what signup_invites stores instead of the code itself. */
function hashCode(code) {
  return createHash('sha256').update(String(code)).digest('hex');
}

/**
 * Find and CLAIM a usable invite in one step.
 *
 * The claim is a conditional update (`used_at is null`), so two people racing
 * the same code produce exactly one winner: the loser's update matches no row.
 * Checking first and updating after would let both through the gap between.
 *
 * Returns { ok: true, invite } on success, or { ok: false, reason } — the
 * caller collapses every reason into one 403 so the response never reveals
 * whether a code exists, is spent, has expired, or is bound to someone else.
 */
async function claimInvite(svc, code, email) {
  const { data: invite } = await svc
    .from('signup_invites')
    .select('id, email, agency_name, expires_at, used_at')
    .eq('code_hash', hashCode(code))
    .maybeSingle();

  if (!invite) return { ok: false, reason: 'no_such_code' };
  if (invite.used_at) return { ok: false, reason: 'already_used' };
  if (new Date(invite.expires_at) <= new Date()) return { ok: false, reason: 'expired' };
  if (invite.email && invite.email.toLowerCase() !== String(email || '').toLowerCase()) {
    return { ok: false, reason: 'wrong_email' };
  }

  const { data: claimed } = await svc
    .from('signup_invites')
    .update({ used_at: new Date().toISOString() })
    .eq('id', invite.id)
    .is('used_at', null)
    .select('id')
    .maybeSingle();
  if (!claimed) return { ok: false, reason: 'lost_race' };

  return { ok: true, invite };
}

/** Hand an invite back when signup failed after the claim. */
async function releaseInvite(svc, inviteId) {
  await svc.from('signup_invites').update({ used_at: null }).eq('id', inviteId);
}

/**
 * Constant-time comparison of two secrets of any length.
 * Hashing first gives timingSafeEqual the equal-length buffers it requires,
 * and stops the comparison itself from leaking the code's length.
 */
function secretsMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  // Creating an account is free and permanent, so this is the endpoint worth
  // guarding hardest. A real person signs up once; 5/hour per IP leaves room
  // for a retry or a shared office NAT without allowing scripted signups.
  if (await enforceRateLimit(req, res, { bucket: 'onboard', limit: 5, windowSec: 3600 })) return;

  const { agencyName, email, password, inviteCode } = req.body || {};
  const svc = getServiceClient();

  // Invite gate, resolved before any field validation and before any write.
  // A caller without a working code never reaches the 409/400 responses below,
  // so the endpoint cannot be used to probe which emails are registered. The
  // rate limit above doubles as brute-force protection: 5 guesses/IP/hour.
  const masterCode = process.env.SIGNUP_INVITE_CODE;
  const supplied = String(inviteCode || '');
  const masterMatched = !!masterCode && secretsMatch(supplied, masterCode);

  let claimedInvite = null;
  if (!masterMatched) {
    if (!supplied) {
      res.status(403).json({ error: 'invalid_invite_code' });
      return;
    }
    const result = await claimInvite(svc, supplied, email);
    if (!result.ok) {
      // Every failure reason collapses into one response. Distinguishing
      // "spent" from "expired" from "not yours" would confirm the code exists.
      res.status(403).json({ error: 'invalid_invite_code' });
      return;
    }
    claimedInvite = result.invite;
  }

  // From here the invite is spent, so every early return must hand it back.
  const fail = async (status, body) => {
    if (claimedInvite) await releaseInvite(svc, claimedInvite.id);
    res.status(status).json(body);
  };

  if (!agencyName || !String(agencyName).trim()) {
    await fail(400, { error: 'missing_agency_name' });
    return;
  }
  if (!email || !password || String(password).length < 6) {
    await fail(400, { error: 'invalid_credentials' });
    return;
  }

  const { data: created, error: createErr } = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { agency_name: agencyName }
  });
  if (createErr) {
    const code = /already.*registered|already exists/i.test(createErr.message) ? 'email_already_registered' : 'signup_failed';
    await fail(409, { error: code, detail: createErr.message });
    return;
  }

  const userId = created.user.id;

  try {
    const agency = await provisionAgency(svc, { userId, agencyName });
    if (claimedInvite) {
      // PostgrestFilterBuilder is thenable but has no .catch, so this needs a
      // real try/catch. Recording who redeemed the invite is bookkeeping; it
      // must not be able to fail a signup that has already succeeded.
      try {
        await svc.from('signup_invites')
          .update({ used_by: userId }).eq('id', claimedInvite.id);
      } catch { /* the invite is already marked used, which is what gates reuse */ }
    }
    res.status(200).json({ agencyId: agency.id, slug: agency.slug });
  } catch (err) {
    // This path created the auth user moments ago, so deleting it on failure
    // is safe and lets the agency retry signup with the same email — which
    // means the invite has to come back too, or the retry has no way in.
    await svc.auth.admin.deleteUser(userId).catch(() => {});
    await fail(500, { error: 'onboard_failed', detail: safeDetail(err) });
  }
}
