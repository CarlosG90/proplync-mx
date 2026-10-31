/**
 * PropLync Finder  ·  Concierge, the buyer-facing voice agent
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * Finder cannot search until it knows what the buyer actually wants, and a form
 * does not get that out of people. A conversation does. Concierge runs that
 * conversation, by voice or by text, and turns it into a structured brief the
 * buyer approves before anything is searched.
 *
 * WHY THREE PROVIDERS
 * NVIDIA NIM (free tier) is the primary Concierge provider (cheaper than Claude).
 * Groq is the fallback when NVIDIA is unavailable or rate-limited.
 * Claude (via Anthropic SDK) is used only for extraction (PDFs, images).
 * Groq also runs Whisper for speech to text (neither other provider does STT).
 * All LLM providers have rate limits; failures on one layer fall through to next.
 *
 * ONE FUNCTION, SEVERAL ACTIONS
 * Vercel Hobby allows 12 serverless functions and this is the twelfth. Every
 * future Finder endpoint has to arrive as another `action` on this file until
 * the account moves to Pro. Same reason /api/nlsearch is folded into
 * api/generate.js -- see the rewrite in vercel.json.
 *
 * AFTER THE CONVERSATION
 * `approve` needs a signed-in buyer (Supabase Auth). It stores the brief
 * (migration 009), spends the buyer's free first search or one credit
 * (migration 012) and starts Scout (api/_lib/scout.js) right away; Scout then
 * advances through `scout-step`, one Claude segment per invocation, each one
 * kicking the next, and a failed run is refunded. `status` is what the buyer's
 * link reads: the brief, Scout's progress and its matches, each labelled
 * unverified, verification requested, or confirmed. `verify` (1 credit) asks
 * a person to confirm one with its agent; `wallet` and `rerun` round it out.
 *
 * WHAT THIS DOES NOT DO
 * It never presents an unverified property as confirmed, never shows the
 * listing agent's contact, and gives no legal, tax or financial advice.
 * -----------------------------------------------------------------------------
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { safeDetail, logDegraded } from './_lib/health.js';
import { enforceRateLimit } from './_lib/ratelimit.js';
import { groqChat, messageText } from './_lib/groq.js';
import { nvidiaChat, chatWithModel, conciergeModels, CANDIDATE_MODELS, THINKING_OFF } from './_lib/nvidia-concierge.js';
import { askConcierge, isBusy, parseReply, NO_THINK } from './_lib/concierge-turn.js';
import { getServiceClient } from './_lib/supabase.js';
import { createRun, runScoutStep, runsStartedToday, scoutConfigured, checkAnthropic, probeScout, fxRate } from './_lib/scout.js';
import { investorBrief, loadRentComps, financialsFor } from './_lib/candidate-financials.js';
import { scoutState, sameBrief } from './_lib/scout-state.js';
import { watchRun } from './_lib/scout-watch.js';
import { collectHealth, doctorToken } from './_lib/health-check.js';
import { redisGet, redisSet } from './_lib/redis.js';
import { monthlyBudgetUsd, spentThisMonth } from './_lib/scout-budget.js';
import { notifyOperator } from './_lib/notify.js';

const MODEL = 'claude-opus-5';
// Free Scout searches per buyer. The same number is free_limit in spend_credit() (migration 013).
const FREE_SEARCHES = 5;
const GROQ_STT = 'https://api.groq.com/openai/v1/audio/transcriptions';

/* A voice note long enough to say something useful is still small. This cap is
   about staying inside Vercel's request body limit, not about being strict. */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_TURNS = 40;

/* The brief is the contract between Concierge and Scout. Keep this shape and
   these field names identical to the planned table, so storing it later is a
   straight insert rather than a translation. */
