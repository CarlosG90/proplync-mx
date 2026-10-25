"""Ingest worker for proplync.mx: turn listing pages on a few open sites into records the search index can take.

WHY THIS EXISTS
PropLync's search index fills from paid Apify scrapers for the big portals (off until someone pays for them) and from our own
agencies. Smaller agency sites that serve plain visitors can be read with the scraper in this package at no cost. This worker is
the bridge: the Node crawler (ingest/adapters/index.js, source `scraper_web`) calls it, then sends what it returns through the
index writer, so dedupe, merging across sites, currency conversion and embeddings stay in ONE place (api/_lib/search).

TWO COMMANDS (JSON in and out, nothing else on stdout)
  sitemap   print [{url, lastmod, site}] for every configured site, read from the sitemaps its robots.txt names.
  scrape    read [{url, site}] on stdin, scrape each page, print one JSON record per line for the pages that yielded a usable listing.

WHY SITEMAPS
A sitemap is the site telling crawlers which pages exist. It costs a handful of requests instead of walking results pages, and a URL
still listed there counts as "still for sale" without fetching it: the Node side re-fetches only what is new, plus a weekly slice so
prices refresh.

WHAT IS LEFT OUT ON PURPOSE (precision over volume)
  * Nightly/vacation rentals. The index has `sale` and `rental` only, so a nightly rate stored as a rental would read as a monthly
    rent of US$150 and poison every rental comp.
  * Prices whose currency the page does not state and whose size is ambiguous (US$900k or MXN 900k?). The index defaults a missing
    currency to MXN, so a guess here would silently misprice.
  * Pages with no price and no size, or no recognisable town.
Politeness is the scraper's: robots.txt, an allow-list, randomised per-host delays, a page budget, and it never solves a visitor check.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any
from urllib.parse import urlsplit

from loguru import logger

from src.config import Settings, get_settings
from src.domain import infer_currency
from src.models import Operation, PropertyListing
from src.tools.scraper import ListingScraper, host_of

# Listing sitemaps and the shape of a listing URL, per site (found by reading each site's robots.txt on 2026-10-25).
# `prefer` keeps one language when a site publishes the same property twice (Spanish: PropLync's default).
SITES: dict[str, dict[str, Any]] = {
    "bestcaribbeanproperty.com": {
        "name": "Best Caribbean Property",
        "sitemap": "https://bestcaribbeanproperty.com/cf47rs_property-sitemap.xml",
        "include": r"^/es/properties/[^/]+/?$",
    },
    "remaxmaya.com": {
        "name": "RE/MAX Maya",
        "sitemap": "https://remaxmaya.com/estate_property-sitemap.xml",
        "include": r"^/properties/[^/]+/?$",
    },
    "moskito.mx": {
        "name": "Moskito Real Estate",
        "sitemap": "https://moskito.mx/lcentral_listings-sitemap.xml",
        "include": r"^/es/bienes-raices/[^/]+/?$",
    },
}

# A price with no stated currency is ambiguous inside these bands (USD or MXN?) and is skipped.
AMBIGUOUS_SALE = (400_000, 2_500_000)
AMBIGUOUS_RENT_MONTH = (3_000, 15_000)


def site_for(url: str, sites: dict[str, dict[str, Any]] = SITES) -> str | None:
    host = host_of(url)
    return host if host in sites else None


def parse_sitemap(xml: str, site: str, sites: dict[str, dict[str, Any]] = SITES) -> list[dict[str, str | None]]:
    """[{url, lastmod, site}] for the URLs in a sitemap that look like one listing's page."""
    pattern = re.compile(sites[site]["include"])
    out: list[dict[str, str | None]] = []
    for block in re.findall(r"<url>([\s\S]*?)</url>", xml):
        loc = re.search(r"<loc>\s*([^<\s]+)\s*</loc>", block)
        if not loc:
            continue
        url = loc.group(1).strip()
        if not pattern.match(urlsplit(url).path):
            continue
        lastmod = re.search(r"<lastmod>\s*([^<\s]+)\s*</lastmod>", block)
        out.append({"url": url, "lastmod": lastmod.group(1) if lastmod else None, "site": site})
    return out


