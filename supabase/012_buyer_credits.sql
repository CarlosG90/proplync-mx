-- Proplync.mx · Buyer credits: the quota that pays for Scout and verification
-- Run once, after 011_search_maintenance.sql. Idempotent.
--
-- WHY THIS EXISTS
-- Concierge used to end with "a person will contact you". Now the brief hands
-- straight to Scout on the same page, and credits are what pay for it:
--   - the first Scout search per buyer is free
--   - every further search costs 1 credit
--   - asking a person to verify a property with its agent costs 1 credit
--   - credits come in packs (Stripe) or are granted by hand (scripts/credits.mjs)
--
-- HOW IT STAYS HONEST
-- Every change to a balance is a row in credit_ledger, written in the same
-- transaction as the balance update, so the balance can always be audited.
-- spend_credit() locks the wallet row: two tabs cannot spend the same credit.
-- add_credits() is idempotent on (reason, ref): a Stripe webhook delivered
-- twice adds the pack once. Only the service role can call either; the
-- browser sees balances through api/finder.js.

create table if not exists buyer_wallets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  credits integer not null default 0 check (credits >= 0),
  free_search_used boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists credit_ledger (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  delta integer not null,
  --  free_search : the first search, used (delta 0)
  --  purchase    : a pack bought (ref = Stripe checkout session id)
  --  search      : a Scout search (ref = scout run id)
  --  verify      : a verification request (ref = scout candidate id)
  --  manual      : granted by an operator (ref = a note)
  --  refund      : given back when a paid Scout run failed (ref = run id)
  reason text not null check (reason in ('free_search','purchase','search','verify','manual','refund')),
  ref text,
  balance_after integer not null,
  created_at timestamptz not null default now()
);
create index if not exists credit_ledger_user_idx on credit_ledger (user_id, created_at desc);
-- A purchase or a refund is applied exactly once per reference.
create unique index if not exists credit_ledger_once_idx on credit_ledger (reason, ref) where reason in ('purchase', 'refund');

alter table buyer_briefs add column if not exists user_id uuid references auth.users(id) on delete set null;
create index if not exists buyer_briefs_user_idx on buyer_briefs (user_id, created_at desc);

alter table scout_runs add column if not exists user_id uuid references auth.users(id) on delete set null;
alter table scout_runs add column if not exists charged text check (charged in ('free', 'credit', 'operator'));

alter table scout_candidates add column if not exists verify_requested_at timestamptz;
alter table scout_candidates add column if not exists verify_requested_by uuid references auth.users(id) on delete set null;

alter table buyer_wallets enable row level security;
alter table credit_ledger enable row level security;

/* Spend one unit of quota. For a search, the free first search is used
   before any credit. Returns {ok, free, credits} or {ok:false, error, credits}. */
create or replace function public.spend_credit(p_user uuid, p_reason text, p_ref text)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  w buyer_wallets%rowtype;
begin
  if p_reason not in ('search', 'verify') then
    raise exception 'spend_credit: unknown reason %', p_reason;
  end if;
  insert into buyer_wallets (user_id) values (p_user) on conflict (user_id) do nothing;
  select * into w from buyer_wallets where user_id = p_user for update;

  if p_reason = 'search' and not w.free_search_used then
    update buyer_wallets set free_search_used = true, updated_at = now() where user_id = p_user;
    insert into credit_ledger (user_id, delta, reason, ref, balance_after) values (p_user, 0, 'free_search', p_ref, w.credits);
    return jsonb_build_object('ok', true, 'free', true, 'credits', w.credits);
  end if;

  if w.credits < 1 then
    return jsonb_build_object('ok', false, 'error', 'insufficient_credits', 'credits', w.credits, 'free_search_used', w.free_search_used);
  end if;

  update buyer_wallets set credits = credits - 1, updated_at = now() where user_id = p_user;
  insert into credit_ledger (user_id, delta, reason, ref, balance_after) values (p_user, -1, p_reason, p_ref, w.credits - 1);
  return jsonb_build_object('ok', true, 'free', false, 'credits', w.credits - 1);
end;
$$;

/* Add (or, for a refund of the free search, restore) quota. Idempotent for
   purchases and refunds: the same (reason, ref) is applied once. */
create or replace function public.add_credits(p_user uuid, p_delta integer, p_reason text, p_ref text, p_restore_free boolean default false)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  w buyer_wallets%rowtype;
  v_after integer;
begin
  if p_reason not in ('purchase', 'manual', 'refund') then
    raise exception 'add_credits: unknown reason %', p_reason;
  end if;
  if p_delta < 0 then raise exception 'add_credits: negative delta'; end if;
  if p_reason in ('purchase', 'refund') and exists (select 1 from credit_ledger where reason = p_reason and ref = p_ref) then
    select * into w from buyer_wallets where user_id = p_user;
    return jsonb_build_object('ok', true, 'duplicate', true, 'credits', coalesce(w.credits, 0));
  end if;

  insert into buyer_wallets (user_id) values (p_user) on conflict (user_id) do nothing;
  select * into w from buyer_wallets where user_id = p_user for update;
  v_after := w.credits + p_delta;
  update buyer_wallets
     set credits = v_after,
         free_search_used = case when p_restore_free then false else free_search_used end,
         updated_at = now()
   where user_id = p_user;
  insert into credit_ledger (user_id, delta, reason, ref, balance_after) values (p_user, p_delta, p_reason, p_ref, v_after);
  return jsonb_build_object('ok', true, 'duplicate', false, 'credits', v_after);
end;
$$;

revoke all on function public.spend_credit(uuid, text, text) from public, anon, authenticated;
revoke all on function public.add_credits(uuid, integer, text, text, boolean) from public, anon, authenticated;
grant execute on function public.spend_credit(uuid, text, text) to service_role;
grant execute on function public.add_credits(uuid, integer, text, text, boolean) to service_role;
