/**
 * RecruitersOS · BD · MPC · AI humanizer (the dynamic voice layer)
 *
 * The deterministic engine (templates + spintax + resolve) produces copy that is TRUE and safe but
 * finite in its phrasings. This layer makes each Day-0 opener read like a real person typed it fast,
 * dynamically, without ever giving up truthfulness or deliverability. The design principle:
 *
 *     THE AI REARRANGES REAL FACTS. IT NEVER INVENTS THEM.
 *
 * So the flow is: resolve the real facts deterministically → render the safe template → hand that
 * rendered note to a fast model to REWRITE in a natural voice → run it through a hard gate that
 * rejects anything robotic or untruthful → send. Any failure (no key, disabled, gate reject, API
 * error) returns null and the caller sends the deterministic version. It can only ever IMPROVE copy;
 * it can never break a send.
 *
 * Two layers live here:
 *   - humanizeMpc(): the AI rewrite (Haiku, style-constrained, cached), env-gated behind MPC_HUMANIZER.
 *   - the naturalness GATE (naturalnessViolations + truthPreserved): pure, deterministic, unit-testable,
 *     and useful on its own — it's what guarantees no LLM tell and no fabricated fact ever ships.
 */

import type { Prospect } from "../../core/types";
import { buildMpcTokens } from "./resolve";

/* ------------------------------------------------------------------ *
 * Layer 3 — the naturalness gate (pure, deterministic, no network)    *
 * ------------------------------------------------------------------ */

/**
 * The dead giveaways that a machine (or a template mill) wrote it. If any appear, the copy is NOT
 * human and the gate rejects it. Kept lowercase; matched case-insensitively as whole phrases. The
 * em-dash is here on purpose — it's both an AI tell and a standing house-style ban.
 */
export const BANNED_PHRASES: string[] = [
  "i hope this email finds you",
  "i hope this finds you",
  "i wanted to reach out",
  "i am reaching out",
  "reaching out to you",
  "just circling back",
  "circling back",
  "touch base",
  "touching base",
  "i trust this",
  "per my last",
  "as a recruiter",
  "leverage",
  "synergy",
  "synergies",
  "in today's",
  "fast-paced",
  "cutting-edge",
  "game-changer",
  "game changer",
  "at the end of the day",
  "delighted to",
  "i am thrilled",
  "i'm thrilled",
  "hope you're doing well",
  "hope you are doing well",
  "to whom it may concern",
];

/** Characters that read as machine-typed / on-brand-banned: em-dash and its unicode cousins. */
const BANNED_CHARS = /[—–]/; // em-dash, en-dash

/**
 * Return the list of naturalness violations in `text` (empty = clean). A non-empty result means the
 * copy reads like a bot and must not send. Cheap enough to run on every candidate.
 */
export function naturalnessViolations(text: string): string[] {
  const hay = (text || "").toLowerCase();
  const hits = BANNED_PHRASES.filter((p) => hay.includes(p));
  if (BANNED_CHARS.test(text || "")) hits.push("em-dash");
  return hits;
}

/** Every run of digits in the text (e.g. "142", "six" is NOT a digit-run). Order-independent bag. */
function numberBag(text: string): string[] {
  return (text.match(/\d[\d,.%]*/g) || []).map((s) => s.replace(/[.,%]+$/, ""));
}

/**
 * TRUTH GATE. The rewrite is only allowed to rephrase — never to fabricate. This enforces both
 * directions of that:
 *   - every `mustAppear` fact (name, company, the open seat, the sign-off, the destination city)
 *     still appears verbatim, so the AI didn't quietly drop or swap a hard fact; and
 *   - the candidate introduces NO number the reference didn't already contain, so it can never
 *     invent a metric ("142% to quota" can't become "150%"). Dropping a number is allowed
 *     (a shorter, truthful note); adding one is a fabrication and is rejected.
 */
export function truthPreserved(reference: string, candidate: string, mustAppear: string[]): boolean {
  const c = candidate.toLowerCase();
  for (const fact of mustAppear) {
    const f = (fact || "").trim().toLowerCase();
    if (f && !c.includes(f)) return false;
  }
  const refNums = new Set(numberBag(reference));
  for (const n of numberBag(candidate)) if (!refNums.has(n)) return false; // no invented number
  return true;
}

/* ------------------------------------------------------------------ *
 * Layer 2 — the AI rewrite                                            *
 * ------------------------------------------------------------------ */

/** True only when the humanizer is switched on AND a key exists. Off by default: deploying this file
 *  changes nothing until you opt in, and the deterministic engine keeps running exactly as before. */
export function humanizerEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes((process.env.MPC_HUMANIZER || "").toLowerCase())
    && !!process.env.ANTHROPIC_API_KEY;
}

