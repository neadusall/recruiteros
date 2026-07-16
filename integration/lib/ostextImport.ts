/**
 * Shared server-to-server bridge into the OS Text engine's /api/import.
 *
 * Used by both push paths:
 *   - /api/ostext/push      (Candidates list -> OS Text campaign)
 *   - /api/sourcing         (action "ostext": JD Sourcing list -> OS Text campaign)
 *
 * Creates (or tops up) an OS Text campaign and loads the contacts with the full
 * personalization column set, so every merge token OS Text knows can fill in:
 * first_name, last_name, company, job_title, location, email, linkedin_url,
 * plus customFields (available as {tag} / {headline} tokens). Auth is the same
 * shared secret the SSO handshake uses (RECRUITEROS_OSTEXT_TOKEN = the engine's
 * ACCESS_TOKEN); nothing here is reachable without a portal session upstream.
 */

export interface OsTextContact {
  firstName: string;
  lastName: string;
  company: string;
  jobTitle: string;
  phone: string;
  email: string;
  linkedinUrl: string;
  location: string;
  customFields: Record<string, string>;
}

export function ostextEngineBase(): string {
  const internal = (process.env.RECRUITEROS_OSTEXT_INTERNAL_URL || "").replace(/\/$/, "");
  if (internal) return internal;
  const dev = (process.env.RECRUITEROS_OSTEXT_DEV_URL || "").replace(/\/$/, "");
  if (dev) return dev;
  // Production default: the engine container on the compose network.
  return "http://taltxt:3000/ostext-app";
}

export function ostextPushConfigured(): boolean {
  return Boolean(process.env.RECRUITEROS_OSTEXT_TOKEN);
}

/** Starter SMS template: only {first_name}, which every pushed contact has, so
 *  no contact gets failed for a missing merge field before the recruiter edits. */
export function ostextStarterTemplate(recruiterName: string, roleName: string): string {
  const first = (recruiterName || "").trim().split(/\s+/)[0] || "";
  return `Hi {first_name}, this is ${first || "a recruiter"} reaching out about a ${roleName} opening. Your background looks like a strong fit. Open to a quick text about it?`;
}

export interface OsTextImportArgs {
  name: string;
  template: string;
  positionSummary: string;
  recruiterName: string;
  recruiterEmail: string;
  contacts: OsTextContact[];
  validate: boolean;
}

/** Call the engine's /api/import. Returns the engine's response body on success;
 *  throws an Error whose `code` is a stable id the routes can surface. */
export async function ostextImport(args: OsTextImportArgs): Promise<Record<string, unknown>> {
  const token = process.env.RECRUITEROS_OSTEXT_TOKEN || "";
  if (!token) {
    const e = new Error("RECRUITEROS_OSTEXT_TOKEN is not set on this server, run enable-ostext-sso.sh to wire OS Text first.");
    (e as Error & { code?: string }).code = "ostext_not_connected";
    throw e;
  }
  let res: Response;
  try {
    res = await fetch(ostextEngineBase() + "/api/import", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        campaign: {
          name: args.name,
          smsTemplate: args.template,
          positionSummary: args.positionSummary,
          recruiterName: args.recruiterName,
          recruiterEmail: args.recruiterEmail,
        },
        contacts: args.contacts,
        validate: args.validate === true,
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    const e = new Error("Could not reach the OS Text engine. Check that the taltxt container is up.");
    (e as Error & { code?: string }).code = "ostext_unreachable";
    throw e;
  }
  let data: Record<string, unknown> = {};
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const e = new Error((data as { error?: string }).error || `engine returned ${res.status}`);
    (e as Error & { code?: string }).code = "ostext_import_failed";
    throw e;
  }
  return data;
}
