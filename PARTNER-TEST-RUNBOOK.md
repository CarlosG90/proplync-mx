# Testing the AI agents with your partner

Scout (the research agent) and Concierge (the conversation) are the heart of PropLync. **Scout has never run in
production**: on 2026-10-24 the database held 0 runs, 0 candidates and 0 wallets. This guide gets you from "merged"
to "a real buyer ran a real search, and you confirmed a property by phone".

Money: a Scout run costs about **US$1–3** of Anthropic credit (it wraps up at US$3 and is stopped and refunded at
US$6). Concierge and voice notes use free tiers. Nothing here costs anything until a Scout run starts.

## 0. The journey you are testing

1. **Concierge** (free): the buyer talks or types on `/invest` (or `/voice`) until the brief is complete.
2. **Approve**: the buyer signs in (Google or an email code), ticks consent, approves. The first search is free.
3. **Scout** (US$1–3): runs on its own, in several steps of a few minutes each. The buyer can leave the page open. (The duration is my estimate: no real run exists yet. Your rehearsal gives the real number.)
4. **Results**: candidates appear on the same page, each labelled *sin verificar*.
5. **Verification** (1 credit): the buyer asks for one property to be confirmed.
6. **You**, the operator: phone the listing agent, record the five answers, mark the brief ready.

## 1. Before the test (about 20 minutes, once)

| # | Do this | Why |
|---|---|---|
| 1 | **Apply migration 013.** Supabase dashboard → SQL editor → paste `supabase/013_contact_requests.sql` → Run. | Without it the `/agencias` and `/agents` forms cannot save. (Not needed for Scout itself.) |
| 2 | **Merge PR #17** (squash). Vercel deploys production in about a minute. | The fixes below only exist once deployed. |
| 3 | **Put credit on the Anthropic account** and check the key in Vercel is the funded one. | The one thing no check can verify for free: a run is the proof. |
| 4 | **Raise the test limits** in Vercel → Settings → Environment Variables (Production): `SCOUT_MONTHLY_BUDGET_USD=100`, `SCOUT_MAX_RUNS_PER_DAY=10`. Redeploy. | Defaults are US$50 a month and 5 runs a day, which two people testing can hit. |
| 5 | **Set up email alerts** (otherwise nobody tells you when a buyer approves or asks for a verification). Create a Resend account, make an API key, then set `RESEND_API_KEY`, `OPERATOR_EMAIL` (your email) and `LEAD_NOTIFY_FROM` = `PropLync <onboarding@resend.dev>`. | As far as I know Resend's test sender (`onboarding@resend.dev`) only delivers to the account owner's own address, which is all the operator alerts need. Check Resend's current rules. Until then run `node scripts/scout.mjs list` to see new briefs. |
| 6 | **Run the doctor** from the main checkout: `node scripts/doctor.mjs` | It must end with **✓ Ready.** Anything it marks ✗ or lists under PROBLEMS will break the test. It spends nothing. |

### What the doctor checks for you

Each provider accepts its key and still lists the model we call (retired model IDs are the usual silent failure),
Scout can start a run, the limits and the month's spending, every table exists, and whether any run is stuck.
It never prints a secret.

## 2. Dress rehearsal: do the whole journey yourself first

Do steps 0.1–0.5 once as a buyer, with your own email, before your partner does. This is the first real Scout run
ever, and it should not be your partner's.

1. Open `https://proplync-mx.vercel.app/invest`, tap the microphone and describe a search. Use a real area and a
   realistic budget (for example *Playa del Carmen, up to USD 300,000, pool, walkable to the beach*).
2. When Concierge says the brief is ready, tap **Review and approve**, sign in, tick consent, approve.
3. Watch `Scout está buscando…`. Note how long it takes; I expect a few minutes, but this is the first real measurement. If it has not moved after 10 minutes, see section 5.
4. You should see candidates, each with sources and prices, all labelled *sin verificar*.
5. Run `node scripts/doctor.mjs` again: the month's spend and "today" should now show the run.

