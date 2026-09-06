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

import Anthropic from '@anthropic-ai/sdk';
import { safeDetail, logDegraded } from './_lib/health.js';
import { enforceRateLimit } from './_lib/ratelimit.js';

const MODEL = 'claude-opus-5';

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

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

    const num = v => {
      const n = parseInt(String(v == null ? '' : v).replace(/[^0-9]/g, ''), 10);
      return Number.isFinite(n) ? n : 0;
    };

    res.status(200).json({
      property: {
        title: String(parsed.title || ''),
        town: String(parsed.town || ''),
        neighborhood: String(parsed.neighborhood || ''),
        bedrooms: num(parsed.bedrooms),
        bathrooms: num(parsed.bathrooms),
        size: num(parsed.size),
        parking: num(parsed.parking),
        operation: parsed.operation === 'rental' ? 'rental' : 'sale',
        currency: parsed.currency === 'MXN' ? 'MXN' : 'USD',
        amount: num(parsed.amount),
        features: String(parsed.features || '')
      },
      /* The agent confirms before this becomes a listing, so name the fields
         worth checking instead of presenting all of it as fact. */
      missing: Array.isArray(parsed.missing) ? parsed.missing.map(String) : [],
      confidence: parsed.confidence && typeof parsed.confidence === 'object' ? parsed.confidence : {},
      notes: String(parsed.notes || '')
    });
  } catch (err) {
    logDegraded('extract:handler', safeDetail(err));
    res.status(502).json({ error: 'extraction_unavailable', detail: safeDetail(err) });
  }
}
