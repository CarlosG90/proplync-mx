-- 016 · scout_runs.progress
-- What Scout is doing right now, for the buyer to watch: each search it runs, each page it opens, and where it
-- could not read one. The /brief page shows it while a run is active ("Searching: ...", "Reading: ...").
--
-- WHAT IT HOLDS: a short JSON array of events (kind, a clipped search phrase or page title, a site name). At most
-- 40 events and 16 KB; the engine trims it. WHAT IT NEVER HOLDS: contact details, prices the agent has not
-- published, or anything from the buyer. The text is the model's own words about public pages, so the page
-- draws it with textContent, never as HTML.
--
-- scout_runs has RLS on and no policies: only the service role reads or writes it, and the status endpoint
-- decides what leaves. Apply this BEFORE deploying the code that writes it. The code also copes if the column
-- is missing (the progress writes fail quietly and the status endpoint answers without it).
-- Idempotent: safe to run twice.

alter table scout_runs
  add column if not exists progress jsonb not null default '[]'::jsonb
  check (jsonb_typeof(progress) = 'array' and pg_column_size(progress) <= 16384);
