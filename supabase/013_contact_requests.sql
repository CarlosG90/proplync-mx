-- 013 · contact_requests
-- The "request a free diagnosis" form on /agencias. These are prospects for
-- Proplync itself, so like download_leads they do not live in `leads` (an
-- agency's own buyers, scoped to an agency by RLS). It is a separate table
-- from download_leads because those rows require a phone and have no place
-- for the company, the type of operation or the message the call needs.
-- Idempotent: safe to run twice.

create table if not exists contact_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company text,
  email text not null,
  phone text,
  kind text not null default 'agency'
    check (kind in ('agency', 'owner', 'developer', 'other')),
  message text,
  lang text check (lang in ('es', 'en')),
  source text not null default 'agencias',
  created_at timestamptz not null default now()
);

create index if not exists contact_requests_created_idx on contact_requests (created_at desc);
create index if not exists contact_requests_email_idx on contact_requests (lower(email));

-- Service role only: /api/leads?action=contact writes it, the operator reads it
-- from SQL. No policies on purpose, so no browser session (anonymous or signed
-- in) can read or write a row directly.
alter table contact_requests enable row level security;