const SYSTEM = `Eres Concierge, la asistente de PropLync Finder. Hablas con una persona que quiere comprar una propiedad en Mexico.

QUIEN ERES
Di desde el principio, una sola vez, que eres una asistente de IA de PropLync. Nunca afirmes ser humano. Si la persona pide hablar con alguien, dile que puede pedirlo cuando quiera y que un humano la contactara.

COMO CONVERSAS
- Empieza por la historia, no por el formulario: "Cuentame de la vida que quieres tener ahi."
- UNA pregunta por turno. Nunca una lista de preguntas.
- Extrae todo lo que puedas de cada respuesta y pregunta solo lo que falte.
- Habla el idioma de la persona. Si escribe en ingles, responde en ingles.
- Cuando un deseo es vago, conviertelo en peso con una pregunta de intercambio: "Cambiarias la alberca por diez minutos caminando a la playa?"
- Si el presupuesto y los imprescindibles se contradicen, dilo pronto y pregunta cual se relaja. No dejes que la busqueda salga vacia.
- Nunca relajes un imprescindible por tu cuenta.
- Se calida, dulce y breve. Dos o tres frases por turno.
- Tu respuesta se lee en voz alta: escribe como hablas, con frases cortas y naturales. Sin listas, sin asteriscos, sin emojis ni simbolos.

LIMITES
- No das asesoria legal, fiscal ni financiera. Sobre fideicomiso, impuestos o costos de cierre: di lo general y remite a un profesional.
- No prometes que exista una propiedad, ni inventas precios o zonas.
- No pides documentos de identidad, ni CURP, ni datos bancarios.

CUANDO TERMINA
Cuando tengas presupuesto, zona, al menos un imprescindible y el proposito, marca done=true y en "say" haz un resumen de una pagina para que la persona lo apruebe o lo corrija.
Despues del resumen explica lo que sigue, en pocas palabras: al aprobarlo, Scout, el agente de busqueda de PropLync, empieza a buscar en ese momento, aqui mismo, en las agencias de PropLync, los portales y los sitios de agencias. Tiene 5 busquedas gratis. Los resultados aparecen en esta pagina marcados como "sin verificar", y si una propiedad le interesa puede pedir que una persona la confirme con el agente que la tiene, usando un credito.
No digas que alguien la va a contactar para mostrarle opciones ni que tu no buscas: la busqueda la hace Scout en cuanto apruebe.

FORMATO
Responde UNICAMENTE con un objeto JSON valido, sin markdown ni backticks:
{
  "say": "lo que le dices a la persona en su idioma",
  "brief": {
    "must_haves": [], "deal_breakers": [], "nice_to_haves": [],
    "budget": {"comfortable": null, "max": null, "currency": null, "financing": null},
    "location": {"areas": [], "anchors": []},
    "purpose": null, "timeline": null,
    "buyer_profile": {"origin": null, "first_time_in_mexico": null},
    "lifestyle_words": []
  },
  "missing": ["los campos que todavia faltan"],
  "done": false
}
Un dato que la persona no haya dado se queda en null o en lista vacia. Nunca lo rellenes tu.`;

/* Claude is the intended brain. Where its key is absent (Preview deployments)
   Groq runs the same conversation so the Concierge still works. Groq's cap is
   1,000 output tokens a minute on this account, so its replies are budgeted
   tighter and a 429 is reported as "busy", not as a broken product. */
const GROQ_MAX_TOKENS = 600;

