/**
 * RecruitersOS · BD · Methodology pool (self-learning outreach)
 *
 * The experiment layer (experiment.ts) runs the high-level family A/B: mpc vs
 * consultative. THIS layer goes a level deeper — inside each family it holds a
 * POOL of methodologies (distinct angles: signal-led urgency, contrarian
 * curiosity, cost-of-vacancy math, candidate-led proof, scarcity, ...). Each
 * methodology is a short generation directive the content engine writes in.
 *
 * A prospect's stamped variant becomes a RICH id `${family}::${methodologyId}`,
 * so the existing analytics `byVariant` rollup measures every methodology's
 * positive-reply rate + significance for free. The optimizer (optimizer.ts) then
 * crowns a champion per family, retires losers, and spawns fresh challengers —
 * and the allocator below sends most traffic to the champion while reserving an
 * exploration slice for challengers (epsilon-greedy, stable per prospect).
 *
 * Pool is keyed by (workspaceId, motion) — the queue is motion level, so this is
 * a workspace-wide BD/recruiting pool. Durable like the other stores.
 */

import { nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";
import { variantOf, type Variant } from "./experiment";
import { scanMessage } from "../copy/guardrail";
import type { Motion } from "../core/types";

export type Family = Variant; // "mpc" | "consultative"
export type MethodologyStatus = "champion" | "challenger" | "retired";

export interface Methodology {
  id: string;            // stable within a family, e.g. "cost-of-vacancy"
  family: Family;
  label: string;
  /** The generation directive handed to the content engine for this variant. */
  angle: string;
  status: MethodologyStatus;
  createdAt: string;
  promotedAt?: string;
  retiredAt?: string;
  retiredReason?: string;
  /** Latest real rendered content for this methodology (captured at draft time),
   *  so the winning string can be shown + written into the sequence. */
  sampleContent?: { subject: string; body: string; at: string };
}

/** Exploration share reserved for challengers; the champion gets the rest. */
const EXPLORATION = Number(process.env.RECRUITEROS_BD_EXPLORATION ?? 0.25);

/* ---------------- seed angle bank (useful on day 1, no LLM needed) ---------- */

const SEED: Record<Family, Array<{ id: string; label: string; angle: string }>> = {
  consultative: [
    { id: "status-quo-question", label: "Quiet status-quo question", angle: "One understated observation from their signal, ending on how they're handling the load right now, in house or with help. Low key, high signal, never a pitch." },
    { id: "signal-urgency", label: "Signal-led urgency", angle: "Lead from the specific hiring signal as a symptom whose cost compounds weekly. Imply the gap is expensive without being alarmist. Stay a peer observation." },
    { id: "contrarian-curiosity", label: "Contrarian curiosity", angle: "Open with a mild contrarian take on the obvious assumption about their hire so the reader pauses and wants to agree or push back. Earn the reply through curiosity." },
    { id: "peer-pattern", label: "Peer pattern", angle: "Frame the observation as a pattern you keep seeing at companies at their exact stage. Honest social proof only, never a fabricated statistic." },
    { id: "cost-of-vacancy", label: "Cost-of-vacancy math", angle: "Anchor on the quiet business math of the role staying open: lost output, overloaded team, slipped roadmap. Concrete, but never invent a number." },
  ],
  mpc: [
    { id: "candidate-proof", label: "Candidate-led proof", angle: "Lead with one specific anonymized candidate as the reason for reaching out, tying their proven background to the company's likely open role." },
    { id: "off-market-scarcity", label: "Off-market scarcity", angle: "Frame the candidate as a quiet maybe, not actively looking, open for a short window. Scarcity through truth, never fabricated urgency." },
    { id: "comparable-placement", label: "Comparable placement", angle: "Reference the SHAPE of a comparable placement you've made (no names, no fabricated outcomes) to show you place exactly this profile." },
    { id: "specific-fit-hook", label: "Specific-fit hook", angle: "Open with the single sharpest line of fit between the candidate and the company's exact situation, then a low-friction ask to see the profile." },
    { id: "sample-offer", label: "Low-friction sample", angle: "Offer to send a short anonymized profile or a tiny shortlist with zero commitment, lowering the cost of yes to almost nothing." },
  ],
};

/* ---------------- store ---------------- */

type Pool = Methodology[];
const store: Record<string, Pool> = {}; // key = `${workspaceId}::${motion}`
const SNAP_KEY = "bd_methodologies";
const persist = debouncedSaver(SNAP_KEY, () => store);

let hydrated: Promise<void> | null = null;
export function ensureMethodologyReady(): Promise<void> {
  if (!hydrated) {
    hydrated = dbEnabled()
      ? loadSnapshot<Record<string, Pool>>(SNAP_KEY).then((s) => { if (s) Object.assign(store, s); }).catch(() => {})
      : Promise.resolve();
  }
  return hydrated;
}
void ensureMethodologyReady();

const key = (workspaceId: string, motion: Motion) => `${workspaceId}::${motion}`;

export const richId = (family: Family, methodologyId: string) => `${family}::${methodologyId}`;
export function parseRich(rich: string): { family: Family; methodologyId: string } | null {
  const i = rich.indexOf("::");
  if (i < 0) return null;
  const family = rich.slice(0, i) as Family;
  if (family !== "mpc" && family !== "consultative") return null;
  return { family, methodologyId: rich.slice(i + 2) };
}

/** Seed both family pools the first time a (workspace, motion) is touched. */
export async function ensureSeeded(workspaceId: string, motion: Motion): Promise<Pool> {
  await ensureMethodologyReady();
  const k = key(workspaceId, motion);
  if (store[k]?.length) return store[k];
  const pool: Pool = [];
  for (const family of ["mpc", "consultative"] as Family[]) {
    SEED[family].forEach((s, i) => {
      pool.push({ ...s, family, status: i === 0 ? "champion" : "challenger", createdAt: nowIso() });
    });
  }
  store[k] = pool;
  persist();
  return pool;
}

export async function listMethodologies(workspaceId: string, motion: Motion): Promise<Pool> {
  return ensureSeeded(workspaceId, motion);
}

function activeOf(pool: Pool, family: Family): Methodology[] {
  return pool.filter((m) => m.family === family && m.status !== "retired");
}
function championOf(pool: Pool, family: Family): Methodology | undefined {
  return pool.find((m) => m.family === family && m.status === "champion");
}

/* ---------------- allocation (epsilon-greedy, stable per prospect) ---------- */

/** FNV-1a -> [0,1), seeded so two independent draws per prospect don't correlate. */
function unit(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

export interface Allocation {
  family: Family;
  methodologyId: string;
  angle: string;
  /** The rich variant id to stamp on every send for this prospect. */
  rich: string;
  label: string;
}

/**
 * Pick the family (stable A/B from experiment.ts) and a methodology inside it.
 * Champion gets (1 - EXPLORATION); challengers split EXPLORATION. Deterministic
 * per prospect so re-pulls stay in the same cell — no mixing mid-funnel.
 */
export async function allocate(workspaceId: string, motion: Motion, prospectId: string): Promise<Allocation> {
  const pool = await ensureSeeded(workspaceId, motion);
  const family = variantOf(prospectId);
  const active = activeOf(pool, family);
  const champion = championOf(pool, family) ?? active[0];
  const challengers = active.filter((m) => m.id !== champion?.id);

  let chosen = champion;
  if (challengers.length && unit(`${prospectId}|explore`) < EXPLORATION) {
    chosen = challengers[Math.floor(unit(`${prospectId}|which`) * challengers.length)] ?? champion;
  }
  const m = chosen ?? active[0];
  return { family, methodologyId: m.id, angle: m.angle, rich: richId(family, m.id), label: m.label };
}

/* ---------------- mutations (used by the optimizer) ------------------------- */

export async function recordSample(
  workspaceId: string, motion: Motion, rich: string, content: { subject: string; body: string },
): Promise<void> {
  await ensureMethodologyReady();
  const parsed = parseRich(rich);
  if (!parsed) return;
  const pool = store[key(workspaceId, motion)];
  const m = pool?.find((x) => x.family === parsed.family && x.id === parsed.methodologyId);
  if (!m) return;
  // Fail-safe: never capture a rule-violating draft as the winning sample, so the
  // optimizer can't later pin off-voice copy to the top of the sequence.
  if (!scanMessage({ subject: content.subject, body: content.body }).ok) return;
  m.sampleContent = { subject: content.subject, body: content.body, at: nowIso() };
  persist();
}

export async function setStatus(
  workspaceId: string, motion: Motion, family: Family, methodologyId: string,
  status: MethodologyStatus, reason?: string,
): Promise<void> {
  await ensureMethodologyReady();
  const pool = store[key(workspaceId, motion)];
  const m = pool?.find((x) => x.family === family && x.id === methodologyId);
  if (!m) return;
  // One champion per family: demote the incumbent first.
  if (status === "champion") {
    for (const x of pool!) if (x.family === family && x.status === "champion") x.status = "challenger";
    m.promotedAt = nowIso();
  }
  if (status === "retired") { m.retiredAt = nowIso(); m.retiredReason = reason; }
  m.status = status;
  persist();
}

export async function addMethodology(
  workspaceId: string, motion: Motion, family: Family,
  m: { id: string; label: string; angle: string },
): Promise<void> {
  await ensureMethodologyReady();
  const pool = store[key(workspaceId, motion)] ?? (store[key(workspaceId, motion)] = []);
  if (pool.some((x) => x.family === family && x.id === m.id)) return; // de-dupe
  pool.push({ ...m, family, status: "challenger", createdAt: nowIso() });
  persist();
}

/** Get a family's champion (with its captured winning content sample, if any). */
export async function getChampion(workspaceId: string, motion: Motion, family: Family): Promise<Methodology | undefined> {
  const pool = await ensureSeeded(workspaceId, motion);
  return championOf(pool, family);
}

export { SEED as SEED_ANGLES };
