/**
 * RecruitersOS · In-Market · paid web search — the decision-maker NAMING backend
 *
 * The NAMING bottleneck runs on free search-engine SCRAPING (DuckDuckGo / Bing / Mojeek /
 * SearXNG). That hop is rate-limited on every source IP, and from this box it is not merely
 * degraded but ARCHITECTURALLY DEAD — every one of the five free engines reports okRate 0 /
 * throttleRate 1, so the single biggest naming strategy (reading "Jane Doe - VP of Engineering -
 * Acme" straight out of public result titles) resolves nobody. Companies pile up at status
 * `sourced` (owning TITLE known, no NAME), never earn an email, and therefore never become
 * renderable video supply. This module is the paid replacement for that hop.
 *
 * THREE PROVIDERS FORMING A FAILOVER LADDER, best-value first. All are Google-backed SERP
 * APIs returning clean JSON — exactly what the LinkedIn-title parsers in decisionMaker.ts /
 * xray.ts already consume. Order re-measured 2026-08-14 (8-query naming battery, real bills):
 *
 *   1. DATAFORSEO   — DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD. $0.002/query live WITH the
 *                     site:-operator rewrite (serpRewrite.ts — without it DataForSEO bills a
 *                     5x advanced-operator surcharge, which is what made it look 10x too
 *                     expensive before). Quality parity measured: 7/8 right-company hits.
 *                     First because its balance NEVER expires and it has native auto-recharge
 *                     (app.dataforseo.com → Billing), so it is the provider that can't
 *                     quietly die the way Serper credits did on 2026-07-30 and 2026-08-12.
 *   2. SERPER       — SERPER_API_KEY. $0.001/query, fastest, proven on this exact workload —
 *                     but credits expire after 6 months, there is no auto-top-up, and an
 *                     empty account answers 400 "Not enough credits" until someone pays.
 *   3. RAPIDAPI     — RAPID_WEBSEARCH_KEY (real-time-web-search). Kept for continuity; last
 *                     because it is the most expensive subscription of the three.
 *
 * A provider that answers with a QUOTA-shaped failure (out of credits / key rejected) is put
 * in a cooldown (default 60 min — long enough to stop burning calls, short enough that an
 * auto-recharge refill is picked up within the hour) and the NEXT rung serves the query in
 * the same call. The first quota failure per provider per day files a ROS-SEARCH-DRY break
 * and emails the owner — this exact failure ran silently for two days in August 2026 and
 * the only symptom was an empty render queue, which is the wrong place to find out.
 *
 * Set INMARKET_SEARCH_PROVIDER to pin one explicitly ("dataforseo" | "serper" | "rapidapi" |
 * "off"); a pin disables the ladder on purpose (you asked for that provider, you get exactly
 * it). Otherwise the ladder above serves.
 *
 * SPEND IS CAPPED, NOT TRUSTED TO CALLER DISCIPLINE. Naming re-attempts every unnamed company
 * on a ~90-minute cycle and the callers' in-process caches are wiped by every deploy, so an
 * uncapped paid hop would re-buy the same misses all day. Three guards, all here:
 *   - a PERSISTENT daily query budget (INMARKET_SEARCH_DAILY_MAX) bounded in MONEY
 *     (INMARKET_SEARCH_DAILY_USD) at the serving provider's real rate;
 *   - `webSearchReady()`, which the callers check so an exhausted budget falls THROUGH to the
 *     free rotation instead of silently naming nobody; and
 *   - a PERSISTENT miss cache: a query that came back empty from a HEALTHY provider
 *     INMARKET_MISS_CAP times (default 4) is a real negative, and re-asking it every cycle
 *     re-buys the same nothing — it is suppressed for INMARKET_MISS_RETRY_DAYS (default 7)
 *     before it may spend again. On 2026-08-13, 6,673 of the day's queries were exactly such
 *     re-buys.
 * Failed calls are NOT counted as spend: the budget reserves a slot before the request (so
 * concurrent calls can't overrun the cap) and refunds it when the provider errors.
 *
 * Cost note for whoever tunes this: a paid query only ever runs on a company the free
 * strategies (team page, news, GitHub, Common Crawl) already failed to name, so it bills on
 * misses only — the same cheapest-first policy as paidEmail/paidNaming.
 */