def read_sitemaps(scraper: ListingScraper, sites: dict[str, dict[str, Any]] = SITES) -> list[dict[str, str | None]]:
    entries: list[dict[str, str | None]] = []
    for site, cfg in sites.items():
        fetched = scraper.fetch(cfg["sitemap"])
        if fetched.blocked or not fetched.html:
            logger.warning("Sitemap of {} not readable: {}", site, fetched.reason)
            continue
        found = parse_sitemap(fetched.html, site, sites)
        logger.info("{}: {} listing URL(s) in the sitemap", site, len(found))
        entries += found
    return entries


def _ambiguous(price: float, operation: Operation) -> bool:
    low, high = AMBIGUOUS_SALE if operation is Operation.SALE else AMBIGUOUS_RENT_MONTH
    return low <= price <= high


def record_from_page(url: str, page_hints: dict[str, Any], markdown: str, title: str | None, usd_mxn: float,
                     site_name: str | None = None) -> dict[str, Any] | None:
    """One index record from a scraped page, or None when it must not be indexed (see the module docstring)."""
    hints = dict(page_hints)
    if hints.get("price") is None and hints.get("m2_size") is None:
        return None
    try:
        listing = PropertyListing(url=url, usd_mxn_rate=usd_mxn, summary=markdown[:400], **{k: hints[k] for k in (
            "title", "operation", "property_type", "town", "neighborhood", "bedrooms", "bathrooms", "m2_size", "land_m2", "price", "currency",
        ) if k in hints})
    except ValueError as err:
        logger.warning("Rejected {}: {}", url, str(err).splitlines()[0])
        return None
    if listing.operation is Operation.RENTAL_SHORT:
        logger.info("Skipped {}: nightly rental (the index holds monthly rents only)", url)
        return None
    if not listing.town:
        logger.info("Skipped {}: no town could be read", url)
        return None
    currency = listing.currency
    if listing.price is not None:
        if listing.currency_assumed and _ambiguous(listing.price, listing.operation):
            logger.info("Skipped {}: price {} has no currency and could be USD or MXN", url, listing.price)
            return None
        if currency is None:  # cannot happen once a price exists, kept as a guard: the index would default it to MXN
            currency = infer_currency(listing.price, listing.price_period, listing.operation.value)
    return {
        "url": url,
        "external_id": urlsplit(url).path.rstrip("/").rsplit("/", 1)[-1][:80],
        "title": listing.title or title,
        "operation": "sale" if listing.operation is Operation.SALE else "rental",
        "price": listing.price,
        "currency": currency if listing.price is not None else None,
        "currency_assumed": listing.currency_assumed,
        "property_type": listing.property_type,
        "built_m2": listing.m2_size,
        "land_m2": listing.land_m2,
        "bedrooms": listing.bedrooms,
        "bathrooms": listing.bathrooms,
        "town": listing.town,
        "neighborhood": listing.neighborhood,
        "description": (markdown or "")[:900],
        "listed_by": site_name,
        "photos": [],
    }


def scrape_pages(scraper: ListingScraper, pages: list[dict[str, str]], usd_mxn: float,
                 sites: dict[str, dict[str, Any]] = SITES) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for item in pages:
        url = item["url"]
        site = item.get("site") or site_for(url, sites)
        page = scraper.scrape(url)
        if not page.ok:
            logger.warning("Skipped {}: {}", url, page.fetch.reason or "empty page")
            continue
        record = record_from_page(url, page.hints, page.markdown, page.title, usd_mxn, (sites.get(site or "") or {}).get("name"))
        if record:
            records.append(record)
    logger.info("{} record(s) from {} page(s)", len(records), len(pages))
    return records


def main(argv: list[str] | None = None, settings: Settings | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m src.worker", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["sitemap", "scrape"])
    args = parser.parse_args(argv)
    settings = settings or get_settings()
    logger.remove()
    logger.add(sys.stderr, level=settings.log_level.upper(), format="{time:HH:mm:ss} {level:<7} {message}")  # stdout stays pure JSON
    allowed = tuple(SITES) if settings.allowed_domains == () else tuple(dict.fromkeys(tuple(settings.allowed_domains) + tuple(SITES)))
    scraper = ListingScraper(settings.model_copy(update={"allowed_domains": allowed}))
    if args.command == "sitemap":
        json.dump(read_sitemaps(scraper), sys.stdout)
        return 0
    pages = json.load(sys.stdin)
    for record in scrape_pages(scraper, pages, settings.usd_mxn_rate):
        sys.stdout.write(json.dumps(record, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
