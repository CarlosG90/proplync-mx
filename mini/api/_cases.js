/**
 * PropLync Mini · the owner's client CRM ("Clientes"): jobs per service, fed by WhatsApp
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * The owner tracks each client and job by service: which step it's on, what was
 * charged, the deposit, the balance, the commission (mini_cases, supabase/022).
 * New WhatsApp conversations arrive here as leads (leadFromWhatsApp), so the
 * assistant's chats and the owner's jobs live in one list.
 *
 * WHY STAGES ARE PER SERVICE
 * An appraisal goes "Solicitud → Visita → Elaboración → Revisión → Entregado";
 * a notary procedure has other steps. Each service carries its steps
 * (mini_services.stages); without its own, the business template's steps for the
 * matching suggested service apply (mini/js/business-types.js), else a generic
 * three. A job's stage must be one of its service's steps.
 *
 * A MONTHLY ADD-ON (plans.js crmActive): writes need agencies.crm_until in the
 * future, reads never stop. Routed from mini/api/panel.js ?resource=cases.
 * -----------------------------------------------------------------------------
 */

import { crmActive } from './_proplync/_lib/plans.js';
import { typeFor } from './_business-types.js';

export const CASE_FIELDS = 'id, service_id, source, status, stage, client_name, client_phone, address, started_on, finished_on, ' +
  'fee, advance, balance, sale_price, commission, commission_paid_on, notes, created_at, updated_at';
export const GENERIC_STAGES = ['Nuevo', 'En proceso', 'Terminado'];
const STATUSES = ['lead', 'open', 'done', 'cancelled'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE = /^[0-9+()\-\s]{6,30}$/;
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/** A service's steps: its own, else its template twin's, else generic. Pure, for tests. */
export function stagesFor(service, businessType) {
  if (service && Array.isArray(service.stages) && service.stages.length >= 2) return service.stages;
  const ty = typeFor(businessType);
  if (service && service.title_es) {
    const i = ty.services.findIndex((x) => norm(x.title_es) === norm(service.title_es));
    if (i >= 0 && ty.cases[i]) return ty.cases[i].stages;
  }
  return GENERIC_STAGES;
}

/** A list of steps the owner typed for a service → clean, or { error }. Pure, for tests. */
export function cleanStages(v) {
  if (v === null) return { stages: null };
  if (!Array.isArray(v)) return { error: 'invalid_stages' };
  const out = [];
  for (const s of v) {
    const t = typeof s === 'string' ? s.trim() : '';
    if (!t) continue;
    if (t.length > 80) return { error: 'stage_too_long' };
    if (!out.includes(t)) out.push(t);
  }
  if (out.length < 2 || out.length > 12) return { error: 'invalid_stages' };
  return { stages: out };
}

const money = (v, code) => {
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e11) throw new Error('invalid_' + code);
  return Math.round(n * 100) / 100;
};
const text = (v, max, code) => {
  if (v === null || v === '') return null;
  if (typeof v !== 'string') throw new Error('invalid_' + code);
  const s = v.trim();
  if (s.length > max) throw new Error(code + '_too_long');
  return s || null;
};
const day = (v, code) => {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !DATE.test(v) || !Number.isFinite(Date.parse(v))) throw new Error('invalid_' + code);
  return v;
};

/**
 * The panel's form → a clean row, or { error }. Only the fields sent are kept
 * (partial for updates). `stages` is the step list of the job's service; a stage
 * outside it is refused. Pure, for tests.
 */
