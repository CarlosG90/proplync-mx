# api/: rules for serverless code

Loaded when you work in this folder. The root `CLAUDE.md` still applies.

- **No new `api/*.js` file.** All 12 Vercel Hobby slots are used. Add an `action` to an existing handler, plus a rewrite in `vercel.json` if it needs a pretty URL. `api/_lib/` doesn't count.
- **Big file:** `finder.js` is huge. `Grep` for `action ===`, `SYSTEM`, `scout-step` and `Read` with `offset`/`limit`; don't read it whole.
- **Order in a handler:** method check → `enforceRateLimit` → auth (`requireAgencyUser`) → plan check → work in `try/catch`. Return `{ error: 'snake_case_code', detail: safeDetail(err) }` and `logDegraded()` outages.
- **Vercel limits:** 10 s per request on Hobby; long work goes through `waitUntil` and the resumable Scout chain. 4.5 MB request body.
- **LLM output is untrusted:** validate JSON before use (`parseReply`, Scout's range checks). A Groq 429 means "busy", never a crash.
- **Concierge** returns `{ say, brief, missing, done }`; the `brief` field names are a contract with `buyer_briefs`. Prompt changes: follow the "Concierge prompt loop" in `docs/CONTEXT-MAP.md`.
- **DB:** service-role client only here. The three Finder tables have RLS on and no policies. A schema change is a new `supabase/0NN_*.sql` (idempotent, with RLS); the next free number is 018.
- **Tests** for anything in `_lib/` go in `test/` and into the `npm test` list in `package.json`.
