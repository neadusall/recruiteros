/**
 * RecruitersOS · ACCOUNT INTENT LEDGER — the part that makes the hunter predictive.
 *
 * A single post is a moment. The opportunity is the SEQUENCE:
 *
 *   funding announcement today
 *   -> two weeks later the COO posts about expansion
 *   -> three weeks later the CFO mentions building finance infrastructure
 *   -> four weeks later a Controller req appears
 *
 * By the fourth step every recruiter can see it. A desk that logged step one has been watching the
 * buying cycle develop for a month. This ledger is that memory: every scored post is recorded
 * against its COMPANY, and a company accumulates heat as independent signals arrive.
 *
 * ── HOW HEAT WORKS ─────────────────────────────────────────────────────────────────────────────
 *
 * Heat is the sum of DISTINCT event strengths, each decayed by age, capped at 100.
 *
 *   distinct   Three funding posts about the same round are one signal, not three. Counting
 *              repeats would let a chatty founder outrank a company with three real events, which
 *              is the exact opposite of what this is for.
 *   decayed    A raise from eleven weeks ago is not the same buying signal as one from Tuesday.
 *              Half-life is HALF_LIFE_DAYS; anything past WINDOW_DAYS is dropped entirely.
 *   capped     So a company cannot run away with the list on volume alone.
 *
 * The per-post score in hiringIntent decides what to do about THAT POST (comment, watch, ignore).
 * Heat decides which ACCOUNT is worth working. They are deliberately different numbers: a modest
 * post from a company already at heat 80 is a reason to open the account, not to comment again.
 */

import type { IntentRead } from "./hiringIntent";

export const WINDOW_DAYS = 90;
export const HALF_LIFE_DAYS = 45;
/** Heat at which an account is worth working directly rather than just watching. */
export const ACCOUNT_HOT = 60;

export interface IntentSignal {
  at: string;
  eventId: string;
  eventLabel: string;
  layer: 1 | 2 | 3;
  /** Event strength only, so heat is about WHAT HAPPENED rather than who happened to post it. */
  strength: number;
  /** The full per-post score, kept for display and for explaining why we acted on that post. */
  postScore: number;
  functions: string[];
  authorName?: string;
  authorTitle?: string;
  postUrl?: string;
  excerpt?: string;
}

export interface AccountIntent {
  company: string;
  domain?: string;
  signals: IntentSignal[];
  firstSeen: string;
  lastSeen: string;
}

export type IntentLedger = Record<string, AccountIntent>;

export const companyKey = (name: string) =>
  String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 60);

const ageDays = (iso: string, now: number) => Math.max(0, (now - (Date.parse(iso) || 0)) / 864e5);
const decay = (days: number) => Math.pow(0.5, days / HALF_LIFE_DAYS);

