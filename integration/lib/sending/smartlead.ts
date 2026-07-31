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
import { smartleadKey, ensureConfig } from "./config";

const BASE = (process.env.SMARTLEAD_API_BASE || "https://server.smartlead.ai/api/v1").replace(/\/+$/, "");

export function smartleadConfigured(): boolean {
  return !!smartleadKey();
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
  /** ISO timestamp the account was added upstream, the start of its warm-up clock. */
  createdAt?: string;
  /** ISO timestamp warm-up actually began (warmup_details.warmup_created_at);
   *  the true clock, preferred over createdAt when present. */
  warmupStartedAt?: string;
  /** Target warm-up emails/day at the current ramp (warmup_details.max_email_per_day). */
  warmupPerDay?: number;
  /** Warm-up reply rate %, an engagement signal upstream reports even at 0 sends. */
  replyRatePct?: number;
  /** Upstream block reason if warm-up is halted (null/undefined = fine). */
  blockedReason?: string;
  /** Upstream connection type: "SMTP" | "OUTLOOK" | "GMAIL" | ... Free on the
   *  same payload, and the only signal that says what KIND of mailbox this is
   *  (Google Workspace vs Microsoft vs our own mail server). */
  accountType?: string;
  /** SMTP host the mailbox sends through, e.g. smtp.gmail.com. */
  smtpHost?: string;
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
  const apiKey = smartleadKey() || "";
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
        createdAt: typeof a?.created_at === "string" ? a.created_at : undefined,
        warmupStartedAt: typeof w?.warmup_created_at === "string" ? w.warmup_created_at : undefined,
        warmupPerDay: num(w?.max_email_per_day),
        replyRatePct: num(w?.reply_rate),
        blockedReason: w?.blocked_reason ? String(w.blocked_reason) : undefined,
        accountType: a?.type ? String(a.type).toUpperCase() : undefined,
        smtpHost: a?.smtp_host ? String(a.smtp_host) : undefined,
      });
    }
    if (rows.length < limit) break;
  }
  return out;
}

/** Full account view for the fleet-import sync: warm-up health PLUS the connection
 *  details Smartlead stores. SMTP-type accounts carry real credentials (username/
 *  password); OAuth accounts (OUTLOOK/GMAIL) carry none, they send upstream. */
export interface SmartleadAccountFull extends SmartleadAccount {
  fromName?: string;
  /** Upstream connection type: "SMTP" | "OUTLOOK" | "GMAIL" | ... */
  accountType?: string;
  smtpHost?: string;
  smtpPort?: number;
  username?: string;
  password?: string;
  imapHost?: string;
  imapPort?: number;
  imapUsername?: string;
  imapPassword?: string;
}

/** List every Smartlead account WITH connection details (paged, tolerant). Used by
 *  the fleet-import sync; the warm-up panel keeps the lighter listSmartleadAccounts. */
export async function listSmartleadAccountsFull(): Promise<SmartleadAccountFull[]> {
  if (!smartleadConfigured()) return [];
  const out: SmartleadAccountFull[] = [];
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
        createdAt: typeof a?.created_at === "string" ? a.created_at : undefined,
        warmupStartedAt: typeof w?.warmup_created_at === "string" ? w.warmup_created_at : undefined,
        warmupPerDay: num(w?.max_email_per_day),
        replyRatePct: num(w?.reply_rate),
        blockedReason: w?.blocked_reason ? String(w.blocked_reason) : undefined,
        fromName: a?.from_name ? String(a.from_name) : undefined,
        accountType: a?.type ? String(a.type).toUpperCase() : undefined,
        smtpHost: a?.smtp_host ? String(a.smtp_host) : undefined,
        smtpPort: num(a?.smtp_port),
        username: a?.username ? String(a.username) : undefined,
        password: a?.password ? String(a.password) : undefined,
        imapHost: a?.imap_host ? String(a.imap_host) : undefined,
        imapPort: num(a?.imap_port),
        imapUsername: a?.imap_username ? String(a.imap_username) : undefined,
        imapPassword: a?.imap_password ? String(a.imap_password) : undefined,
      });
    }
    if (rows.length < limit) break;
  }
  return out;
}

/* ---------------- per-account warm-up stats (the REAL send numbers) ----------------
 * The account-LIST endpoint's warmup_details reports total_sent_count/total_spam_count
 * as 0 even while warm-up is actively sending (verified against live accounts). The
 * per-account /email-accounts/{id}/warmup-stats endpoint carries the truth: cumulative
 * sent/spam/inbox counts plus a day-by-day series. Numbers arrive as strings. */

export interface WarmupDayStat {
  date: string;
  sent: number;
  replies: number;
  savedFromSpam: number;
}

export interface WarmupAccountStats {
  sentTotal: number;
  spamCount: number;
  inboxCount: number;
  receivedCount: number;
  /** Warm-up emails sent TODAY (last entry of the day series). */
  sentToday: number;
  byDate: WarmupDayStat[];
}

/** Pure normalizer for the warmup-stats payload (string-numbered upstream). */
export function normalizeWarmupStats(j: any): WarmupAccountStats {
  const byDate: WarmupDayStat[] = (Array.isArray(j?.stats_by_date) ? j.stats_by_date : [])
    .map((d: any) => ({
      date: String(d?.date || ""),
      sent: num(d?.sent_count) ?? 0,
      replies: num(d?.reply_count) ?? 0,
      savedFromSpam: num(d?.save_from_spam_count) ?? 0,
    }))
    .filter((d: WarmupDayStat) => d.date)
    .sort((a: WarmupDayStat, b: WarmupDayStat) => a.date.localeCompare(b.date));
  const today = new Date().toISOString().slice(0, 10);
  const last = byDate[byDate.length - 1];
  return {
    sentTotal: num(j?.sent_count) ?? 0,
    spamCount: num(j?.spam_count) ?? 0,
    inboxCount: num(j?.inbox_count) ?? 0,
    receivedCount: num(j?.warmup_email_received_count) ?? 0,
    sentToday: last && last.date === today ? last.sent : 0,
    byDate,
  };
}

const statsCache = new Map<string, { at: number; stats: WarmupAccountStats }>();
const STATS_TTL_MS = 10 * 60 * 1000;

/** Real warm-up stats for one account, cached 10 min. Null on any failure. */
export async function getWarmupStats(accountId: string): Promise<WarmupAccountStats | null> {
  if (!smartleadConfigured() || !accountId) return null;
  const hit = statsCache.get(accountId);
  if (hit && Date.now() - hit.at < STATS_TTL_MS) return hit.stats;
  try {
    const j = await getJson(`/email-accounts/${encodeURIComponent(accountId)}/warmup-stats`);
    const stats = normalizeWarmupStats(j);
    statsCache.set(accountId, { at: Date.now(), stats });
    return stats;
  } catch {
    return null;
  }
}

/** Stats for many accounts with bounded concurrency (best-effort per account). */
export async function getWarmupStatsMany(accountIds: string[], concurrency = 5): Promise<Map<string, WarmupAccountStats>> {
  const out = new Map<string, WarmupAccountStats>();
  const queue = [...accountIds];
  async function worker() {
    for (;;) {
      const id = queue.shift();
      if (!id) return;
      const s = await getWarmupStats(id);
      if (s) out.set(id, s);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, accountIds.length || 1) }, worker));
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
  await ensureConfig();
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
