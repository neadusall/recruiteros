/**
 * GET /api/senders/warmup -> the live warm-up fleet, grouped by sending domain.
 *
 * Feeds the "Domain warm-up" panel on the Senders tab: every warm-up mailbox we
 * run upstream, rolled up per domain with reputation, volume, spam counts and
 * how long the domain has been warming, plus the per-mailbox rows for drill-down.
 *
 * PORTAL SPLIT: the fleet is shared infrastructure, but each portal only ever
 * sees its own brand's domains. A white-label portal (e.g. app.lumesp.com) sees
 * domains named after its brand ("lume…"); the house portal (recruitersos.co)
 * sees everything that is NOT claimed by a white-label brand (e.g. "tal…").
 *
 * ?fresh=1 bypasses the short server-side cache (the upstream list is paged and
 * slow, so we hold results for a couple of minutes between pulls).
 */
import { requireSession, ok } from "../../../../lib/api";
import { listSmartleadAccounts, smartleadConfigured, type SmartleadAccount } from "../../../../lib/sending/smartlead";
import { ensureConfig } from "../../../../lib/sending/config";
import { requestHost, tenantWorkspaceForHost } from "../../../../lib/branding/portal";
import { presetForHost, allBrandPresets } from "../../../../lib/branding/presets";

export const dynamic = "force-dynamic";

/* ---- short-lived fleet cache (upstream pull is ~15 paged calls) ---- */
const TTL_MS = 120_000;
let cache: { at: number; accounts: SmartleadAccount[] } | null = null;
let inflight: Promise<SmartleadAccount[]> | null = null;

async function fleet(fresh: boolean): Promise<{ accounts: SmartleadAccount[]; pulledAt: number }> {
  const now = Date.now();
  if (!fresh && cache && now - cache.at < TTL_MS) return { accounts: cache.accounts, pulledAt: cache.at };
  if (!inflight) {
    inflight = listSmartleadAccounts().finally(() => { inflight = null; });
  }
  const accounts = await inflight;
  // Never let one failed/empty pull wipe a good cache (best-effort upstream).
  if (accounts.length || !cache) cache = { at: Date.now(), accounts };
  return { accounts: cache.accounts, pulledAt: cache.at };
}

/** Brand token a domain is matched on: "Lume Search Partners" -> "lume". */
function token(brandName: string): string {
  return (brandName.split(/\s+/)[0] || "").toLowerCase();
}

function domainOf(email: string): string {
  return (email.split("@")[1] || "").toLowerCase();
}

export interface WarmupMailboxRow {
  email: string;
  status: "active" | "paused" | "unknown";
  reputationPct: number | null;
  sentTotal: number;
  spamCount: number;
  messagePerDay: number | null;
  dailySent: number | null;
  createdAt: string | null;
  days: number | null;
}

export interface WarmupDomainRow {
  domain: string;
  mailboxes: number;
  warming: number;
  paused: number;
  avgReputation: number | null;
  minReputation: number | null;
  since: string | null;
  days: number | null;
  sentTotal: number;
  spamCount: number;
  spamRatePct: number | null;
  readiness: "ready" | "warming" | "attention";
  accounts: WarmupMailboxRow[];
}

function round1(n: number): number { return Math.round(n * 10) / 10; }

