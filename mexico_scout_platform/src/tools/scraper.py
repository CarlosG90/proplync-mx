"""Hybrid scraping engine: Scrapling fetches, Crawl4AI compresses.

WHY THIS EXISTS
Portals serve the same listing to a person and to a script very differently. Fetching and parsing are separate jobs:
  1. FETCH  (Scrapling): an HTTP request that carries a real desktop browser's TLS/HTTP2 fingerprint and headers
     (tier "http"), and, only if that is refused, one retry in a headless browser (tier "browser") for pages that
     need JavaScript.
  2. PARSE  (Crawl4AI): turns the HTML we already hold into compact, LLM-ready markdown (navigation, footers and
     boilerplate pruned), and runs per-site CSS extraction schemas when one is registered. No second download.
The result is raw markdown plus rule-based hints (price, m2, bedrooms, neighbourhood...) for the Research agent.

WHAT THIS DELIBERATELY DOES NOT DO
  * It never solves a CAPTCHA or a Cloudflare/Turnstile challenge, and never logs in. A page that still shows a
    challenge after the browser retry comes back `blocked=True` with a reason, and the run moves on.
  * It reads robots.txt (config.respect_robots) and only fetches hosts in config.allowed_domains.
  * It paces itself: randomised, human-scale delays per host and a hard page budget per run. That keeps load on the
    sites low; it is politeness, not a promise of invisibility.
The operator is responsible for each site's terms of use. Where a portal offers a feed or an API, use that instead.
"""

from __future__ import annotations

import random
import re
import time
from collections.abc import Callable
from typing import Any, Literal
from urllib.parse import urljoin, urlsplit
from urllib.robotparser import RobotFileParser

from loguru import logger
from pydantic import BaseModel, Field

from src.config import Settings, get_settings
from src.domain import hints_from_text, parse_money
from src.models import normalize_url

BLOCK_MARKERS = (
    "just a moment", "cf-chl", "attention required", "verify you are human", "enable javascript and cookies",
    "access denied", "px-captcha", "are you a robot", "unusual traffic", "captcha",
)
# Words that make a link look like one listing's page (and carry an id/number), as opposed to a category page.
LISTING_URL_RE = re.compile(r"/(?:propiedad(?:es)?|inmuebles?|detalle|property|properties|listing|anuncio|departamento|casa|venta|depa)[/-][^?#]*\d", re.IGNORECASE)

# Per-site Crawl4AI CSS schemas, keyed by host. Empty on purpose: selectors are only worth registering after looking
# at the live page. Example:
#   "example-portal.mx": {"name": "listing", "baseSelector": "main",
#       "fields": [{"name": "price_text", "selector": ".price", "type": "text"},
#                  {"name": "title", "selector": "h1", "type": "text"}]}
SITE_SCHEMAS: dict[str, dict[str, Any]] = {}


class FetchResult(BaseModel):
    url: str
    status: int | None = None
    html: str = ""
    tier: Literal["http", "browser", "none"] = "none"
    blocked: bool = False
    reason: str | None = None


class ScrapedPage(BaseModel):
    url: str
    fetch: FetchResult
    title: str | None = None
    markdown: str = ""
    hints: dict[str, Any] = Field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.fetch.blocked and bool(self.markdown)


def looks_blocked(status: int | None, html: str) -> bool:
    """A refusal (403/429/503) or a short interstitial page that talks about a challenge."""
    if status in (401, 403, 429, 503):
        return True
    if status is None or not html:
        return True
    return len(html) < 80_000 and any(marker in html[:6000].lower() for marker in BLOCK_MARKERS)


def host_of(url: str) -> str:
    """Bare host (no port, no www): what the allow-list and per-host pacing key on."""
    return (urlsplit(url).hostname or "").lower().removeprefix("www.")


