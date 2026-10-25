import io
import json

from src import worker
from src.tools.scraper import ListingScraper

SITES = {"127.0.0.1": {"name": "Fake portal", "sitemap": "SITEMAP", "include": r"^/(venta|renta|renta-vacacional)/[^/]+/?$"}}


def scraper(settings):
    return ListingScraper(settings, sleep=lambda s: None)


def test_parse_sitemap_keeps_only_listing_urls_and_their_lastmod():
    xml = ("<urlset><url><loc>https://x.mx/es/properties/casa-1/</loc><lastmod>2026-10-01T00:00:00+00:00</lastmod></url>"
           "<url><loc>https://x.mx/es/properties/</loc></url><url><loc>https://x.mx/blog/post</loc></url>"
           "<url><loc>https://x.mx/es/properties/casa-2</loc></url></urlset>")
    sites = {"x.mx": {"include": r"^/es/properties/[^/]+/?$"}}
    found = worker.parse_sitemap(xml, "x.mx", sites)
    assert [f["url"] for f in found] == ["https://x.mx/es/properties/casa-1/", "https://x.mx/es/properties/casa-2"]
    assert found[0]["lastmod"] == "2026-10-01T00:00:00+00:00" and found[1]["lastmod"] is None and found[0]["site"] == "x.mx"


def test_the_real_site_configs_match_real_listing_urls():
    cases = {
        "bestcaribbeanproperty.com": ("/es/properties/departamento-de-2-recamaras-en-aldea-zama/", ["/properties/luxury-condo-in-corasol/", "/es/properties/", "/es/location/x/"]),
        "remaxmaya.com": ("/properties/artia-condos-2-bedroom-penthouse-for-sale-in-aldea-zama/", ["/properties/", "/agents/x/"]),
        "moskito.mx": ("/es/bienes-raices/departamento-de-dos-habitaciones-en-venta-en-tulum-164/", ["/real-estate/", "/es/bienes-raices/"]),
    }
    import re
    for site, (good, bad) in cases.items():
        pattern = re.compile(worker.SITES[site]["include"])
        assert pattern.match(good), site
        assert not any(pattern.match(b) for b in bad), site


def test_read_sitemaps_from_a_local_site(settings, portal):
    sites = {"127.0.0.1": {**SITES["127.0.0.1"], "sitemap": portal + "/sitemap.xml"}}
    entries = worker.read_sitemaps(scraper(settings), sites)
    assert len(entries) == 7 and all(e["site"] == "127.0.0.1" and e["lastmod"] for e in entries)
    assert not any("contacto" in e["url"] or "blog" in e["url"] for e in entries)


def test_a_sale_page_becomes_an_index_record_with_an_explicit_currency(settings, portal):
    page = scraper(settings).scrape(portal + "/venta/propiedad-1")
    rec = worker.record_from_page(page.url, page.hints, page.markdown, page.title, 18.0, "Fake portal")
    assert (rec["operation"], rec["price"], rec["currency"], rec["bedrooms"], rec["built_m2"]) == ("sale", 4_500_000, "MXN", 2, 105)
    assert (rec["town"], rec["neighborhood"], rec["listed_by"], rec["external_id"]) == ("Tulum", "Aldea Zama", "Fake portal", "propiedad-1")
    assert rec["photos"] == [] and rec["currency_assumed"] is False


def test_a_monthly_rental_is_kept_and_a_nightly_one_is_dropped(settings, portal):
    sc = scraper(settings)
    long = sc.scrape(portal + "/renta/propiedad-1")
    rec = worker.record_from_page(long.url, long.hints, long.markdown, long.title, 18.0)
    assert (rec["operation"], rec["price"], rec["currency"]) == ("rental", 1700, "USD")
    short = sc.scrape(portal + "/renta-vacacional/propiedad-1")
    assert worker.record_from_page(short.url, short.hints, short.markdown, short.title, 18.0) is None, "a nightly rate must never enter the index as a rent"


