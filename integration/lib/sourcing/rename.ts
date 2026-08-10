/**
 * RecruitersOS · JD Sourcing
 * Rename a saved sourcing list — and everything the old name is written on.
 *
 * Promotion carries a run's name end-to-end (see ./promote): the Candidates
 * campaign, the saved Candidates list, and every promoted person's tag all take
 * it. A rename that only touched the JD Sourcing header would leave the recruiter
 * with one list under two names, and the next top-up promote (which tags by the
 * CURRENT name) would split the people across two tags in Candidates.
 *
 * So a rename moves all of them together:
 *   - the run itself,
 *   - its Candidates campaign (promotedCampaignId),
 *   - its saved Candidates list (promotedListId),
 *   - the tag on every prospect still carrying the old name.
 *
 * The one name deliberately left alone is the OS Text campaign's: that engine
 * get-or-creates campaigns by exact name, so the run pins the pushed name in
 * `ostextName` (store.renameSourcingRun) and keeps topping the SAME campaign up
 * rather than forking an empty twin. The UI says so when it offers the rename.
 */

import { getCore } from "../core/repository";
import { renameProspectList } from "../prospect-lists";
import { getSourcingRun, renameSourcingRun } from "./store";
import type { SourcingRun } from "./types";

export interface RenameRunResult {
  run: SourcingRun;
  /** What moved with the name, for the UI's confirmation line. */
  renamedList: boolean;
  renamedCampaign: boolean;
  retagged: number;
  /** The OS Text campaign name this run keeps pushing under, when it differs. */
  ostextName?: string;
}

/** Longest name the tab (and the Candidates tag chip) can show without breaking. */
export const MAX_RUN_NAME = 120;

export async function renameSourcingList(
  workspaceId: string, runId: string, rawName: string,
): Promise<RenameRunResult | undefined> {
  const name = (rawName || "").replace(/\s+/g, " ").trim().slice(0, MAX_RUN_NAME);
  if (!name) return undefined;

  const core = getCore();
  // Read the OLD name before the rename lands: the tag sweep below matches on it.
  const prior = await getSourcingRun(workspaceId, runId);
  if (!prior) return undefined;
  const oldName = prior.name;

  const run = await renameSourcingRun(workspaceId, runId, name);
  if (!run) return undefined;
  if (oldName === run.name) return { run, renamedList: false, renamedCampaign: false, retagged: 0, ostextName: run.ostextName };

  let renamedList = false;
  let renamedCampaign = false;
  let retagged = 0;

  // The saved Candidates list (members untouched).
  if (run.promotedListId) {
    const list = await renameProspectList(workspaceId, run.promotedListId, name);
    renamedList = Boolean(list);
  }

  // The campaign holding the promoted people.
  if (run.promotedCampaignId) {
    const campaign = await core.getCampaign(run.promotedCampaignId);
    if (campaign && campaign.workspaceId === workspaceId) {
      campaign.name = name;
      await core.saveCampaign(campaign);
      renamedCampaign = true;
    }
  }

  // The tag on everyone promoted under the old name. Scoped to this run's
  // campaign when it has one (a tag string can be shared by hand-made lists);
  // matched case-insensitively because the tag is free text in Candidates.
  const oldTag = oldName.trim().toLowerCase();
  if (oldTag) {
    const scope = run.promotedCampaignId ? { campaignId: run.promotedCampaignId } : undefined;
    const people = await core.listProspects(workspaceId, scope);
    for (const p of people) {
      if ((p.category || "").trim().toLowerCase() !== oldTag) continue;
      p.category = name;
      await core.saveProspect(p);
      retagged++;
    }
  }

  return { run, renamedList, renamedCampaign, retagged, ostextName: run.ostextName };
}
