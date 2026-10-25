import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, showable, median, annualDebtService, MIN_COMPS } from '../api/_lib/financial.js';

/* Reference numbers produced by mexico_scout_platform/src/tools/math_engine.py (the Python model, itself tested):
   the JavaScript port must agree with it, or the two copies of the model have drifted apart. */
const REF = {"both_comps": {"better": "short_term", "breakeven": 0.4974, "cash": 267000.0, "s_rev": 36208.0, "s_noi": 15198.52, "s_cap": 0.0608, "s_roi": 0.0569, "s_coc": 0.0569, "s_adr": 160.0, "s_occ": 0.62, "l_rev": 19872.0, "l_noi": 10259.8, "l_cap": 0.041, "l_roi": 0.0384, "l_coc": 0.0384, "l_rent": 1800.0, "l_debt": 0.0, "sens": [[0.52, 11168.92, 0.0447], [0.62, 15198.52, 0.0608], [0.72, 19228.12, 0.0769]], "warn_n": 0}, "long_only": {"better": "short_term", "breakeven": 0.4189, "cash": 267000.0, "s_rev": 42997.0, "s_noi": 19882.93, "s_cap": 0.0795, "s_roi": 0.0745, "s_coc": 0.0745, "s_adr": 190.0, "s_occ": 0.62, "l_rev": 19872.0, "l_noi": 10259.8, "l_cap": 0.041, "l_roi": 0.0384, "l_coc": 0.0384, "l_rent": 1800.0, "l_debt": 0.0, "sens": [[0.52, 15097.78, 0.0604], [0.62, 19882.93, 0.0795], [0.72, 24668.08, 0.0987]], "warn_n": 2}, "defaults": {"better": "short_term", "breakeven": 0.2831, "cash": 267000.0, "s_rev": 42997.0, "s_noi": 19882.93, "s_cap": 0.0795, "s_roi": 0.0745, "s_coc": 0.0745, "s_adr": 190.0, "s_occ": 0.62, "l_rev": 12650.0, "l_noi": 3760.0, "l_cap": 0.015, "l_roi": 0.0141, "l_coc": 0.0141, "l_rent": 1145.8333, "l_debt": 0.0, "sens": [[0.52, 15097.78, 0.0604], [0.62, 19882.93, 0.0795], [0.72, 24668.08, 0.0987]], "warn_n": 3}, "financed": {"better": "short_term", "breakeven": 0.4189, "cash": 104500.0, "s_rev": 42997.0, "s_noi": 19882.93, "s_cap": 0.0795, "s_roi": 0.0745, "s_coc": 0.0163, "s_adr": 190.0, "s_occ": 0.62, "l_rev": 19872.0, "l_noi": 10259.8, "l_cap": 0.041, "l_roi": 0.0384, "l_coc": -0.0758, "l_rent": 1800.0, "l_debt": 18176.56, "sens": [[0.52, 15097.78, 0.0604], [0.62, 19882.93, 0.0795], [0.72, 24668.08, 0.0987]], "warn_n": 1}, "cancun3": {"better": "short_term", "breakeven": 0.3669, "cash": 320000.0, "s_rev": 55845.0, "s_noi": 27973.05, "s_cap": 0.0932, "s_roi": 0.0874, "s_coc": 0.0874, "s_adr": 225.0, "s_occ": 0.68, "l_rev": 20700.0, "l_noi": 10230.0, "l_cap": 0.0341, "l_roi": 0.032, "l_coc": 0.032, "l_rent": 1875.0, "l_debt": 0.0, "sens": [[0.58, 22306.43, 0.0744], [0.68, 27973.05, 0.0932], [0.78, 33639.68, 0.1121]], "warn_n": 3}};

const S = { priceUsd: 250000, bedrooms: 2, town: 'Tulum' };
const comps = (operation, prices, bedrooms = 2) => prices.map((p) => ({ operation, priceUsd: p, bedrooms }));
const near = (a, b, tol = 0.011) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

