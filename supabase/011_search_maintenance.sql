-- Proplync.mx · Search index upkeep: price ranges and stale listings
-- Run once, after 010_search_index.sql. Idempotent.
--
-- Two jobs the crawler (api/_lib/search/index-writer.js) asks the database to
-- do, because they are set operations Postgres does in one statement and the
-- client would do in thousands of round trips.

/* A property's price range is the span of its active offers, in MXN. Called
   for every property a crawl run touched. */
create or replace function public.search_refresh_prices(p_ids uuid[])
returns integer
language sql
set search_path = public
as $$
  with ranges as (
    select property_id, min(price_mxn) as lo, max(price_mxn) as hi
    from search_offers
    where status = 'active' and property_id = any(p_ids)
    group by property_id
  ), changed as (
    update search_properties sp
    set price_mxn_min = r.lo, price_mxn_max = r.hi, updated_at = now()
    from ranges r
    where sp.id = r.property_id
      and (sp.price_mxn_min is distinct from r.lo or sp.price_mxn_max is distinct from r.hi)
    returning 1
  )
  select count(*)::int from changed
$$;

/* An ad a source stopped showing has most likely sold or expired. Offers from
   p_source not seen since p_cutoff go inactive; a crawled property with no
   active offer left goes inactive with them. Our own listings are managed by
   the PropLync sync, never here. */
create or replace function public.search_mark_stale(p_source text, p_cutoff timestamptz)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_offers int;
  v_props int;
begin
  update search_offers set status = 'inactive'
  where source_id = p_source and status = 'active' and last_seen_at < p_cutoff;
  get diagnostics v_offers = row_count;

  update search_properties sp set status = 'inactive', updated_at = now()
  where sp.origin = 'web' and sp.status = 'active'
    and not exists (select 1 from search_offers o where o.property_id = sp.id and o.status = 'active');
  get diagnostics v_props = row_count;

  return jsonb_build_object('offers_inactivated', v_offers, 'properties_inactivated', v_props);
end;
$$;

revoke all on function public.search_refresh_prices(uuid[]) from public, anon, authenticated;
revoke all on function public.search_mark_stale(text, timestamptz) from public, anon, authenticated;
grant execute on function public.search_refresh_prices(uuid[]) to service_role;
grant execute on function public.search_mark_stale(text, timestamptz) to service_role;
