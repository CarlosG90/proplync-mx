/**
 * Groq (free tier) → Proplync.mx · Natural-language search parser
 * -----------------------------------------------------------------------------
 * Turns a free-text query ("2 bedroom condo near the beach under $400k") into
 * the same structured filters /api/search already accepts (op, town, beds,
 * minPrice, maxPrice, minSize, maxSize, q). The page still runs the real
 * search itself — this endpoint only extracts filters, it never invents or
 * returns listings on its own.
 *
 * Free API key (no card required): https://console.groq.com/keys
 * Reuses GROQ_API_KEY (same var as /api/describe.js).
 * -----------------------------------------------------------------------------
 */

import { groqChat, messageText } from './_lib/groq.js';

const TOWNS = ['Tulum', 'Playa del Carmen', 'Puerto Morelos', 'Cancún', 'Cancun'];

const SYSTEM_PROMPT = `You extract real-estate search filters from a buyer's free-text query in Spanish or English, for listings in Mexico's Riviera Maya (Tulum, Playa del Carmen, Puerto Morelos, Cancún).

Respond with ONLY a JSON object, no prose, matching this exact shape (omit any key you can't confidently infer from the text — do not guess or invent values):
{
  "op": "sale" | "rental",
  "town": string,
  "beds": integer,
  "minPrice": number,
  "maxPrice": number,
  "minSize": number,
  "maxSize": number,
  "q": string
}

Rules:
- "op" is "rental" only if the text clearly asks for renting ("renta", "rent", "for rent", "/mes", "/mo"). Otherwise omit it (don't assume sale).
- Prices given in "k" (e.g. "400k", "$400k") mean thousands — multiply by 1000. Assume USD unless pesos/MXN is explicit.
- "beds" is a minimum bedroom count if the text says a number of bedrooms/recámaras.
- "town" must be one of exactly: Tulum, Playa del Carmen, Puerto Morelos, Cancún — only if a matching city/area is clearly named in the text.
- "q" is matched as a LITERAL substring against each listing's title and location text — it is NOT a semantic or amenity search. Only put a term in "q" if it's plausibly a literal word that would appear in a listing's title (e.g. a named development like "Aldea Zamá" or "Playacar"). NEVER put generic descriptive phrases there (e.g. "near the beach", "con alberca", "pet friendly", "con vista al mar") — those don't literally appear in titles and would wrongly filter out real matches. When in doubt, omit "q" entirely.
- If nothing can be confidently extracted, return {}.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const key = process.env.GROQ_API_KEY;
  if (!key) {
    res.status(500).json({ error: 'missing_groq_api_key' });
    return;
  }

  const { query } = req.body || {};
  if (!query || !String(query).trim()) {
    res.status(400).json({ error: 'missing_query' });
    return;
  }

  try {
    const data = await groqChat({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: String(query).slice(0, 300) }
      ],
      temperature: 0,
      max_tokens: 200,
      response_format: { type: 'json_object' }
    });
    const raw = messageText(data);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('invalid_json_from_model');
    }

    // sanitize against the exact shape /api/search expects — never trust the
    // model's output directly into query params
    const filters = {};
    if (parsed.op === 'sale' || parsed.op === 'rental') filters.op = parsed.op;
    if (typeof parsed.town === 'string' && TOWNS.includes(parsed.town)) {
      filters.town = parsed.town === 'Cancun' ? 'Cancún' : parsed.town;
    }
    if (Number.isFinite(parsed.beds) && parsed.beds > 0) filters.beds = Math.floor(parsed.beds);
    if (Number.isFinite(parsed.minPrice) && parsed.minPrice > 0) filters.minPrice = parsed.minPrice;
    if (Number.isFinite(parsed.maxPrice) && parsed.maxPrice > 0) filters.maxPrice = parsed.maxPrice;
    if (Number.isFinite(parsed.minSize) && parsed.minSize > 0) filters.minSize = parsed.minSize;
    if (Number.isFinite(parsed.maxSize) && parsed.maxSize > 0) filters.maxSize = parsed.maxSize;
    if (typeof parsed.q === 'string' && parsed.q.trim()) filters.q = parsed.q.trim().slice(0, 80);

    res.status(200).json({ filters });
  } catch (err) {
    res.status(502).json({ error: 'nlsearch_unavailable', detail: String(err.message) });
  }
}
