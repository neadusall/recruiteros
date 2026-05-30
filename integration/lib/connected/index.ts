/**
 * RecruiterOS · Connected
 * Integration pre-flight. Verify every required channel is green before a
 * campaign can activate. Status walks Red (unconfigured) -> Yellow (key added,
 * unverified) -> Green (test passed).
 */

import { nowIso } from "../core/ids";
import type { Motion } from "../core/types";

export type IntegrationId =
  | "instantly" | "salesrobot" | "unipile" | "rapidapi" | "fresh_linkedin"
  | "tomba" | "loxo" | "taltxt" | "telnyx";

export type ConnStatus = "red" | "yellow" | "green";

export interface Integration {
  id: IntegrationId;
  label: string;
  /** Which motions require this integration to be green to activate. */
  requiredFor: Motion[];
  status: ConnStatus;
  lastTestedAt?: string;
  error?: string;
}

const CATALOG: Omit<Integration, "status" | "lastTestedAt" | "error">[] = [
  { id: "instantly", label: "Instantly (email)", requiredFor: ["bd", "recruiting"] },
  { id: "unipile", label: "Unipile (LinkedIn)", requiredFor: ["bd", "recruiting"] },
  { id: "salesrobot", label: "SalesRobot (LinkedIn)", requiredFor: [] },
  { id: "rapidapi", label: "RapidAPI (job scraper)", requiredFor: ["bd", "recruiting"] },
  { id: "fresh_linkedin", label: "Fresh LinkedIn (enrich)", requiredFor: ["bd", "recruiting"] },
  { id: "tomba", label: "Tomba (email lookup)", requiredFor: ["bd"] },
  { id: "loxo", label: "Loxo (ATS)", requiredFor: ["bd", "recruiting"] },
  { id: "taltxt", label: "TalTxt (SMS)", requiredFor: ["recruiting"] },
  { id: "telnyx", label: "Telnyx 10DLC (SMS/voice)", requiredFor: ["recruiting"] },
];

const state = new Map<string, Map<IntegrationId, Integration>>();

function wsState(workspaceId: string): Map<IntegrationId, Integration> {
  let m = state.get(workspaceId);
  if (!m) {
    m = new Map();
    for (const c of CATALOG) m.set(c.id, { ...c, status: "red" });
    state.set(workspaceId, m);
  }
  return m;
}

export function listIntegrations(workspaceId: string): Integration[] {
  return [...wsState(workspaceId).values()];
}

/** Key added -> yellow. */
export function configure(workspaceId: string, id: IntegrationId): Integration | null {
  const i = wsState(workspaceId).get(id);
  if (!i) return null;
  if (i.status === "red") i.status = "yellow";
  return i;
}

/**
 * Run the test endpoint for one integration. The reference build simulates the
 * call; wire the real per-service health check where marked. Pass succeeds ->
 * green, fails -> yellow with an error.
 */
export async function testConnection(workspaceId: string, id: IntegrationId, ok = true, error?: string): Promise<Integration | null> {
  const i = wsState(workspaceId).get(id);
  if (!i) return null;
  // TODO(prod): call the service's verify endpoint (Instantly /vitals, Loxo /me, ...).
  i.status = ok ? "green" : "yellow";
  i.lastTestedAt = nowIso();
  i.error = ok ? undefined : (error ?? "verification failed");
  return i;
}

export async function testAll(workspaceId: string): Promise<Integration[]> {
  const list = listIntegrations(workspaceId).filter((i) => i.status !== "red");
  for (const i of list) await testConnection(workspaceId, i.id, true);
  return listIntegrations(workspaceId);
}

/** Pre-flight gate: can this motion's campaign activate? */
export function preflight(workspaceId: string, motion: Motion): { ok: boolean; blocking: IntegrationId[] } {
  const blocking = listIntegrations(workspaceId)
    .filter((i) => i.requiredFor.includes(motion) && i.status !== "green")
    .map((i) => i.id);
  return { ok: blocking.length === 0, blocking };
}
