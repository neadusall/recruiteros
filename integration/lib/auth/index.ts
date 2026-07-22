/**
 * RecruitersOS · Auth
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
import { isOwnerEmail } from "../owner/emails";
import { hashPassword, verifyPassword, randomToken } from "./crypto";
import { capabilitiesFor } from "./permissions";
import type { AuthResult, EmailToken, Membership, Role, Session, User, Workspace } from "./types";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";
import {
  generateTotpSecret,
  otpauthUri,
  verifyTotp,
  generateRecoveryCodes,
  hashRecoveryCode,
} from "./totp";

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
  bootstrapResetNonce: "" as string,           // last-applied OWNER_BOOTSTRAP_RESET (one-shot guard)
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
    bootstrapResetNonce: store.bootstrapResetNonce,
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
  store.bootstrapResetNonce = s.bootstrapResetNonce || "";
  backfillDomainIndex();
}

/**
 * Self-heal the domain -> workspace index so corporate-domain auto-join (and the
 * shared integrations that ride on it, e.g. the ATS connection) holds even for
 * workspaces created before this index existed. Two passes:
 *   1) re-index any workspace that already carries a .domain but is missing.
 *   2) legacy heal: a corporate workspace with no .domain set — infer it from
 *      the OWNER's email, but ONLY when it's unambiguous (exactly one workspace
 *      owned by that domain), so we never wrongly merge two orgs.
 * Idempotent; runs on every hydrate.
 */