function check(report, ref) {
  assert.equal(report.betterTrack, ref.better);
  if (ref.breakeven === null) assert.equal(report.breakevenOccupancy, null); else near(report.breakevenOccupancy, ref.breakeven, 0.0002);
  near(report.totalCashInvestedUsd, ref.cash);
  near(report.shortTerm.revenueGrossUsd, ref.s_rev); near(report.shortTerm.noiUsd, ref.s_noi); near(report.shortTerm.capRate, ref.s_cap, 0.00011);
  near(report.shortTerm.unleveredRoi, ref.s_roi, 0.00011); near(report.shortTerm.cashOnCash, ref.s_coc, 0.00011);
  near(report.shortTerm.details.adr_usd, ref.s_adr, 0.0002); near(report.shortTerm.details.occupancy, ref.s_occ, 0.0002);
  near(report.longTerm.revenueGrossUsd, ref.l_rev); near(report.longTerm.noiUsd, ref.l_noi); near(report.longTerm.capRate, ref.l_cap, 0.00011);
  near(report.longTerm.unleveredRoi, ref.l_roi, 0.00011); near(report.longTerm.cashOnCash, ref.l_coc, 0.00011);
  near(report.longTerm.details.monthly_rent_usd, ref.l_rent, 0.02); near(report.longTerm.annualDebtServiceUsd, ref.l_debt, 0.02);
  assert.equal(report.warnings.length, ref.warn_n);
  report.sensitivity.forEach((s, i) => { near(s.occupancy, ref.sens[i][0], 0.0001); near(s.shortTermNoiUsd, ref.sens[i][1]); near(s.shortTermCapRate, ref.sens[i][2], 0.00011); });
}

test('port parity: both tracks from comps', () => {
  check(analyze(S, [...comps('rental_short', [150, 160, 170]), ...comps('rental_long', [1700, 1800, 1900])], { scope: 'neighborhood' }), REF.both_comps);
});
test('port parity: long-term from comps, short-term from defaults', () => {
  check(analyze(S, comps('rental_long', [1700, 1800, 1900]), { scope: 'town' }), REF.long_only);
});
test('port parity: no comps at all', () => { check(analyze(S, [], { scope: 'none' }), REF.defaults); });
test('port parity: financed purchase (35% down, 9.5%, 20 years)', () => {
  check(analyze(S, comps('rental_long', [1800, 1800, 1800]), { scope: 'neighborhood', assumptions: { downPaymentPct: 0.35 } }), REF.financed);
});
test('port parity: a 3-bedroom in Cancún uses that market\'s defaults', () => {
  check(analyze({ priceUsd: 300000, bedrooms: 3, town: 'Cancún' }, [], { scope: 'none' }), REF.cancun3);
});

test('helpers: median, debt service, minimum comps', () => {
  assert.equal(median([3, 1, 2]), 2); assert.equal(median([1, 2, 3, 4]), 2.5); assert.equal(median([]), null);
  near(annualDebtService(100000, 0.06, 30), 7194.61, 0.5); assert.equal(annualDebtService(0, 0.06, 30), 0);
  assert.equal(MIN_COMPS, 3);
});

test('a track is shown to a buyer only when it rests on real comps, never on a default', () => {
  const both = analyze(S, [...comps('rental_short', [150, 160, 170]), ...comps('rental_long', [1700, 1800, 1900])], { scope: 'neighborhood' });
  assert.deepEqual(showable(both), { short: true, long: true });
  const rentOnly = analyze(S, comps('rental_long', [1700, 1800, 1900]), { scope: 'town' });
  assert.deepEqual(showable(rentOnly), { short: false, long: true });
  assert.deepEqual(showable(analyze(S, [], { scope: 'none' })), { short: false, long: false });
  assert.deepEqual(showable(analyze(S, comps('rental_long', [1800, 1800]), { scope: 'town' })), { short: false, long: false }, 'two comps are not enough');
  assert.deepEqual(showable(null), { short: false, long: false });
});

test('no price means no numbers, and an assumed currency is called out', () => {
  const none = analyze({ priceUsd: 0, bedrooms: 2, town: 'Tulum' }, []);
  assert.equal(none.shortTerm, null); assert.match(none.warnings[0], /no usable price/);
  assert.ok(analyze({ ...S, currencyAssumed: true }, []).warnings.some((w) => /currency/.test(w)));
});

test('income tax on rents is off by default and applies when set', () => {
  const base = analyze(S, comps('rental_long', [1800, 1800, 1800]), { scope: 'neighborhood' }).longTerm;
  const taxed = analyze(S, comps('rental_long', [1800, 1800, 1800]), { scope: 'neighborhood', assumptions: { rentalTaxRateOnGross: 0.25 } }).longTerm;
  assert.equal(base.details.income_tax, 0);
  near(taxed.noiUsd, base.noiUsd - base.revenueGrossUsd * 0.25, 0.05);
});
