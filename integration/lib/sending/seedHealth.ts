/**
 * RecruiterOS · Seed-inbox health maintenance
 * The safeguards that keep the seed network honest over time. Seeds are global
 * (not workspace-scoped), so these run ONCE per cron tick, not per workspace.
 *
 *   reverifyAllSeeds  — re-test the IMAP login of every seed with creds, so a
 *                       locked account / revoked app password surfaces in the
 *                       console instead of silently failing a warm-up tick.
 *   readDuePlacements — for every still-pending placement test, connect to each
 *                       seed and record where the probe actually landed
 *                       (inbox/spam/missing). Makes seed testing hands-off.
 */

import { listSeeds, setSeedVerification, listSendingWorkspaceIds, listSeedTests } from "./store";
import { verifySeedLogin, seedDrivable, readPlacement } from "./seedClient";
import { recordSeedResult } from "./seedtest";
import type { Placement } from "./types";

export interface SeedReverifyReport { checked: number; ok: number; failed: number }

/** Re-run the connector test for every seed that has credentials. */
export async function reverifyAllSeeds(): Promise<SeedReverifyReport> {
  const seeds = (await listSeeds()).filter((s) => s.imapUser && s.imapPass);
  let ok = 0;
  for (const seed of seeds) {
    const v = await verifySeedLogin(seed);
    await setSeedVerification(seed.id, v.ok, v.error);
    if (v.ok) ok++;
  }
  return { checked: seeds.length, ok, failed: seeds.length - ok };
}

export interface PlacementReadReport { tests: number; probesRead: number }

/**
 * Fill in pending placement results by reading the seed inboxes over IMAP.
 * Groups pending probes by seed so each inbox is opened once per tick.
 */
export async function readDuePlacements(): Promise<PlacementReadReport> {
  const seeds = await listSeeds();
  const seedById = new Map(seeds.map((s) => [s.id, s]));
  let probesRead = 0;
  const touchedTests = new Set<string>();

  for (const ws of await listSendingWorkspaceIds()) {
    const tests = await listSeedTests(ws);
    // seedId -> set of testIds with a still-pending result on that seed
    const bySeed = new Map<string, Set<string>>();
    for (const t of tests) {
      if (t.status === "complete") continue;
      for (const r of t.results) {
        if (r.placement !== "pending") continue;
        const set = bySeed.get(r.seedId) || new Set<string>();
        set.add(t.id); bySeed.set(r.seedId, set);
      }
    }
    for (const [seedId, testIds] of bySeed) {
      const seed = seedById.get(seedId);
      if (!seed || !seedDrivable(seed)) continue;
      const ids = [...testIds];
      const placements = await readPlacement(seed, ids);
      for (const testId of ids) {
        const placement = placements[testId] as Placement | undefined;
        if (!placement) continue;          // probe not yet visible — try next tick
        await recordSeedResult(testId, seedId, placement);
        probesRead++; touchedTests.add(testId);
      }
    }
  }
  return { tests: touchedTests.size, probesRead };
}

/** One call the cron runs: re-verify logins + read any due placements. */
export async function runSeedMaintenance(): Promise<{ reverify: SeedReverifyReport; placement: PlacementReadReport }> {
  const reverify = await reverifyAllSeeds();
  let placement: PlacementReadReport = { tests: 0, probesRead: 0 };
  try { placement = await readDuePlacements(); } catch { /* best-effort */ }
  return { reverify, placement };
}
