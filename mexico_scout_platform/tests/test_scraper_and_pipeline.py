import json

from src.agents import definitions as defs
from src.models import Operation
from src.pipeline import analyze_url, ingest_urls, listing_from_hints, main, render_report
from src.tools.math_engine import Assumptions
from src.tools.scraper import ListingScraper, looks_blocked


def scraper(settings, **kw):
    return ListingScraper(settings, sleep=lambda s: None, **kw)


def test_blocked_detection():
    assert looks_blocked(403, "")
    assert looks_blocked(200, "<title>Just a moment...</title> checking your browser")
    assert looks_blocked(None, "")
    assert not looks_blocked(200, "<html>" + "Departamento en venta " * 50 + "</html>")
    assert not looks_blocked(200, "<html>" + "x" * 90_000 + " captcha </html>")  # a big real page that merely mentions a captcha


def test_scrape_a_listing_end_to_end(settings, portal):
    page = scraper(settings).scrape(portal + "/venta/propiedad-1")
    assert page.ok and page.fetch.tier == "http" and page.fetch.html == ""
    assert "4,500,000" in page.markdown and "Menú" not in page.markdown
    h = page.hints
    assert (h["price"], h["currency"], h["bedrooms"], h["m2_size"], h["neighborhood"], h["town"]) == (4_500_000, "MXN", 2, 105, "Aldea Zama", "Tulum")


def test_a_challenge_page_is_reported_blocked_and_never_solved(settings, portal):
    page = scraper(settings).scrape(portal + "/bloqueado")
    assert page.fetch.blocked and not page.ok and page.fetch.reason == "refused_http_403"


def test_robots_allowlist_and_budget_are_enforced(settings, portal):
    s = scraper(settings)
    assert s.fetch(portal + "/privado/1").reason == "disallowed_by_robots_txt"
    assert s.fetch("https://example.com/x").reason == "domain_not_in_allowlist"
    tight = scraper(settings.model_copy(update={"max_pages_per_run": 1}))
    assert tight.fetch(portal + "/venta/propiedad-1").tier == "http"
    assert tight.fetch(portal + "/renta/propiedad-1").reason == "page_budget_exhausted"
    off = scraper(settings.model_copy(update={"respect_robots": False}))
    assert off.fetch(portal + "/privado/1").tier == "http"


def test_discover_finds_listing_links_only(settings, portal):
    urls = scraper(settings).discover(portal + "/resultados", limit=50)
    assert len(urls) == 7 and all("propiedad-" in u for u in urls)
    assert not any("otro.com" in u or "contacto" in u for u in urls)


def test_politeness_delays_are_randomised_and_paced_per_host(settings):
    slept = []
    s = ListingScraper(settings.model_copy(update={"request_delay_min": 3.0, "request_delay_max": 9.0}), sleep=slept.append)
    delays = {s.next_delay() for _ in range(40)}
    assert len(delays) > 20 and all(3.0 <= d <= 9.0 * 2.5 for d in delays)
    s._pace("a.mx"); assert slept == []          # the first request to a host is not delayed
    s._pace("a.mx"); assert len(slept) == 1 and slept[0] > 0
    s._pace("b.mx"); assert len(slept) == 1       # another host has its own clock


def test_deterministic_pipeline_scrape_store_comps_and_maths(settings, portal, store):
    sc = scraper(settings)
    stored = ingest_urls(sc.discover(portal + "/resultados", limit=50), sc, store, settings)
    assert len(stored) == 7 and store.count() == 7
    ops = sorted(l.operation.value for l in stored)
    assert ops == ["rental_long"] * 3 + ["rental_short"] * 3 + ["sale"]

    report = analyze_url(portal + "/venta/propiedad-1", store, Assumptions())
    assert report["subject"]["neighborhood"] == "Aldea Zama" and report["comps_used"] == 6 and report["comps_scope"] == "neighborhood"
    assert report["purchase_price_usd"] == 250_000
    short, long = report["short_term"], report["long_term"]
    assert short["basis"]["adr"].startswith("median of 3") and long["basis"]["rent"].startswith("median of 3")
    assert long["details"]["monthly_rent_usd"] == 1800
    text = render_report(report)
    assert "Short-term" in text and "Cap rate" in text and "Aldea Zama" in text


def test_listing_from_hints_rejects_pages_with_nothing_to_store():
    assert listing_from_hints("https://x.mx/a", {"title": "Contacto"}, 18.0) is None
    assert listing_from_hints("https://x.mx/a", {"price": 4_500_000, "currency": "MXN", "operation": "sale"}, 18.0).price_usd == 250_000


