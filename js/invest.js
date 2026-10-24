/* invest.js — the /invest hero is the conversation with Concierge.
   WHY: the page used to end in a link to a second page (/finder, then /voice) where the real
   conversation happened. The 3D object now takes the buyer's voice right where they read the
   promise. The recording, speaking and asking all live in js/concierge.js (shared with /brief);
   this file only draws the hero's half: captions, the captured-needs chips and a hand-off.
   The hand-off sends the conversation to /brief, which is where the brief is approved. */
(function () {
  'use strict';

  var C = window.PropLyncConcierge;
  var micEl = document.getElementById('mic');
  if (!C || !micEl) return;

  function $(id) { return document.getElementById(id); }
  function t(es, en) { return document.documentElement.lang === 'es' ? es : en; }
  function track(name) { if (window.plTrack) window.plTrack(name); }

  var youEl = $('vo-you'), sayEl = $('vo-say'), chipsEl = $('vo-chips'), contEl = $('vo-continue');
  var formEl = $('vo-form'), inputEl = $('vo-input'), typeBtn = $('vo-type-toggle');

  /* What the model is told it already said. Same line as /brief, so the hand-off is seamless. */
  var messages = [{ role: 'assistant', content: 'Hi, I am Concierge. Tell me: what life do you picture there?' }];
  var done = false, lastBrief = {};

  /* Captions replace translated copy, so they must stop being re-translated by the language switch. */
  function caption(el, text, isErr) {
    el.removeAttribute('data-es');
    el.removeAttribute('data-en');
    el.textContent = text;
    el.classList.toggle('err', !!isErr);
  }

  function renderChips(b) {
    chipsEl.textContent = '';
    var filled = 0;
    C.FIELDS.forEach(function (f) {
      var val = C.flat(b[f[0]]);
      if (!val) return;
      filled++;
      var chip = document.createElement('span');
      chip.className = 'vo-chip';
      var k = document.createElement('b');
      k.textContent = t(f[1], f[2]);
      chip.appendChild(k);
      chip.appendChild(document.createTextNode(val.length > 60 ? val.slice(0, 57) + '...' : val));
      chipsEl.appendChild(chip);
    });
    if (window.PropLyncOrb) window.PropLyncOrb.setProgress(done ? 1 : filled / C.FIELDS.length);   // each need closes the object a little more
  }

  function showContinue() {
    var es = done ? 'Revisa y aprueba tu resumen →' : 'Seguir en pantalla completa →';
    var en = done ? 'Review and approve your brief →' : 'Continue in full screen →';
    contEl.hidden = false;
    contEl.className = 'btn ' + (done ? 'btn-gold' : 'btn-ghost') + ' vo-continue';
    contEl.setAttribute('data-es', es);
    contEl.setAttribute('data-en', en);
    contEl.textContent = t(es, en);
  }

  var ui = C.create({
    micEl: micEl,
    stateEl: $('vo-state'),
    outEl: $('voice-out'),
    messages: messages,
    onStart: function () { track('concierge_start'); },
    onUser: function (text) { caption(youEl, text); },
    onReply: function (text) { caption(sayEl, text); showContinue(); },
    onBrief: function (b) { lastBrief = b; renderChips(b); },
    onDone: function () { done = true; renderChips(lastBrief); showContinue(); track('concierge_complete'); },
    onNotice: function (kind, text) { caption(sayEl, text, kind === 'err'); },
    onBusy: function (b) { inputEl.disabled = b; formEl.querySelector('button').disabled = b; },
    /* A turn that failed for good: open the typing box with what they said, ready to send again. */
    onFailedText: function (text) {
      formEl.hidden = false;
      typeBtn.setAttribute('aria-expanded', 'true');
      inputEl.value = text;
    }
  });

  /* Hand the conversation to /brief, where the brief is approved. The link itself does the navigation. */
  contEl.addEventListener('click', function () { C.saveHandoff(messages, ui.getBrief(), done); });

  /* Typing is the quiet alternative, kept out of the way until asked for. */
  typeBtn.addEventListener('click', function () {
    var open = formEl.hidden;
    formEl.hidden = !open;
    typeBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) inputEl.focus();
  });
  formEl.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    ui.turn(text, false);
  });

  document.addEventListener('langchange', function () { renderChips(lastBrief); });

  /* The closing call to action brings the buyer back up to the conversation. */
  var close = $('close-cta');
  if (close) close.addEventListener('click', function (e) {
    e.preventDefault();
    var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    micEl.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'center' });
    micEl.focus({ preventScroll: true });
    micEl.classList.add('nudge');
    setTimeout(function () { micEl.classList.remove('nudge'); }, 1800);
  });
})();
