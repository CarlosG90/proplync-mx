/**
 * Proplync.mx · NVIDIA Concierge via the NIM API
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * Concierge runs on NVIDIA NIM's free tier first (Claude is gone from this path). The API
 * is OpenAI-compatible. This file only talks to NVIDIA: choosing providers, sending the
 * system prompt, validating the reply and falling back all live in concierge-turn.js.
 * ─────────────────────────────────────────────────────────────────────────
 */

const NVIDIA_NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MODEL = 'nvidia/nvidia-nemotron-nano-9b-v2';
const REQUEST_TIMEOUT_MS = 9000;

export async function nvidiaChat(messages, options = {}) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error('NVIDIA_API_KEY not configured');

  const body = JSON.stringify({
    model: MODEL,
    messages,
    max_tokens: options.max_tokens || 1400,
    temperature: options.temperature !== undefined ? options.temperature : 0.4,
    top_p: 0.9,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await (options.fetchImpl || fetch)(NVIDIA_NIM_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const code = response.status === 401 ? 'nvidia_auth_failed' :
                   response.status === 404 ? 'nvidia_model_unavailable' :
                   response.status === 429 ? 'nvidia_rate_limited' :
                   response.status >= 500 ? 'nvidia_unavailable' :
                   'nvidia_request_failed';
      const text = await response.text();
      const error = new Error(`NVIDIA NIM ${response.status}: ${text}`);
      error.code = code;
      throw error;
    }

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
