# PropLync.mx — project context for Claude

## What we are building

PropLync.mx is a bilingual (ES/EN) real-estate platform for the **Riviera Maya, Mexico** (Cancún, Playa del Carmen, Tulum, Puerto Morelos). It has two front doors:

1. **Agencies (paying customers, the SaaS).** Real-estate agencies manage their listings, get AI-generated marketing for each one, and work their leads in a light CRM.
   - `/dashboard`: their listings (CRUD, photos, AI description, watermark).
   - `/generate` (`/generar`): one listing turned into marketing formats: post, carousel, story, Reel, email and ad, in both languages. Branded 1080x1080 renders, an optional Runway motion Reel, and direct publish to Instagram.
   - `/dashboard/leads`: CRM inbox with notes, follow-ups and lead qualification.
   - `/agencia/:slug`: the agency's public portfolio page.
   - Accounts are invite-only (`/invitacion/:code`, `/signup`). Onboarding happens through the `onboard-agency` skill or `scripts/onboard-agency.mjs`.
2. **Buyers (free, the demand side).**
   - `/` home with agency/buyer "doors", **`/search` (search v2: one index of PropLync listings + crawled portal listings, natural-language queries, ranked, semantic)** and `/propiedades-en-:city`, `/propiedad/:id` (server-rendered for SEO), `/favoritos`.
   - **PropLync Finder** (`/finder`, `/brief`): **Concierge**, a voice- or text-based AI agent, interviews the buyer about the life they want, turns that into a structured *brief* (must-haves, deal-breakers, budget, areas, purpose, timeline), and the buyer approves it (with name, email and consent), getting a private link `/brief?b=<token>`. **Scout** then searches PropLync inventory, the portals and agency sites, merges the same property across sites into one card with every price, and a person confirms five questions with each listing agent before anything is shown to the buyer (see *Scout* below).

Business model: plans `free` / `pro` / `vip` in `api/_lib/plans.js` (listing caps, marketing module, Instagram, monthly Reel quota). `agencies.plan` is set by hand today; there's no billing yet.

Production: https://proplync-mx.vercel.app. The custom domain `proplync.mx` has no DNS records yet. The Resend email sender also waits on that domain.

## Stack

| Layer | Choice |
|---|---|
| Frontend | Plain HTML pages + vanilla JS, **no build step, no framework**. Shared code in `js/`, styles in `css/tokens.css`, `nav.css`, `components.css` |
| Backend | Vercel Functions, Node ESM, `api/*.js`; shared helpers in `api/_lib/` |
| DB / auth / storage | Supabase (Postgres + RLS, Auth, Storage bucket `listing-photos`) |
| AI | **NVIDIA NIM** (free hosted catalog, OpenAI-compatible at `https://integrate.api.nvidia.com/v1`): Concierge (`api/finder.js`), Scout (`api/_lib/scout.js`), document/photo extraction (`api/extract.js`). **Groq**: copy generation, NL search and describe (`api/_lib/groq.js`, with primary→fallback model retry), plus Whisper speech-to-text. **Runway**: Reel clips (costs real money per clip). **Anthropic (Claude): being removed.** See *AI agents in the product* |
| Other services | Upstash Redis (rate limits), Resend (lead emails), Meta Graph API (Instagram), Pexels→Pixabay (stock photos), OSM Nominatim/Overpass (geocode, amenities), `sharp` (image processing) |
| Hosting | Vercel, **Hobby plan** (10 s function limit; we are not upgrading for now). Git-connected: PR → preview deploy, merge to `main` → production |

## Map of the code

