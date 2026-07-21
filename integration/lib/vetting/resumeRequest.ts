/**
 * RecruitersOS · Resume-request email channel
 *
 * The missing first rung of the vetting funnel: EMAIL a sourced or pipeline
 * candidate and ask for their CURRENT resume, before any call has happened.
 * One warm ask, one reminder three days later, then quiet.
 *
 * Everything downstream already exists and is reused, not duplicated:
 *   - the send goes through sendWorkspaceEmail, so a white-label tenant mails
 *     from ITS OWN mailbox (Lume = lumesp.com) and the reply lands in the very
 *     mailbox the resume inbox (inbox.ts) sweeps every 5 minutes;
 *   - before the reply can match, the person is bridged into the vetting
 *     candidate store (upsertCandidate) under a desk that carries the role's
 *     JD, so matchCandidate() recognizes the sender by email;
 *   - a filed resume then runs the standing intake untouched: resume coverage
 *     review, Job Library pairing, and the self-scheduling screen-call loop.
 *
 * Guard rails, in order, before any send:
 *   1. checkContactable (DNC + 14-day cross-channel cooldown) - and because
 *      sendWorkspaceEmail is a transactional path that does NOT stamp touches,
 *      every send here is registered via logTouchToAts so the cooldown both
 *      blocks this channel and learns from it;
 *   2. per-candidate stamps (resumeRequestedAt) - one ask per person per 14
 *      days, never re-asked once a resume is on file, so sourcing top-ups and
 *      retries are free;
 *   3. a per-workspace daily cap (RESUME_REQUEST_DAILY_CAP, default 60) - the
 *      brand mailbox is a single real inbox, not a sending pool, and its
 *      deliverability is the whole channel.
 *
 * The automatic leg on the sourcing belt (autoRequestResumesForRun) is OFF
 * until RESUME_REQUEST_AUTO=on: hands-off email to a whole list is an owner
 * decision, same posture as OS Text's human-set send time.
 */

import { sendWorkspaceEmail } from "../auth";
import { checkContactable } from "../outreach/contactGuard";
import { withWorkspaceCreds } from "../connected";
import type { CandidateProfile, VettingDesk } from "./types";
import {
  ensureVettingReady, listDesks, getDeskById, upsertDesk, upsertCandidate,
  findCandidateByEmail, markResumeRequested, listCandidates, listVettingWorkspaceIds,
} from "./store";
import { pairCandidateToDeskJd } from "./jdlink";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Don't re-ask the same person inside this window. */
const REASK_DAYS = 14;
/** Reminder fires this long after an unanswered ask. */
const REMIND_AFTER_MS = 3 * DAY_MS;
/** A resume this fresh means the ask already succeeded; never ask again. */
const RESUME_FRESH_DAYS = 90;
/** The standing desk for people with no known role (email-match still works). */
const INTAKE_DESK_NAME = "Resume intake";

/** Same daytime window as the chase ladder: 13:00-23:59 UTC ~ 9am-7pm Eastern. */
function inDaytimeWindow(now = new Date()): boolean {
  const h = now.getUTCHours();
  return h >= 13 && h < 24;
}

/* ---------------- inputs ---------------- */

export interface ResumeRequestPerson {
  firstName?: string;
  lastName?: string;
  fullName?: string;
  email: string;
  phone?: string;
  linkedinUrl?: string;
}

export interface ResumeRequestOpts {
  /** Where the ask originated ("candidates" tab, "sourcing" belt). */
  source: string;
  /** Pin the ask to a specific vetting desk (else resolved from pairings/JD). */
  deskId?: string;
  /** The role's JD, when known (a sourcing run's) - finds or creates its desk. */
  jd?: { title?: string; text: string; company?: string };
  /** Signs the email; falls back to the desk persona's agent name. */
  requesterName?: string;
}

export type ResumeRequestSkip =
  | "no_email" | "has_resume" | "already_asked" | "daily_cap"
  | "do_not_contact" | "recently_contacted" | "error";

export interface ResumeRequestResult {
  sent: boolean;
  reason?: ResumeRequestSkip;
  candidateId?: string;
}

