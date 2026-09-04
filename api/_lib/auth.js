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

export async function requireAgencyUser(req) {
  const authz = req.headers.authorization || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : null;
  if (!token) return null;

  const svc = getServiceClient();
  const { data: { user }, error } = await svc.auth.getUser(token);
  if (error || !user) return null;

  const { data: member } = await svc
    .from('agency_members')
    .select('agency_id, role')
    .eq('user_id', user.id)
    .single();
  if (!member) return null;

  return { user, token, agencyId: member.agency_id, role: member.role };
}
