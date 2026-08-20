/**
 * RecruitersOS · Senders · the fleet-outlook watcher (the tick that makes the
 * board living rather than drawn).
 *
 * Runs inside the sending maintenance tick. Every run it re-reads each fleet's
 * milestones (lib/senders/outlook, verified against the ledgers that gate them),
 * folds the readings into the milestone ledger so a check-off keeps the date its
 * evidence arrived, and raises the four things a person actually needs to hear:
 *
 *   completed  a milestone that matters proved itself (the cutover held, a
 *              receiver came back, the boxes graduated, the cold lane opened)
 *   regressed  something proven has been contradicted since - the loudest signal
 *              on the board, because it means the machinery moved backwards
 *   late       a milestone is past its forecast with no evidence it happened
 *   slipped    the gating ledger pushed a date out, so the plan changed
 *
 * A MONITOR MUST NOT BE ABLE TO CAUSE AN INCIDENT, so this layer is written to
 * fail quiet and stay quiet:
 *   - it never throws (per-workspace and per-fleet failures are counted, not
 *     propagated) and a failed read is reported, never silently treated as "fine";
 *   - only milestones marked `notify` can reach a person, so the board churn of a
 *     fleet with eighteen resting domains never becomes mail (the 2026-08-19
 *     warm-up notify flood is why every alert path here is gated twice);
 *   - a COLD START (an absent or wiped ledger) records without paging, because
 *     "everything completed at once" is a lost snapshot, not news;
 *   - one digest per tick at most, capped in length, deduplicated by event set and
 *     rate-limited, and it only fires when something actually changed;
 *   - concurrent runs (the cron tick and the in-process scheduler) are collapsed
 *     into one, so two writers can never race the ledger and lose a check-off.
 */

import { loadSnapshot, saveSnapshot } from "../db";
import { listSenderWorkspaceIds } from "./store";
import { fleetOverview } from "./fleets";
import { OUTLOOK_LEDGER_KEY, foldOutlook, pruneOutlook, ledgerKey } from "./outlook";
import type { OutlookEvent, OutlookLedger } from "./outlook";

const ALARM_KEY = "senders_outlook_alarm_v1";
const MIN_DIGEST_GAP_MS = 6 * 3_600_000;
const MAX_DIGEST_LINES = 12;
/** More completions than this in one run, from an empty ledger, is a restored or
 *  wiped snapshot rather than a burst of good news. */
const COLD_START_MAX = 3;

interface AlarmSnap { notifiedKey?: string; at?: string }

export interface OutlookWatchReport {
  at: string;
  workspaces: number;
  fleets: number;
  milestones: number;
  done: number;
  late: number;
  regressed: number;
  unverified: number;
  /** Workspaces or fleets whose evidence could not be read this run. A monitor that
   *  cannot see must say so; the health board turns amber on this. */
  errors: number;
  pruned: number;
  coldStart: boolean;
  events: OutlookEvent[];
  notified: boolean;
}

/** Collapses concurrent callers (cron tick + in-process scheduler) onto one run. */
let inFlight: Promise<OutlookWatchReport> | null = null;

export function runOutlookWatch(): Promise<OutlookWatchReport> {
  if (inFlight) return inFlight;
  inFlight = watch().finally(() => { inFlight = null; });
  return inFlight;
}

