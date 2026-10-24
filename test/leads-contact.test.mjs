import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/leads.js';

// Validation paths only: they answer before the database is touched, so no
// Supabase credentials are needed. The insert itself is not covered here.
function run(body, method = 'POST', query = { action: 'contact' }) {
  return new Promise((resolve) => {
    const res = {
      headers: {}, statusCode: 200,
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.statusCode = c; return this; },
      json(o) { resolve({ status: this.statusCode, body: o }); return this; },
      end() { resolve({ status: this.statusCode, body: null }); }
    };
    handler({ method, query, body, headers: {}, socket: {} }, res);
  });
}

test('contact: name and email are required', async () => {
  const r = await run({ name: '  ', email: 'a@b.co' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'name_and_email_required');
  const r2 = await run({ name: 'Ana' });
  assert.equal(r2.body.error, 'name_and_email_required');
});

test('contact: a malformed email is rejected', async () => {
  const r = await run({ name: 'Ana', email: 'not-an-email' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid_email');
});

test('contact: a phone that is too short is rejected, an empty one is fine', async () => {
  const r = await run({ name: 'Ana', email: 'a@b.co', phone: '123' });
  assert.equal(r.body.error, 'invalid_phone');
});

test('contact: the honeypot answers ok without storing anything', async () => {
  const r = await run({ name: 'Bot', email: 'bot@spam.co', website: 'http://spam' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
});

// ---- the insert itself, with the database call mocked ----
// supabase-js talks to PostgREST over fetch, so a fake fetch lets us read exactly what would be stored.
async function submitAndCapture(body) {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
  const real = globalThis.fetch;
  let stored = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/rest/v1/contact_requests')) {
      stored = JSON.parse(init.body);
      return new Response('[]', { status: 201, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const r = await run(body);
    return { r, stored };
  } finally { globalThis.fetch = real; }
}

test('contact: an agent request is stored as kind "agent" from source "agents"', async () => {
  const { r, stored } = await submitAndCapture({ name: ' Ana ', email: 'ANA@Example.com', type: 'agent', source: 'agents', lang: 'en', company: 'Mar Azul' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.equal(stored.kind, 'agent');
  assert.equal(stored.source, 'agents');
  assert.equal(stored.email, 'ana@example.com');
  assert.equal(stored.name, 'Ana');
  assert.equal(stored.lang, 'en');
});

test('contact: the client cannot invent a source or a kind', async () => {
  const { stored } = await submitAndCapture({ name: 'Ana', email: 'a@b.co', type: 'vip-hacker', source: 'anything-i-like' });
  assert.equal(stored.kind, 'other');
  assert.equal(stored.source, 'agencias');
});

test('contact: a database failure answers 500 and never claims success', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'relation "contact_requests" does not exist', code: '42P01' }), { status: 404, headers: { 'content-type': 'application/json' } });
  try {
    const r = await run({ name: 'Ana', email: 'a@b.co' });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, 'contact_request_failed');
  } finally { globalThis.fetch = real; }
});
