-- Proplync.mx · Search index: one card per real property, from every source
-- Run once, after 009_finder_briefs_scout.sql. Idempotent: safe to re-run.
--
-- WHY THIS EXISTS
-- Search used to load every listing into a function's memory and filter it
-- with substring matches: no ranking, no amenities, USD and MXN compared as
-- one number. It also only ever saw our own agencies' listings. This index is
-- what search reads instead: our listings plus everything the crawler brings
-- in from the portals (ingest/run.mjs), deduplicated into one row per real
-- property with every advertised price kept as its own offer.
--
-- THE SWITCHES
-- search_sources and search_markets are the controls. A source can be turned
-- off or dropped to a safer display mode (facts and a link, facts only,
-- hidden) with one UPDATE, no deploy. A market is switched on the same way.
--
-- WHO CAN READ THIS
-- RLS on, no policies: only the service role, through api/search.js. The
-- crawled offers carry the listing agent's published contact, which the
-- Finder operator uses to verify a property; it never goes to the browser.

create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;
create extension if not exists vector with schema extensions;
create extension if not exists postgis with schema extensions;

/* unaccent() is STABLE, so it cannot feed a generated column. Pinning the
   dictionary makes the result depend on the input alone. */
create or replace function public.f_unaccent(text)
returns text language sql immutable parallel safe strict
set search_path = ''
as $$ select extensions.unaccent('extensions.unaccent'::regdictionary, $1) $$;

/* ── Registries ── */

create table if not exists search_markets (
  id text primary key,                 -- 'riviera-maya'
  name text not null,
  state text not null,
  towns text[] not null default '{}',  -- what a place name in a query resolves to
  min_lng double precision, min_lat double precision,
  max_lng double precision, max_lat double precision,
  enabled boolean not null default false,
  refresh_hours integer not null default 24,
  created_at timestamptz not null default now()
);

create table if not exists search_sources (
  id text primary key,                 -- 'inmuebles24'
  name text not null,                  -- shown on the card: "encontrado en Inmuebles24"
  runner text not null check (runner in ('internal','apify','self','feed')),
  enabled boolean not null default false,
  --  full       : the whole card (facts, photos, description, every price)
  --  facts_link : facts, one photo, and a link to the source
  --  facts_only : price, place, size, bedrooms; no photos, no description
  --  hidden     : kept in the index, never shown
  display_mode text not null default 'full'
    check (display_mode in ('full','facts_link','facts_only','hidden')),
  max_results_per_run integer not null default 500,
  monthly_budget_usd numeric(10,2) not null default 0,
  config jsonb not null default '{}'::jsonb,   -- actor id, search URLs per market
  spent_month text,                            -- 'YYYY-MM' the spend below belongs to
  spent_usd numeric(10,4) not null default 0,
  last_run_at timestamptz,
  last_run_status text,
  last_run_stats jsonb,
  created_at timestamptz not null default now()
);

/* ── The index ── */

