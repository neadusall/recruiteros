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

import { randomBytes } from "crypto";
import { promises as dns } from "dns";
import { nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";

export interface Branding {
  workspaceId: string;
  /** Customer's logo as a small data URL (or hosted URL). Blank = default wordmark. */
  logoUrl?: string;
  /** Wordmark text shown when there's no logo (e.g. "LUME"). Blank = "RecruitersOS". */
  brandName?: string;
  /** Accent color (hex, e.g. "#7c5cff") driving the portal's primary/brand color. */
  accentColor?: string;
  /**
   * The custom domain a customer wants their portal served on (e.g.
   * app.lumesp.com). Stored here as the source of truth; the host -> workspace
   * routing + TLS is wired at the edge/deploy layer, with this as the lookup.
   */
  customDomain?: string;
  /** Domain ownership/serving state, advanced by the DNS verification step. */
  domainStatus?: "none" | "pending" | "verified" | "live";
  /** Random per-workspace token the customer publishes as a TXT record to prove ownership. */
  domainToken?: string;
  updatedAt: string;
}

/** The shape a workspace is allowed to change about its own branding. */
export type BrandingPatch = Partial<
  Pick<Branding, "logoUrl" | "brandName" | "accentColor" | "customDomain" | "domainStatus" | "domainToken">
>;

export interface DomainRecord {
  type: "CNAME" | "TXT";
  host: string;
  value: string;
  note: string;
}
export interface DomainInstructions {
  domain: string;
  status: NonNullable<Branding["domainStatus"]>;
  records: DomainRecord[];
}

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
  for (const k of ["logoUrl", "brandName", "accentColor", "customDomain", "domainToken"] as const) {
    if (next[k] !== undefined && String(next[k]).trim() === "") next[k] = undefined;
  }
  if (!next.customDomain) { next.domainStatus = "none"; next.domainToken = undefined; }
  store.brand.set(workspaceId, next);
  persist();
  return next;
}

/** Look up which workspace owns a given custom domain (for host-based routing). */
export async function workspaceForDomain(domain: string): Promise<string | null> {
  await ensureBrandingReady();
  const host = normalizeDomain(domain);
  for (const b of store.brand.values()) {
    if (b.customDomain && b.customDomain.toLowerCase() === host) return b.workspaceId;
  }
  return null;
}

/* ---------------- custom domain lifecycle ---------------- */

/** Where customers point their CNAME. Set WHITE_LABEL_CNAME_TARGET to your app host. */
function cnameTarget(): string {
  return process.env.WHITE_LABEL_CNAME_TARGET || "app.recruitersos.co";
}

/** Normalize user input to a bare hostname (strip scheme/path/trailing dot). */
export function normalizeDomain(input: string): string {
  return (input || "")
    .trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
}

const verifyHost = (domain: string) => "_recruiteros." + domain;

function buildInstructions(
  domain: string,
  status: NonNullable<Branding["domainStatus"]>,
  token: string,
): DomainInstructions {
  return {
    domain,
    status,
    records: [
      { type: "CNAME", host: domain, value: cnameTarget(), note: "Point your domain at the RecruitersOS app." },
      { type: "TXT", host: verifyHost(domain), value: token, note: "Proves you own the domain — required to verify." },
    ],
  };
}

/** Start (or update) a custom domain for a workspace -> pending + DNS instructions. */
export async function setCustomDomain(
  workspaceId: string,
  input: string,
): Promise<{ branding: Branding; instructions: DomainInstructions }> {
  const domain = normalizeDomain(input);
  if (!domain || !domain.includes(".")) throw new Error("invalid_domain");
  const cur = await getBranding(workspaceId);
  const token = cur.domainToken || "ros-verify-" + randomBytes(8).toString("hex");
  const branding = await setBranding(workspaceId, { customDomain: domain, domainStatus: "pending", domainToken: token });
  return { branding, instructions: buildInstructions(domain, "pending", token) };
}

/** Clear a workspace's custom domain (back to the house host). */
export async function clearCustomDomain(workspaceId: string): Promise<Branding> {
  return setBranding(workspaceId, { customDomain: "", domainStatus: "none", domainToken: "" });
}

/** The DNS records a workspace must publish for its current domain (or null). */
export async function domainInstructions(workspaceId: string): Promise<DomainInstructions | null> {
  const b = await getBranding(workspaceId);
  if (!b.customDomain || !b.domainToken) return null;
  return buildInstructions(b.customDomain, b.domainStatus ?? "pending", b.domainToken);
}

/** Verify ownership by looking up the TXT token. On success -> verified. */
export async function verifyCustomDomain(
  workspaceId: string,
): Promise<{ branding: Branding; verified: boolean; error?: string; instructions: DomainInstructions }> {
  const cur = await getBranding(workspaceId);
  const domain = cur.customDomain;
  const token = cur.domainToken;
  if (!domain || !token) throw new Error("no_domain");
  let verified = false;
  let error: string | undefined;
  try {
    const records = await dns.resolveTxt(verifyHost(domain));
    verified = records.some((chunks) => chunks.join("").trim() === token);
    if (!verified) error = "txt_not_found";
  } catch (e: any) {
    error = e?.code === "ENOTFOUND" || e?.code === "ENODATA" ? "txt_not_found" : e?.message || "dns_error";
  }
  const branding = verified ? await setBranding(workspaceId, { domainStatus: "verified" }) : cur;
  return { branding, verified, error, instructions: buildInstructions(domain, branding.domainStatus ?? "pending", token) };
}

/** Public branding for a host (custom-domain login/signup pages). Logo + name only. */
export async function publicBrandingForHost(
  host: string,
): Promise<{ logoUrl?: string; brandName?: string; accentColor?: string } | null> {
  const ws = await workspaceForDomain(host);
  if (!ws) return null;
  const b = await getBranding(ws);
  return { logoUrl: b.logoUrl, brandName: b.brandName, accentColor: b.accentColor };
}
