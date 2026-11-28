/**
 * PropLync Mini · WhatsApp webhook (Meta WhatsApp Cloud API)
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * A Mini customer's clients write to the business's WhatsApp number. Meta posts
 * each message here; the owner's assistant (api/_bot.js) answers from what the
 * owner taught it, and hands the chat to the owner when it should.
 *
 *   GET   Meta's subscription check: hub.verify_token must equal WHATSAPP_VERIFY_TOKEN.
 *   POST  incoming messages. Signed by Meta (X-Hub-Signature-256, HMAC of the raw
 *         body with WHATSAPP_APP_SECRET); anything unsigned is refused. Answered 200
 *         at once (Meta retries slow webhooks); the reply is written in waitUntil.
 *
 * WHY IT STAYS FREE (owner's decision 2026-11-28)
 *   - it only replies to a client who wrote first, inside Meta's 24-hour window:
 *     service messages, free up to 1,000 a month per number. It never starts a
 *     conversation (templates are paid).
 *   - mini_bot.monthly_cap (default 950) stops it before the free tier ends.
 *   - Groq's free tier writes the reply; when Groq is busy it sends nothing.
 *
 * WHEN IT STAYS QUIET (the owner answers by hand in the WhatsApp app)
 *   bot switched off or page not paid · monthly cap reached · the chat was handed
 *   to the owner in the last 12 hours · a message that isn't text · Groq busy.
 *
 * EVERY INQUIRY REACHES THE OWNER'S CRM (mini/api/_cases.js leadFromWhatsApp): a
 * new client number becomes a lead in "Clientes", with the service the assistant
 * understood they want, even when the bot stays quiet.
 *
 * Retries are harmless: each incoming message id is stored once (unique
 * mini_bot_messages.wa_message_id); a repeat is ignored.
 * -----------------------------------------------------------------------------
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { getServiceClient } from './_proplync/_lib/supabase.js';
import { pageActive } from './_proplync/_lib/plans.js';
import { logDegraded } from './_proplync/_lib/health.js';
import { loadBotContext, botReply } from './_bot.js';
import { leadFromWhatsApp } from './_cases.js';

const GRAPH = 'https://graph.facebook.com/' + (process.env.WHATSAPP_GRAPH_VERSION || 'v23.0');
export const HANDOFF_PAUSE_MS = 12 * 3600 * 1000;
const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

/** Meta's signature over the raw body. Pure, for tests. */
export function validSignature(raw, header, secret) {
  if (!secret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const want = Buffer.from('sha256=' + createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Meta's webhook body → the messages to handle: [{ phoneNumberId, from, id, type, text, ts }]. Pure, for tests. */
export function incomingMessages(body) {
  const out = [];
  for (const entry of (body && body.entry) || []) {
    for (const change of entry.changes || []) {
      const v = change && change.value;
      if (!v || change.field !== 'messages' || !v.metadata) continue;
      for (const m of v.messages || []) {
        out.push({
          phoneNumberId: String(v.metadata.phone_number_id || ''),
          from: String(m.from || '').replace(/[^0-9]/g, '').slice(0, 20),
          id: String(m.id || ''),
          type: m.type,
          text: m.type === 'text' && m.text ? String(m.text.body || '').slice(0, 4000) : '',
          ts: Number(m.timestamp) * 1000 || Date.now()
        });
      }
    }
  }
  return out.filter((m) => m.phoneNumberId && m.from && m.id);
}

/** Coexistence: what the owner sent from the WhatsApp Business app (field smb_message_echoes). Pure, for tests. */
export function ownerEchoes(body) {
  const out = [];
  for (const entry of (body && body.entry) || []) {
    for (const change of entry.changes || []) {
      const v = change && change.value;
      if (!v || change.field !== 'smb_message_echoes' || !v.metadata) continue;
      for (const m of v.message_echoes || []) {
        out.push({ phoneNumberId: String(v.metadata.phone_number_id || ''), to: String(m.to || '').replace(/[^0-9]/g, '').slice(0, 20),
          id: String(m.id || ''), text: m.text ? String(m.text.body || '').slice(0, 4000) : `[${m.type || 'mensaje'}]` });
      }
    }
  }
  return out.filter((m) => m.phoneNumberId && m.to && m.id);
}

/** Log the owner's own reply (role 'owner', supabase/025): the assistant then stays quiet in that chat. */
export async function handleEcho(e, deps = {}) {
  const svc = deps.svc || getServiceClient();
  const { data: bot } = await svc.from('mini_bot').select('agency_id').eq('wa_phone_number_id', e.phoneNumberId).maybeSingle();
  if (!bot) return { skipped: 'unknown_number' };
  const { error } = await svc.from('mini_bot_messages').insert({ agency_id: bot.agency_id, contact: e.to, role: 'owner', body: e.text, wa_message_id: e.id });
  if (error && error.code !== '23505') throw error;
  return { logged: true };
}

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

async function sendText(phoneNumberId, to, text, deps) {
  const r = await (deps.fetch || fetch)(`${GRAPH}/${encodeURIComponent(phoneNumberId)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${(deps.env || process.env).WHATSAPP_TOKEN}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: true, body: text } })
  });
  if (!r.ok) throw new Error('whatsapp_send_' + r.status);
}

/** One incoming message: store it, decide whether to answer, answer. Exported for tests. */
export async function handleMessage(m, deps = {}) {
  const svc = deps.svc || getServiceClient();
  const now = (deps.now || Date.now)();
  const { data: bot, error: bErr } = await svc.from('mini_bot').select('agency_id, enabled, monthly_cap')
    .eq('wa_phone_number_id', m.phoneNumberId).maybeSingle();
  if (bErr) throw bErr;
  if (!bot) return { skipped: 'unknown_number' };

  // Store the client's message first: the owner sees it in the panel even if the bot stays quiet.
  const { error: insErr } = await svc.from('mini_bot_messages').insert({
    agency_id: bot.agency_id, contact: m.from, role: 'user', body: m.text || `[${m.type || 'mensaje'}]`, wa_message_id: m.id
  });
  if (insErr) {
    if (insErr.code === '23505') return { skipped: 'duplicate' };   // Meta retried this message
    throw insErr;
  }
  const lead = deps.leadFromWhatsApp || leadFromWhatsApp;
  await lead(svc, { agencyId: bot.agency_id, phone: m.from, now }).catch((err) => logDegraded('mini:whatsapp-lead', err));
  if (!bot.enabled) return { skipped: 'disabled' };
  if (!m.text) return { skipped: 'not_text' };

  const [used, lastHandoff, hist] = await Promise.all([
    svc.from('mini_bot_messages').select('id', { count: 'exact', head: true }).eq('agency_id', bot.agency_id).eq('role', 'bot')
      .gte('created_at', monthStart(new Date(now))),
    // Quiet for 12 h after a handoff, or after the owner answered this chat from their own app (coexistence).
    svc.from('mini_bot_messages').select('id').eq('agency_id', bot.agency_id).eq('contact', m.from)
      .or('and(role.eq.bot,handoff.eq.true),role.eq.owner').gte('created_at', new Date(now - HANDOFF_PAUSE_MS).toISOString()).limit(1),
    svc.from('mini_bot_messages').select('role, body, created_at').eq('agency_id', bot.agency_id).eq('contact', m.from)
      .gte('created_at', new Date(now - 24 * 3600 * 1000).toISOString())
      .order('created_at', { ascending: false }).limit(12)
  ]);
  for (const r of [used, lastHandoff, hist]) if (r.error) throw r.error;
  if ((used.count || 0) >= bot.monthly_cap) return { skipped: 'monthly_cap' };
  if ((lastHandoff.data || []).length) return { skipped: 'handed_off' };

  const ctx = await (deps.loadBotContext || loadBotContext)(svc, bot.agency_id);
  if (!ctx || !pageActive(ctx.agency, now)) return { skipped: 'page_not_active' };
  const history = (hist.data || []).slice().reverse().map((x) => ({ role: x.role, body: x.body }));
  const out = await (deps.botReply || botReply)({ ...ctx, history });
  if (out.busy) return { skipped: 'busy' };

  await sendText(m.phoneNumberId, m.from, out.reply, deps);
  const { error: bIns } = await svc.from('mini_bot_messages').insert({
    agency_id: bot.agency_id, contact: m.from, role: 'bot', body: out.reply.slice(0, 4000), handoff: !!out.handoff
  });
  if (bIns) logDegraded('mini:whatsapp-log', bIns);
  if (out.service) await lead(svc, { agencyId: bot.agency_id, phone: m.from, serviceTitle: out.service, now }).catch((err) => logDegraded('mini:whatsapp-lead', err));
  return { replied: true, handoff: !!out.handoff };
}

export default async function handler(req, res, deps = {}) {
  const env = deps.env || process.env;
  if (req.method === 'GET') {
    const q = req.query || {};
    if (env.WHATSAPP_VERIFY_TOKEN && q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === env.WHATSAPP_VERIFY_TOKEN) {
      res.setHeader('Content-Type', 'text/plain');
      res.status(200).send(String(q['hub.challenge'] || ''));
      return;
    }
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  if (!env.WHATSAPP_APP_SECRET || !env.WHATSAPP_TOKEN) { res.status(503).json({ error: 'whatsapp_not_configured' }); return; }

  const raw = deps.raw || await readRaw(req);
  if (!validSignature(raw, req.headers && req.headers['x-hub-signature-256'], env.WHATSAPP_APP_SECRET)) {
    res.status(401).json({ error: 'bad_signature' });
    return;
  }
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { res.status(400).json({ error: 'invalid_json' }); return; }

  // Answer Meta now; the replies are written after (each message on its own, so one failure doesn't stop the rest).
  res.status(200).json({ ok: true });
  const work = Promise.all([
    ...ownerEchoes(body).map((e) => handleEcho(e, deps).catch((err) => logDegraded('mini:whatsapp-echo', err))),
    ...incomingMessages(body).map((m) => handleMessage(m, deps).catch((err) => logDegraded('mini:whatsapp', err)))
  ]);
  if (deps.await) await work; else waitUntil(work);
}

// Meta signs the exact bytes it sent: read the raw body, don't let a parser touch it.
export const config = { api: { bodyParser: false } };
