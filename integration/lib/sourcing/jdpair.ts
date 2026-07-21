/**
 * RecruitersOS · JD Sourcing <-> Job Library glue
 *
 * Every JD Sourcing run starts from a pasted job description; when its
 * candidates get pushed (to the Candidates pipeline and into OS Text), that
 * JD registers in the central Job Library and every pushed contact with an
 * email or phone gets a PAIRING row tying them to it. From then on, wherever
 * that person surfaces (Candidates tab, OS Text replies, a vetting call),
 * the "which job are they for?" lookup answers instantly.
 *
 * Fire-and-forget by design: library trouble must never break a push.
 */

import { ensureJobsReady, upsertJd, recordPairing } from "../jobs";
import type { SourcingRun } from "./types";

export async function pairRunToJobLibrary(run: SourcingRun, note?: string): Promise<void> {
  try {
    if ((run.jd || "").trim().length < 40) return;
    await ensureJobsReady();
    // The search UI appends "Based in: <location>" to the JD it runs with. A
    // run started from a Job Library pick must fold back into THAT library
    // record (often a Loxo-synced job), so strip the location tail before the
    // content-hash match; runs from pasted text are unaffected.
    const baseText = run.jd.replace(/\n+Based in:[^\n]*\s*$/i, "").trim();
    const jd = upsertJd(run.workspaceId, {
      title: run.name || undefined,
      text: baseText.length >= 40 ? baseText : run.jd,
      source: "sourcing",
    });
    let paired = 0;
    for (const c of run.candidates || []) {
      if (!c.email && !c.phone) continue;
      const p = recordPairing(run.workspaceId, {
        jdId: jd.id,
        email: c.email,
        phone: c.phone,
        name: c.fullName,
        source: "jdsourcing",
        note: note ?? `JD Sourcing: ${run.name}`,
      });
      if (p) paired += 1;
    }
    if (paired) console.log(`[jobs] paired ${paired} contact(s) to "${jd.title}" from run ${run.id}`);
  } catch (e: any) {
    console.error("[jobs] run pairing failed:", e?.message || e);
  }
}

/**
 * History self-heal: saved lists that were pushed (to Candidates / OS Text)
 * BEFORE the Job Library existed carry no pairings. Walking the workspace's
 * promoted runs once per process registers each run's JD and pairs its
 * contacts retroactively, so "no candidate left floating" covers history.
 * Dedupe upstream makes it idempotent; the per-process guard keeps the
 * repeated GETs that trigger it cheap. Fire-and-forget, never throws.
 */
const backfilledWorkspaces = new Set<string>();
export async function backfillPromotedRunPairings(workspaceId: string): Promise<void> {
  if (backfilledWorkspaces.has(workspaceId)) return;
  backfilledWorkspaces.add(workspaceId);
  try {
    const { listSourcingRuns } = await import("./store");
    for (const run of await listSourcingRuns(workspaceId)) {
      if (!run.promotedListId) continue; // never pushed: pairs when it is
      await pairRunToJobLibrary(run);
    }
  } catch (e: any) {
    console.error("[jobs] promoted-run backfill failed:", e?.message || e);
  }
}
