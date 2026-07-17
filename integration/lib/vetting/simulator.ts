/**
 * RecruitersOS · AI Vetting · Simulation harness + prompt lint
 *
 * The other half of the optimization loop (the half GoHighLevel's Prompt
 * Optimizer covers): stress-test the desk's REAL agent prompt against synthetic
 * candidates BEFORE real ones call, so a desk can be tuned on day zero with no
 * call history.
 *
 *   generateScenarios(desk) -> a handful of candidate personas with priorities
 *     (the skeptic who asks "is this an AI?", the rambler, the star, the
 *     confident-but-unqualified, the comp-mismatch...) each with an expected
 *     agent behavior.
 *   runSimulation(desk)     -> plays each persona against the desk's actual
 *     instructions in a text conversation (chat-mode simulation: the cheap,
 *     fast tier; the phone stays untouched), then judges every transcript
 *     against the human-likeness bar + the scenario's expectation.
 *   lintPrompt(desk)        -> GHL "Prompt Evaluator" equivalent: a static
 *     findings pass over the exact instructions the engine will run.
 *
 * Sim results feed the optimizer (lib/vetting/optimizer.ts) as extra evidence,
 * and failures are exactly what its revisions are asked to fix.
 */

import Anthropic from "@anthropic-ai/sdk";
import { rid, nowIso } from "../core/ids";
import type { VettingDesk, SimScenario, SimResult, SimRun, TranscriptTurn } from "./types";
import { buildAssistantInstructions, buildGreeting, buildCallContext } from "./prompt";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.RECRUITEROS_VETTING_MODEL ?? process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";

/** Turns per side in a simulated conversation (short screen, like the real call). */
const SIM_TURNS = 6;

function requireLlm(): void {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw Object.assign(new Error("anthropic_not_configured: set ANTHROPIC_API_KEY"), { status: 409 });
  }
}

/** Fill the {{dynamic_variables}} with a plausible sample caller for sims. */
function resolvedInstructions(desk: VettingDesk): { instructions: string; greeting: string } {
  const vars: Record<string, string> = {
    ...buildCallContext(desk),
    first_name: "Jordan",
    current_title: "Senior Manager",
    current_company: "a mid-size company in the space",
    experience: "Roughly ten years in the field, most recently leading a small team.",
  };
  const fill = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
  return { instructions: fill(buildAssistantInstructions(desk)), greeting: fill(buildGreeting(desk)) };
}

const SCENARIO_SYSTEM = `You design stress-test scenarios for an AI phone recruiter that screens inbound candidates. Given the role and qualifiers, produce EXACTLY 5 candidate personas that probe different failure modes:
1. A skeptic who peppers practical questions early (pay first, then remote policy or benefits or process), includes at least one practical question the job description does NOT answer (to test the honest flag-it-for-the-recruiter move), and at some point asks whether they are talking to an AI or a robot.
2. A rambler who gives long unfocused answers and goes off on tangents.
3. A strong, genuinely qualified candidate (the agent must not get in the way).
4. A confident talker who does NOT actually meet a key qualifier.
5. One persona tailored to THIS role's trickiest qualifier or likely objection (comp, relocation, confidentiality of the search, notice period...).

Each persona gets:
- "label": short name for the scenario.
- "persona": 3-5 sentences of who they are, how they talk, and what they will push on. Written as instructions to an actor.
- "expected": 1-2 sentences: what a PASSING agent performance looks like here (stays human, follows its rules, covers what it must).
- "priority": "critical" for the skeptic and the unqualified-talker, "high" or "medium" for the rest.

Never use the em-dash character anywhere. Return STRICT JSON only, an array of 5 objects with those keys, no prose, no fences.`;

export async function generateScenarios(desk: VettingDesk): Promise<SimScenario[]> {
  requireLlm();
  const qs = desk.questions.map((q) => `- ${q.prompt} (pass: ${q.passCriteria}${q.mustHave ? ", must-have" : ""})`).join("\n");
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1400,
    temperature: 0.4,
    system: [{ type: "text", text: SCENARIO_SYSTEM, cache_control: { type: "ephemeral" } }] as any,
    messages: [{
      role: "user",
      content: `Role: ${desk.roleTitle || "(unset)"}${desk.clientCompany ? ` at ${desk.clientCompany}` : " (confidential search)"}\nQualifiers:\n${qs || "(none set)"}\n\nJob description excerpt:\n"""\n${(desk.jobDescription || "").slice(0, 2500)}\n"""\n\nReturn the 5 scenarios.`,
    }],
  });
  const block = response.content.find((b) => b.type === "text");
  const raw = block && block.type === "text" ? block.text : "[]";
  let arr: any = [];
  try {
    arr = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
  } catch { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  return arr
    .filter((s: any) => s && typeof s.persona === "string")
    .slice(0, 5)
    .map((s: any): SimScenario => ({
      id: rid("vsim"),
      label: String(s.label || "Scenario").slice(0, 80),
      persona: String(s.persona).slice(0, 900),
      expected: String(s.expected || "Stays human and covers the qualifiers.").slice(0, 400),
      priority: (["critical", "high", "medium", "low"].includes(s.priority) ? s.priority : "medium"),
    }));
}

