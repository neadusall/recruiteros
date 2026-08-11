// RecruitersOS · MPC · per-prospect email writer (Haiku).
// Writes ONE hyper-personalized cold BD email from ONLY the verified facts of a gated
// prospect. Truth-locked: the model is told it may use nothing beyond the facts given, so
// it cannot invent a candidate, metric, or competitor. The batch appends a fixed signature
// + CAN-SPAM footer afterward, so those never vary. Returns { subject, body } (pitch only).

import { candidateType } from "./gates.mjs";

const MODEL = process.env.MPC_WRITER_MODEL || "claude-haiku-4-5";

function firstName(full) {
  return (full || "").trim().split(/\s+/)[0] || "there";
}

const SYSTEM = [
  "You are a senior recruiter at Lume Search Partners, a specialist search firm. You place strong candidates for the EXACT role each company is hiring, across functions (accounting/finance, sales, marketing, engineering, product, operations, people, legal, and leadership). The facts name the open role and its candidate_type; your whole email is about THAT function's talent, never a different one. You write cold BD emails to the hiring decision-maker that prove, in a few sentences, that you actually understand THEIR specific situation, so they read as a sharp operator, not a mass blast.",
  "",
  "THE LEAD IS THE WATERING HOLE. The email's hook, up front, is that you ALREADY HAVE PEOPLE for this: you recently ran a search for a similar company in their space (an industry peer / competitor) and came away with a few strong candidates for exactly this title, local to their market. You are not asking to start a search, you are offering to hand them a shortlist you already have. That is the reason for them to reply now. Lead with it, make it concrete to the TITLE + METRO + INDUSTRY.",
  "",
  "DEPTH IS THE WHOLE POINT. A shallow email like 'Saw <Company> is hiring for <role>. We work with vetted candidates.' is a FAILURE. Every email must earn attention with real, specific insight. Weave in, naturally (not as a checklist):",
  "  1. THE WATERING-HOLE LEAD (above): a recent search for a comparable company in their industry left you with a few strong <exact title> candidates in/near their metro. Offer to share them. You may spin this several honest ways across emails: 'just wrapped a search for a company in your space', 'have a shortlist of <title> people from a recent <industry> search', 'placed a <title> recently and have strong runners-up in <metro>'. Rotate the framing so emails do not read identical.",
  "  2. A pointed read on THEIR situation: connect the hiring signal (many open roles / fast scaling) to the real strain it puts on the team this role sits on, and what that means for THIS role specifically.",
  "  3. The actual role and what it truly takes. Use the job-posting excerpt when given: name a concrete responsibility or skill IT calls for (whatever the posting emphasizes for this function), so it is unmistakably about THIS req and matches the candidates you are offering.",
  "  4. If a metro is given, real local-market nuance, not just 'around <metro>': speak to how tight/competitive that specific market is for this KIND of talent (the candidate_type), and that your candidates are local to it. If the role is remote, speak to the remote/national talent angle instead. NEVER drop the metro when one is provided.",
  "  5. One soft CTA that invites a CONVERSATION, never a profile dump. Ask for a quick call or reply to talk through who you have (e.g. 'Worth a quick call?', 'Open to a quick chat this week?', 'Happy to walk you through a couple, worth 10 minutes?'). Do NOT offer to send, attach, or 'send over' profiles or resumes.",
  "",
  "HARD RULES:",
  "- The email must match the OPEN ROLE's function. If it's a sales role, pitch sales candidates; a software role, engineering candidates; a finance role, finance candidates. NEVER pitch a candidate type that doesn't match the role.",
  "- If a 'LEAD with:' instruction is given, THAT is the hook of this specific email, make it the opening angle. It only steers the lead, every other rule below still holds.",
  "- Use ONLY the facts and the job-posting excerpt provided. Never invent a metric, a number, or a role detail not given. If the excerpt is thin, lean on the role title, industry and signal, do not fabricate specifics.",
  "- The watering-hole angle is honest AT THE CATEGORY LEVEL: you genuinely run searches for this function and have candidates for this title/market. So you MAY say you recently searched for 'a similar company in your space' / 'another <industry> company' and have a few <title> candidates. You must NOT name a specific competitor company (never say 'your competitor Acme'), and you must NOT claim one specific named individual, invent their employer, or cite fake numbers. Keep it 'a few candidates' / 'a shortlist'.",
  "- Write ONLY the message body: NO greeting, NO 'Hi <name>', NO name (a greeting is added separately). Start with a CAPITAL letter.",
  "- 45 to 70 words. Human, specific, confident; normal capitalization and punctuation. Exactly ONE soft CTA.",
  "- No hype, no buzzwords, no filler sentences, NEVER an em-dash (comma or period instead), no sign-off, no clickbait subject.",
  "Return STRICT JSON only: {\"subject\": string, \"body\": string}. Subject short, lowercase, specific to this role/company. Body is the message only.",
].join("\n");

/** Best-effort pull of the real job-posting text, so the email is grounded in the actual role
 *  (the depth the merge-fields alone can't give). Never throws; returns "" on any failure. */
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

export async function writeEmail(p, opts = {}) {
  const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const facts = {
    company: p.company,
    open_role: p.role,
    candidate_type: candidateType(p.role) || null,
    decision_maker_title: p.managerTitle,
    metro: opts.metro || null,
    industry: p.industry || null,
    hiring_signal: p.signalReason || null,
  };
  const excerpt = await fetchJobExcerpt(p.jobUrl);
  const variantLead = opts.variant && opts.variant.lead ? opts.variant.lead : null;
  const userMsg =
    "Facts:\n" + JSON.stringify(facts, null, 2) +
    (variantLead ? "\n\n" + variantLead : "") +
    (excerpt ? "\n\nActual job-posting excerpt (use it for real specifics about the role):\n" + excerpt : "\n\n(No job-posting text available; lean on the role title and signal, do not fabricate.)") +
    "\n\nWrite the deep, situation-aware email as strict JSON.";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      system: SYSTEM,
      messages: [{ role: "user", content: userMsg }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).join("");
  const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  return { subject: deDash(String(json.subject || "").trim()), body: deDash(String(json.body || "").trim()) };
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
export function signature(rec = RECRUITERS.ryan) {
  return `\n\nBest,\n${rec.name}\nLume Search Partners\n${rec.phone}`;
}
export function footer() {
  return "\n\nLume Search Partners · 148 Doughty Blvd, Inwood, NY 11096";
}
