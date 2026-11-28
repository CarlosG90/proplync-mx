-- Proplync.mx · 020 · Mini pages: the owner's material (infographics, brochures, price lists)
-- -----------------------------------------------------------------------------
-- WHY THIS EXISTS
-- Service businesses already have their offer designed as infographics and PDFs
-- (what an appraisal includes, the documents a notary needs, a price list). They
-- want those on their page as they are, not retyped into service cards. One row
-- per file the owner uploaded; the page shows them as a "Material" section that
-- visitors open full size, download or share.
--
-- WHERE THE FILES LIVE
-- In the existing public bucket listing-photos, under the agency's own folder
-- (<agency_id>/asset-….ext). The storage policy listing_photos_agency_write
-- (schema.sql) already lets a member write only there. mini/api/_assets.js only
-- accepts URLs inside that folder, so a row can never point somewhere else.
--
-- Idempotent: safe to run twice.
-- -----------------------------------------------------------------------------

create table if not exists mini_assets (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  url text not null check (url ~ '^https://' and length(url) <= 1000),
  kind text not null check (kind in ('image', 'pdf')),
  title text check (title is null or length(title) <= 120),
  sort integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists mini_assets_agency_idx on mini_assets (agency_id, sort, created_at);

-- Your agency's material, nobody else's. The public page reads it with the
-- service role (mini/api/page.js), only for a paid page.
alter table mini_assets enable row level security;

drop policy if exists mini_assets_select_own on mini_assets;
create policy mini_assets_select_own on mini_assets for select
  using (agency_id = get_my_agency_id());

drop policy if exists mini_assets_insert_own on mini_assets;
create policy mini_assets_insert_own on mini_assets for insert
  with check (agency_id = get_my_agency_id());

drop policy if exists mini_assets_update_own on mini_assets;
create policy mini_assets_update_own on mini_assets for update
  using (agency_id = get_my_agency_id())
  with check (agency_id = get_my_agency_id());

drop policy if exists mini_assets_delete_own on mini_assets;
create policy mini_assets_delete_own on mini_assets for delete
  using (agency_id = get_my_agency_id());
