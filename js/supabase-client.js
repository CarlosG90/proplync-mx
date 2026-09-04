/* Proplync.mx · Supabase session helper
   ─────────────────────────────────────────────────────────────────
   Loaded via CDN script tag (window.supabase global) before this file,
   same pattern as Leaflet on search.html/property.html. The Supabase
   client persists its own session in localStorage — no cookies, no
   custom token plumbing, same "just use the browser API" spirit as
   js/favorites.js.

   SUPABASE_URL/ANON_KEY are public by design — protected by Postgres
   RLS, not by secrecy. Safe to ship in client-side code. */

const SUPABASE_URL = 'https://cyfoblrbsgsusmenjwps.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5Zm9ibHJic2dzdXNtZW5qd3BzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzOTEzNDAsImV4cCI6MjEwMTk2NzM0MH0.0XO2_SXWYJgVoPyI9JNJ_7Wfg33J7vcQQOOBcwe_G5I';

let sb;
function initSupabase() {
  if (!sb) sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return sb;
}

async function getSession() {
  const { data: { session } } = await initSupabase().auth.getSession();
  return session;
}

async function requireAuth() {
  const session = await getSession();
  if (!session) {
    window.location.href = '/login';
    return null;
  }
  return session;
}

async function authedFetch(url, opts = {}) {
  const session = await getSession();
  const headers = Object.assign({}, opts.headers, session ? { Authorization: 'Bearer ' + session.access_token } : {});
  return fetch(url, Object.assign({}, opts, { headers }));
}

async function signOut() {
  await initSupabase().auth.signOut();
  window.location.href = '/login';
}
