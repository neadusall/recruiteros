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
  /** PBKDF2 hash; never store the raw password. Null for magic-link-only users. */
  passwordHash: string | null;
  emailVerified: boolean;
  createdAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  /** Email domain that auto-joins this workspace (enterprise SSO-lite). */
  domain?: string;
  plan: "trial" | "team" | "enterprise";
  createdAt: string;
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

/** Short-lived token for email verification or magic-link sign-in. */
export interface EmailToken {
  token: string;
  email: string;
  purpose: "verify" | "magic_link";
  expiresAt: string;
}

export interface AuthResult {
  user: Omit<User, "passwordHash">;
  workspace: Workspace;
  role: Role;
  session: Session;
}
