/**
 * RecruitersOS · Senders · HEALTH LEDGER
 *
 * WHY THIS EXISTS. Every sending surface in the portal answered "how is it RIGHT
 * NOW". The warm-up panel recomputed itself on every poll and kept nothing; the
 * guard journal held actions but not conditions; the rest ledger, the fuse, the
 * provider-block radar and the DNS probe each knew one thing and told nobody else.
 * So the two questions that actually matter could not be answered at all:
 *
 *   "Why is this domain not sending, since when, and what caused it?"
 *   "How much life does this domain have left?"
 *
 * This module is the living record. Once per tick it observes every sending
 * domain and every Email ID, writes one dated row per identity per day, and diffs
 * the observation against the last one to OPEN and CLOSE typed events. An event
 * carries the cause code, the evidence that proved it, the moment it started and
 * the moment it ended, so a stoppage has a documented duration rather than a
 * vibe. Cause definitions live in ledgerTypes.ts and are rendered verbatim in the
 * UI: no code reading required to learn what a condition means.
 *
 * SOURCES (all read-only; this module owns no sending decision):
 *   warm-up fleet pull        reputation, warm-up volume, upstream blocks
 *   senders registry          status, credentials, caps, own bounce counters
 *   live DNS probe            SPF/DKIM/DMARC/MX + public blocklists
 *   mpc_deliverability_v1     real cold sends, accepted, hard fails, bounces
 *   mpc_domain_rest_v1        bench/revive history per domain
 *   mpc_send_fuse_v1          the latched fleet stop
 *   provider_blocks_v1        receiver-named refusals (Gmail/Outlook) + IPs
 *   mpc_cold_capacity_v1      parked lanes, benched boxes, ledger freshness
 *   sender_health_guard_v1    guard holds and revives
 *
 * CAPACITY RULE (CLAUDE.md 6-8): this module never invents a capacity number.
 * Fleet capacity is read from the published cold-lane ledger; per-mailbox caps
 * come from the pool's own coldCapFor rule. Nothing here re-sums the fleet.
 */

import { loadSnapshot, saveSnapshot } from "../db";
import { nowIso, rid } from "../core/ids";
import { listInboxes, listSenderWorkspaceIds } from "./store";
import { coldCapFor } from "./limits";
import { coldCapacity } from "./coldLane";
import type { SenderInbox } from "./types";
import { listSmartleadAccounts, smartleadConfigured, type SmartleadAccount } from "../sending/smartlead";
import { probeDnsMany, cachedDns, type DnsPosture } from "../sending/dnsProbe";
import { ensureConfig } from "../sending/config";
import { allBrandPresets, brandToken, brandOwnsDomain } from "../branding/presets";
import { tenantWorkspaceForHost } from "../branding/portal";
import {
  CAUSE_BY_CODE, CAUSES, SEVERITY_RANK, MAILBOX_STATUS_CODES,
  type Blocker, type DomainDay, type IdentityKind, type LedgerEvent, type MailboxDay, type ShelfLife, type Severity,
} from "./ledgerTypes";

export const LEDGER_KEY = "sender_ledger_v1";
export const LEDGER_EVENTS_KEY = "sender_ledger_events_v1";

const DAY_MS = 86_400_000;
/** Domains are few and each row is worth a lot: keep half a year. */
const DOMAIN_DAYS = 180;
/** Hundreds of mailboxes: keep a month of packed rows plus the full event trail. */
const MAILBOX_DAYS = 30;
/** Events retained fleet-wide. Open events are NEVER pruned. */
const EVENT_CAP = 8000;
/** A full observation is expensive (fleet pull + DNS). Never more often than this. */
const MIN_TICK_MS = 20 * 60_000;

/* ------------------------------------------------------------------ */
/* State                                                              */
/* ------------------------------------------------------------------ */

export interface Lifetime {
  daysObserved: number;
  daysBlocked: number;
  wSent: number;          // last observed cumulative warm-up sends
  wSpam: number;
  cSent: number;          // last observed cumulative cold sends
  cFailed: number;
  bounces: number;
  restEpisodes: number;
  blocklistEpisodes: number;
  guardHolds: number;
  providerBlockDays: number;
  authRegressions: number;
  /** Peak reputation ever recorded, so a fall is measurable against a real high. */
  repPeak: number | null;
}

interface IdentityRecord {
  key: string;
  workspaceId: string;
  kind: IdentityKind;
  id: string;              // domain name, or the full email address
  domain: string;
  firstSeen: string;
  lastSeen: string;
  provider?: string;
  ownerName?: string;
  infra?: string;          // sending-ac | internal-smtp | google | unknown
  days: Array<DomainDay | MailboxDay>;
  lifetime: Lifetime;
  /** open cause code -> event id */
  open: Record<string, string>;
  /** Last resolved blockers, kept so a read never has to re-observe. */
  lastBlockers?: Blocker[];
  lastShelf?: ShelfLife;
  lastHealth?: number;
  retiredAt?: string;
}

interface LedgerState {
  version: 1;
  updatedAt?: string;
  lastTickAt?: string;
  identities: Record<string, IdentityRecord>;
}

interface EventState { version: 1; events: LedgerEvent[] }

let state: LedgerState = { version: 1, identities: {} };
let events: EventState = { version: 1, events: [] };
/** id -> event, so closing a condition is a lookup and not a scan of the journal. */
let eventIndex = new Map<string, LedgerEvent>();
let hydrated = false;
let hydrating: Promise<void> | null = null;

function reindexEvents(): void {
  eventIndex = new Map(events.events.map((e) => [e.id, e]));
}

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const [s, e] = await Promise.all([
        loadSnapshot<LedgerState>(LEDGER_KEY),
        loadSnapshot<EventState>(LEDGER_EVENTS_KEY),
      ]);
      if (s && s.identities) state = { version: 1, updatedAt: s.updatedAt, lastTickAt: s.lastTickAt, identities: s.identities };
      if (e && Array.isArray(e.events)) events = { version: 1, events: e.events };
      reindexEvents();
      hydrated = true;
    })();
  }
  return hydrating;
}

/** Both snapshots are written together so a reader never sees an event whose
 *  identity row has not been persisted yet. */
async function persistAll(): Promise<void> {
  state.updatedAt = nowIso();
  await Promise.all([saveSnapshot(LEDGER_KEY, state), saveSnapshot(LEDGER_EVENTS_KEY, events)]);
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

function utcDay(t: number): string { return new Date(t).toISOString().slice(0, 10); }
function round1(n: number): number { return Math.round(n * 10) / 10; }
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }
function domainOf(email: string): string { return (email.split("@")[1] || "").toLowerCase(); }
function idKey(ws: string, kind: IdentityKind, id: string): string { return `${ws}|${kind}|${id}`; }
export function identityRef(kind: IdentityKind, id: string): string { return `${kind}:${id}`; }

const DNS_SPF = 1, DNS_DKIM = 2, DNS_DMARC = 4, DNS_MX = 8;
function dnsMask(p: DnsPosture | null): number {
  if (!p) return -1;   // -1 = unknown; never compared for regression
  return (p.spf ? DNS_SPF : 0) | (p.dkim ? DNS_DKIM : 0) | (p.dmarc ? DNS_DMARC : 0) | (p.mx ? DNS_MX : 0);
}
function dnsNames(mask: number): string[] {
  const out: string[] = [];
  if (mask & DNS_SPF) out.push("SPF");
  if (mask & DNS_DKIM) out.push("DKIM");
  if (mask & DNS_DMARC) out.push("DMARC");
  if (mask & DNS_MX) out.push("MX");
  return out;
}