```
*.html                 one file per page (generate.html ~3.4k lines, index.html ~2k; scripts are inline)
generate-backup.html   dead copy; don't edit, planned for deletion
js/escape.js           escapeHtml / safeUrl / cssUrl; load before i18n.js on any page that builds HTML from data
js/i18n.js             ES/EN toggle; language saved in localStorage 'proplync_lang', carried across pages
js/nav-auth.js         reads the stored Supabase session to pick nav labels; secures nothing
js/supabase-client.js  SDK client, used only on authenticated pages
js/api.js, favorites.js, hero3d.js (Three.js hero)
api/
  generate.js          multi-action: listing copy, describe, nlsearch, enhance, day-to-dusk, Reel start/poll
  finder.js            Concierge (?action=turn | transcribe) + approve | status | scout-step (internal, secret-gated chain)
  extract.js           messy input (PDF, photo, WhatsApp text) → structured listing fields (NVIDIA vision, migrating from Claude)
  my-listings.js       agency listing CRUD (auth)
  leads.js             public lead capture + CRM (auth for reads/notes)
  onboard.js           invite-gated account creation (service-role admin API)
  instagram-publish.js auth + plan.instagram + rate limited; posts to the shared company IG account
  property.js, search.js   JSON + server-rendered pages + sitemap.xml
  amenities.js, geocode.js, photos.js   thin external proxies
  _lib/                auth, plans, ratelimit, redis, groq, nvidia (new), runway, reel, notify, photos, agency, supabase, health
  _lib/search/         search v2: amenities.js (ES/EN tag dictionary), normalize.js (one listing shape), index-writer.js
                       (dedupe/upsert, PropLync mirror, embeddings), query.js (rules first, Groq only for leftovers), api.js (?action=query)
  _lib/scout.js        Scout engine: one resumable model segment per call (search/fetch tools we run ourselves + submit_candidates)
  _lib/scout-merge.js  pure dedupe/merge + hard brief limits (budget, must-haves, deal-breakers)
supabase/              schema.sql + numbered migrations 002–012 (applied by hand or Supabase MCP)
scripts/               operator scripts: onboard-agency, create-invite, scout, health-check, set-supabase-project, credits
ingest/                crawler: run.mjs + adapters/ (Apify: Inmuebles24, Lamudi); runs daily via .github/workflows/ingest.yml
supabase/functions/embed  edge function: gte-small embeddings (free, in Supabase); accepts only service_role JWTs
test/                  node:test unit tests (`npm test`)
.claude/skills/scout/  skill wrapping scripts/scout.mjs (run, review, confirm, release)
vercel.json            function durations + pretty-URL rewrites (Spanish and English paths)
RECOMMENDATIONS.md     prioritized engineering/AI backlog; check it before larger changes
```

