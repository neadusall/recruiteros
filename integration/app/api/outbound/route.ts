/**
 * RecruitersOS · API · /api/outbound
 *
 * One dispatch surface for the Outbound Performance system.
 *
 * GET ?view=
 *   team | insights | goals | alerts | audit | methodology   -> team:manage
 *   user&user=<id>                                           -> team:manage, or self
 *   me | checklist | notifications                           -> any session (self-scoped)
 *
 * POST { action }
 *   goals_put | assign_role | set_phone | insights_refresh | run_tick |
 *   alert_read (self)      | check (self) | notify_prefs (self) | mark_read (self)
 *
 * RBAC: members only ever see their own numbers; team-wide reads and all
 * configuration writes sit behind team:manage. Config writes audit-log.
 */

import { ok, fail, body, requireSession, requireCapability } from "../../../lib/api";
import {
  teamOverview, userProfile, adminInsights, userAssessment,
  getGoalsConfig, putGoalsConfig, emailPoolSplit, listAlerts, markAlertRead, listAudit, appendAudit,
  buildChecklist, setStepTick, listNotifications, markNotificationRead,
  getPrefs, setPrefs, SCORE_METHODOLOGY, SCORE_WEIGHTS,
  DEFAULT_CHANNELS, DEFAULT_TRIGGERS, GOAL_ROLES, localDay, workspaceTz,
} from "../../../lib/outbound";
import type { GoalsPatch, GoalRole, NotifyPrefs } from "../../../lib/outbound";
import { userSpendRollup, userSpend } from "../../../lib/billing/ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const view = url.searchParams.get("view") || "me";

  // Self-scoped views: any signed-in user.
  if (view === "me" || view === "checklist" || view === "notifications") {
    const g = requireSession(req);
    if ("response" in g) return g.response;
    const ws = g.ctx.workspace.id;
    const uid = g.ctx.user.id;
    try {
      if (view === "checklist") return ok(await buildChecklist(ws, uid, g.ctx.role));
      if (view === "notifications") {
        return ok({
          notifications: await listNotifications(ws, uid),
          prefs: await getPrefs(ws, uid),
          alerts: await listAlerts(ws, { userId: uid, limit: 40 }),
        });
      }
      const [profile, assessment, checklist] = await Promise.all([
        userProfile(ws, uid, Number(url.searchParams.get("since")) || 30),
        userAssessment(ws, uid, { authRole: g.ctx.role }).catch(() => null),
        buildChecklist(ws, uid, g.ctx.role),
      ]);
      // The recruiter's own paid-enrichment spend (JD Sourcing phone boost), 30 days.
      const premiumSpend = userSpend(ws, g.ctx.user.email || "", "30d", "premium_phone_boost");
      return ok({ profile, assessment, checklist, premiumSpend });
    } catch (e) {
      return fail(e instanceof Error ? e.message : "outbound_me_failed", 500);
    }
  }

  // Per-user view: admins, or the user themselves.
  if (view === "user") {
    const target = url.searchParams.get("user") || "";
    const g = requireSession(req);
    if ("response" in g) return g.response;
    const isSelf = target === g.ctx.user.id;
    if (!isSelf && !g.ctx.capabilities.includes("team:manage")) return fail("forbidden", 403, { needs: "team:manage" });
    try {
      const since = Number(url.searchParams.get("since")) || 30;
      const [profile, assessment] = await Promise.all([
        userProfile(g.ctx.workspace.id, target, since),
        userAssessment(g.ctx.workspace.id, target).catch(() => null),
      ]);
      return ok({ profile, assessment });
    } catch (e) {
      return fail(e instanceof Error ? e.message : "outbound_user_failed", 500);
    }
  }

  // Everything else is the admin surface.
  const g = requireCapability(req, "team:manage");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  try {
    switch (view) {
      case "team":
        // premiumSpend: paid-enrichment ledger events (JD Sourcing phone boost),
        // grouped by the recruiter who triggered them, last 30 days.
        return ok({ ...(await teamOverview(ws)), premiumSpend: userSpendRollup(ws, "30d", "premium_phone_boost") });
      case "insights":
        return ok(await adminInsights(ws));
      case "goals": {
        const { notifyBrand } = await import("../../../lib/outbound/brand");
        const cfg = await getGoalsConfig(ws);
        return ok({
          config: cfg,
          defaults: { channels: DEFAULT_CHANNELS, triggers: DEFAULT_TRIGGERS },
          roles: GOAL_ROLES,
          // The daily email pool resolved against the live roster (null = off),
          // so the UI can show "3,000 ÷ 5 recruiters = 600 each".
          pool: await emailPoolSplit(ws),
          // The company identity automated updates go out under (house brand,
          // or this workspace's white-label brand + domain).
          brand: await notifyBrand(ws),
        });
      }
      case "alerts": {
        const day = url.searchParams.get("day") || undefined;
        return ok({ alerts: await listAlerts(ws, { day, limit: 200 }), today: localDay(await workspaceTz(ws)) });
      }
      case "audit":
        return ok({ audit: await listAudit(ws) });
      case "methodology":
        return ok({ methodology: SCORE_METHODOLOGY, weights: SCORE_WEIGHTS });
      default:
        return fail("unknown_view", 400);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : "outbound_failed", 500);
  }
}

