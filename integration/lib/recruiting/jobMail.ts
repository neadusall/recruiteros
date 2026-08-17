/**
 * RecruitersOS · Candidate job-marketing copy engine
 *
 * Paste a Job Description, get a bank of SHORT candidate-facing email templates
 * that market the role: each template is a different angle, written in spintax
 * ({option a|option b} groups) so every rendered email reads differently, with
 * {{First_Name}} / {{Your_Name}} merge tokens filled per candidate + recruiter
 * at send time. The bank guarantees 50+ distinct emails per job or it reports
 * failure honestly (it never pads with junk to hit the number).
 *
 * DELIBERATELY SEPARATE from lib/bd/mpc (which is business development only,
 * by standing rule). Shared primitives come from lib/copy (spintax renderer,
 * render guard) and lib/text (dash hygiene) - nothing here touches MPC.
 *
 * Model: pinned to claude-haiku-4-5 like every other email-creation surface
 * (spend control; RECRUITEROS_EMAIL_MODEL env overrides).
 */

import { expandSpintax } from "../copy/spintax";
import { guardRenderedTouch } from "../copy/renderGuard";
import { stripDashes } from "../text/dashes";

const MODEL = process.env.RECRUITEROS_EMAIL_MODEL ?? "claude-haiku-4-5";

/* ---------------- job facts ---------------- */

export interface JobFacts {
  roleTitle: string;
  company?: string;
  location?: string;
  /** Compensation exactly as the JD states it; never invented. */
  comp?: string;
  /** 2-5 short selling points a candidate would actually care about. */
  hooks: string[];
  /** Work model when stated: onsite / hybrid / remote wording from the JD. */
  workModel?: string;
}

/** Everything the generator may treat as ground truth, for the digit audit. */
export function factsBlob(f: JobFacts): string {
  return [f.roleTitle, f.company, f.location, f.comp, f.workModel, ...(f.hooks || [])]
    .filter(Boolean)
    .join(" \n ");
}

/**
 * One Haiku pass over the pasted JD -> the facts the emails may use. Fails soft
 * to a heuristic parse (first non-empty line as the role title) so the operator
 * can still proceed and edit by hand when the key is missing.
 */
export async function extractJobFacts(jd: string): Promise<{ facts: JobFacts; engine: "llm" | "heuristic" }> {
  const text = String(jd || "").trim().slice(0, 12000);
  const fallback = (): JobFacts => {
    const firstLine = (text.split(/\n/).map((l) => l.trim()).find((l) => l.length > 2) || "the role").slice(0, 80);
    return { roleTitle: firstLine, hooks: [] };
  };
  if (!text) return { facts: fallback(), engine: "heuristic" };
  if (!process.env.ANTHROPIC_API_KEY) return { facts: fallback(), engine: "heuristic" };
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 700,
        temperature: 0,
        system:
          'Extract job facts from a job description. Reply with STRICT JSON only: {"roleTitle":string,"company":string|null,"location":string|null,"comp":string|null,"workModel":string|null,"hooks":string[]}. ' +
          "roleTitle: the job title, short. company: the hiring company if named. location: city/state or metro if stated. " +
          "comp: the pay exactly as written (range, salary, hourly) ONLY if the JD states it, else null. " +
          "workModel: onsite/hybrid/remote wording ONLY if stated. " +
          "hooks: 2 to 5 short phrases (under 9 words each) a CANDIDATE would find attractive about this job, taken from the JD: growth, team, product, stability, schedule, benefits actually named. No invention, no fluff words.",
        messages: [{ role: "user", content: text }],
      },
      { timeout: 60_000 },
    );
    const raw = resp.content.map((c) => ("text" in c ? c.text : "")).join("");
    const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
    const parsed = JSON.parse(raw.slice(s, e + 1));
    const facts: JobFacts = {
      roleTitle: String(parsed.roleTitle || "").trim().slice(0, 90) || fallback().roleTitle,
      company: parsed.company ? String(parsed.company).trim().slice(0, 90) : undefined,
      location: parsed.location ? String(parsed.location).trim().slice(0, 90) : undefined,
      comp: parsed.comp ? String(parsed.comp).trim().slice(0, 90) : undefined,
      workModel: parsed.workModel ? String(parsed.workModel).trim().slice(0, 60) : undefined,
      hooks: (Array.isArray(parsed.hooks) ? parsed.hooks : []).map((h: unknown) => String(h).trim()).filter(Boolean).slice(0, 5),
    };
    return { facts, engine: "llm" };
  } catch {
    return { facts: fallback(), engine: "heuristic" };
  }
}

