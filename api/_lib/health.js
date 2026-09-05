/**
 * Proplync.mx · Degraded-dependency reporting
 * -----------------------------------------------------------------------------
 * Every outage this codebase has hit was silent: Supabase went unreachable and
 * /api/property quietly served hardcoded sample listings, /api/search quietly
 * returned zero agency rows, and requireAgencyUser quietly 401'd every logged-in
 * agent (which reads to a user as "my password stopped working", not "the
 * database is down"). The site looked healthy the whole time.
 *
 * This module exists so a failing dependency leaves a trace that both a human
 * and a monitor can find:
 *   - console.error with a fixed, greppable prefix -> Vercel runtime logs
 *   - callers that keep serving degraded content mark the response `degraded`
 *     so an external health check can detect it without reading logs
 *
 * Deliberately not a metrics client: no deps, no network, safe on cold start.
 * -----------------------------------------------------------------------------
 */

export const DEGRADED_PREFIX = '[DEGRADED]';

/**
 * Record that a dependency failed. Never throws — reporting a failure must not
 * become a second failure.
 *
 * @param {string} scope  where it broke, e.g. 'supabase:listings.byPublicId'
 * @param {unknown} err   the error/PostgrestError that caused it
 */
export function logDegraded(scope, err) {
  try {
    const detail = err && (err.message || err.error_description || err.code)
      ? (err.message || err.error_description || err.code)
      : String(err);
    console.error(`${DEGRADED_PREFIX} ${scope}: ${detail}`);
  } catch {
    /* logging must never take a request down */
  }
}
