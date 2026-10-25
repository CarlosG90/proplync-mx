/**
 * Proplync.mx · Readiness check for the AI agents ("doctor")
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * The agents (Concierge, Scout, speech to text) depend on three outside providers, a database, a handful of
 * environment variables and some model IDs that providers retire without warning. Scout had never run in
 * production. One call to this tells you, before a buyer does, what is and is not ready:
 *   - which keys are set, and whether each provider accepts its key and still lists the model we call
 *   - whether Scout can start a run, and what its limits and spending are
 *   - whether the tables exist, and whether any run is stuck
 *   - what would silently not happen (for example, nobody is emailed about a verification request)
 *
 * It spends nothing: listing models and looking one up are free. It returns booleans, names and counts, never
 * a secret. Each check is isolated, so one failing check cannot hide the others.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { PRIMARY_MODEL, FALLBACK_MODEL } from './groq.js';
import { NVIDIA_MODEL, conciergeModels } from './nvidia-concierge.js';
import { SCOUT_MODEL, runsStartedToday, stuckAction } from './scout.js';
import { monthlyBudgetUsd, runMaxUsd, runHardMaxUsd, spentThisMonth } from './scout-budget.js';
import { createHash } from 'node:crypto';
import { EXTRACT_MODEL } from '../extract.js';
import { safeDetail } from './health.js';

/* How the operator proves who they are without a new secret to invent and store. The CLI hashes the service-role
   key it already has in .env.local and sends the hash; the server does the same sum with its own copy. The key
   itself never travels. */
export function doctorToken(serviceRoleKey) {
  return createHash('sha256').update(String(serviceRoleKey || '') + ':proplync-doctor').digest('hex');
}

const STT_MODEL = 'whisper-large-v3';
const TABLES = ['buyer_briefs', 'scout_runs', 'scout_candidates', 'buyer_wallets', 'contact_requests', 'events', 'search_properties'];

