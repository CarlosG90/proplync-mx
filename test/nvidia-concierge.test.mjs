import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nvidiaChat, chatWithModel, conciergeModels, resetUnavailableModels, CANDIDATE_MODELS, THINKING_OFF } from '../api/_lib/nvidia-concierge.js';

const ok = (text) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }), text: async () => '' });
const fail = (status, body = '{"title":"Not Found"}') => ({ ok: false, status, text: async () => body });
const withKey = async (fn) => {
  const saved = { k: process.env.NVIDIA_API_KEY, m: process.env.NVIDIA_CONCIERGE_MODELS };
  process.env.NVIDIA_API_KEY = 'test-key';
  process.env.NVIDIA_CONCIERGE_MODELS = 'first/model,second/model';
  resetUnavailableModels();
  try { await fn(); } finally {
    if (saved.k === undefined) delete process.env.NVIDIA_API_KEY; else process.env.NVIDIA_API_KEY = saved.k;
    if (saved.m === undefined) delete process.env.NVIDIA_CONCIERGE_MODELS; else process.env.NVIDIA_CONCIERGE_MODELS = saved.m;
    resetUnavailableModels();
  }
};

test('a model that answers 404 for this account is skipped, and remembered, so the next one serves the turn', async () => {
  await withKey(async () => {
    const [first, second] = ['first/model', 'second/model'];
    const asked = [];
    const fetchImpl = async (url, init) => {
      const model = JSON.parse(init.body).model;
      asked.push(model);
      return model === first ? fail(404, "Function 'x': Not found for account 'y'") : ok('{"say":"hola"}');
    };
    assert.equal(await nvidiaChat([{ role: 'user', content: 'hi' }], { fetchImpl }), '{"say":"hola"}');
    assert.deepEqual(asked, [first, second]);
    asked.length = 0;
    await nvidiaChat([{ role: 'user', content: 'hi' }], { fetchImpl });
    assert.deepEqual(asked, [second], 'the dead model is not asked again by this instance');
  });
});

test('when every model is unavailable the caller gets nvidia_model_unavailable, so Groq takes over', async () => {
  await withKey(async () => {
    await assert.rejects(
      nvidiaChat([{ role: 'user', content: 'hi' }], { fetchImpl: async () => fail(404) }),
      (err) => err.code === 'nvidia_model_unavailable'
    );
  });
});

test('a rate limit or an outage is not blamed on the model: no skipping, the error goes straight up', async () => {
  await withKey(async () => {
    let calls = 0;
    await assert.rejects(
      nvidiaChat([{ role: 'user', content: 'hi' }], { fetchImpl: async () => { calls++; return fail(429, 'slow down'); } }),
      (err) => err.code === 'nvidia_rate_limited'
    );
    assert.equal(calls, 1);
  });
});

test('NVIDIA_CONCIERGE_MODELS overrides the list without a code change', async () => {
  await withKey(async () => {
    process.env.NVIDIA_CONCIERGE_MODELS = ' a/one , b/two ';
    assert.deepEqual(conciergeModels(), ['a/one', 'b/two']);
    const asked = [];
    await nvidiaChat([{ role: 'user', content: 'hi' }], { fetchImpl: async (u, init) => { asked.push(JSON.parse(init.body).model); return ok('x'); } });
    assert.deepEqual(asked, ['a/one']);
  });
});

test('with no proven model NVIDIA is off: nothing is sent, and the caller falls back to Groq at once', async () => {
  await withKey(async () => {
    delete process.env.NVIDIA_CONCIERGE_MODELS;
    assert.deepEqual(conciergeModels(), [], 'no model is preferred until one passes a real turn');
    let calls = 0;
    await assert.rejects(
      nvidiaChat([{ role: 'user', content: 'hi' }], { fetchImpl: async () => { calls++; return ok('x'); } }),
      (err) => err.code === 'nvidia_model_unavailable'
    );
    assert.equal(calls, 0);
  });
});

test('chatWithModel sends the caller\'s own request fields, such as a thinking-off switch, to exactly that model', async () => {
  let sent;
  const out = await chatWithModel('openai/gpt-oss-20b', [{ role: 'user', content: 'hi' }], {
    apiKey: 'k', max_tokens: 50, extra: THINKING_OFF['openai/gpt-oss-20b'],
    fetchImpl: async (u, init) => { sent = JSON.parse(init.body); return ok('fine'); }
  });
  assert.equal(out, 'fine');
  assert.equal(sent.model, 'openai/gpt-oss-20b');
  assert.equal(sent.reasoning_effort, 'low');
  assert.equal(sent.max_tokens, 50);
});

test('every thinking-off option belongs to a candidate model', () => {
  for (const model of Object.keys(THINKING_OFF)) assert.ok(CANDIDATE_MODELS.includes(model), model + ' is not a candidate');
});
