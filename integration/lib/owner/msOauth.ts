/**
 * RecruitersOS · Owner · Microsoft 365 IMAP access tokens (XOAUTH2)
 *
 * Microsoft permanently disabled basic-auth IMAP (username + password / app password) on
 * work/school accounts, so a mailbox like ryan@lumesp.com cannot be read the way the Gmail
 * inboxes are. The supported route is OAuth2: the sweep authenticates with a short-lived
 * access token minted from an Entra (Azure AD) app instead of a password.
 *
 * APP-ONLY (client credentials) flow, chosen deliberately over the delegated one: the server
 * holds the app's client secret and mints its own token, so the nightly sweep needs no
 * interactive sign-in, nothing to re-consent, and no refresh token that can silently expire.
 * On the tenant side the app is locked to the specific mailbox(es) by an Exchange
 * ApplicationAccessPolicy, so this secret can only ever read the inbox(es) it was scoped to.
 *
 * Required env (set on the box in .env.production):
 *   MS_TENANT_ID       Entra directory (tenant) id
 *   MS_CLIENT_ID       the app registration's application (client) id
 *   MS_CLIENT_SECRET   a client-secret VALUE from that app
 * Optional:
 *   MS_BILLING_MAILBOXES  comma-separated addresses to sweep (e.g. "ryan@lumesp.com")
 *   MS_IMAP_HOST          defaults to outlook.office365.com
 */

/** One cached token per process; Entra tokens live ~1h and are cheap to re-mint. */
let cached: { token: string; expiresAt: number } | null = null;

export function msOauthConfigured(): boolean {
  const E = process.env;
  return !!(E.MS_TENANT_ID && E.MS_CLIENT_ID && E.MS_CLIENT_SECRET);
}

/** Addresses to sweep over OAuth. Empty unless BOTH the app creds and the list are set. */
export function msBillingMailboxes(): string[] {
  if (!msOauthConfigured()) return [];
  return (process.env.MS_BILLING_MAILBOXES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Mint (or reuse) an Office 365 IMAP access token. The scope MUST be the Outlook resource's
 * `.default` for app-only IMAP — a Graph token is the wrong audience and Exchange rejects it
 * at LOGIN with a bare "AUTHENTICATE failed", which is indistinguishable from a bad secret.
 */
export async function getMsImapToken(): Promise<string> {
  const E = process.env;
  if (!msOauthConfigured()) {
    throw new Error("Microsoft OAuth is not configured (MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET)");
  }
  const now = Date.now();
  // Reuse until a minute before expiry so a token can never lapse mid-connection.
  if (cached && cached.expiresAt - 60_000 > now) return cached.token;

  const url = `https://login.microsoftonline.com/${encodeURIComponent(E.MS_TENANT_ID!)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: E.MS_CLIENT_ID!,
    client_secret: E.MS_CLIENT_SECRET!,
    grant_type: "client_credentials",
    scope: "https://outlook.office365.com/.default",
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string; expires_in?: number; error?: string; error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    const detail = json.error_description || json.error || `HTTP ${res.status}`;
    throw new Error(`Microsoft token request failed: ${String(detail).slice(0, 240)}`);
  }
  cached = { token: json.access_token, expiresAt: now + (Number(json.expires_in) || 3600) * 1000 };
  return cached.token;
}
