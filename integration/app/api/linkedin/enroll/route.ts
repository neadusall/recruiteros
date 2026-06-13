/**
 * POST /api/linkedin/enroll
 * Enroll a prospect into a LinkedIn sequence on a given account.
 *
 * Body: { prospect: Prospect, sequenceId: string, accountId: string }
 * Returns: { enrollment: Enrollment }
 *
 * This is the primary call RecruitersOS makes to start LinkedIn outreach.
 */

import { NextResponse } from "next/server";
import { SequenceEngine } from "../../../../lib/linkedin/sequenceEngine";
import { getRepository } from "../../../../lib/linkedin/repository";
import { requireAuth } from "../../../../lib/linkedin/auth";
import type { Prospect } from "../../../../lib/linkedin/types";

export async function POST(req: Request) {
  const auth = requireAuth(req);
  if (!auth.ok) return auth.response;

  let body: { prospect?: Prospect; sequenceId?: string; accountId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { prospect, sequenceId, accountId } = body;
  if (!prospect?.id || !sequenceId || !accountId) {
    return NextResponse.json(
      { error: "missing_fields", detail: "prospect, sequenceId and accountId are required" },
      { status: 422 },
    );
  }

  const repo = getRepository();
  const [sequence, account] = await Promise.all([
    repo.getSequence(sequenceId),
    repo.getAccount(accountId),
  ]);
  if (!sequence) return NextResponse.json({ error: "sequence_not_found" }, { status: 404 });
  if (!account) return NextResponse.json({ error: "account_not_found" }, { status: 404 });
  if (account.status === "restricted" || account.status === "disconnected") {
    return NextResponse.json({ error: "account_unavailable", status: account.status }, { status: 409 });
  }

  // Snapshot the prospect so the engine can personalize against it at run time.
  await repo.saveProspect(prospect);

  const engine = new SequenceEngine(repo);
  const enrollment = await engine.enroll(prospect, sequence, account);
  return NextResponse.json({ enrollment }, { status: 201 });
}