async function handleTurn(req, res) {
  /* Check provider availability: NVIDIA (free tier) → Groq fallback.
     Claude is no longer used for Concierge (moved to NVIDIA to reduce cost). */
  // Off until a model has passed a real turn (see nvidia-concierge.js): a failing NVIDIA attempt costs the buyer 9-18 s.
  const haveNvidia = Boolean(process.env.NVIDIA_API_KEY) && conciergeModels().length > 0;
  const haveGroq = Boolean(process.env.GROQ_API_KEY);

  if (!haveNvidia && !haveGroq) {
    res.status(503).json({
      error: 'concierge_unconfigured',
      detail: 'Neither NVIDIA_API_KEY nor GROQ_API_KEY is set. Concierge requires at least one.'
    });
    return;
  }

  const turns = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
  if (!turns.length) { res.status(400).json({ error: 'missing_messages' }); return; }
  if (turns.length > MAX_TURNS) { res.status(400).json({ error: 'conversation_too_long' }); return; }

  /* Only the two roles the API accepts, and only strings. The client is not
     trusted to send a well-formed conversation. */
  const messages = turns.slice(-MAX_TURNS).map(function (m) {
    return {
      role: m && m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m && m.content ? m.content : '').slice(0, 4000)
    };
  }).filter(function (m) { return m.content; });

  if (!messages.length) { res.status(400).json({ error: 'missing_messages' }); return; }
  if (messages[0].role !== 'user') messages.unshift({ role: 'user', content: 'Hola' });

  try {
    /* NVIDIA first, then Groq. Both get the same system prompt, every reply is validated, and a bad
       reply gets one repair attempt before the next provider runs (see concierge-turn.js). */
    const { reply, provider, repaired } = await askConcierge(messages, {
      nvidiaChat, groqChat, SYSTEM, GROQ_MAX_TOKENS, haveNvidia, haveGroq
    });

    res.status(200).json({
      say: reply.say,
      /* null, not {}: a reply that leaves the brief out must not wipe what the page already shows. */
      brief: reply.brief,
      missing: reply.missing,
      done: reply.done,
      provider: provider,
      repaired: repaired
    });
  } catch (err) {
    const code = err.code || (err.message ? err.message.split(':')[0] : 'unknown');
    logDegraded('finder:turn', err);

    /* A rate limit or a timeout is "busy", not "broken": the buyer is told to try again, and the page
       already retries once on its own. */
    if (err.busy || isBusy(err)) {
      res.status(503).json({
        error: 'concierge_busy',
        detail: 'The Concierge is busy. Try again in a few seconds.',
        code: code
      });
      return;
    }

    res.status(502).json({
      error: 'concierge_unavailable',
      detail: safeDetail(err, 'finder'),
      code: code
    });
  }
}

async function handleTranscribe(req, res) {
  if (!process.env.GROQ_API_KEY) {
    res.status(503).json({ error: 'transcription_unconfigured' });
    return;
  }

  const b64 = String((req.body && req.body.audio) || '');
  if (!b64) { res.status(400).json({ error: 'missing_audio' }); return; }

  let bytes;
  try {
    bytes = Buffer.from(b64.replace(/^data:[^;]+;base64,/, ''), 'base64');
  } catch (e) { res.status(400).json({ error: 'bad_audio' }); return; }
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) { res.status(413).json({ error: 'audio_too_large' }); return; }

  try {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: (req.body && req.body.mime) || 'audio/webm' }), 'note.webm');
    form.append('model', 'whisper-large-v3');
    /* No language hint on purpose: buyers switch between Spanish and English
       mid-sentence, and Whisper handles that better unprompted. */
    form.append('response_format', 'json');

    const r = await fetch(GROQ_STT, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.GROQ_API_KEY },
      body: form
    });
    if (!r.ok) throw new Error('groq_stt_' + r.status);
    const data = await r.json();
    res.status(200).json({ text: String(data.text || '').trim() });
  } catch (err) {
    logDegraded('finder:transcribe', err);
    res.status(502).json({ error: 'transcription_unavailable', detail: safeDetail(err) });
  }
}

/* ── Approved briefs and Scout ── */

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,}$/i;

/* One Scout segment must end inside this function's 300 s (vercel.json), with
   room left to save the result and kick the next segment. */
const STEP_BUDGET_MS = 250 * 1000;

/* Where the next segment is sent. Taken from Vercel's own environment, never
   from the request's Host header: the request carries the step secret, and a
   spoofed host would hand it to someone else. */
function stepOrigin() {
  if (process.env.SCOUT_STEP_ORIGIN) return process.env.SCOUT_STEP_ORIGIN.replace(/\/+$/, '');
  if (process.env.VERCEL_ENV === 'production' && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL;
  }
  return process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : null;
}

/* Starts the next segment in a fresh invocation. That invocation answers 202
   before doing any work, so this resolves in a second, not a segment's length:
   the chain never nests. */
async function kickStep(runId) {
  const headers = { 'content-type': 'application/json', 'x-scout-secret': process.env.SCOUT_STEP_SECRET };
  // Preview deployments sit behind Vercel's deployment protection.
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers['x-vercel-protection-bypass'] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  try {
    const r = await fetch(stepOrigin() + '/api/finder?action=scout-step', {
      method: 'POST', headers, body: JSON.stringify({ run_id: runId })
    });
    if (r.status !== 202) logDegraded('finder:scout-kick', new Error('HTTP ' + r.status));
  } catch (err) {
    logDegraded('finder:scout-kick', err);
  }
}

