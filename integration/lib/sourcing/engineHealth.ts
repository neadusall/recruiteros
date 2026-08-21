/**
 * RecruitersOS · JD Sourcing — discovery engine health watch.
 *
 * WHY THIS EXISTS. On 2026-07-30 the Lume workspace's Serper key hit zero credits.
 * Serper is the wide web-search pass and, measured across 14 saved runs, it had
 * produced 61.8% of every candidate ever sourced (5,709 of 9,242). Nothing noticed.
 * The first signal was recruiters saying searches "didn't work", hours later, after
 * a separate engineer had already misdiagnosed it and changed unrelated code. A paid
 * dependency that supplies two thirds of the product's output had no monitoring at
 * all.
 *
 * This checks each workspace's discovery engines on a timer and raises an in-app
 * notification to the workspace owner the moment one degrades — EDGE-TRIGGERED, so a
 * sustained outage notifies once rather than every hour.
 *
 * COST NOTE, deliberate and asymmetric:
 *  - Serper has no free balance endpoint, so the only honest check is a real 1-credit
 *    query. At hourly that is ~720 credits/month, about $0.72 against a $50/50k pack.
 *    Worth it: this is the engine that actually died.
 *  - RapidAPI DOES report remaining/limit on every response, and the app already
 *    persists that in the rapidapi_quota_v1 snapshot on each real search. So we read
 *    the snapshot and spend NOTHING. It goes stale when nobody searches, which we
 *    surface as "stale" rather than pretending it is fresh.
 */

import { loadSnapshot, debouncedSaver } from "../db";
import { nowIso } from "../core/ids";
import { withWorkspaceCreds } from "../connected";
import { adminListAccounts, workspaceOwner, ensureAuthReady } from "../auth";
import { pushNotification } from "../outbound/notify";
import {
  verifySerperSearch, serperSearchConfigured, rapidApiSearchConfigured,
  dataforseoSearchConfigured, dataforseoAccountBalance, verifyDataForSeoSearch,
  verifySourcingSearch, peopleSearchHost, peopleSearchServing, widePrimary,
} from "./discovery";
import { getRapidQuotaFor } from "./rapidQuota";

const KEY = "sourcing_engine_health_v1";

/** Warn when a metered engine drops below this share of its quota. */
const LOW_WATER = 0.2;
/** A quota reading older than this is reported as stale, not as truth. */
const STALE_MS = 7 * 24 * 3600_000;

export type EngineState = "ok" | "low" | "down" | "unconfigured" | "stale";

export interface EngineStatus {
  engine: "serper" | "rapidapi" | "dataforseo";
  state: EngineState;
  detail: string;
  remaining?: number;
  limit?: number;
  /** Fraction of quota left, 0..1, when the engine reports one. */
  pct?: number;
  checkedAt: string;
}

export interface WorkspaceEngineHealth {
  workspaceId: string;
  name: string;
  engines: EngineStatus[];
  /** Worst state across engines — what an operator dashboard should show. */
  worst: EngineState;
}

/** Result of the last billed liveness probe for one workspace's paid engine. */
interface ProbeResult {
  at: string;
  ok: boolean;
  error?: string;
  found?: number;
  /** The provider refused us (its throttle), rather than answering with nobody. */
  throttled?: boolean;
  /** Consecutive TRANSIENT bad probes - empty answers or throttles. See liveProbe(). */
  emptyStreak?: number;
}

interface HealthBlob {
  /** `${workspaceId}:${engine}` -> last state, so we only notify on transitions. */
  last: Record<string, EngineState>;
  /** `${workspaceId}:${engine}` -> last live probe, so a healthy engine is not
   *  re-billed on every tick (see PROBE_EVERY_MS). */
  probes: Record<string, ProbeResult>;
  updatedAt?: string;
  report?: WorkspaceEngineHealth[];
}

let store: HealthBlob = { last: {}, probes: {} };
let hydrated = false;
const save = debouncedSaver(KEY, () => store);

async function hydrate(): Promise<void> {
  if (hydrated) return;
  const snap = await loadSnapshot<HealthBlob>(KEY);
  if (snap && typeof snap === "object") store = { last: snap.last ?? {}, probes: snap.probes ?? {}, report: snap.report };
  hydrated = true;
}

/** Rank so `worst` is meaningful. Higher = more urgent. */
const RANK: Record<EngineState, number> = { ok: 0, unconfigured: 1, stale: 2, low: 3, down: 4 };

