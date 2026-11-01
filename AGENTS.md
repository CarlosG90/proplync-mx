# AGENTS.md

Instructions for any coding agent working in this repo. The source of truth is `CLAUDE.md`; read it first.

1. `CLAUDE.md`: what the product is, the stack, hard constraints (12-function Vercel cap, Groq limits), conventions.
2. `docs/CONTEXT-MAP.md`: the feature → files → data → tests graph and the loops (change, live-QA, Concierge prompt, Scout). Read only the nodes you need.
3. Folder rules load on demand: `api/CLAUDE.md`, `js/CLAUDE.md`, `scripts/CLAUDE.md`, `test/CLAUDE.md`.
4. `mexico_scout_platform/agent.md` is for the Python sub-project only.

Non-negotiables: branch → PR → squash-merge only when the user asks; `npm test` before a PR; never print env values;
ask before real Scout runs, paid API calls and production DB writes.
