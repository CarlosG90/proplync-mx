import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReply, stripReasoning, askConcierge, isBusy } from '../api/_lib/concierge-turn.js';

const GOOD = JSON.stringify({ say: 'Hola, ¿qué zona te gusta?', brief: { budget: { max: 300000 } }, missing: ['zona'], done: false });
const SYSTEM = 'SYSTEM PROMPT';
const base = { SYSTEM, GROQ_MAX_TOKENS: 600, haveNvidia: true, haveGroq: true };
const groqReply = (text) => async () => ({ choices: [{ message: { content: text } }] });
const convo = [{ role: 'user', content: 'Necesito que tenga la playa al lado' }];

// ---- parseReply ----
test('parseReply accepts bare JSON and a fenced one', () => {
  assert.equal(parseReply(GOOD).say, 'Hola, ¿qué zona te gusta?');
  assert.equal(parseReply('```json\n' + GOOD + '\n```').done, false);
});

test('parseReply strips <think> blocks, even ones with braces, and a cut-off one', () => {
  assert.equal(parseReply('<think>maybe {"say": "no"} hmm</think>' + GOOD).say, 'Hola, ¿qué zona te gusta?');
  assert.throws(() => parseReply('<think>still thinking about {'), (e) => e.code === 'empty_reply');
  assert.equal(stripReasoning('a<think>x</think>b'), 'ab');
});

test('parseReply rejects prose, broken JSON and a reply with nothing to say', () => {
  assert.throws(() => parseReply('Claro, con gusto te ayudo.'), (e) => e.code === 'model_returned_no_json');
  assert.throws(() => parseReply('{"say": "hola", '), (e) => e.code === 'model_returned_no_json' || e.code === 'model_json_invalid');
  assert.throws(() => parseReply('{"say": "hola" "brief": {}}'), (e) => e.code === 'model_json_invalid');
  assert.throws(() => parseReply('{"say": "  ", "brief": {}}'), (e) => e.code === 'reply_has_no_say');
  assert.throws(() => parseReply(''), (e) => e.code === 'empty_reply');
});

test('a reply without a brief gives null, so the page keeps what it already has', () => {
  const r = parseReply('{"say": "¿Cuál es tu presupuesto?", "done": false}');
  assert.equal(r.brief, null);
  assert.deepEqual(r.missing, []);
});

test('only an explicit true counts as done', () => {
  assert.equal(parseReply('{"say":"x","brief":{},"done":"true"}').done, false);
  assert.equal(parseReply('{"say":"x","brief":{},"done":true}').done, true);
});

// ---- askConcierge ----
test('NVIDIA is sent the system prompt (it used to get none) with thinking switched off', async () => {
  let seen;
  const r = await askConcierge(convo, { ...base, nvidiaChat: async (m) => { seen = m; return GOOD; }, groqChat: groqReply(GOOD) });
  assert.equal(r.provider, 'nvidia');
  assert.equal(seen[0].role, 'system');
  assert.ok(seen[0].content.startsWith(SYSTEM));
  assert.match(seen[0].content, /no_think/);
  assert.deepEqual(seen.slice(1), convo);
});

test('prose from NVIDIA gets one repair attempt with the error in the prompt', async () => {
  const calls = [];
  const nvidiaChat = async (m) => { calls.push(m); return calls.length === 1 ? 'Claro, con gusto te ayudo.' : GOOD; };
  const r = await askConcierge(convo, { ...base, nvidiaChat, groqChat: groqReply('SHOULD NOT RUN') });
  assert.equal(r.provider, 'nvidia');
  assert.equal(r.repaired, true);
  assert.equal(calls.length, 2);
  const repair = calls[1].slice(-2);
  assert.equal(repair[0].role, 'assistant');
  assert.match(repair[0].content, /Claro, con gusto/);
  assert.match(repair[1].content, /model_returned_no_json/);
});

test('NVIDIA invalid twice falls back to Groq, which also gets the system prompt', async () => {
  let groqBody;
  const r = await askConcierge(convo, {
    ...base,
    nvidiaChat: async () => 'solo texto',
    groqChat: async (b) => { groqBody = b; return { choices: [{ message: { content: GOOD } }] }; }
  });
  assert.equal(r.provider, 'groq');
  assert.equal(groqBody.messages[0].role, 'system');
  assert.equal(groqBody.messages[0].content, SYSTEM);
});

