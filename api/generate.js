/**
 * Groq (free tier) → Proplync.mx · Multi-action content API
 * -----------------------------------------------------------------------------
 * Actions:
 *   (default) — 7-format content generator (PDF, post, carousel, story, email, video, ad)
 *   "enhance" — AI photo enhancement via Sharp.js
 *
 * Same pattern as api/describe.js — Groq's OpenAI-compatible endpoint,
 * key stays server-side, "la IA no inventa" principle enforced via system prompt.
 *
 * Free API key (no card required): https://console.groq.com/keys
 * ENV VAR: GROQ_API_KEY
 * -----------------------------------------------------------------------------
 */

import sharp from 'sharp';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'qwen/qwen3.8-27b';

/* ── Photo enhancement constants ── */
const MAX_DIMENSION = 2400;
const JPEG_QUALITY_STD = 82;
const JPEG_QUALITY_HIGH = 92;

/* ── Photo enhancement handler ── */
async function handleEnhance(req, res) {
  const { url, base64, quality } = req.body || {};

  if (!url && !base64) {
    return res.status(400).json({ error: 'missing_image', detail: 'Provide url or base64' });
  }

  try {
    let inputBuffer;

    if (base64) {
      const raw = base64.replace(/^data:image\/\w+;base64,/, '');
      inputBuffer = Buffer.from(raw, 'base64');
    } else {
      const imgRes = await fetch(url, { headers: { 'User-Agent': 'Proplync/1.0' } });
      if (!imgRes.ok) throw new Error(`Image fetch failed: ${imgRes.status}`);
      const arrayBuf = await imgRes.arrayBuffer();
      inputBuffer = Buffer.from(arrayBuf);
    }

    const isHigh = quality === 'high';
    const jpegQuality = isHigh ? JPEG_QUALITY_HIGH : JPEG_QUALITY_STD;

    let pipeline = sharp(inputBuffer)
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .normalize()
      .sharpen({ sigma: 1.0, m1: 0.8, m2: 0.5 })
      .linear(1.08, 4)
      .modulate({ brightness: 1.0, saturation: 1.15, hue: 0 })
      .jpeg({ quality: jpegQuality, mozjpeg: true });

    const outputBuffer = await pipeline.toBuffer();
    const metadata = await sharp(outputBuffer).metadata();
    const enhancedBase64 = `data:image/jpeg;base64,${outputBuffer.toString('base64')}`;

    res.status(200).json({
      enhanced: enhancedBase64,
      meta: {
        width: metadata.width,
        height: metadata.height,
        size_kb: Math.round(outputBuffer.length / 1024),
        enhancements: ['normalize', 'sharpen', 'contrast_boost', 'saturation_boost']
      }
    });
  } catch (err) {
    console.error('enhance error:', err);
    res.status(500).json({ error: 'enhancement_failed', detail: err.message });
  }
}

