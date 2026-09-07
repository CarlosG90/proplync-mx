-- Proplync.mx · Marketing as a Pro module, and the plan column it needs
-- Run once in Supabase Studio's SQL editor, after 004_signup_invites.sql.
--
-- api/_lib/plans.js has read agencies.plan since it was written, and the column
-- never existed — planFor() treats anything unrecognised as free, so every
-- agency has been on the free tier by accident rather than by decision.

alter table agencies
  add column if not exists plan text not null default 'free'
  check (plan in ('free','pro','vip'));

-- Free agencies get a limited number of real generations before the paywall.
-- Counted on the agency, not the browser, so clearing cookies does not reset it.
alter table agencies add column if not exists marketing_trials_used integer not null default 0;

-- An invite decides what the agency gets, not just whether they get in.
-- Defaults to pro: an agency onboarded by hand is the paying relationship,
-- and 'free' stays available for a self-serve tier without another migration.
alter table signup_invites
  add column if not exists plan text not null default 'pro'
  check (plan in ('free','pro','vip'));

-- Downloading generated content asks for a contact first. These are prospects
-- for Proplync itself, which is why they do not live in `leads` — that table is
-- an agency's own buyers and is scoped to an agency by RLS.
create table if not exists download_leads (
  id uuid primary key default gen_random_uuid(),
  name text,
  email text not null,
  phone text not null,
  agency_id uuid references agencies(id) on delete set null,
  listing_public_id text,
  source text not null default 'generate',
  created_at timestamptz not null default now()
);

create index if not exists download_leads_created_idx on download_leads (created_at desc);
create index if not exists download_leads_email_idx on download_leads (lower(email));

-- Only the service role touches this: /api/leads writes it, the operator reads
-- it from SQL. No browser session, anonymous or signed in, sees a row.
alter table download_leads enable row level security;
