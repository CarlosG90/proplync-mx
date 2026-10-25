# Mexico Scout Platform

Open-source AI scout for Riviera Maya real estate (Cancún, Playa del Carmen, Tulum, Puerto Morelos).
It finds listings, extracts a structured schema, remembers them in a **local** vector database, and compares a **short-term
vacation rental** against a **long-term rental** for each for-sale property, using comps from the same neighbourhood.
No paid APIs: scraping is Scrapling + Crawl4AI, storage is Qdrant (a folder), embeddings are fastembed (CPU), the agents run on a
local LLM through Ollama (or any endpoint you configure).

This folder is a sub-project of the proplync.mx repo, built to refine its Scout agent and add a financial agent. See `agent.md`.

```
Scrapling fetch -> Crawl4AI markdown -> Sourcing agent -> PropertyListing -> Qdrant -> comps -> math_engine -> Analyst agent -> dossier
```

## Setup (Python 3.12+)
```bash
cd mexico_scout_platform
uv venv --python 3.12 .venv && source .venv/bin/activate       # or: python3.12 -m venv .venv
uv pip install -r requirements-dev.txt                          # or: pip install -r requirements-dev.txt
cp .env.example .env                                            # every value has a default
scrapling install                                               # one-time: browsers for the headless fallback (optional)
# agent mode needs any LLM that LiteLLM supports: a hosted API key (e.g. Groq's free tier) or a local Ollama model
pytest                                                          # 63 offline tests; no network, no model download
```
The first run that stores a listing downloads the embedding model once (about 220 MB, from Hugging Face). After that it is offline.

## Use
```bash
# Rules only (no LLM): scrape -> store -> comps -> maths -> dossier in ./output
python -m src.pipeline run --no-agents --url https://propiedades.com/aldea-zama-tulum/departamentos-venta --max-price-usd 300000

# With the CrewAI agents. Default `--agent-mode guided`: the code fetches and calculates, each agent gets one small call
# (works on rate-limited free tiers, e.g. Groq: LLM_MODEL=groq/qwen/qwen3.8-27b, LLM_MAX_TOKENS=900).
# `--agent-mode tools` lets the agents drive the tools themselves (needs a strong model and generous rate limits).
# With no flags it asks its questions in the terminal
python -m src.pipeline run --town Tulum --neighborhood "Aldea Zama" --max-price-usd 300000 --min-bedrooms 2 --url <results or listing URL>
python -m src.pipeline run

python -m src.pipeline ingest <url> [<url> ...]          # scrape pages into the database
python -m src.pipeline search "depa con alberca" --town Tulum --operation sale --max-price-usd 300000
python -m src.pipeline analyze <url> [--down-payment 0.35]   # short-term vs long-term for one stored listing
python -m src.pipeline stats
```
For comps to be real, the database needs rental listings too: ingest short-term (per night) and long-term (per month) pages for the same
neighbourhood. With fewer than 3 comps the model says so and uses editable defaults (`MARKET_DEFAULTS` in `src/tools/math_engine.py`).

## Feeding the proplync.mx search index (`src/worker.py`)
A bridge, not a second database writer. The Node crawler (`ingest/run.mjs`, source `scraper_web`) calls the worker, then sends what it returns through
the normal index writer (`api/_lib/search/`), so dedupe, merging across sites, currency conversion and embeddings stay in one place.
```bash
python -m src.worker sitemap                      # JSON: every listing URL named by the configured sites' sitemaps
echo '[{"url": "..."}]' | python -m src.worker scrape   # JSON lines: one index record per page that yielded a listing
node ingest/run.mjs --source scraper_web --dry-run --max 10   # the whole path, writing nothing (needs the source enabled, see below)
```
- **Sites** are in `SITES` in `src/worker.py` (sitemap + listing-URL pattern): bestcaribbeanproperty.com, remaxmaya.com, moskito.mx. About 800 listing URLs.
- **Per run** it reads only what is new, plus one seventh of the known listings (so every price refreshes weekly), up to the source's `max_results_per_run` (80).
  Every other listing a sitemap still names is marked "still listed" with no request to the site, so nothing goes stale.
- **Left out on purpose:** nightly/vacation rentals (the index holds monthly rents only, a nightly rate would read as a US$150 rent), prices with no stated
  currency in an ambiguous band (US$900k or MXN 900k?), pages with no price and no size, and pages with no recognisable town.
- **Off by default.** `supabase/017_scraper_web_source.sql` adds the source disabled. After a dry run: `update search_sources set enabled = true where id = 'scraper_web';`.
- Volume reality (2026-10-25): about 800 listings, almost all for sale; only about 8 are long-term rentals. This fills the sales side of the index; rental comps for the
  return estimate stay thin.

## What it will and will not do
- Fetches only hosts in `ALLOWED_DOMAINS`, honours robots.txt, spaces requests with randomised delays, and caps pages per run.
- Mimics a desktop browser's TLS fingerprint on the HTTP layer. Only a bare JavaScript shell is rendered once in a headless browser. It does **not**
  solve CAPTCHAs or challenges, log in, or escalate after a refusal: a 403/429, or a 200 that is really a visitor-check page, is reported as `blocked`
  and skipped. In real runs (2026-10-25) three portals opened and four answered with a visitor check; Inmuebles24, Lamudi, Vivanuncios and
  MercadoLibre refused in the PropLync runs. Use a licensed feed or the Apify adapters in proplync.mx `ingest/` for those.
  Respect each site's terms of use: that responsibility is the operator's.
- The financial model is a screening tool built on asking prices and assumptions, **not tax, legal or financial advice**. Income tax on rents is not
  modelled unless you set it. Check HOA rules and local vacation-rental regulation before buying.

## Layout
`src/config.py` settings | `src/domain.py` Mexican formats and neighbourhoods | `src/models.py` schemas | `src/db/vector_db.py` Qdrant |
`src/tools/scraper.py` | `src/tools/math_engine.py` | `src/agents/{definitions,crew}.py` | `src/pipeline.py` CLI | `tests/`.
