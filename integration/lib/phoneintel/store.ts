/**
 * RecruitersOS · Phone Intelligence · Store
 *
 * Snapshot-backed (SNAP_KEY "phone_intel_v1"), same durability seam as
 * phone_system / voice_drops: one blob holds every workspace's rows, reads
 * filter by workspaceId, mutations debounce-persist. The learned routes and
 * company profiles here are the durable moat (spec §29-30, §71).
 */

import { rid, nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";
import type {
  CompanyPhoneProfile, IvrRoute, IvrNode, IntelCall, ContactVerification,
} from "./types";

const MAX_CALLS_PER_WORKSPACE = 5000;
const MAX_EVENTS_PER_CALL = 120;

const store = {
  profiles: [] as CompanyPhoneProfile[],
  routes: [] as IvrRoute[],
  nodes: [] as IvrNode[],
  calls: [] as IntelCall[],
  verifications: [] as ContactVerification[],
};

const SNAP_KEY = "phone_intel_v1";
const persist = debouncedSaver(SNAP_KEY, () => store);

let hydrated: Promise<void> | null = null;
export function ensureIntelReady(): Promise<void> {
  if (!hydrated) {
    hydrated = dbEnabled()
      ? loadSnapshot<any>(SNAP_KEY).then((s) => {
          if (!s) return;
          store.profiles = s.profiles ?? [];
          store.routes = s.routes ?? [];
          store.nodes = s.nodes ?? [];
          store.calls = s.calls ?? [];
          store.verifications = s.verifications ?? [];
        }).catch(() => {})
      : Promise.resolve();
  }
  return hydrated;
}
void ensureIntelReady();

/** Normalize a company identity into the graph key (domain preferred). */
export function companyKeyOf(input: { domain?: string; companyName?: string }): string {
  const d = (input.domain || "").toLowerCase().replace(/^www\./, "").trim();
  if (d) return d;
  return (input.companyName || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/* ------------------------------ profiles -------------------------------- */

export function getProfile(workspaceId: string, companyKey: string): CompanyPhoneProfile | undefined {
  return store.profiles.find((p) => p.workspaceId === workspaceId && p.companyKey === companyKey);
}

export function upsertProfile(
  workspaceId: string,
  input: Partial<CompanyPhoneProfile> & { companyKey: string; companyName: string; mainPhone: string },
): CompanyPhoneProfile {
  const existing = getProfile(workspaceId, input.companyKey);
  if (existing) {
    const { id: _i, workspaceId: _w, createdAt: _c, companyKey: _k, ...safe } = input as any;
    Object.assign(existing, safe, { updatedAt: nowIso() });
    persist();
    return existing;
  }
  const p: CompanyPhoneProfile = {
    id: rid("cpp"),
    workspaceId,
    companyKey: input.companyKey,
    companyName: input.companyName,
    domain: input.domain,
    mainPhone: input.mainPhone,
    phoneSystemDetected: input.phoneSystemDetected ?? false,
    systemType: input.systemType,
    directoryAvailable: input.directoryAvailable,
    directorySpec: input.directorySpec,
    operatorAvailable: input.operatorAvailable,
    knownRoute: input.knownRoute ?? false,
    routeId: input.routeId,
    routeConfidence: input.routeConfidence ?? 0,
    lastVerifiedAt: input.lastVerifiedAt,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.profiles.push(p);
  persist();
  return p;
}

export function patchProfile(
  workspaceId: string, companyKey: string, patch: Partial<CompanyPhoneProfile>,
): CompanyPhoneProfile | undefined {
  const p = getProfile(workspaceId, companyKey);
  if (!p) return undefined;
  const { id: _i, workspaceId: _w, createdAt: _c, companyKey: _k, ...safe } = patch as any;
  Object.assign(p, safe, { updatedAt: nowIso() });
  persist();
  return p;
}

export function listProfiles(workspaceId: string): CompanyPhoneProfile[] {
  return store.profiles
    .filter((p) => p.workspaceId === workspaceId)
    .sort((a, b) => a.companyName.localeCompare(b.companyName));
}

/* ------------------------------- routes --------------------------------- */

/** The active (highest-version, active) route for a company, if any. */
export function activeRoute(workspaceId: string, companyKey: string): IvrRoute | undefined {
  return store.routes
    .filter((r) => r.workspaceId === workspaceId && r.companyKey === companyKey && r.active)
    .sort((a, b) => b.version - a.version)[0];
}

export function getRoute(workspaceId: string, id: string): IvrRoute | undefined {
  return store.routes.find((r) => r.workspaceId === workspaceId && r.id === id);
}

export function saveRoute(
  workspaceId: string,
  input: { companyKey: string; mainPhone: string; steps: IvrRoute["steps"]; confidence?: number },
): IvrRoute {
  // Supersede any prior active route (versioning: never destroy — spec §59).
  const prior = activeRoute(workspaceId, input.companyKey);
  for (const r of store.routes) {
    if (r.workspaceId === workspaceId && r.companyKey === input.companyKey) r.active = false;
  }
  const route: IvrRoute = {
    id: rid("route"),
    workspaceId,
    companyKey: input.companyKey,
    mainPhone: input.mainPhone,
    version: (prior?.version ?? 0) + 1,
    steps: input.steps,
    confidence: input.confidence ?? 0.6,
    timesUsed: 0,
    timesSucceeded: 0,
    active: true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.routes.push(route);
  patchProfile(workspaceId, input.companyKey, {
    knownRoute: true, routeId: route.id, routeConfidence: route.confidence,
  });
  persist();
  return route;
}

export function adjustRouteConfidence(
  workspaceId: string, routeId: string, delta: number, succeeded: boolean,
): IvrRoute | undefined {
  const r = getRoute(workspaceId, routeId);
  if (!r) return undefined;
  r.confidence = Math.max(0, Math.min(1, r.confidence + delta));
  r.timesUsed += 1;
  if (succeeded) r.timesSucceeded += 1;
  r.updatedAt = nowIso();
  patchProfile(workspaceId, r.companyKey, { routeConfidence: r.confidence });
  persist();
  return r;
}

/* -------------------------------- nodes --------------------------------- */

export function upsertNode(
  workspaceId: string,
  input: { companyKey: string; promptHash: string; promptTranscript: string; options: IvrNode["options"] },
): IvrNode {
  const existing = store.nodes.find(
    (n) => n.workspaceId === workspaceId && n.companyKey === input.companyKey && n.promptHash === input.promptHash,
  );
  if (existing) {
    existing.seenCount += 1;
    existing.updatedAt = nowIso();
    if (input.options.length > existing.options.length) existing.options = input.options;
    persist();
    return existing;
  }
  const n: IvrNode = {
    id: rid("node"),
    workspaceId,
    companyKey: input.companyKey,
    promptHash: input.promptHash,
    promptTranscript: input.promptTranscript,
    options: input.options,
    seenCount: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.nodes.push(n);
  persist();
  return n;
}

/* -------------------------------- calls --------------------------------- */

export function insertCall(call: Omit<IntelCall, "id" | "createdAt" | "updatedAt">): IntelCall {
  const rec: IntelCall = { ...call, id: rid("icall"), createdAt: nowIso(), updatedAt: nowIso() };
  store.calls.push(rec);
  trimCalls(rec.workspaceId);
  persist();
  return rec;
}

export function getCall(workspaceId: string, id: string): IntelCall | undefined {
  return store.calls.find((c) => c.workspaceId === workspaceId && c.id === id);
}

export function getCallById(id: string): IntelCall | undefined {
  return store.calls.find((c) => c.id === id);
}

export function findCallByControlId(ccid: string): IntelCall | undefined {
  return store.calls.find((c) => c.telnyxCallControlId === ccid);
}

export function updateCall(call: IntelCall, patch: Partial<IntelCall>): IntelCall {
  const { id: _i, workspaceId: _w, createdAt: _c, ...safe } = patch as any;
  Object.assign(call, safe, { updatedAt: nowIso() });
  persist();
  return call;
}

export function logEvent(
  call: IntelCall,
  type: string,
  opts?: { detail?: string; reason?: string; confidence?: number; source?: IntelCall["events"][number]["source"] },
): void {
  const t = Math.max(0, Math.round((Date.now() - Date.parse(call.startedAt)) / 1000));
  call.events.push({ at: nowIso(), t, type, ...opts });
  if (call.events.length > MAX_EVENTS_PER_CALL) {
    call.events.splice(0, call.events.length - MAX_EVENTS_PER_CALL);
  }
  call.updatedAt = nowIso();
  persist();
}

export function listCalls(workspaceId: string, limit = 100): IntelCall[] {
  return store.calls
    .filter((c) => c.workspaceId === workspaceId)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, limit);
}

function trimCalls(workspaceId: string): void {
  const mine = store.calls.filter((c) => c.workspaceId === workspaceId);
  if (mine.length <= MAX_CALLS_PER_WORKSPACE) return;
  const terminal = new Set(["completed", "failed"]);
  const removable = mine
    .filter((c) => terminal.has(c.state))
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
    .slice(0, mine.length - MAX_CALLS_PER_WORKSPACE);
  const drop = new Set(removable.map((c) => c.id));
  if (drop.size) store.calls = store.calls.filter((c) => !drop.has(c.id));
}

/* --------------------------- verifications ------------------------------ */

export function insertVerification(
  input: Omit<ContactVerification, "id" | "createdAt">,
): ContactVerification {
  const v: ContactVerification = { ...input, id: rid("ver"), createdAt: nowIso() };
  store.verifications.push(v);
  persist();
  return v;
}

export function listVerifications(workspaceId: string, contactId?: string): ContactVerification[] {
  return store.verifications
    .filter((v) => v.workspaceId === workspaceId && (!contactId || v.contactId === contactId))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/* ------------------------------ dashboard ------------------------------- */

export interface IntelDashboard {
  companiesMapped: number;
  verifiedRoutes: number;
  verifiedExtensions: number;
  targetVoicemailsVerified: number;
  totalCalls: number;
}

export function dashboard(workspaceId: string): IntelDashboard {
  const profiles = store.profiles.filter((p) => p.workspaceId === workspaceId);
  const calls = store.calls.filter((c) => c.workspaceId === workspaceId);
  return {
    companiesMapped: profiles.length,
    verifiedRoutes: store.routes.filter((r) => r.workspaceId === workspaceId && r.active && r.confidence >= 0.9).length,
    verifiedExtensions: calls.filter((c) => c.successTypes.includes("EXTENSION_VERIFIED")).length,
    targetVoicemailsVerified: calls.filter((c) => c.successTypes.includes("TARGET_VOICEMAIL_VERIFIED")).length,
    totalCalls: calls.length,
  };
}
