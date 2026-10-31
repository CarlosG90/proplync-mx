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
    # Same listing platform as Moskito (lcentral), two sitemap files. Added for its long-term rentals (about 15 in Spanish on
    # 2026-10-31, out of ~590): the index had only 15 rental comps, so few investor briefs could get a yield estimate. The English
    # pages (/real-estate/) repeat the Spanish ones, so only /es/ is read: PropLync's default, and no double fetching.
    "junglerealtor.com": {
        "name": "Jungle Realtor",
        "sitemap": [
            "https://junglerealtor.com/lcentral_listings-sitemap.xml",
            "https://junglerealtor.com/lcentral_listings-sitemap2.xml",
        ],
        "include": r"^/es/real-estate/[^/]+/?$",
    },
}

# A price with no stated currency is ambiguous inside these bands (USD or MXN?) and is skipped.
AMBIGUOUS_SALE = (400_000, 2_500_000)
AMBIGUOUS_RENT_MONTH = (3_000, 15_000)

# Sanity bounds, in USD. Outside them a figure is almost surely a parsing mistake, and a wrong price in the index is worse than a missing
# listing. Found in the first real backfill: houses priced at "4" MXN, a "rental" at US$90,558 a month.
SALE_USD = (15_000, 20_000_000)
RENT_MONTH_USD = (150, 15_000)
BUILT_M2 = {"apartment": (15, 800), "penthouse": (15, 1_200), "house": (25, 3_500)}
BUILT_M2_ANY = (10, 10_000)
SALE_USD_PER_M2 = (250, 25_000)
MIN_M2_PER_BEDROOM = 18


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
        urls = cfg["sitemap"] if isinstance(cfg["sitemap"], list) else [cfg["sitemap"]]
        found: list[dict[str, str | None]] = []
        for sitemap_url in urls:
            fetched = scraper.fetch(sitemap_url)
            if fetched.blocked or not fetched.html:
                logger.warning("Sitemap {} of {} not readable: {}", sitemap_url, site, fetched.reason)
                continue
            found += parse_sitemap(fetched.html, site, sites)
        logger.info("{}: {} listing URL(s) in the sitemap", site, len(found))
        entries += found
    return entries


def _ambiguous(price: float, operation: Operation) -> bool:
    low, high = AMBIGUOUS_SALE if operation is Operation.SALE else AMBIGUOUS_RENT_MONTH
    return low <= price <= high


def _area_in_title(title: str | None) -> float | None:
    """A lot says its size in its title ("Terreno 240m²"); the body is full of other areas."""
    m = re.search(r"(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?|\d+)\s*m(?:2|²)", str(title or ""), re.IGNORECASE)
    if not m:
        return None
    raw = m.group(1)
    raw = raw.replace(",", "") if raw.count(",") >= 1 and "." not in raw else raw.replace(".", "").replace(",", ".") if raw.count(".") > 1 else raw.replace(",", "")
    try:
        return float(raw)
    except ValueError:
        return None


def record_from_page(url: str, page_hints: dict[str, Any], markdown: str, title: str | None, usd_mxn: float,
                     site_name: str | None = None) -> dict[str, Any] | None:
    """One index record from a scraped page, or None when it must not be indexed (see the module docstring)."""
    hints = dict(page_hints)
    if hints.get("out_of_area"):
        logger.info("Skipped {}: the title names a place outside the four markets", url)
        return None
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
        low, high = SALE_USD if listing.operation is Operation.SALE else RENT_MONTH_USD
        if listing.price_usd is None or not (low <= listing.price_usd <= high):
            logger.info("Skipped {}: price {} {} (about US${}) is outside what a {} here can be", url, listing.price, currency, listing.price_usd,
                        "sale" if listing.operation is Operation.SALE else "monthly rent")
            return None

    built, land, bedrooms, bathrooms = listing.m2_size, listing.land_m2, listing.bedrooms, listing.bathrooms
    if listing.property_type == "land":
        # A lot: its area is land, taken from the title when it says one; it has no rooms.
        land, built, bedrooms, bathrooms = _area_in_title(listing.title or title) or land, None, None, None
    elif built is not None:
        low_m2, high_m2 = BUILT_M2.get(listing.property_type or "", BUILT_M2_ANY)
        if bedrooms:
            low_m2 = max(low_m2, MIN_M2_PER_BEDROOM * bedrooms)   # a 3-bedroom home of 34 m2 is a misread, not a listing
        per_m2 = (listing.price_usd / built) if (listing.price_usd and listing.operation is Operation.SALE) else None
        if not (low_m2 <= built <= high_m2) or (per_m2 is not None and not (SALE_USD_PER_M2[0] <= per_m2 <= SALE_USD_PER_M2[1])):
            logger.info("Dropped the area of {}: {} m2 does not fit a {} at this price", url, built, listing.property_type)
            built = None
    if built is None and listing.price is None:
        return None
    return {
        "url": url,
        "external_id": urlsplit(url).path.rstrip("/").rsplit("/", 1)[-1][:80],
        "title": listing.title or title,
        "operation": "sale" if listing.operation is Operation.SALE else "rental",
        "price": listing.price,
        "currency": currency if listing.price is not None else None,
        "currency_assumed": listing.currency_assumed,
        "property_type": listing.property_type,
        "built_m2": built,
        "land_m2": land,
        "bedrooms": bedrooms,
        "bathrooms": bathrooms,
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
