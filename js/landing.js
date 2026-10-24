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
    'agent_signup_start', 'agent_signup_complete', 'agent_request_sent'
  ];

  /* landing_view means "a landing page was seen"; /brief and /signup load this file for the funnel events only. */
  var LANDING_PAGES = ['home', 'invest', 'agents', 'agencias', 'resources', 'article'];

  function track(name, props) {
    if (EVENTS.indexOf(name) === -1) return; // typo guard
    var payload = Object.assign({ page: document.body.dataset.page || '' }, props || {});

    /* Events are always queued on window (a provider added later can drain them) and logged in dev.
       They are also handed to whichever analytics tool the page has loaded, so choosing one (§7, still
       open) means adding its script tag and nothing else. No tool is loaded today, so nothing leaves
       the browser. */
    (window.plEvents = window.plEvents || []).push({ name: name, props: payload, at: Date.now() });
    if (window.location.hostname === 'localhost') console.debug('[track]', name, payload);
    try {
      if (window.umami && typeof window.umami.track === 'function') window.umami.track(name, payload);
      else if (typeof window.plausible === 'function') window.plausible(name, { props: payload });
      else if (typeof window.gtag === 'function') window.gtag('event', name, payload);
    } catch (e) { /* analytics must never break the page */ }
  }

  window.plTrack = track;

  function initTracking() {
    if (LANDING_PAGES.indexOf(document.body.dataset.page || '') !== -1) track('landing_view');

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