function buildDomains(accounts: SmartleadAccount[], now: number): WarmupDomainRow[] {
  const byDomain = new Map<string, SmartleadAccount[]>();
  for (const a of accounts) {
    const d = domainOf(a.email);
    if (!d) continue;
    const list = byDomain.get(d) || [];
    list.push(a);
    byDomain.set(d, list);
  }
  const rows: WarmupDomainRow[] = [];
  for (const [domain, list] of byDomain) {
    const reps = list.map((a) => a.reputationPct).filter((r): r is number => typeof r === "number");
    const createds = list.map((a) => a.createdAt).filter((c): c is string => !!c).sort();
    const since = createds[0] || null;
    const days = since ? round1((now - new Date(since).getTime()) / 86_400_000) : null;
    const sentTotal = list.reduce((s, a) => s + (a.sentTotal || 0), 0);
    const spamCount = list.reduce((s, a) => s + (a.spamCount || 0), 0);
    const warming = list.filter((a) => a.warmupStatus === "active").length;
    const paused = list.filter((a) => a.warmupStatus === "paused").length;
    const avgReputation = reps.length ? Math.round(reps.reduce((s, r) => s + r, 0) / reps.length) : null;
    const minReputation = reps.length ? Math.min(...reps) : null;
    const spamRatePct = sentTotal > 0 ? round1((spamCount / sentTotal) * 100) : null;
    let readiness: WarmupDomainRow["readiness"] = "warming";
    if (paused > 0 || (spamRatePct != null && spamRatePct > 2) || (days != null && days >= 7 && avgReputation != null && avgReputation < 60)) {
      readiness = "attention";
    } else if (days != null && days >= 14 && avgReputation != null && avgReputation >= 95) {
      readiness = "ready";
    }
    rows.push({
      domain,
      mailboxes: list.length,
      warming,
      paused,
      avgReputation,
      minReputation,
      since,
      days,
      sentTotal,
      spamCount,
      spamRatePct,
      readiness,
      accounts: list
        .map((a): WarmupMailboxRow => ({
          email: a.email,
          status: a.warmupStatus === "active" ? "active" : a.warmupStatus === "paused" ? "paused" : "unknown",
          reputationPct: a.reputationPct ?? null,
          sentTotal: a.sentTotal || 0,
          spamCount: a.spamCount || 0,
          messagePerDay: a.messagePerDay ?? null,
          dailySent: a.dailySent ?? null,
          createdAt: a.createdAt || null,
          days: a.createdAt ? round1((now - new Date(a.createdAt).getTime()) / 86_400_000) : null,
        }))
        .sort((x, y) => x.email.localeCompare(y.email)),
    });
  }
  // Oldest cohorts first, then alphabetical - the reading order an operator wants.
  rows.sort((x, y) => (x.since || "9999").localeCompare(y.since || "9999") || x.domain.localeCompare(y.domain));
  return rows;
}

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  await ensureConfig();
  if (!smartleadConfigured()) {
    return ok({ configured: false, updatedAt: null, domains: [], totals: null });
  }
  const url = new URL(req.url);
  const fresh = url.searchParams.get("fresh") === "1";
  const { accounts, pulledAt } = await fleet(fresh);
  const now = Date.now();

  // Portal split: tenant portals see their brand's domains; the house portal
  // sees everything no white-label brand has a claim on.
  const host = requestHost(req);
  const tenantWs = tenantWorkspaceForHost(host);
  const tenantToken = tenantWs ? token(presetForHost(host)?.brandName || "") : "";
  const houseExcluded = allBrandPresets().map((p) => token(p.brandName)).filter(Boolean);

  let domains = buildDomains(accounts, now);
  domains = tenantWs
    ? (tenantToken ? domains.filter((d) => d.domain.startsWith(tenantToken)) : [])
    : domains.filter((d) => !houseExcluded.some((t) => d.domain.startsWith(t)));

  const totals = {
    domains: domains.length,
    mailboxes: domains.reduce((s, d) => s + d.mailboxes, 0),
    warming: domains.reduce((s, d) => s + d.warming, 0),
    paused: domains.reduce((s, d) => s + d.paused, 0),
    ready: domains.filter((d) => d.readiness === "ready").length,
    attention: domains.filter((d) => d.readiness === "attention").length,
    avgReputation: (() => {
      const reps = domains.map((d) => d.avgReputation).filter((r): r is number => r != null);
      return reps.length ? Math.round(reps.reduce((s, r) => s + r, 0) / reps.length) : null;
    })(),
    sentTotal: domains.reduce((s, d) => s + d.sentTotal, 0),
    spamCount: domains.reduce((s, d) => s + d.spamCount, 0),
  };
  return ok({ configured: true, updatedAt: new Date(pulledAt).toISOString(), domains, totals });
}
