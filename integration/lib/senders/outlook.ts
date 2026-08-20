/**
 * RecruitersOS · Senders · the LIVING fleet outlook (milestones that check
 * themselves off, or refuse to).
 *
 * Owner mandate 2026-08-20. The "What to expect" list on the fleet monitor used
 * to tick a step off when its DATE passed. That is a calendar, not a monitor: on
 * 2026-08-20 the warm-up rungs read "done" while the host keeper was actually
 * holding at 8/day because Gmail was still rejecting. A date is a forecast; only
 * evidence is a fact.
 *
 * So every step here is a MILESTONE with a verifier, and a milestone is checked
 * off only when the ledger that gates it says it happened:
 *
 *   cutover        the Mailcow host reports outbound leaving as the new IP with
 *                  the SNAT pin in position 1 and no receiver naming the old one
 *   domain revival the rest ledger cleared the domain AND its boxes are back in
 *                  today's capacity math
 *   block clears   the provider-block ledger has no fresh rejection for the pair
 *                  (and, for Gmail/Outlook, the standing monitor shows the host
 *                  accepting again)
 *   warm-up rung   the host keeper confirms N boxes actually running at that rung
 *   graduation     the boxes carry activatedAt (stamped by the health guard)
 *   app-lane ramp  sendCapacity()'s own rest-aware number reaches the rung
 *   cold lane      the cold lane actually draws from the fleet
 *
 * A step whose date has passed without its evidence goes LATE and says what it is
 * waiting on. A step proven once and then contradicted goes REGRESSED and pages
 * the owner. Nothing on this list can read "done" because a day went by.
 *
 * Read-only over host-owned snapshots (rest ledger, block ledger, standing
 * monitor, warm-up keeper); the only thing this module owns is its own milestone
 * ledger (snap_senders_outlook_ledger_v1), written by the maintenance tick so the
 * check-off keeps its verified date and every slip is on the record.
 */

import { RAMP_BY_WEEK, coldMaxPerInbox } from "./limits";

export const OUTLOOK_LEDGER_KEY = "senders_outlook_ledger_v1";

/** Hours a milestone may sit past its forecast before it is called late. */
export function outlookGraceH(): number {
  const n = Number(process.env.SENDER_OUTLOOK_GRACE_H);
  return Number.isFinite(n) && n > 0 ? n : 36;
}
/** How stale the host keeper's report may be and still count as evidence. */
const KEEPER_MAX_AGE_MS = 6 * 3_600_000;
const STANDING_MAX_AGE_MS = 2 * 3_600_000;
const DAY = 86_400_000;

export type OutlookState = "done" | "waiting" | "due" | "late" | "blocked" | "unverified";

export interface OutlookStep {
  /** Stable across ticks: the ledger keys check-off history off this. */
  id: string;
  /** ISO date the step is expected; null = waits on a condition with no clock. */
  when: string | null;
  what: string;
  /** Kept for older clients: true only when the evidence proved it. */
  done: boolean;
  state: OutlookState;
  /** The evidence that checked it off, in the receivers'/ledgers' own terms. */
  proof: string | null;
  /** What it is waiting on when it is not done. */
  blocker: string | null;
  /** When this run's evidence proved it (null when not proven now). */
  verifiedAt: string | null;
  /** First time this milestone was ever proven (survives a later regression). */
  firstVerifiedAt: string | null;
  /** Proven once, contradicted since. */
  regressed: boolean;
  /** The forecast this step has moved off (set when the gating ledger pushed it out). */
  slippedFrom: string | null;
  slips: number;
  /** One-way steps keep their check-off; reversible ones un-check on contradiction. */
  sticky: boolean;
  /** Worth an owner email when it completes, regresses, or runs late. */
  notify: boolean;
  checkedAt: string;
}

/** What the milestone ledger remembers between ticks. */
export interface OutlookRecord {
  id: string;
  what?: string;
  fleet?: string;
  workspaceId?: string;
  forecast?: string | null;
  firstForecast?: string | null;
  firstDoneAt?: string;
  lastDoneAt?: string;
  doneNow?: boolean;
  regressedAt?: string;
  lateSince?: string;
  slips?: number;
  lastSlipAt?: string;
  state?: OutlookState;
  proof?: string | null;
  blocker?: string | null;
  checkedAt?: string;
}

