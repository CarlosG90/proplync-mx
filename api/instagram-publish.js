/**
 * Proplync.mx · Instagram publish (Meta Instagram Graph API, official — no relay)
 * -----------------------------------------------------------------------------
 * Publishes a single feed image post directly through Meta's Content
 * Publishing API. Two-step flow: create a media container from a public
 * image URL, then publish the container. See ~/.claude/skills/instagram-publish
 * for the full API shape (carousels, Reels, Stories aren't implemented here —
 * v1 is feed-image-only, matching the "Post" card generate.html already makes).
 *
 * PREREQUISITES (see the skill for the full checklist):
 *   - Instagram account must be Business/Creator, linked to a Facebook Page.
 *   - A Meta Developer App (Development Mode is enough for your own account).
 *   - A long-lived Page Access Token with instagram_content_publish.
 *
 * SET TWO ENV VARS:
 *   IG_ACCESS_TOKEN         — long-lived Page/User access token
 *   IG_BUSINESS_ACCOUNT_ID  — numeric Instagram Business Account ID (not the @handle)
 *
 * WHO MAY CALL IT
 * This posts to a real Instagram account with a token we hold, and parks
 * bytes in a public bucket. It used to do both for anyone, with CORS open to
 * every origin. Now it requires a signed-in agency on a plan with
 * `instagram: true`, is rate limited, only accepts a real PNG/JPEG under
 * MAX_RENDER_BYTES, and an imageUrl must already live in our own storage.
 * -----------------------------------------------------------------------------
 */


import sharp from 'sharp';
import { safeDetail, logDegraded } from './_lib/health.js';
import { getServiceClient } from './_lib/supabase.js';
import { requireAgencyUser } from './_lib/auth.js';
import { enforceRateLimit } from './_lib/ratelimit.js';
import { planFor } from './_lib/plans.js';

/* A 1080x1080 PNG render is ~1-2 MB. Vercel rejects bodies over 4.5 MB before
   we see them; this cap is for the decoded bytes, with headroom under that. */
const MAX_RENDER_BYTES = 3 * 1024 * 1024;
const MAX_CAPTION_CHARS = 2200; // Instagram's own caption limit

class BadInput extends Error {}

/* Upload the browser's canvas render so Meta has something public to fetch.
   Uses the service client because the bucket's insert policy is scoped to an
   agency folder and this render belongs to no listing — it is a throwaway
   whose only job is to exist at a URL for the length of one publish. */
async function hostRender(dataUrl, agencyId) {
  const b64 = String(dataUrl).replace(/^data:[^,]+,/, '');
  const bytes = Buffer.from(b64, 'base64');
  if (!bytes.length) throw new BadInput('empty_render');
  if (bytes.length > MAX_RENDER_BYTES) throw new BadInput('render_too_large');

  /* Read the header rather than trusting the data-URL prefix: the bucket is
     public, so whatever lands here is served from our domain. */
  let format;
  try {
    format = (await sharp(bytes).metadata()).format;
  } catch (e) {
    throw new BadInput('not_an_image');
  }
  if (format !== 'png' && format !== 'jpeg') throw new BadInput('not_an_image');

  const ext = format === 'png' ? 'png' : 'jpg';
  const path = 'ig-renders/' + agencyId + '/' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.' + ext;
  const sb = getServiceClient();
  const { error } = await sb.storage
    .from('listing-photos')
    .upload(path, bytes, { contentType: 'image/' + format, upsert: false });
  if (error) throw error;

  const { data } = sb.storage.from('listing-photos').getPublicUrl(path);
  return data.publicUrl;
}
/* An imageUrl is only accepted if it is already in our public listing-photos
   bucket. Otherwise a signed-in caller could put any image on the internet
   onto the account. */
function isOwnStorageUrl(imageUrl) {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  if (!base) return false;
  try {
    const u = new URL(imageUrl);
    return u.protocol === 'https:' &&
      u.origin === new URL(base).origin &&
      u.pathname.startsWith('/storage/v1/object/public/listing-photos/');
  } catch (e) {
    return false;
  }
}

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

async function createContainer(igUserId, token, imageUrl, caption) {
  const url = `${GRAPH_BASE}/${igUserId}/media`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image_url: imageUrl, caption, access_token: token })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || `Graph API responded ${r.status}`);
  return data.id;
}

async function publishContainer(igUserId, token, creationId) {
  const url = `${GRAPH_BASE}/${igUserId}/media_publish`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ creation_id: creationId, access_token: token })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || `Graph API responded ${r.status}`);
  return data.id;
}

export default async function handler(req, res) {
  /* No CORS headers on purpose: generate.html calls this same-origin, and no
     other site has any business posting to our Instagram account. */
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  // Before auth, so a flood of bad tokens doesn't turn into a flood of Supabase calls.
  if (await enforceRateLimit(req, res, { bucket: 'instagram', limit: 10, windowSec: 3600 })) return;

  const auth = await requireAgencyUser(req);
  if (!auth) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const svc = getServiceClient();
  const { data: agency, error: agencyError } = await svc
    .from('agencies')
    .select('plan')
    .eq('id', auth.agencyId)
    .maybeSingle();
  if (agencyError) {
    logDegraded('supabase:agencies.plan', agencyError);
    res.status(503).json({ error: 'plan_lookup_failed' });
    return;
  }
  if (!planFor(agency).instagram) {
    res.status(402).json({ error: 'upgrade_required', module: 'instagram' });
    return;
  }

  const token = process.env.IG_ACCESS_TOKEN;
  const igUserId = process.env.IG_BUSINESS_ACCOUNT_ID;
  if (!token || !igUserId) {
    res.status(500).json({ error: 'missing_instagram_credentials' });
    return;
  }

  const { imageUrl, imageBase64, caption } = req.body || {};
  if ((!imageUrl && !imageBase64) || !caption || typeof caption !== 'string') {
    res.status(400).json({ error: 'missing_image_or_caption' });
    return;
  }
  if (caption.length > MAX_CAPTION_CHARS) {
    res.status(400).json({ error: 'caption_too_long' });
    return;
  }
  if (!imageBase64 && !isOwnStorageUrl(imageUrl)) {
    res.status(400).json({ error: 'image_url_not_allowed' });
    return;
  }

  try {
    /* Meta fetches the image itself, so it needs a URL it can reach. The
       branded 1080x1080 render only exists as canvas bytes in the browser,
       which is why this used to publish the bare property photo: an agent
       approved a designed post and Instagram got an unbranded snapshot. Park
       the render in the public bucket first, then hand Meta that. */
    const publicUrl = imageBase64 ? await hostRender(imageBase64, auth.agencyId) : imageUrl;

    const creationId = await createContainer(igUserId, token, publicUrl, caption);
    const publishedId = await publishContainer(igUserId, token, creationId);
    res.status(200).json({ published: true, id: publishedId });
  } catch (err) {
    if (err instanceof BadInput) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(502).json({ error: 'instagram_publish_failed', detail: safeDetail(err) });
  }
}
