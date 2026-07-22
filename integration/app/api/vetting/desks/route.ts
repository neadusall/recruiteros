/**
 * AI Vetting · Desks API
 *   GET    /api/vetting/desks?motion=   -> this workspace's vetting desks (+candidate/call counts)
 *   PUT    /api/vetting/desks           -> create/update a desk (JD, questions, voice, number)
 *   DELETE /api/vetting/desks?id=       -> remove a desk (and deprovision its assistant)
 *   POST   /api/vetting/desks           -> { action: provision | pause | resume | detach | generate-questions
 *                                           | generate-knowledge | autofill | extract-jd, deskId }
 *
 * Session-gated. `provision` pushes the desk's config to the voice engine and
 * binds its number; with no Telnyx key this runs as a safe dry-run and the desk
 * still flips to "live" so the flow is exercisable end to end in dev.
 *
 * Qualifiers are AUTO-DERIVED: the operator never has to hand-write them. On PUT,
 * when a desk has a job description but no qualifiers, the LLM extracts the top
 * 3-4 from the JD. `generate-questions` does the same on demand (e.g. a preview
 * button) without saving.
 */

import { requireSession, body, ok, fail } from "../../../../lib/api";
import type { Motion } from "../../../../lib/core/types";
import {
  listDesks, getDesk, upsertDesk, deleteDesk, markDeskSynced, setDeskStatus,
  listCandidates, listCalls, provisionDesk, deprovisionDesk, generateQualifiers,
  generateKnowledge, generateDeskProfile, extractResumeText, ensureDeskJdRegistered,
  type VettingDeskInput, type VettingCall,
} from "../../../../lib/vetting";

/**
 * Desk-level engine health, rolled up from its calls: how much it's talking,
 * what that costs, and how human it's reading (mean agent-realism). Outcome
 * numbers only — the UI never shows engine internals.
 */
function deskHealth(calls: VettingCall[]) {
  const minutes = calls.reduce((m, c) => m + (c.durationSec ? Math.ceil(c.durationSec / 60) : 0), 0);
  const costUsd = Math.round(calls.reduce((s, c) => s + (c.costUsd ?? 0), 0) * 100) / 100;
  const realism = calls.map((c) => c.agentRealism?.score).filter((s): s is number => typeof s === "number");
  const avgRealism = realism.length ? Math.round(realism.reduce((a, b) => a + b, 0) / realism.length) : null;
  return { minutes, costUsd, avgRealism };
}

function asMotion(v: unknown): Motion | undefined {
  return v === "bd" ? "bd" : v === "recruiting" ? "recruiting" : undefined;
}

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const motion = asMotion(new URL(req.url).searchParams.get("motion"));
  // Self-heal: any desk that predates the Job Library registers its JD (and
  // backfills its candidates' pairings) the moment the tab is opened, no Save
  // needed. Fire-and-forget; content-hash + pairing dedupe make repeats free.
  for (const d of listDesks(ws, motion)) {
    if (!d.jdId && (d.jobDescription || "").trim().length >= 40) void ensureDeskJdRegistered(d);
  }
  const desks = listDesks(ws, motion).map((d) => {
    const calls = listCalls(ws, d.id);
    const candidates = listCandidates(ws, d.id);
    return {
      ...d,
      candidateCount: candidates.length,
      // The email->call gate: how many of them have a resume on file already.
      resumeCount: candidates.filter((c) => (c.resumeText || "").length >= 80).length,
      callCount: calls.length,
      health: deskHealth(calls),
    };
  });
  return ok({ desks });
}

export async function PUT(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const b = await body<VettingDeskInput>(req);
  if (!b?.name) return fail("missing_fields", 422);
  const ws = g.ctx.workspace.id;

  // Auto-derive qualifiers: if the operator didn't supply any and the desk has
  // (or is gaining) a job description with none stored yet, pull the top 3-4
  // from the JD so they never have to hand-write screening questions.
  const submitted = Array.isArray(b.questions) ? b.questions : undefined;
  if (!submitted || submitted.length === 0) {
    const existing = b.id ? getDesk(ws, b.id) : undefined;
    const jd = b.jobDescription ?? existing?.jobDescription ?? "";
    const hasStored = (existing?.questions?.length ?? 0) > 0;
    if (jd.trim() && !hasStored) {
      const generated = await generateQualifiers(jd, b.roleTitle ?? existing?.roleTitle, b.clientCompany ?? existing?.clientCompany);
      if (generated.length) b.questions = generated;
    }
  }

  const d = upsertDesk(ws, b);
  // Every desk JD lives in the central Job Library: register (content-hash
  // deduped) and stamp the desk with its jdId so candidate pairings can flow.
  await ensureDeskJdRegistered(d);
  return ok({ desk: d });
}

