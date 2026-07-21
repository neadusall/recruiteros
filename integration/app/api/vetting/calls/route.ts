/**
 * AI Vetting · Calls API
 *   GET /api/vetting/calls?deskId=   -> scored inbound calls for a desk (newest first)
 *   GET /api/vetting/calls?id=       -> one call with full transcript + scorecard
 *
 * Session-gated; read-only. The scoring itself happens in the post-call webhook
 * (see /api/vetting/webhook); this is the recruiter-facing read surface that the
 * AI Vetting tab renders.
 */

import { requireSession, ok, fail } from "../../../../lib/api";
import { listCalls, getCall, listCandidates, runChaseTick } from "../../../../lib/vetting";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  // Self-heal: opening the calls view converges the resume-chase ladder (same
  // idiom as the resume inbox GET). Coalesced + windowed inside; fire-and-forget.
  void runChaseTick().catch(() => {});
  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (id) {
    const call = getCall(ws, id);
    if (!call) return fail("not_found", 404);
    return ok({ call });
  }

  const deskId = url.searchParams.get("deskId") || undefined;
  const candidates = listCandidates(ws, deskId);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const calls = listCalls(ws, deskId).map((c) => {
    const cand = c.candidateId ? byId.get(c.candidateId) : undefined;
    return {
      ...c,
      // Trim the transcript out of the list payload; the detail fetch carries it.
      transcript: undefined,
      transcriptTurns: c.transcript.length,
      candidate: cand ? { firstName: cand.firstName, lastName: cand.lastName, linkedinUrl: cand.linkedinUrl, email: cand.email } : undefined,
    };
  });
  return ok({ calls });
}
