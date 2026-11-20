/**
 * PropLync Mini · signup (?action=status | create)
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * The front door of the Mini project (mini/index.html). "status" says whether
 * signup is open (MINI_SIGNUP=on); "create" saves the agent's page as an unpaid
 * Mini agency with its properties as drafts; "event" records one anonymous funnel
 * step from any Mini page.
 *
 * WHY NOT A COPY OF THE LOGIC
 * The rules for who may sign up, how a page is saved and what stays hidden until
 * payment live once, in api/onboard.js (handleMiniSignup), and are tested there
 * (test/mini-signup.test.mjs). Both Vercel projects call the same code.
 * -----------------------------------------------------------------------------
 */

import { handleMiniSignup, miniSignupOpen } from './_proplync/onboard.js';
import { buildEventRow } from './_proplync/_lib/events.js';
import { enforceRateLimit } from './_proplync/_lib/ratelimit.js';
import { getServiceClient } from './_proplync/_lib/supabase.js';
import { safeDetail } from './_proplync/_lib/health.js';

/* The Mini funnel (scripts/funnel.mjs, "Mini"): a fixed list, so the events table can't be filled with
   arbitrary names. Anonymous tab ids only (api/_lib/events.js). mini_paid_notice and mini_activated are
   written by the server and the operator script, not accepted from browsers. */
export const MINI_EVENTS = new Set([
  'mini_view', 'mini_preview', 'mini_signup', 'mini_panel_view', 'mini_pay_open', 'mini_page_view', 'mini_interest'
]);

export async function handleEvent(req, res, deps = {}) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  if (await (deps.enforceRateLimit || enforceRateLimit)(req, res, { bucket: 'mini-event', limit: 240, windowSec: 3600 })) return;
  const { row, error } = buildEventRow(req.body, MINI_EVENTS);
  if (error) { res.status(400).json({ error }); return; }
  const { error: dbErr } = await (deps.getServiceClient || getServiceClient)().from('events').insert(row);
  if (dbErr) { res.status(500).json({ error: 'event_failed', detail: safeDetail(dbErr) }); return; }
  res.status(202).json({ ok: true });
}

export default async function handler(req, res) {
  const action = req.query && req.query.action;
  if (action === 'status') {
    res.status(200).json({ open: miniSignupOpen() });
    return;
  }
  if (action === 'event') return handleEvent(req, res);
  if (action === 'create') {
    if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
    return handleMiniSignup(req, res);
  }
  res.status(404).json({ error: 'unknown_action' });
}
