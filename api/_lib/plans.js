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
  free: { id: 'free', label: 'Gratis',  listings: 10,       photos: 10, agents: 1,  marketing: false, marketingTrials: 1,        instagram: false },
  pro:  { id: 'pro',  label: 'Pro',     listings: Infinity, photos: 30, agents: 4,  marketing: true,  marketingTrials: Infinity, instagram: true  },
  vip:  { id: 'vip',  label: 'VIP',     listings: Infinity, photos: 30, agents: 10, marketing: true,  marketingTrials: Infinity, instagram: true  }
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
      instagram: plan.instagram
    }
  };
}
