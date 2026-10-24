/* ──────────────────────────────────────────────────────────────
   landing.js — tracking for /invest, /agents, /resources

   Language and the mobile menu are shared with the main site: the
   pages load js/i18n.js (same proplync_lang key, so the choice carries
   across pages) and the header uses the same inline menu toggle.
   This file only handles the §7 tracking events.
   ────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  /* ── 3. Tracking (§7) ────────────────────────────────────── */

  var EVENTS = [
    'landing_view', 'cta_click', 'concierge_start', 'concierge_complete',
    'brief_approved', 'scout_result_viewed', 'verification_requested',
    'agent_signup_start', 'agent_signup_complete'
  ];

  function track(name, props) {
    if (EVENTS.indexOf(name) === -1) return; // typo guard
    var payload = Object.assign({ page: document.body.dataset.page || '' }, props || {});

    // TODO(§9 / measurement): replace this block with the chosen
    // provider. Until then events are queued on window so a
    // provider added later can drain them, and logged in dev.
    (window.plEvents = window.plEvents || []).push({ name: name, props: payload, at: Date.now() });
    if (window.location.hostname === 'localhost') console.debug('[track]', name, payload);
  }

  window.plTrack = track;

  function initTracking() {
    track('landing_view');

    document.addEventListener('click', function (e) {
      var cta = e.target.closest('[data-track]');
      if (!cta) return;
      track(cta.dataset.track, { button: cta.dataset.trackLabel || cta.textContent.trim() });
    });
  }

  /* ── Boot ────────────────────────────────────────────────── */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTracking);
  } else {
    initTracking();
  }
})();
