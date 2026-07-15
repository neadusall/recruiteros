/**
 * RecruitersOS · LinkedIn OS
 * Durable stores for the shared engine, in the house pattern: in-memory
 * collections snapshotted through lib/db (file volume in prod, pg fallback).
 *
 * Concurrency model: this app runs as ONE Node process (see lib/db and the
 * automation scheduler). Cross-request atomicity therefore comes from a
 * promise-chain mutex (`withEngineLock`) that serializes every reservation /
 * cancellation / capacity mutation, plus idempotency keys on the ledger so a
 * retried worker can never double-book or double-send. Do not add a second
 * app instance without moving these stores to a real DB with row locking.
 */

import { loadSnapshot, debouncedSaver } from "../../db";
import type {
  AccountPolicy, ActivationBatch, ActivationEntry, LiAccountState,
  LiActionRecord, LiCampaign, LiConversation, LiEnrollment, LiRawEvent,
  PersonIdentity, PersonOutreachState, VoiceApprovalItem, VoiceAsset,
} from "./types";

/** One snapshot-backed collection: hydrate once, mutate in memory, save debounced. */
export interface Collection<T> {
  all(): Promise<T[]>;
  /** Synchronous view AFTER all() has hydrated at least once this boot. */
  items(): T[];
  save(): void;
}

function collection<T>(key: string, cap?: number): Collection<T> {
  let store: T[] = [];
  let hydrating: Promise<void> | null = null;
  const persist = debouncedSaver(key, () => store);
  const hydrate = () => {
    if (!hydrating) {
      hydrating = loadSnapshot<T[]>(key)
        .then((snap) => { if (Array.isArray(snap)) store = snap; })
        .catch(() => { /* memory-only until the store is reachable */ });
    }
    return hydrating;
  };
  return {
    async all() { await hydrate(); return store; },
    items() { return store; },
    save() {
      if (cap && store.length > cap) store.splice(0, store.length - cap);
      persist();
    },
  };
}

/* The collections. One JSON blob each, all workspaces co-mingled, filtered by
 * workspaceId in every read (the established multi-tenancy pattern). */
export const policies = collection<AccountPolicy>("linkedin_os_policies_v1");
export const ledger = collection<LiActionRecord>("linkedin_os_ledger_v1", 20_000);
export const identities = collection<PersonIdentity>("linkedin_os_identities_v1");
export const outreachStates = collection<PersonOutreachState>("linkedin_os_outreach_state_v1");
export const accounts = collection<LiAccountState>("linkedin_os_accounts_v1");
export const campaigns = collection<LiCampaign>("linkedin_os_campaigns_v1");
export const enrollments = collection<LiEnrollment>("linkedin_os_enrollments_v1");
export const conversations = collection<LiConversation>("linkedin_os_inbox_v1");
export const voiceAssets = collection<VoiceAsset>("linkedin_os_voice_assets_v1");
export const voiceApprovals = collection<VoiceApprovalItem>("linkedin_os_voice_approvals_v1", 2_000);
export const activationEntries = collection<ActivationEntry>("linkedin_os_activation_v1", 10_000);
export const activationBatches = collection<ActivationBatch>("linkedin_os_activation_batches_v1");
export const rawEvents = collection<LiRawEvent>("linkedin_os_raw_events_v1", 2_000);

/* ------------------------------------------------------------------ */
/* The engine lock                                                      */
/* ------------------------------------------------------------------ */

let chain: Promise<unknown> = Promise.resolve();

/**
 * Serialize a critical section. Reservation math (read counts, compare against
 * ceilings, write a reservation) must be atomic; two concurrent requests
 * running it interleaved could both see headroom and over-book the account.
 * The promise chain guarantees FIFO execution inside this process.
 */
export function withEngineLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  // Keep the chain alive even when fn throws; the caller still sees the error.
  chain = run.catch(() => undefined);
  return run;
}
