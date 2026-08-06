/**
 * RecruitersOS · Tool readiness
 *
 * The safeguard behind "why did nothing happen?".
 *
 * Every tool that cannot work without a connected account declares that
 * dependency HERE, in one place, and both the screen and the API refuse to
 * pretend otherwise. Before this, a tool whose integration was never connected
 * still opened, still ran, and still came back with nothing — indistinguishable
 * from "there were no results". The person then re-ran it, changed their
 * filters, and re-ran it again: the loop this module exists to end.
 *
 * Three states, deliberately:
 *   ready      every dependency is green (connected AND tested)
 *   unverified keys are saved but the connection was never proven; the tool
 *              runs, and the screen says so, because an untested key is the
 *              other way work dies mid-run
 *   blocked    a dependency has no key at all; the tool cannot work, so it says
 *              that up front instead of running
 *
 * The same registry serves three surfaces, which is the point — one truth, no
 * drift: the screen (a strip above the tool, before any work starts), the API
 * (a 409 that names the missing connection instead of an empty 200), and the
 * owner's monitoring (the audit below, read every hour by ros-sentinel).
 */

import { NextResponse } from "next/server";
import { listIntegrations, type ConnStatus, type IntegrationId } from "../connected";
import { adminListAccounts } from "../auth";

export type ToolKey =
  | "inmarket" | "builder" | "jdsourcing" | "linkedin" | "automation"
  | "linkedinposter" | "vetting" | "calls" | "bdphone" | "voicedrops";

export type ToolState = "ready" | "unverified" | "blocked";

interface ToolSpec {
  /** What the tool is called on screen (must match the nav, not the code). */
  label: string;
  /** Every one of these must be connected or the tool cannot work. */
  needs: IntegrationId[];
  /** At least one of these must be connected (interchangeable providers). */
  anyOf?: IntegrationId[];
  /** Improves results but never blocks — reported as "working with less". */
  helps?: IntegrationId[];
  /** What actually stops working, in the recruiter's words. Completes the
   *  sentence "Until it is connected, ...". */
  impact: string;
}

/**
 * The registry. Keys are the app's own route hashes so the screen can look a
 * tool up with no second mapping to keep in sync.
 *
 * Only hard dependencies belong in `needs`. A tool that degrades (fewer emails
 * found, no phone numbers) but still returns useful work goes in `helps` — a
 * false block is worse than no block, because people learn to ignore it.
 */
const TOOLS: Record<ToolKey, ToolSpec> = {
  inmarket: {
    label: "Hire Signals",
    needs: ["rapidapi"],
    helps: ["fresh_linkedin", "tomba"],
    impact: "no new job postings come in, so the list can only ever show what was already pulled",
  },
  builder: {
    label: "In-Market Leads",
    needs: ["rapidapi"],
    helps: ["fresh_linkedin", "tomba"],
    impact: "no new hiring companies are found, so a build comes back empty",
  },
  jdsourcing: {
    label: "JD Sourcing",
    needs: ["jd_sourcing", "ai"],
    helps: ["fresh_linkedin"],
    impact: "a search cannot look anyone up, so every run finishes with no candidates",
  },
  linkedin: {
    label: "LinkedIn",
    needs: ["unipile"],
    impact: "invites and messages are queued but never actually sent",
  },
  automation: {
    label: "LinkedIn Automation",
    needs: ["unipile"],
    impact: "nothing runs on LinkedIn: invites, messages and profile views all stop at the queue",
  },
  linkedinposter: {
    label: "LinkedIn Poster",
    needs: ["unipile", "ai"],
    impact: "approved posts cannot be published",
  },
  // OS Text is deliberately ABSENT. Its ability to send lives in the texting
  // engine (its own service, its own credentials, its own watchdog), not in the
  // integration tiles: on 2026-08-06 the first live audit called OS Text broken
  // for two accounts that were texting perfectly well, because their "OS Text
  // (SMS)" tile had never been filled in. A gate that cries wolf on working
  // software teaches people to ignore every strip on the screen, so this tool
  // stays out of the registry until the check can ask the engine itself.
  vetting: {
    label: "AI Vetting",
    needs: ["telnyx", "ai"],
    impact: "candidates are never called and no interview is scored",
  },
  calls: {
    label: "Calls",
    needs: ["telnyx"],
    impact: "no call can be placed or received",
  },
  bdphone: {
    label: "BD Phone",
    needs: ["telnyx"],
    impact: "the dialer cannot connect, so calls fail the moment you press call",
  },
  voicedrops: {
    label: "Voice Drops",
    needs: ["telnyx"],
    anyOf: ["elevenlabs", "cartesia", "hume"],
    impact: "a drop has no voice to speak with and no line to deliver on",
  },
};

