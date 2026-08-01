/**
 * MercadoLibre OAuth callback  ·  Proplync.mx
 * -----------------------------------------------------------------------------
 * One-time setup endpoint. After registering an app at
 * developers.mercadolibre.com.mx and sending the owner to MercadoLibre's
 * authorize URL, MercadoLibre redirects here with ?code=... . This exchanges
 * that code for an access_token + refresh_token and stores them in Upstash
 * Redis (provisioned via the Vercel Marketplace) so api/listings.js can keep
 * itself authenticated without anyone visiting this page again — until the
 * refresh_token itself expires after 6 months of disuse.
 *
 * Redirect URI registered with MercadoLibre MUST exactly match this
 * function's deployed URL, e.g. https://proplync-mx.vercel.app/api/ml-callback
 *
 * Requires env vars: ML_CLIENT_ID, ML_CLIENT_SECRET,
 * KV_REST_API_URL, KV_REST_API_TOKEN (from the Upstash integration).
 * -----------------------------------------------------------------------------
 */

async function kvSet(key, value) {
  const url = `${process.env.KV_REST_API_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` } });
  if (!r.ok) throw new Error(`KV set failed for ${key}: HTTP ${r.status}`);
}

export default async function handler(req, res) {
  const code = req.query.code;
  if (!code) {
    res.status(400).send('Missing ?code= — start from the MercadoLibre authorize URL, not this page directly.');
    return;
  }

  const redirectUri = `https://${req.headers.host}/api/ml-callback`;

  try {
    const tokenRes = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'accept': 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.ML_CLIENT_ID,
        client_secret: process.env.ML_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri
      })
    });
    const data = await tokenRes.json();
    if (!tokenRes.ok || !data.access_token) {
      res.status(502).send(`<pre>MercadoLibre token exchange failed:\n${JSON.stringify(data, null, 2)}</pre>`);
      return;
    }

    await kvSet('ml:access_token', data.access_token);
    await kvSet('ml:access_token_expires_at', String(Date.now() + (data.expires_in - 300) * 1000));
    if (data.refresh_token) await kvSet('ml:refresh_token', data.refresh_token);

    res.status(200).send('<h1>Connected</h1><p>MercadoLibre is linked. You can close this tab — /api/listings will use this automatically from now on.</p>');
  } catch (err) {
    res.status(502).send(`<pre>MercadoLibre callback error:\n${String(err.message)}</pre>`);
  }
}
