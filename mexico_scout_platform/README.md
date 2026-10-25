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
ollama pull llama3.1                                            # only for the agent mode; any model Ollama or LiteLLM supports works
pytest                                                          # 50 offline tests; no network, no model download
```
The first run that stores a listing downloads the embedding model once (about 220 MB, from Hugging Face). After that it is offline.

## Use
```bash
# Rules only (no LLM): scrape -> store -> comps -> maths -> dossier in ./output
python -m src.pipeline run --no-agents --url https://propiedades.com/aldea-zama-tulum/departamentos-venta --max-price-usd 300000

# With the CrewAI agents (needs Ollama running); with no flags it asks its questions in the terminal
python -m src.pipeline run --town Tulum --neighborhood "Aldea Zama" --max-price-usd 300000 --min-bedrooms 2 --url <results or listing URL>
python -m src.pipeline run

python -m src.pipeline ingest <url> [<url> ...]          # scrape pages into the database
python -m src.pipeline search "depa con alberca" --town Tulum --operation sale --max-price-usd 300000
python -m src.pipeline analyze <url> [--down-payment 0.35]   # short-term vs long-term for one stored listing
python -m src.pipeline stats
```
For comps to be real, the database needs rental listings too: ingest short-term (per night) and long-term (per month) pages for the same
neighbourhood. With fewer than 3 comps the model says so and uses editable defaults (`MARKET_DEFAULTS` in `src/tools/math_engine.py`).

## What it will and will not do
- Fetches only hosts in `ALLOWED_DOMAINS`, honours robots.txt, spaces requests with randomised delays, and caps pages per run.
- Mimics a desktop browser's TLS fingerprint on the HTTP layer and falls back once to a headless browser. It does **not** solve CAPTCHAs or
  Cloudflare challenges or log in: a challenge page is reported as `blocked` and skipped. Inmuebles24, Lamudi, Vivanuncios and MercadoLibre
  refused every plain fetch in the PropLync runs, so they are off by default. Use a licensed feed or the Apify adapters in proplync.mx `ingest/`.
  Respect each site's terms of use: that responsibility is the operator's.
- The financial model is a screening tool built on asking prices and assumptions, **not tax, legal or financial advice**. Income tax on rents is not
  modelled unless you set it. Check HOA rules and local vacation-rental regulation before buying.

## Layout
`src/config.py` settings | `src/domain.py` Mexican formats and neighbourhoods | `src/models.py` schemas | `src/db/vector_db.py` Qdrant |
`src/tools/scraper.py` | `src/tools/math_engine.py` | `src/agents/{definitions,crew}.py` | `src/pipeline.py` CLI | `tests/`.
