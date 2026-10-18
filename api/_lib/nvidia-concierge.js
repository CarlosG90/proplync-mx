/**
 * Proplync.mx · NVIDIA Concierge via NIM API
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * Concierge runs on NVIDIA NIM free tier to reduce costs (Claude is expensive).
 * NVIDIA API is OpenAI-compatible and includes rate-limit retry logic.
 * ─────────────────────────────────────────────────────────────────────────
 */

const NVIDIA_NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MODEL = 'nvidia/nvidia-nemotron-nano-9b-v2';
const REQUEST_TIMEOUT_MS = 9000; // Vercel limit is 10s; leave 1s margin

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
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = response.status === 401 ? 'nvidia_auth_failed' :
                     response.status === 404 ? 'nvidia_model_unavailable' :
                     response.status >= 500 ? 'nvidia_unavailable' :
                     'nvidia_request_failed';
      const text = await response.text();
      const error = new Error(`NVIDIA NIM ${response.status}: ${text}`);
      error.code = detail;
      throw error;
    }

    const data = await response.json();

    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error('nvidia_invalid_response: no message in choices');
    }

    return data.choices[0].message.content;
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeout_err = new Error('nvidia_timeout: request exceeded 9s');
      timeout_err.code = 'nvidia_timeout';
      throw timeout_err;
    }
    if (err.code) throw err;
    throw new Error(`nvidia_unavailable: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Try NVIDIA, fall back to Groq on failure.
 * Returns { text, provider, error? }
 */
export async function conciergeChat(messages, { groqChat, GROQ_MAX_TOKENS, SYSTEM }) {
  let lastError;

  // Try NVIDIA first
  if (process.env.NVIDIA_API_KEY) {
    try {
      const text = await nvidiaChat(messages.map(m => ({
        role: m.role || 'user',
        content: m.content || ''
      })), {
        max_tokens: 1400,
        temperature: 0.4
      });
      return { text, provider: 'nvidia' };
    } catch (err) {
      lastError = err;
      // Log but continue to fallback
      console.error('[Concierge] NVIDIA failed:', err.code || err.message);
    }
  }

  // Fall back to Groq
  if (process.env.GROQ_API_KEY) {
    try {
      const data = await groqChat({
        max_tokens: GROQ_MAX_TOKENS,
        temperature: 0.4,
        messages: [{ role: 'system', content: SYSTEM }].concat(messages)
      });
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw new Error('groq_no_message');
      return { text, provider: 'groq' };
    } catch (err) {
      lastError = err;
      // Both providers failed
    }
  }

  // All providers failed
  if (lastError) throw lastError;
  throw new Error('concierge_no_provider: neither NVIDIA_API_KEY nor GROQ_API_KEY configured');
}
