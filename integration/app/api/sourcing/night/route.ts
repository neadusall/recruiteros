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
  // Fire-and-forget: a search step can run for minutes; the tick's own mutex makes
  // overlapping timer hits harmless. The response just reports the queue is being served.
  const ticked = tickNightQueue().catch((e) => console.warn("[night-queue] tick failed:", e?.message ?? e));
  void ticked;
  return NextResponse.json({ ok: true, ticked: true });
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }
