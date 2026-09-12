/**
 * Proplync.mx · Property Search API
 * -----------------------------------------------------------------------------
 * Searches the cached EasyBroker inventory with server-side filters.
 * Falls back to the sample properties when no API key is configured.
 * Uses Upstash Redis for caching (5 min TTL).
 *
 * Also merges in published listings created by agencies through /dashboard
 * (Supabase-backed, Phase 1 multi-tenant SaaS pivot). Agency rows are mapped
 * to this exact same object shape and tagged source:'agency' — the existing
 * filter logic below runs over the merged array unmodified.
 * -----------------------------------------------------------------------------
 */

import { getServiceClient } from './_lib/supabase.js';
import { redisGet, redisSet } from './_lib/redis.js';
import { logDegraded, safeDetail } from './_lib/health.js';

const EB_URL = 'https://api.easybroker.com/v1';
const PAGE_LIMIT = 50;
const MAX_PAGES = 40;
const PAGE_DELAY_MS = 120;

/* ---------- sample data (same as index.html) ---------- */
const SAMPLES = [
  {public_id:'EB-T2451',title_es:'Departamento en preventa',title_en:'Pre-sale apartment',town:'Tulum',neighborhood:'Aldea Zamá',bedrooms:2,bathrooms:2,parking:1,size:78,operation:'sale',currency:'USD',amount:245000,formatted:'245,000',image:'https://images.pexels.com/photos/35877931/pexels-photo-35877931.jpeg?auto=compress&cs=tinysrgb&w=800',lat:20.2114,lng:-87.4654},
  {public_id:'EB-P8830',title_es:'Casa con alberca en Playacar',title_en:'House with pool in Playacar',town:'Playa del Carmen',neighborhood:'Playacar Fase II',bedrooms:3,bathrooms:4,parking:2,size:240,operation:'sale',currency:'USD',amount:685000,formatted:'685,000',image:'https://images.pexels.com/photos/8134849/pexels-photo-8134849.jpeg?auto=compress&cs=tinysrgb&w=800',lat:20.6116,lng:-87.0739},
  {public_id:'EB-M1207',title_es:'Studio frente al mar',title_en:'Beachfront studio',town:'Puerto Morelos',neighborhood:'Zona Hotelera',bedrooms:1,bathrooms:1,parking:1,size:45,operation:'sale',currency:'USD',amount:189000,formatted:'189,000',image:'https://images.pexels.com/photos/6312076/pexels-photo-6312076.jpeg?auto=compress&cs=tinysrgb&w=800',lat:20.8460,lng:-86.8756},
  {public_id:'EB-C4062',title_es:'Penthouse vista al Caribe',title_en:'Penthouse with Caribbean view',town:'Cancún',neighborhood:'Puerto Cancún',bedrooms:3,bathrooms:3,parking:2,size:180,operation:'sale',currency:'USD',amount:1150000,formatted:'1,150,000',image:'https://images.pexels.com/photos/6775268/pexels-photo-6775268.jpeg?auto=compress&cs=tinysrgb&w=800',lat:21.1394,lng:-86.7649},
  {public_id:'EB-P5519',title_es:'Departamento amueblado',title_en:'Furnished apartment',town:'Playa del Carmen',neighborhood:'Centro',bedrooms:2,bathrooms:2,parking:1,size:90,operation:'rental',currency:'USD',amount:2200,formatted:'2,200',image:'https://images.pexels.com/photos/6969824/pexels-photo-6969824.jpeg?auto=compress&cs=tinysrgb&w=800',lat:20.6296,lng:-87.0739},
  {public_id:'EB-T3388',title_es:'Villa en la selva',title_en:'Villa in the jungle',town:'Tulum',neighborhood:'Región 15',bedrooms:4,bathrooms:4,parking:3,size:320,operation:'sale',currency:'USD',amount:890000,formatted:'890,000',image:'https://images.pexels.com/photos/4940760/pexels-photo-4940760.jpeg?auto=compress&cs=tinysrgb&w=800',lat:20.1950,lng:-87.4550},
  {public_id:'EB-P9214',title_es:'Penthouse con vista al mar en Coco Beach',title_en:'Oceanview penthouse in Coco Beach',town:'Playa del Carmen',neighborhood:'Coco Beach',bedrooms:2,bathrooms:2,parking:1,size:204,operation:'sale',currency:'USD',amount:839000,formatted:'839,000',image:'https://images.pexels.com/photos/36362/pexels-photo.jpg?auto=compress&cs=tinysrgb&w=800',lat:20.6455,lng:-87.0625},
  {public_id:'EB-T6720',title_es:'Estudio frente al mar en Tankah Bay',title_en:'Beachfront studio in Tankah Bay',town:'Tulum',neighborhood:'Tankah Bay',bedrooms:1,bathrooms:1,parking:1,size:51,operation:'sale',currency:'USD',amount:672190,formatted:'672,190',image:'https://images.pexels.com/photos/31688473/pexels-photo-31688473.jpeg?auto=compress&cs=tinysrgb&w=800',lat:20.2970,lng:-87.4280}
];

