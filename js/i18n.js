/* Proplync.mx · Internationalization (ES/EN)
   ─────────────────────────────────────────── */

/* Each page declares its own starting language in <html lang>; anything that
   does not say 'en' starts in Spanish. Pages whose markup text is English call
   setLang() once at the end of the body so the declared language is applied. */
let lang = document.documentElement.lang === 'en' ? 'en' : 'es';

function setLang(l) {
  lang = l;
  document.documentElement.lang = l;
  document.getElementById('es').classList.toggle('on', l === 'es');
  document.getElementById('en').classList.toggle('on', l === 'en');
  document.querySelectorAll('[data-es]').forEach(function (el) {
    el.innerHTML = el.getAttribute('data-' + l);
  });
  // fire custom event so page-specific code can react
  document.dispatchEvent(new CustomEvent('langchange', { detail: { lang: l } }));
}

/* helpers shared across pages */
const bd = p => p.bedrooms + ' ' + (lang === 'es' ? 'rec' : 'bd');
const ba = p => p.bathrooms + ' ' + (lang === 'es' ? 'baños' : 'bath');
const per = p => p.operation === 'rental' ? (lang === 'es' ? '/mes' : '/mo') : '';
const priceStr = p => p.currency + ' $' + p.formatted + (per(p) ? ' ' + per(p) : '');
const opLabel = p => p.operation === 'sale' ? (lang === 'es' ? 'Venta' : 'For sale') : (lang === 'es' ? 'Renta' : 'For rent');
