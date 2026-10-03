/* Proplync.mx · nav reflects whether an agent is signed in
   ─────────────────────────────────────────────────────────────────
   WHY THIS EXISTS
   An agent logs in, comes back to the landing page, and every button still
   says "Soy agente" pointing at /login. The session was alive in localStorage
   the whole time — the public pages simply never asked. Clicking through to a
   login form you did not need reads as "the session didn't stay", which is the
   bug this fixes on the display side. (login.html handles the other half: it
   now sends an already-authenticated visitor straight to the dashboard.)

   WHY NOT THE SUPABASE SDK
   These are public pages, two of them buyer-facing (search, property). Loading
   ~100KB of auth SDK to decide the wording of one link is a bad trade, so this
   reads the token supabase-js already wrote and does no network call.

   NOTHING IS SECURED HERE. This only picks a label and an href. dashboard.html
   still calls requireAuth(), api/ still verifies the bearer token, and Postgres
   RLS still governs every row. A forged localStorage entry buys a visitor a
   dashboard link that bounces them right back to /login.

   FAILS CLOSED. Anything unexpected — key missing, JSON unparseable, shape
   changed by a future supabase-js, storage blocked in private mode — and we
   leave the nav exactly as the HTML shipped it: "Soy agente" → /login. */

(function () {
  /* Mirrors SUPABASE_URL in js/supabase-client.js, which is the source of
     truth. supabase-js v2 keys its session as sb-<project-ref>-auth-token. */
  var PROJECT_REF = 'rznuuykmtvbgmnczbqiq';
  var STORAGE_KEY = 'sb-' + PROJECT_REF + '-auth-token';

  function hasLiveSession() {
    var raw;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return false;          // private mode, blocked site data
    }
    if (!raw) return false;

    /* Some supabase-js builds prefix the value when the payload is encoded.
       Handle it rather than mistaking a live session for none. */
    if (raw.indexOf('base64-') === 0) {
      try {
        raw = atob(raw.slice(7));
      } catch (e) {
        return false;
      }
    }

    var session;
    try {
      session = JSON.parse(raw);
    } catch (e) {
      return false;
    }
    if (!session || !session.access_token) return false;

    /* Require a real expiry in the future. An entry we cannot date is an entry
       we do not trust — better a redundant login link than a dashboard link
       that dumps the agent back on the login form. */
    if (typeof session.expires_at !== 'number') return false;
    return session.expires_at * 1000 > Date.now();
  }

  function applySignedIn() {
    /* "Mi agencia" is what the product already calls this view — the button at
       dashboard.html:227 and the heading at :343. Reusing that wording instead
       of inventing a synonym keeps one name for one place. */
    var es = 'Mi agencia';
    var en = 'My agency';

    /* Swap the elements that only make sense for one audience: a signed-in
       agent does not need "Soy una agencia" or a sales call, and a visitor
       must not see a dashboard button. Declared in the HTML so each page
       decides for itself; this file just flips them. */
    document.querySelectorAll('[data-agent-only]').forEach(function (el) {
      el.hidden = false;
    });
    document.querySelectorAll('[data-guest-only]').forEach(function (el) {
      el.hidden = true;
    });

    /* Relabel the identity-claim links only. "Ver mi panel" / "Ver el CRM"
       already read correctly once you are signed in, so they only need the
       href change below. */
    ['Soy agente', 'Soy una agencia'].forEach(function (label) {
      document.querySelectorAll('[data-es="' + label + '"]').forEach(function (el) {
        /* data-es/data-en too, not just the text: setLang() in js/i18n.js
           rewrites innerHTML from these attributes on every language toggle
           and would otherwise put "Soy agente" straight back. */
        el.setAttribute('data-es', es);
        el.setAttribute('data-en', en);
        el.innerHTML = document.documentElement.lang === 'en' ? en : es;
      });
    });

    document.querySelectorAll('a[href="/login"]').forEach(function (a) {
      a.setAttribute('href', '/dashboard');
    });
  }

  function run() {
    try {
      if (hasLiveSession()) applySignedIn();
    } catch (e) {
      /* Never let a nav label break the page it sits on. */
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
