/**
 * RecruitersOS · In-Market → Prospects launch
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

/** A leg that only fires for a SUBSET of prospects (HOT-tier voicemail, post-reply SMS), so
 *  it is shown as a per-unit add-on rather than baked into every person's firm cost. */
export interface ConditionalLine {
  key: string;
  label: string;
  unitUsd: number;
  basis: string;
}

export interface PushCostEstimate {
  count: number;
  /** Firm cost charged for EVERY prospect (enrichment + AI). qty/costUsd are ×count. */
  perPersonLines: CostLine[];
  perPersonUsd: number;   // firm subtotal for one prospect
  firmTotalUsd: number;   // count × perPersonUsd — the reliable headline
  /** Legs that only apply to a subset (not in the firm total). */
  conditional: ConditionalLine[];
  dialCapUsd: number;
  notes: string[];
}

/** The hard per-contact direct-dial LOOKUP cap (person-direct only); the premium reveal is
 *  skipped above this, so the cheap landline lookup is the firm cost. Mirrors Voice Drops. */
function dialCapUsd(): number {
  const v = Number(process.env.RECRUITEROS_MAX_DIAL_USD);
  return Number.isFinite(v) && v > 0 ? v : 0.03;
}

/**
 * Cost to push + enrich + sequence `count` selected people, modelled accurately:
 *
 *  - FIRM (every prospect): email find + verify, LinkedIn ID, phone classify + cheap
 *    direct-dial lookup, and the once-per-prospect AI personalization. Email sends ride the
 *    customer's own warmed inboxes (no per-email charge); the premium phone reveal is
 *    skipped above the dial cap, so the cheap landline lookup is the firm phone cost.
 *  - CONDITIONAL (a subset only, per sequence.ts): the voicemail/voice-drop fires only for
 *    HOT-tier prospects (warmth >= 80, hotOnly), and SMS only post-reply — so they are
 *    reported as per-unit add-ons, NOT multiplied into every person's total.
 */
export function estimatePushCost(count: number, opts: { directDial?: boolean } = {}): PushCostEstimate {
  const n = Math.max(0, Math.floor(count || 0));
  const maxDial = dialCapUsd();
  const directDial = opts.directDial === true;
  const perPersonLines: CostLine[] = [];
  const add = (key: string, label: string, unitUsd: number) => {
    perPersonLines.push({ key, label, qty: n, unitUsd, costUsd: +(n * unitUsd).toFixed(4) });
  };

  // FIRM, per-prospect — the cheapest-first resolution that runs for everyone. email_find is
  // already the blended multi-provider waterfall (80-95% coverage), so the email fail-safe is
  // baked in. Phone here is the CHEAP lookup; the premium direct-dial reveal is a separate,
  // deeper leg below (it fires lazily at the dial/voicemail step, not for every prospect).
  add("email_find", "Email — multi-provider waterfall (deep, 80-95%)", rateCost("email_find"));
  add("email_verify", "Email verification", rateCost("email_verify"));
  add("person_enrich", "LinkedIn profile ID + data", rateCost("person_enrich"));
  add("phone_classify", "Phone classify (route mobile vs landline)", rateCost("phone_classify"));
  add("landline_find", "Phone lookup (cheap-first)", rateCost("landline_find"));
  add("ai_personalize", "AI personalization (LLM, house voice)", rateCost("ai_personalize"));

  const perPersonUsd = +perPersonLines.reduce((s, l) => s + l.unitUsd, 0).toFixed(4);
  const firmTotalUsd = +(n * perPersonUsd).toFixed(2);

  // Conditional legs — per applicable prospect, NOT in the firm total. (No SMS — not BD.)
  //  - Deep direct-dial reveal: the $0.10 PREMIUM fail-safe (Apify + PDL) that actually
  //    resolves the person's direct number when the cheap rung missed. Fires lazily at the
  //    dial/voicemail step; no-find lookups are FREE. Honors the dial cap (default $0.03 —
  //    raise RECRUITEROS_MAX_DIAL_USD to >= $0.10 to let it run; otherwise it's skipped and
  //    fill stays low by design).
  //  - Voicemail/voice-drop: Telnyx AMD drop to landline/VoIP, HOT-tier only.
  const voicemailUnit = +(rateCost("voice_minute") * 0.5 + rateCost("voice_clone_synthesis") * 0.3).toFixed(4);
  const ddPrice = rateCost("apify_direct_dial");
  const conditional: ConditionalLine[] = [];
  if (directDial) {
    // The setting is ON for this push — the deep reveal runs for every pushed prospect.
    conditional.push({
      key: "deep_dial",
      label: "Verified direct dial — person-direct landline/VoIP (Apify + PDL)",
      unitUsd: ddPrice,
      basis: "per number FOUND (no-find is free) · mobiles + switchboards rejected",
    });
  } else {
    conditional.push({
      key: "deep_dial_off",
      label: "Verified direct dial (off — enable the setting to run it)",
      unitUsd: ddPrice,
      basis: "$0.10 per number found when enabled; person-direct landline/VoIP only",
    });
  }
  conditional.push({
    key: "voicemail",
    label: "Voicemail / voice-drop (Telnyx AMD → landline/VoIP)",
    unitUsd: voicemailUnit,
    basis: "per HOT-tier prospect (warmth ≥ 80) only",
  });

  const notes = [
    "Per-person total is the FIRM cheapest-first resolution charged for every prospect (email waterfall + LinkedIn + cheap phone + AI).",
    "Email is already the blended multi-provider waterfall (80-95%) — its fail-safe is baked into the $0.006.",
    directDial
      ? `Direct dial is ON: the $${ddPrice.toFixed(2)} Apify+PDL reveal runs for every pushed prospect — a person-direct landline/VoIP only (mobiles + switchboards dropped), and a no-find lookup is free.`
      : `Direct dial is OFF: enable the Hire Signals setting to run the $${ddPrice.toFixed(2)} Apify+PDL reveal (person-direct landline/VoIP only; no-find free).`,
    "Voicemail/voice-drops fire only for HOT-tier prospects (warmth ≥ 80). Email sends use your own warmed inboxes — no per-email charge.",
  ];

  return { count: n, perPersonLines, perPersonUsd, firmTotalUsd, conditional, dialCapUsd: maxDial, notes };
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
      // Never let a hung n8n endpoint block the enroll path indefinitely.
      signal: AbortSignal.timeout(10_000),
    });
    return { triggered: res.ok, queued: true, detail: res.ok ? "n8n notified" : `n8n responded ${res.status}` };
  } catch (e) {
    return { triggered: false, queued: true, detail: `n8n webhook error: ${(e as Error).message}` };
  }
}
