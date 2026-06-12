/**
 * RecruiterOS · Content Library — Resolver
 *
 * The pull engine. Given parameters (function × seniority × industry × signal ×
 * motion) it selects the right fragment packs, composes them into the multi-channel
 * touch templates, and returns ready-to-send copy. Pure + deterministic: no LLM
 * call, no network, microseconds per lead. The richness was authored up front in
 * the packs; this just assembles it for THIS person.
 *
 * Fallback chain guarantees a non-empty, on-voice message for ANY input:
 *   industry  -> inferred from text -> "general"
 *   function  -> "other"
 *   signal    -> generic timing opener
 */

import { INDUSTRY_PACKS } from "./industries";
import { FUNCTION_PACKS } from "./functions";
import { SIGNAL_ANGLES } from "./signals";
import { SENIORITY_TONE } from "./tone";
import { TOUCH_TEMPLATES } from "./templates";
import { classifyTitle, type JobFunction, type Seniority } from "../../signals/filters";

/** Lenient function inference used only when the shared classifier returns "other"
 *  (its word-boundary regex misses common forms like "Engineering" / "Eng Lead").
 *  Non-invasive: we never override a confident classification. */
const FUNCTION_FALLBACK: Array<[JobFunction, RegExp]> = [
  ["data", /\bdata\b|machine learning|\bml\b|analytics|data scien/i],
  ["engineering", /engineer|developer|\bdev\b|software|swe|devops|\bsre\b|backend|front.?end|full.?stack|programmer|infrastructure|platform eng/i],
  ["product", /product/i],
  ["design", /design|\bux\b|\bui\b|creative/i],
  ["sales", /sales|account exec|\bae\b|\bsdr\b|\bbdr\b|revenue|business development|biz dev/i],
  ["marketing", /marketing|growth|brand|demand gen|content|\bseo\b|comms/i],
  ["finance", /financ|account|controller|fp&a|treasur/i],
  ["people_hr", /recruit|talent|people|human resources|\bhr\b/i],
  ["customer_success", /customer success|\bcsm\b|support|account manager/i],
  ["legal", /legal|counsel|attorney|compliance/i],
  ["operations", /operations|\bops\b|program manager|project manager|supply chain|logistics/i],
  ["executive", /\bceo\b|\bcoo\b|\bcfo\b|\bcto\b|\bcmo\b|chief|founder|president|owner|managing director|general manager/i],
];
function refineFunction(title: string, base: JobFunction): JobFunction {
  if (base !== "other") return base;
  for (const [k, re] of FUNCTION_FALLBACK) if (re.test(title)) return k;
  return "other";
}
import type {
  ContentQuery, CraftedSequence, CraftedTouch, IndustryKey, Motion,
  TouchTemplate, IndustryPack, FunctionPack,
} from "./taxonomy";

/* ------------------------------------------------------------------ */
/* Industry resolution                                                 */
/* ------------------------------------------------------------------ */

const INDUSTRY_INFER: Array<[IndustryKey, RegExp]> = [
  ["healthcare", /\b(health|medical|clinical|patient|biotech|pharma|hospital|care)\b/i],
  ["fintech", /\b(fintech|payments?|banking|lending|trading|crypto|insurance|insurtech|wealth)\b/i],
  ["cybersecurity", /\b(security|cyber|infosec|threat|identity|appsec)\b/i],
  ["ai_ml", /\b(\bai\b|artificial intelligence|machine learning|\bml\b|llm|generative)\b/i],
  ["ecommerce", /\b(ecommerce|e-commerce|retail|marketplace|d2c|consumer goods|shopify)\b/i],
  ["edtech", /\b(edtech|education|learning|tutoring|university|school)\b/i],
  ["logistics", /\b(logistics|supply chain|freight|delivery|fleet|warehouse|shipping)\b/i],
  ["gaming", /\b(gaming|games|esports|game studio)\b/i],
  ["climate", /\b(climate|clean ?tech|energy|solar|sustainab|carbon|renewable)\b/i],
  ["saas", /\b(saas|b2b software|platform|api|developer tools|cloud|software)\b/i],
];

/** Resolve any industry input (a known key, a free-text string, or nothing) to a key. */
function resolveIndustry(input?: string): { key: IndustryKey; fallback: boolean } {
  if (input) {
    const lc = String(input).toLowerCase().trim();
    if (lc in INDUSTRY_PACKS) return { key: lc as IndustryKey, fallback: false };
    for (const [key, re] of INDUSTRY_INFER) if (re.test(lc)) return { key, fallback: false };
  }
  return { key: "general", fallback: true };
}

