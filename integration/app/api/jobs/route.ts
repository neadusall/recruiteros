/**
 * Job Library API
 *   GET  /api/jobs            -> all JDs with paired-candidate counts
 *   GET  /api/jobs?id=        -> one JD + its paired candidates
 *   POST { action: "upload", filename, contentType, dataBase64, title?, company? }
 *   POST { action: "create", title?, company?, text }
 *   POST { action: "update", id, title?, company?, text? }
 *   POST { action: "close" | "reopen", id }
 *   POST { action: "pair", jdId, email?, phone?, name?, note? }   (manual pairing)
 *   POST { action: "unpair", pairingId }
 *   POST { action: "lookup", contacts: [{ key, email?, phone? }] } (batch: which job is this person for?)
 *   DELETE /api/jobs?id=
 *
 * Session-gated. This is the central home for every JD in the workspace; the
 * pairing rows tie each candidate contact (email/phone) to their job so the
 * match follows them across Candidates, AI Vetting, JD Sourcing, and OS Text.
 */

import { requireSession, body, ok, fail } from "../../../lib/api";
import {
  ensureJobsReady, listJds, getJd, upsertJd, setJdStatus, deleteJd,
  listPairings, recordPairing, deletePairing, pairingCounts, lookupJobs,
} from "../../../lib/jobs";
import { extractResumeText } from "../../../lib/vetting";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  await ensureJobsReady();

  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const jd = getJd(ws, id);
    if (!jd) return fail("not_found", 404);
    return ok({ jd, pairings: listPairings(ws, id) });
  }

  const counts = pairingCounts(ws);
  const jds = listJds(ws).map((j) => ({
    ...j,
    text: undefined, // list payload stays lean; the detail fetch carries the text
    textChars: j.text.length,
    candidates: counts[j.id] ?? 0,
  }));
  return ok({ jds });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  await ensureJobsReady();
  const b = await body<{
    action?: string; id?: string; jdId?: string; pairingId?: string;
    title?: string; company?: string; text?: string; email?: string; phone?: string;
    name?: string; note?: string; filename?: string; contentType?: string; dataBase64?: string;
    contacts?: Array<{ key: string; email?: string; phone?: string }>;
  }>(req);

  if (b.action === "upload") {
    if (!b.dataBase64) return fail("missing_fields", 422);
    let buf: Buffer;
    try { buf = Buffer.from(String(b.dataBase64), "base64"); } catch { return fail("bad_file", 422); }
    if (!buf.length) return fail("bad_file", 422);
    if (buf.length > 10 * 1024 * 1024) return fail("file_too_large", 422, { detail: "Keep the JD file under 10 MB." });
    const text = await extractResumeText({ filename: b.filename || "", contentType: b.contentType || "", content: buf } as any);
    if (!text || text.trim().length < 40) {
      return fail("unreadable_file", 422, { detail: "Couldn't read text from that file. Use a PDF, Word (.docx), or plain-text file, or paste the JD instead." });
    }
    const jd = upsertJd(ws, {
      title: typeof b.title === "string" ? b.title : undefined,
      company: typeof b.company === "string" ? b.company : undefined,
      text, source: "upload", fileName: String(b.filename || "").slice(0, 120),
    });
    return ok({ jd: { ...jd, text: undefined, textChars: jd.text.length } });
  }

  if (b.action === "create") {
    const text = typeof b.text === "string" ? b.text : "";
    if (text.trim().length < 40) return fail("jd_too_short", 422);
    const jd = upsertJd(ws, {
      title: typeof b.title === "string" ? b.title : undefined,
      company: typeof b.company === "string" ? b.company : undefined,
      text, source: "paste",
    });
    return ok({ jd: { ...jd, text: undefined, textChars: jd.text.length } });
  }

  if (b.action === "update") {
    if (!getJd(ws, String(b.id || ""))) return fail("not_found", 404);
    const jd = upsertJd(ws, {
      id: String(b.id),
      title: typeof b.title === "string" ? b.title : undefined,
      company: typeof b.company === "string" ? b.company : undefined,
      text: typeof b.text === "string" ? b.text : "",
      source: "paste",
    });
    return ok({ jd: { ...jd, text: undefined, textChars: jd.text.length } });
  }

  if (b.action === "close" || b.action === "reopen") {
    const jd = setJdStatus(ws, String(b.id || ""), b.action === "close" ? "closed" : "open");
    if (!jd) return fail("not_found", 404);
    return ok({ jd: { ...jd, text: undefined, textChars: jd.text.length } });
  }

  if (b.action === "pair") {
    const p = recordPairing(ws, {
      jdId: String(b.jdId || ""),
      email: typeof b.email === "string" ? b.email : undefined,
      phone: typeof b.phone === "string" ? b.phone : undefined,
      name: typeof b.name === "string" ? b.name : undefined,
      source: "manual",
      note: typeof b.note === "string" ? b.note : undefined,
    });
    if (!p) return fail("bad_pairing", 422, { detail: "Need a valid JD plus an email or phone." });
    return ok({ pairing: p });
  }

  if (b.action === "unpair") {
    return deletePairing(ws, String(b.pairingId || "")) ? ok({ removed: true }) : fail("not_found", 404);
  }

  if (b.action === "lookup") {
    const contacts = Array.isArray(b.contacts) ? b.contacts : [];
    return ok({ jobs: lookupJobs(ws, contacts) });
  }

  return fail("unknown_action", 400);
}

export async function DELETE(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  await ensureJobsReady();
  const id = new URL(req.url).searchParams.get("id") || "";
  return deleteJd(ws, id) ? ok({ deleted: true }) : fail("not_found", 404);
}
