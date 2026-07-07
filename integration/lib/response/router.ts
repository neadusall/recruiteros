/**
 * RecruitersOS · Response
 * The router: executes a rule's actions against the prospect, the sequence
 * engine, the ATS and the suppression list. This is where a classified reply
 * becomes real-world state changes.
 */

import { getCore } from "../core/repository";
import { getAts } from "../ats";
import { rid, nowIso, today } from "../core/ids";
import { suppress } from "./suppression";
import { ruleFor } from "./rules";
import { variantOf, recordOutcome } from "../bd/experiment";
import { recordStrategyOutcome } from "../bd/nurtureStrategy";
import { markEngaged } from "../bd/nurture";
import type { Classification, InboundResponse, ProcessedResponse } from "./types";
import type { ProspectStatus } from "../core/types";

/**
 * Hook the sequence engine here so a reply pauses every channel. The LinkedIn
 * engine already pauses on reply via its own webhook; this covers email/SMS and
 * gives the Response inbox one consistent place to stop all drips.
 */
export type PauseSequences = (prospectId: string) => Promise<void>;

const STATUS_MAP: Record<string, ProspectStatus> = {
  replied: "replied",
  nurture: "nurture",
  closed_lost: "closed_lost",
  do_not_contact: "do_not_contact",
  booked: "booked",
  won: "won",
};

/**
 * The mpc/consultative A/B experiment is a BUSINESS DEVELOPMENT model only.
 * Candidate (recruiting) outreach is a separate model, built later. Resolve a
 * prospect's motion authoritatively (its own tag, else its campaign) so recruiting
 * replies NEVER record into the BD experiment and skew its results.
 */
async function isBdMotion(
  core: ReturnType<typeof getCore>,
  prospect: { motion?: string; campaignId?: string } | null,
): Promise<boolean> {
  if (!prospect) return false;
  if (prospect.motion) return prospect.motion === "bd";
  if (!prospect.campaignId) return false;
  const c = await core.getCampaign(prospect.campaignId);
  return c?.motion === "bd";
}

