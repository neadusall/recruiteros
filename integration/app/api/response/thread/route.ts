/**
 * GET /api/response/thread?id=<responseId>
 * One person's full cross-channel conversation, anchored on an inbox row:
 * every inbound reply (email / LinkedIn / SMS), every outbound message sent from
 * the reply center, and the outbound touch log (campaign sends), merged into a
 * single timeline. Also reports which channels a reply can go out on right now.
 */

import { getInbox, isSuppressed } from "../../../../lib/response";
import { getCore } from "../../../../lib/core/repository";
import { requireSession, ok, fail } from "../../../../lib/api";

interface ThreadEntry {
  at: string;
  dir: "in" | "out";
  channel: string;
  /** "message" carries real text both ways; "event" is a logged touch (summary only). */
  kind: "message" | "event";
  text: string;
  subject?: string;
  cls?: string;
  provider?: string;
  responseId?: string;
}

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!id) return fail("missing_id", 422);

  const inbox = getInbox();
  const anchor = await inbox.getById(ws, id);
  if (!anchor) return fail("not_found", 404);

  const prospectId = anchor.inbound.prospectId || null;
  const prospect = prospectId ? await getCore().getProspect(prospectId) : undefined;
  const handles = [prospect?.email, prospect?.phone, prospect?.linkedinUrl, anchor.inbound.fromHandle];

  const rows = await inbox.forPerson(ws, { prospectId, handles });
  const notes = await inbox.outboundForPerson(ws, { prospectId, responseIds: rows.map((r) => r.inbound.id) });
  const activity = prospectId ? await getCore().listActivity(prospectId) : [];

  const entries: ThreadEntry[] = [];
  for (const r of rows) {
    entries.push({
      at: r.inbound.receivedAt, dir: "in", channel: r.inbound.channel, kind: "message",
      text: r.inbound.text, subject: r.inbound.subject, cls: r.classification.class,
      responseId: r.inbound.id,
    });
  }
  for (const n of notes) {
    entries.push({ at: n.at, dir: "out", channel: n.channel, kind: "message", text: n.text, provider: n.provider });
  }
  // Campaign / system touches. The reply center's own sends also land one generic
  // "<channel>_sent" activity event via the send layer; drop those duplicates when an
  // outbound note with real text exists on the same channel within a few minutes.
  const nearNote = (at: string, channel: string) =>
    notes.some((n) => n.channel === channel && Math.abs(Date.parse(n.at) - Date.parse(at)) < 3 * 60_000);
  for (const a of activity) {
    if (a.type === `${a.channel}_sent` && nearNote(a.at, String(a.channel))) continue;
    entries.push({ at: a.at, dir: "out", channel: String(a.channel), kind: "event", text: a.summary || a.type });
  }
  entries.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));

  // What can a reply go out on right now?
  let suppressed = false;
  for (const h of handles) {
    if (h && (await isSuppressed(ws, h))) { suppressed = true; break; }
  }
  const lastEmailWithBox = rows
    .filter((r) => r.inbound.channel === "email" && r.inbound.toMailbox)
    .sort((a, b) => Date.parse(b.inbound.receivedAt) - Date.parse(a.inbound.receivedAt))[0];
  const channels = {
    email: !!lastEmailWithBox,
    linkedin: !!prospect?.linkedinUrl,
    sms: !!prospect?.phone && prospect?.motion !== "bd",
  };

  // Per-channel touch counts, so the UI can say "3 emails out, 1 LinkedIn in".
  const counts: Record<string, { in: number; out: number }> = {};
  for (const e of entries) {
    const c = (counts[e.channel] ||= { in: 0, out: 0 });
    c[e.dir]++;
  }

  // Whose identity an email reply goes out under (the recruiter owning the
  // sending mailbox), so the composer can say exactly who it sends as.
  let sendsAs: { name: string | null; email: string } | null = null;
  if (lastEmailWithBox) {
    try {
      const { sendAsFor } = await import("../../../../lib/response/sendAs");
      sendsAs = await sendAsFor(ws, lastEmailWithBox);
    } catch { /* the composer label just stays generic */ }
  }

  return ok({
    person: {
      name: anchor.inbound.fromName || prospect?.fullName || "Unknown",
      prospectId,
      email: prospect?.email || (anchor.inbound.channel === "email" ? anchor.inbound.fromHandle : undefined),
      phone: prospect?.phone || (anchor.inbound.channel === "sms" ? anchor.inbound.fromHandle : undefined),
      linkedinUrl: prospect?.linkedinUrl || (anchor.inbound.channel === "linkedin" ? anchor.inbound.fromHandle : undefined),
      company: prospect?.company,
      title: prospect?.title,
      status: prospect?.status,
    },
    suppressed,
    channels,
    counts,
    entries,
    sendsAs,
  });
}
