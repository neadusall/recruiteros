/**
 * In-Market · AI email opener for a personalized role video.
 *
 * POST /api/in-market/opener
 *   { company, roleTitle, signalReason?, motion?, videoKey?, watchUrl?, gifUrl?, firstName? }
 *     -> draft a short opener (Claude, falls back to a built-in template) that wraps the video.
 *        Returns { subject, body, source } where body carries {{videoembed}}/{{firstName}}/...
 *        merge fields for a sequence. When videoKey+watchUrl+gifUrl are supplied, also returns a
 *        ready-to-paste `bodyHtml` with the video embedded + merge fields filled (for one-off
 *        sends), using `firstName` (or "there") as the greeting.
 *
 * Operator-only (requireSession). Uses ANTHROPIC_API_KEY when set.
 */

import { requireSession, body as readBody, ok, fail } from "../../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function esc(s: string): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;

  const b = await readBody<any>(req);
  const company = String(b?.company ?? "").trim();
  const roleTitle = String(b?.roleTitle ?? "").trim();
  if (!company || !roleTitle) return fail("missing company or roleTitle", 422);

  const motion = b?.motion === "recruiting" ? "recruiting" : "bd";
  const input = { company, roleTitle, signalReason: b?.signalReason ? String(b.signalReason) : undefined, motion } as const;

  const { draftVideoOpener, templateOpener } = await import("../../../../lib/inmarket/videoOpener");
  const draft = (await draftVideoOpener(input)) || templateOpener(input);

  // Optional: a fully-filled HTML version for immediate copy-paste (one-off sends).
  let bodyHtml: string | undefined;
  const videoKey = b?.videoKey ? String(b.videoKey) : "";
  const watchUrl = b?.watchUrl ? String(b.watchUrl) : "";
  const gifUrl = b?.gifUrl ? String(b.gifUrl) : "";
  if (videoKey && watchUrl && gifUrl) {
    const first = b?.firstName ? String(b.firstName) : "there";
    const embed =
      `<a href="${watchUrl}"><img src="${gifUrl}" alt="A quick note about ${esc(company)}" width="600" ` +
      `style="max-width:100%;border-radius:10px;border:1px solid #e5e7eb;display:block" /></a>`;
    const vals: Record<string, string> = {
      firstname: first, company, role: roleTitle, watchlink: watchUrl, videoembed: embed, videogif: gifUrl,
    };
    bodyHtml = draft.body
      .replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_m, k) => vals[String(k).toLowerCase()] ?? "")
      .replace(/\n/g, "<br>");
  }

  return ok({ subject: draft.subject, body: draft.body, bodyHtml, source: draft.source });
}
