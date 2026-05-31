/**
 * RecruiterOS · Owner (OWNER ONLY)
 *
 * The owner layer: who counts as the owner, the fully-joined account view
 * (identity + cost + revenue + infra + data counts), and the cross-module hard
 * reset. Everything here sits behind requireOwner() — it is the single-operator
 * back office, not part of the multi-tenant app.
 */

import { nowIso } from "../core/ids";
import { devCore } from "../core/repository";
import {
  adminListAccounts,
  adminAccountDetail,
  adminSetSuspended,
  adminRevokeSessions,
  adminResetPasswordToTemp,
  adminDeleteWorkspace,
  type AdminAccount,
} from "../auth";
import {
  workspaceCost,
  workspaceCostByCategory,
  workspaceEvents,
  purgeWorkspaceUsage,
  type SpendWindow,
} from "../billing/ledger";
import { workspaceAccountCounts, purgeWorkspaceAccounts } from "../accounts";
import { listAssets, deleteAsset } from "../content";
import { getAccountMeta, setAccountMeta, deleteAccountMeta, type AccountMeta } from "./store";

/* ---------------- owner identity ---------------- */

/**
 * The owner allow-list. Set OWNER_EMAIL (comma-separated for >1) in the
 * environment. With nothing set we fall back to the build owner so the console
 * is reachable on first boot, then you lock it down via env.
 */
const FALLBACK_OWNER = "neadusall@gmail.com";

export function ownerEmails(): string[] {
  const raw = process.env.OWNER_EMAIL || FALLBACK_OWNER;
  return raw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}

export function isOwnerEmail(email?: string | null): boolean {
  if (!email) return false;
  return ownerEmails().includes(email.trim().toLowerCase());
}

/* ---------------- joined account view ---------------- */

export interface FullAccount extends AdminAccount {
  meta: AccountMeta;
  /** Cost incurred in the selected window. */
  costUsd: number;
  costByCategory: Record<string, number>;
  /** Revenue = the monthly price on file. */
  monthlyPriceUsd: number;
  /** Revenue minus cost (window cost vs monthly price; see note in console). */
  grossProfitUsd: number;
  grossMarginPct: number;
  /** Platform usage counts for the detail panel. */
  counts: {
    prospects: number;
    campaigns: number;
    linkedinAccounts: number;
    domains: number;
    apiKeys: number;
    contentAssets: number;
  };
}

function countsFor(workspaceId: string): FullAccount["counts"] {
  const core = devCore();
  const prospects = [...core.prospects.values()].filter((p) => p.workspaceId === workspaceId).length;
  const campaigns = [...core.campaigns.values()].filter((c) => c.workspaceId === workspaceId).length;
  const infra = workspaceAccountCounts(workspaceId);
  const contentAssets = listAssets(workspaceId).length;
  return {
    prospects, campaigns,
    linkedinAccounts: infra.linkedin, domains: infra.domains, apiKeys: infra.apiKeys,
    contentAssets,
  };
}

function joinAccount(acc: AdminAccount, window: SpendWindow): FullAccount {
  const meta = getAccountMeta(acc.workspaceId);
  const costUsd = workspaceCost(acc.workspaceId, window);
  const price = meta.monthlyPriceUsd || 0;
  const grossProfitUsd = round(price - costUsd);
  const grossMarginPct = price > 0 ? round((grossProfitUsd / price) * 100, 1) : 0;
  return {
    ...acc,
    meta,
    costUsd,
    costByCategory: workspaceCostByCategory(acc.workspaceId, window),
    monthlyPriceUsd: price,
    grossProfitUsd,
    grossMarginPct,
    counts: countsFor(acc.workspaceId),
  };
}

/** Every account, fully joined, sorted by cost desc. */
export function listFullAccounts(window: SpendWindow = "30d"): FullAccount[] {
  return adminListAccounts()
    .map((a) => joinAccount(a, window))
    .sort((a, b) => b.costUsd - a.costUsd);
}

/** One account, fully joined, with its recent cost events. */
export function fullAccountDetail(workspaceId: string, window: SpendWindow = "30d") {
  const acc = adminAccountDetail(workspaceId);
  if (!acc) return null;
  return { account: joinAccount(acc, window), recentUsage: workspaceEvents(workspaceId, 50) };
}

