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

import { groqChat, messageText } from './_lib/groq.js';

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
    ? 'Eres un redactor inmobiliario en México. Escribe descripciones de venta breves, cálidas y honestas, liderando con la característica más fuerte del inmueble. Nunca inventes ni infles datos que no te dieron, y nunca describas al comprador ideal (nada de "perfecto para..." ni lenguaje que discrimine o segregue). Evita clichés vacíos ("no te lo puedes perder"). Máximo 80 palabras.'
    : 'You are a real estate copywriter in Mexico. Write short, warm, honest sales descriptions, leading with the property\'s strongest feature. Never invent or inflate facts you weren\'t given, and never describe the ideal buyer (no "perfect for..." or language that discriminates/steers). Avoid empty clichés ("must see"). Max 80 words.';
  const user = isEs
    ? `Propiedad: ${title}, en ${neighborhood}, ${town}. ${bedrooms} recámaras, ${bathrooms} baños, ${size} m². En ${opWord} por ${currency} $${amount}. Escribe una descripción comercial.`
    : `Property: ${title}, in ${neighborhood}, ${town}. ${bedrooms} bedrooms, ${bathrooms} bathrooms, ${size} m². For ${opWord} at ${currency} $${amount}. Write a sales description.`;

  try {
    const data = await groqChat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.7,
      max_tokens: 200
    });
    res.status(200).json({ description: messageText(data) });
  } catch (err) {
    res.status(502).json({ error: 'description_unavailable', detail: String(err.message) });
  }
}