/* ---------------- template generation ---------------- */

export interface JobMailTemplate {
  id: string;
  angle: string;
  subject: string;
  body: string;
}

/** Tokens the templates may carry; everything else must be inlined facts. */
const ALLOWED_TOKENS = new Set(["first_name", "your_name"]);

/** Local hygiene list for candidate mail (kept separate from BD's list on purpose). */
const BANNED = [
  "i hope this finds you", "i hope you are doing well", "i hope you're doing well",
  "touch base", "reaching out", "circle back", "exciting opportunity", "amazing opportunity",
  "incredible opportunity", "dream job", "rockstar", "ninja", "guru", "fast-paced environment",
  "dynamic team", "synergy", "leverage", "world-class", "cutting-edge", "game-changer",
  "don't miss", "act now", "apply today", "limited time", "100% free", "no strings",
  "perfect fit", "perfect candidate", "came across your profile", "i was impressed by",
];

const ANGLES = [
  "direct match: their background fits this seat, say it plainly",
  "the role just opened: fresh opening, early look",
  "location: the job is near them / matches their market",
  "growth: what this role sets someone up for next",
  "the work itself: what they would actually do day to day",
  "team or company strength: one concrete hook from the facts",
  "career move framing: why people in this seat move for this",
  "low friction: two lines, worth a look, easy no",
  "timing: markets shift, this is a good moment to compare",
  "quiet look: they are not actively looking and that is fine",
  "one question: a single honest question about their interest",
  "compensation: lead with the stated pay (ONLY if comp fact exists)",
  "schedule or work model: lead with it (ONLY if that fact exists)",
  "second look: short, casual, assumes a busy reader",
  "candid recruiter note: what the recruiter honestly thinks of this role",
  "comparison: how this seat compares to a typical one like theirs",
];

/** Count the spintax option-combinations a template can render ({a|b|c} groups). */
export function spinCombos(text: string): number {
  let combos = 1;
  const re = /\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const inner = m[1];
    if (inner.startsWith("{")) continue;
    const opts = inner.split("|").length;
    if (opts > 1) combos *= opts;
    if (combos > 100000) return 100000;
  }
  return combos;
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function digitRuns(s: string): string[] {
  return s.match(/\d[\d,.]*/g) || [];
}

/**
 * The model sometimes writes a spin group with doubled braces ("{{a|b|c}}").
 * The spintax expander protects ANY double-braced run as a merge field, so the
 * group never expands and the render guard holds the send as an unresolved
 * token. A real merge token can never contain a pipe, so any double-braced
 * group with one is spintax: fold it to single braces.
 */
export function normalizeSpinBraces(s: string): string {
  return String(s || "").replace(/\{\{([^{}]*\|[^{}]*)\}\}/g, "{$1}");
}

/** Why a generated template is unusable; empty array = keep it. */
export function templateViolations(t: { subject: string; body: string }, facts: JobFacts): string[] {
  const out: string[] = [];
  const subject = String(t.subject || "");
  const body = String(t.body || "");
  if (!subject.trim()) out.push("empty subject");
  if (subject.length > 70) out.push("subject too long");
  if (!body.includes("{{First_Name}}")) out.push("missing {{First_Name}}");
  if (!body.includes("{{Your_Name}}")) out.push("missing {{Your_Name}}");
  for (const text of [subject, body]) {
    if (/[—–]/.test(text)) out.push("em/en dash");
    if (/https?:\/\//i.test(text)) out.push("contains URL");
  }
  // Every double-braced run must be an allowed merge token. Matching ANY
  // content (not just word-shaped names) is what catches "{{a|b}}" spintax
  // written with doubled braces, which the expander would protect verbatim.
  const tokenRe = /\{\{([^{}]*)\}\}/g;
  let tm: RegExpExecArray | null;
  while ((tm = tokenRe.exec(subject + " " + body))) {
    if (!ALLOWED_TOKENS.has(tm[1].trim().toLowerCase())) out.push("unknown token " + tm[1].trim().slice(0, 40));
  }
  // Spintax must expand cleanly (no stray braces/pipes once groups resolve).
  const expanded = expandSpintax(body, "probe").replace(/\{\{[^}]+\}\}/g, "x");
  if (/[{}|]/.test(expanded)) out.push("broken spintax");
  const subjExpanded = expandSpintax(subject, "probe").replace(/\{\{[^}]+\}\}/g, "x");
  if (/[{}|]/.test(subjExpanded)) out.push("broken subject spintax");
  // Enough built-in variety that the bank multiplies into distinct emails.
  if (spinCombos(body) < 4) out.push("too little spintax variety");
  const words = wordCount(expanded);
  if (words < 22) out.push("too short");
  if (words > 120) out.push("too long");
  if ((expanded.match(/\?/g) || []).length > 1) out.push("more than one question");
  const lower = (subject + " " + expanded).toLowerCase();
  for (const b of BANNED) if (lower.includes(b)) out.push("banned phrase: " + b);
  // Truth audit: any number in the email must exist in the JD facts.
  const truth = factsBlob(facts);
  for (const run of digitRuns(expanded + " " + subjExpanded)) {
    const bare = run.replace(/[^\d]/g, "");
    if (bare && !truth.replace(/[^\d]/g, "").includes(bare)) { out.push("invented number " + run); break; }
  }
  return out;
}

