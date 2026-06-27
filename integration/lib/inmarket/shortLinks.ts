/**
 * RecruitersOS · In-Market · Short watch links
 *
 * Turns a composite videoKey into a short, clean code so outreach landing pages live at
 * `vid.<yourdomain>/v/<code>` (Loom/Sendspark style) instead of a long signed query string. The
 * code is DETERMINISTIC from the videoKey (same video → same code, idempotent), and the record
 * carries the company/role (for the watch-page context) and the owning workspace (so the brand +
 * TidyCal calendar resolve from the domain). Resolution is public — the code is the capability.
 */

import { createHash } from "crypto";
import { loadSnapshot, saveSnapshot } from "../db";

const KEY = "inmarket_shortlinks_v1"; // code -> ShortRec

export interface ShortRec { videoKey: string; company: string; role: string; workspaceId?: string; at: string }
type ShortMap = Record<string, ShortRec>;

/** Deterministic 9-char code from the videoKey (stable + collision-resistant). */
export function shortCodeFor(videoKey: string): string {
  return createHash("sha1").update(videoKey).digest("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 9);
}

async function loadMap(): Promise<ShortMap> { return (await loadSnapshot<ShortMap>(KEY).catch(() => null)) || {}; }

/** Mint (or reuse) short codes for a batch of videos. Returns videoKey -> code. */
export async function makeShortLinks(items: Array<{ videoKey: string; company: string; role: string; workspaceId?: string }>): Promise<Record<string, string>> {
  const map = await loadMap();
  const out: Record<string, string> = {};
  let changed = false;
  const nowIso = new Date().toISOString();
  for (const it of items) {
    if (!it.videoKey) continue;
    const code = shortCodeFor(it.videoKey);
    out[it.videoKey] = code;
    if (!map[code]) { map[code] = { videoKey: it.videoKey, company: it.company, role: it.role, workspaceId: it.workspaceId, at: nowIso }; changed = true; }
  }
  if (changed) await saveSnapshot(KEY, map);
  return out;
}

/** Resolve a short code back to its video + context, or null. */
export async function resolveShortLink(code: string): Promise<ShortRec | null> {
  if (!code) return null;
  const map = await loadMap();
  return map[code] || null;
}
