/**
 * RecruitersOS · BD · Self-learning outreach optimizer
 *
 * The brain of the loop. Per (workspace, motion) it reads the live per-variant
 * analytics (positive-reply rate + two-proportion significance, already computed
 * by buildOutreachStats().byVariant keyed on our rich `${family}::${methodology}`
 * ids), then, inside each family:
 *
 *   PROMOTE  a challenger that beats the champion on positive-reply rate WITH
 *            statistical confidence and enough volume -> it becomes the champion,
 *            so the queue generates the winning angle for (1 - EXPLORATION) of all
 *            new prospects. Its latest real content is written into the live
 *            sequence (the "winning string goes into the sequencing" step).
 *   RETIRE   a challenger that loses to the champion with confidence + volume.
 *   SPAWN    fresh challengers (from the seed bank first, then LLM-brainstormed
 *            novel angles) to refill the pool, so the system keeps exhausting new
 *            MPC angles and methodologies instead of settling on two.
 *
 * Guardrails (the "full auto" the operator chose, made safe): nothing is judged
 * below MIN_* volume; promote/retire require significance; every move is logged
 * and reversible (retired, never deleted); a kill switch lives on the campaign
 * autopilot toggle / the cron not being scheduled.
 *
 * Metric choice (locked): positive-reply rate is primary (fast signal); booked
 * is the tiebreak when two variants are within a hair on positives.
 */

import Anthropic from "@anthropic-ai/sdk";
import { buildOutreachStats } from "../analytics/outreach";
import {
  ensureSeeded, listMethodologies, setStatus, addMethodology, richId, getChampion,
  SEED_ANGLES, type Family, type Methodology,
} from "./methodology";
import { listSequences, upsertSequence } from "../sequences";
import { scanMessage } from "../copy/guardrail";
import type { Motion } from "../core/types";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";

const MIN_PROMOTE = Number(process.env.RECRUITEROS_BD_MIN_PROMOTE ?? 25); // contacted before a challenger can win
const MIN_JUDGE = Number(process.env.RECRUITEROS_BD_MIN_JUDGE ?? 30);     // contacted before a loser is retired
const TARGET_POOL = Number(process.env.RECRUITEROS_BD_POOL ?? 4);         // active variants kept per family

interface Cell { positiveRate: number; contacted: number; booked: number; confident: boolean; }
const ZERO: Cell = { positiveRate: 0, contacted: 0, booked: 0, confident: false };

export interface OptimizerAction {
  family: Family;
  action: "promote" | "retire" | "spawn";
  methodologyId: string;
  detail: string;
}
export interface OptimizeResult {
  motion: Motion;
  actions: OptimizerAction[];
  champions: Partial<Record<Family, string>>;
}

const FAMILIES: Family[] = ["mpc", "consultative"];

/** Run one optimization pass for a (workspace, motion). Safe + idempotent. */
export async function optimizeMotion(workspaceId: string, motion: Motion): Promise<OptimizeResult> {
  const pool = await ensureSeeded(workspaceId, motion);
  const stats = await buildOutreachStats(workspaceId, { motion });
  const byKey = new Map(stats.byVariant.map((d) => [d.key, d]));
  const cell = (family: Family, id: string): Cell => {
    const d = byKey.get(richId(family, id));
    return d ? { positiveRate: d.positiveRate, contacted: d.contacted, booked: d.booked, confident: d.confident } : ZERO;
  };
  const better = (a: Cell, b: Cell) => a.positiveRate > b.positiveRate || (a.positiveRate === b.positiveRate && a.booked > b.booked);

  const actions: OptimizerAction[] = [];
  const champions: Partial<Record<Family, string>> = {};

  for (const family of FAMILIES) {
    let active = pool.filter((m) => m.family === family && m.status !== "retired");
    if (!active.length) continue;

    // Ensure exactly one champion (crown the most-contacted active if none set).
    let champion = active.find((m) => m.status === "champion");
    if (!champion) {
      champion = [...active].sort((a, b) => cell(family, b.id).contacted - cell(family, a.id).contacted)[0];
      await setStatus(workspaceId, motion, family, champion.id, "champion");
    }
    let champCell = cell(family, champion.id);
    const challengers = active.filter((m) => m.id !== champion!.id);

    // PROMOTE: the best challenger that beats the champion with confidence + volume.
    const contender = challengers
      .filter((c) => { const s = cell(family, c.id); return s.confident && s.contacted >= MIN_PROMOTE && better(s, champCell); })
      .sort((a, b) => cell(family, b.id).positiveRate - cell(family, a.id).positiveRate)[0];
    if (contender) {
      await setStatus(workspaceId, motion, family, contender.id, "champion"); // demotes incumbent
      const s = cell(family, contender.id);
      actions.push({ family, action: "promote", methodologyId: contender.id, detail: `${contender.label} ${s.positiveRate}% positive (n=${s.contacted}) beat ${champion.label} ${champCell.positiveRate}%` });
      champion = contender;
      champCell = s;
    }

    // RETIRE: challengers that lose to the champion with confidence + volume.
    for (const c of challengers) {
      if (c.id === champion.id) continue;
      const s = cell(family, c.id);
      if (s.contacted >= MIN_JUDGE && s.confident && s.positiveRate < champCell.positiveRate) {
        await setStatus(workspaceId, motion, family, c.id, "retired", `${s.positiveRate}% vs champion ${champCell.positiveRate}% (n=${s.contacted})`);
        actions.push({ family, action: "retire", methodologyId: c.id, detail: `${c.label} retired: ${s.positiveRate}% positive (n=${s.contacted})` });
      }
    }

    // SPAWN: refill the pool so the system keeps exploring new angles.
    active = (await listMethodologies(workspaceId, motion)).filter((m) => m.family === family && m.status !== "retired");
    const need = TARGET_POOL - active.length;
    if (need > 0) {
      const existing = await listMethodologies(workspaceId, motion);
      const fresh = await generateChallengerAngles(family, need, existing.filter((m) => m.family === family));
      for (const a of fresh) {
        await addMethodology(workspaceId, motion, family, a);
        actions.push({ family, action: "spawn", methodologyId: a.id, detail: `New challenger: ${a.label}` });
      }
    }

    const champ = await getChampion(workspaceId, motion, family);
    if (champ) champions[family] = champ.id;
  }

  // Write the current overall winning content into the live sequence.
  await promoteChampionToSequence(workspaceId, motion).catch(() => { /* best-effort */ });

  return { motion, actions, champions };
}

