"""CrewAI agents, tasks and the tools they are allowed to call.

WHY THIS EXISTS
The two agents split the work the way a real analyst desk does:
  * Property Sourcing Agent    - reads listing pages, fixes what the rules could not read, stores clean records.
  * Financial Investment Analyst - pulls local comps from Qdrant, runs the maths engine, writes the dossier.
Both get the same domain guardrails in their system prompts, and neither does arithmetic: numbers come from
`math_engine.py` through a tool, so a small local model cannot get them wrong.

WHY THE TOOLS ARE THIN
Each tool validates its input with the Pydantic schemas and returns JSON text or a short error the model can act on.
A tool never raises into the agent loop: a failed scrape or a bad record comes back as {"error": ...}.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from crewai import LLM, Agent, Task
from crewai.tools import tool
from loguru import logger
from pydantic import ValidationError

from src.config import Settings
from src.db.vector_db import ListingStore
from src.models import Operation, PropertyListing, SearchBrief
from src.tools.math_engine import Assumptions, analyze
from src.tools.scraper import ListingScraper

# --- shared state for the tools --------------------------------------------------------------------------------------


@dataclass
class ToolContext:
    settings: Settings
    scraper: ListingScraper
    store: ListingStore
    assumptions: Assumptions = field(default_factory=Assumptions)
    saved_urls: list[str] = field(default_factory=list)
    reports: dict[str, dict[str, Any]] = field(default_factory=dict)


_CTX: ToolContext | None = None


def configure_tools(ctx: ToolContext) -> None:
    global _CTX
    _CTX = ctx


def _ctx() -> ToolContext:
    if _CTX is None:
        raise RuntimeError("configure_tools(ToolContext(...)) must run before the agents do")
    return _CTX


def _json(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, default=str)


# --- tools -------------------------------------------------------------------------------------------------------------


@tool("discover_listing_urls")
def discover_listing_urls(results_url: str) -> str:
    """Find listing page URLs on a portal's search-results page. Input: the results page URL. Output: JSON list of URLs."""
    try:
        return _json({"urls": _ctx().scraper.discover(results_url)})
    except Exception as exc:  # noqa: BLE001
        logger.exception("discover failed")
        return _json({"error": f"{type(exc).__name__}: {exc}"})


@tool("scrape_listing_page")
def scrape_listing_page(url: str) -> str:
    """Fetch one listing page and return compact markdown plus rule-based hints (price, currency, m2, bedrooms, neighbourhood).
    The hints are a starting point: confirm them against the markdown. If 'blocked' is true, skip this page."""
    try:
        page = _ctx().scraper.scrape(url)
        return _json({
            "url": url, "ok": page.ok, "blocked": page.fetch.blocked, "reason": page.fetch.reason,
            "title": page.title, "hints": page.hints, "markdown": page.markdown[: _ctx().settings.agent_markdown_chars],
        })
    except Exception as exc:  # noqa: BLE001
        logger.exception("scrape failed")
        return _json({"url": url, "ok": False, "error": f"{type(exc).__name__}: {exc}"})


@tool("save_listing")
def save_listing(listing_json: str) -> str:
    """Validate and store one property in the vector database. Input: a JSON object with url, title, operation
    (sale | rental_long | rental_short), property_type, town, neighborhood, bedrooms, bathrooms, m2_size, price,
    currency (MXN | USD), amenities (list), summary. Use null for anything the page does not state. Never guess a value."""
    ctx = _ctx()
    try:
        data = json.loads(listing_json)
        data["usd_mxn_rate"] = ctx.settings.usd_mxn_rate
        listing = PropertyListing.model_validate(data)
        ctx.store.upsert([listing])
        ctx.saved_urls.append(listing.url)
        return _json({"saved": True, "url": listing.url, "neighborhood": listing.neighborhood, "town": listing.town,
                      "price_usd": listing.price_usd, "currency_assumed": listing.currency_assumed})
    except (ValueError, ValidationError) as exc:
        return _json({"saved": False, "error": str(exc)[:600]})
    except Exception as exc:  # noqa: BLE001
        logger.exception("save_listing failed")
        return _json({"saved": False, "error": f"{type(exc).__name__}: {exc}"})


