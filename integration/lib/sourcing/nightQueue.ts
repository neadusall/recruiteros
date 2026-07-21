/**
 * RecruitersOS · JD Sourcing · Overnight queue.
 *
 * Queue searches (or enrichment of an existing saved list) and walk away: a cron tick
 * advances the queue entirely SERVER-SIDE, so runs finish overnight with no browser
 * tab open, and the recruiter wakes up to enriched lists. One item LEADS at a time,
 * FIFO — but the worker runs one browser session per VENDOR (Laxis / KoldInfo), so
 * while the lead item waits on one vendor's job, the tick loop gives the next item
 * (never one sharing the lead's run) steps that can use the other vendor's lane.
 *
 * Each item is a small state machine over the SAME rungs the hands-free UI chain uses,
 * and it parks job refs on the run itself (koldJob / koldDbJob / laxisJob /
 * laxisProgress), so the saved-list enrichment chip stays truthful for queue-driven
 * runs and a queue item can even resume a chain the UI started (and vice versa).
 *
 *   queued -> search (kind:"search" only) -> kold -> koldDb -> laxis(+gap-fill) -> done
 *   queued -> [kold -> koldDb -> laxis if not fully enriched] -> boost -> done   (kind:"boost")
 *
 * kind:"boost" is the recruiter-approved paid phone run: pressing Boost on several
 * lists queues them here, so they run one after another with no babysitting, and a
 * list that is not fully enriched gets the free chain finished FIRST (free rungs may
 * still fill rows the paid lookup would otherwise bill for).
 *
 * Deliberately NOT automated: promote / Send to OS Text. Outbound stays a human
 * decision; the queue's job is data, not sending.
 *
 * Durability: the queue snapshots to the same store as saved runs; worker jobs persist
 * on the worker's own volume. A redeploy mid-item just means the next tick re-polls.
 */

import { rid, nowIso } from "../core/ids";
import { loadSnapshot, saveSnapshot } from "../db";
import type { CandidateRow, SearchBreadth, SourcingRun } from "./types";
import { getSourcingRun, saveSourcingRun } from "./store";
import { parseJobDescription } from "./parseJobDescription";
import { pinIcpLocation } from "./pinLocation";
import { parseRadiusMi } from "./geoRadius";
import { generateQueries } from "./generateQueries";
import { runDiscovery } from "./discovery";
import { getSeenKeys, addSeenKeys } from "./seen";
import {
  laxisWorkerConfigured, koldinfoWorkerReady, serializeCandidatesCsv,
  submitLaxisJob, getLaxisJob, mergeEnrichedCsv, MAX_LAXIS_UPLOAD,
} from "./laxis";
import { buildSourcingKoldInfoCsv, mergeSourcingKoldInfoCsv, buildKoldInfoDbCsv } from "./koldinfo";
import { gapFillContacts } from "./gapfill";
import { runPremiumPhoneBoost } from "./premiumPhone";
import { withWorkspaceCreds } from "../connected";

const KEY = "sourcing_night_queue_v1";

export type NightStage = "queued" | "search" | "kold" | "koldDb" | "laxis" | "boost" | "done" | "error";