export interface ToolDep {
  id: IntegrationId;
  label: string;
  status: ConnStatus;
}

export interface ToolReadiness {
  tool: ToolKey;
  label: string;
  state: ToolState;
  /** Convenience for callers that only care whether work may start. */
  ready: boolean;
  /** No key at all — these are why the tool is blocked. */
  blocked: ToolDep[];
  /** Keys saved, never tested. The tool runs; the screen warns. */
  unverified: ToolDep[];
  /** Optional helpers that are missing: the tool works with less. */
  degraded: ToolDep[];
  /** One assembled line, already in recruiter language. Empty when ready. */
  message: string;
}

/** "A", "A and B", "A, B and C" — read out loud, not comma-joined. */
function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] || "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function message(spec: ToolSpec, blocked: ToolDep[], unverified: ToolDep[]): string {
  if (blocked.length) {
    const names = listNames(blocked.map((d) => d.label));
    const verb = blocked.length > 1 ? "are not connected" : "is not connected";
    return `${names} ${verb}. Until that is done, ${spec.impact}.`;
  }
  if (unverified.length) {
    const names = listNames(unverified.map((d) => d.label));
    const verb = unverified.length > 1 ? "have keys saved but have" : "has keys saved but has";
    return `${names} ${verb} never been tested. ${spec.label} will run, but it can still stop part-way if the key is wrong.`;
  }
  return "";
}

/**
 * Read one tool's readiness for a workspace.
 *
 * Status comes from the same per-workspace integration store the Integrations
 * screen reads, so a tenant that has not been granted the operator's key is
 * correctly told it is missing — the exact case where the tool would otherwise
 * run and return nothing.
 */
export async function toolReadiness(workspaceId: string, tool: ToolKey): Promise<ToolReadiness | null> {
  if (!TOOLS[tool]) return null;
  return readFrom(await listIntegrations(workspaceId), tool);
}

/** The same read against an already-loaded integration list. Every caller that
 *  asks about more than one tool goes through here: the audit sweeps a whole
 *  box, and re-reading the store once per tool turned that into 11 reads per
 *  account for an answer that cannot change between them. */
function readFrom(list: Awaited<ReturnType<typeof listIntegrations>>, tool: ToolKey): ToolReadiness | null {
  const spec = TOOLS[tool];
  if (!spec) return null;
  const byId = new Map(list.map((i) => [i.id, i]));
  const dep = (id: IntegrationId): ToolDep => {
    const found = byId.get(id);
    return { id, label: found?.label || id, status: found?.status || "red" };
  };

  const required = spec.needs.map(dep);
  const blocked = required.filter((d) => d.status === "red");
  const unverified = required.filter((d) => d.status === "yellow");

  // Interchangeable providers: one connected is enough, all red blocks.
  const alts = (spec.anyOf || []).map(dep);
  if (alts.length && alts.every((d) => d.status === "red")) blocked.push(...alts);

  const degraded = (spec.helps || []).map(dep).filter((d) => d.status === "red");

  const state: ToolState = blocked.length ? "blocked" : unverified.length ? "unverified" : "ready";
  return {
    tool,
    label: spec.label,
    state,
    ready: state !== "blocked",
    blocked,
    unverified,
    degraded,
    message: message(spec, blocked, unverified),
  };
}

/** Every tool's readiness for a workspace (the screen loads this once). */
export async function allToolReadiness(workspaceId: string): Promise<ToolReadiness[]> {
  const list = await listIntegrations(workspaceId);
  return (Object.keys(TOOLS) as ToolKey[])
    .map((k) => readFrom(list, k))
    .filter((r): r is ToolReadiness => r !== null);
}

export function isToolKey(v: unknown): v is ToolKey {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(TOOLS, v);
}

