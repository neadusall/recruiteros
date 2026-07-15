/**
 * RecruitersOS · LinkedIn OS
 * Contact pressure: one weighted, cross-channel view of how hard RecruitersOS
 * has been touching a person recently. LinkedIn touches come from the ledger;
 * email / SMS / voicemail touches come from the core activity log, so the
 * score sees EVERY channel, not just this engine's own sends.
 */

import { getCore } from "../../core/repository";
import { listLedger } from "./ledger";
import { getIdentity } from "./identity";
import type { PressureConfig, PressureState } from "./types";

export interface PressureReading {
  score: number;
  state: PressureState;
  touches: Array<{ channel: string; weight: number; at: string }>;
}

function stateFor(score: number, cfg: PressureConfig): PressureState {
  if (score >= cfg.highThreshold) return "high";
  if (score >= cfg.elevatedThreshold) return "elevated";
  if (score >= Math.ceil(cfg.elevatedThreshold / 2)) return "medium";
  return "low";
}

function ledgerWeight(actionType: string, cfg: PressureConfig): number {
  switch (actionType) {
    case "connect":
    case "connect_note": return cfg.weights.connection;
    case "message":
    case "attachment": return cfg.weights.linkedin_message;
    case "voice_note": return cfg.weights.voice_note;
    case "inmail": return cfg.weights.inmail;
    default: return 0; // views / endorses / likes press very lightly: not counted
  }
}

function activityWeight(channel: string, type: string, cfg: PressureConfig): number {
  if (!type.endsWith("_sent")) return 0;
  switch (channel) {
    case "email": return cfg.weights.email;
    case "sms": return cfg.weights.sms;
    case "voice": return cfg.weights.voicemail;
    default: return 0; // LinkedIn activity is counted from the ledger instead
  }
}

/** Compute the person's current pressure across every channel. */
export async function computePressure(
  workspaceId: string,
  personIdentityId: string,
  cfg: PressureConfig,
): Promise<PressureReading> {
  const cutoff = new Date(Date.now() - cfg.windowDays * 86_400_000).toISOString();
  const touches: PressureReading["touches"] = [];

  const rows = await listLedger(workspaceId);
  for (const r of rows) {
    if (r.personIdentityId !== personIdentityId) continue;
    if (r.status !== "success" && r.status !== "submitted") continue;
    const at = r.completedAt ?? r.submittedAt ?? r.requestedAt;
    if (at < cutoff) continue;
    const w = ledgerWeight(r.actionType, cfg);
    if (w > 0) touches.push({ channel: `linkedin_${r.actionType}`, weight: w, at });
  }

  // Other channels via the core activity log, matched through the identity's
  // linked prospect ids.
  const identity = await getIdentity(workspaceId, personIdentityId);
  if (identity && identity.prospectIds.length) {
    const idSet = new Set(identity.prospectIds);
    const acts = await getCore().listAllActivity(workspaceId);
    for (const a of acts) {
      if (!idSet.has(a.prospectId)) continue;
      if (a.at < cutoff) continue;
      const w = activityWeight(a.channel, a.type, cfg);
      if (w > 0) touches.push({ channel: a.channel, weight: w, at: a.at });
    }
  }

  const score = touches.reduce((s, t) => s + t.weight, 0);
  return { score, state: stateFor(score, cfg), touches };
}
