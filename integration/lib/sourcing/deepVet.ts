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
 */

import Anthropic from "@anthropic-ai/sdk";
import type { CandidateICP, CandidateRow } from "./types";
import type { FullProfile } from "./profile";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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

function clampScore(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function strArr(v: unknown, cap = 8): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean).slice(0, cap);
}

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

function normalize(raw: string): VetResult {
  try {
    const o = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    const verdict = ["strong", "possible", "weak", "no"].includes(o.verdict) ? o.verdict : "possible";
    return {
      verifiedScore: clampScore(o.verifiedScore),
      verdict,
      yearsRelevant: Number.isFinite(Number(o.yearsRelevant)) ? Number(o.yearsRelevant) : undefined,
      strengths: strArr(o.strengths),
      gaps: strArr(o.gaps),
      flags: strArr(o.flags),
      rationale: String(o.rationale || "").slice(0, 400),
    };
  } catch {
    return { verifiedScore: 0, verdict: "no", strengths: [], gaps: [], flags: ["parse_error"], rationale: "Could not parse vetting result." };
  }
}

/** Deep-vet one candidate against the ICP. Throws only if the model client is unconfigured. */
export async function deepVetCandidate(row: CandidateRow, icp: CandidateICP, profile?: FullProfile): Promise<VetResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw Object.assign(new Error("anthropic_not_configured: set ANTHROPIC_API_KEY"), { status: 409 });
  }
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 700,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] as any,
    messages: [
      {
        role: "user",
        content: `IDEAL CANDIDATE PROFILE:\n"""\n${renderIcp(icp)}\n"""\n\nCANDIDATE:\n"""\n${renderCandidate(row, profile)}\n"""\n\nReturn the vetting JSON.`,
      },
    ],
  });
  const block = response.content.find((b) => b.type === "text");
  return normalize(block && block.type === "text" ? block.text : "{}");
}
