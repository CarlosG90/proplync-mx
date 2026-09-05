/**
 * Proplync.mx · Agency-auth guard
 * -----------------------------------------------------------------------------
 * requireAgencyUser(req) reads the Authorization: Bearer <token> header,
 * validates it against Supabase Auth, and looks up the caller's agency
 * membership. Returns null on any failure — callers respond 401.
 *
 * No JWT library, no middleware framework: supabase.auth.getUser(token)
 * validates the token directly against Supabase Auth's servers.
 * -----------------------------------------------------------------------------
 */

import { getServiceClient } from './supabase.js';
import { logDegraded } from './health.js';

export async function requireAgencyUser(req) {
  const authz = req.headers.authorization || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : null;
  if (!token) return null;

  const svc = getServiceClient();

  // An unreachable Supabase and a genuinely bad token both end up returning
  // null here, and the caller turns both into 401 — which a signed-in agent
  // experiences as "my login stopped working" with nothing in the logs. Keep
  // the 401 (the request truly can't be authorized), but say which it was.
  let user;
  try {
    const { data, error } = await svc.auth.getUser(token);
    if (error) {
      // Auth rejects bad/expired tokens with a 401/403 status; anything else
      // (or no status at all) means Auth itself is unhealthy.
      if (!error.status || error.status >= 500) logDegraded('supabase:auth.getUser', error);
      return null;
    }
    user = data && data.user;
  } catch (err) {
    logDegraded('supabase:auth.getUser', err);
    return null;
  }
  if (!user) return null;

  try {
    const { data: member, error: memberError } = await svc
      .from('agency_members')
      .select('agency_id, role')
      .eq('user_id', user.id)
      .single();
    // .single() errors with PGRST116 when there's simply no membership row —
    // that's a legitimate "not an agency user", not an outage.
    if (memberError && memberError.code !== 'PGRST116') {
      logDegraded('supabase:agency_members.byUser', memberError);
      return null;
    }
    if (!member) return null;
    return { user, token, agencyId: member.agency_id, role: member.role };
  } catch (err) {
    logDegraded('supabase:agency_members.byUser', err);
    return null;
  }
}
