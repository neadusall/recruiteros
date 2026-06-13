/**
 * RecruitersOS · Signal Engine
 * Campaign flow — the end-to-end lifecycle from signal to launch-ready.
 *
 * `campaignBuilder` assembles a reviewable draft for free. This module runs the rest of
 * the proper campaign flow, with an explicit state machine so nothing launches half-built:
 *
 *   draft ──approve──▶ enriching ──▶ drafting ──▶ ready ──launch──▶ live
 *     │                    │             │           │
 *   (free)          cheapest-first   signal-      every target has a
 *                     waterfall      grounded     contact + a sequence
 *                                    sequences
 *
 * The orchestrator only spends on enrichment AFTER a human approves the free draft, and
 * only drafts outreach for targets it could actually reach. The output, a
 * `LaunchReadyCampaign`, is the artifact the deploy layer (../linkedin sequenceEngine,
 * email, SMS) executes. State transitions are pure given injected `now` + enrich fn.
 */

import type { EnrichmentReport } from "./waterfall";
import type { CampaignDraft, CampaignTarget } from "./campaignBuilder";
import { planLaunch } from "./campaignBuilder";
import { draftSequence, type DraftedSequence, type MessageContext, type DraftOptions } from "./messaging";
import type { Signal } from "./types";

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

export type CampaignState =
  | "draft"       // assembled from free signals, awaiting human approval
  | "approved"    // approved; enrichment may begin
  | "enriching"   // resolving contact data, cheapest-source-first
  | "drafting"    // generating signal-grounded sequences
  | "ready"       // every reachable target has contact + a drafted sequence
  | "live"        // handed to the deploy layer
  | "archived";

/** A target after the flow has run: contact resolved + sequence drafted. */
export interface PreparedTarget {
  target: CampaignTarget;
  /** Resolved contact fields from the waterfall (email/phone/domain), if found. */
  contact?: { email?: string; phone?: string; mobilePhone?: string; landlinePhone?: string; confidence?: number; cost?: number };
  /** The drafted, signal-grounded outreach sequence. */
  sequence?: DraftedSequence;
  /** Why a target was dropped from launch (no reachable contact, etc.). */
  skippedReason?: string;
}

