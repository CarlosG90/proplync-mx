# Proplync.mx · Riviera Maya

Bilingual (ES/EN) landing site for a real-estate content-automation system aimed at
the Riviera Maya market, with real property photos and an optional serverless proxy
that can feed live listings from **MercadoLibre** (Mexico's largest marketplace, with
a real "Inmuebles" category) without exposing your app credentials.

## What's here

```
proplync-mx/
├── index.html          # the site (open directly in a browser to preview)
├── api/listings.js     # MercadoLibre proxy (Vercel path: /api/listings) — optional, free app credentials
├── api/ml-callback.js   # one-time OAuth handoff for the MercadoLibre proxy above
├── api/photos.js        # Pexels proxy (Vercel path: /api/photos) — free real photos for the sample listings
├── .env.example         # copy to .env.local and add your key(s)
├── vercel.json           # minimal Vercel config
└── .gitignore
```

## Preview locally

Just open `index.html` in a browser. With no proxies running it shows six illustrated
sample listings (Tulum, Playa del Carmen, Puerto Morelos, Cancún) and a working
ES⇄EN toggle, ROI calculator, and "1 listing → 6 formats" demo.

## Real photos, no MLS account needed

The six sample listings ship with a `photoQuery` (e.g. "jungle villa mexico exterior").
On load, the page calls `/api/photos`, which searches **Pexels** for a free, real photo
matching each query and swaps it in for the illustrated placeholder.

1. **Get a free Pexels API key** — instant, no approval wait: https://www.pexels.com/api/
2. Copy `.env.example` to `.env.local` and fill in `PEXELS_API_KEY`.
3. Deploy (see below). If `/api/photos` isn't reachable, the illustrated samples stay —
   nothing breaks.

## Go live with real inventory (optional, free)

MercadoLibre's real-estate search is free, but its search endpoint requires an OAuth
token — anonymous requests 403. Access tokens expire every 6 hours and the
refresh_token that renews them is single-use (a new one is issued on every refresh),
so it lives in Upstash Redis (Vercel Marketplace, free tier) rather than a plain env
var. One-time setup:

1. **Add Upstash Redis to the project** (auto-provisions the env vars below):
   `vercel integration add upstash/upstash-kv`
2. **Register a free app** at developers.mercadolibre.com.mx (any MercadoLibre account
   works). Set its redirect URI to `https://<your-domain>/api/ml-callback` exactly.
   Save the Client ID and Client Secret.
3. Add them as env vars: `vercel env add ML_CLIENT_ID`, `vercel env add ML_CLIENT_SECRET`.
4. Deploy, then visit this URL once in a browser (with your real client_id and domain),
   log in, and authorize:
   `https://auth.mercadolibre.com.mx/authorization?response_type=code&client_id=<ID>&redirect_uri=https://<your-domain>/api/ml-callback`
5. MercadoLibre redirects to `/api/ml-callback`, which exchanges the code for tokens
   and stores them in Redis. You're done — `/api/listings` refreshes itself from here.
   Re-run step 4 only if the refresh_token expires from 6 months of disuse.

If `/api/listings` isn't reachable or not yet authorized, the samples (with Pexels
photos) stay — nothing breaks.

## Deploy (Vercel)

```bash
npm i -g vercel
vercel                              # follow prompts
vercel env add PEXELS_API_KEY       # paste your key
vercel env add ML_CLIENT_ID         # optional, MercadoLibre live listings
vercel env add ML_CLIENT_SECRET     # optional, MercadoLibre live listings
vercel --prod
```

If you host the proxies on a different domain, change `LISTINGS_ENDPOINT` / `PHOTOS_ENDPOINT`
near the top of the `<script>` in `index.html` to the full URL.

## Notes

- The listings proxy queries MercadoLibre per town (Tulum, Playa del Carmen, Puerto
  Morelos, Cancún) and caches results 5 minutes at the edge.
- The photos proxy caches results 1 day at the edge.
- Only publish content from listings you own or are authorized to use.
- Photos from Pexels are free to use; crediting the photographer (returned in the API
  response) isn't required by their license but is appreciated.
- Privacy: keep exact addresses internal; public pieces use area-level location
  (Mexico's LFPDPPP).

Built with Claude Code.