/* ---------------- the per-workspace daily cap ---------------- */

function dailyCap(): number {
  const v = Number(process.env.RESUME_REQUEST_DAILY_CAP);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 60;
}

const capState = new Map<string, { day: string; count: number }>();

function underDailyCap(workspaceId: string): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const s = capState.get(workspaceId);
  return !s || s.day !== day || s.count < dailyCap();
}

function bumpDailyCount(workspaceId: string): void {
  const day = new Date().toISOString().slice(0, 10);
  const s = capState.get(workspaceId);
  if (s && s.day === day) s.count++;
  else capState.set(workspaceId, { day, count: 1 });
}

/* ---------------- shared lookups ---------------- */

/** The mailbox candidates reply to: the workspace's resume inbox. */
async function resumeAddress(workspaceId: string): Promise<string> {
  try {
    const { inboxConfig } = await import("./inbox");
    return (await withWorkspaceCreds(workspaceId, async () => inboxConfig()?.user || "")) || "";
  } catch {
    return "";
  }
}

/** The candidate-facing resume page (same builder as chase/resumeCoach). */
function resumePageUrl(deskId: string, candidateId: string): string {
  const base = (process.env.RECRUITEROS_APP_URL ?? "https://recruitersos.co").replace(/\/$/, "");
  return `${base}/vetting-resume.html?desk=${encodeURIComponent(deskId)}&cid=${encodeURIComponent(candidateId)}`;
}

/** The brand the email speaks as (Lume for Lume's workspace, house otherwise). */
async function brandNameFor(workspaceId: string): Promise<string> {
  try {
    const { notifyBrand } = await import("../outbound/brand");
    return (await notifyBrand(workspaceId)).name || "our recruiting team";
  } catch {
    return "our recruiting team";
  }
}

/* ---------------- copy (deterministic, warm, no em-dashes) ---------------- */

function sendLine(address: string, link: string): string {
  if (address && link) return `The easiest way is to reply to this email with it attached, send it to ${address}, or paste it here: ${link}`;
  if (address) return `Just reply to this email with it attached, or send it to ${address}.`;
  if (link) return `You can paste or upload it here: ${link}`;
  return `Just reply to this email with it attached.`;
}

function firstAskEmail(
  desk: VettingDesk, cand: CandidateProfile, signer: string, brand: string, address: string,
): { subject: string; body: string } {
  const role = (desk.roleTitle || "").trim();
  const link = resumePageUrl(desk.id, cand.id);
  const hi = cand.firstName ? `Hi ${cand.firstName},` : "Hi there,";
  const roleLine = role
    ? `I'm recruiting for a ${role} opening and your background stood out.`
    : `I'm recruiting for a role your background looks like a genuinely strong match for.`;
  return {
    subject: role ? `Your resume for the ${role} opening` : `Quick one: your current resume`,
    body:
      `${hi}\n\n` +
      `${signer} here with ${brand}. ${roleLine}\n\n` +
      `Before anything moves I want your story told right, and that starts with your current resume. Could you send me your latest version?\n\n` +
      `${sendLine(address, link)}\n\n` +
      `If the timing is off or this one is not for you, no problem at all, just reply and tell me. And if you have questions, replying here reaches me directly.\n\n` +
      `Talk soon,\n${signer}\n${brand}`,
  };
}

function reminderAskEmail(
  desk: VettingDesk, cand: CandidateProfile, signer: string, brand: string, address: string,
): { subject: string; body: string } {
  const role = (desk.roleTitle || "").trim();
  const link = resumePageUrl(desk.id, cand.id);
  const roleLine = role
    ? `The ${role} opening is still on my desk and I would like to put you forward.`
    : `I would still like to put you forward.`;
  return {
    subject: role ? `Still open: ${role}` : `Following up on your resume`,
    body:
      `Hi ${cand.firstName || "there"},\n\n` +
      `Quick follow-up from ${signer} at ${brand}. ${roleLine} The one thing I need is your current resume.\n\n` +
      `${sendLine(address, link)}\n\n` +
      `If you would rather pass, a one line reply is all it takes and I will not nudge you again.\n\n` +
      `${signer}\n${brand}`,
  };
}