function mapProperty(p) {
  const loc = (p.location || {});
  const ops = p.operations || [];
  const op = ops[0] || {};
  const fmt = op.formatted_amount || String(op.amount || 0);
  const parts = (loc.name || '').split(',').map(s => s.trim());
  return {
    public_id: p.public_id,
    title_es: p.title || '',
    title_en: p.title || '',
    town: parts[1] || parts[0] || '',
    neighborhood: parts[0] || '',
    bedrooms: p.bedrooms || 0,
    bathrooms: p.bathrooms || 0,
    parking: p.parking_spaces || 0,
    size: p.lot_size || p.construction_size || 0,
    operation: op.type === 'rental' ? 'rental' : 'sale',
    currency: op.currency || 'MXN',
    amount: op.amount || 0,
    formatted: fmt.replace(/[^0-9,.]/g, ''),
    image: (p.title_image_full || p.title_image_thumb || ''),
    lat: loc.latitude || null,
    lng: loc.longitude || null
  };
}

async function fetchAllFromEB(key) {
  const all = [];
  let page = 1;
  while (page <= MAX_PAGES) {
    const url = `${EB_URL}/properties?page=${page}&limit=${PAGE_LIMIT}&search[statuses][]=published`;
    const r = await fetch(url, {
      headers: { accept: 'application/json', 'Country-Code': 'MX', 'X-Authorization': key }
    });
    if (!r.ok) throw new Error(`EB responded ${r.status}`);
    const data = await r.json();
    const batch = (data.content || []).map(mapProperty);
    all.push(...batch);
    if (batch.length < PAGE_LIMIT || !data.pagination?.next_page) break;
    page++;
    if (page <= MAX_PAGES) await new Promise(ok => setTimeout(ok, PAGE_DELAY_MS));
  }
  return all;
}

function formatAmount(amount) {
  return Number(amount || 0).toLocaleString('en-US');
}

/* ── City landing page rendering ─────────────────────────────────────────── */

const DIACRITICS = new RegExp('[̀-ͯ]', 'g');

