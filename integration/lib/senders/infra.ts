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
 *   3) Mailcow API (optional) - when the mail server connection is set (portal
 *      Connections, else MAILCOW_API_BASE_URL/MAILCOW_API_KEY env), pulls
 *      mailbox/domain counts off the owned mail server so the portal shows the
 *      server's own inventory, not just our imports.
 *
 * Watch-hosts env (servers to monitor even with zero imported inboxes):
 *   SMTP_WATCH_HOSTS='[{"host":"mail.lumesp.com","port":587,"portal":"lume","label":"Lume mail server","dailyCap":1100}]'
 *   "portal" is a brand token ("lume") or "house"; omitted = every portal.
 *   "dailyCap" (optional) pins the server's steady-state daily send capacity; when
 *   absent we derive it from the mail server inventory (mailboxes × WARMED_PER_MAILBOX_PER_DAY).
 */

import net from "net";
import { listInboxes, verifyInbox, saveInbox } from "./index";
import { coldMaxPerInbox } from "./limits";
import { ensureConfig, mailServerUrl, mailServerKey, mailServerConnected } from "../sending/config";
import type { SenderInbox } from "./types";

/* ------------------------------ send capacity ------------------------------ */

/**
 * Fully-ramped cold sends/day for ONE dedicated mailbox on an owned mail server
 * (e.g. mail.lumesp.com). Kept in lockstep with the send model's per-inbox ceiling
 * (limits.ts coldMaxPerInbox, default 20) so this per-server figure and the
 * Sending-infrastructure-split "at full ramp" number agree. A 75-mailbox server
 * therefore matures to ~1,500 sends/day.
 */
export const WARMED_PER_MAILBOX_PER_DAY = coldMaxPerInbox();

/** Round a capacity figure to a clean headline number (nearest 100). */
export function roundCapacity(n: number): number {
  return Math.max(0, Math.round(n / 100) * 100);
}

/** Steady-state daily send capacity for an owned mail server given its mailbox inventory. */
export function serverDailyCapacity(mailboxes: number): number {
  return roundCapacity(mailboxes * WARMED_PER_MAILBOX_PER_DAY);
}

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

export interface WatchHost { host: string; port: number; portal?: string; label?: string; dailyCap?: number }

export function watchHosts(): WatchHost[] {
  try {
    const raw = (process.env.SMTP_WATCH_HOSTS || "").trim();
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((w) => w && typeof w.host === "string" && w.host)
      .map((w) => ({
        host: String(w.host), port: Number(w.port) || 587,
        portal: w.portal ? String(w.portal) : undefined,
        label: w.label ? String(w.label) : undefined,
        dailyCap: Number.isFinite(Number(w.dailyCap)) && Number(w.dailyCap) > 0 ? Math.round(Number(w.dailyCap)) : undefined,
      }));
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

/* ------------------------------ revive errored logins ------------------------------ */

export interface ReviveReport { checked: number; revived: number; stillFailing: number; at: string; }

/**
 * Re-verify own-smtp inboxes currently in ERROR and, on a successful login, flip
 * them back to "warming" so they rejoin the send rotation. Unlike sweepSmtpAuth
 * this is NOT gated by the 24h freshness window and targets only errored own-smtp
 * mailboxes, so a credential that just got fixed (e.g. a self-healed base64
 * password) is revived on the next maintenance tick without waiting for anyone to
 * open the Senders panel. A login that still fails keeps its error, untouched.
 */
export async function reviveErroredSmtpLogins(workspaceId: string, max = 60): Promise<ReviveReport> {
  const at = new Date().toISOString();
  const all = await listInboxes(workspaceId);
  const targets = all.filter((m) => m.provider === "own-smtp" && m.status === "error").slice(0, Math.max(0, max));
  let revived = 0, stillFailing = 0;
  const CONCURRENCY = 3;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    await Promise.all(targets.slice(i, i + CONCURRENCY).map(async (m) => {
      const r = await verifyInbox(m);
      (m as unknown as { lastVerifyAt?: string }).lastVerifyAt = new Date().toISOString();
      if (r.ok) { m.status = "warming"; m.lastError = undefined; revived++; }
      else { m.lastError = r.error; stillFailing++; }
      await saveInbox(m);
    }));
  }
  return { checked: targets.length, revived, stillFailing, at };
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

// Connection resolves portal-set values first (Mailbox Ops > Connections),
// then the MAILCOW_* env vars, via lib/sending/config.
export function mailcowConfigured(): boolean {
  return mailServerConnected();
}

export async function mailcowSummary(): Promise<MailcowSummary | null> {
  await ensureConfig();
  if (!mailcowConfigured()) return null;
  if (mailcowCache.summary && Date.now() - mailcowCache.at < PROBE_TTL_MS) return mailcowCache.summary;
  const rawUrl = String(mailServerUrl());
  const baseUrl = (/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`).replace(/\/+$/, "");
  const headers = { "X-API-Key": String(mailServerKey()), Accept: "application/json" };
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
  capacityPerDay: number | null;  // steady-state warmed sends/day for this server (null = unknown)
  capacityBasis: string | null;   // how capacityPerDay was derived (for the tooltip)
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
    // A pinned dailyCap wins; the mail-server-inventory figure is filled in by
    // the route (it has the live inventory). Left null here otherwise.
    const capacityPerDay = w?.dailyCap ?? null;
    const capacityBasis = w?.dailyCap ? "Configured steady-state cap" : null;
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
      capacityPerDay,
      capacityBasis,
    } as SmtpServerRow;
  }));
  rows.sort((a, b) => (b.inboxes - a.inboxes) || a.host.localeCompare(b.host));
  return rows;
}
