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
import { safeDetail, logDegraded } from './_lib/health.js';
import { provisionAgency } from './_lib/agency.js';
import { PLANS, MINI_PRICE_MXN, MINI_PERIOD_DAYS } from './_lib/plans.js';
import { validateListingFields, validateAgencyFields, BUSINESS_TYPE_KEYS } from './_lib/listing-fields.js';
import { notifyOperator } from './_lib/notify.js';
import { waitUntil } from '@vercel/functions';

/* ── PropLync Mini: self-serve signup (?action=mini, ?action=mini-status) ──────
   WHY A SECOND DOOR: the Mini page is sold from social ads to agents who have
   never heard of us (docs/CONTEXT-MAP.md, "Mini pages"), so an invite code is the
   wrong gate. What replaces it:
     - the agent has already proven the email with a Supabase code (the page
       does signInWithOtp/verifyOtp), so the request carries a real session;
     - one agency per account: an account that already belongs to an agency is
       sent to its dashboard instead of getting a second one;
     - nothing goes public before payment: the agency is created with plan
       `mini` and no paid period (plans.js pageActive), its listings are
       saved as drafts, and the operator is told there is a page to collect
       for. Paying (Mercado Pago later; by hand today with scripts/mini.mjs
       activate) publishes them for MINI_PERIOD_DAYS;
     - MINI_SIGNUP must be "on" in the environment, so the door can be closed
       in one setting without touching code or existing pages.
   The full SaaS stays invite-only through the handler below. */
export function miniSignupOpen(env = process.env) {
  return String(env.MINI_SIGNUP || '').toLowerCase() === 'on';
}

const PHONE = /^[0-9+()\-\s]{6,25}$/;

/** What the /mini preview sends for one property → listing fields, validated like a dashboard save. Throws on a bad field. */
export function miniListingFields(p) {
  const x = p && typeof p === 'object' ? p : {};
  const features = Array.isArray(x.features) ? x.features
    : String(x.features || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 30);
  const fields = validateListingFields({
    title_es: String(x.title || '').trim().slice(0, 300),
    town: String(x.town || '').trim().slice(0, 120),
    neighborhood: String(x.neighborhood || '').trim().slice(0, 120),
    bedrooms: x.bedrooms ?? 0, bathrooms: x.bathrooms ?? 0, parking: x.parking ?? 0,
    size: x.size ?? 0, amount: x.amount ?? 0,
    currency: x.currency, features
  });
  if (!fields.title_es) throw new Error('missing_title');
  if (!fields.currency) throw new Error('invalid_currency');
  // A draft until paid: drafts never reach the agency page or the search index.
  return { ...fields, operation: x.operation === 'rental' ? 'rental' : 'sale', status: 'draft' };
}

/* A service business signs up with services instead of properties (supabase/019).
   Kept to what the landing sends: a title and, optionally, a price. The panel edits the rest. */
export const MINI_SIGNUP_SERVICES = 20;
const PRICE_KINDS = ['fixed', 'from', 'per_m2', 'quote'];

/** One service from the signup → a mini_services row. Throws with the 400 code. */
export function miniServiceFields(x, i = 0) {
  const o = x && typeof x === 'object' ? x : { title_es: x };
  const title = String(o.title_es || o.title || '').trim();
  if (!title) throw new Error('missing_service_title');
  if (title.length > 120) throw new Error('service_title_too_long');
  const titleEn = o.title_en == null ? null : String(o.title_en).trim().slice(0, 120) || null;
  let price = o.price == null || o.price === '' ? null : Number(o.price);
  if (price !== null && (!Number.isFinite(price) || price < 0 || price > 1e10)) throw new Error('invalid_service_price');
  let kind = PRICE_KINDS.includes(o.price_kind) ? o.price_kind : (price !== null ? 'fixed' : 'quote');
  if (kind === 'quote') price = null;
  return { title_es: title, title_en: titleEn, price, price_kind: kind, currency: o.currency === 'USD' ? 'USD' : 'MXN', sort: i * 10, status: 'published' };
}

async function signedInUser(req, svc) {
  const authz = (req.headers && req.headers.authorization) || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : null;
  if (!token) return null;
  try {
    const { data, error } = await svc.auth.getUser(token);
    return error || !data ? null : data.user;
  } catch (err) {
    logDegraded('onboard:mini-auth', err);
    return null;
  }
}

/**
 * POST ?action=mini { agencyName, whatsapp_number, business_type?, listings: [...], services?: [...], address?, bio? } with the session.
 * Creates the agency on plan mini, not yet paid, and saves up to 10 listings as drafts and up to 20 services
 * (shown only once the page is paid); answers { slug }. It needs listings or services, at least one.
 * `deps` lets the tests replace the environment, the database and the operator alert.
 */
