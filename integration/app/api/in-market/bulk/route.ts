/**
 * In-Market · Bulk personalized videos (record once, render many).
 *
 * POST /api/in-market/bulk
 *   { company, roleTitle, roleUrl?, domain?, clipId, pip?,
 *     recipients:[{firstName, email?}]  |  names:[string],
 *     voiceId? }
 *   -> kicks off one personalized render per recipient (cloned-voice + lip-synced "Hey {name},")
 *      and returns each one's status. NON-BLOCKING: poll by re-POSTing the same list until every
 *      recipient is "ready"; cache hits return "ready" instantly and never re-bill. Ready rows carry
 *      signed share links (watch/gif/mp4) to send.
 *
 * Capped at 1,000 recipients per request — send larger lists in chunks (the client paginates).
 */

import { requireSession, body, ok, fail } from "../../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PER_REQUEST = 1000;

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;

  const b = await body<any>(req);
  const company = String(b?.company ?? "").trim();
  const roleTitle = String(b?.roleTitle ?? "").trim();
  const clipId = String(b?.clipId ?? "").trim();
  if (!company || !roleTitle) return fail("missing company or roleTitle", 422);
  if (!clipId) return fail("missing clipId", 422);

  // Accept either structured recipients or a bare list of first names.
  let recipients: Array<{ firstName: string; email?: string }> = [];
  if (Array.isArray(b?.recipients)) {
    recipients = b.recipients
      .map((r: any) => ({ firstName: String(r?.firstName ?? "").trim(), email: r?.email ? String(r.email).trim() : undefined }))
      .filter((r: any) => r.firstName);
  } else if (Array.isArray(b?.names)) {
    recipients = b.names.map((n: any) => ({ firstName: String(n ?? "").trim() })).filter((r: any) => r.firstName);
  }
  if (!recipients.length) return fail("no recipients (send recipients:[{firstName}] or names:[])", 422);
  if (recipients.length > MAX_PER_REQUEST) return fail(`too many recipients (max ${MAX_PER_REQUEST} per request)`, 422);

  const { resolveVoiceId } = await import("../../../../lib/inmarket/voiceClone");
  const voiceId = await resolveVoiceId(ws, b?.voiceId ? String(b.voiceId) : undefined);

  const reqShot = {
    company, roleTitle,
    roleUrl: b?.roleUrl ? String(b.roleUrl) : undefined,
    domain: b?.domain ? String(b.domain) : undefined,
  };

  const { startBulk, bulkQueueStats } = await import("../../../../lib/inmarket/bulkVideo");
  const results = startBulk(reqShot, clipId, b?.pip, voiceId, recipients);

  // Attach signed share links to the ones that are ready to send.
  const { compositeShareUrls } = await import("../../../../lib/inmarket/shareSign");
  const enriched = results.map((r) => {
    if (r.status !== "ready") return r;
    const share = compositeShareUrls(r.key, { company, roleTitle });
    // Personalize the watch page greeting by name (the page reads &n= and greets "Hi {name}").
    const watch = r.spokenName ? `${share.watch}&n=${encodeURIComponent(r.spokenName)}` : share.watch;
    return { ...r, share: { ...share, watch } };
  });

  const summary = enriched.reduce(
    (s, r) => { s[r.status] = (s[r.status] ?? 0) + 1; return s; },
    {} as Record<string, number>,
  );

  return ok({ total: enriched.length, summary, queue: bulkQueueStats(), results: enriched });
}
