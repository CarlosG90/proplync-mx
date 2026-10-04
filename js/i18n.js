/* Proplync.mx · Internationalization (ES/EN)
   ─────────────────────────────────────────── */

/* Each page declares its own starting language in <html lang>. A language the
   visitor chose on any page (saved below) wins over that, so picking English on
   the home page carries to /finder, /search and the rest. Pages whose markup
   text is not in the saved language get it applied once the DOM is ready. */
const LANG_KEY = 'proplync_lang';
let declaredLang = document.documentElement.lang === 'en' ? 'en' : 'es';
let lang = declaredLang;
try {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved === 'es' || saved === 'en') lang = saved;
} catch (e) { /* storage blocked: keep the page's own language */ }
document.documentElement.lang = lang;

function setLang(l) {
  lang = l;
  document.documentElement.lang = l;
  try { localStorage.setItem(LANG_KEY, l); } catch (e) { /* not fatal */ }
  const es = document.getElementById('es'), en = document.getElementById('en');
  if (es) es.classList.toggle('on', l === 'es');
  if (en) en.classList.toggle('on', l === 'en');
  document.querySelectorAll('[data-es]').forEach(function (el) {
    el.innerHTML = el.getAttribute('data-' + l);
  });
  // fire custom event so page-specific code can react
  document.dispatchEvent(new CustomEvent('langchange', { detail: { lang: l } }));
}

if (lang !== declaredLang) {
  document.addEventListener('DOMContentLoaded', function () { setLang(lang); });
}

/* helpers shared across pages */
const bd = p => p.bedrooms + ' ' + (lang === 'es' ? 'rec' : 'bd');
const ba = p => p.bathrooms + ' ' + (lang === 'es' ? 'baños' : 'bath');
const per = p => p.operation === 'rental' ? (lang === 'es' ? '/mes' : '/mo') : '';
const priceStr = p => p.currency + ' $' + p.formatted + (per(p) ? ' ' + per(p) : '');
const opLabel = p => p.operation === 'sale' ? (lang === 'es' ? 'Venta' : 'For sale') : (lang === 'es' ? 'Renta' : 'For rent');
