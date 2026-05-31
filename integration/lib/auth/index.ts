/**
 * RecruiterOS · Auth
 * Sign-up / sign-in / sessions / magic links for the enterprise login.
 *
 * Flow:
 *   register(email, password, name) -> provisions a workspace from the email
 *     domain (or joins the existing one), issues a session, sends a verify link.
 *   login(email, password) -> verifies + issues a session.
 *   requestMagicLink(email) -> emails a one-time sign-in link (passwordless).
 *   consumeMagicLink(token) -> exchanges the link for a session.
 *
 * In-memory reference store; swap `store` for Prisma in prod. Email sending is a
 * single seam (`sendEmail`) wired to a log here, SMTP/Resend in production.
 */

import { rid, nowIso, isoPlusHours } from "../core/ids";
import { hashPassword, verifyPassword, randomToken } from "./crypto";
import { capabilitiesFor } from "./permissions";
import type { AuthResult, EmailToken, Membership, Role, Session, User, Workspace } from "./types";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";

export * from "./types";
export * from "./permissions";

const store = {
  users: new Map<string, User>(),
  usersByEmail: new Map<string, string>(),     // email -> userId
  workspaces: new Map<string, Workspace>(),
  workspacesByDomain: new Map<string, string>(),
  memberships: [] as Membership[],
  sessions: new Map<string, Session>(),
  emailTokens: new Map<string, EmailToken>(),
  suspended: new Set<string>(),                // workspaceIds locked by the owner
};

/* ---------------- durability (Postgres snapshot) ----------------
   Accounts, workspaces and sessions survive restarts. With no DATABASE_URL the
   loader returns null and persist() is a no-op, so dev still runs in-memory. */
const SNAP_KEY = "auth";
function serialize() {
  return {
    users: [...store.users.entries()],
    usersByEmail: [...store.usersByEmail.entries()],
    workspaces: [...store.workspaces.entries()],
    workspacesByDomain: [...store.workspacesByDomain.entries()],
    memberships: store.memberships,
    sessions: [...store.sessions.entries()],
    emailTokens: [...store.emailTokens.entries()],
    suspended: [...store.suspended],
  };
}
function hydrate(s: any) {
  if (!s) return;
  store.users = new Map(s.users || []);
  store.usersByEmail = new Map(s.usersByEmail || []);
  store.workspaces = new Map(s.workspaces || []);
  store.workspacesByDomain = new Map(s.workspacesByDomain || []);
  store.memberships = s.memberships || [];
  store.sessions = new Map(s.sessions || []);
  store.emailTokens = new Map(s.emailTokens || []);
  store.suspended = new Set(s.suspended || []);
}
const persist = debouncedSaver(SNAP_KEY, serialize);

// Boot: hydrate from the durable snapshot before serving requests.
let hydrated: Promise<void> | null = null;
export function ensureAuthReady(): Promise<void> {
  if (!hydrated) {
    hydrated = dbEnabled()
      ? loadSnapshot<any>(SNAP_KEY).then(hydrate).catch(() => {})
      : Promise.resolve();
  }
  return hydrated;
}
// Kick off hydration at module load so the snapshot is in memory by the time
// the first request hits a synchronous guard (sessionContext).
void ensureAuthReady();

const SESSION_HOURS = 24 * 14;
const FREE_DOMAINS = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "proton.me"]);

/* ---------------- public API ---------------- */

export async function register(email: string, password: string, name: string): Promise<AuthResult> {
  await ensureAuthReady();
  const key = normEmail(email);
  if (store.usersByEmail.has(key)) throw authError("email_in_use", 409);
  if (password.length < 8) throw authError("weak_password", 422);

  const user: User = {
    id: rid("usr"), email: key, name: name.trim() || key.split("@")[0],
    passwordHash: hashPassword(password), emailVerified: false, createdAt: nowIso(),
  };
  store.users.set(user.id, user);
  store.usersByEmail.set(key, user.id);

  const { workspace, role } = provisionWorkspace(user);
  await sendVerificationEmail(user);
  const session = issueSession(user.id, workspace.id);
  persist();
  return result(user, workspace, role, session);
}

export async function login(email: string, password: string): Promise<AuthResult> {
  await ensureAuthReady();
  const user = userByEmail(email);
  if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
    throw authError("invalid_credentials", 401);
  }
  const m = primaryMembership(user.id);
  if (store.suspended.has(m.workspaceId)) throw authError("account_suspended", 403);
  const session = issueSession(user.id, m.workspaceId);
  persist();
  return result(user, store.workspaces.get(m.workspaceId)!, m.role, session);
}

