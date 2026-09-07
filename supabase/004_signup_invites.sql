-- Proplync.mx · Single-use signup invites
-- Run once in Supabase Studio's SQL editor, after 003_crm_notes_followups.sql.
--
-- Why not the SIGNUP_INVITE_CODE env var: it is one shared secret for everyone,
-- changing it needs a redeploy, an agency can pass it on, and there is no record
-- of who used what. A row per invite fixes all four — issue one per agency, bind
-- it to their address, watch it burn on use, revoke it by deleting it.
--
-- The env var still works as a master override; this table is checked first.

create table if not exists signup_invites (
  id uuid primary key default gen_random_uuid(),

  -- sha256 of the code, never the code itself. A leaked database backup should
  -- not hand someone a working set of signup codes.
  code_hash text not null unique,

  -- When set, only this address may redeem the invite. Recommended: it turns a
  -- forwarded code into a dead code.
  email text,

  -- Prefills the agency name at signup so they cannot typo their own slug.
  agency_name text,

  -- Free-text reminder of who this was for, for when you are looking at a list
  -- of hashes three weeks later.
  note text,

  expires_at timestamptz not null,
  used_at    timestamptz,
  used_by    uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists signup_invites_unused_idx
  on signup_invites (expires_at)
  where used_at is null;

-- RLS on with no policies at all: this table is only ever touched by the
-- service-role client inside /api/onboard and the operator's local script.
-- No browser session, anonymous or signed-in, can read or write a single row.
alter table signup_invites enable row level security;
