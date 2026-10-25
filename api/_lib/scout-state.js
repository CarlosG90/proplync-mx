/**
 * Proplync.mx · What state is a buyer's Scout search in, and if it has not started, why
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * Approving a brief tries to start Scout, and that can be refused: the free first search is spent and there are no credits, the
 * day's run limit is reached, or Scout is switched off. The refusal was returned to the page once, in the approve response, and shown
 * as one muted line. After a reload the page said only "your brief is saved", so a buyer could not tell whether Scout had run, and
 * approved again (three duplicate briefs in one evening). The status endpoint now derives the state from the database every time, so
 * the page can say plainly "searching", "done", "failed" or "not started, because...", and keep saying it.
 *
 * It never reveals a balance, only whether a credit is needed.
 * -----------------------------------------------------------------------------
 */

/**
 * @param {object} a
 * @param {{status:string}|null} a.run     the brief's latest Scout run, if any
 * @param {{credits:number, free_search_used:boolean}|null} a.wallet  the buyer's wallet (null = none yet, so the free search is available)
 * @param {number} a.startedToday  runs started today (UTC)
 * @param {number} a.cap           the daily run limit
 * @param {boolean} a.canRun       Scout is configured and not switched off
 * @returns {{state:'searching'|'done'|'failed'|'not_started', reason?:'needs_credit'|'busy'|'unavailable'|'unknown'}}
 */
export function scoutState({ run, wallet, startedToday = 0, cap = 0, canRun = true }) {
  if (run) {
    if (run.status === 'queued' || run.status === 'running') return { state: 'searching' };
    if (run.status === 'failed') return { state: 'failed' };
    return { state: 'done' };
  }
  if (wallet && wallet.free_search_used && Number(wallet.credits) < 1) return { state: 'not_started', reason: 'needs_credit' };
  if (!canRun) return { state: 'not_started', reason: 'unavailable' };
  if (cap > 0 && startedToday >= cap) return { state: 'not_started', reason: 'busy' };
  return { state: 'not_started', reason: 'unknown' };
}

/** JSON with keys sorted at every level: Postgres stores jsonb in its own key order, so two equal briefs rarely stringify equally. */
export function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export const sameBrief = (a, b) => stableStringify(a) === stableStringify(b);