export async function requestMagicLink(email: string): Promise<{ sent: true }> {
  const key = normEmail(email);
  const token: EmailToken = { token: randomToken(), email: key, purpose: "magic_link", expiresAt: isoPlusHours(1) };
  store.emailTokens.set(token.token, token);
  await sendEmail(key, "Your RecruiterOS sign-in link",
    `Sign in: ${appUrl()}/login?token=${token.token}`);
  return { sent: true };
}

/**
 * Forgot password: email a one-time reset link. Always returns { sent: true }
 * even when the email is unknown, so the endpoint can't be used to enumerate
 * accounts.
 */
export async function requestPasswordReset(email: string): Promise<{ sent: true }> {
  const key = normEmail(email);
  const user = userByEmail(key);
  if (user) {
    const token: EmailToken = { token: randomToken(), email: key, purpose: "reset_password", expiresAt: isoPlusHours(1) };
    store.emailTokens.set(token.token, token);
    await sendEmail(key, "Reset your RecruiterOS password",
      `Reset your password: ${appUrl()}/reset-password.html?token=${token.token}`);
  }
  return { sent: true };
}

/** Check a reset token is valid without consuming it (so the page can render). */
export function peekResetToken(token: string): { valid: boolean; email?: string } {
  const t = store.emailTokens.get(token);
  if (!t || t.purpose !== "reset_password" || Date.parse(t.expiresAt) < Date.now()) return { valid: false };
  return { valid: true, email: t.email };
}

/**
 * Complete a password reset: set the new password, invalidate the token and all
 * existing sessions for that user, then issue a fresh session.
 */
export async function resetPassword(token: string, newPassword: string): Promise<AuthResult> {
  await ensureAuthReady();
  if (newPassword.length < 8) throw authError("weak_password", 422);
  const t = store.emailTokens.get(token);
  if (!t || t.purpose !== "reset_password" || Date.parse(t.expiresAt) < Date.now()) {
    throw authError("invalid_or_expired_token", 401);
  }
  store.emailTokens.delete(token);

  const user = userByEmail(t.email);
  if (!user) throw authError("not_found", 404);
  user.passwordHash = hashPassword(newPassword);
  user.emailVerified = true;

  // Security: revoke every existing session for this user.
  for (const [tok, s] of store.sessions) if (s.userId === user.id) store.sessions.delete(tok);

  const m = primaryMembership(user.id);
  const session = issueSession(user.id, m.workspaceId);
  persist();
  return result(user, store.workspaces.get(m.workspaceId)!, m.role, session);
}

export async function consumeMagicLink(token: string): Promise<AuthResult> {
  await ensureAuthReady();
  const t = store.emailTokens.get(token);
  if (!t || t.purpose !== "magic_link" || Date.parse(t.expiresAt) < Date.now()) {
    throw authError("invalid_or_expired_token", 401);
  }
  store.emailTokens.delete(token);

  let user = userByEmail(t.email);
  if (!user) {
    // First touch via magic link: create a passwordless user + workspace.
    user = { id: rid("usr"), email: t.email, name: t.email.split("@")[0], passwordHash: null, emailVerified: true, createdAt: nowIso() };
    store.users.set(user.id, user);
    store.usersByEmail.set(t.email, user.id);
    provisionWorkspace(user);
  } else {
    user.emailVerified = true;
  }
  const m = primaryMembership(user.id);
  const session = issueSession(user.id, m.workspaceId);
  persist();
  return result(user, store.workspaces.get(m.workspaceId)!, m.role, session);
}

export function verifyEmail(token: string): boolean {
  const t = store.emailTokens.get(token);
  if (!t || t.purpose !== "verify" || Date.parse(t.expiresAt) < Date.now()) return false;
  store.emailTokens.delete(token);
  const u = userByEmail(t.email);
  if (u) u.emailVerified = true;
  return Boolean(u);
}

/** Validate a session token -> the authed context, or null. */
export function sessionContext(token?: string | null): AuthResult | null {
  if (!token) return null;
  const s = store.sessions.get(token);
  if (!s || Date.parse(s.expiresAt) < Date.now()) return null;
  const user = store.users.get(s.userId);
  const ws = store.workspaces.get(s.workspaceId);
  if (!user || !ws) return null;
  if (store.suspended.has(ws.id)) return null; // owner-locked: token is dead until unsuspended
  const m = store.memberships.find((x) => x.userId === user.id && x.workspaceId === ws.id);
  return result(user, ws, m?.role ?? "member", s);
}

export function logout(token: string): void {
  store.sessions.delete(token);
  persist();
}

/** Read the Bearer / cookie session token off a request. */
export function tokenFromRequest(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)ros_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/* ---------------- internals ---------------- */

