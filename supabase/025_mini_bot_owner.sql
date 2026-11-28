-- Proplync.mx · 025 · Mini assistant: the owner's own replies (WhatsApp coexistence)
-- -----------------------------------------------------------------------------
-- WHY THIS EXISTS
-- With coexistence the owner keeps the WhatsApp Business app on the same number;
-- Meta mirrors what they send from the app to our webhook (field
-- smb_message_echoes). Those are logged as role 'owner', and an owner reply makes
-- the assistant stay quiet in that chat (mini/api/whatsapp.js), so it never talks
-- over the owner. Idempotent.
-- -----------------------------------------------------------------------------
alter table mini_bot_messages drop constraint if exists mini_bot_messages_role_check;
alter table mini_bot_messages add constraint mini_bot_messages_role_check check (role in ('user', 'bot', 'owner'));
