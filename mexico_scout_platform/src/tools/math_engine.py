"""Pure-Python financial model: short-term (vacation) vs long-term rental, for one property and its local comps.

WHY THIS EXISTS
Money maths must be exact, repeatable and auditable, so it is plain Python with no LLM and no network. The analyst
agent decides *which* comps and *what to say*; this module decides every number.

HONESTY RULES (the part that matters)
  * Every headline input says where it came from: `comps` (medians of real listings found in Qdrant) or
    `default_assumption` (the editable tables below). A report never presents an assumption as market data.
  * Comps give prices, not occupancy. Occupancy always comes from the assumptions unless the caller overrides it.
  * Too few comps (< MIN_COMPS) -> fall back to defaults and add a warning. Nothing is invented to fill a gap.
  * Taxes: Mexican property tax (predial) is modelled at 0.3% of price (the 0.1%-0.5% range is configurable).
    A foreign owner's fideicomiso (bank trust) costs a yearly fee of about US$500-1,000 plus a set-up cost, both modelled.
    Income tax on rental income is NOT modelled by default (regime-dependent: set `rental_tax_rate_on_gross`).
    This is a screening model, not tax or legal advice.

All money is USD. Rates are fractions (0.07 = 7%).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from statistics import median
from typing import Any

from src.models import Operation, PropertyListing, ScoredListing

MIN_COMPS = 3

# --- editable market assumptions (NOT data: starting points to be replaced as real comps accumulate) -----------------
# occupancy: annual average; adr_per_bedroom_usd: nightly rate per bedroom for a typical condo;
# ltr_gross_yield: annual long-term rent / price.
MARKET_DEFAULTS: dict[str, dict[str, float]] = {
    "Cancún": {"occupancy": 0.68, "adr_per_bedroom_usd": 75.0, "ltr_gross_yield": 0.075},
    "Playa del Carmen": {"occupancy": 0.66, "adr_per_bedroom_usd": 80.0, "ltr_gross_yield": 0.065},
    "Tulum": {"occupancy": 0.62, "adr_per_bedroom_usd": 95.0, "ltr_gross_yield": 0.055},
    "Puerto Morelos": {"occupancy": 0.58, "adr_per_bedroom_usd": 60.0, "ltr_gross_yield": 0.060},
}
FALLBACK_MARKET = {"occupancy": 0.62, "adr_per_bedroom_usd": 75.0, "ltr_gross_yield": 0.060}


@dataclass(frozen=True)
class Assumptions:
    # acquisition
    closing_cost_pct: float = 0.06  # ISAI transfer tax, notary, registry, due diligence
    fideicomiso_setup_usd: float = 2000.0  # bank trust set-up, foreign buyers in the restricted zone
    foreign_buyer: bool = True
    # yearly ownership costs
    property_tax_pct: float = 0.003  # predial: 0.1%-0.5% of value, midpoint
    fideicomiso_annual_usd: float = 750.0  # US$500-1,000
    insurance_pct: float = 0.0025
    maintenance_pct: float = 0.01
    hoa_monthly_usd: float = 250.0
    # short-term rental
    str_platform_fee_pct: float = 0.03
    str_management_pct: float = 0.20
    str_supplies_pct: float = 0.08  # cleaning, laundry, consumables not passed to guests
    str_utilities_monthly_usd: float = 180.0
    occupancy_override: float | None = None
    # long-term rental
    ltr_vacancy_pct: float = 0.08
    ltr_management_pct: float = 0.10
    ltr_utilities_monthly_usd: float = 0.0  # tenant pays
    # income tax on gross rents (0 = not modelled)
    rental_tax_rate_on_gross: float = 0.0
    # financing (None = all cash)
    down_payment_pct: float | None = None
    mortgage_rate: float = 0.095
    mortgage_years: int = 20


@dataclass
class TrackResult:
    track: str
    basis: dict[str, str]
    revenue_gross_usd: float
    operating_expenses_usd: float
    noi_usd: float
    cap_rate: float
    cash_invested_usd: float
    unlevered_roi: float
    cash_on_cash: float
    annual_debt_service_usd: float
    details: dict[str, float] = field(default_factory=dict)


@dataclass
class FinancialReport:
    subject_url: str
    purchase_price_usd: float
    total_cash_invested_usd: float
    comps_scope: str
    short_term: TrackResult | None
    long_term: TrackResult | None
    better_track: str | None
    breakeven_occupancy: float | None
    sensitivity: list[dict[str, float]]
    warnings: list[str]
    assumptions: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# --- helpers --------------------------------------------------------------------------------------------------------


def annual_debt_service(loan: float, rate: float, years: int) -> float:
    """Level yearly payment of an amortising loan (monthly compounding)."""
    if loan <= 0 or years <= 0:
        return 0.0
    monthly = rate / 12
    n = years * 12
    if monthly == 0:
        return loan / years
    payment = loan * monthly / (1 - (1 + monthly) ** -n)
    return payment * 12


def _market(town: str | None) -> dict[str, float]:
    return MARKET_DEFAULTS.get(town or "", FALLBACK_MARKET)


def _per_bedroom(listing: PropertyListing) -> float | None:
    """Price per bedroom in USD (studios count as one room)."""
    if listing.price_usd is None:
        return None
    return listing.price_usd / max(listing.bedrooms or 0, 1)


def _comps_of(comps: list[ScoredListing], operation: Operation) -> list[PropertyListing]:
    return [c.listing for c in comps if c.listing.operation is operation and c.listing.price_usd]


def _ownership_costs(price: float, a: Assumptions) -> dict[str, float]:
    return {
        "property_tax": price * a.property_tax_pct,
        "fideicomiso_fee": a.fideicomiso_annual_usd if a.foreign_buyer else 0.0,
        "insurance": price * a.insurance_pct,
        "maintenance": price * a.maintenance_pct,
        "hoa": a.hoa_monthly_usd * 12,
    }


def _finish(track: str, basis: dict[str, str], revenue: float, costs: dict[str, float], price: float,
            cash_invested: float, debt_service: float, extra: dict[str, float], a: Assumptions) -> TrackResult:
    tax = revenue * a.rental_tax_rate_on_gross
    opex = sum(costs.values())
    noi = revenue - opex
    after_tax_noi = noi - tax
    details = {**{k: round(v, 2) for k, v in costs.items()}, "income_tax": round(tax, 2), **{k: round(v, 4) for k, v in extra.items()}}
    return TrackResult(
        track=track, basis=basis,
        revenue_gross_usd=round(revenue, 2), operating_expenses_usd=round(opex + tax, 2), noi_usd=round(after_tax_noi, 2),
        cap_rate=round(after_tax_noi / price, 4),
        cash_invested_usd=round(cash_invested, 2),
        unlevered_roi=round(after_tax_noi / (price * (1 + a.closing_cost_pct) + (a.fideicomiso_setup_usd if a.foreign_buyer else 0)), 4),
        cash_on_cash=round((after_tax_noi - debt_service) / cash_invested, 4) if cash_invested > 0 else 0.0,
        annual_debt_service_usd=round(debt_service, 2), details=details,
    )


# --- the two tracks -------------------------------------------------------------------------------------------------


def short_term_model(subject: PropertyListing, comps: list[ScoredListing], a: Assumptions, occupancy: float | None = None) -> tuple[TrackResult, list[str]]:
    price = subject.price_usd or 0.0
    market = _market(subject.town)
    bedrooms = max(subject.bedrooms or 0, 1)
    warnings: list[str] = []

    nightly = [per for per in (_per_bedroom(c) for c in _comps_of(comps, Operation.RENTAL_SHORT)) if per]
    if len(nightly) >= MIN_COMPS:
        adr, adr_basis = median(nightly) * bedrooms, f"median of {len(nightly)} short-term comps (per bedroom x {bedrooms})"
    else:
        adr, adr_basis = market["adr_per_bedroom_usd"] * bedrooms, "default_assumption"
        warnings.append(f"Only {len(nightly)} short-term comp(s): ADR uses the default of ${market['adr_per_bedroom_usd']:.0f} per bedroom per night.")

    occ_source = "override" if (occupancy is not None or a.occupancy_override is not None) else "default_assumption"
    occ = occupancy if occupancy is not None else (a.occupancy_override if a.occupancy_override is not None else market["occupancy"])
    revenue = adr * 365 * occ

    costs = _ownership_costs(price, a)
    costs["platform_fees"] = revenue * a.str_platform_fee_pct
    costs["management"] = revenue * a.str_management_pct
    costs["supplies_cleaning"] = revenue * a.str_supplies_pct
    costs["utilities"] = a.str_utilities_monthly_usd * 12

    cash = _cash_invested(price, a)
    loan = price * (1 - a.down_payment_pct) if a.down_payment_pct is not None else 0.0
    debt = annual_debt_service(loan, a.mortgage_rate, a.mortgage_years)
    result = _finish("short_term", {"adr": adr_basis, "occupancy": occ_source}, revenue, costs, price, cash, debt,
                     {"adr_usd": adr, "occupancy": occ, "nights_sold": 365 * occ}, a)
    return result, warnings


def long_term_model(subject: PropertyListing, comps: list[ScoredListing], a: Assumptions) -> tuple[TrackResult, list[str]]:
    price = subject.price_usd or 0.0
    market = _market(subject.town)
    bedrooms = max(subject.bedrooms or 0, 1)
    warnings: list[str] = []

    monthly = [per for per in (_per_bedroom(c) for c in _comps_of(comps, Operation.RENTAL_LONG)) if per]
    if len(monthly) >= MIN_COMPS:
        rent, rent_basis = median(monthly) * bedrooms, f"median of {len(monthly)} long-term comps (per bedroom x {bedrooms})"
    else:
        rent, rent_basis = price * market["ltr_gross_yield"] / 12, "default_assumption"
        warnings.append(f"Only {len(monthly)} long-term comp(s): rent uses the default gross yield of {market['ltr_gross_yield']:.1%} of price.")

    gross_potential = rent * 12
    revenue = gross_potential * (1 - a.ltr_vacancy_pct)
    costs = _ownership_costs(price, a)
    costs["management"] = revenue * a.ltr_management_pct
    costs["utilities"] = a.ltr_utilities_monthly_usd * 12

    cash = _cash_invested(price, a)
    loan = price * (1 - a.down_payment_pct) if a.down_payment_pct is not None else 0.0
    debt = annual_debt_service(loan, a.mortgage_rate, a.mortgage_years)
    result = _finish("long_term", {"rent": rent_basis, "vacancy": "default_assumption"}, revenue, costs, price, cash, debt,
                     {"monthly_rent_usd": rent, "monthly_rental_yield": rent / price if price else 0.0, "gross_annual_yield": gross_potential / price if price else 0.0}, a)
    return result, warnings


def _cash_invested(price: float, a: Assumptions) -> float:
    closing = price * a.closing_cost_pct + (a.fideicomiso_setup_usd if a.foreign_buyer else 0.0)
    down = price * a.down_payment_pct if a.down_payment_pct is not None else price
    return down + closing


def breakeven_occupancy(short: TrackResult, long: TrackResult) -> float | None:
    """Occupancy at which short-term NOI equals long-term NOI.

    Short-term NOI(occ) = revenue(occ) * (1 - v) - F, where revenue scales with occupancy, v is the share of revenue
    that goes to platform fees, management, supplies and income tax, and F is every cost that does not move with
    occupancy (ownership costs, utilities). Solved for the occupancy where it equals the long-term NOI.
    """
    adr = short.details.get("adr_usd")
    if not adr or short.revenue_gross_usd <= 0:
        return None
    variable = sum(short.details.get(k, 0.0) for k in ("platform_fees", "management", "supplies_cleaning", "income_tax"))
    v = variable / short.revenue_gross_usd
    fixed = short.operating_expenses_usd - variable
    if v >= 1:
        return None
    revenue_needed = (long.noi_usd + fixed) / (1 - v)
    occupancy = revenue_needed / (adr * 365)
    return round(occupancy, 4) if 0 < occupancy < 1.5 else None


# --- the report -----------------------------------------------------------------------------------------------------


def analyze(subject: PropertyListing, comps: list[ScoredListing], *, comps_scope: str = "none",
            assumptions: Assumptions | None = None) -> FinancialReport:
    """Dual-track evaluation of one *for-sale* listing against the comps found for it."""
    a = assumptions or Assumptions()
    warnings: list[str] = []
    if subject.operation is not Operation.SALE:
        warnings.append("The subject is not a for-sale listing: there is no purchase to model.")
    if not subject.price_usd:
        warnings.append("The subject has no usable price in USD (missing, or in an unsupported currency): no returns can be computed.")
        return FinancialReport(subject.url, 0.0, 0.0, comps_scope, None, None, None, None, [], warnings, asdict(a))
    if subject.currency_assumed:
        warnings.append(f"The listing's price had no currency; {subject.currency} was assumed. Confirm it before relying on the numbers.")
    if comps_scope == "town":
        warnings.append("Comps come from the whole town: too few in the same neighbourhood.")
    if comps_scope == "none":
        warnings.append("No comps were found: every rental figure below is a default assumption.")

    short, short_warnings = short_term_model(subject, comps, a)
    long, long_warnings = long_term_model(subject, comps, a)
    warnings += short_warnings + long_warnings

    better = "short_term" if short.noi_usd > long.noi_usd else "long_term"
    sensitivity = []
    for delta in (-0.10, 0.0, 0.10):
        occ = min(max(short.details["occupancy"] + delta, 0.05), 0.95)
        variant, _ = short_term_model(subject, comps, a, occupancy=occ)
        sensitivity.append({"occupancy": round(occ, 2), "short_term_noi_usd": variant.noi_usd, "short_term_cap_rate": variant.cap_rate})

    return FinancialReport(
        subject_url=subject.url, purchase_price_usd=round(subject.price_usd, 2),
        total_cash_invested_usd=short.cash_invested_usd, comps_scope=comps_scope,
        short_term=short, long_term=long, better_track=better,
        breakeven_occupancy=breakeven_occupancy(short, long), sensitivity=sensitivity,
        warnings=warnings, assumptions=asdict(a),
    )
