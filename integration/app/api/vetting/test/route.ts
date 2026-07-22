/**
 * AI Vetting · Test drive
 *   POST /api/vetting/test  -> { deskId, phone, mode: "call" | "text" | "interview",
 *                                name?, resumeText?, filename?, contentType?, dataBase64? }
 *
 * Lets any operator (house or white-label) run the live agent through its
 * courses on demand: the desk's assistant CALLS the number they type, or opens
 * an SMS conversation with it, exactly as it treats a real candidate: same
 * prompt, same tools, same default (Lukas) or picked voice. Fires as a Telnyx
 * scheduled event a few seconds out, inside the workspace credential context,
 * so every tenant demos on its own engine and numbers.
 *
 * "call" / "text" are the quick walkthrough: the tester's first name rides the
 * normal {{first_name}} slot and no resume or scoring state is created.
 *
 * "interview" is the full-dress rehearsal used to approve a desk before it
 * goes live on real candidates: the operator hands over a resume (pasted text
 * or an uploaded PDF/Word/text file) and we prepare the call EXACTLY like a
 * real screen against the desk's job description: the recruiter-review
 * coverage pass (what this role needs that the resume doesn't clearly show)
 * plus the personalized prepared-questions pass, then the agent calls and
 * runs the real ten-minute vetting arc. The prepared context rides both the
 * scheduled event's dynamic variables AND an ephemeral test session the
 * context webhook resolves at connect (testSession.ts), so no candidate or
 * chase state is ever created. The call itself still lands in the Calls tab
 * with transcript + scoring, which is exactly what the operator needs to
 * judge the campaign.
 */

import { requireSession, body, ok, fail } from "../../../../lib/api";
import { withWorkspaceCreds } from "../../../../lib/connected";
import { telnyx } from "../../../../lib/providers";
import {
  getDesk, buildCallContext, extractResumeText, reviewResume,
  generatePersonalQuestions, registerTestInterview, inboxConfig,
  type VettingDesk, type CandidateProfile, type PersonalQuestion,
} from "../../../../lib/vetting";
import { toE164 } from "../../../../lib/voice/phone";

/** Opening SMS for a text test: honest, link-free, reply-able. */
function testOpeningText(desk: VettingDesk, firstName: string): string {
  const who = `${desk.persona.agentName} with ${desk.persona.agentCompany}`;
  const role = desk.roleTitle || "the role";
  const name = firstName === "there" ? "" : ` ${firstName}`;
  return `Hey${name}, this is ${who} about ${role}. Do you have a minute to chat by text?`;
}

/**
 * The same gap-line shape the context webhook builds from a stored
 * ResumeReview (context/route.ts resumeGapLines), rendered straight from the
 * fresh review result here since a test never stores one.
 */
