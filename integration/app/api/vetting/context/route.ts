/**
 * AI Vetting · Dynamic-variables webhook  (PUBLIC — called by the voice engine)
 *   POST /api/vetting/context
 *
 * Telnyx calls this the moment a caller connects, so the assistant can greet the
 * RIGHT person. We get the dialed number (which desk) and the caller's number
 * (who's calling), resolve the matching desk + opted-in candidate, open a call
 * record, and return the {{dynamic_variables}} the assistant substitutes into its
 * instructions — first name, current title/company, and LinkedIn talking points.
 *
 * Defensive on shape: Telnyx field names for the to/from numbers vary across
 * assistant versions, so we probe the common keys and fall back gracefully. An
 * unknown caller still gets a warm, generic context (never an error to the
 * engine — that would drop the call).
 */

import { NextResponse } from "next/server";
import {
  findDeskByNumber, findCandidate, createCall, buildCallContext, inboxConfig,
  latestResumeReview,
} from "../../../../lib/vetting";
import { withWorkspaceCreds } from "../../../../lib/connected";

/**
 * The gap list the agent walks in with: from the recruiter-review of the
 * candidate's CURRENT resume against this role's must-haves, the requirements
 * the resume doesn't clearly show yet. Short plain lines the agent can work
 * from live; "" when there's no review on file (prompt handles blank).
 */
function resumeGapLines(candidateId: string): string {
  const review = latestResumeReview(candidateId);
  if (!review) return "";
  return review.coverage
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

/** Pull the first present phone-ish value from a set of candidate keys. */
function firstPhone(obj: any, keys: string[]): string {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v && typeof v === "object" && typeof v.phone_number === "string") return v.phone_number;
  }
  return "";
}

export async function POST(req: Request) {
  let payload: any = {};
  try {
    payload = await req.json();
  } catch {
    /* tolerate empty/odd bodies */
  }

  // Telnyx wraps as { data: { payload: {...} } }; also accept a flat body.
  const ev = payload?.data?.payload ?? payload?.payload ?? payload ?? {};

  const dialed = firstPhone(ev, ["to", "telnyx_end_user_target", "called_number", "destination", "did"]);
  const caller = firstPhone(ev, ["from", "telnyx_agent_target", "caller_number", "origin", "ani"]);
  const engineCallId =
    ev?.call_control_id || ev?.conversation_id || ev?.call_id || ev?.telnyx_call_control_id || undefined;

  const desk = dialed ? findDeskByNumber(dialed) : undefined;
  if (!desk) {
    // No desk for this number — hand back neutral defaults so the call survives.
    return NextResponse.json({
      dynamic_variables: {
        agent_name: "the recruiter", agent_company: "our firm",
        first_name: "there", current_title: "", current_company: "", experience: "", resume: "",
      },
    });
  }

  const candidate = caller ? findCandidate(desk.id, caller) : undefined;

  // Open the call record now so the post-call webhook can attach the transcript.
  createCall({
    workspaceId: desk.workspaceId,
    deskId: desk.id,
    candidateId: candidate?.id,
    callerName: candidate ? `${candidate.firstName} ${candidate.lastName}` : undefined,
    callerPhone: caller || "unknown",
    engineCallId,
  });

  // The resume-inbox address rides into the call so the agent can speak it in
  // THE RESUME ASK. Best-effort: a cred hiccup must never drop the call.
  let resumeEmail = "";
  try {
    resumeEmail = (await withWorkspaceCreds(desk.workspaceId, async () => inboxConfig()?.user || "")) || "";
  } catch { /* blank is handled by the prompt */ }

  const resumeGaps = candidate ? resumeGapLines(candidate.id) : "";
  const vars = buildCallContext(desk, candidate, { resumeEmail, resumeGaps });
  // Return both the canonical Telnyx key and a flat copy for forward-compat.
  return NextResponse.json({ dynamic_variables: vars, ...vars });
}