function sameSecret(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/* ── Buyers, credits and the hand-off to Scout ──
   A buyer signs in (email code or Google, Supabase Auth) when the brief is
   done. Approving it spends the free first search or one credit
   (spend_credit, migration 012) and starts Scout right there; a failed run
   gives the credit back. Verifying a property with its agent costs one more.
   Credits are bought in packs (Stripe) or granted by an operator. */

async function requireBuyer(req) {
  const authz = req.headers.authorization || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : null;
  if (!token) return null;
  try {
    const { data, error } = await getServiceClient().auth.getUser(token);
    if (error || !data || !data.user) return null;
    return data.user;
  } catch (err) {
    logDegraded('finder:buyer-auth', err);
    return null;
  }
}

function scoutCanRun() {
  return process.env.SCOUT_PAID_RUNS !== 'off' && scoutConfigured() &&
    Boolean(process.env.SCOUT_STEP_SECRET) && Boolean(stepOrigin());
}

/* Charge, then start. Charging first (ref = the brief) means an empty wallet
   never creates a run; a run that then fails to start is refunded at once. */
async function startPaidRun(svc, user, briefId, spendRef = briefId) {
  if (!scoutCanRun()) return { started: false, reason: 'scout_unavailable' };
  const cap = Number(process.env.SCOUT_MAX_RUNS_PER_DAY) || 5;
  if (await runsStartedToday(svc) >= cap) {
    logDegraded('finder:scout-daily-cap', new Error(`cap ${cap} reached; brief ${briefId} waits`));
    return { started: false, reason: 'daily_capacity' };
  }

  // Check monthly budget
  const monthlyBudget = monthlyBudgetUsd();
  const monthlySpent = await spentThisMonth(svc);
  if (monthlySpent >= monthlyBudget) {
    logDegraded('finder:scout-monthly-cap', new Error(`monthly budget $${monthlyBudget} reached ($${monthlySpent.toFixed(2)} spent); brief ${briefId} waits`));
    return { started: false, reason: 'monthly_capacity' };
  }

  const { data: spend, error: spendErr } = await svc.rpc('spend_credit', { p_user: user.id, p_reason: 'search', p_ref: spendRef });
  if (spendErr) throw spendErr;
  if (!spend.ok) return { started: false, reason: 'insufficient_credits', credits: spend.credits };

  let run;
  try {
    ({ run } = await createRun(svc, briefId, 'auto'));
    await svc.from('scout_runs').update({ user_id: user.id, charged: spend.free ? 'free' : 'credit' }).eq('id', run.id);
  } catch (err) {
    await refundRun(svc, { id: 'start-' + briefId, user_id: user.id, charged: spend.free ? 'free' : 'credit' });
    throw err;
  }
  waitUntil(kickStep(run.id));
  return { started: true, free: spend.free, credits: spend.credits, run_id: run.id };
}

/* Give back what a failed run cost: a credit, or the free first search. */
async function refundRun(svc, run) {
  if (!run || !run.user_id || !run.charged || run.charged === 'operator') return;
  const { error } = await svc.rpc('add_credits', {
    p_user: run.user_id, p_delta: run.charged === 'credit' ? 1 : 0, p_reason: 'refund', p_ref: String(run.id),
    p_restore_free: run.charged === 'free'
  });
  if (error) logDegraded('finder:refund', error);
}

function validBrief(brief) {
  if (!brief || typeof brief !== 'object' || Array.isArray(brief) || JSON.stringify(brief).length > 20000) return 'invalid_brief';
  // The same bar Concierge sets before it says done: a place to search, a budget.
  const loc = brief.location || {};
  const budget = brief.budget || {};
  const hasPlace = [].concat(loc.areas || [], loc.anchors || []).some((a) => String(a || '').trim());
  return hasPlace && (budget.max || budget.comfortable) ? null : 'brief_incomplete';
}

async function handleApprove(req, res) {
  const user = await requireBuyer(req);
  if (!user) { res.status(401).json({ error: 'sign_in_required' }); return; }
  const body = req.body || {};
  const brief = body.brief;
  const lang = body.lang === 'en' ? 'en' : 'es';
  const invalid = validBrief(brief);
  if (invalid) { res.status(400).json({ error: invalid }); return; }
  if (body.consent !== true) { res.status(400).json({ error: 'consent_required' }); return; }
  const meta = user.user_metadata || {};
  const name = String(body.name || meta.full_name || meta.name || '').trim().slice(0, 120) || String(user.email || '').split('@')[0];

  // The buyer's link to this brief: random, shown once, stored only as a hash.
  const token = randomBytes(32).toString('base64url');
  const svc = getServiceClient();

  /* The same brief approved again by the same buyer within 30 minutes (a reload, a second click: nothing on screen said whether Scout had
     started) is the same brief. Reuse it with a fresh private link instead of saving a duplicate. A link is only ever stored as a hash,
     so the old one cannot be shown again; the new one replaces it. */
  let row = null, error = null;
  try {
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: recent } = await svc.from('buyer_briefs').select('id, brief').eq('user_id', user.id).gte('created_at', since)
      .order('created_at', { ascending: false }).limit(5);
    const same = (recent || []).find((r) => sameBrief(r.brief, brief));
    if (same) {
      const { error: rotateError } = await svc.from('buyer_briefs').update({ access_token_hash: sha256(token), lang, updated_at: new Date().toISOString() }).eq('id', same.id);
      if (!rotateError) row = { id: same.id };
    }
  } catch (err) { logDegraded('finder:approve-dedupe', err); }
  if (!row) {
    ({ data: row, error } = await svc.from('buyer_briefs').insert({
      access_token_hash: sha256(token), lang, brief, user_id: user.id,
      contact_name: name, contact_email: user.email || '', consent_at: new Date().toISOString()
    }).select('id').single());
  }
  if (error || !row) {
    logDegraded('finder:approve', error || new Error('no row'));
    res.status(503).json({ error: 'approve_failed' }); return;
  }

  let scout = { started: false, reason: 'scout_unavailable' };
  try {
    scout = await startPaidRun(svc, user, row.id);
  } catch (err) {
    // The brief is saved either way; the buyer can start the search again.
    logDegraded('finder:scout-start', err);
  }
  const status = scout.started ? 'searching' : 'approved';
  waitUntil(notifyOperator({
    subject: `Finder: brief aprobado (${status}${scout.free ? ', búsqueda gratis' : ''})`,
    text: `Brief ${row.id}\n${name} <${user.email}>\nEstado: ${status} ${scout.reason || ''}\n\nRevisar: node scripts/scout.mjs review ${row.id}`
  }));
  res.status(200).json({ token, status, scout });
}