/** Run one chat-mode conversation: our agent prompt vs the persona actor. */
async function simulateConversation(desk: VettingDesk, scenario: SimScenario): Promise<TranscriptTurn[]> {
  const { instructions, greeting } = resolvedInstructions(desk);
  const candidateSystem =
    `You are ROLE-PLAYING a job candidate on a phone screen. Stay fully in character; never break character, never mention being an AI or a simulation.\n\nYour character:\n${scenario.persona}\n\nSpeak like a real person on the phone: casual, sometimes imperfect, contractions, occasionally short. One reply per turn, usually one to three sentences (the rambler persona may run longer). You called the recruiter about the ${desk.roleTitle || "role"}.`;

  const turns: TranscriptTurn[] = [{ role: "agent", text: greeting }];

  for (let i = 0; i < SIM_TURNS; i++) {
    // Candidate replies to everything said so far.
    const candView = turns.map((t) => ({
      role: t.role === "agent" ? ("user" as const) : ("assistant" as const),
      content: t.text,
    }));
    const candRes = await client.messages.create({
      model: MODEL,
      max_tokens: 220,
      temperature: 0.7,
      system: candidateSystem,
      messages: candView,
    });
    const candBlock = candRes.content.find((b) => b.type === "text");
    const candText = (candBlock && candBlock.type === "text" ? candBlock.text : "").trim();
    if (!candText) break;
    turns.push({ role: "candidate", text: candText });

    // Agent replies using the DESK'S REAL instructions (what the phone runs).
    const agentView = turns.map((t) => ({
      role: t.role === "candidate" ? ("user" as const) : ("assistant" as const),
      content: t.text,
    }));
    const agentRes = await client.messages.create({
      model: MODEL,
      max_tokens: 220,
      temperature: 0.5,
      system: [{ type: "text", text: instructions, cache_control: { type: "ephemeral" } }] as any,
      messages: agentView,
    });
    const agentBlock = agentRes.content.find((b) => b.type === "text");
    const agentText = (agentBlock && agentBlock.type === "text" ? agentBlock.text : "").trim();
    if (!agentText) break;
    turns.push({ role: "agent", text: agentText });
  }
  return turns;
}

const JUDGE_SYSTEM = `You judge a SIMULATED phone screen between an AI recruiter (AGENT) and an actor playing a candidate. Judge ONLY the agent.

Grade:
- "realism" (0-100): would a real caller believe the AGENT is a human recruiter? Penalize robotic tells: repeated cadence, interrogation without acknowledgment, over-long turns, digits/symbols/lists in speech, customer-support phrasing, ignoring what the candidate said, dodging a direct question (especially pay), repeating the question back before answering, saying it lacks information without offering a concrete path, deflecting small talk, restarting a sentence after an interruption. Reward natural pacing, reactions, mirroring or labeling the candidate's words, direct answer-first replies to candidate questions, a candid pay answer, honest handling of unknowns with a concrete path, referencing earlier answers, graceful handling of hard moments.
- "passed" (boolean): did the agent meet the scenario's EXPECTED behavior while staying human and inside its rules (truthful, no outcome promises, kind close)?
- "notes": 2-3 sentences, the decisive evidence. Quote a short agent line where useful. Never use the em-dash character.

Return STRICT JSON only: { "realism": int, "passed": bool, "notes": string }`;