/** Serper: no balance API, so a real 1-credit query is the only honest signal. */
async function checkSerper(): Promise<EngineStatus> {
  const checkedAt = nowIso();
  if (!serperSearchConfigured()) {
    return { engine: "serper", state: "unconfigured", detail: "No Serper API key set for this workspace.", checkedAt };
  }
  const res = await verifySerperSearch();
  if (res.ok) {
    return { engine: "serper", state: "ok", detail: `Live: ${res.found ?? 0} results returned.`, checkedAt };
  }
  const err = res.error || "search request failed";
  // serperXraySearch tags credit/quota failures explicitly; treat everything else as
  // down too, but keep the vendor's wording so the notification is actionable.
  return { engine: "serper", state: "down", detail: err, checkedAt };
}

/** Warn when the DataForSEO balance drops under this many dollars (roughly a
 *  thousand wide-web searches of headroom at its live-task pricing). */
const DFS_LOW_USD = 2;

/**
 * DataForSEO — now the PRIMARY wide-web pass, so it is checked like one.
 *
 * The balance endpoint is free, which is why this used to be balance-only. But a
 * balance proves the login authenticates and there is money behind it, NOT that a
 * search comes back with anything: this engine sat "ok, Balance: $49.25" while having
 * returned 0 candidates in every saved run. So the money check (free) is followed by a
 * real search (about $0.002 at depth 10, daily), the same shape as the RapidAPI probe.
 */
async function checkDataForSeo(workspaceId: string): Promise<EngineStatus> {
  const checkedAt = nowIso();
  if (!dataforseoSearchConfigured()) {
    return { engine: "dataforseo", state: "unconfigured", detail: "No DataForSEO API login set for this workspace.", checkedAt };
  }
  const { balance, error } = await dataforseoAccountBalance();
  if (balance === null) {
    return { engine: "dataforseo", state: "down", detail: error || "balance check failed", checkedAt };
  }
  const usd = `$${balance.toFixed(2)}`;
  // No money means no search; probing would only burn a request to learn that.
  if (balance <= 0.05) return { engine: "dataforseo", state: "down", detail: `Balance empty (${usd}). Top up at app.dataforseo.com.`, remaining: balance, checkedAt };

  const probe = await liveProbe(`${workspaceId}:dataforseo`, verifyDataForSeoSearch);
  if (probe && !probe.ok) {
    const state = probeState(probe);
    return {
      engine: "dataforseo", state, remaining: balance, checkedAt,
      detail: state === "stale"
        ? `Login and balance are fine (${usd}) but the last search returned no profiles. This vendor blanks intermittently, so it is being re-checked before anyone is alerted.`
        : `Login and balance are fine (${usd}) but the search itself failed: ${probe.error || "search request failed"}`,
    };
  }
  const proof = probe && probe.at === checkedAt
    ? `Live: search answered with ${probe.found ?? 0} result(s).`
    : `Search answered at ${probe?.at}.`;
  if (balance < DFS_LOW_USD) return { engine: "dataforseo", state: "low", detail: `${proof} Balance running low: ${usd} left.`, remaining: balance, checkedAt };
  return { engine: "dataforseo", state: "ok", detail: `${proof} Balance: ${usd}.`, remaining: balance, checkedAt };
}

/**
 * RapidAPI: a live search costs one BILLED request, so a listing that already answered
 * is re-proven at most this often. A FAILED probe is retried on every tick — a dead key
 * is exactly the thing worth re-checking, and a refusal usually costs nothing.
 *
 * Daily, not hourly, and deliberately so. This box has a standing rule against
 * background loops quietly spending on paid APIs, and the proactive probe is only the
 * SECOND line of defence: a dead key is caught within milliseconds of a real search by
 * the fatal-error path in discovery.ts. At daily this costs ~4 requests/day across every
 * workspace here, against a 20,000/month plan. Override with SOURCING_PROBE_EVERY_H.
 */
const PROBE_EVERY_MS = (() => {
  const h = parseInt(process.env.SOURCING_PROBE_EVERY_H || "", 10);
  return (Number.isFinite(h) && h > 0 ? h : 24) * 3600_000;
})();

/** Consecutive empty probes before an engine is called down rather than watched. */
const EMPTY_STREAK_TO_DOWN = 2;

