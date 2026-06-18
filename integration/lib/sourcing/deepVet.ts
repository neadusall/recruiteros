/**
 * RecruitersOS · JD Sourcing
 * Stage-2 deep vetting — does this person ACTUALLY qualify?
 *
 * The bulk rule-scorer (score.ts) ranks on surface signals: title, company, geo.
 * This pass reads the candidate's full work history against the job description and
 * renders a real verdict — years of relevant experience, tenure/progression, genuine
 * strengths and gaps — the judgment a human recruiter would make on a first pass.
 *
 * One LLM call per candidate, run only on the top slice you choose (cost-controlled).
 * Defaults to Claude Sonnet — résumé judgment needs more than the extraction tier.
 * Never invents history: it reasons only over the profile fields it's given, and says
 * so when the data is thin.
 *
 * Two execution paths, same prompt + parsing:
 *   - deepVetCandidate(): one synchronous call. Used for tiny slices and as the
 *     fallback when the Batch API is unavailable.
 *   - submitVetBatch()/retrieveVetBatch()/collectVetBatch(): the Message Batches API,
 *     which runs the SAME requests asynchronously at HALF the token price. Deep-vet
 *     isn't latency-critical (the recruiter picks a top-N and walks away), so the top
 *     slice goes through a batch — the single biggest cost lever in JD Sourcing.
 */

import { anthropicClient } from "./anthropic";
import { parseVetResult } from "./vetParse";
import type { CandidateICP, CandidateRow } from "./types";
import type { FullProfile } from "./profile";

// Judgment work — default to the balanced tier; override via env.
const MODEL = process.env.RECRUITEROS_VET_MODEL ?? process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";

export interface VetResult {
  verifiedScore: number;
  verdict: "strong" | "possible" | "weak" | "no";
  yearsRelevant?: number;
  strengths: string[];
  gaps: string[];
  flags: string[];
  rationale: string;
}

const SYSTEM = `You are a senior recruiter vetting whether a candidate TRULY qualifies for a role.
You are given a job's ideal-candidate profile and a candidate's actual work history.
Judge fit the way an experienced recruiter would on a first-pass screen — reason over the
WORK HISTORY (roles, tenure, progression, domain), not just the current title.

Return STRICT JSON only, no prose:
{
  "verifiedScore": 0-100,                 // honest fit after reading the history
  "verdict": "strong"|"possible"|"weak"|"no",
  "yearsRelevant": number,                // years of role-relevant experience (0 if unknown)
  "strengths": string[],                  // concrete fits grounded in the history
  "gaps": string[],                       // where they fall short of the JD
  "flags": string[],                      // risks: "job_hopping","title_inflation","domain_mismatch","employment_gap","overqualified","underqualified"
  "rationale": string                     // one or two sentences explaining the score
}

Rules:
- Be honest and calibrated. "strong" means you'd confidently put them forward; "no" means clearly wrong.
- Reward real, role-relevant tenure and progression. Penalize title-only matches with no substance.
- If the work history is thin or missing, say so in rationale, lower confidence toward the middle, and flag "insufficient_data". Do NOT invent experience.
- Ground every strength/gap in something actually present (or absent) in the data.`;

/** Render the candidate (full profile if we have it, else the shallow row) for the model. */
function renderCandidate(row: CandidateRow, profile?: FullProfile): string {
  const lines: string[] = [];
  lines.push(`Name: ${row.fullName}`);
  lines.push(`Headline/title: ${profile?.headline || row.headline || row.title || "(unknown)"}`);
  lines.push(`Current company: ${row.company || "(unknown)"}`);
  lines.push(`Location: ${profile?.location || row.location || "(unknown)"}`);
  if (profile?.totalYears) lines.push(`Total experience: ~${profile.totalYears} years`);
  if (profile?.summary) lines.push(`Summary: ${profile.summary.slice(0, 800)}`);
  if (profile?.experiences?.length) {
    lines.push("Work history (most recent first):");
    for (const e of profile.experiences.slice(0, 12)) {
      const span = [e.start, e.end].filter(Boolean).join(" – ");
      const dur = e.durationMonths ? ` (${Math.round((e.durationMonths / 12) * 10) / 10}y)` : "";
      lines.push(`- ${e.title || "?"} @ ${e.company || "?"}${span ? ` [${span}${dur}]` : dur}${e.description ? `: ${e.description.slice(0, 200)}` : ""}`);
    }
  } else {
    lines.push("Work history: NOT AVAILABLE (only the surface profile was retrieved — judge with low confidence and flag insufficient_data).");
  }
  if (profile?.education?.length) lines.push(`Education: ${profile.education.join("; ")}`);
  if (profile?.skills?.length) lines.push(`Skills: ${profile.skills.slice(0, 30).join(", ")}`);
  return lines.join("\n");
}

