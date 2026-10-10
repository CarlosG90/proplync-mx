/**
 * PropLync Finder  ·  Concierge, the buyer-facing voice agent
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * Finder cannot search until it knows what the buyer actually wants, and a form
 * does not get that out of people. A conversation does. Concierge runs that
 * conversation, by voice or by text, and turns it into a structured brief the
 * buyer approves before anything is searched.
 *
 * WHY TWO PROVIDERS
 * Claude runs the conversation and the extraction when ANTHROPIC_API_KEY is set:
 * tone matters here, it is the only thing the buyer ever talks to. Groq runs
 * Whisper for speech to text (Claude takes no audio input), and also stands in
 * for Claude on the conversation where that key is missing, e.g. Preview. Its
 * 1,000 output-tokens-per-minute cap (api/extract.js) applies to chat
 * completions, not to transcription, which is why it is the fallback and not
 * the first choice.
 *
 * ONE FUNCTION, SEVERAL ACTIONS
 * Vercel Hobby allows 12 serverless functions and this is the twelfth. Every
 * future Finder endpoint has to arrive as another `action` on this file until
 * the account moves to Pro. Same reason /api/nlsearch is folded into
 * api/generate.js -- see the rewrite in vercel.json.
 *
 * AFTER THE CONVERSATION
 * `approve` stores the brief the buyer signed off (migration 009) and hands
 * back a private link token. With SCOUT_AUTO=on it also starts Scout
 * (api/_lib/scout.js), which then advances through `scout-step`, one Claude
 * segment per invocation, each one kicking the next. With it off, the brief
 * waits for an operator to run scripts/scout.mjs. `status` is what the buyer's
 * link reads: the brief, where it stands, and only the candidates a person
 * has confirmed with the listing agent.
 *
 * WHAT THIS DOES NOT DO
 * It never promises a property exists, never shows an unverified one, and
 * gives no legal, tax or financial advice.
 * -----------------------------------------------------------------------------
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { waitUntil } from '@vercel/functions';
import { safeDetail, logDegraded } from './_lib/health.js';
import { enforceRateLimit } from './_lib/ratelimit.js';
import { groqChat, messageText } from './_lib/groq.js';
import { getServiceClient } from './_lib/supabase.js';
import { createRun, runScoutStep, runsStartedToday, scoutConfigured } from './_lib/scout.js';
import { notifyOperator } from './_lib/notify.js';

const MODEL = 'claude-opus-5';
const GROQ_STT = 'https://api.groq.com/openai/v1/audio/transcriptions';

/* A voice note long enough to say something useful is still small. This cap is
   about staying inside Vercel's request body limit, not about being strict. */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_TURNS = 40;

/* The brief is the contract between Concierge and Scout. Keep this shape and
   these field names identical to the planned table, so storing it later is a
   straight insert rather than a translation. */
