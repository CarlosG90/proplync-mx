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
