"""Main crew orchestration: sourcing first, then financial analysis.

TWO MODES
  guided (default)  The code fetches, parses and calculates; each agent gets one small, focused call:
                      * Sourcing agent, once per listing page: "here is the page and what the rules read from it; return the
                        corrected record as JSON".
                      * Financial analyst, once per for-sale listing: "here are the exact numbers; write the memo".
                    Numbers always come from math_engine, so a model cannot get one wrong, and a run costs a handful of short
                    calls instead of a long tool loop.
  tools             The agents drive the tools themselves (discover -> scrape -> save -> model) in a ReAct loop.

WHY GUIDED IS THE DEFAULT
Tested on two real models. A 3B local model looped on its first tool call and stored nothing. Groq's free qwen3.8-27b chained the
tools correctly but each step re-sent several thousand tokens, and the free tier allows 7,000 input and 1,000 output tokens a minute,
so the loop died on a rate limit after one listing. The guided calls are about a tenth of the size, do not depend on the model
choosing the right tool, and a failed call degrades to the rule-based record instead of losing the page.

WHY SEQUENTIAL
The analyst can only evaluate what the sourcing step stored. A hierarchical crew would add a manager LLM call per step.
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable
from typing import Any

from crewai import Agent, Crew, Process, Task
from loguru import logger

from src.agents.definitions import ToolContext, build_agents, build_tasks, configure_tools
from src.config import Settings
from src.models import Operation, PropertyListing, SearchBrief
from src.tools.reporting import analyze_url, listing_from_hints, render_report

TaskRunner = Callable[[Agent, str, str], str]
RECORD_FIELDS = ("title", "operation", "property_type", "town", "neighborhood", "bedrooms", "bathrooms", "m2_size", "land_m2",
                 "price", "currency", "amenities", "summary")


def extract_json_object(raw: str) -> dict[str, Any] | None:
    """The first JSON object in a model reply: tolerant of <think> blocks, code fences and chatter around it."""
    text = re.sub(r"<think>[\s\S]*?</think>", "", str(raw or ""), flags=re.IGNORECASE)
    text = re.sub(r"```(?:json)?", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        value = json.loads(text[start:end + 1])
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def is_rate_limit(err: BaseException) -> bool:
    return "ratelimit" in type(err).__name__.lower() or "rate limit" in str(err).lower() or "rate_limit" in str(err).lower()


class ScoutCrew:
    def __init__(self, settings: Settings, ctx: ToolContext, run_task: TaskRunner | None = None,
                 sleep: Callable[[float], None] = time.sleep) -> None:
        self.settings = settings
        self.ctx = ctx
        self._run_task = run_task or self._crewai_task
        self._sleep = sleep
        configure_tools(ctx)

    # -- one small call ------------------------------------------------------------------------------------------------
    @staticmethod
    def _crewai_task(agent: Agent, description: str, expected_output: str) -> str:
        task = Task(description=description, expected_output=expected_output, agent=agent)
        output = Crew(agents=[agent], tasks=[task], process=Process.sequential, verbose=False, memory=False).kickoff()
        return str(getattr(output, "raw", output))

    def _ask(self, agent: Agent, description: str, expected_output: str, attempts: int = 5) -> str | None:
        """One agent call. A rate limit is waited out (free tiers reset per minute); any other failure returns None."""
        for attempt in range(1, attempts + 1):
            try:
                return self._run_task(agent, description, expected_output)
            except Exception as err:  # noqa: BLE001 - one bad call must never lose the run
                if is_rate_limit(err) and attempt < attempts:
                    wait = min(65, 15 * attempt)
                    logger.warning("Model rate limit, waiting {}s (attempt {}/{})", wait, attempt, attempts)
                    self._sleep(wait)
                    continue
                logger.warning("Agent call failed ({}): {}", type(err).__name__, str(err)[:200])
                return None
        return None

    # -- guided mode -------------------------------------------------------------------------------------------------------
    def _verify_listing(self, sourcing: Agent, url: str, page_title: str | None, hints: dict[str, Any], markdown: str) -> PropertyListing | None:
        fx = self.settings.usd_mxn_rate
        rule_listing = listing_from_hints(url, hints, fx, summary=markdown[:500])
        description = (
            "Review ONE listing page and return the corrected record as a single JSON object.\n"
            f"URL: {url}\nPAGE TITLE: {page_title}\n"
            f"WHAT THE RULES READ (may contain mistakes): {json.dumps(hints, ensure_ascii=False, default=str)}\n"
            f"FX: 1 USD = {fx} MXN.\n"
            f"PAGE TEXT:\n<<<\n{markdown[: self.settings.agent_markdown_chars]}\n>>>\n"
            "Return ONLY JSON with these keys: title, operation (sale | rental_long | rental_short), property_type, town, neighborhood, "
            "bedrooms, bathrooms, m2_size (built area in m2), land_m2, price (a number, in the currency written on the page), currency "
            "(MXN | USD, or null if the page does not say), amenities (list of short strings), summary (one sentence in Spanish). "
            "Use null for anything the page does not state. Never guess."
        )
        raw = self._ask(sourcing, description, "One JSON object, nothing else.")
        draft = extract_json_object(raw) if raw else None
        if draft is None:
            logger.info("No usable agent reply for {}: keeping the rule-based record", url)
            return rule_listing
        merged = {k: v for k, v in hints.items() if k in RECORD_FIELDS}
        merged.update({k: v for k, v in draft.items() if k in RECORD_FIELDS and v not in (None, "", [])})
        try:
            return PropertyListing(url=url, usd_mxn_rate=fx, **merged)
        except ValueError as err:
            logger.warning("Agent record for {} failed validation ({}); keeping the rule-based record", url, str(err).splitlines()[0])
            return rule_listing

    def _memo(self, analyst: Agent, report: dict[str, Any]) -> str:
        facts = render_report(report)
        raw = self._ask(
            analyst,
            "Write a short investment memo (at most 180 words, in English) about this property, using ONLY the facts below. Say which track "
            "looks better and why, state which inputs are real comps and which are default assumptions, and name the main risks (taxes, "
            "fideicomiso, HOA and vacation-rental rules, asking price vs sale price). Do not repeat the table and do not invent numbers.\n\n"
            f"FACTS:\n{facts}",
            "A memo of at most 180 words.",
        )
        return (raw or "").strip()

    def run_guided(self, brief: SearchBrief) -> dict[str, Any]:
        sourcing, analyst = build_agents(self.settings, with_tools=False)
        scraper, store = self.ctx.scraper, self.ctx.store
        urls: list[str] = []
        for url in brief.urls:
            found = scraper.discover(url) if scraper.domain_allowed(url) else []
            urls += found or [url]
        urls = list(dict.fromkeys(urls))
        logger.info("Guided run: {} page(s) to read", len(urls))

        stored: list[PropertyListing] = []
        for url in urls:
            page = scraper.scrape(url)
            if not page.ok:
                logger.warning("Skipped {}: {}", url, page.fetch.reason or "empty page")
                continue
            listing = self._verify_listing(sourcing, url, page.title, page.hints, page.markdown)
            if listing is None:
                logger.warning("Skipped {}: no price or size could be read", url)
                continue
            store.upsert([listing])
            stored.append(listing)
            self.ctx.saved_urls.append(listing.url)

        sales = [l for l in stored if l.operation is Operation.SALE and (brief.max_price_usd is None or (l.price_usd or 0) <= brief.max_price_usd)]
        sections: list[str] = []
        for listing in sales:
            report = analyze_url(listing.url, store, self.ctx.assumptions)
            if not report:
                continue
            self.ctx.reports[listing.url] = report
            memo = self._memo(analyst, report)
            sections.append(render_report(report) + (f"\n**Analyst memo**\n\n{memo}\n" if memo else ""))
        body = "# Investment dossier\n\n" + ("\n".join(sections) if sections else "No for-sale listing matched the brief.\n")
        return {"dossier_markdown": body, "saved_urls": list(self.ctx.saved_urls), "reports": dict(self.ctx.reports), "mode": "agents-guided"}

    # -- tools mode ----------------------------------------------------------------------------------------------------------
    def run_with_tools(self, brief: SearchBrief) -> dict[str, Any]:
        sourcing, analyst = build_agents(self.settings, with_tools=True)
        sourcing_task, analyst_task = build_tasks(brief, sourcing, analyst, self.settings.usd_mxn_rate)
        crew = Crew(
            agents=[sourcing, analyst], tasks=[sourcing_task, analyst_task], process=Process.sequential,
            verbose=self.settings.agent_verbose, memory=False, cache=True,
        )
        logger.info("Starting the tool-driven crew for brief: {}", brief.model_dump_json())
        output = crew.kickoff()
        return {
            "dossier_markdown": str(getattr(output, "raw", output)),
            "saved_urls": list(self.ctx.saved_urls),
            "reports": dict(self.ctx.reports),
            "mode": "agents-tools",
        }

    def run(self, brief: SearchBrief, mode: str = "guided") -> dict[str, Any]:
        """Run both agents. Returns the dossier text plus the machine-readable numbers recorded along the way."""
        return self.run_with_tools(brief) if mode == "tools" else self.run_guided(brief)
