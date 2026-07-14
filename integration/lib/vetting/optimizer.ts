/**
 * RecruitersOS · AI Vetting · Prompt & voice optimizer (the learning loop)
 *
 * What GoHighLevel's "Prompt Optimizer" does for a static prompt, this does
 * CONTINUOUSLY from evidence: one LLM pass reads the desk's recent scored calls
 * (the agent's actual lines, the candidate's reactions, and the per-call
 * Agent-Realism grades the scorer already produces) and emits a versioned
 * revision:
 *
 *   - styleNotes  -> operative coaching lines injected into the agent prompt
 *                    ("# WHAT YOU'VE LEARNED..." section in prompt.ts)
 *   - voiceTuning -> small, bounded nudges to the ElevenLabs delivery knobs
 *                    (stability/similarity/style/speed), never a wild swing
 *   - changelog   -> plain-English "changed X because Y (call evidence)" the
 *                    operator reads in the Optimizer tab
 *
 * Revisions are stored on the desk (store.ts), applied on demand or
 * automatically (auto-learn: every N scored calls), and pushed to the live
 * Telnyx assistant via provisionDesk - so the agent that answers the NEXT call
 * is literally the one that learned from the last ones.
 *
 * Same Anthropic client + STRICT-JSON-with-fallback convention as scoring.ts.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { VettingDesk, VettingCall, VoiceTuning, PromptRevision, TranscriptTurn, SimRun } from "./types";
import { clampVoiceTuning, DEFAULT_VOICE_TUNING } from "./types";
import {
  listCalls, deskLearning, addRevision, applyRevision, bumpLearningCounter, getDeskById,
} from "./store";
import { provisionDesk } from "./assistant";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// Optimizing the agent is judgment work like scoring - use the reasoning tier.
const MODEL = process.env.RECRUITEROS_VETTING_MODEL ?? process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";

/** How many recent scored calls one optimizer pass studies. */
const CALL_SAMPLE = 8;
/** Max agent/candidate turns quoted per call (keeps the prompt tight). */
const TURNS_PER_CALL = 26;

const SYSTEM = `You are a world-class voice-agent conversation coach. Your client is an AI phone recruiter that speaks in a real recruiter's cloned voice on short inbound screening calls. Your ONLY goal: make it indistinguishable from a skilled human recruiter, call over call.

You are given: the desk's setup, the currently applied coaching notes (may be empty), the current voice-delivery settings, and transcripts of recent calls with a per-call Agent-Realism grade (0-100) and grader notes.

Study the AGENT's actual lines against how the CANDIDATE reacted. Hunt for:
- robotic tells: repeated sentence shapes, question after question with no acknowledgment, over-long turns, customer-support phrasing, scripted-sounding transitions, ignoring what the candidate just said
- unspoken-text tells: digits/symbols/abbreviations that a voice engine reads wrong, list-like phrasing, missing hesitations where a human would think
- pacing and warmth: did it interrupt, lecture, rush the close, or fail to mirror energy
- what WORKED: moments where the candidate opened up, laughed, or engaged - keep and amplify those patterns

Then produce ONE revision:
1. "diagnosis": one short paragraph, the honest read on how human the agent currently sounds and the single biggest gap.
2. "styleNotes": the coaching addendum injected into the agent's system prompt. 4 to 8 lines, each starting with "- ". Every line must be OPERATIVE (tell the agent exactly what to do or say differently, with a concrete example phrase where useful), grounded in something you saw in these calls. Refine delivery only: never contradict the agent's hard rules (truthfulness, barge-in, no AI claims), never change WHAT it screens for, only HOW it talks. If the current notes contain lines that are clearly still valuable, carry them forward so learning accumulates instead of resetting.
3. "voiceTuning": nudge the delivery knobs only when call evidence justifies it, and move each by AT MOST 0.05 (speed at most 0.03) from the current values. Stay inside: stability 0.30-0.55, similarityBoost 0.75-0.90, style 0-0.30, speed 0.90-1.10. If it graded monotone/flat, lower stability slightly. If wobbly/inconsistent, raise it. If it sounded rushed, lower speed a touch. No evidence = return the current values unchanged.
4. "changelog": 2 to 6 short lines, each "what changed: why, citing the call evidence". Written for the recruiter who owns this desk.

Writing rules for everything you output: plain professional English, no markdown headings, no emojis, and never use the em-dash character; use commas, colons, or parentheses instead.

Return STRICT JSON only, no prose, no fences:
{
  "diagnosis": string,
  "styleNotes": string,
  "voiceTuning": { "stability": number, "similarityBoost": number, "style": number, "speed": number, "speakerBoost": boolean },
  "changelog": [string]
}`;

