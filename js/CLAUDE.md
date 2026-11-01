# js/: rules for browser code

Loaded when you work in this folder (and a good guide for the inline scripts in the `*.html` pages).

- Vanilla JS, no build step. Match the file: most use `function` and `var`.
- **Public pages stay SDK-free**; only dashboard pages load supabase-js. The client secures nothing.
- **Escape everything from data or an LLM:** `escapeHtml()`, `safeUrl()`, `cssUrl()` from `escape.js`; prefer `textContent`.
- **Bilingual:** `data-es`/`data-en` attributes or `isEs ? … : …`. Captions that replace translated copy must drop their `data-*` attributes, or the language switch overwrites them.
- **Voice (`concierge.js`):** the hand-off to `/brief` goes through `saveHandoff`; `/brief` restores it in `restoreHandoff`/`restorePending`. A finished interview opens the review view, not the interview again.
- **Mobile first:** check 390 px. The typing field must keep its own row; long assistant bubbles scroll to their first line.
- `brief.html` stage headings: change them with `setHead(stage)` (idempotent), not by hand.
- Test a UI change with gstack `/browse` at phone width, not by reading code.
