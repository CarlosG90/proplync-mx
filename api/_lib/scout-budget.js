/**
 * Proplync.mx · Scout spending limits
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * Scout is the only part of Finder whose cost grows with every buyer. Each run
 * reads web pages with a paid model, and the first search is free, so demand
 * alone could run up a bill nobody approved. The daily run cap
 * (SCOUT_MAX_RUNS_PER_DAY) limits how many runs start, not what they cost.
 * These two limits cap the money directly:
 *
 *   SCOUT_MONTHLY_BUDGET_USD  no new automatic run starts once the runs created
 *                             this calendar month (UTC) have cost this much.
 *                             Default 50.
 *   SCOUT_RUN_MAX_USD         a run that reaches this cost is told to submit
 *                             what it has; if it keeps going it is stopped.
 *                             Default 2.
 *
 * WHY NOT 0 TO TURN SCOUT OFF
 * A missing or invalid value falls back to the default, so a typo can never
 * remove the limit. To stop Scout entirely, use SCOUT_PAID_RUNS=off.
 *
 * Operator runs (scripts/scout.mjs) skip the monthly budget on purpose: a
 * person chose to spend that money. They still obey the per-run limit.
 * -----------------------------------------------------------------------------
 */

export const DEFAULT_MONTHLY_BUDGET_USD = 50;
export const DEFAULT_RUN_MAX_USD = 2;

/** A positive number from an env value, or the fallback. */
export function usdFromEnv(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function monthlyBudgetUsd(env = process.env) {
  return usdFromEnv(env.SCOUT_MONTHLY_BUDGET_USD, DEFAULT_MONTHLY_BUDGET_USD);
}

export function runMaxUsd(env = process.env) {
  return usdFromEnv(env.SCOUT_RUN_MAX_USD, DEFAULT_RUN_MAX_USD);
}

/** First instant of the current calendar month, UTC. */
export function monthStartUtc(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Sum of cost_usd over scout_runs rows, rounded like the column. */
export function sumCosts(rows) {
  const total = (rows || []).reduce((sum, r) => sum + (Number(r && r.cost_usd) || 0), 0);
  return Number(total.toFixed(4));
}

/** What runs created this month have cost so far, in USD. */
export async function spentThisMonth(svc, now = new Date()) {
  const { data, error } = await svc.from('scout_runs')
    .select('cost_usd')
    .gte('created_at', monthStartUtc(now).toISOString());
  if (error) throw error;
  return sumCosts(data);
}

export function overRunLimit(costUsd, limitUsd = runMaxUsd()) {
  return Number(costUsd) >= limitUsd;
}
