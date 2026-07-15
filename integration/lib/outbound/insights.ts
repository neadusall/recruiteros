/**
 * RecruitersOS · Outbound Performance · AI analysis
 *
 * The numbers are computed FIRST (capacity engine, rollups, score); the LLM
 * only narrates them. Prompts forbid invention: every figure in the output
 * must appear in the supplied facts. Without an Anthropic key the same facts
 * render through deterministic templates, so the feature degrades to
 * "specific but unstyled", never to "broken" or "generic coaching".
 *
 * Cached per day (snapshot `outbound_ai_v1`) so the LLM runs once per
 * user/day, not per page load. `refresh` forces a rebuild.
 */

import { loadSnapshot, debouncedSaver } from "../db";
import { nowIso } from "../core/ids";
import { listMembers } from "../auth/team";
import { userCapacity } from "./capacity";
import { getDay, listRollups, sumCounts, workspaceTz } from "./rollup";
import { computeScore } from "./score";
import { localDay } from "./goals";
import type { UserCapacity } from "./types";

const KEY = "outbound_ai_v1";
interface AiState { entries: Record<string, { day: string; text: string; actions: string[]; at: string }>; }
let state: AiState = { entries: {} };
let hydrated = false;
let hydrating: Promise<void> | null = null;
const save = debouncedSaver(KEY, () => state);

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<AiState>(KEY);
      if (snap && snap.entries) state = snap;
      hydrated = true;
    })();
  }
  return hydrating;
}

function model(): string {
  return process.env.RECRUITEROS_OUTBOUND_MODEL || process.env.RECRUITEROS_LLM_MODEL || "claude-sonnet-4-6";
}

async function narrate(system: string, facts: string, maxTokens = 500): Promise<string | null> {
  try {
    const { anthropicClient } = await import("../sourcing/anthropic");
    const client = anthropicClient();
    const res = await client.messages.create({
      model: model(),
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: facts }],
    });
    const text = res.content
      .map((b: { type: string; text?: string }) => (b.type === "text" ? b.text ?? "" : ""))
      .join("")
      .trim();
    return text || null;
  } catch { return null; }
}

/* --------------------------- per-user assessment ------------------------- */

function userFacts(name: string, cap: UserCapacity, counts: Record<string, number>, scoreTotal: number): string {
  const ch = (k: "email" | "linkedin" | "sms" | "followUp" | "content") => {
    const u = cap[k];
    return `${u.label}: used ${u.used}, target ${u.target}, capacity ${u.capacity}, state ${u.state}`;
  };
  return [
    `User: ${name}`,
    `Overall capacity utilization today: ${cap.overallPct}%`,
    `Outbound score: ${scoreTotal}/100`,
    ch("email"), ch("linkedin"), ch("sms"), ch("followUp"), ch("content"),
    `Conversations waiting on a reply: ${cap.response.remaining}`,
    `Campaign supply: ${cap.supply.detail}${cap.supply.constrained ? " (SUPPLY CONSTRAINED: capacity exceeds ready contacts)" : ""}`,
    `System factors: ${cap.systemFactors.map((f) => f.reason).join("; ") || "none"}`,
    `Today so far: ${counts.repliesReceived ?? 0} replies, ${counts.positiveReplies ?? 0} positive, ${counts.meetingsBooked ?? 0} meetings.`,
    `Recommended actions already computed: ${[cap.email, cap.linkedin, cap.sms, cap.followUp, cap.content, cap.response].map((u) => u.recommendedAction).filter(Boolean).join(" | ") || "none"}`,
  ].join("\n");
}

const USER_SYSTEM = [
  "You are the outbound performance manager inside RecruitersOS.",
  "Write a 2-4 sentence factual assessment of this user's outbound day using ONLY the numbers provided. Never invent a number. Never use generic coaching language.",
  "If a supply constraint or system factor exists, name it as the cause instead of blaming the user.",
  "Do not use em-dashes anywhere in the output. Use plain sentences.",
].join(" ");

export async function userAssessment(
  workspaceId: string, userId: string, opts: { refresh?: boolean; authRole?: string } = {},
): Promise<{ text: string; actions: string[]; day: string; generatedAt: string }> {
  await hydrate();
  const tz = await workspaceTz(workspaceId);
  const day = localDay(tz);
  const k = `${workspaceId}|u|${userId}`;
  const cached = state.entries[k];
  if (cached && cached.day === day && !opts.refresh) {
    return { text: cached.text, actions: cached.actions, day, generatedAt: cached.at };
  }

  const member = listMembers(workspaceId).find((m) => m.userId === userId);
  const name = member?.name || "This user";
  const cap = await userCapacity(workspaceId, userId, opts.authRole ?? member?.role ?? "member");
  const today = await getDay(workspaceId, userId, day);
  const score = computeScore(cap, { positiveReplies: today.counts.positiveReplies, meetingsBooked: today.counts.meetingsBooked });

  const actions = [cap.response, cap.followUp, cap.email, cap.linkedin, cap.sms, cap.content]
    .map((u) => u.recommendedAction)
    .filter((a): a is string => !!a)
    .slice(0, 5);

  const facts = userFacts(name, cap, today.counts as unknown as Record<string, number>, score.total);
  const llm = await narrate(USER_SYSTEM, facts);
  const fallback = [
    `${name} has used ${cap.overallPct}% of available outbound capacity today (score ${score.total}/100).`,
    `Email is at ${cap.email.targetPct}% of target, LinkedIn at ${cap.linkedin.targetPct}%` +
      (cap.sms.state !== "not_enabled" ? `, SMS at ${cap.sms.targetPct}%` : "") + ".",
    cap.supply.constrained ? "Unused capacity is caused by insufficient campaign supply, not user effort." : "",
    cap.response.remaining > 0 ? `${cap.response.remaining} conversations are waiting on a reply.` : "",
  ].filter(Boolean).join(" ");

  const text = llm || fallback;
  state.entries[k] = { day, text, actions, at: nowIso() };
  save();
  return { text, actions, day, generatedAt: state.entries[k].at };
}

