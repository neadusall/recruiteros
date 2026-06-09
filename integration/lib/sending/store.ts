/**
 * RecruiterOS · Sending registry store
 *
 * Workspace-scoped registry of sending domains, MTA servers, and mailboxes —
 * held in memory for fast reads, snapshotted to the durable backend so the
 * infrastructure inventory (and the DKIM private keys it holds) survives a
 * redeploy. Same persistence pattern as lib/data/store.ts.
 */

import { rid, nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver } from "../db";
import type { SendingDomain, MtaServer, Mailbox, SuppressionEntry, SendEvent, SeedAccount, SeedTest, WarmupThread } from "./types";

interface SendingState {
  domains: SendingDomain[];
  servers: MtaServer[];
  mailboxes: Mailbox[];
  suppression: SuppressionEntry[];
  events: SendEvent[];     // capped recent feed
  seeds: SeedAccount[];
  seedTests: SeedTest[];
  warmupThreads: WarmupThread[]; // capped recent warm-up engagement conversations
}

const KEY = "sending_infra_v1";
const MAX_EVENTS = 500;
const MAX_WARMUP = 1000;
let state: SendingState = { domains: [], servers: [], mailboxes: [], suppression: [], events: [], seeds: [], seedTests: [], warmupThreads: [] };
let hydrated = false;
let hydrating: Promise<void> | null = null;

const save = debouncedSaver(KEY, () => state);

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<SendingState>(KEY);
      if (snap && Array.isArray(snap.domains)) state = {
        domains: snap.domains || [],
        servers: snap.servers || [],
        mailboxes: snap.mailboxes || [],
        suppression: snap.suppression || [],
        events: snap.events || [],
        seeds: snap.seeds || [],
        seedTests: snap.seedTests || [],
        warmupThreads: snap.warmupThreads || [],
      };
      hydrated = true;
    })();
  }
  return hydrating;
}

/** Internal: ensure hydrated for modules that operate on the raw state. */
export async function ready(): Promise<void> { return hydrate(); }

export function persist(): void { save(); }

/* ---------------- domains ---------------- */

export async function listDomains(workspaceId: string): Promise<SendingDomain[]> {
  await hydrate();
  return state.domains.filter((d) => d.workspaceId === workspaceId).sort((a, b) => (b.createdAt < a.createdAt ? -1 : 1));
}

export async function getDomain(workspaceId: string, id: string): Promise<SendingDomain | undefined> {
  await hydrate();
  return state.domains.find((d) => d.id === id && d.workspaceId === workspaceId);
}

export async function findDomainByName(workspaceId: string, domain: string): Promise<SendingDomain | undefined> {
  await hydrate();
  const d = domain.toLowerCase().trim();
  return state.domains.find((x) => x.workspaceId === workspaceId && x.domain.toLowerCase() === d);
}

export async function addDomain(workspaceId: string, domain: string, opts?: { serverId?: string }): Promise<SendingDomain> {
  await hydrate();
  const now = nowIso();
  const rec: SendingDomain = {
    id: rid("sdom"),
    workspaceId,
    domain: domain.toLowerCase().trim(),
    serverId: opts?.serverId,
    status: "pending",
    dkimSelector: "ros" + now.slice(0, 4) + Math.random().toString(36).slice(2, 5),
    records: [],
    createdAt: now,
    updatedAt: now,
  };
  state.domains.push(rec);
  save();
  return rec;
}

export async function saveDomain(d: SendingDomain): Promise<void> {
  await hydrate();
  d.updatedAt = nowIso();
  if (!state.domains.includes(d)) state.domains.push(d);
  save();
}

export async function deleteDomain(workspaceId: string, id: string): Promise<boolean> {
  await hydrate();
  const i = state.domains.findIndex((d) => d.id === id && d.workspaceId === workspaceId);
  if (i < 0) return false;
  state.domains.splice(i, 1);
  // orphan its mailboxes
  state.mailboxes = state.mailboxes.filter((m) => m.domainId !== id);
  save();
  return true;
}

/* ---------------- servers ---------------- */

export async function listServers(workspaceId: string): Promise<MtaServer[]> {
  await hydrate();
  return state.servers.filter((s) => s.workspaceId === workspaceId);
}