/* ------------------------------------------------------------------ */
/* Deterministic varied picker                                         */
/* ------------------------------------------------------------------ */

/** Stable string hash (djb2) so the same lead+slot always picks the same fragment,
 *  but different leads/slots/touches vary — copy never repeats across the cadence. */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

function pick<T>(arr: T[] | undefined, salt: string): T | undefined {
  if (!arr || arr.length === 0) return undefined;
  return arr[hash(salt) % arr.length];
}

/* ------------------------------------------------------------------ */
/* Slot rendering                                                      */
/* ------------------------------------------------------------------ */

function genericOpener(motion: Motion): string {
  return motion === "recruiting"
    ? "Your background caught my eye and the timing felt worth a note."
    : "Something about what {company} is building made this worth a short note.";
}

/** Build the slot map for one touch. `seed` keeps picks stable per lead but varied
 *  across touches (we fold the touch id into each slot's salt). */
function slotsFor(
  q: ContentQuery,
  ind: IndustryPack,
  fnPack: FunctionPack,
  motion: Motion,
  touchId: string,
  seed: string,
): Record<string, string> {
  const p = q.prospect ?? {};
  const first = p.firstName || p.fullName?.split(/\s+/)[0] || "there";
  const signalAngle = q.signal ? SIGNAL_ANGLES[q.signal] : undefined;
  const opener = signalAngle
    ? (motion === "recruiting" ? signalAngle.recruiting : signalAngle.bd)
    : genericOpener(motion);
  const tone = SENIORITY_TONE[q.seniority ?? "mid"] ?? SENIORITY_TONE.mid;

  // BD vs recruiting flips a couple of slots to the right audience.
  const functionHook = motion === "recruiting"
    ? pick(fnPack.recruitingAngle, seed + touchId + "fh")
    : pick(fnPack.hooks, seed + touchId + "fh");
  const industryValue = motion === "recruiting"
    ? pick(ind.recruitingPitch, seed + touchId + "iv")
    : pick(ind.valueAngles, seed + touchId + "iv");

  const map: Record<string, string> = {
    first_name: first,
    full_name: p.fullName || first,
    company: p.company || "your team",
    title: p.title || "",
    role: fnPack.label.toLowerCase(),
    industry: ind.label,
    signal_opener: opener,
    industry_context: ind.context,
    industry_pain: pick(ind.painPoints, seed + touchId + "ip") || "",
    industry_value: industryValue || "",
    function_pain: pick(fnPack.painPoints, seed + touchId + "fp") || "",
    function_hook: functionHook || "",
    cares_about: pick(fnPack.caresAbout, seed + touchId + "ca") || "",
    proof: pick(ind.proofPoints, seed + touchId + "pr") || "",
    vocab: pick(ind.vocabulary, seed + touchId + "vo") || "",
    cta: tone.cta,
    sender: q.sender || "{{sender}}",
    calendar_link: q.calendarLink || "{{calendar_link}}",
    callback_number: q.callbackNumber || "{{callback_number}}",
  };
  return map;
}

/** Single-brace tokens our fragment authors use ({company}, {role}, ...). Numeric
 *  proof placeholders ({pct}, {weeks}, {n}, ...) are intentionally NOT in this set —
 *  they stay as fill-ins so we never ship a fabricated statistic. */
const SAFE_SINGLE = new Set(["company", "role", "first_name", "full_name", "industry", "title", "sender"]);

/** Capitalize the first letter of each sentence (start, and after . ! ?). */
function sentenceCase(s: string): string {
  return s.replace(/(^|[.!?]\s+)([a-z])/g, (_m, lead: string, c: string) => lead + c.toUpperCase());
}

/** Substitute {{slot}} (and known {single}) tokens, then clean up any gaps. */
function render(template: string, slots: Record<string, string>): string {
  let out = template.replace(/\{\{(\w+)\}\}/g, (_m, k: string) =>
    Object.prototype.hasOwnProperty.call(slots, k) ? slots[k] : `{{${k}}}`,
  );
  // Single-brace tokens that came in FROM the fragments themselves.
  out = out.replace(/\{(\w+)\}/g, (m, k: string) =>
    SAFE_SINGLE.has(k) && Object.prototype.hasOwnProperty.call(slots, k) ? slots[k] : m,
  );
  out = out
    // Drop list bullets that resolved to nothing.
    .replace(/^[ \t]*[-*][ \t]*$/gm, "")
    // Collapse 3+ newlines, and trim trailing spaces per line.
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    // Tidy punctuation left dangling by an empty slot.
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;:])\1+/g, "$1")
    .replace(/ {2,}/g, " ")
    .trim();
  return sentenceCase(out);
}

