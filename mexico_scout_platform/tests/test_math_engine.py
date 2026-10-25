import pytest

from src.models import Operation, PropertyListing, ScoredListing
from src.tools.math_engine import Assumptions, analyze, annual_debt_service, long_term_model, short_term_model


def listing(url, op, price, currency="USD", bd=2, town="Tulum", hood="Aldea Zama"):
    return PropertyListing(url=url, operation=op, town=town, neighborhood=hood, bedrooms=bd, price=price, currency=currency, m2_size=100, usd_mxn_rate=18.0)


SUBJECT = listing("https://x.mx/s", "sale", 250_000)


def comps(op, prices):
    return [ScoredListing(listing=listing(f"https://x.mx/{op}{i}", op, p), score=0.9) for i, p in enumerate(prices)]


def test_debt_service_matches_the_standard_formula():
    assert annual_debt_service(100_000, 0.06, 30) == pytest.approx(7194.61, abs=0.5)
    assert annual_debt_service(0, 0.06, 30) == 0
    assert annual_debt_service(120_000, 0, 10) == 12_000


def test_short_term_uses_comps_when_there_are_enough():
    short, warnings = short_term_model(SUBJECT, comps("rental_short", [150, 160, 170]), Assumptions())
    assert short.basis["adr"].startswith("median of 3")
    assert short.details["adr_usd"] == 160 / 2 * 2        # median 160 per 2-bed listing -> 80 per bedroom x 2 bedrooms
    assert short.details["occupancy"] == 0.62               # Tulum default: comps never carry occupancy
    assert short.basis["occupancy"] == "default_assumption"
    assert short.revenue_gross_usd == pytest.approx(160 * 365 * 0.62, abs=0.01)
    assert warnings == []


def test_short_term_falls_back_to_defaults_and_says_so():
    short, warnings = short_term_model(SUBJECT, comps("rental_short", [150]), Assumptions())
    assert short.basis["adr"] == "default_assumption"
    assert short.details["adr_usd"] == 95 * 2
    assert "Only 1 short-term comp" in warnings[0]


def test_noi_cap_rate_and_costs_add_up():
    short, _ = short_term_model(SUBJECT, comps("rental_short", [150, 150, 150]), Assumptions())
    d = short.details
    expected_costs = 250_000 * (0.003 + 0.0025 + 0.01) + 750 + 250 * 12 + short.revenue_gross_usd * (0.03 + 0.20 + 0.08) + 180 * 12
    assert short.operating_expenses_usd == pytest.approx(expected_costs, abs=0.05)
    assert short.noi_usd == pytest.approx(short.revenue_gross_usd - expected_costs, abs=0.05)
    assert short.cap_rate == pytest.approx(short.noi_usd / 250_000, abs=1e-4)
    assert d["property_tax"] == 750 and d["fideicomiso_fee"] == 750          # 0.3% predial; US$750/yr trust fee
    assert short.cash_invested_usd == 250_000 * 1.06 + 2000                  # all cash: price + 6% closing + trust set-up


def test_long_term_yield_and_vacancy():
    long, warnings = long_term_model(SUBJECT, comps("rental_long", [1700, 1800, 1900]), Assumptions())
    assert long.details["monthly_rent_usd"] == 1800
    assert long.details["monthly_rental_yield"] == pytest.approx(1800 / 250_000)
    assert long.revenue_gross_usd == pytest.approx(1800 * 12 * 0.92, abs=0.01)
    assert warnings == []
    default, w = long_term_model(SUBJECT, [], Assumptions())
    assert default.details["monthly_rent_usd"] == pytest.approx(250_000 * 0.055 / 12)
    assert default.basis["rent"] == "default_assumption" and w


def test_financing_changes_cash_on_cash_not_cap_rate():
    cash = analyze(SUBJECT, comps("rental_long", [1800] * 3), comps_scope="neighborhood")
    levered = analyze(SUBJECT, comps("rental_long", [1800] * 3), comps_scope="neighborhood", assumptions=Assumptions(down_payment_pct=0.35))
    assert cash.long_term.cap_rate == levered.long_term.cap_rate
    assert levered.long_term.annual_debt_service_usd > 0 and cash.long_term.annual_debt_service_usd == 0
    assert levered.long_term.cash_invested_usd < cash.long_term.cash_invested_usd


def test_report_compares_tracks_and_computes_breakeven_and_sensitivity():
    report = analyze(SUBJECT, comps("rental_short", [200, 210, 220]) + comps("rental_long", [1500, 1500, 1500]), comps_scope="neighborhood")
    assert report.better_track in ("short_term", "long_term")
    assert [s["occupancy"] for s in report.sensitivity] == [0.52, 0.62, 0.72]
    assert report.sensitivity[0]["short_term_noi_usd"] < report.sensitivity[1]["short_term_noi_usd"] < report.sensitivity[2]["short_term_noi_usd"]
    # at the break-even occupancy the two NOIs are equal
    assert report.breakeven_occupancy is not None
    at_breakeven, _ = short_term_model(SUBJECT, comps("rental_short", [200, 210, 220]), Assumptions(), occupancy=report.breakeven_occupancy)
    # breakeven_occupancy is rounded to 4 decimals (0.01 points of occupancy is worth about US$5 here), hence the tolerance
    assert at_breakeven.noi_usd == pytest.approx(report.long_term.noi_usd, abs=6.0)


def test_warnings_for_missing_price_assumed_currency_and_thin_comps():
    no_price = PropertyListing(url="https://x.mx/n", operation="sale", town="Tulum")
    r = analyze(no_price, [])
    assert r.short_term is None and "no usable price" in r.warnings[0]
    assumed = PropertyListing(url="https://x.mx/a", operation="sale", town="Tulum", neighborhood="Aldea Zama", bedrooms=2, price=4_500_000, usd_mxn_rate=18.0)
    r = analyze(assumed, [], comps_scope="none")
    text = " ".join(r.warnings)
    assert "currency" in text and "No comps were found" in text
    rental = analyze(listing("https://x.mx/r", "rental_long", 1800), [])
    assert "not a for-sale listing" in rental.warnings[0]


def test_rental_income_tax_is_off_by_default_and_applies_when_set():
    base = long_term_model(SUBJECT, comps("rental_long", [1800] * 3), Assumptions())[0]
    taxed = long_term_model(SUBJECT, comps("rental_long", [1800] * 3), Assumptions(rental_tax_rate_on_gross=0.25))[0]
    assert base.details["income_tax"] == 0
    assert taxed.noi_usd == pytest.approx(base.noi_usd - base.revenue_gross_usd * 0.25, abs=0.05)
