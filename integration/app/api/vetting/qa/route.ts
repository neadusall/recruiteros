/**
 * AI Vetting · Question intelligence API (the self-learning Q&A control surface)
 *   GET  /api/vetting/qa?deskId=   -> clusters + coverage stats + settings
 *   POST /api/vetting/qa           -> { action, deskId, ... }
 *     action: "teach"    approve a cluster's answer (recruiter-edited or the
 *                        draft), push it to the live agent, and optionally
 *                        text the answer back to the candidates who asked
 *     action: "dismiss"  this topic doesn't need teaching
 *     action: "draft"    (re)draft grounded answers for the open gaps
 *     action: "harvest"  backfill: mine recent scored calls that predate
 *                        question intelligence
 *     action: "settings" flip autoTeach / textBack for the desk
 *
 * Session-gated, same conventions as the optimizer route. LLM actions surface
 * a clean 409 setup hint when ANTHROPIC_API_KEY is missing.
 */

import { requireSession, body, ok, fail } from "../../../../lib/api";
import {
  getDesk, deskQA, dismissQACluster, setDeskQASettings,
  teachCluster, draftGapAnswers, backfillHarvest, questionCoverage,
} from "../../../../lib/vetting";

function requireLlm(): void {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw Object.assign(new Error("anthropic_not_configured: set ANTHROPIC_API_KEY"), { status: 409 });
  }
}

/** The GET payload, rebuilt after every mutation so the UI repaints from truth. */
function snapshot(desk: NonNullable<ReturnType<typeof getDesk>>) {
  const qa = deskQA(desk);
  const weight = (c: (typeof qa.clusters)[number]) =>
    (c.status === "open" ? 1_000_000 : 0) + c.askCount * 1000 + Date.parse(c.lastAskedAt) / 1e10;
  return {
    settings: { autoTeach: qa.autoTeach, textBack: qa.textBack },
    coverage: questionCoverage(desk),
    clusters: [...qa.clusters]
      .filter((c) => c.status !== "dismissed")
      .sort((a, b) => weight(b) - weight(a))
      .slice(0, 40),
    lastHarvestAt: qa.lastHarvestAt,
  };
}

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const deskId = new URL(req.url).searchParams.get("deskId") || "";
  const desk = getDesk(g.ctx.workspace.id, deskId);
  if (!desk) return fail("not_found", 404);
  return ok(snapshot(desk));
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const b = await body<{
    action?: string; deskId?: string; clusterId?: string;
    answer?: string; textBack?: boolean;
    autoTeach?: boolean;
  }>(req);
  if (!b?.action || !b?.deskId) return fail("missing_fields", 422);
  const desk = getDesk(g.ctx.workspace.id, b.deskId);
  if (!desk) return fail("not_found", 404);

  try {
    switch (b.action) {
      case "teach": {
        if (!b.clusterId || !b.answer?.trim()) return fail("missing_fields", 422);
        const res = await teachCluster(desk, b.clusterId, b.answer, { textBack: b.textBack });
        if ("error" in res) return fail(res.error, 422);
        return ok({ taught: true, pushed: res.pushed, texted: res.texted, ...snapshot(desk) });
      }
      case "dismiss": {
        if (!b.clusterId) return fail("missing_fields", 422);
        if (!dismissQACluster(desk, b.clusterId)) return fail("not_found", 404);
        return ok(snapshot(desk));
      }
      case "draft": {
        requireLlm();
        const drafted = await draftGapAnswers(desk, b.clusterId ? [b.clusterId] : undefined);
        return ok({ drafted: drafted.length, ...snapshot(desk) });
      }
      case "harvest": {
        requireLlm();
        const processed = await backfillHarvest(desk);
        return ok({ processed, ...snapshot(desk) });
      }
      case "settings": {
        setDeskQASettings(g.ctx.workspace.id, desk.id, { autoTeach: b.autoTeach, textBack: b.textBack });
        return ok(snapshot(desk));
      }
      default:
        return fail("unknown_action", 422);
    }
  } catch (e: any) {
    const status = typeof e?.status === "number" ? e.status : 500;
    return fail("qa_failed", status, { detail: e?.message || "error" });
  }
}
