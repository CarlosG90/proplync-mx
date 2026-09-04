-- Proplync.mx · Add agency WhatsApp number
-- Run once in Supabase Studio's SQL editor, after schema.sql.
-- No migration tooling — matches this repo's zero-tooling philosophy elsewhere.

-- E.164 format (e.g. '+529981234567'), used to build wa.me click-to-chat
-- links on the public property page so buyer inquiries reach the agent's
-- WhatsApp directly instead of only landing in the web leads inbox.
alter table agencies add column if not exists whatsapp_number text;
