/**
 * Proplync.mx · Rental-return estimate for one for-sale property: short-term vs long-term
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * Scout finds properties; an investor then asks "what would it earn?". This is the same model as
 * mexico_scout_platform/src/tools/math_engine.py (its tests are the reference: financial.test.mjs checks both give
 * the same numbers), ported to JavaScript because Scout runs on Vercel Hobby (10 s functions) where a Python worker
 * does not fit. It is plain arithmetic: no network, no model.
 *
 * HONESTY RULES (what makes it safe to show a buyer)
 *  - Every headline input says where it came from: `comps` (a median of real listings in the search index) or
 *    `default_assumption` (the editable tables below). A default is a starting point, never market data.
 *  - Comps give prices, not occupancy: occupancy is always an assumption unless overridden.
 *  - Fewer than MIN_COMPS comps -> that track falls back to defaults and says so.
 *  - The screen shows a track only when its main input is `comps` (see showable()). A default alone is not shown.
 *  - Predial (property tax) is 0.3% of price (range 0.1-0.5%); a foreign owner's fideicomiso costs about US$750 a
 *    year plus a set-up cost; closing costs 6%. Income tax on rents is NOT modelled unless asked.
 *  This is a screening model on asking prices, not tax, legal or financial advice.
 *
 * All money is USD. Rates are fractions.
 * -----------------------------------------------------------------------------
 */

export const MIN_COMPS = 3;

/* Editable starting points, NOT data. Same table as math_engine.py.

   UNSOURCED, AND THE OCCUPANCY LOOKS HIGH (checked 2026-10-31). AirDNA's public Quintana Roo pages showed about 54% occupancy for
   Cancún and 31-46% for Tulum (two pages disagreed), against 68% and 62% here; Playa del Carmen and Puerto Morelos could not be
   read (AirDNA answers automated requests with 403). Nothing here reaches a buyer today: showable() needs the nightly rate to come
   from 3+ real comps, and loadRentComps() passes only long-term rents. Before short-term is ever shown, replace these with a
   sourced figure (a market-data vendor, or occupancy agencies enter themselves) and keep the card saying the occupancy is assumed.
   The ADR per bedroom and long-term yields below are equally unsourced. */
export const MARKET_DEFAULTS = {
  'Cancún': { occupancy: 0.68, adrPerBedroomUsd: 75, ltrGrossYield: 0.075 },
  'Playa del Carmen': { occupancy: 0.66, adrPerBedroomUsd: 80, ltrGrossYield: 0.065 },
  'Tulum': { occupancy: 0.62, adrPerBedroomUsd: 95, ltrGrossYield: 0.055 },
  'Puerto Morelos': { occupancy: 0.58, adrPerBedroomUsd: 60, ltrGrossYield: 0.060 }
};
const FALLBACK_MARKET = { occupancy: 0.62, adrPerBedroomUsd: 75, ltrGrossYield: 0.060 };

export const DEFAULT_ASSUMPTIONS = Object.freeze({
  closingCostPct: 0.06, fideicomisoSetupUsd: 2000, foreignBuyer: true,
  propertyTaxPct: 0.003, fideicomisoAnnualUsd: 750, insurancePct: 0.0025, maintenancePct: 0.01, hoaMonthlyUsd: 250,
  strPlatformFeePct: 0.03, strManagementPct: 0.20, strSuppliesPct: 0.08, strUtilitiesMonthlyUsd: 180, occupancyOverride: null,
  ltrVacancyPct: 0.08, ltrManagementPct: 0.10, ltrUtilitiesMonthlyUsd: 0,
  rentalTaxRateOnGross: 0,
  downPaymentPct: null, mortgageRate: 0.095, mortgageYears: 20
});

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const r4 = (n) => Math.round((n + Number.EPSILON) * 10000) / 10000;

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export function annualDebtService(loan, rate, years) {
  if (!(loan > 0) || !(years > 0)) return 0;
  const monthly = rate / 12;
  const n = years * 12;
  if (monthly === 0) return loan / years;
  return (loan * monthly / (1 - Math.pow(1 + monthly, -n))) * 12;
}

const market = (town) => MARKET_DEFAULTS[town] || FALLBACK_MARKET;
const perBedroom = (c) => (Number.isFinite(c.priceUsd) && c.priceUsd > 0 ? c.priceUsd / Math.max(c.bedrooms || 0, 1) : null);
const compsOf = (comps, operation) => (comps || []).filter((c) => c.operation === operation && perBedroom(c) !== null);