Data model: `agencies` (plan, slug, whatsapp_number, marketing_trials_used), `agency_members` (user ↔ agency, role), `listings`, `leads` (+ qualification fields, follow-ups), `lead_notes`, `download_leads`, `signup_invites`, `reel_jobs`, and for Finder `buyer_briefs` (token hash, brief jsonb, contact, status), `scout_runs` (resumable transcript, lease, usage/cost) and `scout_candidates` (facts, sources with per-site prices, match, verification + the agent's answers). The Finder tables have RLS on and **no policies**: service role only. **Search index (010/011):** `search_markets` and `search_sources` (the switches: enable a market, switch a source off or to a safer `display_mode` with one UPDATE, monthly budgets), `search_properties` (one row per real property: facts, MXN price range, amenities[], tsv, geog, halfvec(384) embedding; origin `proplync` or `web`), `search_offers` (one row per ad with its own price, URL, internal `contact`), `search_queries` (anonymized demand log), `geocode_cache`, `places`. Ranking is the RPC `search_properties_v1(jsonb)` (weights live there); upkeep is `search_refresh_prices` / `search_mark_stale`.

## Hard constraints (read before adding things)

- **12 functions max on Vercel Hobby. All 12 slots in `api/` are used.** Don't add a new `api/*.js` file. Add an `action` to an existing function and, if it needs a pretty URL, a rewrite in `vercel.json` (see `/api/describe`, `/api/nlsearch`). Files in `api/_lib/` don't count toward the limit.
- **10 s max execution per function on Vercel Hobby.** Anything synchronous (Concierge turns, extraction) must finish inside that. Long work (Scout) runs as chained segments, each one a separate invocation (`waitUntil`, 202 response). Never make a single request wait on a Scout run.
- **4.5 MB request body limit.** Large uploads go browser → Supabase Storage first, then the URL goes to the API.
- **Groq free tier** is about 1,000 output tokens/min. Treat a 429 as "busy", never as a crash.
- **NVIDIA free tier** (build.nvidia.com): rate-limited per key (third-party docs report about 40 requests/min; **verify on the model page before relying on it**). Treat a 429 the same way as Groq: "busy", retry once, then degrade.
- **NVIDIA model IDs must be checked on build.nvidia.com before a deploy.** The catalog changes. Model IDs live in one place (see *AI agents*), and a deploy that uses a removed ID must fail loudly, not silently.
- **Runway costs money per clip.** Reels are capped per plan per month; check the `plans.js` comment before raising limits.
- **No Anthropic API calls in production once the migration ships.** `ANTHROPIC_API_KEY` is removed from Vercel and `.env.local` at that point. Any new code must not import `@anthropic-ai/sdk`.
- Nominatim and Overpass have fair-use policies: cache, and don't hammer them.

## Conventions

- **Comments explain *why*.** Each file opens with a header block (`WHY THIS EXISTS`, `WHY NOT X`). Keep that style; it's how decisions are recorded in this repo.
- **Bilingual everything.** UI strings use `data-es="…" data-en="…"` attributes or `isEs ? '…' : '…'`. User-facing errors and alerts need both languages. Spanish is the default.
- **API endpoint pattern:**
  1. method check
  2. `enforceRateLimit(req, res, { bucket, limit, windowSec })` for anything public, costly or spammable
  3. `requireAgencyUser(req)` → `{ user, agencyId, role }` or 401
  4. plan check via `planFor` / `marketingAccess` / `reelAccess` (402 `upgrade_required`)
  5. work in `try/catch`, return `{ error: 'snake_case_code', detail }` and log outages with `logDegraded()`
- Errors are `snake_case` codes the frontend switches on. Use `safeDetail(err)` so internals don't leak.
- No CORS headers: every caller is same-origin.
- **Public pages stay SDK-free.** They read the stored session token directly (`storedAccessToken()` / `generateHeaders()` in `generate.html`, `js/nav-auth.js`). Only the dashboard pages load supabase-js.
- **Security model:** the client secures nothing. Every API verifies the bearer token, and Postgres RLS governs rows. Service-role client only in `api/` and `scripts/`, never in the browser.
- **Escaping:** listing fields, agency fields, OSM place names, error messages and all LLM output are untrusted. When building HTML strings, wrap text in `escapeHtml()`, `src`/`href` in `safeUrl()`, and `url('…')` in styles in `cssUrl()` (all from `js/escape.js`). Prefer `textContent` for plain text. In `generate.html`, call `htmlSafe()` on a renderer's inputs, but only for HTML: PDF, TXT, canvas text and filenames use the raw values. JSON inside a `<script>` tag needs `.replace(/</g, '\\u003c')`.
- `api/my-listings.js` validates listing and agency fields on save (types, lengths, image URL schemes, currency, color, WhatsApp). New writable fields need a rule there.
- **Validate model JSON before using it.** Every model call that must return structured data is checked against a schema in code (see *Model output* below).
- Rate limiting fails open (allows the request when Redis is down) but logs the outage.
- Code style: vanilla ES modules, no TypeScript, no bundler. Match the surrounding file (many front-end scripts use `function` and `var`).

## AI agents in the product

### Provider layer (`api/_lib/nvidia.js`, to be created)

One thin client for NVIDIA NIM, shared by Concierge, Scout and extraction. Everything goes through it so model IDs and retry rules live in one file.

- Endpoint: `https://integrate.api.nvidia.com/v1/chat/completions` (OpenAI Chat Completions format). Auth: `NVIDIA_API_KEY`.
- Model IDs are constants at the top of the file, one per role:
  - `CONCIERGE_MODEL`: a fast model, because a turn must finish inside 10 s. Candidate: `nvidia/nvidia-nemotron-nano-9b-v2`.
  - `SCOUT_MODEL`: the reasoning and tool-calling model for Scout segments. Candidate: `nvidia/nemotron-3-super-120b-a12b`. Fallback: `nvidia/llama-3.3-nemotron-super-49b-v1.5`.
  - `VISION_MODEL`: for `extract.js` on photos and PDF pages. Candidate: `meta/llama-4-maverick-17b-128e-instruct` (vision and tools). **Verify this before use; the candidates above come from third-party docs, not from build.nvidia.com.**
- Retry: one retry on 429 or 5xx, then fall back to Groq for copy-type tasks, or return `{ error: 'ai_busy' }` for Concierge and Scout. Never crash.
- **Avoid `deepseek-ai/deepseek-r1` on the hosted endpoint for tool use**: reasoning and tool calling are reported to conflict there.
- Log the provider and model on every response (`provider` field, as Concierge does today).

### Concierge (`api/finder.js`)

- The Spanish system prompt `SYSTEM` defines the persona. It discloses it's an AI, asks one question per turn, never relaxes a must-have, gives no legal, tax or financial advice, and never invents properties.
- It returns JSON `{ say, brief, missing, done }`. The `brief` shape is the contract with the `buyer_briefs` table, so don't rename its fields casually.
- **Provider order today: Claude → Groq fallback.** After the migration: NVIDIA (`CONCIERGE_MODEL`) → Groq fallback. The `provider` field keeps showing which one answered.
- Validate the returned JSON against the brief schema. If it doesn't parse or fails validation, retry once with the error in the prompt, then return `ai_busy`. Don't pass unvalidated JSON to the database.

### Scout (`api/_lib/scout.js`)

- **Today:** `claude-opus-5-5` with Anthropic's server-side `web_search` and `web_fetch` tools, plus a strict `submit_candidates` tool. A run is a series of segments: `pause_turn` saves the transcript to `scout_runs.messages` and the next segment resumes it. A lease stops two runners doing the same segment.
- **After the migration:** NVIDIA's chat endpoint has no built-in web search or fetch. **We run those tools ourselves.** Scout gets two function tools:
  - `search_web(query)`: calls a search API, returns titles, URLs and snippets only.
  - `fetch_page(url)`: fetches a URL from an allow-list of portal and agency domains, strips the HTML to text, returns a capped excerpt.
  - Plus `submit_candidates`, unchanged.
  - The search provider is an **open decision** (not chosen yet). Pick one before building, and check its free-tier limits and terms.
- `scout_runs.messages` changes from Anthropic's content-block format to OpenAI-style `messages` (`role`, `content`, `tool_calls`, `tool_call_id`). Existing in-flight runs on Claude are allowed to finish on Claude, or are marked failed and re-run. Don't mix formats in one transcript.
- Runners stay the same: a signed-in buyer's approval chains `finder.js?action=scout-step` on Vercel (each hop answers 202 and works in `waitUntil`), unless `SCOUT_PAID_RUNS=off`; operators can also run `node scripts/scout.mjs run <briefId>`.
- **Nothing the model says is stored on trust.** Source URLs must have appeared in this run's search or fetch results (the check now runs against *our* tool logs, not the provider's). Numbers are range-checked, and `scout-merge.js` drops over-budget / must-have-missing / deal-breaker cards.
- Buyers see candidates as soon as a run finishes, labelled unverified / verification requested / confirmed; rejected ones are hidden.
- **Model output:** `submit_candidates` arguments are validated against the JSON schema in code before anything reaches `scout_candidates`.

