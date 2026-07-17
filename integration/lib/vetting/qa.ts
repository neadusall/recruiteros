/**
 * RecruitersOS · AI Vetting · Question intelligence (self-learning candidate Q&A)
 *
 * The loop no competitor ships: every candidate question on every call is
 * harvested from the transcript, rolled up into per-desk topic clusters, and
 * the ones the agent had to DEFER become a learning queue:
 *
 *   harvest  -> one LLM pass per scored call extracts the candidate's questions
 *               (topic + phrasing + whether the agent answered or deferred)
 *   draft    -> gaps get an answer drafted ONLY from the JD + existing desk
 *               facts; anything the JD can't support is left for the recruiter
 *               (grounding is absolute, same liability rule as knowledge.ts)
 *   teach    -> an approved answer becomes a desk FAQ fact, the live assistant
 *               is re-provisioned, and the NEXT caller gets the real answer
 *   text back-> the candidates who asked get the answer texted from the desk's
 *               own number (the agent promised "you'll get the real answer";
 *               this keeps that promise, automatically)
 *
 * maybeLearnQuestions() is the fire-and-forget post-call hook (webhook/route.ts),
 * the same contract as optimizer.maybeAutoLearn: never throws, never blocks the
 * engine. With auto-teach ON, a grounded draft closes the whole loop hands-free.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { VettingDesk, VettingCall, CallQuestion, QACluster, TranscriptTurn } from "./types";
import { normalizeKnowledge, KNOWLEDGE_CAP } from "./types";
import {
  getDeskById, getCandidateById, listCalls, updateCall,
  deskQA, recordCallQuestions, setQADraft, approveQACluster, markQAAnswerTexted,
} from "./store";
import { provisionDesk } from "./assistant";
import { telnyx } from "../providers";
import { withWorkspaceCreds } from "../connected";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.RECRUITEROS_VETTING_MODEL ?? process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";

/** Answers are only texted back to candidates who asked this recently. */
const TEXT_BACK_WINDOW_DAYS = 30;
/** Hard cap on answer texts per approval (protects against a runaway cluster). */
const TEXT_BACK_MAX = 25;

function stripEmDash(s: string): string {
  return s.replace(/\s*—\s*/g, ", ").replace(/\s*–\s*/g, ", ");
}

/* ---------------- harvest: transcript -> the candidate's questions ---------------- */

const HARVEST_SYSTEM = `You review the transcript of a recruiter phone screen and extract every question the CANDIDATE asked about the role, company, pay, benefits, process, logistics, or working conditions.

Rules:
- Only the CANDIDATE's questions. Ignore the agent's questions.
- Ignore pure small talk ("how are you?"), turn-taking noises ("right?", "you know?"), and requests to repeat ("sorry, what was that?").
- Combine a re-asked question into ONE entry.
- "question": the question as asked, lightly cleaned, under 200 characters.
- "topic": a SHORT canonical label (2-4 words, lowercase) for what it's about, e.g. "401k match", "remote policy", "team size", "interview process", "start date". If the list of known topics contains the same subject, reuse that topic string EXACTLY (even if worded differently). Only invent a new topic for a genuinely new subject.
- "outcome": how the AGENT handled it:
    "answered" = gave a direct, substantive answer
    "partial"  = answered but hedged, was vague, or gave only part of it
    "deferred" = did not know and flagged it for the recruiter (or dodged it)
- "answerGiven": what the agent actually said back, one line under 200 characters ("" if it gave nothing).

Never use the em-dash character anywhere. Return STRICT JSON only, an array (possibly empty), no prose, no fences:
[ { "question": string, "topic": string, "outcome": "answered"|"partial"|"deferred", "answerGiven": string } ]`;

function transcriptBlock(turns: TranscriptTurn[]): string {
  return turns
    .slice(0, 80)
    .map((t) => `${t.role === "agent" ? "AGENT" : "CANDIDATE"}: ${t.text.slice(0, 400)}`)
    .join("\n");
}

