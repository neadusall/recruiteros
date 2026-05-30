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
};

const SESSION_HOURS = 24 * 14;
const FREE_DOMAINS = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "proton.me"]);

/* ---------------- public API ---------------- */

export async function register(email: string, password: string, name: string): Promise<AuthResult> {
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
  return result(user, workspace, role, session);
}

export async function login(email: string, password: string): Promise<AuthResult> {
  const user = userByEmail(email);
  if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
    throw authError("invalid_credentials", 401);
  }
  const m = primaryMembership(user.id);
  const session = issueSession(user.id, m.workspaceId);
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
  return result(user, store.workspaces.get(m.workspaceId)!, m.role, session);
}

export async function consumeMagicLink(token: string): Promise<AuthResult> {
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
  const m = store.memberships.find((x) => x.userId === user.id && x.workspaceId === ws.id);
  return result(user, ws, m?.role ?? "member", s);
}

export function logout(token: string): void {
  store.sessions.delete(token);
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
async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  console.info(`[email] -> ${to} :: ${subject}\n${body}`);
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
  return process.env.RECRUITEROS_APP_URL ?? "https://app.recruiteros.co";
}
function authError(code: string, status: number): Error & { status: number } {
  const e = new Error(code) as Error & { status: number };
  e.status = status;
  return e;
}

/** Dev seeding / tests only. */
export function devAuthStore() {
  return store;
}