**What a good run looks like:** 3–10 candidates, each with at least one real listing link, prices that match the
page, and nothing that is obviously sold. Open two or three links yourself. If the links are wrong or the
properties are junk, stop and tell me: that is a Scout quality problem, not a deployment problem.

## 3. Your partner's test

1. Your partner signs in once on `/voice` (so the account exists), then you give them credits:
   `node scripts/credits.mjs grant partner@email.com 5 --note "pilot"`
   The first search is free; each further search costs 1 credit and each verification 1 credit.
2. They run the journey from section 0. Sit with them, or watch the doctor.
3. When they ask for a verification you get an email (if you set it up) or see it with
   `node scripts/scout.mjs list`. Then:
   - `node scripts/scout.mjs review <briefId>` shows each candidate and the five questions to ask the agent.
   - Phone the listing agent. Record the answers:
     `node scripts/scout.mjs confirm <candidateId> --answers '{"available":"si","price":"USD 285,000","can_visit":"si","listing_agent":"Ana, Casa Tulum","restrictions":"no rentas vacacionales"}'`
   - If it is sold or dead: `node scripts/scout.mjs reject <candidateId> --reason "vendido en agosto"`.
   - When you have finished: `node scripts/scout.mjs ready <briefId>`. The buyer then sees the confirmed answers.

Time yourself: **minutes per verification** is one of the numbers your business model says to track.

## 4. What protects you while you test

| Protection | Behaviour |
|---|---|
| Per-run cost | At US$3 the run is told to wrap up and submit; at US$6 it is stopped, counted as failed and the buyer is refunded. |
| Daily and monthly caps | `SCOUT_MAX_RUNS_PER_DAY`, `SCOUT_MONTHLY_BUDGET_USD`. When reached, the buyer is told Scout is busy and is **not** charged. |
| Failed run | The credit (or the free first search) is refunded automatically. |
| Lost hand-off | If a run stalls, the buyer's status page restarts it within about a minute; if it is hopelessly stuck (35 minutes) it is closed and refunded, and you are emailed. |
| Kill switch | `SCOUT_PAID_RUNS=off` in Vercel stops all automatic runs at once. Buyers keep their saved brief. |

## 5. When something looks wrong

| You see | Likely cause | Do this |
|---|---|---|
| Doctor says *Scout cannot research* | The Anthropic key is wrong, revoked, or the model was retired | Check the key in Vercel; the doctor prints the reason |
| Run stays on *searching* more than 10 minutes | A hand-off was lost | Keep the buyer's page open (it restarts the run). Fallback: `node scripts/scout.mjs run <briefId>` from your machine (needs `ANTHROPIC_API_KEY` in `.env.local`) |
| *This search did not finish. We gave the credit back* | The run failed and was refunded | Doctor, then `node scripts/scout.mjs list`. Tell me the briefId |
| *Scout is very busy today… you were not charged* | A daily or monthly cap was reached | Raise the cap (section 1, step 4) |
| Concierge says *no respondió* | Both providers failed after a retry | Doctor: it will show which provider is down |
| Voice notes fail | The speech model is missing from Groq | Doctor shows it under PROBLEMS |
| Forms on `/agents` or `/agencias` say they could not send | Migration 013 not applied | Section 1, step 1 |

Vercel keeps runtime logs for **one hour only** on this plan, so look soon after something fails. The failure
reasons are also written to `scout_runs.error` and visible with the doctor.

## 6. Roll back

Vercel → Deployments → the previous production deployment → **Promote to Production**. Data is untouched: the
migration only adds a table.

## 7. What to write down

Per run: minutes it took, cost (from the doctor or `scout_runs.cost_usd`), candidates found, how many links were
real. Per verification: your minutes and whether the agent answered. These are the numbers in
`BUSINESS-MODEL.md` §4. Decide after the test, not before.
