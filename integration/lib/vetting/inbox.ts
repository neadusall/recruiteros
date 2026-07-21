/**
 * RecruitersOS · AI Vetting · Resume inbox (email intake)
 *
 * The missing front door of the vetting funnel. The recruiter tells interested
 * candidates: "email your updated resume to ryan@lumesp.com". This module IS
 * that mailbox's operator: every few minutes (automation scheduler, default 5)
 * it connects over IMAP, finds messages carrying a PDF / Word resume, extracts
 * the text, files it onto the matching opted-in candidate's profile, and THEN
 * deletes the message from the mailbox — the resume's home is the portal, not
 * the inbox. A filed resume is the gate that moves a candidate to the screening
 * call: the sweep fires the "your resume is in, here's the call" invite (Telnyx
 * SMS from the desk's own number) the moment it lands.
 *
 * Matching is deliberately conservative: the SENDER address must match an
 * opted-in candidate's email. Anything else (no attachment, unknown sender,
 * unsupported file) is LEFT IN THE MAILBOX and logged, never deleted — we only
 * ever delete what we successfully saved.
 *
 * Credentials ride the same per-workspace cred() seam as every provider:
 *   RESUME_INBOX_USER  e.g. ryan@lumesp.com
 *   RESUME_INBOX_PASS  the mailbox app password
 *   RESUME_INBOX_HOST  IMAP host (defaults are guessed for gmail/outlook)
 *   RESUME_INBOX_PORT  optional, default 993
 * Unset creds = the sweep is a silent no-op for that workspace (dry-safe).
 */

import { ImapFlow } from "imapflow";
import { simpleParser, type Attachment } from "mailparser";
import { cred } from "../providers/http";
import { telnyx } from "../providers";
import { withWorkspaceCreds } from "../connected";
import type { CandidateProfile, InboxLogEntry, VettingDesk } from "./types";
import {
  listCandidates, getDeskById, setCandidateResume, markScreenInviteSent,
  addResumeReview, inboxState, recordInboxSweep, listVettingWorkspaceIds,
  ensureVettingReady,
} from "./store";
import { reviewResume } from "./resumeCoach";

/* ---------------- config ---------------- */

export interface InboxConfig {
  user: string;
  pass: string;
  host: string;
  port: number;
}

/** Guess the IMAP host from the mailbox domain when none is configured. */
function guessHost(user: string): string {
  const domain = (user.split("@")[1] || "").toLowerCase();
  if (domain === "gmail.com" || domain === "googlemail.com") return "imap.gmail.com";
  if (["outlook.com", "hotmail.com", "live.com", "office365.com"].includes(domain)) return "outlook.office365.com";
  if (domain === "yahoo.com") return "imap.mail.yahoo.com";
  // Google Workspace / custom domains most often sit on Gmail's IMAP; an
  // explicit RESUME_INBOX_HOST always wins over this guess.
  return domain ? "imap.gmail.com" : "";
}

/** The workspace's inbox credentials (must be read inside withWorkspaceCreds). */
export function inboxConfig(): InboxConfig | null {
  const user = cred("RESUME_INBOX_USER").trim();
  const pass = cred("RESUME_INBOX_PASS").trim();
  if (!user || !pass) return null;
  const host = cred("RESUME_INBOX_HOST").trim() || guessHost(user);
  const port = Number(cred("RESUME_INBOX_PORT")) || 993;
  if (!host) return null;
  return { user, pass, host, port };
}

/* ---------------- attachment -> text ---------------- */

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return (m?.[1] || "").toLowerCase();
}

/** Is this attachment plausibly a resume file we can read? */
function isResumeAttachment(a: Attachment): boolean {
  const ext = extOf(a.filename || "");
  const ct = (a.contentType || "").toLowerCase();
  return (
    ext === "pdf" || ct.includes("application/pdf") ||
    ext === "docx" || ct.includes("officedocument.wordprocessingml") ||
    ext === "doc" || ct === "application/msword" ||
    ext === "txt" || ct.startsWith("text/plain")
  );
}

/**
 * Extract readable text from a resume attachment. Returns "" when the format
 * can't be read (legacy .doc) so the caller can log it as unsupported instead
 * of guessing.
 */
