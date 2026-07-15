/**
 * RecruitersOS · LinkedIn OS
 * Canonical person identity: one record per human, linking every RecruitersOS
 * face of that human (candidate prospect, BD prospect, warehouse contact,
 * LinkedIn profile, emails, phones). All engine decisions (reply stop, contact
 * pressure, collision prevention, dedup) key on this id, never on a channel
 * handle, so "Sarah the candidate" and "Sarah the prospect" are one Sarah.
 */

import { rid, nowIso } from "../../core/ids";
import { normalizePhone } from "../../core/repository";
import { identities, withEngineLock } from "./store";
import type { PersonIdentity } from "./types";

export function normalizeEmail(e?: string): string | undefined {
  const t = (e ?? "").trim().toLowerCase();
  return t.includes("@") ? t : undefined;
}

/** Canonical LinkedIn profile URL: https + www stripped, /in/slug, no query. */
export function normalizeLinkedinUrl(u?: string): string | undefined {
  const t = (u ?? "").trim();
  if (!t) return undefined;
  const m = t.match(/linkedin\.com\/(in|sales\/lead|sales\/people|talent\/profile)\/([^/?#]+)/i);
  if (m) return `linkedin.com/${m[1].toLowerCase()}/${decodeURIComponent(m[2]).toLowerCase()}`;
  if (/^[a-z0-9%_.-]+$/i.test(t) && !t.includes("@")) return `linkedin.com/in/${t.toLowerCase()}`;
  return undefined;
}

export function normalizePhoneHandle(p?: string): string | undefined {
  const t = (p ?? "").trim();
  if (!t || !/\d{6,}/.test(t)) return undefined;
  return normalizePhone(t);
}

export interface IdentityHint {
  email?: string;
  linkedinUrl?: string;
  phone?: string;
  fullName?: string;
  company?: string;
  title?: string;
  prospectId?: string;
  dataRecordId?: string;
  providerProfileId?: string;
  /** Which LinkedIn product surfaced the provider id. */
  providerProduct?: "classic" | "salesNavigator" | "recruiter";
}

function push<T>(arr: T[], v?: T): void {
  if (v !== undefined && v !== null && v !== ("" as unknown as T) && !arr.includes(v)) arr.push(v);
}

function matches(p: PersonIdentity, h: {
  email?: string; li?: string; phone?: string; prospectId?: string; providerProfileId?: string;
}): boolean {
  if (h.email && p.emails.includes(h.email)) return true;
  if (h.li && p.linkedinUrls.includes(h.li)) return true;
  if (h.phone && p.phones.includes(h.phone)) return true;
  if (h.prospectId && p.prospectIds.includes(h.prospectId)) return true;
  if (h.providerProfileId && (
    p.providerIds.classic === h.providerProfileId ||
    p.providerIds.salesNavigator === h.providerProfileId ||
    p.providerIds.recruiter === h.providerProfileId
  )) return true;
  return false;
}

/**
 * Resolve (or create) the canonical identity for a set of handles, merging the
 * new handles onto the match. Serialized under the engine lock so two
 * concurrent enrollments of the same person cannot fork duplicate identities.
 */
export async function resolveIdentity(workspaceId: string, hint: IdentityHint): Promise<PersonIdentity> {
  const email = normalizeEmail(hint.email);
  const li = normalizeLinkedinUrl(hint.linkedinUrl);
  const phone = normalizePhoneHandle(hint.phone);
  return withEngineLock(async () => {
    const all = await identities.all();
    let p = all.find((x) => x.workspaceId === workspaceId &&
      matches(x, { email, li, phone, prospectId: hint.prospectId, providerProfileId: hint.providerProfileId }));
    // Last resort: exact name + company (both present) inside the workspace.
    if (!p && hint.fullName && hint.company) {
      const nk = hint.fullName.trim().toLowerCase();
      const ck = hint.company.trim().toLowerCase();
      p = all.find((x) => x.workspaceId === workspaceId &&
        (x.fullName ?? "").trim().toLowerCase() === nk &&
        (x.company ?? "").trim().toLowerCase() === ck);
    }
    if (!p) {
      p = {
        id: rid("pid"),
        workspaceId,
        prospectIds: [], dataRecordIds: [], emails: [], phones: [], linkedinUrls: [],
        providerIds: {},
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      all.push(p);
    }
    push(p.emails, email);
    push(p.phones, phone);
    push(p.linkedinUrls, li);
    push(p.prospectIds, hint.prospectId);
    push(p.dataRecordIds, hint.dataRecordId);
    if (hint.fullName && !p.fullName) p.fullName = hint.fullName.trim();
    if (hint.company && !p.company) p.company = hint.company.trim();
    if (hint.title && !p.title) p.title = hint.title.trim();
    if (hint.providerProfileId) {
      const product = hint.providerProduct ?? "classic";
      if (!p.providerIds[product]) p.providerIds[product] = hint.providerProfileId;
    }
    p.updatedAt = nowIso();
    identities.save();
    return p;
  });
}

export async function getIdentity(workspaceId: string, id: string): Promise<PersonIdentity | null> {
  const all = await identities.all();
  return all.find((x) => x.workspaceId === workspaceId && x.id === id) ?? null;
}

export async function findIdentityByProviderProfile(
  workspaceId: string,
  providerProfileId: string,
): Promise<PersonIdentity | null> {
  const all = await identities.all();
  return all.find((x) => x.workspaceId === workspaceId && matches(x, { providerProfileId })) ?? null;
}

export async function findIdentityByHandle(workspaceId: string, handle: string): Promise<PersonIdentity | null> {
  const email = normalizeEmail(handle);
  const li = normalizeLinkedinUrl(handle);
  const phone = normalizePhoneHandle(handle);
  if (!email && !li && !phone) return null;
  const all = await identities.all();
  return all.find((x) => x.workspaceId === workspaceId && matches(x, { email, li, phone })) ?? null;
}

/** Record the accepted-connection relationship on the identity. */
export async function markConnected(workspaceId: string, identityId: string, at: string): Promise<void> {
  const all = await identities.all();
  const p = all.find((x) => x.workspaceId === workspaceId && x.id === identityId);
  if (!p) return;
  p.connectionDegree = 1;
  p.connectedAt = at;
  p.updatedAt = nowIso();
  identities.save();
}

export async function listIdentities(workspaceId: string): Promise<PersonIdentity[]> {
  const all = await identities.all();
  return all.filter((x) => x.workspaceId === workspaceId);
}