export interface OutlookLedger {
  at?: string;
  records?: Record<string, OutlookRecord>;
  /** Rollup the host health collector reads without reparsing every record. */
  summary?: { milestones: number; done: number; late: number; regressed: number };
}

/** Receiver names, keyed the way the provider-block ledger keys them. */
export const RECEIVER_LABEL: Record<string, string> = {
  google: "Gmail / Google Workspace",
  microsoft: "Outlook / Microsoft 365",
  mailspamprotection: "mailspamprotection.com",
  proofpoint: "Proofpoint",
  mimecast: "Mimecast",
  barracuda: "Barracuda",
};

/* ------------------------------------------------------------------ evidence */

export interface RestEntry {
  state?: string; reason?: string; until?: string; since?: string;
  history?: Array<{ at?: string; event?: string; reason?: string; days?: number }>;
}
export interface RestSnap { domains?: Record<string, RestEntry> }
export interface BlockEntry { fleet?: string; provider?: string; count?: number; lastSeen?: string; blocklist?: string | null; blockedIp?: string | null }
export interface BlocksSnap { blocks?: Record<string, BlockEntry> }
export interface EgressSnap { cutoverAt?: string; egressIp?: string; warmupRamp?: { afterDays: number; perDay: number }[] }
export interface Recv { accepted: number; rejected: number; deferred: number; rateLimited?: number }
export interface StandingSnap {
  at?: string; newIp?: string; rulePos1?: boolean; egressSeen?: string; oldIpMentions?: number;
  receivers?: { google?: Recv; microsoft?: Recv; other?: Recv };
  dnsbl?: Record<string, string>;
}
/** Written by lume-warmup-keeper.sh on ros (host-owned; the app only reads it).
 *  Every field is optional on purpose: this is a cross-language contract, and the
 *  reader treats anything missing as "not proven" rather than trusting a default. */
export interface KeeperSnap {
  at?: string; lastRun?: string; rung?: number; target?: number; due?: number; rungs?: number;
  down?: string[]; hold?: string[];
  boxes?: number; atTarget?: number; active?: number; reenabled?: number; failed?: string[];
  /** Set when the keeper ran but could not reach the warm-up vendor to count boxes. */
  error?: string;
}

/** Per-domain box facts, straight out of the same per-box math capacity uses. */
export interface DomainBoxes { boxes: number; cap: number }

export interface OutlookInput {
  now: number;
  workspaceId: string;
  fleet: string;                       // "internal" | "sendingac" | "google" | "other"
  fleetName: string;
  domains: Set<string>;                // sending domains owned by this fleet
  domainBoxes: Map<string, DomainBoxes>;
  boxes: { total: number; active: number; warming: number; paused: number; error: number; benched: number };
  capacity: { today: number; benched: number; atFullRamp: number };
  coldToday: number;
  /** Whether coldToday came from the sender's published capacity ledger. When the
   *  sender has not published (ledger absent or stale), coldToday reads 0, and 0 is
   *  indistinguishable from a parked lane: the cold-lane milestone must report that
   *  it cannot tell rather than assert either. */
  coldPublished: boolean;
  sentToday: number;
  activatedBoxes: number;              // boxes carrying activatedAt (health-guard graduation stamp)
  graduationAt: number | null;         // median age clock, before the quiet-window gate
  rest: RestSnap | null;
  blocking: string[];                  // providers currently blocking this fleet (recipientGuard)
  blocks: BlocksSnap | null;
  egress: EgressSnap | null;
  standing: StandingSnap | null;
  keeper: KeeperSnap | null;
  records: Record<string, OutlookRecord>;
}

/* ------------------------------------------------------------------- helpers */

interface Verdict { ok: boolean; proof?: string; blocker?: string; unverified?: boolean }

