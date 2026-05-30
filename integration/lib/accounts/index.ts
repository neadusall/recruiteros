/**
 * RecruiterOS · Accounts
 * LinkedIn sending accounts, sending domains, and API keys, with the health /
 * warmup automations from the reference Accounts tab.
 *
 *  - LinkedIn accounts: per-account daily action quotas, warmup tracking,
 *    auto-pause when LinkedIn flags an account.
 *  - Domains: 3 inboxes each, daily Instantly /vitals sync, auto-pause when
 *    bounce >= 2% or blacklisted.
 *  - API keys: stored masked (the reference keeps these client-side).
 */

import { rid, nowIso } from "../core/ids";

/* ---------------- LinkedIn accounts ---------------- */

export type LinkedInPlatform =
  | "unipile" | "salesrobot" | "meet_alfred" | "dripify" | "heyreach"
  | "lagrowthmachine" | "phantombuster" | "expandi" | "waalaxy" | "linkedhelper"
  | "skylead" | "closely" | "zopto" | "octopus" | "lemlist" | "meet_leonard" | "custom";

export interface LinkedInAccount {
  id: string;
  workspaceId: string;
  handle: string;                       // email / username
  platform: LinkedInPlatform;
  warmup: "in_warmup" | "warmed" | "flagged";
  quotas: { connects: number; dms: number; profileViews: number };
  active: boolean;
  createdAt: string;
}

/* ---------------- Sending domains ---------------- */

export interface SendingDomain {
  id: string;
  workspaceId: string;
  domain: string;
  inboxes: number;                      // typically 3
  health: "healthy" | "warming" | "bouncing" | "blacklisted";
  bounceRate: number;                   // 0..1
  spamRate: number;
  active: boolean;
}

/* ---------------- API keys ---------------- */

export interface ApiKey {
  id: string;
  workspaceId: string;
  service: string;                      // Instantly / SalesRobot / RapidAPI / ...
  masked: string;                       // e.g. "sk-...4f2a"
  lastUsed?: string;
  createdAt: string;
}

const linkedinAccounts: LinkedInAccount[] = [];
const domains: SendingDomain[] = [];
const apiKeys: ApiKey[] = [];

/* LinkedIn accounts */
export function addLinkedInAccount(workspaceId: string, handle: string, platform: LinkedInPlatform): LinkedInAccount {
  const a: LinkedInAccount = {
    id: rid("liacc"), workspaceId, handle, platform, warmup: "in_warmup",
    quotas: { connects: 20, dms: 25, profileViews: 40 }, active: true, createdAt: nowIso(),
  };
  linkedinAccounts.push(a);
  return a;
}
export function listLinkedInAccounts(workspaceId: string): LinkedInAccount[] {
  return linkedinAccounts.filter((a) => a.workspaceId === workspaceId);
}

/* Domains */
export function addDomain(workspaceId: string, domain: string, inboxes = 3): SendingDomain {
  const d: SendingDomain = {
    id: rid("dom"), workspaceId, domain, inboxes, health: "warming",
    bounceRate: 0, spamRate: 0, active: true,
  };
  domains.push(d);
  return d;
}
export function listDomains(workspaceId: string): SendingDomain[] {
  return domains.filter((d) => d.workspaceId === workspaceId);
}

/* API keys */
export function addApiKey(workspaceId: string, service: string, rawKey: string): ApiKey {
  const k: ApiKey = {
    id: rid("key"), workspaceId, service, masked: mask(rawKey), createdAt: nowIso(),
  };
  apiKeys.push(k);
  return k;
}
export function listApiKeys(workspaceId: string): ApiKey[] {
  return apiKeys.filter((k) => k.workspaceId === workspaceId);
}
function mask(key: string): string {
  return key.length <= 6 ? "***" : `${key.slice(0, 3)}...${key.slice(-4)}`;
}

/**
 * Nightly health sweep. Domains pull Instantly /vitals; bounce >= 2% or a
 * blacklist flag auto-pauses. LinkedIn accounts flagged by the provider
 * auto-pause. Returns what changed for the Overview alert strip.
 */
export function runHealthSweep(workspaceId: string, vitals?: Record<string, { bounceRate?: number; blacklisted?: boolean }>): string[] {
  const alerts: string[] = [];
  for (const d of listDomains(workspaceId)) {
    const v = vitals?.[d.domain];
    if (v?.bounceRate !== undefined) d.bounceRate = v.bounceRate;
    if (v?.blacklisted) d.health = "blacklisted";
    if (d.health === "blacklisted" || d.bounceRate >= 0.02) {
      if (d.active) { d.active = false; alerts.push(`Domain ${d.domain} auto-paused (${d.health}, bounce ${(d.bounceRate * 100).toFixed(1)}%)`); }
    }
  }
  for (const a of listLinkedInAccounts(workspaceId)) {
    if (a.warmup === "flagged" && a.active) { a.active = false; alerts.push(`LinkedIn ${a.handle} auto-paused (flagged)`); }
  }
  return alerts;
}

export const LINKEDIN_PLATFORMS: LinkedInPlatform[] = [
  "unipile", "salesrobot", "meet_alfred", "dripify", "heyreach", "lagrowthmachine",
  "phantombuster", "expandi", "waalaxy", "linkedhelper", "skylead", "closely",
  "zopto", "octopus", "lemlist", "meet_leonard", "custom",
];
