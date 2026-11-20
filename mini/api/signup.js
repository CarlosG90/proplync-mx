/**
 * PropLync Mini · signup (?action=status | create)
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * The front door of the Mini project (mini/index.html). "status" says whether
 * signup is open (MINI_SIGNUP=on); "create" saves the agent's page as an unpaid
 * Mini agency with its properties as drafts.
 *
 * WHY NOT A COPY OF THE LOGIC
 * The rules for who may sign up, how a page is saved and what stays hidden until
 * payment live once, in api/onboard.js (handleMiniSignup), and are tested there
 * (test/mini-signup.test.mjs). Both Vercel projects call the same code.
 * -----------------------------------------------------------------------------
 */

import { handleMiniSignup, miniSignupOpen } from '../../api/onboard.js';

export default async function handler(req, res) {
  const action = req.query && req.query.action;
  if (action === 'status') {
    res.status(200).json({ open: miniSignupOpen() });
    return;
  }
  if (action === 'create') {
    if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
    return handleMiniSignup(req, res);
  }
  res.status(404).json({ error: 'unknown_action' });
}