import { noteRapidQuota } from "../sourcing/rapidQuota";
import { loadSnapshot, saveSnapshot } from "../db";
import { rewriteSiteOperators, matchesSitePrefixes } from "../serpRewrite";

const TIMEOUT_MS = 12_000;

export type WebSearchProvider = "dataforseo" | "serper" | "rapidapi";

/** Ladder order — see the header for the measured reasoning. */
const LADDER: WebSearchProvider[] = ["dataforseo", "serper", "rapidapi"];

/**
 * Every configured provider, ladder order, honoring an INMARKET_SEARCH_PROVIDER pin.
 * Cooldowns are NOT applied here (this answers "what is wired up"); the query path skips
 * cooled-down rungs itself.
 */
export function webSearchProviderOrder(): WebSearchProvider[] {
  const pin = (process.env.INMARKET_SEARCH_PROVIDER || "").trim().toLowerCase();
  if (pin === "off" || pin === "0" || pin === "none") return [];
  if (pin === "dataforseo") return dataforseoConfigured() ? ["dataforseo"] : [];
  if (pin === "serper") return serperConfigured() ? ["serper"] : [];
  if (pin === "rapidapi") return rapidConfigured() ? ["rapidapi"] : [];
  return LADDER.filter((p) =>
    p === "dataforseo" ? dataforseoConfigured() : p === "serper" ? serperConfigured() : rapidConfigured(),
  );
}

/** The provider that will serve the next query, or null when none is configured / pinned off. */
export function webSearchProvider(): WebSearchProvider | null {
  return webSearchProviderOrder()[0] ?? null;
}

function dataforseoConfigured(): boolean {
  return !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
}
function serperConfigured(): boolean {
  return !!process.env.SERPER_API_KEY;
}
function rapidConfigured(): boolean {
  return !!process.env.RAPID_WEBSEARCH_KEY;
}

/** True once ANY paid search provider is configured. Says nothing about remaining budget — use
 *  `webSearchReady()` before choosing this backend over the free rotation. */
export function webSearchEnabled(): boolean {
  return webSearchProvider() !== null;
}

/* ------------------------------------------------------------------ */
/* Daily spend ceiling + provider cooldowns (persistent)               */
/* ------------------------------------------------------------------ */

const BUDGET_KEY = "inmarket_websearch_budget_v1";
const SAVE_DEBOUNCE_MS = 10_000;

interface DownEntry {
  /** ISO time this cooldown expires. */
  until: string;
  /** Human-readable cause, e.g. "serper 400 (out of credits)". */
  reason: string;
}

interface BudgetState {
  /** UTC day this counter belongs to, YYYY-MM-DD. */
  day: string;
  /** Paid queries billed today (successful calls only — failures are refunded). */
  used: number;
  /** Which provider spent them (informational; the meter is per-day, not per-provider). */
  provider?: string;
  /** The ceiling in force when this was last written, so a reader outside the process (the ops
   *  sentinel reads this file straight off the data volume) can tell "spent out" from "idle"
   *  without access to the container's env. */
  cap?: number;
  usdCap?: number;
  /** Providers currently in quota cooldown, with why and until when. */
  down?: Partial<Record<WebSearchProvider, DownEntry>>;
  /** Last UTC day each provider's dry-alert went out, so it fires once a day, not per query. */
  alerted?: Partial<Record<WebSearchProvider, string>>;
}

let budget: BudgetState | null = null;
let hydrating: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * What one query really bills, per provider — kept honest against MEASURED billing, not rate
 * sheets. dataforseo assumes the site:-operator rewrite is in effect (it is — dataforseoSearch
 * applies it unconditionally); without the rewrite the same call bills 5x. Used to keep the
 * ceiling honest in MONEY rather than in query count — see dailyQueryCap(). Deliberately the
 * pessimistic end of each range so the guard errs toward spending less than the stated dollar
 * ceiling, never more.
 */
const USD_PER_QUERY: Record<WebSearchProvider, number> = {
  serper: 0.001,
  dataforseo: 0.002, // live/regular, rewritten query, depth ≤ 10-result page — billed cost observed 2026-08-14
  rapidapi: 0.004,
};

/** The provider the query cap is denominated in: INMARKET_SEARCH_DAILY_MAX means "this many
 *  Serper queries", because that is the rate it was tuned against. */
