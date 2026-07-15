/**
 * RecruitersOS · Ayrshare provider (LinkedIn Poster's publishing engine)
 *
 * Ayrshare is the OFFICIAL-API path to LinkedIn feed posting: it holds the
 * LinkedIn partner access, each recruiter links their own account through
 * LinkedIn OAuth (no cookies, no session automation, no ban risk), and we
 * publish through one REST API. This keeps RecruitersOS on the compliant side
 * of the line the LinkedIn outreach engine deliberately walks elsewhere.
 *
 * Env:
 *   AYRSHARE_API_KEY      required to publish (Bearer token).
 *   AYRSHARE_DOMAIN       optional, Business plan: the domain registered for
 *                         generateJWT single-sign-on linking pages.
 *   AYRSHARE_PRIVATE_KEY  optional, Business plan: the RSA private key for
 *                         generateJWT ("\n" escapes are unfolded here).
 *
 * Multi-user: on the Business plan every workspace gets its own Ayrshare
 * "user profile" (a profileKey) so each recruiter links THEIR LinkedIn. All
 * calls accept an optional profileKey and fall back to the primary account,
 * which is exactly right for a single-recruiter workspace on a smaller plan.
 */

const BASE = "https://api.ayrshare.com/api";

export function ayrshareConfigured(): boolean {
  return !!(process.env.AYRSHARE_API_KEY ?? "").trim();
}

/** Whether the Business-plan SSO-linking envs are present (profileKey linking). */
export function ayrshareLinkingConfigured(): boolean {
  return !!(process.env.AYRSHARE_DOMAIN && process.env.AYRSHARE_PRIVATE_KEY);
}

function headers(profileKey?: string): Record<string, string> {
  const key = (process.env.AYRSHARE_API_KEY ?? "").trim();
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
  };
  if (profileKey) h["Profile-Key"] = profileKey;
  return h;
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  if (!ayrshareConfigured()) {
    throw Object.assign(new Error("ayrshare_not_configured: set AYRSHARE_API_KEY"), { status: 409 });
  }
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const detail = summarizeError(json) || text.slice(0, 300) || `HTTP ${res.status}`;
    throw Object.assign(new Error(detail), { status: res.status });
  }
  return json as T;
}

/** Pull the human-readable message out of Ayrshare's several error shapes. */
function summarizeError(j: unknown): string {
  if (!j || typeof j !== "object") return "";
  const o = j as Record<string, unknown>;
  if (typeof o.message === "string") return o.message;
  if (Array.isArray(o.errors) && o.errors.length) {
    const e = o.errors[0] as Record<string, unknown>;
    return String(e.message ?? e.code ?? "ayrshare_error");
  }
  if (Array.isArray(o.posts) && o.posts.length) {
    const p = o.posts[0] as Record<string, unknown>;
    if (p.status === "error") return String(p.message ?? "post_error");
  }
  return "";
}

export interface AyrshareAccountStatus {
  configured: boolean;
  /** LinkedIn linked on this profile? */
  linkedinConnected: boolean;
  /** All linked platforms, for the settings card. */
  activeSocialAccounts: string[];
  /** Display name Ayrshare reports for the linked account, when present. */
  displayNames: Array<{ platform: string; displayName?: string; profileUrl?: string }>;
  error?: string;
}

/** Linked-account status for the workspace's profile (or the primary account). */
export async function getAccountStatus(profileKey?: string): Promise<AyrshareAccountStatus> {
  if (!ayrshareConfigured()) {
    return { configured: false, linkedinConnected: false, activeSocialAccounts: [], displayNames: [] };
  }
  try {
    const u = await call<{
      activeSocialAccounts?: string[];
      displayNames?: Array<{ platform: string; displayName?: string; profileUrl?: string }>;
    }>("/user", { method: "GET", headers: headers(profileKey) });
    const active = u.activeSocialAccounts ?? [];
    return {
      configured: true,
      linkedinConnected: active.includes("linkedin"),
      activeSocialAccounts: active,
      displayNames: (u.displayNames ?? []).filter((d) => d.platform === "linkedin"),
    };
  } catch (e) {
    return {
      configured: true, linkedinConnected: false, activeSocialAccounts: [], displayNames: [],
      error: (e as Error).message,
    };
  }
}

/** Create a per-workspace Ayrshare user profile (Business plan). Returns its profileKey. */
export async function createProfile(title: string): Promise<string> {
  const r = await call<{ profileKey?: string; status?: string }>("/profiles", {
    method: "POST", headers: headers(), body: JSON.stringify({ title }),
  });
  if (!r.profileKey) throw new Error("ayrshare_profile_create_failed");
  return r.profileKey;
}

/**
 * Short-lived SSO URL where the recruiter links their LinkedIn account to the
 * workspace's Ayrshare profile (Business plan; needs domain + private key).
 */
export async function generateLinkUrl(profileKey: string): Promise<string> {
  if (!ayrshareLinkingConfigured()) {
    throw Object.assign(new Error("ayrshare_linking_not_configured: set AYRSHARE_DOMAIN and AYRSHARE_PRIVATE_KEY"), { status: 409 });
  }
  const privateKey = (process.env.AYRSHARE_PRIVATE_KEY as string).replace(/\\n/g, "\n");
  const r = await call<{ url?: string }>("/profiles/generateJWT", {
    method: "POST", headers: headers(),
    body: JSON.stringify({ domain: process.env.AYRSHARE_DOMAIN, privateKey, profileKey }),
  });
  if (!r.url) throw new Error("ayrshare_jwt_failed");
  return r.url;
}

export interface AyrsharePostResult {
  id: string;
  postUrl?: string;
}

/**
 * Publish a LinkedIn post now. `mediaUrls` must be PUBLICLY reachable (we hand
 * Ayrshare the /api/linkedin/poster/media/<id> URL on the live domain).
 */
export async function publishLinkedInPost(opts: {
  text: string;
  mediaUrls?: string[];
  profileKey?: string;
}): Promise<AyrsharePostResult> {
  const payload: Record<string, unknown> = {
    post: opts.text,
    platforms: ["linkedin"],
  };
  if (opts.mediaUrls?.length) payload.mediaUrls = opts.mediaUrls;
  const r = await call<{
    status?: string;
    id?: string;
    postIds?: Array<{ platform?: string; id?: string; postUrl?: string; status?: string; message?: string }>;
    errors?: unknown[];
  }>("/post", { method: "POST", headers: headers(opts.profileKey), body: JSON.stringify(payload) });

  const li = (r.postIds ?? []).find((p) => p.platform === "linkedin");
  if (r.status === "error" || (li && li.status === "error")) {
    throw new Error(li?.message ?? summarizeError(r) ?? "ayrshare_post_failed");
  }
  return { id: li?.id ?? r.id ?? "", postUrl: li?.postUrl };
}
