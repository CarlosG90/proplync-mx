# Proplync.mx: Engineering & AI Recommendations

_Review date: 2026-10-09 · Based on `main` @ `6aceb09`_

This is a review from an AI and software engineering point of view. It covers what the codebase does well, what needs fixing now, and where to take it next. Items are in priority order inside each section, and each one names the file it's about.

---

## 1. Snapshot

| Area | Today |
|---|---|
| Frontend | 17 hand-written HTML pages (vanilla JS, no build step); `generate.html` is 3,426 lines, `index.html` 2,075 |
| Backend | 12 Vercel Functions in `api/` (Node, ESM), shared code in `api/_lib/` |
| Data / auth | Supabase (Postgres + RLS + Auth), migrations in `supabase/*.sql` |
| AI | Claude (`api/finder.js` Concierge, `api/extract.js`), Groq (copy generation, NL search, Whisper STT), Runway (Reel clips) |
| Infra | Upstash Redis rate limiting, Resend email, Meta Graph API (Instagram), Pexels/Pixabay, OSM |
| Quality gates | **No tests, no CI, no lint** |

**What's already good, and worth keeping:**
- The comments explain *why*, not just what (`plans.js`, `ratelimit.js`, `finder.js`). That's rare and valuable.
- Rate limiting is an atomic INCR+EXPIRE pipeline, and when Redis is down it lets requests through but logs the outage instead of failing silently.
- `auth.js` tells "bad token" apart from "Supabase is down" in the logs.
- Costs are thought through: Runway credits per Reel are measured and capped per plan.
- The LLM output is handled defensively: roles, length and turn count are clamped, and the Concierge falls back from Claude to Groq.
- The Concierge's honesty rules (says it's an AI, gives no legal or tax advice, never invents listings) are the right instincts for a buyer-facing agent.

---

## 2. Fix now (security and correctness)

### 2.1 `/api/instagram-publish` is open to the internet ✅ Fixed 2026-10-09
_Now requires a signed-in agency with `plan.instagram`, rate limited to 10 per hour per IP, CORS removed, only real PNG/JPEG renders up to 3 MB, `imageUrl` restricted to our own storage. Per-agency OAuth (below) is still open._


`api/instagram-publish.js` has **no auth, no rate limit, and `Access-Control-Allow-Origin: *`**. It publishes with the company's `IG_ACCESS_TOKEN` and uploads any base64 it receives to a public storage bucket (`hostRender`).

That means anyone who finds the URL can:
- post arbitrary images and captions to your Instagram business account
- use your Supabase bucket as free public file hosting

**Fix:**
```js
const auth = await requireAgencyUser(req);
if (!auth) return res.status(401).json({ error: 'unauthorized' });
// check planFor(agency).instagram === true
if (await enforceRateLimit(req, res, { bucket: 'ig', limit: 10, windowSec: 3600 })) return;
```
Also remove the wildcard CORS headers (the page is same-origin), cap the `imageBase64` size, and check that the bytes really are an image (e.g. with `sharp(...).metadata()`).

Longer term, each agency should publish to **its own** IG account through OAuth tokens stored per agency, not through one shared env token.

### 2.2 Check every other endpoint the same way
Do a five-minute pass: for each file in `api/`, write down (a) who can call it, (b) what it costs, (c) whether it's rate-limited. Right now `generate.js`, `finder.js`, `extract.js`, `leads.js` and `onboard.js` are limited. `property.js`, `search.js`, `amenities.js`, `geocode.js` and `photos.js` aren't. Those last ones are cheap, but `geocode` and `amenities` call Nominatim and Overpass, whose usage policies ban heavy or anonymous proxying. Add a limit and CDN caching there.

