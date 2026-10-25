"""End-to-end entrypoint:  python -m src.pipeline <command>

  run       scout pages for a brief and write an investment dossier (agents by default; --no-agents = rules only)
  ingest    scrape listing pages straight into the vector database (no LLM)
  search    semantic search over what is already stored
  analyze   financial model for one stored for-sale listing (no LLM)
  stats     what is in the database

WHY A DETERMINISTIC MODE
`--no-agents` runs the whole graph with rules instead of an LLM: scrape -> parse -> validate -> Qdrant -> comps -> maths.
It needs no model server, so it is how the pipeline is tested and how a run stays useful when a local LLM is down.
With no arguments, `run` asks its questions in the terminal.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from loguru import logger

from src.agents.crew import ScoutCrew
from src.agents.definitions import ToolContext
from src.config import PROJECT_ROOT, Settings, get_settings
from src.db.vector_db import ListingStore
from src.models import Operation, PropertyListing, SearchBrief
from src.tools.math_engine import Assumptions, analyze
from src.tools.scraper import ListingScraper

OUTPUT_DIR = PROJECT_ROOT / "output"


def setup_logging(settings: Settings) -> None:
    logger.remove()
    logger.add(sys.stderr, level=settings.log_level.upper(), format="<green>{time:HH:mm:ss}</green> <level>{level:<7}</level> {message}")
    (PROJECT_ROOT / "logs").mkdir(exist_ok=True)
    logger.add(PROJECT_ROOT / "logs" / "scout.log", level="DEBUG", rotation="5 MB", retention=5, enqueue=True)


# --- deterministic steps ------------------------------------------------------------------------------------------------


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


def write_outputs(stem: str, markdown: str, payload: dict[str, Any]) -> tuple[Path, Path]:
    OUTPUT_DIR.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    md, js = OUTPUT_DIR / f"{stem}-{stamp}.md", OUTPUT_DIR / f"{stem}-{stamp}.json"
    disclaimer = "\n\n_Screening model built on asking prices and editable assumptions. Not tax, legal or financial advice._\n"
    md.write_text(markdown + disclaimer, encoding="utf-8")
    js.write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    return md, js


# --- commands -----------------------------------------------------------------------------------------------------------


def _ask(prompt: str, default: str = "") -> str:
    try:
        answer = input(f"{prompt}{f' [{default}]' if default else ''}: ").strip()
    except EOFError:
        answer = ""
    return answer or default


def _brief_from_args(args: argparse.Namespace) -> SearchBrief:
    interactive = not (args.town or args.url or args.max_price_usd)
    if interactive:
        print("PropLync Scout platform: describe what to scout (Enter to skip).")
        town = _ask("Town (Cancún / Playa del Carmen / Tulum / Puerto Morelos)")
        hoods = [h.strip() for h in _ask("Neighbourhoods, comma separated").split(",") if h.strip()]
        price = _ask("Max price in USD")
        beds = _ask("Min bedrooms")
        urls = [u.strip() for u in _ask("Listing or results-page URLs, space separated").split() if u.strip()]
        notes = _ask("Notes (must-haves, deal-breakers)")
        return SearchBrief(town=town or None, neighborhoods=hoods, max_price_usd=float(price) if price else None,
                           min_bedrooms=int(beds) if beds else None, urls=urls, notes=notes)
    return SearchBrief(town=args.town, neighborhoods=args.neighborhood or [], max_price_usd=args.max_price_usd,
                       min_bedrooms=args.min_bedrooms, urls=args.url or [], notes=args.notes or "")


def _expand(urls: list[str], scraper: ListingScraper) -> list[str]:
    """A results page becomes its listing links; a listing URL stays as it is."""
    out: list[str] = []
    for url in urls:
        found = scraper.discover(url) if scraper.domain_allowed(url) else []
        out += found or [url]
    return list(dict.fromkeys(out))


def _rules_dossier(brief: SearchBrief, scraper: ListingScraper, store: ListingStore, settings: Settings, note: str = "") -> tuple[str, dict[str, Any]]:
    """The whole graph without an LLM: scrape -> parse -> validate -> Qdrant -> comps -> maths."""
    stored = ingest_urls(_expand(brief.urls, scraper), scraper, store, settings)
    sales = [l for l in stored if l.operation is Operation.SALE and (brief.max_price_usd is None or (l.price_usd or 0) <= brief.max_price_usd)]
    reports = [r for r in (analyze_url(l.url, store, Assumptions()) for l in sales) if r]
    body = "# Investment dossier\n\n" + (f"> {note}\n\n" if note else "")
    body += "\n".join(render_report(r) for r in reports) if reports else "No for-sale listing matched the brief.\n"
    return body, {"brief": brief.model_dump(), "reports": reports, "mode": "rules"}


def cmd_run(args: argparse.Namespace, settings: Settings, store: ListingStore) -> int:
    brief = _brief_from_args(args)
    if not brief.urls:
        logger.error("Nothing to scout: give at least one --url (a listing or a search-results page on an allowed portal).")
        return 2
    scraper = ListingScraper(settings)
    if args.no_agents:
        body, payload = _rules_dossier(brief, scraper, store, settings)
    else:
        try:
            result = ScoutCrew(settings, ToolContext(settings=settings, scraper=scraper, store=store)).run(brief)
        except Exception:  # noqa: BLE001 - a model server that is down or confused must not cost the user the run
            logger.exception("The agent crew failed")
            result = {"saved_urls": []}
        if result["saved_urls"]:
            body, payload = result["dossier_markdown"], {"brief": brief.model_dump(), **result, "mode": "agents"}
        else:
            logger.warning("The agents stored no listing (the local model may be too small for multi-step tool use, try a 7B+ instruct "
                           "model with tool support). Falling back to the rules-based pipeline for this run.")
            body, payload = _rules_dossier(brief, scraper, store, settings, note="The agents stored nothing, so this dossier was produced by the rules-based pipeline.")
    md, js = write_outputs("dossier", body, payload)
    print(f"\nDossier: {md}\nData:    {js}")
    return 0


def cmd_ingest(args: argparse.Namespace, settings: Settings, store: ListingStore) -> int:
    scraper = ListingScraper(settings)
    stored = ingest_urls(_expand(args.urls, scraper), scraper, store, settings)
    print(f"Stored {len(stored)} listing(s). Database now holds {store.count()}.")
    return 0 if stored else 1


def cmd_search(args: argparse.Namespace, settings: Settings, store: ListingStore) -> int:
    hits = store.search(
        args.query, limit=args.limit, town=args.town, neighborhood=args.neighborhood, operation=args.operation,
        max_price_usd=args.max_price_usd, bedrooms=args.bedrooms, bedroom_tolerance=args.bedroom_tolerance,
    )
    for hit in hits:
        l = hit.listing
        print(f"{hit.score:.3f} | {l.operation.value:<12} | {l.neighborhood or '?':<18} | {l.bedrooms} bd | {l.m2_size or '?'} m2 | ${l.price_usd or 0:>12,.0f} USD | {l.url}")
    if not hits:
        print("No matches.")
    return 0


def cmd_analyze(args: argparse.Namespace, settings: Settings, store: ListingStore) -> int:
    report = analyze_url(args.url, store, Assumptions(down_payment_pct=args.down_payment))
    if report is None:
        return 1
    print(render_report(report))
    md, js = write_outputs("analysis", render_report(report), report)
    print(f"Saved: {md}")
    return 0


def cmd_stats(args: argparse.Namespace, settings: Settings, store: ListingStore) -> int:
    print(f"{store.count()} listing(s) in '{settings.qdrant_collection}' at {settings.qdrant_dir}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m src.pipeline", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="scout a brief and write a dossier")
    run.add_argument("--town"); run.add_argument("--neighborhood", action="append"); run.add_argument("--max-price-usd", type=float)
    run.add_argument("--min-bedrooms", type=int); run.add_argument("--url", action="append"); run.add_argument("--notes")
    run.add_argument("--no-agents", action="store_true", help="rules only: no LLM")
    run.set_defaults(func=cmd_run)

    ing = sub.add_parser("ingest", help="scrape pages into the database"); ing.add_argument("urls", nargs="+"); ing.set_defaults(func=cmd_ingest)

    se = sub.add_parser("search", help="semantic search with strict filters"); se.add_argument("query")
    se.add_argument("--town"); se.add_argument("--neighborhood"); se.add_argument("--operation", choices=[o.value for o in Operation])
    se.add_argument("--max-price-usd", type=float); se.add_argument("--bedrooms", type=int); se.add_argument("--bedroom-tolerance", type=int, default=1)
    se.add_argument("--limit", type=int, default=8); se.set_defaults(func=cmd_search)

    an = sub.add_parser("analyze", help="financial model for one stored listing"); an.add_argument("url")
    an.add_argument("--down-payment", type=float, help="fraction financed buyer pays up front, e.g. 0.35; omit for all cash"); an.set_defaults(func=cmd_analyze)

    st = sub.add_parser("stats", help="database size"); st.set_defaults(func=cmd_stats)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv if argv is not None else (sys.argv[1:] or ["run"]))
    settings = get_settings()
    setup_logging(settings)
    store = ListingStore(settings)
    try:
        return args.func(args, settings, store)
    except KeyboardInterrupt:
        logger.warning("Interrupted")
        return 130
    except Exception:  # noqa: BLE001
        logger.exception("The run failed")
        return 1
    finally:
        store.close()


if __name__ == "__main__":
    sys.exit(main())