### Extraction (`api/extract.js`)

- **Today:** Claude reads PDFs and images and returns listing fields.
- **After the migration:** `VISION_MODEL` on NVIDIA. Quality may differ from Claude on scanned PDFs, so test with real samples before switching production traffic. Keep the current output schema.

### Buyer credits (`supabase/012_buyer_credits.sql`)

`buyer_wallets` + `credit_ledger`, changed only through `spend_credit` / `add_credits` (service role, row-locked, purchases and refunds idempotent on `(reason, ref)`). First Scout search free, then 1 credit per search and 1 per verification request. Sign-in on `/brief` is Supabase Auth (Google when enabled in the project, else email code/link). Manual grants: `node scripts/credits.mjs grant <email> <n> --note ...`. Packs: 3 = MXN 299, 10 = MXN 799, 25 = MXN 1,699 (Stripe checkout not built yet).

### Content generation (`api/generate.js`)

Groq, with honesty rules (no invented features) restated inside the brand-voice block. No change in the migration.

### Search v2 (`/search` → `api/search.js?action=query` → `api/_lib/search/api.js`)

`query.js` parses buyer text with deterministic rules first (beds, prices + currency, rent/sale, towns, amenity phrases); **Groq `gpt-oss-20b` is called only when descriptive words are left over**, and parses are cached 24 h. A guessed currency is flagged `currency_assumed` and shown as a flippable chip. Query text → `embed` edge function → vector; the RPC combines full-text (words boost, never gate), semantic similarity, amenity preferences, distance, freshness and a verified boost, and returns reasons per card. Fewer than 3 results → relaxation suggestions with counts + the Scout/Finder offer. Cards obey each source's `display_mode`; agent contacts never leave the DB. Our agencies' listings are mirrored into the index on every save (`my-listings.js` → `syncProplync`) and nightly; they are indexed even outside crawl markets. The old GET `/api/search` filter path still serves city pages and old links.

