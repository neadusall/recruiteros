/**
 * RecruiterOS · Auth · Team management (admin sub-accounts)
 *
 * Admins/owners add recruiters to their workspace, set roles, and remove them.
 * Recruiters join via an emailed invite link and never touch Telnyx, API keys,
 * billing, or the org. See permissions.ts for the capability wall.
 */

import { rid, nowIso, isoPlusHours } from "../core/ids";
import { capabilitiesFor, ASSIGNABLE_ROLES } from "./permissions";
import { devAuthStore, issueSessionForUser, sendWorkspaceEmail } from "./index";
import type { AuthResult, Membership, Role } from "./types";

export interface TeamMember {
  userId: string;
  email: string;
  name: string;
  /** Derived from `name` (split on first space) so the UI can search/sort by
   *  first or last name without a schema change to the user record. */
  firstName: string;
  lastName: string;
  role: Role;
  emailVerified: boolean;
  isYou?: boolean;
}

/** Split a single display name into first + last (everything after the first space). */
function splitName(name: string): { firstName: string; lastName: string } {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") };
}

function err(code: string, status: number): Error & { status: number } {
  const e = new Error(code) as Error & { status: number };
  e.status = status;
  return e;
}

/** Everyone in a workspace, with their role. */
export function listMembers(workspaceId: string, youUserId?: string): TeamMember[] {
  const store = devAuthStore();
  return store.memberships
    .filter((m) => m.workspaceId === workspaceId)
    .map((m) => {
      const u = store.users.get(m.userId);
      const name = u?.name ?? "(unknown)";
      const { firstName, lastName } = splitName(name);
      return {
        userId: m.userId,
        email: u?.email ?? "(unknown)",
        name,
        firstName,
        lastName,
        role: m.role,
        emailVerified: u?.emailVerified ?? false,
        isYou: m.userId === youUserId,
      };
    });
}

/**
 * Find members by first name, last name, or email. Empty `q` returns everyone.
 * Multi-token queries ("jane smith") require every token to match somewhere in
 * the member's name+email — so first+last together still resolves one person.
 */
