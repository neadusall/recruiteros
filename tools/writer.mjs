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
 * The `reason` is the field that makes an MPC land. Every hiring manager reading a marketed
 * candidate thinks "if they're that good, why are they available?", and a pitch that does not
 * answer it reads as a resume broadcast. It is also the one thing no model can infer, so it is
 * never generated, only passed through.
 *
 *   [{ "title": "Controller",
 *      "family": "Accounting",                  // optional; inferred from title when absent
 *      "metro": "Dallas", "remoteOk": true,     // optional
 *      "reason": "Their CFO seat went to an outside hire",   // why they are looking
 *      "status": "taking calls this week",      // optional
 *      "proof": ["Took a manual close down to five days",
 *                "Ran the ERP migration underneath it"] }]   // exactly two, the PAIRING
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

// Family alone is far too loose to pitch a REAL person into a req: "Accounting" covers a Junior
// Accountant and a Controller, and pitching one person's record under the other's title is not
// merely unconvincing, it is a false claim about a human being (both leaked on 2026-08-21).
// So the record's own title has to answer the req. Generic rank and role words are stripped, and
// what is left has to overlap: "Senior Controller" answers "Controller", "Junior Accountant" does
// not, and "Tax Manager" does not answer "FP&A Manager" just because both end in Manager. A
// record can widen its own reach with an explicit pitchFor list, which the recruiter controls.
const GENERIC_TITLE_WORD = /^(senior|sr|junior|jr|entry|lead|principal|staff|head|chief|vice|vp|svp|evp|director|manager|mgr|specialist|associate|assistant|coordinator|supervisor|officer|executive|analyst|of|and|the|a|an|i|ii|iii|iv|full|part|time|onsite|on|site|remote|hybrid|contract|perm|temp|level|iii)$/i;

function titleTokens(t) {
  return new Set(
    String(t || "").toLowerCase().replace(/[^a-z0-9&]+/g, " ").split(/\s+/)
      .filter((w) => w && !GENERIC_TITLE_WORD.test(w)),
  );
}

/** Does this record's person actually answer this req's title? */
export function titleFits(candidate, role) {
  const pitchFor = Array.isArray(candidate.pitchFor) ? candidate.pitchFor : null;
  if (pitchFor && pitchFor.length) {
    const r = String(role || "").toLowerCase();
    return pitchFor.some((p) => r.includes(String(p).toLowerCase()));
  }
  const mine = titleTokens(candidate.title);
  const theirs = titleTokens(role);
  if (!mine.size || !theirs.size) return false;
  for (const w of mine) if (theirs.has(w)) return true;
  return false;
}

/** The real candidate we are marketing into this req, or null. Family match, then metro if the
 *  record is pinned to one, so a Denver-only person is never pitched into a Tampa seat.
 *
 *  When several people in the bank fit, the pick is SEEDED by the prospect rather than taken
 *  first-match: a bench of four controllers should reach a day's accounting reqs spread across
 *  all four, not the same person forty times. Seeded, so a resend renders the same person. */
export function matchCandidate(role, metro, bank = loadCandidateBank(), seed = "") {
  if (!bank.length) return null;
  const fam = roleFamily(role);
  if (!fam) return null;
  const fits = bank.filter((c) => {
    if ((c.family || roleFamily(c.title)) !== fam) return false;
    if (!titleFits(c, role)) return false;
    if (!c.metro) return true;
    if (!metro) return c.remoteOk === true;
    return String(c.metro).toLowerCase() === String(metro).toLowerCase() || c.remoteOk === true;
  });
  if (!fits.length) return null;
  let h = 2166136261;
  const k = String(seed || role || "");
  for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 16777619); }
  return fits[(h >>> 0) % fits.length];
}