/** Owner-set price / tier / notes for an account. */
export function updateAccountMeta(
  workspaceId: string,
  patch: Partial<Pick<AccountMeta, "monthlyPriceUsd" | "tier" | "notes">>,
): AccountMeta {
  return setAccountMeta(workspaceId, patch);
}

export { adminSetSuspended as setAccountSuspended, adminRevokeSessions as revokeAccountSessions };
export { adminResetPasswordToTemp };

/* ---------------- hard reset ---------------- */

export interface HardResetOptions {
  /** Wipe prospects, campaigns, activity, content, sending infra, usage. */
  purgeData?: boolean;
  /** Revoke every session (force re-login). Default true. */
  revokeSessions?: boolean;
  /** Reset each member's password to a fresh temp value. Default false. */
  resetPasswords?: boolean;
  /** Suspend (lock) the account after reset. Default false. */
  suspend?: boolean;
  /** Nuke the account entirely (identity + all data). Overrides the rest. */
  deleteAccount?: boolean;
}

export interface HardResetResult {
  workspaceId: string;
  deleted: boolean;
  purged?: {
    prospects: number; campaigns: number; activity: number;
    contentAssets: number; linkedin: number; domains: number; apiKeys: number; usageEvents: number;
  };
  sessionsRevoked?: number;
  passwordsReset?: Array<{ userId: string; email: string; tempPassword: string }>;
  suspended?: boolean;
  at: string;
}

/** Purge every piece of a workspace's DATA across modules (keeps identity). */
function purgeWorkspaceData(workspaceId: string): NonNullable<HardResetResult["purged"]> {
  const core = devCore();

  const prospectIds = [...core.prospects.values()].filter((p) => p.workspaceId === workspaceId).map((p) => p.id);
  let prospects = 0;
  for (const id of prospectIds) { core.prospects.delete(id); prospects++; }

  const campaignIds = [...core.campaigns.values()].filter((c) => c.workspaceId === workspaceId).map((c) => c.id);
  let campaigns = 0;
  for (const id of campaignIds) { core.campaigns.delete(id); campaigns++; }

  const beforeActivity = core.activity.length;
  core.activity = core.activity.filter((e) => e.workspaceId !== workspaceId);
  const activity = beforeActivity - core.activity.length;

  let contentAssets = 0;
  for (const a of [...listAssets(workspaceId)]) { if (deleteAsset(a.id)) contentAssets++; }

  const infra = purgeWorkspaceAccounts(workspaceId);
  const usageEvents = purgeWorkspaceUsage(workspaceId);

  return { prospects, campaigns, activity, contentAssets, ...infra, usageEvents };
}

/**
 * The "hard reset" the owner asked for. Composable: by default it just revokes
 * sessions; flags escalate to a full data purge, password resets, suspend, or
 * outright delete. Returns a precise summary of everything it touched.
 */
export function hardReset(workspaceId: string, opts: HardResetOptions = {}): HardResetResult | null {
  const detail = adminAccountDetail(workspaceId);
  if (!detail) return null;
  const at = nowIso();

  if (opts.deleteAccount) {
    purgeWorkspaceData(workspaceId);
    deleteAccountMeta(workspaceId);
    adminDeleteWorkspace(workspaceId);
    return { workspaceId, deleted: true, at };
  }

  const out: HardResetResult = { workspaceId, deleted: false, at };

  if (opts.purgeData) out.purged = purgeWorkspaceData(workspaceId);

  if (opts.resetPasswords) {
    out.passwordsReset = [];
    for (const m of detail.members) {
      const temp = adminResetPasswordToTemp(m.id);
      if (temp) out.passwordsReset.push({ userId: m.id, email: m.email, tempPassword: temp });
    }
  }

  // Revoke sessions by default (password reset already revoked the members'; this
  // sweeps any stragglers and is the minimum a "reset" should do).
  if (opts.revokeSessions !== false) out.sessionsRevoked = adminRevokeSessions(workspaceId);

  if (opts.suspend) { adminSetSuspended(workspaceId, true); out.suspended = true; }

  setAccountMeta(workspaceId, { lastResetAt: at });
  return out;
}

function round(n: number, dp = 2): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}