### 2.3 Add security headers
`vercel.json` sets no headers. Add at least:
```json
"headers": [{ "source": "/(.*)", "headers": [
  { "key": "X-Content-Type-Options", "value": "nosniff" },
  { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
  { "key": "X-Frame-Options", "value": "DENY" },
  { "key": "Permissions-Policy", "value": "camera=(), geolocation=(), microphone=(self)" }
]}]
```
A real Content-Security-Policy is blocked by the large inline `<script>` blocks (see 4.2). Start with `Content-Security-Policy-Report-Only` so you can see what would break.

### 2.4 Audit `innerHTML`
There are about 75 `innerHTML` writes across the pages (16 in `property.html`, 14 in `index.html`, 13 in `generate.html`). Some render agency-entered or LLM-generated text, such as listing descriptions and lead messages. `dashboard-leads.html` has an `esc()` helper, but most pages don't. Put one `escapeHtml` in `js/` and use it everywhere, or switch to `textContent` for plain text. **LLM output is user input**: a prompt-injected listing description can carry markup.

### 2.5 Repo hygiene
- `supabase/.temp/` is committed. Add it to `.gitignore` and `git rm --cached` it.
- `generate-backup.html` (2,206 lines) and `api/_lib/_deprecated/listings.js.bak` are dead code that still ships to production (the backup page is publicly reachable). Delete them; git history keeps them.
- `README.md` describes the August prototype (EasyBroker proxy, `api/listings.js`). Rewrite it around the current product: agency SaaS, Finder/Concierge, plans.
- The migrations start at `002_`. Make `schema.sql` → `001_` explicit, or switch to `supabase/migrations/` with timestamped files so `supabase db push` works.

---

## 3. AI engineering

### 3.1 Use structured output, not "please return JSON"
`finder.js` and `generate.js` ask the model for bare JSON and then strip markdown fences with a regex (`readJson`). That works until it doesn't. With Claude, define the brief as a **tool with a JSON schema** (or use structured outputs) so the response is guaranteed to parse. With Groq, use `response_format: { type: "json_object" }`. Then check the result with a small schema validator (zod or a hand-rolled check) before trusting `brief`.

### 3.2 Centralize model configuration
`'claude-opus-5'` is hard-coded in both `api/finder.js` and `api/extract.js`, and Groq models live in `api/_lib/groq.js`. Create `api/_lib/models.js` with one entry per *use case* (`concierge`, `extract`, `copy`, `nlsearch`, `stt`). Upgrading a model should be a one-line change.

Also think about cost per use case. A buyer conversation in two or three sentences per turn probably doesn't need the largest model. Run the eval set from 3.4 on a mid-tier model (e.g. Sonnet) and keep Opus only where quality clearly wins.

### 3.3 Prompt caching
The Concierge `SYSTEM` prompt is large, never changes, and is re-sent on every turn of a conversation of up to 40 turns. Mark it with `cache_control: { type: "ephemeral" }`. That's a significant input-token saving and lower latency, for a one-line change.

### 3.4 Build a small eval set before changing prompts
Every prompt here encodes a promise: "one question per turn", "never relax a must-have", "never invent a town", "answer in the buyer's language". Write 20–30 scripted conversations in `evals/concierge/*.json` with assertions such as:
- every `say` has at most one `?`
- `brief` fields are `null` unless the user actually stated them (checks for hallucinated fields)
- Spanish in → Spanish out, English in → English out
- legal and tax questions get deflected

Run them in CI against both Claude and the Groq fallback. **The fallback is the path most likely to drift quietly**, because it's a different model following the same prompt.

### 3.5 Make degradation visible to the product, not just the logs
`finder.js` returns `provider: 'groq' | 'anthropic'`, which is good. Record it, along with latency, token usage, parse failures and 429s, in a table or Vercel Observability. Then you can answer questions like "what share of Concierge turns ran on the fallback this week?" Today the only signal is `logDegraded`.

### 3.6 Persisting buyer briefs (migration 009)
When briefs get stored:
- Buyers are anonymous, so key rows to a signed session id, not to an IP address.
- Write RLS so a buyer can only read their own brief, and agencies only see briefs a buyer has shared with them.
- Under LFPDPPP, budget plus origin plus timeline is personal data. You need an *aviso de privacidad* linked from the Concierge, a retention period, and a delete path.
- Send audio straight to STT and never store it.