/* ---------------- pipeline stage write-back ---------------- */

/**
 * Nudge the person's warehouse record forward on the Candidates board without
 * ever fighting the recruiter: only the early, automated stages move
 * (nothing -> Outbound -> Screening), a custom or later stage is left alone,
 * and the stage never moves backward. Best-effort by design.
 */
const AUTO_STAGE_ORDER = ["Applied", "Longlist", "Shortlist", "Outbound", "Screening"];
const HANDS_OFF_STAGES = new Set(["Submitted", "Interviewing", "Rejected", "Hired"]);

export async function markPipelineStage(
  workspaceId: string,
  who: { email?: string; phone?: string; fullName?: string },
  stage: "Outbound" | "Screening",
): Promise<void> {
  try {
    const { findRecordForPerson, saveRecord } = await import("../data");
    const rec = await findRecordForPerson(workspaceId, who);
    if (!rec) return;
    const cur = (rec.stage || "").trim();
    if (HANDS_OFF_STAGES.has(cur)) return;
    if (cur && !AUTO_STAGE_ORDER.includes(cur)) return;
    if (cur && AUTO_STAGE_ORDER.indexOf(cur) >= AUTO_STAGE_ORDER.indexOf(stage)) return;
    rec.stage = stage;
    await saveRecord(rec);
  } catch { /* a stage nudge must never break the send or the intake */ }
}

/* ---------------- desk resolution ---------------- */

/**
 * Which desk the ask (and later, the reply, the coverage review and the screen
 * call) belongs to. Strongest signal first:
 *   1. an explicit deskId,
 *   2. the person's freshest Job Library pairing whose JD a desk carries,
 *   3. the given JD text: reuse the desk already carrying that JD (content-hash
 *      dedupe upstream) or spin one up for the role,
 *   4. the workspace's standing "Resume intake" desk (email-match still works).
 */
async function resolveDesk(
  workspaceId: string, person: ResumeRequestPerson, opts: ResumeRequestOpts,
): Promise<VettingDesk> {
  if (opts.deskId) {
    const d = getDeskById(opts.deskId);
    if (d && d.workspaceId === workspaceId) return d;
  }

  try {
    const { ensureJobsReady, jobsForContact } = await import("../jobs");
    await ensureJobsReady();
    const jobs = jobsForContact(workspaceId, { email: person.email, phone: person.phone });
    for (const j of jobs) {
      const d = listDesks(workspaceId, "recruiting").find((x) => x.jdId === j.jdId);
      if (d) return d;
    }
  } catch { /* pairing lookup is best-effort */ }

  const jdText = (opts.jd?.text || "").trim();
  if (jdText.length >= 40) {
    try {
      const { ensureJobsReady, upsertJd, titleFromJdText } = await import("../jobs");
      await ensureJobsReady();
      const jd = upsertJd(workspaceId, {
        title: opts.jd?.title || titleFromJdText(jdText),
        company: opts.jd?.company,
        text: jdText,
        source: "vetting",
      });
      const existing = listDesks(workspaceId, "recruiting").find((d) => d.jdId === jd.id);
      if (existing) return existing;
      return upsertDesk(workspaceId, {
        name: jd.title, motion: "recruiting", jobDescription: jdText,
        roleTitle: jd.title, clientCompany: opts.jd?.company, jdId: jd.id,
      });
    } catch { /* fall through to the intake desk */ }
  }

  const intake = listDesks(workspaceId, "recruiting").find((d) => d.name === INTAKE_DESK_NAME);
  return intake ?? upsertDesk(workspaceId, { name: INTAKE_DESK_NAME, motion: "recruiting" });
}

/* ---------------- the ask ---------------- */

function splitName(p: ResumeRequestPerson): { first: string; last: string; full: string } {
  const full = (p.fullName || `${p.firstName || ""} ${p.lastName || ""}`).trim();
  const first = (p.firstName || full.split(/\s+/)[0] || "").trim();
  const last = (p.lastName || full.split(/\s+/).slice(1).join(" ") || "").trim();
  return { first, last, full: full || `${first} ${last}`.trim() };
}