@tool("search_listings")
def search_listings(query: str, town: str = "", neighborhood: str = "", operation: str = "", max_price_usd: float = 0, bedrooms: int = -1) -> str:
    """Semantic search over stored listings with strict filters. query: free text (Spanish or English). town,
    neighborhood, operation (sale | rental_long | rental_short): exact-match filters, '' to skip. max_price_usd: 0 to skip.
    bedrooms: -1 to skip. Output: JSON list of matches with similarity score."""
    try:
        hits = _ctx().store.search(
            query, limit=8, town=town or None, neighborhood=neighborhood or None, operation=operation or None,
            max_price_usd=max_price_usd or None, bedrooms=None if bedrooms < 0 else bedrooms, bedroom_tolerance=1,
        )
        return _json([{"score": round(h.score, 3), **h.listing.model_dump(mode="json", include={
            "url", "title", "operation", "town", "neighborhood", "bedrooms", "m2_size", "price", "currency", "price_usd"})} for h in hits])
    except Exception as exc:  # noqa: BLE001
        logger.exception("search failed")
        return _json({"error": f"{type(exc).__name__}: {exc}"})


@tool("run_financial_model")
def run_financial_model(listing_url: str) -> str:
    """Run the dual-track financial model (short-term vs long-term rental) for one stored for-sale listing. It finds the
    local comps itself, then returns exact numbers (cap rate, NOI, yields, cash-on-cash) with where each input came from.
    Report these numbers as given; do not recompute them."""
    ctx = _ctx()
    try:
        subject = ctx.store.get(listing_url)
        if subject is None:
            return _json({"error": "listing not found in the database: save_listing it first"})
        comps, scope = [], "none"
        for operation in (Operation.RENTAL_SHORT, Operation.RENTAL_LONG):
            found, found_scope = ctx.store.find_comps(subject, operation)
            comps += found
            if found and scope != "neighborhood":
                scope = found_scope
        report = analyze(subject, comps, comps_scope=scope, assumptions=ctx.assumptions).to_dict()
        report["comps_used"] = len(comps)
        ctx.reports[subject.url] = report
        return _json(report)
    except Exception as exc:  # noqa: BLE001
        logger.exception("financial model failed")
        return _json({"error": f"{type(exc).__name__}: {exc}"})


# --- prompts: the domain guardrails -------------------------------------------------------------------------------------

DOMAIN_RULES = """\
DOMAIN RULES (Riviera Maya, Mexico: Cancún, Playa del Carmen, Tulum, Puerto Morelos)
- Prices appear as MXN or USD. "$" alone is ambiguous: say so, never silently pick. Convert only with the rate you are given.
- "m²", "mts2" and "metros cuadrados" are square metres. "Recámaras", "habitaciones" and "dormitorios" are bedrooms.
  "Baño y medio" is 1.5 bathrooms. Built area (construcción) and land (terreno) are different numbers.
- Use the canonical neighbourhood names (Aldea Zama, La Veleta, Region 15, Tulum Centro, Playacar, Gonzalo Guerrero,
  Playa Centro, Zona Hotelera Cancun, Puerto Cancun, Cancun Centro...). Aldea Zamá and Zama Village are the same place.
- Mexican property tax (predial) is roughly 0.1% to 0.5% of value a year. Foreign buyers in the coastal restricted zone
  hold title through a fideicomiso (bank trust): budget roughly US$500-1,000 a year plus a set-up cost. Closing costs run
  about 5-7% of the price.
- A listing is an ASKING price, not a sale price. Comps are other listings, not transactions. Say so in the report.
- Never invent a number. If a page does not state it, the field is null and the report says it is missing."""

SOURCING_BACKSTORY = f"""You are a meticulous real-estate data analyst for the Mexican Caribbean. You read listing pages and turn
them into clean, truthful records. You prefer a null over a guess, and you flag every assumption.

{DOMAIN_RULES}"""

