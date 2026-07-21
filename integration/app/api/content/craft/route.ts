/**
 * GET  /api/content/craft  -> pull ready-to-send copy by parameters.
 *   ?function=&seniority=&industry=&signal=&motion=&warmth=&company=&firstName=
 *   &title=&sender=&calendarLink=&callbackNumber=&touch=         (single touch)
 *   ?action=coverage                                             (library stats)
 *
 * POST /api/content/craft  -> pull for a prospect-shaped body (classifies the
 *   title into function + seniority and infers industry):
 *   { title, industry?, company?, firstName?, fullName?, warmth?, motion?, signal?,
 *     sender?, calendarLink?, callbackNumber?, voiceThreshold? }
 *
 * The content pool is authored in lib/content/library and renders with no LLM call,
 * so this is safe to hit synchronously the moment a lead is enriched.
 */

import {
  craftSequence, craftTouch, pullForProspect, libraryCoverage,
  type ContentQuery, type JobFunction, type Seniority, type SignalType, type Motion,
} from "../../../../lib/content/library";
import { body, ok, requireCapability } from "../../../../lib/api";

export async function GET(req: Request) {
  const g = requireCapability(req, "outreach:send");
  if ("response" in g) return g.response;
  const u = new URL(req.url);
  const q = u.searchParams;

  if (q.get("action") === "coverage") return ok({ coverage: libraryCoverage() });

  const warmthRaw = q.get("warmth");
  const query: ContentQuery = {
    function: (q.get("function") as JobFunction) || undefined,
    seniority: (q.get("seniority") as Seniority) || undefined,
    industry: q.get("industry") || undefined,
    signal: (q.get("signal") as SignalType) || undefined,
    motion: (q.get("motion") as Motion) || undefined,
    warmth: warmthRaw !== null ? Number(warmthRaw) : undefined,
    voiceThreshold: q.get("voiceThreshold") ? Number(q.get("voiceThreshold")) : undefined,
    prospect: {
      firstName: q.get("firstName") || undefined,
      fullName: q.get("fullName") || undefined,
      company: q.get("company") || undefined,
      title: q.get("title") || undefined,
    },
    sender: q.get("sender") || undefined,
    calendarLink: q.get("calendarLink") || undefined,
    callbackNumber: q.get("callbackNumber") || undefined,
  };

  const touch = q.get("touch");
  if (touch) {
    const t = craftTouch(query, touch);
    return ok({ touch: t });
  }
  return ok(craftSequence(query));
}

export async function POST(req: Request) {
  const g = requireCapability(req, "outreach:send");
  if ("response" in g) return g.response;
  const b = (await body<any>(req)) ?? {};
  // A full ContentQuery (with nested prospect) routes straight to craftSequence;
  // a flat prospect-shaped body goes through the classifier.
  if (b.prospect || b.function || b.seniority) return ok(craftSequence(b as ContentQuery));
  return ok(pullForProspect(b));
}
