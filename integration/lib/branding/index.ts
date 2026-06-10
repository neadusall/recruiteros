/**
 * RecruiterOS · Branding (white-label)
 *
 * Per-workspace branding so every account can run the product under its OWN
 * name, logo and domain — the first brick of the white-label model. This is the
 * customer-facing twin of the owner-only AccountMeta store: it holds only what a
 * workspace is allowed to set about how its portal LOOKS, never pricing or notes.
 *
 * The owner's own workspace (ryan@recruiters.co) simply leaves these blank and
 * keeps the default "RecruitersOS" wordmark; a white-label customer (e.g. LUME)
 * uploads a logo, sets a brand name, and points their domain at us.
 *
 * Stored per-workspace and snapshotted with the same durable backend every other
 * module uses, so a customer's branding survives every redeploy.
 */

import { nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";

export interface Branding {
  workspaceId: string;
  /** Customer's logo as a small data URL (or hosted URL). Blank = default wordmark. */
  logoUrl?: string;
  /** Wordmark text shown when there's no logo (e.g. "LUME"). Blank = "RecruitersOS". */
  brandName?: string;
  /**
   * The custom domain a customer wants their portal served on (e.g.
   * app.lumesp.com). Stored here as the source of truth; the host -> workspace
   * routing + TLS is wired at the edge/deploy layer, with this as the lookup.
   */
  customDomain?: string;
  /** Domain ownership/serving state, advanced by the DNS verification step. */
  domainStatus?: "none" | "pending" | "verified" | "live";
  updatedAt: string;
}

/** The shape a workspace is allowed to change about its own branding. */
export type BrandingPatch = Partial<
  Pick<Branding, "logoUrl" | "brandName" | "customDomain" | "domainStatus">
>;

const store = { brand: new Map<string, Branding>() };

const SNAP_KEY = "workspace_branding";
function serialize() {
  return { brand: [...store.brand.entries()] };
}
function hydrate(s: any) {
  if (s?.brand) store.brand = new Map(s.brand);
}
const persist = debouncedSaver(SNAP_KEY, serialize);

let hydrated: Promise<void> | null = null;
export function ensureBrandingReady(): Promise<void> {
  if (!hydrated) {
    hydrated = dbEnabled() ? loadSnapshot<any>(SNAP_KEY).then(hydrate).catch(() => {}) : Promise.resolve();
  }
  return hydrated;
}
void ensureBrandingReady();

/** This workspace's branding (defaults to an empty record = the house brand). */
export async function getBranding(workspaceId: string): Promise<Branding> {
  await ensureBrandingReady();
  return (
    store.brand.get(workspaceId) ?? {
      workspaceId,
      domainStatus: "none",
      updatedAt: nowIso(),
    }
  );
}

/**
 * Save a workspace's branding. Empty-string fields are treated as "clear it"
 * (reset to the house default) rather than ignored, so the portal's Reset button
 * actually removes a custom logo/name.
 */
export async function setBranding(workspaceId: string, patch: BrandingPatch): Promise<Branding> {
  const cur = await getBranding(workspaceId);
  const next: Branding = { ...cur, ...patch, workspaceId, updatedAt: nowIso() };
  // Normalise blanks to undefined so callers fall back to the default wordmark.
  for (const k of ["logoUrl", "brandName", "customDomain"] as const) {
    if (next[k] !== undefined && String(next[k]).trim() === "") next[k] = undefined;
  }
  if (!next.customDomain) next.domainStatus = "none";
  store.brand.set(workspaceId, next);
  persist();
  return next;
}

/** Look up which workspace owns a given custom domain (for host-based routing). */
export async function workspaceForDomain(domain: string): Promise<string | null> {
  await ensureBrandingReady();
  const host = domain.trim().toLowerCase();
  for (const b of store.brand.values()) {
    if (b.customDomain && b.customDomain.toLowerCase() === host) return b.workspaceId;
  }
  return null;
}