class ListingScraper:
    def __init__(self, settings: Settings | None = None, sleep: Callable[[float], None] = time.sleep, rng: random.Random | None = None) -> None:
        self.settings = settings or get_settings()
        self._sleep = sleep
        self._rng = rng or random.Random()
        self._last_request: dict[str, float] = {}
        self._robots: dict[str, RobotFileParser | None] = {}
        self.pages_fetched = 0

    # -- politeness ------------------------------------------------------------------------------------------------
    def next_delay(self) -> float:
        """Human-scale pause: uniform in [min, max], with an occasional longer one (as when someone reads a page)."""
        s = self.settings
        delay = self._rng.uniform(s.request_delay_min, s.request_delay_max)
        if self._rng.random() < 0.12:
            delay *= self._rng.uniform(1.5, 2.5)
        return round(delay, 2)

    def _pace(self, host: str) -> None:
        last = self._last_request.get(host)
        if last is not None:
            wait = self.next_delay() - (time.monotonic() - last)
            if wait > 0:
                logger.debug("Pausing {:.1f}s before the next request to {}", wait, host)
                self._sleep(wait)
        self._last_request[host] = time.monotonic()

    # -- rules -----------------------------------------------------------------------------------------------------
    def domain_allowed(self, url: str) -> bool:
        host = host_of(url)
        return any(host == d or host.endswith("." + d) for d in self.settings.allowed_domains)

    def robots_allowed(self, url: str) -> bool:
        if not self.settings.respect_robots:
            return True
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        if origin not in self._robots:
            self._robots[origin] = self._load_robots(origin)
        parser = self._robots[origin]
        return True if parser is None else parser.can_fetch("*", url)

    def _load_robots(self, origin: str) -> RobotFileParser | None:
        from scrapling.fetchers import Fetcher  # imported lazily: it starts the HTTP stack

        try:
            self._pace(host_of(origin))
            response = Fetcher.get(origin + "/robots.txt", impersonate=self.settings.impersonate, timeout=10, retries=1, **self._proxy_kwargs())
            if response.status != 200:
                return None  # no robots.txt (or unreadable): the standard reading is "no restrictions"
            parser = RobotFileParser()
            # .html_content wraps plain text in <html><body>; the raw body is the real robots.txt
            parser.parse(bytes(response.body).decode("utf-8", errors="ignore").splitlines())
            return parser
        except Exception as exc:  # noqa: BLE001 - a robots fetch must never break a run
            logger.warning("Could not read robots.txt for {}: {}", origin, exc)
            return None

    def _proxy_kwargs(self) -> dict[str, Any]:
        return {"proxy": self.settings.proxy_url} if self.settings.proxy_url else {}

    # -- fetch -----------------------------------------------------------------------------------------------------
    def fetch(self, url: str) -> FetchResult:
        from scrapling.fetchers import Fetcher, StealthyFetcher

        if not self.domain_allowed(url):
            return FetchResult(url=url, blocked=True, reason="domain_not_in_allowlist")
        if self.pages_fetched >= self.settings.max_pages_per_run:
            return FetchResult(url=url, blocked=True, reason="page_budget_exhausted")
        if not self.robots_allowed(url):
            return FetchResult(url=url, blocked=True, reason="disallowed_by_robots_txt")

        host = host_of(url)
        self._pace(host)
        self.pages_fetched += 1
        try:
            response = Fetcher.get(
                url, impersonate=self.settings.impersonate, stealthy_headers=True, follow_redirects=True,
                timeout=self.settings.fetch_timeout, retries=1, retry_delay=2, **self._proxy_kwargs(),
            )
            status, html = int(response.status), str(response.html_content or "")
        except Exception as exc:  # noqa: BLE001
            logger.warning("HTTP fetch failed for {}: {}", url, exc)
            status, html = None, ""

        if not looks_blocked(status, html):
            return FetchResult(url=url, status=status, html=html, tier="http")
        logger.info("HTTP tier refused {} (status {}).", url, status)

        if not self.settings.browser_fallback:
            return FetchResult(url=url, status=status, blocked=True, reason=f"refused_http_{status}")

        self._pace(host)
        try:
            response = StealthyFetcher.fetch(
                url, headless=True, network_idle=True, timeout=self.settings.fetch_timeout * 1000, **self._proxy_kwargs(),
            )
            status, html = int(response.status), str(response.html_content or "")
        except Exception as exc:  # noqa: BLE001
            logger.warning("Browser fetch failed for {}: {}", url, exc)
            return FetchResult(url=url, status=status, blocked=True, reason=f"browser_error_{type(exc).__name__}")
        if looks_blocked(status, html):
            logger.warning("{} still shows a challenge after the browser retry; skipping it (no challenge solving).", url)
            return FetchResult(url=url, status=status, html=html, tier="browser", blocked=True, reason="challenge_page")
        return FetchResult(url=url, status=status, html=html, tier="browser")

    # -- parse -----------------------------------------------------------------------------------------------------
    def parse(self, url: str, html: str) -> ScrapedPage:
        """Compress `html` to markdown with Crawl4AI and read the facts the rules can read. No network."""
        from crawl4ai import DefaultMarkdownGenerator, JsonCssExtractionStrategy
        try:
            from crawl4ai import PruningContentFilterLXML as PruningContentFilter  # same output as the older filter, ~10x faster
        except ImportError:  # older crawl4ai
            from crawl4ai import PruningContentFilter

        generator = DefaultMarkdownGenerator(content_filter=PruningContentFilter(threshold=0.4, threshold_type="dynamic", min_word_threshold=4))
        result = generator.generate_markdown(input_html=html, base_url=url)
        markdown = (result.fit_markdown or result.raw_markdown or "").strip()
        if len(markdown) < 200:  # pruning ate a short page: the unpruned text is better than nothing
            markdown = (result.raw_markdown or markdown).strip()
        markdown = markdown[: self.settings.max_markdown_chars]

        title_match = re.search(r"<title[^>]*>(.*?)</title>", html, re.DOTALL | re.IGNORECASE)
        title = re.sub(r"\s+", " ", title_match.group(1)).strip() if title_match else None

        # Facts are read from the UNPRUNED text: the pruning filter keeps what looks like prose and can drop short
        # bullets such as "2 recámaras", which are exactly the fields we need. The pruned markdown is for the LLM.
        hints = hints_from_text((result.raw_markdown or markdown)[:20000], html, title)
        schema = SITE_SCHEMAS.get(host_of(url))
        if schema:
            try:
                for item in JsonCssExtractionStrategy(schema).extract(url, html)[:1]:
                    amount, currency = parse_money(str(item.get("price_text", "")))
                    if amount and "price" not in hints:
                        hints["price"], hints["currency"] = amount, currency
                    if item.get("title") and "title" not in hints:
                        hints["title"] = str(item["title"]).strip()
            except Exception as exc:  # noqa: BLE001 - a broken schema must not lose the page
                logger.warning("CSS schema for {} failed: {}", host_of(url), exc)
        return ScrapedPage(url=url, fetch=FetchResult(url=url, status=200, tier="http"), title=title, markdown=markdown, hints=hints)

    def scrape(self, url: str) -> ScrapedPage:
        fetched = self.fetch(url)
        if fetched.blocked or not fetched.html:
            return ScrapedPage(url=url, fetch=fetched.model_copy(update={"html": ""}))
        page = self.parse(url, fetched.html)
        page.fetch = fetched.model_copy(update={"html": ""})  # the markdown is what travels on; keep memory small
        logger.info("Scraped {} via {} tier: {} chars of markdown, hints={}", url, fetched.tier, len(page.markdown), sorted(page.hints))
        return page

    # -- discovery -------------------------------------------------------------------------------------------------
    def discover(self, results_url: str, limit: int | None = None) -> list[str]:
        """Listing URLs found on a search-results page: same site, allowed, shaped like a listing page."""
        fetched = self.fetch(results_url)
        if fetched.blocked or not fetched.html:
            logger.warning("Cannot read results page {}: {}", results_url, fetched.reason)
            return []
        return self.links_from_html(results_url, fetched.html, limit or self.settings.max_pages_per_run)

    def links_from_html(self, base_url: str, html: str, limit: int) -> list[str]:
        hrefs = re.findall(r"""href=["']([^"'#]+)["']""", html, re.IGNORECASE)
        base_host = host_of(base_url)
        seen: dict[str, str] = {}
        for href in hrefs:
            absolute = urljoin(base_url, href.strip())
            if not absolute.lower().startswith(("http://", "https://")):
                continue
            if host_of(absolute) != base_host or not self.domain_allowed(absolute) or not LISTING_URL_RE.search(urlsplit(absolute).path):
                continue
            seen.setdefault(normalize_url(absolute), absolute)
            if len(seen) >= limit:
                break
        return list(seen.values())
