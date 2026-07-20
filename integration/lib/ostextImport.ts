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

/** The OS Text engine + token a workspace should use, isolation-correct. */
export interface OstextTarget {
  base: string;
  token: string;
  /** true when this is the workspace's OWN engine (separate data + Telnyx). */
  own: boolean;
}

/** Normalize a saved engine URL to a base that ends at the /ostext-app app root. */
function normalizeEngineBase(url: string): string {
  const b = url.replace(/\/+$/, "");
  return b.includes("/ostext-app") ? b : b + "/ostext-app";
}

/**
 * Resolve which OS Text engine a workspace pushes to. OWN-INSTANCE-PER-CLIENT:
 * a workspace that has connected its own OS Text (saved TALTXT_API_URL +
 * TALTXT_API_KEY under Setup) hits ITS OWN engine, with its own database and its
 * own Telnyx, fully isolated. A workspace with no own endpoint may ride the
 * shared house engine ONLY if it is the house workspace or has been granted OS
 * Text (the operator lending its engine during onboarding); any other workspace
 * must connect its own OS Text first (returns null -> "not connected").
 *
 * Passing no workspaceId (background/global callers) resolves the house engine.
 */
export async function resolveOstextTarget(workspaceId?: string): Promise<OstextTarget | null> {
  if (workspaceId) {
    try {
      const { getKeys } = await import("./connected/credentials");
      const keys = await getKeys(workspaceId, "taltxt");
      const url = (keys.TALTXT_API_URL || "").trim();
      const key = (keys.TALTXT_API_KEY || "").trim();
      if (url && key) return { base: normalizeEngineBase(url), token: key, own: true };
    } catch {
      /* credential store unavailable -> fall through to the house engine */
    }
    // No own endpoint: only the house workspace or a granted customer may ride
    // the shared engine. Everyone else must connect their own OS Text.
    try {
      const { isHouseWorkspace, isGranted } = await import("./connected/access");
      const mayShare = isHouseWorkspace(workspaceId) || (await isGranted(workspaceId, "taltxt"));
      if (!mayShare) return null;
    } catch {
      /* access checks unavailable -> preserve today's house behavior (no break) */
    }
  }
  const token = process.env.RECRUITEROS_OSTEXT_TOKEN || "";
  if (!token) return null;
  return { base: ostextEngineBase(), token, own: false };
}

/** Whether a workspace has a usable OS Text engine (own or shared). */
export async function ostextConfiguredFor(workspaceId?: string): Promise<boolean> {
  return (await resolveOstextTarget(workspaceId)) !== null;
}

/** Starter SMS template: only {first_name}, which every pushed contact has, so
 *  no contact gets failed for a missing merge field before the recruiter edits.
 *  Campaign names arrive as saved-list names ("VP of Operations · Howell, New
 *  Jersey +50mi (combined)"); the text must say the ROLE, not the list name, so
 *  strip the separator tail, parentheticals, and trailing state codes. */
export function ostextStarterTemplate(recruiterName: string, roleName: string): string {
  const first = (recruiterName || "").trim().split(/\s+/)[0] || "";
  const role = roleName.split("·")[0].replace(/\(.*?\)/g, "").replace(/,\s*[A-Z]{2}\b.*$/, "").trim() || roleName.trim();
  const article = /^[aeiou]/i.test(role) ? "an" : "a";
  return `Hi {first_name}, this is ${first || "a recruiter"} reaching out about ${article} ${role} opening. Your background looks like a strong fit. Open to a quick text about it?`;
}

export interface OsTextImportArgs {
  name: string;
  template: string;
  positionSummary: string;
  recruiterName: string;
  recruiterEmail: string;
  contacts: OsTextContact[];
  /** IGNORED: Telnyx cell validation is forced on every push (see below). The
   *  field survives only so existing callers keep compiling. */
  validate?: boolean;
  /**
   * When set, every contact passes the no-double-contact guard (ATS DNC +
   * recent-communication cooldown) before it reaches the SMS engine. Both push
   * paths should pass this; the skipped tallies come back as protectedDnc /
   * protectedRecent on the result.
   */
  workspaceId?: string;
  /**
   * The recruiter this push belongs to. When they have a phone line assigned on
   * the Numbers page, that line becomes the campaign's SMS from-number, so the
   * same number the recruiter calls from also texts. Needs workspaceId too;
   * without a line the engine falls back to its shared sending number.
   */
  fromUserId?: string;
}

