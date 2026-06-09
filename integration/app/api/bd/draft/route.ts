/**
 * POST /api/bd/draft
 * Generate the full persona-, industry-, and trigger-grounded BD outreach package
 * for one executive lead — the content brain behind the omnichannel funnel.
 * Bearer-authed (RECRUITEROS_API_TOKEN); the scheduler / n8n / enroll-queue calls
 * this to populate a prospect's per-channel content before the channels fire.
 *
 * Body: { lead?, prospect?, sender?, callbackNumber?, hiringActivity?, companyContext?, profileSummary?, renderAudio? }
 *   - Pass EITHER a raw `lead` (BdLead) OR a core `prospect` (mapped to a lead).
 *   - hiringActivity: the REAL observed signal (the symptom) that surfaced the lead.
 *   - profileSummary: the prospect's own background (grounds the message in their experience).
 *   - renderAudio !== false: also synthesize the LinkedIn voice-note script into a clip.
 *
 * Returns the n8n-ready flat fields plus the full reasoning package. The engine
 * generalizes to ANY industry/title and never fabricates facts (see lib/bd/*).
 */

import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/linkedin/auth";
import { type BdLead } from "../../../../lib/bd/personaMessaging";
import { draftContent, leadFromProspect } from "../../../../lib/bd/draftContent";
import type { Prospect } from "../../../../lib/core/types";

export async function POST(req: Request) {
  const auth = requireAuth(req);
  if (!auth.ok) return auth.response;

  let body: {
    lead?: BdLead;
    prospect?: Partial<Prospect>;
    sender?: string;
    callbackNumber?: string;
    hiringActivity?: string;
    companyContext?: string;
    profileSummary?: string;
    renderAudio?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const lead: BdLead | undefined = body.lead
    ? body.lead
    : body.prospect
      ? leadFromProspect(body.prospect, body)
      : undefined;
  if (!lead || (!lead.title && !lead.company)) {
    return NextResponse.json(
      { error: "missing_fields", detail: "a lead/prospect with at least a title or company is required" },
      { status: 422 },
    );
  }

  try {
    const payload = await draftContent(lead, { renderAudio: body.renderAudio });
    return NextResponse.json(payload);
  } catch (e: any) {
    return NextResponse.json({ error: "generation_failed", detail: e?.message ?? String(e) }, { status: 502 });
  }
}