export function slugify(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(DIACRITICS, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function unslugify(slug) {
  return String(slug || '').split('-').filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Listing titles are agent-supplied; this is where their text becomes markup. */
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function money(p) {
  return `${p.currency || ''} $${Number(p.amount || 0).toLocaleString('en-US')}` +
         (p.operation === 'rental' ? '/mes' : '');
}

/**
 * A full HTML page per city. Rendered server-side so the listings are in the
 * markup a crawler sees, with JSON-LD ItemList so results can show rich data.
 */
function renderCityPage(town, slug, listings, canonical) {
  const count = listings.length;
  const title = `Propiedades en ${town} · ${count} en venta y renta | Proplync.mx`;
  const desc = count
    ? `${count} propiedades en ${town}: casas, departamentos y terrenos en venta y renta, publicados por agentes y propietarios directos.`
    // Was "...en ${town} ... en la Riviera Maya", which reads as nonsense the
    // moment town is Puebla. The town is the location; naming a second region
    // around it only makes the sentence wrong.
    : `Propiedades en ${town} en venta y renta.`;

  const cards = listings.map(p => `
      <a class="ct-card" href="/property/${esc(p.public_id)}">
        <div class="ct-photo" style="background-image:url('${esc((p.image || '').replace(/'/g, '%27'))}')">
          <span class="ct-badge">${p.operation === 'sale' ? 'Venta' : 'Renta'}</span>
        </div>
        <div class="ct-body">
          <div class="ct-loc">${esc([p.neighborhood, p.town].filter(Boolean).join(' · '))}</div>
          <h2 class="ct-title">${esc(p.title_es || p.title_en)}</h2>
          <div class="ct-specs">${p.bedrooms || 0} rec · ${p.bathrooms || 0} baños · ${p.size || 0} m²</div>
          <div class="ct-price">${esc(money(p))}</div>
        </div>
      </a>`).join('');

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `Propiedades en ${town}`,
    numberOfItems: count,
    itemListElement: listings.slice(0, 25).map((p, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: `${canonical.replace(/\/propiedades-en-.*$/, '')}/property/${p.public_id}`,
      name: p.title_es || p.title_en
    }))
  };

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(canonical)}">
${listings[0] && listings[0].image ? `<meta property="og:image" content="${esc(listings[0].image)}">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400&family=Hanken+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/tokens.css">
<link rel="stylesheet" href="/css/nav.css">
<link rel="stylesheet" href="/css/components.css">
<style>
  .ct-hero{background:var(--ink);color:var(--on-ink);padding:52px 0 44px}
  .ct-eyebrow{font-family:var(--mono);font-size:.66rem;letter-spacing:.18em;text-transform:uppercase;color:var(--gold);display:flex;align-items:center;gap:12px;margin-bottom:12px}
  .ct-eyebrow::before{content:"";width:28px;height:1px;background:var(--gold)}
  .ct-hero h1{font-family:var(--display);font-size:clamp(1.9rem,4vw,3rem);font-weight:300;line-height:1.12;color:var(--on-ink);margin:0}
  .ct-hero p{margin-top:14px;color:var(--on-ink-dim);font-size:.95rem;max-width:46em;line-height:1.7}
  .ct-body-wrap{padding:48px 0 90px}
  .ct-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
  .ct-card{background:var(--white);border:1px solid rgba(26,36,56,.06);border-radius:var(--radius-lg);overflow:hidden;box-shadow:var(--shadow-card);display:block;transition:transform var(--duration) var(--ease-out),box-shadow var(--duration) ease}
  .ct-card:hover{transform:translateY(-3px);box-shadow:var(--shadow-card-hover)}
  .ct-photo{position:relative;height:190px;background-size:cover;background-position:center;background-color:var(--sand)}
  .ct-badge{position:absolute;top:12px;left:12px;font-family:var(--mono);font-size:.58rem;letter-spacing:.08em;text-transform:uppercase;font-weight:700;padding:5px 11px;border-radius:999px;background:rgba(45,138,133,.92);color:#fff}
  .ct-body{padding:18px 20px 20px}
  .ct-loc{font-family:var(--mono);font-size:.6rem;letter-spacing:.1em;text-transform:uppercase;color:var(--gold)}
  .ct-title{font-family:var(--display);font-size:1.04rem;font-weight:400;color:var(--ink);margin:7px 0 0;line-height:1.3}
  .ct-specs{font-family:var(--mono);font-size:.66rem;color:var(--on-sand-dim);margin-top:9px}
  .ct-price{font-family:var(--mono);font-weight:700;color:var(--ink);margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
  .ct-empty{text-align:center;padding:70px 20px;color:var(--on-sand-dim)}
  .ct-links{margin-top:56px;padding-top:32px;border-top:1px solid var(--line)}
  .ct-links h2{font-family:var(--display);font-size:1.2rem;font-weight:400;color:var(--ink);margin:0 0 18px}
  .ct-links-cols{display:grid;grid-template-columns:repeat(4,1fr);gap:20px}
  .ct-links-cols h3{font-size:.78rem;color:var(--ink);margin:0 0 10px}
  .ct-links-cols a{display:block;font-size:.82rem;color:var(--on-sand-dim);padding:4px 0}
  .ct-links-cols a:hover{color:var(--sea)}
  @media (max-width:900px){.ct-grid{grid-template-columns:repeat(2,1fr)}.ct-links-cols{grid-template-columns:repeat(2,1fr)}}
  @media (max-width:560px){.ct-grid{grid-template-columns:1fr}}
</style>
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
<header>
  <nav class="wrap">
    <a class="brand" href="/">Proplync<span class="accent">.mx</span></a>
    <div class="navlinks"><a href="/search">Buscar propiedades</a><a href="/generate">Generador</a></div>
    <div class="navtools"><a href="/search" class="btn btn-gold">Ver todas</a></div>
  </nav>
</header>

<section class="ct-hero">
  <div class="wrap">
    <div class="ct-eyebrow">Riviera Maya</div>
    <h1>Propiedades en ${esc(town)}</h1>
    <p>${esc(desc)}</p>
  </div>
</section>

<main class="ct-body-wrap">
  <div class="wrap">
    ${count ? `<div class="ct-grid">${cards}</div>` : `<p class="ct-empty">Aun no hay propiedades publicadas en ${esc(town)}. <a href="/generate" style="color:var(--sea)">Publica la primera</a>.</p>`}

    <div class="ct-links">
      <h2>Enlaces inmobiliarios utiles</h2>
      <div class="ct-links-cols">
        <div>
          <h3>En venta</h3>
          <a href="/search?op=sale&town=${encodeURIComponent(town)}">Casas en venta en ${esc(town)}</a>
          <a href="/search?op=sale&town=${encodeURIComponent(town)}">Departamentos en venta en ${esc(town)}</a>
        </div>
        <div>
          <h3>En renta</h3>
          <a href="/search?op=rental&town=${encodeURIComponent(town)}">Casas en renta en ${esc(town)}</a>
          <a href="/search?op=rental&town=${encodeURIComponent(town)}">Departamentos en renta en ${esc(town)}</a>
        </div>
        <div>
          <h3>Otras ciudades</h3>
          <a href="/propiedades-en-tulum">Propiedades en Tulum</a>
          <a href="/propiedades-en-playa-del-carmen">Propiedades en Playa del Carmen</a>
          <a href="/propiedades-en-cancun">Propiedades en Cancun</a>
        </div>
        <div>
          <h3>Explorar</h3>
          <a href="/search">Todas las propiedades</a>
          <a href="/generate">Publicar mi propiedad</a>
        </div>
      </div>
    </div>
  </div>
</main>

<footer>
  <div class="wrap foot">
    <span class="brand">Proplync<span class="accent">.mx</span></span>
    <span>Riviera Maya · Tulum · Playa del Carmen · Cancun</span>
  </div>
</footer>
</body>
</html>`;
}

/* One agency row -> the same object shape the rest of the site renders. */
function mapAgencyRow(row) {
  return {
    public_id: row.public_id,
    title_es: row.title_es,
    title_en: row.title_en,
    town: row.town,
    neighborhood: row.neighborhood,
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
    parking: row.parking,
    size: row.size,
    operation: row.operation,
    currency: row.currency,
    amount: row.amount,
    formatted: formatAmount(row.amount),
    image: row.image,
    images: row.images,
    description_es: row.description_es,
    description_en: row.description_en,
    lat: row.lat,
    lng: row.lng,
    features: row.features,
    source: 'agency'
  };
}

/** Strip accents and case, so "Cancún" and "Cancun" are the same town. */
function fold(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

async function fetchAgencyListings() {
  try {
    const svc = getServiceClient();
    const { data, error } = await svc.from('listings').select('*').eq('status', 'published');
    if (error) {
      // Returning [] here is what made a dead database look like "no agency
      // listings yet" — buyers saw only EasyBroker/sample inventory.
      logDegraded('supabase:listings.published', error);
      return [];
    }
    if (!data) return [];
    return data.map(mapAgencyRow);
  } catch (err) {
    logDegraded('supabase:listings.published', err);
    return [];
  }
}

async function getInventory() {
  const agencyListings = await fetchAgencyListings();

  // 1. Try Redis cache
  const cached = await redisGet('eb:listings:all');
  if (cached && cached.length) return [...agencyListings, ...cached];

  // 2. Try EasyBroker
  const ebKey = process.env.EASYBROKER_API_KEY;
  if (ebKey) {
    const live = await fetchAllFromEB(ebKey);
    if (live.length) {
      await redisSet('eb:listings:all', live, 300);
      return [...agencyListings, ...live];
    }
  }

  /* 3. No live inventory source is configured. The samples exist so a
        brand-new deployment does not look abandoned, and that was fine while
        there were no customers.

        It stops being fine the moment real agency listings exist. Padding the
        results with eight invented properties buries the four real ones we are
        actually in business to advertise, and it does it under a page that
        promises "datos verificados, sin informacion inventada". The listing
        copy has RISKY_CLAIMS to stop the model inflating a pool into a private
        pool; this is the same failure one level up, committed by the product
        itself rather than the model.

        So samples are now strictly a cold-start affordance: they appear only
        when an agency's inventory would otherwise be empty, and they carry a
        flag so the page can say what they are. */
  if (agencyListings.length) return agencyListings;
  return SAMPLES.map(sample => ({ ...sample, is_sample: true }));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60');

  try {
    /* ── City landing pages + sitemap ──────────────────────────────────────
       Their acquisition engine is one indexable page per city. Ours has to be
       server-rendered for the same reason the property page is: crawlers do
       not run JS, so a client-rendered grid indexes as an empty page.
       Both live in this handler because of the 12-function cap.
       ──────────────────────────────────────────────────────────────────── */
    if (req.query.format === 'sitemap') {
      const all = await getInventory();
      const base = `https://${req.headers['x-forwarded-host'] || req.headers.host || 'proplync.mx'}`;
      const towns = [...new Set(all.map(p => p.town).filter(Boolean))];
      const urls = [
        { loc: `${base}/`, pri: '1.0' },
        { loc: `${base}/search`, pri: '0.9' },
        ...towns.map(t => ({ loc: `${base}/propiedades-en-${slugify(t)}`, pri: '0.8' })),
        ...all.map(p => ({ loc: `${base}/property/${encodeURIComponent(p.public_id)}`, pri: '0.7' }))
      ];
      res.setHeader('content-type', 'application/xml; charset=utf-8');
      res.status(200).send(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        urls.map(u => `  <url><loc>${escXml(u.loc)}</loc><priority>${u.pri}</priority></url>`).join('\n') +
        `\n</urlset>\n`
      );
      return;
    }

    if (req.query.city) {
      const all = await getInventory();
      const wanted = slugify(req.query.city);
      const matches = all.filter(p => slugify(p.town) === wanted);
      const townName = matches.length ? matches[0].town : unslugify(req.query.city);
      const base = `https://${req.headers['x-forwarded-host'] || req.headers.host || 'proplync.mx'}`;
      const canonical = `${base}/propiedades-en-${wanted}`;

      if (req.query.format === 'page') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.status(200).send(renderCityPage(townName, wanted, matches, canonical));
        return;
      }
      res.status(200).json({ town: townName, listings: matches, total: matches.length });
      return;
    }

    /* ── Agency portfolio ──────────────────────────────────────────────────
       ?agency=<slug> returns one agency plus every published listing it owns,
       which is what /agencia/:slug and the "more from this agency" rail on a
       property page both render. Folded in here rather than added as
       api/agency.js because the project sits on Vercel Hobby's 12-function cap
       (see the same note in api/my-listings.js).
       ──────────────────────────────────────────────────────────────────── */
    if (req.query.agency) {
      const svc = getServiceClient();
      const { data: agency, error: agencyErr } = await svc
        .from('agencies')
        .select('id, name, slug, logo_url, primary_color, whatsapp_number')
        .eq('slug', String(req.query.agency).toLowerCase())
        .maybeSingle();
      if (agencyErr) {
        logDegraded('supabase:agencies.bySlug', agencyErr);
        res.status(503).json({ error: 'agency_lookup_unavailable' });
        return;
      }
      if (!agency) {
        res.status(404).json({ error: 'agency_not_found' });
        return;
      }
      const { data: rows, error: rowsErr } = await svc
        .from('listings')
        .select('*')
        .eq('agency_id', agency.id)
        .eq('status', 'published')
        .order('created_at', { ascending: false });
      if (rowsErr) {
        logDegraded('supabase:listings.byAgency', rowsErr);
        res.status(503).json({ error: 'agency_listings_unavailable' });
        return;
      }
      const owned = (rows || []).map(mapAgencyRow);
      // exclude lets a property page show "others from this agency"
      const exclude = req.query.exclude;
      res.status(200).json({
        agency: { name: agency.name, slug: agency.slug, logo_url: agency.logo_url,
                  primary_color: agency.primary_color, whatsapp_number: agency.whatsapp_number },
        listings: exclude ? owned.filter(p => p.public_id !== exclude) : owned,
        total: owned.length
      });
      return;
    }

    let listings = await getInventory();

    // filters
    const { op, town, minPrice, maxPrice, beds, minSize, maxSize, q } = req.query;

    if (op && op !== 'all') {
      listings = listings.filter(p => p.operation === op);
    }
    if (town) {
      // Folded, not just lowercased: the inventory spells it "Cancun" and a
      // buyer (or the AI filter) may spell it "Cancún". Lowercase alone made
      // those two different towns.
      const t = fold(town);
      listings = listings.filter(p => fold(p.town).includes(t));
    }
    if (minPrice) {
      const min = parseFloat(minPrice);
      if (Number.isFinite(min)) listings = listings.filter(p => p.amount >= min);
    }
    if (maxPrice) {
      const max = parseFloat(maxPrice);
      if (Number.isFinite(max)) listings = listings.filter(p => p.amount <= max);
    }
    if (beds) {
      const b = parseInt(beds);
      if (b > 0) listings = listings.filter(p => p.bedrooms >= b);
    }
    if (minSize) {
      const ms = parseFloat(minSize);
      if (Number.isFinite(ms)) listings = listings.filter(p => p.size >= ms);
    }
    if (maxSize) {
      const ms = parseFloat(maxSize);
      if (Number.isFinite(ms)) listings = listings.filter(p => p.size <= ms);
    }
    if (q) {
      const term = fold(q);
      listings = listings.filter(p =>
        fold(p.title_es + ' ' + p.title_en + ' ' + p.town + ' ' + p.neighborhood).includes(term)
      );
    }

    // extract unique towns for filter dropdown
    const allListings = await getInventory();
    const towns = [...new Set(allListings.map(p => p.town).filter(Boolean))].sort();

    res.status(200).json({ listings, towns, total: listings.length });
  } catch (err) {
    res.status(502).json({ error: 'search_unavailable', detail: safeDetail(err) });
  }
}
