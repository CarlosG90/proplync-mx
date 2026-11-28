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
 * PREVIEW (/:slug?vista=1)
 * The owner sees the finished page, drafts included, before paying. The address
 * carries no secret, so a shared preview link is worthless: this answers with
 * an empty shell (state "preview_private": no name, no properties), and p.html
 * fetches the page itself from /api/panel?action=preview with the owner's own
 * session, which never leaves their browser. Anyone else sees "this preview is
 * private". A page that is already live redirects to its clean address.
 *
 * WHY NOT REUSE api/search.js ?agency=
 * That endpoint belongs to the PropLync project; calling it across projects would
 * tie this page's uptime and cache to the other deploy. The query is small and
 * the visibility rule is the same shared function.
 * -----------------------------------------------------------------------------
 */

import { readFileSync } from 'node:fs';
import { getServiceClient } from './_proplync/_lib/supabase.js';
import { pageActive } from './_proplync/_lib/plans.js';
import { AGENCY_FIELDS, LISTING_FIELDS, buildModel } from './_page-model.js';
import { PUBLIC_SERVICE_FIELDS } from './_services.js';
import { ASSET_FIELDS, missingTable } from './_assets.js';
import { typeFor } from './_business-types.js';

export { AGENCY_FIELDS, LISTING_FIELDS, buildModel };
import { logDegraded } from './_proplync/_lib/health.js';

const TEMPLATE = readFileSync(new URL('../p.html', import.meta.url), 'utf8');
const PROPLYNC_SITE = (process.env.PROPLYNC_SITE_URL || 'https://proplync-mx.vercel.app').replace(/\/$/, '');
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const PUBLIC_ID = /^[A-Za-z0-9_-]{1,40}$/;

const escAttr = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A <script type="application/json"> body that can't close its own tag or break JS parsers. */
export const jsonForScript = (v) => JSON.stringify(v)
  .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const money = (l) => (l && l.amount ? `${l.currency || 'MXN'} $${Number(l.amount).toLocaleString('en-US')}${l.operation === 'rental' ? ' /mes' : ''}` : '');
const firstPhoto = (l) => (l && (l.image || (Array.isArray(l.images) && l.images[0]))) || '';
const httpsOnly = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : '');

/** Fill the template: meta tags for link previews plus the model as JSON. Pure, for tests. */
export function renderPage(template, model, { origin = '', focus = null, service = null } = {}) {
  const a = model.agency || {};
  const list = model.listings || [];
  const pick = focus && list.find((l) => l.public_id === focus);
  // ?s=<service id>: a link to one service previews that service (name, price) on WhatsApp.
  const svcPick = !pick && service && (model.services || []).find((x) => x.id === service);
  let title, desc, image = '';
  if (model.state === 'not_found') {
    title = 'Página no encontrada · PropLync Mini';
    desc = 'Esta página no existe o cambió de dirección.';
  } else if (model.state === 'paused') {
    title = `${a.name} · PropLync Mini`;
    desc = 'Esta página no está disponible por ahora.';
  } else if (model.state === 'preview_private') {
    title = 'Vista previa privada · PropLync Mini';
    desc = 'Esta vista previa solo la ve el dueño de la página.';
  } else if (svcPick) {
    const price = svcPick.price_kind === 'quote' || svcPick.price == null ? 'Precio a cotizar'
      : `${svcPick.price_kind === 'from' ? 'Desde ' : ''}${svcPick.currency || 'MXN'} $${Number(svcPick.price).toLocaleString('en-US')}${svcPick.price_kind === 'per_m2' ? ' por m²' : ''}`;
    title = `${svcPick.title_es || svcPick.title_en} · ${a.name}`;
    desc = [price, (svcPick.description_es || '').slice(0, 140)].filter(Boolean).join(' · ');
    image = httpsOnly(svcPick.image) || httpsOnly(a.cover_url) || httpsOnly(a.logo_url);
  } else if (pick) {
    const where = [pick.neighborhood, pick.town].filter(Boolean).join(', ');
    title = `${pick.title_es || pick.title_en || 'Propiedad'} · ${a.name}`;
    desc = [money(pick), where, [pick.bedrooms ? pick.bedrooms + ' rec' : '', pick.size ? pick.size + ' m²' : ''].filter(Boolean).join(' · ')]
      .filter(Boolean).join(' · ');
    image = httpsOnly(firstPhoto(pick)) || httpsOnly(a.cover_url) || httpsOnly(a.logo_url);
  } else {
    const svcs = model.services || [];
    const towns = [...new Set(list.map((l) => l.town).filter(Boolean))].slice(0, 3).join(', ');
    const props = list.length ? `${list.length} ${list.length === 1 ? 'propiedad' : 'propiedades'}${towns ? ' en ' + towns : ''}` : '';
    // A services page is titled by what it offers, never "0 propiedades".
    const offer = svcs.slice(0, 3).map((x) => x.title_es || x.title_en).filter(Boolean).join(', ');
    title = `${a.name} · ${svcs.length ? typeFor(a.business_type).eyebrow[0] : 'Propiedades'}`;
    desc = [offer, props].filter(Boolean).join(' · ') + '. ' +
      (a.bio ? a.bio.slice(0, 140) : 'Escríbeme por WhatsApp para más información.');
    const firstImg = (model.assets || []).find((x) => x.kind === 'image');
    image = httpsOnly(a.cover_url) || httpsOnly(firstPhoto(list[0])) || httpsOnly(svcs[0] && svcs[0].image) ||
      httpsOnly(firstImg && firstImg.url) || httpsOnly(a.logo_url);
  }
  const canonical = model.state === 'active' && a.slug
    ? `${origin}/${a.slug}${pick ? '?p=' + encodeURIComponent(pick.public_id) : svcPick ? '?s=' + encodeURIComponent(svcPick.id) : ''}` : '';
  const meta = [
    `<meta name="description" content="${escAttr(desc)}">`,
    `<meta property="og:title" content="${escAttr(title)}">`,
    `<meta property="og:description" content="${escAttr(desc)}">`,
    `<meta property="og:type" content="website">`,
    canonical ? `<meta property="og:url" content="${escAttr(canonical)}"><link rel="canonical" href="${escAttr(canonical)}">` : '',
    image ? `<meta property="og:image" content="${escAttr(image)}"><meta name="twitter:card" content="summary_large_image">` : '',
    model.state === 'active' ? '' : '<meta name="robots" content="noindex">',
  ].filter(Boolean).join('\n');
  const tokens = { '__TITLE__': escAttr(title), '__META__': meta, '__DATA__': jsonForScript({ ...model, focus: pick ? pick.public_id : null }) };
  return template.replace(/__TITLE__|__META__|__DATA__/g, (k) => tokens[k]);
}