/**
 * Run (or reuse) the cached liveness probe for one engine, with HYSTERESIS on the
 * "answered cleanly but returned nobody" case.
 *
 * A hard failure — auth refused, HTTP error, network — is down immediately; it will not
 * fix itself. An EMPTY answer is a different animal. Measured on this box across five
 * back-to-back cycles, DataForSEO returned a blank page for a perfectly valid x-ray on
 * one cycle in five, and blank TWICE IN A ROW on that cycle, even though the query
 * returns ~10 profiles the rest of the time. Marking down on a single empty answer would
 * page the owner over vendor noise and teach them to ignore the alerts.
 *
 * So an empty answer parks at "stale", which is visible but does not alert, and only
 * escalates to "down" once the NEXT check is empty too — an hour later, four blank calls
 * apart. A run of results resets the streak.
 *
 * A probe that is not `ok` is always re-run on the next tick, so the escalation happens
 * at the watch's own cadence with no extra scheduling.
 */
async function liveProbe(
  key: string,
  run: () => Promise<{ ok: boolean; error?: string; found?: number; throttled?: boolean }>,
): Promise<ProbeResult | undefined> {
  const prev = store.probes[key];
  const due = !prev || !prev.ok || Date.now() - new Date(prev.at).getTime() > PROBE_EVERY_MS;
  if (!due) return prev;
  const res = await run();
  // probeResult() reports an empty answer as ok:false WITH found:0; a hard failure has
  // no `found` at all. That is what separates "returned nobody" from "did not answer".
  // "Answered but returned nobody" and "the provider throttled us" are both TRANSIENT,
  // so they share the hysteresis below. A refused key or an HTTP error is neither.
  const soft = !res.ok && (res.found === 0 || res.throttled === true);
  const next: ProbeResult = {
    at: nowIso(),
    ok: res.ok,
    error: res.error,
    found: res.found,
    throttled: res.throttled,
    emptyStreak: soft ? (prev?.emptyStreak ?? 0) + 1 : 0,
  };
  store.probes[key] = next;
  return next;
}

/** The state an unhealthy probe maps to: watched while it might just be vendor noise. */
function probeState(probe: ProbeResult): EngineState {
  const soft = probe.found === 0 || probe.throttled === true;
  return soft && (probe.emptyStreak ?? 0) < EMPTY_STREAK_TO_DOWN ? "stale" : "down";
}

/**
 * RapidAPI people search.
 *
 * TWO questions, and this check used to answer neither. It read
 * `rapidapi_quota_v1` as a flat host->row map, but the snapshot is
 * `{hosts, history}` — so `Object.values()` yielded those two containers, the
 * numeric filter rejected both, and the check returned "stale" every single time it
 * ran, for any key, working or not. Even had it parsed, it took the tightest row
 * across ALL listings, so the phone skip-trace or the job feed could speak for JD
 * Sourcing's search.
 *
 * And a quota reading answers "how much plan is left", never "does this key still
 * work". A listing that renames its endpoint, or a subscription that lapses, keeps
 * whatever number it last wrote and reads healthy forever. So:
 *   1. VALIDITY comes from a real one-request search, rate-limited by PROBE_EVERY_MS.
 *   2. HEADROOM comes from the quota row for THIS listing's host only.
 */