function iso(t: number): string { return new Date(t).toISOString(); }
function day(s?: string | null): string { return String(s || "").slice(0, 10); }
function num(n: number): string { return Number(n || 0).toLocaleString(); }
function ago(from: string | undefined, now: number): string {
  const t = Date.parse(from || "");
  if (!Number.isFinite(t)) return "never";
  const m = Math.round((now - t) / 60_000);
  if (m < 60) return `${m}m ago`;
  if (m < 2880) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}
function pct(r?: Recv): { line: string; attempts: number; share: number | null } {
  const att = (r?.accepted || 0) + (r?.rejected || 0);
  const share = att ? (r?.accepted || 0) / att : null;
  return { line: att ? `${Math.round((share || 0) * 100)}% of ${num(att)}` : "no attempts", attempts: att, share };
}

/** Compose one step from its verifier plus what the ledger remembers about it. */
function step(
  input: OutlookInput,
  id: string,
  what: string,
  when: string | null,
  v: Verdict,
  opts: { sticky?: boolean; notify?: boolean } = {},
): OutlookStep {
  const now = input.now;
  const rec = input.records[ledgerKey(input.workspaceId, input.fleet, id)];
  const sticky = !!opts.sticky;
  const provenBefore = !!rec?.firstDoneAt;
  // Sticky milestones keep their check-off once the evidence has ever proven them
  // (an IP move, a graduation: those happened). Everything else re-earns it every
  // tick, so a domain that goes back to rest un-checks itself in front of the operator.
  const done = v.ok || (sticky && provenBefore);
  // Missing evidence is not counter-evidence: a monitor that went quiet leaves a
  // proven milestone standing (with the re-check noted) instead of accusing the
  // machinery of moving backwards.
  const regressed = provenBefore && !v.ok && !v.unverified;
  const whenT = when ? Date.parse(when) : NaN;
  let state: OutlookState;
  if (done && !regressed) state = "done";
  else if (regressed) state = "late";
  else if (v.unverified) state = "unverified";
  else if (!when) state = v.blocker ? "blocked" : "waiting";
  else if (!Number.isFinite(whenT) || whenT > now) state = "waiting";
  else if (now - whenT <= outlookGraceH() * 3_600_000) state = "due";
  else state = "late";
  const firstForecast = rec?.firstForecast ?? rec?.forecast ?? when;
  const slipped = when && firstForecast && when > firstForecast ? firstForecast : null;
  return {
    id, when, what, done,
    state,
    // A step still standing on an older proof says so, and carries the reason its
    // re-check could not run, so nobody reads a stale tick as a fresh one.
    proof: v.ok ? v.proof || null : (done && !regressed ? rec?.proof || null : null),
    blocker: v.ok ? null : v.blocker || null,
    verifiedAt: v.ok ? iso(now) : null,
    firstVerifiedAt: rec?.firstDoneAt || (v.ok ? iso(now) : null),
    regressed,
    slippedFrom: slipped,
    slips: rec?.slips || 0,
    sticky,
    notify: !!opts.notify,
    checkedAt: iso(now),
  };
}

export function ledgerKey(workspaceId: string, fleet: string, id: string): string {
  return `${workspaceId}::${fleet}::${id}`;
}

/* ---------------------------------------------------------------- verifiers */

/** Domains resting under the rest ledger, and the ones it has recently cleared.
 *  A revival is only real when the domain's boxes are back in today's capacity. */
