/**
 * Groq (free tier) → Proplync.mx · AI property description generator
 * -----------------------------------------------------------------------------
 * OpenAI-compatible chat completions API. The key must never reach the
 * browser, so this proxy holds it server-side and only forwards the listing
 * fields the page already has — no invented facts, same promise the rest of
 * the product makes ("La IA no inventa").
 *
 * Free API key (no card required): https://console.groq.com/keys
 * SET ONE ENV VAR: GROQ_API_KEY
 * -----------------------------------------------------------------------------
 */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'llama-3.3-70b-versatile';

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

  const { title, town, neighborhood, bedrooms, bathrooms, size, operation, currency, amount, lang } =
    req.body || {};
  if (!title || !town) {
    res.status(400).json({ error: 'missing_property_fields' });
    return;
  }

  const isEs = lang !== 'en';
  const opWord = operation === 'rental' ? (isEs ? 'renta' : 'rent') : (isEs ? 'venta' : 'sale');
  const system = isEs
    ? 'Eres un redactor inmobiliario en México. Escribe descripciones de venta breves, cálidas y honestas, sin inventar datos que no te dieron. Máximo 80 palabras.'
    : "You are a real estate copywriter in Mexico. Write short, warm, honest sales descriptions, never inventing facts you weren't given. Max 80 words.";
  const user = isEs
    ? `Propiedad: ${title}, en ${neighborhood}, ${town}. ${bedrooms} recámaras, ${bathrooms} baños, ${size} m². En ${opWord} por ${currency} $${amount}. Escribe una descripción comercial.`
    : `Property: ${title}, in ${neighborhood}, ${town}. ${bedrooms} bedrooms, ${bathrooms} bathrooms, ${size} m². For ${opWord} at ${currency} $${amount}. Write a sales description.`;

  try {
    const r = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        temperature: 0.7,
        max_tokens: 200
      })
    });
    if (!r.ok) throw new Error(`Groq responded ${r.status}`);
    const data = await r.json();
    const description = data.choices?.[0]?.message?.content?.trim();
    if (!description) throw new Error('empty_completion');
    res.status(200).json({ description });
  } catch (err) {
    res.status(502).json({ error: 'description_unavailable', detail: String(err.message) });
  }
}
