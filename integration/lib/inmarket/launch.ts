/**
 * RecruiterOS · In-Market → Prospects launch
 *
 * Two things the "Push selected to Prospects" button needs:
 *   1. estimatePushCost() — a solid, itemized upper-bound of what it costs to run the
 *      selected people through the third-party enrichment (email + phone + LinkedIn ID) and
 *      the outreach sequence (LLM personalization + voicemail/voice-drop minutes), so the
 *      recruiter can approve or cancel BEFORE any money is spent.
 *   2. kickOutreach() — once approved (and the prospects are promoted), nudge the
 *      omnichannel orchestrator (n8n) to start immediately instead of waiting for its next
 *      poll of /api/prospects/queue. n8n is the engine that drafts the house-voice messages,
 *      enrolls each prospect in the 6-month nurture, and runs email → LinkedIn → voicemail →
 *      voice-drop. If no N8N_WEBHOOK_URL is set, the prospects still flow on the next poll.
 *
 * Costs come straight from the coded rate catalog (lib/billing/rates.ts) so the estimate and
 * the actual metered spend never drift. Dialing honors the hard per-contact cap.
 */

import { rateCost } from "../billing";

export interface CostLine {
  key: string;
  label: string;
  qty: number;
  unitUsd: number;
  costUsd: number;
}

export interface PushCostEstimate {
  count: number;
  lines: CostLine[];
  totalUsd: number;
  perPersonUsd: number;
  includeVoice: boolean;
  dialCapUsd: number;
  notes: string[];
}

/** The hard per-contact dialing cap (person-direct only); never exceed without explicit
 *  config. Mirrors the Voice Drops cost discipline. */
function dialCapUsd(): number {
  const v = Number(process.env.RECRUITEROS_MAX_DIAL_USD);
  return Number.isFinite(v) && v > 0 ? v : 0.03;
}

/**
 * Upper-bound cost to push + enrich + sequence `count` selected people. `includeVoice`
 * (default true) adds the phone reveal + voicemail/voice-drop legs; turn it off for an
 * email/LinkedIn-only estimate. Email sends ride the customer's own warmed inboxes, so
 * there is no per-email charge here.
 */
export function estimatePushCost(count: number, opts: { includeVoice?: boolean } = {}): PushCostEstimate {
  const n = Math.max(0, Math.floor(count || 0));
  const includeVoice = opts.includeVoice !== false;
  const maxDial = dialCapUsd();
  const lines: CostLine[] = [];
  const add = (key: string, label: string, unitUsd: number, qtyPer = 1) => {
    const qty = n * qtyPer;
    lines.push({ key, label, qty, unitUsd, costUsd: +(qty * unitUsd).toFixed(4) });
  };

  // Enrichment (the third-party providers: email + LinkedIn ID; phone below).
  add("email_find", "Email find (cheapest-first waterfall)", rateCost("email_find"));
  add("email_verify", "Email verification", rateCost("email_verify"));
  add("person_enrich", "LinkedIn profile ID + data", rateCost("person_enrich"));
  // AI personalization (LLM house-voice package per prospect).
  add("ai_personalize", "AI personalization (LLM, house voice)", rateCost("ai_personalize"));

  if (includeVoice) {
    add("phone_classify", "Phone classify (mobile vs landline)", rateCost("phone_classify"));
    add("apify_direct_dial", "Direct-dial find (capped)", Math.min(rateCost("apify_direct_dial"), maxDial));
    add("voice_minute", "Voicemail / voice-drop (~0.5 min)", +(rateCost("voice_minute") * 0.5).toFixed(4));
    add("voice_clone_synthesis", "Cloned-voice render (amortized, cache-mostly)", +(rateCost("voice_clone_synthesis") * 0.3).toFixed(4));
    add("sms_segment", "SMS touches (2 segments)", rateCost("sms_segment"), 2);
  }

  const totalUsd = +lines.reduce((s, l) => s + l.costUsd, 0).toFixed(2);
  const perPersonUsd = n ? +(totalUsd / n).toFixed(4) : 0;
  const notes = [
    "Email sends use your own warmed inboxes — no per-email charge.",
    includeVoice
      ? `Dialing is hard-capped at $${maxDial.toFixed(2)} per contact.`
      : "Voicemail / voice-drops excluded from this estimate.",
    "Upper-bound: a miss (no email/phone found) costs less than shown.",
  ];
  return { count: n, lines, totalUsd, perPersonUsd, includeVoice, dialCapUsd: maxDial, notes };
}

/**
 * Nudge the omnichannel orchestrator (n8n) to start the run now. Best-effort and env-gated:
 * POSTs to N8N_WEBHOOK_URL with the batch context. Returns whether it fired; either way the
 * promoted prospects are picked up by n8n's queue poll, so this only affects latency.
 */
export async function kickOutreach(input: {
  workspaceId: string;
  campaignId?: string;
  count: number;
}): Promise<{ triggered: boolean; queued: boolean; detail?: string }> {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) return { triggered: false, queued: true, detail: "no N8N_WEBHOOK_URL; prospects flow on next queue poll" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.N8N_WEBHOOK_TOKEN ? { Authorization: `Bearer ${process.env.N8N_WEBHOOK_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        event: "in_market_push",
        workspaceId: input.workspaceId,
        campaignId: input.campaignId,
        count: input.count,
        at: new Date().toISOString(),
      }),
    });
    return { triggered: res.ok, queued: true, detail: res.ok ? "n8n notified" : `n8n responded ${res.status}` };
  } catch (e) {
    return { triggered: false, queued: true, detail: `n8n webhook error: ${(e as Error).message}` };
  }
}