/** Signals inside the window, newest first, one per distinct event (the freshest instance wins). */
export function liveSignals(acct: AccountIntent, now = Date.now()): IntentSignal[] {
  const byEvent = new Map<string, IntentSignal>();
  for (const s of acct.signals) {
    if (ageDays(s.at, now) > WINDOW_DAYS) continue;
    const cur = byEvent.get(s.eventId);
    if (!cur || Date.parse(s.at) > Date.parse(cur.at)) byEvent.set(s.eventId, s);
  }
  return [...byEvent.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** 0-100. See the header: distinct events, decayed by age, capped. */
export function heatOf(acct: AccountIntent, now = Date.now()): number {
  const live = liveSignals(acct, now);
  const raw = live.reduce((sum, s) => sum + s.strength * decay(ageDays(s.at, now)), 0);
  return Math.min(100, Math.round(raw));
}

/** Every function any live signal points at, best-first by how often it appears. */
export function impliedFunctions(acct: AccountIntent, now = Date.now()): string[] {
  const count = new Map<string, number>();
  for (const s of liveSignals(acct, now)) for (const f of s.functions) count.set(f, (count.get(f) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
}

/**
 * Record a scored post against its company. Returns the account so the caller can act on the heat
 * immediately — the third signal in a week should change what happens on that same tick, not on
 * tomorrow's run.
 *
 * Idempotent per (company, event, post): re-reading the same post never inflates heat, which is
 * what keeps a re-scan from turning one raise into a hot account.
 */
export function recordSignal(
  ledger: IntentLedger,
  input: { company: string; domain?: string; read: IntentRead; postUrl?: string; postAt?: string; authorName?: string; authorTitle?: string; excerpt?: string },
): AccountIntent | null {
  const key = companyKey(input.company);
  if (!key || !input.read.primary) return null;
  const at = input.postAt || new Date().toISOString();

  let acct = ledger[key];
  if (!acct) {
    acct = ledger[key] = { company: input.company, domain: input.domain, signals: [], firstSeen: at, lastSeen: at };
  }
  if (input.domain && !acct.domain) acct.domain = input.domain;

  for (const e of input.read.events) {
    const dupe = acct.signals.some((s) =>
      s.eventId === e.id && (
        (input.postUrl && s.postUrl === input.postUrl) ||
        Math.abs((Date.parse(s.at) || 0) - (Date.parse(at) || 0)) < 60 * 60 * 1000
      ));
    if (dupe) continue;
    acct.signals.push({
      at, eventId: e.id, eventLabel: e.label, layer: e.layer,
      strength: e.heat === 5 ? 30 : e.heat === 4 ? 24 : 18,
      postScore: input.read.score,
      functions: e.functions,
      authorName: input.authorName, authorTitle: input.authorTitle,
      postUrl: input.postUrl, excerpt: (input.excerpt || "").slice(0, 240),
    });
  }
  if (Date.parse(at) > Date.parse(acct.lastSeen)) acct.lastSeen = at;
  if (Date.parse(at) < Date.parse(acct.firstSeen)) acct.firstSeen = at;
  // Bound the per-account history so one very loud company cannot grow the snapshot without limit.
  if (acct.signals.length > 60) {
    acct.signals = acct.signals.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 60);
  }
  return acct;
}

/** Drop everything outside the window. Run before publishing so the snapshot stays bounded. */
export function pruneLedger(ledger: IntentLedger, now = Date.now()): IntentLedger {
  for (const [k, acct] of Object.entries(ledger)) {
    acct.signals = acct.signals.filter((s) => ageDays(s.at, now) <= WINDOW_DAYS);
    if (!acct.signals.length) delete ledger[k];
  }
  return ledger;
}

export interface RankedAccount {
  key: string;
  company: string;
  domain?: string;
  heat: number;
  signalCount: number;
  layers: number[];
  functions: string[];
  firstSeen: string;
  lastSeen: string;
  timeline: Array<{ at: string; event: string; layer: number; author?: string; authorTitle?: string; postUrl?: string }>;
  hot: boolean;
}

/** The watchlist: accounts by heat, hottest first. This is the working list, not the post feed. */
export function rankAccounts(ledger: IntentLedger, now = Date.now(), limit = 100): RankedAccount[] {
  const out: RankedAccount[] = [];
  for (const [key, acct] of Object.entries(ledger)) {
    const live = liveSignals(acct, now);
    if (!live.length) continue;
    const heat = heatOf(acct, now);
    out.push({
      key, company: acct.company, domain: acct.domain, heat,
      signalCount: live.length,
      layers: [...new Set(live.map((s) => s.layer))].sort(),
      functions: impliedFunctions(acct, now),
      firstSeen: acct.firstSeen, lastSeen: acct.lastSeen,
      timeline: live.slice(0, 8).map((s) => ({
        at: s.at, event: s.eventLabel, layer: s.layer,
        author: s.authorName, authorTitle: s.authorTitle, postUrl: s.postUrl,
      })),
      hot: heat >= ACCOUNT_HOT,
    });
  }
  // Heat first, then how many independent signals: two events beat one loud one at equal heat,
  // because a repeated pattern from one company is the thing we are actually hunting for.
  out.sort((a, b) => (b.heat - a.heat) || (b.signalCount - a.signalCount));
  return out.slice(0, limit);
}