async function checkRapidApi(workspaceId: string): Promise<EngineStatus> {
  const checkedAt = nowIso();
  if (!rapidApiSearchConfigured()) {
    return { engine: "rapidapi", state: "unconfigured", detail: "No RapidAPI people-search key/host set.", checkedAt };
  }
  // 1) Does it actually answer? One billed request, at most every PROBE_EVERY_MS
  //    while healthy. The probe also refreshes the quota headers below for free.
  const probe = await liveProbe(`${workspaceId}:rapidapi`, verifySourcingSearch);
  // Read AFTER the probe, never before. Whether the configured listing even has a
  // people-search endpoint is only discovered by trying it, and naming the configured
  // host in a failure the FALLBACK listing produced sends the reader to the wrong
  // dashboard. Seen live 2026-08-21: "not answering on realtime-linkedin-fresh-data"
  // when that listing had 404'd on every known path and the answer - a throttle - came
  // from the fallback listing entirely.
  const host = peopleSearchHost();
  const serving = peopleSearchServing();
  // Serving through the fallback listing means searches work but Setup is wrong: say
  // both, so a working search never buries the stale config it is covering for.
  const configNote = serving.viaFallback
    ? ` The listing configured in Setup (${serving.configured}) has no people-search endpoint, so this ran on ${serving.serving} instead - fix the search host/path under Setup -> JD Sourcing.`
    : "";
  if (probe && !probe.ok) {
    const state = probeState(probe);
    // A throttle is the provider saying "not right now", NOT a key, a subscription or a
    // spent plan. Reporting it as "down" sent an owner hunting a billing problem that
    // did not exist, so it says which of the two this is in the first sentence.
    const detail = probe.throttled
      ? (state === "stale"
        ? `${host} is throttling our requests (its own limit, not your plan's). Re-checking before anyone is alerted.`
        : `${host} keeps throttling our requests: ${probe.error || "too many requests"} Your plan credits are not the problem; searches will thin out until the provider lets up.`)
      : (state === "stale"
        ? `The people search on ${host} answered but returned nobody. Re-checking before anyone is alerted.`
        : `The people search is not answering on ${host}: ${probe.error || "search request failed"}`);
    return { engine: "rapidapi", state, checkedAt, detail: detail + configNote };
  }
  const proof = (probe && probe.at === checkedAt
    ? `Live: search answered with ${probe.found ?? 0} result(s).`
    : `Search answered at ${probe?.at}.`) + configNote;

  // 2) How much plan is left on THIS listing?
  const row = await getRapidQuotaFor(host);
  if (!row || typeof row.limit !== "number" || row.limit <= 0) {
    // It works, it just does not publish x-ratelimit headers. That is not a fault.
    return { engine: "rapidapi", state: "ok", detail: `${proof} This listing does not report a credit balance.`, checkedAt };
  }
  const pct = row.remaining / Math.max(1, row.limit);
  const age = Date.now() - new Date(row.updatedAt || 0).getTime();
  const base = { engine: "rapidapi" as const, remaining: row.remaining, limit: row.limit, pct, checkedAt };
  const pctTxt = `${row.remaining}/${row.limit} (${Math.round(pct * 100)}%)`;
  if (row.remaining <= 0) return { ...base, state: "down", detail: `Plan requests exhausted on ${host}: ${pctTxt}.` };
  if (pct < LOW_WATER) return { ...base, state: "low", detail: `Running low on ${host}: ${pctTxt} left.` };
  if (Number.isFinite(age) && age > STALE_MS) {
    return { ...base, state: "stale", detail: `${proof} Credit reading is ${Math.round(age / 86400000)}d old: ${pctTxt}.` };
  }
  return { ...base, state: "ok", detail: `${proof} ${pctTxt} remaining on ${host}.` };
}

function worstOf(engines: EngineStatus[]): EngineState {
  let out: EngineState = "ok";
  for (const e of engines) if (RANK[e.state] > RANK[out]) out = e.state;
  return out;
}

/**
 * Does this down-detail describe a TRANSIENT transport failure (timeout, network drop,
 * vendor 5xx) rather than anything a billing dashboard can fix? Account-shaped failures
 * never match: their details say "Balance empty", "out of credits", "login rejected",
 * "key rejected", none of which appear here. Matched against the detail text because the
 * probe error is already embedded in it verbatim by the check functions above.
 *
 * Why it matters: on 2026-08-19 DataForSEO's SERP endpoint timed out with $46.93 in the
 * account, and the alert said "Top up at app.dataforseo.com" anyway, sending the owner
 * to fix the one thing that was NOT broken.
 */
function transientDown(detail: string): boolean {
  return /timeout|timed out|abort|network|fetch failed|socket hang|ECONN|\b(dataforseo|serper|google|rapidapi)?\s?50[0-9]\b/i.test(detail);
}