export function searchMembers(workspaceId: string, q: string, youUserId?: string): TeamMember[] {
  const all = listMembers(workspaceId, youUserId);
  const needle = (q || "").toLowerCase().trim();
  if (!needle) return all;
  const tokens = needle.split(/\s+/);
  return all.filter((m) => {
    const hay = `${m.name} ${m.email}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
}

/** Pending invites still outstanding for a workspace. */
export function listInvites(workspaceId: string): { email: string; role: Role; expiresAt: string }[] {
  const store = devAuthStore();
  return [...store.emailTokens.values()]
    .filter((t) => t.purpose === "invite" && t.workspaceId === workspaceId)
    .map((t) => ({ email: t.email, role: t.role ?? "member", expiresAt: t.expiresAt }));
}

/**
 * Invite a recruiter. The actor's role decides which roles they may assign
 * (admins can only add members; owners can add admins or members).
 */
export async function inviteMember(
  actorRole: Role,
  actorName: string,
  workspaceId: string,
  email: string,
  role: Role,
): Promise<{ invited: true; email: string; role: Role }> {
  if (!ASSIGNABLE_ROLES[actorRole].includes(role)) throw err("role_not_assignable", 403);
  const store = devAuthStore();
  const key = email.trim().toLowerCase();

  // Already a member? No-op-ish guard.
  const existing = store.usersByEmail.get(key);
  if (existing && store.memberships.some((m) => m.userId === existing && m.workspaceId === workspaceId)) {
    throw err("already_member", 409);
  }

  const token = {
    token: rid("inv"),
    email: key,
    purpose: "invite" as const,
    expiresAt: isoPlusHours(24 * 7),
    workspaceId,
    role,
    invitedByName: actorName,
  };
  store.emailTokens.set(token.token, token);

  const ws = store.workspaces.get(workspaceId);
  await sendWorkspaceEmail(
    key,
    `${actorName} invited you to ${ws?.name ?? "RecruiterOS"}`,
    `Join the workspace as ${role}: ${appUrl()}/signup.html?invite=${token.token}`,
  );
  return { invited: true, email: key, role };
}

/**
 * Accept an invite: create (or reuse) the user, add them to the workspace at the
 * invited role, and issue a session. Password optional (magic-link style).
 */
export async function acceptInvite(token: string, name: string, password?: string): Promise<AuthResult> {
  const store = devAuthStore();
  const t = store.emailTokens.get(token);
  if (!t || t.purpose !== "invite" || !t.workspaceId || Date.parse(t.expiresAt) < Date.now()) {
    throw err("invalid_or_expired_invite", 401);
  }
  store.emailTokens.delete(token);

  let userId = store.usersByEmail.get(t.email);
  if (!userId) {
    const { hashPassword } = await import("./crypto");
    userId = rid("usr");
    store.users.set(userId, {
      id: userId, email: t.email, name: name?.trim() || t.email.split("@")[0],
      passwordHash: password ? hashPassword(password) : null,
      emailVerified: true, createdAt: nowIso(),
    });
    store.usersByEmail.set(t.email, userId);
  }

  const role: Role = t.role ?? "member";
  if (!store.memberships.some((m) => m.userId === userId && m.workspaceId === t.workspaceId)) {
    store.memberships.push({ userId, workspaceId: t.workspaceId, role });
  }
  return issueSessionForUser(userId, t.workspaceId!);
}

/**
 * Admin "view as recruiter": mint a session for a recruiter in this workspace so
 * an admin can open that recruiter's portal exactly as they see it, no password.
 * Hard wall: the target must be a RECRUITER (role "member") in the SAME
 * workspace — never another admin or owner (no privilege escalation). The caller
 * (the route) has already verified the actor holds team:manage.
 */
export function impersonateMember(workspaceId: string, userId: string): AuthResult {
  const store = devAuthStore();
  const m = store.memberships.find((x) => x.userId === userId && x.workspaceId === workspaceId);
  if (!m) throw err("not_found", 404);
  if (m.role !== "member") throw err("can_only_view_recruiters", 403);
  return issueSessionForUser(userId, workspaceId);
}

/** Change a member's role (cannot change the last owner; admins can't mint owners). */
export function setRole(actorRole: Role, workspaceId: string, userId: string, role: Role): TeamMember[] {
  const store = devAuthStore();
  if (actorRole !== "owner" && (role === "owner" || role === "admin")) throw err("forbidden", 403);
  const m = store.memberships.find((x) => x.userId === userId && x.workspaceId === workspaceId);
  if (!m) throw err("not_found", 404);
  if (m.role === "owner" && role !== "owner" && lastOwner(workspaceId)) throw err("cannot_demote_last_owner", 409);
  m.role = role;
  return listMembers(workspaceId);
}

/** Remove a member from the workspace (never the last owner). */
export function removeMember(workspaceId: string, userId: string): TeamMember[] {
  const store = devAuthStore();
  const m = store.memberships.find((x) => x.userId === userId && x.workspaceId === workspaceId);
  if (m?.role === "owner" && lastOwner(workspaceId)) throw err("cannot_remove_last_owner", 409);
  store.memberships = store.memberships.filter((x) => !(x.userId === userId && x.workspaceId === workspaceId));
  // Revoke that user's sessions scoped to this workspace.
  for (const [tok, s] of store.sessions) if (s.userId === userId && s.workspaceId === workspaceId) store.sessions.delete(tok);
  return listMembers(workspaceId);
}

function lastOwner(workspaceId: string): boolean {
  const store = devAuthStore();
  return store.memberships.filter((m) => m.workspaceId === workspaceId && m.role === "owner").length <= 1;
}

function appUrl(): string {
  return process.env.RECRUITEROS_APP_URL ?? "https://app.recruitersos.co";
}

export { capabilitiesFor };
