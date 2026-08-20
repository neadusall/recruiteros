// RecruitersOS · MPC · per-prospect email writer (Haiku).
//
// Writes ONE cold MPC email: you represent a candidate, you are marketing them to a company
// hiring that exact title. The whole design goal is BREVITY WITH BANG. Three short paragraphs,
// 35-55 words, one idea per line, one question at the end. A decision-maker reads it in six
// seconds without scrolling on a phone.
//
// Truth-locked: the model may use nothing beyond the facts given, so it cannot invent a
// candidate, a metric or a competitor. Hard numbers ("$12M to $40M", "3 to 22 reps") are only
// ever possible when a REAL candidate record supplies them (see the candidate bank below);
// with no record the writer stays at the capability level, which is honest and still specific.
//
// The batch appends greeting, the confidentiality line, signature and CAN-SPAM footer, so those
// never vary. Returns { subject, body } (pitch only).

import { readFileSync } from "node:fs";
import { candidateType, roleFamily } from "./gates.mjs";

const MODEL = process.env.MPC_WRITER_MODEL || "claude-haiku-4-5";

/* ── The candidate bank ─────────────────────────────────────────────────────────────────────
 * Optional. A JSON array of the REAL people currently being marketed. When one matches the open
 * role, its proof lines go into the email VERBATIM, which is the only way an email is allowed to
 * carry hard numbers. With no bank (or no match) the writer falls back to capability-level proof
 * drawn from the job posting, which is truthful and still concrete.
 *
 *   [{ "title": "VP of Sales",
 *      "family": "Sales",                       // optional; inferred from title when absent
 *      "metro": "Denver", "remoteOk": true,     // optional
 *      "status": "exploring quietly",           // optional
 *      "proof": ["Grew a portfolio from $12M to $40M",
 *                "Built the team from 3 to 22 reps"] }]
 */
const BANK_PATH = process.env.MPC_CANDIDATE_BANK || "/data/mpc-candidates.json";
let BANK_CACHE = null;

export function loadCandidateBank(path = BANK_PATH) {
  if (BANK_CACHE) return BANK_CACHE;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const list = (Array.isArray(raw) ? raw : raw.candidates || []).filter(
      (c) => c && c.title && Array.isArray(c.proof) && c.proof.length,
    );
    BANK_CACHE = list;
  } catch {
    BANK_CACHE = [];
  }
  return BANK_CACHE;
}

/** The real candidate we are marketing into this req, or null. Family match, then metro if the
 *  record is pinned to one, so a Denver-only person is never pitched into a Tampa seat. */
export function matchCandidate(role, metro, bank = loadCandidateBank()) {
  if (!bank.length) return null;
  const fam = roleFamily(role);
  if (!fam) return null;
  const sameFamily = bank.filter((c) => (c.family || roleFamily(c.title)) === fam);
  if (!sameFamily.length) return null;
  const placed = sameFamily.find((c) => {
    if (!c.metro) return true;
    if (!metro) return c.remoteOk === true;
    return String(c.metro).toLowerCase() === String(metro).toLowerCase();
  });
  return placed || null;
}

