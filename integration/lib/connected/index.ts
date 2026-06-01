/**
 * RecruiterOS · Connected
 * Integration pre-flight. Verify every required channel is green before a
 * campaign can activate. Status walks Red (unconfigured) -> Yellow (key added,
 * unverified) -> Green (test passed).
 */

import { nowIso } from "../core/ids";
import { getProvider, providerStatuses } from "../providers";
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
  { id: "rapidapi", label: "Job Search (signal feed)", requiredFor: ["bd", "recruiting"] },
  { id: "fresh_linkedin", label: "Profile enrichment", requiredFor: ["bd", "recruiting"] },
  { id: "tomba", label: "Email finder", requiredFor: ["bd"] },
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
 * Run the real verify endpoint for one integration via its provider client.
 * Configured + verify passes -> green; configured but verify fails -> yellow
 * with the error; not configured -> red. The `force` arg lets the demo flip a
 * provider green without live credentials.
 */
export async function testConnection(workspaceId: string, id: IntegrationId, force?: boolean, error?: string): Promise<Integration | null> {
  const i = wsState(workspaceId).get(id);
  if (!i) return null;
  i.lastTestedAt = nowIso();

  if (force) {
    i.status = "green";
    i.error = undefined;
    return i;
  }

  const provider = getProvider(id);
  const loxoConfigured = id === "loxo" && Boolean(process.env.LOXO_API_KEY);

  if (!provider && !loxoConfigured) {
    // No live client / not configured -> stay red unless a key exists.
    i.status = i.status === "red" ? "red" : "yellow";
    i.error = error ?? "not_configured";
    return i;
  }
  if (provider && !provider.configured()) {
    i.status = "red";
    i.error = "not_configured";
    return i;
  }

  const result = provider ? await provider.verify() : { ok: loxoConfigured };
  i.status = result.ok ? "green" : "yellow";
  i.error = result.ok ? undefined : (result.error ?? error ?? "verification failed");
  return i;
}

/** Live configured-status straight from the provider registry (for diagnostics). */
export function providerHealth() {
  return providerStatuses();
}

/** Run a real verify() for every configured integration ("Test all"). */
export async function testAll(workspaceId: string): Promise<Integration[]> {
  const list = listIntegrations(workspaceId).filter((i) => i.status !== "red");
  await Promise.all(list.map((i) => testConnection(workspaceId, i.id)));
  return listIntegrations(workspaceId);
}

/** Pre-flight gate: can this motion's campaign activate? */
export function preflight(workspaceId: string, motion: Motion): { ok: boolean; blocking: IntegrationId[] } {
  const blocking = listIntegrations(workspaceId)
    .filter((i) => i.requiredFor.includes(motion) && i.status !== "green")
    .map((i) => i.id);
  return { ok: blocking.length === 0, blocking };
}
