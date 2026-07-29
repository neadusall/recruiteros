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
import { probeDnsMany, cachedDns, type DnsPosture } from "../../../../lib/sending/dnsProbe";
import { listInboxes, SENDING_AC_PER_INBOX, coldMaxPerInbox } from "../../../../lib/senders";

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
  /** SMTP state of the matching Email ID on THIS portal (null = not imported). */
  smtpStatus: string | null;
  smtpError: string | null;
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
  /** Live DNS posture; null while the first probe is still resolving. */
  dns: {
    spf: boolean; dkim: boolean; dmarc: boolean; mx: boolean;
    dmarcPolicy: string | null; dkimSelector: string | null; checkedAt: string;
    /** Public spam-blocklist state (Spamhaus DBL/ZEN, best-effort). */
    blacklisted: boolean; blocklists: string[];
  } | null;
  /** Composite deliverability health, 0-100 + label. */
  health: { score: number; label: "healthy" | "watch" | "at_risk" };
  /** What an operator should do next for this domain (ordered, most urgent first). */
  actions: string[];
  /** Email IDs from this domain imported on THIS portal (the send side). */
  emailIds: { total: number; active: number; error: number };
  /** Which sending infrastructure this domain rides: Sending.ac's provisioned
   *  mailboxes (flat 2 cold/day each) or the internal SMTP server (warm-up ramp).
   *  Resolved from imported Email IDs first, then the domain's live MX records. */
  infra: { kind: "sending-ac" | "internal-smtp" | "unknown"; source: "email-ids" | "mx" | "none"; coldPerDay: number | null };
  /** Warm-up throughput the upstream schedule is running at (emails/day, summed)
   *  and the average reply rate. Meaningful even when cumulative sends read 0. */
  warmupPerDay: number | null;
  replyRatePct: number | null;
  accounts: WarmupMailboxRow[];
}

function round1(n: number): number { return Math.round(n * 10) / 10; }

/** Hostnames that identify the INTERNAL SMTP server(s): the watch list plus the
 *  Mailcow host (e.g. mail.lumesp.com on the RackNerd box). */
function internalSmtpHosts(): string[] {
  const hosts: string[] = [];
  try {
    const raw = process.env.SMTP_WATCH_HOSTS;
    if (raw) for (const w of JSON.parse(raw)) if (w?.host) hosts.push(String(w.host).toLowerCase());
  } catch { /* bad JSON: the Mailcow host below still applies */ }
  try {
    const base = process.env.MAILCOW_API_BASE_URL;
    if (base) hosts.push(new URL(base).hostname.toLowerCase());
  } catch { /* unset/invalid: watch hosts above still apply */ }
  return hosts.filter(Boolean);
}

/**
 * Which infrastructure a warm-up domain sends through. Imported Email IDs are the
 * ground truth (their provider field says who runs the mailbox); a domain with no
 * imports yet is classified by its live MX: Sending.ac provisions MS-based
 * mailboxes (protection.outlook.com MX), the internal server answers its own MX.
 */
function classifyInfra(d: WarmupDomainRow, local: { provider?: string }[], p: DnsPosture | null): WarmupDomainRow["infra"] {
  const provs = new Set(local.map((m) => m.provider));
  if (provs.has("sending-ac")) return { kind: "sending-ac", source: "email-ids", coldPerDay: d.mailboxes * SENDING_AC_PER_INBOX };
  if (provs.has("own-smtp")) return { kind: "internal-smtp", source: "email-ids", coldPerDay: d.mailboxes * coldMaxPerInbox() };
  const mx = (p?.mxHosts || []).join(" ").toLowerCase();
  if (/protection\.outlook\.com/.test(mx)) return { kind: "sending-ac", source: "mx", coldPerDay: d.mailboxes * SENDING_AC_PER_INBOX };
  if (internalSmtpHosts().some((h) => mx.includes(h))) return { kind: "internal-smtp", source: "mx", coldPerDay: d.mailboxes * coldMaxPerInbox() };
  return { kind: "unknown", source: "none", coldPerDay: null };
}

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
    // Prefer the true warm-up start (warmup_created_at) over the account's
    // upstream created_at; fall back to created_at where warm-up hasn't stamped one.
    const createds = list.map((a) => a.warmupStartedAt || a.createdAt).filter((c): c is string => !!c).sort();
    const since = createds[0] || null;
    const perDays = list.map((a) => a.warmupPerDay).filter((n): n is number => typeof n === "number");
    const warmupPerDay = perDays.length ? perDays.reduce((s, n) => s + n, 0) : null;
    const replies = list.map((a) => a.replyRatePct).filter((n): n is number => typeof n === "number");
    const replyRatePct = replies.length ? Math.round(replies.reduce((s, n) => s + n, 0) / replies.length) : null;
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
      dns: null,
      health: { score: 0, label: "watch" },
      actions: [],
      emailIds: { total: 0, active: 0, error: 0 },
      infra: { kind: "unknown", source: "none", coldPerDay: null },
      warmupPerDay,
      replyRatePct,
      accounts: list
        .map((a): WarmupMailboxRow => ({
          email: a.email,
          status: a.warmupStatus === "active" ? "active" : a.warmupStatus === "paused" ? "paused" : "unknown",
          reputationPct: a.reputationPct ?? null,
          sentTotal: a.sentTotal || 0,
          spamCount: a.spamCount || 0,
          messagePerDay: a.warmupPerDay ?? a.messagePerDay ?? null,
          dailySent: a.dailySent ?? null,
          createdAt: a.warmupStartedAt || a.createdAt || null,
          days: (a.warmupStartedAt || a.createdAt) ? round1((now - new Date((a.warmupStartedAt || a.createdAt) as string).getTime()) / 86_400_000) : null,
          smtpStatus: null,
          smtpError: null,
        }))
        .sort((x, y) => x.email.localeCompare(y.email)),
    });
  }
  // Oldest cohorts first, then alphabetical - the reading order an operator wants.
  rows.sort((x, y) => (x.since || "9999").localeCompare(y.since || "9999") || x.domain.localeCompare(y.domain));
  return rows;
}

/**
 * Composite deliverability health for one domain: warm-up reputation carries
 * most of the weight, then live DNS posture, spam outcomes and fleet state.
 * DKIM is a soft signal (selector may just not be guessable), so it costs
 * little and never triggers an at_risk on its own.
 */
function computeHealth(d: WarmupDomainRow): { score: number; label: "healthy" | "watch" | "at_risk" } {
  let score = 0;
  score += (d.avgReputation ?? 50) * 0.45;                                   // 0-45
  if (d.spamRatePct == null || d.spamRatePct <= 0.5) score += 15;            // 0-15
  else if (d.spamRatePct <= 2) score += 8;
  if (d.dns) {
    score += (d.dns.spf ? 9 : 0) + (d.dns.dmarc ? 9 : 0) + (d.dns.mx ? 4 : 0) + (d.dns.dkim ? 3 : 0); // 0-25
  } else {
    score += 18;                                                             // unknown DNS: neutral, not punitive
  }
  score += Math.max(0, 15 - d.paused * 3);                                   // 0-15
  // A confirmed public-blocklist listing is an emergency regardless of warm-up
  // reputation: cap the score so the domain always reads at_risk until delisted.
  if (d.dns?.blacklisted) score = Math.min(score, 40);
  const s = Math.round(Math.min(100, score));
  return { score: s, label: s >= 85 ? "healthy" : s >= 65 ? "watch" : "at_risk" };
}

