---
name: scout
description: "Run PropLync Finder's Scout research agent on an approved buyer brief and work the human verification queue: list briefs, start a search, review the candidates it found with every source and price, and record the listing agent's answers (confirm / reject / unreachable) before releasing results to the buyer. Use when asked to run Scout, search for a buyer, review Finder candidates, confirm or reject a property for a buyer, or release a brief."
argument-hint: "[list | run <briefId> | review <briefId> | ready <briefId>]"
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
---

# Scout: search for a buyer, then confirm with the agent

Everything goes through `scripts/scout.mjs` from the project root
(`~/Projects/proplync-mx`). It needs `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY` and, for `run`, `ANTHROPIC_API_KEY` in `.env.local`.

## The flow

1. **See what is waiting:** `node scripts/scout.mjs list` (add `--status approved` for briefs nobody has searched yet).
2. **Search:** `node scripts/scout.mjs run <briefId>`.
   - **This costs money**, roughly US$1–3, and takes a few minutes. Say so and get a yes before the first run in a session.
   - It prints the cost after each segment. If auto mode already started the run on Vercel, the script waits for it instead of competing with it.
3. **Read the results:** `node scripts/scout.mjs review <briefId>`. Present each candidate to the user:
   - title, area, specs
   - every source with its own price (the same house on several portals is one candidate)
   - must-haves with the quoted evidence
   - the "Ask" questions for the agent
   - the run's notes on what it could not find
4. **Verify, one candidate at a time.** A person calls or messages the listing agent. Record the outcome:
   - `confirm <candidateId> --answers '<json>' [--notes "..."] [--by "<name>"]`. The answers JSON needs all five keys: `available`, `price`, `can_visit`, `listing_agent`, `restrictions`. Never fill one in on the user's behalf; ask for what the agent actually said.
   - `reject <candidateId> --reason "..."` for sold, a different price, no visits, or failing the brief.
   - `unreachable <candidateId>` when nobody answered.
5. **Release:** `node scripts/scout.mjs ready <briefId>`. Only then does the buyer's link show anything, and it shows only confirmed candidates. Confirm with the user before releasing.

`new --file brief.json --name --email` creates a brief for a buyer who talked to us outside the website. It prints their private link once.

## Rules

- Nothing reaches the buyer without a confirmed answer from the listing agent. That is Finder's whole promise.
- Never invent or "tidy up" a fact Scout left blank. Blank means "ask the agent".
- Buyer names and emails stay in the terminal. Don't paste them into other tools.
