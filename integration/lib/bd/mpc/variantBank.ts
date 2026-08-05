/**
 * RecruitersOS · BD · MPC · Pre-generated variant bank (the zero-cost voice layer)
 *
 * WHY THIS EXISTS. The per-send humanizer (humanizer.ts) paid a Haiku call for EVERY Day-0 opener,
 * which at volume is real money for work that never depended on the recipient: the AI only ever
 * varies PHRASING, never facts (its truth gate enforces exactly that). So the rewrite belongs at the
 * TEMPLATE level, done once, not at the send level, done 150k times a month. This module:
 *
 *   1. GENERATION (weekly, ~50 small Haiku calls, pennies): for each of the 50 MPC templates,
 *      produce N rewrites of the template body with every {{Merge_Token}} kept intact, run each
 *      through the same naturalness + truth discipline the humanizer enforced (banned phrases,
 *      no em/en dash, token-set equality so no fact slot is ever dropped or invented, one soft
 *      question, bounded length), and store the survivors in a JSON bank on the data volume.
 *
 *   2. SEND TIME (free, no network): pick a gate-approved variant body for this prospect
 *      (seeded, so resends are idempotent), render it through the normal renderTouch merge-fill,
 *      re-run the render guard on the result, and hand it back. Any miss (no bank yet, no entry
 *      for this template, guard reject) returns null and the deterministic copy sends unchanged.
 *      Same contract as the humanizer: this layer can only IMPROVE copy, never break a send.
 *
 * Variety math: 50 templates x ~16 variants x spintax x seeded per-prospect selection is far more
 * surface diversity than the per-send rewrite achieved, at ~$2/month instead of ~$200+.
 *
 * Env:
 *   MPC_VARIANTS=0|false|off|no     hard opt-out (send path AND refresh become no-ops)
 *   MPC_VARIANTS_PER_TEMPLATE       target variants per template (default 16)
 *   MPC_VARIANTS_TTL_DAYS           refresh age in days (default 7)
 *   MPC_HUMANIZER_MODEL / RECRUITEROS_EMAIL_MODEL   model override (default claude-haiku-4-5)
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { CampaignModelTouch, Prospect } from "../../core/types";
import { MPC_TEMPLATES, SIGN } from "./templates";
import { naturalnessViolations } from "./humanizer";

/* ------------------------------------------------------------------ *
 * Pure helpers (exported for tests)                                   *
 * ------------------------------------------------------------------ */

/** FNV-1a hash of the raw template body: the bank key. A template edit changes the hash, so the
 *  stale entry simply stops matching and the changed template regenerates on the next refresh. */
export function bankKey(templateBody: string): string {
  let h = 2166136261;
  const s = templateBody || "";
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/** Seeded pick (same FNV idiom as resolve.ts) so a given prospect always gets the same variant. */
function pickIndex(len: number, seed: string): number {
  if (len <= 0) return 0;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % len;
}

/** The lowercase set of {{Merge_Token}} names referenced by a text. */
export function tokensOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of (text || "").matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) out.add(m[1].toLowerCase());
  return out;
}

/** Split a template body into its core and the standing sign-off suffix. Every MPC template ends
 *  with SIGN; the model never sees or writes the sign-off (we re-append it), so {{Your_Name}} and
 *  its spintax survive generation untouched. */
export function splitSignOff(body: string): { core: string; sign: string } {
  const b = body || "";
  if (b.endsWith(SIGN)) return { core: b.slice(0, b.length - SIGN.length), sign: SIGN };
  // Fallback: treat a trailing line that carries {{Your_Name}} as the sign-off.
  const idx = b.lastIndexOf("\n");
  if (idx > 0 && /\{\{\s*Your_Name\s*\}\}/i.test(b.slice(idx))) return { core: b.slice(0, idx), sign: b.slice(idx) };
  return { core: b, sign: "" };
}

/** First-words fingerprint of a body (greeting skipped), for dedupe across a template's variants. */
export function openingFp(core: string): string {
  const firstLine = (core.split("\n").find((l) => l.trim()) || core)
    .toLowerCase()
    .replace(/\{\{\s*[a-z0-9_]+\s*\}\}/g, "x")
    .replace(/[^a-z0-9\s]/g, " ");
  const w = firstLine.split(/\s+/).filter(Boolean);
  const start = ["hi", "hey", "hello"].includes(w[0]) ? 2 : 0;
  return w.slice(start, start + 6).join(" ");
}

