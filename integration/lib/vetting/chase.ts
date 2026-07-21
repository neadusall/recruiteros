/**
 * RecruitersOS · AI Vetting · Resume chase (the updated-resume follow-up ladder)
 *
 * The vetting motion converges on ONE artifact: the candidate's UPDATED resume,
 * tailored to the role they just screened for. The agent asks for it on the
 * call (see prompt.ts, THE RESUME ASK); this module keeps the promise alive
 * afterwards:
 *
 *   Rung 1 (right after scoring): thank-you EMAIL - warm thanks + the tailored
 *          resume-coaching note (buildPostCallEmail) + the resubmit link.
 *   Rung 2 (same moment):         thank-you SMS from the desk's own number,
 *          repeating where to send the resume so the ask survives the call.
 *   Rung 3 (+1 day, no resume):   reminder EMAIL, shorter and lighter.
 *   Rung 4 (+2 days, no resume):  reminder SMS, one line, then we go quiet.
 *
 * A filed resume (email inbox or the resume page) stops the ladder instantly
 * wherever it is (store.setCandidateResume -> settleResumeArrival). Every send
 * is best-effort and recorded as a ChaseStep so the recruiter can see exactly
 * what went out and when. Reminders only fire inside a daytime window so no
 * candidate gets a 3am text.
 *
 * The tick rides the proven resume-inbox cadence (sweepAllResumeInboxes calls
 * runChaseTick) plus a self-heal pass on the calls GET, the same convergence
 * idiom as the rest of the vetting stack.
 */

import { telnyx } from "../providers";
import { withWorkspaceCreds } from "../connected";
import { sendWorkspaceEmail } from "../auth";
import type { VettingDesk, VettingCall, CandidateProfile, ChaseStep, ChaseStepKind } from "./types";
import {
  getDeskById, getCandidateById, getCallById, listActiveChaseCalls, setCallChase, addChaseStep,
  ensureVettingReady,
} from "./store";
import { buildPostCallEmail } from "./resumeCoach";

/* ---------------- timing ---------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Hour window (UTC) reminders may fire in: 13:00-23:59 UTC ~ 9am-7pm US Eastern. */
const REMINDER_UTC_START = 13;
const REMINDER_UTC_END = 24;

function inDaytimeWindow(now = new Date()): boolean {
  const h = now.getUTCHours();
  return h >= REMINDER_UTC_START && h < REMINDER_UTC_END;
}

/* ---------------- the resume address ---------------- */

/**
 * Where the candidate sends the resume: the workspace's resume-inbox mailbox.
 * Read inside the workspace's credential context; "" when the inbox isn't set
 * up (the copy then leans on the resume page link instead).
 */
async function resumeAddress(workspaceId: string): Promise<string> {
  try {
    const { inboxConfig } = await import("./inbox");
    return (await withWorkspaceCreds(workspaceId, async () => inboxConfig()?.user || "")) || "";
  } catch {
    return "";
  }
}

/** The candidate-facing resume page (same builder as resumeCoach). */
function resumePageUrl(deskId: string, candidateId: string): string {
  const base = (process.env.RECRUITEROS_APP_URL ?? "https://recruitersos.co").replace(/\/$/, "");
  return `${base}/vetting-resume.html?desk=${encodeURIComponent(deskId)}&cid=${encodeURIComponent(candidateId)}`;
}

/* ---------------- copy (deterministic, warm, no em-dashes) ---------------- */

function sendLine(address: string, link: string): string {
  if (address && link) return `The easiest way is to reply to this email with it attached, send it to ${address}, or paste it here: ${link}`;
  if (address) return `Just reply to this email with it attached, or send it to ${address}.`;
  if (link) return `You can paste or upload it here: ${link}`;
  return `Just reply to this email with it attached.`;
}

