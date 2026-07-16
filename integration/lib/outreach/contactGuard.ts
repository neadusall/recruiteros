/**
 * RecruitersOS · Contact guard
 *
 * ONE answer to "is it safe to contact this person right now?", built from the
 * two sources of truth:
 *   1. the durable suppression list (STOP / unsubscribe / Loxo DNC), and
 *   2. the warehouse communication state the Loxo activity sync maintains
 *      (doNotContact + lastContactedAt, which also reflects our own sends).
 *
 * Every outbound path calls this before a FIRST touch: the email/SMS/voice
 * dispatcher, the OS Text push, and the one-off Candidates actions. Follow-up
 * touches inside an active sequence skip the recency rule (the sequence's own
 * spacing governs those) but still respect do-not-contact.
 */

import { findRecordForPerson } from "../data";
import { isSuppressed } from "../response/suppression";

/** Days of quiet required after ANY communication before a new first touch. */
export function contactCooldownDays(): number {
  const v = Number(process.env.ROS_CONTACT_COOLDOWN_DAYS);
  return Number.isFinite(v) && v >= 0 ? v : 14;
}

export interface ContactCheckWho {
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  fullName?: string;
  company?: string;
}

export interface ContactCheck {
  ok: boolean;
  reason?: "do_not_contact" | "recently_contacted";
  /** Human-readable explanation for UI toasts / queue notes. */
  detail?: string;
  lastContactedAt?: string;
  lastContactChannel?: string;
}

/**
 * Check a person against the suppression list and the warehouse communication
 * state. `checkRecency=false` limits the check to do-not-contact (used for
 * in-sequence follow-ups). Fails OPEN on lookup errors: a guard outage must
 * not silently freeze all outreach, and the DNC list check comes first anyway.
 */
export async function checkContactable(
  workspaceId: string,
  who: ContactCheckWho,
  opts: { checkRecency?: boolean; cooldownDays?: number } = {},
): Promise<ContactCheck> {
  const checkRecency = opts.checkRecency !== false;
  const cooldown = opts.cooldownDays ?? contactCooldownDays();

  try {
    // 1) Durable DNC list (STOP replies, unsubscribes, Loxo DNC mirror).
    for (const h of [who.email, who.phone, who.linkedinUrl]) {
      if (h && (await isSuppressed(workspaceId, h))) {
        return { ok: false, reason: "do_not_contact", detail: "On the do-not-contact list." };
      }
    }

    // 2) Warehouse communication state (synced from Loxo + our own sends).
    const rec = await findRecordForPerson(workspaceId, who);
    if (rec?.doNotContact) {
      return {
        ok: false,
        reason: "do_not_contact",
        detail: rec.dncReason === "loxo_status" || rec.dncReason === "loxo_tag" || rec.dncReason === "loxo_flag"
          ? "Marked do-not-contact in the ATS."
          : "Marked do-not-contact.",
      };
    }
    if (checkRecency && cooldown > 0 && rec?.lastContactedAt) {
      const ageMs = Date.now() - Date.parse(rec.lastContactedAt);
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < cooldown * 24 * 3600_000) {
        const days = Math.max(1, Math.floor(ageMs / (24 * 3600_000)));
        return {
          ok: false,
          reason: "recently_contacted",
          detail: `Contacted ${days === 1 ? "1 day" : days + " days"} ago${rec.lastContactChannel ? " via " + rec.lastContactChannel : ""}.`,
          lastContactedAt: rec.lastContactedAt,
          lastContactChannel: rec.lastContactChannel,
        };
      }
    }
    return { ok: true, lastContactedAt: rec?.lastContactedAt, lastContactChannel: rec?.lastContactChannel };
  } catch {
    return { ok: true };
  }
}
