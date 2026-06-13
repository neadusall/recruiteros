/**
 * RecruitersOS · Outreach Statistics — aggregation engine
 *
 * The read model behind the "Outreach Statistics" admin tab. It rolls up every
 * real signal the engine already records — sends (ActivityEvent `*_sent`),
 * classified replies (Response pipeline), email deliverability (Postal SendEvent
 * domain metrics), and prospect lifecycle — into one funnel plus the breakdowns
 * that answer "what's landing and who's responding to what":
 *
 *   funnel · by channel · by message/variant · by segment (industry/function/
 *   seniority) · by touch · by send-hour · by recruiter · by campaign · reply
 *   quality mix · deliverability by domain · daily trend · ranked recommendations.
 *
 * Pure read model: no writes, computed on demand. Attribution rides the
 * campaignId/variant/touch now stamped on each send (lib/channels logTouch).
 */

import { getCore } from "../core/repository";
import { recentResponses } from "../response";
import { classifyTitle } from "../signals/filters";
import { report as bdReport } from "../bd/experiment";
import { listMembers } from "../auth/team";
import type { ActivityEvent, Channel, Motion, Prospect } from "../core/types";

/* ------------------------------- options -------------------------------- */

export interface OutreachStatsOpts {
  motion?: Motion;
  campaignId?: string;
  ownerId?: string;
  /** Rolling window; null/undefined = all time. */
  sinceDays?: number | null;
  /** Restrict to one channel. */
  channel?: Channel;
}

/* ------------------------------- output --------------------------------- */

export interface DimStat {
  key: string;
  label: string;
  contacted: number;   // unique prospects contacted in this group
  sent: number;        // touches sent (events)
  replied: number;     // prospects who replied
  positive: number;    // prospects with a positive / soft-yes reply
  booked: number;
  replyRate: number;   // replied / contacted (%)
  positiveRate: number;// positive / contacted (%)
  lift: number;        // positiveRate vs workspace baseline (pct points)
  confident: boolean;  // enough volume + significant vs baseline
}

export interface ChannelStat {
  channel: Channel;
  contacted: number;
  sent: number;
  replied: number;
  positive: number;
  replyRate: number;
  positiveRate: number;
}

export interface TouchStat {
  touch: string;
  channel: string;
  sent: number;
  replies: number;
  replyRate: number;
}

export interface DeliverabilityStat {
  domains: Array<{
    domain: string;
    delivered: number;
    opened: number;
    bounced: number;
    complained: number;
    openRate: number;
    bounceRate: number;
    spamRate: number;
    status: "green" | "yellow" | "red";
  }>;
  openRate: number;
  bounceRate: number;
  spamRate: number;
  status: "green" | "yellow" | "red";
}

export interface Recommendation {
  kind: "variant" | "segment" | "channel" | "send_hour" | "underperformer";
  title: string;
  detail: string;
  metric: string;
  confident: boolean;
  /** Payload the promote-winners action consumes. */
  apply?: { winningVariant?: string; winningSegments?: string[]; bestSendHour?: number; channelEmphasis?: Channel[] };
}

export interface OutreachStats {
  scope: { motion: Motion; campaignId?: string; ownerId?: string; sinceDays: number | null };
  generatedAt: string;
  totals: {
    prospectsContacted: number;
    touchesSent: number;
    replied: number;
    positive: number;
    booked: number;
    won: number;
    replyRate: number;
    positiveRate: number;
    bookRate: number;
    medianHoursToReply: number | null;
  };
  funnel: Array<{ label: string; value: number; pct: number }>;
  byChannel: ChannelStat[];
  byVariant: DimStat[];
  bySegment: DimStat[];
  byIndustry: DimStat[];
  byFunction: DimStat[];
  byTouch: TouchStat[];
  byOwner: DimStat[];
  byCampaign: DimStat[];
  bySendHour: Array<{ hour: number; sent: number; replies: number; replyRate: number }>;
  replyQuality: Array<{ class: string; count: number; pct: number }>;
  trend: Array<{ date: string; sent: number; replies: number }>;
  deliverability: DeliverabilityStat | null;
  bdExperiment: ReturnType<typeof bdReport> | null;
  recommendations: Recommendation[];
  /** Honesty signals so the UI never over-states what the data supports. */
  meta: {
    /** Timezone the send-hour buckets are in (server local). */
    sendHourTimezone: string;
    /** Deliverability metrics are per-domain lifetime, not windowed. */
    deliverabilityWindow: string;
    /** True when total volume is too low for the rates to be trustworthy. */
    lowVolume: boolean;
    /** Min prospects per group before a "winner" can be flagged significant. */
    minForConfidence: number;
  };
}