function reminderEmail(desk: VettingDesk, cand: CandidateProfile, address: string): { subject: string; body: string } {
  const role = desk.roleTitle || "the role";
  const link = resumePageUrl(desk.id, cand.id);
  return {
    subject: `Your updated resume for ${role}`,
    body:
      `Hi ${cand.firstName},\n\n` +
      `Really enjoyed our conversation about ${role}. Quick nudge on the one thing I still need from you: the updated version of your resume, tailored to what we talked about. ` +
      `I have your current one, but the updated version is what goes in front of the hiring side, so the sooner it lands, the sooner I can get you moving.\n\n` +
      `${sendLine(address, link)}\n\n` +
      `Even a lightly touched-up version today beats a perfect one next week. If anything is holding you up, just reply and tell me.\n\n` +
      `Talk soon,\n${desk.persona.agentName}\n${desk.persona.agentCompany}`,
  };
}

function thanksSmsText(desk: VettingDesk, cand: CandidateProfile, address: string): string {
  const first = cand.firstName ? `${cand.firstName}, thanks` : "Thanks";
  const where = address ? `send the updated resume we talked about to ${address}` : `send over the updated resume we talked about (link in your email)`;
  return `${first} for the great call about the ${desk.roleTitle || "role"}. It's ${desk.persona.agentName} with ${desk.persona.agentCompany}. ` +
    `One thing keeps you moving: ${where}. I just emailed you exactly what to strengthen. Any questions, call or text this number.`;
}

function reminderSmsText(desk: VettingDesk, cand: CandidateProfile, address: string): string {
  const where = address ? `Send it to ${address}` : `The link is in your email`;
  return `Hi ${cand.firstName || "there"}, ${desk.persona.agentName} here with ${desk.persona.agentCompany}. ` +
    `Still holding a spot open on the ${desk.roleTitle || "role"} conversation for you. The updated resume we talked about is the one thing I need to move you forward. ${where} and I'll take it from there.`;
}

/* ---------------- sends (best-effort, recorded) ---------------- */

async function sendChaseEmail(
  desk: VettingDesk, call: VettingCall, cand: CandidateProfile,
  kind: ChaseStepKind, subject: string, body: string,
): Promise<void> {
  const step: ChaseStep = { kind, at: new Date().toISOString(), ok: false };
  if (!cand.email) {
    step.note = "no email on file";
  } else {
    try {
      await sendWorkspaceEmail(cand.email, subject, body, call.workspaceId);
      step.ok = true;
    } catch (e: any) {
      step.note = String(e?.message || "email failed").slice(0, 160);
    }
  }
  addChaseStep(call.id, step);
}

async function sendChaseSms(
  desk: VettingDesk, call: VettingCall, cand: CandidateProfile, kind: ChaseStepKind, text: string,
): Promise<void> {
  const step: ChaseStep = { kind, at: new Date().toISOString(), ok: false };
  const to = cand.phone || (call.callerPhone !== "unknown" ? call.callerPhone : "");
  if (!to) {
    step.note = "no phone on file";
  } else if (!desk.phoneNumber) {
    step.note = "desk has no number";
  } else {
    try {
      const res: any = await withWorkspaceCreds(desk.workspaceId, () => telnyx.sendSms(to, text, desk.phoneNumber));
      if (res?.error) throw new Error(String(res.error));
      step.ok = true;
    } catch (e: any) {
      step.note = String(e?.message || "sms failed").slice(0, 160);
    }
  }
  addChaseStep(call.id, step);
}

/* ---------------- rung 1+2: the thank-you pair ---------------- */

/**
 * Kick off the chase for a freshly scored call: thank-you email (the tailored
 * coaching note) + thank-you text, both requesting the updated resume. Runs
 * for EVERY scored call with a matched candidate, qualified or not: the resume
 * is wanted no matter how the call went. Never throws.
 */