function isDomainDay(r: DomainDay | MailboxDay): r is DomainDay { return !Array.isArray(r); }

/* ------------------------------------------------------------------ */
/* Source snapshots (host-owned ledgers; we only ever read)           */
/* ------------------------------------------------------------------ */

interface DeliverabilityDomain {
  domain: string; sent: number; accepted: number; failed: number;
  acceptanceRatePct: number; hardFailRatePct: number; bounces: number;
  warmedBoxes?: number; warmingActive?: number; warmupReputationPct?: number;
  auth?: { spf: boolean; dkim: boolean; dmarc: boolean; mx: boolean; spfPolicy?: string; dmarcPolicy?: string; fullyAuthed?: boolean };
  verdict?: string;
  resting?: { until?: string; reason?: string } | null;
}
interface RestRecord { state?: string; reason?: string; since?: string; until?: string | null; history?: Array<{ at: string; event: string; reason?: string; days?: number }> }
interface FuseFleet { tripped?: boolean; scope?: string; domains?: string[]; reason?: string; since?: string }
interface ProviderBlock { fleet?: string; provider?: string; count?: number; lastSeen?: string; blockedIp?: string | null; blocklist?: string | null; sample?: string | null }

interface Sources {
  deliverability: { generatedAt?: string; byDomain: DeliverabilityDomain[] } | null;
  rest: Record<string, RestRecord>;
  fuse: FuseFleet | null;
  providerBlocks: Record<string, ProviderBlock>;
  capacity: Awaited<ReturnType<typeof coldCapacity>>;
  guardHolds: Set<string>;
}

async function readSources(workspaceId: string): Promise<Sources> {
  const [deliv, rest, fuse, blocks, cap] = await Promise.all([
    loadSnapshot<{ generatedAt?: string; byDomain?: DeliverabilityDomain[] }>("mpc_deliverability_v1").catch(() => null),
    loadSnapshot<{ domains?: Record<string, RestRecord> }>("mpc_domain_rest_v1").catch(() => null),
    loadSnapshot<{ fleet?: FuseFleet }>("mpc_send_fuse_v1").catch(() => null),
    loadSnapshot<{ blocks?: Record<string, ProviderBlock> }>("provider_blocks_v1").catch(() => null),
    coldCapacity(workspaceId).catch(() => null),
  ]);
  return {
    deliverability: deliv ? { generatedAt: deliv.generatedAt, byDomain: deliv.byDomain || [] } : null,
    rest: rest?.domains || {},
    fuse: fuse?.fleet || null,
    providerBlocks: blocks?.blocks || {},
    capacity: cap,
    guardHolds: new Set<string>(),
  };
}

/** Receiver-level refusals that are still fresh enough to act on (7 days). */
function activeProviderBlocks(blocks: Record<string, ProviderBlock>): ProviderBlock[] {
  const cutoff = Date.now() - 7 * DAY_MS;
  return Object.values(blocks).filter((b) => b?.lastSeen && Date.parse(b.lastSeen) >= cutoff && (b.count || 0) > 0);
}

/* ------------------------------------------------------------------ */
/* Observation                                                        */
/* ------------------------------------------------------------------ */

/** Everything known about one identity at one moment, before it becomes a row. */
interface Observation {
  kind: IdentityKind;
  id: string;
  domain: string;
  workspaceId: string;
  provider?: string;
  ownerName?: string;
  infra?: string;
  ageDays: number | null;
  rep: number | null;
  wSent: number; wSpam: number;
  cSent: number; cFailed: number; bounces: number;
  boxes: number; sending: number;
  dns: number;
  blocklists: string[];
  blockers: Blocker[];
  health: number;
}

function mk(code: string, detail: string, since?: string): Blocker {
  const c = CAUSE_BY_CODE[code];
  if (!c) {
    return { code, category: "lifecycle", severity: "info", blocking: false, title: code, detail, source: "unknown", fix: "" };
  }
  return {
    code: c.code, category: c.category, severity: c.severity, blocking: c.blocking,
    title: c.title, detail, since, source: c.provenBy, fix: c.fix,
  };
}

/**
 * Order for presentation, and DEDUPE BY CODE. Events are keyed by (identity, code),
 * so two blockers sharing a code would open one event but render twice and be
 * charged twice in the health score. The first of a code wins, because callers
 * push the most specific one first.
 */
function sortBlockers(list: Blocker[]): Blocker[] {
  const seen = new Set<string>();
  const uniq: Blocker[] = [];
  for (const b of list) {
    if (seen.has(b.code)) continue;
    seen.add(b.code);
    uniq.push(b);
  }
  return uniq.sort((a, b) =>
    (b.blocking ? 1 : 0) - (a.blocking ? 1 : 0) ||
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    a.code.localeCompare(b.code));
}

/**
 * Composite health, 0-100. Deliberately the same shape as the warm-up panel's
 * score so the two never disagree, extended with the cold-lane signals the panel
 * could not see: real bounces, receiver refusals and open blocking conditions.
 */
function healthScore(o: Omit<Observation, "health" | "blockers">, blockers: Blocker[]): number {
  let s = 0;
  s += (o.rep ?? 50) * 0.4;                                             // 0-40 reputation
  const spamPct = o.wSent > 0 ? (o.wSpam / o.wSent) * 100 : null;
  s += spamPct == null || spamPct <= 0.5 ? 12 : spamPct <= 2 ? 6 : 0;   // 0-12 warm-up placement
  const bouncePct = o.cSent > 0 ? (o.bounces / o.cSent) * 100 : null;
  s += bouncePct == null ? 10 : bouncePct <= 2 ? 16 : bouncePct <= 5 ? 10 : bouncePct <= 12 ? 4 : 0; // 0-16 real bounces
  if (o.dns >= 0) {
    s += (o.dns & DNS_SPF ? 8 : 0) + (o.dns & DNS_DMARC ? 8 : 0) + (o.dns & DNS_MX ? 4 : 0) + (o.dns & DNS_DKIM ? 4 : 0); // 0-24
  } else {
    s += 4; // unknown DNS scores like a bare-MX domain, never like a verified one
  }
  s += o.boxes > 0 && o.sending > 0 ? 8 : 0;                            // 0-8 actually usable
  // Penalties are bounded in total: a domain with six open conditions is worse than
  // one with two, but flooring every troubled domain at zero destroys the ranking
  // that makes this board usable.
  let penalty = 0;
  for (const b of blockers) {
    if (b.severity === "critical") penalty += b.blocking ? 22 : 14;
    else if (b.severity === "warn") penalty += 8;
  }
  s -= Math.min(penalty, 55);
  if (o.blocklists.length) s = Math.min(s, 35);                         // a listing caps the score, whatever else is true
  return clamp(Math.round(s), 0, 100);
}

/** Reputation slope over the recorded series: points per day across the window. */
function repSlope(days: Array<DomainDay | MailboxDay>, windowDays: number): { slope: number; from: number; to: number } | null {
  const pts: Array<{ t: number; v: number }> = [];
  for (const r of days) {
    const d = isDomainDay(r) ? r.d : r[0];
    const v = isDomainDay(r) ? r.rep : r[1];
    if (v == null) continue;
    pts.push({ t: Date.parse(d + "T00:00:00Z"), v });
  }
  if (pts.length < 3) return null;
  const cutoff = Date.now() - windowDays * DAY_MS;
  const win = pts.filter((p) => p.t >= cutoff);
  if (win.length < 3) return null;
  const first = win[0], last = win[win.length - 1];
  const spanDays = Math.max(1, (last.t - first.t) / DAY_MS);
  return { slope: round1((last.v - first.v) / spanDays), from: first.v, to: last.v };
}

