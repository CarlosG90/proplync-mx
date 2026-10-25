/**
 * Proplync.mx · Return estimates for Scout's for-sale candidates
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * An investor reading Scout's results wants to know what a property could earn. financial.js holds the model; this
 * file feeds it real rental comps from the search index and decides what the buyer is allowed to see.
 *
 * WHAT IS SHOWN, AND WHAT IS NOT
 *  - Only for buyers whose brief is about renting or investing (investorBrief): someone buying a home to live in
 *    does not need a yield table.
 *  - Only a track that rests on at least three real comps in the same neighbourhood or town (financial.showable).
 *    The search index holds monthly rents only, so today only the long-term track can qualify; a short-term estimate
 *    needs nightly-rate comps that PropLync does not collect yet, and a default assumption is never shown as an estimate.
 *  - Asking prices, not sale prices; occupancy and costs are assumptions. The card says so.
 * -----------------------------------------------------------------------------
 */

import { analyze, showable, MIN_COMPS } from './financial.js';

export function investorBrief(brief) {
  const text = `${brief && brief.purpose ? brief.purpose : ''} ${brief && Array.isArray(brief.must_haves) ? brief.must_haves.join(' ') : ''}`.toLowerCase();
  return /invers|invest|rent|alquil|airbnb|vacacional|rendimiento|yield|retorno|roi/.test(text);
}

/** Monthly-rent comps for the towns of these candidates, from search_properties (price_mxn_min is MXN per month for rentals). */
export async function loadRentComps(svc, towns, fx) {
  const list = [...new Set((towns || []).filter(Boolean))];
  if (!list.length) return [];
  const { data, error } = await svc.from('search_properties')
    .select('town, neighborhood, bedrooms, price_mxn_min')
    .eq('operation', 'rental').in('town', list).not('price_mxn_min', 'is', null).limit(300);
  if (error) throw error;
  return (data || []).map((r) => ({
    operation: 'rental_long', town: r.town, neighborhood: r.neighborhood,
    bedrooms: r.bedrooms === null ? null : Number(r.bedrooms), priceUsd: Number(r.price_mxn_min) / fx
  })).filter((r) => r.priceUsd > 0);
}

function nearBedrooms(list, bedrooms) {
  return bedrooms === null || bedrooms === undefined ? list : list.filter((c) => c.bedrooms !== null && Math.abs(c.bedrooms - bedrooms) <= 1);
}

/** What the card may show for one candidate, or null. `rentComps` come from loadRentComps. */
export function financialsFor(candidate, rentComps, fx) {
  if (!candidate || candidate.operation !== 'sale' || !(Number(candidate.lowest_price_mxn) > 0)) return null;
  const subject = { priceUsd: Number(candidate.lowest_price_mxn) / fx, bedrooms: candidate.bedrooms === null ? null : Number(candidate.bedrooms), town: candidate.town };
  const sameTown = nearBedrooms(rentComps.filter((c) => c.town === candidate.town), subject.bedrooms);
  const sameHood = candidate.neighborhood ? sameTown.filter((c) => c.neighborhood === candidate.neighborhood) : [];
  const [used, scope] = sameHood.length >= MIN_COMPS ? [sameHood, 'neighborhood'] : sameTown.length ? [sameTown, 'town'] : [[], 'none'];
  const report = analyze(subject, used, { scope });
  const ok = showable(report);
  if (!ok.long && !ok.short) return null;
  const out = { comps_used: used.length, comps_scope: scope, purchase_price_usd: report.purchasePriceUsd, long_term: null, short_term: null };
  if (ok.long) {
    const l = report.longTerm;
    out.long_term = { monthly_rent_usd: l.details.monthly_rent_usd, gross_yield: l.details.gross_annual_yield, cap_rate: l.capRate,
      noi_usd: l.noiUsd, cash_on_cash: l.cashOnCash };
  }
  if (ok.short) {
    const s = report.shortTerm;
    out.short_term = { adr_usd: s.details.adr_usd, occupancy_assumed: s.details.occupancy, cap_rate: s.capRate, noi_usd: s.noiUsd,
      breakeven_occupancy: report.breakevenOccupancy };
  }
  return out;
}
