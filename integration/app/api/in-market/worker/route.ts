/**
 * RecruitersOS · In-Market · Distributed research WORKER endpoint
 *
 * The main server hands out research work and ingests results here, so 1-2+ cheap worker boxes can
 * each scrape with their OWN IP / /64 (their own Common-Crawl / news / team-page quota) and push the
 * named decision-makers back. This is the legitimate way to multiply FREE throughput toward 5K/day:
 * per-IP rate limits are sidestepped by spreading the work across independent IPs.
 *
 *   POST /api/in-market/worker   { action: "claim",  limit }          -> { jobs: [{lead, role}, …] }
 *   POST /api/in-market/worker   { action: "submit", rows: [...] }    -> { newlyAdded, updated, accepted }
 *
 * AUTH: a shared bearer token (INMARKET_WORKER_TOKEN). The endpoint is a no-op 401 until the token
 * is set, so it's inert by default. Submitted rows are sanitized (whitelisted + clamped) before they
 * touch the curation store, since a worker is only semi-trusted.
 */

import { claimResearchBatch, mergeCuratedRows, type CuratedProspect, type CurationStatus } from "../../../../lib/inmarket/curation";
import { recordClaim, recordSubmit, recordHealth } from "../../../../lib/inmarket/fleet";
import { ok, fail, body } from "../../../../lib/api";

export const dynamic = "force-dynamic";

function authed(req: Request): boolean {
  const token = process.env.INMARKET_WORKER_TOKEN;
  if (!token) return false; // disabled until a token is configured
  const provided = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  // length check first so a mismatch can't be timed; both must be non-empty and equal.
  return provided.length > 0 && provided.length === token.length && provided === token;
}

const STATUSES = new Set<CurationStatus>(["sourced", "named", "contactable", "queued", "enrolled", "suppressed"]);
const s = (v: unknown, max = 200): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim(); return t ? t.slice(0, max) : undefined;
};
const n = (v: unknown): number => { const x = Number(v); return isFinite(x) ? x : 0; };

/** Accept only the expected fields off a submitted row, coerced + clamped. Never trusts raw input. */
function sanitizeRow(raw: unknown): CuratedProspect | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = s(r.id, 140); const company = s(r.company, 200); const role = s(r.role, 200);
  const status = (typeof r.status === "string" && STATUSES.has(r.status as CurationStatus)) ? (r.status as CurationStatus) : null;
  if (!id || !company || !role || !status) return null; // the minimum that makes a valid row
  const email = s(r.likelyEmail, 254);
  return {
    id, company, role, status,
    domain: s(r.domain, 200),
    industry: s(r.industry, 120),
    signalType: s(r.signalType, 60) ?? "job_posting",
    signalReason: s(r.signalReason, 400) ?? "",
    function: (s(r.function, 40) ?? "other") as CuratedProspect["function"],
    score: Math.max(0, Math.min(100, Math.round(n(r.score)))),
    managerName: s(r.managerName, 120),
    managerTitle: s(r.managerTitle, 120) ?? "Hiring Manager",
    managerVia: s(r.managerVia, 40),
    managerTier: s(r.managerTier, 40) ?? "company_only",
    likelyEmail: email && email.includes("@") ? email : undefined,
    emailPattern: s(r.emailPattern, 40),
    emailSource: s(r.emailSource, 40),
    emailInvalid: r.emailInvalid === true ? true : undefined,
    emailValidated: r.emailValidated === true ? true : undefined,
    validatedAt: s(r.validatedAt, 40),
    curatedAt: s(r.curatedAt, 40) ?? new Date().toISOString(),
  };
}

export async function POST(req: Request) {
  if (!authed(req)) return fail("unauthorized", 401);
  const b = await body<{ action?: string; limit?: number; rows?: unknown[]; worker?: string; health?: unknown }>(req);
  const workerId = (s(b?.worker, 60) || "").replace(/[^\w.\-]/g, "").slice(0, 60); // sanitize id for telemetry

  // Every authenticated call may carry a health digest (workers piggyback it on claim/submit/heartbeat),
  // so the fleet view always has each box's latest CC/search/loop state — no extra request needed.
  if (b?.health && workerId) recordHealth(workerId, b.health);

  // A standalone heartbeat lets an IDLE box (no work to claim) keep reporting health.
  if (b?.action === "heartbeat") return ok({ ok: true });

  if (b?.action === "claim") {
    const limit = Math.min(Math.max(Number(b.limit) || 100, 1), 1000);
    const jobs = await claimResearchBatch(limit);
    recordClaim(workerId, jobs.length);
    return ok({ jobs });
  }

  if (b?.action === "submit") {
    const raw = Array.isArray(b.rows) ? b.rows.slice(0, 5000) : [];
    const rows = raw.map(sanitizeRow).filter((x): x is CuratedProspect => !!x);
    const res = await mergeCuratedRows(rows);
    recordSubmit(workerId, rows.length, rows.filter((r) => r.managerName).length);
    return ok({ ...res, accepted: rows.length, received: raw.length });
  }

  return fail("bad_action", 422, { detail: "action must be claim | submit" });
}
