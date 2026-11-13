/**
 * Proplync.mx  ·  messy-input property extractor
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * Agents do not hold listings in a database. They hold them in a ficha tecnica
 * PDF from the developer, a photo of a printed sheet, a WhatsApp message someone
 * forwarded, or a row in an inventory spreadsheet. Retyping that into the
 * generate form is the actual work, and the reason a listing never gets posted.
 *
 * This reads whatever they have and returns the structured fields the rest of
 * the product already speaks: the /generate form, the listing record, and the
 * property page.
 *
 * WHY A SECOND PROVIDER
 * Groq runs content generation and is capped at 1,000 output tokens per minute
 * on this account, which one extraction would eat by itself. Extraction also
 * needs to look at pages and photographs, not just text. So this endpoint talks
 * to Claude and content generation keeps Groq. Set ANTHROPIC_API_KEY in Vercel;
 * without it this reports itself unconfigured instead of failing at request time.
 *
 * NOTE ON SIZE
 * Vercel caps a request body at 4.5 MB and a phone photo of a document blows
 * through that, so the browser uploads to Supabase Storage first and sends URLs
 * here. Images are passed to Claude by URL; PDFs are fetched server-side and
 * inlined, because the document block takes base64.
 * -----------------------------------------------------------------------------
 */

import { parseAmount, parseCount, parseCurrency } from './_lib/extract-fields.js';
import Anthropic from '@anthropic-ai/sdk';
import { safeDetail, logDegraded } from './_lib/health.js';
import { enforceRateLimit } from './_lib/ratelimit.js';
import { groqChat, messageText } from './_lib/groq.js';

const MODEL = 'claude-opus-5';
export const EXTRACT_MODEL = MODEL;   // the readiness check verifies this ID still exists (it differs from Scout's)

/* A PDF is inlined as base64, so it counts against the 32 MB request Anthropic
   accepts. Stay well under it — a ficha tecnica bigger than this is a scan
   nobody needs at full resolution. */
const MAX_PDF_BYTES = 12 * 1024 * 1024;
const MAX_FILES = 8;

const SYSTEM = `Eres un asistente que extrae datos de propiedades inmobiliarias en Mexico a partir de material desordenado: fichas tecnicas en PDF, fotos de hojas impresas, mensajes de WhatsApp, filas de inventario.

Devuelve UNICAMENTE un objeto JSON valido, sin markdown ni backticks, con esta forma exacta:
{
  "title": "titulo corto y descriptivo de la propiedad",
  "town": "ciudad o municipio",
  "neighborhood": "colonia o fraccionamiento, cadena vacia si no aparece",
  "bedrooms": numero entero,
  "bathrooms": numero entero,
  "size": metros cuadrados de construccion como numero entero,
  "parking": numero entero de cajones,
  "operation": "sale" o "rental",
  "currency": "MXN" o "USD",
  "amount": precio como numero entero sin comas ni simbolos,
  "features": "amenidades y detalles reales separados por comas",
  "confidence": {"campo": "high" o "low"},
  "missing": ["nombres de los campos que no pudiste determinar"],
  "notes": "una linea sobre algo relevante que no cabe en los campos, o cadena vacia"
}

Reglas:
- Extrae SOLO lo que aparece en el material. Nunca completes un campo con lo que suele ser tipico.
- Si un dato no aparece, dejalo en 0 o cadena vacia Y agregalo a "missing". Un campo inventado es peor que uno vacio, porque termina publicado como si fuera cierto.
- Marca "low" en confidence para cualquier campo que dedujiste en vez de leer directamente.
- Precios: "1.5 mdp" es 1500000 MXN, "450k usd" es 450000 USD. Si dice mensuales o renta, operation es "rental".
- En "features" pon solo amenidades explicitas (alberca, roof, amueblado, vista al mar). No incluyas recamaras, banos ni metros: esos ya tienen su campo.
- Si el material trae varias propiedades, extrae la primera y menciona en "notes" cuantas viste.`;

