-- Proplync.mx · 019 · Mini for any service business: business type + services catalog
-- -----------------------------------------------------------------------------
-- WHY THIS EXISTS
-- PropLync Mini was built for real-estate agents: the page's items are listings.
-- The first customers outside that mold sell services (appraisals, paperwork at
-- city hall and the notary, architectural drawings, land surveys), and the same
-- one-link page is wanted by any person who provides services. So an agency now
-- has a business_type (which template its page and panel use, mini/js/business-types.js)
-- and a catalog of services shown on its page.
--
-- WHY NOT STORE SERVICES AS LISTINGS
-- listings carry property columns (bedrooms, m²) and every save is mirrored into
-- the buyer search index (api/my-listings.js syncProplync). A "Levantamiento
-- topográfico" must never show up in property search.
--
-- WHY agencies.services STAYS
-- It is the short tag strip in the page's hero (up to 8 words). mini_services is
-- the full catalog: description, price, photo, order.
--
-- Existing agencies default to real_estate: nothing changes for them.
-- Idempotent: safe to run twice.
-- -----------------------------------------------------------------------------

alter table agencies
  add column if not exists business_type text not null default 'real_estate';

alter table agencies drop constraint if exists agencies_business_type_check;
alter table agencies add constraint agencies_business_type_check
  check (business_type in ('real_estate', 'professional', 'trades', 'beauty', 'general'));

create table if not exists mini_services (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  title_es text not null check (length(trim(title_es)) between 1 and 120),
  title_en text check (title_en is null or length(title_en) <= 120),
  description_es text check (description_es is null or length(description_es) <= 1200),
  description_en text check (description_en is null or length(description_en) <= 1200),
  -- null = "a cotizar". price_kind says how to read the number.
  price numeric(12,2) check (price is null or price >= 0),
  price_kind text not null default 'quote' check (price_kind in ('fixed', 'from', 'per_m2', 'quote')),
  currency text not null default 'MXN' check (currency in ('MXN', 'USD')),
  duration_min integer check (duration_min is null or duration_min between 5 and 1440),
  image text,
  sort integer not null default 0,
  -- Drafts until the page is paid, like listings (plans.js pageActive).
  status text not null default 'published' check (status in ('published', 'draft')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mini_services_agency_idx on mini_services (agency_id, sort, created_at);

create or replace function mini_services_touch()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists mini_services_touch on mini_services;
create trigger mini_services_touch before update on mini_services
  for each row execute function mini_services_touch();

-- Your agency's services, nobody else's. The public page reads published rows
-- with the service role (mini/api/page.js), only for a paid page.
alter table mini_services enable row level security;

drop policy if exists mini_services_select_own on mini_services;
create policy mini_services_select_own on mini_services for select
  using (agency_id = get_my_agency_id());

drop policy if exists mini_services_insert_own on mini_services;
create policy mini_services_insert_own on mini_services for insert
  with check (agency_id = get_my_agency_id());

drop policy if exists mini_services_update_own on mini_services;
create policy mini_services_update_own on mini_services for update
  using (agency_id = get_my_agency_id())
  with check (agency_id = get_my_agency_id());

drop policy if exists mini_services_delete_own on mini_services;
create policy mini_services_delete_own on mini_services for delete
  using (agency_id = get_my_agency_id());
