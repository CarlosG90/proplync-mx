-- Proplync.mx · Marca de agua: bucket privado para las fotos originales
-- =============================================================================
-- El asesor hace el levantamiento fotografico de la propiedad a su costa y
-- luego otro asesor le toma las fotos de donde las publico. La marca de agua
-- vuelve ese robo inutil.
--
-- La foto se marca en el navegador antes de subirla, asi que lo que vive en
-- 'listing-photos' (publico) ya viene marcado y no existe una version limpia
-- accesible desde internet. La original se guarda aqui, en un bucket PRIVADO,
-- por si la agencia cambia de logo o necesita el archivo limpio despues.
--
-- Publico y privado importan: si la original viviera en el mismo bucket con el
-- mismo nombre de archivo, bastaria adivinar la ruta para saltarse la marca, y
-- toda la funcion seria decorativa.
-- =============================================================================

insert into storage.buckets (id, name, public) values ('listing-originals','listing-originals', false)
  on conflict (id) do nothing;

-- Mismo criterio que listing-photos: la primera carpeta de la ruta es el id de
-- la agencia, y solo esa agencia entra. La diferencia es que aqui tampoco hay
-- lectura publica.
drop policy if exists listing_originals_agency_read on storage.objects;
create policy listing_originals_agency_read on storage.objects for select
  using (bucket_id = 'listing-originals' and (storage.foldername(name))[1] = get_my_agency_id()::text);

drop policy if exists listing_originals_agency_write on storage.objects;
create policy listing_originals_agency_write on storage.objects for insert
  with check (bucket_id = 'listing-originals' and (storage.foldername(name))[1] = get_my_agency_id()::text);

drop policy if exists listing_originals_agency_manage on storage.objects;
create policy listing_originals_agency_manage on storage.objects for update
  using (bucket_id = 'listing-originals' and (storage.foldername(name))[1] = get_my_agency_id()::text);

drop policy if exists listing_originals_agency_delete on storage.objects;
create policy listing_originals_agency_delete on storage.objects for delete
  using (bucket_id = 'listing-originals' and (storage.foldername(name))[1] = get_my_agency_id()::text);
