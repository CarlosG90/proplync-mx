"""Rules-based steps shared by the CLI and the agents: ingest pages, run the maths, render a report.

WHY THIS EXISTS
Everything here is deterministic. The agents (src/agents) call it for the facts and add judgement on top; the CLI's
`--no-agents` mode and the fallback when a model fails use it alone. Keeping it in one place means the numbers in a
dossier are the same whichever path produced it.
"""

from __future__ import annotations

from typing import Any

from loguru import logger

from src.config import Settings
from src.db.vector_db import ListingStore
from src.models import Operation, PropertyListing
from src.tools.math_engine import Assumptions, analyze
from src.tools.scraper import ListingScraper


def listing_from_hints(url: str, hints: dict[str, Any], usd_mxn: float, summary: str | None = None) -> PropertyListing | None:
    """Rules-only record from a scraped page. None when the page gave nothing usable (no price and no size)."""
    if hints.get("price") is None and hints.get("m2_size") is None:
        return None
    data = {k: hints[k] for k in (
        "title", "operation", "property_type", "town", "neighborhood", "bedrooms", "bathrooms", "m2_size", "land_m2", "price", "currency",
    ) if k in hints}
    try:
        return PropertyListing(url=url, summary=summary, usd_mxn_rate=usd_mxn, **data)
    except ValueError as exc:
        logger.warning("Rejected {}: {}", url, str(exc).splitlines()[0])
        return None


def ingest_urls(urls: list[str], scraper: ListingScraper, store: ListingStore, settings: Settings) -> list[PropertyListing]:
    stored: list[PropertyListing] = []
    for url in urls:
        page = scraper.scrape(url)
        if not page.ok:
            logger.warning("Skipped {}: {}", url, page.fetch.reason or "empty page")
            continue
        listing = listing_from_hints(url, page.hints, settings.usd_mxn_rate, summary=page.markdown[:500])
        if listing is None:
            logger.warning("Skipped {}: no price or size could be read", url)
            continue
        store.upsert([listing])
        stored.append(listing)
        logger.info("Stored {} | {} | {} | {} bd | ${} USD", listing.operation.value, listing.neighborhood, listing.town, listing.bedrooms, listing.price_usd)
    return stored


def analyze_url(url: str, store: ListingStore, assumptions: Assumptions) -> dict[str, Any] | None:
    subject = store.get(url)
    if subject is None:
        logger.error("{} is not in the database; ingest it first", url)
        return None
    comps, scope = [], "none"
    for operation in (Operation.RENTAL_SHORT, Operation.RENTAL_LONG):
        found, found_scope = store.find_comps(subject, operation)
        comps += found
        if found and scope != "neighborhood":
            scope = found_scope
    report = analyze(subject, comps, comps_scope=scope, assumptions=assumptions).to_dict()
    report["comps_used"] = len(comps)
    report["subject"] = subject.model_dump(mode="json", include={"title", "neighborhood", "town", "bedrooms", "m2_size", "price", "currency"})
    return report


def render_report(report: dict[str, Any]) -> str:
    s, l = report.get("short_term"), report.get("long_term")
    subject = report.get("subject", {})
    lines = [f"## {subject.get('title') or report['subject_url']}", f"{report['subject_url']}", ""]
    if not s or not l:
        return "\n".join(lines + ["**No returns computed.**", *[f"- {w}" for w in report["warnings"]]])
    lines += [
        f"{subject.get('neighborhood') or '?'}, {subject.get('town') or '?'} | {subject.get('bedrooms')} bd | {subject.get('m2_size')} m2 | "
        f"purchase **${report['purchase_price_usd']:,.0f} USD** | cash invested ${s['cash_invested_usd']:,.0f} | comps: {report['comps_used']} ({report['comps_scope']})",
        "",
        "| | Short-term (vacation) | Long-term |",
        "|---|---|---|",
        f"| Gross revenue / yr | ${s['revenue_gross_usd']:,.0f} | ${l['revenue_gross_usd']:,.0f} |",
        f"| Operating expenses / yr | ${s['operating_expenses_usd']:,.0f} | ${l['operating_expenses_usd']:,.0f} |",
        f"| NOI / yr | ${s['noi_usd']:,.0f} | ${l['noi_usd']:,.0f} |",
        f"| Cap rate | {s['cap_rate']:.2%} | {l['cap_rate']:.2%} |",
        f"| Unlevered ROI | {s['unlevered_roi']:.2%} | {l['unlevered_roi']:.2%} |",
        f"| Cash-on-cash | {s['cash_on_cash']:.2%} | {l['cash_on_cash']:.2%} |",
        f"| ADR / occupancy | ${s['details']['adr_usd']:,.0f} / {s['details']['occupancy']:.0%} | |",
        f"| Monthly rent / yield | | ${l['details']['monthly_rent_usd']:,.0f} / {l['details']['monthly_rental_yield']:.2%} |",
        f"| Inputs from | ADR: {s['basis']['adr']}; occupancy: {s['basis']['occupancy']} | rent: {l['basis']['rent']} |",
        "",
        f"**Better track:** {report['better_track'].replace('_', '-')}"
        + (f" | short-term needs ~{report['breakeven_occupancy']:.0%} occupancy to match long-term" if report.get("breakeven_occupancy") else ""),
        "",
        *[f"- WARNING: {w}" for w in report["warnings"]],
        "",
    ]
    return "\n".join(lines)


