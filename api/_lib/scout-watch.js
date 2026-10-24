/**
 * Proplync.mx · Scout watchdog
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * Each Scout segment ends by calling the next one over HTTP. If that call is lost (a network blip, a
 * function killed at its time limit), nothing restarts the run: it sits on "searching" for ever, with the
 * buyer's credit already spent. The buyer's status page polls every few seconds while a run is active, so
 * it doubles as the watchdog: it asks stuckAction() and acts on the answer.
 *
 *   kick  restart the run. Harmless if something is in fact working on it: the lease lets only one segment
 *         run at a time. Throttled, so a page left open cannot flood the function.
 *   fail  the run is far past anything normal. Close it, refund the buyer once, tell the operator.
 *
 * The effects (restart, refund, notify, throttle) are passed in, so the rules can be tested without a
 * network and finder.js stays the only place that knows how to do them.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { stuckAction } from './scout.js';

/**
 * @param {object} svc   service-role Supabase client
 * @param {object} run   the buyer's latest scout_runs row (id, status, created_at, lease_until, user_id, charged)
 * @param {object} brief the buyer_briefs row (id)
 * @param {object} fx    { recentlyKicked(id), markKicked(id), kick(id), refund(run), notify({subject,text}) }
 * @returns {Promise<'none'|'wait'|'throttled'|'kicked'|'failed'|'already_closed'>}
 */
export async function watchRun(svc, run, brief, fx) {
  const action = stuckAction(run);

  if (action === 'kick') {
    if (await fx.recentlyKicked(run.id)) return 'throttled';
    await fx.markKicked(run.id);
    fx.kick(run.id);
    return 'kicked';
  }

  if (action === 'fail') {
    // Only the caller that flips the status refunds, so two polls at once cannot refund twice.
    const { data: closed } = await svc.from('scout_runs')
      .update({ status: 'failed', error: 'stalled', lease_until: null, finished_at: new Date().toISOString() })
      .eq('id', run.id).in('status', ['queued', 'running'])
      .select('id').maybeSingle();
    if (!closed) return 'already_closed';
    await svc.from('buyer_briefs').update({ status: 'review', updated_at: new Date().toISOString() }).eq('id', brief.id);
    await fx.refund(run);
    fx.notify({
      subject: 'Scout: búsqueda detenida (sin avance)',
      text: `Run ${run.id} llevaba demasiado tiempo sin avanzar y se cerró como fallida. Se devolvió el crédito.\nBrief ${brief.id}\n\nRevisar con: node scripts/scout.mjs list`
    });
    return 'failed';
  }

  return action;   // 'none' or 'wait'
}