const SYSTEM = `Eres Concierge, el asistente de PropLync Finder. Hablas con una persona que quiere comprar una propiedad en Mexico.

QUIEN ERES
Di desde el principio, una sola vez, que eres un asistente de IA de PropLync. Nunca afirmes ser humano. Si la persona pide hablar con alguien, dile que puede pedirlo cuando quiera y que un humano la contactara.

COMO CONVERSAS
- Empieza por la historia, no por el formulario: "Cuentame de la vida que quieres tener ahi."
- UNA pregunta por turno. Nunca una lista de preguntas.
- Extrae todo lo que puedas de cada respuesta y pregunta solo lo que falte.
- Habla el idioma de la persona. Si escribe en ingles, responde en ingles.
- Cuando un deseo es vago, conviertelo en peso con una pregunta de intercambio: "Cambiarias la alberca por diez minutos caminando a la playa?"
- Si el presupuesto y los imprescindibles se contradicen, dilo pronto y pregunta cual se relaja. No dejes que la busqueda salga vacia.
- Nunca relajes un imprescindible por tu cuenta.
- Se calido y breve. Dos o tres frases por turno.

LIMITES
- No das asesoria legal, fiscal ni financiera. Sobre fideicomiso, impuestos o costos de cierre: di lo general y remite a un profesional.
- No prometes que exista una propiedad, ni inventas precios o zonas.
- No pides documentos de identidad, ni CURP, ni datos bancarios.

CUANDO TERMINA
Cuando tengas presupuesto, zona, al menos un imprescindible y el proposito, marca done=true y en "say" haz un resumen de una pagina para que la persona lo apruebe o lo corrija.

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

function readJson(raw) {
  /* The model is told to return bare JSON, but surviving a stray fence costs
     nothing and a 500 in the buyer's face costs a lot. */
  const text = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('model_returned_no_json');
  return JSON.parse(text.slice(start, end + 1));
}

/* Claude is the intended brain. Where its key is absent (Preview deployments)
   Groq runs the same conversation so the Concierge still works. Groq's cap is
   1,000 output tokens a minute on this account, so its replies are budgeted
   tighter and a 429 is reported as "busy", not as a broken product. */
const GROQ_MAX_TOKENS = 600;

async function handleTurn(req, res) {
  const provider = process.env.ANTHROPIC_API_KEY ? 'anthropic'
    : process.env.GROQ_API_KEY ? 'groq' : null;
  if (!provider) {
    res.status(503).json({
      error: 'concierge_unconfigured',
      detail: 'Neither ANTHROPIC_API_KEY nor GROQ_API_KEY is set in this environment.'
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
    let text;
    let used = provider;
    const viaGroq = async function () {
      const data = await groqChat({
        max_tokens: GROQ_MAX_TOKENS,
        temperature: 0.4,
        messages: [{ role: 'system', content: SYSTEM }].concat(messages)
      });
      return messageText(data);
    };
    if (provider === 'anthropic') {
      try {
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const out = await client.messages.create({
          model: MODEL,
          max_tokens: 1400,
          system: SYSTEM,
          messages: messages
        });
        text = (out.content || []).filter(function (b) { return b.type === 'text'; })
          .map(function (b) { return b.text; }).join('');
      } catch (err) {
        /* A rejected or expired Anthropic key must not take the Concierge down
           while Groq is available. Log it so the bad key still gets noticed. */
        if (!process.env.GROQ_API_KEY) throw err;
        logDegraded('finder:anthropic-failed-using-groq', err);
        used = 'groq';
        text = await viaGroq();
      }
    } else {
      text = await viaGroq();
    }
    const parsed = readJson(text);

    res.status(200).json({
      say: String(parsed.say || '').slice(0, 4000),
      brief: parsed.brief && typeof parsed.brief === 'object' ? parsed.brief : {},
      missing: Array.isArray(parsed.missing) ? parsed.missing.slice(0, 20) : [],
      done: parsed.done === true,
      provider: used
    });
  } catch (err) {
    logDegraded('finder:turn', err);
    if (/Groq responded 429/.test(String(err && err.message))) {
      res.status(429).json({ error: 'concierge_busy', detail: 'The Concierge is busy. Try again in a few seconds.' });
      return;
    }
    res.status(502).json({ error: 'concierge_unavailable', detail: safeDetail(err) });
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

function autoEnabled() {
  return process.env.SCOUT_AUTO === 'on' && scoutConfigured() && Boolean(process.env.SCOUT_STEP_SECRET) && Boolean(stepOrigin());
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

async function handleApprove(req, res) {
  const body = req.body || {};
  const brief = body.brief;
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  const lang = body.lang === 'en' ? 'en' : 'es';

  if (!brief || typeof brief !== 'object' || Array.isArray(brief) || JSON.stringify(brief).length > 20000) {
    res.status(400).json({ error: 'invalid_brief' }); return;
  }
  // The same bar Concierge sets before it says done: a place to search, a budget.
  const loc = brief.location || {};
  const budget = brief.budget || {};
  const hasPlace = [].concat(loc.areas || [], loc.anchors || []).some((a) => String(a || '').trim());
  if (!hasPlace || !(budget.max || budget.comfortable)) { res.status(400).json({ error: 'brief_incomplete' }); return; }
  if (!name || name.length > 120) { res.status(400).json({ error: 'invalid_name' }); return; }
  if (!EMAIL.test(email) || email.length > 200) { res.status(400).json({ error: 'invalid_email' }); return; }
  if (body.consent !== true) { res.status(400).json({ error: 'consent_required' }); return; }

  // The buyer's link is the only key to their brief: random, shown once,
  // stored only as a hash.
  const token = randomBytes(32).toString('base64url');
  const svc = getServiceClient();
  const { data: row, error } = await svc.from('buyer_briefs').insert({
    access_token_hash: sha256(token), lang, brief,
    contact_name: name, contact_email: email, consent_at: new Date().toISOString()
  }).select('id').single();
  if (error) {
    logDegraded('finder:approve', error);
    res.status(503).json({ error: 'approve_failed' }); return;
  }

  let status = 'approved';
  if (autoEnabled()) {
    const cap = Number(process.env.SCOUT_MAX_RUNS_PER_DAY) || 10;
    try {
      if (await runsStartedToday(svc) < cap) {
        const { run } = await createRun(svc, row.id, 'auto');
        status = 'searching';
        waitUntil(kickStep(run.id));
      } else {
        logDegraded('finder:scout-daily-cap', new Error(`cap ${cap} reached; brief ${row.id} waits for an operator`));
      }
    } catch (err) {
      // The brief is saved either way; an operator can start the search.
      logDegraded('finder:scout-start', err);
    }
  }

  waitUntil(notifyOperator({
    subject: `Finder: brief aprobado (${status})`,
    text: `Brief ${row.id}\n${name} <${email}>\nEstado: ${status}\n\nRevisar: node scripts/scout.mjs review ${row.id}`
  }));
  res.status(200).json({ token, status });
}

async function handleStatus(req, res) {
  const token = String(req.query.t || '');
  if (token.length < 20 || token.length > 100) { res.status(404).json({ error: 'not_found' }); return; }
  const svc = getServiceClient();
  const { data: brief, error } = await svc.from('buyer_briefs')
    .select('id, lang, brief, status, created_at').eq('access_token_hash', sha256(token)).maybeSingle();
  if (error) { logDegraded('finder:status', error); res.status(503).json({ error: 'status_unavailable' }); return; }
  if (!brief) { res.status(404).json({ error: 'not_found' }); return; }

  const { count: pending } = await svc.from('scout_candidates')
    .select('id', { count: 'exact', head: true }).eq('brief_id', brief.id).eq('verification', 'pending');

  // Only what a person confirmed, and only once the operator releases the set.
  let confirmed = [];
  if (brief.status === 'ready') {
    const { data } = await svc.from('scout_candidates')
      .select('id, title, operation, property_type, town, neighborhood, bedrooms, bathrooms, built_m2, land_m2, sources, photos, match, answers, verified_at')
      .eq('brief_id', brief.id).eq('verification', 'confirmed')
      .order('fit_score', { ascending: false, nullsFirst: false });
    confirmed = (data || []).map(({ match, ...c }) => ({
      ...c,
      summary: match && match.summary,
      must_haves: (match && match.must_haves) || []
    }));
  }

  res.status(200).json({
    status: brief.status, lang: brief.lang, brief: brief.brief, created_at: brief.created_at,
    pending: pending || 0, confirmed
  });
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

  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  // Called only by this function itself; the shared secret is the throttle.
  if (action === 'scout-step') return handleScoutStep(req, res);

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
