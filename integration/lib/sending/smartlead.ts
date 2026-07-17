/**
 * RecruitersOS · Smartlead warm-up bridge
 *
 * Warm-up is the ONE thing we delegate to Smartlead.ai. Everything else, sending
 * domains, mailboxes, the send caps, the governor, blocklist/reputation, and all
 * monitoring, is local to this portal. This module is a thin, read-mostly client
 * over Smartlead's email-accounts API: it pulls each mailbox's warm-up health
 * (reputation, status, volume) and mirrors it onto our local Mailbox so the
 * Mailbox Ops console shows one unified fleet with warm-up as a first-class vital.
 *
 * Config: SMARTLEAD_API_KEY enables it; SMARTLEAD_API_BASE overrides the host.
 * Everything is best-effort: no key, a timeout, an auth error, or a shape change
 * never throws into a caller, it yields an empty or partial sync instead.
 */

import { allMailboxes, saveMailbox } from "./store";
import type { WarmupSnapshot } from "./types";
import { nowIso } from "../core/ids";

const BASE = (process.env.SMARTLEAD_API_BASE || "https://server.smartlead.ai/api/v1").replace(/\/+$/, "");

export function smartleadConfigured(): boolean {
  return !!(process.env.SMARTLEAD_API_KEY || "").trim();
}

export interface SmartleadAccount {
  smartleadId: string;
  email: string;
  warmupStatus: "active" | "paused" | "unknown";
  reputationPct?: number;
  sentTotal?: number;
  spamCount?: number;
  messagePerDay?: number;
  dailySent?: number;
}

function num(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === "string" ? parseFloat(v.replace(/[^\d.]/g, "")) : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function normStatus(s: unknown): "active" | "paused" | "unknown" {
  const t = String(s || "").toLowerCase();
  if (t.includes("active") || t.includes("running") || t.includes("enabled") || t === "1" || t === "true") return "active";
  if (t.includes("pause") || t.includes("stop") || t.includes("disabled") || t === "0" || t === "false") return "paused";
  return "unknown";
}

async function getJson(path: string): Promise<unknown> {
  const apiKey = (process.env.SMARTLEAD_API_KEY || "").trim();
  const sep = path.includes("?") ? "&" : "?";
  const url = `${BASE}${path}${sep}api_key=${encodeURIComponent(apiKey)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (!r.ok) throw Object.assign(new Error(`smartlead_${r.status}`), { status: r.status });
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/** List every Smartlead email account with its warm-up health (paged, tolerant). */
export async function listSmartleadAccounts(): Promise<SmartleadAccount[]> {
  if (!smartleadConfigured()) return [];
  const out: SmartleadAccount[] = [];
  const limit = 100;
  for (let offset = 0; offset < 5000; offset += limit) {
    let rows: any[];
    try {
      const data: any = await getJson(`/email-accounts/?offset=${offset}&limit=${limit}`);
      rows = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
    } catch {
      break;
    }
    if (!rows.length) break;
    for (const a of rows) {
      const w = a?.warmup_details || a?.warmupDetails || {};
      const email = String(a?.from_email || a?.email || "").toLowerCase().trim();
      if (!email) continue;
      out.push({
        smartleadId: String(a?.id ?? a?.email_account_id ?? ""),
        email,
        warmupStatus: normStatus(w?.warmup_status ?? w?.status ?? a?.warmup_status),
        reputationPct: num(w?.warmup_reputation ?? w?.reputation ?? a?.warmup_reputation),
        sentTotal: num(w?.total_sent_count ?? w?.sent_count),
        spamCount: num(w?.total_spam_count ?? w?.spam_count),
        messagePerDay: num(a?.message_per_day),
        dailySent: num(a?.daily_sent_count),
      });
    }
    if (rows.length < limit) break;
  }
  return out;
}

export interface WarmupSyncReport {
  configured: boolean;
  accounts: number;
  matched: number;
  unmatched: string[]; // local mailbox addresses with no matching Smartlead account
  at: string;
}

/**
 * Pull Smartlead warm-up health and mirror it onto every matching local mailbox
 * (matched by email address). Best-effort: returns a report, never throws.
 */
export async function syncSmartleadWarmup(workspaceId: string): Promise<WarmupSyncReport> {
  const at = nowIso();
  if (!smartleadConfigured()) return { configured: false, accounts: 0, matched: 0, unmatched: [], at };
  let accounts: SmartleadAccount[] = [];
  try {
    accounts = await listSmartleadAccounts();
  } catch {
    accounts = [];
  }
  const byEmail = new Map(accounts.map((a) => [a.email, a]));
  const mailboxes = await allMailboxes(workspaceId);
  let matched = 0;
  const unmatched: string[] = [];
  for (const m of mailboxes) {
    const a = byEmail.get(m.address.toLowerCase());
    if (!a) {
      unmatched.push(m.address);
      continue;
    }
    const snap: WarmupSnapshot = {
      provider: "smartlead",
      status: a.warmupStatus,
      reputationPct: a.reputationPct,
      sentTotal: a.sentTotal,
      spamCount: a.spamCount,
      syncedAt: at,
    };
    m.warmup = snap;
    if (a.smartleadId) m.smartleadId = a.smartleadId;
    await saveMailbox(m);
    matched++;
  }
  return { configured: true, accounts: accounts.length, matched, unmatched, at };
}