export async function extractResumeText(a: Attachment): Promise<string> {
  const buf = a.content as Buffer;
  if (!buf || buf.length === 0 || buf.length > MAX_ATTACHMENT_BYTES) return "";
  const ext = extOf(a.filename || "");
  const ct = (a.contentType || "").toLowerCase();
  try {
    if (ext === "pdf" || ct.includes("application/pdf")) {
      // pdf-parse v2 API: class-based, pdfjs underneath.
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(buf) });
      try {
        const out = await parser.getText();
        return (out?.text || "").trim();
      } finally {
        try { await (parser as any).destroy?.(); } catch { /* best-effort */ }
      }
    }
    if (ext === "docx" || ct.includes("officedocument.wordprocessingml")) {
      const mammoth = await import("mammoth" as string);
      const out = await (mammoth.extractRawText ?? mammoth.default?.extractRawText)({ buffer: buf });
      return (out?.value || "").trim();
    }
    if (ext === "txt" || ct.startsWith("text/plain")) {
      return buf.toString("utf8").trim();
    }
  } catch (e: any) {
    console.error("[vetting] resume extraction failed:", a.filename, e?.message || e);
  }
  return "";
}

/* ---------------- candidate matching ---------------- */

/** Match a sender address to the workspace's opted-in candidates (most recent wins). */
function matchCandidate(workspaceId: string, fromEmail: string): CandidateProfile | undefined {
  const from = fromEmail.trim().toLowerCase();
  if (!from) return undefined;
  return listCandidates(workspaceId).find((c) => (c.email || "").trim().toLowerCase() === from);
}

/* ---------------- the screening invite (the gate opening) ---------------- */

/**
 * The resume is in: tell the candidate the screening call is the next step.
 * SMS from the desk's own inbound number (Telnyx, same stack) so replying or
 * calling back lands on the agent. Best-effort: an invite failure never undoes
 * the filed resume. Sent ONCE per candidate — an updated resume refreshes the
 * profile without re-texting them.
 */
async function sendScreenInvite(desk: VettingDesk, candidate: CandidateProfile): Promise<boolean> {
  if (candidate.screenInviteSentAt) return false;
  if (!desk.phoneNumber || desk.status !== "live") return false;
  if (!candidate.phone) return false;
  const first = candidate.firstName || "";
  const booking = (desk.bookingUrl || "").trim();
  const text =
    `${first ? `Hi ${first}, ` : "Hi, "}it's ${desk.persona.agentName} with ${desk.persona.agentCompany}. ` +
    `Got your resume, thank you. Next step is a quick screening call about the ${desk.roleTitle || "role"}: ` +
    `call me at ${desk.phoneNumber} whenever you have a few minutes.` +
    (booking ? ` Prefer to lock a time instead? Grab one here: ${booking}` : "");
  try {
    const res: any = await telnyx.sendSms(candidate.phone, text, desk.phoneNumber);
    if (res?.error) throw new Error(String(res.error));
    markScreenInviteSent(candidate.id);
    return true;
  } catch (e: any) {
    console.error("[vetting] screen invite SMS failed:", e?.message || e);
    return false;
  }
}

/* ---------------- the sweep ---------------- */

export interface SweepResult {
  configured: boolean;
  checked: number;
  saved: number;
  entries: InboxLogEntry[];
  error?: string;
}

/**
 * Messages we already looked at, couldn't act on, and left in the mailbox
 * (unknown sender, no attachment, unreadable file). Keyed by mailbox identity
 * (uidValidity) + uid so each is LOGGED once per process instead of spamming
 * the activity log every 5 minutes — they're still re-tried every sweep, so a
 * candidate who opts in AFTER emailing gets picked up on the next pass.
 */
const alreadyLogged = new Set<string>();

/**
 * One sweep of one workspace's resume inbox. Must run inside that workspace's
 * credential context (sweepResumeInbox handles that). Never throws.
 */