/**
 * Ask one person for their current resume. Guards, bridges them into the
 * vetting store so the reply matches, sends from the workspace's own brand
 * mailbox, registers the touch with the cooldown, pairs the JD, and nudges
 * their pipeline stage to Outbound. Never throws.
 */
export async function requestResume(
  workspaceId: string, person: ResumeRequestPerson, opts: ResumeRequestOpts,
): Promise<ResumeRequestResult> {
  try {
    const email = (person.email || "").trim();
    if (!email || !email.includes("@")) return { sent: false, reason: "no_email" };
    await ensureVettingReady();

    const name = splitName(person);

    // Per-candidate stamps: one ask per window, never once a resume is fresh.
    const existing = findCandidateByEmail(workspaceId, email);
    if (existing?.resumeText && (existing.resumeText || "").length >= 80) {
      const age = existing.resumeUpdatedAt ? Date.now() - Date.parse(existing.resumeUpdatedAt) : 0;
      if (age < RESUME_FRESH_DAYS * DAY_MS) return { sent: false, reason: "has_resume", candidateId: existing.id };
    }
    if (existing?.resumeRequestedAt && Date.now() - Date.parse(existing.resumeRequestedAt) < REASK_DAYS * DAY_MS) {
      return { sent: false, reason: "already_asked", candidateId: existing.id };
    }

    if (!underDailyCap(workspaceId)) return { sent: false, reason: "daily_cap" };

    // DNC + 14-day cross-channel cooldown, BEFORE anything is written.
    const check = await checkContactable(workspaceId, {
      email, phone: person.phone, fullName: name.full,
    }, { checkRecency: true });
    if (!check.ok) return { sent: false, reason: check.reason || "do_not_contact" };

    const desk = await resolveDesk(workspaceId, person, opts);

    // Bridge into the vetting store: the reply's sender address must match a
    // CandidateProfile or the inbox files it as "unmatched". Email is the
    // dedupe key here; upsertCandidate's phone-key dedupe covers re-asks.
    const cand = existing ?? upsertCandidate(workspaceId, {
      deskId: desk.id, firstName: name.first, lastName: name.last,
      phone: (person.phone || "").trim(), email, linkedinUrl: person.linkedinUrl,
    });

    const address = await resumeAddress(workspaceId);
    const brand = await brandNameFor(workspaceId);
    const signer = (opts.requesterName || "").trim() || desk.persona.agentName;
    const mail = firstAskEmail(desk, cand, signer, brand, address);
    await sendWorkspaceEmail(email, mail.subject, mail.body, workspaceId);

    markResumeRequested(cand.id, { requestedAt: new Date().toISOString(), source: opts.source });
    bumpDailyCount(workspaceId);

    // sendWorkspaceEmail is transactional and stamps nothing: register the
    // touch ourselves so the cooldown guard sees (and later protects) it.
    const { logTouchToAts } = await import("../ats/activity");
    void logTouchToAts(workspaceId, {
      email, phone: person.phone, fullName: name.full, channel: "email",
      note: `Resume request${desk.roleTitle ? ` for ${desk.roleTitle}` : ""} (${opts.source})`,
      at: new Date().toISOString(),
    });

    void pairCandidateToDeskJd(desk, { email, phone: person.phone, name: name.full }, "vetting", `Resume request: ${desk.name}`);
    void markPipelineStage(workspaceId, { email, phone: person.phone, fullName: name.full }, "Outbound");

    return { sent: true, candidateId: cand.id };
  } catch (e: any) {
    console.error("[resume-request] ask failed:", e?.message || e);
    return { sent: false, reason: "error" };
  }
}

/* ---------------- bulk: the Candidates tab action ---------------- */

export interface ResumeRequestTally {
  sent: number;
  skipped: number;
  reasons: Partial<Record<ResumeRequestSkip, number>>;
}

export async function requestResumes(
  workspaceId: string, people: ResumeRequestPerson[], opts: ResumeRequestOpts,
): Promise<ResumeRequestTally> {
  const tally: ResumeRequestTally = { sent: 0, skipped: 0, reasons: {} };
  for (const p of people) {
    const r = await requestResume(workspaceId, p, opts);
    if (r.sent) tally.sent++;
    else {
      tally.skipped++;
      const key = r.reason || "error";
      tally.reasons[key] = (tally.reasons[key] || 0) + 1;
      if (key === "daily_cap") break;
    }
  }
  return tally;
}

