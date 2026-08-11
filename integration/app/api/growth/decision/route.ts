/**
 * POST /api/growth/decision   (session, tenant-scoped)
 *
 * Records the recruiter's call on a Growth Engine campaign proposal, keyed by cohort. The Growth
 * Engine reads these back and LEARNS from them:
 *   approve                 -> greenlit; keep sending the cohort
 *   reject reason=messaging -> keep the cohort, mark it for a fresh angle, re-propose differently
 *   reject reason=wrong_market -> suppress that cohort strategy, surface the next-best market
 *   reject reason=bad_contacts/weak_evidence -> rejected (planner can refresh/research next pass)
 *   snooze  (snoozeDays)    -> off the board until it elapses
 *   suppress                -> never propose or send this cohort again
 *
 * Also gates the sender: prospects in a suppressed / wrong-market / snoozed cohort are skipped.
 *
 *   body: { cohortKey, action: "approve"|"reject"|"snooze"|"suppress", reason?, snoozeDays? }
 */

import { requireSession, ok, fail, body } from "../../../../lib/api";
import { loadSnapshot, saveSnapshot } from "../../../../lib/db";

const KEY = "growth_decisions_v1";
const REASONS = ["messaging", "wrong_market", "bad_contacts", "weak_evidence", "poor_timing", "capacity"];

interface Decision { state: "approved" | "rejected" | "snoozed" | "suppressed"; reason?: string; decidedAt: string; snoozeUntil?: string; }
interface Store { workspaceId: string; decisions: Record<string, Decision>; }

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<{ cohortKey?: string; action?: string; reason?: string; snoozeDays?: number }>(req);
  if (!b?.cohortKey || !b.action) return fail("missing_fields", 422);

  const existing = await loadSnapshot<Store>(KEY);
  const store: Store = existing && existing.workspaceId === ws && existing.decisions
    ? existing
    : { workspaceId: ws, decisions: {} };

  const at = new Date().toISOString();
  let dec: Decision;
  switch (b.action) {
    case "approve": dec = { state: "approved", decidedAt: at }; break;
    case "suppress": dec = { state: "suppressed", decidedAt: at }; break;
    case "snooze": {
      const days = Math.min(Math.max(Number(b.snoozeDays) || 7, 1), 60);
      dec = { state: "snoozed", decidedAt: at, snoozeUntil: new Date(Date.now() + days * 86_400_000).toISOString() };
      break;
    }
    case "reject": {
      const reason = REASONS.includes(String(b.reason)) ? String(b.reason) : "wrong_market";
      dec = { state: "rejected", reason, decidedAt: at };
      break;
    }
    default: return fail("unknown_action", 400);
  }
  store.decisions[b.cohortKey] = dec;
  await saveSnapshot(KEY, store);
  return ok({ ok: true, decision: dec });
}
