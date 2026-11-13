-- Proplync.mx · 018 · Mini pages: the agent's card, and a plan that can expire
-- -----------------------------------------------------------------------------
-- WHY THIS EXISTS
-- A competitor's ad sells "all your properties in one link, with your brand" as a
-- one-time product: an agent card (WhatsApp, call, email, location, services) plus
-- up to 10 properties, built by hand within 24 hours. /agencia/:slug already is
-- that page, minus the card fields and a way to sell it on its own. This adds the
-- card fields and a `mini` plan that can expire, so the page can be offered
-- self-serve from an ad (docs/CONTEXT-MAP.md, "Mini pages").
--
-- plan_expires_at is null for every existing agency: nothing changes for them.
-- Only the mini free trial gets a date; once it passes, the public page shows a
-- paused notice and hides the listings (api/search.js ?agency=). Nothing is
-- deleted, and the dashboard keeps working so the agent can pay or upgrade.
--
-- cover_url exists in production but had no migration; `if not exists` records it.
-- Idempotent: safe to run twice.
-- -----------------------------------------------------------------------------

alter table agencies
  add column if not exists cover_url text,
  add column if not exists phone text,
  add column if not exists public_email text,
  add column if not exists address text,
  add column if not exists maps_url text,
  add column if not exists services text[] not null default '{}',
  add column if not exists bio text,
  add column if not exists plan_expires_at timestamptz;

comment on column agencies.plan_expires_at is
  'When set and in the past the public page is paused (listings hidden, data kept). Null = no expiry.';

-- The plan checks were created inline with their columns (005), so they carry
-- the default names. Widened, not relaxed: still a closed list.
alter table agencies drop constraint if exists agencies_plan_check;
alter table agencies add constraint agencies_plan_check
  check (plan in ('free', 'pro', 'vip', 'mini'));

alter table signup_invites drop constraint if exists signup_invites_plan_check;
alter table signup_invites add constraint signup_invites_plan_check
  check (plan in ('free', 'pro', 'vip', 'mini'));
