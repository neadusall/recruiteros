/**
 * RecruitersOS · JD Sourcing
 * Promote a staged SourcingRun into the Candidates (Prospects) pipeline.
 *
 * The recruiter saves a run under a name in the JD Sourcing tab, reviews it, then
 * promotes it. Promotion preserves that name end-to-end:
 *   - a recruiting Campaign named after the run holds the prospects,
 *   - every prospect is stamped category = run.name,
 *   - a ProspectList named after the run captures the exact set,
 * so the same list shows up in Candidates under the name it was saved as here.
 *
 * Discovery-only: no paid contact lookup happens at promotion. Contacts are enriched
 * on demand from the Candidates tab (the existing cheapest-first waterfall), or for the
 * top slice via the API's "enrich" action.
 */

import { getCore } from "../core/repository";
import { addProspect } from "../prospects";
import { createCampaign } from "../campaigns";
import { upsertProspectList } from "../prospect-lists";
import { getSourcingRun, saveSourcingRun } from "./store";

export interface PromoteResult {
  campaignId: string;
  listId: string;
  added: number;
  deduped: number;
  /** The name carried through from the JD Sourcing tab. */
  name: string;
}

export interface PromoteOptions {
  /** Only promote candidates at/above this fit score. Default 0 (all staged). */
  minFit?: number;
  /** Promote into an existing campaign instead of creating one. */
  campaignId?: string;
  /** Name for the campaign + saved Candidates list. Defaults to the run's saved name. */
  listName?: string;
  /** Tag stamped on every promoted candidate (their category) so you can pull them by tag. Defaults to the list name. */
  tag?: string;
  /**
   * Also restamp candidates ALREADY in the pipeline with this tag (and fill their
   * blank contact fields from the run's row). Used by combined lists: the sources
   * were usually promoted before, so without a retag the merged tag would only land
   * on the handful of new people and the tag filter in Candidates would miss the rest.
   */
  retag?: boolean;
}

/**
 * Promote a saved run's candidates into Candidates under the run's name.
 * Dedupes by LinkedIn URL against the existing pipeline (same guard as the importer).
 */
export async function promoteSourcingRun(
  workspaceId: string,
  runId: string,
  opts: PromoteOptions = {},
): Promise<PromoteResult> {
  const run = await getSourcingRun(workspaceId, runId);
  if (!run) throw Object.assign(new Error("run_not_found"), { status: 404 });

  const minFit = opts.minFit ?? 0;
  const core = getCore();

  // The recruiter can name the destination list (and a tag) at promote time; both
  // default to the run's saved name so existing behavior is unchanged.
  const listName = (opts.listName || "").trim() || run.name;
  const tag = (opts.tag || "").trim() || listName;

  // 1. The campaign that holds them — named after the chosen list name.
  let campaignId = opts.campaignId;
  if (!campaignId) {
    const campaign = await createCampaign({
      workspaceId,
      motion: run.motion,
      name: listName,
      goal: `Sourced candidates for: ${run.icp.label || run.name}`,
      icp: {
        accountProfile: run.icp.targetCompanies.slice(0, 8).join(", ") || run.icp.industries.join(", "),
        persona: run.icp.titles[0] || run.icp.label,
        disqualifiers: run.icp.disqualifiers,
      },
      signals: [],
    });
    campaignId = campaign.id;
  }

  // 2. Add each candidate as a Prospect, deduped by LinkedIn URL, stamped with the name.
  const prospectIds: string[] = [];
  let added = 0;
  let deduped = 0;
  for (const c of run.candidates) {
    if (c.fitScore < minFit) continue;
    if (c.linkedinUrl) {
      const existing = await core.findProspectByLinkedin(workspaceId, c.linkedinUrl);
      if (existing) {
        deduped++; prospectIds.push(existing.id);
        if (opts.retag) {
          // Combined-list promote: the person came in earlier under a source list's
          // tag. Restamp with the combined tag and fill any contact blanks the merge
          // found, so one tag pulls the WHOLE combined set in Candidates.
          let dirty = false;
          if (existing.category !== tag) { existing.category = tag; dirty = true; }
          if (!existing.email && c.email) { existing.email = c.email; dirty = true; }
          if (!existing.phone && c.phone) { existing.phone = c.phone; existing.phoneSource = c.phoneSource; dirty = true; }
          if (!existing.title && (c.title || c.headline)) { existing.title = c.title || c.headline; dirty = true; }
          if (!existing.location && c.location) { existing.location = c.location; dirty = true; }
          if (dirty) await core.saveProspect(existing);
        }
        continue;
      }
    }
    const p = await addProspect({
      workspaceId,
      campaignId,
      motion: run.motion,
      fullName: c.fullName,
      title: c.title || c.headline,
      headline: c.headline,
      company: c.company,
      location: c.location,
      photoUrl: c.imageUrl,
      linkedinUrl: c.linkedinUrl,
      email: c.email,
      phone: c.phone,
      phoneSource: c.phoneSource,
      category: tag, // <- the tag (defaults to the list name) — pull these back by tag in Candidates
    });
    prospectIds.push(p.id);
    added++;
  }

  // 3. A saved list under the chosen name capturing the exact set.
  const list = await upsertProspectList(workspaceId, {
    name: listName,
    prospectIds,
    motion: run.motion,
  });

  // 4. Record the promotion back on the run so the tab shows it's been sent.
  // Delivered = everyone now in Candidates (new + deduped-into-pipeline), NOT just
  // net-new rows: a top-up re-promote dedupes everybody, and stamping `added` (0)
  // here used to flip the journey strip's Candidates stop back to grey.
  run.promotedCampaignId = campaignId;
  run.promotedListId = list.id;
  run.promotedCount = prospectIds.length;
  await saveSourcingRun(workspaceId, { ...run });

  return { campaignId, listId: list.id, added, deduped, name: listName };
}
