import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTERS, pickPages, hashKey } from '../ingest/adapters/index.js';
import { normalizeListing } from '../api/_lib/search/normalize.js';
import { normalizeUrl } from '../api/_lib/scout-merge.js';
import { touchSeen } from '../api/_lib/search/index-writer.js';

const entry = (n, lastmod = '2026-10-01T00:00:00+00:00') => ({ url: `https://moskito.mx/es/bienes-raices/casa-${n}/`, lastmod, site: 'moskito.mx' });
const keyOf = (e) => normalizeUrl(e.url);

test('hashKey is stable and spreads URLs over the week', () => {
  assert.equal(hashKey('https://x.mx/a'), hashKey('https://x.mx/a'));
  const buckets = new Set(Array.from({ length: 60 }, (_, i) => hashKey(`https://x.mx/p-${i}`) % 7));
  assert.equal(buckets.size, 7, 'every day of the week has something to refresh');
});

test('pickPages: new listings first (newest change first), within the cap, everything else is "still listed"', () => {
  const sitemap = [entry(1, '2026-09-01'), entry(2, '2026-10-20'), entry(3, '2026-10-05'), entry(4), entry(5)];
  const known = new Set([keyOf(entry(4)), keyOf(entry(5))]);
  const { fetch, seenUrls } = pickPages(sitemap, known, { day: 0, cap: 2 });
  assert.deepEqual(fetch.map((e) => e.url), [entry(2).url, entry(3).url], 'cap 2: the two newest new listings');
  assert.ok(!seenUrls.includes(entry(2).url) && !seenUrls.includes(entry(3).url), 'what is fetched is not also "seen"');
  assert.ok(seenUrls.includes(entry(4).url) && seenUrls.includes(entry(5).url), 'known listings the sitemap still names stay listed');
  assert.ok(!seenUrls.includes(entry(1).url), 'a new listing that did not fit the cap is not claimed as seen: it is not in the index yet');
});

test('pickPages: each known listing falls due once a week, and a tracking-param variant is still the same listing', () => {
  const sitemap = Array.from({ length: 70 }, (_, i) => entry(i));
  const known = new Set(sitemap.map(keyOf));
  const dueByDay = Array.from({ length: 7 }, (_, d) => pickPages(sitemap, known, { day: d, cap: 1000 }).fetch.map((e) => e.url));
  assert.equal(new Set(dueByDay.flat()).size, 70, 'over seven days every listing is re-read once');
  assert.equal(dueByDay.flat().length, 70, '...and only once');
  const withUtm = [{ url: entry(1).url + '?utm_source=x' }];
  assert.equal(pickPages(withUtm, new Set([keyOf(entry(1))]), { day: 99, cap: 0 }).fetch.length, 0, 'known despite the tracking parameter');
});

test('pickPages: a cap of zero reads nothing and still reports what is listed', () => {
  const sitemap = [entry(1), entry(2)];
  const out = pickPages(sitemap, new Set([keyOf(entry(1))]), { day: 3, cap: 0 });
  assert.equal(out.fetch.length, 0);
  assert.ok(out.seenUrls.includes(entry(1).url));
});

test('the adapter asks the worker for the sitemaps, then scrapes only the pages it picked', async () => {
  const sitemap = [entry(1), entry(2), entry(3)];
  const calls = [];
  const run = async (args, input) => {
    calls.push(args[0]);
    if (args[0] === 'sitemap') return JSON.stringify(sitemap);
    const asked = JSON.parse(input).map((p) => p.url);
    return asked.map((url) => JSON.stringify({ url, operation: 'sale', price: 4_500_000, currency: 'MXN', town: 'Tulum', neighborhood: 'Aldea Zama', bedrooms: 2, built_m2: 105, listed_by: 'Moskito', photos: [] })).join('\n') + '\n';
  };
  const svc = { from: () => ({ select: () => ({ eq: () => ({ range: async () => ({ data: [{ url_key: keyOf(entry(3)) }], error: null }) }) }) }) };
  // a day on which entry 3 is NOT in the weekly refresh slice (it would be re-read on the day its hash falls due)
  const notDue = ((hashKey(keyOf(entry(3))) % 7) + 1) * 86_400_000;
  const out = await ADAPTERS.scraper_web.fetch({ max: 5, svc, sourceId: 'scraper_web', run, now: notDue });
  assert.deepEqual(calls, ['sitemap', 'scrape']);
  assert.deepEqual(out.items.map((i) => i.url).sort(), [entry(1).url, entry(2).url].sort(), 'the two new pages; entry 3 is known and not due');
  assert.equal(out.costUsd, 0);
  assert.ok(out.seenUrls.includes(entry(3).url));
});