/** Optimize every motion for a workspace (cadence hook / cron entry). */
export async function optimizeAll(workspaceId: string): Promise<OptimizeResult[]> {
  const out: OptimizeResult[] = [];
  for (const motion of ["bd", "recruiting"] as Motion[]) {
    try { out.push(await optimizeMotion(workspaceId, motion)); } catch { /* skip motion on error */ }
  }
  return out;
}

/**
 * Write the winning champion's latest real content into the motion's active
 * sequence (first email step). Non-destructive: preserves every other step.
 * Picks the family champion with the best captured sample; skips if none.
 */
async function promoteChampionToSequence(workspaceId: string, motion: Motion): Promise<void> {
  const champs = (await Promise.all(FAMILIES.map((f) => getChampion(workspaceId, motion, f)))).filter(
    (m): m is Methodology => !!m && !!m.sampleContent && scanMessage({ subject: m.sampleContent.subject, body: m.sampleContent.body }).ok,
  );
  if (!champs.length) return;
  const champ = champs.sort((a, b) => Date.parse(b.sampleContent!.at) - Date.parse(a.sampleContent!.at))[0];

  const seq = listSequences(workspaceId, motion).find((s) => s.status === "active");
  if (!seq) return;

  const steps = seq.steps.map((s) => ({ ...s }));
  const emailIdx = steps.findIndex((s) => s.channel === "email" || (!s.channel && s.subject != null));
  const patch = { subject: champ.sampleContent!.subject, body: champ.sampleContent!.body };
  if (emailIdx >= 0) steps[emailIdx] = { ...steps[emailIdx], ...patch };
  else steps.unshift({ day: 0, channel: "email", ...patch } as any);

  const tags = Array.from(new Set([...(seq.tags ?? []).filter((t) => !t.startsWith("champion:")), `champion:${champ.family}/${champ.id}`]));
  upsertSequence(workspaceId, { id: seq.id, channel: seq.channel, name: seq.name, motion: seq.motion, status: seq.status, steps, tags, variables: seq.variables });
}

/* ---------------- challenger angle generation ---------------- */

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "angle";

/**
 * Produce up to `n` NEW challenger angles for a family: drains the unused seed
 * bank first (free, curated, on-brand), then asks the LLM for novel angles
 * distinct from everything already tried. Falls back to seeds only on any error.
 */
export async function generateChallengerAngles(
  family: Family, n: number, existing: Methodology[],
): Promise<Array<{ id: string; label: string; angle: string }>> {
  const haveIds = new Set(existing.map((m) => m.id));
  const out: Array<{ id: string; label: string; angle: string }> = [];

  for (const s of SEED_ANGLES[family]) {
    if (out.length >= n) break;
    if (!haveIds.has(s.id)) { out.push(s); haveIds.add(s.id); }
  }
  if (out.length >= n || !process.env.ANTHROPIC_API_KEY) return out.slice(0, n);

  try {
    const want = n - out.length;
    const tried = existing.map((m) => `- ${m.label}: ${m.angle}`).join("\n");
    const familyDesc = family === "mpc"
      ? "the Most Placeable Candidate model (lead with a specific, real, anonymized candidate as the reason to reach out)"
      : "the consultative model (earn attention with a grounded role/industry observation, end on a genuine question, never pitch)";
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 700,
      messages: [{
        role: "user",
        content:
          `You design cold outreach METHODOLOGIES for an expert recruiting firm using ${familyDesc}.\n\n` +
          `Angles already tried (do NOT repeat these):\n${tried || "(none)"}\n\n` +
          `Propose ${want} NEW, genuinely distinct methodology directives. Each is a single instruction telling the writer the strategic angle to take, in the same spirit as the tried ones. They must respect the firm's hard rules (truth is non negotiable, never fabricate a fact/number/person, no dashes, peer-level tone) — the angle is about STRATEGY, not breaking rules.\n\n` +
          `Respond as strict JSON only: [{ "label": string (<=4 words), "angle": string (one sentence directive) }]`,
      }],
    });
    const raw = res.content.find((b) => b.type === "text");
    const text = raw && raw.type === "text" ? raw.text : "[]";
    const a = text.indexOf("["); const b = text.lastIndexOf("]");
    const arr: Array<{ label?: string; angle?: string }> = a >= 0 ? JSON.parse(text.slice(a, b + 1)) : [];
    for (const item of arr) {
      if (out.length >= n) break;
      const label = String(item.label ?? "").trim();
      const angle = String(item.angle ?? "").trim();
      if (!label || !angle) continue;
      let id = slug(label);
      while (haveIds.has(id)) id = `${id}-2`;
      haveIds.add(id);
      out.push({ id, label, angle });
    }
  } catch { /* seeds-only fallback */ }

  return out.slice(0, n);
}