export function cleanCase(body, { stages = null } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  try {
    if (b.service_id !== undefined) {
      if (b.service_id === null || b.service_id === '') out.service_id = null;
      else if (typeof b.service_id !== 'string' || !UUID.test(b.service_id)) return { error: 'invalid_service' };
      else out.service_id = b.service_id;
    }
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) return { error: 'invalid_status' };
      out.status = b.status;
    }
    if (b.stage !== undefined) {
      out.stage = text(b.stage, 80, 'stage');
      if (out.stage && stages && !stages.includes(out.stage)) return { error: 'invalid_stage' };
    }
    if (b.client_name !== undefined) out.client_name = text(b.client_name, 120, 'client_name');
    if (b.client_phone !== undefined) {
      out.client_phone = text(b.client_phone, 30, 'client_phone');
      if (out.client_phone && !PHONE.test(out.client_phone)) return { error: 'invalid_client_phone' };
    }
    if (b.address !== undefined) out.address = text(b.address, 200, 'address');
    if (b.notes !== undefined) out.notes = text(b.notes, 4000, 'notes');
    for (const k of ['started_on', 'finished_on', 'commission_paid_on']) if (b[k] !== undefined) out[k] = day(b[k], k);
    for (const k of ['fee', 'advance', 'sale_price', 'commission']) if (b[k] !== undefined) out[k] = money(b[k], k);
  } catch (err) {
    return { error: err.message };
  }
  if (out.fee != null && out.advance != null && out.advance > out.fee) return { error: 'advance_over_fee' };
  if (out.started_on && out.finished_on && out.finished_on < out.started_on) return { error: 'finished_before_start' };
  return { row: out };
}

/** Totals for the panel's strip, per service too. Pure, for tests. */
export function summarize(cases) {
  const s = { leads: 0, open: 0, done: 0, owed: 0, commissions_pending: 0, by_service: {} };
  for (const c of cases || []) {
    const k = c.service_id || 'none';
    s.by_service[k] = (s.by_service[k] || 0) + 1;
    if (c.status === 'lead') s.leads++;
    if (c.status === 'open') s.open++;
    if (c.status === 'done') s.done++;
    if (c.status !== 'cancelled' && Number(c.balance) > 0) s.owed += Number(c.balance);
    if (c.status !== 'cancelled' && Number(c.commission) > 0 && !c.commission_paid_on) s.commissions_pending += Number(c.commission);
  }
  s.owed = Math.round(s.owed * 100) / 100;
  s.commissions_pending = Math.round(s.commissions_pending * 100) / 100;
  return s;
}

async function agencyRow(svc, agencyId) {
  const { data, error } = await svc.from('agencies').select('id, business_type, crm_until, plan').eq('id', agencyId).maybeSingle();
  if (error) throw error;
  return data;
}
async function serviceRow(svc, agencyId, serviceId) {
  if (!serviceId) return null;
  const { data, error } = await svc.from('mini_services').select('id, title_es, stages').eq('id', serviceId).eq('agency_id', agencyId).maybeSingle();
  if (error) throw error;
  return data || false;   // false = not this owner's service
}

/**
 * GET (list + summary + each service's steps) · POST · PUT ?id= · DELETE ?id=.
 * PUT ?service=<id>&stages=1 saves a service's own steps.
 */