function ownershipCosts(price, a) {
  return {
    property_tax: price * a.propertyTaxPct,
    fideicomiso_fee: a.foreignBuyer ? a.fideicomisoAnnualUsd : 0,
    insurance: price * a.insurancePct,
    maintenance: price * a.maintenancePct,
    hoa: a.hoaMonthlyUsd * 12
  };
}

function cashInvested(price, a) {
  const closing = price * a.closingCostPct + (a.foreignBuyer ? a.fideicomisoSetupUsd : 0);
  const down = a.downPaymentPct !== null ? price * a.downPaymentPct : price;
  return down + closing;
}

function finish(track, basis, revenue, costs, price, cash, debtService, extra, a) {
  const tax = revenue * a.rentalTaxRateOnGross;
  const opex = Object.values(costs).reduce((s, v) => s + v, 0);
  const noi = revenue - opex - tax;
  const roiBase = price * (1 + a.closingCostPct) + (a.foreignBuyer ? a.fideicomisoSetupUsd : 0);
  const details = {};
  for (const [k, v] of Object.entries(costs)) details[k] = r2(v);
  details.income_tax = r2(tax);
  for (const [k, v] of Object.entries(extra)) details[k] = r4(v);
  return {
    track, basis,
    revenueGrossUsd: r2(revenue), operatingExpensesUsd: r2(opex + tax), noiUsd: r2(noi),
    capRate: r4(noi / price), cashInvestedUsd: r2(cash), unleveredRoi: r4(noi / roiBase),
    cashOnCash: cash > 0 ? r4((noi - debtService) / cash) : 0,
    annualDebtServiceUsd: r2(debtService), details
  };
}

const loanOf = (price, a) => (a.downPaymentPct !== null ? price * (1 - a.downPaymentPct) : 0);

export function shortTermModel(subject, comps, a, occupancy = null) {
  const price = subject.priceUsd || 0;
  const mk = market(subject.town);
  const bedrooms = Math.max(subject.bedrooms || 0, 1);
  const warnings = [];

  const nightly = compsOf(comps, 'rental_short').map(perBedroom);
  let adr, adrBasis;
  if (nightly.length >= MIN_COMPS) {
    adr = median(nightly) * bedrooms;
    adrBasis = `median of ${nightly.length} short-term comps (per bedroom x ${bedrooms})`;
  } else {
    adr = mk.adrPerBedroomUsd * bedrooms;
    adrBasis = 'default_assumption';
    warnings.push(`Only ${nightly.length} short-term comp(s): ADR uses the default of $${mk.adrPerBedroomUsd.toFixed(0)} per bedroom per night.`);
  }
  const overridden = occupancy !== null || a.occupancyOverride !== null;
  const occ = occupancy !== null ? occupancy : (a.occupancyOverride !== null ? a.occupancyOverride : mk.occupancy);
  const revenue = adr * 365 * occ;

  const costs = ownershipCosts(price, a);
  costs.platform_fees = revenue * a.strPlatformFeePct;
  costs.management = revenue * a.strManagementPct;
  costs.supplies_cleaning = revenue * a.strSuppliesPct;
  costs.utilities = a.strUtilitiesMonthlyUsd * 12;

  const result = finish('short_term', { adr: adrBasis, occupancy: overridden ? 'override' : 'default_assumption' }, revenue, costs, price,
    cashInvested(price, a), annualDebtService(loanOf(price, a), a.mortgageRate, a.mortgageYears),
    { adr_usd: adr, occupancy: occ, nights_sold: 365 * occ }, a);
  return { result, warnings };
}