function clamp(s: string, max?: number): string {
  if (!max || s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

function renderTouch(
  t: TouchTemplate, q: ContentQuery, ind: IndustryPack, fnPack: FunctionPack, motion: Motion, seed: string,
): CraftedTouch {
  const slots = slotsFor(q, ind, fnPack, motion, t.id, seed);
  return {
    id: t.id,
    channel: t.channel,
    action: t.action,
    day: t.day,
    name: t.name,
    subject: t.subject ? render(t.subject, slots) : undefined,
    body: clamp(render(t.body, slots), t.maxChars),
    hotOnly: t.hotOnly,
  };
}

/**
 * Pull the full multi-channel sequence for a lead, by parameters. The warmth gate
 * mirrors RecruiterOS: hot-only touches (voicemail drop, LinkedIn voice note) are
 * included only when warmth >= the voice threshold (default 80).
 */
export function craftSequence(q: ContentQuery): CraftedSequence {
  const motion: Motion = q.motion === "recruiting" ? "recruiting" : "bd";
  const { key: industryKey, fallback: industryFallback } = resolveIndustry(q.industry as string);
  const fn: JobFunction = (q.function && FUNCTION_PACKS[q.function]) ? q.function : "other";
  const functionFallback = fn !== q.function;
  const seniority: Seniority = q.seniority ?? "mid";
  const ind = INDUSTRY_PACKS[industryKey];
  const fnPack = FUNCTION_PACKS[fn];
  const warmth = Number.isFinite(q.warmth as number) ? (q.warmth as number) : 50;
  const threshold = Number.isFinite(q.voiceThreshold as number) ? (q.voiceThreshold as number) : 80;
  const seed = `${industryKey}|${fn}|${seniority}|${q.signal ?? "none"}|${q.prospect?.company ?? ""}`;

  const touches = TOUCH_TEMPLATES
    .filter((t) => !t.motions || t.motions.includes(motion))
    .filter((t) => !t.hotOnly || warmth >= threshold)
    .map((t) => renderTouch(t, q, ind, fnPack, motion, seed))
    .sort((a, b) => a.day - b.day);

  return {
    resolved: {
      function: fn, seniority, industry: industryKey, signal: q.signal, motion,
      industryFallback, functionFallback, signalFallback: !q.signal || !SIGNAL_ANGLES[q.signal],
    },
    touches,
  };
}

/** Render a single touch by template id (or the first of a channel). */
export function craftTouch(q: ContentQuery, idOrChannel: string): CraftedTouch | null {
  const seq = craftSequence(q);
  return seq.touches.find((t) => t.id === idOrChannel || t.channel === idOrChannel) ?? null;
}

/**
 * Convenience entry: pull from a prospect-shaped object. Classifies the title into
 * function + seniority (reusing the signals-engine classifier) and infers industry,
 * so callers can hand in raw enriched-lead data and get ready-to-send copy back.
 */
export function pullForProspect(input: {
  title?: string;
  industry?: string;
  company?: string;
  firstName?: string;
  fullName?: string;
  location?: string;
  headline?: string;
  warmth?: number;
  motion?: Motion;
  signal?: ContentQuery["signal"];
  voiceThreshold?: number;
  sender?: string;
  calendarLink?: string;
  callbackNumber?: string;
}): CraftedSequence {
  const titleText = input.title || input.headline || "";
  const intel = classifyTitle(titleText);
  return craftSequence({
    function: refineFunction(titleText, intel.function),
    seniority: intel.seniority,
    industry: input.industry || input.company || input.headline,
    signal: input.signal,
    motion: input.motion,
    warmth: input.warmth,
    voiceThreshold: input.voiceThreshold,
    prospect: {
      firstName: input.firstName,
      fullName: input.fullName,
      company: input.company,
      title: input.title,
      location: input.location,
      headline: input.headline,
    },
    sender: input.sender,
    calendarLink: input.calendarLink,
    callbackNumber: input.callbackNumber,
  });
}

/** Library coverage, for introspection / the owner console. */
export function libraryCoverage() {
  return {
    industries: Object.keys(INDUSTRY_PACKS).length,
    functions: Object.keys(FUNCTION_PACKS).length,
    signals: Object.keys(SIGNAL_ANGLES).length,
    seniorityTiers: Object.keys(SENIORITY_TONE).length,
    touchTemplates: TOUCH_TEMPLATES.length,
    channels: Array.from(new Set(TOUCH_TEMPLATES.map((t) => t.channel))),
  };
}