function gapLines(coverage: Array<{ requirement: string; mustHave: boolean; status: string; coaching?: string }>): string {
  return coverage
    .filter((c) => c.status !== "shown")
    .slice(0, 6)
    .map((c) => {
      const state = c.status === "partial"
        ? "hinted at on the resume but easy to miss"
        : "not shown on the resume";
      return `- ${c.requirement}${c.mustHave ? " (must-have)" : ""}: ${state}.${c.coaching ? ` If they have it: ${c.coaching}` : ""}`;
    })
    .join("\n");
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<{
    deskId?: string; phone?: string; mode?: string; name?: string;
    resumeText?: string; filename?: string; contentType?: string; dataBase64?: string;
  }>(req);
  if (!b?.deskId || !b?.phone) return fail("missing_fields", 422);
  const mode: "call" | "text" | "interview" =
    b.mode === "text" ? "text" : b.mode === "interview" ? "interview" : "call";

  const desk = getDesk(ws, b.deskId);
  if (!desk) return fail("not_found", 404);
  if (!desk.assistantId) {
    return fail("not_live", 422, { detail: "Take the desk live first, then test it." });
  }
  if (!desk.phoneNumber) {
    return fail("no_phone_number", 422, { detail: "Bind an inbound number to the desk first." });
  }
  const phone = toE164(b.phone);
  if (!phone) {
    return fail("bad_phone", 422, { detail: "Enter the number with area code, e.g. +1 479 555 0134." });
  }

  const fullName = (b.name || "").trim();
  const firstName = fullName.split(/\s+/)[0] || "there";
  const lastName = fullName.split(/\s+/).slice(1).join(" ");

  // ---- Full-dress interview prep (resume vs the desk's JD) ----------------
  let resumeGaps = "";
  let questions: PersonalQuestion[] = [];
  let resumeText = "";
  let prepNote = "";
  if (mode === "interview") {
    if (!(desk.jobDescription || "").trim()) {
      return fail("no_job_description", 422, {
        detail: "Give the desk a job description first (edit the desk and use Auto-fill from JD), so the interview has a role to vet against.",
      });
    }
    resumeText = (b.resumeText || "").trim();
    if (!resumeText && b.dataBase64) {
      let buf: Buffer;
      try { buf = Buffer.from(String(b.dataBase64), "base64"); } catch { return fail("bad_file", 422); }
      if (!buf.length) return fail("bad_file", 422);
      if (buf.length > 10 * 1024 * 1024) return fail("file_too_large", 422, { detail: "Keep the resume file under 10 MB." });
      resumeText = (await extractResumeText({
        filename: b.filename || "", contentType: b.contentType || "", content: buf,
      } as any)).trim();
      if (resumeText.length < 80) {
        return fail("unreadable_file", 422, { detail: "Couldn't read text from that file. Use a PDF, Word (.docx), or plain-text resume, or paste the text instead." });
      }
    }
    if (resumeText.length < 80) {
      return fail("no_resume", 422, { detail: "Paste the resume text or attach the file, so the agent has something to vet." });
    }

    // The synthetic caller: enough CandidateProfile for the two prep passes
    // and buildCallContext. Never stored.
    const tester = {
      id: "test-drive", workspaceId: ws, deskId: desk.id,
      firstName, lastName, phone, phoneDigits: phone.replace(/\D+/g, ""), email: "",
      resumeText,
    } as unknown as CandidateProfile;

    // Same two passes a real candidate gets at the resume-inbox seam, run
    // fresh and in parallel. Without an LLM key the call still fires with the
    // resume riding along; the gaps/questions layers just stay blank.
    const [review, personal] = await Promise.all([
      reviewResume(desk, resumeText, tester).catch(() => null),
      generatePersonalQuestions(desk, tester).catch(() => [] as PersonalQuestion[]),
    ]);
    resumeGaps = review ? gapLines(review.coverage) : "";
    questions = personal || [];
    if (!review && !questions.length) {
      prepNote = "The AI prep passes couldn't run (is the Anthropic key set on the server?), so the agent goes in with the resume only.";
    }
  }

  // The same variable set a real scheduled screen carries.
  const prepped = mode === "interview"
    ? ({ firstName, lastName, resumeText, prequal: questions.length ? { questions, generatedAt: "", basis: "" } : undefined } as unknown as CandidateProfile)
    : undefined;
  const vars = buildCallContext(desk, prepped, {
    resumeGaps,
    callOpening: mode !== "text" ? "Thanks for making time, calling like we set up." : undefined,
  });
  vars.first_name = firstName;

  // A few seconds out: enough for Telnyx to accept and fire, near-instant to
  // the person holding the phone.
  const scheduledAt = new Date(Date.now() + 15 * 1000).toISOString();

  try {
    return await withWorkspaceCreds(ws, async () => {
      if (mode === "interview") {
        // The resume-inbox address rides in so THE RESUME ASK sounds real.
        try { vars.resume_email = inboxConfig()?.user || ""; } catch { /* blank is handled */ }
        // Arm the webhook side so the connect-time variable resolution returns
        // the same interview, not the unknown-caller blanks.
        registerTestInterview({
          deskId: desk.id, workspaceId: ws, phone,
          firstName, lastName, resumeText, resumeGaps, questions,
        });
      }
      const res: any = await telnyx.createAssistantScheduledEvent(desk.assistantId!, {
        agentNumber: desk.phoneNumber!,
        endUserNumber: phone,
        scheduledAt,
        channel: mode === "text" ? "sms_chat" : "phone_call",
        dynamicVariables: vars,
        text: mode === "text" ? testOpeningText(desk, firstName) : undefined,
      });
      if (res?.error) {
        return fail("test_failed", 502, { detail: String(res.error).slice(0, 180) });
      }
      const dryRun = Boolean(res?.dryRun);
      const eventId = res?.data?.scheduled_event_id ?? res?.scheduled_event_id;
      return ok({
        mode, phone, dryRun, eventId, from: desk.phoneNumber,
        gaps: mode === "interview" ? resumeGaps.split("\n").filter(Boolean).length : undefined,
        questions: mode === "interview" ? questions.length : undefined,
        prepNote: prepNote || undefined,
      });
    });
  } catch (e: any) {
    return fail("test_failed", 502, { detail: String(e?.message || "could not start the test").slice(0, 180) });
  }
}