/* ------------------------------------------------------------------ */
/* Shelf life                                                         */
/* ------------------------------------------------------------------ */

/**
 * Sends a clean, well-authenticated domain is expected to carry before rotation
 * is prudent. Not a hard law of nature; a stated assumption, tunable, and shown
 * in the UI next to the number it produces so nobody mistakes it for physics.
 */
function shelfBaseSends(): number {
  const n = Number(process.env.SENDER_SHELF_BASE_SENDS);
  return Number.isFinite(n) && n >= 250 ? Math.floor(n) : 5000;
}

/**
 * WEAR MODEL. A sending identity does not die of old age, it dies of accumulated
 * bad outcomes. Every contribution is itemised and returned, so the score is
 * always explainable down to the point.
 */
function shelfLife(rec: IdentityRecord, obs: Observation | null, blockers: Blocker[]): ShelfLife {
  const lt = rec.lifetime;
  const contributions: ShelfLife["contributions"] = [];
  const base = shelfBaseSends();
  const perBoxScale = rec.kind === "mailbox" ? 0.25 : 1; // a mailbox carries a share of a domain's budget

  const volume = clamp((lt.cSent / (base * perBoxScale)) * 45, 0, 45);
  if (volume > 0.5) contributions.push({ label: "Volume carried", points: round1(volume), detail: `${lt.cSent.toLocaleString()} cold sends against an assumed ${Math.round(base * perBoxScale).toLocaleString()}-send shelf` });

  const bounceRate = lt.cSent > 0 ? (lt.bounces / lt.cSent) * 100 : null;
  const bouncePts = bounceRate == null ? 0 : clamp(bounceRate * 1.6, 0, 30);
  if (bouncePts > 0.5) contributions.push({ label: "Bounces taken", points: round1(bouncePts), detail: `${lt.bounces.toLocaleString()} bounces on ${lt.cSent.toLocaleString()} sends (${round1(bounceRate || 0)}%)` });

  const restPts = clamp(lt.restEpisodes * 6, 0, 24);
  if (restPts > 0) contributions.push({ label: "Rest episodes", points: restPts, detail: `benched ${lt.restEpisodes} time${lt.restEpisodes === 1 ? "" : "s"} after burn signals` });

  const blPts = clamp(lt.blocklistEpisodes * 25, 0, 50);
  if (blPts > 0) contributions.push({ label: "Blocklist listings", points: blPts, detail: `${lt.blocklistEpisodes} public listing${lt.blocklistEpisodes === 1 ? "" : "s"} recorded` });

  const guardPts = clamp(lt.guardHolds * 3, 0, 15);
  if (guardPts > 0) contributions.push({ label: "Guard holds", points: guardPts, detail: `pulled from rotation ${lt.guardHolds} time${lt.guardHolds === 1 ? "" : "s"} by the health guard` });

  const pbPts = clamp(lt.providerBlockDays * 2, 0, 20);
  if (pbPts > 0) contributions.push({ label: "Receiver refusals", points: pbPts, detail: `${lt.providerBlockDays} day${lt.providerBlockDays === 1 ? "" : "s"} with a mailbox provider refusing us` });

  const authPts = clamp(lt.authRegressions * 5, 0, 15);
  if (authPts > 0) contributions.push({ label: "Authentication regressions", points: authPts, detail: `${lt.authRegressions} time${lt.authRegressions === 1 ? "" : "s"} a published DNS record disappeared` });

  const slope = repSlope(rec.days, 14);
  let slopePts = 0;
  if (slope && slope.slope < -0.5) {
    slopePts = clamp(Math.abs(slope.slope) * 4, 0, 15);
    contributions.push({ label: "Reputation trend", points: round1(slopePts), detail: `falling ${Math.abs(slope.slope)} points a day over the last two weeks (${slope.from}% to ${slope.to}%)` });
  }

  const wearPct = clamp(Math.round(volume + bouncePts + restPts + blPts + guardPts + pbPts + authPts + slopePts), 0, 100);

  // Wear rate: measured from the recorded wear series rather than assumed.
  let wearPerDay: number | null = null;
  const wearPts: Array<{ t: number; w: number }> = [];
  for (const r of rec.days) if (isDomainDay(r)) wearPts.push({ t: Date.parse(r.d + "T00:00:00Z"), w: r.wear });
  if (wearPts.length >= 3) {
    const cutoff = Date.now() - 14 * DAY_MS;
    const win = wearPts.filter((p) => p.t >= cutoff);
    if (win.length >= 3) {
      const span = Math.max(1, (win[win.length - 1].t - win[0].t) / DAY_MS);
      const delta = win[win.length - 1].w - win[0].w;
      wearPerDay = delta > 0 ? round1(delta / span) : 0;
    }
  }

  const ageDays = obs?.ageDays ?? null;
  const daysRemaining = wearPerDay && wearPerDay > 0.05 ? Math.max(0, Math.round((100 - wearPct) / wearPerDay)) : null;
  const retireBy = daysRemaining != null ? utcDay(Date.now() + daysRemaining * DAY_MS) : null;
  const dailySend = obs && obs.sending > 0 && rec.days.length > 1 ? recentDailySends(rec) : null;
  const sendsRemaining = daysRemaining != null && dailySend != null ? Math.round(daysRemaining * dailySend) : null;

  let stage: ShelfLife["stage"];
  if (rec.retiredAt) stage = "retired";
  else if (wearPct >= 85) stage = "burned";
  else if (wearPct >= 60) stage = "fatigued";
  else if (ageDays != null && ageDays < 3) stage = "provisioning";
  else if (blockers.some((b) => b.code === "warming")) stage = "warming";
  else if (lt.cSent > 200 && wearPct < 40) stage = "prime";
  else stage = "ready";

  const verdict =
    stage === "retired" ? "Retired. Kept on the board so its history stays readable."
    : stage === "burned" ? "Burned. Every further send from here costs more reputation than it earns. Retire it."
    : stage === "fatigued" ? `Fatigued at ${wearPct}% wear${daysRemaining != null ? `, about ${daysRemaining} days of useful life left at the current rate` : ""}. Start rotating a replacement in now.`
    : stage === "prime" ? `In its prime: ${lt.cSent.toLocaleString()} sends carried at ${wearPct}% wear.`
    : stage === "provisioning" ? "Brand new. No shelf life consumed yet."
    : stage === "warming" ? "Still warming. Shelf life is not consumed by warm-up mail, only by cold volume and bad outcomes."
    : `Healthy at ${wearPct}% wear${daysRemaining != null ? `, roughly ${daysRemaining} days of life left at the current rate` : ", not measurably wearing yet"}.`;

  return {
    stage, wearPct, contributions,
    ageDays, lifetimeSent: lt.cSent, lifetimeBounced: lt.bounces,
    bounceRatePct: bounceRate == null ? null : round1(bounceRate),
    wearPerDay, daysRemaining, retireBy, sendsRemaining, verdict,
  };
}