export async function getServer(workspaceId: string, id: string): Promise<MtaServer | undefined> {
  await hydrate();
  return state.servers.find((s) => s.id === id && s.workspaceId === workspaceId);
}

export async function addServer(workspaceId: string, input: { name: string; hostname: string; serverType?: string; location?: string }): Promise<MtaServer> {
  await hydrate();
  const now = nowIso();
  const s: MtaServer = {
    id: rid("mta"),
    workspaceId,
    provider: "hetzner",
    name: input.name,
    hostname: input.hostname.toLowerCase().trim(),
    serverType: input.serverType,
    location: input.location,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  state.servers.push(s);
  save();
  return s;
}

export async function saveServer(s: MtaServer): Promise<void> {
  await hydrate();
  s.updatedAt = nowIso();
  if (!state.servers.includes(s)) state.servers.push(s);
  save();
}

/* ---------------- mailboxes ---------------- */

export async function listMailboxes(workspaceId: string, domainId?: string): Promise<Mailbox[]> {
  await hydrate();
  return state.mailboxes.filter((m) => m.workspaceId === workspaceId && (!domainId || m.domainId === domainId));
}

export async function addMailbox(workspaceId: string, input: { domainId: string; address: string; displayName?: string; dailyCap?: number }): Promise<Mailbox> {
  await hydrate();
  const now = nowIso();
  const m: Mailbox = {
    id: rid("mbox"),
    workspaceId,
    domainId: input.domainId,
    address: input.address.toLowerCase().trim(),
    displayName: input.displayName,
    dailyCap: input.dailyCap ?? 10,      // start low; warmup ramps it
    sentToday: 0,
    warmupDay: 0,
    status: "warming",
    sent: 0,
    bounced: 0,
    complained: 0,
    createdAt: now,
    updatedAt: now,
  };
  state.mailboxes.push(m);
  save();
  return m;
}

export async function saveMailbox(m: Mailbox): Promise<void> {
  await hydrate();
  m.updatedAt = nowIso();
  if (!state.mailboxes.includes(m)) state.mailboxes.push(m);
  save();
}

export async function stats(workspaceId: string): Promise<{ domains: number; active: number; servers: number; mailboxes: number; suppressed: number }> {
  await hydrate();
  const domains = state.domains.filter((d) => d.workspaceId === workspaceId);
  return {
    domains: domains.length,
    active: domains.filter((d) => d.status === "active").length,
    servers: state.servers.filter((s) => s.workspaceId === workspaceId).length,
    mailboxes: state.mailboxes.filter((m) => m.workspaceId === workspaceId).length,
    suppressed: state.suppression.length,
  };
}

/* ---------------- raw collections (for the deliverability modules) ---------------- */

export async function allMailboxes(workspaceId: string): Promise<Mailbox[]> {
  await hydrate();
  return state.mailboxes.filter((m) => m.workspaceId === workspaceId);
}
export async function allDomains(workspaceId: string): Promise<SendingDomain[]> {
  await hydrate();
  return state.domains.filter((d) => d.workspaceId === workspaceId);
}
export async function mailboxById(workspaceId: string, id: string): Promise<Mailbox | undefined> {
  await hydrate();
  return state.mailboxes.find((m) => m.id === id && m.workspaceId === workspaceId);
}

/**
 * Distinct workspace ids that own at least one sending domain. Used by the
 * scheduler-driven /api/sending/cron (which has no session) to run the daily
 * warm-up / reputation / governor tick across every tenant.
 */
export async function listSendingWorkspaceIds(): Promise<string[]> {
  await hydrate();
  return [...new Set(state.domains.map((d) => d.workspaceId))];
}

/**
 * Global (cross-workspace) sender resolver for the webhook: given a "from"
 * address, find the mailbox + its domain + the owning workspace. Used only by
 * the Postal webhook, which has no session.
 */
export async function resolveSender(fromAddress: string): Promise<{ workspaceId: string; mailbox?: Mailbox; domain?: SendingDomain } | null> {
  await hydrate();
  const addr = fromAddress.toLowerCase().trim();
  const apex = addr.includes("@") ? addr.split("@")[1] : addr;
  const mailbox = state.mailboxes.find((m) => m.address.toLowerCase() === addr);
  const domain = mailbox
    ? state.domains.find((d) => d.id === mailbox.domainId)
    : state.domains.find((d) => d.domain.toLowerCase() === apex);
  if (!domain) return null;
  return { workspaceId: domain.workspaceId, mailbox, domain };
}

/* ---------------- suppression ---------------- */

export async function isSuppressed(email: string): Promise<boolean> {
  await hydrate();
  const e = email.toLowerCase().trim();
  return state.suppression.some((s) => s.email === e);
}
export async function suppress(email: string, reason: SuppressionEntry["reason"], source?: string): Promise<void> {
  await hydrate();
  const e = email.toLowerCase().trim();
  if (!e || state.suppression.some((s) => s.email === e)) return;
  state.suppression.push({ email: e, reason, source, at: nowIso() });
  save();
}
export async function listSuppression(): Promise<SuppressionEntry[]> {
  await hydrate();
  return state.suppression.slice(-1000).reverse();
}

/* ---------------- events feed ---------------- */

export async function recordEvent(ev: Omit<SendEvent, "id" | "at"> & { at?: string }): Promise<void> {
  await hydrate();
  state.events.push({ id: rid("sev"), at: ev.at || nowIso(), ...ev });
  if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
  save();
}
export async function recentEvents(limit = 100): Promise<SendEvent[]> {
  await hydrate();
  return state.events.slice(-limit).reverse();
}

/* ---------------- seeds + seed tests ---------------- */

export async function listSeeds(): Promise<SeedAccount[]> {
  await hydrate();
  return state.seeds;
}
export async function addSeed(input: Omit<SeedAccount, "id">): Promise<SeedAccount> {
  await hydrate();
  const seed: SeedAccount = { id: rid("seed"), ...input };
  state.seeds.push(seed);
  save();
  return seed;
}
export async function deleteSeed(id: string): Promise<void> {
  await hydrate();
  state.seeds = state.seeds.filter((s) => s.id !== id);
  save();
}
export async function addSeedTest(t: SeedTest): Promise<void> {
  await hydrate();
  state.seedTests.push(t);
  if (state.seedTests.length > 200) state.seedTests = state.seedTests.slice(-200);
  save();
}
export async function getSeedTest(id: string): Promise<SeedTest | undefined> {
  await hydrate();
  return state.seedTests.find((t) => t.id === id);
}
export async function listSeedTests(workspaceId: string, domainId?: string): Promise<SeedTest[]> {
  await hydrate();
  return state.seedTests.filter((t) => t.workspaceId === workspaceId && (!domainId || t.domainId === domainId)).slice(-50).reverse();
}
export async function saveSeedTest(): Promise<void> { await hydrate(); save(); }

/* ---------------- warm-up engagement threads ---------------- */

export async function addWarmupThread(t: Omit<WarmupThread, "id" | "createdAt" | "updatedAt">): Promise<WarmupThread> {
  await hydrate();
  const now = nowIso();
  const rec: WarmupThread = { id: rid("warm"), createdAt: now, updatedAt: now, ...t };
  state.warmupThreads.push(rec);
  if (state.warmupThreads.length > MAX_WARMUP) state.warmupThreads = state.warmupThreads.slice(-MAX_WARMUP);
  save();
  return rec;
}
export async function saveWarmupThread(t: WarmupThread): Promise<void> {
  await hydrate();
  t.updatedAt = nowIso();
  if (!state.warmupThreads.includes(t)) state.warmupThreads.push(t);
  save();
}
/** All warm-up threads for a workspace (newest first). */
export async function listWarmupThreads(workspaceId: string, limit = 100): Promise<WarmupThread[]> {
  await hydrate();
  return state.warmupThreads.filter((t) => t.workspaceId === workspaceId).slice(-limit).reverse();
}
/** Open threads (sent/rescued/opened, not yet replied/failed) the IMAP worker still acts on. */
export async function openWarmupThreads(workspaceId: string): Promise<WarmupThread[]> {
  await hydrate();
  return state.warmupThreads.filter((t) => t.workspaceId === workspaceId && (t.status === "sent" || t.status === "rescued" || t.status === "opened"));
}
