/**
 * In-Market · Bulk personalized videos (record once, render many).
 *
 * POST /api/in-market/bulk
 *   { company, roleTitle, roleUrl?, domain?, clipId | clipIds:[string], pip?, diversify?,
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
  // Accept one clip (clipId) or many (clipIds) — multiple recordings are rotated across recipients
  // for video diversity. Fall back to the single clip for older callers.
  const clipIds: string[] = Array.isArray(b?.clipIds) && b.clipIds.length
    ? b.clipIds.map((x: any) => String(x).trim()).filter(Boolean)
    : (String(b?.clipId ?? "").trim() ? [String(b.clipId).trim()] : []);
  if (!company || !roleTitle) return fail("missing company or roleTitle", 422);
  if (!clipIds.length) return fail("missing clipId", 422);

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
  // LAUNCH GATE: several people at ONE company must each get a DIFFERENT recording. Require the
  // operator to have recorded at least MIN_LAUNCH_CLIPS distinct clips before a multi-recipient run.
  const MIN_LAUNCH_CLIPS = 3;
  if (recipients.length > 1 && clipIds.length < MIN_LAUNCH_CLIPS) {
    return fail(`Record ${MIN_LAUNCH_CLIPS} clips before launching to multiple people at one company (so no two get the same video). You have ${clipIds.length}.`, 422);
  }

  const { resolveVoiceId } = await import("../../../../lib/inmarket/voiceClone");
  const voiceId = await resolveVoiceId(ws, b?.voiceId ? String(b.voiceId) : undefined);

  const reqShot = {
    company, roleTitle,
    roleUrl: b?.roleUrl ? String(b.roleUrl) : undefined,
    domain: b?.domain ? String(b.domain) : undefined,
  };

  const { startBulk, bulkQueueStats } = await import("../../../../lib/inmarket/bulkVideo");
  const results = startBulk(reqShot, clipIds, b?.pip, voiceId, recipients, { diversify: b?.diversify !== false });

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
