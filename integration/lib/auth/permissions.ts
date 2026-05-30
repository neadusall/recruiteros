/**
 * RecruiterOS · Auth · Permissions (RBAC)
 *
 * Three roles, one capability matrix. The owner creates the workspace; admins
 * run it and add recruiters; recruiters (members) do the daily work but are
 * walled off from anything that touches money, credentials, or the org itself.
 *
 * Discretion on the member (recruiter) wall, by design:
 *   CAN:    work the Response inbox, the pipeline, run sourcing, draft + send
 *           their own outreach, use the voice dialer, read analytics + content.
 *   CANNOT: see or manage the Telnyx / SMS account, API keys, sending domains,
 *           LinkedIn account credentials, the ATS connection, billing, the
 *           integrations pre-flight, or the team (add/remove/role users).
 *
 * Sensitive infrastructure (Telnyx especially) is owner/admin only.
 */

import type { Role } from "./types";

export type Capability =
  // operate (recruiters included)
  | "overview:view"
  | "response:view"
  | "response:act"
  | "prospects:view"
  | "prospects:edit"
  | "sourcing:run"
  | "campaigns:view"
  | "campaigns:create"
  | "outreach:send"
  | "voice:dial"          // use the dialer, NOT manage the Telnyx account
  | "content:view"
  | "content:manage"
  | "analytics:view"
  // manage (admin/owner only)
  | "campaigns:activate"
  | "accounts:manage"     // LinkedIn accounts + sending domains
  | "apikeys:manage"
  | "telnyx:manage"       // the Telnyx/SMS account + credentials
  | "integrations:manage" // the Connected pre-flight
  | "ats:manage"
  | "team:manage"         // add / remove / re-role recruiters
  // owner only
  | "billing:manage"
  | "workspace:delete";

/** Capabilities every recruiter (member) gets, the floor for all roles. */
const MEMBER: Capability[] = [
  "overview:view", "response:view", "response:act",
  "prospects:view", "prospects:edit", "sourcing:run",
  "campaigns:view", "campaigns:create", "outreach:send",
  "voice:dial", "content:view", "analytics:view",
];

/** Admins get everything members get, plus running the workspace. */
const ADMIN: Capability[] = [
  ...MEMBER,
  "content:manage", "campaigns:activate", "accounts:manage",
  "apikeys:manage", "telnyx:manage", "integrations:manage",
  "ats:manage", "team:manage",
];

/** Owners get everything, including billing + deleting the workspace. */
const OWNER: Capability[] = [...ADMIN, "billing:manage", "workspace:delete"];

export const ROLE_CAPABILITIES: Record<Role, Capability[]> = {
  member: MEMBER,
  admin: ADMIN,
  owner: OWNER,
};

/** All capabilities a role holds. */
export function capabilitiesFor(role: Role): Capability[] {
  return ROLE_CAPABILITIES[role] ?? MEMBER;
}

/** Can this role perform this capability? */
export function can(role: Role, cap: Capability): boolean {
  return capabilitiesFor(role).includes(cap);
}

/** Map a sensitive Connected integration id to the capability that gates it. */
export const INTEGRATION_CAPABILITY: Record<string, Capability> = {
  telnyx: "telnyx:manage",
  taltxt: "telnyx:manage",
  loxo: "ats:manage",
};

/** Which roles an admin is allowed to assign (admins cannot mint owners). */
export const ASSIGNABLE_ROLES: Record<Role, Role[]> = {
  owner: ["admin", "member"],
  admin: ["member"],
  member: [],
};