async function watch(): Promise<OutlookWatchReport> {
  const startedAt = Date.now();
  const at = new Date(startedAt).toISOString();
  const report: OutlookWatchReport = {
    at, workspaces: 0, fleets: 0, milestones: 0, done: 0, late: 0, regressed: 0, unverified: 0,
    errors: 0, pruned: 0, coldStart: false, events: [], notified: false,
  };

  let ledger: OutlookLedger = {};
  try { ledger = (await loadSnapshot<OutlookLedger>(OUTLOOK_LEDGER_KEY)) || {}; }
  catch { report.errors++; }
  const hadRecords = Object.keys(ledger.records || {}).length > 0;

  let ids: string[] = [];
  try { ids = await listSenderWorkspaceIds(); }
  catch { report.errors++; ids = []; }

  const seen = new Set<string>();
  for (const ws of ids) {
    let cards;
    try { cards = await fleetOverview(ws); }
    catch { report.errors++; continue; }
    report.workspaces++;
    for (const c of cards) {
      if (!c.outlook?.length) continue;
      try {
        report.fleets++;
        report.milestones += c.outlook.length;
        report.done += c.outlook.filter((s) => s.done && !s.regressed).length;
        report.late += c.outlook.filter((s) => s.state === "late").length;
        report.regressed += c.outlook.filter((s) => s.regressed).length;
        report.unverified += c.outlook.filter((s) => s.state === "unverified").length;
        for (const s of c.outlook) seen.add(ledgerKey(ws, c.key, s.id));
        const folded = foldOutlook(ledger, { workspaceId: ws, fleet: c.key, fleetName: c.name, now: Date.now() }, c.outlook);
        ledger = folded.ledger;
        report.events.push(...folded.events);
      } catch { report.errors++; }
    }
  }

  // Nothing was read: keep the ledger exactly as it was rather than stamping a fresh
  // "at" over it, so the health board sees a watcher that has stopped folding instead
  // of a board that looks maintained while it is blind.
  if (!report.fleets && report.errors) return report;

  const cleaned = pruneOutlook(ledger, seen, startedAt);
  report.pruned = cleaned.pruned;
  ledger = cleaned.ledger;

  try {
    await saveSnapshot(OUTLOOK_LEDGER_KEY, {
      ...ledger,
      at,
      summary: {
        milestones: report.milestones, done: report.done, late: report.late,
        regressed: report.regressed, unverified: report.unverified, errors: report.errors,
      },
    });
  } catch { report.errors++; }

  const completions = report.events.filter((e) => e.kind === "completed").length;
  report.coldStart = !hadRecords && completions > COLD_START_MAX;
  await maybeNotify(report, at);
  return report;
}

/** One capped, deduplicated, rate-limited digest. Regressions and misses first,
 *  because those are the ones that change what anyone does today. */
async function maybeNotify(report: OutlookWatchReport, at: string): Promise<void> {
  const worth = report.events.filter((e) => e.notify);
  if (!worth.length || report.coldStart) return;
  const key = worth.map((e) => `${e.workspaceId}:${e.fleet}:${e.id}:${e.kind}`).sort().join(",");
  let prev: AlarmSnap = {};
  try { prev = (await loadSnapshot<AlarmSnap>(ALARM_KEY)) || {}; } catch { return; }
  if (key === prev.notifiedKey) return;
  if (prev.at && Date.now() - Date.parse(prev.at) < MIN_DIGEST_GAP_MS) return;

  try {
    const { notifyOwner, noticeConfigured } = await import("../owner/ownerNotice");
    if (!noticeConfigured()) return;
    const order = { regressed: 0, late: 1, slipped: 2, completed: 3 } as Record<OutlookEvent["kind"], number>;
    const sorted = [...worth].sort((a, b) => order[a.kind] - order[b.kind]);
    const shown = sorted.slice(0, MAX_DIGEST_LINES);
    const lines = shown.map((e) => {
      const verb = e.kind === "completed" ? "DONE" : e.kind === "regressed" ? "WENT BACKWARDS" : e.kind === "late" ? "LATE" : "DATE MOVED";
      return `- [${verb}] ${e.fleetName}: ${e.what}\n  ${e.detail}`;
    });
    if (sorted.length > shown.length) lines.push(`- and ${sorted.length - shown.length} more on the Senders tab`);
    const bad = sorted.filter((e) => e.kind !== "completed").length;
    const res = await notifyOwner({
      subject: `Sending fleet plan: ${sorted.length - bad} done, ${bad} needing a look`,
      body:
        `The fleet monitor checks each step off only when the ledger that gates it proves it happened. Since the last digest:\n\n${lines.join("\n")}\n\n` +
        `WENT BACKWARDS means a step that had been proven is now contradicted; that is the one worth opening the Senders tab for. LATE means the date passed with no evidence, and the line under it says what the step is waiting on. Nothing here needs a reply.`,
    });
    report.notified = !!res?.ok;
    if (report.notified) await saveSnapshot(ALARM_KEY, { notifiedKey: key, at } satisfies AlarmSnap);
  } catch { /* alerting is best-effort; the board and the health check still show it */ }
}
