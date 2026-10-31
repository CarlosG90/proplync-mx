-- Proplync.mx · Five free Scout searches per buyer (was one)
-- Run once, after 012_buyer_credits.sql. Idempotent.
--
-- WHY THIS EXISTS
-- One free search was too tight: a buyer who refined their brief once hit the paywall
-- before seeing what Scout can do. Every buyer now gets 5 free searches; after that a
-- search costs 1 credit, as before. Verification requests still cost 1 credit.
-- Concierge (the interview) never cost credits, so it is unchanged.
--
-- WHY A COUNTER AND NOT A NEW BOOLEAN
-- free_searches_used counts the free searches spent. The old free_search_used flag is
-- kept and mirrors "all 5 used", so code deployed before this migration (which only
-- reads the flag) keeps working. That is why the migration can run before the deploy.
-- Buyers who had already spent their one free search have 1 of 5 used, so they get 4 more.
--
-- To change the number later, change free_limit in spend_credit() and
-- FREE_SEARCHES in api/finder.js (the wallet endpoint reports what is left).

alter table buyer_wallets add column if not exists free_searches_used integer not null default 0 check (free_searches_used >= 0);
update buyer_wallets set free_searches_used = 1 where free_search_used and free_searches_used = 0;
update buyer_wallets set free_search_used = (free_searches_used >= 5);

create or replace function public.spend_credit(p_user uuid, p_reason text, p_ref text)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  w buyer_wallets%rowtype;
  free_limit constant integer := 5;
begin
  if p_reason not in ('search', 'verify') then
    raise exception 'spend_credit: unknown reason %', p_reason;
  end if;
  insert into buyer_wallets (user_id) values (p_user) on conflict (user_id) do nothing;
  select * into w from buyer_wallets where user_id = p_user for update;

  if p_reason = 'search' and w.free_searches_used < free_limit then
    update buyer_wallets
       set free_searches_used = w.free_searches_used + 1,
           free_search_used = (w.free_searches_used + 1 >= free_limit),
           updated_at = now()
     where user_id = p_user;
    insert into credit_ledger (user_id, delta, reason, ref, balance_after) values (p_user, 0, 'free_search', p_ref, w.credits);
    return jsonb_build_object('ok', true, 'free', true, 'credits', w.credits, 'free_left', free_limit - w.free_searches_used - 1);
  end if;

  if w.credits < 1 then
    return jsonb_build_object('ok', false, 'error', 'insufficient_credits', 'credits', w.credits, 'free_search_used', w.free_searches_used >= free_limit);
  end if;

  update buyer_wallets set credits = credits - 1, updated_at = now() where user_id = p_user;
  insert into credit_ledger (user_id, delta, reason, ref, balance_after) values (p_user, -1, p_reason, p_ref, w.credits - 1);
  return jsonb_build_object('ok', true, 'free', false, 'credits', w.credits - 1);
end;
$$;

/* p_restore_free now gives back ONE free search (a failed free run), not all of them. */
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
         free_searches_used = case when p_restore_free then greatest(free_searches_used - 1, 0) else free_searches_used end,
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
