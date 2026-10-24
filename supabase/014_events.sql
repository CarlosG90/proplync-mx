-- 014 · events
-- A first-party, anonymous log of the funnel (LANDING-PAGES-PLAN §7, BUSINESS-MODEL R7): who got as far as
-- starting a conversation, approving a brief, asking for a verification. No analytics vendor, no cookies.
--
-- WHAT IT HOLDS: the event name, the page, an anonymous id that lives only in the visitor's tab
-- (sessionStorage), the language, the campaign tags (UTM) from the link, and the referring site's host.
-- WHAT IT NEVER HOLDS: an IP address, a name, an email, a phone. The API drops any property that looks like
-- one, and the browser does not send anything when Do Not Track or Global Privacy Control is on.
--
-- Written only by /api/leads?action=event (service role). Read from SQL or `node scripts/funnel.mjs`.
-- Idempotent: safe to run twice.

create table if not exists events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  name text not null check (name ~ '^[a-z_]{3,40}$'),
  page text not null check (page ~ '^[a-z0-9_-]{1,40}$'),
  session text not null check (session ~ '^[a-z0-9-]{8,40}$'),
  lang text check (lang in ('es', 'en')),
  utm_source text check (char_length(utm_source) <= 80),
  utm_medium text check (char_length(utm_medium) <= 80),
  utm_campaign text check (char_length(utm_campaign) <= 80),
  ref_host text check (char_length(ref_host) <= 100),
  props jsonb not null default '{}'::jsonb
    check (jsonb_typeof(props) = 'object' and pg_column_size(props) <= 1024)
);

create index if not exists events_created_idx on events (created_at desc);
create index if not exists events_name_created_idx on events (name, created_at desc);
create index if not exists events_session_idx on events (session, created_at);

-- Server only. No policies on purpose, and no grants to the browser roles, so nobody with the public key can
-- read or write a row directly.
alter table events enable row level security;
revoke all on events from anon, authenticated;

-- The funnel, in three views. security_invoker makes each view obey the caller's rights (and so the table's
-- row security), so exposing them in the public schema does not open the data to the browser.

-- Per day and event: how many events, and how many distinct visitors (sessions).
create or replace view event_funnel_daily with (security_invoker = true) as
select (created_at at time zone 'America/Cancun')::date as day,
       name,
       count(*) as events,
       count(distinct session) as sessions
from events
group by 1, 2;

-- The last 30 days, one row per stage: how many distinct visitors reached it.
create or replace view event_funnel_30d with (security_invoker = true) as
select name, count(distinct session) as sessions
from events
where created_at > now() - interval '30 days'
group by name;

-- Same, split by where the visitor came from (campaign tag, else referring site, else direct).
create or replace view event_funnel_by_source_30d with (security_invoker = true) as
select coalesce(utm_source, ref_host, '(direct)') as source,
       coalesce(utm_campaign, '') as campaign,
       name,
       count(distinct session) as sessions
from events
where created_at > now() - interval '30 days'
group by 1, 2, 3;

revoke all on event_funnel_daily, event_funnel_30d, event_funnel_by_source_30d from anon, authenticated;