async function briefByToken(svc, token) {
  if (token.length < 20 || token.length > 100) return null;
  const { data, error } = await svc.from('buyer_briefs')
    .select('id, lang, brief, status, created_at, user_id').eq('access_token_hash', sha256(token)).maybeSingle();
  if (error) throw error;
  return data;
}

/* Search this brief again (e.g. after buying credits). Owner only. */
async function handleRerun(req, res) {
  const user = await requireBuyer(req);
  if (!user) { res.status(401).json({ error: 'sign_in_required' }); return; }
  const svc = getServiceClient();
  const brief = await briefByToken(svc, String((req.body && req.body.t) || ''));
  if (!brief || brief.user_id !== user.id) { res.status(404).json({ error: 'not_found' }); return; }
  const { data: active } = await svc.from('scout_runs').select('id').eq('brief_id', brief.id).in('status', ['queued', 'running']).limit(1);
  if (active && active.length) { res.status(200).json({ status: 'searching', scout: { started: false, reason: 'already_running' } }); return; }
  const scout = await startPaidRun(svc, user, brief.id, brief.id + ':' + Date.now());
  res.status(200).json({ status: scout.started ? 'searching' : brief.status, scout });
}

async function handleStatus(req, res) {
  const svc = getServiceClient();
  let brief;
  try {
    brief = await briefByToken(svc, String(req.query.t || ''));
  } catch (err) {
    logDegraded('finder:status', err);
    res.status(503).json({ error: 'status_unavailable' }); return;
  }
  if (!brief) { res.status(404).json({ error: 'not_found' }); return; }

  /* `progress` (migration 016) is what Scout is doing right now. If the column is not there yet the page just
     goes without the live feed, instead of losing the whole status. */
  const runCols = 'id, status, steps, web_searches, web_fetches, created_at, finished_at, lease_until, user_id, charged';
  const latestRun = (cols) => svc.from('scout_runs').select(cols)
    .eq('brief_id', brief.id).order('created_at', { ascending: false }).limit(1);
  let { data: runs, error: runsError } = await latestRun(runCols + ', progress');
  if (runsError) ({ data: runs } = await latestRun(runCols));
  let run = runs && runs[0];

  /* This page polls every few seconds while a run is active, so it is also Scout's watchdog: a run whose
     hand-off was lost is restarted, and one that is hopelessly stuck is closed and refunded. */
  if (run) {
    try {
      const watched = await watchRun(svc, { ...run }, brief, {
        recentlyKicked: async (id) => Boolean(await redisGet('scout:rekick:' + id)),
        markKicked: (id) => redisSet('scout:rekick:' + id, 1, 40),
        kick: (id) => waitUntil(kickStep(id)),
        refund: (r) => refundRun(svc, r),
        notify: (m) => waitUntil(notifyOperator(m))
      });
      if (watched === 'failed') run = { ...run, status: 'failed' };
    } catch (err) {
      logDegraded('finder:watchdog', err);
    }
  }

  /* Scout's matches show as soon as it finishes, each labelled with where it
     stands: not yet verified, verification requested, confirmed by the agent,
     or ruled out. Internal notes and the agent's contact never leave. */
  const { data: rows } = await svc.from('scout_candidates')
    .select('id, origin, listing_public_id, title, operation, property_type, town, neighborhood, bedrooms, bathrooms, built_m2, land_m2, sources, photos, match, fit_score, lowest_price_mxn, verification, verify_requested_at, answers, verified_at')
    .eq('brief_id', brief.id).neq('verification', 'rejected')
    .order('fit_score', { ascending: false, nullsFirst: false });
  /* A yield estimate, for investors only and only where it rests on real rental comps (see candidate-financials.js).
     Optional: if the index cannot be read the page simply has no estimate. */
  let rentComps = [], fx = 18;
  if (investorBrief(brief.brief) && (rows || []).some((c) => c.operation === 'sale')) {
    try { fx = fxRate(); rentComps = await loadRentComps(svc, (rows || []).map((c) => c.town), fx); }
    catch (err) { logDegraded('finder:financials', err); }
  }
  const candidates = (rows || []).map(({ match, answers, lowest_price_mxn, ...c }) => ({
    ...c,
    summary: match && match.summary,
    must_haves: (match && match.must_haves) || [],
    answers: c.verification === 'confirmed' ? answers : null,
    verify_requested: Boolean(c.verify_requested_at),
    financials: rentComps.length ? financialsFor({ ...c, lowest_price_mxn }, rentComps, fx) : null
  }));

  /* Where the search stands, and if it never started, why. Derived every time (not remembered from the approve click), so a reload
     still says it. See scout-state.js. */
  let scout = null;
  try {
    let wallet = null, startedToday = 0;
    if (!run) {
      if (brief.user_id) {
        const { data } = await svc.from('buyer_wallets').select('credits, free_search_used').eq('user_id', brief.user_id).maybeSingle();
        wallet = data || null;
      }
      startedToday = await runsStartedToday(svc);
    }
    scout = scoutState({ run, wallet, startedToday, cap: Number(process.env.SCOUT_MAX_RUNS_PER_DAY) || 5, canRun: scoutCanRun() });
  } catch (err) { logDegraded('finder:scout-state', err); }

  res.status(200).json({
    status: brief.status, lang: brief.lang, brief: brief.brief, created_at: brief.created_at, scout,
    run: run ? {
      status: run.status, steps: run.steps, searches: run.web_searches, pages: run.web_fetches,
      progress: Array.isArray(run.progress) ? run.progress.slice(-30) : []
    } : null,
    candidates
  });
}

