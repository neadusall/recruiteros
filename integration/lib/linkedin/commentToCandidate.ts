/**
 * RecruitersOS · Role Hunter · blocked BD target -> candidate pipeline
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-08-21 we DM'd a Finance Director offering him candidates. He replied
 * that he was not hiring, he was looking for work. Two guards were built that
 * day so it could not happen again: the open-to-work badge, and the employment
 * record (lib/outreach/jobSeeker.ts, lib/outreach/employment.ts).
 *
 * Both of them THREW HIM AWAY. That is the right call for the BD lane and the
 * wrong one for the desk: he is a Finance Director, actively looking, in the
 * exact function this desk places. We had already paid to find him, screen him,
 * read his profile and confirm he was available, and the entire yield of that
 * work was a line in a log saying "skipped".
 *
 * This module is the other side of the gate. A person the BD lane refuses
 * BECAUSE THEY ARE LOOKING FOR WORK becomes a candidate row instead, carrying
 * the evidence that proved it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * Only the two availability gates hand off. A staffing peer, an advisory
 * practice, an off-market poster or a non-decision-maker is blocked for reasons
 * that say nothing about whether they want a job, and turning every rejection
 * into a candidate would fill the pipeline with people who never asked for one.
 *
 * SENDING STAYS OFF, and this lane needs that more than the BD one. The campaign
 * is a DRAFT and rows land "queued", so nothing contacts anybody until a human
 * opens it. Automatically messaging someone because we noticed they lost their
 * job would be a worse version of the mistake this whole thread started with.
 */

import { getCore } from "../core/repository";
import { rid, nowIso } from "../core/ids";
import type { Campaign, Prospect } from "../core/types";
import type { EmploymentVerdict } from "../outreach/employment";

/**
 * Turn the BD lane's refusal into candidate evidence, or null if this refusal
 * says nothing about availability.
 *
 * Pure and exported so the selftest can pin the one rule that matters: ONLY the
 * two availability findings hand off. `leftClaimedCompany` is deliberately NOT
 * one of them -- somebody who moved to a new job is the least available person
 * on LinkedIn, and treating a stale headline as a candidate signal would put
 * happily-employed people on the bench.
 */
export function availabilityFrom(
  seekerReason: string | null,
  employment: EmploymentVerdict,
): { evidence: string; lastRoleEndedAt?: string } | null {
  if (seekerReason) {
    return { evidence: seekerReason, lastRoleEndedAt: employment.lastRoleEndedAt };
  }
  if (employment.status === "not_employed") {
    return {
      evidence: employment.reason ?? "no current employer on their profile",
      lastRoleEndedAt: employment.lastRoleEndedAt,
    };
  }
  return null;
}

/** Owners can switch the handoff off; it writes rows, so it gets a switch. */
export function candidateHandoffEnabled(): boolean {
  return (process.env.ROLE_HUNTER_CANDIDATE_HANDOFF ?? "1") !== "0";
}

/** Stable name, so the campaign is found again rather than re-created. */
export const OPEN_TO_WORK_CAMPAIGN_NAME = "Open to work (found by Role Hunter)";

/**
 * The campaign these people land in, created once per workspace.
 *
 * Its own campaign, not whichever recruiting campaign happens to be running:
 * these are not sourced against a live req, they are people we happened to
 * catch at the moment they became available. Mixing them into an active search
 * would corrupt that search's numbers and bury them.
 */
