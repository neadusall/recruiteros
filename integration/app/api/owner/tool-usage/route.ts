/**
 * /api/owner/tool-usage  (OWNER ONLY)
 *
 * The Tools & Credits monitor behind Owner Console -> Tools & Credits. Reads the LIVE
 * RapidAPI credit meters (captured from every response's quota headers) plus their 120-day
 * usage history, and projects each subscription forward: average daily burn, days-to-empty,
 * and whether it will run dry BEFORE its monthly window resets. That projection is the point,
 * it tells us which package to upgrade, and when, to keep the send pipeline from throttling as
 * we scale toward 4K/day. Reoon (email validation) has no balance endpoint, so it's reported by
 * live engine consumption instead.
 *
 *   GET ?days=14  -> { tools: [...], alerts: [...], generatedAt }
 */

import { requireOwner, ok } from "../../../../lib/api";
import { getRapidQuota, getRapidQuotaHistory } from "../../../../lib/sourcing/rapidQuota";
import { reoonStatus } from "../../../../lib/inmarket/reoon";

const DAY_MS = 86_400_000;

// Friendly identity for each metered listing, by kind, so the panel reads in business terms
// (what the credit actually buys) instead of raw RapidAPI hostnames.
const KIND_META: Record<string, { label: string; powers: string }> = {
  jobs: { label: "JSearch · Job Sourcing", powers: "Finds companies hiring finance roles (Lane A signal)" },
  people: { label: "Decision-Maker Lookup", powers: "Resolves the CFO / Controller at each company" },
  phone: { label: "Skip-Trace · Phone", powers: "Direct-dial numbers for outreach" },
  search: { label: "SERP · Naming", powers: "Names decision-makers via paid web search" },
};

export async function GET(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;

  const url = new URL(req.url);
  const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 14, 7), 90);
  const now = Date.now();

  const quotas = await getRapidQuota();
  const tools: Array<Record<string, unknown>> = [];
  const alerts: Array<{ tool: string; message: string }> = [];

  for (const q of quotas) {
    const hist = await getRapidQuotaHistory(q.host, days);
    // Average daily burn over the trailing window that actually has activity (ignore leading
    // zero days so a subscription used for 2 days isn't averaged across 14).
    const active = hist.filter((h) => h.used > 0);
    const spent = active.reduce((s, h) => s + h.used, 0);
    const avgDaily = active.length ? spent / active.length : 0;
    const remaining = Number(q.remaining) || 0;
    const limit = Number(q.limit) || 0;
    const pctUsed = limit ? Math.round((q.used / limit) * 100) : 0;
    const daysToEmpty = avgDaily > 0 ? remaining / avgDaily : Infinity;
    const daysToReset = q.resetAt ? Math.max(0, (Date.parse(q.resetAt) - now) / DAY_MS) : null;
    // Critical = will run dry BEFORE the window resets (a scaling blocker). Watch = >80% used.
    const willDeplete = daysToReset != null && Number.isFinite(daysToEmpty) && daysToEmpty < daysToReset;
    const status = willDeplete ? "critical" : pctUsed >= 80 ? "watch" : "ok";
    const meta = KIND_META[q.kind || "people"] || { label: q.host, powers: "" };

    const tool = {
      key: q.host,
      label: meta.label,
      powers: meta.powers,
      host: q.host,
      kind: q.kind || "people",
      limit,
      used: Number(q.used) || 0,
      remaining,
      pctUsed,
      resetAt: q.resetAt || null,
      updatedAt: q.updatedAt,
      avgDaily: Math.round(avgDaily * 10) / 10,
      daysToEmpty: Number.isFinite(daysToEmpty) ? Math.round(daysToEmpty * 10) / 10 : null,
      daysToReset: daysToReset == null ? null : Math.round(daysToReset * 10) / 10,
      status,
      history: hist, // [{date, used}] daily deltas for the sparkline
      metered: true,
    };
    tools.push(tool);
    if (status === "critical") {
      alerts.push({
        tool: meta.label,
        message: `${meta.label} burns ~${tool.avgDaily}/day and will run out in ~${tool.daysToEmpty}d, before it resets in ~${tool.daysToReset}d. Upgrade the package.`,
      });
    }
  }

  // Reoon has no balance endpoint (probed: all 404), so report by live engine consumption.
  const reoon = await reoonStatus().catch(() => null);
  if (reoon) {
    tools.push({
      key: "reoon",
      label: "Reoon · Email Validation",
      powers: "Validates every decision-maker email before it can send",
      host: "emailverifier.reoon.com",
      kind: "validation",
      limit: 0,
      used: 0,
      remaining: 0,
      pctUsed: 0,
      resetAt: null,
      updatedAt: reoon.lastRun ? new Date(reoon.lastRun).toISOString() : null,
      avgDaily: 0,
      daysToEmpty: null,
      daysToReset: null,
      status: reoon.enabled ? (reoon.lastError ? "watch" : "ok") : "critical",
      history: [],
      metered: false,
      note: reoon.enabled
        ? `Engine active. Last run validated ${reoon.lastApplied || 0} emails${reoon.lastError ? ` (last error: ${reoon.lastError})` : ""}. Credit balance is on the Reoon dashboard (no live API).`
        : "REOON_API_KEY not set, validation is OFF, which blocks the whole send pipeline.",
    });
    if (!reoon.enabled) alerts.push({ tool: "Reoon · Email Validation", message: "Reoon is not configured; validated-only enrollment means NOTHING can send. Set REOON_API_KEY." });
  }

  // KoldInfo is an owned bulk DB (no per-call meter), surfaced so it's on the same board.
  tools.push({
    key: "koldinfo",
    label: "KoldInfo · Bulk Contact DB",
    powers: "129M-person / 57M-email owned DB, bulk email-find (Lane B volume)",
    host: "koldinfo", kind: "database", limit: 0, used: 0, remaining: 0, pctUsed: 0,
    resetAt: null, updatedAt: null, avgDaily: 0, daysToEmpty: null, daysToReset: null,
    status: "ok", history: [], metered: false,
    note: "Owned subscription (flat plan, no per-call quota). Being leveraged as the volume email-finder to spare the metered Decision-Maker Lookup credits.",
  });

  return ok({ generatedAt: new Date().toISOString(), windowDays: days, alerts, tools });
}
