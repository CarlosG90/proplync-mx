-- Proplync.mx · Runway reel clips: job tracking + permanent storage
-- Run once in Supabase Studio's SQL editor, after 005_marketing_pro_gate.sql.
--
-- Two things force this migration to exist.
--
-- 1. Runway generations are asynchronous and slow. A measured gen4.5 clip took
--    104 seconds, and the account renders them one at a time, so a full Reel is
--    5-9 minutes. The function is capped at 60s (Hobby allows up to 300s), so
--    the request that starts a Reel cannot be the request that finishes it. The
--    task ids have to survive between the two, and a serverless function has
--    nowhere to put them. That is this table.
--
-- 2. Runway's output URLs expire in 24-48 hours — their own SDK types say to
--    download the assets and store them yourself. An agency that came back on
--    Monday for Friday's Reel would find a dead link, so the finished mp4 gets
--    copied into a bucket we own and the Runway URL is never handed to a
--    browser.

create table if not exists reel_jobs (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,

  -- Which listing this Reel is for. Text, not a foreign key, to match how
  -- listing_public_id is already carried in download_leads.
  listing_public_id text,

  -- 'working' while any clip is still generating, then 'done' or 'failed'.
  -- Partial success counts as done: four clips where one failed still makes a
  -- Reel, because the canvas renderer falls back to the still photo per scene.
  status text not null default 'working' check (status in ('working','done','failed')),

  -- One entry per Reel beat, in playback order:
  --   { "slot": "hook", "task_id": "...", "state": "working|done|failed",
  --     "source_photo": "https://...", "video_path": "agency/job/hook.mp4" }
  -- JSONB rather than a child table: clips are only ever read and written as a
  -- complete set, and there is no query that wants one clip on its own.
  clips jsonb not null default '[]'::jsonb,

  -- What Runway actually charged, summed across clips as each one lands.
  -- Unlike Groq's free tier this feature costs real money per run, so the
  -- number is recorded per job instead of being estimated after the fact.
  credits_spent numeric not null default 0,

  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The quota check in api/reel.js counts this month's jobs for one agency, and
-- the dashboard lists an agency's recent jobs newest-first. Both hit this.
create index if not exists reel_jobs_agency_created_idx
  on reel_jobs (agency_id, created_at desc);

-- Only the service role touches reel_jobs: api/reel.js runs every read and
-- write with it, exactly as api/generate.js does for marketing trials. No
-- browser session reaches this table directly.
alter table reel_jobs enable row level security;

-- --- Permanent home for finished clips ---------------------------------------
-- Public-read because the clips end up composited into a Reel the agency
-- publishes to Instagram anyway, and a public URL is what the canvas renderer
-- can load cross-origin without a signing round-trip. Nothing private lands
-- here — these are marketing videos of a listing that is already public.
insert into storage.buckets (id, name, public)
values ('reel-clips', 'reel-clips', true)
on conflict (id) do nothing;

-- Read is open (the bucket is public); writes are service-role only, so an
-- agency cannot upload arbitrary video into our storage bill.
drop policy if exists "reel clips are publicly readable" on storage.objects;
create policy "reel clips are publicly readable"
  on storage.objects for select
  using (bucket_id = 'reel-clips');