async function judgeSim(desk: VettingDesk, scenario: SimScenario, transcript: TranscriptTurn[]): Promise<{ realism: number; passed: boolean; notes: string }> {
  const text = transcript.map((t) => `${t.role === "agent" ? "AGENT" : "CANDIDATE"}: ${t.text}`).join("\n");
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    temperature: 0,
    system: [{ type: "text", text: JUDGE_SYSTEM, cache_control: { type: "ephemeral" } }] as any,
    messages: [{
      role: "user",
      content: `Scenario: ${scenario.label}\nExpected agent behavior: ${scenario.expected}\n\nTranscript:\n"""\n${text.slice(0, 12000)}\n"""\n\nReturn the verdict JSON.`,
    }],
  });
  const block = response.content.find((b) => b.type === "text");
  const raw = block && block.type === "text" ? block.text : "{}";
  let o: any = {};
  try { o = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); } catch { o = {}; }
  return {
    realism: Math.max(0, Math.min(100, Math.round(Number(o.realism)) || 0)),
    passed: Boolean(o.passed),
    notes: String(o.notes ?? "").replace(/\s*—\s*/g, ", ").slice(0, 500),
  };
}

/**
 * Full simulation pass: scenarios -> conversations -> judged results. The
 * scenarios run CONCURRENTLY (each is a chain of LLM round-trips, so the run
 * takes as long as its slowest scenario, not the sum); a single bad scenario is
 * recorded as a failure rather than sinking the run.
 */
export async function runSimulation(desk: VettingDesk): Promise<SimRun> {
  requireLlm();
  const scenarios = await generateScenarios(desk);
  if (!scenarios.length) {
    throw Object.assign(new Error("scenario_generation_failed"), { status: 502 });
  }
  const results: SimResult[] = await Promise.all(scenarios.map(async (sc): Promise<SimResult> => {
    try {
      const transcript = await simulateConversation(desk, sc);
      const verdict = await judgeSim(desk, sc, transcript);
      return { scenarioId: sc.id, label: sc.label, priority: sc.priority, transcript, ...verdict };
    } catch (e: any) {
      return {
        scenarioId: sc.id, label: sc.label, priority: sc.priority, transcript: [],
        realism: 0, passed: false, notes: `Simulation errored: ${String(e?.message || e).slice(0, 200)}`,
      };
    }
  }));
  const passed = results.filter((r) => r.passed).length;
  const realisms = results.filter((r) => r.transcript.length).map((r) => r.realism);
  return {
    id: rid("vrun"),
    at: nowIso(),
    results,
    passed,
    failed: results.length - passed,
    avgRealism: realisms.length ? Math.round(realisms.reduce((a, b) => a + b, 0) / realisms.length) : null,
  };
}

/* ---------------- prompt lint (GHL "Prompt Evaluator" equivalent) ---------------- */

export interface LintFinding {
  severity: "high" | "medium" | "low";
  issue: string;
  recommendation: string;
}

const LINT_SYSTEM = `You review the system prompt of an AI phone recruiter for problems BEFORE it takes calls. Look for: contradictory instructions, missing guardrails (what to do when it does not know, when the caller is hostile, when asked if it is an AI), unspeakable content that a voice engine will mangle (digits, symbols, URLs, lists), ambiguity about the close/next step, anything that would make it sound scripted, and missing handling for the confidential-company case if relevant. Do NOT flag style choices that are clearly intentional.

Return STRICT JSON only, an array of at most 6 findings ordered most important first:
[ { "severity": "high"|"medium"|"low", "issue": string, "recommendation": string } ]
If the prompt is genuinely solid, return fewer findings or an empty array. Never use the em-dash character.`;

export async function lintPrompt(desk: VettingDesk): Promise<LintFinding[]> {
  requireLlm();
  const { instructions, greeting } = resolvedInstructions(desk);
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 900,
    temperature: 0,
    system: [{ type: "text", text: LINT_SYSTEM, cache_control: { type: "ephemeral" } }] as any,
    messages: [{ role: "user", content: `Greeting line:\n${greeting}\n\nFull agent instructions:\n"""\n${instructions.slice(0, 14000)}\n"""\n\nReturn the findings JSON.` }],
  });
  const block = response.content.find((b) => b.type === "text");
  const raw = block && block.type === "text" ? block.text : "[]";
  let arr: any = [];
  try { arr = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1)); } catch { arr = []; }
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 6).map((f: any): LintFinding => ({
    severity: (["high", "medium", "low"].includes(f?.severity) ? f.severity : "medium"),
    issue: String(f?.issue ?? "").replace(/\s*—\s*/g, ", ").slice(0, 300),
    recommendation: String(f?.recommendation ?? "").replace(/\s*—\s*/g, ", ").slice(0, 300),
  })).filter((f: LintFinding) => f.issue);
}
