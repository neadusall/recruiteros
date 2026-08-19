/**
 * GET /api/senders/story  (session, tenant-scoped)
 *
 * The plain-English answer to "why is sending volume what it is right now?", composed
 * from the snapshots the MPC sending tools already write. This is the owner-facing
 * narrative for the Senders tab: which side is the limiter today (mailbox capacity or
 * clean prospect supply), whether the supply engine is producing, whether Gmail
 * placement is passing, and which domains are resting after bounce trouble.
 *
 * Read-only composition: every number here is already being written by batch.mjs,
 * mpc-deliverability.mjs, ndr-sweep/domain-rest, run-seed-test, and the curation
 * engine. The ramp-cap math mirrors batch.mjs exactly (same defaults, same placement
 * unlock rule) so the cap shown here is the cap the sender actually enforces.
 *
 * Gated like /api/mpc-stats: only the workspace the MPC snapshots belong to sees the
 * story; every other tenant gets { present:false } and the card hides.
 */

import { requireSession, ok } from "../../../../lib/api";
import { loadSnapshot } from "../../../../lib/db";
import { sendCapacity } from "../../../../lib/senders";

interface MpcStats {
  workspaceId?: string; generatedAt?: string;
  sentTotal?: number; sentToday?: number; repliesTotal?: number; replyRate?: number;
  supplyReady?: number;
}
interface GrowthSnap {
  workspaceId?: string;
  growthGap?: { untouchedClean?: number; sentToday?: number; safeCapacity?: number; safeRemaining?: number; constraint?: string; message?: string };
}
interface DeliverabilitySnap {
  generatedAt?: string;
  overall?: { bounces?: number; warmupReputationPct?: number; domainsSending?: number; domainsTotal?: number; sentToday?: number };
  byDomain?: { domain?: string; verdict?: string }[];
}
interface RestSnap { updatedAt?: string; domains?: Record<string, { state?: string; reason?: string; until?: string }> }
interface PlacementSnap { checkedAt?: string; gmail?: { inbox?: number; spam?: number } }
interface EngineHealth { lastCurationAt?: string; lastCurationOk?: boolean }

const DAY = 86_400_000;

/** Mirrors the volume-ramp governor in scripts/mpc/batch.mjs: base 450/day from
 *  2026-08-13, +20%/week toward the 1500 ceiling, growth unlocked only while a
 *  fresh (<=7 day) seed test shows Gmail inboxing (spam share <= 30%). */
function rampCap(placement: PlacementSnap | null): { cap: number; base: number; ceiling: number; growthUnlocked: boolean } {
  const base = Number(process.env.MPC_RAMP_BASE ?? 450);
  const start = Date.parse(process.env.MPC_RAMP_START || "2026-08-13");
  const envCap = Number(process.env.MPC_DAILY_CAP || 1800);
  const ceiling = Math.min(1500, envCap);
  let passes = false;
  if (placement?.checkedAt && Date.now() - Date.parse(placement.checkedAt) <= 7 * DAY) {
    const g = placement.gmail || {};
    const total = (g.inbox || 0) + (g.spam || 0);
    if (total > 0) passes = (g.spam || 0) / total <= 0.3;
  }
  if (!(base > 0) || !Number.isFinite(start)) return { cap: envCap, base, ceiling, growthUnlocked: passes };
  const weeks = Math.max(0, (Date.now() - start) / (7 * DAY));
  const cap = Math.min(ceiling, Math.round(base * (passes ? Math.pow(1.2, weeks) : 1)));
  return { cap: Math.min(envCap, cap), base, ceiling, growthUnlocked: passes };
}

