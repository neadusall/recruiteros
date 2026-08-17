import { requireSession, ok, fail, body } from "../../../../lib/api";
import { ostextTenantFor, resolveOstextTarget } from "../../../../lib/ostextImport";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/ostext/scores
 *
 * Batch qualification-score lookup for the Candidates tab: takes the same
 * { contacts: [{ key, email?, phone? }] } shape as the Job Library lookup and
 * returns { scores: { key: { score, reason, campaignName, scoredAt } } } from
 * the workspace's OS Text engine. Workspace isolation: resolveOstextTarget
 * picks the workspace's own engine when connected; on the shared house engine
 * the resolved tenant label walls the query to that tenant's campaigns
 * engine-side.
 */

type LookupContact = { key?: string; email?: string; phone?: string };

const MAX_CONTACTS = 500;

function normPhoneKey(v: string | undefined): string {
  return String(v || "").replace(/\D+/g, "").slice(-10);
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;

  const payload = await body<{ contacts?: LookupContact[] }>(req);
  const contacts = (Array.isArray(payload?.contacts) ? payload.contacts : [])
    .filter((c) => c && typeof c.key === "string" && c.key)
    .slice(0, MAX_CONTACTS);
  if (!contacts.length) return ok({ scores: {} });

  const target = await resolveOstextTarget(g.ctx.workspace.id).catch(() => null);
  if (!target) return ok({ scores: {}, connected: false });
  const tenant = await ostextTenantFor(g.ctx.workspace.id).catch(() => "house");

  const phones = Array.from(new Set(contacts.map((c) => String(c.phone || "").trim()).filter(Boolean)));
  const emails = Array.from(new Set(contacts.map((c) => String(c.email || "").trim().toLowerCase()).filter(Boolean)));
  if (!phones.length && !emails.length) return ok({ scores: {} });

  let res: Response;
  try {
    res = await fetch(target.base + "/api/scores", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${target.token}` },
      body: JSON.stringify({ tenant, phones, emails }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return fail("ostext_unreachable", 502);
  }
  let data: {
    byPhone?: Record<string, { score: number; reason?: string | null; campaignName?: string; scoredAt?: string | null }>;
    byEmail?: Record<string, { score: number; reason?: string | null; campaignName?: string; scoredAt?: string | null }>;
  } = {};
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  // A 404 here means the engine predates /api/scores (pointer not yet bumped);
  // answer empty instead of erroring so the Candidates tab stays quiet.
  if (res.status === 404) return ok({ scores: {} });
  if (!res.ok) return fail("ostext_scores_failed", 502);

  const byPhone = data.byPhone || {};
  const byEmail = data.byEmail || {};

  // Engine phones are E.164; join on last-10-digits like lib/jobs samePhone.
  const phoneIndex: Record<string, (typeof byPhone)[string]> = {};
  for (const [p, hit] of Object.entries(byPhone)) {
    const k = normPhoneKey(p);
    if (!k) continue;
    const prev = phoneIndex[k];
    if (!prev || hit.score > prev.score) phoneIndex[k] = hit;
  }

  const scores: Record<string, { score: number; reason: string | null; campaignName: string | null; scoredAt: string | null }> = {};
  for (const c of contacts) {
    const viaPhone = phoneIndex[normPhoneKey(c.phone)];
    const viaEmail = byEmail[String(c.email || "").trim().toLowerCase()];
    const hit = [viaPhone, viaEmail].filter(Boolean).sort((a, b) => (b!.score - a!.score))[0];
    if (!hit) continue;
    scores[c.key as string] = {
      score: hit.score,
      reason: hit.reason ?? null,
      campaignName: hit.campaignName ?? null,
      scoredAt: hit.scoredAt ?? null,
    };
  }
  return ok({ scores });
}
