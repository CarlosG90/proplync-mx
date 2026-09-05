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
 * -----------------------------------------------------------------------------
 */


import { safeDetail } from './_lib/health.js';
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const token = process.env.IG_ACCESS_TOKEN;
  const igUserId = process.env.IG_BUSINESS_ACCOUNT_ID;
  if (!token || !igUserId) {
    res.status(500).json({ error: 'missing_instagram_credentials' });
    return;
  }

  const { imageUrl, caption } = req.body || {};
  if (!imageUrl || !caption) {
    res.status(400).json({ error: 'missing_image_or_caption' });
    return;
  }

  try {
    const creationId = await createContainer(igUserId, token, imageUrl, caption);
    const publishedId = await publishContainer(igUserId, token, creationId);
    res.status(200).json({ published: true, id: publishedId });
  } catch (err) {
    res.status(502).json({ error: 'instagram_publish_failed', detail: safeDetail(err) });
  }
}
