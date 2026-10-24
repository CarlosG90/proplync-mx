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

  /* ── First-party event log (supabase/014_events.sql) ──
     Each tracked event is also sent to our own /api/leads?action=event, so the funnel can be read with SQL
     (node scripts/funnel.mjs) without an analytics vendor or a cookie. What is sent: the event name, the page,
     an anonymous id that lives only in this tab (sessionStorage), the language, the campaign tags (UTM) and
     the referring site's host. Never an IP, a name or an email. Nothing is sent when Do Not Track or Global
     Privacy Control is on, nor from localhost (so developing does not fill the table). */

  var ONCE_PER_SESSION = ['concierge_start', 'concierge_complete'];   // the conversation may continue on /brief; count it once

  function tabStore() { try { return window.sessionStorage; } catch (e) { return null; } }

  function randomId() {
    var a = new Uint8Array(12);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(a);
    else for (var i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function sessionId() {
    var ss = tabStore();
    if (!ss) return null;
    try {
      var id = ss.getItem('pl_sid');
      if (!id) { id = randomId(); ss.setItem('pl_sid', id); }
      return id;
    } catch (e) { return null; }
  }

  /* Where the visitor came from, decided once per tab, on the first event, and carried to later pages. */
  function attribution() {
    var ss = tabStore();
    if (!ss) return {};
    try {
      var saved = ss.getItem('pl_attr');
      if (saved) return JSON.parse(saved);
      var q = new URLSearchParams(window.location.search);
      var ref = '';
      try { ref = new URL(document.referrer).hostname.toLowerCase(); } catch (e) { /* no referrer */ }
      if (ref === window.location.hostname) ref = '';
      var attr = { utm_source: q.get('utm_source'), utm_medium: q.get('utm_medium'), utm_campaign: q.get('utm_campaign'), ref_host: ref || null };
      ss.setItem('pl_attr', JSON.stringify(attr));
      return attr;
    } catch (e) { return {}; }
  }

  function eventsEnabled() {
    var host = window.location.hostname;
    var dev = false;
    try { dev = window.localStorage.getItem('pl_events_dev') === '1'; } catch (e) { /* storage blocked */ }
    if ((host === 'localhost' || host === '127.0.0.1') && !dev) return false;
    var nav = window.navigator;
    if (nav.doNotTrack === '1' || window.doNotTrack === '1' || nav.globalPrivacyControl === true) return false;
    return true;
  }

  function sendFirstParty(name, payload) {
    try {
      if (!eventsEnabled()) return;
      var sid = sessionId();
      if (!sid) return;
      if (ONCE_PER_SESSION.indexOf(name) !== -1) {
        var ss = tabStore();
        var key = 'pl_once_' + name;
        if (ss.getItem(key)) return;
        ss.setItem(key, '1');
      }
      var props = {};
      Object.keys(payload).forEach(function (k) { if (k !== 'page') props[k] = payload[k]; });
      var attr = attribution();
      var body = JSON.stringify({
        name: name, page: payload.page || 'unknown', session: sid,
        lang: document.documentElement.lang === 'en' ? 'en' : 'es',
        utm_source: attr.utm_source, utm_medium: attr.utm_medium, utm_campaign: attr.utm_campaign, ref_host: attr.ref_host,
        props: props
      });
      var url = '/api/leads?action=event';
      if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) return;
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body, keepalive: true }).catch(function () {});
    } catch (e) { /* the event log must never break the page */ }
  }

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
    sendFirstParty(name, payload);
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