export interface NightItem {
  id: string;
  workspaceId: string;
  kind: "search" | "enrich" | "boost";
  /** List name (becomes the saved run's name for kind:"search"). */
  name: string;
  jd?: string;
  location?: string;
  breadth?: SearchBreadth;
  outsideGeo?: boolean;
  /** The saved run being enriched (given for kind:"enrich", set after the search saves). */
  runId?: string;
  /** kind:"search" only: the recruiter who queued it, stamped onto the saved run
   *  so the auto-send credits the campaign to them (not the workspace owner). */
  createdBy?: { userId: string; name: string; email: string };
  stage: NightStage;
  /** Plain-English progress line for the queue card. */
  note?: string;
  error?: string;
  /** Contacts gained across the whole chain (for the morning readout). */
  added: { emails: number; phones: number };
  /** One-shot retry markers per rung, so a transient worker death (a deploy
   *  recreating the container kills Chromium mid-job) re-runs the rung ONCE
   *  instead of silently abandoning its remaining rows. */
  retried?: Partial<Record<"kold" | "koldDb", boolean>>;
  /** kind:"boost" only: the recruiter-approved paid phone run. Queued presses on
   *  several lists run back-to-back with no babysitting: one at a time (the queue's
   *  invariant), each finishing the FREE enrichment chain first if the list is not
   *  fully enriched, then buying in batches until the approved count is reached or
   *  the monthly budget stops it. The actor rides on the item because the batches
   *  run on cron ticks, long after the request that queued them is gone, and every
   *  cent must still land on the recruiter who pressed Go. */
  boost?: {
    wanted: number;
    /** Lookups completed so far (billed calls + free cache fills). */
    done: number;
    /** Phones added so far. */
    found: number;
    costUsd: number;
    actorUserId?: string;
    actorEmail: string;
  };
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

/**
 * Where a queued boost item enters the state machine. Pure so the regression
 * suite (scripts/test-sourcing-nightqueue.mts) can pin the routing:
 *  - a free rung parked mid-flight on the run is RESUMED, not restarted;
 *  - an unfinished chunk ledger re-enters at the final (laxis) pass;
 *  - a never-enriched list runs the whole free chain first (the list must be
 *    properly enriched before any paid lookup);
 *  - only a provably finished chain goes straight to buying. The KoldInfo rungs
 *    are never re-submitted on a finished chain: that would re-spend vendor
 *    tokens on rows they already failed to fill.
 */
export function boostEntryStage(
  run: Pick<SourcingRun, "koldJob" | "koldDbJob" | "laxisJob" | "laxisProgress" | "autoflow" | "promotedCount" | "promotedListId">,
): Extract<NightStage, "kold" | "koldDb" | "laxis" | "boost"> {
  if (run.koldJob) return "kold";
  if (run.koldDbJob) return "koldDb";
  if (run.laxisJob || (run.laxisProgress && run.laxisProgress.nextStart !== null)) return "laxis";
  const enrichRan = Boolean(run.laxisProgress || run.autoflow?.sentAt || run.promotedCount || run.promotedListId);
  return enrichRan ? "boost" : "kold";
}

/** A worker error worth ONE rung re-run: the job vanished (retention/volume) or
 *  the browser was killed under it (deploy recreate, crash) mid-run. Distinct
 *  from data errors, which retrying would just repeat. */
function retryableJobError(error: string): boolean {
  return /job_not_found|browser_died|browser has been closed|target (page|crashed)|browser crashed/i.test(error);
}

let store: NightItem[] = [];
let hydrated = false;
let hydrating: Promise<void> | null = null;

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<NightItem[]>(KEY);
      if (Array.isArray(snap)) store = snap;
      hydrated = true;
    })();
  }
  return hydrating;
}
async function save(): Promise<void> {
  await saveSnapshot(KEY, store);
}

export async function listNightItems(workspaceId: string): Promise<NightItem[]> {
  await hydrate();
  return store.filter((i) => i.workspaceId === workspaceId);
}

export interface NightAddInput {
  kind: "search" | "enrich" | "boost";
  name: string;
  jd?: string;
  location?: string;
  breadth?: SearchBreadth;
  outsideGeo?: boolean;
  runId?: string;
  /** kind:"search" only: the recruiter queueing it (becomes the run's createdBy). */
  createdBy?: { userId: string; name: string; email: string };
  /** kind:"boost" only: approved lookup count + the recruiter the spend bills to. */
  boost?: { wanted: number; actorUserId?: string; actorEmail: string };
}

