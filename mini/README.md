# PropLync Mini

"Your business in one link." A self-serve page sold from social ads. It started with real-estate agents
(paste your WhatsApp inventory, see your page, confirm your email, pay MXN 249 for 3 months, share one link)
and now serves anyone who sells services: `agencies.business_type` picks a template from `js/business-types.js`
(real estate, professional services, trades, beauty, or general), and the page shows a services catalog
(`mini_services`, migration 019) with or without properties.

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
| `/:slug` | `p.html` via `api/page.js` | The public page (server-rendered link previews; `?p=<public_id>` opens one property; `?vista=1` is the owner's private preview before paying, visible only with their session) |
| `/privacidad`, `/terminos` | | Legal drafts (noindex, `[CONFIRMAR]` items pending) |
| `/pago` | redirect | → `/panel?pay=1` |

## Functions (5 of 12)
`api/signup.js` (status, create) · `api/import.js` (paste → properties) · `api/panel.js` (card + listings via
`api/my-listings.js`, services via `api/_services.js`, material (infographics, PDFs) via `api/_assets.js`, `paid-notice`, `preview`) · `api/page.js` (public page) · `api/whatsapp.js` (Meta webhook for the assistant). Panel resources also serve
the CRM (`api/_cases.js`) and the assistant's training and test chat (`api/_bot.js`). The preview address carries no secret:
`/:slug?vista=1` is an empty shell that loads the page with the owner's own session, so a shared preview link shows nothing.

## Set up the Vercel project (once)
1. Vercel project `proplync-mini` (created 2026-11-20): this repo, **Root Directory `mini`**, framework "Other".
   Production: https://proplync-mini.vercel.app
2. Environment variables (Production and Preview): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `SUPABASE_ANON_KEY`, `GROQ_API_KEY`, `ANTHROPIC_API_KEY`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`,
   `RESEND_API_KEY`, `LEAD_NOTIFY_FROM`, `OPERATOR_EMAIL`, `MINI_SIGNUP` (`on` to open signup),
   optional `PROPLYNC_SITE_URL`.
3. Supabase Auth → URL configuration: add the Mini domain to the redirect allow-list.
4. Payment details for customers: `js/pay-config.js` (bank, CLABE, holder). Empty = "Pedir datos de pago".

## WhatsApp assistant: connecting a number (once per customer)
1. The customer creates a Meta Business account; their number goes on the WhatsApp Cloud API (coexistence keeps their app).
2. On proplync-mini set `WHATSAPP_APP_SECRET`, `WHATSAPP_TOKEN`, `WHATSAPP_VERIFY_TOKEN` (and optionally `WHATSAPP_GRAPH_VERSION`).
3. Subscribe `https://proplync-mini.vercel.app/api/whatsapp` (field `messages`) in the Meta app with the verify token.
4. Save their `phone_number_id` in `mini_bot.wa_phone_number_id` for their agency. Until then the panel says "Sin conectar".

## Operating it
- Who is waiting to pay, and their payment notices: `node scripts/mini.mjs list`
- After a payment is in: `node scripts/mini.mjs activate <slug>` (publishes drafts, 90 days, logs `mini_activated`)
- Client CRM add-on (MXN 149/month) after its payment: `node scripts/mini.mjs crm <slug> [--days 30]`
- Close signup without touching live pages: `MINI_SIGNUP=off`.

## Local preview
Static pages open over any local server from this folder. Functions need `vercel dev` inside `mini/`
after `vercel link` to the Mini project.
