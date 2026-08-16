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
  dataforseoSearchConfigured, dataforseoAccountBalance,
  verifySourcingSearch, peopleSearchHost,
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
interface ProbeResult { at: string; ok: boolean; error?: string; found?: number }

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

/** DataForSEO: FREE balance endpoint, so this check spends nothing. */
async function checkDataForSeo(): Promise<EngineStatus> {
  const checkedAt = nowIso();
  if (!dataforseoSearchConfigured()) {
    return { engine: "dataforseo", state: "unconfigured", detail: "No DataForSEO API login set for this workspace.", checkedAt };
  }
  const { balance, error } = await dataforseoAccountBalance();
  if (balance === null) {
    return { engine: "dataforseo", state: "down", detail: error || "balance check failed", checkedAt };
  }
  const usd = `$${balance.toFixed(2)}`;
  if (balance <= 0.05) return { engine: "dataforseo", state: "down", detail: `Balance empty (${usd}). Top up at app.dataforseo.com.`, remaining: balance, checkedAt };
  if (balance < DFS_LOW_USD) return { engine: "dataforseo", state: "low", detail: `Balance running low: ${usd} left.`, remaining: balance, checkedAt };
  return { engine: "dataforseo", state: "ok", detail: `Balance: ${usd}.`, remaining: balance, checkedAt };
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
  const host = peopleSearchHost();

  // 1) Does it actually answer? One billed request, at most every PROBE_EVERY_MS
  //    while healthy. The probe also refreshes the quota headers below for free.
  const pk = `${workspaceId}:rapidapi`;
  const prev = store.probes[pk];
  const due = !prev || !prev.ok || Date.now() - new Date(prev.at).getTime() > PROBE_EVERY_MS;
  let probe = prev;
  if (due) {
    const res = await verifySourcingSearch();
    probe = { at: checkedAt, ok: res.ok, error: res.error, found: res.found };
    store.probes[pk] = probe;
  }
  if (probe && !probe.ok) {
    return {
      engine: "rapidapi", state: "down", checkedAt,
      detail: `The people search is not answering on ${host}: ${probe.error || "search request failed"}`,
    };
  }
  const proof = probe?.at === checkedAt
    ? `Live: search answered with ${probe?.found ?? 0} result(s).`
    : `Search answered at ${probe?.at}.`;

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

/** Human sentence for the notification body. */
function alertBody(wsName: string, e: EngineStatus): string {
  const who =
    e.engine === "serper" ? "Serper (the wide web-search pass)"
    : e.engine === "dataforseo" ? "DataForSEO (the cheapest wide web-search pass)"
    : "the RapidAPI people-search engine";
  if (e.engine === "serper" && e.state === "down") {
    return `${who} is not answering for ${wsName}: ${e.detail} Serper supplies most of JD Sourcing's candidates, so searches will return far fewer people until this is restored. Top up at serper.dev.`;
  }
  if (e.engine === "rapidapi" && e.state === "down") {
    return `${who} is refusing requests for ${wsName}: ${e.detail} JD Sourcing runs will skip the paid people search until this is fixed. Check the key, the listing subscription and the search host/path under Setup -> JD Sourcing.`;
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
        const d = await checkDataForSeo();
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
