/**
 * Proplync.mx · NVIDIA NIM chat client
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * Concierge moves off Claude to NVIDIA's free hosted catalog (build.nvidia.com)
 * to cut cost. The endpoint is OpenAI-compatible, so the request and response
 * shapes match api/_lib/groq.js, and the retry rules match it too: a 429 is
 * "busy", never a crash.
 *
 * WHY ONLY CONCIERGE FOR NOW
 * Scout needs its own search and fetch tools (NVIDIA's chat endpoint has no
 * web tools), and extraction needs a vision model that reads PDFs. Neither is
 * wired here. Model IDs are added only once checked on build.nvidia.com, so a
 * guessed ID never ships.
 *
 * WHY NOT THROW ON A RETIRED MODEL SILENTLY
 * A 404 means the model ID is gone from the catalog. That is reported as
 * nvidia_model_unavailable and logged, so the caller can fall back to Groq and
 * the gap gets noticed, instead of retrying a dead ID forever.
 * -----------------------------------------------------------------------------
 */

import { logDegraded } from './health.js';

export const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

/* Verified against https://build.nvidia.com/nvidia/nvidia-nemotron-nano-9b-v2
   (Oct 2026). A small model keeps a Concierge turn inside Vercel Hobby's
   10 s function limit. Check it still answers before each release. */
export const CONCIERGE_MODEL = 'nvidia/nvidia-nemotron-nano-9b-v2';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST a chat completion. Retries once on 429 or 5xx, with a short pause.
 *
 * @param {object} body  chat-completions body WITHOUT `model` (added here)
 * @param {object} [opts]
 * @param {string} [opts.model]         defaults to CONCIERGE_MODEL
 * @param {Function} [opts.fetchImpl]   injected in tests
 * @param {number} [opts.retryDelayMs]  pause before the retry
 * @returns {Promise<object>} parsed response
 * @throws {Error} missing_nvidia_api_key | nvidia_rate_limited |
 *                 nvidia_model_unavailable | nvidia_unavailable |
 *                 invalid_json_from_nvidia
 */
export async function nvidiaChat(body, {
  model = CONCIERGE_MODEL,
  fetchImpl = fetch,
  retryDelayMs = 800
} = {}) {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error('missing_nvidia_api_key');

  const attempt = async () => {
    const r = await fetchImpl(NVIDIA_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ ...body, model })
    });
    return { ok: r.ok, status: r.status, text: await r.text() };
  };

  let res = await attempt();
  if (!res.ok && (res.status === 429 || res.status >= 500)) {
    logDegraded('nvidia:retry', `${model} -> ${res.status}`);
    await sleep(retryDelayMs);
    res = await attempt();
  }

  if (!res.ok) {
    if (res.status === 429) {
      logDegraded('nvidia:rate-limited', res.text.slice(0, 200));
      throw new Error('nvidia_rate_limited');
    }
    if (res.status === 404) {
      logDegraded('nvidia:model-unavailable', `${model} returned 404`);
      throw new Error('nvidia_model_unavailable');
    }
    throw new Error('nvidia_unavailable');
  }

  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error('invalid_json_from_nvidia');
  }
}
