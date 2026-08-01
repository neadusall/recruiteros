/**
 * RecruitersOS · AI Vetting · Reconciler (self-healing scoring)
 *
 * Telnyx has NO per-assistant "post-call transcript" webhook — the transcript
 * lives on the conversation and is read via the Conversations API. So rather than
 * depend on a fragile push, we PULL: every tick, this sweep finds vetting calls
 * that aren't finalized yet, locates each one's Telnyx conversation, and — once
 * the conversation has ended — pulls its transcript and runs the shared
 * `finalizeVettingCall` scorer. It is idempotent (finalize guards on state), so a
 * call is scored exactly once whether the trigger is a webhook or this sweep.
 *
 * The ONE genuinely Telnyx-shape-dependent step — matching a conversation to our
 * call and reading its status/id — is isolated in the small helpers below, each
 * shape-tolerant and logged, so a live test call lets us tighten them fast.
 *
 * Driven by `POST /api/vetting/cron` on a ~1-3 min schedule.
 */

import { telnyx } from "../providers";
import { withWorkspaceCreds } from "../connected";
import { listCallsNeedingScore, getDeskById, updateCall, ensureVettingReady } from "./store";
import { finalizeVettingCall } from "./finalize";
import { parseConversationMessages } from "./transcript";
import type { VettingCall } from "./types";

/** A call this old whose conversation looks ended is scored even if status is fuzzy. */
const STALE_MS = 15 * 60_000;
/** No usable conversation this long after start → close the call as failed. */
const ABANDON_MS = 45 * 60_000;

/** Log the real Telnyx conversation shape only once per process (bring-up aid). */
let loggedShape = false;

function ageMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Date.now() - t : 0;
}

/** Tolerant: does this conversation object belong to our call_control_id? */
export function conversationMatches(convo: any, engineCallId: string): boolean {
  const m = convo?.metadata ?? convo;
  const id =
    m?.call_control_id ??
    m?.telnyx_call_control_id ??
    convo?.call_control_id ??
    convo?.telnyx_call_control_id;
  return Boolean(id) && String(id) === String(engineCallId);
}

/** Tolerant: has this conversation finished, so its transcript is complete? */
export function conversationEnded(convo: any): boolean {
  const s = String(convo?.status ?? convo?.state ?? "").toLowerCase();
  if (["ended", "completed", "finished", "closed", "hangup", "done"].some((x) => s.includes(x))) return true;
  return Boolean(convo?.ended_at || convo?.end_time || convo?.finished_at || convo?.completed_at);
}

/**
 * Find the Telnyx conversation for a call. Tries a metadata filter first (fast),
 * then falls back to scanning recent conversations and matching by call id — so
 * we're robust to the filter param varying across Telnyx versions.
 */
async function findConversation(engineCallId: string): Promise<any | null> {
  try {
    const filtered: any = await telnyx.listConversations({
      "filter[metadata][call_control_id]": engineCallId,
    });
    if (!filtered?.dryRun) {
      const data: any[] = Array.isArray(filtered?.data) ? filtered.data : [];
      const hit = data.find((c) => conversationMatches(c, engineCallId)) ?? (data.length === 1 ? data[0] : undefined);
      if (hit) return hit;
    } else {
      return null; // dry-run: no live Telnyx
    }
  } catch {
    /* fall through to scan */
  }
  try {
    const recent: any = await telnyx.listConversations({ "page[size]": 100 });
    if (recent?.dryRun) return null;
    const data: any[] = Array.isArray(recent?.data) ? recent.data : [];
    return data.find((c) => conversationMatches(c, engineCallId)) ?? null;
  } catch {
    return null;
  }
}

async function reconcileOne(call: VettingCall): Promise<"scored" | "failed" | "waiting"> {
  const desk = getDeskById(call.deskId);
  if (!desk) return "waiting"; // desk deleted mid-flight; nothing to score against

  const convo = call.engineCallId ? await findConversation(call.engineCallId) : null;
  const old = ageMs(call.startedAt);

  if (!convo) {
    if (old > ABANDON_MS) {
      updateCall(call.id, {
        status: "failed",
        summary: "No Telnyx conversation was found for this call.",
        endedAt: new Date().toISOString(),
      });
      return "failed";
    }
    return "waiting"; // conversation may not have materialized yet — try next sweep
  }

  // First sighting of the real shape — log keys ONCE so we can tighten the helpers.
  if (!loggedShape) {
    loggedShape = true;
    console.info("[vetting:reconcile] conversation keys:", Object.keys(convo || {}));
  }

  if (!conversationEnded(convo) && old < STALE_MS) return "waiting";

  // Pull the transcript from the conversation; keep whatever we already had on failure.
  let transcript = call.transcript ?? [];
  const convoId = convo?.id ?? convo?.conversation_id;
  if (convoId) {
    try {
      const msgs: any = await telnyx.getConversationMessages(String(convoId));
      if (!msgs?.dryRun) {
        const parsed = parseConversationMessages(msgs);
        if (parsed.length) transcript = parsed;
      }
    } catch {
      /* keep prior transcript */
    }
  }

  const recordingUrl = convo?.recording_url ?? convo?.recording?.url ?? call.recordingUrl;
  const durationSec = typeof convo?.duration_sec === "number" ? convo.duration_sec : call.durationSec;

  await finalizeVettingCall({ call, desk, transcript, recordingUrl, durationSec });
  return "scored";
}

export interface ReconcileSummary {
  scanned: number;
  scored: number;
  failed: number;
  waiting: number;
}

/**
 * One reconciliation sweep across all workspaces. Uses each workspace's OWN
 * Telnyx credentials (never the operator's) via withWorkspaceCreds. Never throws
 * — a single bad call is logged and skipped so the rest still process.
 */
export async function reconcilePendingVettingCalls(): Promise<ReconcileSummary> {
  await ensureVettingReady();
  const pending = listCallsNeedingScore();
  const summary: ReconcileSummary = { scanned: pending.length, scored: 0, failed: 0, waiting: 0 };

  // Group by workspace so each batch runs under the right Telnyx key.
  const byWorkspace = new Map<string, VettingCall[]>();
  for (const c of pending) {
    const list = byWorkspace.get(c.workspaceId) ?? [];
    list.push(c);
    byWorkspace.set(c.workspaceId, list);
  }

  for (const [workspaceId, calls] of byWorkspace) {
    await withWorkspaceCreds(workspaceId, async () => {
      for (const call of calls) {
        try {
          const outcome = await reconcileOne(call);
          summary[outcome] += 1;
        } catch (e: any) {
          summary.waiting += 1;
          console.error("[vetting:reconcile] call", call.id, "failed:", e?.message || e);
        }
      }
    });
  }

  return summary;
}
