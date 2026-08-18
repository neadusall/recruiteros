import { requireSession, requireCapability, ok, fail, body } from "../../../lib/api";
import { listMembers } from "../../../lib/auth/team";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * /api/jobblast: candidate job-marketing blasts from the Candidates tab.
 *
 * GET  -> { blasts, members, capacity } for the panel (recruiter picker = the
 *         workspace's members; capacity = the picked recruiter's warmed-inbox
 *         headroom when ?recruiterId= is passed). Opening the panel also
 *         self-heals: a lazy fire-and-forget tick advances any active blast,
 *         so blasts progress even between hourly cron passes.
 *
 * POST actions (outreach:send):
 *   generate {jd}                              -> facts + gated template bank + samples
 *   create   {name, facts, templates, recruiterId, dailyCap?, prospectIds, dataIds, start}
 *   pause    {id} / resume {id} / delete {id}
 *   tick     {}                                -> send a wave now (window permitting)
 */

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const url = new URL(req.url);
  const recruiterId = url.searchParams.get("recruiterId") || "";

  const { listJobBlasts, runJobBlastTick } = await import("../../../lib/recruiting/jobBlast");
  // Self-heal clock: never blocks the panel paint. ?peek=1 skips it - the
  // board's auto-refresh polls every 30s, and each tick can send up to a wave,
  // so a ticking refresh would quietly burn the daily cap far faster than the
  // "paced across the day" promise. Peek reads state without advancing it.
  if (url.searchParams.get("peek") !== "1") void runJobBlastTick(ws).catch(() => {});

  const blasts = await listJobBlasts(ws);
  // Each member carries their resolved signature entry so the create modal can
  // preview EXACTLY what the sender will append - same resolver, same env, so
  // the preview and the real email cannot disagree (the 2026-08-18 pause was a
  // recruiter reading the bare-body preview as "my signature is missing").
  let entryFor: ((s: { inboxEmail?: string; ownerId?: string; ownerName?: string }) => unknown) | null = null;
  try {
    const sigMod = await import("../../../lib/sending/signature");
    entryFor = (s) => sigMod.signatureEntryFor(s);
  } catch { /* preview simply omits the block */ }
  const members = listMembers(ws)
    .filter((m) => m.role === "member" || m.role === "admin" || m.role === "owner")
    .map((m) => ({
      userId: m.userId, name: m.name, email: m.email, role: m.role,
      sig: entryFor ? entryFor({ inboxEmail: m.email, ownerId: m.userId, ownerName: m.name }) ?? null : null,
    }));

  let capacity: unknown = null;
  try {
    const { poolCapacity } = await import("../../../lib/senders");
    capacity = await poolCapacity(ws, recruiterId || undefined);
  } catch { /* pool not set up yet: the UI says so */ }

  let window: unknown = null;
  try {
    const { sendWindowInfo } = await import("../../../lib/sending/sendWindow");
    window = sendWindowInfo();
  } catch { /* board falls back to counts-only */ }

  return ok({ blasts, members, capacity, window });
}

export async function POST(req: Request) {
  const g = requireCapability(req, "outreach:send");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<any>(req);
  const action = String(b?.action || "");

  if (action === "generate") {
    const jd = String(b?.jd || "").trim();
    if (jd.length < 40) return fail("jd_too_short", 422, { detail: "Paste the job description (at least a few lines)." });
    const { extractJobFacts, generateJobMailBank, renderJobMail } = await import("../../../lib/recruiting/jobMail");
    const { facts, engine } = await extractJobFacts(jd);
    const bank = await generateJobMailBank(facts);
    if (!bank.templates.length) {
      return fail("generation_unavailable", 409, {
        detail: "Email generation needs the AI key configured on the server (Setup > AI). Nothing was created.",
      });
    }
    // Three example renders so the operator sees real emails, not templates.
    const samples = ["sample_a", "sample_b", "sample_c"].map((id, i) =>
      renderJobMail(bank.templates, { id: id + Date.now().toString(36), firstName: ["Sam", "Jordan", "Alex"][i] }, "Your Name"),
    );
    return ok({ facts, factsEngine: engine, bank, samples });
  }

  if (action === "create") {
    const name = String(b?.name || "").trim();
    const recruiterId = String(b?.recruiterId || "");
    const templates = Array.isArray(b?.templates) ? b.templates : [];
    const facts = b?.facts;
    if (!name) return fail("missing_fields", 422, { detail: "Name the blast." });
    if (!recruiterId) return fail("missing_fields", 422, { detail: "Pick the recruiter whose inboxes send this." });
    if (!facts || !facts.roleTitle) return fail("missing_fields", 422, { detail: "Generate the emails first." });
    if (templates.length < 8) return fail("bank_too_small", 422, { detail: "Generate the emails first (the bank is too small to send)." });
    const prospectIds = (Array.isArray(b?.prospectIds) ? b.prospectIds : []).filter(Boolean);
    const dataIds = (Array.isArray(b?.dataIds) ? b.dataIds : []).filter(Boolean);
    if (!prospectIds.length && !dataIds.length) return fail("missing_fields", 422, { detail: "Select the candidates first." });
    const member = listMembers(ws).find((m) => m.userId === recruiterId);
    if (!member) return fail("unknown_recruiter", 422);
    const { createJobBlast, runJobBlastTick } = await import("../../../lib/recruiting/jobBlast");
    const blast = await createJobBlast({
      workspaceId: ws,
      name,
      recruiterId,
      recruiterName: (member.firstName || member.name || "").trim() || member.name,
      facts,
      templates,
      dailyCap: Number(b?.dailyCap) > 0 ? Math.min(2000, Math.floor(Number(b.dailyCap))) : undefined,
      prospectIds,
      dataIds,
      start: b?.start !== false,
    });
    // First wave immediately (window permitting) so "start" visibly does something.
    if (blast.status === "sending") void runJobBlastTick(ws).catch(() => {});
    let window: unknown = null;
    try {
      const { sendWindowInfo } = await import("../../../lib/sending/sendWindow");
      window = sendWindowInfo();
    } catch { /* toast falls back to the generic line */ }
    return ok({ blast, window });
  }

  if (action === "pause" || action === "resume") {
    const { setBlastStatus } = await import("../../../lib/recruiting/jobBlast");
    const blast = await setBlastStatus(ws, String(b?.id || ""), action === "pause" ? "paused" : "sending");
    if (!blast) return fail("not_found", 404);
    if (action === "resume") {
      const { runJobBlastTick } = await import("../../../lib/recruiting/jobBlast");
      void runJobBlastTick(ws).catch(() => {});
    }
    return ok({ blast });
  }

  if (action === "delete") {
    const { deleteJobBlast } = await import("../../../lib/recruiting/jobBlast");
    return (await deleteJobBlast(ws, String(b?.id || ""))) ? ok({ deleted: true }) : fail("not_found", 404);
  }

  if (action === "tick") {
    const { runJobBlastTick } = await import("../../../lib/recruiting/jobBlast");
    return ok({ report: await runJobBlastTick(ws) });
  }

  return fail("unknown_action", 400);
}
