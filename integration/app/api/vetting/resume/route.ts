/**
 * AI Vetting · Resume coaching API  (PUBLIC — no session)
 *   GET  /api/vetting/resume?desk=&cid=   -> role + must-haves + the candidate's
 *                                            latest coverage, to render the page
 *   POST /api/vetting/resume              -> candidate submits an updated resume;
 *                                            we score it vs the must-haves
 *                                            (semantically), email them tactful
 *                                            coaching, and return the coverage so
 *                                            the page updates live
 *
 * This is the candidate-facing side of the coaching loop, so it is intentionally
 * sessionless and CORS-open (the operator may host the page on their own domain).
 * The candidate is identified by their id from the link we emailed them; the desk
 * id carries the workspace, so no auth is needed to attribute the submission. We
 * never reveal desk internals beyond the public role info + the requirements.
 */

import { NextResponse } from "next/server";
import { body } from "../../../../lib/api";
import {
  getDeskById, getCandidateById, setCandidateResume, addResumeReview,
  markReviewEmailSent, latestResumeReview, reviewResume,
} from "../../../../lib/vetting";
import { sendWorkspaceEmail } from "../../../../lib/auth";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: CORS });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/** Public must-have view for the candidate page — prompt + whether it's a hard gate. */
function publicMustHaves(deskQuestions: { id: string; prompt: string; mustHave: boolean }[]) {
  return deskQuestions.map((q) => ({ id: q.id, requirement: q.prompt, mustHave: q.mustHave }));
}

export function GET(req: Request) {
  const url = new URL(req.url);
  const deskId = url.searchParams.get("desk");
  const cid = url.searchParams.get("cid");
  if (!deskId) return json({ error: "missing_desk" }, 422);

  const desk = getDeskById(deskId);
  if (!desk) return json({ error: "not_found" }, 404);

  const candidate = cid ? getCandidateById(cid) : undefined;
  const last = candidate ? latestResumeReview(candidate.id) : undefined;

  return json({
    desk: {
      id: desk.id,
      roleTitle: desk.roleTitle,
      clientCompany: desk.clientCompany,
      agentName: desk.persona.agentName,
      agentCompany: desk.persona.agentCompany,
    },
    candidate: candidate ? { id: candidate.id, firstName: candidate.firstName } : null,
    mustHaves: publicMustHaves(desk.questions),
    latest: last
      ? { round: last.round, allMet: last.allMet, gaps: last.gaps, summary: last.summary, coverage: last.coverage }
      : null,
  });
}

interface ResumeBody {
  deskId?: string;
  candidateId?: string;
  resumeText?: string;
}

export async function POST(req: Request) {
  const b = await body<ResumeBody>(req);
  const deskId = b?.deskId?.trim();
  const candidateId = b?.candidateId?.trim();
  const resumeText = (b?.resumeText ?? "").trim();

  if (!deskId) return json({ error: "missing_deskId" }, 422);
  if (!resumeText || resumeText.length < 80) {
    return json({ error: "resume_too_short", message: "Paste your full resume text so we can review it against the role." }, 422);
  }

  const desk = getDeskById(deskId);
  if (!desk) return json({ error: "not_found" }, 404);

  const candidate = candidateId ? getCandidateById(candidateId) : undefined;
  if (candidate) setCandidateResume(candidate.id, resumeText);

  let result;
  try {
    result = await reviewResume(desk, resumeText, candidate);
  } catch (e: any) {
    const status = e?.status === 409 ? 503 : 500;
    return json({ error: "review_unavailable", message: e?.message || "Could not review the resume right now." }, status);
  }

  // Record the round (self-numbering) when we know who submitted it.
  let reviewId: string | undefined;
  if (candidate) {
    const rec = addResumeReview({
      workspaceId: desk.workspaceId,
      deskId: desk.id,
      candidateId: candidate.id,
      resumeText,
      coverage: result.coverage,
      allMet: result.allMet,
      gaps: result.gaps,
      summary: result.summary,
      emailSubject: result.emailSubject,
      emailBody: result.emailBody,
      emailSent: false,
    });
    reviewId = rec.id;

    // Email the coaching back (best-effort) so the loop continues off-page too.
    if (candidate.email) {
      try {
        await sendWorkspaceEmail(candidate.email, result.emailSubject, result.emailBody, desk.workspaceId);
        markReviewEmailSent(rec.id);
      } catch (mailErr: any) {
        console.error("[vetting] resume coaching email failed:", mailErr?.message || mailErr);
      }
    }
  }

  return json({
    ok: true,
    reviewId,
    allMet: result.allMet,
    gaps: result.gaps,
    summary: result.summary,
    coverage: result.coverage,
  });
}