/* ----------------------------- industry infer --------------------------- */

const INDUSTRY_INFER: Array<[string, RegExp]> = [
  ["healthcare", /\b(health|medical|clinical|patient|biotech|pharma|hospital|care)\b/i],
  ["fintech", /\b(fintech|payments?|banking|lending|trading|crypto|insurance|insurtech|wealth)\b/i],
  ["cybersecurity", /\b(security|cyber|infosec|threat|identity|appsec)\b/i],
  ["ai_ml", /\b(\bai\b|artificial intelligence|machine learning|\bml\b|llm|generative)\b/i],
  ["ecommerce", /\b(ecommerce|e-commerce|retail|marketplace|d2c|consumer goods|shopify)\b/i],
  ["edtech", /\b(edtech|education|learning|tutoring|university|school)\b/i],
  ["logistics", /\b(logistics|supply chain|freight|delivery|fleet|warehouse|shipping)\b/i],
  ["gaming", /\b(gaming|games|esports)\b/i],
  ["climate", /\b(climate|clean ?tech|energy|solar|sustainab|carbon|renewable)\b/i],
  ["saas", /\b(saas|b2b software|platform|api|developer tools|cloud|software)\b/i],
];
function inferIndustry(text: string): string {
  for (const [k, re] of INDUSTRY_INFER) if (re.test(text)) return k;
  return "general";
}

/* ------------------------------- stats math ----------------------------- */

const POSITIVE_CLASSES = new Set(["positive", "soft_yes"]);
/** Statuses only reachable via an inbound reply (any sentiment) — so they count
 *  as "replied" even when the original ProcessedResponse predates the window. */
const REPLY_STATUSES = new Set(["replied", "booked", "won", "nurture", "closed_lost", "do_not_contact"]);
/** Statuses that imply a positive outcome. */
const POSITIVE_STATUSES = new Set(["booked", "won"]);

const MIN_REC = 10;    // min prospects for a group to be a recommendation candidate
const MIN_CONF = 15;   // min prospects (and min in the rest) before significance is tested
const Z_CONF = 1.645;  // one-sided p < 0.05

function pct(n: number, d: number): number {
  return d ? Number(((n / d) * 100).toFixed(1)) : 0;
}

/**
 * Two-proportion z-test of a group vs the REST of the population. Testing against
 * the whole population (group included) biases toward null and lets big groups
 * never reach significance, so we always compare group vs everyone-else. Flags
 * only genuine OUT-performance, with enough volume on both sides, at p < 0.05.
 */
function significant(succ: number, n: number, restSucc: number, restN: number): boolean {
  if (n < MIN_CONF || restN < MIN_CONF) return false;
  const p1 = succ / n, p2 = restSucc / restN;
  if (p1 <= p2) return false;
  const pPool = (succ + restSucc) / (n + restN);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n + 1 / restN));
  if (!se) return false;
  return (p1 - p2) / se > Z_CONF;
}

/* ------------------------------- the rollup ----------------------------- */

interface PR {
  p: Prospect;
  sends: ActivityEvent[];
  variant: string;
  industry: string;
  fn: string;
  seniority: string;
  firstSendMs?: number;
  replied: boolean;
  positive: boolean;
  booked: boolean;
  won: boolean;
  firstReplyMs?: number;
}

