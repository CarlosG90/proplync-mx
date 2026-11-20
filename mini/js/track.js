/* PropLync Mini · funnel events
   ─────────────────────────────────────────────────────────────────
   WHY: to know where agents drop off (saw the page → built a preview → saved →
   paid) and whether buyers use the pages. Anonymous by design: a random id that
   lives only in this browser tab, plus where the visit came from (UTM tags, the
   referring site). Never an email, phone or name; the server drops anything that
   looks like one (api/_lib/events.js). The page never waits on this. */
(function () {
  'use strict';
  function store(k, v) { try { if (v !== undefined) sessionStorage.setItem(k, v); return sessionStorage.getItem(k); } catch (e) { return v || null; } }
  var sid = store('mini_sid') || store('mini_sid', (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)));
  var q = new URLSearchParams(location.search);
  ['utm_source', 'utm_medium', 'utm_campaign'].forEach(function (k) { if (q.get(k)) store('mini_' + k, q.get(k).slice(0, 80)); });
  if (q.get('ref') && !store('mini_utm_source')) store('mini_utm_source', q.get('ref').slice(0, 80));
  var refHost = '';
  try { refHost = document.referrer ? new URL(document.referrer).hostname : ''; } catch (e) {}
  if (refHost === location.hostname) refHost = '';

  window.miniTrack = function (name, props) {
    try {
      var body = JSON.stringify({
        name: name, page: document.body.getAttribute('data-page') || 'unknown', session: sid,
        lang: document.documentElement.lang === 'en' ? 'en' : 'es',
        utm_source: store('mini_utm_source'), utm_medium: store('mini_utm_medium'), utm_campaign: store('mini_utm_campaign'),
        ref_host: refHost || null, props: props || {}
      });
      var url = '/api/signup?action=event';
      if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) return;
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body, keepalive: true }).catch(function () {});
    } catch (e) { /* tracking must never break a page */ }
  };
})();