/* ── Day-to-Dusk virtual twilight handler ── */
async function handleDayToDusk(req, res) {
  const { url, base64 } = req.body || {};

  if (!url && !base64) {
    return res.status(400).json({ error: 'missing_image', detail: 'Provide url or base64' });
  }

  try {
    let inputBuffer;

    if (base64) {
      const raw = base64.replace(/^data:image\/\w+;base64,/, '');
      inputBuffer = Buffer.from(raw, 'base64');
    } else {
      const imgRes = await fetch(url, { headers: { 'User-Agent': 'Proplync/1.0' } });
      if (!imgRes.ok) throw new Error(`Image fetch failed: ${imgRes.status}`);
      const arrayBuf = await imgRes.arrayBuffer();
      inputBuffer = Buffer.from(arrayBuf);
    }

    /* Get image dimensions for overlay generation */
    const inputMeta = await sharp(inputBuffer).metadata();
    const w = Math.min(inputMeta.width || 1600, MAX_DIMENSION);
    const h = Math.min(inputMeta.height || 1200, MAX_DIMENSION);

    /* Step 1: Resize + base warm color grade (darken, warm shift, boost saturation) */
    let base = sharp(inputBuffer)
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .modulate({
        brightness: 0.62,     // darken to twilight level
        saturation: 1.25,     // boost warm tones
        hue: -12              // shift slightly towards warm/amber
      })
      .linear(1.15, -8)      // increase contrast, deepen shadows
      .tint({ r: 255, g: 180, b: 80 });  // warm amber tint

    const baseBuffer = await base.toBuffer();
    const baseMeta = await sharp(baseBuffer).metadata();
    const finalW = baseMeta.width;
    const finalH = baseMeta.height;

    /* Step 2: Create gradient overlays */
    // Top overlay: deep blue-purple (dusk sky simulation)
    const skyGradientSvg = `<svg width="${finalW}" height="${finalH}">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#1a1040" stop-opacity="0.55"/>
          <stop offset="35%" stop-color="#2d1855" stop-opacity="0.30"/>
          <stop offset="60%" stop-color="#ff8c42" stop-opacity="0.12"/>
          <stop offset="100%" stop-color="#000000" stop-opacity="0.0"/>
        </linearGradient>
      </defs>
      <rect width="${finalW}" height="${finalH}" fill="url(#sky)"/>
    </svg>`;

    // Bottom overlay: warm golden glow (simulates warm interior/landscape light)
    const warmGlowSvg = `<svg width="${finalW}" height="${finalH}">
      <defs>
        <linearGradient id="warm" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="#ff9a3c" stop-opacity="0.18"/>
          <stop offset="40%" stop-color="#ffb347" stop-opacity="0.08"/>
          <stop offset="100%" stop-color="#000000" stop-opacity="0.0"/>
        </linearGradient>
      </defs>
      <rect width="${finalW}" height="${finalH}" fill="url(#warm)"/>
    </svg>`;

    // Vignette overlay: subtle darkening at edges
    const vignetteSvg = `<svg width="${finalW}" height="${finalH}">
      <defs>
        <radialGradient id="vig" cx="50%" cy="50%" r="70%">
          <stop offset="50%" stop-color="#000000" stop-opacity="0.0"/>
          <stop offset="100%" stop-color="#000000" stop-opacity="0.35"/>
        </radialGradient>
      </defs>
      <rect width="${finalW}" height="${finalH}" fill="url(#vig)"/>
    </svg>`;

    const skyOverlay = await sharp(Buffer.from(skyGradientSvg)).png().toBuffer();
    const warmOverlay = await sharp(Buffer.from(warmGlowSvg)).png().toBuffer();
    const vignetteOverlay = await sharp(Buffer.from(vignetteSvg)).png().toBuffer();

    /* Step 3: Composite all overlays onto the base */
    const outputBuffer = await sharp(baseBuffer)
      .composite([
        { input: skyOverlay, blend: 'over' },
        { input: warmOverlay, blend: 'screen' },
        { input: vignetteOverlay, blend: 'multiply' }
      ])
      .sharpen({ sigma: 0.8, m1: 0.6, m2: 0.4 })
      .jpeg({ quality: JPEG_QUALITY_HIGH, mozjpeg: true })
      .toBuffer();

    const outputMeta = await sharp(outputBuffer).metadata();
    const duskBase64 = `data:image/jpeg;base64,${outputBuffer.toString('base64')}`;

    res.status(200).json({
      enhanced: duskBase64,
      meta: {
        width: outputMeta.width,
        height: outputMeta.height,
        size_kb: Math.round(outputBuffer.length / 1024),
        enhancements: ['twilight_grade', 'sky_overlay', 'warm_glow', 'vignette', 'sharpen']
      }
    });
  } catch (err) {
    console.error('day-to-dusk error:', err);
    res.status(500).json({ error: 'day_to_dusk_failed', detail: err.message });
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  /* ── Route to sub-handlers by action ── */
  const { action } = req.body || {};
  if (action === 'enhance') {
    return handleEnhance(req, res);
  }
  if (action === 'day-to-dusk') {
    return handleDayToDusk(req, res);
  }

  const key = process.env.GROQ_API_KEY;
  if (!key) {
    res.status(500).json({ error: 'missing_groq_api_key' });
    return;
  }

  const {
    title, town, neighborhood, bedrooms, bathrooms, size,
    parking, operation, currency, amount, lang, features
  } = req.body || {};

  if (!title || !town) {
    res.status(400).json({ error: 'missing_property_fields' });
    return;
  }

  const isEs = lang !== 'en';
  const opWord = operation === 'rental'
    ? (isEs ? 'renta' : 'rent')
    : (isEs ? 'venta' : 'sale');

  const propertyLine = isEs
    ? `Propiedad: "${title}" en ${neighborhood || ''}, ${town}. ${bedrooms} recamaras, ${bathrooms} banos, ${size} m², ${parking || 0} estacionamiento(s). En ${opWord} por ${currency} $${amount}.${features ? ' Caracteristicas: ' + features : ''}`
    : `Property: "${title}" in ${neighborhood || ''}, ${town}. ${bedrooms} bedrooms, ${bathrooms} bathrooms, ${size} m², ${parking || 0} parking spot(s). For ${opWord} at ${currency} $${amount}.${features ? ' Features: ' + features : ''}`;

  const system = isEs
    ? `Eres un especialista en contenido inmobiliario para la Riviera Maya de Mexico. Genera copy de marketing para 7 formatos de contenido a partir de un solo listado. Todo el copy en espanol.

Reglas obligatorias (aplican a los 7 formatos):
- Nunca inventes ni infles datos (metros, anio, permisos, vistas, escuelas). Usa solo lo que se te dio.
- Lidera cada pieza con la caracteristica mas fuerte del inmueble, no con un listado seco de datos.
- Se especifico y sensorial ("luz de la manana entra por la cocina"), evita cliches vacios ("no te lo puedes perder", "unico en su tipo") y el exceso de signos de exclamacion.
- Describe la propiedad y el trato, nunca al comprador ideal (nada de "perfecto para una familia joven" ni lenguaje que discrimine o segregue por caracteristicas protegidas).
- No inventes urgencia falsa ("se va a acabar") salvo que sea un plazo real dado en los datos.
- El copy publicitario (formato "ad") es el mas sensible: usa vocabulario real de botones de CTA (Mas informacion, Contactar, Agendar visita), sin superlativos no verificables.

Para el formato "video" (un Reel corto): elige EXACTAMENTE UNO de estos 12 tipos probados de Reel inmobiliario
segun cual encaje mejor con los datos de esta propiedad, y estructuralo en 3 tiempos: hook (0-2s, texto en
pantalla, curiosidad o dato concreto, nunca generico), cuerpo (3-4 escenas que cumplen lo que promete el hook),
y CTA final (una accion especifica). El texto debe funcionar sin sonido (todo en pantalla).
Tipos disponibles: "Revelacion de cuarto wow" (puerta cerrada, hook "Espera a ver esto..."), "Tour cinematografico
completo" (recorrido fluido de toda la propiedad), "Adivina el precio" (exterior primero, pide adivinar, revela en
el interior), "Guia del vecindario" (puntos clave: cafes, parques, escuelas), "Antes/despues de staging",
"Dato del mercado" (una estadistica + un insight + una conclusion), "Que te da $X" (comparacion de precio),
"El error comun" (error del comprador/vendedor, consecuencia, solucion), "Cuenta regresiva de casa abierta"
(mejores caracteristicas + fecha/hora/direccion), "POV caminando" (recorrido en primera persona sin narracion),
"Mito vs realidad" (mito comun desmentido con el hecho), "Por que me encanta esta casa" (reaccion genuina a una
caracteristica especifica).

Responde UNICAMENTE con un objeto JSON valido (sin markdown, sin backticks, sin texto extra) con esta estructura exacta:
{
  "pdf": {
    "headline": "titulo atractivo para la ficha",
    "description": "descripcion comercial de 60-80 palabras",
    "features_list": ["caracteristica 1", "caracteristica 2", "caracteristica 3", "caracteristica 4", "caracteristica 5"]
  },
  "post": {
    "caption": "texto para Instagram, 2-3 oraciones con emojis relevantes",
    "hashtags": "#Hashtag1 #Hashtag2 #Hashtag3 #Hashtag4 #Hashtag5"
  },
  "carousel": [
    { "slide_title": "titulo portada", "slide_text": "texto breve portada" },
    { "slide_title": "titulo ubicacion", "slide_text": "texto sobre la zona" },
    { "slide_title": "titulo interior", "slide_text": "texto sobre espacios" },
    { "slide_title": "titulo amenidades", "slide_text": "texto sobre caracteristicas" },
    { "slide_title": "titulo contacto", "slide_text": "texto CTA" }
  ],
  "story": {
    "headline": "texto impactante corto para story",
    "cta_text": "texto del CTA"
  },
  "email": {
    "subject": "asunto del correo",
    "preview_text": "texto de previsualizacion (max 90 caracteres)",
    "body_html": "1-2 parrafos de texto comercial en texto plano (sin HTML)"
  },
  "video": {
    "reel_type": "uno de los 12 tipos de Reel listados arriba",
    "hook_text": "texto del hook (0-2s), curiosidad o dato concreto",
    "scene_texts": ["escena del cuerpo 1", "escena del cuerpo 2", "escena del cuerpo 3"],
    "cta_text": "accion especifica final (ej. Escribe TOUR para agendar tu visita)"
  },
  "ad": {
    "primary_text": "texto principal del anuncio, 1-2 oraciones con el gancho y un dato concreto",
    "headline": "titulo del anuncio, menos de 40 caracteres",
    "description": "linea de apoyo breve (disponibilidad o precio, sin urgencia falsa)",
    "cta_label": "Mas informacion"
  }
}`
    : `You are a real estate content specialist for Mexico's Riviera Maya. Generate marketing copy for 7 content formats from a single listing. All copy in English.

Mandatory rules (apply to all 7 formats):
- Never invent or inflate facts (size, year, permits, views, schools). Use only what was given.
- Lead every piece with the property's strongest feature, not a dry spec dump.
- Be specific and sensory ("morning light pours into the kitchen"), avoid empty cliches ("must see", "one of a kind") and exclamation-mark overload.
- Describe the property and the deal, never the ideal buyer (no "perfect for a young family" or language that discriminates/steers by protected characteristics).
- Do not fabricate urgency ("won't last") unless it's a real deadline given in the data.
- The ad format is the most compliance-sensitive: use real CTA button vocabulary (Learn More, Contact Us, Book a Tour), no unverifiable superlatives.

For the "video" format (a short Reel): choose EXACTLY ONE of these 12 proven real-estate Reel types based on
what fits this property's data best, and structure it in 3 beats: a hook (0-2s, on-screen text, curiosity or a
concrete detail, never generic), a body (3-4 scenes that deliver on what the hook promised), and a final CTA
(one specific action). Text must work with sound off (everything on screen).
Available types: "Wow room reveal" (closed door, hook "Wait for it..."), "Cinematic full tour" (smooth
walkthrough of the whole property), "Price guess" (exterior first, ask viewers to guess, reveal during the
interior), "Neighborhood guide" (key spots: cafes, parks, schools), "Before/after staging", "Market update hot
take" (one stat + one insight + one takeaway), "What $X gets you" (price comparison), "The common mistake"
(buyer/seller mistake, consequence, fix), "Open house countdown" (best features + date/time/address), "Walking
POV" (first-person walkthrough, no narration), "Myth vs reality" (common myth debunked with the fact), "Why I
love this house" (genuine reaction to one specific feature).

Respond ONLY with a valid JSON object (no markdown, no backticks, no extra text) with this exact structure:
{
  "pdf": {
    "headline": "attractive headline for the fact sheet",
    "description": "sales description of 60-80 words",
    "features_list": ["feature 1", "feature 2", "feature 3", "feature 4", "feature 5"]
  },
  "post": {
    "caption": "Instagram caption, 2-3 sentences with relevant emojis",
    "hashtags": "#Hashtag1 #Hashtag2 #Hashtag3 #Hashtag4 #Hashtag5"
  },
  "carousel": [
    { "slide_title": "cover title", "slide_text": "brief cover text" },
    { "slide_title": "location title", "slide_text": "text about the area" },
    { "slide_title": "interior title", "slide_text": "text about spaces" },
    { "slide_title": "amenities title", "slide_text": "text about features" },
    { "slide_title": "contact title", "slide_text": "CTA text" }
  ],
  "story": {
    "headline": "short impactful story text",
    "cta_text": "CTA button text"
  },
  "email": {
    "subject": "email subject line",
    "preview_text": "preview text (max 90 characters)",
    "body_html": "1-2 paragraphs of sales copy in plain text (no HTML)"
  },
  "video": {
    "reel_type": "one of the 12 Reel types listed above",
    "hook_text": "hook text (0-2s), curiosity or a concrete detail",
    "scene_texts": ["body scene 1", "body scene 2", "body scene 3"],
    "cta_text": "specific final action (e.g. DM TOUR to book a showing)"
  },
  "ad": {
    "primary_text": "ad primary text, 1-2 sentences with the hook plus one concrete detail",
    "headline": "ad headline, under 40 characters",
    "description": "short supporting line (availability or price, no fake urgency)",
    "cta_label": "Learn More"
  }
}`;

  const user = propertyLine;

  /* ── Compact mode for the dashboard's AI Assist: only what a listing page
     needs (description + features). ~5x fewer tokens than the 7-format run,
     which matters on Groq's free tier (8k tokens/min): two parallel full
     generations from a single click were enough to trip 429s in production. ── */
  if (action === 'listing') {
    const compactSystem = isEs
      ? `Eres un especialista en contenido inmobiliario para la Riviera Maya. A partir de los datos del listado escribe una descripcion comercial de 60-80 palabras y una lista de exactamente 5 caracteristicas cortas.
Reglas: nunca inventes ni infles datos (metros, vistas, acabados, amenidades, "techado", "frente al mar") — usa unicamente lo que se te dio; lidera con la caracteristica mas fuerte; se especifico y sensorial; evita cliches y exceso de exclamaciones; describe la propiedad, nunca al comprador ideal.
Responde UNICAMENTE con un objeto JSON valido, sin markdown: {"description":"...","features_list":["...","...","...","...","..."]}`
      : `You are a real estate content specialist for Mexico's Riviera Maya. From the listing data write a 60-80 word sales description and a list of exactly 5 short features.
Rules: never invent or inflate facts (size, views, finishes, amenities, "covered", "beachfront") — use only what was given; lead with the strongest feature; be specific and sensory; avoid cliches and exclamation overload; describe the property, never the ideal buyer.
Respond ONLY with a valid JSON object, no markdown: {"description":"...","features_list":["...","...","...","...","..."]}`;
    try {
      const r = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: compactSystem },
            { role: 'user', content: user }
          ],
          temperature: 0.5,
          max_tokens: 450,
          response_format: { type: 'json_object' }
        })
      });
      if (!r.ok) throw new Error(`Groq responded ${r.status}`);
      const data = await r.json();
      let raw = data.choices?.[0]?.message?.content?.trim();
      if (!raw) throw new Error('empty_completion');
      raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      const parsed = JSON.parse(raw);
      res.status(200).json({
        content: {
          pdf: {
            description: String(parsed.description || ''),
            features_list: Array.isArray(parsed.features_list) ? parsed.features_list.slice(0, 6).map(String) : []
          }
        }
      });
    } catch (err) {
      res.status(502).json({ error: 'generation_unavailable', detail: String(err.message) });
    }
    return;
  }

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
        max_tokens: 2000
      })
    });

    if (!r.ok) throw new Error(`Groq responded ${r.status}`);

    const data = await r.json();
    let raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) throw new Error('empty_completion');

    /* Strip markdown code fences if present */
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

    const content = JSON.parse(raw);
    res.status(200).json({ content });
  } catch (err) {
    res.status(502).json({ error: 'generation_unavailable', detail: String(err.message) });
  }
}