/**
 * API gate. Call at the top of any route that does the tool's real work.
 *
 * Returns a 409 naming the missing connection, or null to continue. The 409 is
 * deliberate: not a 403 (the person is allowed), not a 500 (nothing is broken),
 * not a 200 with an empty list (the lie this whole module exists to stop). The
 * body carries the same recruiter-language message the screen shows, so a tool
 * reached by a link, a retry, or an old tab explains itself just as well.
 */
export async function toolGate(workspaceId: string, tool: ToolKey): Promise<NextResponse | null> {
  // Kill switch. A gate that wrongly blocks working software is worse than the
  // silence it replaces, so there is always a way to stand it down in one env
  // change while the registry is corrected.
  if ((process.env.ROS_READY_GATE || "").trim() === "off") return null;
  const r = await toolReadiness(workspaceId, tool);
  if (!r || r.ready) return null;
  return NextResponse.json(
    {
      error: "tool_not_connected",
      tool: r.tool,
      toolLabel: r.label,
      message: r.message,
      missing: r.blocked.map((d) => ({ id: d.id, label: d.label })),
    },
    { status: 409 },
  );
}

/* ---------------- monitoring ---------------------------------------------
   What the owner is told, without anyone having to open a screen. The audit
   answers one question per workspace: is a tool this account can see unable to
   work? ros-sentinel reads it hourly and emails on any change. */

export interface AuditRow {
  workspaceId: string;
  workspaceName: string;
  tool: ToolKey;
  toolLabel: string;
  state: ToolState;
  missing: string[];
}

export interface ReadyAudit {
  generatedAt: string;
  workspaces: number;
  /** Accounts deliberately left out of the alert, and why. */
  skipped: { workspaceId: string; workspaceName: string; reason: string }[];
  blocked: AuditRow[];
  unverified: AuditRow[];
  /** Stable one-line digest the watchdog compares between ticks. */
  fingerprint: string;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Which accounts an alert is worth sending about.
 *
 * The first live audit covered seven workspaces, four of them demo, smoke-test
 * and dev logins that have nothing connected because nothing is meant to be:
 * 47 "blocked" rows, of which a handful were real. An alert nobody can read is
 * an alert nobody reads, so the sweep is scoped.
 *
 * READY_AUDIT_WORKSPACES (comma-separated ids) pins it explicitly. Unset, the
 * default keeps accounts that are on a real plan and have been used this month.
 */
/** Returns the reason to skip this account, or null to audit it. */
function skipReason(a: { workspaceId: string; name: string; plan: string; suspended: boolean; lastActiveAt?: string }): string | null {
  const pinned = (process.env.READY_AUDIT_WORKSPACES || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (pinned.length) return pinned.includes(a.workspaceId) ? null : "not in READY_AUDIT_WORKSPACES";
  if (a.suspended) return "suspended";
  // Self-signups sit on the demo plan until the owner activates them, and by
  // definition have nothing connected yet.
  if (a.plan === "demo" || a.plan === "trial") return `plan is ${a.plan}`;
  const last = a.lastActiveAt ? Date.parse(a.lastActiveAt) : 0;
  if (!last || Date.now() - last > THIRTY_DAYS_MS) return "not used in the last 30 days";
  return null;
}

export async function auditReadiness(at: string): Promise<ReadyAudit> {
  const all = adminListAccounts();
  const skipped: ReadyAudit["skipped"] = [];
  const accounts = all.filter((a) => {
    const reason = skipReason(a);
    if (reason) skipped.push({ workspaceId: a.workspaceId, workspaceName: a.name, reason });
    return !reason;
  });
  const blocked: AuditRow[] = [];
  const unverified: AuditRow[] = [];

  for (const acc of accounts) {
    const list = await allToolReadiness(acc.workspaceId);
    for (const r of list) {
      if (r.state === "ready") continue;
      const row: AuditRow = {
        workspaceId: acc.workspaceId,
        workspaceName: acc.name,
        tool: r.tool,
        toolLabel: r.label,
        state: r.state,
        missing: (r.state === "blocked" ? r.blocked : r.unverified).map((d) => d.label),
      };
      (r.state === "blocked" ? blocked : unverified).push(row);
    }
  }

  const fingerprint = blocked
    .map((r) => `${r.workspaceId}:${r.tool}`)
    .sort()
    .join(",");
  return { generatedAt: at, workspaces: accounts.length, skipped, blocked, unverified, fingerprint };
}