export interface OptimizerOutput {
  diagnosis: string;
  styleNotes: string;
  voiceTuning: VoiceTuning;
  changelog: string[];
  basedOnCalls: number;
  avgRealismBefore?: number;
  /** The coaching lens this output optimized through (multi-variant mode). */
  angle?: string;
}

/**
 * The lenses the multi-variant ("Auto") pass optimizes through. Same evidence,
 * three genuinely different coaching philosophies, so the operator compares
 * real alternatives instead of three rewordings of one idea.
 */
export const VARIANT_LENSES: Record<string, string> = {
  warmth:
    "LENS: WARMTH. Optimize above all for rapport and emotional attunement: reactions before questions, empathy on sensitive topics, the caller should hang up feeling genuinely liked. Accept slightly longer calls to get it.",
  brevity:
    "LENS: BREVITY. Optimize above all for crisp, senior-operator economy: shortest natural turns, zero filler beyond a rare acknowledgment, fast pace, get to the point the way a partner-level recruiter does. Warmth stays, wordiness goes.",
  energy:
    "LENS: ENERGY MIRRORING. Optimize above all for matching and steering the caller's energy: lift when they lift, settle when they hesitate, use pace and emphasis shifts as the main realism lever.",
};

/** The realism trendline the UI charts: per-call points plus rolling means. */
export interface RealismTrend {
  points: Array<{ callId: string; at: string; realism: number | null; total: number | null }>;
  avgRealism: number | null;
  avgRealismRecent: number | null; // last 5 scored calls
  scoredCalls: number;
}

export function realismTrend(workspaceId: string, deskId: string): RealismTrend {
  const calls = listCalls(workspaceId, deskId, 100)
    .filter((c) => c.status === "scored")
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const points = calls.map((c) => ({
    callId: c.id,
    at: c.startedAt,
    realism: c.agentRealism ? c.agentRealism.score : null,
    total: c.totalScore ?? null,
  }));
  const vals = points.map((p) => p.realism).filter((v): v is number => v != null);
  const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return {
    points,
    avgRealism: mean(vals),
    avgRealismRecent: mean(vals.slice(-5)),
    scoredCalls: calls.length,
  };
}

function turnsBlock(turns: TranscriptTurn[]): string {
  const trimmed = turns.slice(0, TURNS_PER_CALL);
  const lines = trimmed.map((t) => `${t.role === "agent" ? "AGENT" : "CANDIDATE"}: ${t.text.slice(0, 400)}`);
  if (turns.length > TURNS_PER_CALL) lines.push(`(... ${turns.length - TURNS_PER_CALL} more turns omitted)`);
  return lines.join("\n");
}

function callsBlock(calls: VettingCall[]): string {
  return calls
    .map((c, i) => {
      const realism = c.agentRealism ? `${c.agentRealism.score}/100${c.agentRealism.notes ? ` (grader: ${c.agentRealism.notes})` : ""}` : "not graded";
      return `--- CALL ${i + 1} · ${c.durationSec ? Math.round(c.durationSec / 60) + "m" : "?"} · candidate score ${c.totalScore ?? "?"} · AGENT REALISM ${realism}\n${turnsBlock(c.transcript)}`;
    })
    .join("\n\n");
}

/** Compact evidence block from a simulation run (failures loudest). */
function simBlock(run: SimRun): string {
  const lines = run.results.map((r) => {
    const head = `SIM "${r.label}" [${r.priority}] · ${r.passed ? "PASSED" : "FAILED"} · realism ${r.realism}/100 · ${r.notes}`;
    if (r.passed || !r.transcript.length) return head;
    // Quote failed sims so the coach can see exactly what went wrong.
    const quoted = r.transcript.slice(0, 14).map((t) => `  ${t.role === "agent" ? "AGENT" : "CANDIDATE"}: ${t.text.slice(0, 300)}`).join("\n");
    return `${head}\n${quoted}`;
  });
  return `Simulated stress-test results (synthetic candidates run against the agent's exact prompt):\n${lines.join("\n\n")}`;
}