async function sweepMailbox(workspaceId: string, cfg: InboxConfig): Promise<SweepResult> {
  const entries: InboxLogEntry[] = [];
  let checked = 0;

  const client = new ImapFlow({
    host: cfg.host, port: cfg.port, secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false, socketTimeout: 30_000,
  });

  try {
    await client.connect();

    // Find the real Trash by IMAP special-use (same idiom as the warm-up seed
    // client). This matters on Gmail: a plain \Deleted+expunge "delete" leaves
    // the message archived in All Mail — moving to Trash actually removes it.
    let trashPath: string | undefined;
    try {
      for (const box of await client.list()) {
        if (((box as any).specialUse || "") === "\\Trash") { trashPath = box.path; break; }
      }
    } catch { /* no special-use support; fall back to plain delete */ }

    const lock = await client.getMailboxLock("INBOX");
    try {
      const uidValidity = String((client.mailbox as any)?.uidValidity ?? "");
      const seenKey = (uid: number) => `${workspaceId}:${uidValidity}:${uid}`;
      // A processed message is removed, so the INBOX is the queue. Everything
      // not yet deleted is fair game; cap per sweep to stay polite. NEWEST
      // first: on a busy personal mailbox the fresh resumes must always make
      // the window, even if old unrelated mail never leaves the inbox.
      const uids = await client.search({ deleted: false }, { uid: true });
      const batch = (uids || []).slice(-25).reverse();
      for (const uid of batch) {
        checked += 1;
        let entry: InboxLogEntry | null = null;
        let removed = false;
        try {
          const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
          const source = (msg as any)?.source as Buffer | undefined;
          if (!source) continue;
          const parsed = await simpleParser(source);
          const fromEmail = parsed.from?.value?.[0]?.address || "";
          const attachments = (parsed.attachments || []).filter(isResumeAttachment);

          if (!attachments.length) {
            entry = { at: new Date().toISOString(), from: fromEmail, file: "", outcome: "no_attachment", note: "No resume attachment; left in the inbox." };
          } else {
            const candidate = matchCandidate(workspaceId, fromEmail);
            if (!candidate) {
              entry = {
                at: new Date().toISOString(), from: fromEmail, file: attachments[0].filename || "",
                outcome: "unmatched", note: "Sender doesn't match an opted-in candidate; left in the inbox.",
              };
            } else {
              // First readable attachment wins.
              let text = "";
              let file = "";
              for (const a of attachments) {
                text = await extractResumeText(a);
                file = a.filename || "";
                if (text.length >= 80) break;
              }
              if (text.length < 80) {
                entry = {
                  at: new Date().toISOString(), from: fromEmail, file,
                  outcome: "unsupported", candidateId: candidate.id, deskId: candidate.deskId,
                  note: "Couldn't read the attachment (scanned image or legacy .doc?); left in the inbox.",
                };
              } else {
                const desk = getDeskById(candidate.deskId);
                setCandidateResume(candidate.id, text, { source: "email", fileName: file });

                // Coverage review (recruiter-facing data); never blocks the intake.
                if (desk) {
                  try {
                    const review = await reviewResume(desk, text, candidate);
                    addResumeReview({
                      workspaceId, deskId: desk.id, candidateId: candidate.id,
                      resumeText: text, coverage: review.coverage, allMet: review.allMet,
                      gaps: review.gaps, summary: review.summary,
                      emailSubject: review.emailSubject, emailBody: review.emailBody, emailSent: false,
                    });
                  } catch { /* no LLM key: resume still filed */ }
                }

                // The gate opens: invite them to the screening call (once per
                // candidate — a resume UPDATE refreshes the file quietly).
                const alreadyInvited = Boolean(candidate.screenInviteSentAt);
                const invited = desk ? await sendScreenInvite(desk, candidate) : false;

                entry = {
                  at: new Date().toISOString(), from: fromEmail, file,
                  outcome: "saved", candidateId: candidate.id, deskId: candidate.deskId,
                  note: `Filed to ${candidate.firstName} ${candidate.lastName}`.trim() +
                    (desk ? ` on ${desk.name}` : "") +
                    (invited ? "; screening invite texted." : alreadyInvited ? "; resume updated (already invited)." : "; ready to screen."),
                };

                // Saved -> the portal owns it now; remove it from the mailbox
                // (real Trash when the provider exposes one, else delete+expunge).
                if (trashPath) {
                  await client.messageMove(String(uid), trashPath, { uid: true });
                } else {
                  await client.messageDelete(String(uid), { uid: true });
                }
                removed = true;
              }
            }
          }
        } catch (e: any) {
          entry = { at: new Date().toISOString(), from: "", file: "", outcome: "error", note: e?.message || "message failed" };
        }
        if (entry) {
          // Messages LEFT in the mailbox would re-log identically every sweep;
          // log each once per process. Saved/removed mail always logs.
          if (removed || entry.outcome === "saved") {
            entries.push(entry);
          } else if (!alreadyLogged.has(seenKey(uid))) {
            if (alreadyLogged.size > 5000) alreadyLogged.clear();
            alreadyLogged.add(seenKey(uid));
            entries.push(entry);
          }
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e: any) {
    try { await client.logout(); } catch { /* already down */ }
    return { configured: true, checked, saved: entries.filter((x) => x.outcome === "saved").length, entries, error: e?.message || "imap_error" };
  }

  return { configured: true, checked, saved: entries.filter((x) => x.outcome === "saved").length, entries };
}

/**
 * In-flight sweeps by workspace. The 5-minute tick, the GET self-heal, and the
 * UI's "Check now" can all fire around the same moment; coalescing onto one
 * promise guarantees a message can never be parsed (or a candidate invited)
 * twice by overlapping sweeps.
 */
const inFlight = new Map<string, Promise<SweepResult>>();

/** Sweep one workspace's resume inbox (its creds, its candidates). Never throws. */
export function sweepResumeInbox(workspaceId: string): Promise<SweepResult> {
  const running = inFlight.get(workspaceId);
  if (running) return running;
  const p = (async (): Promise<SweepResult> => {
    await ensureVettingReady();
    return withWorkspaceCreds(workspaceId, async () => {
      const cfg = inboxConfig();
      if (!cfg) return { configured: false, checked: 0, saved: 0, entries: [] };
      const res = await sweepMailbox(workspaceId, cfg);
      recordInboxSweep(workspaceId, res.entries, res.error);
      return res;
    });
  })().finally(() => { inFlight.delete(workspaceId); });
  inFlight.set(workspaceId, p);
  return p;
}

/** The scheduler tick: sweep every workspace that runs vetting desks. */
export async function sweepAllResumeInboxes(): Promise<void> {
  await ensureVettingReady();
  for (const ws of listVettingWorkspaceIds()) {
    try { await sweepResumeInbox(ws); } catch { /* one workspace's inbox */ }
  }
  // The resume-chase ladder rides the same proven cadence: after each sweep
  // (which may have just filed the resume that stops a chase), send whatever
  // reminders have come due. Best-effort by design.
  try {
    const { runChaseTick } = await import("./chase");
    await runChaseTick();
  } catch { /* chase never blocks the inbox */ }
}

/**
 * Self-arming 5-minute ticker, INDEPENDENT of the AUTOMATION_ENABLED campaign
 * clock: resume intake is passive inbox reading, not outbound automation, so
 * it must not wait on the master switch that gates hands-off sending. Armed
 * once from instrumentation.ts (same pattern as the in-market tickers); a
 * workspace with no RESUME_INBOX creds makes each pass a no-op, and the
 * per-workspace coalescing above keeps this safe alongside the scheduler tick
 * and manual "Check now" sweeps. Interval override: RECRUITEROS_RESUME_INBOX_TICK_MS.
 */
let tickerStarted = false;
export function ensureResumeInboxTicker(): void {
  if (tickerStarted) return;
  tickerStarted = true;
  const n = Number(process.env.RECRUITEROS_RESUME_INBOX_TICK_MS);
  const ms = Number.isFinite(n) && n > 0 ? n : 5 * 60_000;
  const run = () => { void sweepAllResumeInboxes().catch(() => {}); };
  setTimeout(run, 20_000);
  const t = setInterval(run, ms);
  if (typeof t === "object" && t && "unref" in t) (t as { unref: () => void }).unref();
  console.log(`[vetting] resume-inbox ticker armed (every ${Math.round(ms / 1000)}s; no-op until RESUME_INBOX_USER/PASS are set).`);
}

/** Status for the UI card: config presence + sweep state, no secrets. */
export async function resumeInboxStatus(workspaceId: string) {
  await ensureVettingReady();
  return withWorkspaceCreds(workspaceId, async () => {
    const cfg = inboxConfig();
    const state = inboxState(workspaceId);
    const resumes = listCandidates(workspaceId).filter((c) => (c.resumeText || "").length >= 80);
    return {
      configured: Boolean(cfg),
      address: cfg?.user || "",
      lastSweepAt: state.lastSweepAt || null,
      lastError: state.lastError || null,
      savedTotal: state.savedTotal,
      resumesOnFile: resumes.length,
      log: state.log.slice(0, 12),
    };
  });
}