/**
 * TEMPLATE-LEVEL TRUTH + NATURALNESS GATE. A candidate rewrite of `sourceCore` is only bankable if
 * it could never say something the source couldn't:
 *   - identical token SET (every fact slot survives; no new slot is invented)
 *   - no banned phrase, no em/en dash (the humanizer's naturalness gate, reused verbatim)
 *   - no stray braces beyond {{tokens}} (a leftover spin group would reach a prospect literally)
 *   - exactly one question (the single soft CTA)
 *   - no link, no digit the source didn't have (a template-level number would be a fabrication)
 *   - bounded length either way (no runaway rewrite, no collapsed one)
 * Returns the list of violations; empty = bankable.
 */
export function variantViolations(sourceCore: string, candidateCore: string): string[] {
  const out: string[] = [];
  const cand = (candidateCore || "").trim();
  if (!cand) return ["empty"];

  for (const v of naturalnessViolations(cand)) out.push(`naturalness:${v}`);

  const want = tokensOf(sourceCore);
  const got = tokensOf(cand);
  for (const t of want) if (!got.has(t)) out.push(`token_missing:${t}`);
  for (const t of got) if (!want.has(t)) out.push(`token_invented:${t}`);

  if (cand.replace(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g, "").match(/[{}|]/)) out.push("stray_brace");
  const qs = (cand.match(/\?/g) || []).length;
  if (qs !== 1) out.push(`question_count:${qs}`);
  if (/https?:\/\//i.test(cand)) out.push("url");

  const srcDigits = new Set((sourceCore.match(/\d+/g) || []));
  for (const d of (cand.match(/\d+/g) || [])) if (!srcDigits.has(d)) out.push(`invented_number:${d}`);

  const len = cand.length, srcLen = (sourceCore || "").trim().length;
  if (len > srcLen * 1.6 + 40) out.push("too_long");
  if (len < Math.max(40, srcLen * 0.45)) out.push("too_short");
  if ((cand.match(/\n/g) || []).length > 2) out.push("too_many_lines");

  return out;
}

/* ------------------------------------------------------------------ *
 * Storage                                                             *
 * ------------------------------------------------------------------ */

export interface BankEntry {
  templateId: string;
  /** Raw template body at generation time (hash source; lets a human diff drift). */
  source: string;
  /** Full, ready-to-render bodies: gate-approved core + the standing SIGN suffix. */
  variants: string[];
  generatedAt: string;
}

export interface VariantBank {
  version: 1;
  model: string;
  generatedAt: string;
  entries: Record<string, BankEntry>;
}

function dataDir(): string {
  return process.env.ROS_DATA_DIR || (process.env.NODE_ENV === "production" ? "/data" : path.join(process.cwd(), ".data"));
}
export function bankPath(): string {
  return path.join(dataDir(), "mpc-variant-bank.json");
}

let cache: { bank: VariantBank | null; mtimeMs: number; checkedAt: number } | null = null;

/** Test hook: drop the in-process bank cache so the next loadBank() re-reads from disk. */
export function resetBankCache(): void { cache = null; }

/** Read the bank with a light in-process cache (mtime-checked at most every 30s), so the send loop
 *  never pays a disk read per prospect but still picks up a fresh bank within seconds. */
export async function loadBank(): Promise<VariantBank | null> {
  const now = Date.now();
  if (cache && now - cache.checkedAt < 30_000) return cache.bank;
  try {
    const st = await fs.stat(bankPath());
    if (cache && cache.mtimeMs === st.mtimeMs) { cache.checkedAt = now; return cache.bank; }
    const bank = JSON.parse(await fs.readFile(bankPath(), "utf8")) as VariantBank;
    cache = { bank: bank?.version === 1 && bank.entries ? bank : null, mtimeMs: st.mtimeMs, checkedAt: now };
  } catch {
    cache = { bank: null, mtimeMs: 0, checkedAt: now };
  }
  return cache.bank;
}

async function saveBank(bank: VariantBank): Promise<void> {
  const p = bankPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(bank, null, 1), "utf8");
  await fs.rename(tmp, p);
  cache = null; // next loadBank() re-reads
}

export function variantsEnabled(): boolean {
  return !["0", "false", "no", "off"].includes((process.env.MPC_VARIANTS || "").toLowerCase());
}

/* ------------------------------------------------------------------ *
 * Send path                                                           *
 * ------------------------------------------------------------------ */

let lastKick = 0;

/**
 * Swap the Day-0 MPC opener body for a banked variant, rendered through the normal merge-fill and
 * re-checked by the render guard. Returns the rendered { subject, body, tokens } or null (caller
 * keeps the deterministic render). Never throws. Free: no network on this path.
 */