function domainSteps(input: OutlookInput): OutlookStep[] {
  const out: OutlookStep[] = [];
  const revived: OutlookStep[] = [];
  const entries = input.rest?.domains || {};
  for (const d of [...input.domains].sort()) {
    const e = entries[d] || entries[d.toLowerCase()];
    if (!e) continue;
    const restingNow = e.state === "resting" && (!e.until || Date.parse(e.until) > input.now);
    const cleared = (e.history || []).filter((h) => h?.event === "cleared" || h?.event === "revived").slice(-1)[0];
    const clearedAt = cleared?.at ? Date.parse(cleared.at) : NaN;
    const recentlyCleared = e.state !== "resting" && Number.isFinite(clearedAt) && input.now - clearedAt <= 21 * DAY;
    if (!restingNow && !recentlyCleared) continue;   // ancient history is not news
    const boxes = input.domainBoxes.get(d);
    const back = !restingNow && (boxes?.cap || 0) > 0;
    const v: Verdict = back
      ? {
          ok: true,
          proof: `rest served; ${num(boxes?.boxes || 0)} box${(boxes?.boxes || 0) === 1 ? "" : "es"} on ${d} are back in today's capacity (${num(boxes?.cap || 0)}/day)`,
        }
      : restingNow
        ? { ok: false, blocker: `the rest ledger still holds ${d}${e.reason ? ` (${e.reason})` : ""}${e.until ? `, until ${day(e.until)}` : ""}` }
        : { ok: false, blocker: `${d} is out of rest but none of its boxes are drawing capacity yet (paused, in error, or below the minimum age)` };
    const built = step(input, `domain:${d}`, `${d} back in rotation once its rest is served`, restingNow ? (e.until || null) : (cleared?.at || null), v);
    (restingNow ? out : revived).push(built);
  }
  // The list is bounded on both sides, and every trim is stated. An unbounded plan
  // is unreadable (a fleet can hold 70+ domains) and a silently shortened one reads
  // as a complete one, which is worse than either.
  const KEEP_RESTING = 12, KEEP_REVIVED = 6;
  out.sort((a, b) => String(a.when || "9999").localeCompare(String(b.when || "9999")));
  const restingShown = out.slice(0, KEEP_RESTING);
  const restingRest = out.slice(KEEP_RESTING);
  if (restingRest.length) {
    restingShown.push(step(
      input, "domains:resting-more",
      `${restingRest.length} more domain${restingRest.length === 1 ? "" : "s"} are resting behind these`,
      restingRest[0].when,
      { ok: false, blocker: `still on the rest ledger: ${restingRest.slice(0, 8).map((r) => r.id.replace("domain:", "")).join(", ")}${restingRest.length > 8 ? ` and ${restingRest.length - 8} more` : ""}` },
    ));
  }
  revived.sort((a, b) => String(b.when || "").localeCompare(String(a.when || "")));
  restingShown.push(...revived.slice(0, KEEP_REVIVED));
  const trimmed = revived.length - KEEP_REVIVED;
  if (trimmed > 0) {
    restingShown.push(step(
      input, "domains:older",
      `${trimmed} more domain${trimmed === 1 ? "" : "s"} came back in the last three weeks`,
      revived[KEEP_REVIVED].when,
      { ok: true, proof: revived.slice(KEEP_REVIVED).map((r) => r.id.replace("domain:", "")).join(", ") },
    ));
  }
  return restingShown;
}

/** The egress cutover: proven by the host's own view of what leaves the box. */
function cutoverStep(input: OutlookInput): OutlookStep | null {
  const cutT = input.egress?.cutoverAt ? Date.parse(input.egress.cutoverAt) : NaN;
  if (!Number.isFinite(cutT)) return null;
  const st = input.standing;
  const fresh = st?.at ? input.now - Date.parse(st.at) <= STANDING_MAX_AGE_MS : false;
  const ip = input.egress?.egressIp || st?.newIp || "the clean IP";
  const pinHeld = !!st && st.rulePos1 !== false && (!st.egressSeen || !st.newIp || st.egressSeen === st.newIp);
  const oldNamed = (st?.oldIpMentions || 0) > 0;
  const v: Verdict = !fresh
    ? { ok: false, unverified: true, blocker: `the standing monitor has not reported since ${ago(st?.at, input.now)}, so the egress pin cannot be confirmed from here` }
    : !pinHeld
      ? { ok: false, blocker: `the pin is not holding on the host (rule in position 1: ${st?.rulePos1 === false ? "no" : "yes"}, egress seen ${st?.egressSeen || "unknown"})` }
      : oldNamed
        ? { ok: false, blocker: `receivers named the old IP ${st?.oldIpMentions}x inside the window, so mail is still leaving the old address` }
        : { ok: true, proof: `the host reports outbound leaving as ${ip} with the pin rule in position 1, and no receiver has named the old IP in the window (checked ${ago(st?.at, input.now)})` };
  return step(input, "cutover", `Outbound moved to the clean IP ${ip}; receivers now judge this server on fresh history`, iso(cutT), v, { sticky: true, notify: true });
}

