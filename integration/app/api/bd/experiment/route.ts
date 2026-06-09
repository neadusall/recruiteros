/**
 * GET /api/bd/experiment
 * The A/B scoreboard for the two outreach models — "mpc" (Most Placeable
 * Candidate, forward) vs "consultative" (advisory). Returns each variant's
 * enrolled -> engaged -> booked funnel and book-rate, plus the current winner
 * once both arms have enough volume. Bearer-authed (RECRUITEROS_API_TOKEN).
 *
 * Book-rate is the north-star metric: it decides which model fills the calendar.
 */

import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/linkedin/auth";
import { ensureExperimentReady, report } from "../../../../lib/bd/experiment";

export async function GET(req: Request) {
  const auth = requireAuth(req);
  if (!auth.ok) return auth.response;
  await ensureExperimentReady();
  return NextResponse.json({ ok: true, ...report() });
}
