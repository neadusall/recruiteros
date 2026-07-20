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
import { tickNightQueue, listNightItems } from "../../../../lib/sourcing";
import { tickSourcingAutoflow } from "../../../../lib/sourcing/autoflow";
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
  return NextResponse.json({ ok: true, ticked: true });
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }
