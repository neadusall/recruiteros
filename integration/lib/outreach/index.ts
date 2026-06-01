/**
 * RecruiterOS · Outreach readiness
 *
 * The Outreach tab's control surface. It composes one snapshot of everything a
 * customer must have working to send: the ATS connection, SMS (TalTxt), the
 * enrichment waterfall (with a credit balance), Job Search (the white-labelled
 * signal scraper), warming sending domains down to the individual inbox, and
 * the warming LinkedIn accounts — plus the per-motion activation gate.
 *
 * Provider names are deliberately NOT surfaced here. The customer sees
 * capabilities ("Enrichment waterfall", "Job Search"), never vendors, so what
 * pulls the data in stays our concern.
 *
 * Feature flags + the enrichment credit balance live in an in-memory, per-
 * workspace store, mirroring the rest of the reference engine.
 */

import { listIntegrations, preflight, type Integration } from "../connected";
import { listLinkedInAccounts, listDomains, type SendingDomain, type LinkedInAccount } from "../accounts";
import { nowIso } from "../core/ids";
import type { Motion } from "../core/types";

/* ---------------- feature + credit store ---------------- */

export interface OutreachFeatures {
  /** Run the enrichment waterfall (email/phone discovery) in the daily cadence. */
  enrichmentEnabled: boolean;
  /** Pull live hiring/intent signals from Job Search in the daily cadence. */
  jobSearchEnabled: boolean;
  /** Enrichment credits granted this period (e.g. by plan). */
  creditsIncluded: number;
  /** Enrichment credits consumed this period. */
  creditsUsed: number;
  lastTopUpAt?: string;
}

const DEFAULTS: OutreachFeatures = {
  enrichmentEnabled: true,
  jobSearchEnabled: true,
  creditsIncluded: 2000,
  creditsUsed: 0,
};

const features = new Map<string, OutreachFeatures>();

export function getFeatures(workspaceId: string): OutreachFeatures {
  let f = features.get(workspaceId);
  if (!f) { f = { ...DEFAULTS }; features.set(workspaceId, f); }
  return f;
}

export type FeatureKey = "enrichment" | "jobSearch";

export function setFeature(workspaceId: string, key: FeatureKey, on: boolean): OutreachFeatures {
  const f = getFeatures(workspaceId);
  if (key === "enrichment") f.enrichmentEnabled = on;
  else if (key === "jobSearch") f.jobSearchEnabled = on;
  return f;
}

/** Grant more enrichment credits (top-up / plan bump). */
export function topUpCredits(workspaceId: string, amount: number): OutreachFeatures {
  const f = getFeatures(workspaceId);
  f.creditsIncluded += Math.max(0, Math.round(amount));
  f.lastTopUpAt = nowIso();
  return f;
}

/** Consume credits when the waterfall enriches a contact (returns remaining). */
export function consumeCredits(workspaceId: string, n = 1): number {
  const f = getFeatures(workspaceId);
  f.creditsUsed = Math.min(f.creditsIncluded, f.creditsUsed + Math.max(0, Math.round(n)));
  return Math.max(0, f.creditsIncluded - f.creditsUsed);
}

/** Drop a workspace's feature state on hard reset. */
export function purgeWorkspaceOutreach(workspaceId: string): void {
  features.delete(workspaceId);
}

/* ---------------- snapshot ---------------- */

export type ReadyState = "ready" | "warming" | "action" | "off";

export interface InboxState {
  email: string;
  state: "warm" | "warming" | "paused";
  /** 0..100 warmup progress (informational). */
  warmupPct: number;
}

export interface DomainDetail {
  id: string;
  domain: string;
  health: SendingDomain["health"];
  bounceRate: number;
  state: ReadyState;
  inboxes: InboxState[];
}

export interface LinkedInDetail {
  id: string;
  handle: string;
  channel: "LinkedIn";
  warmup: LinkedInAccount["warmup"];
  warmupPct: number;
  state: ReadyState;
  limits: { connects: number; dms: number; profileViews: number };
  /** Plain-language note when the account needs attention; "" when healthy. */
  issue: string;
}

export interface OutreachSnapshot {
  ats: { connected: boolean; label: string; state: ReadyState; detail: string };
  sms: { connected: boolean; label: string; state: ReadyState; detail: string };
  enrichment: {
    enabled: boolean;
    state: ReadyState;
    credits: { included: number; used: number; remaining: number; low: boolean; pct: number };
    healthy: boolean;
    detail: string;
  };
  jobSearch: { enabled: boolean; label: string; state: ReadyState; healthy: boolean; detail: string };
  domains: {
    total: number;
    inboxesTotal: number;
    inboxesWarm: number;
    inboxesWarming: number;
    state: ReadyState;
    list: DomainDetail[];
  };
  linkedin: {
    total: number;
    warmed: number;
    flagged: number;
    state: ReadyState;
    list: LinkedInDetail[];
  };
  preflight: { ok: boolean; blocking: string[] };
}

const INBOX_LOCALS = ["outreach", "hello", "team", "talent", "intro", "hi", "connect", "reach"];

/** Synthesize the individual inboxes under a sending domain and their warm state. */
function inboxesFor(d: SendingDomain): InboxState[] {
  const n = Math.max(1, d.inboxes || 1);
  const paused = d.health === "blacklisted" || d.bounceRate >= 0.02;
  const out: InboxState[] = [];
  for (let i = 0; i < n; i++) {
    const email = `${INBOX_LOCALS[i % INBOX_LOCALS.length]}@${d.domain}`;
    let state: InboxState["state"];
    let warmupPct: number;
    if (paused) { state = "paused"; warmupPct = 0; }
    else if (d.health === "healthy") { state = "warm"; warmupPct = 100; }
    else {
      // "warming": ramp the inboxes so the first one(s) finish first.
      const warm = i < Math.ceil(n / 2);
      state = warm ? "warm" : "warming";
      warmupPct = warm ? 100 : 45 + i * 10;
    }
    out.push({ email, state, warmupPct: Math.min(100, warmupPct) });
  }
  return out;
}

function domainState(d: SendingDomain): ReadyState {
  if (d.health === "blacklisted" || d.bounceRate >= 0.02) return "action";
  if (d.health === "healthy") return "ready";
  return "warming";
}

function linkedinDetail(a: LinkedInAccount): LinkedInDetail {
  let state: ReadyState;
  let warmupPct: number;
  let issue = "";
  if (a.warmup === "flagged") {
    state = "action"; warmupPct = 0;
    issue = "Flagged by LinkedIn and paused. Lower daily actions and let it re-warm for a few days before resuming.";
  } else if (a.warmup === "warmed") {
    state = "ready"; warmupPct = 100;
  } else {
    state = "warming";
    // Ramp progress off the current connect quota (full quota ~= warmed).
    warmupPct = Math.min(95, Math.round(((a.quotas?.connects ?? 0) / 20) * 100));
    issue = "Warming up — daily limits are ramping automatically. Keep activity gentle until it's green.";
  }
  return {
    id: a.id,
    handle: a.handle,
    channel: "LinkedIn",
    warmup: a.warmup,
    warmupPct,
    state,
    limits: {
      connects: a.quotas?.connects ?? 0,
      dms: a.quotas?.dms ?? 0,
      profileViews: a.quotas?.profileViews ?? 0,
    },
    issue,
  };
}

function intg(list: Integration[], id: string): Integration | undefined {
  return list.find((i) => i.id === id);
}

