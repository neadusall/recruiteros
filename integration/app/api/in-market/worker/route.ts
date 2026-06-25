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
import { recordClaim, recordSubmit, recordHealth, recordSource, fleetStatus } from "../../../../lib/inmarket/fleet";
import type { InMarketLead } from "../../../../lib/inmarket/index";
import { ok, fail, body } from "../../../../lib/api";

export const dynamic = "force-dynamic";

/** Authed by the shared worker token, accepted as a Bearer header (workers) OR a ?token= query
 *  param (so a human/monitor can just open the status URL in a browser). */
function authed(req: Request): boolean {
  const token = process.env.INMARKET_WORKER_TOKEN;
  if (!token) return false; // disabled until a token is configured
  const fromHeader = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  let fromQuery = "";
  try { fromQuery = (new URL(req.url).searchParams.get("token") || "").trim(); } catch { /* bad url */ }
  const provided = fromHeader || fromQuery;
  // length check first so a mismatch can't be timed; both must be non-empty and equal.
  return provided.length > 0 && provided.length === token.length && provided === token;
}

/**
 * GET /api/in-market/worker?token=<INMARKET_WORKER_TOKEN>  → fleet + engine monitoring snapshot.
 * One definitive, login-free read (token-protected) of: every worker box (online?, names/hour,
 * jobs/min, totals, self-reported health), the Common-Crawl throttle-governor state (the binding
 * constraint), the main engine heartbeat, the Reoon validator, the auto-enroll autopilot, and the
 * headline funnel (researched / named / contactable / valid). Pollable by a monitor or openable in
 * a browser — this is how we confirm definitively what's working and at what capacity.
 */
export async function GET(req: Request) {
  if (!authed(req)) return fail("unauthorized", 401);
  const [{ commonCrawlHealth }, { engineHealth }, { reoonStatus }, { autoEnrollStatus }, { curationFunnel }] = await Promise.all([
    import("../../../../lib/inmarket/commonCrawl"),
    import("../../../../lib/inmarket/accumulator"),
    import("../../../../lib/inmarket/reoon"),
    import("../../../../lib/inmarket/autoEnroll"),
    import("../../../../lib/inmarket/curation"),
  ]);
  const [engine, reoon, autoEnroll, funnel] = await Promise.all([engineHealth(), reoonStatus(), autoEnrollStatus(), curationFunnel()]);
  const fleet = fleetStatus();
  const cc = commonCrawlHealth();
  return ok({
    at: new Date().toISOString(),
    fleet,                       // per-box: online, namesPerHour, jobsPerMin, totalNamed, health
    cc,                          // Common-Crawl index governor (the throttle constraint)
    engine,                      // main box heartbeat (last cycle / curation tick)
    reoon,                       // email validator (enabled, lastApplied)
    autoEnroll,                  // populate-BD-Bulk autopilot (enabled, today/cap)
    funnel: {                    // headline yield + pace
      researched: funnel.total, named: funnel.named, contactable: funnel.byStatus?.contactable ?? 0,
      validated: funnel.validated, invalid: funnel.invalid,
    },
  });
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
    emailCandidates: Array.isArray(r.emailCandidates)
      ? r.emailCandidates.map((e) => s(e, 254)).filter((e): e is string => !!e && e.includes("@")).slice(0, 16)
      : undefined,
    emailInvalid: r.emailInvalid === true ? true : undefined,
    emailValidated: r.emailValidated === true ? true : undefined,
    validatedAt: s(r.validatedAt, 40),
    curatedAt: s(r.curatedAt, 40) ?? new Date().toISOString(),
  };
}

export async function POST(req: Request) {
  if (!authed(req)) return fail("unauthorized", 401);
  const b = await body<{ action?: string; limit?: number; rows?: unknown[]; leads?: unknown[]; worker?: string; health?: unknown }>(req);
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

  // The "build" half of the loop: a worker discovered new companies from ITS OWN IP (its own board/API
  // quota) and ships them to the shared pool. mergeIntoPool dedupes, caps, and drops staffing agencies,
  // and they become claimable research jobs on the next claim — so the fleet feeds itself.
  if (b?.action === "source") {
    const raw = Array.isArray(b.leads) ? b.leads.slice(0, 3000) : [];
    const leads = raw.filter(
      (l): l is InMarketLead =>
        !!l && typeof l === "object" && typeof (l as { company?: unknown }).company === "string" &&
        (l as { company: string }).company.trim().length > 1,
    );
    const { mergeIntoPool } = await import("../../../../lib/inmarket/pool");
    await mergeIntoPool(leads);
    recordSource(workerId, leads.length);
    return ok({ accepted: leads.length, received: raw.length });
  }

  return fail("bad_action", 422, { detail: "action must be claim | submit | source" });
}
