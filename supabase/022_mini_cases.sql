-- Proplync.mx · 022 · Mini: the owner's client CRM ("Clientes"), per service, fed by WhatsApp
-- -----------------------------------------------------------------------------
-- WHY THIS EXISTS
-- A service business tracks each job: who the client is, which service, where it
-- is (for real estate, the property's address), which step it is on, what was
-- charged, the deposit, the balance and the commission. The first customer kept
-- this on paper (NOMBRE, DIRECCIÓN, TRÁMITE, INICIO, FINALIZÓ, PROCESO, TELÉFONO,
-- COSTO, ANTICIPO, RESTO, COSTO DE VENTA, PAGO DE COMISIÓN). One row per job.
--
-- PER SERVICE
-- Each service has its own steps (mini_services.stages), defaulted from the
-- business template (mini/js/business-types.js "cases"). A job's stage is one of
-- its service's steps.
--
-- FED BY WHATSAPP
-- A new WhatsApp conversation (mini/api/whatsapp.js) opens a "lead" row with the
-- client's number and, when the assistant could tell, the service they asked
-- about. The owner turns it into a job (status open) or drops it.
--
-- A MONTHLY ADD-ON
-- agencies.crm_until: the CRM is a paid monthly add-on (MXN 149, plans.js).
-- Writes need it to be in the future; data is never deleted when it lapses.
--
-- balance is computed by Postgres (fee - advance), never typed.
-- Idempotent: safe to run twice.
-- -----------------------------------------------------------------------------

alter table agencies add column if not exists crm_until timestamptz;

alter table mini_services add column if not exists stages text[];

-- Several photos per service (the first is the cover). `image` stays as the cover for old rows and readers.
alter table mini_services add column if not exists images text[] not null default '{}';

create table if not exists mini_cases (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  service_id uuid references mini_services(id) on delete set null,
  source text not null default 'manual' check (source in ('manual', 'whatsapp')),
  status text not null default 'open' check (status in ('lead', 'open', 'done', 'cancelled')),
  stage text check (stage is null or length(stage) <= 80),
  client_name text check (client_name is null or length(client_name) <= 120),
  client_phone text check (client_phone is null or length(client_phone) <= 30),
  address text check (address is null or length(address) <= 200),
  started_on date,
  finished_on date,
  fee numeric(12,2) check (fee is null or fee >= 0),
  advance numeric(12,2) check (advance is null or advance >= 0),
  balance numeric(12,2) generated always as (coalesce(fee, 0) - coalesce(advance, 0)) stored,
  sale_price numeric(12,2) check (sale_price is null or sale_price >= 0),
  commission numeric(12,2) check (commission is null or commission >= 0),
  commission_paid_on date,
  notes text check (notes is null or length(notes) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (finished_on is null or started_on is null or finished_on >= started_on)
);

create index if not exists mini_cases_agency_idx on mini_cases (agency_id, status, created_at desc);
create index if not exists mini_cases_service_idx on mini_cases (agency_id, service_id);
create index if not exists mini_cases_phone_idx on mini_cases (agency_id, client_phone);

create or replace function mini_cases_touch()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists mini_cases_touch on mini_cases;
create trigger mini_cases_touch before update on mini_cases for each row execute function mini_cases_touch();

-- The owner's clients only. The API writes with the service role, scoped to the session's agency.
alter table mini_cases enable row level security;
drop policy if exists mini_cases_select_own on mini_cases;
create policy mini_cases_select_own on mini_cases for select using (agency_id = get_my_agency_id());
drop policy if exists mini_cases_insert_own on mini_cases;
create policy mini_cases_insert_own on mini_cases for insert with check (agency_id = get_my_agency_id());
drop policy if exists mini_cases_update_own on mini_cases;
create policy mini_cases_update_own on mini_cases for update
  using (agency_id = get_my_agency_id()) with check (agency_id = get_my_agency_id());
drop policy if exists mini_cases_delete_own on mini_cases;
create policy mini_cases_delete_own on mini_cases for delete using (agency_id = get_my_agency_id());
