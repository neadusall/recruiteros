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

  const { templateOpener } = await import("../../../../lib/inmarket/videoOpener");
  const draft = templateOpener(input); // Day-0 MPC (bd/mpc/templates) + Day-1 real-person video

  // Preview fill: resolve MPC tokens (native-lexicon floor for a keyless preview) + expand spintax so
  // the operator sees a real rendered email, not raw tokens. The live send fills per prospect in
  // renderTouch; this mirrors that for the Studio preview.
  const { buildMpcTokens, fixArticles } = await import("../../../../lib/bd/mpc/resolve");
  const { expandSpintax } = await import("../../../../lib/copy/spintax");
  const first = b?.firstName ? String(b.firstName) : "there";
  const tok = buildMpcTokens({
    firstName: first, company, openRole: roleTitle,
    jobLocation: b?.jobLocation ? String(b.jobLocation) : undefined,
    yourName: b?.yourName ? String(b.yourName) : undefined,
  });
  const baseVals: Record<string, string> = { firstname: first, company, role: roleTitle };
  for (const [k, v] of Object.entries(tok)) if (typeof v === "string") baseVals[k.toLowerCase()] = v;
  const fillText = (s: string, seed: string, extra: Record<string, string> = {}) =>
    fixArticles(expandSpintax(s, seed).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, k) => ({ ...baseVals, ...extra }[String(k).toLowerCase()] ?? "")));
  const email1 = { subject: fillText(draft.first.subject, "preview1"), body: draft.first.body, bodyFilled: fillText(draft.first.body, "preview1") };

  // Email 2 (video follow-up): a fully-filled HTML version for immediate copy-paste (one-off sends).
  let bodyHtml: string | undefined;
  const videoKey = b?.videoKey ? String(b.videoKey) : "";
  const watchUrl = b?.watchUrl ? String(b.watchUrl) : "";
  const gifUrl = b?.gifUrl ? String(b.gifUrl) : "";
  if (videoKey && watchUrl && gifUrl) {
    const embed =
      `<a href="${watchUrl}"><img src="${gifUrl}" alt="A quick note about ${esc(company)}" width="600" ` +
      `style="max-width:100%;border-radius:10px;border:1px solid #e5e7eb;display:block" /></a>`;
    bodyHtml = fillText(draft.second.body, "preview2", { watchlink: watchUrl, videoembed: embed, videogif: gifUrl })
      .replace(/\n/g, "<br>");
  }

  // Back-compat: top-level subject/body/bodyHtml are the VIDEO (second) email — what the Studio
  // already renders + embeds. `firstEmail` is the new text-only first touch in the sequence.
  return ok({
    source: draft.source,
    firstEmail: email1,
    subject: draft.second.subject,
    body: draft.second.body,
    bodyHtml,
  });
}