/**
 * One optimizer pass over the desk's recent scored calls, optionally enriched
 * with a simulation run's results (which also let a desk with NO real calls yet
 * be optimized purely from sims). Throws with a clean status when unconfigured
 * or there is nothing at all to learn from.
 */
export async function runOptimizer(desk: VettingDesk, sim?: SimRun, angle?: string): Promise<OptimizerOutput> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw Object.assign(new Error("anthropic_not_configured: set ANTHROPIC_API_KEY"), { status: 409 });
  }
  const scored = listCalls(desk.workspaceId, desk.id, 60)
    .filter((c) => c.status === "scored" && c.transcript.length >= 2)
    .slice(0, CALL_SAMPLE);
  const simRun = sim ?? deskLearning(desk).lastSimulation;
  if (!scored.length && !simRun?.results?.length) {
    throw Object.assign(new Error("no_evidence: take a scored call or run a simulation first"), { status: 409 });
  }

  const current = clampVoiceTuning(desk.voiceTuning);
  const notes = deskLearning(desk).learnedNotes || "(none yet)";
  const realisms = scored.map((c) => c.agentRealism?.score).filter((v): v is number => v != null);
  const avgBefore = realisms.length ? Math.round(realisms.reduce((a, b) => a + b, 0) / realisms.length) : undefined;

  const lens = angle && VARIANT_LENSES[angle] ? `\n\n${VARIANT_LENSES[angle]}` : "";
  const userContent =
    `Desk: ${desk.name} · Role: ${desk.roleTitle || "(unset)"}${desk.clientCompany ? ` at ${desk.clientCompany}` : " (confidential search)"}\n` +
    `Agent persona: ${desk.persona.agentName} at ${desk.persona.agentCompany}, warmth=${desk.persona.warmth || "warm"}\n\n` +
    `Currently applied coaching notes:\n${notes}\n\n` +
    `Current voice delivery settings: ${JSON.stringify(current)}\n\n` +
    (scored.length ? `Recent REAL calls (newest first):\n${callsBlock(scored).slice(0, 20000)}\n\n` : "No real scored calls yet.\n\n") +
    (simRun?.results?.length ? `${simBlock(simRun).slice(0, 12000)}\n\n` : "") +
    `Real-call evidence outweighs simulated evidence when they disagree. Produce the revision JSON.${lens}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1600,
    // Single-revision coaching should be steady, not creative roulette. Variant
    // lenses get a little more room so the three proposals genuinely diverge.
    temperature: angle ? 0.5 : 0.2,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] as any,
    messages: [{ role: "user", content: userContent }],
  });

  const block = response.content.find((b) => b.type === "text");
  const out = normalize(block && block.type === "text" ? block.text : "{}", current, scored.length, avgBefore);
  return angle ? { ...out, angle } : out;
}

/**
 * GHL "Auto" mode: three competing revisions from the same evidence, each
 * optimized through a different coaching lens, run concurrently. All are
 * stored as PROPOSED by the route; the operator applies the one they like.
 */
export async function runOptimizerVariants(desk: VettingDesk): Promise<OptimizerOutput[]> {
  const angles = Object.keys(VARIANT_LENSES);
  const results = await Promise.allSettled(angles.map((a) => runOptimizer(desk, undefined, a)));
  const ok = results
    .filter((r): r is PromiseFulfilledResult<OptimizerOutput> => r.status === "fulfilled")
    .map((r) => r.value);
  if (!ok.length) {
    // Every lens failed: surface the first real error (e.g. no key / no evidence).
    const firstErr = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    throw firstErr?.reason ?? new Error("variants_failed");
  }
  return ok;
}

/** Bound one knob to within `step` of its current value (anti-oscillation). */
function nudge(next: number, cur: number, step: number, lo: number, hi: number): number {
  if (!Number.isFinite(next)) return cur;
  const bounded = Math.min(cur + step, Math.max(cur - step, next));
  return Math.round(Math.min(hi, Math.max(lo, bounded)) * 100) / 100;
}

function stripEmDash(s: string): string {
  return s.replace(/\s*—\s*/g, ", ").replace(/\s*–\s*/g, ", ");
}

function normalize(raw: string, current: VoiceTuning, basedOnCalls: number, avgRealismBefore?: number): OptimizerOutput {
  let o: any = {};
  try {
    o = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    o = {};
  }

  const vt = o.voiceTuning ?? {};
  const voiceTuning: VoiceTuning = {
    stability: nudge(Number(vt.stability), current.stability, 0.05, 0.3, 0.55),
    similarityBoost: nudge(Number(vt.similarityBoost), current.similarityBoost, 0.05, 0.75, 0.9),
    style: nudge(Number(vt.style), current.style, 0.05, 0, 0.3),
    speed: nudge(Number(vt.speed), current.speed, 0.03, 0.9, 1.1),
    speakerBoost: vt.speakerBoost === undefined ? current.speakerBoost : Boolean(vt.speakerBoost),
  };

  const styleNotes = stripEmDash(String(o.styleNotes ?? "").trim()).slice(0, 1600);
  const changelog = (Array.isArray(o.changelog) ? o.changelog : [])
    .map((l: unknown) => stripEmDash(String(l).trim()).slice(0, 280))
    .filter(Boolean)
    .slice(0, 8);

  return {
    diagnosis: stripEmDash(String(o.diagnosis ?? "").trim()).slice(0, 900),
    styleNotes: styleNotes || "- Keep doing what is working: short turns, acknowledge before asking, mirror the caller's energy.",
    voiceTuning,
    changelog: changelog.length ? changelog : ["No material changes: not enough new evidence in these calls."],
    basedOnCalls,
    avgRealismBefore,
  };
}

/**
 * Auto-learn hook, called (fire-and-forget) by the post-call webhook after a
 * call is scored. Counts the call; when the desk has auto-learn on and enough
 * new calls have accumulated, runs a pass, applies it, and re-provisions the
 * live assistant so the next caller meets the improved agent. Never throws.
 */
export async function maybeAutoLearn(deskId: string): Promise<PromptRevision | undefined> {
  try {
    const desk = getDeskById(deskId);
    if (!desk) return undefined;
    const count = bumpLearningCounter(desk);
    const l = deskLearning(desk);
    if (!l.autoLearn || count < l.minCallsBetweenRuns || !process.env.ANTHROPIC_API_KEY) return undefined;

    const out = await runOptimizer(desk);
    const rev = addRevision(desk, {
      source: "auto_learn",
      status: "proposed",
      styleNotes: out.styleNotes,
      voiceTuning: out.voiceTuning,
      changelog: out.changelog,
      diagnosis: out.diagnosis,
      basedOnCalls: out.basedOnCalls,
      avgRealismBefore: out.avgRealismBefore,
    });
    applyRevision(desk, rev.id);
    // Push the improved prompt + voice settings to the live agent.
    if (desk.status === "live" && desk.assistantId) await provisionDesk(desk);
    return rev;
  } catch (e: any) {
    console.error("[vetting] auto-learn failed:", e?.message || e);
    return undefined;
  }
}

/** Named presets for the tuning UI: honest, documented starting points. */
export const VOICE_PRESETS: Record<string, { label: string; hint: string; tuning: VoiceTuning }> = {
  natural: {
    label: "Natural recruiter",
    hint: "The phone-realism sweet spot. Alive intonation, holds the clone, full speed.",
    tuning: { ...DEFAULT_VOICE_TUNING },
  },
  warm: {
    label: "Warm and unhurried",
    hint: "More expressive and a touch slower. Good for senior or sensitive searches.",
    tuning: { stability: 0.35, similarityBoost: 0.8, style: 0.1, speed: 0.95, speakerBoost: true },
  },
  crisp: {
    label: "Crisp and consistent",
    hint: "Steadier delivery for noisy lines or fast screens. Slightly flatter.",
    tuning: { stability: 0.55, similarityBoost: 0.85, style: 0, speed: 1.02, speakerBoost: true },
  },
};