/** Build the full Outreach readiness snapshot for a workspace + motion. */
export function outreachSnapshot(workspaceId: string, motion: Motion): OutreachSnapshot {
  const f = getFeatures(workspaceId);
  const ints = listIntegrations(workspaceId);

  // ATS (Loxo, surfaced generically as "your ATS").
  const loxo = intg(ints, "loxo");
  const atsConnected = loxo?.status === "green";
  const ats = {
    connected: atsConnected,
    label: "ATS (system of record)",
    state: (atsConnected ? "ready" : "action") as ReadyState,
    detail: atsConnected
      ? "Connected — every reply and touch logs to your ATS."
      : "Not connected. Connect your ATS so prospects, replies, and placements sync automatically.",
  };

  // SMS via TalTxt.
  const taltxt = intg(ints, "taltxt");
  const smsConnected = taltxt?.status === "green";
  const smsYellow = taltxt?.status === "yellow";
  const sms = {
    connected: smsConnected,
    label: "SMS (TalTxt)",
    state: (smsConnected ? "ready" : smsYellow ? "warming" : "action") as ReadyState,
    detail: smsConnected
      ? "Connected — post-engagement texts and opt-outs are live."
      : smsYellow
      ? "Key added — run a test to verify your TalTxt connection."
      : "Not connected. Connect TalTxt to add compliant SMS to your sequences.",
  };

  // Enrichment waterfall + credits. Healthy when its underlying providers verify.
  const enrichGreen = intg(ints, "fresh_linkedin")?.status === "green" || intg(ints, "tomba")?.status === "green";
  const remaining = Math.max(0, f.creditsIncluded - f.creditsUsed);
  const pct = f.creditsIncluded > 0 ? Math.round((remaining / f.creditsIncluded) * 100) : 0;
  const low = remaining <= Math.max(50, Math.round(f.creditsIncluded * 0.1));
  let enrichState: ReadyState;
  if (!f.enrichmentEnabled) enrichState = "off";
  else if (remaining <= 0) enrichState = "action";
  else if (low || !enrichGreen) enrichState = "warming";
  else enrichState = "ready";
  const enrichment = {
    enabled: f.enrichmentEnabled,
    state: enrichState,
    credits: { included: f.creditsIncluded, used: f.creditsUsed, remaining, low, pct },
    healthy: enrichGreen,
    detail: !f.enrichmentEnabled
      ? "Off. Turn on the waterfall to auto-find work emails and direct dials for new prospects."
      : remaining <= 0
      ? "Out of credits. Top up to keep finding contacts."
      : low
      ? `Running low — ${remaining.toLocaleString()} credits left.`
      : `${remaining.toLocaleString()} of ${f.creditsIncluded.toLocaleString()} credits available.`,
  };

  // Job Search — white-labelled signal scraper.
  const jobGreen = intg(ints, "rapidapi")?.status === "green";
  const jobSearch = {
    enabled: f.jobSearchEnabled,
    label: "Job Search",
    state: (!f.jobSearchEnabled ? "off" : jobGreen ? "ready" : "warming") as ReadyState,
    healthy: jobGreen,
    detail: !f.jobSearchEnabled
      ? "Off. Turn on Job Search to pull live hiring signals into your campaigns."
      : jobGreen
      ? "On — live hiring signals feed your daily cadence."
      : "On — connecting the live signal feed.",
  };

  // Domains, down to the inbox.
  const domList = listDomains(workspaceId).map((d) => ({
    id: d.id,
    domain: d.domain,
    health: d.health,
    bounceRate: d.bounceRate,
    state: domainState(d),
    inboxes: inboxesFor(d),
  }));
  const allInboxes = domList.flatMap((d) => d.inboxes);
  const inboxesWarm = allInboxes.filter((i) => i.state === "warm").length;
  const inboxesWarming = allInboxes.filter((i) => i.state === "warming").length;
  const domainsState: ReadyState = !domList.length
    ? "action"
    : domList.some((d) => d.state === "action")
    ? "action"
    : inboxesWarm > 0
    ? (inboxesWarming > 0 ? "warming" : "ready")
    : "warming";
  const domains = {
    total: domList.length,
    inboxesTotal: allInboxes.length,
    inboxesWarm,
    inboxesWarming,
    state: domainsState,
    list: domList,
  };

  // LinkedIn accounts.
  const liList = listLinkedInAccounts(workspaceId).map(linkedinDetail);
  const warmed = liList.filter((a) => a.warmup === "warmed").length;
  const flagged = liList.filter((a) => a.warmup === "flagged").length;
  const linkedinState: ReadyState = !liList.length
    ? "action"
    : flagged > 0
    ? "action"
    : warmed > 0
    ? (warmed < liList.length ? "warming" : "ready")
    : "warming";
  const linkedin = { total: liList.length, warmed, flagged, state: linkedinState, list: liList };

  return {
    ats,
    sms,
    enrichment,
    jobSearch,
    domains,
    linkedin,
    preflight: preflight(workspaceId, motion),
  };
}
