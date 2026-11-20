# PropLync Mini

"All your properties in one link." A self-serve product for real-estate agents, sold from social ads:
paste your WhatsApp inventory, see your page, confirm your email, pay MXN 249 for 3 months, share one link.

It runs as **its own Vercel project** (Root Directory `mini`), so it has its own domain, deploys and
12-function budget. It shares PropLync's Supabase database, auth and storage, and imports PropLync's
rules from `../api` instead of copying them (plan caps, field validation, signup, paste import).

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
1. New Vercel project from this repo, **Root Directory `mini`**, framework "Other", and keep
   "Include files outside the root directory" on (the functions import `../api`).
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
