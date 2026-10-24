-- 015 · Supabase security-advisor fixes
-- Source: the security advisor run on 2026-10-24 (function_search_path_mutable, *_security_definer_function_executable).
--
-- 1. get_my_agency_id(): pin its search_path. It is SECURITY DEFINER and read by 17 row-security policies
--    (agencies, listings, leads, lead_notes, and the listing-photos / listing-originals storage buckets).
--    EXECUTE stays open to anon on purpose: those policies are evaluated with the caller's rights, so revoking
--    it would make every public listing and photo read fail with "permission denied for function". It only ever
--    returns the caller's own agency id (null when logged out), so exposing it as an RPC leaks nothing.
-- 2. lead_notes_set_agency(): a trigger function. Postgres checks EXECUTE when a trigger is created, not when it
--    fires, so nobody needs the right. Closing it removes the useless /rest/v1/rpc/lead_notes_set_agency door.
--
-- Not fixable from SQL: "Leaked password protection" is an Auth setting (Dashboard -> Authentication ->
-- Providers -> Email -> enable "Prevent use of leaked passwords"; it needs the Pro plan).
-- Idempotent: safe to run twice.

alter function public.get_my_agency_id() set search_path = public, pg_temp;

revoke execute on function public.lead_notes_set_agency() from public, anon, authenticated;