const REFERENCE_PROVIDER: WebSearchProvider = "serper";

/** The operator's query ceiling, before the money guard narrows it. */
function explicitQueryCap(): number {
  const n = Number(process.env.INMARKET_SEARCH_DAILY_MAX);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2_000;
}

/**
 * The dollar ceiling for a UTC day. Set INMARKET_SEARCH_DAILY_USD to state it directly; otherwise
 * it is inferred as what the query cap costs at REFERENCE_PROVIDER rates — so raising the query cap
 * raises the budget exactly as an operator expects, and the two knobs can never disagree.
 */
export function dailyUsdCap(): number {
  const n = Number(process.env.INMARKET_SEARCH_DAILY_USD);
  if (Number.isFinite(n) && n >= 0) return n;
  return explicitQueryCap() * USD_PER_QUERY[REFERENCE_PROVIDER];
}

/**
 * Hard ceiling on paid queries per UTC day. 0 disables the paid hop outright.
 *
 * The ceiling is the LOWER of the query cap and what the dollar cap buys from whichever provider is
 * ACTUALLY serving. That second term is the failover guard: without it, failing over to a
 * pricier rung would silently multiply the dollar ceiling with no change in configuration and
 * nothing to notice. Money is what has to be bounded, so money is what gets bounded; the query
 * count is just how the intent is expressed.
 */
export function dailyQueryCap(): number {
  const queryCap = explicitQueryCap();
  const provider = webSearchProvider();
  if (!provider) return queryCap;
  const affordable = Math.floor(dailyUsdCap() / USD_PER_QUERY[provider]);
  return Math.min(queryCap, affordable);
}

/** What today's spend has cost, in dollars, at the serving provider's rate. Kept to sub-cent
 *  precision on purpose: at $0.001/query, rounding to cents reports real spend as $0. */
export function spentUsd(used: number, provider: WebSearchProvider | null): number {
  if (!provider) return 0;
  return Math.round(used * USD_PER_QUERY[provider] * 1000) / 1000;
}

async function hydrateBudget(): Promise<void> {
  if (budget) return;
  hydrating ??= (async () => {
    const saved = await loadSnapshot<BudgetState>(BUDGET_KEY).catch(() => null);
    budget = saved && typeof saved.used === "number" && typeof saved.day === "string"
      ? saved
      : { day: today(), used: 0 };
  })();
  await hydrating;
  hydrating = null;
}

/** Persist the counter at most once per SAVE_DEBOUNCE_MS — the ceiling only has to survive a
 *  restart, and a write per query would be pure churn at thousands/day. */
function scheduleBudgetSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (budget) void saveSnapshot(BUDGET_KEY, budget).catch(() => {});
  }, SAVE_DEBOUNCE_MS);
  // Never hold the process open for a counter flush.
  (saveTimer as unknown as { unref?: () => void }).unref?.();
}

/** Roll the day (which also clears yesterday's alert throttle; cooldowns carry their own expiry). */
function rollDay(): void {
  const day = today();
  if (!budget || budget.day === day) return;
  budget = { day, used: 0, down: budget.down, alerted: {} };
}

/**
 * Stamp the CURRENT ceiling onto the persisted counter whenever it has drifted.
 *
 * This cannot live in spendOne(): a refused query returns before it would run, and callers check
 * webSearchReady() first and so stop calling in at all once the budget is gone. The ceiling would
 * therefore be missing from the file precisely while the budget is exhausted — leaving the outside
 * reader unable to tell "spent out" from "never ran" for up to a whole day, which is the one
 * question it exists to answer. Recording it on the READ path keeps it fresh either way.
 */
function recordCeiling(): void {
  if (!budget) return;
  const cap = dailyQueryCap();
  const usdCap = dailyUsdCap();
  if (budget.cap === cap && budget.usdCap === usdCap) return;
  budget.cap = cap;
  budget.usdCap = usdCap;
  scheduleBudgetSave();
}

/** Today's paid-query spend against the ceiling. Surfaced for the engine-health readout. */
export async function webSearchBudget(): Promise<{ used: number; cap: number; provider: string | null }> {
  await hydrateBudget();
  rollDay();
  recordCeiling();
  return { used: budget?.used ?? 0, cap: dailyQueryCap(), provider: webSearchProvider() };
}

/* --- provider cooldowns ------------------------------------------- */