export async function variantRender(
  touch: CampaignModelTouch,
  p: Partial<Prospect>,
  emailStep: number,
): Promise<{ subject?: string; body: string; tokens: Record<string, string> } | null> {
  if (!variantsEnabled()) return null;
  const bank = await loadBank();
  const entry = bank?.entries[bankKey(touch.body)];
  if (!entry?.variants?.length) {
    // No bank (first boot) or a just-edited template: nudge a background refresh at most once per
    // 6h per process, and let the deterministic copy send meanwhile.
    if (Date.now() - lastKick > 6 * 3600_000 && process.env.ANTHROPIC_API_KEY) {
      lastKick = Date.now();
      void refreshVariantBank().catch(() => { /* best-effort */ });
    }
    return null;
  }

  const { renderTouch } = await import("../../automation/model");
  const { guardRenderedTouch } = await import("../../copy/renderGuard");

  // Seeded walk: start at this prospect's stable pick; if a candidate fails the guard (it should
  // not, they were gated at generation, but data-dependent renders can surprise), try the next.
  const start = pickIndex(entry.variants.length, `${p.id || ""}:${touch.key || ""}`);
  for (let i = 0; i < Math.min(3, entry.variants.length); i++) {
    const body = entry.variants[(start + i) % entry.variants.length];
    try {
      const r = renderTouch({ ...touch, body }, p, { emailStep });
      const guard = guardRenderedTouch({ channel: touch.channel, action: touch.action, emailStep, subject: r.subject, body: r.body, tokens: r.tokens });
      if (!guard.ok) continue;
      if (naturalnessViolations(r.body).length) continue;
      return r;
    } catch { continue; }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Generation (weekly)                                                 *
 * ------------------------------------------------------------------ */

const GEN_STYLE = [
  "You rewrite a recruiter's short cold-email TEMPLATE so each rewrite reads like a real person typed it quickly, not a campaign.",
  "The template contains merge placeholders like {{First_Name}} or {{Open_Role}} that are filled with real facts later.",
  "HARD RULES:",
  "- Keep every {{Placeholder}} EXACTLY as written (same spelling, same casing, double braces). Each placeholder in the original must appear in every rewrite. Never invent a new placeholder.",
  "- If the template contains a choice group like {this|that}, pick ONE of the options as plain text. Your output must contain no single braces or pipes, only {{Placeholder}} tokens.",
  "- Never add a fact, a number, a link, or a name. You are rearranging phrasing only.",
  "- Lowercase and casual. Use contractions. Read like a quick note.",
  "- No greeting cliches: never 'I hope this finds you', 'I wanted to reach out', 'just circling back', 'touch base'.",
  "- No corporate words: leverage, synergy, cutting-edge, fast-paced, game-changer.",
  "- Never use an em-dash or en-dash. Use a comma, period, or parentheses instead.",
  "- 2 to 4 short sentences. Exactly ONE soft question, at the close.",
  "- Every rewrite must OPEN differently from the original and from each other.",
  "- Do not write a sign-off line; it is appended automatically.",
  'Return STRICT JSON only, no prose: { "variants": [string, ...] }.',
].join("\n");

export interface RefreshReport {
  skipped?: string;
  model?: string;
  refreshed: number;
  kept: number;
  rejected: number;
  pruned: number;
  templates: Array<{ id: string; kept: number; rejected: number; error?: string }>;
}

function ttlMs(): number {
  const days = Number(process.env.MPC_VARIANTS_TTL_DAYS) || 7;
  return Math.max(1, days) * 24 * 3600_000;
}
function perTemplateTarget(): number {
  return Math.min(32, Math.max(6, Number(process.env.MPC_VARIANTS_PER_TEMPLATE) || 16));
}
/** Below this many surviving variants an entry is treated as incomplete and regenerates. */
const MIN_KEEP = 4;

let refreshing: Promise<RefreshReport> | null = null;

/**
 * (Re)generate the bank. Self-gating: no-op without a key, when MPC_VARIANTS is off, or when every
 * current template already has a fresh, full entry. Safe to call from the hourly cron; it only does
 * real work about once a week (or when a template is edited). Concurrent calls share one run.
 */
export function refreshVariantBank(opts?: { force?: boolean }): Promise<RefreshReport> {
  if (refreshing) return refreshing;
  refreshing = doRefresh(opts).finally(() => { refreshing = null; });
  return refreshing;
}

async function doRefresh(opts?: { force?: boolean }): Promise<RefreshReport> {
  const none: RefreshReport = { refreshed: 0, kept: 0, rejected: 0, pruned: 0, templates: [] };
  if (!variantsEnabled()) return { ...none, skipped: "MPC_VARIANTS off" };
  if (!process.env.ANTHROPIC_API_KEY) return { ...none, skipped: "no ANTHROPIC_API_KEY" };

  const model = process.env.MPC_HUMANIZER_MODEL ?? process.env.RECRUITEROS_EMAIL_MODEL ?? "claude-haiku-4-5";
  const existing = (await loadBank()) ?? { version: 1 as const, model, generatedAt: "", entries: {} };
  const now = Date.now();

  const work = MPC_TEMPLATES.filter((t) => {
    if (opts?.force) return true;
    const e = existing.entries[bankKey(t.body)];
    if (!e || e.variants.length < MIN_KEEP) return true;
    return now - (Date.parse(e.generatedAt || "") || 0) > ttlMs();
  });

  // Prune entries whose template no longer exists (edited or removed), even on a no-op tick.
  const live = new Set(MPC_TEMPLATES.map((t) => bankKey(t.body)));
  let pruned = 0;
  for (const k of Object.keys(existing.entries)) if (!live.has(k)) { delete existing.entries[k]; pruned++; }

  if (!work.length) {
    if (pruned) await saveBank({ ...existing, model: existing.model || model });
    return { ...none, skipped: "fresh", pruned, model };
  }

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const target = perTemplateTarget();
  const report: RefreshReport = { refreshed: 0, kept: 0, rejected: 0, pruned, templates: [], model };

  for (const t of work) {
    const { core, sign } = splitSignOff(t.body);
    const accepted: string[] = [];
    const fps = new Set<string>([openingFp(core)]); // never bank the template's own opening
    let rejected = 0;
    let error: string | undefined;

    try {
      for (let attempt = 0; attempt < 2 && accepted.length < target; attempt++) {
        const ask = target - accepted.length + (attempt === 0 ? 4 : 6); // over-ask; the gate trims
        const nudge = attempt === 0 ? "" :
          `\nDo not open any rewrite with these already-used starts: ${[...fps].filter(Boolean).slice(0, 20).join(" | ")}`;
        const resp = await client.messages.create(
          {
            model,
            max_tokens: 4000,
            temperature: 1,
            system: GEN_STYLE,
            messages: [{ role: "user", content: `Write ${ask} distinct rewrites of this template.${nudge}\n\nTEMPLATE:\n${core}` }],
          },
          { timeout: 60_000 },
        );
        const text = resp.content.map((c) => ("text" in c ? c.text : "")).join("");
        const s = text.indexOf("{"), e = text.lastIndexOf("}");
        if (s < 0 || e < 0) continue;
        let parsed: { variants?: unknown };
        try { parsed = JSON.parse(text.slice(s, e + 1)); } catch { continue; }
        for (const raw of Array.isArray(parsed.variants) ? parsed.variants : []) {
          if (accepted.length >= target) break;
          const cand = String(raw ?? "").trim();
          if (variantViolations(core, cand).length) { rejected++; continue; }
          const fp = openingFp(cand);
          if (fp && fps.has(fp)) { rejected++; continue; }
          fps.add(fp);
          accepted.push(cand + sign);
        }
      }
    } catch (e: any) {
      error = e?.message ?? "generation_failed";
    }

    if (accepted.length >= MIN_KEEP) {
      existing.entries[bankKey(t.body)] = {
        templateId: t.id,
        source: t.body,
        variants: accepted,
        generatedAt: new Date().toISOString(),
      };
      report.refreshed++;
    }
    // Below MIN_KEEP: keep whatever prior entry exists (or nothing); the next tick retries.
    report.kept += accepted.length;
    report.rejected += rejected;
    report.templates.push({ id: t.id, kept: accepted.length, rejected, ...(error ? { error } : {}) });
  }

  await saveBank({ version: 1, model, generatedAt: new Date().toISOString(), entries: existing.entries });
  return report;
}

/** Summary for the CLI / status surfaces. */
export async function bankStatus(): Promise<{ path: string; templates: number; covered: number; variants: number; oldest?: string; model?: string }> {
  const bank = await loadBank();
  const live = MPC_TEMPLATES.map((t) => bankKey(t.body));
  const entries = live.map((k) => bank?.entries[k]).filter(Boolean) as BankEntry[];
  return {
    path: bankPath(),
    templates: MPC_TEMPLATES.length,
    covered: entries.length,
    variants: entries.reduce((n, e) => n + e.variants.length, 0),
    oldest: entries.map((e) => e.generatedAt).sort()[0],
    model: bank?.model,
  };
}
