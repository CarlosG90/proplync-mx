# Proplync.mx · Riviera Maya

Bilingual (ES/EN) landing site for a real-estate content-automation system aimed at
the Riviera Maya market, with real property photos and an optional serverless proxy
that can feed live listings from **EasyBroker** (Mexico's MLS) without exposing your
API key.

## What's here

```
proplync-mx/
├── index.html          # the site (open directly in a browser to preview)
├── api/listings.js     # EasyBroker proxy (Vercel path: /api/listings) — optional, needs a paid EasyBroker account
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

## Go live with real inventory (optional)

EasyBroker has **no free or sandbox tier** — you need a real, paid broker account to get
an API key at all, even for test/fictional data. If you have one:

1. Get your key at app.easybroker.com → Settings → API.
2. Add `EASYBROKER_API_KEY` to `.env.local` (or your Vercel project's env vars).
3. The site fetches `/api/listings` on load. If the proxy answers, real inventory
   replaces the samples automatically; if not, the samples (with Pexels photos) stay.

## Deploy (Vercel)

```bash
npm i -g vercel
vercel                              # follow prompts
vercel env add PEXELS_API_KEY       # paste your key
vercel env add EASYBROKER_API_KEY   # optional, only if you have a paid account
vercel --prod
```

If you host the proxies on a different domain, change `LISTINGS_ENDPOINT` / `PHOTOS_ENDPOINT`
near the top of the `<script>` in `index.html` to the full URL.

## Notes

- The listings proxy paginates EasyBroker (50/page, up to `MAX_PAGES`) and caches results
  5 minutes at the edge, staying under EasyBroker's 20 req/s limit.
- The photos proxy caches results 1 day at the edge.
- Only publish content from listings you own or are authorized to use.
- Photos from Pexels are free to use; crediting the photographer (returned in the API
  response) isn't required by their license but is appreciated.
- Privacy: keep exact addresses internal; public pieces use area-level location
  (Mexico's LFPDPPP).

Built with Claude Code.
