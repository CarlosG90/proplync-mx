/**
 * Proplync.mx · Plan tiers and their caps
 * -----------------------------------------------------------------------------
 * A free tier with a listing cap is what makes the public listing worth paying
 * to escape, and it doubles as abuse control now that owners can publish
 * without an agency behind them.
 *
 * The caps live here, once, because they are enforced in two places that must
 * agree: api/my-listings.js on write, and dashboard.html in the UI. A limit the
 * client shows but the server does not enforce is decoration.
 *
 * `plan` may not exist on a given row yet (the column is added by schema.sql,
 * and older rows predate it), so planFor() treats anything unrecognised as
 * free. Failing closed to the cheapest tier is the safe direction: the worst
 * case is asking someone to upgrade, not silently handing out paid limits.
 * -----------------------------------------------------------------------------
 */

export const PLANS = {
  // `marketingTrials` is how many real generations a plan gets from inside the
  // dashboard before the paywall. Free gets one on purpose: an agency that has
  // seen the seven formats built from their own listing is a far better
  // conversation than one reading a feature list.
  //
  // `reelsPerMonth` is the one cap here that is about money rather than
  // packaging. Every other limit costs us nothing to raise — Groq's copy
  // generation is a free tier, photos are Sharp on a function we already pay
  // for. A Runway Reel bills real credits on every single run, so
  // `marketing: true` deliberately does NOT mean unlimited video the way it
  // means unlimited copy.
  //
  // The numbers, measured against Runway rather than estimated:
  //   gen4.5 costs 12 credits per second of output.
  //   A standard Reel (hook + 3 scenes + CTA) is 17s = 204 credits.
  //   So pro at 8/mo = ~1,632 credits/mo, vip at 25/mo = ~5,100.
  // The account's own ceiling is maxMonthlyCreditSpend (10,000 when this was
  // written), which is roughly 49 Reels a month across EVERY agency combined.
  // Raising these two numbers without raising that ceiling just moves where
  // the failure lands — from a clean "quota reached" to Runway refusing
  // mid-Reel. Check the Runway plan before raising them.
  //
  // Free gets none: the marketing trial exists to show an agency the seven
  // formats, and it can do that with the still-photo Reel the canvas renderer
  // has always produced.
  free: { id: 'free', label: 'Gratis',  listings: 10,       photos: 10, agents: 1,  marketing: false, marketingTrials: 1,        instagram: false, reelsPerMonth: 0  },
  pro:  { id: 'pro',  label: 'Pro',     listings: Infinity, photos: 30, agents: 4,  marketing: true,  marketingTrials: Infinity, instagram: true,  reelsPerMonth: 8  },
  vip:  { id: 'vip',  label: 'VIP',     listings: Infinity, photos: 30, agents: 10, marketing: true,  marketingTrials: Infinity, instagram: true,  reelsPerMonth: 25 }
};

export const DEFAULT_PLAN = 'free';

/** Resolve a plan record from whatever the agency row carries. */
export function planFor(agency) {
  const key = String((agency && agency.plan) || DEFAULT_PLAN).toLowerCase();
  return PLANS[key] || PLANS[DEFAULT_PLAN];
}

/**
 * Whether this agency may generate marketing from inside the dashboard right
 * now, and why not when it may not. Trials are counted on the agency row, so
 * clearing browser storage does not hand out another one.
 */
export function marketingAccess(agency) {
  const plan = planFor(agency);
  if (plan.marketing) return { allowed: true, reason: 'plan', trialsLeft: null };
  const used = Number((agency && agency.marketing_trials_used) || 0);
  const left = Math.max(0, plan.marketingTrials - used);
  return {
    allowed: left > 0,
    reason: left > 0 ? 'trial' : 'upgrade_required',
    trialsLeft: left
  };
}

/**
 * Whether this agency may generate a Runway Reel right now.
 *
 * Separate from marketingAccess() because it answers a different question:
 * marketing access is "has this agency paid for the module", reel access is
 * "has this agency spent this month's video budget". A Pro agency passes the
 * first and can still fail the second.
 *
 * @param {object} agency  the agency row
 * @param {number} usedThisMonth  reel_jobs rows for this agency since the 1st,
 *   counted by the caller (api/reel.js) — plans.js stays free of DB access.
 */
export function reelAccess(agency, usedThisMonth) {
  const plan = planFor(agency);
  const limit = plan.reelsPerMonth || 0;
  const used = Number(usedThisMonth || 0);
  const left = Math.max(0, limit - used);
  if (limit === 0) return { allowed: false, reason: 'upgrade_required', left: 0, limit };
  return {
    allowed: left > 0,
    reason: left > 0 ? 'quota' : 'quota_exhausted',
    left,
    limit
  };
}

/** Client-safe view of a plan plus current usage. */
export function planStatus(agency, listingCount) {
  const plan = planFor(agency);
  const marketing = marketingAccess(agency);
  return {
    plan: plan.id,
    label: plan.label,
    listingsUsed: listingCount,
    listingsLimit: plan.listings === Infinity ? null : plan.listings,
    photosPerListing: plan.photos,
    atListingLimit: listingCount >= plan.listings,
    // Drives the lock on the dashboard's Marketing button. The server enforces
    // the same rule in api/generate.js; this only decides what the UI shows.
    marketing: {
      included: plan.marketing,
      allowed: marketing.allowed,
      trialsLeft: marketing.trialsLeft,
      instagram: plan.instagram,
      // The dashboard shows "3 of 8 Reels left this month"; the count itself
      // comes from api/reel.js, which is the only place that queries reel_jobs.
      reelsPerMonth: plan.reelsPerMonth
    }
  };
}
