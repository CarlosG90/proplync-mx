-- Proplync.mx · 024 · Mini: "Agendar cita", appointment requests the owner approves
-- -----------------------------------------------------------------------------
-- WHY THIS EXISTS
-- Service businesses live on appointments, and the competing card offer sells
-- "tus clientes agendan, tú autorizas". A client picks a day and a time on the
-- Mini page (mini/api/agenda.js); the owner confirms or declines it in the panel
-- and the client gets the answer on WhatsApp.
--
-- agencies.agenda: the owner's settings (on/off, working days, hours, length of
-- an appointment, how far ahead, time zone). Validated in mini/api/_agenda.js.
-- mini_appointments: one row per request. The partial unique index means two
-- clients can never hold the same time: a requested or confirmed slot is taken.
-- When the CRM add-on is active, a request also becomes a lead (source 'agenda').
--
-- Idempotent: safe to run twice.
-- -----------------------------------------------------------------------------

alter table agencies add column if not exists agenda jsonb;

create table if not exists mini_appointments (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  service_id uuid references mini_services(id) on delete set null,
  starts_at timestamptz not null,
  minutes integer not null default 60 check (minutes between 10 and 480),
  client_name text not null check (length(trim(client_name)) between 1 and 120),
  client_phone text not null check (length(client_phone) between 6 and 30),
  note text check (note is null or length(note) <= 500),
  status text not null default 'requested' check (status in ('requested', 'confirmed', 'declined', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists mini_appointments_slot_uniq on mini_appointments (agency_id, starts_at)
  where status in ('requested', 'confirmed');
create index if not exists mini_appointments_agency_idx on mini_appointments (agency_id, starts_at);

-- Bookings also reach the CRM as leads.
alter table mini_cases drop constraint if exists mini_cases_source_check;
alter table mini_cases add constraint mini_cases_source_check check (source in ('manual', 'whatsapp', 'agenda'));

-- The owner's appointments only. Clients book through the API (service role), never directly.
alter table mini_appointments enable row level security;
drop policy if exists mini_appointments_select_own on mini_appointments;
create policy mini_appointments_select_own on mini_appointments for select using (agency_id = get_my_agency_id());
drop policy if exists mini_appointments_update_own on mini_appointments;
create policy mini_appointments_update_own on mini_appointments for update
  using (agency_id = get_my_agency_id()) with check (agency_id = get_my_agency_id());
drop policy if exists mini_appointments_delete_own on mini_appointments;
create policy mini_appointments_delete_own on mini_appointments for delete using (agency_id = get_my_agency_id());