/* ---------------- the sourcing belt leg (flag-gated) ---------------- */

/**
 * The hands-off leg on the sourcing auto-belt: every candidate on a freshly
 * sent recruiting list who carries an email gets ONE resume ask. OFF until the
 * owner sets RESUME_REQUEST_AUTO=on; per-candidate stamps make top-up re-runs
 * free, and the daily cap stops the pass early rather than flooding the
 * brand mailbox.
 */
export async function autoRequestResumesForRun(run: {
  workspaceId: string;
  name: string;
  motion: string;
  jd: string;
  createdBy?: { name: string };
  candidates: Array<{ fullName?: string; email?: string; phone?: string; linkedinUrl?: string }>;
}): Promise<{ enabled: boolean } & ResumeRequestTally> {
  const on = /^(1|on|true|yes)$/i.test((process.env.RESUME_REQUEST_AUTO || "").trim());
  if (!on || run.motion === "bd") return { enabled: false, sent: 0, skipped: 0, reasons: {} };
  const people = run.candidates
    .filter((c) => (c.email || "").includes("@"))
    .map((c) => ({ fullName: c.fullName, email: c.email as string, phone: c.phone, linkedinUrl: c.linkedinUrl }));
  const tally = await requestResumes(run.workspaceId, people, {
    source: "sourcing", jd: { text: run.jd }, requesterName: run.createdBy?.name,
  });
  return { enabled: true, ...tally };
}

/* ---------------- the reminder tick ---------------- */

/**
 * One convergence pass over every unanswered ask, across all workspaces: three
 * days after the ask, inside the daytime window, one reminder, then quiet.
 * Rides the resume-inbox cadence (sweepAllResumeInboxes), same as the chase
 * ladder; overlapping passes coalesce. A filed resume needs no settling here:
 * the ask-time stamps simply stop matching the "unanswered" filter.
 */
let tickInFlight: Promise<void> | null = null;
export function runResumeRequestTick(): Promise<void> {
  if (tickInFlight) return tickInFlight;
  tickInFlight = (async () => {
    await ensureVettingReady();
    if (!inDaytimeWindow()) return;
    const now = Date.now();
    for (const ws of listVettingWorkspaceIds()) {
      for (const cand of listCandidates(ws)) {
        try {
          if (!cand.resumeRequestedAt || cand.resumeRequestRemindedAt || !cand.email) continue;
          if ((cand.resumeText || "").length >= 80) continue;
          if (now - Date.parse(cand.resumeRequestedAt) < REMIND_AFTER_MS) continue;

          // In-sequence follow-up: DNC still binds, the recency rule does not.
          const check = await checkContactable(ws, { email: cand.email, phone: cand.phone }, { checkRecency: false });
          const desk = getDeskById(cand.deskId);
          if (!check.ok || !desk) {
            // Stamp it handled either way so a protected person is never re-tried every 5 minutes.
            markResumeRequested(cand.id, { remindedAt: new Date().toISOString() });
            continue;
          }

          const address = await resumeAddress(ws);
          const brand = await brandNameFor(ws);
          const mail = reminderAskEmail(desk, cand, desk.persona.agentName, brand, address);
          await sendWorkspaceEmail(cand.email, mail.subject, mail.body, ws);
          markResumeRequested(cand.id, { remindedAt: new Date().toISOString() });

          const { logTouchToAts } = await import("../ats/activity");
          void logTouchToAts(ws, {
            email: cand.email, phone: cand.phone,
            fullName: `${cand.firstName} ${cand.lastName}`.trim(),
            channel: "email", note: "Resume request reminder", at: new Date().toISOString(),
          });
        } catch (e: any) {
          console.error("[resume-request] reminder failed for", cand.id, e?.message || e);
        }
      }
    }
  })().finally(() => { tickInFlight = null; });
  return tickInFlight;
}
