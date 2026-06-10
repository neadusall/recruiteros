/**
 * RecruiterOS · Auth
 * Enterprise identity: users, workspaces (orgs), memberships, sessions.
 *
 * Every other module is workspace-scoped, so auth is the root: a user signs up
 * with their work email, which provisions (or joins) a workspace and issues a
 * session. Roles gate who can activate campaigns and manage billing.
 */

export type Role = "owner" | "admin" | "member";

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
}

export interface Workspace {
  id: string;
  name: string;
  /** Email domain that auto-joins this workspace (enterprise SSO-lite). */
  domain?: string;
  plan: "trial" | "team" | "enterprise";
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
  user: Omit<User, "passwordHash">;
  workspace: Workspace;
  role: Role;
  /** Capabilities granted to this role, so the UI shows only what they can use. */
  capabilities: import("./permissions").Capability[];
  session: Session;
}