async function listModels(url, key, fetchImpl) {
  const r = await fetchImpl(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return { ok: false, status: r.status, ids: [] };
  const body = await r.json();
  return { ok: true, status: r.status, ids: (body.data || []).map((m) => m.id) };
}

async function checkNvidia(env, fetchImpl) {
  if (!env.NVIDIA_API_KEY) return { configured: false, ok: false, model: NVIDIA_MODEL, detail: 'NVIDIA_API_KEY is not set' };
  try {
    const { ok, status, ids } = await listModels('https://integrate.api.nvidia.com/v1/models', env.NVIDIA_API_KEY, fetchImpl);
    if (!ok) return { configured: true, ok: false, model: NVIDIA_MODEL, detail: `NVIDIA answered ${status} (key rejected or service down)` };
    const listed = ids.includes(NVIDIA_MODEL);
    return { configured: true, ok: listed, model: NVIDIA_MODEL, listed, detail: listed ? undefined : 'the key works but this model ID is not in NVIDIA\'s catalog any more' };
  } catch (err) { return { configured: true, ok: false, model: NVIDIA_MODEL, detail: safeDetail(err, 'health') }; }
}

async function checkGroq(env, fetchImpl) {
  if (!env.GROQ_API_KEY) return { configured: false, ok: false, detail: 'GROQ_API_KEY is not set' };
  try {
    const { ok, status, ids } = await listModels('https://api.groq.com/openai/v1/models', env.GROQ_API_KEY, fetchImpl);
    if (!ok) return { configured: true, ok: false, detail: `Groq answered ${status} (key rejected or service down)` };
    const missing = [PRIMARY_MODEL, FALLBACK_MODEL, STT_MODEL].filter((m) => !ids.includes(m));
    return {
      configured: true, ok: !missing.includes(STT_MODEL) && missing.length < 2,
      primary: { model: PRIMARY_MODEL, listed: ids.includes(PRIMARY_MODEL) },
      fallback: { model: FALLBACK_MODEL, listed: ids.includes(FALLBACK_MODEL) },
      speech: { model: STT_MODEL, listed: ids.includes(STT_MODEL) },
      detail: missing.length ? `not in Groq's catalog: ${missing.join(', ')}` : undefined
    };
  } catch (err) { return { configured: true, ok: false, detail: safeDetail(err, 'health') }; }
}

/* WHY a GET and not a HEAD: for a table that does not exist PostgREST answers a HEAD with an empty 404, and the
   client library turns an empty 404 into "no content, no error". That made a missing table look present with
   0 rows. A GET carries a JSON error body, so a missing table is reported as missing. */
async function countRows(svc, table) {
  const { data, count, error } = await svc.from(table).select('*', { count: 'exact' }).limit(1);
  if (error) return { exists: false, error: error.code || error.message };
  return { exists: true, rows: typeof count === 'number' ? count : (Array.isArray(data) ? data.length : 0) };
}

async function checkDatabase(svc, now) {
  const out = { tables: {} };
  await Promise.all(TABLES.map(async (t) => {
    try { out.tables[t] = await countRows(svc, t); } catch (err) { out.tables[t] = { exists: false, error: safeDetail(err, 'health') }; }
  }));
  try {
    const { data } = await svc.from('scout_runs').select('id, status, created_at, lease_until').in('status', ['queued', 'running']).limit(50);
    const active = data || [];
    out.active_runs = active.length;
    out.stuck_runs = active.filter((r) => ['kick', 'fail'].includes(stuckAction(r, now))).length;
  } catch (err) { out.runs_error = safeDetail(err, 'health'); }
  return out;
}

/**
 * @param {object} deps
 * @param {object} deps.env             process.env
 * @param {object} deps.svc             service-role Supabase client
 * @param {Function} deps.checkAnthropic  from scout.js (injected so tests need no SDK call)
 * @param {boolean} deps.scoutCanRun
 * @param {boolean} deps.stepOriginSet
 * @param {number} deps.dailyCap
 * @param {Function} [deps.fetchImpl]
 * @param {Function} [deps.probeScout]  sends Scout's real request once (costs a few cents); only when the operator asks
 */
export async function collectHealth(deps) {
  const { env, svc, checkAnthropic, scoutCanRun, stepOriginSet, dailyCap } = deps;
  const fetchImpl = deps.fetchImpl || fetch;
  const now = deps.now || Date.now();

  const failed = (model) => (err) => ({ configured: Boolean(env.ANTHROPIC_API_KEY), ok: false, model, detail: safeDetail(err, 'health') });
  const [anthropic, extractor, nvidia, groq, database] = await Promise.all([
    checkAnthropic([SCOUT_MODEL]).catch(failed(SCOUT_MODEL)),
    checkAnthropic([EXTRACT_MODEL]).catch(failed(EXTRACT_MODEL)),     // a different model ID from Scout's: either can be retired alone
    checkNvidia(env, fetchImpl),
    checkGroq(env, fetchImpl),
    checkDatabase(svc, now)
  ]);

  let spent = null, today = null;
  try { spent = await spentThisMonth(svc); } catch { /* reported by the tables check */ }
  try { today = await runsStartedToday(svc); } catch { /* same */ }

  const limits = { run_soft_cap_usd: runMaxUsd(env), run_hard_cap_usd: runHardMaxUsd(env), monthly_budget_usd: monthlyBudgetUsd(env), daily_run_cap: dailyCap };
  const email = { resend_key: Boolean(env.RESEND_API_KEY), from: Boolean(env.LEAD_NOTIFY_FROM), operator: Boolean(env.OPERATOR_EMAIL) };
  const scout = {
    can_start_runs: Boolean(scoutCanRun),
    paid_runs_switch: env.SCOUT_PAID_RUNS === 'off' ? 'off' : 'on',
    step_secret: Boolean(env.SCOUT_STEP_SECRET),
    step_origin: stepOriginSet,
    limits, runs_started_today: today, spent_this_month_usd: spent
  };

  /* Problems stop something from working. Notes are things that will not break but that you should know. */
  const problems = [];
  const notes = [];
  if (!anthropic.ok) problems.push(`Scout cannot research: ${anthropic.detail || 'the Anthropic check failed'}.`);
  if (anthropic.ok && !extractor.ok) problems.push(`Listing import from PDFs and photos will fail: ${extractor.detail || 'the Anthropic check failed'}.`);
  if (!nvidia.ok && !groq.ok) problems.push('Concierge has no working provider: both NVIDIA and Groq failed their checks.');
  else if (!nvidia.ok) notes.push(`Concierge will use Groq only: ${nvidia.detail || 'NVIDIA check failed'}.`);
  if (groq.configured && groq.detail) notes.push(`Groq: ${groq.detail}. Copy generation, search parsing and speech to text depend on these.`);
  if (groq.speech && !groq.speech.listed) problems.push('Voice notes will fail: the speech-to-text model is not in Groq\'s catalog.');
  if (!scoutCanRun && anthropic.ok) problems.push('Scout is configured but cannot start runs: check SCOUT_PAID_RUNS, SCOUT_STEP_SECRET and the step origin.');
  if (scout.paid_runs_switch === 'off') notes.push('Automatic Scout runs are switched OFF (SCOUT_PAID_RUNS=off).');
  for (const t of TABLES) {
    if (database.tables[t] && !database.tables[t].exists) {
      problems.push(t === 'contact_requests'
        ? 'Migration 013 is not applied: the /agencias and /agents forms cannot save requests.'
        : t === 'events'
          ? 'Migration 014 is not applied: the funnel cannot be recorded (events are lost silently).'
          : `Table ${t} is missing or unreachable (${database.tables[t].error}).`);
    }
  }
  if (database.stuck_runs > 0) problems.push(`${database.stuck_runs} Scout run(s) look stuck. The buyer's status page restarts them; operator fallback: node scripts/scout.mjs run <briefId>.`);
  if (!email.resend_key || !email.operator || !email.from) {
    notes.push('Nobody is emailed when a brief is approved, a verification is requested or a Scout run finishes (set RESEND_API_KEY, LEAD_NOTIFY_FROM and OPERATOR_EMAIL). Until then, check: node scripts/scout.mjs list');
  }
  const index = database.tables.search_properties;
  if (index && index.exists && index.rows < 20) notes.push(`The search index holds only ${index.rows} properties. Scout still researches the web; the index adds PropLync's own listings.`);
  if (spent !== null && spent >= limits.monthly_budget_usd * 0.8) notes.push(`Scout has spent US$${spent.toFixed(2)} of its US$${limits.monthly_budget_usd} monthly budget.`);

  // The real reason recent runs failed. A model lookup passing says nothing about whether a run is accepted.
  let recent_failures = [];
  try {
    const { data } = await svc.from('scout_runs').select('id, created_at, error').eq('status', 'failed').order('created_at', { ascending: false }).limit(3);
    recent_failures = (data || []).map((r) => ({ id: r.id, at: r.created_at, error: r.error }));
  } catch { /* the report is still useful without it */ }

  // Which NVIDIA models can really run a Concierge turn (the real prompt, the 9 s limit, a parseable brief).
  // The catalog check above only proves a model is listed; a tiny request proves almost nothing either.
  let nvidia_probe = null;
  if (nvidia.configured && conciergeModels(env).length === 0) {
    notes.push('Concierge uses Groq only on purpose: NVIDIA stays off until a model passes a real turn. Run `node scripts/doctor.mjs --probe` to test the candidates.');
  }
  if (deps.probeNvidia && env.NVIDIA_API_KEY) {
    try {
      nvidia_probe = await deps.probeNvidia();
      const passed = nvidia_probe.filter((m) => m.ok).sort((x, y) => x.ms - y.ms);
      if (!passed.length) notes.push('NVIDIA: no candidate returned a valid Concierge turn inside 9 s, so Concierge stays on Groq. See the probe table.');
      else notes.push(`NVIDIA: passed a real Concierge turn: ${passed.map((m) => `${m.model} (${m.variant}, ${m.ms} ms)`).join('; ')}. Put the fastest in PREFERRED_MODELS in nvidia-concierge.js, with its thinking-off option in MODEL_EXTRA if it needed one.`);
    } catch (err) { notes.push(`NVIDIA probe failed: ${safeDetail(err, 'health')}`); }
  }

  let scout_request = null;
  if (deps.probeScout) {
    scout_request = await deps.probeScout();
    if (!scout_request.ok) problems.push(`Anthropic rejects Scout's real request: ${scout_request.detail}`);
  } else if (recent_failures.length) {
    notes.push('Recent Scout runs failed. Run `node scripts/doctor.mjs --probe` to send Scout\'s real request once (a few cents) and see why.');
  }

  return {
    ok: problems.length === 0,
    checked_at: new Date(now).toISOString(),
    problems, notes,
    providers: { anthropic, extractor, nvidia, groq },
    scout, email, database, recent_failures, scout_request, nvidia_probe
  };
}
