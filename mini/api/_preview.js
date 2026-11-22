/**
 * PropLync Mini · preview links for an unpublished page
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * A customer should see their page finished, exactly as buyers will, before we
 * ask them to pay. The public route (/:slug) hides an unpaid page, so the panel
 * asks for a short-lived signed link (/:slug?vista=<token>) and page.js shows the
 * page in "preview" mode when the token is valid for that agency.
 *
 * WHY A SIGNED LINK, NOT THE SESSION TOKEN OR AN IFRAME
 * The session lives in the browser's storage, which a normal page navigation
 * can't send, and a Supabase JWT must never sit in a URL. An iframe of the page
 * inside the panel breaks history, link building and the phone layout. A signed
 * {agency, expiry} token opens the real page at its real address, grants only a
 * view of that page's drafts, and dies after PREVIEW_TTL_SEC.
 *
 * The key is MINI_PREVIEW_SECRET, or else derived from the service-role key the
 * project already has, so no new secret is required to ship.
 * -----------------------------------------------------------------------------
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const PREVIEW_TTL_SEC = 60 * 60;

function key(env = process.env) {
  const base = env.MINI_PREVIEW_SECRET || env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!base) return null;
  return createHmac('sha256', base).update('proplync-mini:preview:v1').digest();
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const sign = (k, body) => b64(createHmac('sha256', k).update(body).digest());

/** A token for one agency's preview, or null when no key is configured. */
export function makePreviewToken(agencyId, { now = Date.now(), env } = {}) {
  const k = key(env);
  if (!k || !agencyId) return null;
  const body = b64(JSON.stringify({ a: String(agencyId), e: Math.floor(now / 1000) + PREVIEW_TTL_SEC }));
  return `${body}.${sign(k, body)}`;
}

/** The agency id a token grants, or null when it is malformed, forged or expired. */
export function readPreviewToken(token, { now = Date.now(), env } = {}) {
  const k = key(env);
  if (!k || typeof token !== 'string' || token.length > 400) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(sign(k, body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!p || typeof p.a !== 'string' || typeof p.e !== 'number') return null;
  if (p.e * 1000 < now) return null;
  return p.a;
}