/** When each blocked receiver comes back, proven by the block ledger going quiet
 *  (and, where the standing monitor watches that receiver, by acceptance). */
function blockSteps(input: OutlookInput): { steps: OutlookStep[]; quietAt: number | null } {
  const out: OutlookStep[] = [];
  const blockMin = Number(process.env.SENDER_BLOCK_MIN) > 0 ? Number(process.env.SENDER_BLOCK_MIN) : 20;
  const live = new Map<string, BlockEntry>();
  for (const b of Object.values(input.blocks?.blocks || {})) {
    if (b?.fleet !== input.fleet || !b.provider || !b.lastSeen) continue;
    const cur = live.get(b.provider);
    if (!cur || String(b.lastSeen) > String(cur.lastSeen)) live.set(b.provider, b);
  }
  let quietAt: number | null = null;
  const providers = new Set<string>([...input.blocking, ...live.keys()]);
  for (const p of [...providers].sort()) {
    const b = live.get(p);
    const lastSeen = b?.lastSeen ? Date.parse(b.lastSeen) : NaN;
    const material = (b?.count || 0) >= blockMin;
    const quiet = Number.isFinite(lastSeen) ? lastSeen + 7 * DAY : NaN;
    const blockedNow = input.blocking.includes(p);
    if (blockedNow && Number.isFinite(quiet) && quiet > input.now && (quietAt == null || quiet > quietAt)) quietAt = quiet;
    if (!blockedNow && (!Number.isFinite(lastSeen) || input.now - lastSeen > 21 * DAY)) continue; // long healed, not news
    // A pair that never reached the routing threshold never took this fleet off that
    // receiver, so "came back" would be a milestone for something that never happened.
    if (!blockedNow && !material) continue;
    const name = RECEIVER_LABEL[p] || p;
    const recv = p === "google" ? input.standing?.receivers?.google : p === "microsoft" ? input.standing?.receivers?.microsoft : undefined;
    const acc = pct(recv);
    const standingFresh = input.standing?.at ? input.now - Date.parse(input.standing.at) <= STANDING_MAX_AGE_MS : false;
    const v: Verdict = blockedNow
      ? {
          ok: false,
          blocker: `the bounce sweeps still see ${name} rejecting this server (${num(b?.count || 0)} notice${(b?.count || 0) === 1 ? "" : "s"}, last ${ago(b?.lastSeen, input.now)}); the pair needs 7 days without one`
            + (standingFresh && acc.attempts ? `. Last 24h: ${acc.line} accepted` : ""),
        }
      : {
          ok: true,
          proof: `no rejection from ${name} on the block ledger since ${day(b?.lastSeen) || "before the window"}; recipients on that host send from this fleet again`
            + (standingFresh && acc.attempts ? `, and the host accepted ${acc.line} in the last 24h` : ""),
        };
    out.push(step(
      input, `block:${p}`,
      `${name} recipients return to this fleet after 7 days without a rejection`,
      // A healed pair is dated by the quiet mark it actually reached; if it cleared
      // early (the notices aged out under the threshold) the last rejection is the
      // honest anchor, and either way the date stops moving once it is in the past.
      blockedNow
        ? (Number.isFinite(quiet) ? iso(quiet) : null)
        : (Number.isFinite(quiet) ? iso(Math.min(quiet, input.now) === quiet ? quiet : lastSeen) : null),
      v, { notify: material },
    ));
  }
  return { steps: out, quietAt };
}

