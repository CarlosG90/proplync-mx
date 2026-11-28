-- Proplync.mx · 023 · Mini card: profession line and social links
-- -----------------------------------------------------------------------------
-- WHY THIS EXISTS
-- The competing "digital card" offer (Logo tu marca, seen 2026-11-28) shows a
-- profession line under the name ("ODONTÓLOGA") and a contact row per social
-- network. A Mini page is a business card first, so it carries the same:
--   profession: short line under the name ("Valuador certificado").
--   instagram / facebook / tiktok: a handle (@gael.inmobiliaria) or a profile URL.
--   website: the business's own site (http/https only).
-- Rules for what may be stored: api/_lib/listing-fields.js validateAgencyFields.
-- Idempotent: safe to run twice.
-- -----------------------------------------------------------------------------

alter table agencies
  add column if not exists profession text check (profession is null or length(profession) <= 80),
  add column if not exists instagram text check (instagram is null or length(instagram) <= 200),
  add column if not exists facebook text check (facebook is null or length(facebook) <= 200),
  add column if not exists tiktok text check (tiktok is null or length(tiktok) <= 200),
  add column if not exists website text check (website is null or length(website) <= 300);
