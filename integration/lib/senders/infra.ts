/**
 * RecruitersOS · Senders · SMTP infrastructure health
 *
 * The send side of the stable-system picture: are the SMTP endpoints our Email
 * IDs actually send through (own Mailcow server, Sending.ac, any provider) up,
 * answering, and accepting our logins RIGHT NOW?
 *
 * Three layers, all best-effort and cached:
 *   1) Server probes - one TCP connect + SMTP banner read per distinct
 *      smtpHost:port in the workspace's inbox pool (plus env watch-hosts), so a
 *      dead or unreachable server is visible even before a send fails.
 *   2) Auth sweep - rotates through the pool re-verifying real SMTP logins
 *      (verifyInbox) a few at a time, so every credential is re-proven at
 *      least daily without hammering the host.
 *   3) Mailcow API (optional) - when MAILCOW_API_BASE_URL/MAILCOW_API_KEY are
 *      set, pulls mailbox/domain counts off the owned mail server so the
 *      portal shows the server's own inventory, not just our imports.
 *
 * Watch-hosts env (servers to monitor even with zero imported inboxes):
 *   SMTP_WATCH_HOSTS='[{"host":"mail.lumesp.com","port":587,"portal":"lume","label":"Lume mail server"}]'
 *   "portal" is a brand token ("lume") or "house"; omitted = every portal.
 */

import net from "net";
import { listInboxes, verifyInbox, saveInbox } from "./index";
import type { SenderInbox } from "./types";

/* ------------------------------ server probes ------------------------------ */

export interface SmtpProbe {
  host: string;
  port: number;
  reachable: boolean;
  banner: string | null;
  latencyMs: number | null;
  checkedAt: string;
}

const PROBE_TTL_MS = 10 * 60 * 1000;
const probeCache = new Map<string, { at: number; probe: SmtpProbe }>();

export function probeSmtp(host: string, port: number, timeoutMs = 6000): Promise<SmtpProbe> {
  const key = `${host}:${port}`;
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return Promise.resolve(hit.probe);
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let banner = "";
    const done = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* noop */ }
      const probe: SmtpProbe = {
        host, port, reachable,
        banner: banner ? banner.slice(0, 120).trim() : null,
        latencyMs: reachable ? Date.now() - started : null,
        checkedAt: new Date().toISOString(),
      };
      probeCache.set(key, { at: Date.now(), probe });
      resolve(probe);
    };
    const sock = net.connect({ host, port, timeout: timeoutMs });
    sock.on("connect", () => {
      // Reachable on connect; hang on briefly for the 220 banner (25/587 send
      // it unprompted; 465 wants TLS first, so no banner there is still fine).
      setTimeout(() => done(true), 1500);
    });
    sock.on("data", (d) => {
      banner += d.toString("utf8");
      if (/^\d{3}/.test(banner)) done(true);
    });
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

/* ------------------------------ watch hosts ------------------------------ */

export interface WatchHost { host: string; port: number; portal?: string; label?: string }

export function watchHosts(): WatchHost[] {
  try {
    const raw = (process.env.SMTP_WATCH_HOSTS || "").trim();
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((w) => w && typeof w.host === "string" && w.host)
      .map((w) => ({ host: String(w.host), port: Number(w.port) || 587, portal: w.portal ? String(w.portal) : undefined, label: w.label ? String(w.label) : undefined }));
  } catch {
    return [];
  }
}

/* ------------------------------ auth sweep ------------------------------ */

export interface SweepReport {
  tested: number;
  passed: number;
  failed: number;
  pendingStale: number; // inboxes still older than the freshness bar after this pass
  at: string;
}

const SWEEP_FRESH_MS = 24 * 60 * 60 * 1000;
const sweepInFlight = new Set<string>(); // workspaceId guard

function lastVerifiedAt(m: SenderInbox): number {
  const extra = (m as unknown as { lastVerifyAt?: string }).lastVerifyAt;
  return extra ? new Date(extra).getTime() : 0;
}

/**
 * Re-verify the stalest SMTP logins for this workspace (bounded batch, serial
 * enough to be polite to the host). Persists lastVerifyAt + status/lastError
 * exactly like the manual Test action, so every surface agrees.
 */