/** Average cold sends per day over the recorded window, from cumulative deltas. */
function recentDailySends(rec: IdentityRecord): number | null {
  const pts: Array<{ t: number; c: number }> = [];
  for (const r of rec.days) {
    const d = isDomainDay(r) ? r.d : r[0];
    const c = isDomainDay(r) ? r.cSent : r[4];
    pts.push({ t: Date.parse(d + "T00:00:00Z"), c });
  }
  if (pts.length < 2) return null;
  const cutoff = Date.now() - 14 * DAY_MS;
  const win = pts.filter((p) => p.t >= cutoff);
  if (win.length < 2) return null;
  const span = Math.max(1, (win[win.length - 1].t - win[0].t) / DAY_MS);
  const delta = win[win.length - 1].c - win[0].c;
  return delta > 0 ? round1(delta / span) : 0;
}

/* ------------------------------------------------------------------ */
/* Event open/close                                                   */
/* ------------------------------------------------------------------ */

function openEvent(rec: IdentityRecord, b: Blocker, evidence: Record<string, unknown>, at: string): LedgerEvent {
  const ev: LedgerEvent = {
    id: rid("sev"),
    workspaceId: rec.workspaceId,
    identity: identityRef(rec.kind, rec.id),
    kind: rec.kind,
    code: b.code,
    severity: b.severity,
    detail: b.detail,
    openedAt: at,
    evidence,
  };
  events.events.unshift(ev);
  eventIndex.set(ev.id, ev);
  rec.open[b.code] = ev.id;
  return ev;
}

function closeEvent(rec: IdentityRecord, code: string, at: string): LedgerEvent | null {
  const id = rec.open[code];
  delete rec.open[code];
  if (!id) return null;
  const ev = eventIndex.get(id);
  if (!ev || ev.closedAt) return null;
  ev.closedAt = at;
  ev.hoursOpen = round1((Date.parse(at) - Date.parse(ev.openedAt)) / 3_600_000);
  return ev;
}

/** Keep the journal bounded without ever dropping something still open. */
function pruneEvents(): void {
  if (events.events.length <= EVENT_CAP) return;
  const open = events.events.filter((e) => !e.closedAt);
  const closed = events.events.filter((e) => !!e.closedAt)
    .sort((a, b) => Date.parse(b.closedAt || "") - Date.parse(a.closedAt || ""));
  events.events = [...open, ...closed.slice(0, Math.max(0, EVENT_CAP - open.length))]
    .sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));
  reindexEvents();
}

/* ------------------------------------------------------------------ */
/* Blocker resolution — "why is this not sending?"                    */
/* ------------------------------------------------------------------ */

interface ResolveCtx {
  now: number;
  src: Sources;
  dns: DnsPosture | null;
  deliv: DeliverabilityDomain | null;
  rest: RestRecord | null;
  fuseHit: boolean;
  providerHits: ProviderBlock[];
  lanesParked: string[];
  prevDnsMask: number;
  prevRep: number | null;
  ageDays: number | null;
  readyAfterDays: number;
}