def test_an_ambiguous_price_without_a_currency_is_skipped_but_a_clear_one_is_inferred():
    base = {"title": "Casa en venta en Tulum", "operation": "sale", "town": "Tulum", "neighborhood": "Aldea Zama", "bedrooms": 2, "m2_size": 90}
    assert worker.record_from_page("https://x.mx/a", {**base, "price": 900_000}, "t", None, 18.0) is None, "US$900k or MXN 900k: do not guess"
    assert worker.record_from_page("https://x.mx/a", {**base, "price": 4_500_000}, "t", None, 18.0)["currency"] == "MXN"
    assert worker.record_from_page("https://x.mx/a", {**base, "price": 175_000}, "t", None, 18.0)["currency"] == "USD"
    assert worker.record_from_page("https://x.mx/a", {**base, "price": 900_000, "currency": "USD"}, "t", None, 18.0)["currency"] == "USD", "a stated currency is never second-guessed"


def test_pages_with_nothing_to_index_are_dropped():
    assert worker.record_from_page("https://x.mx/a", {"title": "Contacto"}, "t", None, 18.0) is None
    assert worker.record_from_page("https://x.mx/a", {"price": 4_500_000, "currency": "MXN"}, "t", None, 18.0) is None, "no town"


def test_scrape_command_prints_one_json_record_per_line_and_nothing_else(settings, portal, monkeypatch, capsys):
    pages = [{"url": portal + "/venta/propiedad-1"}, {"url": portal + "/bloqueado"}, {"url": portal + "/renta-vacacional/propiedad-2"}]
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(pages)))
    assert worker.main(["scrape"], settings) == 0
    lines = [l for l in capsys.readouterr().out.splitlines() if l.strip()]
    assert len(lines) == 1, "the blocked page and the nightly rental are not records"
    assert json.loads(lines[0])["price"] == 4_500_000


# ---------- sanity bounds, from the first real backfill ----------
BASE = {"title": "Casa en venta en Playa del Carmen", "operation": "sale", "property_type": "house", "town": "Playa del Carmen", "bedrooms": 3,
        "m2_size": 220, "price": 450_000, "currency": "USD"}


def rec(**over):
    hints = {**BASE, **over}
    return worker.record_from_page("https://x.mx/a", hints, "texto", hints.get("title"), 18.0, "Site")


def test_an_implausible_price_is_never_indexed():
    assert rec()["price"] == 450_000
    assert rec(price=4, currency="MXN") is None, "houses priced at MXN 4 were indexed in the first backfill"
    assert rec(price=500, currency="USD") is None
    assert rec(price=90_558, currency="USD", operation="rental_long") is None, "a US$90k monthly rent is a sale ad mislabelled"
    assert rec(price=1_800, currency="USD", operation="rental_long")["operation"] == "rental"
    assert rec(price=100, currency="USD", operation="rental_long") is None
    assert rec(price=50_000_000, currency="USD") is None


def test_an_area_that_cannot_be_right_is_dropped_but_the_listing_stays():
    assert rec()["built_m2"] == 220
    assert rec(m2_size=36, property_type="penthouse", price=1_960_704)["built_m2"] is None, "a 3-bedroom penthouse with 36 m2 for US$1.96M"
    assert rec(m2_size=3750, property_type="apartment", price=300_000)["built_m2"] is None
    kept = rec(m2_size=3750, property_type="apartment", price=300_000)
    assert kept["price"] == 300_000 and kept["bedrooms"] == 3, "only the area is dropped"
    assert rec(m2_size=220, price=45_000_000 // 10, currency="USD")["built_m2"] == 220


def test_a_lot_keeps_its_land_area_from_the_title_and_loses_its_rooms():
    lot = rec(title="Terreno en Venta 240m² en El Cielo, Playa del Carmen", property_type="land", bedrooms=1, bathrooms=1, m2_size=334.83, price=87_000)
    assert (lot["land_m2"], lot["built_m2"], lot["bedrooms"], lot["bathrooms"]) == (240, None, None, None)
    nosize = rec(title="Lotes en Venta en Tulum", property_type="land", m2_size=97, price=173_188)
    assert nosize["land_m2"] is None and nosize["built_m2"] is None, "an area found only in the body is not trusted for a lot"
    assert nosize["price"] == 173_188


def test_a_place_outside_the_markets_is_skipped():
    assert rec(out_of_area=True) is None
