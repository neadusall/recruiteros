/**
 * RecruitersOS · MPC · watch -> LinkedIn connect (shared logic)
 *
 * One place that turns a video WATCHER into a LinkedIn connection request from the recruiter who
 * emailed them. Used by both the manual button (/api/mpc-connect) and the auto sweep
 * (/api/mpc-connect/sweep, driven by the q20min tick). Every send goes through LinkedIn OS, so
 * pacing, health, suppression, daily targets and idempotency all apply, an auto sweep can never
 * blast: the engine queues at policy speed.
 */

import { loadSnapshot, saveSnapshot } from "../db";
import { listMembers } from "../auth/team";
import { seatForUser } from "../linkedin/seats";
import { requestLinkedInAction } from "../linkedin/os/engine";

export interface Watcher {
  email: string; name?: string; title?: string; company?: string; role?: string;
  recruiter?: string; linkedin?: string; event?: string; watchedAt?: string;
}
export interface ConnectRec {
  email: string; name?: string; company?: string; recruiter?: string;
  status: "sent" | "queued" | "suppressed" | "no_profile" | "accepted";
  reason?: string; at: string; by?: string; auto?: boolean;
}

const STRENGTH: Record<string, number> = { open: 1, play: 2, complete: 3 };

function noteFor(firstName: string, role?: string): string {
  const seat = role ? `your ${role} search` : "the role you're hiring for";
  return `Hi ${firstName}, I'm the one from the short video about ${seat}. Wanted to put a real name to the face. Open to connecting?`.slice(0, 280);
}

async function loadConnects(ws: string): Promise<ConnectRec[]> {
  const log = (await loadSnapshot<{ workspaceId?: string; items?: ConnectRec[] }>("mpc_connects_v1")) || {};
  return log.workspaceId === ws ? log.items || [] : [];
}
async function saveConnect(ws: string, rec: ConnectRec): Promise<void> {
  const items = (await loadConnects(ws)).filter((x) => x.email !== rec.email);
  items.unshift(rec);
  await saveSnapshot("mpc_connects_v1", { workspaceId: ws, items: items.slice(0, 2000) });
}

/**
 * Fire (or refuse) the connect for one watcher. Returns the resulting status. Idempotent: LinkedIn
 * OS dedups on the idempotency key, and a person already in the connects log is skipped.
 */
export async function connectWatcher(
  ws: string,
  w: Watcher,
  opts: { approvedBy?: string; auto?: boolean } = {},
): Promise<ConnectRec> {
  const now = new Date().toISOString();
  if (!w.linkedin) {
    const rec: ConnectRec = { email: w.email, name: w.name, company: w.company, recruiter: w.recruiter, status: "no_profile", at: now, auto: opts.auto };
    return rec; // not persisted: still "ready" once a profile is resolved
  }
  const members = listMembers(ws);
  const member = members.find((m) => (m.name || "").toLowerCase() === String(w.recruiter || "").toLowerCase());
  const seat = member ? await seatForUser(ws, member.userId) : null;
  const accountId = seat?.accountId || "default";

  const res = await requestLinkedInAction({
    workspaceId: ws,
    accountId,
    person: { email: w.email, linkedinUrl: w.linkedin, fullName: w.name, company: w.company, title: w.title },
    actionType: "connect_note",
    payload: { text: noteFor((w.name || "there").split(/\s+/)[0], w.role) },
    businessUnit: "bd",
    sourceType: opts.auto ? "multichannel_workflow" : "manual",
    approvedBy: opts.approvedBy,
    idempotencyKey: `mpcwatch|${ws}|${w.email.toLowerCase()}`,
  });

  const rec: ConnectRec = {
    email: w.email, name: w.name, company: w.company, recruiter: w.recruiter,
    status: res.accepted ? "sent" : (res.record.status === "suppressed" ? "suppressed" : "queued"),
    reason: res.reason, at: now, by: member?.name || "", auto: opts.auto,
  };
  await saveConnect(ws, rec);
  return rec;
}

/** Manual single connect from the button. Resolves the watcher from the snapshot. */
export async function connectWatcherByEmail(ws: string, email: string, approvedBy?: string): Promise<ConnectRec | { error: string; code: number }> {
  const snap = await loadSnapshot<{ workspaceId?: string; watchers?: Watcher[] }>("mpc_watchers_v1");
  if (!snap || snap.workspaceId !== ws) return { error: "no_watchers", code: 404 };
  const w = (snap.watchers || []).find((x) => x.email === email.toLowerCase());
  if (!w) return { error: "not_a_watcher", code: 404 };
  if (!w.linkedin) return { error: "no_linkedin_profile", code: 422 };
  return connectWatcher(ws, w, { approvedBy });
}

/**
 * Auto sweep: connect every eligible watcher not yet actioned. Eligible = engagement at/above the
 * threshold (env MPC_WATCH_AUTOCONNECT_MIN, default "open" so a click-through counts) and a resolved
 * LinkedIn profile. Off with MPC_WATCH_AUTOCONNECT=0. Watchers with no profile yet are left for a
 * later sweep once linkedin-resolve fills them in.
 */
export async function autoConnectSweep(): Promise<{ enabled: boolean; considered: number; fired: number; skipped: number; noProfile: number }> {
  const enabled = !["0", "false", "no", "off"].includes((process.env.MPC_WATCH_AUTOCONNECT || "").toLowerCase());
  if (!enabled) return { enabled: false, considered: 0, fired: 0, skipped: 0, noProfile: 0 };
  const minEvent = (process.env.MPC_WATCH_AUTOCONNECT_MIN || "open").toLowerCase();
  const minStrength = STRENGTH[minEvent] || 1;

  const snap = await loadSnapshot<{ workspaceId?: string; watchers?: Watcher[] }>("mpc_watchers_v1");
  if (!snap?.workspaceId) return { enabled: true, considered: 0, fired: 0, skipped: 0, noProfile: 0 };
  const ws = snap.workspaceId;
  const done = new Set((await loadConnects(ws)).map((c) => c.email));

  let fired = 0, skipped = 0, noProfile = 0, considered = 0;
  for (const w of snap.watchers || []) {
    if ((STRENGTH[w.event || "open"] || 0) < minStrength) continue;
    considered++;
    if (done.has(w.email)) { skipped++; continue; }
    if (!w.linkedin) { noProfile++; continue; }
    const rec = await connectWatcher(ws, w, { auto: true });
    if (rec.status === "sent" || rec.status === "queued") fired++;
    else skipped++;
  }
  return { enabled: true, considered, fired, skipped, noProfile };
}
