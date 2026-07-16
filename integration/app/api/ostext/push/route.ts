import { requireSession, body, ok, fail } from "../../../../lib/api";
import { getCore } from "../../../../lib/core/repository";
import { ostextImport, ostextStarterTemplate, type OsTextContact } from "../../../../lib/ostextImport";

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
 * Engine call + contact column set live in lib/ostextImport.ts (shared with
 * the JD Sourcing "ostext" action).
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

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;

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
  const contacts: OsTextContact[] = [];
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
  const template = (b?.template || "").trim() || ostextStarterTemplate(recruiter, name);

  let data: Record<string, unknown>;
  try {
    data = await ostextImport({
      name,
      template,
      positionSummary: `Pushed from RecruitersOS Candidates list "${name}" (${contacts.length} contacts).`,
      recruiterName: recruiter,
      recruiterEmail: g.ctx.user.email || "",
      contacts,
      validate: b?.validate === true,
    });
  } catch (e) {
    const err = e as Error & { code?: string };
    const code = err.code || "ostext_import_failed";
    return fail(code, code === "ostext_not_connected" ? 503 : 502, { detail: err.message });
  }

  return ok({ ...data, requested: ids.length, matched: picked.length, noPhone });
}
