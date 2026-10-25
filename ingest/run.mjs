#!/usr/bin/env node
/**
 * Proplync.mx · The crawler: fills the search index
 * -----------------------------------------------------------------------------
 * Runs daily on GitHub Actions (.github/workflows/ingest.yml), or by hand:
 *
 *   node ingest/run.mjs                      every enabled source × market
 *   node ingest/run.mjs --source lamudi --market riviera-maya --max 10
 *   node ingest/run.mjs --dry-run            fetch + normalize, write nothing
 *   node ingest/run.mjs --only-proplync      our listings + embeddings, no crawling
 *
 * One run, in order:
 *   1. Mirror our agencies' published listings (always; free).
 *   2. For each enabled source × enabled market: skip if this month's budget
 *      is spent, run the source's scraper on the market's start URLs, keep
 *      what normalize.js accepts, and index it (dedupe happens there).
 *   3. Health check per source. A run that returns far fewer listings than
 *      the last one switches that source off instead of marking the rest of
 *      its listings stale: a broken scraper must not empty the index.
 *   4. Mark stale what healthy sources stopped showing.
 *   5. Embed every property that has no vector yet.
 *
 * The switches live in the database (search_sources, search_markets), so
 * turning a source off or a market on never needs a deploy.
 * -----------------------------------------------------------------------------
 */

import { parseArgs, serviceClient, die } from '../scripts/_lib.mjs';
import { normalizeListing } from '../api/_lib/search/normalize.js';
import { normalizeUrl } from '../api/_lib/scout-merge.js';
import { indexListings, markStale, touchSeen, syncProplync, embedPending, loadMarkets, fxRate } from '../api/_lib/search/index-writer.js';
import { ADAPTERS } from './adapters/index.js';

const args = parseArgs(process.argv.slice(2), ['dry-run', 'only-proplync']);
const dryRun = args.flags.has('dry-run');
const svc = serviceClient();
const month = new Date().toISOString().slice(0, 7);
const started = new Date();
const summary = { started: started.toISOString(), dry_run: dryRun, proplync: null, sources: [], stale: [], embeddings: null };

function log(...a) { console.log('  ' + a.join(' ')); }

/* A run is suspect when it brings back under a fifth of what the source gave
   last time (and last time was meaningful). Portals change their HTML; this
   is how a scraper that silently broke gets caught. */
function suspect(prevStats, items) {
  const prev = prevStats && Number(prevStats.items);
  return prev >= 50 && items < prev * 0.2;
}

async function runSource(source, markets) {
  const adapter = ADAPTERS[source.id];
  const result = { source: source.id, markets: [], items: 0, kept: 0, cost_usd: 0, status: 'ok' };
  if (!adapter) { result.status = 'no_adapter'; return result; }

  const spentThisMonth = source.spent_month === month ? Number(source.spent_usd) : 0;
  if (source.monthly_budget_usd > 0 && spentThisMonth >= Number(source.monthly_budget_usd)) {
    result.status = 'budget_spent';
    log(`${source.id}: monthly budget US$${source.monthly_budget_usd} spent; skipped`);
    return result;
  }

  const fx = fxRate();
  const listings = [];
  const seen = [];   // URLs a source proved are still listed without re-reading them (see touchSeen)
  for (const market of markets) {
    const urls = ((source.config || {}).urls || {})[market.id] || (adapter.defaultUrls || {})[market.id] || [];
    if (!urls.length) { result.markets.push({ market: market.id, status: 'no_start_urls' }); continue; }
    const max = Number(args.max) || source.max_results_per_run;
    log(`${source.id} × ${market.id}: ${urls.length} start URL(s), up to ${max} listings`);
    try {
      const { items, costUsd, seenUrls = [] } = await adapter.fetch({ urls, max, config: source.config || {}, svc, sourceId: source.id });
      const normalized = items
        .map((item) => normalizeListing(adapter.toRaw(item), { sourceId: source.id, fx, markets: [market] }))
        .filter(Boolean);
      // A listing the source confirmed without re-reading it still counts as seen: the health check below compares sightings run to run.
      result.items += items.length + seenUrls.length;
      seen.push(...seenUrls);
      result.kept += normalized.length;
      result.cost_usd += costUsd || 0;
      listings.push(...normalized);
      result.markets.push({ market: market.id, items: items.length, kept: normalized.length, cost_usd: costUsd || 0 });
      log(`  → ${items.length} fetched, ${normalized.length} kept, ~US$${(costUsd || 0).toFixed(3)}`);
    } catch (err) {
      result.status = 'error';
      result.markets.push({ market: market.id, status: 'error', error: String(err.message || err).slice(0, 300) });
      log(`  ✗ ${err.message || err}`);
    }
  }

  if (dryRun) {
    result.sample = listings.slice(0, 3);
    return result;
  }

  if (listings.length) {
    const stats = await indexListings(svc, listings);
    result.index = { ...stats, touched: stats.touched.length };
  }
  if (seen.length) result.still_listed = await touchSeen(svc, source.id, seen.map(normalizeUrl));

  const isSuspect = result.status === 'ok' && suspect(source.last_run_stats, result.items);
  if (isSuspect) result.status = 'auto_disabled';
  await svc.from('search_sources').update({
    last_run_at: new Date().toISOString(),
    last_run_status: result.status,
    last_run_stats: { items: result.items, kept: result.kept, markets: result.markets, index: result.index || null },
    spent_month: month,
    spent_usd: Number((spentThisMonth + result.cost_usd).toFixed(4)),
    ...(isSuspect ? { enabled: false } : {})
  }).eq('id', source.id);
  if (isSuspect) log(`${source.id}: only ${result.items} listings vs ${source.last_run_stats.items} last run; source switched OFF, nothing marked stale`);
  return result;
}

try {
  console.log(`\nIngest ${dryRun ? '(dry run) ' : ''}${started.toISOString()}`);

  if (!dryRun) {
    summary.proplync = await syncProplync(svc);
    log(`proplync: ${summary.proplync.synced} listings mirrored, ${summary.proplync.retired} retired`);
  }

  if (!args.flags.has('only-proplync')) {
    let markets = await loadMarkets(svc);
    if (args.market) markets = markets.filter((m) => m.id === args.market);
    let q = svc.from('search_sources').select('*').eq('enabled', true).neq('runner', 'internal');
    if (args.source) q = q.eq('id', args.source);
    const { data: sources, error } = await q;
    if (error) throw error;
    if (!sources.length) log('no enabled crawl sources (switch one on in search_sources)');

    for (const source of sources) {
      const r = await runSource(source, markets);
      summary.sources.push(r);
      // Only a healthy, complete run that saw listings may retire the ones it no longer sees.
      if (!dryRun && r.status === 'ok' && r.items > 0 && !args.market && !args.max) {
        const hours = Math.max(...markets.map((m) => m.refresh_hours || 24));
        const cutoff = new Date(started.getTime() - 2 * hours * 3600 * 1000).toISOString();
        const stale = await markStale(svc, source.id, cutoff);
        summary.stale.push({ source: source.id, ...stale });
      }
    }
  }

  if (!dryRun) {
    summary.embeddings = await embedPending(svc, { limit: Number(args['embed-limit']) || 3000 });
    log(`embeddings: ${summary.embeddings.embedded} added, ${summary.embeddings.pending} still pending`);
  }

  summary.finished = new Date().toISOString();
  console.log('\n' + JSON.stringify(summary, null, 2));
  const failed = summary.sources.some((s) => s.status === 'error' || s.status === 'auto_disabled');
  process.exit(failed ? 1 : 0);
} catch (err) {
  die(err.stack || err.message || String(err));
}
