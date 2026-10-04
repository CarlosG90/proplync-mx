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
 * Claude runs the conversation and the extraction: tone matters here, it is the
 * only thing the buyer ever talks to, and api/extract.js already proved this
 * pattern. Groq runs Whisper for speech to text. That split is not arbitrary --
 * Claude takes no audio input, and Groq's 1,000 output-tokens-per-minute cap
 * (documented in api/extract.js) applies to chat completions, not to the
 * transcription endpoint, so Whisper is the one job Groq is free to do here.
 *
 * ONE FUNCTION, SEVERAL ACTIONS
 * Vercel Hobby allows 12 serverless functions and this is the twelfth. Every
 * future Finder endpoint has to arrive as another `action` on this file until
 * the account moves to Pro. Same reason /api/nlsearch is folded into
 * api/generate.js -- see the rewrite in vercel.json.
 *
 * WHAT THIS DOES NOT DO
 * It stores nothing yet, it never promises a property exists, and it gives no
 * legal, tax or financial advice. Persistence (buyers, buyer_briefs) and its
 * row-level security land with migration 009.
 * -----------------------------------------------------------------------------
 */

import Anthropic from '@anthropic-ai/sdk';
import { safeDetail, logDegraded } from './_lib/health.js';
import { enforceRateLimit } from './_lib/ratelimit.js';

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

async function handleTurn(req, res) {
  if (!process.env.ANTHROPIC_API_KEY) {
    /* Preview deployments do not carry this key yet. Say so plainly rather than
       failing in a way the buyer would read as a broken product. */
    res.status(503).json({
      error: 'concierge_unconfigured',
      detail: 'ANTHROPIC_API_KEY is not set in this environment.'
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
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const out = await client.messages.create({
      model: MODEL,
      max_tokens: 1400,
      system: SYSTEM,
      messages: messages
    });

    const text = (out.content || []).filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text; }).join('');
    const parsed = readJson(text);

    res.status(200).json({
      say: String(parsed.say || '').slice(0, 4000),
      brief: parsed.brief && typeof parsed.brief === 'object' ? parsed.brief : {},
      missing: Array.isArray(parsed.missing) ? parsed.missing.slice(0, 20) : [],
      done: parsed.done === true
    });
  } catch (err) {
    logDegraded('finder:turn', err);
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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  /* Both actions cost real money per call, so throttle before doing any work.
     enforceRateLimit writes the 429 itself and returns true to mean "stop". */
  if (await enforceRateLimit(req, res, { bucket: 'finder', limit: 20, windowSec: 60 })) return;

  const action = String(req.query.action || '');
  if (action === 'turn') return handleTurn(req, res);
  if (action === 'transcribe') return handleTranscribe(req, res);
  res.status(400).json({ error: 'unknown_action' });
}
