/**
 * Proplync.mx · Agency provisioning
 * -----------------------------------------------------------------------------
 * The one place an agency gets created. Two callers need identical behaviour:
 * api/onboard.js (invite-code self-signup) and scripts/onboard-agency.mjs (the
 * operator creating an account from a laptop). When this logic lived only in
 * the endpoint, the script would have had to reimplement slug uniqueness,
 * membership roles and metadata — and any drift between them shows up later as
 * an agency that behaves subtly differently from every other one.
 *
 * Everything here takes a service-role client. None of it is reachable from a
 * browser: callers are responsible for deciding who is allowed to provision.
 * -----------------------------------------------------------------------------
 */

const DIACRITICS_RE = /[̀-ͯ]/g;

export function slugify(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFD').replace(DIACRITICS_RE, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'agencia';
}

/** First free slug of the form base, base-2, base-3, ... */
export async function uniqueSlug(svc, base) {
  let slug = base;
  let n = 2;
  while (true) {
    const { data } = await svc.from('agencies').select('id').eq('slug', slug).maybeSingle();
    if (!data) return slug;
    slug = `${base}-${n++}`;
  }
}

/**
 * Create the agency row and make `userId` its owner.
 *
 * Throws on failure and leaves no agency behind: the caller owns the auth user
 * and is the only one who can decide whether deleting it is safe (self-signup
 * created it and should roll it back; an operator linking a pre-existing
 * account must not).
 */
export async function provisionAgency(svc, { userId, agencyName }) {
  const slug = await uniqueSlug(svc, slugify(agencyName));

  const { data: agency, error: agencyErr } = await svc
    .from('agencies')
    .insert({ name: agencyName, slug })
    .select('id, slug')
    .single();
  if (agencyErr) throw agencyErr;

  const { error: memberErr } = await svc
    .from('agency_members')
    .insert({ user_id: userId, agency_id: agency.id, role: 'owner' });
  if (memberErr) {
    // Undo the agency so a retry does not leave orphans accumulating slugs.
    await svc.from('agencies').delete().eq('id', agency.id);
    throw memberErr;
  }

  // Stash agency_id in user_metadata so the client can read it straight off the
  // session (e.g. for the Storage upload path prefix) without an extra API
  // round-trip. Best-effort: the dashboard falls back to /api/my-listings.
  await svc.auth.admin.updateUserById(userId, {
    user_metadata: { agency_name: agencyName, agency_id: agency.id }
  }).catch(() => {});

  return agency;
}
