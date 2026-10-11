// Proplync.mx · embed: text → 384-dim vectors for semantic search
// -----------------------------------------------------------------------------
// Runs Supabase's built-in gte-small model inside the edge runtime: no external
// API, no per-token bill, and listing text never leaves our stack. The crawler
// embeds properties with it (api/_lib/search/index-writer.js embedPending) and
// the search API embeds the buyer's words, so both sides land in one space.
//
// Only our own servers may call it. The gateway verifies the project JWT
// (verify_jwt), and this requires that verified token's role to be
// service_role, which only api/ and the crawler hold. The public anon key
// passes the first check and fails this one, so nobody can burn the free
// quota from a browser.
// -----------------------------------------------------------------------------

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const session = new Supabase.ai.Session("gte-small");
const MAX_INPUTS = 32;
const MAX_CHARS = 2000;

function roleOf(authorization: string | null): string | null {
  const token = (authorization ?? "").replace(/^Bearer\s+/i, "");
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // verify_jwt means the gateway has already checked this token's signature;
  // all that is left is who it belongs to. (Comparing against the injected
  // SUPABASE_SERVICE_ROLE_KEY does not work: the runtime injects the newer
  // key format, while our servers hold the legacy service-role JWT.)
  if (roleOf(req.headers.get("authorization")) !== "service_role") return json({ error: "unauthorized" }, 401);

  let body: { inputs?: unknown };
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const inputs = Array.isArray(body.inputs) ? body.inputs.slice(0, MAX_INPUTS) : [];
  if (!inputs.length) return json({ error: "no_inputs" }, 400);

  const embeddings: number[][] = [];
  for (const text of inputs) {
    const out = await session.run(String(text ?? "").slice(0, MAX_CHARS), { mean_pool: true, normalize: true });
    embeddings.push(Array.from(out as Iterable<number>));
  }
  return json({ model: "gte-small", dims: 384, embeddings });
});