test('with nothing new and nothing due the worker is never asked to scrape', async () => {
  const calls = [];
  const run = async (args) => { calls.push(args[0]); return JSON.stringify([]); };
  const svc = { from: () => ({ select: () => ({ eq: () => ({ range: async () => ({ data: [], error: null }) }) }) }) };
  const out = await ADAPTERS.scraper_web.fetch({ max: 5, svc, run, now: 0 });
  assert.deepEqual(calls, ['sitemap']);
  assert.deepEqual(out.items, []);
});

test('a worker record goes through the normal normalizer, with its currency intact', () => {
  const markets = [{ id: 'riviera-maya', towns: ['Tulum', 'Cancún', 'Playa del Carmen', 'Puerto Morelos'], min_lng: -88.3, min_lat: 18, max_lng: -86.7, max_lat: 21.7 }];
  const rec = { url: 'https://remaxmaya.com/properties/a/', external_id: 'a', title: 'Penthouse 2 Bedroom for Sale in Aldea Zama', operation: 'sale',
    price: 249000, currency: 'USD', property_type: 'penthouse', built_m2: 161, bedrooms: 2, bathrooms: 2, town: 'Tulum', neighborhood: 'Aldea Zama', description: 'Roof garden y alberca.', listed_by: 'RE/MAX Maya', photos: [], currency_assumed: false };
  const n = normalizeListing(ADAPTERS.scraper_web.toRaw(rec), { sourceId: 'scraper_web', fx: 18, markets });
  assert.equal(n.currency, 'USD');
  assert.equal(n.price_mxn, 249000 * 18, 'USD is converted, never read as MXN');
  assert.equal(n.operation, 'sale');
  assert.equal(n.market_id, 'riviera-maya');
  const rent = normalizeListing(ADAPTERS.scraper_web.toRaw({ ...rec, operation: 'rental', price: 1800, currency: 'USD' }), { sourceId: 'scraper_web', fx: 18, markets });
  assert.equal(rent.operation, 'rental');
  assert.equal(rent.price_mxn, 1800 * 18);
});

test('touchSeen refreshes last_seen_at, re-activates a retired offer and its property, and counts the offers', async () => {
  const log = [];
  const svc = { from: (table) => ({
    update: (patch) => {
      const q = { eqs: {}, ins: {} };
      const chain = {
        eq(c, v) { q.eqs[c] = v; return chain; },
        in(c, vs) { q.ins[c] = vs; return chain; },
        select() { log.push({ table, patch, ...q }); return Promise.resolve({ data: table === 'search_offers' ? q.ins.url_key.map((_, i) => ({ property_id: 'p' + (i % 2) })) : [], error: null }); },
        then(res) { log.push({ table, patch, ...q }); return res({ error: null }); }
      };
      return chain;
    }
  }) };
  const keys = Array.from({ length: 4 }, (_, i) => `https://x.mx/${i}`);
  const touched = await touchSeen(svc, 'scraper_web', [...keys, keys[0], null]);
  assert.equal(touched, 4, 'duplicates and nulls are ignored');
  const offers = log.find((l) => l.table === 'search_offers');
  assert.equal(offers.patch.status, 'active');
  assert.equal(offers.eqs.source_id, 'scraper_web');
  assert.ok(offers.patch.last_seen_at);
  const props = log.find((l) => l.table === 'search_properties');
  assert.deepEqual(props.ins.id.sort(), ['p0', 'p1'], 'each property once');
  assert.equal(props.eqs.origin, 'web');
  assert.equal(await touchSeen(svc, 'scraper_web', []), 0);
});
