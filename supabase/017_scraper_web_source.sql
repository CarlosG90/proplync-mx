-- 017 · the own-scraper source
-- Adds the crawl source `scraper_web`: a Python worker (mexico_scout_platform/src/worker.py) reads a few agency sites that serve plain
-- visitors (through their sitemaps), and the Node crawler (ingest/adapters/index.js) sends what it finds through the normal index writer.
-- It is FREE to run (no Apify), so there is no budget; politeness is the worker's job: robots.txt, an allow-list, randomised delays and
-- a per-run page cap (max_results_per_run).
--
-- Ships DISABLED. Switch it on deliberately, after a dry run:
--   node ingest/run.mjs --source scraper_web --dry-run --max 10
--   update search_sources set enabled = true where id = 'scraper_web';
-- Switch it off the same way. display_mode 'facts_link' shows facts and a link to the source, not the description.
-- Idempotent: safe to run twice.

insert into search_sources (id, name, runner, enabled, display_mode, max_results_per_run, monthly_budget_usd)
values ('scraper_web', 'Sitios de agencias', 'self', false, 'facts_link', 80, 0)
on conflict (id) do nothing;
