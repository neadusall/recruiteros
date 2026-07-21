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
    const jd = upsertJd(run.workspaceId, {
      title: run.name || undefined,
      text: run.jd,
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