/** Warm-up rungs: only the host keeper knows what the boxes are actually set to. */
function warmupSteps(input: OutlookInput, cutT: number, quietAt: number | null): OutlookStep[] {
  const out: OutlookStep[] = [];
  const ramp = (input.egress?.warmupRamp || []).filter((r) => r && r.afterDays > 0).sort((a, b) => a.afterDays - b.afterDays);
  if (!ramp.length) return out;
  const k = input.keeper;
  const runAt = k?.lastRun || k?.at;
  const keeperFresh = runAt ? input.now - Date.parse(runAt) <= KEEPER_MAX_AGE_MS : false;
  const held = [...(k?.down || []), ...(k?.hold || [])];
  // The keeper's report is a cross-language contract (a bash/python script on the host
  // writing JSON the app reads). Every field it decides a check-off on is validated
  // here: an unreadable or partial report leaves the rung UNVERIFIED, which is the only
  // honest reading, and never trips the "went backwards" alarm.
  const target = typeof k?.target === "number" && Number.isFinite(k.target) ? k.target : null;
  const boxes = typeof k?.boxes === "number" && k.boxes > 0 ? k.boxes : null;
  const atTarget = typeof k?.atTarget === "number" && k.atTarget >= 0 ? k.atTarget : null;
  // A rung is only reached when the boxes are actually ON it. The keeper applies the
  // rung box by box and can be interrupted (Smartlead 429s, a census that failed), so
  // a partial roll-out must not read as a completed step.
  const applied = boxes != null && atTarget != null && atTarget >= Math.ceil(boxes * 0.9);
  for (const r of ramp) {
    const when = Math.max(cutT + r.afterDays * DAY, quietAt ? quietAt - 4 * DAY : 0);
    let v: Verdict;
    if (!k) {
      v = { ok: false, unverified: true, blocker: "the host warm-up keeper does not report into the app, so this rung cannot be checked off from here" };
    } else if (!keeperFresh) {
      v = { ok: false, unverified: true, blocker: `the warm-up keeper last reported ${ago(runAt, input.now)}; a rung is never assumed while its report is stale` };
    } else if (target == null) {
      v = { ok: false, unverified: true, blocker: `the warm-up keeper's last report is unreadable${k.error ? ` (${k.error})` : ""}; a rung is never assumed from a partial report` };
    } else if (target >= r.perDay && !applied) {
      v = {
        ok: false, unverified: true,
        blocker: boxes == null || atTarget == null
          ? `the keeper reports rung ${num(target)}/day but could not count the boxes${k.error ? ` (${k.error})` : ""}, so the rung is not confirmed`
          : `the keeper is rolling this rung out: ${num(atTarget)} of ${num(boxes)} boxes are at ${num(target)}/day`,
      };
    } else if (target >= r.perDay) {
      v = { ok: true, proof: `${num(atTarget || 0)} of ${num(boxes || 0)} boxes confirmed at ${num(target)}/day by the host keeper (${ago(runAt, input.now)})` };
    } else {
      v = {
        ok: false,
        blocker: `the keeper is holding at ${num(target)}/day per box`
          + (held.length ? `: ${held.slice(0, 2).join("; ")}` : " until the standing evidence is clean for 24h"),
      };
    }
    out.push(step(
      input, `warmup:${r.perDay}`,
      `Warm-up steps up to ${r.perDay}/day per box (automatic; climbs only on clean standing, steps back to 8 on trouble)`,
      iso(when), v,
    ));
  }
  return out;
}

/** Graduation + the app-lane ramp + the cold lane, each read back off the same
 *  numbers the sender actually enforces. */
