/**
 * RecruitersOS · Senders · Fleet overview (the one place all sending infrastructure reports)
 *
 * Owner mandate 2026-08-19: Sending.ac, the Zapmail/Google boxes, and the internal
 * Mailcow server each tell their story in one monitor on the Senders tab - box counts,
 * benched capacity, bounce pressure, graduation clocks - so nobody has to assemble the
 * picture from four panels. Read-only composition over stores and snapshots the system
 * already maintains; per CLAUDE.md rule 6, capacity numbers reuse the same rest-aware
 * per-box math as sendCapacity() (coldCapFor + the rest ledger), never re-derived.
 */

import { loadSnapshot } from "../db";
import { listInboxes } from "./store";
import { coldCapFor, coldMaxPerInbox, SENDING_AC_PER_INBOX } from "./limits";
import { activeBlocks } from "./recipientGuard";
import { coldCapacity } from "./coldLane";
import { buildOutlook, OUTLOOK_LEDGER_KEY, RECEIVER_LABEL } from "./outlook";
import type {
  BlocksSnap, DomainBoxes, EgressSnap, KeeperSnap, OutlookLedger, OutlookStep, Recv, RestSnap, StandingSnap,
} from "./outlook";
import type { SenderInbox } from "./types";

export type FleetKey = "sendingac" | "google" | "internal" | "other";

export interface FleetCard {
  key: FleetKey;
  name: string;
  boxes: { total: number; active: number; warming: number; paused: number; error: number; benched: number };
  domains: { total: number; resting: number; nextRevival: string | null };
  capacity: { today: number; benched: number; atFullRamp: number };
  /** What the COLD-OUTREACH lane can draw from this fleet today. Differs from
   *  capacity.today (the app-lane ramp): Sending.ac is the same; the Google lane
   *  runs batch.mjs's receiver-friendly ramp (MPC_GOOGLE_RAMP, week-1 floor
   *  mirrored here); the internal server is 0 while its cold lane stays parked
   *  (MPC_SMTP_LANE) even though app sends (job blasts, replies) may use it. */
  coldToday: number;
  bounces7d: number;               // campaign NDRs on this fleet's domains (combined sweep window)
  warmupBounces7d: number | null;  // internal lane only: NDRs on warm-up traffic = provider-side rejection pressure
  graduation: { warming: number; eligibleAt: string | null } | null;
  notes: string[];
  /** The dated path this fleet is on, every step carrying the evidence that closes
   *  it (lib/senders/outlook). Every date comes from the ledger that gates the
   *  step, and every check-off comes from that ledger saying it happened, never
   *  from the date arriving. null for fleets with nothing pending. */
  outlook: OutlookStep[] | null;
  /** Rollup for the card header: how much of the path is verified done. */
  outlookProgress: { done: number; total: number; late: number; regressed: number; nextAt: string | null; nextWhat: string | null } | null;
}

export type { OutlookStep } from "./outlook";

interface NdrSnap { perDomain?: Record<string, { bounces?: number }>; warmupNdrs?: number; generatedAt?: string }

function fleetOf(m: SenderInbox): FleetKey {
  if (m.provider === "sending-ac") return "sendingac";
  if (m.provider === "google" || /^smtp\.gmail\.com$/i.test(m.smtpHost || "")) return "google";
  if (m.provider === "own-smtp") return "internal";
  return "other";
}

function domainOf(email: string): string {
  const i = email.indexOf("@");
  return i >= 0 ? email.slice(i + 1).toLowerCase().trim() : "";
}

const FLEET_NAMES: Record<FleetKey, string> = {
  sendingac: "Sending.ac",
  google: "Google (Zapmail)",
  internal: "Internal server (mail.lumesp.com)",
  other: "Other",
};