export async function handleCases(req, res, { auth, svc, now = Date.now() }) {
  const q = req.query || {};
  const id = q.id;
  if (id !== undefined && !UUID.test(String(id))) { res.status(400).json({ error: 'invalid_id' }); return; }
  const agency = await agencyRow(svc, auth.agencyId);
  if (!agency) { res.status(404).json({ error: 'not_found' }); return; }
  const active = crmActive(agency, now);

  if (req.method === 'GET') {
    const [cs, sv] = await Promise.all([
      svc.from('mini_cases').select(CASE_FIELDS).eq('agency_id', auth.agencyId).order('created_at', { ascending: false }).limit(500),
      svc.from('mini_services').select('id, title_es, stages, sort').eq('agency_id', auth.agencyId).order('sort', { ascending: true })
    ]);
    if (cs.error) throw cs.error;
    if (sv.error) throw sv.error;
    const services = (sv.data || []).map((x) => ({ id: x.id, title: x.title_es, stages: stagesFor(x, agency.business_type), custom: Array.isArray(x.stages) && x.stages.length >= 2 }));
    res.status(200).json({ active, crm_until: agency.crm_until || null, cases: cs.data || [], services, generic_stages: GENERIC_STAGES, summary: summarize(cs.data) });
    return;
  }

  // Everything below writes: the add-on must be active.
  if (!active) { res.status(402).json({ error: 'upgrade_required' }); return; }

  if ((req.method === 'PUT' || req.method === 'PATCH') && q.stages && q.service) {
    if (!UUID.test(String(q.service))) { res.status(400).json({ error: 'invalid_service' }); return; }
    const { stages, error } = cleanStages(req.body && req.body.stages);
    if (error) { res.status(400).json({ error }); return; }
    const { data, error: uErr } = await svc.from('mini_services').update({ stages }).eq('id', q.service).eq('agency_id', auth.agencyId).select('id').maybeSingle();
    if (uErr) throw uErr;
    if (!data) { res.status(404).json({ error: 'not_found' }); return; }
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    let current = null;
    if (req.method !== 'POST') {
      if (!id) { res.status(400).json({ error: 'missing_id' }); return; }
      const { data, error } = await svc.from('mini_cases').select('id, service_id').eq('id', id).eq('agency_id', auth.agencyId).maybeSingle();
      if (error) throw error;
      if (!data) { res.status(404).json({ error: 'not_found' }); return; }
      current = data;
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const serviceId = body.service_id !== undefined ? body.service_id : current && current.service_id;
    const service = await serviceRow(svc, auth.agencyId, serviceId && UUID.test(String(serviceId)) ? serviceId : null);
    if (service === false) { res.status(400).json({ error: 'invalid_service' }); return; }
    const { row, error } = cleanCase(body, { stages: stagesFor(service, agency.business_type) });
    if (error) { res.status(400).json({ error }); return; }
    if (req.method === 'POST') {
      if (!row.client_name && !row.client_phone) { res.status(400).json({ error: 'missing_client' }); return; }
      const { data, error: iErr } = await svc.from('mini_cases')
        .insert({ status: 'open', ...row, agency_id: auth.agencyId, source: 'manual' }).select(CASE_FIELDS).single();
      if (iErr) throw iErr;
      res.status(201).json({ case: data });
      return;
    }
    if (!Object.keys(row).length) { res.status(400).json({ error: 'nothing_to_update' }); return; }
    const { data, error: uErr } = await svc.from('mini_cases').update(row).eq('id', id).eq('agency_id', auth.agencyId).select(CASE_FIELDS).maybeSingle();
    if (uErr) throw uErr;
    res.status(200).json({ case: data });
    return;
  }

  if (req.method === 'DELETE') {
    if (!id) { res.status(400).json({ error: 'missing_id' }); return; }
    const { data, error } = await svc.from('mini_cases').delete().eq('id', id).eq('agency_id', auth.agencyId).select('id');
    if (error) throw error;
    if (!data || !data.length) { res.status(404).json({ error: 'not_found' }); return; }
    res.status(200).json({ ok: true });
    return;
  }
  res.status(405).json({ error: 'method_not_allowed' });
}

/**
 * A WhatsApp conversation → a lead in the CRM, once per client: if this number
 * already has a lead or an open job, nothing new is created (the service is
 * filled in if it was unknown). Only while the add-on is active.
 */
export async function leadFromWhatsApp(svc, { agencyId, phone, serviceTitle = null, now = Date.now() }) {
  const agency = await agencyRow(svc, agencyId);
  if (!agency || !crmActive(agency, now)) return { skipped: 'crm_inactive' };
  let serviceId = null;
  if (serviceTitle) {
    const { data } = await svc.from('mini_services').select('id, title_es').eq('agency_id', agencyId);
    const hit = (data || []).find((x) => norm(x.title_es) === norm(serviceTitle));
    serviceId = hit ? hit.id : null;
  }
  const { data: existing, error } = await svc.from('mini_cases').select('id, service_id, status')
    .eq('agency_id', agencyId).eq('client_phone', phone).in('status', ['lead', 'open']).limit(1);
  if (error) throw error;
  const row = (existing || [])[0];
  if (row) {
    if (!row.service_id && serviceId) await svc.from('mini_cases').update({ service_id: serviceId }).eq('id', row.id).eq('agency_id', agencyId);
    return { existing: row.id };
  }
  const { data, error: iErr } = await svc.from('mini_cases')
    .insert({ agency_id: agencyId, source: 'whatsapp', status: 'lead', client_phone: phone, service_id: serviceId, stage: null }).select('id').single();
  if (iErr) throw iErr;
  return { created: data.id };
}