def test_agent_tools_validate_and_never_raise(settings, portal, store):
    ctx = defs.ToolContext(settings=settings, scraper=scraper(settings), store=store)
    defs.configure_tools(ctx)
    bad = json.loads(defs.save_listing.run(listing_json="{not json"))
    assert bad["saved"] is False
    invalid = json.loads(defs.save_listing.run(listing_json=json.dumps({"url": "ftp://x", "price": 1})))
    assert invalid["saved"] is False and "url" in invalid["error"]
    ok = json.loads(defs.save_listing.run(listing_json=json.dumps({"url": "https://x.mx/p/1", "operation": "sale", "town": "Tulum", "neighborhood": "Aldea Zamá", "bedrooms": 2, "price": 4500000, "currency": "MXN"})))
    assert ok["saved"] and ok["price_usd"] == 250_000 and ok["neighborhood"] == "Aldea Zama"
    assert json.loads(defs.run_financial_model.run(listing_url="https://x.mx/nope"))["error"].startswith("listing not found")
    scraped = json.loads(defs.scrape_listing_page.run(url=portal + "/venta/propiedad-1"))
    assert scraped["ok"] and scraped["hints"]["price"] == 4_500_000
    model = json.loads(defs.run_financial_model.run(listing_url="https://x.mx/p/1"))
    assert "warnings" in model and "x.mx/p/1" in model["subject_url"] and ctx.reports


def test_cli_ingest_search_and_analyze(settings, portal, monkeypatch, tmp_path, capsys):
    from src import pipeline
    monkeypatch.setattr(pipeline, "get_settings", lambda: settings)
    monkeypatch.setattr(pipeline, "OUTPUT_DIR", tmp_path / "out")
    monkeypatch.setattr(pipeline, "setup_logging", lambda s: None)
    from tests.conftest import OfflineStore
    monkeypatch.setattr(pipeline, "ListingStore", lambda s: OfflineStore(s))
    assert main(["ingest", portal + "/resultados"]) == 0
    assert main(["stats"]) == 0 and "7 listing(s)" in capsys.readouterr().out
    assert main(["search", "departamento aldea zama", "--operation", "sale", "--neighborhood", "Aldea Zama"]) == 0
    assert "sale" in capsys.readouterr().out
    assert main(["analyze", portal + "/venta/propiedad-1"]) == 0
    assert list((tmp_path / "out").glob("analysis-*.md"))
    assert main(["run", "--no-agents", "--url", portal + "/resultados", "--max-price-usd", "300000"]) == 0
    assert list((tmp_path / "out").glob("dossier-*.json"))


def test_agent_mode_falls_back_to_the_rules_when_the_agents_store_nothing(settings, portal, monkeypatch, tmp_path):
    from src import pipeline
    from tests.conftest import OfflineStore

    class UselessCrew:
        def __init__(self, *a, **k): pass
        def run(self, brief): return {"dossier_markdown": "nothing", "saved_urls": [], "reports": {}}

    monkeypatch.setattr(pipeline, "get_settings", lambda: settings)
    monkeypatch.setattr(pipeline, "OUTPUT_DIR", tmp_path / "out")
    monkeypatch.setattr(pipeline, "setup_logging", lambda s: None)
    monkeypatch.setattr(pipeline, "ListingStore", lambda s: OfflineStore(s))
    monkeypatch.setattr(pipeline, "ScoutCrew", UselessCrew)
    assert main(["run", "--url", portal + "/resultados", "--max-price-usd", "300000"]) == 0
    data = json.loads(next((tmp_path / "out").glob("dossier-*.json")).read_text())
    assert data["mode"] == "rules" and len(data["reports"]) == 1
    assert "stored nothing" in next((tmp_path / "out").glob("dossier-*.md")).read_text()


def test_agent_mode_survives_a_crashing_crew(settings, portal, monkeypatch, tmp_path):
    from src import pipeline
    from tests.conftest import OfflineStore

    class CrashingCrew:
        def __init__(self, *a, **k): pass
        def run(self, brief): raise ConnectionError("ollama is down")

    monkeypatch.setattr(pipeline, "get_settings", lambda: settings)
    monkeypatch.setattr(pipeline, "OUTPUT_DIR", tmp_path / "out")
    monkeypatch.setattr(pipeline, "setup_logging", lambda s: None)
    monkeypatch.setattr(pipeline, "ListingStore", lambda s: OfflineStore(s))
    monkeypatch.setattr(pipeline, "ScoutCrew", CrashingCrew)
    assert main(["run", "--url", portal + "/resultados"]) == 0
    assert json.loads(next((tmp_path / "out").glob("dossier-*.json")).read_text())["mode"] == "rules"


def test_crew_objects_wire_up_without_calling_a_model(settings, store):
    from src.agents.definitions import build_agents, build_tasks
    from src.models import SearchBrief
    sourcing, analyst = build_agents(settings)
    t1, t2 = build_tasks(SearchBrief(town="Tulum", urls=["https://x.mx"]), sourcing, analyst, 18.0)
    assert {t.name for t in sourcing.tools} == {"discover_listing_urls", "scrape_listing_page", "save_listing", "search_listings"}
    assert {t.name for t in analyst.tools} == {"search_listings", "run_financial_model"}
    assert t2.context == [t1]
    for prompt in (sourcing.backstory, analyst.backstory):
        assert "0.1% to 0.5%" in prompt and "fideicomiso" in prompt and "US$500-1,000" in prompt
