/* concierge.js — the buyer-facing voice client, shared by the /invest hero and /brief.

   WHY ONE FILE: the conversation (record, transcribe, ask Concierge, speak the answer, keep
   the brief) used to live inline in brief.html. Putting a second copy in the landing page
   would have meant two things to fix every time it changed, so both pages use this one and
   only draw their own screen (transcript bubbles on /brief, captions and chips on /invest).

   THE VOICE: Concierge speaks with the browser's own voices, which cost nothing and send
   nothing anywhere. A browser has no "gender" field, so pickVoice() chooses by name: it
   prefers known women's voices (Paulina, Mónica, Dalia, Sabina, Samantha...), avoids known
   men's, and a slightly slower pace and higher pitch make it softer. It is best effort: a
   device with no woman's voice installed falls back to its default.

   Needs: i18n.js for the language on the page. Optional: hero3d.js (PropLyncOrb) to drive
   the 3D object. Nothing here touches the DOM when the file loads, so it can be unit-tested. */
(function (root) {
  'use strict';

  /* ---------- the brief's fields (shared by both pages) ---------- */
  var FIELDS = [
    ['budget',        'Presupuesto',    'Budget'],
    ['location',      'Zona',           'Location'],
    ['must_haves',    'Imprescindible', 'Must-haves'],
    ['deal_breakers', 'Descartan',      'Deal-breakers'],
    ['nice_to_haves', 'Deseable',       'Nice to have'],
    ['purpose',       'Propósito',      'Purpose'],
    ['timeline',      'Cuándo',         'Timeline']
  ];

  function money(n) { return isFinite(n) ? Number(n).toLocaleString('en-US') : String(n); }

  /* A brief's value as one line for a person. Recursive on purpose: location is {areas: [...], anchors: [...]}, and stringifying a
     nested list printed "Tulum,Aldea Zama" with no space. Numbers get thousands separators, and a budget reads "USD 300,000" instead of
     "300000 · USD". */
  function flat(v) {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number') return money(v);
    if (Array.isArray(v)) return v.map(flat).filter(Boolean).join(', ');
    if (typeof v === 'object') {
      if ('max' in v && 'currency' in v) {
        var cur = v.currency ? String(v.currency) + ' ' : '';
        var out = v.max !== null && v.max !== undefined && v.max !== '' ? cur + money(v.max) : '';
        var more = [v.comfortable ? cur + money(v.comfortable) : '', flat(v.financing)].filter(Boolean);
        return [out].concat(more).filter(Boolean).join(' · ');
      }
      return Object.keys(v).map(function (k) { return flat(v[k]); }).filter(Boolean).join(' · ');
    }
    return String(v);
  }

  /* ---------- choosing a woman's voice ---------- */
  var FEMALE = ['paulina', 'monica', 'angelica', 'marisol', 'soledad', 'esperanza', 'luciana', 'isabela',
    'sabina', 'dalia', 'elvira', 'lupe', 'camila', 'valentina', 'paloma', 'larissa', 'laura', 'lucia',
    'marta', 'conchita', 'penelope', 'sofia', 'ximena', 'carolina', 'catalina', 'fernanda', 'jimena',
    'gabriela', 'elena', 'helena', 'samantha', 'ava', 'allison', 'susan', 'victoria', 'karen', 'moira',
    'tessa', 'serena', 'fiona', 'zira', 'jenny', 'aria', 'emma', 'joanna', 'salli', 'kimberly', 'kendra',
    'ivy', 'jessica', 'sara', 'natasha', 'libby', 'sonia', 'hazel', 'mia', 'nova', 'shimmer', 'amy',
    'olivia', 'zoe', 'kate', 'nicky', 'siri'];
  var MALE = ['jorge', 'juan', 'diego', 'carlos', 'alberto', 'pablo', 'andres', 'raul', 'jaime', 'enrique',
    'miguel', 'alex', 'daniel', 'fred', 'tom', 'david', 'mark', 'guy', 'ryan', 'george', 'james', 'oliver',
    'rishi', 'arthur', 'aaron', 'gordon', 'lee', 'thomas', 'eric', 'liam', 'roger', 'brian', 'christopher',
    'steffan', 'alvaro', 'tomas', 'jose', 'luis', 'mateo', 'santiago', 'sergio', 'alejandro', 'antonio',
    'rodrigo', 'cristian', 'guillermo', 'ricardo', 'eddy', 'reed', 'rocko', 'grandpa'];

  /* macOS joke voices and old formant voices. Never the right voice for someone buying a home. */
  var NOVELTY = ['albert', 'bahh', 'bells', 'boing', 'bubbles', 'cellos', 'jester', 'organ', 'superstar',
    'trinoids', 'whisper', 'wobble', 'zarvox', 'deranged', 'hysterical', 'bad', 'good'];
  var ROBOTIC = ['fred', 'junior', 'ralph', 'kathy', 'agnes', 'bruce', 'vicki', 'victoria', 'princess',
    'flo', 'sandy', 'shelley', 'grandma', 'grandpa', 'rocko', 'reed'];
  var QUALITY = /natural|neural|premium|enhanced|online|siri/;

  function words(name) {
    var s = String(name || '').toLowerCase();
    if (s.normalize) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return s.split(/[^a-z]+/).filter(Boolean);
  }
  function inList(list) { return function (w) { return list.indexOf(w) !== -1; }; }

  function scoreVoice(v, lang) {
    var want = lang === 'es' ? 'es' : 'en';
    var vl = String(v.lang || '').toLowerCase().replace('_', '-');
    if (vl.indexOf(want) !== 0) return -Infinity;
    var name = String(v.name || '').toLowerCase();
    var w = words(v.name);
    var s = ({ 'es-mx': 12, 'es-us': 8, 'es-es': 4, 'en-us': 12, 'en-gb': 6 })[vl] || 0;
    if (/\bfemale\b|\bmujer\b|\bfemenin/.test(name)) s += 60;
    else if (/\bmale\b|\bhombre\b|\bmasculin/.test(name)) s -= 100;
    if (w.some(inList(FEMALE))) s += 45;
    if (w.some(inList(MALE))) s -= 80;
    /* Quality is what separates "a woman's voice" from "a robot with a woman's name". */
    if (QUALITY.test(name)) s += 25;
    if (v.localService === false) s += 6;                       // network voices are usually neural
    if (w.some(inList(NOVELTY))) s -= 150;
    else if (w.some(inList(ROBOTIC)) || /compact/.test(name)) s -= 30;
    return s;
  }

  /* Best match for the page's language, or null when the device has none. */
  function pickVoice(voices, lang) {
    var best = null, bestScore = -Infinity;
    (voices || []).forEach(function (v) {
      var sc = scoreVoice(v, lang);
      if (sc > bestScore) { best = v; bestScore = sc; }
    });
    return best;
  }
  /* True only when the name says "woman" (a known name or an explicit tag), not when we are guessing. */
  function isLikelyFemale(v, lang) { return !!v && scoreVoice(v, lang) >= 40; }
  function isNatural(v) { return !!v && QUALITY.test(String(v.name || '').toLowerCase()); }

  /* ---------- shaping the text so it sounds like speech ----------
     A reply read as one block sounds like a machine; the same words in short phrases, with money and
     sizes said the way people say them, sound like a person. Sentences are spoken one after another. */
  function shapeSpeech(text, lang) {
    var es = lang === 'es';
    var s = String(text || '');
    s = s.replace(/[*_`#~^|<>]/g, ' ');
    s = s.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ');            // emoji
    s = s.replace(/\b(USD|MXN)\s*\$?\s*(\d[\d.,]*)\s?(k|mil)?/gi, function (m, cur, num, k) {
      var word = String(cur).toUpperCase() === 'USD' ? (es ? 'dólares' : 'dollars') : 'pesos';
      return num + (k ? (es ? ' mil' : ' thousand') : '') + ' ' + word;
    });
    s = s.replace(/\$\s*(\d[\d.,]*)\s?(k|mil)\b/gi, function (m, num) { return num + (es ? ' mil' : ' thousand'); });
    s = s.replace(/(\d)\s?k\b/gi, function (m, d) { return d + (es ? ' mil' : ' thousand'); });
    s = s.replace(/\bm²|\bm2\b/g, es ? ' metros cuadrados' : ' square meters');
    s = s.replace(/%/g, es ? ' por ciento' : ' percent');
    s = s.replace(/&/g, es ? ' y ' : ' and ');
    s = s.replace(/\s+/g, ' ').trim();
    if (!s) return [];
    var out = [], carry = '';
    s.replace(/([.!?\u2026]+)\s+/g, '$1\u0001').split('\u0001').forEach(function (part) {
      part = (carry + ' ' + part).trim();
      carry = '';
      if (part.length < 14) { carry = part; return; }               // "Sí." is not worth its own breath
      out.push(part);
    });
    if (carry) { if (out.length) out[out.length - 1] += ' ' + carry; else out.push(carry); }
    return out;
  }

  /* ---------- hand-off between the landing hero and /brief ----------
     sessionStorage, not localStorage: it holds what the buyer said, so it should die with the tab,
     and it is deleted the moment /brief reads it. */
  var HANDOFF_KEY = 'pl_voice_handoff';
  var HANDOFF_TTL = 30 * 60 * 1000;

  function saveHandoff(messages, brief, done) {
    try {
      root.sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ messages: messages, brief: brief || {}, done: !!done, at: Date.now() }));
    } catch (e) { /* storage blocked: the buyer simply starts over on /brief */ }
  }
  function takeHandoff() {
    var raw = null;
    try { raw = root.sessionStorage.getItem(HANDOFF_KEY); root.sessionStorage.removeItem(HANDOFF_KEY); } catch (e) { return null; }
    if (!raw) return null;
    var h;
    try { h = JSON.parse(raw); } catch (e) { return null; }
    if (!h || !Array.isArray(h.messages) || Date.now() - (h.at || 0) > HANDOFF_TTL) return null;
    var msgs = h.messages.filter(function (m) {
      return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string';
    }).slice(-60).map(function (m) { return { role: m.role, content: m.content.slice(0, 4000) }; });
    if (!msgs.length) return null;
    return { messages: msgs, brief: (h.brief && typeof h.brief === 'object' && !Array.isArray(h.brief)) ? h.brief : {}, done: !!h.done };
  }

  /* ---------- the conversation ---------- */
  function create(opts) {
    var doc = root.document;
    var t = opts.t || function (es, en) { return doc.documentElement.lang === 'es' ? es : en; };
    var micEl = opts.micEl, stateEl = opts.stateEl, outEl = opts.outEl || null;
    var messages = opts.messages || [];
    var brief = {}, busy = false, curState = 'idle', started = false;

    var STATE_TEXT = {
      idle:         ['Toca el micrófono y cuéntame qué buscas.', 'Tap the mic and tell me what you are looking for.'],
      listening:    ['Te escucho. Toca de nuevo para enviar.', 'Listening. Tap again to send.'],
      transcribing: ['Transcribiendo...', 'Transcribing...'],
      thinking:     ['Pensando...', 'Thinking...'],
      speaking:     ['Concierge responde. Toca el micrófono para interrumpir.', 'Concierge is answering. Tap the mic to interrupt.']
    };
    function orb() { return root.PropLyncOrb || null; }
    function notify(kind, text) { if (opts.onNotice) opts.onNotice(kind, text); }
    function markStart() { if (!started) { started = true; if (opts.onStart) opts.onStart(); } }

    function voiceState(s) {
      curState = s;
      if (orb()) orb().setState(s === 'transcribing' ? 'thinking' : s);
      if (stateEl) stateEl.textContent = t(STATE_TEXT[s][0], STATE_TEXT[s][1]);
      micEl.setAttribute('data-state', s);
      micEl.setAttribute('data-rec', s === 'listening' ? 'true' : 'false');
      micEl.setAttribute('aria-pressed', s === 'listening' ? 'true' : 'false');
      micEl.setAttribute('aria-label', s === 'listening' ? t('Terminar y enviar', 'Stop and send') : t('Hablar con Concierge', 'Talk to Concierge'));
    }

    /* ----- spoken replies ----- */
    var speechOk = 'speechSynthesis' in root && typeof root.SpeechSynthesisUtterance !== 'undefined';
    var voiceOut = speechOk;
    try { if (root.localStorage.getItem('pl_voice_out') === 'off') voiceOut = false; } catch (e) { /* keep the default */ }

    function paintOut() {
      if (!outEl) return;
      outEl.setAttribute('aria-pressed', voiceOut ? 'true' : 'false');
      var label = voiceOut ? t('Respuestas en voz: activadas', 'Spoken replies: on') : t('Respuestas en voz: apagadas', 'Spoken replies: off');
      outEl.setAttribute('title', label);
      outEl.setAttribute('aria-label', label);
    }
    if (outEl) {
      if (!speechOk) { outEl.hidden = true; } else { paintOut(); }
      outEl.addEventListener('click', function () {
        voiceOut = !voiceOut;
        try { root.localStorage.setItem('pl_voice_out', voiceOut ? 'on' : 'off'); } catch (e) { /* not fatal */ }
        if (!voiceOut) { stopSpeaking(); if (curState === 'speaking') voiceState('idle'); }
        paintOut();
      });
    }

    /* Safari only lets speech start from a tap, and the reply arrives seconds after the tap.
       Speaking a silent utterance on the first tap unlocks it for later. */
    var unlocked = false;
    function unlockSpeech() {
      if (!speechOk || unlocked) return;
      unlocked = true;
      try { var u = new root.SpeechSynthesisUtterance(' '); u.volume = 0; root.speechSynthesis.speak(u); } catch (e) { /* not fatal */ }
    }

    var speakGen = 0;   // a new reply or an interruption makes any older queued sentence stop
    function stopSpeaking() {
      speakGen++;
      if (speechOk) root.speechSynthesis.cancel();
    }

    function speak(text) {
      var lang = doc.documentElement.lang === 'es' ? 'es' : 'en';
      var parts = shapeSpeech(text, lang);
      if (!speechOk || !voiceOut || !parts.length) { voiceState('idle'); return; }
      try {
        root.speechSynthesis.cancel();
        var gen = ++speakGen;
        var v = pickVoice(root.speechSynthesis.getVoices(), lang);
        var natural = isNatural(v);
        var female = isLikelyFemale(v, lang);
        /* Gentle pace. No pitch-shifting on a natural voice, because shifting is what makes one sound
           synthetic; an ordinary voice gets a little lift so it reads softer. */
        var rate = natural ? 0.97 : 0.94;
        var pitch = natural ? 1.0 : (female ? 1.06 : 1.2);
        (function next(i) {
          if (gen !== speakGen) return;
          if (i >= parts.length) { if (curState === 'speaking') voiceState('idle'); return; }
          var u = new root.SpeechSynthesisUtterance(parts[i]);
          if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = lang === 'es' ? 'es-MX' : 'en-US'; }
          u.rate = rate;
          u.pitch = (!natural && /\?$/.test(parts[i])) ? pitch + 0.05 : pitch;   // a small lilt on a question
          if (i === 0) u.onstart = function () { if (gen === speakGen) voiceState('speaking'); };
          u.onend = function () { next(i + 1); };
          u.onerror = function () { if (gen === speakGen && curState === 'speaking') voiceState('idle'); };
          root.speechSynthesis.speak(u);
        })(0);
        /* A browser with no voice installed can accept the call and never start. */
        root.setTimeout(function () { if (gen === speakGen && curState === 'thinking' && !root.speechSynthesis.speaking) voiceState('idle'); }, 3000);
      } catch (e) { voiceState('idle'); }
    }

    /* ----- recording ----- */
    var rec = null, chunks = [], recTimer = null, audioCtx = null, analyser = null, levelRaf = 0;
    var MAX_RECORD_MS = 60000;   // a longer note is rarely one thought, and the server caps the upload

    function watchLevel(stream) {
      try {
        audioCtx = new (root.AudioContext || root.webkitAudioContext)();
        var src = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        var buf = new Uint8Array(analyser.fftSize);
        (function tick() {
          if (!analyser) return;
          analyser.getByteTimeDomainData(buf);
          var sum = 0;
          for (var i = 0; i < buf.length; i++) { var x = (buf[i] - 128) / 128; sum += x * x; }
          var lv = Math.min(1, Math.sqrt(sum / buf.length) * 4);
          if (orb()) orb().setLevel(lv);
          micEl.style.setProperty('--lvl', lv.toFixed(2));
          levelRaf = root.requestAnimationFrame(tick);
        })();
      } catch (e) { /* no meter, the recording itself still works */ }
    }
    function stopLevel() {
      analyser = null;
      root.cancelAnimationFrame(levelRaf);
      if (audioCtx) { try { audioCtx.close(); } catch (e) { /* already closed */ } audioCtx = null; }
      if (orb()) orb().setLevel(0);
      micEl.style.setProperty('--lvl', '0');
    }

    async function startRec() {
      try {
        var stream = await root.navigator.mediaDevices.getUserMedia({ audio: true });
        chunks = [];
        rec = new root.MediaRecorder(stream);
        rec.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
        rec.onstop = async function () {
          root.clearTimeout(recTimer);
          stopLevel();
          stream.getTracks().forEach(function (tr) { tr.stop(); });
          var blob = new root.Blob(chunks, { type: rec.mimeType || 'audio/webm' });
          if (!blob.size) { voiceState('idle'); return; }
          voiceState('transcribing');
          try {
            var b64 = await new Promise(function (resolve, reject) {
              var fr = new root.FileReader();
              fr.onload = function () { resolve(String(fr.result).split(',')[1]); };
              fr.onerror = reject;
              fr.readAsDataURL(blob);
            });
            var r = await root.fetch('/api/finder?action=transcribe', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ audio: b64, mime: blob.type })
            });
            var data = await r.json();
            if (r.ok && data.text) { turn(data.text, true); }
            else { notify('err', t('No pude transcribir esa nota.', 'I could not transcribe that note.')); voiceState('idle'); }
          } catch (e) {
            notify('err', t('No pude transcribir esa nota.', 'I could not transcribe that note.'));
            voiceState('idle');
          }
        };
        rec.start();
        markStart();
        watchLevel(stream);
        voiceState('listening');
        recTimer = root.setTimeout(function () { if (rec && rec.state === 'recording') rec.stop(); }, MAX_RECORD_MS);
      } catch (e) {
        /* A denied microphone is a choice, not a failure. Typing still works. */
        notify('err', t('Sin acceso al micrófono. Puedes escribir.', 'No microphone access. You can type instead.'));
        voiceState('idle');
      }
    }

    function toggleMic() {
      unlockSpeech();
      stopSpeaking();                                                // tapping the mic interrupts Concierge
      if (!root.navigator.mediaDevices || typeof root.MediaRecorder === 'undefined') {
        notify('err', t('Este navegador no graba audio. Puedes escribir.', 'This browser cannot record audio. You can type instead.'));
        return;
      }
      if (rec && rec.state === 'recording') { rec.stop(); }
      else if (!busy) { startRec(); }
    }
    micEl.addEventListener('click', toggleMic);

    /* ----- one turn with Concierge ----- */
    async function turn(text, viaVoice) {
      if (busy || !text) return;
      busy = true;
      if (opts.onBusy) opts.onBusy(true);
      markStart();
      stopSpeaking();
      if (opts.onUser) opts.onUser(text);
      messages.push({ role: 'user', content: text });
      voiceState('thinking');

      /* The turn failed for good: take it back out of the conversation (so a retry does not send it
         twice), say why, and hand the buyer's words back so nothing they said is lost. */
      function fail(message) {
        var last = messages[messages.length - 1];
        if (last && last.role === 'user' && last.content === text) messages.pop();
        notify('err', message);
        voiceState('idle');
        if (opts.onFailedText) opts.onFailedText(text);
      }

      try {
        /* One automatic retry for the failures worth retrying (busy, an outage, a dropped connection),
           so a hiccup does not reach the buyer as an error. */
        var out = null;
        for (var attempt = 0; attempt < 2; attempt++) {
          try {
            var resp = await root.fetch('/api/finder?action=turn', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ messages: messages })
            });
            out = { r: resp, data: await resp.json() };
          } catch (e) { out = null; }
          var retryable = !out || out.r.status === 429 || out.r.status >= 500;
          if (!retryable) break;
          if (attempt === 0) await new Promise(function (res) { root.setTimeout(res, 1500); });
        }

        if (!out) { fail(t('Sin conexión con Concierge.', 'No connection to Concierge.')); return; }
        var r = out.r, data = out.data;
        if (!r.ok) {
          /* Name the real reason. "Something went wrong" sends people away; "the key is missing in this
             environment" tells whoever is testing what to fix. */
          fail(data.error === 'concierge_unconfigured'
            ? t('Concierge no está configurado en este entorno (faltan NVIDIA_API_KEY y GROQ_API_KEY).',
                'Concierge is not configured in this environment (NVIDIA_API_KEY and GROQ_API_KEY are both missing).')
            : data.error === 'concierge_busy'
              ? t('Concierge está ocupada. Intenta de nuevo en unos segundos.', 'Concierge is busy. Try again in a few seconds.')
            : data.error === 'rate_limited'
              ? t('Demasiados mensajes seguidos. Espera un momento.', 'Too many messages at once. Give it a moment.')
              : t('Concierge no respondió. Intenta de nuevo.', 'Concierge did not answer. Try again.'));
          return;
        }
        if (data.brief) { brief = data.brief; if (opts.onBrief) opts.onBrief(brief); }
        if (data.say) {
          messages.push({ role: 'assistant', content: data.say });
          if (opts.onReply) opts.onReply(data.say);
          speak(data.say);
        } else {
          voiceState('idle');
        }
        if (data.done && opts.onDone) opts.onDone();
      } catch (e) {
        fail(t('Sin conexión con Concierge.', 'No connection to Concierge.'));
      } finally {
        busy = false;
        if (opts.onBusy) opts.onBusy(false);
        if (opts.onTurnEnd) opts.onTurnEnd(!!viaVoice);
      }
    }

    root.document.addEventListener('langchange', function () { voiceState(curState); paintOut(); });
    voiceState('idle');

    return {
      turn: turn,
      speak: speak,
      toggleMic: toggleMic,
      voiceState: voiceState,
      messages: messages,
      getBrief: function () { return brief; },
      setBrief: function (b) { brief = b || {}; },
      isBusy: function () { return busy; },
      state: function () { return curState; }
    };
  }

  root.PropLyncConcierge = {
    create: create, pickVoice: pickVoice, scoreVoice: scoreVoice, isLikelyFemale: isLikelyFemale, isNatural: isNatural, shapeSpeech: shapeSpeech,
    saveHandoff: saveHandoff, takeHandoff: takeHandoff, FIELDS: FIELDS, flat: flat
  };
})(typeof window !== 'undefined' ? window : globalThis);
