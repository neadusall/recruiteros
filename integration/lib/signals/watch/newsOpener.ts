/**
 * RecruitersOS · Signal Watchlists · the send-time news opener
 *
 * The bridge between "the news arm found this company" and "the email that actually
 * leaves the building". Without it, signalPitch.ts is a composer nothing calls, and a
 * news prospect receives the Day-0 MPC opener — an email that says "I met a candidate
 * for your Operations Manager seat" to a company that just raised a Series B and has
 * posted no roles at all. The role in that sentence was INFERRED by us; presenting it
 * back as a seat they are hiring for is the single most detectable mistake this system
 * could make, because the reader knows for a fact it is not true.
 *
 * So: one function, called by the cadence runner on the first email of a news-arm
 * prospect, returning either sendable copy or null. Null always means "send nothing and
 * hold", never "fall back to the other arm's copy" — see holdReason below.
 *
 * WHY DETERMINISTIC AT SEND TIME. The pitch renders from pre-written beats with no model
 * call. That is the same contract the approved campaign model has (copy a human signed
 * off, merge-filled per prospect) and it buys the same three things: no per-send cost, no
 * outage when a provider is down, and no drift into a claim the desk never made. The
 * optional Haiku pass in signalPitch is a DRAFTING aid for preview, not a send-path call.
 */

import type { Prospect } from "../../core/types";
import type { NewsSignal } from "./newsDiscover";
import { NEWS_SIGNALS } from "./newsDiscover";
import { composePitch, checkPitch, getDeskProfile, profileComplete, type PitchInput } from "./signalPitch";

export interface NewsOpener {
  subject: string;
  body: string;
  /** Which of the five angles this email was written from — stamped on the send so
   *  Outreach Stats can compare "funding" against "exec hire" inside the news arm,
   *  not just news against jobs. */
  signal: NewsSignal;
}

/** Why no opener could be built. Every one of these is a HOLD, not a downgrade: the
 *  prospect stays queued, nothing sends, and the reason surfaces in the Send Queue. */
export type NewsOpenerHold =
  | "not_news_arm"          // a jobs-arm prospect; the MPC path owns it
  | "unknown_signal"        // signalType is not one of the five angles
  | "no_reason"             // no observation to open on, so beat 1 cannot be true
  | "desk_profile_missing"  // beats 3 and 4 would be generic filler
  | "failed_gate";          // composed copy did not pass checkPitch

export interface NewsOpenerResult {
  opener?: NewsOpener;
  hold?: NewsOpenerHold;
  /** Recruiter-facing sentence for the Send Queue hold card. */
  reason?: string;
}

const HOLD_TEXT: Record<NewsOpenerHold, string> = {
  not_news_arm: "not a news-arm prospect",
  unknown_signal: "the news signal on this prospect is not one the opener knows how to write",
  no_reason: "no signal reason was recorded, so the email has no true fact to open on",
  desk_profile_missing:
    "the desk profile is not filled in, so the email cannot say what this desk recruits into. " +
    "Set the firm name and verticals in Signal Watchlists to release these.",
  failed_gate: "the composed opener did not pass the copy gate",
};

/** True when this prospect is one the news opener owns. Cheap, so the caller can ask
 *  before doing any of the work. */
export function isNewsArm(p: Pick<Prospect, "discoverySource">): boolean {
  return p.discoverySource === "news";
}

function asSignal(v: string | undefined): NewsSignal | null {
  const s = (v || "").trim() as NewsSignal;
  return NEWS_SIGNALS.includes(s) ? s : null;
}

/**
 * Build the first-touch email for a news-arm prospect, or explain why it is being held.
 *
 * The seat named in the stakes beat comes from the role curation researched this person
 * FOR (`discoveryRole`), not from their own title: their title is the buyer's, the role is
 * the seat. It defaults off the prospect so no caller can quietly drop it and silently
 * degrade every email to the generic "leadership seat" wording — `opts.roles` is an
 * override for previews, not the supply.
 */
export async function newsOpenerFor(
  workspaceId: string,
  p: Prospect,
  opts?: { roles?: string[] },
): Promise<NewsOpenerResult> {
  if (!isNewsArm(p)) return { hold: "not_news_arm", reason: HOLD_TEXT.not_news_arm };

  const signal = asSignal(p.signalType);
  if (!signal) return { hold: "unknown_signal", reason: HOLD_TEXT.unknown_signal };

  // Beat 1 IS the reason clause. Without it the opener would have to invent an
  // observation, which is exactly what this arm exists to avoid.
  const reason = (p.signalReason || "").trim();
  if (!reason) return { hold: "no_reason", reason: HOLD_TEXT.no_reason };

  const profile = await getDeskProfile(workspaceId);
  // FAIL CLOSED. An unfilled profile still RENDERS ("We focus on this market, so the
  // leaders we place already understand the operating reality of your market") — it just
  // renders a sentence with no information in it, attached to a real company name and a
  // real funding round. That email is worse than no email: it spends the one true fact
  // we hold about this buyer on a paragraph that could have been sent to anyone.
  if (!profileComplete(profile)) {
    return { hold: "desk_profile_missing", reason: HOLD_TEXT.desk_profile_missing };
  }

  const input: PitchInput = {
    firstName: p.firstName,
    company: p.company || "",
    reason,
    // The market the sweep was watching. Falls back to the stakes beat's own "this
    // market" wording rather than guessing a segment from the company name.
    segment: p.discoverySegment || "",
    signal,
    roles: opts?.roles ?? (p.discoveryRole ? [p.discoveryRole] : undefined),
    facts: p.newsFacts,
    profile,
    // Stable per prospect, so a re-render after a held send is the same email.
    variantSeed: p.id,
  };

  const pitch = composePitch(input);
  const verdict = checkPitch(pitch.body, input);
  if (!verdict.ok) {
    return { hold: "failed_gate", reason: `${HOLD_TEXT.failed_gate}: ${verdict.problems.join("; ")}` };
  }
  return { opener: { subject: pitch.subject, body: pitch.body, signal } };
}