export async function startResumeChase(deskId: string, callId: string): Promise<void> {
  try {
    await ensureVettingReady();
    const desk = getDeskById(deskId);
    const call = getCallById(callId);
    if (!desk || !call || call.chase) return;

    const cand = call.candidateId ? getCandidateById(call.candidateId) : undefined;
    if (!cand || (!cand.email && !cand.phone && call.callerPhone === "unknown")) {
      setCallChase(callId, {
        status: "skipped", startedAt: new Date().toISOString(), steps: [],
        note: cand ? "no contact info on file" : "caller never opted in, nothing to chase",
      });
      return;
    }

    setCallChase(callId, { status: "active", startedAt: new Date().toISOString(), steps: [] });

    const address = await resumeAddress(call.workspaceId);

    // Thank-you email: the coaching email IS the thank-you + resume ask. It
    // degrades to a deterministic version without an LLM key, so this always
    // has something warm to send.
    if (cand.email) {
      try {
        const mail = await buildPostCallEmail(desk, call, cand);
        const body = address
          ? `${mail.body.trim()}\n\nYou can also just reply to this email with the updated resume attached, or send it to ${address}.`
          : mail.body;
        await sendChaseEmail(desk, call, cand, "thanks_email", mail.subject, body);
      } catch (e: any) {
        addChaseStep(call.id, { kind: "thanks_email", at: new Date().toISOString(), ok: false, note: String(e?.message || "compose failed").slice(0, 160) });
      }
    } else {
      addChaseStep(call.id, { kind: "thanks_email", at: new Date().toISOString(), ok: false, note: "no email on file" });
    }

    await sendChaseSms(desk, call, cand, "thanks_sms", thanksSmsText(desk, cand, address));
  } catch (e: any) {
    console.error("[vetting] resume chase start failed:", e?.message || e);
  }
}

/* ---------------- rung 3+4: the reminder ladder ---------------- */

function hasStep(call: VettingCall, kind: ChaseStepKind): boolean {
  return Boolean(call.chase?.steps.some((s) => s.kind === kind));
}

/** Did the candidate's resume land AFTER this call started? (What "updated" means.) */
function resumeArrivedSince(call: VettingCall, cand: CandidateProfile | undefined): boolean {
  if (!cand?.resumeText || !cand.resumeUpdatedAt) return false;
  return Date.parse(cand.resumeUpdatedAt) >= Date.parse(call.startedAt);
}

/**
 * One convergence pass over every active chase, across all workspaces. Cheap
 * when nothing is due. Runs on the resume-inbox cadence (~5 min) and on the
 * calls GET self-heal; overlapping passes are coalesced.
 */
let tickInFlight: Promise<void> | null = null;
export function runChaseTick(): Promise<void> {
  if (tickInFlight) return tickInFlight;
  tickInFlight = (async () => {
    await ensureVettingReady();
    const now = Date.now();
    for (const call of listActiveChaseCalls()) {
      try {
        const desk = getDeskById(call.deskId);
        const cand = call.candidateId ? getCandidateById(call.candidateId) : undefined;
        if (!desk || !cand || !call.chase) continue;

        // Belt-and-braces: settle a resume that arrived through any path.
        if (resumeArrivedSince(call, cand)) {
          call.chase.status = "completed";
          call.chase.resumeReceivedAt = cand.resumeUpdatedAt;
          setCallChase(call.id, call.chase);
          continue;
        }

        const age = now - Date.parse(call.chase.startedAt);
        if (!inDaytimeWindow()) continue;

        if (age >= DAY_MS && !hasStep(call, "reminder_email")) {
          const address = await resumeAddress(call.workspaceId);
          const mail = reminderEmail(desk, cand, address);
          await sendChaseEmail(desk, call, cand, "reminder_email", mail.subject, mail.body);
        } else if (age >= 2 * DAY_MS && !hasStep(call, "reminder_sms")) {
          const address = await resumeAddress(call.workspaceId);
          await sendChaseSms(desk, call, cand, "reminder_sms", reminderSmsText(desk, cand, address));
          // Final rung sent: the ladder goes quiet.
          call.chase.status = "exhausted";
          call.chase.note = "full ladder sent; waiting quietly";
          setCallChase(call.id, call.chase);
        }
      } catch (e: any) {
        console.error("[vetting] chase tick failed for call", call.id, e?.message || e);
      }
    }
  })().finally(() => { tickInFlight = null; });
  return tickInFlight;
}
