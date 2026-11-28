-- Proplync.mx · 021 · Mini: the owner's WhatsApp assistant (training + conversation log)
-- -----------------------------------------------------------------------------
-- WHY THIS EXISTS
-- A Mini customer's clients write on WhatsApp. The assistant answers them at any
-- hour from what the owner taught it (mini/api/_bot.js), says it is an assistant,
-- and hands the chat to the owner for anything it doesn't know or must not
-- promise. mini_bot is what the owner teaches it in the panel; mini_bot_messages
-- is the conversation log the owner reviews (and the bot's short memory).
--
-- WHY IT STAYS FREE
-- It only replies to people who wrote first (Meta's free service messages, first
-- 1,000 a month per number) and never starts a conversation (templates cost).
-- monthly_cap stops the bot before the free tier ends; the owner keeps answering
-- by hand in the WhatsApp app (coexistence).
--
-- WHY wa_phone_number_id
-- Meta's webhook says which business number a message reached. That id maps the
-- message to one agency. Unique: one number, one bot. Null = not connected yet.
--
-- Idempotent: safe to run twice.
-- -----------------------------------------------------------------------------

create table if not exists mini_bot (
  agency_id uuid primary key references agencies(id) on delete cascade,
  enabled boolean not null default false,
  tone text not null default 'usted' check (tone in ('usted', 'tu')),
  hours text check (hours is null or length(hours) <= 300),
  area text check (area is null or length(area) <= 300),
  never text check (never is null or length(never) <= 800),
  handoff text check (handoff is null or length(handoff) <= 300),
  faq jsonb not null default '[]'::jsonb check (jsonb_typeof(faq) = 'array' and jsonb_array_length(faq) <= 40),
  extra text check (extra is null or length(extra) <= 4000),
  monthly_cap integer not null default 950 check (monthly_cap between 0 and 100000),
  wa_phone_number_id text unique,
  updated_at timestamptz not null default now()
);

create table if not exists mini_bot_messages (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  channel text not null default 'whatsapp' check (channel in ('whatsapp')),
  -- The client's WhatsApp number: the owner's own client, shown only to the owner.
  contact text not null check (length(contact) <= 30),
  role text not null check (role in ('user', 'bot')),
  body text not null check (length(body) <= 4000),
  handoff boolean not null default false,
  -- Meta retries a webhook; the message id makes a retry a no-op.
  wa_message_id text unique,
  created_at timestamptz not null default now()
);

create index if not exists mini_bot_messages_chat_idx on mini_bot_messages (agency_id, contact, created_at desc);
create index if not exists mini_bot_messages_month_idx on mini_bot_messages (agency_id, created_at) where role = 'bot';

-- The owner's own rows only. The webhook writes with the service role.
alter table mini_bot enable row level security;
alter table mini_bot_messages enable row level security;

drop policy if exists mini_bot_select_own on mini_bot;
create policy mini_bot_select_own on mini_bot for select using (agency_id = get_my_agency_id());
drop policy if exists mini_bot_insert_own on mini_bot;
create policy mini_bot_insert_own on mini_bot for insert with check (agency_id = get_my_agency_id());
drop policy if exists mini_bot_update_own on mini_bot;
create policy mini_bot_update_own on mini_bot for update
  using (agency_id = get_my_agency_id()) with check (agency_id = get_my_agency_id());

drop policy if exists mini_bot_messages_select_own on mini_bot_messages;
create policy mini_bot_messages_select_own on mini_bot_messages for select using (agency_id = get_my_agency_id());