/* Ask a person to confirm one property with its agent: 1 credit. */
async function handleVerify(req, res) {
  const user = await requireBuyer(req);
  if (!user) { res.status(401).json({ error: 'sign_in_required' }); return; }
  const id = String((req.body && req.body.candidate_id) || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) { res.status(400).json({ error: 'invalid_candidate' }); return; }
  const svc = getServiceClient();
  const { data: cand } = await svc.from('scout_candidates')
    .select('id, brief_id, title, verification, verify_requested_at, buyer_briefs(user_id)').eq('id', id).maybeSingle();
  if (!cand || !cand.buyer_briefs || cand.buyer_briefs.user_id !== user.id) { res.status(404).json({ error: 'not_found' }); return; }
  if (cand.verification !== 'pending' || cand.verify_requested_at) {
    res.status(200).json({ ok: true, already: true }); return;
  }
  const { data: spend, error } = await svc.rpc('spend_credit', { p_user: user.id, p_reason: 'verify', p_ref: id });
  if (error) { logDegraded('finder:verify', error); res.status(503).json({ error: 'verify_unavailable' }); return; }
  if (!spend.ok) { res.status(402).json({ error: 'insufficient_credits', credits: spend.credits }); return; }
  await svc.from('scout_candidates').update({ verify_requested_at: new Date().toISOString(), verify_requested_by: user.id }).eq('id', id);
  waitUntil(notifyOperator({
    subject: 'Finder: verificación pedida',
    text: `Candidato ${id}: ${cand.title || ''}\nBrief ${cand.brief_id} · ${user.email}\n\nnode scripts/scout.mjs review ${cand.brief_id}`
  }));
  res.status(200).json({ ok: true, credits: spend.credits });
}