export interface JobMailBank {
  templates: JobMailTemplate[];
  rejected: number;
  /** Total distinct renderable emails across the bank (spintax combinations). */
  distinctEmails: number;
  engine: string;
}

const SYSTEM_PROMPT =
  "You write short emails from a recruiter to a potential candidate, marketing ONE specific job opening. " +
  "You will get job facts and a list of angles. Write ONE email per angle given.\n" +
  "HARD RULES:\n" +
  "- Greeting is exactly: Hi {{First_Name}},\n" +
  "- Sign-off is exactly: {Thanks|Best|Talk soon},\n{{Your_Name}}\n" +
  "- Body between greeting and sign-off: 2 to 4 short sentences, 30 to 80 words total. Plain, direct, human. Write like a busy recruiter who respects the reader, not a marketer.\n" +
  "- SPINTAX: every email must weave in at least 3 spin groups of the form {option one|option two} or {a|b|c}, each option a natural full phrasing, so the same email renders differently per person. Spin real phrasings, not single filler words. Subjects should carry one spin group when it reads naturally.\n" +
  "- Merge tokens allowed: {{First_Name}} and {{Your_Name}} ONLY. Job facts get written INTO the text (role title, location, pay), never as tokens.\n" +
  "- Mention the role title. Mention the location or work model when those facts exist.\n" +
  "- Use ONLY the facts provided. Never invent pay, benefits, numbers, or company claims. If a fact is missing, write around it.\n" +
  "- At most ONE question in the whole email. The ask is small: worth a look, open to details, want the spec.\n" +
  "- No links. No em dashes or en dashes (use commas or periods). No exclamation marks. No emoji.\n" +
  "- Never use: " + BANNED.slice(0, 14).join(", ") + ".\n" +
  "- Subject: under 60 characters, lowercase-casual or sentence case, concrete, never clickbait.\n" +
  'Reply with STRICT JSON only: {"templates":[{"angle":"...","subject":"...","body":"..."}]}. The body string contains real newlines as \\n.';

/**
 * Generate the template bank for one job: batched Haiku calls, each candidate
 * template gated by templateViolations. Keeps generating (up to 3 batches)
 * until the bank holds >= 12 templates AND >= 50 distinct renderable emails.
 */
