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
 * One digest per tick at most, and only when the event set itself changes, so a
 * fleet that is simply waiting stays silent (the 2026-08-19 warm-up notify flood
 * is the reason every new alert path here is de-duplicated before it can send).
 */

import { loadSnapshot, saveSnapshot } from "../db";
import { listSenderWorkspaceIds } from "./store";
import { fleetOverview } from "./fleets";
import { OUTLOOK_LEDGER_KEY, foldOutlook } from "./outlook";
import type { OutlookEvent, OutlookLedger } from "./outlook";

const ALARM_KEY = "senders_outlook_alarm_v1";
const MIN_DIGEST_GAP_MS = 6 * 3_600_000;

interface AlarmSnap { notifiedKey?: string; at?: string }

export interface OutlookWatchReport {
  at: string;
  workspaces: number;
  milestones: number;
  done: number;
  late: number;
  regressed: number;
  events: OutlookEvent[];
  notified: boolean;
}

/** Never throws: a monitoring layer must not be able to break the tick it runs in. */
export async function runOutlookWatch(): Promise<OutlookWatchReport> {
  const at = new Date().toISOString();
  const report: OutlookWatchReport = { at, workspaces: 0, milestones: 0, done: 0, late: 0, regressed: 0, events: [], notified: false };
  let ledger = (await loadSnapshot<OutlookLedger>(OUTLOOK_LEDGER_KEY)) || {};
  let ids: string[] = [];
  try { ids = await listSenderWorkspaceIds(); } catch { ids = []; }

  for (const ws of ids) {
    let cards;
    try { cards = await fleetOverview(ws); } catch { continue; }
    report.workspaces++;
    for (const c of cards) {
      if (!c.outlook?.length) continue;
      report.milestones += c.outlook.length;
      report.done += c.outlook.filter((s) => s.done && !s.regressed).length;
      report.late += c.outlook.filter((s) => s.state === "late").length;
      report.regressed += c.outlook.filter((s) => s.regressed).length;
      const folded = foldOutlook(ledger, { workspaceId: ws, fleet: c.key, fleetName: c.name, now: Date.now() }, c.outlook);
      ledger = folded.ledger;
      report.events.push(...folded.events);
    }
  }

  await saveSnapshot(OUTLOOK_LEDGER_KEY, {
    ...ledger,
    at,
    summary: { milestones: report.milestones, done: report.done, late: report.late, regressed: report.regressed },
  });

  // Digest: regressions and misses first, because those are the ones that change
  // what anyone does today.
  const worth = report.events;
  if (worth.length) {
    const key = worth.map((e) => `${e.fleet}:${e.id}:${e.kind}`).sort().join(",");
    const prev = (await loadSnapshot<AlarmSnap>(ALARM_KEY)) || {};
    const gapOk = !prev.at || Date.now() - Date.parse(prev.at) >= MIN_DIGEST_GAP_MS;
    if (key !== prev.notifiedKey && gapOk) {
      try {
        const { notifyOwner, noticeConfigured } = await import("../owner/ownerNotice");
        if (noticeConfigured()) {
          const order = { regressed: 0, late: 1, completed: 2, slipped: 3 } as Record<OutlookEvent["kind"], number>;
          const lines = [...worth].sort((a, b) => order[a.kind] - order[b.kind]).map((e) => {
            const verb = e.kind === "completed" ? "DONE" : e.kind === "regressed" ? "WENT BACKWARDS" : e.kind === "late" ? "LATE" : "DATE MOVED";
            return `- [${verb}] ${e.fleetName}: ${e.what}\n  ${e.detail}`;
          });
          const res = await notifyOwner({
            subject: `Sending fleet plan: ${worth.filter((e) => e.kind === "completed").length} done, ${worth.filter((e) => e.kind !== "completed").length} needing a look`,
            body:
              `The fleet monitor checks each step off only when the ledger that gates it proves it happened. Since the last digest:\n\n${lines.join("\n")}\n\n` +
              `WENT BACKWARDS means a step that had been proven is now contradicted; that is the one worth opening the Senders tab for. LATE means the date passed with no evidence, and the line above it says what the step is waiting on. Nothing here needs a reply.`,
          });
          report.notified = !!res?.ok;
          if (report.notified) await saveSnapshot(ALARM_KEY, { notifiedKey: key, at } satisfies AlarmSnap);
        }
      } catch { /* alerting is best-effort; the board and the health check still show it */ }
    }
  }
  return report;
}
