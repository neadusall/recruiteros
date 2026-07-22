/**
 * RecruitersOS · Auth
 * Enterprise identity: users, workspaces (orgs), memberships, sessions.
 *
 * Every other module is workspace-scoped, so auth is the root: a user signs up
 * with their work email, which provisions (or joins) a workspace and issues a
 * session. Roles gate who can activate campaigns and manage billing.
 */

export type Role = "owner" | "admin" | "member";

/** Workspace plan. "demo" = self-serve signup on the house site: a walk-around
 *  portal with the live data-network feature sets withheld until the operator
 *  activates the workspace (or it converts to a paid plan). */
export type Plan = "demo" | "trial" | "team" | "enterprise";

export interface User {
  id: string;
  email: string;
  name: string;
  /** PBKDF2 hash; never store the raw password. Null for magic-link / OAuth-only users. */
  passwordHash: string | null;
  emailVerified: boolean;
  createdAt: string;
  /** Captured from LinkedIn sign-in: public profile URL + avatar. */
  linkedinUrl?: string;
  picture?: string;
  /** Optional TOTP second factor. Absent = never set up. */
  twoFactor?: TwoFactor;
}

/** Authenticator-app second factor. `enabled` is false during pending setup
 *  (secret generated but not yet confirmed with a valid code). */
export interface TwoFactor {
  secret: string;            // base32 TOTP secret
  enabled: boolean;
  /** sha256 hashes of the unused one-time recovery codes. */
  recoveryHashes: string[];
  enabledAt?: string;
}

export interface Workspace {
  id: string;
  name: string;
  /** Email domain that auto-joins this workspace (enterprise SSO-lite). */
  domain?: string;
  plan: Plan;
  createdAt: string;
  /** When the free 14-day admin trial ends (ISO). Admin sign-up needs no card
   *  until this date; after it, the workspace must be on a paid plan. Unset for
   *  legacy workspaces created before trials existed — those are grandfathered
   *  (never gated). */
  trialEndsAt?: string;
  /** True once the workspace has an active paid subscription. */
  paid?: boolean;
}

export interface Membership {
  userId: string;
  workspaceId: string;
  role: Role;
}

export interface Session {
  token: string;
  userId: string;
  workspaceId: string;
  createdAt: string;
  expiresAt: string;
}

/** Short-lived token for email verification, magic-link sign-in, or a team invite. */
export interface EmailToken {
  token: string;
  email: string;
  purpose: "verify" | "magic_link" | "invite" | "reset_password";
  expiresAt: string;
  /** Set for invites: the workspace + role the invitee joins. */
  workspaceId?: string;
  role?: Role;
  invitedByName?: string;
}

export interface AuthResult {
  /** hasPassword lets the portal decide whether to ask for a current password
   *  when the user changes it (a passwordless invited/OAuth user has none). */
  user: Omit<User, "passwordHash" | "twoFactor"> & { hasPassword: boolean };
  workspace: Workspace;
  role: Role;
  /** Capabilities granted to this role, so the UI shows only what they can use. */
  capabilities: import("./permissions").Capability[];
  session: Session;
}