export async function generateJobMailBank(facts: JobFacts): Promise<JobMailBank> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { templates: [], rejected: 0, distinctEmails: 0, engine: "none" };
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const angles = ANGLES.filter((a) => {
    if (a.startsWith("compensation") && !facts.comp) return false;
    if (a.startsWith("schedule") && !facts.workModel) return false;
    return true;
  });

  const factLines = [
    "Role: " + facts.roleTitle,
    facts.company ? "Hiring company: " + facts.company : "",
    facts.location ? "Location: " + facts.location : "",
    facts.workModel ? "Work model: " + facts.workModel : "",
    facts.comp ? "Pay (as stated): " + facts.comp : "",
    facts.hooks.length ? "Selling points: " + facts.hooks.join("; ") : "",
  ].filter(Boolean).join("\n");

  const kept: JobMailTemplate[] = [];
  let rejected = 0;
  const seenOpenings = new Set<string>();

  for (let batch = 0; batch < 3; batch++) {
    const distinct = kept.reduce((n, t) => n + spinCombos(t.body), 0);
    if (kept.length >= 12 && distinct >= 50) break;
    const batchAngles = angles.map((a, i) => (batch > 0 ? a + " (fresh wording, batch " + (batch + 1) + ", variant " + i + ")" : a));
    let parsed: { templates?: Array<{ angle?: string; subject?: string; body?: string }> };
    try {
      const resp = await client.messages.create(
        {
          model: MODEL,
          max_tokens: 4000,
          temperature: 1,
          system: SYSTEM_PROMPT,
          messages: [{
            role: "user",
            content: "JOB FACTS:\n" + factLines + "\n\nANGLES (one email per angle):\n" + batchAngles.map((a, i) => (i + 1) + ". " + a).join("\n"),
          }],
        },
        { timeout: 90_000 },
      );
      const raw = resp.content.map((c) => ("text" in c ? c.text : "")).join("");
      const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
      parsed = JSON.parse(raw.slice(s, e + 1));
    } catch {
      continue; // one bad batch never sinks the bank; the loop retries
    }
    for (const t of parsed.templates || []) {
      // Repair the two model slips we can fix mechanically (doubled spin braces,
      // dashes) instead of rejecting the template and shrinking the bank.
      const subject = stripDashes(normalizeSpinBraces(String(t.subject || "").trim())).trim();
      const body = stripDashes(normalizeSpinBraces(String(t.body || "").replace(/\r/g, "").trim())).trim();
      const v = templateViolations({ subject, body }, facts);
      if (v.length) { rejected++; continue; }
      // No near-duplicate openings: the first 40 chars of the expanded body
      // (minus greeting) must be new to the bank.
      const opening = expandSpintax(body, "fp").replace(/^Hi \{\{First_Name\}\},?\s*/i, "").slice(0, 40).toLowerCase();
      if (seenOpenings.has(opening)) { rejected++; continue; }
      seenOpenings.add(opening);
      kept.push({ id: "jt" + (kept.length + 1) + "_" + Math.abs(fnv(body)).toString(36), angle: String(t.angle || "").slice(0, 80), subject, body });
    }
  }

  return {
    templates: kept,
    rejected,
    distinctEmails: kept.reduce((n, t) => n + spinCombos(t.body) * Math.max(1, spinCombos(t.subject)), 0),
    engine: MODEL,
  };
}

/* ---------------- per-candidate render ---------------- */

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h | 0;
}

export interface RenderedJobMail {
  subject: string;
  body: string;
  templateId: string;
  holds: string[];
}

/**
 * Deterministic render for one candidate: seeded template pick + seeded spintax
 * expansion + token fill, then the shared render guard. Same candidate always
 * gets the same email (safe re-render), different candidates spread across the
 * whole bank.
 */
export function renderJobMail(
  templates: JobMailTemplate[],
  candidate: { id: string; firstName?: string; fullName?: string },
  recruiterName: string,
): RenderedJobMail {
  if (!templates.length) return { subject: "", body: "", templateId: "", holds: ["empty template bank"] };
  const first = (candidate.firstName || (candidate.fullName || "").trim().split(/\s+/)[0] || "").trim();
  const seed = candidate.id + ":jobmail";
  const t = templates[Math.abs(fnv(seed)) % templates.length];
  // normalizeSpinBraces + stripDashes also run here (not just at generation)
  // so banks already stored with doubled spin braces or dashes render clean
  // instead of holding forever. stripDashes leaves URLs untouched.
  const fill = (s: string) =>
    stripDashes(
      expandSpintax(normalizeSpinBraces(s), seed)
        .replace(/\{\{\s*First_Name\s*\}\}/gi, first)
        .replace(/\{\{\s*Your_Name\s*\}\}/gi, recruiterName),
    );
  const subject = fill(t.subject);
  const body = fill(t.body);
  const holds: string[] = [];
  if (!first) holds.push("missing first name");
  if (!recruiterName.trim()) holds.push("missing recruiter name");
  const verdict = guardRenderedTouch({
    channel: "email",
    emailStep: 1,
    subject,
    body,
    tokens: { first_name: first, your_name: recruiterName },
  });
  if (!verdict.ok) for (const h of verdict.holds) holds.push(h.check + ": " + h.detail);
  return { subject, body, templateId: t.id, holds };
}