function placementStatus(pl: PlacementSnap | null): { status: "pass" | "fail" | "stale" | "none"; checkedAt: string | null; inbox: number; spam: number } {
  if (!pl?.checkedAt) return { status: "none", checkedAt: null, inbox: 0, spam: 0 };
  const g = pl.gmail || {};
  const inbox = g.inbox || 0, spam = g.spam || 0;
  const fresh = Date.now() - Date.parse(pl.checkedAt) <= 7 * DAY;
  if (!fresh) return { status: "stale", checkedAt: pl.checkedAt, inbox, spam };
  const total = inbox + spam;
  return { status: total > 0 && spam / total <= 0.3 ? "pass" : "fail", checkedAt: pl.checkedAt, inbox, spam };
}

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;

  const stats = await loadSnapshot<MpcStats>("mpc_stats_v1");
  if (!stats || stats.workspaceId !== g.ctx.workspace.id) return ok({ present: false });

  const [growth, deliv, rest, placement, engine] = await Promise.all([
    loadSnapshot<GrowthSnap>("growth_proposals_v1"),
    loadSnapshot<DeliverabilitySnap>("mpc_deliverability_v1"),
    loadSnapshot<RestSnap>("mpc_domain_rest_v1"),
    loadSnapshot<PlacementSnap>("mpc_placement_v1"),
    loadSnapshot<EngineHealth>("inmarket_engine_health_v1"),
  ]);

  const gap: NonNullable<GrowthSnap["growthGap"]> =
    (growth && growth.workspaceId === g.ctx.workspace.id && growth.growthGap) || {};
  const ramp = rampCap(placement);
  const sentToday = Math.max(stats.sentToday || 0, deliv?.overall?.sentToday || 0, gap.sentToday || 0);
  const supplyReady = Math.max(stats.supplyReady || 0, gap.untouchedClean || 0);

  // Domain bench: who is resting right now, and when the next one comes back.
  const resting = Object.entries(rest?.domains || {})
    .filter(([, d]) => d.state === "resting")
    .map(([domain, d]) => ({ domain, reason: d.reason || "", until: d.until || null }))
    .sort((a, b) => String(a.until || "").localeCompare(String(b.until || "")));
  const nextRevival = resting.find((r) => r.until)?.until || null;

  // The REAL ceiling, not just the ramp's. The ramp says what reputation allows;
  // the fleet says what the benched-vs-usable mailbox split allows. ONE source of
  // truth: sendCapacity() in lib/senders/store.ts is the only place that sums
  // per-box caps (rest-ledger aware); every surface reads it, none re-derives it —
  // hand-rolled sums are how this card and the Senders tab told two different
  // capacity stories on 2026-08-19. Cold lane is Sending.ac only (own-SMTP parked).
  let fleetBoxes = 0, usableBoxes = 0, benchedBoxes = 0, fleetCeiling = 0, perBox = 2;
  try {
    const sac = (await sendCapacity(g.ctx.workspace.id)).byProvider.find((p) => p.provider === "sending-ac");
    if (sac) {
      usableBoxes = sac.inboxes;
      benchedBoxes = sac.benchedInboxes;
      fleetBoxes = sac.inboxes + sac.benchedInboxes;
      fleetCeiling = sac.coldCapacity;
      perBox = sac.inboxes > 0 ? Math.round(sac.coldCapacity / sac.inboxes) : perBox;
    }
  } catch { /* fleet math is best-effort; the ramp cap still renders */ }
  const capToday = fleetBoxes > 0 ? Math.min(ramp.cap, fleetCeiling) : ramp.cap;
  const remaining = Math.max(0, capToday - sentToday);
  const fleetLimited = fleetBoxes > 0 && fleetCeiling < ramp.cap;

  const pl = placementStatus(placement);

  // Supply engine: the curation tick that validates and enriches prospects. If it has
  // not completed successfully in the last 3 hours, fresh supply is not refilling.
  const lastRun = engine?.lastCurationAt ? Date.parse(engine.lastCurationAt) : NaN;
  const engineOk = engine?.lastCurationOk === true && Number.isFinite(lastRun) && Date.now() - lastRun <= 3 * 3_600_000;

  // The verdict: what is actually limiting volume today, in priority order.
  let verdict: "engine" | "placement" | "fleet" | "supply" | "capacity" | "healthy";
  if (!engineOk) verdict = "engine";
  else if (pl.status === "fail") verdict = "placement";
  else if (fleetLimited && fleetCeiling < ramp.cap / 2) verdict = "fleet";
  else if (supplyReady < remaining / 2) verdict = "supply";
  else if (supplyReady > remaining && remaining < capToday / 4) verdict = "capacity";
  else verdict = "healthy";

  const headline =
    verdict === "engine" ? "Supply engine needs attention" :
    verdict === "placement" ? "Gmail placement is failing, volume held down" :
    verdict === "fleet" ? "Most mailboxes are resting; real capacity is reduced today" :
    verdict === "supply" ? "Senders are ready; clean prospect supply is the limiter" :
    verdict === "capacity" ? "Supply is full; mailbox capacity is the limiter" :
    "Sending is healthy and balanced";

  const narrative: string[] = [];
  narrative.push(
    fleetLimited
      ? `Reputation allows ${ramp.cap.toLocaleString()} cold emails today (ramp: ${ramp.base}/day base, growing toward ${ramp.ceiling.toLocaleString()}), but ${benchedBoxes.toLocaleString()} of the fleet's ${fleetBoxes.toLocaleString()} mailboxes sit on resting domains, so the real ceiling right now is ${capToday.toLocaleString()} (${usableBoxes.toLocaleString()} usable boxes at ${perBox}/day each). ` +
        `${sentToday.toLocaleString()} went out so far, leaving room for ${remaining.toLocaleString()}.`
      : `The fleet can send up to ${capToday.toLocaleString()} cold emails today (reputation ramp: ${ramp.base}/day base, growing toward ${ramp.ceiling.toLocaleString()}). ` +
        `${sentToday.toLocaleString()} went out so far, leaving room for ${remaining.toLocaleString()}.`
  );
  if (verdict === "fleet") {
    narrative.push(
      `The resting domains hold most of the sending mailboxes, so today's volume is limited by the bench, not by supply or reputation. ` +
      `The bench protects sender reputation after bounce trouble; domains rejoin automatically on their rest schedule${nextRevival ? ` (next revival ${nextRevival.slice(0, 10)})` : ""}.`
    );
  }
  if (verdict === "supply") {
    narrative.push(
      `Only ${supplyReady.toLocaleString()} clean, validated prospects are ready to email, so supply is what limits volume today, not your mailboxes. ` +
      (engineOk ? "The prospect engine is running normally and refilling the pool." : "")
    );
  } else if (verdict === "capacity") {
    narrative.push(`${supplyReady.toLocaleString()} clean prospects are waiting, more than today's remaining send room, so volume is capped by the reputation ramp rather than supply.`);
  } else if (verdict === "engine") {
    narrative.push(
      `The prospect engine has not completed a run recently${engine?.lastCurationAt ? ` (last success ${new Date(lastRun).toISOString().slice(0, 16).replace("T", " ")} UTC)` : ""}, so fresh validated supply is not refilling. Sending continues from the existing pool (${supplyReady.toLocaleString()} ready).`
    );
  } else if (verdict === "placement") {
    narrative.push("The latest Gmail seed test shows messages landing in spam, so Gmail-hosted prospects are held and volume stays at the base rate until a passing test lands.");
  } else {
    narrative.push(`${supplyReady.toLocaleString()} clean prospects are ready against ${remaining.toLocaleString()} of remaining send room.`);
  }
  if (resting.length) {
    narrative.push(
      `${resting.length} sending domain${resting.length === 1 ? " is" : "s are"} resting after bounce trouble and will rejoin automatically` +
      (nextRevival ? ` (next revival ${nextRevival.slice(0, 10)})` : "") +
      // "Healthy domains carry the volume" is only true when they actually can.
      (fleetLimited ? "." : ". Healthy domains carry the volume meanwhile.")
    );
  }
  if (pl.status === "pass") narrative.push(`Latest Gmail seed test: ${pl.inbox} of ${pl.inbox + pl.spam} landed in the inbox, ${pl.spam ? `${pl.spam} in spam` : "none in spam"}. Growth above the base rate is unlocked.`);
  else if (pl.status === "stale") narrative.push("The Gmail seed test is over a week old, so growth above the base rate is paused until a fresh passing test.");
  else if (pl.status === "none") narrative.push("No Gmail seed test on record yet; volume holds at the base rate until one passes.");

  return ok({
    present: true,
    generatedAt: stats.generatedAt || null,
    verdict, headline, narrative: narrative.filter(Boolean),
    capacity: {
      capToday, rampCap: ramp.cap, base: ramp.base, ceiling: ramp.ceiling, growthUnlocked: ramp.growthUnlocked,
      sentToday, remaining, fleetBoxes, usableBoxes, benchedBoxes, perBox,
    },
    supply: { ready: supplyReady, message: gap.message || null, engineOk, engineLastRunAt: engine?.lastCurationAt || null },
    fleet: {
      domainsSending: deliv?.overall?.domainsSending || 0,
      domainsTotal: deliv?.overall?.domainsTotal || 0,
      warmupReputationPct: deliv?.overall?.warmupReputationPct ?? null,
      bounces: deliv?.overall?.bounces || 0,
      resting, nextRevival,
    },
    placement: pl,
    outcomes: { sentTotal: stats.sentTotal || 0, replies: stats.repliesTotal || 0 },
  });
}
