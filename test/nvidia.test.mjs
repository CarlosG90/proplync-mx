/**
 * Unit tests for api/_lib/nvidia.js. No network: fetch is injected.
 * Run with: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nvidiaChat, CONCIERGE_MODEL } from '../api/_lib/nvidia.js';

const OK_BODY = JSON.stringify({ choices: [{ message: { content: '{"say":"hola"}' } }] });

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.shift();
    return { ok: next.status >= 200 && next.status < 300, status: next.status, text: async () => next.text ?? '' };
  };
  fn.calls = calls;
  return fn;
}

function withKey(fn) {
  return async (t) => {
    const prev = process.env.NVIDIA_API_KEY;
    process.env.NVIDIA_API_KEY = 'test-key';
    try { await fn(t); } finally {
      if (prev === undefined) delete process.env.NVIDIA_API_KEY; else process.env.NVIDIA_API_KEY = prev;
    }
  };
}

test('missing NVIDIA_API_KEY fails before any request', async () => {
  const prev = process.env.NVIDIA_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  try {
    const f = fakeFetch([]);
    await assert.rejects(nvidiaChat({ messages: [] }, { fetchImpl: f }), /missing_nvidia_api_key/);
    assert.equal(f.calls.length, 0);
  } finally {
    if (prev !== undefined) process.env.NVIDIA_API_KEY = prev;
  }
});

test('sends model, bearer key and body; returns parsed JSON', withKey(async () => {
  const f = fakeFetch([{ status: 200, text: OK_BODY }]);
  const data = await nvidiaChat({ max_tokens: 10, messages: [] }, { fetchImpl: f });
  assert.equal(data.choices[0].message.content, '{"say":"hola"}');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.model, CONCIERGE_MODEL);
  assert.equal(f.calls[0].body.max_tokens, 10);
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer test-key');
  assert.match(f.calls[0].url, /^https:\/\/integrate\.api\.nvidia\.com\/v1\//);
}));

test('one retry on 429 then success', withKey(async () => {
  const f = fakeFetch([{ status: 429, text: 'slow down' }, { status: 200, text: OK_BODY }]);
  const data = await nvidiaChat({ messages: [] }, { fetchImpl: f, retryDelayMs: 0 });
  assert.ok(data.choices);
  assert.equal(f.calls.length, 2);
}));

test('two 429s surface as nvidia_rate_limited after exactly two attempts', withKey(async () => {
  const f = fakeFetch([{ status: 429, text: 'x' }, { status: 429, text: 'x' }]);
  await assert.rejects(nvidiaChat({ messages: [] }, { fetchImpl: f, retryDelayMs: 0 }), /nvidia_rate_limited/);
  assert.equal(f.calls.length, 2);
}));

test('5xx is retried once and then reported as nvidia_unavailable', withKey(async () => {
  const f = fakeFetch([{ status: 503, text: '' }, { status: 503, text: '' }]);
  await assert.rejects(nvidiaChat({ messages: [] }, { fetchImpl: f, retryDelayMs: 0 }), /nvidia_unavailable/);
  assert.equal(f.calls.length, 2);
}));

test('404 means the model ID is gone: no retry, nvidia_model_unavailable', withKey(async () => {
  const f = fakeFetch([{ status: 404, text: '' }, { status: 200, text: OK_BODY }]);
  await assert.rejects(nvidiaChat({ messages: [] }, { fetchImpl: f, retryDelayMs: 0 }), /nvidia_model_unavailable/);
  assert.equal(f.calls.length, 1);
}));

test('400 is not retried', withKey(async () => {
  const f = fakeFetch([{ status: 400, text: 'bad' }, { status: 200, text: OK_BODY }]);
  await assert.rejects(nvidiaChat({ messages: [] }, { fetchImpl: f, retryDelayMs: 0 }), /nvidia_unavailable/);
  assert.equal(f.calls.length, 1);
}));

test('a 200 with a non-JSON body is invalid_json_from_nvidia', withKey(async () => {
  const f = fakeFetch([{ status: 200, text: '<html>oops</html>' }]);
  await assert.rejects(nvidiaChat({ messages: [] }, { fetchImpl: f }), /invalid_json_from_nvidia/);
}));