/** Human sentence for the notification body. */
function alertBody(wsName: string, e: EngineStatus): string {
  // Which wide-web engine leads is a setting, so the copy follows it rather than naming
  // a winner: telling an owner their "primary" is down when it is actually the second
  // pass sends them to the wrong dashboard.
  const lead = widePrimary();
  const isLead = e.engine === lead;
  const role = isLead ? "the primary wide web-search pass" : "the wide web-search top-up";
  const who =
    e.engine === "dataforseo" ? `DataForSEO (${role})`
    : e.engine === "serper" ? `Serper (${role})`
    : "the RapidAPI people-search engine";
  const topUpAt = e.engine === "dataforseo" ? "app.dataforseo.com" : "serper.dev";
  if ((e.engine === "dataforseo" || e.engine === "serper") && e.state === "down") {
    const impact = isLead
      ? `This is the engine that carries most of JD Sourcing's candidates, so searches will return far fewer people until it is restored.`
      : `The primary pass runs first and absorbs the volume, so runs continue without it, just minus the second pass that picked up what the primary missed.`;
    // A vendor-side outage and an empty balance need OPPOSITE advice: telling someone to
    // top up a funded account teaches them the alerts can't be trusted.
    const action = transientDown(e.detail)
      ? `The failure is on the vendor's side, not the account, so there is nothing to top up. The health watch re-probes on its own schedule and clears this alert once the vendor recovers; if it is still down after a day, that is worth a support ticket at ${topUpAt}.`
      : isLead
        ? `Top up or check the login at ${topUpAt}.`
        : `Top up at ${topUpAt} when convenient.`;
    return `${who} is not answering for ${wsName}: ${e.detail} ${impact} ${action}`;
  }
  if (e.engine === "rapidapi" && e.state === "down") {
    // A throttled provider and a wrong key produce the same silence and need OPPOSITE
    // actions. Sending an owner to re-check a key that is fine is how alerts stop being
    // read at all - so the advice follows what the probe actually found.
    const action = /throttl/i.test(e.detail)
      ? `Nothing in Setup needs changing: the key and the plan are fine, and the provider lifts its own limit. The health watch re-probes on its own schedule and clears this when it does; still throttled a day from now is worth a support ticket on the listing.`
      : `Check the key, the listing subscription and the search host/path under Setup -> JD Sourcing.`;
    return `${who} is refusing requests for ${wsName}: ${e.detail} JD Sourcing runs will skip the paid people search until this clears. ${action}`;
  }
  if (e.state === "low") return `${who} is running low for ${wsName}. ${e.detail}`;
  if (e.state === "down") return `${who} is down for ${wsName}. ${e.detail}`;
  return `${who} for ${wsName}: ${e.detail}`;
}

/**
 * Check every workspace that has JD Sourcing engines configured. Returns the full
 * report; raises a notification only where a state got WORSE than last check.
 */
export async function checkEngineHealth(opts: { notify?: boolean } = {}): Promise<WorkspaceEngineHealth[]> {
  await hydrate();
  // Background job: the auth store may not be hydrated yet on a cold container,
  // and adminListAccounts() reads it directly. Without this the first tick after a
  // deploy silently reports zero workspaces.
  await ensureAuthReady();
  const notify = opts.notify !== false;
  const report: WorkspaceEngineHealth[] = [];

  for (const acct of adminListAccounts()) {
    if (acct.suspended) continue;
    let engines: EngineStatus[] = [];
    try {
      engines = await withWorkspaceCreds(acct.workspaceId, async () => {
        // Sequential on purpose: two cheap calls, and it keeps the credential
        // context unambiguous for the duration of each check.
        const s = await checkSerper();
        const d = await checkDataForSeo(acct.workspaceId);
        const r = await checkRapidApi(acct.workspaceId);
        return [s, d, r];
      });
    } catch (e: any) {
      console.error("[engine-health] check failed for", acct.workspaceId, e?.message || e);
      continue;
    }
    // A workspace with nothing configured is not interesting — skip it entirely so
    // trial/demo shells don't fill the report with noise.
    if (engines.every((e) => e.state === "unconfigured")) continue;

    report.push({ workspaceId: acct.workspaceId, name: acct.name, engines, worst: worstOf(engines) });

    if (!notify) continue;
    for (const e of engines) {
      const k = `${acct.workspaceId}:${e.engine}`;
      const prev = store.last[k] ?? "ok";
      store.last[k] = e.state;
      // Edge-triggered: only fire when it got worse. Recovery is recorded silently
      // so the next degradation notifies again.
      if (RANK[e.state] <= RANK[prev]) continue;
      if (e.state !== "down" && e.state !== "low") continue;
      const owner = await workspaceOwner(acct.workspaceId);
      if (!owner) continue;
      try {
        await pushNotification(acct.workspaceId, {
          userId: owner.userId,
          category: "system",
          severity: e.state === "down" ? "critical" : "warning",
          title: e.state === "down" ? `JD Sourcing: ${e.engine} is down` : `JD Sourcing: ${e.engine} is running low`,
          body: alertBody(acct.name, e),
        });
        console.error(`[engine-health] ALERT ${acct.name} ${e.engine} ${prev} -> ${e.state}: ${e.detail}`);
      } catch (err: any) {
        console.error("[engine-health] notify failed:", err?.message || err);
      }
    }
  }

  store.updatedAt = nowIso();
  store.report = report;
  save();
  return report;
}

/** Last computed report, for the UI/API without re-spending a Serper credit. */
export async function lastEngineHealth(): Promise<{ updatedAt?: string; report: WorkspaceEngineHealth[] }> {
  await hydrate();
  return { updatedAt: store.updatedAt, report: store.report ?? [] };
}
