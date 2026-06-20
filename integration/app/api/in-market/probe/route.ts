/**
 * RecruitersOS · In-Market · one-box test PROBE (read-only telemetry)
 *
 * A tiny, dependency-free GET that exposes ONLY aggregate telemetry for the "prove the model on one
 * box" test — this box's Common Crawl index-governor health + the per-IP naming yield + funnel
 * counts. NO leads, NO PII, NO secrets. Lets an operator (or the build assistant) poll the verdict
 * without a logged-in session.
 *
 * Optional gate: if INMARKET_PROBE_TOKEN is set, require ?key=<token>; otherwise it's public
 * telemetry-only. force-dynamic so it's never statically cached (the numbers must be live).
 */

import { ok, fail } from "../../../../lib/api";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: Request) {
  const token = process.env.INMARKET_PROBE_TOKEN;
  if (token) {
    const key = new URL(req.url).searchParams.get("key") || "";
    if (key.length !== token.length || key !== token) return fail("unauthorized", 401);
  }

  const out: Record<string, unknown> = { ok: true, ts: new Date().toISOString() };
  try {
    const { commonCrawlHealth } = await import("../../../../lib/inmarket/commonCrawl");
    out.cc = commonCrawlHealth();
  } catch { out.cc = null; }
  try {
    const { searchHealth } = await import("../../../../lib/inmarket/searchHealth");
    out.search = searchHealth().status;
  } catch { out.search = "idle"; }
  try {
    const { fleetStatus } = await import("../../../../lib/inmarket/fleet");
    const f = fleetStatus();
    out.fleet = { online: f.online, totalNamesPerHour: f.totalNamesPerHour, health: f.health };
  } catch { /* fleet optional */ }
  try {
    const { engineHealth } = await import("../../../../lib/inmarket/accumulator");
    const h = await engineHealth();
    out.engine = { lastCurationAt: h.lastCurationAt, lastCurationOk: h.lastCurationOk, lastCycleAt: h.lastCycleAt, curationTicks: h.curationTicks };
  } catch { /* optional */ }
  try {
    const { curationFunnel } = await import("../../../../lib/inmarket/curation");
    const fn = await curationFunnel();
    out.namedLastHour = fn.namedLastHour;
    out.total = fn.total;
    out.named = fn.named;
    out.namedRate = fn.namedRate;
    out.byStatus = fn.byStatus;
    out.contactableRate = fn.contactableRate;
    out.domainRate = fn.domain?.resolverRate;
  } catch (e) {
    out.funnelError = (e as Error)?.message ?? "funnel_failed";
  }
  return ok(out);
}