ANALYST_BACKSTORY = f"""You are a cautious real-estate investment analyst for foreign buyers in Quintana Roo. You evaluate a
property two ways, as a short-term vacation rental and as a long-term rental, using the numbers the financial model returns
and the comps found in the local database. You explain trade-offs plainly, state what is an assumption and what is data,
and you never present a screening model as tax, legal or financial advice.

{DOMAIN_RULES}"""


# --- agents and tasks -----------------------------------------------------------------------------------------------------


def build_llm(settings: Settings) -> LLM:
    kwargs: dict[str, Any] = {"model": settings.llm_model, "temperature": settings.llm_temperature, "num_retries": settings.llm_num_retries, "max_tokens": settings.llm_max_tokens}
    if settings.llm_base_url:
        kwargs["base_url"] = settings.llm_base_url
    if settings.llm_api_key:
        kwargs["api_key"] = settings.llm_api_key
    return LLM(**kwargs)


def build_agents(settings: Settings, with_tools: bool = True) -> tuple[Agent, Agent]:
    """The two agents. `with_tools=False` is the guided mode: the code fetches and calculates, the agents only judge."""
    llm = build_llm(settings)
    sourcing = Agent(
        role="Property Sourcing Agent",
        goal="Read listing pages accurately and return clean, truthful records for the vector database.",
        backstory=SOURCING_BACKSTORY, llm=llm, verbose=settings.agent_verbose, allow_delegation=False, max_iter=14 if with_tools else 3,
        tools=[discover_listing_urls, scrape_listing_page, save_listing, search_listings] if with_tools else [],
    )
    analyst = Agent(
        role="Financial Investment Analyst",
        goal="Explain, honestly and from the numbers given, how each listing performs as a short-term and a long-term rental.",
        backstory=ANALYST_BACKSTORY, llm=llm, verbose=settings.agent_verbose, allow_delegation=False, max_iter=10 if with_tools else 3,
        tools=[search_listings, run_financial_model] if with_tools else [],
    )
    return sourcing, analyst


def build_tasks(brief: SearchBrief, sourcing: Agent, analyst: Agent, fx: float) -> tuple[Task, Task]:
    sourcing_task = Task(
        description=(
            "Scout properties for this brief and store them.\n"
            f"BRIEF: {brief.model_dump_json()}\n"
            f"FX: 1 USD = {fx} MXN.\n"
            "Steps: (1) for each results-page URL in the brief, call discover_listing_urls; (2) for each listing URL, call "
            "scrape_listing_page, confirm the hints against the markdown, and fix anything the rules got wrong; (3) call "
            "save_listing with a complete JSON record (null for anything not stated); (4) skip pages that come back blocked, "
            "and say which. Stop when the URLs are exhausted. Do not fetch anything that is not in the brief or found from it."
        ),
        expected_output=(
            "A target profile in markdown: one line per stored listing (url, neighbourhood, bedrooms, m2, price in USD and the "
            "currency it was written in), then a list of pages skipped and why, then any data-quality concerns."
        ),
        agent=sourcing,
    )
    analyst_task = Task(
        description=(
            "Evaluate every listing stored in the previous step that is for sale. For each one call run_financial_model with its "
            "URL, then use search_listings if you want to look at the comps. Compare the short-term and long-term tracks using ONLY "
            "the numbers the model returned. Say how many comps were used and how local they were, and which inputs are default "
            f"assumptions. BRIEF: {brief.model_dump_json()}"
        ),
        expected_output=(
            "An investment dossier in markdown: a ranked summary table (cap rate and cash-on-cash for both tracks), then per property "
            "the key numbers, the better track and why, the break-even occupancy, the warnings, and a closing section of risks "
            "(taxes, fideicomiso, HOA and vacation-rental rules, asking-vs-sale price). End with the disclaimer that this is a "
            "screening model, not advice."
        ),
        agent=analyst, context=[sourcing_task],
    )
    return sourcing_task, analyst_task
