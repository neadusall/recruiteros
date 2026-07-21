/**
 * RecruitersOS · Auth · Permissions (RBAC)
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

import type { Plan, Role } from "./types";

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

/**
 * Capabilities WITHHELD from a demo-plan workspace, whatever the role. Demo is
 * the self-serve signup tier on the house site: a look-around portal with the
 * pipeline, campaigns drafting, analytics and content, but none of the live
 * data-network feature sets (sourcing, texting, dialing, LinkedIn sends) and
 * none of the credential/integration surfaces. Activating the workspace to a
 * real plan (owner console or payment) restores the full matrix instantly:
 * capabilities are computed per-request, never stored on the session.
 */
const DEMO_WITHHELD: Capability[] = [
  "sourcing:run", "outreach:send", "voice:dial",
  "campaigns:activate", "accounts:manage", "apikeys:manage",
  "telnyx:manage", "integrations:manage", "ats:manage",
];

/** All capabilities a role holds on a given plan (plan omitted = full matrix). */
export function capabilitiesFor(role: Role, plan?: Plan): Capability[] {
  const base = ROLE_CAPABILITIES[role] ?? MEMBER;
  if (plan !== "demo") return base;
  return base.filter((c) => !DEMO_WITHHELD.includes(c));
}

/** Can this role perform this capability? */
export function can(role: Role, cap: Capability, plan?: Plan): boolean {
  return capabilitiesFor(role, plan).includes(cap);
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
