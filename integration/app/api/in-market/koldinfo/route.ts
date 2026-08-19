/**
 * GET|POST /api/in-market/koldinfo — the KoldInfo residual-finder round-trip, cron-authed.
 *
 * The session-authed koldinfo_export/koldinfo_import actions on /api/in-market serve the
 * operator's manual CSV round-trip. This route is the SAME two functions behind the shared
 * scheduler secret, so a box-side orchestrator can drive the round-trip hands-free through
 * the laxis-worker's headless KoldInfo DB flow (the rejected-address pile has no LinkedIn
 * URLs, so the name+city DB lookup is the only door those rows fit through).
 *
 *   GET  ?mode=all|seed&limit=N -> the export pile as JSON rows (koldInfoExportRows)
 *   POST { csv }                -> parse + Reoon re-verify + merge a result CSV
 *                                  (applyKoldInfoResults; verified hits promote a rescued
 *                                  row back to contactable)
 *
 * Auth: x-cron-secret (or ?secret=) === RECRUITEROS_CRON_SECRET, matching sourcing/night.
 */

import { NextResponse } from "next/server";
import { requireCronAuth } from "../../../../lib/linkedin/auth";

export async function GET(req: Request) {
  const auth = requireCronAuth(req);
  if (!auth.ok) return auth.response;
  const p = new URL(req.url).searchParams;
  const limit = Math.min(Math.max(Number(p.get("limit")) || 4000, 1), 20000);
  const mode = p.get("mode") === "all" ? ("all" as const) : ("seed" as const);
  const { koldInfoExportRows } = await import("../../../../lib/inmarket/curation");
  const rows = await koldInfoExportRows({ limit, mode });
  return NextResponse.json({ ok: true, rows });
}

export async function POST(req: Request) {
  const auth = requireCronAuth(req);
  if (!auth.ok) return auth.response;
  let b: { csv?: unknown } = {};
  try { b = await req.json(); } catch { /* handled below */ }
  const csv = typeof b?.csv === "string" ? b.csv : "";
  if (!csv.trim()) return NextResponse.json({ ok: false, error: "missing_csv" }, { status: 422 });
  const { parseKoldInfoCsv } = await import("../../../../lib/inmarket/koldInfo");
  const { applyKoldInfoResults } = await import("../../../../lib/inmarket/curation");
  const parsed = parseKoldInfoCsv(csv);
  const summary = await applyKoldInfoResults(parsed, new Date().toISOString());
  return NextResponse.json({ ok: true, parsed: parsed.length, ...summary });
}