/** Extract the candidate's questions from one call's transcript. */
export async function harvestCallQuestions(desk: VettingDesk, call: VettingCall): Promise<CallQuestion[]> {
  if (!process.env.ANTHROPIC_API_KEY || call.transcript.length < 2) return [];

  const knownTopics = Array.from(new Set([
    ...deskQA(desk).clusters.filter((c) => c.status !== "dismissed").map((c) => c.topic),
    ...normalizeKnowledge(desk.knowledge).map((k) => k.question),
  ])).slice(0, 60);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1200,
    temperature: 0,
    system: [{ type: "text", text: HARVEST_SYSTEM, cache_control: { type: "ephemeral" } }] as any,
    messages: [{
      role: "user",
      content:
        `Role being screened: ${desk.roleTitle || "(unset)"}\n\n` +
        `Known topics on this desk (reuse these labels when the subject matches):\n` +
        (knownTopics.length ? knownTopics.map((t) => `- ${t}`).join("\n") : "(none yet)") +
        `\n\nTranscript:\n${transcriptBlock(call.transcript)}\n\nReturn the JSON array.`,
    }],
  });

  const block = response.content.find((b) => b.type === "text");
  const raw = block && block.type === "text" ? block.text : "[]";
  let arr: any = [];
  try {
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    arr = JSON.parse(raw.slice(start, end + 1));
  } catch { arr = []; }
  if (!Array.isArray(arr)) return [];

  return arr
    .filter((q: any) => q && typeof q.question === "string" && q.question.trim() && typeof q.topic === "string" && q.topic.trim())
    .slice(0, 12)
    .map((q: any): CallQuestion => ({
      question: stripEmDash(String(q.question).trim()).slice(0, 200),
      topic: stripEmDash(String(q.topic).trim().toLowerCase()).slice(0, 80),
      outcome: (["answered", "partial", "deferred"] as const).includes(q.outcome) ? q.outcome : "deferred",
      answerGiven: q.answerGiven ? stripEmDash(String(q.answerGiven).trim()).slice(0, 200) : undefined,
    }));
}

/* ---------------- draft: gaps -> grounded answers (or an honest "can't") ---------------- */

const DRAFT_SYSTEM = `You are an executive recruiter writing phone-ready answers for an AI screening agent. You get a job description, the facts the agent already knows, and a list of question topics candidates asked that the agent could NOT answer.

For each topic, decide whether the job description (or the existing facts) genuinely contains the answer:
- If YES: write the answer the way a recruiter would SAY it on the phone: short, plain, first person, speakable, leading with the direct answer, keeping the JD's exact specifics (ranges, days, counts). Set "grounded": true.
- If NO: set "grounded": false and "answer": "". NEVER estimate, never generalize from the industry, never fill the gap with something plausible. An invented benefit or comp number on a recorded call is a real liability.

Never use the em-dash character anywhere. Return STRICT JSON only, an array with one object per topic, in the same order, no prose, no fences:
[ { "topic": string, "answer": string, "grounded": boolean } ]`;

/**
 * Draft answers for the desk's open gaps (deferred or unanswered clusters with
 * no draft yet). Grounded drafts are written; ungroundable ones are marked so
 * the UI asks the recruiter for the real answer. Returns the clusters touched.
 */