create table if not exists search_properties (
  id uuid primary key default gen_random_uuid(),
  -- 'proplync' rows mirror our agencies' listings (listing_public_id set);
  -- 'web' rows were assembled from crawled offers.
  origin text not null check (origin in ('proplync','web')),
  listing_public_id text unique,
  market_id text references search_markets(id),

  title text,
  operation text check (operation in ('sale','rental')),
  property_type text,
  town text,
  neighborhood text,
  bedrooms numeric,
  bathrooms numeric,
  parking numeric,
  built_m2 numeric,
  land_m2 numeric,

  -- Every offer converted to MXN, for filtering and sorting only. The card
  -- shows each offer's own price and currency.
  price_mxn_min numeric,
  price_mxn_max numeric,

  description text,                 -- trimmed; the source keeps the full text
  amenities text[] not null default '{}',   -- normalized tags: pool, ocean_view, ...
  photos text[] not null default '{}',      -- links to the source, never copies

  lat double precision,
  lng double precision,
  geog extensions.geography(Point, 4326) generated always as (
    case when lat is not null and lng is not null
      then extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography end
  ) stored,

  tsv tsvector generated always as (
    setweight(to_tsvector('simple', public.f_unaccent(
      coalesce(title, '') || ' ' || coalesce(neighborhood, '') || ' ' || coalesce(town, '') || ' ' || coalesce(property_type, ''))), 'A') ||
    -- amenities are matched through their own GIN index, not the text:
    -- array_to_string() is only STABLE and cannot feed a generated column
    setweight(to_tsvector('spanish', public.f_unaccent(coalesce(description, ''))), 'B')
  ) stored,

  embedding extensions.halfvec(384),     -- gte-small, from the `embed` edge function
  embedding_hash text,                   -- of the text embedded; re-embed when it changes

  verified boolean not null default false,
  status text not null default 'active' check (status in ('active','inactive')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists search_properties_filter_idx
  on search_properties (status, market_id, operation, price_mxn_min);
create index if not exists search_properties_tsv_idx on search_properties using gin (tsv);
create index if not exists search_properties_amenities_idx on search_properties using gin (amenities);
create index if not exists search_properties_geog_idx on search_properties using gist (geog);
create index if not exists search_properties_town_trgm_idx
  on search_properties using gin (public.f_unaccent(lower(coalesce(town, '') || ' ' || coalesce(neighborhood, ''))) extensions.gin_trgm_ops);
create index if not exists search_properties_embedding_idx
  on search_properties using hnsw (embedding extensions.halfvec_cosine_ops);

create table if not exists search_offers (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references search_properties(id) on delete cascade,
  source_id text not null references search_sources(id),
  url text not null,
  url_key text not null unique,          -- normalizeUrl(url): one row per ad
  external_id text,
  raw_title text,
  price numeric,
  currency text,
  price_mxn numeric,
  listed_by text,
  -- The listing agent's contact as the ad publishes it. Internal: the Finder
  -- operator uses it to verify; api/search.js never returns it.
  contact jsonb,
  price_history jsonb not null default '[]'::jsonb,   -- [{price, currency, at}]
  status text not null default 'active' check (status in ('active','inactive')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists search_offers_property_idx on search_offers (property_id, status);
create index if not exists search_offers_source_seen_idx on search_offers (source_id, last_seen_at);

/* What buyers search for. No IP, no free text, nothing that identifies a person. */
create table if not exists search_queries (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  market_id text,
  filters jsonb not null default '{}'::jsonb,
  prefs jsonb not null default '{}'::jsonb,
  result_count integer not null default 0,
  sort text,
  via text check (via in ('nl','filters','map','facet'))
);
create index if not exists search_queries_created_idx on search_queries (created_at desc);

create table if not exists geocode_cache (
  key text primary key,
  lat double precision,
  lng double precision,
  created_at timestamptz not null default now()
);

create table if not exists places (
  id bigserial primary key,
  market_id text references search_markets(id),
  kind text not null check (kind in ('beach','landmark','neighborhood')),
  name text not null,
  geog extensions.geography(Point, 4326) not null
);
create index if not exists places_geog_idx on places using gist (geog);

alter table search_markets enable row level security;
alter table search_sources enable row level security;
alter table search_properties enable row level security;
alter table search_offers enable row level security;
alter table search_queries enable row level security;
alter table geocode_cache enable row level security;
alter table places enable row level security;

/* ── Seed: markets (phased: Riviera Maya + Yucatán on first) and sources ── */

insert into search_markets (id, name, state, towns, min_lng, min_lat, max_lng, max_lat, enabled) values
  ('riviera-maya', 'Riviera Maya', 'Quintana Roo',
   array['Cancún','Playa del Carmen','Tulum','Puerto Morelos','Akumal','Puerto Aventuras','Bacalar','Holbox','Isla Mujeres','Cozumel','Chetumal','Riviera Maya'],
   -88.3, 18.0, -86.7, 21.7, true),
  ('yucatan', 'Yucatán', 'Yucatán',
   array['Mérida','Progreso','Valladolid','Telchac','Chicxulub','Izamal'],
   -90.5, 19.5, -87.5, 21.7, true),
  ('cdmx', 'Ciudad de México', 'CDMX', array['Ciudad de México','CDMX'], -99.4, 19.0, -98.9, 19.6, false),
  ('guadalajara', 'Guadalajara', 'Jalisco', array['Guadalajara','Zapopan','Tlaquepaque'], -103.6, 20.4, -103.1, 20.9, false),
  ('monterrey', 'Monterrey', 'Nuevo León', array['Monterrey','San Pedro Garza García','San Nicolás'], -100.6, 25.5, -100.1, 25.9, false),
  ('puerto-vallarta', 'Puerto Vallarta', 'Jalisco', array['Puerto Vallarta','Nuevo Vallarta','Bucerías','Sayulita'], -105.6, 20.5, -105.1, 21.0, false)
on conflict (id) do nothing;

insert into search_sources (id, name, runner, enabled, display_mode, max_results_per_run, monthly_budget_usd) values
  ('proplync', 'PropLync', 'internal', true, 'full', 10000, 0),
  ('inmuebles24', 'Inmuebles24', 'apify', false, 'full', 1500, 20),
  ('lamudi', 'Lamudi', 'apify', false, 'full', 1500, 10),
  ('vivanuncios', 'Vivanuncios', 'apify', false, 'full', 1500, 10),
  ('mercadolibre', 'Mercado Libre', 'apify', false, 'full', 1500, 10),
  ('easybroker_feed', 'EasyBroker (agencia)', 'feed', false, 'full', 10000, 0)
on conflict (id) do nothing;

/* ── Ranking ──
   One call returns a page of cards with a score and the reasons behind it.
   Hard filters are WHERE clauses; everything the buyer "would like" (amenities
   they prefer, words that describe the place, being near something) only
   moves a property up or down. Weights are kept here, in one place, and only
   change with the relevance test set (see test/search-*.test.mjs). */
create or replace function public.search_properties_v1(p jsonb)
returns jsonb
language plpgsql stable
set search_path = public, extensions
as $$
declare
  v_limit int := least(greatest(coalesce((p->>'limit')::int, 24), 1), 60);
  v_offset int := greatest(coalesce((p->>'offset')::int, 0), 0);
  v_q text := nullif(trim(coalesce(p->>'q', '')), '');
  v_tsq tsquery;
  v_emb halfvec(384);
  v_pref text[] := coalesce(array(select jsonb_array_elements_text(p->'amenities_preferred')), '{}');
  v_req  text[] := coalesce(array(select jsonb_array_elements_text(p->'amenities_required')), '{}');
  v_towns text[] := coalesce(array(select public.f_unaccent(lower(x)) from jsonb_array_elements_text(p->'towns') x), '{}');
  v_near geography;
  v_max numeric := (p->>'price_max_mxn')::numeric;
  v_result jsonb;
begin
  /* Words boost, they do not gate: any word that matches raises the score,
     so "depa de 2 recamaras cerca de la playa" is not an empty page just
     because one listing never says "depa". q_mode=all restores strict AND. */
  if v_q is not null then
    v_tsq := plainto_tsquery('spanish', public.f_unaccent(v_q)) || plainto_tsquery('simple', public.f_unaccent(v_q));
    if p->>'q_mode' is distinct from 'all' then
      v_tsq := nullif(replace(v_tsq::text, ' & ', ' | '), '')::tsquery;
    end if;
    if v_tsq is not null and numnode(v_tsq) = 0 then v_tsq := null; end if;
  end if;
  if p ? 'embedding' and jsonb_typeof(p->'embedding') = 'array' then
    v_emb := (p->>'embedding')::halfvec(384);
  end if;
  if p ? 'near' then
    v_near := st_setsrid(st_makepoint((p->'near'->>'lng')::float8, (p->'near'->>'lat')::float8), 4326)::geography;
  end if;

  with visible_offers as (
    select o.property_id,
           jsonb_agg(jsonb_build_object(
             'source', s.id, 'source_name', s.name, 'display_mode', s.display_mode,
             'url', o.url, 'price', o.price, 'currency', o.currency, 'price_mxn', o.price_mxn,
             'listed_by', o.listed_by, 'last_seen_at', o.last_seen_at
           ) order by o.price_mxn nulls last) as offers,
           min(case s.display_mode when 'full' then 1 when 'facts_link' then 2 else 3 end) as best_mode
    from search_offers o
    join search_sources s on s.id = o.source_id and s.enabled and s.display_mode <> 'hidden'
    where o.status = 'active'
    group by o.property_id
  ),
  candidates as (
    select sp.*, vo.offers, vo.best_mode,
      case when v_tsq is null then 0 else ts_rank_cd(sp.tsv, v_tsq, 32) end as s_text,
      case when v_emb is null or sp.embedding is null then 0 else 1 - (sp.embedding <=> v_emb) end as s_sem,
      case when cardinality(v_pref) = 0 then 0
           else cardinality(array(select unnest(sp.amenities) intersect select unnest(v_pref)))::float / cardinality(v_pref) end as s_pref,
      case when v_near is null or sp.geog is null then null else st_distance(sp.geog, v_near) / 1000.0 end as dist_km
    from search_properties sp
    left join visible_offers vo on vo.property_id = sp.id
    where sp.status = 'active'
      -- our own listings always show; crawled ones need at least one visible offer
      and (sp.origin = 'proplync' or vo.property_id is not null)
      and (p->>'market' is null or sp.market_id = p->>'market')
      and (p->>'operation' is null or sp.operation = p->>'operation')
      and (cardinality(v_towns) = 0 or exists (
            select 1 from unnest(v_towns) t
            where public.f_unaccent(lower(coalesce(sp.town, '') || ' ' || coalesce(sp.neighborhood, ''))) like '%' || t || '%'))
      and (p->>'beds_min' is null or sp.bedrooms >= (p->>'beds_min')::numeric)
      and (p->>'price_min_mxn' is null or sp.price_mxn_max >= (p->>'price_min_mxn')::numeric)
      and (v_max is null or sp.price_mxn_min <= v_max)
      and (p->>'size_min' is null or sp.built_m2 >= (p->>'size_min')::numeric)
      and (p->>'size_max' is null or sp.built_m2 <= (p->>'size_max')::numeric)
      and (cardinality(v_req) = 0 or sp.amenities @> v_req)
      and (p->'bbox' is null or (sp.lng between (p->'bbox'->>0)::float8 and (p->'bbox'->>2)::float8
                                 and sp.lat between (p->'bbox'->>1)::float8 and (p->'bbox'->>3)::float8))
      and (v_near is null or p->>'radius_km' is null
           or (sp.geog is not null and st_dwithin(sp.geog, v_near, (p->>'radius_km')::float8 * 1000)))
      and (v_tsq is null or p->>'q_mode' is distinct from 'all' or sp.tsv @@ v_tsq)
  ),
  scored as (
    select c.*,
      -- ts_rank_cd with normalization 32 is already in [0, 1); scaling it up
      -- made every matching listing tie at 1
      0.35 * c.s_text
      + 0.35 * greatest(c.s_sem, 0)
      + 0.15 * c.s_pref
      + 0.10 * case when c.dist_km is null then 0 else 1 / (1 + c.dist_km) end
      + 0.03 * exp(-extract(epoch from (now() - c.last_seen_at)) / 86400.0 / 30)
      + 0.02 * case when c.verified then 1 else 0 end as score,
      count(*) over () as total
    from candidates c
  ),
  ranked as (
    select s.*, row_number() over (order by
      case when p->>'sort' = 'price_asc' then price_mxn_min end asc nulls last,
      case when p->>'sort' = 'price_desc' then price_mxn_min end desc nulls last,
      case when p->>'sort' = 'newest' then first_seen_at end desc,
      score desc, price_mxn_min asc nulls last, id) as rn
    from scored s
  ),
  page as (
    select * from ranked where rn > v_offset and rn <= v_offset + v_limit
  )
  select jsonb_build_object(
    'total', coalesce(max(total), 0),
    'results', coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'origin', origin, 'listing_public_id', listing_public_id, 'market_id', market_id,
      'title', title, 'operation', operation, 'property_type', property_type,
      'town', town, 'neighborhood', neighborhood,
      'bedrooms', bedrooms, 'bathrooms', bathrooms, 'parking', parking,
      'built_m2', built_m2, 'land_m2', land_m2,
      'price_mxn_min', price_mxn_min, 'price_mxn_max', price_mxn_max,
      'description', description, 'amenities', amenities, 'photos', photos,
      'lat', lat, 'lng', lng, 'verified', verified, 'best_mode', best_mode,
      'offers', coalesce(offers, '[]'::jsonb),
      'score', round(score::numeric, 4),
      'reasons', jsonb_build_object(
        'amenities_met', to_jsonb(array(select unnest(amenities) intersect select unnest(v_pref))),
        'amenities_missing', to_jsonb(array(select unnest(v_pref) except select unnest(amenities))),
        'distance_km', case when dist_km is null then null else round(dist_km::numeric, 1) end,
        'under_budget_pct', case when v_max is null or price_mxn_min is null or v_max = 0 then null
                                 else round(((v_max - price_mxn_min) / v_max * 100)::numeric) end,
        'text_match', s_text > 0
      )
    ) order by rn), '[]'::jsonb)
  ) into v_result
  from page;

  return v_result;
end;
$$;

revoke all on function public.search_properties_v1(jsonb) from public, anon, authenticated;
grant execute on function public.search_properties_v1(jsonb) to service_role;