export async function handleMiniSignup(req, res, deps = {}) {
  if (!miniSignupOpen(deps.env || process.env)) { res.status(403).json({ error: 'mini_closed' }); return; }
  if (await enforceRateLimit(req, res, { bucket: 'onboard-mini', limit: 5, windowSec: 3600 })) return;
  const svc = deps.svc || getServiceClient();

  const user = await signedInUser(req, svc);
  if (!user) { res.status(401).json({ error: 'sign_in_required' }); return; }

  const { agencyName, whatsapp_number: wa, listings, services, business_type: bt, address, bio } = req.body || {};
  const name = String(agencyName || '').trim();
  if (!name || name.length > 120) { res.status(400).json({ error: 'missing_agency_name' }); return; }
  const whatsapp = String(wa || '').trim();
  if (!PHONE.test(whatsapp)) { res.status(400).json({ error: 'invalid_whatsapp_number' }); return; }
  // No type sent = the original real-estate landing, so older pages and ads keep working.
  const businessType = bt == null || bt === '' ? 'real_estate' : bt;
  if (!BUSINESS_TYPE_KEYS.includes(businessType)) { res.status(400).json({ error: 'invalid_business_type' }); return; }
  const list = Array.isArray(listings) ? listings.slice(0, PLANS.mini.listings) : [];
  const svcList = Array.isArray(services) ? services.slice(0, MINI_SIGNUP_SERVICES) : [];
  // A page needs something to show: properties, services, or both.
  if (!list.length && !svcList.length) { res.status(400).json({ error: businessType === 'real_estate' ? 'no_listings' : 'no_services' }); return; }

  let rows, svcRows, extra;
  try {
    rows = list.map(miniListingFields); svcRows = svcList.map(miniServiceFields);
    // Optional on the landing: the business address (only if they want it shown) and one line about what they do.
    const opt = {};
    if (typeof address === 'string' && address.trim()) opt.address = address.trim();
    if (typeof bio === 'string' && bio.trim()) opt.bio = bio.trim();
    extra = validateAgencyFields(opt);
  } catch (err) { res.status(400).json({ error: err.message || 'invalid_listing' }); return; }

  // One agency per account. A returning agent goes to the dashboard they already have.
  const { data: member } = await svc.from('agency_members').select('agency_id').eq('user_id', user.id).limit(1).maybeSingle();
  if (member) { res.status(409).json({ error: 'already_has_agency' }); return; }

  let agency, inserted = [];
  try {
    agency = await (deps.provisionAgency || provisionAgency)(svc, { userId: user.id, agencyName: name, plan: 'mini' });
    // plan_expires_at stays null: not paid yet, so the page is not live (plans.js pageActive).
    const { error: upErr } = await svc.from('agencies')
      .update({ ...extra, whatsapp_number: whatsapp, plan_expires_at: null, business_type: businessType }).eq('id', agency.id);
    if (upErr) throw upErr;
    // The ids come back so the page can attach the photos the agent picked (uploaded
    // under <agencyId>/… once they are a member, then saved through my-listings).
    if (rows.length) {
      const { data, error: insErr } = await svc.from('listings')
        .insert(rows.map((r) => ({ ...r, agency_id: agency.id }))).select('id, public_id');
      if (insErr) throw insErr;
      inserted = data || [];
    }
    if (svcRows.length) {
      const { error: sErr } = await svc.from('mini_services').insert(svcRows.map((r) => ({ ...r, agency_id: agency.id })));
      if (sErr) throw sErr;
    }
  } catch (err) {
    logDegraded('onboard:mini', err);
    res.status(500).json({ error: 'mini_signup_failed', detail: safeDetail(err) });
    return;
  }

  /* Until Mercado Pago is connected, a person collects the payment, so tell them now. */
  const alert = (deps.notifyOperator || notifyOperator)({
    subject: `Mini: pagina lista para cobrar (${name})`,
    text: `${name} preparo su pagina (${businessType}) con ${[rows.length ? rows.length + ' propiedades' : '', svcRows.length ? svcRows.length + ' servicios' : ''].filter(Boolean).join(' y ')} ` +
      `y espera el pago (MXN ${MINI_PRICE_MXN}, ${MINI_PERIOD_DAYS} dias).\n` +
      `Correo: ${user.email || '-'}\nWhatsApp: ${whatsapp}\nSlug: ${agency.slug}\n\n` +
      `Cuando pague: node scripts/mini.mjs activate ${agency.slug}`
  }).catch((err) => logDegraded('onboard:mini-notify', err));
  if (deps.notifyOperator) await alert; else waitUntil(alert);

  res.status(200).json({
    slug: agency.slug, agency_id: agency.id, status: 'pending_payment', saved: rows.length, services_saved: svcRows.length,
    business_type: businessType,
    listings: inserted.map((l) => ({ id: l.id, public_id: l.public_id })),
    price_mxn: MINI_PRICE_MXN, period_days: MINI_PERIOD_DAYS
  });
}

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
    .select('id, email, agency_name, expires_at, used_at, plan')
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

  const action = String((req.query && req.query.action) || '');
  if (action === 'mini-status') { res.status(200).json({ open: miniSignupOpen() }); return; }
  if (action === 'mini') {
    if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
    return handleMiniSignup(req, res);
  }

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
    // The invite decides the plan. Master-code signups (no invite row) get pro
    // too: that path is the operator letting someone in deliberately.
    const plan = (claimedInvite && claimedInvite.plan) || 'pro';
    const agency = await provisionAgency(svc, { userId, agencyName, plan });
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