const SYSTEM = [
  "You are a recruiter at Lume Search Partners. You write ONE cold MPC email: you represent a candidate and you are marketing that person to a company hiring their exact title. You are not selling a search, not selling your firm, and not explaining their own job to them.",
  "",
  "THE FORMAT IS FIXED. Three short paragraphs SEPARATED BY A BLANK LINE, in this order, nothing else. A body that is not three blank-line-separated paragraphs is a failure:",
  "  1. WHO. One sentence, and it MUST begin with the words \"I'm representing\". Then the title, then the metro if one is given, or 'in your space' if none is. If CANDIDATE TITLE is given in the facts, that is the title you write, EXACTLY, even when the open role is titled differently: the facts in paragraph 2 belong to that person, so naming anyone else would be a lie. Only when no candidate title is given do you use the open role's title. Nothing else. Use the SHORT form of the title a person would say out loud: 'Tax Manager', not 'Tax Manager - High Net Worth (Hybrid)'. Never 'we're representing', never a plural, never your own words for their industry.",
  "  2. PROOF. Exactly TWO concrete things this person has done, each one SHORT: eight words maximum, no sub-clauses, no 'that' or 'which'. Write them as two clipped sentences. Nothing else in this paragraph. This is the paragraph people over-write, so cut it twice before you return it.",
  "     PICK THE TWO FACTS THAT ARE HARD TO GET IN ONE PERSON. Reading the posting back as a duty list ('Owned monthly close and variance analysis') proves nothing, because every applicant claims it and the reader wrote those words himself. Find the COMBINATION the posting quietly needs, the pairing most people in this title do not have, and make the two facts that pairing. The scarcity must come from the facts standing next to each other, never from you calling it scarce.",
  "  3. CLOSE. Two short sentences, six words each is plenty. The second is ONE short question. Nothing after the question. The FIRST sentence depends on what you were given:",
  "     a. If CANDIDATE REASON is given, that reason IS the sentence, and it is the most important sentence in the email. A hiring manager's first thought about any marketed candidate is 'if they're that good, why are they available?'. The reason answers it before they ask. Write it plainly, no spin, no apology. It does not have to begin with 'They're'.",
  "     b. If no reason is given, fall back to a plain availability line that begins with \"They're\": 'They're looking quietly.', 'They're taking calls this week.' Never dress it up.",
  "     The close is EXACTLY TWO sentences. When a reason is given it REPLACES the availability line, it does not sit beside it. 'Their CFO seat went to an outside hire. They're ready to move now, not in six months. Worth a look?' is three sentences and it is wrong; the reason already told the reader everything the middle sentence tried to.",
  "",
  "A CORRECT EMAIL, exactly this shape and this short:",
  "  I'm representing a Controller in Dallas.",
  "  <blank line>",
  "  Took a manual close down to five days. Ran the ERP migration underneath it.",
  "  <blank line>",
  "  Their CFO seat went to an outside hire. Worth a look?",
  "",
  "WHY THAT ONE WORKS, and what to copy from it. The two facts are a PAIRING: plenty of controllers close the books and plenty of people survive an ERP migration, but doing both at once is the thing a hiring manager cannot easily buy. Nobody had to say the word 'rare'. And the last line answers the question the reader is already asking, which is why a person this good is available at all. That answer is what turns a claim into a person.",
  "",
  "THE SAME EMAIL, WRITTEN BADLY, so you can see the trap:",
  "  I'm representing a Controller in Dallas.",
  "  <blank line>",
  "  Owned month-end close and reconciliations. Managed financial reporting and compliance.",
  "  <blank line>",
  "  They're still employed and looking quietly. Worth a look?",
  "That version is the same length and says nothing. The facts are the job description handed back, they describe a category and not a human being, and the close is filler. Never send that email.",
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
  const candidate = opts.candidate !== undefined ? opts.candidate : matchCandidate(p.role, metro, loadCandidateBank(), p.id || p.company || "");
  const facts = {
    open_role: p.role,
    candidate_type: candidateType(p.role) || null,
    decision_maker_title: p.managerTitle,
    metro,
    industry: p.industry || null,
    // Real proof, verbatim, when we actually hold this person. Absent = capability level only.
    candidate_proof: candidate ? candidate.proof : null,
    candidate_status: candidate ? candidate.status || null : null,
    // WHY a person this good is on the market. The single most persuasive fact in an MPC pitch
    // and the one thing the writer can never guess, so it is passed through or left null.
    candidate_reason: candidate ? candidate.reason || null : null,
    // When a record is in play, THIS is the title the email says. Writing the req's title over
    // another person's facts would be a false claim, not a rounding error.
    candidate_title: candidate ? candidate.title : null,
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