export async function draftGapAnswers(desk: VettingDesk, only?: string[]): Promise<QACluster[]> {
  if (!process.env.ANTHROPIC_API_KEY) return [];
  const qa = deskQA(desk);
  const pending = qa.clusters.filter((c) =>
    c.status === "open" &&
    (only ? only.includes(c.id) : c.draftAnswer === undefined) &&
    (c.deferredCount > 0 || c.answeredCount === 0),
  ).slice(0, 10);
  if (!pending.length) return [];

  const facts = normalizeKnowledge(desk.knowledge)
    .map((k) => `- ${k.question}: ${k.answer}`)
    .join("\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1400,
    temperature: 0,
    system: [{ type: "text", text: DRAFT_SYSTEM, cache_control: { type: "ephemeral" } }] as any,
    messages: [{
      role: "user",
      content:
        `Role: ${desk.roleTitle || "(unset)"}${desk.clientCompany ? ` at ${desk.clientCompany}` : " (confidential search)"}\n\n` +
        `Job description:\n"""\n${(desk.jobDescription || "").slice(0, 8000)}\n"""\n\n` +
        `Facts the agent already knows:\n${facts || "(none)"}\n\n` +
        `Topics the agent could not answer (with how candidates phrased them):\n` +
        pending.map((c) => `- ${c.topic}: "${c.canonicalQuestion}"`).join("\n") +
        `\n\nReturn the JSON array.`,
    }],
  });

  const block = response.content.find((b) => b.type === "text");
  const raw = block && block.type === "text" ? block.text : "[]";
  let arr: any = [];
  try {
    arr = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
  } catch { arr = []; }
  if (!Array.isArray(arr)) arr = [];

  const touched: QACluster[] = [];
  for (const c of pending) {
    const hit = arr.find((a: any) => a && typeof a.topic === "string" && a.topic.trim().toLowerCase() === c.topic.toLowerCase());
    const grounded = Boolean(hit?.grounded) && typeof hit?.answer === "string" && hit.answer.trim().length > 0;
    const answer = grounded ? stripEmDash(String(hit.answer).trim()) : "";
    const saved = setQADraft(desk, c.id, answer, grounded);
    if (saved) touched.push(saved);
  }
  return touched;
}

/* ---------------- teach + text back ---------------- */

/**
 * Text the approved answer back to the candidates who asked and were promised
 * a follow-up. Sends from the desk's own number (the one they dialed), skips
 * anyone already texted, and stays inside the recency window. Best-effort.
 */
export async function textAnswerBack(desk: VettingDesk, cluster: QACluster): Promise<number> {
  const answer = (cluster.approvedAnswer || "").trim();
  if (!answer || !desk.phoneNumber) return 0;

  const cutoff = Date.now() - TEXT_BACK_WINDOW_DAYS * 24 * 3600 * 1000;
  const due = cluster.asks
    .filter((a) => a.phone && !a.answerTextedAt && Date.parse(a.at) >= cutoff)
    .slice(0, TEXT_BACK_MAX);

  let sent = 0;
  for (const ask of due) {
    const candidate = ask.candidateId ? getCandidateById(ask.candidateId) : undefined;
    const first = candidate?.firstName || "";
    const text =
      `${first ? `Hi ${first}, ` : "Hi, "}it's ${desk.persona.agentName} with ${desk.persona.agentCompany}. ` +
      `You asked about ${cluster.topic} when we spoke about the ${desk.roleTitle || "role"}. ` +
      `Got the answer for you: ${answer} ` +
      `Any other questions, just call or text this number.`;
    try {
      const res: any = await withWorkspaceCreds(desk.workspaceId, () =>
        telnyx.sendSms(ask.phone!, text, desk.phoneNumber),
      );
      if (res?.error) throw new Error(String(res.error));
      markQAAnswerTexted(desk, cluster.id, ask.callId);
      sent += 1;
    } catch (e: any) {
      console.error("[vetting] qa text-back failed:", e?.message || e);
    }
  }
  return sent;
}

/**
 * Teach the agent one answer: approve the cluster into the desk FAQ, push the
 * updated prompt to the live assistant, and (optionally) text the answer back
 * to the candidates who asked. Returns what happened for the UI.
 */
