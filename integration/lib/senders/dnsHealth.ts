/**
 * RecruitersOS · Senders · Domain DNS health (Zapmail source)
 *
 * Answers one question on an hourly cadence: for every sending domain in the
 * portal's Zapmail account, is its authentication posture (MX / SPF / DKIM /
 * DMARC) actually live on the public internet right now?
 *
 * WHY a separate module from warmup/route.ts: that panel sources domains from
 * the Smartlead warm-up fleet, so a domain only appears once it is warming.
 * These are the domains as Zapmail knows them (the system of record for what we
 * actually own), pulled straight from the Zapmail API, then verified against
 * PUBLIC DNS (dnsProbe) — which is authoritative for what is really published,
 * regardless of what Zapmail's reseller intended to set.
 *
 * The Zapmail API is management-only: it lists domains, it does NOT return
 * mailbox SMTP credentials (those come from the Zapmail CSV export). So this
 * module reads domains + status and never touches secrets.
 *
 * Persistence: one snapshot per RecruitersOS workspace (`dnshealth_<wsId>`), so
 * the panel renders instantly and the sweep can run on a timer independent of
 * anyone viewing. A single portal (Lume) owns the Zapmail account today; the key
 * is global. Per-tenant keys can be added later without changing the shape.
 */

import { probeDnsMany } from "../sending/dnsProbe";
import { loadSnapshot, saveSnapshot } from "../db";

const API_BASE = process.env.ZAPMAIL_API_BASE || "https://api.zapmail.ai/api";
const SERVICE_PROVIDER = process.env.ZAPMAIL_SERVICE_PROVIDER || "GOOGLE";

export interface DomainDnsHealth {
  domain: string;
  zapmailStatus: string | null; // Zapmail's own domain status (e.g. ACTIVE)
  mx: boolean;
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
  dmarcPolicy: string | null;
  dkimSelector: string | null;
  ok: boolean; // MX + SPF + DKIM + DMARC all live
  checkedAt: string;
}

export interface DnsHealthSnapshot {
  workspaceId: string;
  source: "zapmail";
  checkedAt: string;
  totals: { domains: number; healthy: number; incomplete: number };
  domains: DomainDnsHealth[];
  incomplete: string[];
}

export function zapmailConfigured(): boolean {
  return !!(process.env.ZAPMAIL_API_KEY && process.env.ZAPMAIL_API_KEY.trim());
}

function headers(workspaceKey?: string): Record<string, string> {
  const h: Record<string, string> = {
    "x-auth-zapmail": (process.env.ZAPMAIL_API_KEY || "").trim(),
    "x-service-provider": SERVICE_PROVIDER,
    "Content-Type": "application/json",
  };
  const ws = workspaceKey || process.env.ZAPMAIL_WORKSPACE_KEY;
  if (ws) h["x-workspace-key"] = ws.trim();
  return h;
}

async function zapmailJson(path: string, workspaceKey?: string): Promise<any | null> {
  try {
    const r = await fetch(`${API_BASE}${path}`, { headers: headers(workspaceKey) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** The Zapmail workspace id the API key resolves to (cached for the process). */
let cachedWorkspaceKey: string | null = null;
async function zapmailWorkspaceKey(): Promise<string | null> {
  if (process.env.ZAPMAIL_WORKSPACE_KEY) return process.env.ZAPMAIL_WORKSPACE_KEY.trim();
  if (cachedWorkspaceKey) return cachedWorkspaceKey;
  const j = await zapmailJson("/v2/workspaces");
  const id = j?.data?.currentWorkspace?.id || null;
  if (id) cachedWorkspaceKey = id;
  return id;
}

/** All domains in the Zapmail account (paginated), as { domain, status }. */
export async function zapmailDomains(): Promise<Array<{ domain: string; status: string | null }>> {
  if (!zapmailConfigured()) return [];
  const wsKey = await zapmailWorkspaceKey();
  if (!wsKey) return [];
  const out: Array<{ domain: string; status: string | null }> = [];
  for (let page = 1; page <= 50; page++) {
    const j = await zapmailJson(`/v2/domains?page=${page}&limit=50`, wsKey);
    const arr: any[] = j?.data?.domains || [];
    for (const d of arr) if (d?.domain) out.push({ domain: String(d.domain).toLowerCase(), status: d.status ?? null });
    const totalPages = Number(j?.data?.totalPages || 1);
    if (!arr.length || page >= totalPages) break;
  }
  return out;
}

const SNAP_KEY = (workspaceId: string) => `dnshealth_${workspaceId}`;

/** In-flight guard: never run two sweeps for the same workspace at once. */
const inflight = new Map<string, Promise<DnsHealthSnapshot | null>>();

/**
 * Pull Zapmail domains, verify each against live public DNS, persist + return
 * the snapshot. Best-effort: returns null only when Zapmail is unconfigured or
 * returns no domains (so we never overwrite a good snapshot with an empty one).
 */
export async function refreshDnsHealth(workspaceId: string): Promise<DnsHealthSnapshot | null> {
  const existing = inflight.get(workspaceId);
  if (existing) return existing;
  const run = (async (): Promise<DnsHealthSnapshot | null> => {
    if (!zapmailConfigured()) return null;
    const domains = await zapmailDomains();
    if (!domains.length) return null;
    const statusByDomain = new Map(domains.map((d) => [d.domain, d.status]));
    const postures = await probeDnsMany(domains.map((d) => d.domain));
    const rows: DomainDnsHealth[] = domains.map(({ domain }) => {
      const p = postures.get(domain);
      const mx = !!p?.mx, spf = !!p?.spf, dkim = !!p?.dkim, dmarc = !!p?.dmarc;
      return {
        domain,
        zapmailStatus: statusByDomain.get(domain) ?? null,
        mx, spf, dkim, dmarc,
        dmarcPolicy: p?.dmarcPolicy ?? null,
        dkimSelector: p?.dkimSelector ?? null,
        ok: mx && spf && dkim && dmarc,
        checkedAt: p?.checkedAt || new Date().toISOString(),
      };
    });
    rows.sort((a, b) => Number(a.ok) - Number(b.ok) || a.domain.localeCompare(b.domain));
    const incomplete = rows.filter((r) => !r.ok).map((r) => r.domain);
    const snap: DnsHealthSnapshot = {
      workspaceId,
      source: "zapmail",
      checkedAt: new Date().toISOString(),
      totals: { domains: rows.length, healthy: rows.length - incomplete.length, incomplete: incomplete.length },
      domains: rows,
      incomplete,
    };
    await saveSnapshot(SNAP_KEY(workspaceId), snap);
    return snap;
  })().finally(() => inflight.delete(workspaceId));
  inflight.set(workspaceId, run);
  return run;
}

/** Latest persisted snapshot for a workspace (null if never swept). */
export async function getDnsHealth(workspaceId: string): Promise<DnsHealthSnapshot | null> {
  return loadSnapshot<DnsHealthSnapshot>(SNAP_KEY(workspaceId));
}

export function snapshotAgeMs(snap: DnsHealthSnapshot | null): number {
  if (!snap?.checkedAt) return Infinity;
  return Date.now() - new Date(snap.checkedAt).getTime();
}
