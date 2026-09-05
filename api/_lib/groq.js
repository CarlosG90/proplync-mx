/**
 * Proplync.mx · Groq chat client with model fallback
 * -----------------------------------------------------------------------------
 * Groq retires models on its own schedule. `llama-3.3-70b-versatile` was
 * hardcoded in three endpoints; when Groq dropped it, every AI feature on the
 * site started returning 404 at once — the AI descriptions, the 7-format
 * generator, and natural-language search — with no warning and no fallback.
 *
 * So model choice lives here, once, and a model that has gone missing degrades
 * to a second one instead of taking the whole product down. scripts/health-check.py
 * reads PRIMARY_MODEL out of this file and verifies it against Groq's live
 * /models list, so drift gets caught before a user hits it.
 * -----------------------------------------------------------------------------
 */

import { logDegraded } from './health.js';

export const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

/* Both are non-reasoning models: their completion tokens are all visible
   output, so max_tokens budgets mean what they say. Reasoning models (e.g.
   gpt-oss-120b) silently spend most of the budget on hidden thinking. */
export const PRIMARY_MODEL = 'qwen/qwen3.8-27b';
export const FALLBACK_MODEL = 'openai/gpt-oss-20b';

/** A 404/400 from Groq means "this model id is gone", not "bad request". */
function isModelGone(status, text) {
  if (status === 404) return true;
  return status === 400 && /model|decommission|does not exist/i.test(text || '');
}

/**
 * POST a chat completion, retrying once on a different model if the primary
 * has been retired.
 *
 * @param {object} body  chat-completions body WITHOUT `model` (added here)
 * @returns {Promise<object>} parsed Groq response
 * @throws {Error} if both models fail, or the key is missing
 */
export async function groqChat(body) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('missing_groq_api_key');

  const attempt = async (model) => {
    const r = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ ...body, model })
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  };

  let res = await attempt(PRIMARY_MODEL);

  if (!res.ok && isModelGone(res.status, res.text)) {
    logDegraded('groq:model-retired', `${PRIMARY_MODEL} -> ${res.status}; retrying ${FALLBACK_MODEL}`);
    res = await attempt(FALLBACK_MODEL);
  }

  if (!res.ok) {
    // 429 is the other common one: Groq's free tier is 8k tokens/min, and a
    // single click that fires several generations can trip it.
    if (res.status === 429) logDegraded('groq:rate-limited', res.text.slice(0, 200));
    throw new Error(`Groq responded ${res.status}`);
  }

  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error('invalid_json_from_groq');
  }
}

/** Pull the assistant message text, stripping a ```json fence if present. */
export function messageText(data) {
  const raw = data?.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error('empty_completion');
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
}
