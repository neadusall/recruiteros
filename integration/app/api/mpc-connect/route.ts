/**
 * POST /api/mpc-connect   (session, outreach:send)
 *
 * Fire a LinkedIn connection request to a prospect who WATCHED their video, from the recruiter who
 * emailed them. Body: { email }. Looks the person up in the watchers snapshot (mpc_watchers_v1),
 * resolves the emailing recruiter's own LinkedIn seat, and files a `connect_note` through LinkedIn OS
 * (all policy, pacing, health, suppression and idempotency apply). Records the outcome to the
 * mpc_connects_v1 snapshot so the resolver + UI show status. Idempotent per person.
 *
 * GET /api/mpc-connect  -> the connects log for this workspace (status per person).
 */

import { requireCapability, ok, fail } from "../../../lib/api";
import { loadSnapshot, saveSnapshot } from "../../../lib/db";
import { listMembers } from "../../../lib/auth/team";
import { seatForUser } from "../../../lib/linkedin/seats";
import { requestLinkedInAction } from "../../../lib/linkedin/os/engine";

interface Watcher {
  email: string; name?: string; title?: string; company?: string; role?: string;
  recruiter?: string; linkedin?: string; event?: string;
}
interface ConnectRec {
  email: string; name?: string; company?: string; recruiter?: string;
  status: "sent" | "queued" | "suppressed" | "no_profile" | "accepted";
  reason?: string; at: string; by?: string;
}

function noteFor(firstName: string, role?: string): string {
  const seat = role ? `your ${role} search` : "the role you're hiring for";
  return `Hi ${firstName}, I'm the one from the short video about ${seat}. Wanted to put a real name to the face. Open to connecting?`.slice(0, 280);
}

export async function GET(req: Request) {
  const g = requireCapability(req, "outreach:send");
  if ("response" in g) return g.response;
  const log = (await loadSnapshot<{ workspaceId?: string; items?: ConnectRec[] }>("mpc_connects_v1")) || {};
  const items = log.workspaceId === g.ctx.workspace.id ? log.items || [] : [];
  return ok({ items });
}

export async function POST(req: Request) {
  const g = requireCapability(req, "outreach:send");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;

  let body: { email?: string } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const email = String(body.email || "").toLowerCase().trim();
  if (!email) return fail("email_required", 400);

  const snap = await loadSnapshot<{ workspaceId?: string; watchers?: Watcher[] }>("mpc_watchers_v1");
  if (!snap || snap.workspaceId !== ws) return fail("no_watchers", 404);
  const w = (snap.watchers || []).find((x) => x.email === email);
  if (!w) return fail("not_a_watcher", 404);
  if (!w.linkedin) return fail("no_linkedin_profile", 422);

  // The recruiter who emailed them fires from THEIR OWN seat (never a shared/wrong account).
  const members = listMembers(ws);
  const member = members.find((m) => (m.name || "").toLowerCase() === String(w.recruiter || "").toLowerCase());
  const seat = member ? await seatForUser(ws, member.userId) : null;
  const accountId = seat?.accountId || "default";

  const res = await requestLinkedInAction({
    workspaceId: ws,
    accountId,
    person: {
      email: w.email, linkedinUrl: w.linkedin, fullName: w.name,
      company: w.company, title: w.title,
    },
    actionType: "connect_note",
    payload: { text: noteFor((w.name || "there").split(/\s+/)[0], w.role) },
    businessUnit: "bd",
    sourceType: "manual",
    approvedBy: g.ctx.user.id,
    idempotencyKey: `mpcwatch|${ws}|${email}`,
  });

  const rec: ConnectRec = {
    email, name: w.name, company: w.company, recruiter: w.recruiter,
    status: res.accepted ? "sent" : (res.record.status === "suppressed" ? "suppressed" : "queued"),
    reason: res.reason, at: new Date().toISOString(), by: member?.name || "",
  };
  const log = (await loadSnapshot<{ workspaceId?: string; items?: ConnectRec[] }>("mpc_connects_v1")) || {};
  const items = (log.workspaceId === ws ? log.items || [] : []).filter((x) => x.email !== email);
  items.unshift(rec);
  await saveSnapshot("mpc_connects_v1", { workspaceId: ws, items: items.slice(0, 1000) });

  return ok({ status: rec.status, reason: rec.reason });
}
