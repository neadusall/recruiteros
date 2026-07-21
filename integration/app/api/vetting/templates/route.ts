/**
 * AI Vetting · Reusable next-step messages
 *   GET  /api/vetting/templates            -> this workspace's saved messages (both kinds)
 *   POST /api/vetting/templates            -> { action: "add", kind, name, text }
 *                                             { action: "delete", id }
 *
 * Session-gated, workspace-scoped. Backs the "saved messages" dropdowns on the
 * desk form's If QUALIFIED / If NOT qualified fields, so a recruiter writes a
 * closing script once and reuses it on every desk.
 */

import { requireSession, body, ok, fail } from "../../../../lib/api";
import {
  ensureVettingReady, listMsgTemplates, addMsgTemplate, deleteMsgTemplate,
  type DeskMsgTemplate,
} from "../../../../lib/vetting";

function asKind(v: unknown): DeskMsgTemplate["kind"] | undefined {
  return v === "qualified" ? "qualified" : v === "unqualified" ? "unqualified" : undefined;
}

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  await ensureVettingReady();
  return ok({ templates: listMsgTemplates(g.ctx.workspace.id) });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  await ensureVettingReady();
  const ws = g.ctx.workspace.id;
  const b = await body<{ action?: string; kind?: string; name?: string; text?: string; id?: string }>(req);

  if (b?.action === "add") {
    const kind = asKind(b.kind);
    const name = (b.name ?? "").trim();
    const text = (b.text ?? "").trim();
    if (!kind || !name || !text) return fail("missing_fields", 422);
    if (text.length > 2000) return fail("too_long", 422, { detail: "Keep a saved message under 2,000 characters." });
    return ok({ template: addMsgTemplate(ws, { kind, name, text }) });
  }

  if (b?.action === "delete") {
    if (!b.id) return fail("missing_id", 422);
    return ok({ ok: deleteMsgTemplate(ws, b.id) });
  }

  return fail("unknown_action", 422);
}