export async function ensureOpenToWorkCampaign(workspaceId: string): Promise<Campaign> {
  const core = getCore();
  const existing = (await core.listCampaigns(workspaceId))
    .find((c) => c.motion === "recruiting" && c.name === OPEN_TO_WORK_CAMPAIGN_NAME);
  if (existing) return existing;

  const c: Campaign = {
    id: rid("camp"),
    workspaceId,
    motion: "recruiting",
    name: OPEN_TO_WORK_CAMPAIGN_NAME,
    goal: "Bench the finance leaders the BD lane found looking for work, so they can be marketed to live searches.",
    icp: {
      accountProfile: "Not account-scoped: these are people, surfaced by availability rather than by employer.",
      persona: "Decision-maker-level finance professional who is currently available",
      disqualifiers: ["outside the United States", "staffing or recruiting firm"],
    },
    signals: ["hiring_velocity"],
    channels: {},
    methodology: "hiring_manager_outreach",
    voiceNoteThreshold: 80,
    dailyCap: 25,
    // Draft, and it matters more here than anywhere: nothing should message
    // someone because we noticed they lost their job.
    status: "draft",
    createdAt: nowIso(),
  };
  await core.saveCampaign(c);
  console.log(`[comment-candidate] ${workspaceId}: created campaign "${OPEN_TO_WORK_CAMPAIGN_NAME}" (draft, sending off)`);
  return c;
}

/** What the handoff needs, named so this module does not depend on
 *  commentWatch's much larger record shape. */
export interface AvailablePerson {
  authorName: string;
  authorPublicUrl?: string;
  authorHeadline?: string;
  /** Their most recent employer, when the work history gave us one. */
  company?: string;
  title?: string;
  location?: string;
  /** The post that surfaced them, kept as provenance. */
  postUrl?: string;
  /** Why the BD lane refused them, in plain language. This IS the evidence. */
  evidence: string;
  /** ISO date their last role ended, when the employment record showed one. */
  lastRoleEndedAt?: string;
}

/**
 * Create (or find) the candidate row for one available person.
 *
 * Returns the prospect id, or null when nothing was written. Somebody already
 * in the pipeline is never duplicated: they get the availability logged against
 * their existing record instead, which is the more useful outcome, because a
 * recruiter working that row needs to know they have come free.
 */
export async function handoffAvailablePerson(
  workspaceId: string,
  person: AvailablePerson,
): Promise<string | null> {
  const core = getCore();
  const name = (person.authorName || "").trim();
  // "LinkedIn member" is what the API returns for a profile it could not read.
  // A row with no real name is unworkable and would only have to be cleaned up.
  if (!name || name.toLowerCase() === "linkedin member") return null;

  const signalReason = [
    `Found available while prospecting BD: ${person.evidence}.`,
    person.lastRoleEndedAt ? ` Last role ended ${person.lastRoleEndedAt}.` : "",
    person.postUrl ? ` Surfaced by their post: ${person.postUrl}` : "",
  ].join("");

  let prospect = person.authorPublicUrl
    ? await core.findProspectByLinkedin(workspaceId, person.authorPublicUrl)
    : null;

  const existed = Boolean(prospect);
  if (!prospect) {
    const campaign = await ensureOpenToWorkCampaign(workspaceId);
    prospect = {
      id: rid("pros"),
      workspaceId,
      campaignId: campaign.id,
      motion: "recruiting",
      fullName: name,
      firstName: name.split(/\s+/)[0],
      linkedinUrl: person.authorPublicUrl,
      company: person.company,
      title: person.title,
      location: person.location,
      headline: person.authorHeadline,
      // Matches the vocabulary lib/signals already uses for availability, so
      // this row is legible to anything that later reads signal types.
      signalType: "open_to_work",
      signalReason,
      status: "queued",
      dripStage: null,
      warmth: 0,
      createdAt: nowIso(),
    } satisfies Prospect;
    await core.saveProspect(prospect);
  }

  // The activity row is what pays off on BOTH branches. On a new row it records
  // how we know; on an existing one it is the whole point, because a recruiter
  // working that person needs to see they have just come free.
  await core.recordActivity({
    id: rid("act"),
    workspaceId,
    prospectId: prospect.id,
    channel: "linkedin",
    type: "note",
    summary: [
      "Available: ",
      person.evidence,
      person.lastRoleEndedAt ? ` (last role ended ${person.lastRoleEndedAt})` : "",
      person.postUrl ? ` — ${person.postUrl}` : "",
      existed ? " [already in pipeline, availability logged]" : "",
    ].join(""),
    at: nowIso(),
  });

  console.log(
    `[comment-candidate] ${workspaceId}: ${existed ? "logged availability on" : "created"} candidate ${name} - ${person.evidence}`,
  );
  return prospect.id;
}