test('an NVIDIA outage goes straight to Groq without repeating the call', async () => {
  let nvidiaCalls = 0;
  const r = await askConcierge(convo, {
    ...base,
    nvidiaChat: async () => { nvidiaCalls++; const e = new Error('NVIDIA NIM 503: down'); e.code = 'nvidia_unavailable'; throw e; },
    groqChat: groqReply(GOOD)
  });
  assert.equal(r.provider, 'groq');
  assert.equal(nvidiaCalls, 1);
});

test('both providers returning junk gives a coded error, not busy', async () => {
  await assert.rejects(
    askConcierge(convo, { ...base, nvidiaChat: async () => 'prosa', groqChat: groqReply('más prosa') }),
    (e) => e.code === 'model_returned_no_json' && e.busy === false
  );
});

test('both providers rate limited is reported busy', async () => {
  const limited = (code, msg) => () => { const e = new Error(msg); if (code) e.code = code; throw e; };
  await assert.rejects(
    askConcierge(convo, { ...base, nvidiaChat: limited('nvidia_rate_limited', 'NVIDIA NIM 429: slow down'), groqChat: limited(null, 'Groq responded 429') }),
    (e) => e.busy === true
  );
  assert.equal(isBusy({ code: 'nvidia_timeout' }), true);
  assert.equal(isBusy(new Error('Groq responded 500')), false);
});

test('the turn stops trying once its time budget is spent', async () => {
  let t = 0;
  let calls = 0;
  const now = () => (t += 30000);
  await assert.rejects(
    askConcierge(convo, { ...base, now, nvidiaChat: async () => { calls++; return 'prosa'; }, groqChat: groqReply('prosa') }),
    (e) => e.code === 'turn_budget_exceeded'
  );
  assert.equal(calls, 0);
});

test('no provider configured is its own error', async () => {
  await assert.rejects(askConcierge(convo, { ...base, haveNvidia: false, haveGroq: false }), (e) => e.code === 'concierge_no_provider');
});

// ---- the real handler, network mocked: the exact failure a buyer hit ----
function call(handler, body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, setHeader() {},
      status(c) { this.statusCode = c; return this; },
      json(o) { resolve({ status: this.statusCode, body: o }); return this; },
      end() { resolve({ status: this.statusCode, body: null }); }
    };
    handler({ method: 'POST', query: { action: 'turn' }, body, headers: {}, socket: {} }, res);
  });
}
const respond = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj, text: async () => JSON.stringify(obj) });

test('handler: NVIDIA answers in prose, the buyer still gets a good reply from the fallback', async () => {
  process.env.NVIDIA_API_KEY = 'test'; process.env.GROQ_API_KEY = 'test';
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).includes('nvidia')
    ? respond({ choices: [{ message: { content: 'Claro, con gusto. ¿Qué zona prefieres?' } }] })
    : respond({ choices: [{ message: { content: GOOD } }] });
  try {
    const { default: handler } = await import('../api/finder.js');
    const r = await call(handler, { messages: convo });
    assert.equal(r.status, 200);
    assert.equal(r.body.provider, 'groq');
    assert.equal(r.body.say, 'Hola, ¿qué zona te gusta?');
    assert.deepEqual(r.body.brief, { budget: { max: 300000 } });
  } finally { globalThis.fetch = real; }
});

test('handler: both providers rate limited answers 503 concierge_busy', async () => {
  process.env.NVIDIA_API_KEY = 'test'; process.env.GROQ_API_KEY = 'test';
  const real = globalThis.fetch;
  globalThis.fetch = async () => respond({ error: 'slow down' }, 429);
  try {
    const { default: handler } = await import('../api/finder.js');
    const r = await call(handler, { messages: convo });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'concierge_busy');
  } finally { globalThis.fetch = real; }
});

test('handler: a reply with no brief answers null instead of wiping the page', async () => {
  process.env.NVIDIA_API_KEY = 'test'; process.env.GROQ_API_KEY = '';
  const real = globalThis.fetch;
  globalThis.fetch = async () => respond({ choices: [{ message: { content: '<think>hmm</think>{"say":"¿Y tu presupuesto?","done":false}' } }] });
  try {
    const { default: handler } = await import('../api/finder.js');
    const r = await call(handler, { messages: convo });
    assert.equal(r.status, 200);
    assert.equal(r.body.brief, null);
    assert.equal(r.body.say, '¿Y tu presupuesto?');
  } finally { globalThis.fetch = real; }
});
