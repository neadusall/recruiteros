/**
 * RecruitersOS · LinkedIn · Per-recruiter seats
 *
 * Maps each signed-in recruiter (`${workspaceId}:${userId}`) to THEIR OWN
 * connected LinkedIn login on the workspace's automation instance, so JD
 * Sourcing's "Search from LinkedIn" pulls a pasted search's members through
 * the recruiter's account (their Sales Navigator / Recruiter seat, their
 * network) instead of one shared workspace seat.
 *
 * Same durability seam as the phone store: in-memory reference store +
 * debounced snapshot (SNAP_KEY "linkedin_seats_v1"), survives restarts when
 * a data volume / DATABASE_URL is set.
 *
 * The connect flow is a hosted sign-in: /api/linkedin/connect mints a
 * single-use token here (beginConnect), sends the recruiter to the provider's
 * hosted wizard with that token as the correlation `name`, and the notify
 * callback redeems it (takePending) to bind the resulting provider account id
 * to exactly the recruiter who clicked Connect. Tokens are unguessable,
 * single-use, and expire after 2 hours, so a callback can never attach an
 * account to anyone else's login.
 */

import { randomBytes } from "node:crypto";
import { nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";

export interface RecruiterSeat {
  workspaceId: string;
  userId: string;
  /** Provider account id of the recruiter's connected LinkedIn login. */
  accountId: string;
  /** Recruiter-facing label (usually the LinkedIn profile's display name). */
  label?: string;
  /** "ok" pulls searches; "reconnect" means LinkedIn signed the session out. */
  status: "ok" | "reconnect";
  connectedAt: string;
  updatedAt: string;
  /** Last live health probe against the provider (throttles re-checks). */
  lastCheckedAt?: string;
}

export interface PendingConnect {
  token: string;
  workspaceId: string;
  userId: string;
  mode: "create" | "reconnect";
  createdAt: string;
}

/** Pending hosted sign-ins older than this are dead (wizard link also expires). */
const PENDING_TTL_MS = 2 * 60 * 60 * 1000;

const store = {
  /** Keyed by `${workspaceId}:${userId}`. */
  seats: {} as Record<string, RecruiterSeat>,
  /** Keyed by single-use token. */
  pending: {} as Record<string, PendingConnect>,
};

/* ---------------- durability ---------------- */

const SNAP_KEY = "linkedin_seats_v1";
const persist = debouncedSaver(SNAP_KEY, () => store);

function hydrate(s: any) {
  if (!s) return;
  store.seats = s.seats ?? {};
  store.pending = s.pending ?? {};
}

let hydrated: Promise<void> | null = null;
export function ensureSeatsReady(): Promise<void> {
  if (!hydrated) {
    hydrated = dbEnabled()
      ? loadSnapshot<any>(SNAP_KEY).then(hydrate).catch(() => {})
      : Promise.resolve();
  }
  return hydrated;
}
void ensureSeatsReady();

const keyOf = (workspaceId: string, userId: string) => `${workspaceId}:${userId}`;

/* ---------------- seats ---------------- */

/** The recruiter's own seat, whatever its health. Null when never connected. */
export async function seatForUser(workspaceId: string, userId: string): Promise<RecruiterSeat | null> {
  await ensureSeatsReady();
  return store.seats[keyOf(workspaceId, userId)] ?? null;
}

/** Any healthy seat in the workspace. For READ-ONLY fallbacks only (e.g. the
 *  Poster's watchlist pulls and stats refresh). Publishing must NEVER use
 *  this: a post belongs to its author's own login. */
export async function anySeatForWorkspace(workspaceId: string): Promise<RecruiterSeat | null> {
  await ensureSeatsReady();
  return Object.values(store.seats).find((s) => s.workspaceId === workspaceId && s.status === "ok") ?? null;
}

export async function upsertSeat(
  workspaceId: string,
  userId: string,
  patch: { accountId: string; label?: string; status?: RecruiterSeat["status"] },
): Promise<RecruiterSeat> {
  await ensureSeatsReady();
  const k = keyOf(workspaceId, userId);
  const prev = store.seats[k];
  const seat: RecruiterSeat = {
    workspaceId,
    userId,
    accountId: patch.accountId,
    label: patch.label ?? (prev?.accountId === patch.accountId ? prev?.label : undefined),
    status: patch.status ?? "ok",
    connectedAt: prev?.accountId === patch.accountId ? prev.connectedAt : nowIso(),
    updatedAt: nowIso(),
    lastCheckedAt: nowIso(),
  };
  store.seats[k] = seat;
  persist();
  return seat;
}

export async function setSeatStatus(
  workspaceId: string,
  userId: string,
  status: RecruiterSeat["status"],
): Promise<void> {
  await ensureSeatsReady();
  const seat = store.seats[keyOf(workspaceId, userId)];
  if (!seat || seat.status === status) return;
  seat.status = status;
  seat.updatedAt = nowIso();
  persist();
}

/** Stamp a live health probe (with an optional status flip) on the seat. */
export async function markSeatChecked(
  workspaceId: string,
  userId: string,
  status?: RecruiterSeat["status"],
  label?: string,
): Promise<void> {
  await ensureSeatsReady();
  const seat = store.seats[keyOf(workspaceId, userId)];
  if (!seat) return;
  seat.lastCheckedAt = nowIso();
  if (status && seat.status !== status) seat.status = status;
  if (label) seat.label = label;
  seat.updatedAt = nowIso();
  persist();
}

export async function removeSeat(workspaceId: string, userId: string): Promise<RecruiterSeat | null> {
  await ensureSeatsReady();
  const k = keyOf(workspaceId, userId);
  const seat = store.seats[k] ?? null;
  if (seat) {
    delete store.seats[k];
    persist();
  }
  return seat;
}

/**
 * Provider webhooks only carry the provider account id: flip every seat bound
 * to it (one login is only ever one recruiter, but stay tolerant). Returns how
 * many seats changed, so callers can no-op quietly for non-seat accounts.
 */
export async function markSeatStatusByAccount(
  accountId: string,
  status: RecruiterSeat["status"],
): Promise<number> {
  await ensureSeatsReady();
  if (!accountId) return 0;
  let changed = 0;
  for (const seat of Object.values(store.seats)) {
    if (seat.accountId === accountId && seat.status !== status) {
      seat.status = status;
      seat.updatedAt = nowIso();
      changed++;
    }
  }
  if (changed) persist();
  return changed;
}

/* ---------------- hosted sign-in handshake ---------------- */

/** Mint the single-use correlation token for one recruiter's hosted sign-in. */
export async function beginConnect(
  workspaceId: string,
  userId: string,
  mode: "create" | "reconnect",
): Promise<string> {
  await ensureSeatsReady();
  prunePending();
  const token = randomBytes(24).toString("base64url");
  store.pending[token] = { token, workspaceId, userId, mode, createdAt: nowIso() };
  persist();
  return token;
}

/** Redeem (and burn) a pending token. Null when unknown or expired. */
export async function takePending(token: string): Promise<PendingConnect | null> {
  await ensureSeatsReady();
  prunePending();
  const p = store.pending[token] ?? null;
  if (p) {
    delete store.pending[token];
    persist();
  }
  return p;
}

function prunePending(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [token, p] of Object.entries(store.pending)) {
    if (new Date(p.createdAt).getTime() < cutoff) delete store.pending[token];
  }
}
