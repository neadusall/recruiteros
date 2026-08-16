/**
 * RecruitersOS · Role Hunter · public comment -> BD pipeline
 *
 * WHY THIS EXISTS
 * ---------------
 * The public-comment lane had no downstream. It found a hiring decision-maker
 * with open roles, wrote a comment onto their post, marked the item approved,
 * and stopped. `prospectId` existed on the lead record but nothing in the lane
 * ever WROTE it, so a poster we had already paid to find, screen, profile-read
 * and publicly engage never became a row in BD. The touch was real and the
 * yield was uncollected (owner direction 2026-08-15).
 *
 * This module is the second step. A comment that the engine accepted becomes,
 * after a deliberate delay, a BD prospect in its own campaign, carrying the
 * post that surfaced them as the signal.
 *
 * THE DELAY IS THE POINT
 * ----------------------
 * Commenting and emailing the same person inside the same hour reads as a
 * machine sweep, which is the one impression this desk cannot afford twice.
 * The gap lets the comment land, get seen in their notifications, and (when it
 * works) pull a profile click first, so the email arrives to a name they have
 * already read. Default 60 hours, override with ROLE_HUNTER_BD_DELAY_HOURS.
 *
 * The handoff runs off the lane's own item retention (14 days for resolved
 * items) rather than a new queue: the approved item IS the pending record, and
 * stamping `prospectId` onto it is what marks the handoff done. That makes the
 * whole thing idempotent for free - a second pass finds the stamp and skips.
 *
 * SENDING STAYS OFF
 * -----------------
 * The campaign is created as a DRAFT, and prospects land "queued". Nothing
 * emails anyone until a human opens that campaign and activates it. That is
 * the standing rule on this deployment (the owner arms sending, not the code),
 * and a lane that starts mailing strangers because a comment posted would be
 * exactly the wrong thing to discover after the fact.
 */

import { getCore } from "../core/repository";
import { rid, nowIso } from "../core/ids";
import type { Campaign, Prospect } from "../core/types";

/** Hours between the comment posting and the prospect becoming a BD row. */
const DEFAULT_DELAY_HOURS = 60;

/** Stable name, so the campaign is found again rather than re-created. */
export const COMMENTED_CAMPAIGN_NAME = "Commented (Role Hunter)";

export function bdHandoffDelayHours(): number {
  const raw = Number(process.env.ROLE_HUNTER_BD_DELAY_HOURS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DELAY_HOURS;
}

/**
 * The campaign these posters land in, created once per workspace.
 *
 * Deliberately its own campaign rather than whatever BD campaign happens to be
 * running: this lane's economics are unknown, and mixing it into cold email
 * would make it permanently impossible to tell whether public commenting pays
 * for itself. One campaign, one answer.
 */
export async function ensureCommentedCampaign(workspaceId: string): Promise<Campaign> {
  const core = getCore();
  const existing = (await core.listCampaigns(workspaceId))
    .find((c) => c.motion === "bd" && c.name === COMMENTED_CAMPAIGN_NAME);
  if (existing) return existing;

  const c: Campaign = {
    id: rid("camp"),
    workspaceId,
    motion: "bd",
    name: COMMENTED_CAMPAIGN_NAME,
    goal: "Convert hiring managers whose post we commented on into discovery calls.",
    icp: {
      accountProfile: "Companies whose decision-makers post their own open roles on LinkedIn.",
      persona: "Hiring decision-maker who published the role themselves",
      disqualifiers: ["staffing or recruiting firm", "outside the United States"],
    },
    signals: ["hiring_velocity"],
    channels: {},
    methodology: "hiring_manager_outreach",
    voiceNoteThreshold: 80,
    dailyCap: 25,
    // Draft, not active: the operator arms sending, never the lane.
    status: "draft",
    createdAt: nowIso(),
  };
  await core.saveCampaign(c);
  console.log(`[comment-bd] ${workspaceId}: created campaign "${COMMENTED_CAMPAIGN_NAME}" (draft, sending off)`);
  return c;
}

/** The fields the handoff needs off a lane item, named so this module does not
 *  depend on commentWatch's much larger record shape. */
export interface CommentedPoster {
  id: string;
  authorName: string;
  authorPublicUrl?: string;
  authorHeadline?: string;
  company?: string;
  title?: string;
  posterLocation?: string;
  postExcerpt?: string;
  postUrl?: string;
  commentDraft?: string;
  openRoles?: number;
}

/**
 * Create (or find) the BD prospect for one poster we commented on.
 *
 * Returns the prospect id, or null when the handoff should be skipped. A
 * poster who is ALREADY in BD is not duplicated: they get the comment logged
 * against their existing record instead, which is the more useful outcome -
 * the rep working that row sees the public touch in the activity feed and does
 * not re-approach cold.
 */
export async function handoffPoster(
  workspaceId: string,
  poster: CommentedPoster,
): Promise<string | null> {
  const core = getCore();
  const name = (poster.authorName || "").trim();
  if (!name || name.toLowerCase() === "linkedin member") return null;

  const signalReason = poster.openRoles
    ? `Posted a hiring role on LinkedIn; ${poster.openRoles} open role${poster.openRoles === 1 ? "" : "s"} on their board. We commented on the post.`
    : "Posted a hiring role on LinkedIn. We commented on the post.";

  let prospect = poster.authorPublicUrl
    ? await core.findProspectByLinkedin(workspaceId, poster.authorPublicUrl)
    : null;

  if (!prospect) {
    const campaign = await ensureCommentedCampaign(workspaceId);
    prospect = {
      id: rid("pros"),
      workspaceId,
      campaignId: campaign.id,
      motion: "bd",
      fullName: name,
      firstName: name.split(/\s+/)[0],
      linkedinUrl: poster.authorPublicUrl,
      company: poster.company,
      title: poster.title,
      location: poster.posterLocation,
      headline: poster.authorHeadline,
      signalType: "linkedin_hiring_post",
      signalReason,
      // "queued" = discovered, awaiting the approval queue. It does not send on
      // its own; the campaign is a draft until a human activates it.
      status: "queued",
      dripStage: null,
      warmth: 0,
      createdAt: nowIso(),
    } satisfies Prospect;
    await core.saveProspect(prospect);
  }

  // The activity row is the part that pays off on either branch: whoever works
  // this prospect later can see we already spoke to them in public, and what
  // we said, before they open with something that contradicts it.
  await core.recordActivity({
    id: rid("act"),
    workspaceId,
    prospectId: prospect.id,
    channel: "linkedin",
    type: "comment_posted",
    summary: [
      "Public comment on their hiring post",
      poster.commentDraft ? `: "${poster.commentDraft.slice(0, 180)}"` : "",
      poster.postUrl ? ` (${poster.postUrl})` : "",
    ].join(""),
    at: nowIso(),
  });

  return prospect.id;
}