export interface LaunchReadyCampaign {
  name: string;
  state: CampaignState;
  motion: CampaignDraft["motion"];
  prepared: PreparedTarget[];
  /** Targets ready to send (have a contact AND a sequence). */
  launchable: PreparedTarget[];
  stats: {
    targets: number;
    enriched: number;
    drafted: number;
    launchable: number;
    skipped: number;
    enrichmentCostUsd: number;
  };
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Orchestrator                                                        */
/* ------------------------------------------------------------------ */

export interface FlowDeps {
  now: string;
  /** Resolve contact data for one subject (wraps cheapFirstContactWaterfall + enrich). */
  enrichSubject: (subject: Record<string, unknown>) => Promise<EnrichmentReport>;
  /** Optional LLM personalizer passed through to message drafting. */
  personalize?: DraftOptions["personalize"];
  /** Sender identity for the drafted copy. */
  sender?: string;
  /** Only prepare the top N targets (cost control); default all. */
  limit?: number;
}

/**
 * Run an approved draft to launch-ready. Enriches each target that needs contact data,
 * drafts a signal-grounded sequence for those it can reach, and reports the full state.
 * Targets with no reachable contact are kept but flagged, never silently dropped.
 */
export async function prepareCampaign(
  draft: CampaignDraft,
  deps: FlowDeps,
): Promise<LaunchReadyCampaign> {
  const launchPlan = planLaunch(draft);
  const jobsByKey = new Map(launchPlan.enrichmentJobs.map((j) => [j.targetKey, j.subject]));
  const targets = typeof deps.limit === "number" ? draft.targets.slice(0, deps.limit) : draft.targets;

  let enrichmentCostUsd = 0;
  const prepared: PreparedTarget[] = [];

  for (const target of targets) {
    const subject = jobsByKey.get(target.key) ?? subjectFromTarget(target);

    // 1. Enrich (cheapest-first) only if we need contact data.
    let contact: PreparedTarget["contact"];
    if (target.needs.email || target.needs.phone) {
      try {
        const report = await deps.enrichSubject(subject);
        enrichmentCostUsd += report.totalCost;
        const email = report.resolved.email?.value as string | undefined;
        // Mobile and landline are resolved as separate fields; the generic
        // `phone` field is the legacy single number. Primary phone = mobile first.
        const mobilePhone = report.resolved.mobilePhone?.value as string | undefined;
        const landlinePhone = report.resolved.landlinePhone?.value as string | undefined;
        const genericPhone = report.resolved.phone?.value as string | undefined;
        const phone = mobilePhone ?? landlinePhone ?? genericPhone;
        if (email || phone) {
          contact = {
            email,
            phone,
            mobilePhone,
            landlinePhone,
            confidence: report.resolved.email?.confidence ?? report.resolved.mobilePhone?.confidence ?? report.resolved.phone?.confidence,
            cost: report.totalCost,
          };
        }
      } catch {
        /* enrichment failed for this target; it will be flagged below */
      }
    } else {
      contact = {}; // already had what it needed
    }

    // 2. No reachable contact → keep but skip from launch.
    if (!contact || (!contact.email && !contact.phone && (target.needs.email || target.needs.phone))) {
      prepared.push({ target, contact, skippedReason: "no reachable contact found" });
      continue;
    }

    // 3. Draft the signal-grounded sequence from the target's strongest signal.
    const topSignal = target.signals[0];
    const sequence = topSignal
      ? await draftSequence(topSignal, messageContext(target, contact, deps.sender), {
          personalize: deps.personalize,
        })
      : undefined;

    prepared.push({ target, contact, sequence });
  }

  const launchable = prepared.filter((p) => p.sequence && (p.contact?.email || p.contact?.phone));
  return {
    name: draft.name,
    state: "ready",
    motion: draft.motion,
    prepared,
    launchable,
    stats: {
      targets: prepared.length,
      enriched: prepared.filter((p) => p.contact?.email || p.contact?.phone).length,
      drafted: prepared.filter((p) => p.sequence).length,
      launchable: launchable.length,
      skipped: prepared.filter((p) => p.skippedReason).length,
      enrichmentCostUsd: round(enrichmentCostUsd),
    },
    updatedAt: deps.now,
  };
}

/* ------------------------------------------------------------------ */
/* State transitions (explicit, so the UI/API can drive the machine)  */
/* ------------------------------------------------------------------ */

const TRANSITIONS: Record<CampaignState, CampaignState[]> = {
  draft: ["approved", "archived"],
  approved: ["enriching", "archived"],
  enriching: ["drafting", "archived"],
  drafting: ["ready", "archived"],
  ready: ["live", "archived"],
  live: ["archived"],
  archived: [],
};

/** Validate a lifecycle transition. Returns the next state or throws. */
export function transition(from: CampaignState, to: CampaignState): CampaignState {
  if (!TRANSITIONS[from].includes(to)) {
    throw new Error(`Illegal campaign transition: ${from} → ${to}`);
  }
  return to;
}

/* ------------------------------------------------------------------ */
/* Launch hand-off                                                     */
/* ------------------------------------------------------------------ */

/** The per-channel send items the deploy layer consumes once a campaign goes live. */
export interface SendItem {
  targetKey: string;
  to: { email?: string; phone?: string; name: string };
  step: number;
  channel: DraftedSequence["steps"][number]["channel"];
  delayHours: number;
  subject?: string;
  body: string;
}

/** Flatten a launch-ready campaign into ordered send items for execution. */
export function toSendItems(campaign: LaunchReadyCampaign): SendItem[] {
  const items: SendItem[] = [];
  for (const p of campaign.launchable) {
    if (!p.sequence) continue;
    for (const step of p.sequence.steps) {
      // Only include channels we have an address for.
      if (step.channel === "email" && !p.contact?.email) continue;
      if (step.channel === "sms" && !p.contact?.phone) continue;
      items.push({
        targetKey: p.target.key,
        to: { email: p.contact?.email, phone: p.contact?.phone, name: p.target.name },
        step: step.step,
        channel: step.channel,
        delayHours: step.delayHours,
        subject: step.subject,
        body: step.body,
      });
    }
  }
  return items;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function subjectFromTarget(t: CampaignTarget): Record<string, unknown> {
  const top = t.signals[0];
  return {
    fullName: t.kind === "person" ? t.name : undefined,
    companyName: t.kind === "company" ? t.name : top?.company?.name,
    domain: top?.company?.domain,
    title: t.title,
  };
}

function messageContext(
  t: CampaignTarget,
  contact: PreparedTarget["contact"],
  sender?: string,
): MessageContext {
  return {
    firstName: t.kind === "person" ? t.name.split(/\s+/)[0] : undefined,
    fullName: t.kind === "person" ? t.name : undefined,
    company: t.kind === "company" ? t.name : t.signals[0]?.company?.name,
    title: t.title,
    sender,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Re-exports for convenience                                          */
/* ------------------------------------------------------------------ */

export type { Signal };
