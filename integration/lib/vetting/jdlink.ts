/**
 * RecruitersOS · AI Vetting <-> Job Library glue
 *
 * Every vetting desk's JD lives in the central Job Library (lib/jobs), and
 * every candidate who touches a desk (opt-in form, resume inbox, a call) gets
 * a PAIRING row tying their email/phone to that JD. That pairing is what
 * follows the person across the portal (Candidates tab, JD Sourcing, OS Text)
 * so nobody is ever floating with no job attached.
 *
 * Both helpers are safe to fire-and-forget: library trouble must never break
 * a desk save, an opt-in, or a resume filing.
 */

import { ensureJobsReady, upsertJd, recordPairing, type PairingSource } from "../jobs";
import type { VettingDesk } from "./types";
import { upsertDesk } from "./store";

/**
 * Make sure this desk's JD is registered in the Job Library and the desk
 * carries its jdId. Content-hash dedupe upstream means calling this on every
 * save is free; an edited JD re-registers as its new canonical record.
 */
export async function ensureDeskJdRegistered(desk: VettingDesk): Promise<string | undefined> {
  try {
    if ((desk.jobDescription || "").trim().length < 40) return desk.jdId;
    await ensureJobsReady();
    const jd = upsertJd(desk.workspaceId, {
      title: desk.roleTitle || desk.name,
      company: desk.clientCompany,
      text: desk.jobDescription,
      source: "vetting",
    });
    if (desk.jdId !== jd.id) {
      upsertDesk(desk.workspaceId, { id: desk.id, jdId: jd.id });
      desk.jdId = jd.id;
    }
    return jd.id;
  } catch (e: any) {
    console.error("[jobs] desk JD registration failed:", e?.message || e);
    return desk.jdId;
  }
}

/** Tie one candidate contact to this desk's JD. Never throws. */
export async function pairCandidateToDeskJd(
  desk: VettingDesk,
  contact: { email?: string; phone?: string; name?: string },
  source: PairingSource,
  note?: string,
): Promise<void> {
  try {
    const jdId = await ensureDeskJdRegistered(desk);
    if (!jdId) return;
    recordPairing(desk.workspaceId, {
      jdId,
      email: contact.email,
      phone: contact.phone,
      name: contact.name,
      source,
      note: note ?? `AI Vetting: ${desk.name}`,
    });
  } catch (e: any) {
    console.error("[jobs] candidate pairing failed:", e?.message || e);
  }
}