interface PostBody {
  action?: string;
  level?: "global" | "role" | "user";
  role?: GoalRole;
  userId?: string;
  patch?: GoalsPatch;
  goalRole?: GoalRole;
  phone?: string;
  stepId?: string;
  done?: boolean;
  prefs?: Partial<NotifyPrefs>;
  id?: string;
  scope?: "admin" | "user";
}

export async function POST(req: Request): Promise<Response> {
  const p = await body<PostBody>(req);
  if (!p?.action) return fail("missing_action", 400);

  /* ------------------------- self-service actions ------------------------ */
  if (p.action === "check" || p.action === "notify_prefs" || p.action === "mark_read" || p.action === "alert_read") {
    const g = requireSession(req);
    if ("response" in g) return g.response;
    const ws = g.ctx.workspace.id;
    const uid = g.ctx.user.id;
    try {
      if (p.action === "check") {
        if (!p.stepId) return fail("missing_step", 400);
        const day = localDay(await workspaceTz(ws));
        await setStepTick(ws, uid, day, p.stepId, !!p.done);
        return ok(await buildChecklist(ws, uid, g.ctx.role));
      }
      if (p.action === "notify_prefs") {
        return ok({ prefs: await setPrefs(ws, uid, p.prefs ?? {}) });
      }
      if (p.action === "mark_read") {
        if (p.id) await markNotificationRead(ws, uid, p.id);
        return ok({ done: true });
      }
      if (p.id) await markAlertRead(ws, p.id, uid);
      return ok({ done: true });
    } catch (e) {
      return fail(e instanceof Error ? e.message : "outbound_action_failed", 500);
    }
  }

  /* ---------------------------- admin actions ---------------------------- */
  const g = requireCapability(req, "team:manage");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const admin = { adminId: g.ctx.user.id, adminEmail: g.ctx.user.email };

  try {
    switch (p.action) {
      case "goals_put": {
        if (!p.level || !p.patch) return fail("missing_level_or_patch", 400);
        const cfg = await getGoalsConfig(ws);
        let previous: unknown;
        let label = "";
        if (p.level === "global") {
          previous = cfg.global;
          cfg.global = { ...cfg.global, ...p.patch, channels: { ...(cfg.global.channels ?? {}), ...(p.patch.channels ?? {}) }, triggers: { ...(cfg.global.triggers ?? {}), ...(p.patch.triggers ?? {}) } };
          label = "goals: global";
        } else if (p.level === "role") {
          if (!p.role) return fail("missing_role", 400);
          previous = cfg.byRole[p.role];
          const cur = cfg.byRole[p.role] ?? {};
          cfg.byRole[p.role] = { ...cur, ...p.patch, channels: { ...(cur.channels ?? {}), ...(p.patch.channels ?? {}) }, triggers: { ...(cur.triggers ?? {}), ...(p.patch.triggers ?? {}) } };
          label = `goals: role ${p.role}`;
        } else {
          if (!p.userId) return fail("missing_user", 400);
          previous = cfg.byUser[p.userId];
          const cur = cfg.byUser[p.userId] ?? {};
          cfg.byUser[p.userId] = { ...cur, ...p.patch, channels: { ...(cur.channels ?? {}), ...(p.patch.channels ?? {}) }, triggers: { ...(cur.triggers ?? {}), ...(p.patch.triggers ?? {}) } };
          label = `goals: user ${p.userId}`;
        }
        await putGoalsConfig(ws, cfg);
        await appendAudit(ws, { ...admin, change: label, previous: previous ?? null, next: p.patch });
        return ok({ config: cfg });
      }
      case "assign_role": {
        if (!p.userId || !p.goalRole || !GOAL_ROLES.includes(p.goalRole)) return fail("bad_role", 400);
        const { listMembers } = await import("../../../lib/auth/team");
        if (!listMembers(ws).some((m) => m.userId === p.userId)) return fail("not_a_member", 404);
        const cfg = await getGoalsConfig(ws);
        const previous = cfg.userRoles[p.userId] ?? null;
        cfg.userRoles[p.userId] = p.goalRole;
        await putGoalsConfig(ws, cfg);
        await appendAudit(ws, { ...admin, change: `goal role for user ${p.userId}`, previous, next: p.goalRole });
        return ok({ config: cfg });
      }
      case "set_phone": {
        if (!p.userId) return fail("missing_user", 400);
        const { listMembers } = await import("../../../lib/auth/team");
        if (!listMembers(ws).some((m) => m.userId === p.userId)) return fail("not_a_member", 404);
        const cfg = await getGoalsConfig(ws);
        const previous = cfg.userPhones[p.userId] ?? null;
        if (p.phone) cfg.userPhones[p.userId] = p.phone; else delete cfg.userPhones[p.userId];
        await putGoalsConfig(ws, cfg);
        await appendAudit(ws, { ...admin, change: `alert phone for user ${p.userId}`, previous, next: p.phone ?? null });
        return ok({ config: cfg });
      }
      case "insights_refresh": {
        if (p.scope === "user" && p.userId) return ok(await userAssessment(ws, p.userId, { refresh: true }));
        return ok(await adminInsights(ws, { refresh: true }));
      }
      case "run_tick": {
        const { runOutboundTick } = await import("../../../lib/outbound/worker");
        await runOutboundTick();
        return ok({ done: true });
      }
      default:
        return fail("unknown_action", 400);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : "outbound_admin_failed", 500);
  }
}
