/**
 * Public unsubscribe endpoint (no session — reached from a recipient's mail client).
 *
 *   GET  /api/unsubscribe?w=<workspaceId>&e=<base64url email>&s=<hmac>
 *        → human clicked the link: suppress + tiny confirmation page.
 *   POST /api/unsubscribe?w=…&e=…&s=…
 *        → RFC 8058 one-click (Gmail/Yahoo post here automatically): suppress, 200.
 *
 * The signature (lib/sending/unsubscribe) must verify — an unsigned request can't
 * suppress anyone. Suppression is the same treatment as a STOP reply: durable DNC
 * entry (mirrored to every platform) + every matching prospect flipped to
 * do_not_contact so no sequence retries them.
 */

import { verifyUnsubSignature } from "../../../lib/sending/unsubscribe";
import { suppress } from "../../../lib/response/suppression";
import { getCore } from "../../../lib/core/repository";

interface Parsed { ws: string; email: string }

function parse(req: Request): Parsed | null {
  const url = new URL(req.url);
  const ws = url.searchParams.get("w") || "";
  const e = url.searchParams.get("e") || "";
  const sig = url.searchParams.get("s") || "";
  if (!ws || !e || !sig) return null;
  let email = "";
  try { email = Buffer.from(e, "base64url").toString("utf8"); } catch { return null; }
  if (!email.includes("@") || !verifyUnsubSignature(ws, email, sig)) return null;
  return { ws, email };
}

async function unsubscribe(p: Parsed): Promise<void> {
  await suppress(p.ws, [p.email], "unsubscribe_link", new Date().toISOString());
  // Flip every matching prospect so the cadence stops considering them at all.
  try {
    const core = getCore();
    const all = await core.listProspects(p.ws);
    const em = p.email.trim().toLowerCase();
    for (const pr of all) {
      if ((pr.email || "").trim().toLowerCase() === em && pr.status !== "do_not_contact") {
        pr.status = "do_not_contact";
        await core.saveProspect(pr);
      }
    }
  } catch { /* the DNC entry is the source of truth; prospect flip is best-effort */ }
}

const PAGE = (msg: string) =>
  `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<body style="font-family:Helvetica,Arial,sans-serif;background:#f7f8f5;margin:0;display:grid;place-items:center;min-height:100vh">` +
  `<div style="background:#fff;border:1px solid #e2e6e0;border-radius:10px;padding:32px 36px;max-width:420px;text-align:center">` +
  `<div style="font-size:34px">✓</div><h1 style="font-size:19px;margin:10px 0 6px">${msg}</h1>` +
  `<p style="color:#6c7570;font-size:14px;margin:0">You won't receive further emails from us.</p></div></body>`;

export async function GET(req: Request) {
  const p = parse(req);
  if (!p) return new Response("Invalid or expired unsubscribe link.", { status: 400 });
  await unsubscribe(p);
  return new Response(PAGE("You're unsubscribed"), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

// RFC 8058: mail clients POST here for one-click. Body is ignored; the signed URL is the grant.
export async function POST(req: Request) {
  const p = parse(req);
  if (!p) return new Response("invalid", { status: 400 });
  await unsubscribe(p);
  return new Response("ok", { status: 200 });
}