export async function buildOutreachStats(workspaceId: string, opts: OutreachStatsOpts = {}): Promise<OutreachStats> {
  const motion: Motion = opts.motion === "bd" ? "bd" : "recruiting";
  const sinceDays = opts.sinceDays == null ? null : Number(opts.sinceDays);
  const sinceMs = sinceDays ? Date.now() - sinceDays * 86_400_000 : 0;
  const inWindow = (iso?: string) => !iso || !sinceMs || Date.parse(iso) >= sinceMs;

  const core = getCore();
  const prospects = (await core.listProspects(workspaceId)).filter((p) => {
    if ((p.motion ?? "recruiting") !== motion) return false;
    if (opts.campaignId && p.campaignId !== opts.campaignId) return false;
    if (opts.ownerId && p.ownerId !== opts.ownerId) return false;
    return true;
  });
  const pById = new Map(prospects.map((p) => [p.id, p]));
  const activity = await core.listAllActivity(workspaceId);
  const responses = (await recentResponses(workspaceId, 5000)).filter(
    (r) => r.inbound.prospectId && pById.has(r.inbound.prospectId) && inWindow(r.inbound.receivedAt),
  );

  // Responses grouped by prospect.
  const respByProspect = new Map<string, typeof responses>();
  for (const r of responses) {
    const id = r.inbound.prospectId as string;
    (respByProspect.get(id) ?? respByProspect.set(id, []).get(id)!).push(r);
  }

  // Per-prospect rollup over send events in scope.
  const rows: PR[] = [];
  const sendEvents: ActivityEvent[] = [];
  for (const p of prospects) {
    const sends = activity.filter(
      (e) => e.prospectId === p.id && e.type.endsWith("_sent") && inWindow(e.at) && (!opts.channel || e.channel === opts.channel),
    );
    if (!sends.length) continue; // contacted prospects only
    sendEvents.push(...sends);
    const idText = `${p.company ?? ""} ${p.headline ?? ""} ${p.title ?? ""}`;
    const intel = classifyTitle(p.title || p.headline || "");
    const industry = inferIndustry(idText);
    const variant = sends.find((s) => s.variant)?.variant || `${industry}/${intel.function}/${intel.seniority}`;
    const firstSendMs = Math.min(...sends.map((s) => Date.parse(s.at)));
    const myResp = respByProspect.get(p.id) ?? [];
    const hasPositive = myResp.some((r) => POSITIVE_CLASSES.has(r.classification.class));
    const status = p.status;
    // A booking/win only belongs to THIS window when we know it happened in it.
    const bookedInWindow = POSITIVE_STATUSES.has(status) && inWindow(p.bookedAt);
    const replied = myResp.length > 0 || REPLY_STATUSES.has(status);
    const positive = hasPositive || bookedInWindow;
    const booked = bookedInWindow;
    const firstReplyMs = myResp.length ? Math.min(...myResp.map((r) => Date.parse(r.inbound.receivedAt))) : undefined;
    rows.push({ p, sends, variant, industry, fn: intel.function, seniority: intel.seniority, firstSendMs, replied, positive, booked, won: status === "won", firstReplyMs });
  }

  // Totals.
  const contacted = rows.length;
  const totalReplied = rows.filter((r) => r.replied).length;
  const totalPositive = rows.filter((r) => r.positive).length;
  const totalBooked = rows.filter((r) => r.booked).length;
  const totalWon = rows.filter((r) => r.won).length;
  const replyDeltas = rows
    .filter((r) => r.firstReplyMs && r.firstSendMs && r.firstReplyMs >= r.firstSendMs)
    .map((r) => (r.firstReplyMs! - r.firstSendMs!) / 3_600_000)
    .sort((a, b) => a - b);
  const medianHoursToReply = replyDeltas.length ? Number(replyDeltas[Math.floor(replyDeltas.length / 2)].toFixed(1)) : null;

  // Generic dimension aggregator (prospect-level).
  const baselinePos = totalPositive;
  const baselineN = contacted;
  function dim(keyFn: (r: PR) => string | undefined, labelFn: (k: string) => string): DimStat[] {
    const g = new Map<string, PR[]>();
    for (const r of rows) {
      const k = keyFn(r);
      if (!k) continue;
      (g.get(k) ?? g.set(k, []).get(k)!).push(r);
    }
    const out: DimStat[] = [];
    for (const [k, prs] of g) {
      const cont = prs.length;
      const replied = prs.filter((r) => r.replied).length;
      const positive = prs.filter((r) => r.positive).length;
      const booked = prs.filter((r) => r.booked).length;
      const sent = prs.reduce((s, r) => s + r.sends.length, 0);
      out.push({
        key: k, label: labelFn(k), contacted: cont, sent, replied, positive, booked,
        replyRate: pct(replied, cont), positiveRate: pct(positive, cont),
        lift: Number((pct(positive, cont) - pct(baselinePos, baselineN)).toFixed(1)),
        // Significance is group vs the REST (baseline minus this group).
        confident: significant(positive, cont, baselinePos - positive, baselineN - cont),
      });
    }
    return out.sort((a, b) => b.positiveRate - a.positiveRate || b.contacted - a.contacted);
  }

  const titleCase = (s: string) => s.replace(/(^|[_/])([a-z])/g, (_m, sep, c) => (sep === "_" ? " " : sep) + c.toUpperCase());

  // By channel (event + response.channel attributed).
  const channels: Channel[] = ["email", "linkedin", "voice", "sms"];
  const byChannel: ChannelStat[] = channels.map((ch) => {
    const prsOn = rows.filter((r) => r.sends.some((s) => s.channel === ch));
    const sent = sendEvents.filter((e) => e.channel === ch).length;
    const repliesOn = responses.filter((r) => r.inbound.channel === ch);
    const repliedProspects = new Set(repliesOn.map((r) => r.inbound.prospectId)).size;
    const positiveProspects = new Set(repliesOn.filter((r) => POSITIVE_CLASSES.has(r.classification.class)).map((r) => r.inbound.prospectId)).size;
    return {
      channel: ch, contacted: prsOn.length, sent, replied: repliedProspects, positive: positiveProspects,
      replyRate: pct(repliedProspects, prsOn.length), positiveRate: pct(positiveProspects, prsOn.length),
    };
  }).filter((c) => c.sent > 0 || c.contacted > 0);

  // By touch (event-level; reply attributed to the last send before the reply).
  const touchAgg = new Map<string, { channel: string; sent: number; replies: number }>();
  for (const e of sendEvents) {
    const key = `${e.touch || "Untitled"}|${e.channel}`;
    const t = touchAgg.get(key) ?? touchAgg.set(key, { channel: e.channel, sent: 0, replies: 0 }).get(key)!;
    t.sent++;
  }
  for (const r of rows) {
    if (!r.firstReplyMs) continue;
    const before = r.sends.filter((s) => Date.parse(s.at) <= r.firstReplyMs!).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] || r.sends[0];
    const key = `${before.touch || "Untitled"}|${before.channel}`;
    const t = touchAgg.get(key);
    if (t) t.replies++;
  }
  const byTouch: TouchStat[] = [...touchAgg.entries()].map(([key, v]) => ({
    touch: key.split("|")[0], channel: v.channel, sent: v.sent, replies: v.replies, replyRate: pct(v.replies, v.sent),
  })).sort((a, b) => b.replyRate - a.replyRate || b.sent - a.sent);

  // By send-hour.
  const hourAgg = Array.from({ length: 24 }, (_h, hour) => ({ hour, sent: 0, replies: 0 }));
  for (const e of sendEvents) hourAgg[new Date(e.at).getHours()].sent++;
  for (const r of rows) {
    if (!r.firstReplyMs) continue;
    const before = r.sends.filter((s) => Date.parse(s.at) <= r.firstReplyMs!).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] || r.sends[0];
    hourAgg[new Date(before.at).getHours()].replies++;
  }
  const bySendHour = hourAgg.map((h) => ({ ...h, replyRate: pct(h.replies, h.sent) }));

  // Reply quality mix.
  const qual = new Map<string, number>();
  for (const r of responses) qual.set(r.classification.class, (qual.get(r.classification.class) ?? 0) + 1);
  const qualTotal = responses.length;
  const replyQuality = [...qual.entries()]
    .map(([cls, count]) => ({ class: cls, count, pct: pct(count, qualTotal) }))
    .sort((a, b) => b.count - a.count);

  // Daily trend (last N days, capped at 30).
  const days = Math.min(sinceDays || 30, 30);
  const trend: Array<{ date: string; sent: number; replies: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    trend.push({
      date: d,
      sent: sendEvents.filter((e) => e.at.slice(0, 10) === d).length,
      replies: responses.filter((r) => r.inbound.receivedAt.slice(0, 10) === d).length,
    });
  }

  // Deliverability (email, workspace-wide — Postal domain metrics).
  let deliverability: DeliverabilityStat | null = null;
  try {
    const { listDomains } = await import("../sending/store");
    const domains = await listDomains(workspaceId);
    if (domains.length) {
      let D = 0, O = 0, B = 0, C = 0, S = 0;
      const rows2 = domains.map((d) => {
        const m = d.metrics ?? { sent: 0, delivered: 0, opened: 0, bounced: 0, complained: 0, since: "" };
        D += m.delivered; O += m.opened; B += m.bounced; C += m.complained; S += m.sent;
        const openRate = pct(m.opened, m.delivered);
        const bounceRate = pct(m.bounced, m.sent || m.delivered);
        const spamRate = pct(m.complained, m.delivered);
        const status: "green" | "yellow" | "red" = bounceRate > 5 || spamRate > 0.3 ? "red" : bounceRate > 2 || spamRate > 0.1 ? "yellow" : "green";
        return { domain: d.domain, delivered: m.delivered, opened: m.opened, bounced: m.bounced, complained: m.complained, openRate, bounceRate, spamRate, status };
      });
      const bounceRate = pct(B, S || D);
      const spamRate = pct(C, D);
      deliverability = {
        domains: rows2.sort((a, b) => b.delivered - a.delivered),
        openRate: pct(O, D), bounceRate, spamRate,
        status: bounceRate > 5 || spamRate > 0.3 ? "red" : bounceRate > 2 || spamRate > 0.1 ? "yellow" : "green",
      };
    }
  } catch { /* sending module not available — deliverability stays null */ }

  // Resolve human labels for owners + campaigns (raw ids are meaningless in the UI).
  const memberName = new Map(listMembers(workspaceId).map((m) => [m.userId, m.name]));
  const campaignName = new Map((await core.listCampaigns(workspaceId)).map((c) => [c.id, c.name]));

  // Breakdowns.
  const byVariant = dim((r) => r.variant, titleCase);
  const bySegment = dim((r) => `${r.industry}/${r.fn}/${r.seniority}`, titleCase);
  const byIndustry = dim((r) => r.industry, titleCase);
  const byFunction = dim((r) => r.fn, titleCase);
  const byOwner = dim((r) => r.p.ownerId, (k) => memberName.get(k) || "Recruiter " + k.slice(0, 6));
  const byCampaign = dim((r) => r.p.campaignId, (k) => campaignName.get(k) || k);

  // Recommendations (the promote-winners candidates).
  const recommendations: Recommendation[] = [];
  const topVariant = byVariant.find((v) => v.contacted >= MIN_REC);
  if (topVariant) {
    recommendations.push({
      kind: "variant", title: `Best message: ${topVariant.label}`,
      detail: `${topVariant.positiveRate}% positive on ${topVariant.contacted} contacted (${topVariant.lift >= 0 ? "+" : ""}${topVariant.lift} pts vs avg).`,
      metric: `${topVariant.positiveRate}% positive`, confident: topVariant.confident,
      apply: { winningVariant: topVariant.key },
    });
  }
  const topSegs = bySegment.filter((s) => s.contacted >= MIN_REC).slice(0, 3);
  if (topSegs.length) {
    recommendations.push({
      kind: "segment", title: `Top segments responding`,
      detail: topSegs.map((s) => `${s.label} (${s.positiveRate}%)`).join(", "),
      metric: `${topSegs[0].positiveRate}% positive`, confident: topSegs[0].confident,
      apply: { winningSegments: topSegs.map((s) => s.key) },
    });
  }
  const topChannel = [...byChannel].filter((c) => c.contacted >= MIN_REC).sort((a, b) => b.positiveRate - a.positiveRate)[0];
  if (topChannel) {
    const order = [...byChannel].sort((a, b) => b.positiveRate - a.positiveRate).map((c) => c.channel);
    recommendations.push({
      kind: "channel", title: `Best channel: ${titleCase(topChannel.channel)}`,
      detail: `${topChannel.positiveRate}% positive vs ${topChannel.replyRate}% reply on ${topChannel.contacted} contacted.`,
      metric: `${topChannel.positiveRate}% positive`, confident: topChannel.contacted >= 20,
      apply: { channelEmphasis: order },
    });
  }
  const bestHour = [...bySendHour].filter((h) => h.sent >= MIN_REC).sort((a, b) => b.replyRate - a.replyRate)[0];
  if (bestHour) {
    recommendations.push({
      kind: "send_hour", title: `Best send time: ${String(bestHour.hour).padStart(2, "0")}:00`,
      detail: `${bestHour.replyRate}% reply rate on ${bestHour.sent} sends in that hour.`,
      metric: `${bestHour.replyRate}% reply`, confident: bestHour.sent >= 20,
      apply: { bestSendHour: bestHour.hour },
    });
  }
  const worst = byVariant.filter((v) => v.contacted >= MIN_REC).slice(-1)[0];
  if (worst && byVariant.length > 2 && worst.key !== topVariant?.key && worst.positiveRate < (topVariant?.positiveRate ?? 0) / 2) {
    recommendations.push({
      kind: "underperformer", title: `Underperformer: ${worst.label}`,
      detail: `${worst.positiveRate}% positive on ${worst.contacted} contacted — consider pausing or rewriting.`,
      metric: `${worst.positiveRate}% positive`, confident: worst.contacted >= 20,
    });
  }

  let bdExperiment: ReturnType<typeof bdReport> | null = null;
  try { if (motion === "bd") bdExperiment = bdReport(); } catch { /* optional */ }

  return {
    scope: { motion, campaignId: opts.campaignId, ownerId: opts.ownerId, sinceDays },
    generatedAt: new Date().toISOString(),
    totals: {
      prospectsContacted: contacted, touchesSent: sendEvents.length, replied: totalReplied,
      positive: totalPositive, booked: totalBooked, won: totalWon,
      replyRate: pct(totalReplied, contacted), positiveRate: pct(totalPositive, contacted),
      bookRate: pct(totalBooked, contacted), medianHoursToReply,
    },
    funnel: [
      { label: "Contacted", value: contacted, pct: 100 },
      { label: "Replied", value: totalReplied, pct: pct(totalReplied, contacted) },
      { label: "Positive", value: totalPositive, pct: pct(totalPositive, contacted) },
      { label: "Booked", value: totalBooked, pct: pct(totalBooked, contacted) },
      { label: "Won", value: totalWon, pct: pct(totalWon, contacted) },
    ],
    byChannel, byVariant, bySegment, byIndustry, byFunction, byTouch, byOwner, byCampaign,
    bySendHour, replyQuality, trend, deliverability, bdExperiment, recommendations,
    meta: {
      sendHourTimezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "server local"; } catch { return "server local"; } })(),
      deliverabilityWindow: "all-time (per sending domain)",
      lowVolume: contacted < MIN_CONF,
      minForConfidence: MIN_CONF,
    },
  };
}
