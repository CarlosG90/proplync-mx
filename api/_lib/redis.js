/**
 * Proplync.mx · Upstash Redis REST helpers
 * -----------------------------------------------------------------------------
 * Shared by any endpoint that wants to cache an external API call. Silently
 * no-ops (cache miss / no-op write) if KV_REST_API_URL / KV_REST_API_TOKEN
 * aren't set, so callers never need to branch on whether Redis is configured.
 * -----------------------------------------------------------------------------
 */

import { logDegraded } from './health.js';

export async function redisGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/get/${key}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await r.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch (err) {
    // A cache miss is normal; an unreachable cache is not — it silently turns
    // every request into an origin/EasyBroker call.
    logDegraded('redis:get', err);
    return null;
  }
}

export async function redisSet(key, value, exSeconds) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(`${url}/set/${key}/${encodeURIComponent(JSON.stringify(value))}/ex/${exSeconds}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch (err) {
    logDegraded('redis:set', err);
  }
}
