/**
 * RecruitersOS · Built-in white-label brand presets
 *
 * Per-workspace branding (lib/branding) is the source of truth a customer edits
 * in Setup → Branding. But a flagship white-label tenant should look like itself
 * from the very first paint — before any workspace record exists and on the
 * public, pre-login screens that resolve purely by HOST.
 *
 * This is that fallback: a small host -> brand map, consulted only when no
 * workspace has claimed the domain yet. A real workspace branding record always
 * wins over a preset. Logos are served as static assets (synced from repo-root
 * /assets to public/assets), so these are just paths.
 */

export interface BrandPreset {
  brandName: string;
  /** The portal host this brand's links should point at (e.g. app.lumesp.com). */
  appHost: string;
  /** Logo for the DARK appearance (white text) — used on the dark login screens. */
  logoUrl: string;
  /** Logo for the LIGHT appearance (navy text) — used in the light-theme portal. */
  logoLightUrl: string;
  /** Square mark for the browser tab / favicon. */
  faviconUrl: string;
  accentColor: string;
  logoScale?: number;
}

/** Lume Search Partners — app.lumesp.com white-label. */
const LUME: BrandPreset = {
  brandName: "Lume Search Partners",
  appHost: "app.lumesp.com",
  logoUrl: "/assets/img/lume-wordmark-white.svg",
  logoLightUrl: "/assets/img/lume-wordmark-navy.svg",
  faviconUrl: "/assets/img/lume-favicon.svg",
  accentColor: "#0080A0",
  logoScale: 1,
};

/** Exact-host and domain-suffix routes to a built-in brand. */
function matchPreset(host: string): BrandPreset | null {
  const h = (host || "").toLowerCase().replace(/:\d+$/, "");
  if (h === "lumesp.com" || h === "app.lumesp.com" || h.endsWith(".lumesp.com")) return LUME;
  return null;
}

export function presetForHost(host: string): BrandPreset | null {
  return matchPreset(host);
}

/** Every built-in white-label preset (used to keep tenant-branded assets, e.g.
 *  warm-up domains named after a tenant, off the house portal's views). */
export function allBrandPresets(): BrandPreset[] {
  return [LUME];
}

/* ------------------------------------------------------------------ */
/* THE portal-split rule: which sending domains (and therefore which   */
/* mailboxes) belong to which portal. Every panel that lists shared    */
/* sending infrastructure (warm-up fleet, DNS health, drill-downs)     */
/* must route through these two functions, never a local copy.         */
/* ------------------------------------------------------------------ */

/** Brand token a domain is matched on: "Lume Search Partners" -> "lume". */
export function brandToken(brandName: string): string {
  return (brandName.split(/\s+/)[0] || "").toLowerCase();
}

/** A brand owns a sending domain when its token appears ANYWHERE in the
 *  name: "lume" claims lumesp.com and artlumesearchgroup.com alike. A
 *  domain a brand owns shows ONLY on that brand's portal; everything
 *  unclaimed shows only on the house portal. Mailboxes follow their domain. */
export function brandOwnsDomain(domain: string, token: string): boolean {
  return !!token && (domain || "").toLowerCase().includes(token);
}