const STYLE = [
  "You rewrite a recruiter's short cold email so it reads like a real person typed it quickly, not a template.",
  "HARD RULES:",
  "- Keep every FACT identical: names, companies, roles, cities, and any numbers. Never add, drop, or change a fact. Never invent a number or a name.",
  "- Lowercase and casual. Use contractions. Read like a quick note, not a campaign.",
  "- No greeting cliches: never 'I hope this finds you', 'I wanted to reach out', 'just circling back', 'touch base'.",
  "- No corporate words: leverage, synergy, cutting-edge, fast-paced, game-changer.",
  "- Never use an em-dash or en-dash. Use a comma, period, or parentheses instead.",
  "- 2 to 4 short sentences. Exactly ONE soft question as the close.",
  "- Vary the opening line; do not start the way a template would.",
  "- Keep the sign-off line exactly as the reference has it.",
  'Return STRICT JSON only, no prose: { "subject": string, "body": string }.',
].join("\n");

/** In-process cache so a given seed renders the same humanized copy across retries/previews within a
 *  running instance (idempotent-ish). Resets on deploy; persistent caching is a deliberate follow-up. */
const memo = new Map<string, { subject?: string; body: string }>();

export interface Rendered { subject?: string; body: string }

/**
 * The hard facts that MUST survive the rewrite, pulled deterministically from the prospect (the same
 * resolution renderTouch does). Only non-generic values are enforced, so a sparse lead doesn't over-
 * constrain the model into echoing filler.
 */
function protectedFacts(p: Partial<Prospect>): string[] {
  const ctx = p.mpcContext ?? {};
  let t: ReturnType<typeof buildMpcTokens>;
  try {
    t = buildMpcTokens({
      firstName: p.firstName, company: p.company, openRole: ctx.openRole || p.title,
      placedRole: ctx.placedRole, placementLocation: ctx.placementLocation, jobLocation: p.location,
      competitor: ctx.competitor, industry: ctx.industry, mustHaves: ctx.mustHaves, metric: ctx.metric,
      gender: ctx.gender, yourName: ctx.yourName,
    });
  } catch { return []; }
  // Enforce the identity facts a rewrite must never lose. Skip the lexicon-floor generics ("your team",
  // "the seat", "there") so we only pin things that are genuinely specific to this lead.
  const generic = new Set(["your team", "the seat", "there", ""]);
  return [t.First_Name, t.Company, t.Open_Role, t.Job_Location, t.Your_Name]
    .map((s) => (s || "").trim())
    .filter((s) => s && !generic.has(s.toLowerCase()));
}

/**
 * Rewrite a rendered MPC opener into natural, human copy — or return null to fall back to the
 * deterministic version. Never throws. Gate-enforced: banned-phrase clean AND truth-preserving, or
 * it's rejected. Tries once, then one stricter retry, then gives up (null).
 */
export async function humanizeMpc(p: Partial<Prospect>, rendered: Rendered, seed = ""): Promise<Rendered | null> {
  if (!humanizerEnabled() || !rendered?.body?.trim()) return null;
  const cacheKey = `${seed}|${rendered.subject || ""}|${rendered.body}`;
  const cached = memo.get(cacheKey);
  if (cached) return cached;

  const must = protectedFacts(p);
  const reference = `${rendered.subject ? `Subject: ${rendered.subject}\n` : ""}${rendered.body}`;

  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const model = process.env.MPC_HUMANIZER_MODEL ?? "claude-haiku-4-5";

    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await client.messages.create({
        model,
        max_tokens: 400,
        temperature: attempt === 0 ? 0.85 : 0.6, // second try is tighter, to land inside the gate
        system: attempt === 0 ? STYLE : STYLE + "\nThe previous attempt was rejected. Keep EVERY fact and number identical to the reference and use no banned phrase.",
        messages: [{ role: "user", content: `Rewrite this email. Keep the facts and the sign-off.\n\n${reference}` }],
      });
      const text = resp.content.map((c) => ("text" in c ? c.text : "")).join("");
      const s = text.indexOf("{"), e = text.lastIndexOf("}");
      if (s < 0 || e < 0) continue;
      let parsed: { subject?: string; body?: string };
      try { parsed = JSON.parse(text.slice(s, e + 1)); } catch { continue; }
      const body = (parsed.body || "").trim();
      const subject = (parsed.subject || rendered.subject || "").trim() || undefined;
      if (!body) continue;

      // GATE: reject bot-tells and any fabricated/lost fact. Fail -> retry once, then fall back.
      if (naturalnessViolations(`${subject || ""}\n${body}`).length) continue;
      if (!truthPreserved(reference, `${subject || ""}\n${body}`, must)) continue;
      // Length sanity: a natural rewrite stays in the same ballpark; reject runaway output.
      if (body.length > rendered.body.length * 1.7 + 40) continue;

      const out: Rendered = { subject, body };
      memo.set(cacheKey, out);
      return out;
    }
  } catch { /* API/parse failure -> deterministic fallback */ }
  return null;
}