/** Conditions shared by a domain and every mailbox on it. */
function domainLevelBlockers(domain: string, ctx: ResolveCtx, rep: number | null): Blocker[] {
  const out: Blocker[] = [];
  const bl = ctx.dns?.dnsbl?.lists || [];
  if (ctx.dns?.dnsbl?.listed && bl.length) {
    out.push(mk("blocklist.listed", `${domain} is listed on ${bl.join(", ")}. Receivers consulting these lists refuse the connection before they ever see the message.`));
  }
  if (ctx.fuseHit) {
    const f = ctx.src.fuse;
    out.push(mk("fuse.tripped", `The send fuse is latched${f?.reason ? `: ${f.reason}` : ""}${f?.since ? `, since ${f.since.slice(0, 16).replace("T", " ")}Z` : ""}. Nothing cold sends until a person clears it.`, f?.since));
  }
  if (ctx.rest?.state === "resting" && (!ctx.rest.until || Date.parse(ctx.rest.until) > ctx.now)) {
    const until = ctx.rest.until ? new Date(ctx.rest.until) : null;
    const daysLeft = until ? Math.max(0, Math.ceil((until.getTime() - ctx.now) / DAY_MS)) : null;
    out.push(mk("domain.resting", `Benched by the rest fail-safe${ctx.rest.reason ? `: ${ctx.rest.reason}` : ""}.${daysLeft != null ? ` It lifts on its own in ${daysLeft} day${daysLeft === 1 ? "" : "s"} (${until!.toISOString().slice(0, 10)}).` : ""}`, ctx.rest.since));
  }
  if (ctx.providerHits.length) {
    // One condition, however many receivers are refusing: the operator needs the
    // whole picture in a sentence, not one chip per provider.
    const name = (p?: string) => (p === "google" ? "Gmail" : p === "microsoft" ? "Outlook" : p || "a receiver");
    const parts = ctx.providerHits
      .slice()
      .sort((a, b) => (b.count || 0) - (a.count || 0))
      .map((pb) => `${name(pb.provider)} refused ${(pb.count || 0).toLocaleString()} deliveries from the ${pb.fleet || "sending"} fleet${pb.blockedIp ? `, naming IP ${pb.blockedIp}` : ""}${pb.blocklist ? ` and blocklist ${pb.blocklist}` : ""}`);
    const newest = ctx.providerHits.map((pb) => pb.lastSeen || "").sort().slice(-1)[0] || undefined;
    const ips = [...new Set(ctx.providerHits.map((pb) => pb.blockedIp).filter(Boolean))];
    out.push(mk("provider.block",
      `${parts.join("; ")}. Last refusal ${(newest || "").slice(0, 16).replace("T", " ")}Z.${ips.length ? ` The IP the receivers named is the asset to replace here, not the domain: ${ips.join(", ")}.` : ""}`,
      newest));
  }
  if (ctx.dns) {
    if (!ctx.dns.spf) out.push(mk("auth.spf.missing", `No SPF record answers at ${domain}.`));
    if (!ctx.dns.dmarc) out.push(mk("auth.dmarc.missing", `No _dmarc record answers at ${domain}.`));
    if (!ctx.dns.mx) out.push(mk("auth.mx.missing", `No MX record answers at ${domain}, so nothing can reply to it.`));
    if (!ctx.dns.dkim) out.push(mk("auth.dkim.missing", `No DKIM key answered on the selectors checked for ${domain}.`));
    const cur = dnsMask(ctx.dns);
    if (ctx.prevDnsMask >= 0 && cur >= 0) {
      const lost = ctx.prevDnsMask & ~cur;
      if (lost) out.push(mk("auth.regressed", `${dnsNames(lost).join(" and ")} was published on ${domain} and is now gone. Someone changed DNS.`));
    }
  }
  if (rep != null && ctx.prevRep != null && ctx.prevRep - rep >= 15) {
    out.push(mk("rep.collapse", `Warm-up reputation fell from ${ctx.prevRep}% to ${rep}% since the last recorded observation.`));
  }
  if (rep != null && ctx.ageDays != null && ctx.ageDays >= 7 && rep < 60) {
    out.push(mk("rep.low.mature", `${round1(ctx.ageDays)} days of warm-up banked but reputation is only ${rep}%.`));
  }
  if (ctx.src.capacity?.stale) {
    out.push(mk("ledger.stale", `The sender last published its capacity ledger ${ctx.src.capacity.ageMinutes} minutes ago. The send loop is not running, so today's numbers are history.`));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The tick                                                           */
/* ------------------------------------------------------------------ */

export interface LedgerTickReport {
  at: string;
  skipped?: "debounced" | "no_workspaces";
  workspaces: number;
  domains: number;
  mailboxes: number;
  opened: Array<{ identity: string; code: string; detail: string }>;
  closed: Array<{ identity: string; code: string; hoursOpen: number }>;
  blockingNow: number;
  fleetHealth: number | null;
}

export async function recordLedgerTick(opts: { force?: boolean } = {}): Promise<LedgerTickReport> {
  await hydrate();
  const now = Date.now();
  const at = new Date(now).toISOString();
  if (!opts.force && state.lastTickAt && now - Date.parse(state.lastTickAt) < MIN_TICK_MS) {
    return { at, skipped: "debounced", workspaces: 0, domains: 0, mailboxes: 0, opened: [], closed: [], blockingNow: 0, fleetHealth: null };
  }
  await ensureConfig();

  const workspaceIds = await listSenderWorkspaceIds();
  if (!workspaceIds.length) {
    state.lastTickAt = at;
    await persistAll();
    return { at, skipped: "no_workspaces", workspaces: 0, domains: 0, mailboxes: 0, opened: [], closed: [], blockingNow: 0, fleetHealth: null };
  }

  // Warm-up fleet, once for the whole tick.
  let fleet: SmartleadAccount[] = [];
  if (smartleadConfigured()) {
    try { fleet = await listSmartleadAccounts(); } catch { fleet = []; }
  }
  const fleetByEmail = new Map(fleet.map((a) => [a.email.toLowerCase(), a]));

  // Which workspace owns an un-imported warm-up domain: a brand's own portal, or
  // nobody. Never guess the house portal, that would leak a tenant's fleet.
  const brandWs: Array<{ token: string; ws: string }> = [];
  for (const p of allBrandPresets()) {
    const ws = tenantWorkspaceForHost(p.appHost);
    if (ws) brandWs.push({ token: brandToken(p.brandName), ws });
  }

  const report: LedgerTickReport = { at, workspaces: workspaceIds.length, domains: 0, mailboxes: 0, opened: [], closed: [], blockingNow: 0, fleetHealth: null };
  const healths: number[] = [];

  for (const ws of workspaceIds) {
    const src = await readSources(ws);
    const inboxes = await listInboxes(ws);
    const byDomain = new Map<string, SenderInbox[]>();
    for (const m of inboxes) {
      const d = domainOf(m.email);
      if (!d) continue;
      const list = byDomain.get(d) || [];
      list.push(m);
      byDomain.set(d, list);
    }
    // Warm-up domains this workspace owns by brand but has not imported: they are
    // real assets on the shelf and must appear on the board.
    const wsTokens = brandWs.filter((b) => b.ws === ws).map((b) => b.token);
    for (const a of fleet) {
      const d = domainOf(a.email);
      if (!d || byDomain.has(d)) continue;
      if (wsTokens.some((t) => brandOwnsDomain(d, t))) byDomain.set(d, []);
    }
    if (!byDomain.size) continue;

    const domainNames = [...byDomain.keys()];
    // Timeboxed: whatever resolves in time is recorded now, the rest fills the
    // probe cache for the next tick. Never let DNS hold the whole ledger hostage.
    await Promise.race([probeDnsMany(domainNames), new Promise((r) => setTimeout(r, 12_000))]);

    const delivByDomain = new Map((src.deliverability?.byDomain || []).map((r) => [r.domain.toLowerCase(), r]));
    const fuse = src.fuse;
    const fuseDomains = new Set((fuse?.domains || []).map((x) => String(x).toLowerCase()));
    const pblocks = activeProviderBlocks(src.providerBlocks);
    const lanesParked = src.capacity?.lanesParked || [];

    for (const [domain, boxes] of byDomain) {
      const accounts = fleet.filter((a) => domainOf(a.email) === domain);
      const dns = cachedDns(domain);
      const deliv = delivByDomain.get(domain) || null;
      const rest = src.rest[domain] || null;
      const fuseHit = !!fuse?.tripped && (fuse.scope === "all" || fuseDomains.has(domain));

      const reps = accounts.map((a) => a.reputationPct).filter((r): r is number => typeof r === "number");
      const rep = reps.length ? Math.round(reps.reduce((s, r) => s + r, 0) / reps.length)
        : (typeof deliv?.warmupReputationPct === "number" ? deliv.warmupReputationPct : null);
      const starts = accounts.map((a) => a.warmupStartedAt || a.createdAt).filter((c): c is string => !!c).sort();
      const youngest = starts.length ? starts[starts.length - 1] : (boxes.length ? boxes.map((b) => b.createdAt).sort().slice(-1)[0] : null);
      const ageDays = youngest ? round1((now - Date.parse(youngest)) / DAY_MS) : null;

      const infra = classifyInfraKind(boxes, accounts, dns);
      const readyAfterDays = infra === "internal-smtp" ? 30 : 14;

      const domRec = ensureRecord(ws, "domain", domain, domain, { infra });
      const prev = lastDomainDay(domRec);

      const ctx: ResolveCtx = {
        now, src, dns, deliv, rest, fuseHit,
        providerHits: pblocks.filter((b) => matchesFleet(b, infra)),
        lanesParked,
        prevDnsMask: prev ? prev.dns : -1,
        prevRep: prev ? prev.rep : null,
        ageDays, readyAfterDays,
      };

      const dBlockers = domainLevelBlockers(domain, ctx, rep);

      // Cold-lane truth for the domain.
      const cSent = deliv?.sent ?? 0;
      const cFailed = deliv?.failed ?? 0;
      const bounces = deliv?.bounces ?? 0;
      const bouncePct = cSent > 0 ? (bounces / cSent) * 100 : null;
      if (bouncePct != null && cSent >= 25 && bouncePct > 5) {
        dBlockers.push(mk("bounce.rate.high", `${bounces.toLocaleString()} bounces against ${cSent.toLocaleString()} real sends (${round1(bouncePct)}%), over the 5% ceiling.`));
      }
      const wSent = accounts.reduce((s, a) => s + (a.sentTotal || 0), 0);
      const wSpam = accounts.reduce((s, a) => s + (a.spamCount || 0), 0);
      const spamPct = wSent > 0 ? (wSpam / wSent) * 100 : null;
      if (spamPct != null && spamPct > 2) {
        dBlockers.push(mk("spam.rate.high", `${wSpam.toLocaleString()} of ${wSent.toLocaleString()} warm-up messages were filed as spam (${round1(spamPct)}%).`));
      }
      if (lanesParked.includes(laneOf(infra))) {
        dBlockers.push(mk("lane.parked", `The ${laneOf(infra)} lane is parked today, so every mailbox on this domain carries zero cold capacity whatever its own health.`));
      }
      if (ageDays != null && ageDays < readyAfterDays && !dBlockers.some((b) => b.code === "domain.resting")) {
        dBlockers.push(mk("warming", `Day ${Math.floor(ageDays)} of the ${readyAfterDays}-day warm for ${infra === "internal-smtp" ? "an internal SMTP" : "a provider-run"} domain.`));
      }
      if (boxes.length === 0 && accounts.length > 0) {
        dBlockers.push(mk("not.imported", `${accounts.length} mailbox${accounts.length === 1 ? " is" : "es are"} warming on this domain but none is imported as an Email ID here, so none can ever be picked to send.`));
      }

      // Per-mailbox pass, which also tells the domain how many boxes can send.
      let sending = 0;
      const mailboxRefs: string[] = [];
      for (const m of boxes) {
        const acct = fleetByEmail.get(m.email.toLowerCase());
        const mb = mailboxBlockers(m, acct, dBlockers, ctx, infra);
        const cap = coldCapFor(m);
        if (cap > 0 && !mb.some((b) => b.blocking)) sending++;
        const mrec = ensureRecord(ws, "mailbox", m.email, domain, { provider: m.provider, ownerName: m.ownerName, infra });
        const mrep = acct?.reputationPct ?? null;
        const mObs: Observation = {
          kind: "mailbox", id: m.email, domain, workspaceId: ws,
          provider: m.provider, ownerName: m.ownerName, infra,
          ageDays: m.createdAt ? round1((now - Date.parse(m.createdAt)) / DAY_MS) : null,
          rep: mrep,
          wSent: acct?.sentTotal || 0, wSpam: acct?.spamCount || 0,
          cSent: m.sent || 0, cFailed: 0, bounces: m.bounced || 0,
          boxes: 1, sending: cap > 0 && !mb.some((b) => b.blocking) ? 1 : 0,
          dns: dnsMask(dns), blocklists: dns?.dnsbl?.lists || [],
          blockers: sortBlockers(mb), health: 0,
        };
        mObs.health = healthScore(mObs, mObs.blockers);
        commit(mrec, mObs, at, report);
        mailboxRefs.push(m.email);
        report.mailboxes++;
      }

      const dObs: Observation = {
        kind: "domain", id: domain, domain, workspaceId: ws, infra,
        ageDays, rep,
        wSent, wSpam, cSent, cFailed, bounces,
        boxes: boxes.length || accounts.length, sending,
        dns: dnsMask(dns), blocklists: dns?.dnsbl?.lists || [],
        blockers: sortBlockers(dBlockers), health: 0,
      };
      dObs.health = healthScore(dObs, dObs.blockers);
      commit(domRec, dObs, at, report);
      healths.push(dObs.health);
      report.domains++;
      if (dObs.blockers.some((b) => b.blocking)) report.blockingNow++;
    }
  }

  pruneStaleIdentities(now);
  pruneEvents();
  state.lastTickAt = at;
  await persistAll();
  report.fleetHealth = healths.length ? Math.round(healths.reduce((s, h) => s + h, 0) / healths.length) : null;
  return report;
}

/** Which cold lane an infrastructure kind belongs to, matching the sender's own keys. */
function laneOf(infra: string): string {
  return infra === "sending-ac" ? "sendingac" : infra === "internal-smtp" ? "internal" : infra === "google" ? "google" : "other";
}

/** A receiver refusal is attributed to the fleet the sweep recorded it against. */
function matchesFleet(b: ProviderBlock, infra: string): boolean {
  const f = String(b.fleet || "").toLowerCase();
  if (!f) return false;
  if (infra === "internal-smtp") return f.includes("internal");
  if (infra === "google") return f.includes("google") || f.includes("zapmail");
  if (infra === "sending-ac") return f.includes("sending") || f.includes("ac");
  return false;
}

function classifyInfraKind(boxes: SenderInbox[], accounts: SmartleadAccount[], dns: DnsPosture | null): string {
  const provs = new Set(boxes.map((b) => b.provider));
  if (provs.has("sending-ac")) return "sending-ac";
  if (provs.has("own-smtp")) return "internal-smtp";
  if (provs.has("google")) return "google";
  const hosts = accounts.map((a) => (a.smtpHost || "").toLowerCase()).join(" ");
  if (hosts.includes("gmail")) return "google";
  const mx = (dns?.mxHosts || []).join(" ").toLowerCase();
  if (/protection\.outlook\.com/.test(mx)) return "sending-ac";
  if (/google(mail)?\.com/.test(mx)) return "google";
  return "unknown";
}

/** Everything that stops ONE mailbox, on top of whatever stops its whole domain. */
function mailboxBlockers(m: SenderInbox, acct: SmartleadAccount | undefined, domainBlockers: Blocker[], ctx: ResolveCtx, infra: string): Blocker[] {
  const out: Blocker[] = domainBlockers.filter((b) => b.code !== "not.imported").map((b) => ({ ...b }));
  if (m.status === "error") {
    out.push(mk("smtp.auth", `SMTP login is failing${m.lastError ? `: ${String(m.lastError).slice(0, 180)}` : ""}.`, m.updatedAt));
  }
  if (m.autoHold) {
    out.push(mk("guard.hold", `The health guard pulled this mailbox${m.autoHoldReason ? `: ${m.autoHoldReason}` : ""}. It revives itself once it passes two consecutive healthy checks.`, m.autoHoldAt));
  } else if (m.status === "paused") {
    out.push(mk("operator.paused", `Paused by hand${m.pausedReason ? `: ${m.pausedReason}` : " with no reason recorded"}.`, m.updatedAt));
  }
  if (!m.smtpPassEnc) {
    out.push(mk("no.credentials", "No SMTP credential is stored here, so the send rotation never picks this mailbox. It is tracked and counted only."));
  }
  if (acct?.blockedReason) {
    out.push(mk("warmup.blocked", `Warm-up is halted upstream: ${acct.blockedReason}`));
  } else if (acct && acct.warmupStatus === "paused") {
    out.push(mk("warmup.paused", "Warm-up is switched off for this mailbox, so its reputation is decaying rather than climbing."));
  }
  const cap = coldCapFor(m);
  const ageDays = m.createdAt ? (Date.now() - Date.parse(m.createdAt)) / DAY_MS : null;
  if (cap === 0 && m.status !== "paused" && m.status !== "error" && ageDays != null && ageDays < 3) {
    out.push(mk("age.too.young", `Imported ${round1(ageDays)} days ago. Cold sending opens at 3 days.`, m.createdAt));
  }
  if (cap > 0 && m.sentToday >= cap) {
    out.push(mk("cap.exhausted", `Sent ${m.sentToday} of ${cap} allowed today.`));
  }
  const bouncePct = m.sent > 0 ? (m.bounced / m.sent) * 100 : null;
  if (bouncePct != null && m.sent >= 25 && bouncePct > 5) {
    out.push(mk("bounce.rate.high", `${m.bounced} bounces on ${m.sent} sends from this mailbox (${round1(bouncePct)}%).`));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Commit an observation into the record                              */
/* ------------------------------------------------------------------ */

function ensureRecord(ws: string, kind: IdentityKind, id: string, domain: string, meta: { provider?: string; ownerName?: string; infra?: string }): IdentityRecord {
  const key = idKey(ws, kind, id);
  let rec = state.identities[key];
  if (!rec) {
    rec = state.identities[key] = {
      key, workspaceId: ws, kind, id, domain,
      firstSeen: nowIso(), lastSeen: nowIso(),
      days: [], open: {},
      lifetime: {
        daysObserved: 0, daysBlocked: 0, wSent: 0, wSpam: 0, cSent: 0, cFailed: 0, bounces: 0,
        restEpisodes: 0, blocklistEpisodes: 0, guardHolds: 0, providerBlockDays: 0, authRegressions: 0, repPeak: null,
      },
    };
  }
  if (meta.provider) rec.provider = meta.provider;
  if (meta.ownerName) rec.ownerName = meta.ownerName;
  if (meta.infra) rec.infra = meta.infra;
  return rec;
}

function lastDomainDay(rec: IdentityRecord): DomainDay | null {
  for (let i = rec.days.length - 1; i >= 0; i--) {
    const r = rec.days[i];
    if (isDomainDay(r)) return r;
  }
  return null;
}

/** Fold one observation in: update lifetime counters, upsert today's row, open
 *  and close events against the previous state. */
function commit(rec: IdentityRecord, o: Observation, at: string, report: LedgerTickReport): void {
  const day = utcDay(Date.parse(at));
  const lt = rec.lifetime;

  // Cumulative counters from upstream can only move forward; a source that resets
  // (a campaign rebuild, a fleet re-provision) must never make history smaller.
  lt.wSent = Math.max(lt.wSent, o.wSent);
  lt.wSpam = Math.max(lt.wSpam, o.wSpam);
  lt.cSent = Math.max(lt.cSent, o.cSent);
  lt.cFailed = Math.max(lt.cFailed, o.cFailed);
  lt.bounces = Math.max(lt.bounces, o.bounces);
  if (o.rep != null) lt.repPeak = lt.repPeak == null ? o.rep : Math.max(lt.repPeak, o.rep);
  rec.lastSeen = at;

  const openNow = new Set(o.blockers.map((b) => b.code));
  const wasOpen = new Set(Object.keys(rec.open));

  for (const b of o.blockers) {
    if (wasOpen.has(b.code)) continue;
    openEvent(rec, b, {
      rep: o.rep, cSent: o.cSent, bounces: o.bounces, dns: dnsNames(o.dns),
      blocklists: o.blocklists, health: o.health, infra: o.infra,
    }, at);
    if (report.opened.length < 200) report.opened.push({ identity: identityRef(rec.kind, rec.id), code: b.code, detail: b.detail });
    // Episode counters: what the shelf-life model charges wear against.
    if (b.code === "domain.resting") lt.restEpisodes++;
    if (b.code === "blocklist.listed") lt.blocklistEpisodes++;
    if (b.code === "guard.hold") lt.guardHolds++;
    if (b.code === "auth.regressed") lt.authRegressions++;
  }
  for (const code of wasOpen) {
    if (openNow.has(code)) continue;
    const ev = closeEvent(rec, code, at);
    if (ev && report.closed.length < 200) report.closed.push({ identity: ev.identity, code, hoursOpen: ev.hoursOpen || 0 });
  }
  // Day-scale counters are charged ONCE per calendar day, not once per tick, or a
  // 20-minute cadence would bill 72 "days" of wear a day and the shelf-life model
  // would read every incident as a catastrophe.
  const firstObservationToday = !hasDay(rec, day);
  if (firstObservationToday) {
    if (openNow.has("provider.block")) lt.providerBlockDays++;
    if (o.blockers.some((b) => b.blocking)) lt.daysBlocked++;
  }

  const shelf = shelfLife(rec, o, o.blockers);
  rec.lastBlockers = o.blockers;
  rec.lastShelf = shelf;
  rec.lastHealth = o.health;

  if (rec.kind === "domain") {
    const row: DomainDay = {
      d: day, rep: o.rep, wSent: o.wSent, wSpam: o.wSpam,
      cSent: o.cSent, cFailed: o.cFailed, bounces: o.bounces,
      boxes: o.boxes, sending: o.sending, dns: o.dns, bl: o.blocklists.length,
      open: [...openNow], wear: shelf.wearPct, health: o.health,
    };
    upsertDay(rec, day, row, DOMAIN_DAYS);
  } else {
    const status: typeof MAILBOX_STATUS_CODES[number] =
      o.blockers.some((b) => b.code === "guard.hold") ? "held"
      : o.blockers.some((b) => b.code === "smtp.auth") ? "error"
      : o.blockers.some((b) => b.code === "operator.paused") ? "paused"
      : o.blockers.some((b) => b.code === "warming") ? "warming"
      : o.sending > 0 ? "active" : "unknown";
    const row: MailboxDay = [day, o.rep, o.wSent, o.wSpam, o.cSent, o.bounces,
      Math.max(0, MAILBOX_STATUS_CODES.indexOf(status)), o.blockers.filter((b) => b.blocking).length];
    upsertDay(rec, day, row, MAILBOX_DAYS);
  }
}

function hasDay(rec: IdentityRecord, day: string): boolean {
  for (let i = rec.days.length - 1; i >= 0; i--) {
    const r = rec.days[i];
    if ((isDomainDay(r) ? r.d : r[0]) === day) return true;
  }
  return false;
}

function upsertDay(rec: IdentityRecord, day: string, row: DomainDay | MailboxDay, keep: number): void {
  const dayOf = (r: DomainDay | MailboxDay) => (isDomainDay(r) ? r.d : r[0]);
  const idx = rec.days.findIndex((r) => dayOf(r) === day);
  if (idx >= 0) rec.days[idx] = row;
  else { rec.days.push(row); rec.lifetime.daysObserved++; }
  if (rec.days.length > keep) rec.days = rec.days.slice(rec.days.length - keep);
}

/** An identity nothing has observed for 45 days is retired, not deleted: its
 *  history is the whole point of the ledger. */
function pruneStaleIdentities(now: number): void {
  for (const rec of Object.values(state.identities)) {
    if (rec.retiredAt) continue;
    if (now - Date.parse(rec.lastSeen) > 45 * DAY_MS) {
      rec.retiredAt = nowIso();
      for (const code of Object.keys(rec.open)) closeEvent(rec, code, rec.retiredAt);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Read API                                                           */
/* ------------------------------------------------------------------ */

export interface LedgerRow {
  identity: string;
  kind: IdentityKind;
  id: string;
  domain: string;
  provider?: string;
  ownerName?: string;
  infra?: string;
  health: number | null;
  rep: number | null;
  ageDays: number | null;
  boxes: number;
  sending: number;
  cSent: number;
  bounces: number;
  bounceRatePct: number | null;
  dns: string[];
  blocklists: number;
  /** The single most important reason it is not sending, or null when it is. */
  headline: { code: string; title: string; severity: Severity; detail: string; since?: string } | null;
  blockingCount: number;
  warningCount: number;
  shelf: ShelfLife | null;
  /** Reputation series for the sparkline, oldest first. */
  spark: Array<number | null>;
  lastSeen: string;
  retiredAt?: string;
}

export interface LedgerFleet {
  updatedAt: string | null;
  lastTickAt: string | null;
  /** Never recomputed here: read straight from the published cold-lane ledger. */
  capacity: Awaited<ReturnType<typeof coldCapacity>>;
  totals: {
    domains: number; mailboxes: number;
    sendingNow: number; blocked: number;
    avgHealth: number | null; avgWear: number | null;
    fatigued: number; burned: number; retired: number;
    openEvents: number; criticalOpen: number;
    lifetimeSent: number; lifetimeBounces: number;
  };
  /** Open conditions across the fleet, biggest first: the daily worklist. */
  byCause: Array<{ code: string; title: string; severity: Severity; category: string; blocking: boolean; domains: number; mailboxes: number; oldestSince: string | null; meaning: string; fix: string }>;
  domains: LedgerRow[];
  /** Newest journal entries across the fleet. */
  recent: LedgerEvent[];
}

function rowOf(rec: IdentityRecord): LedgerRow {
  const last = lastRow(rec);
  const blockers = rec.lastBlockers || [];
  const headline = sortBlockers([...blockers]).find((b) => b.blocking) || blockers.find((b) => b.severity === "critical") || null;
  const spark: Array<number | null> = rec.days.slice(-30).map((r) => (isDomainDay(r) ? r.rep : r[1]));
  const cSent = rec.lifetime.cSent;
  return {
    identity: identityRef(rec.kind, rec.id),
    kind: rec.kind, id: rec.id, domain: rec.domain,
    provider: rec.provider, ownerName: rec.ownerName, infra: rec.infra,
    health: rec.lastHealth ?? null,
    rep: last ? (isDomainDay(last) ? last.rep : last[1]) : null,
    ageDays: rec.lastShelf?.ageDays ?? null,
    boxes: last && isDomainDay(last) ? last.boxes : 1,
    sending: last && isDomainDay(last) ? last.sending : 0,
    cSent,
    bounces: rec.lifetime.bounces,
    bounceRatePct: cSent > 0 ? round1((rec.lifetime.bounces / cSent) * 100) : null,
    dns: last && isDomainDay(last) ? dnsNames(last.dns) : [],
    blocklists: last && isDomainDay(last) ? last.bl : 0,
    headline: headline ? { code: headline.code, title: headline.title, severity: headline.severity, detail: headline.detail, since: headline.since } : null,
    blockingCount: blockers.filter((b) => b.blocking).length,
    warningCount: blockers.filter((b) => !b.blocking && (b.severity === "warn" || b.severity === "critical")).length,
    shelf: rec.lastShelf || null,
    spark,
    lastSeen: rec.lastSeen,
    retiredAt: rec.retiredAt,
  };
}

function lastRow(rec: IdentityRecord): DomainDay | MailboxDay | null {
  return rec.days.length ? rec.days[rec.days.length - 1] : null;
}

export async function ledgerFleet(workspaceId: string): Promise<LedgerFleet> {
  await hydrate();
  const mine = Object.values(state.identities).filter((r) => r.workspaceId === workspaceId);
  const domains = mine.filter((r) => r.kind === "domain");
  const mailboxes = mine.filter((r) => r.kind === "mailbox");
  const openEvents = events.events.filter((e) => e.workspaceId === workspaceId && !e.closedAt);

  const causeMap = new Map<string, { domains: number; mailboxes: number; oldest: string | null }>();
  for (const e of openEvents) {
    const c = causeMap.get(e.code) || { domains: 0, mailboxes: 0, oldest: null };
    if (e.kind === "domain") c.domains++; else c.mailboxes++;
    if (!c.oldest || Date.parse(e.openedAt) < Date.parse(c.oldest)) c.oldest = e.openedAt;
    causeMap.set(e.code, c);
  }
  const byCause = [...causeMap.entries()].map(([code, c]) => {
    const def = CAUSE_BY_CODE[code];
    return {
      code,
      title: def?.title || code,
      severity: (def?.severity || "info") as Severity,
      category: def?.category || "lifecycle",
      blocking: !!def?.blocking,
      domains: c.domains, mailboxes: c.mailboxes, oldestSince: c.oldest,
      meaning: def?.meaning || "",
      fix: def?.fix || "",
    };
  }).sort((a, b) =>
    (b.blocking ? 1 : 0) - (a.blocking ? 1 : 0) ||
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    (b.domains + b.mailboxes) - (a.domains + a.mailboxes));

  const healthVals = domains.map((d) => d.lastHealth).filter((h): h is number => typeof h === "number");
  const wearVals = domains.map((d) => d.lastShelf?.wearPct).filter((w): w is number => typeof w === "number");

  return {
    updatedAt: state.updatedAt || null,
    lastTickAt: state.lastTickAt || null,
    capacity: await coldCapacity(workspaceId).catch(() => null),
    totals: {
      domains: domains.length,
      mailboxes: mailboxes.length,
      sendingNow: mailboxes.filter((m) => !(m.lastBlockers || []).some((b) => b.blocking)).length,
      blocked: mailboxes.filter((m) => (m.lastBlockers || []).some((b) => b.blocking)).length,
      avgHealth: healthVals.length ? Math.round(healthVals.reduce((s, h) => s + h, 0) / healthVals.length) : null,
      avgWear: wearVals.length ? Math.round(wearVals.reduce((s, w) => s + w, 0) / wearVals.length) : null,
      fatigued: mine.filter((r) => r.lastShelf?.stage === "fatigued").length,
      burned: mine.filter((r) => r.lastShelf?.stage === "burned").length,
      retired: mine.filter((r) => !!r.retiredAt).length,
      openEvents: openEvents.length,
      criticalOpen: openEvents.filter((e) => e.severity === "critical").length,
      lifetimeSent: domains.reduce((s, d) => s + d.lifetime.cSent, 0),
      lifetimeBounces: domains.reduce((s, d) => s + d.lifetime.bounces, 0),
    },
    byCause,
    domains: domains.map(rowOf).sort((a, b) =>
      (b.blockingCount > 0 ? 1 : 0) - (a.blockingCount > 0 ? 1 : 0) ||
      (a.health ?? 100) - (b.health ?? 100) ||
      a.id.localeCompare(b.id)),
    recent: events.events.filter((e) => e.workspaceId === workspaceId).slice(0, 40),
  };
}

export interface LedgerIdentityView {
  found: boolean;
  row?: LedgerRow;
  blockers?: Blocker[];
  shelf?: ShelfLife | null;
  /** Daily series, oldest first, normalised to objects for both kinds. */
  series?: Array<{ d: string; rep: number | null; wSent: number; wSpam: number; cSent: number; bounces: number; health?: number; wear?: number; open?: string[] }>;
  timeline?: LedgerEvent[];
  mailboxes?: LedgerRow[];
  firstSeen?: string;
  lifetime?: Lifetime;
}

export async function ledgerIdentity(workspaceId: string, ref: string): Promise<LedgerIdentityView> {
  await hydrate();
  const [kindRaw, ...rest] = ref.split(":");
  const kind = (kindRaw === "mailbox" ? "mailbox" : "domain") as IdentityKind;
  const id = rest.join(":").toLowerCase();
  const rec = state.identities[idKey(workspaceId, kind, id)];
  if (!rec) return { found: false };

  const series = rec.days.map((r) => isDomainDay(r)
    ? { d: r.d, rep: r.rep, wSent: r.wSent, wSpam: r.wSpam, cSent: r.cSent, bounces: r.bounces, health: r.health, wear: r.wear, open: r.open }
    : { d: r[0], rep: r[1], wSent: r[2], wSpam: r[3], cSent: r[4], bounces: r[5] });

  const ident = identityRef(kind, rec.id);
  const timeline = events.events
    .filter((e) => e.workspaceId === workspaceId && e.identity === ident)
    .sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt))
    .slice(0, 200);

  const mailboxes = kind === "domain"
    ? Object.values(state.identities)
        .filter((r) => r.workspaceId === workspaceId && r.kind === "mailbox" && r.domain === rec.id)
        .map(rowOf)
        .sort((a, b) => (b.blockingCount - a.blockingCount) || a.id.localeCompare(b.id))
    : undefined;

  return {
    found: true,
    row: rowOf(rec),
    blockers: rec.lastBlockers || [],
    shelf: rec.lastShelf || null,
    series,
    timeline,
    mailboxes,
    firstSeen: rec.firstSeen,
    lifetime: rec.lifetime,
  };
}

/** Append an operator note to one event. Notes are the human half of the record:
 *  the ledger says WHAT happened, a person says what they did about it. */
export async function annotateEvent(workspaceId: string, eventId: string, by: string, text: string): Promise<{ ok: boolean; event?: LedgerEvent }> {
  await hydrate();
  const ev = eventIndex.get(eventId);
  if (!ev || ev.workspaceId !== workspaceId) return { ok: false };
  ev.notes = ev.notes || [];
  ev.notes.unshift({ at: nowIso(), by, text: String(text).slice(0, 2000) });
  await persistAll();
  return { ok: true, event: ev };
}

/** The catalog, for the UI's reference panel. */
export function causeCatalog() { return CAUSES; }
