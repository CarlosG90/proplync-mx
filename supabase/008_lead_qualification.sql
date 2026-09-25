-- Proplync.mx · Calificacion del interesado en el formulario de contacto
-- =============================================================================
-- Calificacion del interesado
-- =============================================================================
-- El asesor pierde entre 30 minutos y una hora trasladandose a enseñar una
-- propiedad a alguien que no puede comprarla: no le alcanza para el credito,
-- no tiene el enganche, o buscaba otra cosa. Tres preguntas antes del contacto
-- no sustituyen la calificacion real, pero ordenan la lista de a quien llamar
-- primero.
--
-- Las tres son opcionales a proposito. Un formulario que exige respuestas
-- ahuyenta al interesado bueno igual que al malo, y un lead sin calificar
-- sigue siendo un lead.
alter table leads add column if not exists payment_method text
  check (payment_method in ('efectivo','credito','no_se'));
alter table leads add column if not exists purpose text
  check (purpose in ('habitar','inversion','reventa','renta'));
alter table leads add column if not exists mortgage_history text
  check (mortgage_history in ('tiene','tuvo','nunca'));
