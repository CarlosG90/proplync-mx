/* ──────────────────────────────────────────────────────────────
   landing.js — shared behaviour for /invest, /agents, /resources

   Three jobs:
   1. Language switch over the repo's data-es / data-en convention.
   2. Mobile nav toggle.
   3. Tracking events from LANDING-PAGES-PLAN.md §7.

   WHY the tracking layer is a stub: §7 lists the event names but
   the analytics tool is still [TBD] (GA4 vs a privacy-friendly
   alternative, and EU cookie consent hangs off that choice).
   Every call site is already in place; wiring a vendor means
   filling in one function, not hunting for the call sites.
   ────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  /* ── 1. Language ─────────────────────────────────────────── */

  var STORE_KEY = 'pl-lang';
  var root = document.documentElement;

  function readStoredLang() {
    // Storage can throw in private mode or with site data blocked.
    try { return window.localStorage.getItem(STORE_KEY); } catch (e) { return null; }
  }

  function writeStoredLang(lang) {
    try { window.localStorage.setItem(STORE_KEY, lang); } catch (e) { /* non-fatal */ }
  }

  function applyLang(lang) {
    var nodes = document.querySelectorAll('[data-' + lang + ']');
    for (var i = 0; i < nodes.length; i++) {
      var next = nodes[i].getAttribute('data-' + lang);
      if (next !== null) nodes[i].textContent = next;
    }
    root.setAttribute('lang', lang);
    var buttons = document.querySelectorAll('.lp-lang button');
    for (var j = 0; j < buttons.length; j++) {
      buttons[j].setAttribute('aria-pressed', String(buttons[j].dataset.lang === lang));
    }
    writeStoredLang(lang);
  }

  function initLang() {
    // Page default wins on first visit; a stored choice wins after.
    var pageDefault = document.body.dataset.defaultLang || 'en';
    applyLang(readStoredLang() || pageDefault);

    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.lp-lang button');
      if (!btn) return;
      applyLang(btn.dataset.lang);
    });
  }

  /* ── 2. Mobile nav ───────────────────────────────────────── */

  function initNav() {
    var toggle = document.querySelector('.lp-nav__toggle');
    var links = document.querySelector('.lp-nav__links');
    if (!toggle || !links) return;

    toggle.addEventListener('click', function () {
      var open = links.getAttribute('data-open') === 'true';
      links.setAttribute('data-open', String(!open));
      toggle.setAttribute('aria-expanded', String(!open));
    });
  }

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

  function boot() {
    initLang();
    initNav();
    initTracking();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