function rampSteps(input: OutlookInput, gradAt: number): OutlookStep[] {
  const out: OutlookStep[] = [];
  const fleetBoxes = input.boxes.active + input.boxes.warming;
  const warming = input.boxes.warming;
  const gradV: Verdict = warming === 0 && input.boxes.active > 0
    ? { ok: true, proof: `every box on this fleet is active; ${num(input.activatedBoxes)} carry the health guard's activation stamp` }
    : {
        ok: false,
        blocker: `${num(input.boxes.active)} of ${num(fleetBoxes)} boxes are active; the other ${num(warming)} need the 30-day clock plus 7 days without a rejection`,
      };
  out.push(step(
    input, "graduation",
    `${num(warming || input.boxes.active)} warming boxes activate (30-day clock plus 7 quiet days); app lane starts at ${num(fleetBoxes * RAMP_BY_WEEK[0])}/day`,
    iso(gradAt), gradV, { sticky: true, notify: true },
  ));
  for (let w = 1; w <= RAMP_BY_WEEK.length; w++) {
    const per = w < RAMP_BY_WEEK.length ? RAMP_BY_WEEK[w] : coldMaxPerInbox();
    const target = fleetBoxes * per;
    const v: Verdict = input.capacity.today >= target && target > 0
      ? { ok: true, proof: `the app lane's own capacity math reads ${num(input.capacity.today)}/day today, at or above this rung` }
      : {
          ok: false,
          blocker: `capacity is ${num(input.capacity.today)}/day against this rung's ${num(target)}/day`
            + (input.capacity.benched ? `; ${num(input.capacity.benched)}/day is benched on resting domains` : ""),
        };
    out.push(step(
      input, `applane:w${w}`,
      `App lane ramps to ${num(target)}/day (${per} per box)${w === RAMP_BY_WEEK.length ? ", full capacity" : ""}`,
      iso(gradAt + w * 7 * DAY), v,
    ));
  }
  const coldV: Verdict = input.coldToday > 0
    ? { ok: true, proof: `the cold lane is open at ${num(input.coldToday)}/day and the fleet has sent ${num(input.sentToday)} today` }
    : !input.coldPublished
      ? { ok: false, unverified: true, blocker: "the sender has not published a capacity ledger recently, so whether this lane is open cannot be read from here" }
      : { ok: false, blocker: "the cold outreach lane stays parked until a person opens it (MPC_SMTP_LANE); nothing here opens it on a date" };
  out.push(step(
    input, "coldlane",
    "Cold outreach lane stays parked until opened by hand; earliest sensible date, after a clean week of app-lane sends",
    iso(gradAt + 14 * DAY), coldV, { notify: true },
  ));
  return out;
}

/* ------------------------------------------------------------------- builder */

export interface OutlookResult { steps: OutlookStep[]; graduationAt: string | null }

/** The fleet's dated path, every step carrying the evidence that closes it. */
export function buildOutlook(input: OutlookInput): OutlookResult {
  const steps: OutlookStep[] = [...domainSteps(input)];
  let graduationAt: string | null = null;

  if (input.fleet === "internal") {
    const cut = cutoverStep(input);
    if (cut) steps.push(cut);
    const { steps: blocked, quietAt } = blockSteps(input);
    steps.push(...blocked);
    const cutT = input.egress?.cutoverAt ? Date.parse(input.egress.cutoverAt) : NaN;
    if (Number.isFinite(cutT)) steps.push(...warmupSteps(input, cutT, quietAt));
    // The graduation clock is the median age of the WARMING boxes, so it disappears
    // the moment they all activate. The ledger remembers the date this plan was drawn
    // to, which is what keeps the finished tail of the plan on the board instead of
    // deleting it at the exact moment it is achieved.
    const remembered = input.records[ledgerKey(input.workspaceId, input.fleet, "graduation")];
    const rememberedAt = Date.parse(remembered?.firstForecast || remembered?.forecast || "");
    const gradClock = input.graduationAt || (Number.isFinite(rememberedAt) ? rememberedAt : null);
    if (gradClock) {
      const g = input.graduationAt ? Math.max(gradClock, quietAt || 0) : gradClock;
      graduationAt = iso(g);
      steps.push(...rampSteps(input, g));
    }
  }

  steps.sort((a, b) => (a.when || "9999").localeCompare(b.when || "9999"));
  return { steps, graduationAt };
}

/* -------------------------------------------------------------------- ledger */

export interface OutlookEvent {
  kind: "completed" | "regressed" | "late" | "slipped";
  workspaceId: string; fleet: string; fleetName: string;
  id: string; what: string; detail: string;
  /** Whether this event may reach a person. Board events (a domain going back to
   *  rest, a rest window extended) stay on the card; only milestones marked notify
   *  can page, because a fleet with 18 domains generates board churn every sweep and
   *  a monitor that emails on all of it gets muted, which is how a real incident is
   *  missed (the 2026-08-19 warm-up notify flood). */
  notify: boolean;
}

