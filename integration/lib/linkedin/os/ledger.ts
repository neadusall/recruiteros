/**
 * RecruitersOS · LinkedIn OS
 * The global action ledger: every LinkedIn action in RecruitersOS gets exactly
 * one record here, whatever surface created it. Utilization, reservations,
 * audit trails and the live queue are all views over this one collection, so
 * no feature can hold a private opinion about how much capacity is left.
 */

import { nowIso } from "../../core/ids";
import { ledger } from "./store";
import {
  capCategoryOf, HOLDING_STATUSES, USED_STATUSES, WAITING_STATUSES,
} from "./types";
import type {
  AccountPolicy, CategoryUtilization, LiActionRecord, LiActionStatus,
  LiCapCategory,
} from "./types";

/** YYYY-MM-DD in a timezone (the policy day capacity is booked against). */
export function policyDay(tz: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC" }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(at);
  }
}

export async function listLedger(workspaceId: string): Promise<LiActionRecord[]> {
  const all = await ledger.all();
  return all.filter((r) => r.workspaceId === workspaceId);
}

export async function getAction(workspaceId: string, id: string): Promise<LiActionRecord | null> {
  const all = await ledger.all();
  return all.find((r) => r.workspaceId === workspaceId && r.id === id) ?? null;
}

export async function findByIdempotencyKey(
  workspaceId: string,
  idempotencyKey: string,
): Promise<LiActionRecord | null> {
  const all = await ledger.all();
  return all.find((r) => r.workspaceId === workspaceId && r.idempotencyKey === idempotencyKey) ?? null;
}

/** Rows booked on an account for one policy day. */
export function rowsForDay(all: LiActionRecord[], accountId: string, day: string): LiActionRecord[] {
  return all.filter((r) => r.accountId === accountId && r.capacityDay === day);
}

export interface CategoryCounts {
  used: number;
  reserved: number;
  waiting: number;
}

/** used / reserved / waiting for one account + category + day. */
export function categoryCounts(
  all: LiActionRecord[],
  accountId: string,
  category: LiCapCategory,
  day: string,
): CategoryCounts {
  let used = 0, reserved = 0, waiting = 0;
  for (const r of all) {
    if (r.accountId !== accountId) continue;
    if (capCategoryOf(r.actionType) !== category) continue;
    if (r.capacityDay === day) {
      if (USED_STATUSES.includes(r.status)) used++;
      else if (HOLDING_STATUSES.includes(r.status)) reserved++;
    }
    // Waiting rows have no capacityDay yet; they queue for the NEXT free slot.
    if (!r.capacityDay && WAITING_STATUSES.includes(r.status)) waiting++;
  }
  return { used, reserved, waiting };
}

/** Full per-category utilization snapshot against a policy. */
export function utilizationFor(
  all: LiActionRecord[],
  policy: AccountPolicy,
  accountId: string,
  day: string,
  healthFactor: number,
): CategoryUtilization[] {
  const cats: LiCapCategory[] = [
    "connections", "messages", "voice_notes", "inmails", "profile_views", "interactions",
  ];
  return cats.map((category) => {
    const c = categoryCounts(all, accountId, category, day);
    const p = policy.categories[category];
    return {
      category,
      used: c.used,
      reserved: c.reserved,
      waiting: c.waiting,
      dailyTarget: p.dailyTarget,
      hardCeiling: p.hardCeiling,
      effectiveTarget: Math.floor(p.dailyTarget * healthFactor),
    };
  });
}

/** Weekly (7 policy days) usage for the rolling targets view. */
export function weeklyUsed(
  all: LiActionRecord[],
  accountId: string,
  category: LiCapCategory,
  tz: string,
): number {
  const days = new Set<string>();
  for (let i = 0; i < 7; i++) {
    days.add(policyDay(tz, new Date(Date.now() - i * 86_400_000)));
  }
  let n = 0;
  for (const r of all) {
    if (r.accountId !== accountId) continue;
    if (capCategoryOf(r.actionType) !== category) continue;
    if (r.capacityDay && days.has(r.capacityDay) && USED_STATUSES.includes(r.status)) n++;
  }
  return n;
}

/** Mutate a ledger row's status with the matching timestamp; caller saves. */
export function setStatus(r: LiActionRecord, status: LiActionStatus, reason?: string): void {
  r.status = status;
  r.statusReason = reason;
  const at = nowIso();
  if (status === "reserved") r.reservedAt = at;
  if (status === "submitted") r.submittedAt = at;
  if (status === "success" || status === "failed") r.completedAt = at;
  if (status === "cancelled") { r.cancelledAt = at; r.capacityDay = undefined; }
  if (status === "capacity_pending" || status === "suppressed" || status === "paused") {
    // These hold no capacity; make sure no day booking lingers.
    r.capacityDay = undefined;
  }
}

/**
 * Release a held reservation (action failed pre-provider, or was cancelled by
 * a reply). Clearing capacityDay is what actually frees the slot, because the
 * counts above only see rows booked onto a day.
 */
export function releaseReservation(r: LiActionRecord, status: LiActionStatus, reason: string): void {
  setStatus(r, status, reason);
  r.capacityDay = undefined;
}

export function saveLedger(): void {
  ledger.save();
}