export function longTermModel(subject, comps, a) {
  const price = subject.priceUsd || 0;
  const mk = market(subject.town);
  const bedrooms = Math.max(subject.bedrooms || 0, 1);
  const warnings = [];

  const monthly = compsOf(comps, 'rental_long').map(perBedroom);
  let rent, rentBasis;
  if (monthly.length >= MIN_COMPS) {
    rent = median(monthly) * bedrooms;
    rentBasis = `median of ${monthly.length} long-term comps (per bedroom x ${bedrooms})`;
  } else {
    rent = price * mk.ltrGrossYield / 12;
    rentBasis = 'default_assumption';
    warnings.push(`Only ${monthly.length} long-term comp(s): rent uses the default gross yield of ${(mk.ltrGrossYield * 100).toFixed(1)}% of price.`);
  }
  const grossPotential = rent * 12;
  const revenue = grossPotential * (1 - a.ltrVacancyPct);
  const costs = ownershipCosts(price, a);
  costs.management = revenue * a.ltrManagementPct;
  costs.utilities = a.ltrUtilitiesMonthlyUsd * 12;

  const result = finish('long_term', { rent: rentBasis, vacancy: 'default_assumption' }, revenue, costs, price,
    cashInvested(price, a), annualDebtService(loanOf(price, a), a.mortgageRate, a.mortgageYears),
    { monthly_rent_usd: rent, monthly_rental_yield: price ? rent / price : 0, gross_annual_yield: price ? grossPotential / price : 0 }, a);
  return { result, warnings };
}

/** Occupancy at which short-term NOI equals long-term NOI (revenue scales with occupancy, fixed costs do not). */
export function breakevenOccupancy(short, long) {
  const adr = short.details.adr_usd;
  if (!adr || short.revenueGrossUsd <= 0) return null;
  const variable = ['platform_fees', 'management', 'supplies_cleaning', 'income_tax'].reduce((s, k) => s + (short.details[k] || 0), 0);
  const v = variable / short.revenueGrossUsd;
  if (v >= 1) return null;
  const fixed = short.operatingExpensesUsd - variable;
  const occupancy = ((long.noiUsd + fixed) / (1 - v)) / (adr * 365);
  return occupancy > 0 && occupancy < 1.5 ? r4(occupancy) : null;
}

/**
 * @param {{priceUsd:number, bedrooms:number|null, town:string|null, currencyAssumed?:boolean}} subject
 * @param {{operation:'rental_short'|'rental_long', priceUsd:number, bedrooms:number|null}[]} comps
 * @param {{scope?:string, assumptions?:object}} [opts]  scope: 'neighborhood' | 'town' | 'none'
 */
export function analyze(subject, comps, { scope = 'none', assumptions = {} } = {}) {
  const a = { ...DEFAULT_ASSUMPTIONS, ...assumptions };
  const warnings = [];
  if (!(subject && subject.priceUsd > 0)) {
    return { purchasePriceUsd: 0, compsScope: scope, shortTerm: null, longTerm: null, betterTrack: null, breakevenOccupancy: null,
      sensitivity: [], warnings: ['The property has no usable price in USD: no returns can be computed.'] };
  }
  if (subject.currencyAssumed) warnings.push('The listing\'s price had no currency; one was assumed. Confirm it before relying on the numbers.');
  if (scope === 'town') warnings.push('Comps come from the whole town: too few in the same neighbourhood.');
  if (scope === 'none') warnings.push('No comps were found: every rental figure is a default assumption.');

  const s = shortTermModel(subject, comps, a);
  const l = longTermModel(subject, comps, a);
  warnings.push(...s.warnings, ...l.warnings);

  const sensitivity = [-0.10, 0, 0.10].map((delta) => {
    const occ = Math.min(Math.max(s.result.details.occupancy + delta, 0.05), 0.95);
    const v = shortTermModel(subject, comps, a, occ).result;
    return { occupancy: r2(occ), shortTermNoiUsd: v.noiUsd, shortTermCapRate: v.capRate };
  });

  return {
    purchasePriceUsd: r2(subject.priceUsd), totalCashInvestedUsd: s.result.cashInvestedUsd, compsScope: scope,
    shortTerm: s.result, longTerm: l.result,
    betterTrack: s.result.noiUsd > l.result.noiUsd ? 'short_term' : 'long_term',
    breakevenOccupancy: breakevenOccupancy(s.result, l.result), sensitivity, warnings, assumptions: a
  };
}

/**
 * Which tracks may be shown to a buyer: only those whose main input is a real comp median. A default is never shown
 * as an estimate. (Occupancy is always an assumption; it is labelled as one on the card.)
 */
export function showable(report) {
  if (!report || !report.shortTerm || !report.longTerm) return { short: false, long: false };
  return {
    short: report.shortTerm.basis.adr.startsWith('median'),
    long: report.longTerm.basis.rent.startsWith('median')
  };
}
