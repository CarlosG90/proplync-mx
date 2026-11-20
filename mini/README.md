# PropLync Mini

"All your properties in one link." A self-serve product for real-estate agents, sold from social ads:
paste your WhatsApp inventory, see your page, confirm your email, pay MXN 249 for 3 months, share one link.

It runs as **its own Vercel project** (Root Directory `mini`), so it has its own domain, deploys and
12-function budget. It shares PropLync's Supabase database, auth and storage, and runs PropLync's own
rules (plan caps, field validation, signup, paste import) from `api/_proplync/`: a generated copy of the
PropLync files it uses. Vercel only installs packages inside `mini/`, so importing `../api` directly
failed at runtime. Never edit the copy: change `api/` and run `node scripts/sync-mini-shared.mjs`;
`npm test` fails while the copy is out of date.

## Pages
| Path | File | What |
|---|---|---|
| `/` | `index.html` | Landing + paste → preview → email code → saved (unpaid) |
| `/panel` | `panel.html` | The customer's account: status, pay/renew, link + QR, properties, card |
| `/:slug` | `p.html` via `api/page.js` | The public page (server-rendered link previews; `?p=<public_id>` opens one property) |
| `/privacidad`, `/terminos` | | Legal drafts (noindex, `[CONFIRMAR]` items pending) |
| `/pago` | redirect | → `/panel?pay=1` |

## Functions (4 of 12)
`api/signup.js` (status, create) · `api/import.js` (paste → properties) · `api/panel.js` (card + listings via
`api/my-listings.js`, `paid-notice`) · `api/page.js` (public page).

## Set up the Vercel project (once)
1. Vercel project `proplync-mini` (created 2026-11-20): this repo, **Root Directory `mini`**, framework "Other".
   Production: https://proplync-mini.vercel.app
2. Environment variables (Production and Preview): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `SUPABASE_ANON_KEY`, `GROQ_API_KEY`, `ANTHROPIC_API_KEY`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`,
   `RESEND_API_KEY`, `LEAD_NOTIFY_FROM`, `OPERATOR_EMAIL`, `MINI_SIGNUP` (`on` to open signup),
   optional `PROPLYNC_SITE_URL`.
3. Supabase Auth → URL configuration: add the Mini domain to the redirect allow-list.
4. Payment details for customers: `js/pay-config.js` (bank, CLABE, holder). Empty = "Pedir datos de pago".

## Operating it
- Who is waiting to pay, and their payment notices: `node scripts/mini.mjs list`
- After a payment is in: `node scripts/mini.mjs activate <slug>` (publishes drafts, 90 days, logs `mini_activated`)
- Close signup without touching live pages: `MINI_SIGNUP=off`.

## Local preview
Static pages open over any local server from this folder. Functions need `vercel dev` inside `mini/`
after `vercel link` to the Mini project.