/* ── Batch import (?action=batch) ────────────────────────────────────────────
   WHY: the Mini page (docs/CONTEXT-MAP.md, "Mini pages") is sold against an ad
   that promises "up to 10 properties in one link". An agent's real material is
   one WhatsApp dump with several properties in it, so this returns all of them
   (up to 10), each through the same field rules as the single extraction.

   WHY GROQ FIRST FOR TEXT: pasted text needs no vision, and Groq is free. Its
   free tier is small (about 1,000 output tokens a minute), so a long dump can
   hit 429 or come back cut off; then Claude Haiku (cheap) does it. Photos and
   PDFs go to Claude, as the single extraction does. */
export const BATCH_MAX = 10;
const BATCH_TEXT_MODEL = 'claude-haiku-5-5';

const BATCH_SYSTEM = `Extraes propiedades inmobiliarias en Mexico de material desordenado (mensajes de WhatsApp, fichas, listas). El material puede traer VARIAS propiedades.

Devuelve UNICAMENTE un objeto JSON valido, sin markdown, con esta forma:
{"properties":[{"title":"titulo corto","town":"ciudad","neighborhood":"colonia o cadena vacia","bedrooms":0,"bathrooms":0,"size":0,"parking":0,"operation":"sale" o "rental","currency":"MXN" o "USD" o "","amount":0,"features":"amenidades separadas por comas","missing":["campos que no aparecen"]}]}

Reglas:
- Una entrada por propiedad distinta, en el orden en que aparecen, maximo ${BATCH_MAX}.
- Extrae SOLO lo que aparece. Un dato que no aparece va en 0 o cadena vacia Y en "missing". Nunca completes con lo tipico.
- Precios: "1.5 mdp" es 1500000 MXN, "450k usd" es 450000 USD. Si dice renta o mensual, operation es "rental".
- "features": solo amenidades explicitas, sin recamaras, banos ni metros. Breve.
- Si no hay ninguna propiedad, devuelve {"properties":[]}.`;

/**
 * The model's loose answer for one property → the listing fields the rest of the product speaks.
 * Shared by the single and the batch extraction, so both read "4.5 millones" and "2.5 baños" the same way.
 */
export function toListingFields(parsed) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  const count = (v) => parseCount(v).value || 0;
  const baths = parseCount(p.bathrooms);
  const currency = parseCurrency(p.currency);
  const missing = Array.isArray(p.missing) ? p.missing.map(String) : [];
  if (!currency && !missing.includes('currency')) missing.push('currency');
  let notes = String(p.notes || '');
  // listings.bathrooms is a whole number: keep the half bath visible to the agent
  if (baths.half) notes = (notes ? notes + ' ' : '') + `(${baths.value}.5 baños / baths: ${baths.value} completos + medio baño.)`;
  return {
    property: {
      title: String(p.title || '').slice(0, 300),
      town: String(p.town || '').slice(0, 120),
      neighborhood: String(p.neighborhood || '').slice(0, 120),
      bedrooms: count(p.bedrooms),
      bathrooms: baths.value || 0,
      size: Math.round(parseAmount(p.size) || 0),
      parking: count(p.parking),
      operation: p.operation === 'rental' ? 'rental' : 'sale',
      currency,
      amount: Math.round(parseAmount(p.amount) || 0),
      features: String(p.features || '').slice(0, 2000)
    },
    missing,
    confidence: p.confidence && typeof p.confidence === 'object' && !Array.isArray(p.confidence) ? p.confidence : {},
    notes
  };
}

function codeErr(code) { const e = new Error(code); e.code = code; return e; }

/**
 * A batch reply → up to BATCH_MAX validated properties. An entry with neither a title,
 * a price nor a town is not a property (a greeting, a signature) and is dropped.
 * Throws `extraction_unparseable` when the text is not the JSON we asked for.
 */