Model IDs live at the top of each file (`MODEL` in `finder.js` and `extract.js`, `SCOUT_MODEL` in `_lib/scout.js`, `PRIMARY_MODEL` / `FALLBACK_MODEL` in `_lib/groq.js`, and the three roles in `_lib/nvidia.js`).

## Workflow

- Run locally with `vercel dev` (needs `.env.local`; pull it with `vercel env pull`). Static pages also open directly.
- Env vars: see `.env.example` (names only; never print values). Key ones: `SUPABASE_*`, `GROQ_API_KEY`, `NVIDIA_API_KEY`, `RUNWAYML_API_SECRET`, `KV_REST_API_URL/TOKEN`, `IG_ACCESS_TOKEN`, `IG_BUSINESS_ACCOUNT_ID`, `RESEND_API_KEY`, `SIGNUP_INVITE_CODE`, `PUBLIC_SITE_URL`, plus the search provider key once chosen. `ANTHROPIC_API_KEY` is removed at cutover.
- **Shipping:** branch → PR → Vercel preview → squash-merge to `main` (title ends with `(#N)`) → production auto-deploys. Don't push straight to `main`.
- **DB changes:** add `supabase/0NN_description.sql` (idempotent: `if not exists`), apply in Supabase Studio or MCP, and include RLS policies in the same file. The next number is **013** (012 is `buyer_credits`).
- **Order matters:** migration before deploy. The reverse can lose real data.
- **Tests:** `npm test` runs the Scout merge/validation unit tests; there is no CI yet. Add unit tests for the NVIDIA client (retry, 429 handling, schema validation) and for the new Scout tool loop with mocked responses. Otherwise verify by running handlers with mocked `req`/`res` and probing the preview or production URLs. Say plainly what wasn't tested. A real Scout run or a real NVIDIA call costs quota: ask first.
- Useful skills: `onboard-agency`, `audio-a-prompt` (voice note → site change prompt), `real-estate-content`, `digital-marketing-strategy`, `instagram-publish`, `/review`, `/ship`, `/qa`. For web browsing use gstack `/browse`, not the Chrome MCP.

## Known gaps / next up

See `RECOMMENDATIONS.md` for the full prioritized list. The headlines:

- **Migrate off Anthropic (in progress):** `_lib/nvidia.js`; Concierge on NVIDIA; Scout on NVIDIA with our own search/fetch tools; extraction on NVIDIA vision; remove `@anthropic-ai/sdk` and `ANTHROPIC_API_KEY`. Quality check on Concierge and extraction with real samples before cutover.
- **Open decision:** search provider for Scout's `search_web`.
- **Verify NVIDIA model IDs and free-tier limits** on build.nvidia.com before the first deploy.
- No security headers or CSP in `vercel.json`.
- Use structured output where the provider supports it, instead of regex-parsed JSON. Cache the Concierge system prompt where the provider supports it. Build an eval set for Concierge.
- Finder: a formal *aviso de privacidad* page (only a consent line exists), a web review page for operators, payment before Scout runs, and emailing the buyer when results are ready.
- Per-agency Instagram OAuth (today every agency posts to one shared account).
- Stripe billing to own `agencies.plan`.
- Move to Vercel Pro, or a cleaner action router, to escape the 12-function cap. (Not planned for now.)
- Delete `generate-backup.html` and `api/_lib/_deprecated/`, and stop tracking `supabase/.temp/`.
- Rewrite `README.md`, which still describes the August EasyBroker prototype.
