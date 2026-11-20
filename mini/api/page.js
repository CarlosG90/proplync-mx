/**
 * PropLync Mini · the customer's public page (/:slug)
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * The page the agent shares is the product. It is rendered on the server so the
 * link previews on WhatsApp and Facebook (which don't run JavaScript) show the
 * agent's name, how many properties they have and a photo. A link to one
 * property (/:slug?p=<public_id>) previews that property.
 *
 * WHAT IS PUBLIC
 * Only a paid Mini page (plans.js pageActive) shows its published properties and
 * contact buttons. An unpaid or lapsed page answers with the agent's name and a
 * "not available" note, never cached, so activation shows at once. Agencies on
 * PropLync plans are sent to their PropLync page.
 *
 * WHY NOT REUSE api/search.js ?agency=
 * That endpoint belongs to the PropLync project; calling it across projects would
 * tie this page's uptime and cache to the other deploy. The query is small and
 * the visibility rule is the same shared function.
 * -----------------------------------------------------------------------------
 */

import { readFileSync } from 'node:fs';
import { getServiceClient } from '../../api/_lib/supabase.js';
import { pageActive } from '../../api/_lib/plans.js';
import { logDegraded } from '../../api/_lib/health.js';

const TEMPLATE = readFileSync(new URL('../p.html', import.meta.url), 'utf8');
const PROPLYNC_SITE = (process.env.PROPLYNC_SITE_URL || 'https://proplync-mx.vercel.app').replace(/\/$/, '');
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const PUBLIC_ID = /^[A-Za-z0-9_-]{1,40}$/;

export const AGENCY_FIELDS = 'id, name, slug, logo_url, cover_url, primary_color, whatsapp_number, phone, ' +
  'public_email, address, maps_url, services, bio, plan, plan_expires_at';
export const LISTING_FIELDS = 'public_id, title_es, title_en, town, neighborhood, bedrooms, bathrooms, size, ' +
  'parking, operation, currency, amount, image, images, features, description_es, description_en, property_type';

const escAttr = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A <script type="application/json"> body that can't close its own tag or break JS parsers. */
export const jsonForScript = (v) => JSON.stringify(v)
  .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const money = (l) => (l && l.amount ? `${l.currency || 'MXN'} $${Number(l.amount).toLocaleString('en-US')}${l.operation === 'rental' ? ' /mes' : ''}` : '');
const firstPhoto = (l) => (l && (l.image || (Array.isArray(l.images) && l.images[0]))) || '';
const httpsOnly = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : '');

/** What the page shows, from the rows. Internal columns never reach the browser. Pure, for tests. */
export function buildModel(agency, listings, now = Date.now()) {
  if (!agency) return { state: 'not_found' };
  const active = pageActive(agency, now);
  const card = {
    name: agency.name || '', slug: agency.slug,
    logo_url: agency.logo_url || null, cover_url: agency.cover_url || null, primary_color: agency.primary_color || null
  };
  if (!active) return { state: 'paused', agency: card, listings: [] };
  return {
    state: 'active',
    agency: {
      ...card,
      whatsapp_number: agency.whatsapp_number || null, phone: agency.phone || null,
      public_email: agency.public_email || null, address: agency.address || null, maps_url: agency.maps_url || null,
      services: Array.isArray(agency.services) ? agency.services : [], bio: agency.bio || ''
    },
    listings: (listings || []).map((l) => ({ ...l }))
  };
}

