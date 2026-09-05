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
  free: { id: 'free', label: 'Gratis',  listings: 10,       photos: 10, agents: 1  },
  pro:  { id: 'pro',  label: 'Pro',     listings: Infinity, photos: 30, agents: 4  },
  vip:  { id: 'vip',  label: 'VIP',     listings: Infinity, photos: 30, agents: 10 }
};

export const DEFAULT_PLAN = 'free';

/** Resolve a plan record from whatever the agency row carries. */
export function planFor(agency) {
  const key = String((agency && agency.plan) || DEFAULT_PLAN).toLowerCase();
  return PLANS[key] || PLANS[DEFAULT_PLAN];
}

/** Client-safe view of a plan plus current usage. */
export function planStatus(agency, listingCount) {
  const plan = planFor(agency);
  return {
    plan: plan.id,
    label: plan.label,
    listingsUsed: listingCount,
    listingsLimit: plan.listings === Infinity ? null : plan.listings,
    photosPerListing: plan.photos,
    atListingLimit: listingCount >= plan.listings
  };
}
