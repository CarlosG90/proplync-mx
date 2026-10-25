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
/* NVIDIA STAYS OFF UNTIL A MODEL HAS PASSED A REAL CONCIERGE TURN
   Two lessons from production (2026-10-25):
   1. build.nvidia.com lists far more models than a free account can call. nvidia/nemotron-nano-3-30b-a3b is
      listed but answers `404 Function ... Not found for account`. A catalog entry proves nothing about access.
   2. A model that answers a tiny request is not a model that can run a turn. nemotron-3.5-lightning-30b-a3b,
      -bolt-e4b and gpt-oss-20b all answered "ok" in about 200 ms, yet on a real turn lightning timed out at 9 s
      and then returned empty replies (a reasoning model spending its whole token budget thinking). Each failed
      turn cost the buyer 11-18 s before Groq answered, against about 1 s on Groq alone.
   So PREFERRED_MODELS is empty on purpose and Concierge goes straight to Groq. `node scripts/doctor.mjs --probe`
   runs the REAL Concierge prompt through every model in CANDIDATE_MODELS, plain and with thinking switched off,
   and prints which ones return valid brief JSON inside the 9 s limit. Put a model here only when it passes, with
   the request options that made it pass in MODEL_EXTRA. NVIDIA_CONCIERGE_MODELS (comma separated) overrides this
   list without a code change; models that answer 404 are skipped for the life of the instance. */
export const CANDIDATE_MODELS = [
  'nvidia/nemotron-nano-3-30b-a3b',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'nvidia/nemotron-3.5-bolt-e4b',
  'nv-mistralai/mistral-nemo-12b-instruct',
  'google/gemma-3-12b-it',
  'openai/gpt-oss-20b'
];
const PREFERRED_MODELS = [];

/* Extra request fields that switch a reasoning model's thinking off. A GUESS per model family until the probe
   confirms it: the probe sends each candidate both without and with these, so a wrong guess shows as a 400 or as
   no improvement, never as a silent failure in production. */
export const THINKING_OFF = {
  'nvidia/nemotron-nano-3-30b-a3b': { chat_template_kwargs: { enable_thinking: false } },
  'nvidia/nemotron-3.5-lightning-30b-a3b': { chat_template_kwargs: { enable_thinking: false } },
  'nvidia/nemotron-3.5-bolt-e4b': { chat_template_kwargs: { enable_thinking: false } },
  'openai/gpt-oss-20b': { reasoning_effort: 'low' }
};
/* Applied by nvidiaChat to a preferred model once the probe has shown it needs them. Empty until then. */
const MODEL_EXTRA = {};

export function conciergeModels(env = process.env) {
  const fromEnv = String(env.NVIDIA_CONCIERGE_MODELS || '').split(',').map((m) => m.trim()).filter(Boolean);
  return fromEnv.length ? fromEnv : PREFERRED_MODELS;
}

/* The model the readiness check looks up in the catalog: the preferred one, or the first candidate while none is proven. */
export const NVIDIA_MODEL = conciergeModels()[0] || CANDIDATE_MODELS[0];

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
    ...(options.extra || {}),
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
      return await requestModel(model, messages, { ...options, extra: { ...MODEL_EXTRA[model], ...options.extra } }, apiKey);
    } catch (err) {
      if (err.code !== 'nvidia_model_unavailable') throw err;   // rate limit, timeout, outage: not this model's fault
      unavailable.add(model);
      lastUnavailable = err;
      logDegraded('nvidia:model-unavailable', new Error(`${model} is not available to this account: ${err.message.slice(0, 160)}`));
    }
  }
  throw lastUnavailable || nvidiaError(404, 'no NVIDIA model has passed a real Concierge turn yet');
}

/** One request to one model with the caller's own messages and options. Used by the doctor's real-turn probe. */
export async function chatWithModel(model, messages, options = {}) {
  const apiKey = options.apiKey || process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error('NVIDIA_API_KEY not configured');
  return requestModel(model, messages, options, apiKey);
}
