/**
 * RecruitersOS · Owner (OWNER ONLY)
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
import { capabilitiesFor } from "../auth/permissions";
import type { Role } from "../auth/types";
import {
  workspaceCost,
  workspaceCostByCategory,
  workspaceEvents,
  purgeWorkspaceUsage,
  spendRollup,
  type SpendWindow,
} from "../billing/ledger";
import { workspaceAccountCounts, purgeWorkspaceAccounts } from "../accounts";
import { listAssets, deleteAsset } from "../content";
import { getAccountMeta, setAccountMeta, deleteAccountMeta, type AccountMeta } from "./store";

/* ---------------- owner identity ---------------- */
// Lives in ./emails (a leaf) so auth/credentials can use it without an import
// cycle; re-exported here so existing `from "../owner"` importers are untouched.
export { ownerEmails, isOwnerEmail } from "./emails";

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
  /** Owner granted this account at-cost (no-margin) access. */
  atCost: boolean;
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
  const atCost = meta.atCost === true;
  const price = meta.monthlyPriceUsd || 0;
  // At-cost accounts pay exactly what they cost, so they net zero profit/margin
  // (never shown as a loss). Everyone else: revenue = monthly price on file.
  const grossProfitUsd = atCost ? 0 : round(price - costUsd);
  const grossMarginPct = atCost ? 0 : price > 0 ? round((grossProfitUsd / price) * 100, 1) : 0;
  return {
    ...acc,
    meta,
    costUsd,
    costByCategory: workspaceCostByCategory(acc.workspaceId, window),
    monthlyPriceUsd: price,
    grossProfitUsd,
    grossMarginPct,
    atCost,
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

/* ---------------- people / users view ---------------- */

/**
 * The "who is on the platform and what can they do" view. Everything the owner
 * asked to track in one shape: how many accounts / admins / recruiters exist,
 * the LLM vs enrichment spend split, a flat roster of every user (with the
 * capabilities their role grants — i.e. the functions they can perform), and a
 * per-account rollup of headcount, activity, and cost.
 */
export interface PeopleUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** What this role is allowed to do — their functions on the platform. */
  capabilities: string[];
  workspaceId: string;
  workspace: string;
  plan: string;
  suspended: boolean;
  emailVerified: boolean;
  hasPassword: boolean;
  createdAt: string;
}

export interface PeopleAccount {
  workspaceId: string;
  name: string;
  domain?: string;
  plan: string;
  suspended: boolean;
  members: number;
  owners: number;
  admins: number;
  recruiters: number;
  activeSessions: number;
  lastActiveAt?: string;
  /** Activity events this workspace logged within the window. */
  activityEvents: number;
  costUsd: number;
  llmUsd: number;
  enrichmentUsd: number;
}

export interface PeopleOverview {
  window: SpendWindow;
  totals: {
    accounts: number;
    activeAccounts: number;
    suspendedAccounts: number;
    users: number;
    owners: number;
    admins: number;
    recruiters: number;
    activeSessions: number;
  };
  spend: {
    llmUsd: number;
    enrichmentUsd: number;
    sendingUsd: number;
    signalsUsd: number;
    messagingUsd: number;
    linkedinUsd: number;
    infraUsd: number;
    otherUsd: number;
    totalUsd: number;
  };
  roles: Record<Role, number>;
  users: PeopleUser[];
  accounts: PeopleAccount[];
}

function windowStartMs(window: SpendWindow): number {
  if (window === "all") return 0;
  const now = Date.now();
  if (window === "today") return now - 24 * 3600 * 1000;
  if (window === "7d") return now - 7 * 24 * 3600 * 1000;
  return now - 30 * 24 * 3600 * 1000;
}

export function peopleOverview(window: SpendWindow = "30d"): PeopleOverview {
  const accounts = adminListAccounts();
  const roll = spendRollup(window);
  const since = windowStartMs(window);

  // Activity events per workspace within the window.
  const core = devCore();
  const activityByWs = new Map<string, number>();
  for (const e of core.activity) {
    if (Date.parse(e.at) < since) continue;
    activityByWs.set(e.workspaceId, (activityByWs.get(e.workspaceId) ?? 0) + 1);
  }

  const roles: Record<Role, number> = { owner: 0, admin: 0, member: 0 };
  const users: PeopleUser[] = [];
  const peopleAccounts: PeopleAccount[] = [];

  for (const acc of accounts) {
    let owners = 0, admins = 0, recruiters = 0;
    for (const m of acc.members) {
      if (m.role === "owner") owners++;
      else if (m.role === "admin") admins++;
      else recruiters++;
      roles[m.role] = (roles[m.role] ?? 0) + 1;
      users.push({
        id: m.id,
        name: m.name,
        email: m.email,
        role: m.role,
        capabilities: capabilitiesFor(m.role),
        workspaceId: acc.workspaceId,
        workspace: acc.name,
        plan: acc.plan,
        suspended: acc.suspended,
        emailVerified: m.emailVerified,
        hasPassword: m.hasPassword,
        createdAt: m.createdAt,
      });
    }
    const byCat = workspaceCostByCategory(acc.workspaceId, window);
    peopleAccounts.push({
      workspaceId: acc.workspaceId,
      name: acc.name,
      domain: acc.domain,
      plan: acc.plan,
      suspended: acc.suspended,
      members: acc.members.length,
      owners, admins, recruiters,
      activeSessions: acc.activeSessions,
      lastActiveAt: acc.lastActiveAt,
      activityEvents: activityByWs.get(acc.workspaceId) ?? 0,
      costUsd: workspaceCost(acc.workspaceId, window),
      llmUsd: byCat["ai"] ?? 0,
      enrichmentUsd: byCat["enrichment"] ?? 0,
    });
  }

  // Roster: most recently created first.
  users.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  // Accounts: biggest teams first.
  peopleAccounts.sort((a, b) => b.members - a.members);

  const cat = roll.byCategory;
  return {
    window,
    totals: {
      accounts: accounts.length,
      activeAccounts: accounts.filter((a) => !a.suspended).length,
      suspendedAccounts: accounts.filter((a) => a.suspended).length,
      users: users.length,
      owners: roles.owner,
      admins: roles.admin,
      recruiters: roles.member,
      activeSessions: accounts.reduce((s, a) => s + a.activeSessions, 0),
    },
    spend: {
      llmUsd: cat["ai"] ?? 0,
      enrichmentUsd: cat["enrichment"] ?? 0,
      sendingUsd: cat["sending"] ?? 0,
      signalsUsd: cat["signals"] ?? 0,
      messagingUsd: cat["messaging"] ?? 0,
      linkedinUsd: cat["linkedin"] ?? 0,
      infraUsd: cat["infra"] ?? 0,
      otherUsd: cat["other"] ?? 0,
      totalUsd: roll.totalCostUsd,
    },
    roles,
    users,
    accounts: peopleAccounts,
  };
}

/** Owner-set price / tier / notes for an account. */
export function updateAccountMeta(
  workspaceId: string,
  patch: Partial<Pick<AccountMeta, "monthlyPriceUsd" | "tier" | "notes" | "atCost">>,
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
