/**
 * RecruitersOS · Content Library
 * The asset repository the LLM drafter injects into Touch 2 (value drop) and
 * Touch 3 (comparable proof). Case studies, comp benchmarks, value props, and
 * voice scripts, each assignable to one or more campaigns.
 */

import { rid, nowIso } from "../core/ids";

export type AssetType = "case_study" | "comp_benchmark" | "value_prop" | "video_script";

export interface ContentAsset {
  id: string;
  workspaceId: string;
  name: string;
  type: AssetType;
  body: string;
  campaignIds: string[];
  createdAt: string;
  updatedAt: string;
}

const assets: ContentAsset[] = [];

export function addAsset(workspaceId: string, name: string, type: AssetType, body: string, campaignIds: string[] = []): ContentAsset {
  const a: ContentAsset = { id: rid("asset"), workspaceId, name, type, body, campaignIds, createdAt: nowIso(), updatedAt: nowIso() };
  assets.push(a);
  return a;
}

export function listAssets(workspaceId: string, campaignId?: string): ContentAsset[] {
  return assets.filter((a) => a.workspaceId === workspaceId && (!campaignId || a.campaignIds.includes(campaignId)));
}

export function updateAsset(id: string, patch: Partial<Pick<ContentAsset, "name" | "body" | "campaignIds">>): ContentAsset | null {
  const a = assets.find((x) => x.id === id);
  if (!a) return null;
  Object.assign(a, patch, { updatedAt: nowIso() });
  return a;
}

export function deleteAsset(id: string): boolean {
  const i = assets.findIndex((x) => x.id === id);
  if (i < 0) return false;
  assets.splice(i, 1);
  return true;
}

/** Pick the asset the drafter should inject for a campaign + touch. */
export function assetForTouch(workspaceId: string, campaignId: string, touchName: string): ContentAsset | null {
  const pool = listAssets(workspaceId, campaignId);
  const want: AssetType = /comparable|proof/i.test(touchName) ? "case_study"
    : /value/i.test(touchName) ? "comp_benchmark" : "value_prop";
  return pool.find((a) => a.type === want) ?? pool[0] ?? null;
}
