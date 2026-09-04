/**
 * Proplync.mx · Agency onboarding
 * -----------------------------------------------------------------------------
 * POST { agencyName, email, password } — public, no auth header (the account
 * doesn't exist yet). Creates the Supabase auth user via the admin API with
 * email_confirm:true (sidesteps needing to disable "Confirm email" in the
 * Supabase dashboard), then creates the agency + owner membership.
 *
 * The client calls this first, then signs in itself with
 * supabase.auth.signInWithPassword() to get a session — this endpoint never
 * hands back a session directly (the admin API doesn't produce one).
 *
 * If agency/membership creation fails after the auth user was created, the
 * auth user is deleted so signup can be retried cleanly (no orphaned account
 * stuck with no agency).
 * -----------------------------------------------------------------------------
 */

import { getServiceClient } from './_lib/supabase.js';

const DIACRITICS_RE = new RegExp('[̀-ͯ]', 'g');

function slugify(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFD').replace(DIACRITICS_RE, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'agencia';
}

async function uniqueSlug(svc, base) {
  let slug = base;
  let n = 2;
  while (true) {
    const { data } = await svc.from('agencies').select('id').eq('slug', slug).maybeSingle();
    if (!data) return slug;
    slug = `${base}-${n++}`;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const { agencyName, email, password } = req.body || {};
  if (!agencyName || !String(agencyName).trim()) {
    res.status(400).json({ error: 'missing_agency_name' });
    return;
  }
  if (!email || !password || String(password).length < 6) {
    res.status(400).json({ error: 'invalid_credentials' });
    return;
  }

  const svc = getServiceClient();

  const { data: created, error: createErr } = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { agency_name: agencyName }
  });
  if (createErr) {
    const code = /already.*registered|already exists/i.test(createErr.message) ? 'email_already_registered' : 'signup_failed';
    res.status(409).json({ error: code, detail: createErr.message });
    return;
  }

  const userId = created.user.id;

  try {
    const base = slugify(agencyName);
    const slug = await uniqueSlug(svc, base);

    const { data: agency, error: agencyErr } = await svc
      .from('agencies')
      .insert({ name: agencyName, slug })
      .select('id, slug')
      .single();
    if (agencyErr) throw agencyErr;

    const { error: memberErr } = await svc
      .from('agency_members')
      .insert({ user_id: userId, agency_id: agency.id, role: 'owner' });
    if (memberErr) throw memberErr;

    // Stash agency_id in user_metadata so the client can read it straight off
    // the session (e.g. for the Storage upload path prefix) without an extra
    // API round-trip. Best-effort: the dashboard falls back to /api/my-listings
    // if this is ever missing, so a failure here doesn't need to roll back signup.
    await svc.auth.admin.updateUserById(userId, {
      user_metadata: { agency_name: agencyName, agency_id: agency.id }
    }).catch(() => {});

    res.status(200).json({ agencyId: agency.id, slug: agency.slug });
  } catch (err) {
    await svc.auth.admin.deleteUser(userId).catch(() => {});
    res.status(500).json({ error: 'onboard_failed', detail: String(err.message) });
  }
}
