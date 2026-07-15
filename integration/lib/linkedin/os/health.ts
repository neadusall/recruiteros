/**
 * RecruitersOS · LinkedIn OS
 * Account state + risk engine. Watches provider results for restriction
 * responses, failure spikes and disconnects, and steps the account down
 * HEALTHY -> WATCH -> ELEVATED -> COOLDOWN -> PAUSED before anything breaks.
 * Also owns the one-switch kill switch that pauses every LinkedIn automation
 * on the account, whatever surface created it.
 */

import { nowIso } from "../../core/ids";
import { accounts, withEngineLock } from "./store";
import { HEALTH_CAPACITY_FACTOR } from "./types";
import type { AccountHealthState, LiAccountState, RiskSignal } from "./types";

const WINDOW = 30;              // rolling result window per account
const COOLDOWN_MINUTES = 90;    // automatic cooldown length

export async function listAccounts(workspaceId: string): Promise<LiAccountState[]> {
  const all = await accounts.all();
  return all.filter((a) => a.workspaceId === workspaceId);
}

export async function getAccount(workspaceId: string, accountId: string): Promise<LiAccountState | null> {
  const all = await accounts.all();
  return all.find((a) => a.workspaceId === workspaceId && a.accountId === accountId) ?? null;
}

/**
 * Ensure an account state row exists. The account itself comes from the
 * Connected/Unipile layer; this is the engine's operating record for it.
 */
