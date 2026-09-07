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
 * It fails CLOSED: with SIGNUP_INVITE_CODE unset, every request is refused.
 * Opening signup is a deliberate act (set the variable, redeploy), not the
 * default state of a missing config.
 * -----------------------------------------------------------------------------
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import { getServiceClient } from './_lib/supabase.js';
import { enforceRateLimit } from './_lib/ratelimit.js';
import { safeDetail } from './_lib/health.js';
import { provisionAgency } from './_lib/agency.js';

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

  // Invite gate. Checked before anything is read or written, so a caller
  // without the code cannot probe which emails are already registered by
  // reading the difference between a 409 and a 400. The rate limit above
  // doubles as brute-force protection: 5 guesses per IP per hour.
  const expectedCode = process.env.SIGNUP_INVITE_CODE;
  if (!expectedCode) {
    res.status(403).json({ error: 'signup_closed' });
    return;
  }
  if (!secretsMatch(String((req.body || {}).inviteCode || ''), expectedCode)) {
    res.status(403).json({ error: 'invalid_invite_code' });
    return;
  }

  const { agencyName, email, password } = req.body || {};
  if (!agencyName || !String(agencyName).trim()) {
    res.status(400).json({ error: 'missing_agency_name' });
    return;
  }
  if (!email || !password || String(password).length < 6) {
    res.status(400).json({ error: 'invalid_credentials' });
    return;
  }

  const svc = getServiceClient();

  const { data: created, error: createErr } = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { agency_name: agencyName }
  });
  if (createErr) {
    const code = /already.*registered|already exists/i.test(createErr.message) ? 'email_already_registered' : 'signup_failed';
    res.status(409).json({ error: code, detail: createErr.message });
    return;
  }

  const userId = created.user.id;

  try {
    const agency = await provisionAgency(svc, { userId, agencyName });
    res.status(200).json({ agencyId: agency.id, slug: agency.slug });
  } catch (err) {
    // This path created the auth user moments ago, so deleting it on failure
    // is safe and lets the agency retry signup with the same email.
    await svc.auth.admin.deleteUser(userId).catch(() => {});
    res.status(500).json({ error: 'onboard_failed', detail: safeDetail(err) });
  }
}