export async function DELETE(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail("missing_id", 422);
  const desk = getDesk(ws, id);
  if (desk) await deprovisionDesk(desk);
  return ok({ ok: deleteDesk(ws, id) });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<{
    action?: string; deskId?: string; jobDescription?: string; roleTitle?: string; clientCompany?: string;
    filename?: string; contentType?: string; dataBase64?: string;
  }>(req);
  if (!b?.action) return fail("missing_fields", 422);

  // Read the text out of an uploaded JD file (PDF, Word, or plain text) so the
  // operator can drop in the doc instead of pasting. Same extractor the resume
  // inbox uses; nothing is stored, the text just lands in the form's JD box.
  if (b.action === "extract-jd") {
    if (!b.dataBase64) return fail("missing_fields", 422);
    let buf: Buffer;
    try { buf = Buffer.from(String(b.dataBase64), "base64"); } catch { return fail("bad_file", 422); }
    if (!buf.length) return fail("bad_file", 422);
    if (buf.length > 10 * 1024 * 1024) return fail("file_too_large", 422, { detail: "Keep the JD file under 10 MB." });
    const text = await extractResumeText({ filename: b.filename || "", contentType: b.contentType || "", content: buf } as any);
    if (!text || text.trim().length < 40) {
      return fail("unreadable_file", 422, { detail: "Couldn't read text from that file. Use a PDF, Word (.docx), or plain-text file, or paste the JD instead." });
    }
    return ok({ text: text.trim().slice(0, 20000) });
  }

  // One-click desk auto-fill: role profile + qualifiers + role FAQ from the JD
  // in parallel. Preview-only (nothing saves); the form fills its BLANK fields
  // from this and leaves anything the operator already typed alone.
  if (b.action === "autofill") {
    const jd = (b.jobDescription ?? "").trim();
    if (!jd) return fail("no_job_description", 422);
    const [profile, questions, knowledge] = await Promise.all([
      generateDeskProfile(jd),
      generateQualifiers(jd, b.roleTitle, b.clientCompany),
      generateKnowledge(jd, b.roleTitle, b.clientCompany),
    ]);
    if (!profile && !questions.length && !knowledge.length) {
      return fail("generation_unavailable", 409, { detail: "Set ANTHROPIC_API_KEY to auto-fill the desk from a JD." });
    }
    return ok({ profile, questions, knowledge });
  }

  // Preview-only qualifier generation — no deskId needed (used by the form's
  // "Generate from JD" button before the desk is even saved).
  if (b.action === "generate-questions") {
    const jd = (b.jobDescription ?? (b.deskId ? getDesk(ws, b.deskId)?.jobDescription : "") ?? "").trim();
    if (!jd) return fail("no_job_description", 422);
    const questions = await generateQualifiers(jd, b.roleTitle, b.clientCompany);
    if (!questions.length) return fail("generation_unavailable", 409, { detail: "Set ANTHROPIC_API_KEY to auto-generate qualifiers." });
    return ok({ questions });
  }

  // Draft the role FAQ from the JD — the facts the agent may answer candidate
  // questions from (grounded in the JD only). Preview-only, like the above.
  if (b.action === "generate-knowledge") {
    const jd = (b.jobDescription ?? (b.deskId ? getDesk(ws, b.deskId)?.jobDescription : "") ?? "").trim();
    if (!jd) return fail("no_job_description", 422);
    const knowledge = await generateKnowledge(jd, b.roleTitle, b.clientCompany);
    if (!knowledge.length) return fail("generation_unavailable", 409, { detail: "Set ANTHROPIC_API_KEY to draft the role FAQ." });
    return ok({ knowledge });
  }

  if (!b.deskId) return fail("missing_fields", 422);
  const desk = getDesk(ws, b.deskId);
  if (!desk) return fail("not_found", 404);

  switch (b.action) {
    case "provision": {
      if (!desk.jobDescription.trim()) return fail("no_job_description", 422);
      if (!desk.phoneNumber) return fail("no_phone_number", 422);
      if (!desk.voiceId) return fail("no_voice", 422, { detail: "Select your cloned voice before going live." });
      setDeskStatus(ws, desk.id, "provisioning");
      const res = await provisionDesk(desk);
      if (res.error) {
        setDeskStatus(ws, desk.id, "draft");
        return fail("provision_failed", 502, { detail: res.error });
      }
      const updated = markDeskSynced(ws, desk.id, { assistantId: res.assistantId, status: "live" });
      return ok({ desk: updated, dryRun: res.dryRun, numberBound: res.numberBound });
    }
    case "detach": {
      // Unbind the number from this desk (swap it onto another JD). Tears down
      // the engine assistant so the number stops answering for this desk, and
      // drops the desk back to draft until it's re-provisioned with a number.
      await deprovisionDesk(desk);
      const cleared = markDeskSynced(ws, desk.id, { assistantId: "", phoneNumber: "", status: "draft" });
      return ok({ desk: cleared });
    }
    case "pause":
      return ok({ desk: setDeskStatus(ws, desk.id, "paused") });
    case "resume":
      return ok({ desk: setDeskStatus(ws, desk.id, desk.assistantId ? "live" : "draft") });
    default:
      return fail("unknown_action", 422);
  }
}
