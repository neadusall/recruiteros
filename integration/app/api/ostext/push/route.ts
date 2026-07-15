import { requireSession, body, ok, fail } from "../../../../lib/api";
import { getCore } from "../../../../lib/core/repository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/ostext/push
 *
 * One-click push of a Candidates list into OS Text: creates (or tops up) an
 * OS Text campaign under the SAME NAME and loads the selected prospects as
 * contacts, so nobody drags a CSV between the two apps. The campaign lands
 * ~90% built (name, recruiter identity, a safe starter template); the
 * recruiter opens OS Text, polishes the message, and launches.
 *
 * Every prospect goes over with the full personalization column set, so every
 * merge token OS Text knows can fill in:
 *   first_name, last_name, company, job_title, location, email, linkedin_url
 * plus extra columns (available as {tag} and {headline} tokens).
 *
 * Server-to-server: calls the engine's /api/import inside the compose network
 * (http://taltxt:3000, basePath /ostext-app), authenticated with the same
 * shared secret the SSO handshake uses (RECRUITEROS_OSTEXT_TOKEN = the
 * engine's ACCESS_TOKEN). Nothing here is reachable without a portal session.
 *
 * Body: { name, prospectIds: string[], template?, validate? }
 */

interface PushBody {
  name?: string;
  prospectIds?: string[];
  /** Optional SMS template override; defaults to a safe {first_name}-only starter. */
  template?: string;
  /** Run OS Text's Telnyx mobile-line validation on the pushed contacts. */
  validate?: boolean;
}

function engineBase(): string {
  const internal = (process.env.RECRUITEROS_OSTEXT_INTERNAL_URL || "").replace(/\/$/, "");
  if (internal) return internal;
  const dev = (process.env.RECRUITEROS_OSTEXT_DEV_URL || "").replace(/\/$/, "");
  if (dev) return dev;
  // Production default: the engine container on the compose network.
  return "http://taltxt:3000/ostext-app";
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;

  const token = process.env.RECRUITEROS_OSTEXT_TOKEN || "";
  if (!token) {
    return fail("ostext_not_connected", 503, {
      detail: "RECRUITEROS_OSTEXT_TOKEN is not set on this server, run enable-ostext-sso.sh to wire OS Text first.",
    });
  }

  const b = await body<PushBody>(req);
  const name = (b?.name || "").trim();
  const ids = Array.isArray(b?.prospectIds) ? b!.prospectIds!.filter(Boolean) : [];
  if (!name) return fail("missing_name", 422);
  if (!ids.length) return fail("missing_prospect_ids", 422);

  // Load the workspace's prospects once and pick the requested set (also the
  // workspace guard: an id from another workspace simply never matches).
  const core = getCore();
  const all = await core.listProspects(ws);
  const wanted = new Set(ids);
  const picked = all.filter((p) => wanted.has(p.id));

  let noPhone = 0;
  const contacts = [];
  for (const p of picked) {
    // SMS wants the mobile line first; fall back to the general phone field.
    const phone = p.mobilePhone || p.phone || "";
    if (!phone) { noPhone++; continue; }
    const parts = (p.fullName || "").trim().split(/\s+/);
    const custom: Record<string, string> = {};
    if (p.category) custom.tag = p.category;
    if (p.headline) custom.headline = p.headline;
    contacts.push({
      firstName: p.firstName || parts[0] || "",
      lastName: parts.slice(1).join(" "),
      company: p.company || "",
      jobTitle: p.title || p.headline || "",
      phone,
      email: p.email || "",
      linkedinUrl: p.linkedinUrl || "",
      location: p.location || "",
      customFields: custom,
    });
  }
  if (!contacts.length) {
    return fail("no_contacts_with_phone", 422, {
      detail: "None of the selected candidates has a phone number yet. Enrich phones in Candidates first, then push again.",
      noPhone,
    });
  }

  const recruiter = g.ctx.user.name || "";
  const recruiterFirst = recruiter.trim().split(/\s+/)[0] || "";
  // Starter template: only {first_name}, which every pushed contact has, so no
  // contact gets failed for a missing merge field before the recruiter edits.
  const template = (b?.template || "").trim() ||
    `Hi {first_name}, this is ${recruiterFirst || "a recruiter"} reaching out about a ${name} opening. Your background looks like a strong fit. Open to a quick text about it?`;

  let res: Response;
  try {
    res = await fetch(engineBase() + "/api/import", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        campaign: {
          name,
          smsTemplate: template,
          positionSummary: `Pushed from RecruitersOS Candidates list "${name}" (${contacts.length} contacts).`,
          recruiterName: recruiter,
          recruiterEmail: g.ctx.user.email || "",
        },
        contacts,
        validate: b?.validate === true,
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    return fail("ostext_unreachable", 502, {
      detail: "Could not reach the OS Text engine. Check that the taltxt container is up.",
    });
  }

  let data: Record<string, unknown> = {};
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    return fail("ostext_import_failed", 502, { detail: (data as { error?: string }).error || `engine returned ${res.status}` });
  }

  return ok({ ...data, requested: ids.length, matched: picked.length, noPhone });
}