function renderIcp(icp: CandidateICP): string {
  return [
    `Role: ${icp.label}`,
    `Seniority: ${icp.seniority}${icp.managesTeam ? " (must manage a team)" : ""}`,
    icp.titles.length ? `Target titles: ${icp.titles.slice(0, 12).join(", ")}` : "",
    icp.industries.length ? `Industries: ${icp.industries.slice(0, 12).join(", ")}` : "",
    icp.geos.length ? `Geos: ${icp.geos.slice(0, 12).join(", ")}${icp.remoteOk ? " (remote ok)" : ""}` : "",
    icp.mustHave.length ? `Must have: ${icp.mustHave.slice(0, 12).join(", ")}` : "",
    icp.niceToHave.length ? `Nice to have: ${icp.niceToHave.slice(0, 12).join(", ")}` : "",
    icp.disqualifiers.length ? `Disqualifiers: ${icp.disqualifiers.slice(0, 12).join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

/** Pull the first text block out of a message response (single-call + batch share this). */
function textOf(content: any[]): string {
  const block = Array.isArray(content) ? content.find((b) => b && b.type === "text") : undefined;
  return block && block.type === "text" ? block.text : "{}";
}

/**
 * The exact Messages-API request body for vetting one candidate — shared verbatim by
 * the synchronous call and the batch path, so a batch result parses identically to a
 * live one. The system prompt is cached (cache_control) so a batch of N candidates
 * pays for the long instructions once, not N times.
 */
function buildVetParams(row: CandidateRow, icp: CandidateICP, profile?: FullProfile) {
  return {
    model: MODEL,
    max_tokens: 700,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] as any,
    messages: [
      {
        role: "user" as const,
        content: `IDEAL CANDIDATE PROFILE:\n"""\n${renderIcp(icp)}\n"""\n\nCANDIDATE:\n"""\n${renderCandidate(row, profile)}\n"""\n\nReturn the vetting JSON.`,
      },
    ],
  };
}

/** Deep-vet one candidate against the ICP. Throws only if the model client is unconfigured. */
export async function deepVetCandidate(row: CandidateRow, icp: CandidateICP, profile?: FullProfile): Promise<VetResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw Object.assign(new Error("anthropic_not_configured: set ANTHROPIC_API_KEY"), { status: 409 });
  }
  const response = await anthropicClient().messages.create(buildVetParams(row, icp, profile));
  return parseVetResult(textOf(response.content));
}

/* ------------------------------------------------------------------ */
/* Batch path — same prompt, half the token price                      */
/* ------------------------------------------------------------------ */

export interface VetBatchItem {
  /** Stable id echoed back on each result; must be unique within the batch. */
  customId: string;
  row: CandidateRow;
  icp: CandidateICP;
  profile?: FullProfile;
}

export type VetBatchStatus = "in_progress" | "canceling" | "ended";

export interface VetBatchProgress {
  status: VetBatchStatus;
  /** Per-state request counts (processing / succeeded / errored / …) when available. */
  counts?: Record<string, number>;
}

/** True when the installed SDK exposes the Message Batches API (older builds may not). */
export function vetBatchAvailable(): boolean {
  if (!process.env.ANTHROPIC_API_KEY) return false;
  try {
    const c: any = anthropicClient();
    return Boolean(c?.messages?.batches?.create);
  } catch {
    return false;
  }
}

/**
 * Submit a batch of vetting requests. Returns the batch id to poll. Each request is
 * the same body deepVetCandidate would send, tagged with the item's customId so we can
 * map the result back to the right candidate later.
 */
export async function submitVetBatch(items: VetBatchItem[]): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw Object.assign(new Error("anthropic_not_configured: set ANTHROPIC_API_KEY"), { status: 409 });
  }
  const client: any = anthropicClient();
  if (!client?.messages?.batches?.create) {
    throw Object.assign(new Error("batch_api_unavailable"), { status: 501 });
  }
  const requests = items.map((it) => ({
    custom_id: it.customId,
    params: buildVetParams(it.row, it.icp, it.profile),
  }));
  const batch = await client.messages.batches.create({ requests });
  return batch.id as string;
}

/** Poll a vetting batch. Status "ended" means every request has finished (or errored). */
export async function retrieveVetBatch(batchId: string): Promise<VetBatchProgress> {
  const client: any = anthropicClient();
  if (!client?.messages?.batches?.retrieve) {
    throw Object.assign(new Error("batch_api_unavailable"), { status: 501 });
  }
  const b = await client.messages.batches.retrieve(batchId);
  const status: VetBatchStatus = b.processing_status === "ended" ? "ended"
    : b.processing_status === "canceling" ? "canceling" : "in_progress";
  return { status, counts: b.request_counts ?? undefined };
}

export interface VetBatchCollection {
  /** customId -> parsed verdict, for every request that succeeded. */
  results: Record<string, VetResult>;
  /** customId-level errors (one line each) for surfacing as warnings. */
  errors: string[];
}

/**
 * Stream a finished batch's results and parse each succeeded message with the same
 * normalizer the synchronous path uses. Errored/expired requests become warnings —
 * the caller leaves those candidates un-vetted rather than fabricating a verdict.
 */
export async function collectVetBatch(batchId: string): Promise<VetBatchCollection> {
  const client: any = anthropicClient();
  if (!client?.messages?.batches?.results) {
    throw Object.assign(new Error("batch_api_unavailable"), { status: 501 });
  }
  const results: Record<string, VetResult> = {};
  const errors: string[] = [];
  for await (const entry of await client.messages.batches.results(batchId)) {
    const id = entry.custom_id as string;
    const r = entry.result;
    if (r?.type === "succeeded" && r.message) {
      results[id] = parseVetResult(textOf(r.message.content));
    } else if (r?.type === "errored") {
      errors.push(`vet(${id}): ${r.error?.type || "error"}`);
    } else if (r?.type === "expired") {
      errors.push(`vet(${id}): expired`);
    } else if (r?.type === "canceled") {
      errors.push(`vet(${id}): canceled`);
    }
  }
  return { results, errors };
}
