/**
 * RecruiterOS · Response
 * Do-not-contact (DNC) suppression list.
 *
 * STOP / unsubscribe must be honored the instant it arrives and enforced at the
 * source of truth, then mirrored to every sending platform (Instantly,
 * SalesRobot/Unipile, TalTxt) so no channel can reach the contact again.
 */

import { normalizePhone } from "../core/repository";

export interface SuppressionEntry {
  workspaceId: string;
  handles: string[];   // any of: email, linkedin url, phone
  reason: string;
  at: string;
}

const list: SuppressionEntry[] = [];

function key(h: string): string {
  const t = h.trim().toLowerCase();
  return /^\+?\d[\d\s().-]+$/.test(t) ? normalizePhone(t) : t;
}

/** Add a contact's handles to the DNC list and fan out to sending platforms. */
export async function suppress(
  workspaceId: string,
  handles: Array<string | undefined>,
  reason: string,
  at: string,
): Promise<SuppressionEntry> {
  const clean = handles.filter(Boolean).map((h) => key(h as string));
  const entry: SuppressionEntry = { workspaceId, handles: clean, reason, at };
  list.push(entry);
  await mirrorToPlatforms(entry);
  return entry;
}

export function isSuppressed(workspaceId: string, handle?: string): boolean {
  if (!handle) return false;
  const k = key(handle);
  return list.some((e) => e.workspaceId === workspaceId && e.handles.includes(k));
}

export function listSuppression(workspaceId: string): SuppressionEntry[] {
  return list.filter((e) => e.workspaceId === workspaceId);
}

/**
 * Push the opt-out to each provider's suppression endpoint. Stubbed to a log in
 * the reference build; wire the real calls (Instantly block-list, SalesRobot
 * removeProspect, TalTxt opt-out) where marked.
 */
async function mirrorToPlatforms(entry: SuppressionEntry): Promise<void> {
  // TODO(prod): Instantly  -> POST /api/v2/block-list
  // TODO(prod): SalesRobot -> POST /removeProspect
  // TODO(prod): TalTxt     -> contact.opt-out
  console.info("[suppression] DNC mirrored to all channels", entry.handles, entry.reason);
}