### 3.7 Guard against prompt injection where agency text reaches a model
Listing descriptions written by agencies feed the copy generator and NL search. Keep agency- or buyer-supplied text inside clearly delimited blocks (`<listing>…</listing>`), tell the model that content is data, and never let model output choose URLs, recipients or actions without a server-side allowlist. `nlsearch` already maps model output to known towns, so apply the same pattern everywhere.

---

## 4. Architecture

### 4.1 The 12-function Hobby cap is shaping the code
`finder.js` and `generate.js` say so outright: new features become `?action=` branches because the plan allows 12 functions. `generate.js` is now 873 lines and handles copy, describe, nlsearch, enhance, day-to-dusk and Reels in one file. Pick one:
- **Move to Vercel Pro.** The product already bills customers and uses paid APIs (Runway), so this is the honest fix.
- **Or route explicitly:** keep one function per *domain*, but give it a small router (`const routes = { describe, nlsearch, … }`) with each action in its own module under `api/_lib/actions/`. Then splitting files later costs nothing.

### 4.2 Pull the JS out of the HTML
The biggest maintainability risk is the multi-thousand-line inline `<script>` blocks. Without adopting a framework:
1. Move each page's script to `js/pages/<page>.js` as an ES module.
2. Move shared helpers (fetch wrapper, escaping, i18n, formatting) into `js/lib/`.
3. That unblocks a strict CSP (2.3), lets you lint and test, and makes diffs reviewable.

If you later want components, Vite with plain modules is the smallest step that keeps the zero-framework feel. A Next.js rewrite isn't justified yet.

### 4.3 Make plan enforcement the database's job too
`plans.js` is enforced in JS. Back the limits that matter (listings per plan, `marketing_trials_used`, monthly Reels) with Postgres constraints or `security definer` functions that check and increment atomically. Then two parallel requests can't both use the last trial. Run `get_advisors` on the Supabase project and fix any RLS warnings.

### 4.4 Billing
`agencies.plan` is a string someone sets by hand. Once Pro or VIP is sold, connect Stripe through the Vercel Marketplace and let a webhook own that column. Nothing else should write it.

---

## 5. Quality and delivery

| Step | Effort | Payoff |
|---|---|---|
| Add `node --test` unit tests for `plans.js`, `ratelimit.js`, `readJson`, `esc` | ½ day | Locks down the money and abuse logic |
| GitHub Actions: lint (ESLint flat config) + tests + `html-validate` on PRs | ½ day | Every PR gets checked |
| Playwright smoke test: home → finder turn → login → dashboard loads | 1 day | Catches broken deploys before buyers do |
| Concierge evals (3.4) on PRs touching `finder.js` | 1 day | Catches prompt regressions |
| `npm audit` / Dependabot | 10 min | `sharp` and the SDKs move fast |
| Uptime check on `/api/finder` and `/api/generate` (the health-check script exists, so schedule it) | 1 hr | Groq and Anthropic outages show up as alerts |

Also: Vercel Functions now default to Node 24. Pin `"engines": { "node": "24.x" }` in `package.json` so local and production match.

---

## 6. Suggested order

1. **This week:** 2.1 (Instagram endpoint), 2.4 (escaping), 2.5 (hygiene), 2.3 (headers)
2. **Next:** CI + unit tests, 3.1 (structured output), 3.2 (model config), 3.3 (caching)
3. **Before Finder persistence ships:** 3.4 evals, 3.6 privacy/RLS design, 4.3 DB-enforced limits
4. **When revenue justifies it:** Vercel Pro (4.1), Stripe (4.4), per-agency Instagram OAuth, extracting page scripts (4.2)

---

_Every point above points to a specific file or line pattern in this repo. Treat it as a backlog, not a rewrite plan. The codebase's main strength is that its comments say why each decision was made, so keep writing them that way as you fix these._