const SYSTEM = [
  "You are a recruiter at Lume Search Partners. You write ONE cold MPC email: you represent a candidate and you are marketing that person to a company hiring their exact title. You are not selling a search, not selling your firm, and not explaining their own job to them.",
  "",
  "THE FORMAT IS FIXED. Three short paragraphs SEPARATED BY A BLANK LINE, in this order, nothing else. A body that is not three blank-line-separated paragraphs is a failure:",
  "  1. WHO. One sentence, and it MUST begin with the words \"I'm representing\". Then the title, then the metro if one is given, or 'in your space' if none is. Nothing else. Use the SHORT form of the title a person would say out loud: 'Tax Manager', not 'Tax Manager - High Net Worth (Hybrid)'. Never 'we're representing', never a plural, never your own words for their industry.",
  "  2. PROOF. Exactly TWO concrete things this person has done, each one SHORT: eight words maximum, no sub-clauses, no 'that' or 'which'. Write them as two clipped sentences, or as two fragments joined by one comma. Nothing else in this paragraph. This is the paragraph people over-write, so cut it twice before you return it.",
  "  3. CLOSE. Two short sentences, six words each is plenty. The first MUST begin with the word \"They're\" and say their situation in one clause, nothing more. The second is ONE short question. Nothing after the question.",
  "",
  "A CORRECT EMAIL, exactly this shape and this short:",
  "  I'm representing a VP of Sales in Denver.",
  "  <blank line>",
  "  Built the enterprise team from scratch. Owns the whole cycle, from pipeline to close.",
  "  <blank line>",
  "  They're looking quietly. Worth a look?",
  "",
  "LENGTH IS THE FEATURE, AND SHORTER ALWAYS WINS. 25 to 45 words of body, total, across all three paragraphs. At 50 words you have failed. Cut whole ideas, never compress two into a longer sentence. Every sentence stays under 14 words. If a sentence has two commas in it, it is too long, split it or cut half of it.",
  "",
  "THE CARDINAL SIN IS EXPLAINING THEIR SITUATION BACK TO THEM. They wrote the job posting. Never tell them what the role requires, why it is hard to fill, what their market is like, what the seat costs them while it is open, what strain their team is under, or why this profile is rare. Every one of those sentences is deletable, and every one of them is why an email gets ignored. Delete them before you write them.",
  "",
  "BANNED, ALWAYS:",
  "  - Empty adjectives: strong, sharp, seasoned, proven, solid, exceptional, top-tier, high-caliber, rare, unique, dynamic.",
  "  - Setup phrases: 'I wanted to reach out', 'I came across', 'I hope this finds you well', 'just wanted to', 'as you know', 'at your scale', 'that is a compounding cost', 'which is the real constraint', 'these are not generic candidates', 'worth flagging'.",
  "  - Any sentence that would fit in ANY company's email. If it is not about this person or this title, cut it.",
  "  - Lists of three or more skills. Two facts, that is the ceiling.",
  "  - Selling the candidate twice. Say it once and stop.",
  "",
  "THE PROOF LINE IS THE WHOLE EMAIL. Two facts, concrete, past tense, no adjectives.",
  "  - If CANDIDATE PROOF lines are given in the facts, use them VERBATIM (you may join them with a comma and fix tense or capitalization, nothing more). Those are the only hard numbers you may ever write.",
  "  - Every proof fact starts with a past-tense verb: Owned, Built, Ran, Grew, Led, Closed, Rebuilt, Managed. Never a present participle, never 'Overseen'.",
  "  - If no candidate proof is given, you know this person only at the capability level. Write two things the job posting itself demands, phrased as work this person has owned: 'Owned the close cycle and deferred revenue' is fine. NEVER invent a number, a year count, a certification, an employer, a system, or a headcount. Inventing one is a hard failure.",
  "",
  "VOICE. One busy operator writing to another. Contractions. Plain words. Normal capitalization. Never an em-dash, use a comma or a period. No hype, no buzzwords, no sign-off, no P.S.",
  "",
  "HARD RULES:",
  "- The candidate's function must match the OPEN ROLE. A sales req gets a sales candidate, a finance req gets a finance candidate. Never pitch a different function.",
  "- Refer to the candidate as 'they' throughout. Never a name, never a current employer, never a named competitor.",
"- You are one person writing. Always 'I', never 'we' or 'our team', anywhere in the email.",
"- Never apologize for the candidate or frame them as a leftover ('we couldn't place them'). State the fact and move on.",
  "- If an ANGLE instruction is given, it steers ONE sentence of paragraph 1 or 3. It never adds a sentence and never buys extra words.",
  "- If metro is null (a remote or national role), never claim they are local to anything. Say they are remote-ready or drop location entirely.",
  "- Exactly ONE question mark in the whole body, at the very end. The close is a question about seeing the person: 'Worth a look?', 'Want their profile?', 'Worth a quick call?'. Do not ask for a meeting time and do not offer to attach or send a resume.",
  "- Subject: lowercase, 3 to 6 words, in the shape '<title>, <their status>'. The half after the comma describes THE PERSON, never a city and never the industry: 'quietly looking', 'off market', 'ready now', 'open to a move', 'still employed'. So: 'vp of sales, quietly looking', 'controller, off market', 'director of nursing, ready now'. Shorten a long title rather than dropping the status. No company name, no metro, no clickbait, no question mark.",
"- Never characterize their industry or market in your own words ('your engineering software space', 'the fast-moving fintech world'). Name the metro or say 'in your space', nothing more.",
"- Never say you placed a ROLE somewhere. You place PEOPLE. If a variant is about a search you closed, phrase it as a person you could not place.",
  "Return STRICT JSON only: {\"subject\": string, \"body\": string}. Body is the message only: NO greeting, NO name, NO sign-off. Start with a capital letter.",
].join("\n");

/** Best-effort pull of the real job-posting text, so the proof line is grounded in the actual
 *  role (the depth the merge-fields alone can't give). Never throws; returns "" on any failure. */
async function fetchJobExcerpt(url) {
  if (!url) return "";
  try {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return "";
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z#0-9]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, 1800);
  } catch {
    return "";
  }
}

