/**
 * Proplync.mx · One Concierge turn: from the buyer's words to a validated reply
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * A buyer saw "Concierge no respondió" mid-conversation. Reading the old turn code
 * found why it could happen at any moment:
 *   - NVIDIA, the first provider, was never sent the system prompt. Only the Groq
 *     fallback was. So NVIDIA answered as a generic chatbot, in prose instead of the
 *     JSON the page needs, and the parse failed.
 *   - That parse failure happened AFTER the provider call had succeeded, so it never
 *     reached the Groq fallback. It went straight to a 502.
 *   - The project's own rule (CLAUDE.md) is "if the JSON does not parse, retry once
 *     with the error in the prompt, then say it is busy". That was not implemented.
 *   - A reasoning model can wrap its answer in <think>…</think>, and a reply without
 *     "brief" answered {} and wiped the page's captured needs.
 *
 * So: both providers get the same system prompt, reasoning text is stripped, every
 * reply is validated, a bad reply gets one repair attempt, and only then does the next
 * provider run. Transport failures (rate limit, timeout, outage) go to the next
 * provider straight away. The handler turns what is left into "busy" or "unavailable".
 * ─────────────────────────────────────────────────────────────────────────
 */

import { logDegraded } from './health.js';

/* The Nemotron nano models are reasoning models by default; this switches the thinking off.
   Harmless text for a model that does not know it, and parseReply strips <think> anyway. */
export const NO_THINK = '\n\n/no_think';

/* Whole-turn budget, so a slow first provider cannot eat the fallback's chance. */
const BUDGET_MS = 26000;

function codeErr(code, detail) {
  const e = new Error(code);
  e.code = code;
  if (detail) e.detail = detail;
  return e;
}

/** Remove a reasoning model's thinking, including when the token limit cut it off. */
export function stripReasoning(raw) {
  return String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '');
}

/**
 * Turn the model's text into a reply the page can trust, or throw a coded error.
 * `brief` is null when the model left it out, so the page keeps what it already has.
 */
export function parseReply(raw) {
  const text = stripReasoning(raw).replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!text) throw codeErr('empty_reply');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw codeErr('model_returned_no_json', text.slice(0, 100));
  let obj;
  try { obj = JSON.parse(text.slice(start, end + 1)); }
  catch (e) { throw codeErr('model_json_invalid', e.message); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw codeErr('model_json_not_object');
  const say = typeof obj.say === 'string' ? obj.say.trim() : '';
  if (!say) throw codeErr('reply_has_no_say');
  return {
    say: say.slice(0, 4000),
    brief: obj.brief && typeof obj.brief === 'object' && !Array.isArray(obj.brief) ? obj.brief : null,
    missing: Array.isArray(obj.missing) ? obj.missing.slice(0, 20) : [],
    done: obj.done === true
  };
}

/** A rate limit or a timeout: worth telling the buyer to try again, not "broken". */
export function isBusy(err) {
  const msg = String((err && err.message) || '');
  return !!err && (err.code === 'nvidia_rate_limited' || err.code === 'nvidia_timeout'
    || /Groq responded 429|NIM 429/.test(msg));
}

const REPAIR = (code) =>
  `Tu respuesta anterior no se pudo usar (${code}). Responde UNICAMENTE con el objeto JSON del formato indicado, sin texto antes ni despues, y se breve.`;

async function callProvider(name, messages, deps) {
  if (name === 'nvidia') {
    const raw = await deps.nvidiaChat(
      [{ role: 'system', content: deps.SYSTEM + NO_THINK }].concat(messages),
      { max_tokens: 1400, temperature: 0.4 }
    );
    return raw;
  }
  const data = await deps.groqChat({
    max_tokens: deps.GROQ_MAX_TOKENS,
    temperature: 0.4,
    messages: [{ role: 'system', content: deps.SYSTEM }].concat(messages)
  });
  return data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
}

/**
 * @param {Array<{role:string,content:string}>} messages  the conversation so far
 * @param {object} deps  { nvidiaChat, groqChat, SYSTEM, GROQ_MAX_TOKENS, haveNvidia, haveGroq, now? }
 * @returns {Promise<{reply: object, provider: string, repaired: boolean}>}
 * @throws an Error with `.code`, and `.busy` true when a provider was only rate limited
 */
export async function askConcierge(messages, deps) {
  const now = deps.now || Date.now;
  const t0 = now();
  const providers = [];
  if (deps.haveNvidia) providers.push('nvidia');
  if (deps.haveGroq) providers.push('groq');
  if (!providers.length) throw codeErr('concierge_no_provider');

  let last = null;
  let busy = false;

  for (const name of providers) {
    let msgs = messages;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (now() - t0 > BUDGET_MS) { last = last || codeErr('turn_budget_exceeded'); break; }

      let raw;
      try {
        raw = await callProvider(name, msgs, deps);
      } catch (err) {
        /* Outage, rate limit or timeout: repeating the same call rarely helps inside one request,
           so move to the next provider. */
        err.provider = name;
        last = err;
        if (isBusy(err)) busy = true;
        logDegraded(`finder:turn:${name}`, err);
        break;
      }

      try {
        return { reply: parseReply(raw), provider: name, repaired: attempt === 1 };
      } catch (bad) {
        bad.provider = name;
        last = bad;
        logDegraded(`finder:turn:${name}:bad_output`,
          new Error(`${bad.code}: ${String(raw || '').replace(/\s+/g, ' ').slice(0, 160)}`));
        /* One repair attempt with the error in the prompt, as the project's rules say. */
        const prior = stripReasoning(raw).trim().slice(0, 1200) || '(sin respuesta)';
        msgs = messages.concat([{ role: 'assistant', content: prior }, { role: 'user', content: REPAIR(bad.code) }]);
      }
    }
  }

  const err = last || codeErr('concierge_failed');
  err.busy = busy;
  throw err;
}
