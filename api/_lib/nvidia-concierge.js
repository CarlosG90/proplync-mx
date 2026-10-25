/**
 * Proplync.mx · NVIDIA Concierge via the NIM API
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * Concierge runs on NVIDIA NIM's free tier first (Claude is gone from this path). The API
 * is OpenAI-compatible. This file only talks to NVIDIA: choosing providers, sending the
 * system prompt, validating the reply and falling back all live in concierge-turn.js.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { logDegraded } from './health.js';

const NVIDIA_NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
/* WHY A LIST, NOT ONE MODEL
   build.nvidia.com lists far more models than a free account can call. nvidia/nvidia-nemotron-nano-9b-v2 left the
   catalog; its successor nvidia/nemotron-nano-3-30b-a3b IS listed but answers
   `404 Function ... Not found for account` for this account (seen in production on 2026-10-25). A catalog entry
   proves nothing about access, so Concierge tries these in order and skips, for the life of the instance, any model
   that answers 404. The first one that works serves the turn; if none does, the caller falls back to Groq as before.
   `node scripts/doctor.mjs --probe` sends a tiny real request to each from inside production and shows which work:
   reorder this list from that evidence. NVIDIA_CONCIERGE_MODELS (comma separated) overrides it without a code change.
   Prefer instruct models or ones that can switch thinking off: a turn must finish in 9 s. */
const DEFAULT_MODELS = [
  'nvidia/nemotron-nano-3-30b-a3b',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'nvidia/nemotron-3.5-bolt-e4b',
  'nv-mistralai/mistral-nemo-12b-instruct',
  'google/gemma-3-12b-it',
  'openai/gpt-oss-20b'
];

export function conciergeModels(env = process.env) {
  const fromEnv = String(env.NVIDIA_CONCIERGE_MODELS || '').split(',').map((m) => m.trim()).filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_MODELS;
}

export const NVIDIA_MODEL = conciergeModels()[0];   // the readiness check verifies the preferred ID is still listed

const unavailable = new Set();   // models that answered 404 for this account, until this instance is recycled
export function resetUnavailableModels() { unavailable.clear(); }
const REQUEST_TIMEOUT_MS = 9000;

function nvidiaError(status, text) {
  const code = status === 401 ? 'nvidia_auth_failed' :
               status === 404 ? 'nvidia_model_unavailable' :
               status === 429 ? 'nvidia_rate_limited' :
               status >= 500 ? 'nvidia_unavailable' :
               'nvidia_request_failed';
  const error = new Error(`NVIDIA NIM ${status}: ${text}`);
  error.code = code;
  return error;
}

async function requestModel(model, messages, options, apiKey) {
  const body = JSON.stringify({
    model,
    messages,
    max_tokens: options.max_tokens || 1400,
    temperature: options.temperature !== undefined ? options.temperature : 0.4,
    top_p: 0.9,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || REQUEST_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl || fetch)(NVIDIA_NIM_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    if (!response.ok) throw nvidiaError(response.status, await response.text());
    const data = await response.json();
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error('nvidia_invalid_response: no message in choices');
    }
    /* Empty content (a reasoning model that spent its budget thinking) is bad output, not an outage:
       the caller validates it and gets one repair attempt. */
    return data.choices[0].message.content || '';
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error('nvidia_timeout: request exceeded 9s');
      timeoutErr.code = 'nvidia_timeout';
      throw timeoutErr;
    }
    if (err.code) throw err;
    throw new Error(`nvidia_unavailable: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function nvidiaChat(messages, options = {}) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error('NVIDIA_API_KEY not configured');

  let lastUnavailable = null;
  for (const model of conciergeModels()) {
    if (unavailable.has(model)) continue;
    try {
      return await requestModel(model, messages, options, apiKey);
    } catch (err) {
      if (err.code !== 'nvidia_model_unavailable') throw err;   // rate limit, timeout, outage: not this model's fault
      unavailable.add(model);
      lastUnavailable = err;
      logDegraded('nvidia:model-unavailable', new Error(`${model} is not available to this account: ${err.message.slice(0, 160)}`));
    }
  }
  throw lastUnavailable || nvidiaError(404, 'no NVIDIA model is available to this account');
}

/**
 * One tiny real request per model, to learn which ones this account can actually call. Costs a few tokens each.
 * Returns [{model, ok, status, ms, detail}]. Used by the doctor, never on a buyer's request.
 */
export async function probeNvidiaModels(models = conciergeModels(), { fetchImpl, apiKey = process.env.NVIDIA_API_KEY } = {}) {
  // In parallel with a short timeout each, so the whole probe fits inside one serverless invocation.
  return Promise.all(models.map(async (model) => {
    const started = Date.now();
    try {
      await requestModel(model, [{ role: 'user', content: 'Responde solo: ok' }], { max_tokens: 8, temperature: 0, fetchImpl, timeoutMs: 8000 }, apiKey);
      return { model, ok: true, status: 200, ms: Date.now() - started };
    } catch (err) {
      const status = Number((String(err.message).match(/NVIDIA NIM (\d{3})/) || [])[1]) || null;
      return { model, ok: false, status, ms: Date.now() - started, detail: String(err.message).replace(/\s+/g, ' ').slice(0, 160) };
    }
  }));
}