/** Call the engine's /api/import. Returns the engine's response body on success;
 *  throws an Error whose `code` is a stable id the routes can surface. */
export async function ostextImport(args: OsTextImportArgs): Promise<Record<string, unknown>> {
  // Route this push to the workspace's OWN OS Text engine when it has one
  // connected (separate data + Telnyx); else the shared house engine, but only
  // for the house workspace or a workspace granted OS Text.
  const target = await resolveOstextTarget(args.workspaceId);
  if (!target) {
    const e = new Error("OS Text is not connected for this workspace. Open Setup, connect OS Text (add its API URL and key), then push again.");
    (e as Error & { code?: string }).code = "ostext_not_connected";
    throw e;
  }

  // NO-DOUBLE-CONTACT GUARD: last line of defense for every OS Text entry point.
  let protectedDnc = 0;
  let protectedRecent = 0;
  if (args.workspaceId) {
    const { checkContactable } = await import("./outreach/contactGuard");
    const kept: OsTextContact[] = [];
    for (const c of args.contacts) {
      const guard = await checkContactable(args.workspaceId, {
        email: c.email || undefined,
        phone: c.phone || undefined,
        linkedinUrl: c.linkedinUrl || undefined,
        fullName: [c.firstName, c.lastName].filter(Boolean).join(" ") || undefined,
        company: c.company || undefined,
      });
      if (guard.ok) kept.push(c);
      else if (guard.reason === "do_not_contact") protectedDnc++;
      else protectedRecent++;
    }
    args = { ...args, contacts: kept };
    if (!kept.length) {
      const e = new Error(
        `Nothing to push: all selected people are protected (${protectedDnc} do-not-contact, ${protectedRecent} contacted recently).`,
      );
      (e as Error & { code?: string }).code = "all_contacts_protected";
      throw e;
    }
  }
  // ONE NUMBER PER RECRUITER: the line assigned to this recruiter on the
  // Numbers page rides along as the campaign's SMS from-number, so their texts
  // and calls present the same caller ID. Best-effort: no line assigned (or
  // phone system unavailable) simply leaves the engine's shared number in play.
  let fromNumber: string | undefined;
  if (args.workspaceId && args.fromUserId) {
    try {
      const { ensurePhoneReady, numberForUser } = await import("./phone/store");
      await ensurePhoneReady();
      fromNumber = numberForUser(args.workspaceId, args.fromUserId);
    } catch { /* phone store unavailable -> shared number */ }
  }

  let res: Response;
  try {
    res = await fetch(target.base + "/api/import", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${target.token}` },
      body: JSON.stringify({
        campaign: {
          name: args.name,
          smsTemplate: args.template,
          positionSummary: args.positionSummary,
          recruiterName: args.recruiterName,
          recruiterEmail: args.recruiterEmail,
          ...(fromNumber ? { fromNumber } : {}),
        },
        contacts: args.contacts,
        // SAFEGUARD (user mandate): Telnyx cell-line confirmation is FORCED on
        // every push, whatever the caller says. Every phone from every source
        // (free chain, skip-trace Boost, Sales Nav, manual push, parity
        // backfill) lands as "validating" and only confirmed cells can be
        // texted. Previously `args.validate === true` meant a caller that
        // forgot the flag silently DISABLED the engine's own safe default.
        validate: true,
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
  if (protectedDnc || protectedRecent) {
    data.protectedDnc = ((data.protectedDnc as number) || 0) + protectedDnc;
    data.protectedRecent = ((data.protectedRecent as number) || 0) + protectedRecent;
  }
  return data;
}
