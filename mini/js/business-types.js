/**
 * PropLync Mini · business types (templates)
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * Mini started as "all your properties in one link" for real-estate agents. Any
 * person who provides services can now make their page, so each kind of business
 * has a template: what the page calls itself, whether it shows properties, the
 * services we suggest, the WhatsApp greeting, and (for the case CRM) the job types
 * with their stages. agencies.business_type (supabase/019) picks one; `general` is
 * the fallback for any trade that isn't listed, so nobody is turned away.
 *
 * WHY A CLASSIC SCRIPT AND NOT AN ES MODULE
 * The Mini pages are plain <script> pages with no build step, and the functions
 * need the same list to validate a save. A classic script that sets
 * globalThis.MINI_TYPES runs in both: browsers load it with <script src>, and
 * mini/api/_business-types.js imports it for the side effect and re-exports it.
 * One list, no copy to drift.
 * -----------------------------------------------------------------------------
 */
(function (root) {
  'use strict';

  /* s(title_es, title_en, price_kind): one suggested service. */
  function s(es, en, kind) { return { title_es: es, title_en: en, price_kind: kind || 'quote' }; }
  /* c(name, stages): one job type for the case CRM, with its steps in order. */
  function c(name, stages) { return { name: name, stages: stages }; }

  var TYPES = {
    real_estate: {
      key: 'real_estate',
      label: ['Inmobiliaria y gestoría', 'Real estate and paperwork'],
      hint: ['Venta y renta, avalúos, trámites, planos', 'Sales and rentals, appraisals, paperwork, drawings'],
      eyebrow: ['Inmobiliaria y servicios', 'Real estate and services'],
      hasListings: true,
      greeting: ['Hola, vi tu página y quiero más información.', 'Hi, I saw your page and would like more information.'],
      services: [
        s('Avalúos comerciales e hipotecarios (Infonavit, Fovissste)', 'Commercial and mortgage appraisals (Infonavit, Fovissste)'),
        s('Gestiones en ayuntamiento: catastro, desarrollo urbano, registro público', 'City hall paperwork: cadastre, urban development, public registry'),
        s('Venta y renta de propiedades', 'Property sales and rentals'),
        s('Planos arquitectónicos', 'Architectural drawings'),
        s('Levantamiento topográfico', 'Topographic survey'),
        s('Medición de terreno', 'Land measurement'),
        s('Gestión ante Infonavit y Fovissste', 'Infonavit and Fovissste paperwork'),
        s('Gestión ante notaría', 'Notary paperwork')
      ],
      cases: [
        c('Avalúo comercial / hipotecario', ['Solicitud y documentos', 'Visita al inmueble', 'Elaboración', 'Revisión de la unidad de valuación', 'Entregado']),
        c('Gestión en ayuntamiento', ['Documentos recibidos', 'Ingresado', 'En revisión', 'Observaciones', 'Resuelto']),
        c('Venta / renta', ['Captación', 'Publicado', 'Visitas', 'Oferta', 'Contrato o escritura', 'Cerrado']),
        c('Planos arquitectónicos', ['Levantamiento', 'Anteproyecto', 'Revisión con el cliente', 'Planos finales', 'Entregado']),
        c('Levantamiento topográfico', ['Agendado', 'Trabajo de campo', 'Procesamiento', 'Plano entregado']),
        c('Medición de terreno', ['Agendado', 'Medición', 'Croquis entregado']),
        c('Gestión Infonavit / Fovissste', ['Precalificación', 'Documentos', 'Avalúo e inscripción', 'Firma', 'Crédito ejercido']),
        c('Gestión ante notaría', ['Documentos', 'Proyecto de escritura', 'Firma', 'Inscripción en el registro', 'Escritura entregada'])
      ]
    },
    professional: {
      key: 'professional',
      label: ['Servicios profesionales', 'Professional services'],
      hint: ['Abogado, contador, arquitecto, valuador, consultor', 'Lawyer, accountant, architect, appraiser, consultant'],
      eyebrow: ['Servicios profesionales', 'Professional services'],
      hasListings: false,
      greeting: ['Hola, vi tu página y quiero una cotización.', 'Hi, I saw your page and would like a quote.'],
      services: [
        s('Consulta inicial', 'Initial consultation', 'fixed'),
        s('Asesoría', 'Advisory', 'from'),
        s('Trámite o gestión', 'Paperwork handling'),
        s('Proyecto a la medida', 'Custom project')
      ],
      cases: [
        c('Asesoría', ['Primera consulta', 'Propuesta enviada', 'En proceso', 'Entregado']),
        c('Trámite', ['Documentos recibidos', 'Ingresado', 'En revisión', 'Resuelto']),
        c('Proyecto', ['Cotización', 'Anticipo', 'En desarrollo', 'Revisión con el cliente', 'Entregado'])
      ]
    },
    trades: {
      key: 'trades',
      label: ['Oficios y hogar', 'Trades and home services'],
      hint: ['Plomería, electricidad, limpieza, jardinería', 'Plumbing, electrical, cleaning, gardening'],
      eyebrow: ['Servicios para tu hogar', 'Home services'],
      hasListings: false,
      greeting: ['Hola, vi tu página y necesito un servicio.', 'Hi, I saw your page and need a service.'],
      services: [
        s('Visita y diagnóstico', 'Visit and diagnosis', 'fixed'),
        s('Reparación', 'Repair', 'from'),
        s('Instalación', 'Installation', 'from'),
        s('Mantenimiento', 'Maintenance', 'from')
      ],
      cases: [
        c('Servicio', ['Agendado', 'Visita', 'Cotización aceptada', 'En trabajo', 'Terminado']),
        c('Mantenimiento', ['Agendado', 'Realizado', 'Pagado'])
      ]
    },
    beauty: {
      key: 'beauty',
      label: ['Belleza y bienestar', 'Beauty and wellness'],
      hint: ['Estética, uñas, masajes, entrenamiento', 'Salon, nails, massage, training'],
      eyebrow: ['Belleza y bienestar', 'Beauty and wellness'],
      hasListings: false,
      greeting: ['Hola, vi tu página y quiero agendar una cita.', 'Hi, I saw your page and would like to book.'],
      services: [
        s('Corte y peinado', 'Cut and style', 'from'),
        s('Manicure y pedicure', 'Manicure and pedicure', 'from'),
        s('Masaje', 'Massage', 'fixed'),
        s('Paquete', 'Package', 'fixed')
      ],
      cases: [
        c('Cita', ['Agendada', 'Confirmada', 'Atendida', 'Pagada']),
        c('Paquete', ['Vendido', 'En curso', 'Terminado'])
      ]
    },
    general: {
      key: 'general',
      label: ['Otro servicio', 'Other service'],
      hint: ['Cualquier persona que ofrece servicios', 'Anyone who offers services'],
      eyebrow: ['Servicios', 'Services'],
      hasListings: false,
      greeting: ['Hola, vi tu página y quiero más información.', 'Hi, I saw your page and would like more information.'],
      services: [],
      cases: [
        c('Servicio', ['Recibido', 'En proceso', 'Terminado'])
      ]
    }
  };

  var KEYS = ['real_estate', 'professional', 'trades', 'beauty', 'general'];
  /** The template for a stored business_type; anything unknown is `general`, except a missing one (old rows) which is real estate. */
  function typeFor(key) {
    if (key == null || key === '') return TYPES.real_estate;
    return TYPES[key] || TYPES.general;
  }

  root.MINI_TYPES = { TYPES: TYPES, KEYS: KEYS, typeFor: typeFor };
})(typeof window !== 'undefined' ? window : globalThis);