/** Capitalized first name for the greeting, built deterministically (not left to the model). */
export function greetingName(managerName) {
  const n = (managerName || "there").trim().split(/\s+/)[0] || "there";
  return n.charAt(0).toUpperCase() + n.slice(1);
}

/** Remove any em-dash the model slips in, so a good draft is never dropped by the render gate. */
function deDash(s) {
  return (s || "").replace(/\s*—\s*/g, ", ").replace(/\s*–\s*/g, ", ");
}

// The subject is "<title>, <their status>". The status half is what makes it an MPC subject
// rather than a job-board one, and the model keeps re-reading the tail of a long title as the
// status ("design engineer, transmission line"). So it is enforced here, not asked for: casing
// is forced down and a missing status is filled from the variant that was actually assigned.
const SUBJECT_STATUSES = [
  "quietly looking", "off market", "never hit the market", "ready now",
  "open to a move", "still employed", "exploring quietly", "available now",
];
export function normalizeSubject(raw, variant) {
  let s = String(raw || "").toLowerCase().replace(/\s+/g, " ").replace(/[?!.]+$/, "").trim();
  if (SUBJECT_STATUSES.some((st) => s.endsWith(st))) return s;
  const head = s.split(",")[0].trim();
  const status = (variant && variant.subjectStatus) || "quietly looking";
  return head ? `${head}, ${status}` : status;
}

export async function writeEmail(p, opts = {}) {
  const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const metro = opts.metro || null;
  const candidate = opts.candidate !== undefined ? opts.candidate : matchCandidate(p.role, metro);
  const facts = {
    open_role: p.role,
    candidate_type: candidateType(p.role) || null,
    decision_maker_title: p.managerTitle,
    metro,
    industry: p.industry || null,
    // Real proof, verbatim, when we actually hold this person. Absent = capability level only.
    candidate_proof: candidate ? candidate.proof : null,
    candidate_status: candidate ? candidate.status || null : null,
  };
  const excerpt = await fetchJobExcerpt(p.jobUrl);
  const variantLead = opts.variant && opts.variant.lead ? opts.variant.lead : null;
  const userMsg =
    "Facts:\n" + JSON.stringify(facts, null, 2) +
    (variantLead ? "\n\n" + variantLead : "") +
    (excerpt
      ? "\n\nActual job-posting excerpt. Use it ONLY to ground the two proof facts in what this role really does. Do not describe the role back to them:\n" + excerpt
      : "\n\n(No job-posting text available; lean on the title, do not fabricate.)") +
    "\n\nWrite the email as strict JSON. Three short paragraphs, 35 to 55 words, one question at the end.";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system: SYSTEM,
      messages: [{ role: "user", content: userMsg }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).join("");
  const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  return {
    subject: normalizeSubject(deDash(String(json.subject || "")), opts.variant),
    body: deDash(String(json.body || "").trim()),
    // True only when a real candidate record supplied the proof lines. The render gate reads
    // this to decide whether a number in the body is backed or invented.
    sourcedProof: Boolean(candidate),
  };
}

// Fixed signatures + CAN-SPAM footer appended to every send (never AI-varied).
// Sends rotate across ALL FIVE recruiters' mailbox fleets (Ryan/Josh/Noah/Sam on Sending.ac,
// Ariel on the own-SMTP lookalike boxes); each email signs as the recruiter who owns the box
// it leaves from, with their direct line.
const RECRUITERS = {
  ryan: { name: "Ryan Nead", phone: "929-543-0608" },
  josh: { name: "Josh Gurin", phone: "929-532-0756" },
  noah: { name: "Noah Wilkowski", phone: "929-543-0584" },
  sam: { name: "Sam Wagner", phone: "929-401-0849" },
  ariel: { name: "Ariel Grosser", phone: "929-695-9010" },
};
export function recruiterFor(ownerName) {
  const o = String(ownerName || "").toLowerCase();
  for (const [key, rec] of Object.entries(RECRUITERS)) if (o.includes(key)) return rec;
  return RECRUITERS.ryan;
}

// The MPC close. Fixed, never AI-varied, and literally true of every one of these emails: we
// name nobody and we never say where they work now. It also answers, before it is asked, the
// only objection a hiring manager has to a confidential candidate pitch.
export function confidentiality() {
  return "\n\nNo names. No current employer. Fully confidential.";
}

export function signature(rec = RECRUITERS.ryan) {
  return `\n\nBest,\n${rec.name}\nLume Search Partners\n${rec.phone}`;
}
export function footer() {
  return "\n\nLume Search Partners · 148 Doughty Blvd, Inwood, NY 11096";
}
