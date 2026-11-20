/**
 * PropLync Mini · paste import
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * The agent pastes their WhatsApp inventory on the landing page or in the panel,
 * and gets back up to 10 structured properties to review. Anonymous on purpose:
 * the preview comes before any account.
 *
 * WHY NOT A COPY OF THE LOGIC
 * The extraction (Groq first for text, Claude Haiku as the fallback), its prompt,
 * the per-IP limit (6 an hour) and the field parsing are api/extract.js
 * handleBatch, tested in test/extract-batch.test.mjs.
 * -----------------------------------------------------------------------------
 */

import { handleBatch } from './_proplync/extract.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  return handleBatch(req, res);
}