export async function fleetOverview(workspaceId: string): Promise<FleetCard[]> {
  const [inboxes, rest, ndr, ndrImap, blocks, blocksSnap, egress, standing, keeper, outlookLedger] = await Promise.all([
    listInboxes(workspaceId),
    loadSnapshot<RestSnap>("mpc_domain_rest_v1"),
    loadSnapshot<NdrSnap>("mpc_ndr_v1"),
    loadSnapshot<NdrSnap>("mpc_ndr_imap_v1"),
    activeBlocks().catch(() => new Map<string, Set<string>>()),
    loadSnapshot<BlocksSnap>("provider_blocks_v1"),
    loadSnapshot<EgressSnap>("internal_egress_v1"),
    loadSnapshot<StandingSnap>("internal_egress_status_v1"),
    loadSnapshot<KeeperSnap>("internal_warmup_v1"),
    loadSnapshot<OutlookLedger>(OUTLOOK_LEDGER_KEY),
  ]);
  // What the cold lane actually carries today, straight from the sender.
  const cold = await coldCapacity(workspaceId).catch(() => null);

  const now = Date.now();
  const resting = new Map<string, string | null>(); // domain -> until
  for (const [d, v] of Object.entries(rest?.domains || {})) {
    if (v?.state === "resting" && (!v.until || Date.parse(v.until) > now)) resting.set(d.toLowerCase(), v.until || null);
  }

  const graduateDays = (k: FleetKey) =>
    k === "internal"
      ? Number(process.env.SENDER_GRADUATE_DAYS_INTERNAL || 30)
      : Number(process.env.SENDER_GRADUATE_DAYS || 14);

  type Working = FleetCard & {
    _domains: Set<string>; _gradAts: number[];
    _domainBoxes: Map<string, DomainBoxes>; _sentToday: number; _activated: number;
  };
  const cards = new Map<FleetKey, Working>();
  const card = (k: FleetKey) => {
    let c = cards.get(k);
    if (!c) {
      c = {
        key: k, name: FLEET_NAMES[k],
        boxes: { total: 0, active: 0, warming: 0, paused: 0, error: 0, benched: 0 },
        domains: { total: 0, resting: 0, nextRevival: null },
        capacity: { today: 0, benched: 0, atFullRamp: 0 },
        coldToday: 0,
        bounces7d: 0, warmupBounces7d: null, graduation: null, notes: [],
        outlook: null, outlookProgress: null,
        _domains: new Set<string>(), _gradAts: [],
        _domainBoxes: new Map<string, DomainBoxes>(), _sentToday: 0, _activated: 0,
      };
      cards.set(k, c);
    }
    return c;
  };

  for (const m of inboxes) {
    const k = fleetOf(m);
    const c = card(k);
    const dom = domainOf(m.email);
    c.boxes.total++;
    if (dom) c._domains.add(dom);
    if (m.status === "active") c.boxes.active++;
    else if (m.status === "warming") c.boxes.warming++;
    else if (m.status === "paused") c.boxes.paused++;
    else if (m.status === "error") c.boxes.error++;
    if (m.status === "paused" || m.status === "error") continue;

    const cap = coldCapFor(m);
    const mature = m.provider === "sending-ac" ? SENDING_AC_PER_INBOX : coldMaxPerInbox();
    c.capacity.atFullRamp += mature;
    c._sentToday += Number(m.sentToday || 0);
    if (m.activatedAt) c._activated++;
    if (dom && resting.has(dom)) { c.boxes.benched++; c.capacity.benched += cap; }
    else {
      c.capacity.today += cap;
      // Per-domain contribution to TODAY's capacity: a revival is only real when
      // the domain's boxes are drawing again, and this is the number that proves it.
      if (dom) {
        const d = c._domainBoxes.get(dom) || { boxes: 0, cap: 0 };
        d.boxes++; d.cap += cap;
        c._domainBoxes.set(dom, d);
      }
    }

    // Sending.ac boxes never graduate (externally warmed, flat cap; the health
    // guard skips them) - a graduation clock on that fleet would be fiction.
    if (k !== "sendingac" && m.status === "warming" && m.createdAt) {
      const t = Date.parse(m.createdAt);
      if (Number.isFinite(t)) c._gradAts.push(t + graduateDays(k) * 86_400_000);
    }
  }

  // Bounce pressure: combined-sweep perDomain counts attributed to the fleet that owns
  // the domain. The combined snapshot already includes the internal lane's campaign NDRs
  // (merged by ndr-sweep); the IMAP sidecar's warm-up count is the internal lane's
  // provider-rejection signal (e.g. Gmail 550ing the server's IP on warm-up traffic).
  const domainFleet = new Map<string, FleetKey>();
  for (const c of cards.values()) for (const d of c._domains) domainFleet.set(d, c.key);
  for (const [d, v] of Object.entries(ndr?.perDomain || {})) {
    const k = domainFleet.get(d.toLowerCase());
    if (k) card(k).bounces7d += v?.bounces || 0;
  }

  return [...cards.values()]
    .map((c) => {
      const restingMine = [...c._domains].filter((d) => resting.has(d));
      const revivals = restingMine.map((d) => resting.get(d)).filter(Boolean).sort() as string[];
      const grad = c._gradAts.sort()[Math.floor(c._gradAts.length / 2)] || null; // median clock
      // Cold-lane reality per fleet. Google's cold ramp is per-box-per-week from its
      // FIRST COLD SEND (batch.mjs); the app can't see that ledger, so we mirror the
      // conservative week-1 step - it understates in later weeks, never overstates.
      // Cold-lane reality per fleet comes from the SENDER's published ledger, never from a
      // mirror of its ramp: mirroring counted all 100 Google boxes (warming ones included)
      // at a week-1 step and told the portal 1,200/day against a real 832 (2026-08-20).
      // Falls back to 0 rather than to a guess — an unpublished ledger is reported as
      // unknown upstream, and a fabricated ceiling is worse than an absent one.
      const laneKey = c.key === "internal" ? "internal" : c.key;
      const published = cold?.lanes?.find((l) => l.lane === laneKey) || null;
      const coldToday = published ? published.ceiling : 0;
      const out: FleetCard = {
        key: c.key, name: c.name, boxes: c.boxes,
        domains: { total: c._domains.size, resting: restingMine.length, nextRevival: revivals[0] || null },
        capacity: c.capacity,
        coldToday,
        bounces7d: c.bounces7d,
        warmupBounces7d: c.key === "internal" ? (ndrImap?.warmupNdrs ?? null) : null,
        graduation: c.boxes.warming ? { warming: c.boxes.warming, eligibleAt: grad ? new Date(grad).toISOString() : null } : null,
        notes: [],
        outlook: null, outlookProgress: null,
      };
      if (c.key === "internal") {
        // Routing truth comes from the SAME source the sender rotation reads (the
        // provider-block ledger via recipientGuard.activeBlocks), never from prose:
        // on 2026-08-20 a hardcoded "Outlook sends normally" line sat on this card
        // while Microsoft was rejecting 100% of the server's mail.
        // STANDING of the sending IP, last 24h, from the Mailcow host's own log (pulled
        // every 15 min): what receivers actually did, plus blocklists through the box's
        // recursive resolver. This is the evidence the warm-up keeper climbs on.
        const stAge = standing?.at ? (now - Date.parse(standing.at)) / 60_000 : Infinity;
        if (standing && stAge <= 120) {
          const pct = (r?: Recv) => { const n = (r?.accepted || 0) + (r?.rejected || 0); return n ? `${Math.round(((r?.accepted || 0) / n) * 100)}% of ${n}` : "no attempts"; };
          const listed = Object.entries(standing.dnsbl || {}).filter(([, v]) => v !== "clean").map(([z]) => z);
          const pin = standing.rulePos1 === false || (standing.egressSeen && standing.newIp && standing.egressSeen !== standing.newIp) ? "egress pin NOT holding" : "egress pin holding";
          out.notes.push(
            `Standing of ${standing.newIp || "the sending IP"} (last 24h): Gmail accepted ${pct(standing.receivers?.google)}${standing.receivers?.google?.rateLimited ? `, ${standing.receivers.google.rateLimited} rate-limited` : ""}; ` +
            `Outlook ${pct(standing.receivers?.microsoft)}; other hosts ${pct(standing.receivers?.other)}; ` +
            `blocklists ${listed.length ? "LISTED on " + listed.join(", ") : "clean"}; ${pin}` +
            `${(standing.oldIpMentions || 0) > 0 ? `; old IP still named ${standing.oldIpMentions}x` : ""}.`,
          );
        } else {
          out.notes.push("Standing monitor has not reported in the last 2 hours; the warm-up ramp holds its current rung until it does.");
        }
        const rejecting = [...(blocks.get("internal") || [])].sort();
        if (rejecting.length) {
          const names = rejecting.map((p) => RECEIVER_LABEL[p] || p).join(", ");
          out.notes.push(`${names} recipients are routed to other fleets while the bounce sweeps still see those hosts rejecting this server; the block clears by itself after 7 quiet days.`);
        } else {
          out.notes.push("No receiving host is currently rejecting this server; every recipient type sends from this fleet.");
        }
        if ((out.warmupBounces7d || 0) > 50) out.notes.push(`${(out.warmupBounces7d || 0).toLocaleString()} bounce notices on warm-up traffic in the 7-day sweep window - provider-side rejection pressure; the window needs 7 quiet days to clear and graduation waits for it.`);

      }
      // WHAT TO EXPECT, and what has actually HAPPENED. lib/senders/outlook builds the
      // dated path from the ledgers that gate each step, and checks a step off only when
      // that same ledger proves it happened - never because the date arrived.
      {
        const built = buildOutlook({
          now, workspaceId, fleet: c.key, fleetName: c.name,
          domains: c._domains, domainBoxes: c._domainBoxes,
          boxes: c.boxes, capacity: c.capacity, coldToday,
          sentToday: c._sentToday, activatedBoxes: c._activated,
          graduationAt: c.boxes.warming && grad ? grad : null,
          rest, blocking: [...(blocks.get(c.key) || [])].sort(), blocks: blocksSnap,
          egress, standing, keeper,
          records: outlookLedger?.records || {},
        });
        if (built.steps.length) {
          out.outlook = built.steps;
          const late = built.steps.filter((s) => s.state === "late").length;
          const next = built.steps.find((s) => !s.done && s.when) || built.steps.find((s) => !s.done) || null;
          out.outlookProgress = {
            done: built.steps.filter((s) => s.done && !s.regressed).length,
            total: built.steps.length,
            late,
            regressed: built.steps.filter((s) => s.regressed).length,
            nextAt: next?.when || null,
            nextWhat: next?.what || null,
          };
        }
        // The header's "auto-activate" date must be the same gated date the outlook uses,
        // not the bare age clock.
        if (out.graduation && built.graduationAt) out.graduation.eligibleAt = built.graduationAt;
      }
      if (c.key === "sendingac" && out.domains.resting > 0 && out.domains.nextRevival) {
        out.notes.push(`${out.domains.resting} domain${out.domains.resting === 1 ? "" : "s"} resting after bounce trouble; next revival ${out.domains.nextRevival.slice(0, 10)}.`);
      }
      return out;
    })
    .sort((a, b) => (b.boxes.total - a.boxes.total));
}
