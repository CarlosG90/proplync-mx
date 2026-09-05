/**
 * Proplync.mx · Fixed-window rate limiting
 * -----------------------------------------------------------------------------
 * /api/generate, /api/describe and /api/nlsearch are public and unauthenticated,
 * and each one spends Groq tokens. A single click of the dashboard's AI Assist
 * fires two generations, and that alone was enough to trip Groq's free-tier
 * 8k-tokens/minute ceiling during testing — so an unthrottled public endpoint
 * is a standing invitation to burn the quota (or the bill, once it is paid).
 * /api/onboard and /api/leads are cheap but spammable: free account creation
 * and an inbox anyone can flood.
 *
 * Implementation notes
 *   - INCR + EXPIRE(NX) in one Upstash pipeline call, so the counter is atomic.
 *     A get-then-set limiter would race under exactly the burst it exists to stop.
 *   - Fixed window, not sliding: one Redis round trip, and the imprecision at
 *     window edges does not matter for abuse control.
 *   - FAILS OPEN. If Redis is unreachable the request is allowed and the outage
 *     is reported via logDegraded. Losing the cache should not take listing
 *     creation down with it — but it must not be silent either.
 * -----------------------------------------------------------------------------
 */

import { logDegraded } from './health.js';

/** Best-effort client identity. x-forwarded-for is a comma-separated chain; the
    first entry is the original client as seen by Vercel's edge. */
export function clientKey(req) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(fwd) ? fwd[0] : String(fwd || ''))
    .split(',')[0]
    .trim();
  return ip || req.headers['x-real-ip'] || 'unknown';
}

/**
 * Consume one unit from a fixed window.
 *
 * @param {object} req
 * @param {object} opts
 * @param {string} opts.bucket     namespace, e.g. 'generate'
 * @param {number} opts.limit      max requests per window
 * @param {number} opts.windowSec  window length in seconds
 * @returns {Promise<{allowed:boolean, remaining:number, limit:number, resetSec:number}>}
 */
export async function rateLimit(req, { bucket, limit, windowSec }) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  const allow = (remaining) => ({ allowed: true, remaining, limit, resetSec: windowSec });

  // Not configured (e.g. local dev without Upstash) — don't block development.
  if (!url || !token) return allow(limit);

  const window = Math.floor(Date.now() / 1000 / windowSec);
  const key = `rl:${bucket}:${clientKey(req)}:${window}`;

  try {
    const r = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      // EXPIRE ... NX sets the TTL only on the first hit of the window, so a
      // burst can't keep pushing the expiry out and extend its own window.
      body: JSON.stringify([['INCR', key], ['EXPIRE', key, String(windowSec), 'NX']])
    });
    if (!r.ok) throw new Error(`Upstash responded ${r.status}`);
    const out = await r.json();
    const count = Number(out?.[0]?.result);
    if (!Number.isFinite(count)) throw new Error('unexpected pipeline response');

    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      limit,
      resetSec: windowSec
    };
  } catch (err) {
    logDegraded('ratelimit:upstash', err);
    return allow(limit); // fail open
  }
}

/**
 * Apply a limit and, when exceeded, write the 429 response.
 *
 * @returns {Promise<boolean>} true if the caller should stop handling the request
 */
export async function enforceRateLimit(req, res, opts) {
  const { allowed, remaining, limit, resetSec } = await rateLimit(req, opts);
  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  if (allowed) return false;

  res.setHeader('Retry-After', String(resetSec));
  res.status(429).json({
    error: 'rate_limited',
    detail: `Too many requests. Try again in up to ${resetSec}s.`
  });
  return true;
}