function cooldownMs(): number {
  const n = Number(process.env.INMARKET_SEARCH_COOLDOWN_MIN);
  return (Number.isFinite(n) && n > 0 ? n : 60) * 60_000;
}

function isDown(provider: WebSearchProvider): boolean {
  const d = budget?.down?.[provider];
  return !!d && Date.parse(d.until) > Date.now();
}

/** Configured rungs that are not in cooldown right now — what a query can actually use. */
function liveOrder(): WebSearchProvider[] {
  return webSearchProviderOrder().filter((p) => !isDown(p));
}

/**
 * Put a provider in cooldown after a quota-shaped failure, and — once per provider per day —
 * say so OUT LOUD: a ROS-SEARCH-DRY break plus an owner email. The cooldown is short (60 min)
 * on purpose: if auto-recharge or a top-up refills the account, the rung comes back on its own
 * within the hour; if not, one failed probe per hour is the cost of noticing when it does.
 */
async function markDown(provider: WebSearchProvider, reason: string): Promise<void> {
  await hydrateBudget();
  rollDay();
  if (!budget) return;
  budget.down = { ...budget.down, [provider]: { until: new Date(Date.now() + cooldownMs()).toISOString(), reason } };
  const day = today();
  const alreadyAlerted = budget.alerted?.[provider] === day;
  if (!alreadyAlerted) budget.alerted = { ...budget.alerted, [provider]: day };
  scheduleBudgetSave();
  console.warn(`[websearch] ${provider} down for ${Math.round(cooldownMs() / 60000)}min: ${reason}`);
  if (alreadyAlerted) return;

  const survivors = liveOrder();
  const standing = survivors.length
    ? `Naming is still running on ${survivors.join(" then ")}.`
    : `No paid search provider is left — decision-maker naming is DARK until a balance is topped up.`;
  // Neither alert path is allowed to break the query path.
  try {
    const { recordBreak } = await import("../breaks");
    await recordBreak(
      {
        code: "ROS-SEARCH-DRY",
        where: "Decision-maker naming",
        screen: "inmarket",
        path: "lib/inmarket/webSearch.ts",
        status: 0,
        detail: `${reason}. ${standing}`,
        agent: "webSearch failover",
      },
      { workspaceId: "system", userEmail: "system" },
    );
  } catch { /* the break layer must never take naming down with it */ }
  try {
    const { notifyOwner } = await import("../owner/ownerNotice");
    await notifyOwner({
      subject: `Search provider out of credits: ${provider}`,
      body:
        `${reason}\n\n` +
        `${standing}\n\n` +
        (provider === "serper" ? `Top up at https://serper.dev (credits expire 6 months after purchase, so size the buy to the burn).\n` : "") +
        (provider === "dataforseo" ? `Top up at https://app.dataforseo.com and turn on auto-recharge (Billing -> Auto recharge) so this never fires again.\n` : "") +
        `This alert fires at most once per provider per day; the provider re-probes hourly and recovers on its own once funded.`,
    });
  } catch { /* same rule */ }
}

/* --- transient-slowness cooldown ----------------------------------- */

/** Consecutive transient (non-quota) failures per provider before it is rested. Measured
 *  2026-08-19: DataForSEO's live SERP endpoint spent an afternoon swinging between 5s
 *  answers and 45s hangs while its balance endpoint stayed instant. The ladder failed
 *  over correctly, but every single query still paid the full TIMEOUT_MS wait on the
 *  flaky rung before the next one served it. */
const SLOW_STREAK_TO_REST = 3;

/** How long a repeatedly-timing-out provider sits out. Short and quiet on purpose: vendor
 *  slowness self-heals, so this is pacing, not an outage. The quota path (markDown) keeps
 *  its longer cooldown and its once-a-day alert; this one alerts nobody. */
function slowCooldownMs(): number {
  const n = Number(process.env.INMARKET_SEARCH_SLOW_COOLDOWN_MIN);
  return (Number.isFinite(n) && n > 0 ? n : 10) * 60_000;
}

/** In-memory on purpose: a streak is only meaningful within one process's burst of
 *  queries, and losing it on a deploy just means re-measuring three calls. */
const slowStreak: Partial<Record<WebSearchProvider, number>> = {};