export default async function handler(req, res, deps = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const slug = String((req.query && req.query.slug) || '').toLowerCase();
  const focus = PUBLIC_ID.test(String(req.query && req.query.p || '')) ? String(req.query.p) : null;
  const service = /^[0-9a-f-]{36}$/i.test(String(req.query && req.query.s || '')) ? String(req.query.s) : null;
  const vista = !!(req.query && req.query.vista !== undefined);
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const origin = host ? `https://${host}` : '';
  const send = (status, model, cache) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', cache);
    res.status(status).send(renderPage(TEMPLATE, model, { origin, focus, service }));
  };

  if (!SLUG.test(slug)) { send(404, { state: 'not_found' }, 'no-store'); return; }
  try {
    const svc = (deps.getServiceClient || getServiceClient)();
    const { data: agency, error } = await svc.from('agencies').select(AGENCY_FIELDS).eq('slug', slug).maybeSingle();
    if (error) throw error;
    if (!agency) { send(404, { state: 'not_found' }, 'no-store'); return; }
    if (String(agency.plan || '').toLowerCase() !== 'mini') {
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, `${PROPLYNC_SITE}/agencia/${encodeURIComponent(slug)}`);
      return;
    }
    const active = pageActive(agency);
    if (vista && active) {
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, `/${encodeURIComponent(slug)}${focus ? '?p=' + encodeURIComponent(focus) : ''}`);
      return;
    }
    // The preview's content comes from the owner's session in the browser, never from this response.
    if (vista) { send(200, { state: 'preview_private', agency: { slug: agency.slug } }, 'no-store'); return; }
    let listings = [], services = [], assets = [];
    if (active) {
      const [l, s, a] = await Promise.all([
        svc.from('listings').select(LISTING_FIELDS)
          .eq('agency_id', agency.id).eq('status', 'published').order('created_at', { ascending: false }).limit(30),
        svc.from('mini_services').select(PUBLIC_SERVICE_FIELDS)
          .eq('agency_id', agency.id).eq('status', 'published').order('sort', { ascending: true }).limit(40),
        svc.from('mini_assets').select(ASSET_FIELDS)
          .eq('agency_id', agency.id).order('sort', { ascending: true }).limit(40)
      ]);
      if (l.error) throw l.error;
      if (s.error) throw s.error;
      if (a.error && !missingTable(a.error)) throw a.error;
      if (a.error) logDegraded('mini:page-assets', a.error);
      assets = a.error ? [] : a.data || [];
      listings = l.data || [];
      services = s.data || [];
    }
    const model = buildModel(agency, listings, Date.now(), { services, assets });
    // A live page can sit in the CDN for a minute; a hidden one never, so payment shows at once.
    send(200, model, model.state === 'active' ? 'public, max-age=0, s-maxage=60, stale-while-revalidate=300' : 'no-store');
  } catch (err) {
    logDegraded('mini:page', err);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(503).send(renderPage(TEMPLATE, { state: 'not_found' }, { origin }).replace('Página no encontrada', 'Página no disponible por un momento'));
  }
}