export async function teachCluster(
  desk: VettingDesk,
  clusterId: string,
  answer: string,
  opts?: { textBack?: boolean },
): Promise<{ cluster: QACluster; pushed: boolean; texted: number } | { error: string }> {
  const approved = approveQACluster(desk, clusterId, stripEmDash(answer));
  if (!approved) {
    const full = normalizeKnowledge(desk.knowledge).length >= KNOWLEDGE_CAP;
    return { error: full ? "faq_full" : "bad_cluster_or_answer" };
  }

  let pushed = false;
  if (desk.status === "live" && desk.assistantId) {
    const res = await provisionDesk(desk);
    pushed = !res.error;
  }

  const wantText = opts?.textBack ?? deskQA(desk).textBack;
  const texted = wantText ? await textAnswerBack(desk, approved.cluster) : 0;

  return { cluster: approved.cluster, pushed, texted };
}

/* ---------------- the post-call hook ---------------- */

/**
 * Fire-and-forget after a call is scored (webhook/route.ts). Harvests the
 * call's questions, rolls them into clusters, drafts answers for new gaps,
 * and (auto-teach ON) teaches grounded drafts and texts the answer back, so
 * the desk literally answers more of what candidates ask the longer it runs.
 * Never throws.
 */
export async function maybeLearnQuestions(deskId: string, callId: string): Promise<void> {
  try {
    const desk = getDeskById(deskId);
    if (!desk || !process.env.ANTHROPIC_API_KEY) return;
    const call = listCalls(desk.workspaceId, desk.id, 200).find((c) => c.id === callId);
    if (!call || call.questionsHarvestedAt) return;

    const questions = await harvestCallQuestions(desk, call);
    updateCall(call.id, { candidateQuestions: questions, questionsHarvestedAt: new Date().toISOString() });
    if (!questions.length) return;

    const touched = recordCallQuestions(desk, call, questions);
    const gaps = touched.filter((c) => c.status === "open" && c.deferredCount > 0 && !c.draftAnswer);
    if (!gaps.length) return;

    const drafted = await draftGapAnswers(desk, gaps.map((c) => c.id));

    if (deskQA(desk).autoTeach) {
      for (const c of drafted) {
        if (c.draftGrounded && c.draftAnswer) {
          await teachCluster(desk, c.id, c.draftAnswer);
        }
      }
    }
  } catch (e: any) {
    console.error("[vetting] question-learn failed:", e?.message || e);
  }
}

/**
 * Backfill: harvest recent scored calls that predate question intelligence (or
 * arrived while it was off). Serial on purpose: this runs from a button, not
 * the live call path. Returns how many calls were processed.
 */
export async function backfillHarvest(desk: VettingDesk, limit = 15): Promise<number> {
  const calls = listCalls(desk.workspaceId, desk.id, 100)
    .filter((c) => c.status === "scored" && !c.questionsHarvestedAt && c.transcript.length >= 2)
    .slice(0, limit);
  let done = 0;
  for (const call of calls) {
    await maybeLearnQuestions(desk.id, call.id);
    done += 1;
  }
  return done;
}

/* ---------------- coverage (the UI's headline stats) ---------------- */

export interface QACoverage {
  /** Lifetime questions harvested on this desk. */
  asked: number;
  /** Of the clustered asks, the share answered on the spot (0-100, null = none yet). */
  answeredPct: number | null;
  /** Open clusters still needing an answer (the learning queue). */
  openGaps: number;
  /** Answers taught to the agent so far. */
  taught: number;
  /** Answer texts sent back to candidates, lifetime. */
  textedBack: number;
}

export function questionCoverage(desk: VettingDesk): QACoverage {
  const qa = deskQA(desk);
  const live = qa.clusters.filter((c) => c.status !== "dismissed");
  const asks = live.reduce((n, c) => n + c.askCount, 0);
  const answered = live.reduce((n, c) => n + c.answeredCount, 0);
  return {
    asked: qa.totalAsked,
    answeredPct: asks ? Math.round((answered / asks) * 100) : null,
    openGaps: qa.clusters.filter((c) => c.status === "open" && (c.deferredCount > 0 || c.answeredCount === 0)).length,
    taught: qa.clusters.filter((c) => c.status === "approved").length,
    textedBack: qa.clusters.reduce((n, c) => n + c.asks.filter((a) => a.answerTextedAt).length, 0),
  };
}
