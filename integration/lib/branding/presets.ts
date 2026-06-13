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
