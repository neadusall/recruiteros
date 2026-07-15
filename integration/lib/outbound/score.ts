/**
 * RecruitersOS · Outbound Performance · Outbound Utilization Score
 *
 * One 0-100 number per user, computed ONLY from recorded activity vs resolved
 * goals (never a vanity constant). Channels a user cannot use (not_enabled)
 * are excluded and their weight redistributed, so a recruiter without SMS is
 * not punished for it. The methodology (weights + formulas) is exported so
 * the Admin Portal can show exactly how the number is built.
 */

import type { ChannelState, ChannelUtilization, OutboundScore, ScoreComponent, UserCapacity } from "./types";

/** Base weights (sum 100). Reweighted when channels are not enabled. */
export const SCORE_WEIGHTS: Record<string, number> = {
  email: 25,
  linkedin: 25,
  sms: 10,
  followUp: 15,
  content: 10,
  response: 15,
};

export const SCORE_METHODOLOGY = [
  "Each component scores 0-100 from real activity: outbound channels score progress against the user's resolved daily target (capped at 100), follow-up scores due-touch completion, content scores posts vs the weekly goal, response management scores the waiting-conversation backlog.",
  "Component weights: Email 25, LinkedIn 25, SMS 10, Follow-up discipline 15, LinkedIn content 10, Response management 15.",
  "Channels the user cannot use (no provider, zero target, or a system block) are EXCLUDED and their weight is redistributed across the remaining components.",
  "Supply-constrained channels score 70 (neutral-positive): the user could not have spent that capacity, so they are not penalized while the constraint is flagged to admins.",
  "Positive replies and meetings lift the response component: each positive reply +3, each meeting +10 (capped at 100).",
];

function channelScore(u: ChannelUtilization): number {
  if (u.state === "not_enabled") return 0;
  if (u.state === "supply_constrained" || u.state === "system_limited") return 70;
  return Math.min(100, Math.round(u.targetPct));
}

function stateLabel(s: ChannelState): string {
  switch (s) {
    case "strong": return "strong";
    case "attention": return "needs attention";
    case "underutilized": return "underutilized";
    case "supply_constrained": return "supply constrained";
    case "system_limited": return "system limited";
    default: return "not enabled";
  }
}

export function computeScore(cap: UserCapacity, outcomes?: { positiveReplies: number; meetingsBooked: number }): OutboundScore {
  const parts: Array<{ key: keyof typeof SCORE_WEIGHTS; u: ChannelUtilization; label: string }> = [
    { key: "email", u: cap.email, label: "Email Utilization" },
    { key: "linkedin", u: cap.linkedin, label: "LinkedIn Utilization" },
    { key: "sms", u: cap.sms, label: "SMS Utilization" },
    { key: "followUp", u: cap.followUp, label: "Follow-Up Discipline" },
    { key: "content", u: cap.content, label: "LinkedIn Content" },
    { key: "response", u: cap.response, label: "Response Management" },
  ];

  const enabled = parts.filter((p) => p.u.state !== "not_enabled");
  const totalWeight = enabled.reduce((s, p) => s + SCORE_WEIGHTS[p.key as string], 0) || 1;

  const components: ScoreComponent[] = parts.map((p) => {
    const raw = channelScore(p.u);
    const w = p.u.state === "not_enabled" ? 0 : Math.round((SCORE_WEIGHTS[p.key as string] / totalWeight) * 1000) / 10;
    let score = raw;
    if (p.key === "response" && outcomes) {
      // Outcomes lift the response component: engagement is the point.
      const lift = Math.min(30, (outcomes.positiveReplies || 0) * 3 + (outcomes.meetingsBooked || 0) * 10);
      score = Math.min(100, raw + lift);
    }
    return {
      key: p.u.key,
      label: p.label,
      score,
      weight: w,
      state: p.u.state,
      detail: p.u.state === "not_enabled"
        ? "Channel not enabled; excluded from the score"
        : `${p.u.used}/${p.u.target || p.u.capacity} today (${stateLabel(p.u.state)})`,
    };
  });

  const total = Math.round(
    components.reduce((s, comp) => s + comp.score * (comp.weight / 100), 0),
  );

  const weak = components
    .filter((comp) => comp.weight > 0 && comp.score < 60)
    .sort((a, b) => a.score - b.score)
    .slice(0, 2);
  const band = total >= 80 ? "STRONG" : total >= 60 ? "ON TRACK" : total >= 40 ? "BELOW TARGET" : "UNDERUTILIZED";
  const statusLine = weak.length
    ? `${band}: ${weak.map((w) => w.label.toUpperCase()).join(" AND ")} NEED${weak.length === 1 ? "S" : ""} ATTENTION`
    : band;

  return { total: Math.max(0, Math.min(100, total)), components, statusLine };
}
