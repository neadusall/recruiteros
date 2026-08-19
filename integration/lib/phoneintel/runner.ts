/**
 * RecruitersOS · Phone Intelligence · Queue runner (the owner-gated start)
 *
 * The missing seam between the staged queue (queue.ts, pure data) and the call
 * orchestrator: the owner presses Start, THIS walks the queued items and dials
 * them, one at a time, discovery-first per company (learn the switchboard once,
 * then the rest of that company rides the cached route), pacing between calls so
 * no switchboard gets hammered. Mirrors batch.ts semantics but keeps each queue
 * item's status/callId updated so the UI can watch the run live.
 *
 * One run per workspace at a time; stop is cooperative (checked between calls).
 * Runs detached from the HTTP request that started it — the start route returns
 * immediately and the UI polls the queue + run state.
 */

import { startCall } from "./orchestrator";
import { pickFromNumber } from "./outreach";
import { activeRoute, companyKeyOf } from "./store";
import { listQueue, patchItem, ensureQueueReady, type QueueItem } from "./queue";
import { CONFIDENCE } from "./types";

export interface QueueRunState {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  placed: number;
  skipped: number;
  total: number;
  /** The item currently dialing, for the live UI. */
  currentItem?: string;
  lastError?: string;
  stopRequested?: boolean;
}

const runs: Record<string, QueueRunState> = {};

export function queueRunState(workspaceId: string): QueueRunState {
  return runs[workspaceId] ?? { running: false, placed: 0, skipped: 0, total: 0 };
}

/** Cooperative stop: the current call finishes, nothing further dials. */
export function stopQueueRun(workspaceId: string): QueueRunState {
  const st = runs[workspaceId];
  if (st?.running) st.stopRequested = true;
  return queueRunState(workspaceId);
}

export interface StartQueueOptions {
  workspaceId: string;
  /** Caller-ID lines to rotate across (E.164). */
  numberPool: string[];
  /** Ceiling on calls placed this run (default: everything queued). */
  maxCalls?: number;
  /** Seconds between calls to the SAME company (default 90). */
  perCompanyGapSec?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Start processing the queued items. Returns the initial run state immediately;
 * the loop continues in the background. Throws if a run is already active.
 */
export async function startQueueRun(opts: StartQueueOptions): Promise<QueueRunState> {
  await ensureQueueReady();
  const existing = runs[opts.workspaceId];
  if (existing?.running) throw new Error("queue_already_running");

  const items = listQueue(opts.workspaceId, "queued");
  const st: QueueRunState = {
    running: true, startedAt: new Date().toISOString(),
    placed: 0, skipped: 0, total: Math.min(items.length, opts.maxCalls ?? items.length),
  };
  runs[opts.workspaceId] = st;

  void runLoop(opts, items, st).catch((e) => {
    st.lastError = String(e?.message ?? e).slice(0, 200);
  }).finally(() => {
    st.running = false;
    st.finishedAt = new Date().toISOString();
    st.currentItem = undefined;
  });

  return st;
}

/** Discovery-first ordering per company, then walk with pacing. */
async function runLoop(opts: StartQueueOptions, items: QueueItem[], st: QueueRunState): Promise<void> {
  const sleep = opts.sleep ?? defaultSleep;
  const gap = (opts.perCompanyGapSec ?? 90) * 1000;
  const max = opts.maxCalls ?? items.length;

  // Group by routing-graph key so one company's calls stay consecutive and its
  // first (discovery) call gets the full gap before the next prospect rides it.
  const groups = new Map<string, QueueItem[]>();
  for (const it of items) {
    const key = companyKeyOf({ domain: it.domain, companyName: it.companyName });
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(it);
  }

  for (const [companyKey, group] of groups) {
    for (let i = 0; i < group.length; i++) {
      if (st.stopRequested || st.placed >= max) return;
      const it = group[i];

      const pick = pickFromNumber(
        opts.workspaceId,
        { contactId: it.contactId, companyKey, targetFull: it.full },
        opts.numberPool,
      );
      if (pick.exhausted || !pick.number) {
        // Every line burned for this contact (a live person answered them all):
        // hold rather than re-dial from a number they have already picked up.
        patchItem(opts.workspaceId, it.id, { status: "skipped", skipReason: "all_numbers_burned" });
        st.skipped += 1;
        continue;
      }

      st.currentItem = `${it.full} · ${it.companyName}`;
      patchItem(opts.workspaceId, it.id, { status: "dialing" });
      const call = await startCall({
        workspaceId: opts.workspaceId,
        companyName: it.companyName, domain: it.domain, mainPhone: it.mainPhone,
        targetFirst: it.first, targetLast: it.last, targetFull: it.full, targetTitle: it.title,
        targetContactId: it.contactId, fromNumber: pick.number,
        location: it.location, stateCode: it.stateCode,
      });
      // A compliance-blocked call comes back already failed; surface why on the item.
      const blocked = call.state === "failed" && call.events.some((e) => e.type === "BLOCKED");
      patchItem(opts.workspaceId, it.id, {
        status: blocked ? "skipped" : "done",
        callId: call.id,
        skipReason: blocked ? (call.events.find((e) => e.type === "BLOCKED")?.detail ?? "blocked") : undefined,
      });
      if (blocked) st.skipped += 1; else st.placed += 1;

      const hasRoute = () => {
        const r = activeRoute(opts.workspaceId, companyKey);
        return !!r && r.confidence >= CONFIDENCE.REDISCOVER_BELOW;
      };
      const isDiscoveryLead = i === 0 && !hasRoute();
      await sleep(isDiscoveryLead ? gap : Math.round(gap / 2));
    }
  }
}
