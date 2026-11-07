# Context map: where things are, and the loops we run

WHY THIS EXISTS: sessions kept re-reading whole files (`api/finder.js`, `brief.html`,
`generate.html` are thousands of lines) to find the three functions that matter, and the user kept
repeating the same rules. This map is the graph: feature → files → data → tests. Start here, read
only the nodes you need, then `Grep` for the symbol instead of reading a whole file.

Keep it short and true. If you move or rename something in a node below, fix the node in the same PR.

## Rules of thumb for reading less

1. Open this map, pick the feature, read only its files. Use `Grep` for a symbol, then `Read` with `offset`/`limit`.
2. Big files: `generate.html`, `index.html`, `brief.html`, `api/finder.js`. Never read them whole.
3. Nested `CLAUDE.md` files (`api/`, `js/`, `scripts/`, `test/`) load only when you work in that folder. Put folder rules there, not in the root file.
4. Durable facts and user preferences live in memory; one-off state of a session does not belong in any file.
5. Don't re-verify what a test already proves. Run `npm test` and trust a green run for the logic it covers.

## Feature graph

```
Buyer interview (Concierge)
  pages   invest.html → js/invest.js ─┐
          brief.html (inline script) ─┴→ js/concierge.js (record, STT, speak, hand-off via saveHandoff)
  api     api/finder.js ?action=turn|transcribe   (SYSTEM prompt lives here)
  lib     api/_lib/concierge-turn.js (validate + 1 repair) · nvidia-concierge.js · groq.js
  tests   concierge-turn, concierge-format, concierge-voice, nvidia-concierge
  limits  Groq free ≈ 7000 input tokens/min: a repair call doubles tokens → 429 → "concierge_busy"

Brief approval + sign-in (/brief)
  page    brief.html (stages: interview → review → search → results; setHead/reviewMode/renderSave)
  api     api/finder.js ?action=approve|status
  data    buyer_briefs (token hash), buyer_wallets, credit_ledger
  auth    Supabase Auth, email code only (no Google button)

Scout (research agent)
  api     api/finder.js ?action=scout-step (secret-gated chain, 202 + waitUntil)
  lib     api/_lib/scout.js (Claude Opus segments) · scout-merge.js (hard limits) · scout-state.js
          scout-watch.js (restart/refund) · scout-budget.js · candidate-financials.js · financial.js
  data    scout_runs (messages, progress, lease, cost), scout_candidates
  ops     scripts/scout.mjs new|run|review|confirm|reject|ready  (`run` needs ANTHROPIC_API_KEY, Vercel only)
  tests   scout-run, scout-merge, scout-state, scout-watch, scout-budget, financial, candidate-financials
  cost    a real run is ~US$1–3: ask first

Search v2 (/search)
  page    search.html · api/search.js ?action=query → api/_lib/search/{query,api,normalize,amenities,index-writer}.js
  data    search_properties, search_offers, search_markets, search_sources; RPC search_properties_v1
  ingest  ingest/run.mjs + adapters/ (daily GitHub workflow)

Agencies (SaaS)
  pages   dashboard.html, dashboard-leads.html, generate.html, agency.html
  api     my-listings.js, generate.js, leads.js, onboard.js, extract.js, instagram-publish.js
  lib     auth.js, plans.js, agency.js, ratelimit.js, redis.js, runway.js, reel.js
```

## Loops

**Change loop (every code change).** Branch → edit → `npm test` → run the changed handler with mocked `req`/`res`
or a local static server → commit → PR → merge only when the user says so → check the production deploy.
The `ship-pr` skill holds the exact commands and attribution lines.

**Live-QA loop (UX work).** Reproduce on a phone-width viewport (390 px) with gstack `/browse` → write the glitch
down with the evidence → fix → re-run the same script → record what was NOT tested.

**Concierge prompt loop.** Change `SYSTEM` in `api/finder.js` → run the same scripted buyer conversation locally
(human-paced, 8 s turns, so Groq doesn't 429) → compare: one question per turn, tuteo, no repeats, no flattery,
honest closing → then PR.

**Scout loop.** `scripts/scout.mjs new` (QA brief) → run on Vercel through a signed-in buyer → `review` → `confirm`/`reject`.
Never run it, or call NVIDIA, without the user's go-ahead in the current conversation.

## Guardrails that cost time when forgotten

- 12 Vercel functions, all used: add an `action` to an existing `api/*.js`, never a new file.
- Production DB writes and real Scout runs need explicit approval. Tell the user about rows left behind.
- Squash-merge titles end with `(#N)`. Don't push to `main`. Don't merge without being asked.
- Secrets: `ANTHROPIC_API_KEY` lives only in Vercel. Never print env values.
- Untracked files in the working tree that aren't yours (`proplync-mx/`, plan `.md` files, `skills-lock.json`) are never committed.
