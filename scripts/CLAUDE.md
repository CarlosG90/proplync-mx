# scripts/: operator scripts

These act on the **production** database. Treat every run as an outward-facing action.

- `scout.mjs new|run|review|confirm|reject|ready`: `new` creates a brief row; `run` spends money and needs `ANTHROPIC_API_KEY`, which exists only in Vercel, not in `.env.local`. Ask before `run`, and say which rows you created.
- `credits.mjs grant <email> <n> --note …`: moves real credits.
- `onboard-agency.mjs`, `create-invite.mjs`: create accounts or invites.
- `doctor.mjs`: read-only health check (`/api/finder?action=health` answers 401 without the doctor token). `funnel.mjs`: read-only funnel.
- Load env with `node --env-file=.env.local script.mjs`. Never print the values.
- Leave no QA rows behind without telling the user (name, id, what they are).
