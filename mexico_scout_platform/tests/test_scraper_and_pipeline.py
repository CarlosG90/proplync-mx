import json

from src.agents import definitions as defs
from src.models import Operation
from src.pipeline import analyze_url, ingest_urls, listing_from_hints, main, render_report
from src.tools.math_engine import Assumptions
from src.tools.scraper import ListingScraper, classify_page, looks_blocked


def scraper(settings, **kw):
    return ListingScraper(settings, sleep=lambda s: None, **kw)


def test_blocked_detection():
    assert looks_blocked(403, "")
    assert looks_blocked(200, "<title>Just a moment...</title> checking your browser")
    assert looks_blocked(None, "")
    assert not looks_blocked(200, "<html>" + "Departamento en venta " * 50 + "</html>")
    assert not looks_blocked(200, "<html>" + "x" * 90_000 + " captcha </html>")  # a big real page that merely mentions a captcha
    # the real propiedades.com answer: HTTP 200, but the page is a visitor check
    assert looks_blocked(200, '<html><head><title>Challenge Validation</title></head><body><div id="sec-if-container"><iframe id="sec-cpt-if"></iframe></div></body></html>')


def test_classify_separates_a_refusal_a_challenge_a_js_shell_and_a_real_page():
    real = "<html><body>" + "Departamento en venta con alberca. " * 30 + "</body></html>"
    shell = '<html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>'
    assert classify_page(200, real) == "ok"
    assert classify_page(403, "x") == "refused" and classify_page(429, "") == "refused"
    assert classify_page(200, "<title>Just a moment...</title><body>cf-chl</body>") == "challenge"
    assert classify_page(200, shell) == "thin" and not looks_blocked(200, shell)
    assert classify_page(None, "") == "error"


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


# ---------- guided agent mode (the model is stubbed: these run offline) ----------

def _guided(settings, portal, store, run_task, sleeps=None):
    from src.agents.crew import ScoutCrew
    from src.agents.definitions import ToolContext
    from src.models import SearchBrief
    ctx = ToolContext(settings=settings, scraper=scraper(settings), store=store)
    crew = ScoutCrew(settings, ctx, run_task=run_task, sleep=(sleeps.append if sleeps is not None else (lambda s: None)))
    return crew.run(SearchBrief(town="Tulum", max_price_usd=300000, urls=[portal + "/resultados"]))


def test_guided_mode_agent_corrections_win_and_memo_is_appended(settings, portal, store):
    seen = []

    def run_task(agent, description, expected):
        seen.append(agent.role)
        if agent.role.startswith("Property"):
            return '```json\n{"title": "Depto corregido", "bathrooms": 2.5, "amenities": ["alberca"], "price": null, "summary": "Depto en Aldea Zama."}\n```'
        return "Short-term looks stronger; occupancy is an assumption."

    out = _guided(settings, portal, store, run_task)
    assert out["mode"] == "agents-guided" and len(out["saved_urls"]) == 7 and store.count() == 7
    assert seen.count("Property Sourcing Agent") == 7 and seen.count("Financial Investment Analyst") == 1   # one small call each
    sale = store.get(portal + "/venta/propiedad-1")
    assert sale.title == "Depto corregido" and sale.bathrooms == 2.5 and sale.amenities == ["alberca"]
    assert sale.price == 4_500_000, "a null from the agent never erases what the rules read"
    assert "**Analyst memo**" in out["dossier_markdown"] and "Short-term looks stronger" in out["dossier_markdown"]
    assert "Cap rate" in out["dossier_markdown"], "the numbers come from the engine, not the model"


def test_guided_mode_keeps_the_rule_based_record_when_the_model_is_useless(settings, portal, store):
    def run_task(agent, description, expected):
        raise ConnectionError("model server down") if agent.role.startswith("Property") else "memo"

    out = _guided(settings, portal, store, run_task)
    assert len(out["saved_urls"]) == 7 and len(out["reports"]) == 1
    assert store.get(portal + "/venta/propiedad-1").price_usd == 250_000
    out2 = _guided(settings, portal, store, lambda a, d, e: "no json here at all")
    assert len(out2["saved_urls"]) >= 7


def test_guided_mode_waits_out_a_rate_limit_and_retries(settings, portal, store):
    class RateLimitError(Exception): pass
    calls = {"n": 0}

    def run_task(agent, description, expected):
        calls["n"] += 1
        if calls["n"] in (1, 2):
            raise RateLimitError("Rate limit reached for model on tokens per minute")
        return '{"title": "ok"}' if agent.role.startswith("Property") else "memo"

    sleeps = []
    out = _guided(settings, portal, store, run_task, sleeps)
    assert sleeps[:2] == [15, 30], "backs off a little longer each time"
    assert len(out["saved_urls"]) == 7
    assert store.get(portal + "/venta/propiedad-1").title == "ok"


def test_extract_json_object_is_tolerant():
    from src.agents.crew import extract_json_object, is_rate_limit
    assert extract_json_object('<think>hmm {not json}</think>```json\n{"a": 1}\n```') == {"a": 1}
    assert extract_json_object("sin json") is None and extract_json_object("{broken") is None and extract_json_object("[1,2]") is None
    assert is_rate_limit(Exception("Rate limit reached")) and not is_rate_limit(ValueError("nope"))


def test_a_challenge_served_with_200_is_never_retried_in_a_browser(settings, portal, monkeypatch):
    import scrapling.fetchers as f
    from tests import conftest
    conftest_site = conftest.build_site()   # noqa: F841 - the shared portal fixture serves /bloqueado as 403
    called = []
    monkeypatch.setattr(f.StealthyFetcher, "fetch", classmethod(lambda cls, *a, **k: called.append(1)))
    s = scraper(settings.model_copy(update={"browser_fallback": True}))
    result = s.fetch(portal + "/bloqueado")
    assert result.blocked and result.reason == "refused_http_403" and called == [], "a refusal stops the run for that page: no browser, no solving"


def test_a_javascript_shell_is_rendered_once_in_a_browser(settings, portal, monkeypatch):
    import scrapling.fetchers as f
    real = "<html><body>" + "Departamento en venta en Aldea Zama. " * 30 + "</body></html>"
    class Rendered:  # what the browser tier returns
        status, html_content = 200, real
    calls = []
    monkeypatch.setattr(f.StealthyFetcher, "fetch", classmethod(lambda cls, url, **k: calls.append(url) or Rendered()))
    s = scraper(settings.model_copy(update={"browser_fallback": True}))
    monkeypatch.setattr("src.tools.scraper.classify_page", lambda status, html: "thin" if html == "shell" else "ok")
    # tier 1 gets a shell, tier 2 gets the page
    import src.tools.scraper as sc
    monkeypatch.setattr(f.Fetcher, "get", classmethod(lambda cls, url, **k: type("R", (), {"status": 200, "html_content": "shell" if "propiedad" in url else ""})()))
    out = s.fetch(portal + "/venta/propiedad-1")
    assert out.tier == "browser" and not out.blocked and len(calls) == 1
