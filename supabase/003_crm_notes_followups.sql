-- Proplync.mx · CRM: lead notes, follow-ups, and source
-- Run once in Supabase Studio's SQL editor, after 002_agency_whatsapp.sql.
-- No migration tooling — matches this repo's zero-tooling philosophy elsewhere.
--
-- Why: a lead inbox whose only verb is a status dropdown is a list, not a CRM.
-- An agent's real question is "who do I call today, and what did I last say to
-- them?" Neither is answerable today. These three columns and one table make
-- both answerable without introducing a pipeline the product cannot yet honour.

-- ---------------------------------------------------------------------------
-- leads: follow-up scheduling and provenance
-- ---------------------------------------------------------------------------

-- The date the agent intends to next contact this lead. Nullable: a lead with
-- no planned follow-up is a legitimate state (just arrived, or closed out).
alter table leads add column if not exists next_follow_up date;

-- Stamped whenever the agent records contact. Distinct from status: an agent
-- can ring three times without the status ever leaving 'contacted', and
-- "last touched 9 days ago" is the signal that matters for chasing.
alter table leads add column if not exists last_contacted_at timestamptz;

-- Where the lead came from. Defaults to 'web' because every lead the system
-- can currently create arrives through the public form on a property page.
-- Free text rather than an enum: the channels are not yet known well enough
-- to be worth a constraint that blocks writes when a new one appears.
alter table leads add column if not exists source text not null default 'web';

-- The overdue-leads view is the dashboard's default query, so it gets an index.
-- Partial: rows with no follow-up date are never in that result set.
create index if not exists leads_agency_followup_idx
  on leads (agency_id, next_follow_up)
  where next_follow_up is not null;

-- ---------------------------------------------------------------------------
-- lead_notes: the conversation history behind each lead
-- ---------------------------------------------------------------------------

create table if not exists lead_notes (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,

  -- Denormalised from leads.agency_id so the RLS policy is a single-column
  -- comparison instead of a subquery into leads on every row read. Kept
  -- honest by the trigger below rather than by trusting the caller.
  agency_id uuid not null references agencies(id) on delete cascade,

  -- Who wrote it. Nullable and ON DELETE SET NULL so removing a team member
  -- redacts authorship without destroying the agency's history of the deal.
  author_id uuid references auth.users(id) on delete set null,

  body text not null check (length(trim(body)) > 0),
  created_at timestamptz not null default now()
);

create index if not exists lead_notes_lead_idx on lead_notes (lead_id, created_at desc);

-- agency_id must always match the parent lead. Deriving it in a trigger means
-- a caller cannot file a note against their own agency while pointing it at
-- someone else's lead, which the RLS policy alone would happily permit.
create or replace function lead_notes_set_agency()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  select agency_id into new.agency_id from leads where id = new.lead_id;
  if new.agency_id is null then
    raise exception 'lead % not found', new.lead_id;
  end if;
  return new;
end;
$$;

drop trigger if exists lead_notes_set_agency_trg on lead_notes;
create trigger lead_notes_set_agency_trg
  before insert or update of lead_id on lead_notes
  for each row execute function lead_notes_set_agency();

alter table lead_notes enable row level security;

-- Same ownership model as leads: your agency's rows, nobody else's.
drop policy if exists lead_notes_select_own on lead_notes;
create policy lead_notes_select_own on lead_notes for select
  using (agency_id = get_my_agency_id());

drop policy if exists lead_notes_insert_own on lead_notes;
create policy lead_notes_insert_own on lead_notes for insert
  with check (agency_id = get_my_agency_id());

-- Notes are an audit trail of what was said and when, so they are append-only
-- for everyone: no update policy at all. Deleting a mistake is allowed;
-- silently rewriting history after the fact is not.
drop policy if exists lead_notes_delete_own on lead_notes;
create policy lead_notes_delete_own on lead_notes for delete
  using (agency_id = get_my_agency_id());
