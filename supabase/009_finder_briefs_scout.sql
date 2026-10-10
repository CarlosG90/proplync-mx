-- Proplync.mx · Finder: approved buyer briefs, Scout runs, candidate properties
-- Run once, after 008_lead_qualification.sql. Idempotent: safe to re-run.
--
-- WHY THIS EXISTS
-- Concierge turns a buyer conversation into a brief, and until now that brief
-- lived only in the browser tab. Scout (api/_lib/scout.js) needs it stored to
-- search from, a human needs the results stored to verify them against the
-- listing agent, and the buyer needs a link to come back to.
--
-- WHO CAN READ THIS
-- Nobody but the server. RLS is enabled on all three tables with no policies,
-- so the anon and authenticated roles see nothing; api/finder.js and
-- scripts/scout.mjs use the service role. Buyers are not Supabase users: they
-- prove which brief is theirs with a random token whose SHA-256 is stored here,
-- never the token itself.
--
-- WHAT IS NOT STORED
-- The conversation transcript and voice notes. The brief is the minimum needed
-- to search, and LFPDPPP asks for exactly that minimum.

-- Schema drift: schema.sql adds listings.property_type, but production was
-- created before that line existed. Scout's inventory query and
-- api/my-listings.js both read it, so it lands here too.
alter table listings add column if not exists property_type text;

create table if not exists buyer_briefs (
  id uuid primary key default gen_random_uuid(),
  access_token_hash text not null unique,
  lang text not null default 'es' check (lang in ('es','en')),

  -- Concierge's brief exactly as api/finder.js returns it: must_haves,
  -- deal_breakers, nice_to_haves, budget, location, purpose, timeline,
  -- buyer_profile, lifestyle_words. Not normalized on purpose: the shape is the
  -- contract between Concierge and Scout, and both read it as one object.
  brief jsonb not null,

  contact_name text not null,
  contact_email text not null,
  consent_at timestamptz not null,

  --  approved  : saved, nothing searched yet (operator mode waits here)
  --  searching : a Scout run is in progress
  --  review    : candidates exist, a person is confirming them with agents
  --  ready     : confirmed candidates are visible to the buyer
  --  closed    : finished or withdrawn
  status text not null default 'approved'
    check (status in ('approved','searching','review','ready','closed')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists buyer_briefs_status_idx on buyer_briefs(status, created_at desc);

create table if not exists scout_runs (
  id uuid primary key default gen_random_uuid(),
  brief_id uuid not null references buyer_briefs(id) on delete cascade,
  trigger text not null check (trigger in ('auto','operator')),
  status text not null default 'queued'
    check (status in ('queued','running','done','failed')),

  -- The Claude conversation so far. A web search turn pauses after about ten
  -- server-side steps (stop_reason "pause_turn"), and resuming means sending
  -- the whole transcript back. A Vercel function cannot hold it between
  -- invocations, so it lives here. Can reach a few hundred KB of fetched page
  -- text per run; it is only ever read and written whole.
  messages jsonb not null default '[]'::jsonb,

  steps integer not null default 0,     -- completed Claude segments
  attempts integer not null default 0,  -- started segments, including ones killed by a timeout

  -- A step holds this lease while it runs, so a duplicate kick (a retried
  -- request, an operator running the script while auto mode is on) cannot run
  -- the same segment twice and pay for it twice.
  lease_until timestamptz,

  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  cache_write_tokens bigint not null default 0,
  web_searches integer not null default 0,
  web_fetches integer not null default 0,
  cost_usd numeric(10,4) not null default 0,

  search_notes text,   -- what the model searched and where it came up short
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists scout_runs_brief_idx on scout_runs(brief_id, created_at desc);
create index if not exists scout_runs_created_idx on scout_runs(created_at desc);

create table if not exists scout_candidates (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references scout_runs(id) on delete cascade,
  brief_id uuid not null references buyer_briefs(id) on delete cascade,

  -- 'proplync' when it is one of our agencies' listings (listing_public_id set),
  -- 'web' when Scout found it on a portal or an agency site.
  origin text not null check (origin in ('proplync','web')),
  listing_public_id text,

  -- Facts as the sources state them. Null means no source said, which is the
  -- question a person then asks the agent. Never filled in by guesswork.
  title text,
  operation text check (operation in ('sale','rental')),
  property_type text,
  town text,
  neighborhood text,
  bedrooms numeric,
  bathrooms numeric,
  built_m2 numeric,
  land_m2 numeric,

  -- One entry per place this property is advertised, each with its own price:
  --   { "url", "site", "listed_by", "price", "currency" }
  -- The same property on three portals is one candidate with three sources.
  sources jsonb not null default '[]'::jsonb,
  photos jsonb not null default '[]'::jsonb,

  -- { "must_haves": [{item, status: met|no|unknown, evidence}],
  --   "deal_breakers": [{item, status: present|absent|unknown, evidence}],
  --   "summary": "...", "questions_for_agent": ["..."] }
  match jsonb not null default '{}'::jsonb,
  fit_score integer,
  lowest_price_mxn numeric,

  --  pending     : not yet checked with the listing agent
  --  confirmed   : the five questions were answered and it passes
  --  rejected    : sold, wrong price, cannot visit, or fails the brief
  --  unreachable : nobody answered; never shown to the buyer
  verification text not null default 'pending'
    check (verification in ('pending','confirmed','rejected','unreachable')),

  -- The five questions, as the agent answered them:
  --   { "available", "price", "can_visit", "listing_agent", "restrictions" }
  answers jsonb,
  verification_notes text,   -- internal; never sent to the buyer
  verified_by text,
  verified_at timestamptz,

  created_at timestamptz not null default now()
);

create index if not exists scout_candidates_brief_idx on scout_candidates(brief_id, verification);

alter table buyer_briefs enable row level security;
alter table scout_runs enable row level security;
alter table scout_candidates enable row level security;