/** Fill the template: meta tags for link previews plus the model as JSON. Pure, for tests. */
export function renderPage(template, model, { origin = '', focus = null } = {}) {
  const a = model.agency || {};
  const list = model.listings || [];
  const pick = focus && list.find((l) => l.public_id === focus);
  let title, desc, image = '';
  if (model.state === 'not_found') {
    title = 'Página no encontrada · PropLync Mini';
    desc = 'Esta página no existe o cambió de dirección.';
  } else if (model.state === 'paused') {
    title = `${a.name} · PropLync Mini`;
    desc = 'Esta página no está disponible por ahora.';
  } else if (pick) {
    const where = [pick.neighborhood, pick.town].filter(Boolean).join(', ');
    title = `${pick.title_es || pick.title_en || 'Propiedad'} · ${a.name}`;
    desc = [money(pick), where, [pick.bedrooms ? pick.bedrooms + ' rec' : '', pick.size ? pick.size + ' m²' : ''].filter(Boolean).join(' · ')]
      .filter(Boolean).join(' · ');
    image = httpsOnly(firstPhoto(pick)) || httpsOnly(a.cover_url) || httpsOnly(a.logo_url);
  } else {
    const towns = [...new Set(list.map((l) => l.town).filter(Boolean))].slice(0, 3).join(', ');
    title = `${a.name} · Propiedades`;
    desc = `${list.length} ${list.length === 1 ? 'propiedad' : 'propiedades'}${towns ? ' en ' + towns : ''}. ` +
      (a.bio ? a.bio.slice(0, 140) : 'Escríbeme por WhatsApp para más información.');
    image = httpsOnly(a.cover_url) || httpsOnly(firstPhoto(list[0])) || httpsOnly(a.logo_url);
  }
  const canonical = model.state === 'active' && a.slug ? `${origin}/${a.slug}${pick ? '?p=' + encodeURIComponent(pick.public_id) : ''}` : '';
  const meta = [
    `<meta name="description" content="${escAttr(desc)}">`,
    `<meta property="og:title" content="${escAttr(title)}">`,
    `<meta property="og:description" content="${escAttr(desc)}">`,
    `<meta property="og:type" content="website">`,
    canonical ? `<meta property="og:url" content="${escAttr(canonical)}"><link rel="canonical" href="${escAttr(canonical)}">` : '',
    image ? `<meta property="og:image" content="${escAttr(image)}"><meta name="twitter:card" content="summary_large_image">` : '',
    model.state === 'active' ? '' : '<meta name="robots" content="noindex">'
  ].filter(Boolean).join('\n');
  const tokens = { '__TITLE__': escAttr(title), '__META__': meta, '__DATA__': jsonForScript({ ...model, focus: pick ? pick.public_id : null }) };
  return template.replace(/__TITLE__|__META__|__DATA__/g, (k) => tokens[k]);
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const slug = String((req.query && req.query.slug) || '').toLowerCase();
  const focus = PUBLIC_ID.test(String(req.query && req.query.p || '')) ? String(req.query.p) : null;
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const origin = host ? `https://${host}` : '';
  const send = (status, model, cache) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', cache);
    res.status(status).send(renderPage(TEMPLATE, model, { origin, focus }));
  };

  if (!SLUG.test(slug)) { send(404, { state: 'not_found' }, 'no-store'); return; }
  try {
    const svc = getServiceClient();
    const { data: agency, error } = await svc.from('agencies').select(AGENCY_FIELDS).eq('slug', slug).maybeSingle();
    if (error) throw error;
    if (!agency) { send(404, { state: 'not_found' }, 'no-store'); return; }
    if (String(agency.plan || '').toLowerCase() !== 'mini') {
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, `${PROPLYNC_SITE}/agencia/${encodeURIComponent(slug)}`);
      return;
    }
    let listings = [];
    if (pageActive(agency)) {
      const { data, error: lErr } = await svc.from('listings').select(LISTING_FIELDS)
        .eq('agency_id', agency.id).eq('status', 'published').order('created_at', { ascending: false }).limit(30);
      if (lErr) throw lErr;
      listings = data || [];
    }
    const model = buildModel(agency, listings);
    // A live page can sit in the CDN for a minute; a hidden one never, so payment shows at once.
    send(200, model, model.state === 'active' ? 'public, max-age=0, s-maxage=60, stale-while-revalidate=300' : 'no-store');
  } catch (err) {
    logDegraded('mini:page', err);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(503).send(renderPage(TEMPLATE, { state: 'not_found' }, { origin }).replace('Página no encontrada', 'Página no disponible por un momento'));
  }
}
