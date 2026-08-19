/**
 * GET /api/mpc-sent  (session, tenant-scoped)
 *
 * The "Sent" audit view feed: the real messages the MPC engine sent in the operator's name, with
 * full bodies, so they can review exactly what went out and trust the machine. Newest first.
 */

import { requireSession, ok } from "../../../lib/api";
import { loadSnapshot } from "../../../lib/db";
import { signatureFor } from "../../../lib/sending/signature";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const s = await loadSnapshot<Record<string, unknown>>("mpc_sent_v1");
  const mpc: Record<string, unknown>[] =
    s && s.workspaceId === g.ctx.workspace.id ? ((s.messages as Record<string, unknown>[]) || []) : [];
  // Candidate job-blast sends (written by lib/recruiting/jobBlast at send time)
  // belong on the same Sent page: one place shows EVERYTHING that went out.
  // Their stored body is the PRE-signature draft (the pooled sender appends the
  // recruiter signature per send), so show body + signature or the feed reads
  // as if sends left unsigned (a real 2026-08-18/19 scare, twice). Rows written
  // since carry `sig` = the exact appended block; older rows resolve it the
  // same way the sender did (from-address + owner name).
  const jbAll = (await loadSnapshot<Record<string, unknown>[]>("job_blast_sent_v1")) || [];
  const jb = jbAll
    .filter((m) => m && m.ws === g.ctx.workspace.id)
    .map((m) => {
      const sig =
        typeof m.sig === "string"
          ? m.sig
          : signatureFor({ inboxEmail: String(m.from || ""), ownerName: String(m.from_owner || "") }).text;
      return sig ? { ...m, body: String(m.body || "") + sig } : m;
    });
  if (!mpc.length && !jb.length) return ok({ present: false, messages: [] });
  const messages = [...mpc, ...jb].sort(
    (a, b) => (Date.parse(String(b.at || "")) || 0) - (Date.parse(String(a.at || "")) || 0),
  );
  const total = (s && typeof s.total === "number" ? s.total : mpc.length) + jb.length;
  return ok({ present: true, total, generatedAt: s?.generatedAt, messages });
}