export async function ensureAccount(
  workspaceId: string,
  accountId: string,
  seed?: Partial<LiAccountState>,
): Promise<LiAccountState> {
  return withEngineLock(async () => {
    const all = await accounts.all();
    let a = all.find((x) => x.workspaceId === workspaceId && x.accountId === accountId);
    if (!a) {
      a = {
        workspaceId,
        accountId,
        displayName: seed?.displayName ?? accountId,
        providerAccountId: seed?.providerAccountId,
        products: seed?.products ?? { classic: true, salesNavigator: false, recruiter: false },
        connected: seed?.connected ?? true,
        health: "healthy",
        riskSignals: [],
        killSwitch: false,
        recentResults: [],
        ownerUserId: seed?.ownerUserId,
        timezone: seed?.timezone,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      all.push(a);
      accounts.save();
    } else if (seed) {
      if (seed.displayName) a.displayName = seed.displayName;
      if (seed.providerAccountId) a.providerAccountId = seed.providerAccountId;
      if (seed.products) a.products = { ...a.products, ...seed.products };
      if (seed.connected !== undefined) a.connected = seed.connected;
      a.updatedAt = nowIso();
      accounts.save();
    }
    return a;
  });
}

function pushSignal(a: LiAccountState, kind: string, detail: string): void {
  a.riskSignals.push({ kind, detail, at: nowIso() });
  if (a.riskSignals.length > 50) a.riskSignals.splice(0, a.riskSignals.length - 50);
}

function looksLikeRestriction(error: string): boolean {
  return /restrict|challenge|captcha|verification|forbidden|429|403|suspend/i.test(error);
}

/** Feed one provider result into the risk window and re-evaluate health. */
export async function recordResult(
  workspaceId: string,
  accountId: string,
  ok: boolean,
  kind?: string,
  error?: string,
): Promise<LiAccountState> {
  return withEngineLock(async () => {
    const a = await ensureAccountInLock(workspaceId, accountId);
    a.recentResults.push({ ok, at: nowIso(), kind });
    if (a.recentResults.length > WINDOW) a.recentResults.splice(0, a.recentResults.length - WINDOW);

    if (!ok && error) {
      if (looksLikeRestriction(error)) {
        pushSignal(a, "provider_restriction", error.slice(0, 200));
        stepDown(a, "cooldown", "Provider restriction style response detected");
      } else if (/auth|credential|token|401/i.test(error)) {
        pushSignal(a, "auth_error", error.slice(0, 200));
        a.connected = false;
        stepDown(a, "disconnected", "Authentication errors from the provider");
      } else {
        pushSignal(a, "action_failed", `${kind ?? "action"}: ${error.slice(0, 160)}`);
      }
    }
    reevaluate(a);
    a.updatedAt = nowIso();
    accounts.save();
    return a;
  });
}

async function ensureAccountInLock(workspaceId: string, accountId: string): Promise<LiAccountState> {
  const all = await accounts.all();
  let a = all.find((x) => x.workspaceId === workspaceId && x.accountId === accountId);
  if (!a) {
    a = {
      workspaceId, accountId, displayName: accountId,
      products: { classic: true, salesNavigator: false, recruiter: false },
      connected: true, health: "healthy", riskSignals: [], killSwitch: false,
      recentResults: [], createdAt: nowIso(), updatedAt: nowIso(),
    };
    all.push(a);
  }
  return a;
}

function stepDown(a: LiAccountState, to: AccountHealthState, reason: string): void {
  const order: AccountHealthState[] = ["healthy", "watch", "elevated", "cooldown", "paused", "disconnected"];
  if (order.indexOf(to) > order.indexOf(a.health)) {
    a.health = to;
    a.healthReason = reason;
    if (to === "cooldown") {
      a.cooldownUntil = new Date(Date.now() + COOLDOWN_MINUTES * 60_000).toISOString();
    }
  }
}

/** Failure-rate driven state machine over the rolling window. */
function reevaluate(a: LiAccountState): void {
  // Cooldown expiry: step back to elevated so recovery is gradual.
  if (a.health === "cooldown" && a.cooldownUntil && a.cooldownUntil <= nowIso()) {
    a.health = "elevated";
    a.healthReason = "Cooling down finished; velocity reduced while recovering";
    a.cooldownUntil = undefined;
  }
  if (a.health === "paused" || a.health === "disconnected" || a.health === "cooldown") return;

  const recent = a.recentResults.slice(-20);
  if (recent.length < 5) {
    if (a.health !== "healthy") return; // manual/elevated states recover via results below
    return;
  }
  const failures = recent.filter((r) => !r.ok).length;
  const rate = failures / recent.length;
  const lastFive = a.recentResults.slice(-5);
  const consecutiveFailures = lastFive.length === 5 && lastFive.every((r) => !r.ok);

  if (consecutiveFailures || rate >= 0.5) {
    stepDown(a, "cooldown", "Repeated provider action errors were detected");
    pushSignal(a, "failure_spike", `${failures}/${recent.length} recent actions failed`);
  } else if (rate >= 0.3) {
    if (a.health === "healthy" || a.health === "watch") {
      a.health = "elevated";
      a.healthReason = "Action failure rate is elevated; velocity reduced";
    }
  } else if (rate >= 0.15) {
    if (a.health === "healthy") {
      a.health = "watch";
      a.healthReason = "A few recent actions failed; capacity slightly reduced";
    }
  } else if (rate === 0 && (a.health === "watch" || a.health === "elevated")) {
    a.health = "healthy";
    a.healthReason = undefined;
  }
}

/** The effective capacity multiplier, folding in kill switch + connectivity. */
export function capacityFactor(a: LiAccountState | null): number {
  if (!a) return 1; // account not yet tracked: policy alone governs
  if (a.killSwitch || !a.connected) return 0;
  return HEALTH_CAPACITY_FACTOR[a.health];
}

/** Human answer to "can this account execute right now, and if not why". */
export function executionBlock(a: LiAccountState | null): string | null {
  if (!a) return null;
  if (a.killSwitch) return "All LinkedIn automation is paused for this account (kill switch)";
  if (!a.connected) return "The LinkedIn account is disconnected";
  if (a.health === "cooldown") return a.healthReason ?? "The account is cooling down";
  if (a.health === "paused") return a.healthReason ?? "Automation is paused for account review";
  if (a.health === "disconnected") return "The LinkedIn account is disconnected";
  return null;
}

/** The one switch: pause or resume every LinkedIn automation on the account. */
export async function setKillSwitch(
  workspaceId: string,
  accountId: string,
  paused: boolean,
  by?: string,
): Promise<LiAccountState> {
  return withEngineLock(async () => {
    const a = await ensureAccountInLock(workspaceId, accountId);
    a.killSwitch = paused;
    if (paused) {
      pushSignal(a, "kill_switch", `Paused by ${by ?? "user"}`);
    } else {
      pushSignal(a, "kill_switch", `Resumed by ${by ?? "user"}`);
      if (a.health === "paused") { a.health = "watch"; a.healthReason = "Resumed after manual pause"; }
    }
    a.updatedAt = nowIso();
    accounts.save();
    return a;
  });
}

/** Manual health override (Pause Automation / Resume from the Accounts page). */
export async function setHealth(
  workspaceId: string,
  accountId: string,
  health: AccountHealthState,
  reason?: string,
): Promise<LiAccountState> {
  return withEngineLock(async () => {
    const a = await ensureAccountInLock(workspaceId, accountId);
    a.health = health;
    a.healthReason = reason;
    if (health !== "cooldown") a.cooldownUntil = undefined;
    a.updatedAt = nowIso();
    accounts.save();
    return a;
  });
}

export function recentSignals(a: LiAccountState, limit = 10): RiskSignal[] {
  return a.riskSignals.slice(-limit).reverse();
}
