/**
 * GET  /api/data                 -> warehouse list/search (+ stats + provider status)
 *      ?q= &company= &hasEmail=1 &hasPhone=1 &source= &limit= &offset=
 * POST /api/data
 *   { action: "import", rows, mapping? }      -> ingest exported rows (dedupe upsert)
 *   { action: "pull", provider, query }       -> programmatic pull via official API (when keyed)
 *   { action: "enrich", id, field? }          -> resolve email/phone for one record
 *   { action: "promote", ids, campaignId }    -> send records to Candidates as prospects
 *   { action: "delete", ids }                 -> drop records
 */

import { requireSession, body, ok, fail } from "../../../lib/api";
import {
  listRecords, getRecord, saveRecord, upsertRecords, deleteRecords, enrichRecord, stats,
  rowsToInputs, providerStatus, getProvider, ProviderNotConfigured,
  type DataSource, type DataRecord,
} from "../../../lib/data";
import { addProspect } from "../../../lib/prospects";
import { ensureLumeSeed } from "../../../lib/data/autoseed";
import { loxoIsActive, pushPersonToLoxo } from "../../../lib/ats";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  await ensureLumeSeed(ws, host); // Lume portal: auto-load the bundled export; elsewhere: scrub it

  const u = new URL(req.url);
  const { records, total } = await listRecords(ws, {
    q: u.searchParams.get("q") ?? undefined,
    company: u.searchParams.get("company") ?? undefined,
    hasEmail: u.searchParams.get("hasEmail") === "1",
    hasPhone: u.searchParams.get("hasPhone") === "1",
    source: (u.searchParams.get("source") as DataSource | null) ?? undefined,
    limit: u.searchParams.get("limit") ? parseInt(u.searchParams.get("limit") as string, 10) : undefined,
    offset: u.searchParams.get("offset") ? parseInt(u.searchParams.get("offset") as string, 10) : undefined,
  });
  return ok({ records, total, stats: await stats(ws), providers: providerStatus() });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<any>(req);

  if (b?.action === "import" && Array.isArray(b.rows)) {
    const inputs = rowsToInputs(b.rows, { mapping: b.mapping, source: "csv" });
    if (!inputs.length) return fail("nothing_to_import", 422, { detail: "No rows with a resolvable name." });
    const res = await upsertRecords(ws, inputs);
    return ok({ added: res.added, updated: res.updated, total: res.added + res.updated });
  }

  if (b?.action === "pull") {
    const provider = getProvider(b.provider || "zoominfo");
    if (!provider) return fail("unknown_provider", 404);
    try {
      const inputs = await provider.search(b.query || {});
      const res = await upsertRecords(ws, inputs);
      return ok({ added: res.added, updated: res.updated, total: res.added + res.updated });
    } catch (e: any) {
      if (e instanceof ProviderNotConfigured) return fail(e.message, 503, { provider: e.providerId });
      return fail(e?.message ?? "pull_failed", e?.status ?? 400);
    }
  }

  if (b?.action === "enrich") {
    if (!b.id) return fail("missing_fields", 422);
    const rec = await getRecord(ws, b.id);
    if (!rec) return fail("not_found", 404);
    const field = b.field === "email" ? "email" : b.field === "phone" ? "phone" : undefined;
    const { record, found } = await enrichRecord(rec, field);
    // Write-back: when we resolve new contact info, mirror it to Loxo so the ATS
    // stays current. Best-effort; never fails the enrich. Push only on this
    // user action — keeps the sync/webhook pull path loop-free.
    let push: unknown = undefined;
    if (found && b.push !== false && (await loxoIsActive(ws))) {
      push = await pushPersonToLoxo(ws, b.id).catch((e) => ({ ok: false, error: e?.message }));
    }
    return ok({ record, found, push });
  }

  if (b?.action === "promote" && Array.isArray(b.ids)) {
    if (!b.campaignId) return fail("missing_fields", 422, { detail: "campaignId required" });
    let added = 0;
    for (const id of b.ids) {
      const rec = await getRecord(ws, id);
      if (!rec) continue;
      await addProspect({
        workspaceId: ws,
        campaignId: b.campaignId,
        fullName: rec.fullName,
        email: rec.email,
        phone: rec.phone || rec.directPhone,
        company: rec.company,
        companyDomain: rec.companyDomain,
        title: rec.title,
        linkedinUrl: rec.linkedinUrl,
        location: [rec.city, rec.state, rec.country].filter(Boolean).join(", ") || undefined,
        motion: b.motion === "bd" ? "bd" : b.motion === "recruiting" ? "recruiting" : undefined,
        category: "Data warehouse",
      });
      added++;
    }
    return ok({ added, campaignId: b.campaignId });
  }

  if (b?.action === "delete" && Array.isArray(b.ids)) {
    return ok({ deleted: await deleteRecords(ws, b.ids) });
  }

  // Set the pipeline stage on a batch of records (empty string clears it).
  if (b?.action === "update" && Array.isArray(b.ids)) {
    if (typeof b.stage !== "string") return fail("missing_fields", 422, { detail: "stage required" });
    const stage = b.stage.trim();
    let updated = 0;
    for (const id of b.ids) {
      const rec = await getRecord(ws, id);
      if (!rec) continue;
      rec.stage = stage || undefined;
      await saveRecord(rec);
      updated++;
    }
    return ok({ updated, stage });
  }

  // One-off email to each selected record, through the full send layer
  // (sender pool / MTA / Instantly with suppression, caps and warm-up all
  // enforced — sendTouch is the same path campaign sends use). Tokens
  // {first_name} {full_name} {company} {title} fill in per person.
  if (b?.action === "email" && (Array.isArray(b.ids) || Array.isArray(b.prospectIds))) {
    const subject = String(b.subject || "").trim();
    const bodyText = String(b.body || "").trim();
    if (!subject || !bodyText) return fail("missing_fields", 422, { detail: "subject and body required" });
    const ids: string[] = (Array.isArray(b.ids) ? b.ids : []).filter(Boolean).slice(0, 500);
    const { sendTouch } = await import("../../../lib/channels");
    const fill = (tpl: string, r: DataRecord) => {
      const first = (r.fullName || "").trim().split(/\s+/)[0] || "";
      return tpl
        .replace(/\{first_name\}/gi, first)
        .replace(/\{full_name\}/gi, r.fullName || "")
        .replace(/\{company\}/gi, r.company || "")
        .replace(/\{title\}/gi, r.title || "");
    };
    let sent = 0, failed = 0, skipped = 0, dryRun = 0;
    const errors: Record<string, number> = {};
    for (const id of ids) {
      const rec = await getRecord(ws, id);
      if (!rec || !rec.email) { skipped++; continue; }
      const first = (rec.fullName || "").trim().split(/\s+/)[0] || "";
      const res = await sendTouch(ws, {
        channel: "email",
        prospect: {
          id: rec.id,
          workspaceId: ws,
          campaignId: "candidates-direct",
          motion: "recruiting",
          fullName: rec.fullName,
          firstName: first,
          email: rec.email,
          company: rec.company,
          title: rec.title,
          linkedinUrl: rec.linkedinUrl,
          phone: rec.phone || rec.directPhone,
          status: "queued",
          dripStage: null,
          warmth: 0,
          createdAt: rec.createdAt || rec.updatedAt,
        },
        subject: fill(subject, rec),
        text: fill(bodyText, rec),
      });
      if (res.ok) { sent++; if (res.dryRun) dryRun++; }
      else { failed++; if (res.error) errors[res.error] = (errors[res.error] || 0) + 1; }
    }
    // Pipeline prospects: the unified Candidates tab sends both id namespaces in
    // one call ({ ids } = warehouse records, { prospectIds } = pipeline).
    const pids: string[] = (Array.isArray(b.prospectIds) ? b.prospectIds : []).filter(Boolean).slice(0, 500);
    if (pids.length) {
      const { getCore } = await import("../../../lib/core/repository");
      const wanted = new Set(pids);
      const prospects = (await getCore().listProspects(ws)).filter((p) => wanted.has(p.id));
      for (const p of prospects) {
        if (!p.email) { skipped++; continue; }
        const first = p.firstName || (p.fullName || "").trim().split(/\s+/)[0] || "";
        const fillP = (tpl: string) => tpl
          .replace(/\{first_name\}/gi, first)
          .replace(/\{full_name\}/gi, p.fullName || "")
          .replace(/\{company\}/gi, p.company || "")
          .replace(/\{title\}/gi, p.title || "");
        const res = await sendTouch(ws, {
          channel: "email",
          prospect: p,
          subject: fillP(subject),
          text: fillP(bodyText),
        });
        if (res.ok) { sent++; if (res.dryRun) dryRun++; }
        else { failed++; if (res.error) errors[res.error] = (errors[res.error] || 0) + 1; }
      }
      skipped += pids.length - prospects.length;
    }
    return ok({ sent, failed, skipped, dryRun, errors, requested: ids.length + pids.length });
  }

  // Ask each selected person for their CURRENT RESUME, from the workspace's
  // own brand mailbox (white-label safe, DNC + cooldown guarded). Replies land
  // in the resume inbox, which files the resume, pairs the JD, and opens the
  // vetting loop automatically; the person's stage nudges to Outbound now and
  // Screening when the resume arrives.
  if (b?.action === "request_resume" && (Array.isArray(b.ids) || Array.isArray(b.prospectIds))) {
    const { requestResumes } = await import("../../../lib/vetting/resumeRequest");
    const people: Array<{ fullName?: string; email: string; phone?: string; linkedinUrl?: string }> = [];
    let noEmail = 0;
    const ids: string[] = (Array.isArray(b.ids) ? b.ids : []).filter(Boolean).slice(0, 500);
    for (const id of ids) {
      const rec = await getRecord(ws, id);
      if (!rec?.email) { noEmail++; continue; }
      people.push({ fullName: rec.fullName, email: rec.email, phone: rec.phone || rec.directPhone, linkedinUrl: rec.linkedinUrl });
    }
    const pids: string[] = (Array.isArray(b.prospectIds) ? b.prospectIds : []).filter(Boolean).slice(0, 500);
    if (pids.length) {
      const { getCore } = await import("../../../lib/core/repository");
      const wanted = new Set(pids);
      for (const p of (await getCore().listProspects(ws)).filter((x) => wanted.has(x.id))) {
        if (!p.email) { noEmail++; continue; }
        people.push({ fullName: p.fullName, email: p.email, phone: p.phone, linkedinUrl: p.linkedinUrl });
      }
    }
    const tally = await requestResumes(ws, people, { source: "candidates", requesterName: g.ctx.user.name });
    return ok({ sent: tally.sent, skipped: tally.skipped + noEmail, reasons: { ...tally.reasons, ...(noEmail ? { no_email: (tally.reasons.no_email || 0) + noEmail } : {}) } });
  }

  return fail("unknown_action", 400);
}