/* ----------------------------- admin insights ---------------------------- */

const ADMIN_SYSTEM = [
  "You are an Operations Director analyzing an outbound recruiting and BD organization inside RecruitersOS.",
  "Using ONLY the facts provided, write: (1) a short 'requires attention' list naming users and their specific numbers, (2) one team opportunity paragraph quantifying unused capacity, (3) one recommended admin action.",
  "Distinguish user effort problems from supply/system problems explicitly. Never invent numbers. No generic advice.",
  "Do not use em-dashes anywhere in the output. Plain sentences and short lines only.",
].join(" ");

export interface AdminInsights {
  text: string;
  attention: Array<{ userId: string; name: string; line: string }>;
  unused: { total: number; email: number; linkedin: number; sms: number };
  day: string;
  generatedAt: string;
}

export async function adminInsights(workspaceId: string, opts: { refresh?: boolean } = {}): Promise<AdminInsights> {
  await hydrate();
  const tz = await workspaceTz(workspaceId);
  const day = localDay(tz);
  const k = `${workspaceId}|admin`;
  const cached = state.entries[k];

  const members = listMembers(workspaceId);
  const attention: AdminInsights["attention"] = [];
  const unused = { total: 0, email: 0, linkedin: 0, sms: 0 };
  const factLines: string[] = [];

  // Unused capacity over the trailing 5 working days: today's targets are the
  // best available estimate of each day's expected volume.
  const d5 = localDay(tz, new Date(Date.now() - 5 * 86_400_000));
  for (const m of members) {
    let cap;
    try { cap = await userCapacity(workspaceId, m.userId, m.role); } catch { continue; }
    const name = m.name || m.email;
    const rows = await listRollups(workspaceId, { userId: m.userId, sinceDay: d5 });
    const sums = sumCounts(rows);
    const emailsSent = sums.bdEmailsSent + sums.recruitingEmailsSent;
    const liSent = sums.liConnectionsSent + sums.liMessagesSent + sums.liVoiceNotes + sums.liInMails;
    const daysCounted = Math.max(1, new Set(rows.map((r) => r.day)).size || 5);
    const eUnused = Math.max(0, cap.email.target * daysCounted - emailsSent);
    const lUnused = Math.max(0, cap.linkedin.target * daysCounted - liSent);
    const sUnused = cap.sms.state !== "not_enabled" ? Math.max(0, cap.sms.target * daysCounted - sums.smsSent) : 0;
    unused.email += eUnused; unused.linkedin += lUnused; unused.sms += sUnused;

    if (cap.supply.constrained) {
      attention.push({ userId: m.userId, name, line: `${name} has unused capacity caused by insufficient campaign supply (${cap.supply.contactsReady} contacts ready).` });
    } else if (cap.overallPct < 45 && (cap.email.target + cap.linkedin.target) > 0) {
      attention.push({ userId: m.userId, name, line: `${name} is at ${cap.overallPct}% of available outbound capacity today (email ${cap.email.targetPct}%, LinkedIn ${cap.linkedin.targetPct}%).` });
    }
    if (cap.response.remaining >= 5) {
      attention.push({ userId: m.userId, name, line: `${name} has ${cap.response.remaining} conversations waiting on a reply.` });
    }
    factLines.push(`${name}: overall ${cap.overallPct}%, email ${cap.email.used}/${cap.email.target}, linkedin ${cap.linkedin.used}/${cap.linkedin.target}, sms ${cap.sms.used}/${cap.sms.target} (${cap.sms.state}), waiting replies ${cap.response.remaining}, supply ${cap.supply.contactsReady} ready${cap.supply.constrained ? " SUPPLY-CONSTRAINED" : ""}, system: ${cap.systemFactors.map((f) => f.reason).join("; ") || "none"}`);
  }
  unused.total = unused.email + unused.linkedin + unused.sms;

  if (cached && cached.day === day && !opts.refresh) {
    return { text: cached.text, attention, unused, day, generatedAt: cached.at };
  }

  const facts = [
    `Team of ${members.length}. Trailing-5-working-day unused safe outbound actions: total ${unused.total} (email ${unused.email}, linkedin ${unused.linkedin}, sms ${unused.sms}).`,
    ...factLines,
  ].join("\n");
  const llm = await narrate(ADMIN_SYSTEM, facts, 700);
  const fallback = [
    attention.length ? `${attention.length} item${attention.length === 1 ? " requires" : "s require"} attention:\n${attention.map((a) => "- " + a.line).join("\n")}` : "No users currently require attention.",
    unused.total > 0 ? `\nTeam opportunity: an estimated ${unused.total.toLocaleString("en-US")} safe outbound actions went unused over the last 5 working days (email ${unused.email.toLocaleString("en-US")}, LinkedIn ${unused.linkedin.toLocaleString("en-US")}, SMS ${unused.sms.toLocaleString("en-US")}).` : "",
  ].filter(Boolean).join("\n");

  const text = llm || fallback;
  state.entries[k] = { day, text, actions: [], at: nowIso() };
  save();
  return { text, attention, unused, day, generatedAt: state.entries[k].at };
}
