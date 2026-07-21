/**
 * AI Vetting · Opt-in API  (PUBLIC — no session)
 *   POST /api/vetting/optin   -> a candidate opts in for a desk's number
 *   GET  /api/vetting/optin?deskId=  -> minimal desk info to render a form
 *
 * This is the sink for the candidate opt-in form (which the operator may host on
 * their own domain), so it is intentionally sessionless and CORS-open. It stores
 * the candidate keyed to the desk by phone, then enriches their LinkedIn so the
 * agent has talking points when they call. The desk id encodes the workspace, so
 * no auth is needed to attribute the submission.
 *
 * We never reveal a desk's internals here — GET returns only the public-facing
 * role title/company for form display.
 */

import { NextResponse } from "next/server";
import { body } from "../../../../lib/api";
import {
  getDeskById, upsertCandidate, setCandidateEnrichment, enrichCandidate,
  pairCandidateToDeskJd,
} from "../../../../lib/vetting";

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

export function GET(req: Request) {
  const deskId = new URL(req.url).searchParams.get("deskId");
  if (!deskId) return json({ error: "missing_deskId" }, 422);
  const desk = getDeskById(deskId);
  if (!desk) return json({ error: "not_found" }, 404);
  return json({
    desk: {
      id: desk.id,
      roleTitle: desk.roleTitle,
      clientCompany: desk.clientCompany,
      agentName: desk.persona.agentName,
      agentCompany: desk.persona.agentCompany,
      phoneNumber: desk.phoneNumber,
      accepting: desk.status === "live",
    },
  });
}

interface OptinBody {
  deskId?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  linkedinUrl?: string;
}

export async function POST(req: Request) {
  const b = await body<OptinBody>(req);
  const deskId = b?.deskId?.trim();
  if (!deskId) return json({ error: "missing_deskId" }, 422);

  const desk = getDeskById(deskId);
  if (!desk) return json({ error: "not_found" }, 404);

  const firstName = b?.firstName?.trim();
  const lastName = b?.lastName?.trim();
  const phone = b?.phone?.trim();
  const email = b?.email?.trim();
  if (!firstName || !lastName || !phone || !email) {
    return json({ error: "missing_fields", needs: ["firstName", "lastName", "phone", "email"] }, 422);
  }

  const candidate = upsertCandidate(desk.workspaceId, {
    deskId: desk.id, firstName, lastName, phone, email, linkedinUrl: b?.linkedinUrl,
  });

  // Job Library pairing: this person is now tied to this desk's JD, so the
  // match follows them everywhere. Fire-and-forget by design.
  void pairCandidateToDeskJd(desk, { email, phone, name: `${firstName} ${lastName}` }, "vetting");

  // Enrich in line (best-effort, never throws) so the agent has talking points
  // the moment they call. Degrades to source:"none" when LinkedIn isn't keyed.
  const enrichment = await enrichCandidate(candidate.linkedinUrl);
  setCandidateEnrichment(candidate.id, enrichment);

  return json({
    ok: true,
    callNumber: desk.phoneNumber || null,
    message: desk.phoneNumber
      ? `Thanks ${firstName}. Give us a call at ${desk.phoneNumber} when you're ready and we'll talk through the ${desk.roleTitle || "role"}.`
      : `Thanks ${firstName}. We'll be in touch with a number to call shortly.`,
    enriched: enrichment.source !== "none",
  });
}
