/* agents.js — the request-access form on /agents.
   WHY: agent accounts are invite-only, so the old "Join as an agent" button led a cold visitor to an invite-code
   wall. This form stores a request (POST /api/leads?action=contact, kind "agent") that someone reads before
   sending an invite. Success is shown only when the server confirms it, never before. */
(function () {
  'use strict';

  var form = document.getElementById('agent-form');
  if (!form) return;
  var errEl = document.getElementById('agent-error');
  var doneEl = document.getElementById('agent-done');
  var btn = document.getElementById('agent-submit');

  function t(es, en) { return document.documentElement.lang === 'en' ? en : es; }

  function placeholders() {
    var lang = document.documentElement.lang === 'en' ? 'en' : 'es';
    document.querySelectorAll('textarea[data-' + lang + '-placeholder]').forEach(function (el) {
      el.placeholder = el.getAttribute('data-' + lang + '-placeholder');
    });
  }
  placeholders();
  document.addEventListener('langchange', placeholders);

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var label = btn.textContent;
    errEl.hidden = true;
    btn.disabled = true;
    btn.textContent = t('Enviando...', 'Sending...');

    var data = Object.fromEntries(new FormData(form));
    data.type = 'agent';
    data.source = 'agents';
    data.lang = document.documentElement.lang === 'en' ? 'en' : 'es';

    try {
      var r = await fetch('/api/leads?action=contact', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data)
      });
      var out = await r.json().catch(function () { return {}; });
      if (!r.ok) { var f = new Error(out.error || ('http_' + r.status)); f.status = r.status; throw f; }
      form.hidden = true;
      doneEl.hidden = false;
      if (window.plTrack) window.plTrack('agent_request_sent');
    } catch (f) {
      var msgs = {
        invalid_email: t('Revisa tu correo: no parece válido.', 'Please check your email address.'),
        name_and_email_required: t('Escribe tu nombre y tu correo.', 'Please enter your name and email.'),
        invalid_phone: t('Revisa tu número de WhatsApp.', 'Please check your WhatsApp number.')
      };
      errEl.textContent = msgs[f.message]
        || (f.status === 429
            ? t('Demasiados intentos. Intenta más tarde o escríbenos a hola@proplync.mx.', 'Too many attempts. Try again later or email hola@proplync.mx.')
            : t('No pudimos enviar tu solicitud. Escríbenos a hola@proplync.mx.', "We couldn't send your request. Email us at hola@proplync.mx."));
      errEl.hidden = false;
      btn.disabled = false;
      btn.textContent = label;
    }
  });
})();
