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
import { simpleParser, type Attachment, type ParsedMail } from "mailparser";
import { cred } from "../providers/http";
import { withWorkspaceCreds } from "../connected";
import type { CandidateProfile, InboxLogEntry } from "./types";
import {
  listCandidates, getDeskById, setCandidateResume,
  addResumeReview, inboxState, recordInboxSweep, listVettingWorkspaceIds,
  ensureVettingReady,
} from "./store";
import { reviewResume } from "./resumeCoach";

/** The candidate's OWN words from a reply, with quoted chains stripped. */
function replyBody(parsed: ParsedMail): string {
  const t = (parsed.text || "").trim();
  return t.split(/\r?\n\s*(?:On .{0,120}wrote:|-{2,}\s*Original Message|From: )/)[0].trim().slice(0, 1200);
}

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

/* ---------------- candidate matching (the identity verification) ---------------- */

/** Lowercase, collapse to letters+spaces, for tolerant name/title matching. */
function norm(s?: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Every phone-shaped token in a text, normalized to its last 10 digits. */
function phoneTokens(s: string): Set<string> {
  const out = new Set<string>();
  const re = /\+?1?[\s.(-]{0,2}(\d{3})[\s.)-]{0,2}(\d{3})[\s.-]{0,2}(\d{4})(?!\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.add(`${m[1]}${m[2]}${m[3]}`);
  return out;
}

/**
 * Verify WHO sent this resume against the workspace's opted-in candidates.
 * People routinely email from an address we've never seen (personal vs work),
 * so the match ladder runs strongest-signal first:
 *   1. sender email  = the candidate's email on file (business or personal),
 *   2. phone number  = a phone in the message/signature/resume matches theirs,
 *   3. name + title  = their full name appears (sender name or top of the
 *      resume) AND their desk's role title appears in the message, and the
 *      match is UNIQUE across the workspace.
 * Anything weaker stays unmatched and the mail is left in the inbox.
 */
function matchCandidate(
  workspaceId: string,
  fromEmail: string,
  extras?: { fromName?: string; subject?: string; bodyText?: string; resumeText?: string },
): CandidateProfile | undefined {
  const candidates = listCandidates(workspaceId);
  const from = fromEmail.trim().toLowerCase();
  if (from) {
    const byEmail = candidates.find((c) => (c.email || "").trim().toLowerCase() === from);
    if (byEmail) return byEmail;
  }
  if (!extras) return undefined;

  const hay = `${extras.subject || ""}\n${extras.bodyText || ""}\n${(extras.resumeText || "").slice(0, 4000)}`;
  const phones = phoneTokens(hay);
  if (phones.size) {
    const byPhone = candidates.filter((c) => c.phoneDigits && phones.has(c.phoneDigits.slice(-10)));
    if (byPhone.length === 1) return byPhone[0];
  }

  const nameHay = norm(`${extras.fromName || ""} ${(extras.resumeText || "").slice(0, 400)} ${(extras.bodyText || "").slice(0, 400)}`);
  const titleHay = norm(`${extras.subject || ""} ${extras.bodyText || ""} ${(extras.resumeText || "").slice(0, 1500)}`);
  const byName = candidates.filter((c) => {
    const full = norm(`${c.firstName} ${c.lastName}`);
    if (full.length < 5 || !nameHay.includes(full)) return false;
    const desk = getDeskById(c.deskId);
    const role = norm(desk?.roleTitle);
    return Boolean(role && titleHay.includes(role));
  });
  return byName.length === 1 ? byName[0] : undefined;
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
          const fromName = parsed.from?.value?.[0]?.name || "";
          const attachments = (parsed.attachments || []).filter(isResumeAttachment);

          if (!attachments.length) {
            // No resume attached: this may be a SCHEDULING reply ("tomorrow at
            // 2pm works") from a candidate we asked for availability. Known
            // sender with a live loop -> parse it, act, and remove the mail;
            // everything else stays in the inbox as before.
            const candidate = matchCandidate(workspaceId, fromEmail);
            const screenActive = candidate?.screen && ["awaiting_reply", "clarify", "booked"].includes(candidate.screen.status);
            if (candidate && screenActive) {
              const { handleScheduleReply } = await import("./scheduling");
              const res = await handleScheduleReply(candidate.id, replyBody(parsed), "email");
              entry = {
                at: new Date().toISOString(), from: fromEmail, file: "",
                outcome: "schedule_reply", candidateId: candidate.id, deskId: candidate.deskId,
                note: `Availability reply from ${candidate.firstName} ${candidate.lastName}: ${res.outcome.replace(/_/g, " ")}.`,
              };
              if (trashPath) await client.messageMove(String(uid), trashPath, { uid: true });
              else await client.messageDelete(String(uid), { uid: true });
              removed = true;
            } else {
              entry = { at: new Date().toISOString(), from: fromEmail, file: "", outcome: "no_attachment", note: "No resume attachment; left in the inbox." };
            }
          } else {
            // Read the resume FIRST: its text doubles as identity evidence
            // (phone in the header, name at the top) for the match ladder.
            let text = "";
            let file = "";
            for (const a of attachments) {
              text = await extractResumeText(a);
              file = a.filename || "";
              if (text.length >= 80) break;
            }
            const candidate = matchCandidate(workspaceId, fromEmail, {
              fromName, subject: parsed.subject || "", bodyText: replyBody(parsed), resumeText: text,
            });
            if (!candidate) {
              entry = {
                at: new Date().toISOString(), from: fromEmail, file: attachments[0].filename || "",
                outcome: "unmatched", note: "Sender doesn't match an opted-in candidate by email, phone, or name and role; left in the inbox.",
              };
            } else {
              if (text.length < 80) {
                entry = {
                  at: new Date().toISOString(), from: fromEmail, file,
                  outcome: "unsupported", candidateId: candidate.id, deskId: candidate.deskId,
                  note: "Couldn't read the attachment (scanned image or legacy .doc?); left in the inbox.",
                };
              } else {
                const desk = getDeskById(candidate.deskId);
                setCandidateResume(candidate.id, text, { source: "email", fileName: file });

                // Job Library pairing: a filed resume proves this person is in
                // play for this desk's JD. Fire-and-forget.
                if (desk) {
                  const { pairCandidateToDeskJd } = await import("./jdlink");
                  void pairCandidateToDeskJd(desk, {
                    email: candidate.email, phone: candidate.phone,
                    name: `${candidate.firstName} ${candidate.lastName}`.trim(),
                  }, "resume_inbox");
                }

                // Pipeline write-back: a filed resume moves them into Screening
                // on the Candidates board (never past a recruiter-set stage).
                try {
                  const { markPipelineStage } = await import("./resumeRequest");
                  void markPipelineStage(workspaceId, {
                    email: candidate.email, phone: candidate.phone,
                    fullName: `${candidate.firstName} ${candidate.lastName}`.trim(),
                  }, "Screening");
                } catch { /* the stage nudge never blocks the intake */ }

                // A filed resume is the richest personalization material there
                // is: rebuild this candidate's prepared screening questions
                // from it so the call references their real background.
                if (desk) {
                  const { refreshPersonalPrep } = await import("./prequal");
                  void refreshPersonalPrep(desk, candidate);
                }

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

                // The gate opens: ask WHEN we should call them (once per
                // candidate — a resume UPDATE refreshes the file quietly).
                const alreadyAsked = Boolean(candidate.screenInviteSentAt || candidate.screen);
                const { sendAvailabilityAsk } = await import("./scheduling");
                const asked = desk ? await sendAvailabilityAsk(desk, candidate) : false;

                entry = {
                  at: new Date().toISOString(), from: fromEmail, file,
                  outcome: "saved", candidateId: candidate.id, deskId: candidate.deskId,
                  note: `Filed to ${candidate.firstName} ${candidate.lastName}`.trim() +
                    (desk ? ` on ${desk.name}` : "") +
                    (asked ? "; asked them when to call." : alreadyAsked ? "; resume updated (already in the scheduling loop)." : "; ready to screen."),
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
  // The scheduling loop's clock (reminders + settling booked calls) rides the
  // same cadence; the CALL itself fires from the engine's scheduled event.
  try {
    const { runScheduleTick } = await import("./scheduling");
    await runScheduleTick();
  } catch { /* scheduling never blocks the inbox */ }
  // The resume-request channel's one reminder rides the same cadence too.
  try {
    const { runResumeRequestTick } = await import("./resumeRequest");
    await runResumeRequestTick();
  } catch { /* the reminder never blocks the inbox */ }
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