function backfillDomainIndex(): void {
  let changed = false;
  for (const ws of store.workspaces.values()) {
    if (ws.domain && store.workspacesByDomain.get(ws.domain) !== ws.id) {
      store.workspacesByDomain.set(ws.domain, ws.id);
      changed = true;
    }
  }
  const byDomain = new Map<string, Set<string>>(); // corporate domain -> owner workspace ids
  for (const m of store.memberships) {
    if (m.role !== "owner") continue;
    const u = store.users.get(m.userId);
    const dom = u?.email?.split("@")[1]?.toLowerCase();
    if (!dom || FREE_DOMAINS.has(dom) || store.workspacesByDomain.has(dom)) continue;
    if (!byDomain.has(dom)) byDomain.set(dom, new Set());
    byDomain.get(dom)!.add(m.workspaceId);
  }
  for (const [dom, wsIds] of byDomain) {
    if (wsIds.size !== 1) continue; // ambiguous -> leave it alone
    const ws = store.workspaces.get([...wsIds][0]);
    if (!ws) continue;
    if (!ws.domain) ws.domain = dom;
    store.workspacesByDomain.set(dom, ws.id);
    changed = true;
  }
  if (changed) persist();
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

/**
 * Boot-time owner-account bootstrap — the durable fix for "I can't log in".
 *
 * The owner login account is just data in the snapshot store; it is NOT implied
 * by the OWNER_EMAIL allow-list (that only gates the owner console). If the
 * store was ever wiped (the pre-2026-06-12 Postgres-wipe era) the account
 * vanished — and with password-reset email unconfigured in prod there was no
 * recovery path, so the owner stayed locked out across every redeploy. This
 * guarantees the owner can always sign in, with no SSH and no working email:
 *
 *   - OWNER_EMAIL              comma list of owner emails (same as the console).
 *   - OWNER_BOOTSTRAP_PASSWORD password to seed. Bootstrap is a no-op if unset.
 *   - OWNER_BOOTSTRAP_RESET    optional nonce. When its value differs from the
 *                              last-applied one, EXISTING owner accounts are
 *                              force-reset to OWNER_BOOTSTRAP_PASSWORD exactly
 *                              once (covers "account exists but password lost").
 *
 * Idempotent and non-destructive by default: missing owner accounts are created
 * on every boot, but an existing account's password is NEVER clobbered unless
 * the reset nonce changes — so once the owner signs in and sets their own
 * password (account menu / owner console), future deploys leave it alone.
 */
export async function ensureOwnerAccounts(): Promise<void> {
  await ensureAuthReady();
  const pw = process.env.OWNER_BOOTSTRAP_PASSWORD;
  if (!pw) return;
  if (pw.length < 8) {
    console.error("[auth] OWNER_BOOTSTRAP_PASSWORD is too short (min 8); skipping owner bootstrap");
    return;
  }
  const emails = (process.env.OWNER_EMAIL || "")
    .split(",").map((e) => normEmail(e)).filter(Boolean);
  if (!emails.length) return;

  const resetNonce = (process.env.OWNER_BOOTSTRAP_RESET || "").trim();
  const applyReset = Boolean(resetNonce) && store.bootstrapResetNonce !== resetNonce;
  let changed = false;

  for (const email of emails) {
    const existing = userByEmail(email);
    if (!existing) {
      const user: User = {
        id: rid("usr"), email, name: email.split("@")[0],
        passwordHash: hashPassword(pw), emailVerified: true, createdAt: nowIso(),
      };
      store.users.set(user.id, user);
      store.usersByEmail.set(email, user.id);
      provisionWorkspace(user);
      promoteToOwner(user.id);
      changed = true;
      console.info(`[auth] owner bootstrap: created account ${email}`);
    } else if (applyReset) {
      existing.passwordHash = hashPassword(pw);
      existing.emailVerified = true;
      delete existing.twoFactor;        // a lost-password owner can't satisfy a stale 2FA either
      promoteToOwner(existing.id);
      for (const [tok, s] of store.sessions) if (s.userId === existing.id) store.sessions.delete(tok);
      changed = true;
      console.info(`[auth] owner bootstrap: reset password for ${email}`);
    }
  }

  if (applyReset) { store.bootstrapResetNonce = resetNonce; changed = true; }
  if (changed) persist();
}

/** Ensure a user owns their primary workspace (corporate-domain joiners land as
 *  "member"; an owner email must be an actual owner). */
function promoteToOwner(userId: string): void {
  const m = store.memberships.find((x) => x.userId === userId);
  if (m && m.role !== "owner") m.role = "owner";
}

// Run the bootstrap once the snapshot is hydrated, so it never races the load
// and create-if-missing only fires when the account is genuinely absent.
void ensureOwnerAccounts().catch((e) => console.error("[auth] owner bootstrap failed:", (e as Error).message));

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

/**
 * Step one of sign-in. Verifies the password, then EITHER issues a session
 * ({ status: "ok" }) or, when the user has TOTP enabled, withholds the session
 * and returns a short-lived challenge ({ status: "twoFactor" }) that the client
 * redeems with completeTwoFactorLogin() once it has the 6-digit code.
 */
export type LoginResult =
  | { status: "ok"; auth: AuthResult }
  | { status: "twoFactor"; challenge: string };

export async function login(email: string, password: string): Promise<LoginResult> {
  await ensureAuthReady();
  const user = userByEmail(email);
  if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
    throw authError("invalid_credentials", 401);
  }
  const m = primaryMembership(user.id);
  if (store.suspended.has(m.workspaceId)) throw authError("account_suspended", 403);

  if (user.twoFactor?.enabled) {
    return { status: "twoFactor", challenge: createTwoFactorChallenge(user.id, m.workspaceId) };
  }
  const session = issueSession(user.id, m.workspaceId);
  persist();
  return { status: "ok", auth: result(user, store.workspaces.get(m.workspaceId)!, m.role, session) };
}

/* ---------------- two-factor (TOTP) ---------------- */

