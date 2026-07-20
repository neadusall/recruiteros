/**
 * RecruitersOS · In-Market · Replies & leads from the watch page (Sendspark "forms on video")
 *
 * The prospect-facing watch page can now CONVERT, not just inform: a reply box / mini lead form
 * posts back here. We store the submission, scope it to the owning workspace, and (best-effort)
 * email the operator so a reply becomes a real conversation.
 *
 * Ownership: the watch page is public and a videoKey doesn't encode a workspace, so the studio
 * registers videoKey -> { workspaceId, ownerEmail } when a video is generated (authed). Leads are
 * then listed per workspace and notifications go to the owner.
 *
 * Durable via the Postgres snapshot KV (graceful no-op without DATABASE_URL); bounded lead list.
 */

import { loadSnapshot, debouncedSaver } from "../db";

const KEY = "inmarket_leads_v1";
const LEADS_CAP = 1000;

interface VideoOwner {
  workspaceId: string;
  email?: string;
  company?: string;
  roleTitle?: string;
}
export interface Lead {
  id: string;
  videoKey: string;
  workspaceId?: string;
  company?: string;
  roleTitle?: string;
  type: "reply" | "lead";
  name?: string;
  email?: string;
  message?: string;
  recipient?: string;  // rcpt id from the watch link, when present
  at: string;
}

interface LeadState { owners: Record<string, VideoOwner>; leads: Lead[]; }

let mem: LeadState | null = null;
let loading: Promise<void> | null = null;
async function ensure(): Promise<LeadState> {
  if (mem) return mem;
  if (!loading) {
    loading = (async () => {
      const raw = (await loadSnapshot<LeadState>(KEY).catch(() => null)) || null;
      mem = raw && raw.owners ? { owners: raw.owners, leads: raw.leads || [] } : { owners: {}, leads: [] };
    })().catch(() => { mem = { owners: {}, leads: [] }; });
  }
  await loading;
  return mem ?? (mem = { owners: {}, leads: [] });
}
const scheduleSave = debouncedSaver(KEY, () => (mem ? mem : { owners: {}, leads: [] }), 800);

const VALID_KEY = /^[a-z0-9_-]{3,120}$/;
const clean = (s: unknown, n: number) => (typeof s === "string" ? s.trim().slice(0, n) : undefined);
const isEmail = (s: unknown) => typeof s === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

/** Register (or refresh) which workspace owns a generated video, so leads route + scope correctly. */
export async function registerVideoOwner(
  videoKey: string, workspaceId: string, opts: { email?: string; company?: string; roleTitle?: string } = {},
): Promise<void> {
  if (!VALID_KEY.test(videoKey) || !workspaceId) return;
  const st = await ensure();
  st.owners[videoKey] = {
    workspaceId,
    email: opts.email || st.owners[videoKey]?.email,
    company: opts.company || st.owners[videoKey]?.company,
    roleTitle: opts.roleTitle || st.owners[videoKey]?.roleTitle,
  };
  scheduleSave();
}

/** Record a reply / lead from the watch page. Returns the stored lead (or null if invalid). */
export async function recordLead(input: {
  videoKey: string; type?: string; name?: unknown; email?: unknown; message?: unknown;
  company?: unknown; roleTitle?: unknown; recipient?: unknown;
}): Promise<Lead | null> {
  if (!VALID_KEY.test(input.videoKey || "")) return null;
  const st = await ensure();
  const owner = st.owners[input.videoKey];
  const lead: Lead = {
    id: "ld_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    videoKey: input.videoKey,
    workspaceId: owner?.workspaceId,
    company: clean(input.company, 120) || owner?.company,
    roleTitle: clean(input.roleTitle, 160) || owner?.roleTitle,
    type: input.type === "lead" ? "lead" : "reply",
    name: clean(input.name, 120),
    email: isEmail(input.email) ? (input.email as string) : undefined,
    message: clean(input.message, 2000),
    recipient: clean(input.recipient, 120),
    at: new Date().toISOString(),
  };
  if (!lead.message && !lead.email && !lead.name) return null; // ignore empty pings
  st.leads.unshift(lead);
  if (st.leads.length > LEADS_CAP) st.leads.length = LEADS_CAP;
  scheduleSave();

  // Best-effort notification to the video owner (a reply just came in).
  if (owner?.email) notifyOwner(owner.email, lead).catch(() => {});
  return lead;
}

/** Leads for a workspace, newest first. */
export async function listLeads(workspaceId: string, limit = 200): Promise<Lead[]> {
  const st = await ensure();
  return st.leads.filter((l) => l.workspaceId === workspaceId).slice(0, Math.max(1, Math.min(LEADS_CAP, limit)));
}

/** Owner alert through the brand-true workspace sender (auth email seam), so a
 *  white-label recruiter's reply alert never carries the house sender/brand. */
async function notifyOwner(to: string, lead: Lead): Promise<void> {
  const who = lead.name || lead.email || "Someone";
  const subject = `${who} replied to your video${lead.company ? ` · ${lead.company}` : ""}`;
  const lines = [
    `${who}${lead.email ? ` (${lead.email})` : ""} responded to your personalized video.`,
    lead.company ? `Company: ${lead.company}${lead.roleTitle ? ` · ${lead.roleTitle}` : ""}` : "",
    lead.message ? `\n"${lead.message}"` : "",
    `\nSee all replies in PiP Studio → Performance → Replies.`,
  ].filter(Boolean);
  const { sendWorkspaceEmail } = await import("../auth");
  await sendWorkspaceEmail(to, subject, lines.join("\n"), lead.workspaceId).catch(() => {});
}