/** Rest a provider that keeps timing out, without the break/email the quota path raises. */
function markSlow(provider: WebSearchProvider, reason: string): void {
  if (!budget) return;
  budget.down = { ...budget.down, [provider]: { until: new Date(Date.now() + slowCooldownMs()).toISOString(), reason } };
  scheduleBudgetSave();
  console.warn(`[websearch] ${provider} resting ${Math.round(slowCooldownMs() / 60000)}min after ${SLOW_STREAK_TO_REST} transient failures: ${reason}`);
}

/** Reserve one paid query. False when the ceiling is reached (caller must fall back to free). */
async function spendOne(provider: WebSearchProvider): Promise<boolean> {
  await hydrateBudget();
  rollDay();
  if (!budget) budget = { day: today(), used: 0 };
  const cap = dailyQueryCap();
  if (budget.used >= cap) return false;
  budget.used++;
  budget.provider = provider;
  budget.cap = cap;
  budget.usdCap = dailyUsdCap();
  scheduleBudgetSave();
  return true;
}

/** Give back a reserved slot after a provider call FAILED — a 400 that returned nothing is not
 *  spend, and counting it as spend once starved a whole day of naming while reporting a full
 *  budget honestly used (2026-08-13: 6,673 "queries", all of them credit-refusals). */
function refundOne(): void {
  if (budget && budget.used > 0) {
    budget.used--;
    scheduleBudgetSave();
  }
}

/**
 * True when a paid provider is configured AND today's budget still has room. Callers check this
 * (not `webSearchEnabled`) so an exhausted ceiling degrades to the free engine rotation rather
 * than to silence.
 */
export async function webSearchReady(): Promise<boolean> {
  if (!webSearchEnabled()) return false;
  const b = await webSearchBudget();
  return b.used < b.cap;
}

/* ------------------------------------------------------------------ */
/* Miss cache (persistent)                                             */
/* ------------------------------------------------------------------ */

const MISSES_KEY = "inmarket_websearch_misses_v1";
const MAX_MISS_ENTRIES = 20_000;
const PRUNE_TO = 15_000;

interface MissEntry {
  /** Consecutive empty answers from a healthy provider. */
  n: number;
  /** When the last one happened (ISO). */
  at: string;
}

interface MissState {
  e: Record<string, MissEntry>;
}

let misses: MissState | null = null;
let missHydrating: Promise<void> | null = null;
let missSaveTimer: ReturnType<typeof setTimeout> | null = null;

