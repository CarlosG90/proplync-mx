import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nvidiaChat, probeNvidiaModels, conciergeModels, resetUnavailableModels } from '../api/_lib/nvidia-concierge.js';

const ok = (text) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }), text: async () => '' });
const fail = (status, body = '{"title":"Not Found"}') => ({ ok: false, status, text: async () => body });
const withKey = async (fn) => {
  const saved = { k: process.env.NVIDIA_API_KEY, m: process.env.NVIDIA_CONCIERGE_MODELS };
  process.env.NVIDIA_API_KEY = 'test-key';
  delete process.env.NVIDIA_CONCIERGE_MODELS;
  resetUnavailableModels();
  try { await fn(); } finally {
    if (saved.k === undefined) delete process.env.NVIDIA_API_KEY; else process.env.NVIDIA_API_KEY = saved.k;
    if (saved.m === undefined) delete process.env.NVIDIA_CONCIERGE_MODELS; else process.env.NVIDIA_CONCIERGE_MODELS = saved.m;
    resetUnavailableModels();
  }
};

test('a model that answers 404 for this account is skipped, and remembered, so the next one serves the turn', async () => {
  await withKey(async () => {
    const [first, second] = conciergeModels();
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

test('the probe reports, per model, whether this account can call it, in order', async () => {
  const fetchImpl = async (u, init) => JSON.parse(init.body).model === 'good/model' ? ok('ok') : fail(404, 'Not found for account');
  const out = await probeNvidiaModels(['bad/model', 'good/model'], { fetchImpl, apiKey: 'k' });
  assert.deepEqual(out.map((m) => [m.model, m.ok, m.status]), [['bad/model', false, 404], ['good/model', true, 200]]);
  assert.match(out[0].detail, /Not found for account/);
});
