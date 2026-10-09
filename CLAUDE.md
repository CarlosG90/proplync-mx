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
   - `/` home with agency/buyer "doors", `/search` and `/propiedades-en-:city`, `/propiedad/:id` (server-rendered for SEO), `/favoritos`.
   - **PropLync Finder** (`/finder`, `/brief`): **Concierge**, a voice- or text-based AI agent, interviews the buyer about the life they want, turns that into a structured *brief* (must-haves, deal-breakers, budget, areas, purpose, timeline), and the buyer approves it. Planned next: persisting briefs (migration 009) and *Scout*, which matches briefs to listings.

Business model: plans `free` / `pro` / `vip` in `api/_lib/plans.js` (listing caps, marketing module, Instagram, monthly Reel quota). `agencies.plan` is set by hand today; there's no billing yet.

Production: https://proplync-mx.vercel.app. The custom domain `proplync.mx` has no DNS records yet. The Resend email sender also waits on that domain.

## Stack

| Layer | Choice |
|---|---|
| Frontend | Plain HTML pages + vanilla JS, **no build step, no framework**. Shared code in `js/`, styles in `css/tokens.css`, `nav.css`, `components.css` |
| Backend | Vercel Functions, Node ESM, `api/*.js`; shared helpers in `api/_lib/` |
| DB / auth / storage | Supabase (Postgres + RLS, Auth, Storage bucket `listing-photos`) |
| AI | **Claude** (`@anthropic-ai/sdk`): Concierge conversation (`api/finder.js`) and document/photo extraction (`api/extract.js`). **Groq**: copy generation, NL search and describe (`api/_lib/groq.js`, with primary→fallback model retry), plus Whisper speech-to-text. **Runway**: Reel clips (costs real money per clip) |
| Other services | Upstash Redis (rate limits), Resend (lead emails), Meta Graph API (Instagram), Pexels→Pixabay (stock photos), OSM Nominatim/Overpass (geocode, amenities), `sharp` (image processing) |
| Hosting | Vercel, **Hobby plan**. Git-connected: PR → preview deploy, merge to `main` → production |

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
  finder.js            Concierge: ?action=turn | transcribe
  extract.js           messy input (PDF, photo, WhatsApp text) → structured listing fields (Claude)
  my-listings.js       agency listing CRUD (auth)
  leads.js             public lead capture + CRM (auth for reads/notes)
  onboard.js           invite-gated account creation (service-role admin API)
  instagram-publish.js auth + plan.instagram + rate limited; posts to the shared company IG account
  property.js, search.js   JSON + server-rendered pages + sitemap.xml
  amenities.js, geocode.js, photos.js   thin external proxies
  _lib/                auth, plans, ratelimit, redis, groq, runway, reel, notify, photos, agency, supabase, health
supabase/              schema.sql + numbered migrations 002–008 (applied by hand)
scripts/               operator scripts: onboard-agency, create-invite, health-check, set-supabase-project
vercel.json            function durations + pretty-URL rewrites (Spanish and English paths)
RECOMMENDATIONS.md     prioritized engineering/AI backlog; check it before larger changes
```

Data model: `agencies` (plan, slug, whatsapp_number, marketing_trials_used), `agency_members` (user ↔ agency, role), `listings`, `leads` (+ qualification fields, follow-ups), `lead_notes`, `download_leads`, `signup_invites`, `reel_jobs`.

## Hard constraints (read before adding things)

- **12 functions max on Vercel Hobby. All 12 slots in `api/` are used.** Don't add a new `api/*.js` file. Add an `action` to an existing function and, if it needs a pretty URL, a rewrite in `vercel.json` (see `/api/describe`, `/api/nlsearch`). Files in `api/_lib/` don't count toward the limit.
- **4.5 MB request body limit.** Large uploads go browser → Supabase Storage first, then the URL goes to the API.
- **Groq free tier** is about 1,000 output tokens/min. Treat a 429 as "busy", never as a crash. Expensive or long LLM work goes to Claude.
- **Runway costs money per clip.** Reels are capped per plan per month; check the `plans.js` comment before raising limits.
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
- Validate model JSON before using it.
- Rate limiting fails open (allows the request when Redis is down) but logs the outage.
- Code style: vanilla ES modules, no TypeScript, no bundler. Match the surrounding file (many front-end scripts use `function` and `var`).

## AI agents in the product

- **Concierge** (`api/finder.js`): the Spanish system prompt `SYSTEM` defines the persona. It discloses it's an AI, asks one question per turn, never relaxes a must-have, gives no legal, tax or financial advice, and never invents properties. It returns JSON `{ say, brief, missing, done }`. The `brief` shape is the contract with the future `buyer_briefs` table, so don't rename its fields casually. Provider order: Claude → Groq fallback; the response's `provider` field shows which one answered.
- **Content generation** (`api/generate.js`): Groq, with honesty rules (no invented features) restated inside the brand-voice block.
- **Extraction** (`api/extract.js`): Claude reads PDFs and images and returns listing fields.
- Model IDs live at the top of each file (`MODEL` in finder/extract, `PRIMARY_MODEL`/`FALLBACK_MODEL` in `_lib/groq.js`).

## Workflow

- Run locally with `vercel dev` (needs `.env.local`; pull it with `vercel env pull`). Static pages also open directly.
- Env vars: see `.env.example` (names only; never print values). Key ones: `SUPABASE_*`, `GROQ_API_KEY`, `ANTHROPIC_API_KEY`, `RUNWAYML_API_SECRET`, `KV_REST_API_URL/TOKEN`, `IG_ACCESS_TOKEN`, `IG_BUSINESS_ACCOUNT_ID`, `RESEND_API_KEY`, `SIGNUP_INVITE_CODE`, `PUBLIC_SITE_URL`.
- **Shipping:** branch → PR → Vercel preview → squash-merge to `main` (title ends with `(#N)`) → production auto-deploys. Don't push straight to `main`.
- **DB changes:** add `supabase/0NN_description.sql` (idempotent: `if not exists`), apply in Supabase Studio or MCP, and include RLS policies in the same file. The next number is **009** (buyer briefs).
- **No tests or CI yet.** Verify by running handlers with mocked `req`/`res` and probing the preview or production URLs. Say plainly what wasn't tested.
- Useful skills: `onboard-agency`, `audio-a-prompt` (voice note → site change prompt), `real-estate-content`, `digital-marketing-strategy`, `instagram-publish`, `/review`, `/ship`, `/qa`. For web browsing use gstack `/browse`, not the Chrome MCP.

## Known gaps / next up

See `RECOMMENDATIONS.md` for the full prioritized list. The headlines:
- No security headers or CSP in `vercel.json`.
- Use structured output instead of regex-parsed JSON from LLMs, cache the Concierge system prompt, and build an eval set for Concierge.
- Persist buyer briefs (migration 009) with RLS and an LFPDPPP privacy notice.
- Per-agency Instagram OAuth (today every agency posts to one shared account).
- Stripe billing to own `agencies.plan`.
- Move to Vercel Pro, or a cleaner action router, to escape the 12-function cap.
- Delete `generate-backup.html` and `api/_lib/_deprecated/`, and stop tracking `supabase/.temp/`.
- Rewrite `README.md`, which still describes the August EasyBroker prototype.
