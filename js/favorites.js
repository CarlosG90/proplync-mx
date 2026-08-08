/* Proplync.mx · Buyer Favorites (localStorage)
   ─────────────────────────────────────────────── */

const FAVS_KEY = 'proplync:favs';

function getFavorites() {
  try {
    return JSON.parse(localStorage.getItem(FAVS_KEY)) || [];
  } catch { return []; }
}

function isFavorite(id) {
  return getFavorites().includes(id);
}

function toggleFavorite(id) {
  const favs = getFavorites();
  const idx = favs.indexOf(id);
  if (idx >= 0) favs.splice(idx, 1);
  else favs.push(id);
  localStorage.setItem(FAVS_KEY, JSON.stringify(favs));
  updateFavBadge();
  return idx < 0; // true if added
}

function updateFavBadge() {
  const badge = document.getElementById('fav-badge');
  if (!badge) return;
  const count = getFavorites().length;
  badge.textContent = count;
  badge.style.display = count > 0 ? 'flex' : 'none';
}

/* heart SVG for property cards */
function heartSVG() {
  return '<svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
}

/* inject heart button into property cards */
function injectFavButtons() {
  document.querySelectorAll('.pcard').forEach(card => {
    const id = card.getAttribute('data-id');
    if (!id || card.querySelector('.pcard-fav')) return;
    const btn = document.createElement('button');
    btn.className = 'pcard-fav' + (isFavorite(id) ? ' saved' : '');
    btn.innerHTML = heartSVG();
    btn.title = lang === 'es' ? 'Guardar' : 'Save';
    btn.onclick = function (e) {
      e.stopPropagation();
      const added = toggleFavorite(id);
      this.classList.toggle('saved', added);
    };
    card.querySelector('.pcard-photo').appendChild(btn);
  });
}

/* init on page load */
document.addEventListener('DOMContentLoaded', updateFavBadge);