export async function addNightItem(workspaceId: string, input: NightAddInput): Promise<NightItem> {
  await hydrate();
  const item: NightItem = {
    id: rid("nq"),
    workspaceId,
    kind: input.kind,
    name: input.name,
    jd: input.jd,
    location: input.location,
    breadth: input.breadth,
    outsideGeo: input.outsideGeo,
    runId: input.runId,
    createdBy: input.createdBy,
    boost: input.kind === "boost" && input.boost ? {
      wanted: Math.max(1, Math.round(input.boost.wanted)),
      done: 0, found: 0, costUsd: 0,
      actorUserId: input.boost.actorUserId,
      actorEmail: input.boost.actorEmail,
    } : undefined,
    stage: "queued",
    added: { emails: 0, phones: 0 },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.push(item);
  await save();
  // Start work right away (fire-and-forget): the queue is "overnight" because items
  // FINISH unattended, not because they wait for a clock.
  void tickNightQueue().catch(() => {});
  return item;
}

export async function removeNightItem(workspaceId: string, id: string): Promise<boolean> {
  await hydrate();
  const i = store.findIndex((x) => x.id === id && x.workspaceId === workspaceId);
  if (i < 0) return false;
  store.splice(i, 1);
  await save();
  return true;
}

/* ------------------------------------------------------------------------- */
/* processor                                                                  */
/* ------------------------------------------------------------------------- */

function touch(item: NightItem, note?: string): void {
  item.updatedAt = nowIso();
  if (note !== undefined) item.note = note;
}
function finish(item: NightItem, stage: "done" | "error", error?: string): void {
  item.stage = stage;
  item.error = error;
  item.finishedAt = nowIso();
  touch(item, stage === "done"
    ? `finished: ${item.added.emails} email(s) + ${item.added.phones} phone(s) added`
    : undefined);
}

/** Boost items ride the SAME free-chain stages first (a half-enriched list must be
 *  properly enriched before money is spent on rows the free rungs may still fill);
 *  when that chain completes they move on to buying instead of finishing. */
function chainDone(item: NightItem): void {
  if (item.kind === "boost") {
    item.stage = "boost";
    touch(item, "free enrichment finished, starting the paid phone lookups…");
    return;
  }
  finish(item, "done");
}

/** Finish a boost item "done" with its own readout (phones + real cost), which the
 *  queue card prints verbatim. */
function finishBoost(item: NightItem, note: string): void {
  item.stage = "done";
  item.finishedAt = nowIso();
  touch(item, note);
}

/** First grid offset below `total` not yet enriched (mirrors the route's resume rule). */
function nextOffset(doneOffsets: number[], total: number, step: number): number | null {
  if (step <= 0) return null;
  for (let o = 0; o < total; o += step) if (!doneOffsets.includes(o)) return o;
  return null;
}

/** Remember that a chunk was completed WITHOUT its Laxis pass (worker down), so the
 *  Enrich button can re-open exactly these offsets once Laxis is back. */
function rememberLaxisSkip(run: SourcingRun, start: number, error: string): void {
  const skipped = run.laxisSkipped ?? { offsets: [], error, at: nowIso() };
  if (!skipped.offsets.includes(start)) skipped.offsets.push(start);
  skipped.error = error;
  skipped.at = nowIso();
  run.laxisSkipped = skipped;
}

/** A worker failure that will hit every subsequent chunk too (login wall, missing
 *  credentials, structural UI change), as opposed to a one-off job hiccup. */
function laxisFatal(error: string): boolean {
  return /login_failed|credentials_missing|login_form_not_found|step_unresolved/i.test(error);
}

let ticking = false;
let tickingSince = 0;

/** A step wedged past this is presumed hung (vendor call that never resolved); the
 *  latch is stolen so the queue keeps moving instead of freezing until a redeploy. */
const TICK_STEAL_MS = 15 * 60 * 1000;

/** How long a finished item stays on the card so the morning readout is seeable. */
export const DONE_LINGER_MS = 60 * 60 * 1000;
/** Finished but never confirmed delivered (e.g. a BD-motion list the autoflow
 *  sweeper deliberately skips): clear after a day rather than pile up forever. */
export const DONE_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * The queue card is a WORKING queue, not a history log: the saved list under
 * "Your saved candidate lists" is the permanent record (journey strip included).
 * A done item lingers an hour, then drops off once its run is confirmed sent to
 * Candidates + OS Text (autoflow.sentAt); undelivered done items clear after a
 * day. Stopped ("error") items stay until the user removes them. Pure so the
 * regression suite (scripts/test-sourcing-nightqueue.mts) can pin the rules.
 */
export function pruneDecision(
  i: Pick<NightItem, "stage" | "finishedAt" | "updatedAt" | "createdAt">,
  delivered: boolean,
  now: number,
): "keep" | "drop" {
  if (i.stage !== "done") return "keep";
  const finished = Date.parse(i.finishedAt ?? i.updatedAt ?? i.createdAt);
  // An unparseable timestamp counts as age 0: never drop on bad data.
  const age = Number.isFinite(finished) ? now - finished : 0;
  if (age <= DONE_LINGER_MS) return "keep";
  return delivered || age > DONE_MAX_MS ? "drop" : "keep";
}

async function pruneFinished(): Promise<void> {
  const now = Date.now();
  let changed = false;
  for (const i of [...store]) {
    if (i.stage !== "done") continue;
    // delivered=true is the most drop-eager case, so "keep" here means the
    // linger hasn't passed yet: skip the run lookup (cheap ticks stay cheap).
    if (pruneDecision(i, true, now) === "keep") continue;
    let delivered = false;
    if (i.runId) {
      try {
        const run = await getSourcingRun(i.workspaceId, i.runId);
        delivered = Boolean(run?.autoflow?.sentAt);
      } catch { /* store hiccup: leave the item, retry next tick */ }
    }
    if (pruneDecision(i, delivered, now) === "drop") {
      const at = store.indexOf(i);
      if (at >= 0) store.splice(at, 1);
      changed = true;
    }
  }
  if (changed) await save();
}

/** How long one tick keeps chaining steps before yielding to the next timer hit.
 *  Well under TICK_STEAL_MS, so a live tick is never mistaken for a hung one. */
const TICK_BUDGET_MS = 100_000;
/** In-tick re-poll cadence while a worker job is running (the timer alone would
 *  make every poll wait a whole timer interval). */
const POLL_WAIT_MS = 10_000;

/** Everything about an item's position in its chain that a step can advance. When
 *  this is unchanged after a step and no worker job is in flight, the tick yields. */
async function progressSig(item: NightItem): Promise<string> {
  let jobs = "";
  if (item.runId) {
    try {
      const run = await getSourcingRun(item.workspaceId, item.runId);
      jobs = [
        run?.koldJob?.jobId, run?.koldDbJob?.jobId, run?.laxisJob?.jobId,
        run?.laxisProgress?.doneOffsets.length,
      ].join("|");
    } catch { jobs = "unreadable"; }
  }
  return [item.id, item.stage, item.runId ?? "", item.boost?.done ?? 0, jobs].join("|");
}

/** Is this item just waiting on the browser worker to finish a submitted job? */
async function waitingOnWorker(item: NightItem): Promise<boolean> {
  if (!item.runId) return false;
  if (item.stage !== "kold" && item.stage !== "koldDb" && item.stage !== "laxis") return false;
  try {
    const run = await getSourcingRun(item.workspaceId, item.runId);
    return Boolean(run && (run.koldJob || run.koldDbJob || run.laxisJob));
  } catch {
    return false;
  }
}

/**
 * Advance the queue: process the first active item in bounded steps (submit a job,
 * poll a job, or run the search). One tick CHAINS steps for up to TICK_BUDGET_MS —
 * cheap stage transitions run back-to-back and a running worker job is re-polled
 * every POLL_WAIT_MS in-tick — so a finished job's merge, the next chunk's submit,
 * and the next stage all happen within seconds instead of each waiting for its own
 * timer hit. A mutex makes overlapping timer hits harmless. Long work runs inside
 * the tick, so the caller should fire-and-forget rather than await.
 */
export async function tickNightQueue(): Promise<{ active: number }> {
  await hydrate();
  // Sweep BEFORE the active-work check: a queue holding only finished items
  // still needs its ticks to clear them off the card.
  await pruneFinished().catch((e) => console.warn("[night-queue] prune failed:", (e as Error).message));
  const active = store.filter((i) => i.stage !== "done" && i.stage !== "error");
  if (!active.length) return { active: 0 };
  if (ticking) {
    if (Date.now() - tickingSince < TICK_STEAL_MS) return { active: active.length };
    console.warn("[night-queue] tick latch held >15min, stealing (a step hung mid-flight)");
  }
  ticking = true;
  tickingSince = Date.now();
  let item = await pickNext(active);
  try {
    const deadline = Date.now() + TICK_BUDGET_MS;
    for (;;) {
      const before = await progressSig(item);
      await step(item);
      // Persist after EVERY step, not just at tick end: step() already saved the
      // run's own state, and losing the item's matching stage to a crash would
      // re-run rungs the run no longer needs.
      try { await save(); } catch (e) { console.warn("[night-queue] snapshot save failed:", (e as Error).message); }
      if (Date.now() >= deadline) break;
      const activeNow = store.filter((i) => i.stage !== "done" && i.stage !== "error");
      if (!activeNow.length) break;
      const nextItem = await pickNext(activeNow);
      if (nextItem !== item) { item = nextItem; continue; } // previous item finished: keep draining
      if ((await progressSig(item)) !== before) continue;   // real progress: chain the next step now
      if (await waitingOnWorker(item)) {
        // Job still running on the worker. That wait is now usable time: the
        // worker runs one browser session PER VENDOR (Laxis / KoldInfo lanes),
        // so while this item's job holds one lane, give the next active item a
        // step too — its other-vendor rung, search, or boost work runs in the
        // idle window, and a same-lane submit just queues FIFO on the worker.
        // ONE companion at a time, and never one sharing this item's run: two
        // items polling the same run's job refs could double-merge a result.
        const companions = store.filter((i) =>
          i !== item && i.stage !== "done" && i.stage !== "error" &&
          (!i.runId || !item.runId || i.runId !== item.runId));
        if (companions.length) {
          const companion = await pickNext(companions);
          try {
            await step(companion);
            try { await save(); } catch (e) { console.warn("[night-queue] snapshot save failed:", (e as Error).message); }
          } catch (e) {
            touch(companion, `retrying: ${(e as Error).message?.slice(0, 140) ?? "step failed"}`);
          }
        }
        // Short in-tick wait, then re-poll this item's job.
        if (Date.now() + POLL_WAIT_MS >= deadline) break;
        await new Promise((res) => setTimeout(res, POLL_WAIT_MS));
        continue;
      }
      break; // no progress and nothing to poll (e.g. waiting on a lock): yield to the timer
    }
  } catch (e) {
    // A step that throws is retried next tick; only a missing run is terminal (handled
    // inside step). Note the error so the queue card shows what is happening.
    touch(item, `retrying: ${(e as Error).message?.slice(0, 140) ?? "step failed"}`);
  } finally {
    // The latch MUST clear even if the snapshot write throws; a latched-true mutex
    // silently no-ops every future tick and the queue freezes until the next deploy.
    try { await save(); } catch (e) { console.warn("[night-queue] snapshot save failed:", (e as Error).message); }
    ticking = false;
  }
  return { active: store.filter((i) => i.stage !== "done" && i.stage !== "error").length };
}

/**
 * Which active item gets this tick? An item that already STARTED (stage past
 * "queued") keeps its claim until it finishes: the queue's one-item-at-a-time
 * invariant is what keeps the browser worker to a single job stream. Among the
 * still-queued, PARITY FIRST (user mandate 2026-07-20): work whose people are
 * not in OS Text yet (new searches, and resumes of never-sent lists) jumps
 * ahead of re-enrich top-ups for lists already delivered. Without this, a
 * stranded never-sent list can sit for hours behind bulk re-enriches of lists
 * that are already fully in the recruiters' hands.
 */
async function pickNext(active: NightItem[]): Promise<NightItem> {
  const started = active.find((i) => i.stage !== "queued");
  if (started) return started;
  for (const i of active) {
    if (i.kind === "search") return i; // unsaved list: certainly not delivered yet
    if (!i.runId) continue;
    try {
      const run = await getSourcingRun(i.workspaceId, i.runId);
      if (run && !run.autoflow?.sentAt) return i;
    } catch { /* fall through to FIFO */ }
  }
  return active[0];
}

async function step(item: NightItem): Promise<void> {
  const ws = item.workspaceId;

  if (item.stage === "queued") {
    if (item.kind === "boost") {
      // Route past what already ran: resume a mid-flight free rung if one is parked
      // on the run, run the whole free chain if it never ran (the list must be
      // properly enriched before paid lookups), else go straight to buying. Never
      // re-submit the KoldInfo rungs on an already-finished chain: that would
      // re-spend vendor tokens on rows they already failed to fill.
      const brun = item.runId ? await getSourcingRun(ws, item.runId) : undefined;
      if (!brun) { finish(item, "error", "the saved list is gone"); return; }
      item.stage = boostEntryStage(brun);
      touch(item, item.stage === "boost"
        ? "starting the paid phone lookups…"
        : "finishing the free enrichment first, then the paid phone lookups…");
      return;
    }
    item.stage = item.kind === "search" ? "search" : "kold";
    touch(item, item.kind === "search" ? "searching…" : "starting enrichment…");
    if (item.kind === "enrich") return; // enrichment starts next tick (cheap steps)
  }

  if (item.stage === "search") {
    if (!item.jd) { finish(item, "error", "no job description on the queued search"); return; }
    // The queued label carries the recruiter's radius ("Howell, NJ +25mi"), so read it
    // back and thread it EVERYWHERE the interactive path does. Pinning alone is not
    // enough and is in fact worse than nothing: it narrows icp.geos to a short list of
    // in-radius cities, and without radiusMi/geoCenter runDiscovery falls back to
    // matching stated locations against that short list by NAME — dropping real locals
    // from every town that missed the list while still waving through distant same-state
    // people. Overnight runs must filter by the same measured miles as a live search.
    const radiusMi = parseRadiusMi(undefined, item.location);
    const icp = pinIcpLocation(await parseJobDescription(item.jd), item.location, radiusMi);
    const breadth: SearchBreadth = item.breadth === "focused" || item.breadth === "wide" ? item.breadth : "balanced";
    const queries = generateQueries(icp, { breadth, radiusMi });
    const excludeKeys = await getSeenKeys(ws); // overnight runs are additive: skip people already surfaced
    const result = await withWorkspaceCreds(ws, () => runDiscovery(queries, icp, {
      cap: 500,
      minFit: 10,
      breadth,
      excludeKeys: excludeKeys.size ? excludeKeys : undefined,
      strictGeo: Boolean((item.location || "").trim()),
      keepOutOfArea: item.outsideGeo === true,
      radiusMi,
      geoCenter: item.location,
    }));
    await addSeenKeys(ws, result.candidates.map((c) =>
      (c.linkedinUrl || `${c.fullName}|${c.company ?? ""}`).toLowerCase().replace(/\/+$/, "")));
    const run = await saveSourcingRun(ws, {
      name: item.name,
      jd: item.jd,
      location: item.location,
      createdBy: item.createdBy,
      icp,
      queries,
      candidates: result.candidates,
      warnings: result.warnings,
      apiUsage: result.usage ? {
        rapidapi: Number(result.usage.rapidapi) || 0,
        serper: Number(result.usage.serper) || 0,
        google: Number(result.usage.google) || 0,
      } : undefined,
    });
    item.runId = run.id;
    item.stage = "kold";
    touch(item, `found ${result.candidates.length} candidate(s), enriching…`);
    return;
  }

  const run = item.runId ? await getSourcingRun(ws, item.runId) : undefined;
  if (!run) { finish(item, "error", "the saved list is gone"); return; }
  const workerUp = laxisWorkerConfigured() && (await koldinfoWorkerReady());

  if (item.stage === "kold") {
    if (!workerUp) { item.stage = "laxis"; touch(item); return; }
    if (!run.koldJob) {
      const { csv, count } = buildSourcingKoldInfoCsv(run.candidates);
      if (!count) { item.stage = "koldDb"; touch(item); return; }
      const jobId = await submitLaxisJob(csv, "koldinfo");
      run.koldJob = { jobId, submittedAt: nowIso(), count };
      await saveSourcingRun(ws, { ...run });
      touch(item, `free pass 1: looking up ${count} candidate(s)…`);
      return;
    }
    const job = await getLaxisJob(run.koldJob.jobId).catch(() => ({ status: "error", error: "job_not_found" } as any));
    if (job.status === "queued" || job.status === "running") { touch(item); return; }
    if (job.status === "done" && job.enrichedCsv) {
      const m = mergeSourcingKoldInfoCsv(run.candidates, job.enrichedCsv);
      item.added.emails += m.emails; item.added.phones += m.phones;
    }
    // Transient worker failure (lost job, browser killed under it by a deploy):
    // clearing the ref makes the next tick resubmit this rung ONCE; any other
    // error, or a second transient failure, moves the chain along.
    delete run.koldJob;
    await saveSourcingRun(ws, { ...run });
    const koldErr = String(job.error || "");
    if (job.status === "error" && retryableJobError(koldErr) && !item.retried?.kold) {
      (item.retried ??= {}).kold = true;
      touch(item, "free pass 1: the worker restarted mid-run, re-running this pass…");
      return;
    }
    item.stage = "koldDb";
    touch(item);
    return;
  }

  if (item.stage === "koldDb") {
    if (!workerUp) { item.stage = "laxis"; touch(item); return; }
    if (!run.koldDbJob) {
      const { csv, count } = buildKoldInfoDbCsv(run.candidates, run.location);
      if (!count) { item.stage = "laxis"; touch(item); return; }
      const jobId = await submitLaxisJob(csv, "koldinfo-db");
      run.koldDbJob = { jobId, submittedAt: nowIso(), count };
      await saveSourcingRun(ws, { ...run });
      touch(item, `free pass 2: database lookup for ${count} candidate(s)…`);
      return;
    }
    const job = await getLaxisJob(run.koldDbJob.jobId).catch(() => ({ status: "error", error: "job_not_found" } as any));
    if (job.status === "queued" || job.status === "running") { touch(item, run.koldDbJob ? `free pass 2: ${job.stage || "working…"}` : undefined); return; }
    if (job.status === "done" && job.enrichedCsv) {
      const m = mergeSourcingKoldInfoCsv(run.candidates, job.enrichedCsv);
      item.added.emails += m.emails; item.added.phones += m.phones;
    }
    delete run.koldDbJob;
    await saveSourcingRun(ws, { ...run });
    const koldDbErr = String(job.error || "");
    if (job.status === "error" && retryableJobError(koldDbErr) && !item.retried?.koldDb) {
      (item.retried ??= {}).koldDb = true;
      touch(item, "free pass 2: the worker restarted mid-run, re-running this pass…");
      return;
    }
    item.stage = "laxis";
    touch(item);
    return;
  }

  if (item.stage === "laxis") {
    const total = run.candidates.length;
    if (!laxisWorkerConfigured()) {
      // No worker: the in-house waterfall is still worth a pass, then we're done.
      const gf = await gapFillContacts(ws, run.candidates);
      item.added.emails += gf.enriched; item.added.phones += gf.phones;
      await saveSourcingRun(ws, { ...run });
      chainDone(item);
      return;
    }
    const progress = run.laxisProgress ?? { doneOffsets: [], total, nextStart: 0, updatedAt: nowIso() };
    if (!run.laxisJob) {
      const start = nextOffset(progress.doneOffsets, total, MAX_LAXIS_UPLOAD);
      if (start === null) { chainDone(item); return; }
      const targetRows = run.candidates.slice(start, start + MAX_LAXIS_UPLOAD);
      // Laxis down-cooldown (a fatal worker failure was just seen): don't feed chunks
      // to a dead login. The waterfall still runs, the chunk is marked done so the
      // night finishes, and the skip is remembered for a later real Laxis pass.
      const downUntil = run.laxisDownUntil ? Date.parse(run.laxisDownUntil) : NaN;
      if (Number.isFinite(downUntil) && downUntil > Date.now()) {
        const gf = await gapFillContacts(ws, targetRows);
        item.added.emails += gf.enriched; item.added.phones += gf.phones;
        rememberLaxisSkip(run, start, "laxis_down_cooldown");
        run.laxisProgress = markOffsetDone(progress, start, total);
        await saveSourcingRun(ws, { ...run });
        if (run.laxisProgress.nextStart === null) { chainDone(item); return; }
        touch(item, laxisNote(run, total));
        return;
      }
      const { csv, sent } = serializeCandidatesCsv(targetRows);
      if (!sent) {
        // Nothing enrichable in this chunk: run the gap-fill over it and mark it done.
        const gf = await gapFillContacts(ws, targetRows);
        item.added.emails += gf.enriched; item.added.phones += gf.phones;
        run.laxisProgress = markOffsetDone(progress, start, total);
        await saveSourcingRun(ws, { ...run });
        touch(item, laxisNote(run, total));
        return;
      }
      const jobId = await submitLaxisJob(csv);
      run.laxisJob = {
        jobId, submittedAt: nowIso(), count: targetRows.length, start, sent,
        targets: targetRows.map((c) => (c.linkedinUrl || `${c.fullName}|${c.company ?? ""}`).toLowerCase().replace(/\/+$/, "")),
      };
      run.laxisProgress = { ...progress, total, updatedAt: nowIso() };
      await saveSourcingRun(ws, { ...run });
      touch(item, laxisNote(run, total));
      return;
    }
    const job = await getLaxisJob(run.laxisJob.jobId).catch(() => ({ status: "error", error: "job_not_found" } as any));
    if (job.status === "queued" || job.status === "running") { touch(item); return; }
    const start = run.laxisJob.start ?? 0;
    const count = run.laxisJob.count;
    if (job.status === "done" && job.enrichedCsv) {
      const m = mergeEnrichedCsv(run.candidates, job.enrichedCsv);
      item.added.emails += m.emails; item.added.phones += m.phones;
      delete run.laxisDownUntil; // a job came back: the worker is reachable again
    }
    if (job.status === "error" && /job_not_found/i.test(String(job.error || ""))) {
      // Lost job: clear the ref so the next tick resubmits this chunk (offsets not done).
      delete run.laxisJob;
      await saveSourcingRun(ws, { ...run });
      touch(item);
      return;
    }
    if (job.status === "error") {
      // This chunk ran without its Laxis pass. Remember it so Enrich can re-run it,
      // and on a failure class that will hit every chunk (login wall), pause Laxis
      // submits briefly so the rest of the night moves fast on the waterfall alone.
      rememberLaxisSkip(run, start, String(job.error || "unknown"));
      if (laxisFatal(String(job.error || ""))) {
        run.laxisDownUntil = new Date(Date.now() + 30 * 60_000).toISOString();
      }
    }
    // Merged (or the worker gave up after its own retries): gap-fill the chunk and mark
    // its offset done either way, so one bad chunk can't wedge the whole night.
    const gf = await gapFillContacts(ws, run.candidates.slice(start, start + count));
    item.added.emails += gf.enriched; item.added.phones += gf.phones;
    delete run.laxisJob;
    run.laxisProgress = markOffsetDone(run.laxisProgress ?? progress, start, total);
    await saveSourcingRun(ws, { ...run });
    if (run.laxisProgress.nextStart === null) { chainDone(item); return; }
    touch(item, laxisNote(run, total));
    return;
  }

  if (item.stage === "boost") {
    const boost = item.boost;
    if (!boost) { finish(item, "error", "the boost details were lost; press Boost phones on the list again"); return; }
    const money = (v: number) => `$${v >= 0.01 || v === 0 ? v.toFixed(2) : v.toFixed(4)}`;
    const readout = () =>
      `${boost.found} phone${boost.found === 1 ? "" : "s"} added for ${money(boost.costUsd)} (all saved)`;
    // Buy in bounded 20-row batches inside this tick, then yield: momentum without
    // wedging the tick (the latch-steal window is 15 min; we stop well before it).
    const deadline = Date.now() + 3 * 60 * 1000;
    while (true) {
      const remainingWanted = boost.wanted - boost.done;
      if (remainingWanted <= 0) { finishBoost(item, `boost finished: ${readout()}`); return; }
      const r = await runPremiumPhoneBoost(ws, run, {
        max: Math.min(20, remainingWanted),
        actor: { userId: boost.actorUserId, userEmail: boost.actorEmail },
      });
      boost.done += r.called + r.cacheHits;
      boost.found += r.found;
      boost.costUsd = Math.round((boost.costUsd + r.costUsd) * 10000) / 10000;
      item.added.phones += r.found;
      touch(item);
      await saveSourcingRun(ws, { ...run });
      // Persist the counters EVERY batch (the tick's own save only runs when the
      // whole step returns): if the process dies mid-loop, the resumed item must
      // remember what was already bought, or it would buy up to `wanted` fresh
      // rows again on top of the lost count.
      await save().catch(() => {});
      if (r.budgetExhausted) {
        finishBoost(item, `stopped at your monthly Boost budget: ${readout()}; the allowance resets on the 1st`);
        return;
      }
      if (r.stoppedEarly) {
        // Another boost still holds this recruiter's lock (a tab running the old
        // loop, or a race with a just-finished item): wait, don't fail the item.
        if (r.called === 0 && r.cacheHits === 0 && /already in progress/i.test(r.stoppedEarly)) {
          touch(item, "waiting for your other Boost run to finish…");
          return;
        }
        finish(item, "error", `${r.stoppedEarly} · so far: ${readout()}; fix the listing settings and press Boost phones again, rows already bought are never re-billed`);
        return;
      }
      if (r.remaining <= 0) { finishBoost(item, `boost finished: ${readout()}`); return; }
      if (r.called === 0 && r.cacheHits === 0) {
        // Nothing progressed and nothing explained why: bail rather than spin.
        finish(item, "error", `the paid lookup made no progress · so far: ${readout()}`);
        return;
      }
      touch(item, `paid phone lookups: ${Math.min(boost.done, boost.wanted)} of ${boost.wanted} · ${boost.found} phone${boost.found === 1 ? "" : "s"} found · ${money(boost.costUsd)} spent`);
      if (Date.now() > deadline) return; // next tick continues from boost.done
    }
  }
}

function markOffsetDone(progress: NonNullable<SourcingRun["laxisProgress"]>, start: number, total: number): NonNullable<SourcingRun["laxisProgress"]> {
  const doneOffsets = Array.from(new Set([...progress.doneOffsets, start])).sort((a, b) => a - b);
  return { doneOffsets, total, nextStart: nextOffset(doneOffsets, total, MAX_LAXIS_UPLOAD), updatedAt: nowIso() };
}

function laxisNote(run: SourcingRun, total: number): string {
  const done = Math.min((run.laxisProgress?.doneOffsets.length ?? 0) * MAX_LAXIS_UPLOAD, total);
  return `final pass: ${done}/${total} rows through`;
}
