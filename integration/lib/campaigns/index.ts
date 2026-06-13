/**
 * RecruitersOS · Campaigns
 * Campaign creation + the 7-phase deployment workflow, plus barrel exports.
 */

import { getCore } from "../core/repository";
import { rid, nowIso } from "../core/ids";
import type { Campaign, Motion } from "../core/types";

export * from "./sequence";
export * from "./abtest";
export * from "./cadence";

/** The 7-phase deploy workflow from the Outreach tab, as a checklist spec. */
export const DEPLOY_PHASES = [
  { n: 1, title: "Infrastructure pre-flight", time: "one-time", done: "Overview capacity strip shows green",
    items: ["≥1 warmed LinkedIn account per motion", "≥5 warmed domains (15+ inbox capacity)", "RapidAPI job scraper enabled", "Enrichment waterfall (Fresh LinkedIn + Tomba)", "ATS connected", "TalTxt + Telnyx 10DLC deployed"] },
  { n: 2, title: "Create campaign shell", time: "5 min", done: "Draft campaign with ICP + signals",
    items: ["Name + one-sentence goal", "ICP definition", "≥1 signal enabled"] },
  { n: 3, title: "Configure search & discovery", time: "5 min", done: "Preview shows the right companies + people",
    items: ["Role hiring for (JSearch query)", "Candidate / persona title", "Decision-maker target title", "Live query preview validation"] },
  { n: 4, title: "Connect channels", time: "3 min", done: "All channels show ✓",
    items: ["Instantly campaign id", "LinkedIn account", "TalTxt SMS toggle", "Loxo list id"] },
  { n: 5, title: "Configure sequence methodology", time: "3 min", done: "Methodology + assets locked",
    items: ["Methodology (Hiring Manager / Voice-First / 7-touch)", "Voice-note threshold (80 = HOT only)", "LLM personalization", "Content assets attached"] },
  { n: 6, title: "Set A/B variants", time: "2 min", done: "2+ variants, weights = 100%",
    items: ["≥2 variants (Direct vs Curiosity)", "Traffic weights (50/50)", "ONE variable differs"] },
  { n: 7, title: "Soft launch & activate", time: "5 min + ongoing", done: "Status = Active, first 25 in sequence",
    items: ["Daily cap = 25 (week 1)", "Build Prospect List Now", "Activate Campaign", "Day-1 approval-queue review"] },
] as const;

/** Funnel benchmarks (BD motion) surfaced in analytics. */
export const BD_BENCHMARKS = {
  linkedinAcceptRate: [0.40, 0.55],
  emailOpenRate: [0.45, 0.60],
  voiceNoteResponseRate: [0.10, 0.15],
  positiveReplyRate: [0.03, 0.06],
  positiveToBooked: [0.40, 0.60],
  bookedToMandate: [0.15, 0.25],
  mandateToPlacement: [0.50, 0.70],
} as const;

export interface NewCampaignInput {
  workspaceId: string;
  motion: Motion;
  name: string;
  goal: string;
  icp: Campaign["icp"];
  signals: Campaign["signals"];
  methodology?: Campaign["methodology"];
  voiceNoteThreshold?: number;
  dailyCap?: number;
}

/** Create a Draft campaign (phase 2). */
export async function createCampaign(input: NewCampaignInput): Promise<Campaign> {
  const c: Campaign = {
    id: rid("camp"),
    workspaceId: input.workspaceId,
    motion: input.motion,
    name: input.name,
    goal: input.goal,
    icp: input.icp,
    signals: input.signals,
    channels: {},
    methodology: input.methodology ?? "hiring_manager_outreach",
    voiceNoteThreshold: input.voiceNoteThreshold ?? 80,
    dailyCap: input.dailyCap ?? 25,
    status: "draft",
    createdAt: nowIso(),
  };
  await getCore().saveCampaign(c);
  return c;
}

/** Activate a campaign (phase 7) once channels are wired. */
export async function activateCampaign(id: string): Promise<Campaign | null> {
  const core = getCore();
  const c = await core.getCampaign(id);
  if (!c) return null;
  c.status = "active";
  await core.saveCampaign(c);
  return c;
}
