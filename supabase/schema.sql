-- Proplync.mx · Multi-tenant SaaS schema (Phase 1)
-- Run once in Supabase Studio's SQL editor.
-- No migration tooling — matches this repo's zero-tooling philosophy elsewhere.

-- ============================================================
-- agencies: tenant root
-- ============================================================
create table agencies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  logo_url text,
  primary_color text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- agency_members: links auth.users -> agency, with a role.
-- Phase 1 simplification: one agency per user (unique on user_id).
-- Multi-member agencies later = just drop that unique constraint.
-- ============================================================
create table agency_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agency_id uuid not null references agencies(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner','agent')),
  created_at timestamptz not null default now(),
  unique (user_id)
);

-- ============================================================
-- listings: agency-owned, shaped to match the EasyBroker-derived
-- object already produced by api/listings.js / api/search.js /
-- api/property.js, so it's drop-in compatible with cardHTML()/
-- renderProperty() as-is. No "formatted" column — computed at the
-- API layer on read, same as the existing EasyBroker mapping does.
-- ============================================================
create table listings (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  public_id text unique not null default ('PL-' || substr(gen_random_uuid()::text, 1, 8)),
  title_es text not null default '',
  title_en text not null default '',
  town text not null default '',
  neighborhood text not null default '',
  bedrooms int not null default 0,
  bathrooms int not null default 0,
  parking int not null default 0,
  size numeric not null default 0,
  operation text not null check (operation in ('sale','rental')),
  currency text not null default 'MXN',
  amount numeric not null default 0,
  image text,
  images text[] not null default '{}',
  description_es text default '',
  description_en text default '',
  lat numeric,
  lng numeric,
  features text[] not null default '{}',
  status text not null default 'published' check (status in ('draft','published','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index listings_agency_idx on listings(agency_id);
create index listings_status_idx on listings(status);
create index listings_public_id_idx on listings(public_id);

-- ============================================================
-- leads: the CRM core
-- ============================================================
create table leads (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  listing_id uuid references listings(id) on delete set null,
  listing_public_id text,
  name text not null,
  email text not null,
  phone text,
  message text,
  status text not null default 'new' check (status in ('new','contacted','won','lost')),
  created_at timestamptz not null default now()
);
create index leads_agency_idx on leads(agency_id);

-- ============================================================
-- helper: current user's agency_id. SECURITY DEFINER to avoid
-- recursive RLS evaluation when referenced from other tables' policies.
-- ============================================================
create or replace function get_my_agency_id()
returns uuid language sql stable security definer as $$
  select agency_id from agency_members where user_id = auth.uid() limit 1;
$$;

-- ============================================================
-- RLS
-- ============================================================
alter table agencies enable row level security;
alter table agency_members enable row level security;
alter table listings enable row level security;
alter table leads enable row level security;

create policy agencies_select_own on agencies for select
  using (id = get_my_agency_id());

create policy members_select_own on agency_members for select
  using (user_id = auth.uid());
-- no insert/update/delete policies on agencies or agency_members:
-- those writes only happen server-side via the service-role key in
-- api/onboard.js, which enforces slug uniqueness + the "one agency
-- per user" invariant explicitly before Postgres's unique constraint
-- would otherwise just throw a generic 23505 error.

create policy listings_select_public on listings for select
  using (status = 'published');
create policy listings_select_own on listings for select
  using (agency_id = get_my_agency_id());
create policy listings_insert_own on listings for insert
  with check (agency_id = get_my_agency_id());
create policy listings_update_own on listings for update
  using (agency_id = get_my_agency_id());
create policy listings_delete_own on listings for delete
  using (agency_id = get_my_agency_id());

create policy leads_select_own on leads for select
  using (agency_id = get_my_agency_id());
create policy leads_update_own on leads for update
  using (agency_id = get_my_agency_id());
-- no public insert policy: /api/leads.js always writes via the
-- service-role key (bypasses RLS), after deriving agency_id itself
-- from the listing — never trusting a client-supplied agency_id.

-- ============================================================
-- Storage: agency listing photos, uploaded from the dashboard's
-- create/edit form via the browser Supabase client.
-- ============================================================
insert into storage.buckets (id, name, public) values ('listing-photos','listing-photos', true);

create policy listing_photos_public_read on storage.objects for select
  using (bucket_id = 'listing-photos');
create policy listing_photos_agency_write on storage.objects for insert
  with check (bucket_id = 'listing-photos' and (storage.foldername(name))[1] = get_my_agency_id()::text);
create policy listing_photos_agency_manage on storage.objects for update
  using (bucket_id = 'listing-photos' and (storage.foldername(name))[1] = get_my_agency_id()::text);
create policy listing_photos_agency_delete on storage.objects for delete
  using (bucket_id = 'listing-photos' and (storage.foldername(name))[1] = get_my_agency_id()::text);
