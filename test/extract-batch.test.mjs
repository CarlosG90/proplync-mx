import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBatchReply, toListingFields, handleBatch, BATCH_MAX } from '../api/extract.js';

const reply = (properties) => JSON.stringify({ properties });

function fakeRes() {
  return {
    statusCode: 0, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k] = v; }
  };
}
const req = (body) => ({ method: 'POST', query: { action: 'batch' }, headers: {}, body, socket: { remoteAddress: '127.0.0.1' } });
const groqSays = (text) => ({ groqChat: async () => ({ choices: [{ message: { content: text } }] }) });

// ---------- parsing ----------

test('a WhatsApp dump with several properties comes back as several listings, in order', () => {
  const out = parseBatchReply('```json\n' + reply([
    { title: 'Casa en Jardines del Moral', town: 'Leon', bedrooms: '3', bathrooms: '2.5', size: '180 m²', amount: '3.45 millones', currency: 'pesos', operation: 'sale' },
    { title: 'Depa en Centro', town: 'Leon', amount: '$12,000', currency: 'MXN', operation: 'rental' }
  ]) + '\n```');
  assert.equal(out.length, 2);
  assert.equal(out[0].property.amount, 3450000);
  assert.equal(out[0].property.currency, 'MXN');
  assert.equal(out[0].property.bathrooms, 2);
  assert.match(out[0].notes, /2\.5 baños/);
  assert.equal(out[1].property.operation, 'rental');
  assert.equal(out[1].property.amount, 12000);
});

test('never more than BATCH_MAX, and entries that are not properties are dropped', () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ title: 'Casa ' + i, amount: 1000000 + i }));
  assert.equal(parseBatchReply(reply(many)).length, BATCH_MAX);
  const noise = parseBatchReply(reply([{ title: '', amount: 0, town: '' }, { title: 'Casa', amount: 0 }]));
  assert.equal(noise.length, 1);
});

test('a missing currency is flagged, never guessed', () => {
  const [p] = parseBatchReply(reply([{ title: 'Casa', amount: 2000000 }]));
  assert.equal(p.property.currency, '');
  assert.ok(p.missing.includes('currency'));
});

test('anything that is not the JSON we asked for is unparseable, not an empty success', () => {
  assert.throws(() => parseBatchReply('Claro, aqui tienes las propiedades...'), /extraction_unparseable/);
  assert.throws(() => parseBatchReply('{"items": []}'), /extraction_unparseable/);
  assert.deepEqual(parseBatchReply('{"properties": []}'), []);
});

test('the single extraction and the batch read fields the same way', () => {
  const one = toListingFields({ title: 'Casa', amount: '450k usd', currency: 'USD', bedrooms: 3 });
  assert.equal(one.property.amount, 450000);
  assert.equal(one.property.currency, 'USD');
  assert.equal(one.property.bedrooms, 3);
});

// ---------- the handler, with stubbed providers ----------

test('text-only input is read by Groq', async () => {
  const res = fakeRes();
  await handleBatch(req({ text: 'Casa 3 rec 2.5 mdp\nDepa 2 rec renta 15k' }), res, {
    haveGroq: true, anthropic: null, messageText: (d) => d.choices[0].message.content,
    ...groqSays(reply([{ title: 'Casa', amount: '2.5 mdp', currency: 'MXN' }, { title: 'Depa', amount: '15k', operation: 'rental', currency: 'MXN' }]))
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.provider, 'groq');
  assert.equal(res.body.total, 2);
});

test('when Groq is busy or answers badly, Claude does the text', async () => {
  const res = fakeRes();
  let asked = null;
  const anthropic = { messages: { create: async (p) => { asked = p.model; return { content: [{ type: 'text', text: reply([{ title: 'Casa', amount: 1 }]) }] }; } } };
  await handleBatch(req({ text: 'Casa en venta' }), res, {
    haveGroq: true, anthropic, messageText: () => { throw new Error('Groq responded 429'); },
    groqChat: async () => ({})
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.provider, 'claude');
  assert.equal(asked, 'claude-haiku-5-5');
});

test('no input is a 400; no provider at all is a 503', async () => {
  const a = fakeRes();
  await handleBatch(req({}), a, { haveGroq: true, anthropic: null });
  assert.equal(a.statusCode, 400);
  const b = fakeRes();
  await handleBatch(req({ text: 'Casa' }), b, { haveGroq: false, anthropic: null });
  assert.equal(b.statusCode, 503);
});

test('photos need Claude: without it, a 503 rather than a silent text-only read', async () => {
  const res = fakeRes();
  await handleBatch(req({ files: [{ mediaType: 'image/png', data: 'aGVsbG8=' }] }), res, { haveGroq: true, anthropic: null });
  assert.equal(res.statusCode, 503);
});