function provisionWorkspace(user: User): { workspace: Workspace; role: Role } {
  const domain = user.email.split("@")[1];
  const corporate = !FREE_DOMAINS.has(domain);

  if (corporate && store.workspacesByDomain.has(domain)) {
    const ws = store.workspaces.get(store.workspacesByDomain.get(domain)!)!;
    const role: Role = "member"; // joins existing org as a member
    store.memberships.push({ userId: user.id, workspaceId: ws.id, role });
    return { workspace: ws, role };
  }

  const ws: Workspace = {
    id: rid("ws"),
    name: corporate ? titleCase(domain.split(".")[0]) : `${titleCase(user.name)}'s workspace`,
    domain: corporate ? domain : undefined,
    plan: corporate ? "enterprise" : "trial",
    createdAt: nowIso(),
  };
  store.workspaces.set(ws.id, ws);
  if (corporate) store.workspacesByDomain.set(domain, ws.id);
  store.memberships.push({ userId: user.id, workspaceId: ws.id, role: "owner" });
  return { workspace: ws, role: "owner" };
}

function issueSession(userId: string, workspaceId: string): Session {
  const s: Session = { token: randomToken(), userId, workspaceId, createdAt: nowIso(), expiresAt: isoPlusHours(SESSION_HOURS) };
  store.sessions.set(s.token, s);
  return s;
}

async function sendVerificationEmail(user: User): Promise<void> {
  const t: EmailToken = { token: randomToken(), email: user.email, purpose: "verify", expiresAt: isoPlusHours(24) };
  store.emailTokens.set(t.token, t);
  await sendEmail(user.email, "Verify your RecruiterOS email",
    `Confirm your email: ${appUrl()}/verify?token=${t.token}`);
}

/** Email seam. Wire SMTP / Resend / SES here; logs in the reference build. */
/**
 * Sends a real email when RESEND_API_KEY is set (Resend HTTP API), otherwise
 * logs to the console for local dev. EMAIL_FROM controls the sender; it must be
 * a verified domain/address in your Resend account (e.g. "RecruiterOS
 * <no-reply@recruitersos.co>").
 */
