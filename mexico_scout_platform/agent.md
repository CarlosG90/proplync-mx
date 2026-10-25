# agent.md: context for any AI session working in this folder

Read this first. It is the memory of the project; the code is in `src/`.

## Core mission
Automated real-estate **sourcing, persistent caching and financial modelling** for the Mexican Caribbean (Cancún, Playa del
Carmen, Tulum, Puerto Morelos). It finds listings, turns messy Spanish/English pages into one typed schema, remembers them
in a local vector database, and evaluates each for-sale property two ways (short-term vacation rental vs long-term rental)
against local comps.

This is a **sub-project of proplync.mx** (`../` is the PropLync repo). It is the architecture we use to *refine the Scout agent*
and to *add a financial agent* to PropLync. Design every interface so it can be lifted into proplync.mx later (see "Merge path").

## Tech stack constraints (do not break these)
- **100% open source, no paid data APIs.** No OpenAI/Anthropic/Google keys in this package. The LLM is local (Ollama by
  default) or any endpoint the operator configures. Embeddings are local (`fastembed`, ONNX, CPU).
- **Local-first storage:** Qdrant in file mode (`QdrantClient(path=...)`, folder `./qdrant_storage`). Local mode locks the
  folder: one process at a time. Swapping to a Qdrant server means changing the client constructor only.
- **Financial maths is plain Python** (`src/tools/math_engine.py`). Agents never do arithmetic; they call the tool.
- Python 3.12+, strict typing, `loguru` for logging, Pydantic v2 for every schema and for settings (`src/config.py`).
- Pinned dependencies live in `requirements.txt`. If you change one, re-run the tests and update the pin.

## Architecture (the graph)
```
Scrapling (fetch: TLS-impersonating HTTP, then headless browser if refused)
  -> Crawl4AI (HTML -> pruned markdown + CSS extraction; no second download)
  -> Research/Sourcing agent  (confirms rule-based hints, fixes the rest)
  -> PropertyListing (Pydantic)  validated   [src/models.py]
  -> Qdrant upsert (vector + payload; id = hash of the normalised URL, so re-scrapes update)   [src/db/vector_db.py]
  -> find_comps: strict payload filter (operation, neighbourhood, bedrooms) THEN cosine ranking; widens neighbourhood -> town and says so
  -> math_engine.analyze(subject, comps)  -> FinancialReport (every input labelled `comps` or `default_assumption`)
  -> Financial Analyst agent writes the dossier from those numbers
```
Files: `config.py` settings | `domain.py` Mexican formats, neighbourhoods, JSON-LD | `models.py` schemas | `db/vector_db.py` store |
`tools/scraper.py` | `tools/math_engine.py` | `agents/definitions.py` agents, tools, prompts | `agents/crew.py` | `pipeline.py` CLI.
`python -m src.pipeline run --no-agents` runs the whole graph with rules instead of an LLM (no model server needed).

## Domain constraints (Mexico, Quintana Roo)
- Currency: MXN and USD. A bare "$" is ambiguous: `PropertyListing` infers it, sets `currency_assumed=True`, and the report warns.
  Convert with `USD_MXN_RATE` from settings only. EUR/CAD are stored but not converted (`price_usd=None`), never guessed.
- Parse natively: `m²`/`mts2`/`metros cuadrados`; `recámaras`/`habitaciones`/`dormitorios`; `baño y medio` = 1.5; `$3.5 MDP` = 3,500,000 MXN;
  built area (construcción) is not land (terreno).
- Neighbourhoods are canonical names in `domain.NEIGHBORHOODS` with accent-free aliases (Aldea Zamá = Zama Village = Aldea Zama).
  Unknown names are kept title-cased, never dropped. Extend the table instead of special-casing a site.
- Money model guardrails: predial (property tax) about 0.1%-0.5% of value (modelled 0.3%); fideicomiso (bank trust, foreign buyers in the
  restricted zone) about US$500-1,000 a year plus set-up; closing costs about 5-7%. Income tax on rents is NOT modelled by default.
- A listing is an **asking** price and a comp is another listing, not a sale. Reports must say so.

## Operating rules
1. **Never invent data.** Missing fact = `null` + a warning. Defaults are labelled `default_assumption` and live in `MARKET_DEFAULTS`/`Assumptions`;
   they are editable starting points, not market data.
2. **Scraping is polite, not stealthy.** robots.txt respected, allow-listed hosts only, randomised per-host delays, a page budget per run.
   The scraper never solves CAPTCHAs or Cloudflare challenges and never logs in: a challenge page returns `blocked=True` and the run moves on.
   Do not add challenge-solving, credential use or proxy-hiding of identity. Sites that always refuse (Inmuebles24, Lamudi, Vivanuncios,
   MercadoLibre in the PropLync runs) are not in the default allow-list; use the Apify adapters in proplync.mx `ingest/` or a licensed feed.
3. Parse facts from the **unpruned** text; give the LLM the pruned markdown. (Pruning drops short lines like "2 recámaras".)
4. Tools never raise into the agent loop: return `{"error": ...}`. Validate model JSON with Pydantic before it reaches Qdrant.
5. Tests must run offline (`pytest`): fake embedder + local fake portal in `tests/conftest.py`. Say plainly what was not tested live.

## Merge path into proplync.mx
- `PropertyListing.to_scout_card()` produces the shape of a Scout candidate (`operation`, `town`, `neighborhood`, `bedrooms`, `bathrooms`,
  `built_m2`, `land_m2`, `sources[{url, site, price, currency}]`). `m2_size` here is `built_m2` there.
- Scout (`api/_lib/scout.js`, `scout-merge.js`) runs on Vercel Hobby (10 s per function, 12 functions max), so this Python code does not deploy
  there. The intended seam: run this package as a separate worker, and have it (a) write enriched candidates into `scout_candidates` /
  `search_properties` (Supabase) and (b) expose the financial report for a candidate. Embeddings differ (this uses a multilingual MiniLM, PropLync
  uses gte-small, both 384 dims): do not mix vectors from the two.
- The financial agent's output (`FinancialReport`) is plain JSON and can be shown on a candidate card in `/brief`.
