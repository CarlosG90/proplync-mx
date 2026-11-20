/* ─────────────────────────────────────────────────────────────────────────────
   Proplync.mx · Escaping for pages that build markup from strings

   WHY THIS EXISTS
   Most pages render cards with string concatenation into innerHTML. The values
   going in are not ours: listing titles, towns and photo URLs are typed by
   agencies, place names come from OpenStreetMap (which anyone can edit), and
   copy comes back from a language model that read the agency's text. Any of
   them can carry markup, and on a buyer-facing page that markup would run for
   every visitor. Every value that did not come from this codebase goes through
   one of these before it touches HTML.

   WHICH ONE
   escapeHtml(v)  text between tags, and any quoted attribute value
   safeUrl(v)     a src/href: allowed schemes only, then escaped; '' otherwise
   cssUrl(v)      the inside of url('…') in a style; allowed schemes only, with
                  quotes, parens, backslashes and whitespace percent-encoded so
                  it cannot close the url() or the attribute around it

   Plain classic script on purpose: pages load it before their inline scripts.
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* http(s), site-relative (but not protocol-relative), blob: from our own
     uploads, and inline raster images. No javascript:, no data:text/html. */
  var ALLOWED_URL = /^(https?:\/\/|\/(?!\/)|blob:|data:image\/(png|jpe?g|webp|gif|avif);base64,)/i;

  function cleanUrl(value) {
    var s = String(value == null ? '' : value).trim();
    return ALLOWED_URL.test(s) ? s : '';
  }

  function safeUrl(value) {
    return escapeHtml(cleanUrl(value));
  }

  function cssUrl(value) {
    return cleanUrl(value).replace(/["'()\\\s<>]/g, function (c) {
      return '%' + ('0' + c.charCodeAt(0).toString(16).toUpperCase()).slice(-2);
    });
  }

  window.escapeHtml = escapeHtml;
  window.safeUrl = safeUrl;
  window.cssUrl = cssUrl;
})();