export async function sweepSmtpAuth(workspaceId: string, maxTests = 12): Promise<SweepReport> {
  const at = new Date().toISOString();
  if (sweepInFlight.has(workspaceId)) {
    const all = await listInboxes(workspaceId);
    const stale = all.filter((m) => Date.now() - lastVerifiedAt(m) > SWEEP_FRESH_MS).length;
    return { tested: 0, passed: 0, failed: 0, pendingStale: stale, at };
  }
  sweepInFlight.add(workspaceId);
  try {
    const all = await listInboxes(workspaceId);
    const stale = all
      .filter((m) => Date.now() - lastVerifiedAt(m) > SWEEP_FRESH_MS)
      .sort((a, b) => lastVerifiedAt(a) - lastVerifiedAt(b));
    const batch = stale.slice(0, Math.max(0, maxTests));
    let passed = 0;
    let failed = 0;
    const CONCURRENCY = 3;
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      await Promise.all(batch.slice(i, i + CONCURRENCY).map(async (m) => {
        const r = await verifyInbox(m);
        (m as unknown as { lastVerifyAt?: string }).lastVerifyAt = new Date().toISOString();
        if (r.ok) {
          passed++;
          if (m.status === "error") m.status = "warming";
          m.lastError = undefined;
        } else {
          failed++;
          m.status = "error";
          m.lastError = r.error;
        }
        await saveInbox(m);
      }));
    }
    return { tested: batch.length, passed, failed, pendingStale: Math.max(0, stale.length - batch.length), at };
  } finally {
    sweepInFlight.delete(workspaceId);
  }
}

/* ------------------------------ mailcow (optional) ------------------------------ */

export interface MailcowSummary {
  baseUrl: string;
  mailboxes: number | null;
  domains: number | null;
  ok: boolean;
  error?: string;
}

const mailcowCache: { at: number; summary: MailcowSummary | null } = { at: 0, summary: null };

export function mailcowConfigured(): boolean {
  return !!(process.env.MAILCOW_API_BASE_URL && process.env.MAILCOW_API_KEY);
}

export async function mailcowSummary(): Promise<MailcowSummary | null> {
  if (!mailcowConfigured()) return null;
  if (mailcowCache.summary && Date.now() - mailcowCache.at < PROBE_TTL_MS) return mailcowCache.summary;
  const baseUrl = String(process.env.MAILCOW_API_BASE_URL).replace(/\/+$/, "");
  const headers = { "X-API-Key": String(process.env.MAILCOW_API_KEY), Accept: "application/json" };
  async function count(path: string): Promise<number | null> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(`${baseUrl}${path}`, { headers, signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) return null;
      const j = await r.json();
      return Array.isArray(j) ? j.length : null;
    } catch {
      return null;
    }
  }
  const [mailboxes, domains] = await Promise.all([
    count("/api/v1/get/mailbox/all"),
    count("/api/v1/get/domain/all"),
  ]);
  const summary: MailcowSummary = {
    baseUrl,
    mailboxes,
    domains,
    ok: mailboxes != null || domains != null,
    error: mailboxes == null && domains == null ? "api_unreachable_or_bad_key" : undefined,
  };
  mailcowCache.at = Date.now();
  mailcowCache.summary = summary;
  return summary;
}

/* ------------------------------ fleet rollup ------------------------------ */

export interface SmtpServerRow {
  host: string;
  port: number;
  label: string | null;
  provider: string | null;
  inboxes: number;
  active: number;
  warming: number;
  paused: number;
  error: number;
  staleAuth: number;      // logins not re-proven inside the freshness bar
  lastErrors: string[];   // up to 3 distinct recent SMTP errors
  probe: SmtpProbe;
  watched: boolean;       // came from SMTP_WATCH_HOSTS (monitor even with 0 inboxes)
}

export async function smtpServerFleet(workspaceId: string, portalToken: string | "house"): Promise<SmtpServerRow[]> {
  const inboxes = await listInboxes(workspaceId);
  const groups = new Map<string, SenderInbox[]>();
  for (const m of inboxes) {
    if (!m.smtpHost) continue;
    const key = `${m.smtpHost.toLowerCase()}:${m.smtpPort || 587}`;
    const list = groups.get(key) || [];
    list.push(m);
    groups.set(key, list);
  }
  const watch = watchHosts().filter((w) => !w.portal || w.portal === portalToken);
  for (const w of watch) {
    const key = `${w.host.toLowerCase()}:${w.port}`;
    if (!groups.has(key)) groups.set(key, []);
  }
  const watchByKey = new Map(watch.map((w) => [`${w.host.toLowerCase()}:${w.port}`, w]));

  const rows = await Promise.all(Array.from(groups.entries()).map(async ([key, list]) => {
    const [host, portStr] = key.split(":");
    const port = Number(portStr) || 587;
    const w = watchByKey.get(key);
    const probe = await probeSmtp(host, port);
    const errors = Array.from(new Set(list.filter((m) => m.lastError).map((m) => String(m.lastError)))).slice(0, 3);
    return {
      host,
      port,
      label: w?.label || null,
      provider: list[0]?.provider || null,
      inboxes: list.length,
      active: list.filter((m) => m.status === "active").length,
      warming: list.filter((m) => m.status === "warming").length,
      paused: list.filter((m) => m.status === "paused").length,
      error: list.filter((m) => m.status === "error").length,
      staleAuth: list.filter((m) => Date.now() - lastVerifiedAt(m) > SWEEP_FRESH_MS).length,
      lastErrors: errors,
      probe,
      watched: !!w,
    } as SmtpServerRow;
  }));
  rows.sort((a, b) => (b.inboxes - a.inboxes) || a.host.localeCompare(b.host));
  return rows;
}
