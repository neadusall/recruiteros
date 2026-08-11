/**
 * RecruitersOS · Response · reply-center watchdog
 *
 * The worklist only protects revenue if it works when NOBODY has the tab open.
 * In-process ticker (armed at boot from instrumentation.ts, same shape as the
 * ATS scheduler: idempotent arm, overlap guard, unref'd timer, errors swallowed):
 *
 *   1. ESCALATE: an identity-verified positive/referral reply that blew its
 *      response window with no answer emails the operator ONCE ("it's sitting,
 *      go"). Opt-in via RECRUITEROS_NOTIFY_EMAIL, same switch as reply pings.
 *   2. NUDGE PRE-DRAFTS: when an answered thread crosses the 48h-silent line,
 *      the nudge reply is drafted BEFORE the recruiter sees the resurfaced row,
 *      so the comeback arrives with the answer attached. Spend-capped per tick.
 *   3. PRUNE: bounds the inbox snapshot (items / outbound / seen ids) so the
 *      durable store can never grow without limit.
 */

import { getInbox } from "./repository";
import { ruleFor } from "./rules";
import { notifyEmail, notifyReply } from "./notify";
import type { ProcessedResponse, Sla } from "./types";

// 5 minutes: the tick is cheap (in-memory scans; escalations send once per row;
// nudge drafts are capped per tick) and the whole point is minute-level latency
// on hot replies. Override with RECRUITEROS_REPLY_WATCH_MS.
const CYCLE_MS = positiveIntEnv("RECRUITEROS_REPLY_WATCH_MS", 5 * 60 * 1000);
const FIRST_DELAY_MS = 30_000;
const NUDGE_MS = 48 * 3600_000;
const MAX_NUDGE_DRAFTS_PER_TICK = 5;
const ESCALATE_CLASSES = new Set(["positive", "referral"]);
const NUDGE_CLASSES = new Set(["positive", "soft_yes", "referral", "timing_objection", "unclassified"]);

function positiveIntEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function slaMs(sla: Sla): number {
  return sla === "immediate" ? 3600_000 : sla === "four_hours" ? 4 * 3600_000 : 24 * 3600_000;
}

/**
 * The worklist's response windows, tighter than the routing matrix for hot
 * classes: a positive reply answered in minutes-to-an-hour qualifies at a
 * multiple of one answered next-day (the routing matrix's same_day is about
 * SYSTEM actions, not how long a hot lead should wait for a human).
 */
export function responseWindowHours(cls: string): number {
  if (cls === "positive") return 1;
  if (cls === "referral" || cls === "soft_yes") return 4;
  return slaMs(ruleFor(cls as any).sla) / 3600_000;
}

function verified(p: ProcessedResponse): boolean {
  return !!(p.inbound.prospectId || p.inbound.campaignId);
}

/** Escalation eligibility, pure so the behavior suite can pin it down. */
export function needsEscalation(p: ProcessedResponse, now = Date.now()): boolean {
  if (!verified(p) || p.handledAt || p.deletedAt || p.escalatedAt) return false;
  if (p.snoozedUntil && Date.parse(p.snoozedUntil) > now) return false;
  if (!ESCALATE_CLASSES.has(p.classification.class)) return false;
  const age = now - Date.parse(p.inbound.receivedAt);
  return age > responseWindowHours(p.classification.class) * 3600_000;
}

async function escalateBlownSlas(ws: string): Promise<void> {
  if (!notifyEmail()) return; // same opt-in switch as the reply pings
  const inbox = getInbox();
  const rows = await inbox.list(ws, 200);
  for (const p of rows) {
    if (!needsEscalation(p)) continue;
    const hours = Math.round((Date.now() - Date.parse(p.inbound.receivedAt)) / 3600_000);
    const { getCore } = await import("../core/repository");
    const prospect = p.inbound.prospectId ? (await getCore().getProspect(p.inbound.prospectId)) ?? null : null;
    const app = process.env.RECRUITEROS_APP_URL ?? "https://recruitersos.co";
    const sent = await notifyReply({
      workspaceId: ws,
      detail: `This ${p.classification.class} reply has been waiting ${hours}h, past its response window. Interested replies cool fast; answer it now from the Replies tab.`,
      channel: p.inbound.channel,
      text: p.inbound.text,
      fromHandle: p.inbound.fromHandle,
      draft: p.suggestedReply?.text,
      link: { href: `${app}/command#response`, label: "Open the Replies tab (the draft is waiting in the composer)" },
    }, prospect);
    if (sent) await inbox.markEscalated(ws, p.inbound.id);
  }
}

async function preDraftDueNudges(ws: string): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) return;
  const inbox = getInbox();
  const rows = await inbox.list(ws, 200);
  // Newest actionable row per prospect, same shape the list route surfaces.
  const newest = new Map<string, ProcessedResponse>();
  for (const p of rows) {
    const pid = p.inbound.prospectId;
    if (!pid || !NUDGE_CLASSES.has(p.classification.class)) continue;
    const cur = newest.get(pid);
    if (!cur || p.inbound.receivedAt > cur.inbound.receivedAt) newest.set(pid, p);
  }
  let drafted = 0;
  for (const [pid, p] of newest) {
    if (drafted >= MAX_NUDGE_DRAFTS_PER_TICK) break;
    const all = await inbox.forPerson(ws, { prospectId: pid });
    const notes = await inbox.outboundForPerson(ws, { prospectId: pid, responseIds: all.map((r) => r.inbound.id) });
    if (!notes.length) continue;
    const lastOut = notes.map((n) => n.at).sort().pop()!;
    const lastIn = all.map((r) => r.inbound.receivedAt).sort().pop()!;
    const quiet = lastOut > lastIn && Date.now() - Date.parse(lastOut) > NUDGE_MS;
    if (!quiet) continue;
    // Already have a draft written after the last outbound? Then it IS the nudge draft.
    if (p.suggestedReply && p.suggestedReply.at > lastOut) continue;
    try {
      const { draftForRow } = await import("./draft");
      const channel = (["email", "linkedin", "sms"].includes(p.inbound.channel) ? p.inbound.channel : "email") as "email" | "linkedin" | "sms";
      const text = await draftForRow(ws, p, "nudge", channel);
      await inbox.setSuggested(ws, p.inbound.id, { text, objective: "nudge", at: new Date().toISOString() });
      drafted++;
    } catch { /* the on-demand button still drafts */ }
  }
}

let started = false;
let running = false;

async function runCycle(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const inbox = getInbox();
    await inbox.prune();
    for (const ws of await inbox.workspaceIds()) {
      try { await escalateBlownSlas(ws); } catch { /* next ws */ }
      try { await preDraftDueNudges(ws); } catch { /* next ws */ }
    }
  } catch { /* a bad cycle must never touch a user request */ }
  finally { running = false; }
}

/** Idempotent arm; call from instrumentation.ts. */
export function ensureResponseWatchdog(): void {
  if (started) return;
  started = true;
  const first = setTimeout(() => { void runCycle(); }, FIRST_DELAY_MS);
  if (typeof first.unref === "function") first.unref();
  const t = setInterval(() => { void runCycle(); }, CYCLE_MS);
  if (typeof t.unref === "function") t.unref();
  console.log(`[response] reply-center watchdog armed (every ${Math.round(CYCLE_MS / 60000)}m: SLA escalation, nudge pre-drafts, snapshot prune)`);
}