export async function route(
  inbound: InboundResponse,
  cls: Classification,
  pauseSequences?: PauseSequences,
): Promise<ProcessedResponse> {
  const rule = ruleFor(cls.class);
  const core = getCore();
  const ats = getAts();
  const taken: string[] = [];
  let atsEventId: string | undefined;

  const prospect = inbound.prospectId ? await core.getProspect(inbound.prospectId) : null;
  const personRef = prospect?.atsPersonId ?? prospect?.email ?? inbound.fromHandle ?? "unknown";
  // BD-only A/B experiment gate (candidate outreach is a separate model).
  const bd = await isBdMotion(core, prospect);

  for (const action of rule.actions) {
    switch (action.kind) {
      case "push_notification": {
        taken.push(`notify: ${action.detail ?? "recruiter pinged"}`);
        // Email the operator right now (RECRUITEROS_NOTIFY_EMAIL; no-op until set).
        // Fire-and-forget: a notification failure must never affect reply processing.
        const { notifyReply } = await import("./notify");
        void notifyReply(
          { workspaceId: inbound.workspaceId, detail: action.detail, channel: inbound.channel, text: inbound.text, fromHandle: inbound.fromHandle },
          prospect ?? null,
        ).catch(() => {});
        break;
      }

      case "pause_all_sequences":
        if (prospect && pauseSequences) await pauseSequences(prospect.id);
        taken.push("paused all sequences");
        break;

      case "advance_step":
        if (prospect) {
          prospect.dripStage = (prospect.dripStage ?? 0) + 1;
          await core.saveProspect(prospect);
        }
        taken.push("advanced +1 touch");
        break;

      case "send_booking_link":
        if (prospect) {
          try {
            if (bd) { recordOutcome(prospect.id, "engaged"); recordStrategyOutcome(prospect.id, "engaged"); markEngaged(prospect.id); }
            const { sendBookingAsk } = await import("../bd/booking");
            const r = await sendBookingAsk(
              inbound.workspaceId,
              {
                email: prospect.email,
                firstName: prospect.firstName,
                fullName: prospect.fullName,
                title: prospect.title,
                company: prospect.company,
                profileSummary: prospect.headline,
              },
              { priorContext: inbound.text, variant: variantOf(prospect.id) },
            );
            taken.push(
              r.mode === "send"
                ? `sent booking ask (${r.provider})`
                : r.mode === "draft"
                  ? "drafted booking ask (one-click send)"
                  : `booking ask skipped (${r.detail})`,
            );
          } catch (e: any) {
            taken.push(`booking ask failed (${e?.message ?? "error"})`);
          }
        }
        break;

      case "send_asset":
        taken.push("queued campaign asset (case study / comp benchmark)");
        break;

      case "tag":
        if (action.detail) {
          await ats.tagPerson(personRef, action.detail);
          taken.push(`tagged "${action.detail}"`);
        }
        break;

      case "set_status":
        if (prospect && action.detail && STATUS_MAP[action.detail]) {
          prospect.status = STATUS_MAP[action.detail];
          // A positive reply (status -> replied) is an A/B "engaged" event, even though
          // we now hand the conversation to the operator instead of auto-sending a link.
          // BD-only: recruiting replies never enter the BD experiment.
          if (prospect.status === "replied" && bd) { recordOutcome(prospect.id, "engaged"); recordStrategyOutcome(prospect.id, "engaged"); markEngaged(prospect.id); }
          if (prospect.status === "booked") { prospect.bookedAt = today(); if (bd) { recordOutcome(prospect.id, "booked"); recordStrategyOutcome(prospect.id, "booked"); markEngaged(prospect.id); } }
          prospect.lastChannel = inbound.channel;
          await core.saveProspect(prospect);
          taken.push(`status -> ${prospect.status}`);
        }
        break;

      case "nurture":
        taken.push(`-> ${action.detail ?? ""} nurture track`);
        break;

      case "capture_field": {
        const val =
          action.detail === "timing" ? cls.captured?.timing : cls.captured?.referralTo;
        taken.push(`captured ${action.detail}: ${val ?? "(none)"}`);
        break;
      }

      case "suppress_all":
        await suppress(
          inbound.workspaceId,
          [prospect?.email, prospect?.linkedinUrl, prospect?.phone, inbound.fromHandle],
          "opt-out",
          inbound.receivedAt,
        );
        if (personRef !== "unknown") await ats.addDoNotContact(personRef);
        taken.push("suppressed all channels + ATS DNC");
        break;

      case "log_activity":
        atsEventId = await ats.pushPersonEvent({
          personRef,
          activityType: rule.label,
          channel: inbound.channel,
          note: action.detail ?? inbound.text.slice(0, 140),
          at: inbound.receivedAt,
        });
        if (prospect) {
          await core.recordActivity({
            id: rid("act"),
            workspaceId: inbound.workspaceId,
            prospectId: prospect.id,
            channel: inbound.channel,
            type: `reply_${rule.class}`,
            summary: `${rule.label}: ${inbound.text.slice(0, 120)}`,
            at: inbound.receivedAt,
            atsEventId,
          });
        }
        taken.push(`logged person_event (${atsEventId})`);
        break;
    }
  }

  return { inbound, classification: cls, rule, actionsTaken: taken, atsEventId };
}

/** Stamp a manual "booked" the way the reference does (booked_at + Loxo activity). */
export async function markBooked(prospectId: string): Promise<void> {
  const core = getCore();
  const ats = getAts();
  const p = await core.getProspect(prospectId);
  if (!p) return;
  p.status = "booked";
  p.bookedAt = today();
  await core.saveProspect(p);
  // BD-only experiment (candidate outreach is a separate model).
  if (await isBdMotion(core, p)) { recordOutcome(p.id, "booked"); recordStrategyOutcome(p.id, "booked"); markEngaged(p.id); }
  const ref = p.atsPersonId ?? p.email ?? prospectId;
  const eventId = await ats.pushPersonEvent({
    personRef: ref,
    activityType: "Discovery Call Booked",
    channel: "system",
    note: `Booked on ${p.bookedAt}`,
    at: nowIso(),
  });
  await ats.advanceDeal(ref, "Qualification");
  await core.recordActivity({
    id: rid("act"),
    workspaceId: p.workspaceId,
    prospectId: p.id,
    channel: "system",
    type: "discovery_call_booked",
    summary: "Discovery Call Booked",
    at: nowIso(),
    atsEventId: eventId,
  });
}