async function handleWallet(req, res) {
  const user = await requireBuyer(req);
  if (!user) { res.status(401).json({ error: 'sign_in_required' }); return; }
  const svc = getServiceClient();
  const { data: wallet } = await svc.from('buyer_wallets').select('credits, free_searches_used').eq('user_id', user.id).maybeSingle();
  const { data: ledger } = await svc.from('credit_ledger').select('delta, reason, created_at, balance_after')
    .eq('user_id', user.id).order('created_at', { ascending: false }).limit(10);
  const freeLeft = Math.max(0, FREE_SEARCHES - (wallet ? wallet.free_searches_used : 0));
  res.status(200).json({
    email: user.email,
    credits: wallet ? wallet.credits : 0,
    free_search_available: freeLeft > 0,
    free_searches_left: freeLeft,
    ledger: ledger || []
  });
}

/* The real acceptance test for an NVIDIA model: the actual Concierge prompt and a real buyer message, with the turn's
   9 s limit, and the reply must parse into a valid brief. Each candidate runs twice, plain and with thinking switched
   off, in parallel. A few thousand tokens in total, sent from inside production so the key never leaves Vercel. */
async function probeConciergeTurns() {
  const messages = [
    { role: 'system', content: SYSTEM + NO_THINK },
    { role: 'user', content: 'Hola, busco un departamento de 2 recámaras en Tulum, en Aldea Zama, con alberca, hasta 300 mil dólares. Es para vivir parte del año y rentarlo el resto.' }
  ];
  const runs = [];
  for (const model of CANDIDATE_MODELS) {
    runs.push({ model, variant: 'plain', extra: undefined });
    if (THINKING_OFF[model]) runs.push({ model, variant: 'thinking_off', extra: THINKING_OFF[model] });
  }
  return Promise.all(runs.map(async ({ model, variant, extra }) => {
    const started = Date.now();
    try {
      const raw = await chatWithModel(model, messages, { max_tokens: 1400, temperature: 0.4, timeoutMs: 9000, extra });
      const reply = parseReply(raw);
      return { model, variant, ok: true, status: 200, ms: Date.now() - started, detail: `valid brief JSON, say: ${String(reply.say || '').slice(0, 60)}` };
    } catch (err) {
      const status = Number((String(err.message).match(/NVIDIA NIM (\d{3})/) || [])[1]) || null;
      return { model, variant, ok: false, status, ms: Date.now() - started, detail: String(err.code || err.message).replace(/\s+/g, ' ').slice(0, 140) };
    }
  }));
}

/* Is everything the agents need actually in place? Operator-only (the step secret), read-only, spends nothing.
   See api/_lib/health-check.js and scripts/doctor.mjs. */