/** Slips smaller than this are ledger jitter (a sweep re-stamping a window), not a
 *  change of plan, and never page. */
const SLIP_NOTIFY_MS = 2 * DAY;

/** Fold this run's readings into the ledger. Returns every event for the board and
 *  the report; `notify` marks the subset a person may be told about. */
export function foldOutlook(
  ledger: OutlookLedger,
  input: { workspaceId: string; fleet: string; fleetName: string; now: number },
  steps: OutlookStep[],
): { ledger: OutlookLedger; events: OutlookEvent[] } {
  const records = { ...(ledger.records || {}) };
  const events: OutlookEvent[] = [];
  const nowIso = iso(input.now);
  for (const s of steps) {
    const key = ledgerKey(input.workspaceId, input.fleet, s.id);
    const prev: OutlookRecord = records[key] || { id: s.id };
    const rec: OutlookRecord = {
      ...prev,
      id: s.id, what: s.what, fleet: input.fleet, workspaceId: input.workspaceId,
      forecast: s.when, firstForecast: prev.firstForecast ?? s.when,
      state: s.state, proof: s.proof ?? prev.proof ?? null, blocker: s.blocker, checkedAt: nowIso,
      doneNow: s.done && !s.regressed,
    };
    const base = { workspaceId: input.workspaceId, fleet: input.fleet, fleetName: input.fleetName, id: s.id, what: s.what };
    if (s.verifiedAt) {
      if (!prev.firstDoneAt) {
        rec.firstDoneAt = s.verifiedAt;
        events.push({ ...base, kind: "completed", detail: s.proof || "verified", notify: s.notify });
      }
      rec.lastDoneAt = s.verifiedAt;
      rec.lateSince = undefined;
      if (prev.regressedAt) rec.regressedAt = undefined;
    }
    if (s.regressed && !prev.regressedAt) {
      rec.regressedAt = nowIso;
      events.push({ ...base, kind: "regressed", detail: s.blocker || "the evidence that proved this step no longer holds", notify: s.notify });
    }
    if (s.state === "late") {
      if (!prev.lateSince) {
        rec.lateSince = nowIso;
        events.push({ ...base, kind: "late", detail: s.blocker || "past its forecast with no evidence it happened", notify: s.notify });
      }
    } else if (s.state !== "due") {
      rec.lateSince = undefined;
    }
    // A forecast that moves LATER is a slip: the gating ledger pushed the date out,
    // and the board says so instead of quietly redrawing the calendar.
    if (s.when && prev.forecast && s.when > prev.forecast && Date.parse(s.when) - Date.parse(prev.forecast) > 12 * 3_600_000) {
      const moved = Date.parse(s.when) - Date.parse(prev.forecast);
      rec.slips = (prev.slips || 0) + 1;
      rec.lastSlipAt = nowIso;
      events.push({
        ...base, kind: "slipped", detail: `moved from ${day(prev.forecast)} to ${day(s.when)}`,
        notify: s.notify && moved >= SLIP_NOTIFY_MS,
      });
    }
    records[key] = rec;
  }
  return { ledger: { at: nowIso, records }, events };
}

/** Drop records for milestones no fleet reports any more (a domain removed from the
 *  pool, a receiver block long healed). Without this the ledger only ever grows, and
 *  a snapshot that grows without bound eventually becomes the outage. Records are
 *  kept well past the 21-day news window so a revisited milestone still finds its
 *  history. */
export function pruneOutlook(ledger: OutlookLedger, seen: Set<string>, now: number, keepDays = 90): { ledger: OutlookLedger; pruned: number } {
  const records = ledger.records || {};
  const kept: Record<string, OutlookRecord> = {};
  let pruned = 0;
  for (const [k, v] of Object.entries(records)) {
    const last = Date.parse(v.checkedAt || v.lastDoneAt || v.firstDoneAt || "");
    if (seen.has(k) || !Number.isFinite(last) || now - last <= keepDays * DAY) kept[k] = v;
    else pruned++;
  }
  return { ledger: { ...ledger, records: kept }, pruned };
}
