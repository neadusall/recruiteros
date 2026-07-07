/**
 * RecruitersOS · In-Market · SIGNED + EXPIRING share links (Loom-style)
 *
 * The public watch surfaces (/watch page + /api/in-market/watch assets) used to be open by the
 * unguessable key alone. This upgrades them to SIGNED links with an optional expiry: a recipient
 * link carries `exp` (epoch ms; 0 = never) + `sig` = HMAC-SHA256("share:<key>:<exp>") under the
 * server secret. The route verifies both before serving — so a forwarded link can be made to
 * stop working after the TTL, and links can be revoked wholesale by rotating the secret.
 *
 * Secret + convention mirror lib/exttoken (RECRUITEROS_SESSION_SECRET). Operator (authed) access
 * via /api/in-market/video is unaffected — this only governs the public share surface.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

function secret(): string {
  return process.env.RECRUITEROS_SESSION_SECRET || process.env.RECRUITEROS_API_TOKEN || "ros-share-dev-secret";
}

/** Default share lifetime in days (0 = non-expiring). Override with RECRUITEROS_SHARE_TTL_DAYS. */
export const DEFAULT_TTL_DAYS = Math.max(0, Number(process.env.RECRUITEROS_SHARE_TTL_DAYS ?? "45") || 0);

export function signShare(key: string, exp: number): string {
  return createHmac("sha256", secret()).update(`share:${key}:${exp}`).digest("base64url").slice(0, 24);
}

/** Mint an {exp, sig} for a key. ttlDays<=0 → non-expiring (exp=0). */
export function shareToken(key: string, ttlDays: number = DEFAULT_TTL_DAYS): { exp: number; sig: string } {
  const exp = ttlDays > 0 ? Date.now() + Math.round(ttlDays * 86_400_000) : 0;
  return { exp, sig: signShare(key, exp) };
}

/** True when sig matches and (if exp>0) the link hasn't expired. Constant-time compare. */
export function verifyShare(key: string, expRaw: string | null | undefined, sig: string | null | undefined): boolean {
  if (!sig) return false;
  const exp = Number(expRaw ?? "");
  if (!Number.isFinite(exp)) return false;
  if (exp > 0 && Date.now() > exp) return false;
  const expect = signShare(key, exp);
  try {
    const a = Buffer.from(sig), b = Buffer.from(expect);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Canonical public origin for share links (same convention as auth/channels). */
export function appBaseUrl(): string {
  return (process.env.RECRUITEROS_APP_URL ?? "https://recruitersos.co").replace(/\/+$/, "");
}

export interface CompositeShare {
  /** The Loom-style watch page (what goes behind the email teaser). */
  watch: string;
  /** Signed email-teaser GIF. */
  gif: string;
  /** Signed full MP4. */
  mp4: string;
  /** Signed static poster JPEG (frame + play button) — the email thumbnail. */
  poster: string;
  /** Expiry (epoch ms; 0 = never). */
  exp: number;
}

/** Build signed, production-ready share URLs for a composite (PiP) video. */
export function compositeShareUrls(
  key: string,
  meta: { company?: string; roleTitle?: string; ttlDays?: number },
): CompositeShare {
  const { exp, sig } = shareToken(key, meta.ttlDays);
  const auth = `exp=${exp}&sig=${encodeURIComponent(sig)}`;
  const b = appBaseUrl();
  const k = encodeURIComponent(key);
  return {
    watch: `${b}/watch?k=${k}&c=${encodeURIComponent(meta.company || "")}&r=${encodeURIComponent(meta.roleTitle || "")}&${auth}`,
    gif: `${b}/api/in-market/watch?key=${k}&fmt=gif&${auth}`,
    mp4: `${b}/api/in-market/watch?key=${k}&fmt=mp4&${auth}`,
    poster: `${b}/api/in-market/watch?key=${k}&fmt=jpg&${auth}`,
    exp,
  };
}
