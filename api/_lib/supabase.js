/**
 * Proplync.mx · Supabase client factories
 * -----------------------------------------------------------------------------
 * getServiceClient() — service-role key, bypasses RLS. Only for trusted
 * server-side operations: onboarding (before RLS would allow a row to
 * exist), and public lead capture (deriving agency_id from a listing
 * server-side, never trusting a client-supplied value).
 *
 * getUserClient(token) — anon key + the caller's own access token, so every
 * query runs AS that user and RLS enforces tenant isolation automatically.
 * Prefer this for anything an authenticated agent does to their own data.
 * -----------------------------------------------------------------------------
 */

import { createClient } from '@supabase/supabase-js';

export function getServiceClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

export function getUserClient(accessToken) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } }
  });
}
