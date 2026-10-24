/**
 * Proplync.mx · The funnel, as numbers
 * ─────────────────────────────────────────────────────────────────────────
 * Turns the event_funnel_30d rows (event name -> distinct visitors) into the stages BUSINESS-MODEL R7 asks you to
 * watch: how many visitors reached each step, and what share of the step before it and of the first one.
 * A visitor is a browser tab session, so "sessions" is the honest word. Pure, so it is testable.
 * ─────────────────────────────────────────────────────────────────────────
 */

export const BUYER_STAGES = [
  ['landing_view', 'Saw a landing page'],
  ['concierge_start', 'Started talking to Concierge'],
  ['concierge_complete', 'Finished the brief'],
  ['brief_approved', 'Approved it (Scout starts)'],
  ['scout_result_viewed', 'Viewed Scout results'],
  ['verification_requested', 'Asked for a verification']
];

export const AGENT_STAGES = [
  ['landing_view', 'Saw a landing page'],
  ['agent_signup_start', 'Clicked to join'],
  ['agent_request_sent', 'Sent an access request'],
  ['agent_signup_complete', 'Created an account']
];

/** @param {Array<{name:string, sessions:number}>} rows  @param {Array<[string,string]>} stages */
export function buildFunnel(rows, stages) {
  const counts = {};
  for (const r of rows || []) counts[r.name] = Number(r.sessions) || 0;
  const first = counts[stages[0][0]] || 0;
  return stages.map(([name, label], i) => {
    const sessions = counts[name] || 0;
    const prev = i === 0 ? null : (counts[stages[i - 1][0]] || 0);
    return {
      name, label, sessions,
      of_previous: prev === null ? null : (prev ? Math.round((sessions / prev) * 1000) / 10 : null),
      of_first: i === 0 ? null : (first ? Math.round((sessions / first) * 1000) / 10 : null)
    };
  });
}