function missCap(): number {
  const n = Number(process.env.INMARKET_MISS_CAP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4;
}
function missRetryDays(): number {
  const n = Number(process.env.INMARKET_MISS_RETRY_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

function normalizeQuery(q: string): string {
  return String(q || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** FNV-1a — tiny, stable, good enough to key a bounded cache of query strings. */
function queryKey(q: string): string {
  const s = normalizeQuery(q);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * The suppression policy, pure so the regression suite can pin it: a query is suppressed once
 * it has missed `cap` times AND its latest miss is younger than `retryDays`. Older than that,
 * it may retry (people change jobs; a company unfindable in March has a new VP by June) — and
 * one retry either finds someone (entry cleared) or refreshes the clock for another quiet week.
 */
export function missSuppressed(entry: { n: number; at: string } | undefined, now: Date, cap: number, retryDays: number): boolean {
  if (!entry || entry.n < cap) return false;
  const age = now.getTime() - Date.parse(entry.at);
  return Number.isFinite(age) && age < retryDays * 86_400_000;
}

async function hydrateMisses(): Promise<void> {
  if (misses) return;
  missHydrating ??= (async () => {
    const saved = await loadSnapshot<MissState>(MISSES_KEY).catch(() => null);
    misses = saved && saved.e && typeof saved.e === "object" ? saved : { e: {} };
  })();
  await missHydrating;
  missHydrating = null;
}

function scheduleMissSave(): void {
  if (missSaveTimer) return;
  missSaveTimer = setTimeout(() => {
    missSaveTimer = null;
    if (misses) void saveSnapshot(MISSES_KEY, misses).catch(() => {});
  }, SAVE_DEBOUNCE_MS);
  (missSaveTimer as unknown as { unref?: () => void }).unref?.();
}

function noteMiss(query: string): void {
  if (!misses) return;
  const key = queryKey(query);
  const prev = misses.e[key];
  misses.e[key] = { n: (prev?.n ?? 0) + 1, at: new Date().toISOString() };
  // Bound the store: drop the oldest entries once it overgrows. Oldest-first is the right
  // eviction — an entry nobody has refreshed in months belongs to a query nobody asks anymore.
  const keys = Object.keys(misses.e);
  if (keys.length > MAX_MISS_ENTRIES) {
    keys.sort((a, b) => Date.parse(misses!.e[a].at) - Date.parse(misses!.e[b].at));
    for (const k of keys.slice(0, keys.length - PRUNE_TO)) delete misses.e[k];
  }
  scheduleMissSave();
}

function clearMiss(query: string): void {
  if (!misses) return;
  const key = queryKey(query);
  if (misses.e[key]) {
    delete misses.e[key];
    scheduleMissSave();
  }
}

/* ------------------------------------------------------------------ */
/* Naming health readout                                               */
/* ------------------------------------------------------------------ */

/**
 * IS DECISION-MAKER NAMING ACTUALLY ALIVE RIGHT NOW?
 *
 * The free scrapers are dead on this box, so the paid hop is not an optimization — it IS naming,
 * and naming is the gate on emails, which is the gate on video supply. When it goes dark the whole
 * chain drains quietly from the top and the first visible symptom is an empty render queue hours
 * later, described as a video problem. This is the readout that lets a monitor say so at the source
 * instead: `dark` is the single field worth alerting on, `reason` is what to put in the alert.
 *
 * Deliberately reports a near-exhausted budget as a WARNING while it still has room, because by the
 * time used === cap the supply damage is already done and cannot be undone until UTC midnight.
 */
export async function namingHealth(): Promise<{
  provider: string | null;
  used: number;
  cap: number;
  pctUsed: number;
  usdSpent: number;
  usdCap: number;
  dark: boolean;
  warn: boolean;
  reason: string;
  /** Rungs currently in quota cooldown, e.g. ["serper"]. */
  down: string[];
}> {
  const b = await webSearchBudget();
  const provider = webSearchProvider();
  const down = webSearchProviderOrder().filter((p) => isDown(p));
  const live = liveOrder();
  const pctUsed = b.cap > 0 ? Math.round((b.used / b.cap) * 100) : 100;
  const allDown = !!provider && live.length === 0;
  const dark = !provider || allDown || b.cap === 0 || b.used >= b.cap;
  const warn = !dark && (pctUsed >= 80 || down.length > 0);
  const reason = !provider
    ? "no paid search provider is configured — naming has only the free scrapers, which are throttled to zero on this box"
    : allDown
      ? `every paid search provider is out of credits or rejected (${down.map((p) => `${p}: ${budget?.down?.[p]?.reason || "quota"}`).join("; ")}) — naming is dark until one is topped up`
      : b.cap === 0
        ? "the paid search ceiling is set to 0, which disables naming entirely"
        : b.used >= b.cap
          ? `today's paid search ceiling is spent (${b.used}/${b.cap} queries, ~$${spentUsd(b.used, provider)}), so naming has fallen back to the throttled free engines until UTC midnight`
          : down.length
            ? `${down.join(", ")} ${down.length === 1 ? "is" : "are"} out of credits — naming is running on ${live[0]} (${b.used}/${b.cap} queries used today)`
            : warn
              ? `today's paid search budget is ${pctUsed}% spent (${b.used}/${b.cap}) — naming goes dark when it runs out`
              : `naming is running on ${live[0]} (${b.used}/${b.cap} queries used today, ~$${spentUsd(b.used, provider)})`;
  return { provider, used: b.used, cap: b.cap, pctUsed, usdSpent: spentUsd(b.used, provider), usdCap: dailyUsdCap(), dark, warn, reason, down };
}

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

export interface WebResult {
  /** Result title, e.g. "Jane Doe - VP of Engineering - Acme | LinkedIn". */
  title: string;
  /** Canonical result URL (the linkedin.com/in/… profile link when it's a profile). */
  url: string;
  /** Result snippet/description. */
  snippet: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Tolerant across SERP-API response shapes: {data:[…]} (real-time-web-search), {results:[…]}, or a
 *  bare array. Each row may name its fields differently, so we probe the common aliases. */
function parseResults(data: unknown): WebResult[] {
  const root = data as { data?: unknown; results?: unknown } | unknown[] | null;
  const arr: unknown[] = Array.isArray(root) ? root
    : Array.isArray((root as { data?: unknown })?.data) ? (root as { data: unknown[] }).data
    : Array.isArray((root as { results?: unknown })?.results) ? (root as { results: unknown[] }).results
    : [];
  const out: WebResult[] = [];
  for (const r of arr) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const title = str(o.title) || str(o.name) || str(o.heading);
    const url = str(o.url) || str(o.link) || str(o.href);
    const snippet = str(o.description) || str(o.snippet) || str(o.desc) || str(o.content) || str(o.body);
    if (title || url) out.push({ title, url, snippet });
  }
  return out;
}

/** One provider call's outcome. `quota: true` means the failure will not self-heal (out of
 *  credits, key rejected) and the rung should cool down; `quota: false` is transient. */
interface Outcome {
  ok: boolean;
  /** Present when ok. */
  results?: WebResult[];
  /** Present when !ok. */
  quota?: boolean;
  reason?: string;
}

/** DataForSEO live "regular" Google SERP — with the site:-operator rewrite (5x surcharge dodge,
 *  see serpRewrite.ts) and a URL post-filter standing in for the operator's guarantee. Same
 *  balance as the JD Sourcing wide-web pass, so one auto-recharge funds both. */
async function dataforseoSearch(query: string): Promise<Outcome> {
  const auth = Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString("base64");
  const depth = Math.max(10, Math.min(Number(process.env.INMARKET_SEARCH_DEPTH) || 10, 100));
  const rw = rewriteSiteOperators(query);
  const res = await fetch("https://api.dataforseo.com/v3/serp/google/organic/live/regular", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify([{ keyword: rw.query.slice(0, 700), location_code: 2840, language_code: "en", depth }]),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const txt = (await res.text().catch(() => "")).slice(0, 200);
    const quota = res.status === 402 || res.status === 429 || res.status === 401 || res.status === 403 || /balance|payment|money/i.test(txt);
    return { ok: false, quota, reason: `dataforseo ${res.status} ${txt}`.trim() };
  }
  const data = await res.json().catch(() => null) as {
    status_code?: number;
    tasks?: Array<{ status_code?: number; status_message?: string; result?: Array<{ items?: unknown[] }> }>;
  } | null;
  // DataForSEO answers HTTP 200 with per-payload status codes: 20000 = ok, 402xx = payment.
  const task = data?.tasks?.[0];
  const code = Number(data?.status_code || 0);
  const taskCode = Number(task?.status_code || 0);
  if (code !== 20000 || (taskCode && taskCode !== 20000)) {
    const msg = String(task?.status_message || "unexpected answer");
    const quota = /money|balance|payment/i.test(msg) || String(taskCode).startsWith("402");
    return { ok: false, quota, reason: `dataforseo ${taskCode || code} (${msg})` };
  }
  const items = task?.result?.[0]?.items;
  const results = (Array.isArray(items) ? parseResults(items) : [])
    .filter((r) => matchesSitePrefixes(r.url, rw.sitePrefixes));
  return { ok: true, results };
}

/** Serper (serper.dev) — Google results as JSON, 1 credit per query. Out of credits answers
 *  HTTP 400 {"message":"Not enough credits"} — a 400, not the 429 you'd expect. */
async function serperSearch(query: string): Promise<Outcome> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": process.env.SERPER_API_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: 10 }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const txt = (await res.text().catch(() => "")).slice(0, 200);
    const quota = res.status === 429 || res.status === 401 || res.status === 403 || /credit|quota/i.test(txt);
    return { ok: false, quota, reason: `serper ${res.status} ${txt}`.trim() };
  }
  const data = await res.json().catch(() => null) as { organic?: unknown[] } | null;
  return { ok: true, results: Array.isArray(data?.organic) ? parseResults(data.organic) : [] };
}

const rapidCfg = {
  host: () => process.env.RAPID_WEBSEARCH_HOST || "real-time-web-search.p.rapidapi.com",
  path: () => process.env.RAPID_WEBSEARCH_PATH || "/search",
  queryParam: () => process.env.RAPID_WEBSEARCH_QUERY_PARAM || "q",
  limitParam: () => (process.env.RAPID_WEBSEARCH_LIMIT_PARAM ?? "limit"),
  limit: () => process.env.RAPID_WEBSEARCH_LIMIT || "20",
  gl: () => (process.env.RAPID_WEBSEARCH_GL ?? "us"),
  hl: () => (process.env.RAPID_WEBSEARCH_HL ?? "en"),
};

/** RapidAPI real-time-web-search (the original provider). 403 = not subscribed; 429 = quota. */
async function rapidSearch(query: string): Promise<Outcome> {
  const host = rapidCfg.host();
  const u = new URL(`https://${host}${rapidCfg.path()}`);
  u.searchParams.set(rapidCfg.queryParam(), query);
  if (rapidCfg.limitParam()) u.searchParams.set(rapidCfg.limitParam(), rapidCfg.limit());
  if (rapidCfg.gl()) u.searchParams.set("gl", rapidCfg.gl());
  if (rapidCfg.hl()) u.searchParams.set("hl", rapidCfg.hl());
  const res = await fetch(u.toString(), {
    method: "GET",
    headers: {
      "X-RapidAPI-Key": process.env.RAPID_WEBSEARCH_KEY!,
      "X-RapidAPI-Host": host,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // Feed the credit meter so the Owner Console's spend dashboard can tell a working
  // subscription from one nobody wired up.
  noteRapidQuota(host, res.headers, "search");
  if (!res.ok) {
    const quota = res.status === 429 || res.status === 403 || res.status === 401;
    return { ok: false, quota, reason: `rapidapi(${host}) ${res.status}` };
  }
  const data: unknown = await res.json().catch(() => null);
  return { ok: true, results: data ? parseResults(data) : [] };
}

async function attempt(provider: WebSearchProvider, query: string): Promise<Outcome> {
  try {
    if (provider === "dataforseo") return await dataforseoSearch(query);
    if (provider === "serper") return await serperSearch(query);
    return await rapidSearch(query);
  } catch (e) {
    // Timeouts and network drops are transient by definition — no cooldown.
    return { ok: false, quota: false, reason: `${provider} ${(e as Error)?.name || "error"}` };
  }
}

/**
 * Run ONE query down the provider ladder and return its results. [] on a genuine empty answer
 * (a real negative — counted against the miss cache), when unconfigured, when today's budget
 * is spent, when the query is miss-suppressed, or when every rung failed. A rung that fails
 * with a quota-shaped error cools down and alerts (once/day); the next rung serves the same
 * query in the same call. Failed calls refund their budget slot. Authenticated paid APIs →
 * default route, no egress rotation (rotation is only for the free scrapers this replaces).
 */
export async function webSearchResults(query: string): Promise<WebResult[]> {
  if (!query || !webSearchEnabled()) return [];
  await hydrateBudget();
  rollDay();
  await hydrateMisses();
  if (missSuppressed(misses?.e[queryKey(query)], new Date(), missCap(), missRetryDays())) return [];

  for (const provider of liveOrder()) {
    if (!(await spendOne(provider))) return []; // ceiling reached — caller falls back to free
    const out = await attempt(provider, query);
    if (out.ok) {
      slowStreak[provider] = 0;
      const results = out.results ?? [];
      if (results.length) clearMiss(query);
      else noteMiss(query);
      return results;
    }
    refundOne(); // a failed call returned nothing and billed nothing worth counting
    if (out.quota) {
      slowStreak[provider] = 0; // the quota cooldown owns this failure now
      await markDown(provider, out.reason || `${provider} quota`);
      continue; // next rung serves this same query
    }
    // Transient failure: still try the next rung — failover is the point. One hiccup is
    // not an outage, but a STREAK of them means the vendor is degraded and every query
    // is paying the full timeout on this rung before the next one serves it. Rest it
    // briefly (no alert; this self-heals) so the ladder skips straight to a live rung.
    const streak = (slowStreak[provider] ?? 0) + 1;
    slowStreak[provider] = streak;
    if (streak >= SLOW_STREAK_TO_REST) {
      slowStreak[provider] = 0;
      markSlow(provider, out.reason || `${provider} transient failures x${streak}`);
    }
  }
  return [];
}

/** Convenience: just the result titles (the "Name - Title - Company" strings the naming parsers eat). */
export async function webSearchTitles(query: string): Promise<string[]> {
  return (await webSearchResults(query)).map((r) => r.title).filter(Boolean);
}