export function parseBatchReply(raw) {
  const text = String(raw || '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw codeErr('extraction_unparseable');
  let obj;
  try { obj = JSON.parse(text.slice(start, end + 1)); } catch { throw codeErr('extraction_unparseable'); }
  const list = obj && Array.isArray(obj.properties) ? obj.properties : null;
  if (!list) throw codeErr('extraction_unparseable');
  return list
    .map(toListingFields)
    .filter((x) => x.property.title || x.property.amount || x.property.town)
    .slice(0, BATCH_MAX);
}

/** Text-only batch: Groq, then Claude Haiku when Groq is busy or answers badly. */
async function batchFromText(pasted, deps) {
  const prompt = 'Texto pegado por el agente:\n\n' + pasted.slice(0, 12000) + '\n\nResponde solo con el JSON.';
  if (deps.haveGroq) {
    try {
      const data = await deps.groqChat({
        max_tokens: 3000, temperature: 0.1,
        messages: [{ role: 'system', content: BATCH_SYSTEM }, { role: 'user', content: prompt }]
      });
      return { properties: parseBatchReply(deps.messageText(data)), provider: 'groq' };
    } catch (err) {
      logDegraded('extract:batch:groq', err);   // busy or a bad answer: Claude gets its turn
    }
  }
  if (!deps.anthropic) throw codeErr('extraction_unavailable');
  const response = await deps.anthropic.messages.create({
    model: BATCH_TEXT_MODEL, max_tokens: 6000, system: BATCH_SYSTEM,
    messages: [{ role: 'user', content: prompt }]
  });
  return { properties: parseBatchReply(textOf(response)), provider: 'claude' };
}

function textOf(response) {
  return (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

/** Photos/PDFs (+ any text) through Claude, with the batch instructions. `content` is built by readFiles(). */
async function batchFromFiles(content, anthropic) {
  content.push({ type: 'text', text: 'Extrae todas las propiedades de este material y responde solo con el JSON.' });
  const response = await anthropic.messages.create({
    model: MODEL, max_tokens: 8000,
    thinking: { type: 'adaptive' }, output_config: { effort: 'medium' },
    system: BATCH_SYSTEM, messages: [{ role: 'user', content }]
  });
  if (response.stop_reason === 'refusal') throw codeErr('extraction_refused');
  return { properties: parseBatchReply(textOf(response)), provider: 'claude' };
}

/**
 * ?action=batch. Anonymous on purpose (the /mini preview happens before signup), so it is rate limited
 * harder than the single extraction. `deps` lets the tests replace the providers.
 */
export async function handleBatch(req, res, deps = {}) {
  if (await enforceRateLimit(req, res, { bucket: 'extract-batch', limit: 6, windowSec: 3600 })) return;
  const key = process.env.ANTHROPIC_API_KEY;
  const d = {
    groqChat, messageText,
    haveGroq: Boolean(process.env.GROQ_API_KEY),
    anthropic: key ? new Anthropic({ apiKey: key }) : null,
    ...deps
  };
  const { files, text } = req.body || {};
  const list = Array.isArray(files) ? files.slice(0, MAX_FILES) : [];
  const pasted = typeof text === 'string' ? text.trim() : '';
  if (!list.length && !pasted) { res.status(400).json({ error: 'no_input' }); return; }
  if (!d.haveGroq && !d.anthropic) { res.status(503).json({ error: 'extraction_not_configured' }); return; }

  try {
    let out;
    if (list.length) {
      if (!d.anthropic) { res.status(503).json({ error: 'extraction_not_configured' }); return; }
      const content = await readFiles(list);
      if (pasted) content.push({ type: 'text', text: 'Texto pegado por el agente:\n\n' + pasted.slice(0, 12000) });
      if (!content.length) { res.status(400).json({ error: 'no_readable_input' }); return; }
      out = await batchFromFiles(content, d.anthropic);
    } else {
      out = await batchFromText(pasted, d);
    }
    res.status(200).json({ properties: out.properties, total: out.properties.length, provider: out.provider });
  } catch (err) {
    const code = err && err.code;
    if (code === 'extraction_refused') { res.status(422).json({ error: code }); return; }
    if (code === 'extraction_unparseable') { res.status(502).json({ error: code }); return; }
    logDegraded('extract:batch', safeDetail(err));
    res.status(502).json({ error: 'extraction_unavailable', detail: safeDetail(err) });
  }
}

/* Files → Claude content blocks: images by URL or base64, PDFs inlined as base64.
   Shared by the single and the batch extraction. Unreadable or oversized files are skipped. */
async function readFiles(list) {
  const content = [];
  for (const f of list) {
    const mime = (f && f.mediaType) || '';
    const url = f && typeof f.url === 'string' ? f.url : '';
    const isPdf = mime === 'application/pdf';
    const isImg = /^image\/(jpeg|png|webp|gif)$/.test(mime);
    if (!isPdf && !isImg) continue;

    /* Two ways in. Signed-in agents upload to Supabase Storage first and send
       a URL, which keeps big scans out of the request body. Anonymous users
       on /generate have no bucket to write to, so they inline base64 — fine,
       because the page downscales photos before sending and a ficha tecnica
       is normally a couple of MB. */
    let b64 = typeof f.data === 'string' ? f.data.replace(/^data:[^,]+,/, '') : '';

    if (!b64 && /^https:\/\//.test(url)) {
      if (isImg) {
        content.push({ type: 'image', source: { type: 'url', url } });
        continue;
      }
      const r = await fetch(url);          // document blocks take base64, not URLs
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_PDF_BYTES) {
        logDegraded('extract:pdf-too-large', String(buf.length) + ' bytes');
        continue;
      }
      b64 = buf.toString('base64');
    }

    if (!b64) continue;
    if (Buffer.byteLength(b64, 'base64') > MAX_PDF_BYTES) {
      logDegraded('extract:file-too-large', mime);
      continue;
    }

    content.push(isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
      : { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } });
  }
  return content;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  if (req.query && req.query.action === 'batch') return handleBatch(req, res);

  /* Vision calls are the most expensive thing this product does, so gate them
     harder than the text endpoints. */
  if (await enforceRateLimit(req, res, { bucket: 'extract', limit: 12, windowSec: 3600 })) return;

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.status(503).json({ error: 'extraction_not_configured' });
    return;
  }

  const { files, text } = req.body || {};
  const list = Array.isArray(files) ? files.slice(0, MAX_FILES) : [];
  const pasted = typeof text === 'string' ? text.trim() : '';

  if (!list.length && !pasted) {
    res.status(400).json({ error: 'no_input' });
    return;
  }

  try {
    const content = await readFiles(list);

    if (pasted) {
      content.push({ type: 'text', text: 'Texto pegado por el agente:\n\n' + pasted.slice(0, 8000) });
    }

    if (!content.length) {
      res.status(400).json({ error: 'no_readable_input' });
      return;
    }

    content.push({
      type: 'text',
      text: 'Extrae los datos de la propiedad de este material y responde solo con el JSON.'
    });

    const client = new Anthropic({ apiKey: key });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      /* Reading a scanned ficha or a rambling WhatsApp thread is genuinely a
         reasoning task: which number is the price and which is the maintenance
         fee, whether "3/2" means bedrooms and baths. */
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: SYSTEM,
      messages: [{ role: 'user', content }]
    });

    if (response.stop_reason === 'refusal') {
      res.status(422).json({ error: 'extraction_refused' });
      return;
    }

    const textOut = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(textOut.replace(/^```(?:json)?/, '').replace(/```$/, '').trim());
    } catch (e) {
      logDegraded('extract:unparseable', textOut.slice(0, 200));
      res.status(502).json({ error: 'extraction_unparseable' });
      return;
    }

    /* The agent confirms before this becomes a listing, so the reply names the
       fields worth checking (missing, confidence) instead of presenting all of
       it as fact. */
    res.status(200).json(toListingFields(parsed));
  } catch (err) {
    logDegraded('extract:handler', safeDetail(err));
    res.status(502).json({ error: 'extraction_unavailable', detail: safeDetail(err) });
  }
}