async function handleHealth(req, res) {
  const byStepSecret = sameSecret(req.headers['x-scout-secret'], process.env.SCOUT_STEP_SECRET);
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const byDoctorToken = Boolean(serviceKey) && sameSecret(req.headers['x-doctor-token'], doctorToken(serviceKey));
  if (!byStepSecret && !byDoctorToken) {
    res.status(401).json({ error: 'unauthorized' }); return;
  }
  try {
    const report = await collectHealth({
      env: process.env,
      svc: getServiceClient(),
      checkAnthropic,
      probeScout: req.query.probe === '1' ? probeScout : undefined,
      probeNvidia: req.query.probe === '1' ? probeConciergeTurns : undefined,
      scoutCanRun: scoutCanRun(),
      stepOriginSet: Boolean(stepOrigin()),
      dailyCap: Number(process.env.SCOUT_MAX_RUNS_PER_DAY) || 5
    });
    res.status(200).json(report);
  } catch (err) {
    logDegraded('finder:health', err);
    res.status(500).json({ error: 'health_failed', detail: safeDetail(err, 'finder') });
  }
}

async function handleScoutStep(req, res) {
  if (!sameSecret(req.headers['x-scout-secret'], process.env.SCOUT_STEP_SECRET)) {
    res.status(401).json({ error: 'unauthorized' }); return;
  }
  const runId = String((req.body && req.body.run_id) || '');
  if (!/^[0-9a-f-]{36}$/i.test(runId)) { res.status(400).json({ error: 'invalid_run' }); return; }

  res.status(202).json({ accepted: true });

  waitUntil((async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), STEP_BUDGET_MS);
    try {
      const svc = getServiceClient();
      const out = await runScoutStep(svc, runId, { signal: ctrl.signal });
      clearTimeout(timer);
      if (out.state === 'continue') {
        await kickStep(runId);
      } else if (out.state === 'retry') {
        // Overloaded or rate limited: give it a moment, then the same segment again.
        await new Promise((r) => setTimeout(r, 15000));
        await kickStep(runId);
      } else if (out.state === 'done' || out.state === 'failed') {
        if (out.state === 'failed') {
          const { data: run } = await svc.from('scout_runs').select('id, user_id, charged').eq('id', runId).maybeSingle();
          await refundRun(svc, run);
        }
        await notifyOperator({
          subject: `Scout ${out.state}: ${out.candidates || 0} candidatos`,
          text: `Run ${runId}\nEstado: ${out.state} ${out.detail || ''}\nCosto aprox: US$${out.cost_usd || 0}\n\nRevisar con: node scripts/scout.mjs list`
        });
      }
      // 'busy' means another invocation holds this run's lease; it will continue it.
    } catch (err) {
      logDegraded('finder:scout-step', err);
    } finally {
      clearTimeout(timer);
    }
  })());
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const action = String(req.query.action || '');

  /* Each action is throttled on its own budget. enforceRateLimit writes the
     429 itself and returns true to mean "stop". */
  if (action === 'status') {
    if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }
    if (await enforceRateLimit(req, res, { bucket: 'finder-status', limit: 60, windowSec: 60 })) return;
    return handleStatus(req, res);
  }
  if (action === 'wallet') {
    if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }
    if (await enforceRateLimit(req, res, { bucket: 'finder-wallet', limit: 60, windowSec: 60 })) return;
    return handleWallet(req, res);
  }

  if (action === 'health') {
    if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }
    return handleHealth(req, res);
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  // Called only by this function itself; the shared secret is the throttle.
  if (action === 'scout-step') return handleScoutStep(req, res);

  if (action === 'verify') {
    if (await enforceRateLimit(req, res, { bucket: 'finder-verify', limit: 30, windowSec: 3600 })) return;
    return handleVerify(req, res);
  }
  if (action === 'rerun') {
    if (await enforceRateLimit(req, res, { bucket: 'finder-rerun', limit: 10, windowSec: 3600 })) return;
    return handleRerun(req, res);
  }

  if (action === 'approve') {
    if (await enforceRateLimit(req, res, { bucket: 'finder-approve', limit: 5, windowSec: 3600 })) return;
    return handleApprove(req, res);
  }

  /* turn and transcribe cost real money per call, so throttle before any work. */
  if (await enforceRateLimit(req, res, { bucket: 'finder', limit: 20, windowSec: 60 })) return;
  if (action === 'turn') return handleTurn(req, res);
  if (action === 'transcribe') return handleTranscribe(req, res);
  res.status(400).json({ error: 'unknown_action' });
}