/** Short-lived (in-memory) login challenges: password OK, awaiting the code. */
interface TwoFactorChallenge { userId: string; workspaceId: string; expiresAt: number; }
const twoFactorChallenges = new Map<string, TwoFactorChallenge>();
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function createTwoFactorChallenge(userId: string, workspaceId: string): string {
  const token = randomToken();
  twoFactorChallenges.set(token, { userId, workspaceId, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return token;
}

/**
 * Step two of sign-in for 2FA users: redeem the challenge with a TOTP code (or a
 * one-time recovery code) and get the real session. The challenge is consumed on
 * success; wrong codes leave it valid until it expires so the user can retry.
 */
export function completeTwoFactorLogin(challenge: string, code: string): AuthResult {
  const ch = twoFactorChallenges.get(challenge);
  if (!ch || ch.expiresAt < Date.now()) {
    twoFactorChallenges.delete(challenge);
    throw authError("challenge_expired", 401);
  }
  if (!verifyTwoFactorCode(ch.userId, code)) throw authError("invalid_code", 401);
  twoFactorChallenges.delete(challenge);
  if (store.suspended.has(ch.workspaceId)) throw authError("account_suspended", 403);
  const out = issueSessionForUser(ch.userId, ch.workspaceId);
  persist();
  return out;
}

/** Whether a user has an active second factor. */
export function userHasTwoFactor(userId: string): boolean {
  return store.users.get(userId)?.twoFactor?.enabled === true;
}

export function twoFactorStatus(userId: string): { enabled: boolean; pending: boolean; recoveryRemaining: number } {
  const tf = store.users.get(userId)?.twoFactor;
  return {
    enabled: tf?.enabled === true,
    pending: Boolean(tf) && tf!.enabled === false,
    recoveryRemaining: tf?.recoveryHashes.length ?? 0,
  };
}

/**
 * Begin enrollment: mint a fresh secret (not yet active) and return the data the
 * authenticator app needs. Refuses if 2FA is already live (disable it first).
 */
export function beginTwoFactorSetup(userId: string): { secret: string; otpauthUri: string } {
  const user = store.users.get(userId);
  if (!user) throw authError("not_found", 404);
  if (user.twoFactor?.enabled) throw authError("already_enabled", 409);
  const secret = generateTotpSecret();
  user.twoFactor = { secret, enabled: false, recoveryHashes: [] };
  persist();
  return { secret, otpauthUri: otpauthUri(secret, user.email) };
}

/**
 * Confirm enrollment: the user proves they configured their app by entering a
 * live code. On success 2FA goes active and we mint one-time recovery codes
 * (returned ONCE — only their hashes are stored).
 */
export function confirmTwoFactorSetup(userId: string, code: string): { recoveryCodes: string[] } {
  const user = store.users.get(userId);
  if (!user?.twoFactor) throw authError("setup_not_started", 409);
  if (user.twoFactor.enabled) throw authError("already_enabled", 409);
  if (!verifyTotp(user.twoFactor.secret, code)) throw authError("invalid_code", 401);
  const recoveryCodes = generateRecoveryCodes(10);
  user.twoFactor.enabled = true;
  user.twoFactor.enabledAt = nowIso();
  user.twoFactor.recoveryHashes = recoveryCodes.map(hashRecoveryCode);
  persist();
  return { recoveryCodes };
}

/** Turn 2FA off. Requires a current code (or recovery code) to prove possession. */
export function disableTwoFactor(userId: string, code: string): boolean {
  const user = store.users.get(userId);
  if (!user?.twoFactor?.enabled) return true;
  if (!verifyTwoFactorCode(userId, code)) throw authError("invalid_code", 401);
  delete user.twoFactor;
  persist();
  return true;
}

/** Verify a TOTP code or consume a one-time recovery code. */
export function verifyTwoFactorCode(userId: string, code: string): boolean {
  const tf = store.users.get(userId)?.twoFactor;
  if (!tf?.enabled) return false;
  if (verifyTotp(tf.secret, code)) return true;
  const h = hashRecoveryCode(code);
  const idx = tf.recoveryHashes.indexOf(h);
  if (idx !== -1) {
    tf.recoveryHashes.splice(idx, 1); // one-time use
    persist();
    return true;
  }
  return false;
}

export async function requestMagicLink(email: string): Promise<{ sent: true }> {
  const key = normEmail(email);
  const token: EmailToken = { token: randomToken(), email: key, purpose: "magic_link", expiresAt: isoPlusHours(1) };
  store.emailTokens.set(token.token, token);
  const brand = await mailBrandForRecipient(key);
  await sendWorkspaceEmail(key, `Your ${brand.name} sign-in link`,
    `Sign in: ${brand.base}/login?token=${token.token}`, brand.workspaceId, { critical: true });
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
    const brand = await mailBrandForRecipient(key);
    await sendWorkspaceEmail(key, `Reset your ${brand.name} password`,
      `Reset your password: ${brand.base}/reset-password.html?token=${token.token}`, brand.workspaceId, { critical: true });
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

/**
 * Change a signed-in user's own password. Verifies the current password first
 * (so a hijacked session can't silently rotate it), then sets the new one and
 * revokes every OTHER session for the user. The caller's current session token
 * is preserved so they stay signed in on this device; pass it as keepToken.
 *
 * Passwordless accounts (invited / magic-link / OAuth users who never set a
 * password) have no current password to check: when the user has no
 * passwordHash, currentPassword is ignored and this simply sets the first one.
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  keepToken?: string,
): Promise<{ ok: true }> {
  await ensureAuthReady();
  const user = store.users.get(userId);
  if (!user) throw authError("not_found", 404);
  if (newPassword.length < 8) throw authError("weak_password", 422);
  // Only verify the current password when the account actually has one; a
  // passwordless user is setting their first password here.
  if (user.passwordHash) {
    if (!currentPassword || !verifyPassword(currentPassword, user.passwordHash)) {
      throw authError("wrong_password", 403);
    }
    if (verifyPassword(newPassword, user.passwordHash)) {
      throw authError("password_unchanged", 422);
    }
  }
  user.passwordHash = hashPassword(newPassword);
  user.emailVerified = true;
  // Revoke every session for this user EXCEPT the one making the change, so a
  // password rotation logs out other devices without booting the current one.
  for (const [tok, s] of store.sessions) {
    if (s.userId === userId && tok !== keepToken) store.sessions.delete(tok);
  }
  persist();
  return { ok: true };
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

/**
 * Sign in (or sign up) via an OAuth identity provider, currently LinkedIn.
 * Finds the user by email or creates a passwordless one, stores their LinkedIn
 * profile URL + avatar on the user AND on the workspace (so the Alfred
 * extension links to the same LinkedIn account), then issues a session.
 */
export async function upsertOAuthUser(profile: {
  email: string;
  name?: string;
  picture?: string;
  linkedinUrl?: string;
}): Promise<AuthResult> {
  await ensureAuthReady();
  const key = normEmail(profile.email);
  let user = userByEmail(key);
  if (!user) {
    user = {
      id: rid("usr"), email: key, name: (profile.name || key.split("@")[0]).trim(),
      passwordHash: null, emailVerified: true, createdAt: nowIso(),
      linkedinUrl: profile.linkedinUrl, picture: profile.picture,
    };
    store.users.set(user.id, user);
    store.usersByEmail.set(key, user.id);
    provisionWorkspace(user);
  } else {
    user.emailVerified = true;
    if (profile.linkedinUrl) user.linkedinUrl = profile.linkedinUrl;
    if (profile.picture) user.picture = profile.picture;
    if (profile.name && !user.name) user.name = profile.name;
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

/**
 * True when an OWNER_EMAIL account is a member of this workspace WITH the owner
 * role — i.e. it is the operator's own workspace regardless of which id their
 * session carries. Workspace ids drift across auth churn; the operator's email
 * doesn't. Lets house-identity checks (credential mirroring, isolation) survive
 * the drift instead of demoting the operator to an isolated customer. The
 * owner-ROLE requirement means merely being invited into a customer's workspace
 * as a member never makes that workspace the house.
 * [User-approved change to house/credential-isolation logic, 2026-07-16.]
 */
export function workspaceHasOwnerMember(workspaceId: string): boolean {
  for (const m of store.memberships) {
    if (m.workspaceId !== workspaceId || m.role !== "owner") continue;
    const u = store.users.get(m.userId);
    if (u && isOwnerEmail(u.email)) return true;
  }
  return false;
}

/** A workspace's owner (id + name + email), for background jobs acting on its behalf —
 *  e.g. the JD Sourcing auto-send stamping the OS Text campaign's recruiter fields. */
export async function workspaceOwner(workspaceId: string): Promise<{ userId: string; name: string; email: string } | null> {
  await ensureAuthReady();
  for (const m of store.memberships) {
    if (m.workspaceId !== workspaceId || m.role !== "owner") continue;
    const u = store.users.get(m.userId);
    if (u) return { userId: m.userId, name: u.name || "", email: u.email };
  }
  return null;
}

/** A workspace's stable email-domain label: its auto-join domain when set, else
 *  its owner's email domain. Workspace IDS drift across auth churn (2026-07-16
 *  incident) but the company's mail domain doesn't, so shared multi-tenant
 *  engines (OS Text) tag rows with this instead of the raw id. */
export async function workspaceTenantDomain(workspaceId: string): Promise<string | null> {
  await ensureAuthReady();
  const ws = store.workspaces.get(workspaceId);
  const d = (ws?.domain || "").trim().toLowerCase();
  if (d) return d;
  const owner = await workspaceOwner(workspaceId);
  return owner?.email.split("@")[1]?.trim().toLowerCase() || null;
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

/**
 * Re-bind an authed context onto another workspace the same user belongs to.
 * PORTAL ISOLATION uses this: a session whose stored workspace does not match
 * the portal host it arrives on is re-scoped to the user's workspace ON that
 * portal. Never persisted - the wall is per-request, so one browser can hold
 * the house portal and a tenant portal in two tabs without the stored session
 * flip-flopping between workspaces.
 */
export function rescopeContext(ctx: AuthResult, workspaceId: string): AuthResult | null {
  if (ctx.workspace.id === workspaceId) return ctx;
  const user = store.users.get(ctx.user.id);
  const ws = store.workspaces.get(workspaceId);
  if (!user || !ws || store.suspended.has(ws.id)) return null;
  const m = store.memberships.find((x) => x.userId === user.id && x.workspaceId === workspaceId);
  if (!m) return null;
  return result(user, ws, m.role, ctx.session);
}

/** Workspace ids this user belongs to, highest role first (owner, admin, rest). */
export function membershipWorkspaceIds(userId: string): string[] {
  const rank: Record<string, number> = { owner: 0, admin: 1 };
  return store.memberships
    .filter((m) => m.userId === userId)
    .sort((a, b) => (rank[a.role] ?? 9) - (rank[b.role] ?? 9))
    .map((m) => m.workspaceId);
}

/** Read the Bearer / cookie session token off a request. */
export function tokenFromRequest(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)ros_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/* ---------------- trial / billing ---------------- */

export interface TrialStatus {
  /** Currently inside the free trial window. */
  onTrial: boolean;
  /** On a paid plan. */
  paid: boolean;
  /** Whole days left in the trial (0 once it ends). */
  daysLeft: number;
  /** Trial ended AND no paid plan -> the admin portal should prompt to subscribe. */
  expired: boolean;
  trialEndsAt?: string;
}

/**
 * Trial state for a workspace. Legacy workspaces (no trialEndsAt) are
 * grandfathered: never on a trial clock, never expired. Paid workspaces are
 * always good. Otherwise we count down to trialEndsAt.
 */
export function trialStatus(ws: Workspace): TrialStatus {
  if (ws.paid) return { onTrial: false, paid: true, daysLeft: 0, expired: false, trialEndsAt: ws.trialEndsAt };
  if (!ws.trialEndsAt) return { onTrial: false, paid: false, daysLeft: 0, expired: false };
  const msLeft = Date.parse(ws.trialEndsAt) - Date.now();
  const daysLeft = Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)));
  return { onTrial: msLeft > 0, paid: false, daysLeft, expired: msLeft <= 0, trialEndsAt: ws.trialEndsAt };
}

/**
 * Mark a workspace paid / unpaid. This is the seam a real payment processor
 * (Stripe) calls once a subscription is active; until that's wired, the billing
 * route flips it directly. Promotes a trial workspace to the team plan.
 */
export function setWorkspacePaid(workspaceId: string, paid: boolean): TrialStatus | null {
  const ws = store.workspaces.get(workspaceId);
  if (!ws) return null;
  ws.paid = paid;
  if (paid && (ws.plan === "trial" || ws.plan === "demo")) ws.plan = "team";
  persist();
  return trialStatus(ws);
}

/**
 * Owner-console seam: move a workspace between plans. Activating a demo
 * workspace (demo -> team/enterprise) is how the operator turns on the live
 * feature sets after setting the customer up; capabilities are computed
 * per-request from the plan, so the change is live on the customer's next call.
 */
export function setWorkspacePlan(workspaceId: string, plan: Workspace["plan"]): Workspace | null {
  const ws = store.workspaces.get(workspaceId);
  if (!ws) return null;
  ws.plan = plan;
  persist();
  return ws;
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

  // Self-serve signups land on the DEMO plan: they can walk the portal, but the
  // live data-network feature sets stay dark until the operator activates the
  // workspace from the owner console (or it converts to a paid plan). Only the
  // operator's own allow-listed email provisions at full strength.
  const selfServe = !isOwnerEmail(user.email);
  const ws: Workspace = {
    id: rid("ws"),
    // Personal (free-email) workspaces are named after the person who created it,
    // by FIRST name — "Ryan's Workspace" — not the full name or an email/username.
    // Corporate-domain workspaces keep the company name.
    name: corporate ? titleCase(domain.split(".")[0]) : `${titleCase(firstName(user.name))}'s Workspace`,
    domain: corporate ? domain : undefined,
    plan: selfServe ? "demo" : corporate ? "enterprise" : "trial",
    createdAt: nowIso(),
    // Every new admin workspace starts a 14-day free trial — full access, no card
    // required until it ends.
    trialEndsAt: isoPlusHours(24 * 14),
    paid: false,
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
  const brand = await mailBrandForRecipient(user.email);
  await sendWorkspaceEmail(user.email, `Verify your ${brand.name} email`,
    `Confirm your email: ${brand.base}/verify?token=${t.token}`, brand.workspaceId, { critical: true });
}

/** Email seam. Wire SMTP / Resend / SES here; logs in the reference build. */
/**
 * Sends a real email when RESEND_API_KEY is set (Resend HTTP API), otherwise
 * logs to the console for local dev. EMAIL_FROM controls the sender; it must be
 * a verified domain/address in your Resend account (e.g. "RecruitersOS
 * <no-reply@recruitersos.co>").
 */
async function sendEmail(to: string, subject: string, body: string, fromOverride?: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  const from = fromOverride || process.env.EMAIL_FROM || "RecruitersOS <onboarding@resend.dev>";
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

/* ---------------- email health / diagnostics (owner-only) ---------------- */

/** Whether outbound email is wired, and the sender on file. No secrets leaked. */
export function emailConfig(): { configured: boolean; from: string } {
  return {
    configured: Boolean(process.env.RESEND_API_KEY),
    from: process.env.EMAIL_FROM || "RecruitersOS <onboarding@resend.dev>",
  };
}

export interface EmailDiagnostic {
  ok: boolean;
  /** "no_provider" | "sent" | "rejected" | "error" */
  reason: string;
  status?: number;
  detail?: string;
  from: string;
  to: string;
}

/**
 * Send a real test email and report exactly what happened — so the owner can
 * confirm deliverability (or see the precise Resend rejection, e.g. an
 * unverified sender domain) without guessing. Mirrors sendEmail's transport.
 */
export async function sendDiagnosticEmail(to: string): Promise<EmailDiagnostic> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "RecruitersOS <onboarding@resend.dev>";
  if (!key) {
    return { ok: false, reason: "no_provider", from, to,
      detail: "RESEND_API_KEY is not set in production — emails are only logged, never sent." };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from, to: [to],
        subject: "RecruitersOS email test",
        text: "This is a test from your RecruitersOS owner console. If you received this, password-reset and verification emails will deliver.",
        html: "This is a test from your RecruitersOS owner console. If you received this, password-reset and verification emails will deliver.",
      }),
    });
    if (res.ok) return { ok: true, reason: "sent", status: res.status, from, to };
    const detail = await res.text().catch(() => "");
    return { ok: false, reason: "rejected", status: res.status, detail, from, to };
  } catch (e) {
    return { ok: false, reason: "error", detail: (e as Error).message, from, to };
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
  // Never expose the password hash OR the 2FA secret/recovery hashes to clients.
  // hasPassword is a safe boolean the portal uses to drive the change-password UI.
  const { passwordHash: _omit, twoFactor: _tf, ...safe } = user;
  return { user: { ...safe, hasPassword: Boolean(user.passwordHash) }, workspace, role, capabilities: capabilitiesFor(role, workspace.plan), session };
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

/**
 * Public email seam reused by team invites and candidate-facing mail. When a
 * workspaceId is given and that workspace speaks as a white-label brand (its
 * branding record OR a flagship host preset, e.g. Lume), the email is sent
 * through the WORKSPACE'S OWN MAILBOX over SMTP, from its own domain under its
 * brand name, so a customer's correspondence carries NO reference to the house
 * (recruitersos.co). A white-label workspace with no mailbox creds gets the
 * send BLOCKED (logged loudly); it NEVER falls back to the house sender.
 * Unbranded workspaces use the house Resend sender as before.
 */
export async function sendWorkspaceEmail(
  to: string,
  subject: string,
  body: string,
  workspaceId?: string,
  opts?: { critical?: boolean },
): Promise<void> {
  if (workspaceId) {
    try {
      const { notifyBrand } = await import("../outbound/brand");
      const brand = await notifyBrand(workspaceId);
      if (brand.whiteLabel) {
        const sent = await sendBrandedEmail(workspaceId, brand.name, to, subject, body);
        if (sent) return;
        // FAIL-SAFE: the tenant's own mailbox is broken or unconfigured. Routine
        // mail is dropped here (a white-label send is never silently rebranded).
        // But AUTH-CRITICAL mail (password reset, sign-in link, email verify)
        // must NEVER be lost: a lost auth email is a permanent lockout, which is
        // strictly worse than the reset arriving from the house address. So we
        // fail over to the house sender. The link inside still points at the
        // tenant's own domain, so the flow is correct; only the From differs.
        if (!opts?.critical) return;
        console.error(
          `[email] FAIL-SAFE: white-label mailbox for workspace ${workspaceId} could not send an auth email to ${to} :: "${subject}". Delivering via the house sender so the user is not locked out. Fix the tenant's BRAND_SMTP/RESUME_INBOX creds in Setup.`,
        );
      }
    } catch (e) {
      console.error("[email] brand resolve failed, using house sender:", (e as Error).message);
    }
  }
  await sendEmail(to, subject, body);
}

/** Map an IMAP host / mailbox address to its SMTP submission host. */
function smtpHostFor(imapHost: string, user: string): string {
  const h = (imapHost || "").toLowerCase();
  if (h === "imap.gmail.com") return "smtp.gmail.com";
  if (h === "outlook.office365.com" || h === "imap-mail.outlook.com") return "smtp.office365.com";
  if (h.startsWith("imap.")) return "smtp." + h.slice(5);
  const domain = (user.split("@")[1] || "").toLowerCase();
  if (domain === "gmail.com" || domain === "googlemail.com") return "smtp.gmail.com";
  if (["outlook.com", "hotmail.com", "live.com", "office365.com"].includes(domain)) return "smtp.office365.com";
  if (domain === "yahoo.com") return "smtp.mail.yahoo.com";
  // Google Workspace / custom domains most often sit on Gmail's SMTP; an
  // explicit BRAND_SMTP_HOST always wins over this guess.
  return domain ? "smtp.gmail.com" : "";
}

/**
 * White-label transport: the workspace's own mailbox over SMTP. Creds come from
 * the workspace credential store (Setup): BRAND_SMTP_USER/PASS/HOST/PORT plus
 * BRAND_MAIL_FROM, falling back to the RESUME_INBOX_* mailbox (the same app
 * password works for SMTP on Gmail/Outlook).
 *
 * Returns TRUE only when the mail was actually handed to the tenant's SMTP.
 * Missing creds or a send failure return FALSE (and are logged) so the caller
 * can decide what to do: routine mail is still dropped (a white-label send is
 * never SILENTLY downgraded to the house brand), but AUTH-CRITICAL mail uses
 * the returned flag to fail over to the house sender rather than lock the user
 * out. See sendWorkspaceEmail's `critical` option.
 */
async function sendBrandedEmail(
  workspaceId: string,
  brandName: string,
  to: string,
  subject: string,
  body: string,
): Promise<boolean> {
  const { withWorkspaceCreds } = await import("../connected");
  const { cred } = await import("../providers/http");
  const c = await withWorkspaceCreds(workspaceId, () => ({
    user: (cred("BRAND_SMTP_USER") || cred("RESUME_INBOX_USER")).trim(),
    pass: (cred("BRAND_SMTP_PASS") || cred("RESUME_INBOX_PASS")).trim(),
    host: cred("BRAND_SMTP_HOST").trim(),
    port: Number(cred("BRAND_SMTP_PORT")) || 0,
    from: cred("BRAND_MAIL_FROM").trim(),
    imapHost: cred("RESUME_INBOX_HOST").trim(),
  }));
  if (!c.user || !c.pass) {
    console.error(
      `[email] white-label workspace ${workspaceId} has no mailbox creds (set BRAND_SMTP_USER/PASS or RESUME_INBOX_USER/PASS in Setup) -> ${to} :: "${subject}"`,
    );
    return false;
  }
  const host = c.host || smtpHostFor(c.imapHost, c.user);
  const port = c.port || 587;
  try {
    const nodemailer = (await import("nodemailer")).default;
    const transport = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user: c.user, pass: c.pass },
    });
    await transport.sendMail({
      from: c.from || `${brandName} <${c.user}>`,
      to,
      subject,
      text: body,
      html: body
        .split("\n")
        .map((line) => line.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1">$1</a>'))
        .join("<br>"),
    });
    console.info(`[email] white-label send via ${host} as ${c.user} -> ${to} :: ${subject}`);
    return true;
  } catch (e) {
    console.error(`[email] white-label SMTP send failed (${host}, ${c.user} -> ${to}):`, (e as Error).message);
    return false;
  }
}

