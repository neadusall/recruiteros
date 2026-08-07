/**
 * GET|POST /api/sourcing/night -> advance the JD Sourcing overnight queue one step.
 *
 * The queue itself (lib/sourcing/nightQueue) is a small per-item state machine:
 * search -> KoldInfo -> KoldInfo DB -> Laxis + gap-fill. Each tick does one bounded
 * step (submit a job, poll a job, or run the search) and returns; point a scheduler
 * here every couple of minutes and queued searches finish overnight with no browser
 * tab open. The long search step runs fire-and-forget so this request never outlives
 * the proxy timeout.
 *
 * Auth: x-cron-secret (or ?secret=) === RECRUITEROS_CRON_SECRET, matching the other
 * cron ticks (loxo/cron, linkedin/cron, sending/cron).
 */

import { NextResponse } from "next/server";
import { requireCronAuth } from "../../../../lib/linkedin/auth";
import { tickNightQueue, listNightItems, searchesInFlight } from "../../../../lib/sourcing";
import { tickSourcingAutoflow } from "../../../../lib/sourcing/autoflow";
import { seedStandingSweeps, workspacesWithStandingProfiles } from "../../../../lib/sourcing/standingProfiles";
import { backfillListPhones, unstickSourcingRun } from "../../../../lib/sourcing/phoneBackfill";

async function run(req: Request) {
  const auth = requireCronAuth(req);
  if (!auth.ok) return auth.response;
  const params = new URL(req.url).searchParams;
  if (params.get("status") === "1") {
    // Peek without doing work (workspace-blind: item names + stages only).
    const ws = params.get("ws");
    const items = ws ? await listNightItems(ws) : [];
    return NextResponse.json({ ok: true, items: items.map((i) => ({ id: i.id, name: i.name, stage: i.stage, note: i.note, added: i.added })) });
  }
  if (params.get("inflight") === "1") {
    // DEPLOY GATE (auto-deploy.sh). Read-only, workspace-blind, and deliberately
    // ahead of the tick below: the deploy asks this every few seconds while it
    // holds a container swap, and a poll that advanced the queue would be doing
    // the very work it is waiting on. Answers "is a candidate search running",
    // which is the only work a recreate destroys outright.
    return NextResponse.json({ ok: true, ...(await searchesInFlight()) });
  }
  const unstick = params.get("unstick");
  if (unstick) {
    // Operator repair (see lib/sourcing/phoneBackfill.unstickSourcingRun): a run
    // whose worker jobs died out-of-band stays "Enriching" forever and blocks
    // Boost phones. Cron-authed like everything else on this route.
    return NextResponse.json({ ok: true, ...(await unstickSourcingRun(unstick)) });
  }
  if (params.get("phoneBackfill") === "1") {
    // One-shot repair sweep (see lib/sourcing/phoneBackfill): re-run the free
    // LandlineDB phone rung over every saved list after an outage left them
    // phone-less. Synchronous on purpose — it is batched DB reads (seconds, no
    // vendor calls), and the caller wants the counts back.
    const result = await backfillListPhones();
    return NextResponse.json({ ok: true, ...result });
  }
  // Fire-and-forget: a search step can run for minutes; the tick's own mutex makes
  // overlapping timer hits harmless. The response just reports the queue is being served.
  const ticked = tickNightQueue().catch((e) => console.warn("[night-queue] tick failed:", e?.message ?? e));
  void ticked;
  // Same timer also sweeps the auto-send (lib/sourcing/autoflow): finished lists flow
  // on to Candidates + OS Text server-side. It MUST run in the request module graph —
  // instrumentation.ts gets its own bundle instance whose store copy goes stale (and
  // whose saves could clobber live data), which is why the queue ticks via HTTP too.
  void tickSourcingAutoflow().catch((e) => console.warn("[sourcing-autoflow] tick failed:", e?.message ?? e));
  // STANDING SWEEPS (lib/sourcing/standingProfiles): the rota of roles this desk always
  // recruits for. Seeding is idempotent per day and paced by a per-workspace ceiling, so
  // running it on every tick is safe: whatever is not due, or is already in flight, is
  // simply not seeded. This is what turns discovery from "as often as somebody presses a
  // button" into a steady daily supply.
  void tickStandingSweeps().catch((e) => console.warn("[standing-sweeps] tick failed:", e?.message ?? e));
  return NextResponse.json({ ok: true, ticked: true });
}

/** Seed due sweeps for every workspace that has an active standing profile. */
async function tickStandingSweeps(): Promise<void> {
  const workspaces = await workspacesWithStandingProfiles();
  for (const ws of workspaces) {
    try {
      const { seeded } = await seedStandingSweeps(ws);
      if (seeded.length) console.log(`[standing-sweeps] ${ws}: seeded ${seeded.length} (${seeded.join(", ")})`);
    } catch (e: any) {
      // One workspace's bad profile must not stop the others' rotas.
      console.warn(`[standing-sweeps] ${ws} failed:`, e?.message ?? e);
    }
  }
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }
