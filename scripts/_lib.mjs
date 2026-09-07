/**
 * Proplync.mx · Shared plumbing for the operator scripts
 * -----------------------------------------------------------------------------
 * Both onboard-agency.mjs and create-invite.mjs need the same three things:
 * the service-role credentials out of .env.local, a tolerant argv parser, and
 * a way to fail with a readable message. Kept here so the two cannot drift
 * into reading env differently or disagreeing about what --flag means.
 * -----------------------------------------------------------------------------
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadDotEnv() {
  try {
    for (const line of readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      const [, k, raw] = m;
      if (process.env[k]) continue; // a real env var always wins
      process.env[k] = raw.trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env.local is fine when the vars are already exported */ }
}

export function die(msg) { console.error(`\n  ✗ ${msg}\n`); process.exit(1); }

/** `--flag` for anything in booleans, `--key value` for everything else. */
export function parseArgs(argv, booleans = []) {
  const out = { flags: new Set(), _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (booleans.includes(key)) { out.flags.add(key); continue; }
    out[key] = argv[++i];
  }
  return out;
}

/** Service-role client. Exits if the credentials are not present. */
export function serviceClient() {
  loadDotEnv();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    die('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (.env.local or environment).');
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function siteOrigin() {
  return process.env.PUBLIC_SITE_URL || 'https://proplync-mx.vercel.app';
}