/**
 * Probe a white-label workspace's mailbox transport WITHOUT sending mail, so the
 * owner console can flag a broken tenant sender BEFORE it silently drops a
 * password reset. Verifies creds exist and the SMTP server accepts the login.
 */
export async function checkWorkspaceMailbox(
  workspaceId: string,
): Promise<{ configured: boolean; ok: boolean; host?: string; user?: string; detail?: string }> {
  const { withWorkspaceCreds } = await import("../connected");
  const { cred } = await import("../providers/http");
  const c = await withWorkspaceCreds(workspaceId, () => ({
    user: (cred("BRAND_SMTP_USER") || cred("RESUME_INBOX_USER")).trim(),
    pass: (cred("BRAND_SMTP_PASS") || cred("RESUME_INBOX_PASS")).trim(),
    host: cred("BRAND_SMTP_HOST").trim(),
    port: Number(cred("BRAND_SMTP_PORT")) || 0,
    imapHost: cred("RESUME_INBOX_HOST").trim(),
  }));
  if (!c.user || !c.pass) return { configured: false, ok: false, detail: "No BRAND_SMTP/RESUME_INBOX mailbox creds saved in Setup." };
  const host = c.host || smtpHostFor(c.imapHost, c.user);
  const port = c.port || 587;
  try {
    const nodemailer = (await import("nodemailer")).default;
    const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user: c.user, pass: c.pass } });
    await transport.verify();
    return { configured: true, ok: true, host, user: c.user };
  } catch (e) {
    return { configured: true, ok: false, host, user: c.user, detail: (e as Error).message.slice(0, 200) };
  }
}

/** The brand a recipient's auth mail should speak as (their primary workspace's). */
async function mailBrandForRecipient(
  email: string,
): Promise<{ workspaceId?: string; name: string; base: string }> {
  try {
    const u = userByEmail(email);
    const m = u ? store.memberships.find((x) => x.userId === u.id) : undefined;
    if (m) {
      const { notifyBrand } = await import("../outbound/brand");
      const b = await notifyBrand(m.workspaceId);
      return { workspaceId: m.workspaceId, name: b.name, base: b.appUrl };
    }
  } catch {}
  return { name: "RecruitersOS", base: appUrl() };
}
function normEmail(e: string): string {
  return e.trim().toLowerCase();
}
function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function firstName(s: string): string {
  return (s || "").trim().split(/\s+/)[0] || "";
}
function appUrl(): string {
  return process.env.RECRUITEROS_APP_URL ?? "https://recruitersos.co";
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