async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "RecruiterOS <onboarding@resend.dev>";
  if (!key) {
    console.info(`[email] (no RESEND_API_KEY, logging only) -> ${to} :: ${subject}\n${body}`);
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        // Body lines may contain a link; render as simple HTML so it's clickable.
        html: body
          .split("\n")
          .map((line) =>
            line.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1">$1</a>'),
          )
          .join("<br>"),
        text: body,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[email] Resend failed ${res.status}: ${detail}`);
    }
  } catch (e) {
    console.error("[email] send error:", (e as Error).message);
  }
}

function userByEmail(email: string): User | undefined {
  const id = store.usersByEmail.get(normEmail(email));
  return id ? store.users.get(id) : undefined;
}
function primaryMembership(userId: string): Membership {
  const m = store.memberships.find((x) => x.userId === userId);
  if (!m) throw authError("no_workspace", 500);
  return m;
}
function result(user: User, workspace: Workspace, role: Role, session: Session): AuthResult {
  const { passwordHash: _omit, ...safe } = user;
  return { user: safe, workspace, role, capabilities: capabilitiesFor(role), session };
}

/** Issue a session for a known user+workspace and return the authed context. */
export function issueSessionForUser(userId: string, workspaceId: string): AuthResult {
  const user = store.users.get(userId);
  const ws = store.workspaces.get(workspaceId);
  if (!user || !ws) throw authError("not_found", 404);
  const m = store.memberships.find((x) => x.userId === userId && x.workspaceId === workspaceId);
  const session = issueSession(userId, workspaceId);
  return result(user, ws, m?.role ?? "member", session);
}

/** Public email seam reused by team invites. */
export async function sendWorkspaceEmail(to: string, subject: string, body: string): Promise<void> {
  await sendEmail(to, subject, body);
}
function normEmail(e: string): string {
  return e.trim().toLowerCase();
}
function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function appUrl(): string {
  return process.env.RECRUITEROS_APP_URL ?? "https://app.recruitersos.co";
}
function authError(code: string, status: number): Error & { status: number } {
  const e = new Error(code) as Error & { status: number };
  e.status = status;
  return e;
}

/* ================================================================== */
/* OWNER ADMIN OPERATIONS                                              */
/* Full visibility + hard controls over EVERY account. These are       */
/* consumed only by the owner-gated console (requireOwner), never by    */
/* the normal app. They mutate the live store and persist immediately.  */
/* ================================================================== */

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  emailVerified: boolean;
  hasPassword: boolean;
  createdAt: string;
}

export interface AdminAccount {
  workspaceId: string;
  name: string;
  domain?: string;
  plan: string;
  suspended: boolean;
  createdAt: string;
  members: AdminUser[];
  activeSessions: number;
  lastActiveAt?: string;
}

function adminMembersOf(workspaceId: string): AdminUser[] {
  return store.memberships
    .filter((m) => m.workspaceId === workspaceId)
    .map((m) => {
      const u = store.users.get(m.userId);
      return u
        ? {
            id: u.id, email: u.email, name: u.name, role: m.role,
            emailVerified: u.emailVerified, hasPassword: Boolean(u.passwordHash), createdAt: u.createdAt,
          }
        : null;
    })
    .filter(Boolean) as AdminUser[];
}

function sessionsOf(workspaceId: string): Session[] {
  return [...store.sessions.values()].filter((s) => s.workspaceId === workspaceId);
}

function toAdminAccount(ws: Workspace): AdminAccount {
  const sess = sessionsOf(ws.id);
  const lastActiveAt = sess.map((s) => s.createdAt).sort().pop();
  return {
    workspaceId: ws.id, name: ws.name, domain: ws.domain, plan: ws.plan,
    suspended: store.suspended.has(ws.id), createdAt: ws.createdAt,
    members: adminMembersOf(ws.id),
    activeSessions: sess.filter((s) => Date.parse(s.expiresAt) >= Date.now()).length,
    lastActiveAt,
  };
}

/** Every account (workspace) on the platform, with members + session activity. */
export function adminListAccounts(): AdminAccount[] {
  return [...store.workspaces.values()]
    .map(toAdminAccount)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

/** Full detail on one account. */
export function adminAccountDetail(workspaceId: string): AdminAccount | null {
  const ws = store.workspaces.get(workspaceId);
  return ws ? toAdminAccount(ws) : null;
}

/** Lock / unlock an account. Suspending kills every live session for it. */
export function adminSetSuspended(workspaceId: string, suspended: boolean): boolean {
  if (!store.workspaces.has(workspaceId)) return false;
  if (suspended) {
    store.suspended.add(workspaceId);
    for (const [tok, s] of store.sessions) if (s.workspaceId === workspaceId) store.sessions.delete(tok);
  } else {
    store.suspended.delete(workspaceId);
  }
  persist();
  return true;
}

/** Force-revoke every session for an account (forces re-login everywhere). */
export function adminRevokeSessions(workspaceId: string): number {
  let n = 0;
  for (const [tok, s] of store.sessions) if (s.workspaceId === workspaceId) { store.sessions.delete(tok); n++; }
  persist();
  return n;
}

/** Set an explicit new password for one user. */
export function adminSetPassword(userId: string, newPassword: string): boolean {
  const u = store.users.get(userId);
  if (!u) return false;
  u.passwordHash = hashPassword(newPassword);
  u.emailVerified = true;
  for (const [tok, s] of store.sessions) if (s.userId === userId) store.sessions.delete(tok);
  persist();
  return true;
}

/** Reset a user's password to a fresh random temp value, returned once. */
export function adminResetPasswordToTemp(userId: string): string | null {
  const u = store.users.get(userId);
  if (!u) return null;
  const temp = `Ros-${randomToken().slice(0, 10)}`;
  u.passwordHash = hashPassword(temp);
  for (const [tok, s] of store.sessions) if (s.userId === userId) store.sessions.delete(tok);
  persist();
  return temp;
}

/**
 * Delete an account outright: the workspace, its memberships, its sessions, the
 * domain mapping, the suspend flag, and any user who belonged ONLY to it.
 * (Cross-module DATA purge — prospects, campaigns, usage, sending infra — is
 * orchestrated separately by the owner layer; this clears the identity side.)
 */
export function adminDeleteWorkspace(workspaceId: string): { deletedUsers: number; deletedSessions: number } | null {
  const ws = store.workspaces.get(workspaceId);
  if (!ws) return null;

  const memberIds = store.memberships.filter((m) => m.workspaceId === workspaceId).map((m) => m.userId);
  store.memberships = store.memberships.filter((m) => m.workspaceId !== workspaceId);

  let deletedSessions = 0;
  for (const [tok, s] of store.sessions) if (s.workspaceId === workspaceId) { store.sessions.delete(tok); deletedSessions++; }

  let deletedUsers = 0;
  for (const uid of memberIds) {
    const stillMember = store.memberships.some((m) => m.userId === uid);
    if (!stillMember) {
      const u = store.users.get(uid);
      if (u) { store.usersByEmail.delete(u.email); store.users.delete(uid); deletedUsers++; }
    }
  }

  if (ws.domain) store.workspacesByDomain.delete(ws.domain);
  store.suspended.delete(workspaceId);
  store.workspaces.delete(workspaceId);
  persist();
  return { deletedUsers, deletedSessions };
}

/** Dev seeding / tests only. */
export function devAuthStore() {
  return store;
}