function computeActions(d: WarmupDomainRow): string[] {
  const a: string[] = [];
  if (d.dns?.blacklisted) a.push(`Listed on a public spam blocklist (${d.dns.blocklists.join(", ")}), pause this domain's sending and request delisting before resuming`);
  if (d.paused > 0) a.push(`Resume ${d.paused} paused mailbox${d.paused === 1 ? "" : "es"} in warm-up`);
  if (d.spamRatePct != null && d.spamRatePct > 2) a.push(`Spam rate ${d.spamRatePct}% is high, slow this domain's ramp and let reputation recover`);
  if (d.days != null && d.days >= 7 && d.avgReputation != null && d.avgReputation < 60) a.push("Reputation is low after a week of warming, reduce daily warm-up volume for this domain");
  if (d.dns) {
    if (!d.dns.spf) a.push("SPF record missing, add a v=spf1 TXT record at the domain root");
    if (!d.dns.dmarc) a.push("DMARC record missing, add _dmarc TXT (start with p=none)");
    if (!d.dns.mx) a.push("MX record missing, replies and warm-up threads cannot route back");
    if (!d.dns.dkim) a.push("DKIM not visible on common selectors, confirm the mail host's DKIM record");
    if (d.dns.dmarc && (d.dns.dmarcPolicy || "none") === "none" && d.days != null && d.days >= 21) a.push("Domain is stable, tighten DMARC from p=none to p=quarantine");
  }
  if (d.readiness === "ready" && d.emailIds.total === 0) a.push("Warmed and ready, import this domain's mailboxes as Email IDs to start sending");
  if (d.emailIds.error > 0) a.push(`${d.emailIds.error} Email ID${d.emailIds.error === 1 ? "" : "s"} on this portal in SMTP error, open Senders list and Test them`);
  if (!a.length && d.readiness === "warming" && d.days != null && d.days < 14) {
    a.push(`On track, ${Math.max(1, Math.ceil(14 - d.days))} more day${14 - d.days > 1 ? "s" : ""} to the 14-day mark`);
  }
  return a;
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

  // Live DNS posture, timeboxed: whatever resolves in time ships now, the
  // probe keeps filling its cache in the background for the next poll.
  const domainNames = domains.map((d) => d.domain);
  const probe = probeDnsMany(domainNames);
  await Promise.race([probe, new Promise((r) => setTimeout(r, 8000))]);
  const dnsFor = (name: string): DnsPosture | null => cachedDns(name);

  // This portal's imported Email IDs (the send side), blended in per domain.
  const inboxes = await listInboxes(g.ctx.workspace.id);
  const inboxByEmail = new Map(inboxes.map((m) => [m.email.toLowerCase(), m]));

  for (const d of domains) {
    const p = dnsFor(d.domain);
    d.dns = p ? {
      spf: p.spf, dkim: p.dkim, dmarc: p.dmarc, mx: p.mx,
      dmarcPolicy: p.dmarcPolicy || null, dkimSelector: p.dkimSelector || null, checkedAt: p.checkedAt,
      blacklisted: !!p.dnsbl?.listed, blocklists: p.dnsbl?.lists || [],
    } : null;
    const local = inboxes.filter((m) => m.email.toLowerCase().endsWith("@" + d.domain));
    d.emailIds = {
      total: local.length,
      active: local.filter((m) => m.status === "active").length,
      error: local.filter((m) => m.status === "error").length,
    };
    for (const row of d.accounts) {
      const m = inboxByEmail.get(row.email);
      if (m) {
        row.smtpStatus = m.status;
        row.smtpError = m.lastError || null;
      }
    }
    d.infra = classifyInfra(d, local, p);
    d.health = computeHealth(d);
    d.actions = computeActions(d);
  }

  const totals = {
    domains: domains.length,
    mailboxes: domains.reduce((s, d) => s + d.mailboxes, 0),
    warming: domains.reduce((s, d) => s + d.warming, 0),
    paused: domains.reduce((s, d) => s + d.paused, 0),
    ready: domains.filter((d) => d.readiness === "ready").length,
    attention: domains.filter((d) => d.readiness === "attention").length,
    healthy: domains.filter((d) => d.health.label === "healthy").length,
    atRisk: domains.filter((d) => d.health.label === "at_risk").length,
    blacklisted: domains.filter((d) => d.dns?.blacklisted).length,
    avgHealth: domains.length ? Math.round(domains.reduce((s, d) => s + d.health.score, 0) / domains.length) : null,
    avgReputation: (() => {
      const reps = domains.map((d) => d.avgReputation).filter((r): r is number => r != null);
      return reps.length ? Math.round(reps.reduce((s, r) => s + r, 0) / reps.length) : null;
    })(),
    sentTotal: domains.reduce((s, d) => s + d.sentTotal, 0),
    spamCount: domains.reduce((s, d) => s + d.spamCount, 0),
    // Infrastructure split: Sending.ac's flat 2/day mailboxes vs the internal
    // SMTP server's ramping mailboxes; the UI renders each with its own math.
    byInfra: (["sending-ac", "internal-smtp", "unknown"] as const).map((kind) => {
      const rows = domains.filter((d) => d.infra.kind === kind);
      return {
        kind,
        domains: rows.length,
        mailboxes: rows.reduce((s, d) => s + d.mailboxes, 0),
        coldPerDay: rows.reduce((s, d) => s + (d.infra.coldPerDay || 0), 0),
      };
    }),
  };
  return ok({ configured: true, updatedAt: new Date(pulledAt).toISOString(), domains, totals });
}
