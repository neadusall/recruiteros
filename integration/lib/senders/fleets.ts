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
import { coldCapFor, coldMaxPerInbox, RAMP_BY_WEEK, SENDING_AC_PER_INBOX } from "./limits";
import { activeBlocks } from "./recipientGuard";
import type { SenderInbox } from "./types";

// Receiver names for the fleet note, keyed the way the provider-block ledger keys them.
const RECEIVER_LABEL: Record<string, string> = {
  google: "Gmail / Google Workspace",
  microsoft: "Outlook / Microsoft 365",
  mailspamprotection: "mailspamprotection.com",
  proofpoint: "Proofpoint",
  mimecast: "Mimecast",
  barracuda: "Barracuda",
};

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
  /** Internal fleet only: the dated path from "recovering" to "fully sending",
   *  computed from the same ledgers that gate each step (rest ledger, block
   *  ledger, graduation clock, ramp constants) so the card never promises a date
   *  the machinery will not keep. null for fleets without a recovery story. */
  outlook: OutlookStep[] | null;
}

export interface OutlookStep {
  when: string | null;   // ISO date the step is expected; null = waits on a condition with no clock
  what: string;
  done: boolean;
}

interface RestSnap { domains?: Record<string, { state?: string; until?: string }> }
interface NdrSnap { perDomain?: Record<string, { bounces?: number }>; warmupNdrs?: number; generatedAt?: string }
interface BlocksSnap { blocks?: Record<string, { fleet?: string; provider?: string; count?: number; lastSeen?: string }> }
interface EgressSnap { cutoverAt?: string; egressIp?: string; warmupRamp?: { afterDays: number; perDay: number }[] }
interface Recv { accepted: number; rejected: number; deferred: number; rateLimited?: number }
interface StandingSnap {
  at?: string; newIp?: string; rulePos1?: boolean; egressSeen?: string; oldIpMentions?: number;
  receivers?: { google?: Recv; microsoft?: Recv; other?: Recv };
  dnsbl?: Record<string, string>;
}

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
  const [inboxes, rest, ndr, ndrImap, blocks, blocksSnap, egress, standing] = await Promise.all([
    listInboxes(workspaceId),
    loadSnapshot<RestSnap>("mpc_domain_rest_v1"),
    loadSnapshot<NdrSnap>("mpc_ndr_v1"),
    loadSnapshot<NdrSnap>("mpc_ndr_imap_v1"),
    activeBlocks().catch(() => new Map<string, Set<string>>()),
    loadSnapshot<BlocksSnap>("provider_blocks_v1"),
    loadSnapshot<EgressSnap>("internal_egress_v1"),
    loadSnapshot<StandingSnap>("internal_egress_status_v1"),
  ]);

  const now = Date.now();
  const resting = new Map<string, string | null>(); // domain -> until
  for (const [d, v] of Object.entries(rest?.domains || {})) {
    if (v?.state === "resting" && (!v.until || Date.parse(v.until) > now)) resting.set(d.toLowerCase(), v.until || null);
  }

  const graduateDays = (k: FleetKey) =>
    k === "internal"
      ? Number(process.env.SENDER_GRADUATE_DAYS_INTERNAL || 30)
      : Number(process.env.SENDER_GRADUATE_DAYS || 14);

  const cards = new Map<FleetKey, FleetCard & { _domains: Set<string>; _gradAts: number[] }>();
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
        _domains: new Set<string>(), _gradAts: [],
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
    if (dom && resting.has(dom)) { c.boxes.benched++; c.capacity.benched += cap; }
    else c.capacity.today += cap;

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
      const googleStep = Math.max(1, Number(String(process.env.MPC_GOOGLE_RAMP || "8").split(",")[0]) || 8);
      const usableBoxes = c.boxes.active + c.boxes.warming - c.boxes.benched;
      const coldToday =
        c.key === "sendingac" ? c.capacity.today :
        c.key === "google" ? Math.min(c.capacity.today, Math.max(0, usableBoxes) * googleStep) :
        0; // internal + other: cold lane parked (MPC_SMTP_LANE); app sends only
      const out: FleetCard = {
        key: c.key, name: c.name, boxes: c.boxes,
        domains: { total: c._domains.size, resting: restingMine.length, nextRevival: revivals[0] || null },
        capacity: c.capacity,
        coldToday,
        bounces7d: c.bounces7d,
        warmupBounces7d: c.key === "internal" ? (ndrImap?.warmupNdrs ?? null) : null,
        graduation: c.boxes.warming ? { warming: c.boxes.warming, eligibleAt: grad ? new Date(grad).toISOString() : null } : null,
        notes: [],
        outlook: null,
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

        // WHAT TO EXPECT: every date below is derived from the ledger that gates the
        // step, with the same constants the gate uses, so the list moves when reality
        // moves (a new rejection pushes every downstream date out by itself).
        const DAY = 86_400_000;
        const iso = (t: number) => new Date(t).toISOString();
        const steps: OutlookStep[] = [];
        const cut = egress?.cutoverAt ? Date.parse(egress.cutoverAt) : NaN;
        if (Number.isFinite(cut)) steps.push({ when: iso(cut), what: `Outbound moved to the clean IP ${egress?.egressIp || ""}; receivers now judge this server on fresh history`, done: cut <= now });
        for (const d of restingMine) {
          const u = resting.get(d);
          steps.push({ when: u || null, what: `${d} back in rotation once its rest is served`, done: false });
        }
        // Block ledger: a pair stays live 7 days after its last notice (recipientGuard
        // ACTIVE_WINDOW); the latest live pair sets when routing reopens.
        const blockMin = Number(process.env.SENDER_BLOCK_MIN) > 0 ? Number(process.env.SENDER_BLOCK_MIN) : 20;
        let quietAt: number | null = null;
        for (const b of Object.values(blocksSnap?.blocks || {})) {
          if (b?.fleet !== "internal" || (b.count || 0) < blockMin || !b.lastSeen) continue;
          const t = Date.parse(b.lastSeen) + 7 * DAY;
          if (t > now && (quietAt == null || t > quietAt)) quietAt = t;
        }
        if (rejecting.length) {
          const names = rejecting.map((p) => RECEIVER_LABEL[p] || p).join(", ");
          steps.push({ when: quietAt ? iso(quietAt) : null, what: `${names} recipients return to this fleet after 7 days without a rejection`, done: false });
        }
        // Warm-up ramp (lume-warmup-keeper on the host): step N days after the cutover,
        // and only once no receiver has rejected us for 3 days.
        if (Number.isFinite(cut)) {
          for (const r of egress?.warmupRamp || []) {
            if (!(r.afterDays > 0)) continue;
            const t = Math.max(cut + r.afterDays * DAY, quietAt ? quietAt - 4 * DAY : 0);
            steps.push({ when: iso(t), what: `Warm-up steps up to ${r.perDay}/day per box (automatic; climbs only on clean standing, steps back to 8 on trouble)`, done: t <= now });
          }
        }
        // Graduation: the age clock AND a 7-day sweep window under the bounce ceiling.
        const fleetBoxes = c.boxes.active + c.boxes.warming;
        if (c.boxes.warming && grad) {
          const g = Math.max(grad, quietAt || 0);
          // The header's "auto-activate" date must be the same gated date, not the bare clock.
          if (out.graduation) out.graduation.eligibleAt = iso(g);
          steps.push({ when: iso(g), what: `${c.boxes.warming} warming boxes activate (30-day clock plus 7 quiet days); app lane starts at ${(fleetBoxes * RAMP_BY_WEEK[0]).toLocaleString()}/day`, done: false });
          for (let w = 1; w <= RAMP_BY_WEEK.length; w++) {
            const per = w < RAMP_BY_WEEK.length ? RAMP_BY_WEEK[w] : coldMaxPerInbox();
            steps.push({ when: iso(g + w * 7 * DAY), what: `App lane ramps to ${(fleetBoxes * per).toLocaleString()}/day (${per} per box)${w === RAMP_BY_WEEK.length ? ", full capacity" : ""}`, done: false });
          }
          if (coldToday === 0) steps.push({ when: iso(g + 14 * DAY), what: "Cold outreach lane stays parked until opened by hand; earliest sensible date, after a clean week of app-lane sends", done: false });
        }
        steps.sort((a, b) => (a.when || "9999").localeCompare(b.when || "9999"));
        out.outlook = steps;
      }
      if (c.key === "sendingac" && out.domains.resting > 0 && out.domains.nextRevival) {
        out.notes.push(`${out.domains.resting} domain${out.domains.resting === 1 ? "" : "s"} resting after bounce trouble; next revival ${out.domains.nextRevival.slice(0, 10)}.`);
      }
      return out;
    })
    .sort((a, b) => (b.boxes.total - a.boxes.total));
}
