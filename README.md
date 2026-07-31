# InmoContent OS · Riviera Maya

Bilingual (ES/EN) landing site for a real-estate content-automation system aimed at
the Riviera Maya market, plus a serverless proxy that feeds live property listings
from **EasyBroker** (Mexico's MLS) without exposing your API key.

## What's here

```
inmo-riviera/
├── index.html          # the site (open directly in a browser to preview)
├── api/listings.js     # EasyBroker proxy (Vercel path: /api/listings)
├── .env.example        # copy to .env.local and add your key
├── vercel.json         # minimal Vercel config
└── .gitignore
```

## Preview locally

Just open `index.html` in a browser. With no proxy running it shows six illustrated
sample listings (Tulum, Playa del Carmen, Puerto Morelos, Cancún) and a working
ES⇄EN toggle, ROI calculator, and "1 listing → 6 formats" demo.

## Go live with real listings

1. **Get an EasyBroker API key** — real data: app.easybroker.com → Settings → API.
   To test with no account, EasyBroker publishes a sandbox key (fictional data) in
   their docs playground at dev.easybroker.com.
2. **Set the environment variable** — copy `.env.example` to `.env.local` and fill in
   `EASYBROKER_API_KEY`.
3. **Deploy** (Vercel is simplest):
   ```bash
   npm i -g vercel
   vercel            # follow prompts
   vercel env add EASYBROKER_API_KEY   # paste your key
   vercel --prod
   ```
   The site fetches `/api/listings` on load. If the proxy answers, real inventory
   replaces the samples automatically; if not, the samples stay (nothing breaks).

If you host the proxy on a different domain, change `const LISTINGS_ENDPOINT` near the
top of the `<script>` in `index.html` to the full URL.

## Notes

- The proxy paginates EasyBroker (50/page, up to `MAX_PAGES`) and caches results 5
  minutes at the edge, staying under EasyBroker's 20 req/s limit.
- Only publish content from listings you own or are authorized to use.
- Privacy: keep exact addresses internal; public pieces use area-level location
  (Mexico's LFPDPPP).

Built with Claude Code.
