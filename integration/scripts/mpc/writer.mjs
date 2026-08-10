// RecruitersOS · MPC · per-prospect email writer (Haiku).
// Writes ONE hyper-personalized cold BD email from ONLY the verified facts of a gated
// prospect. Truth-locked: the model is told it may use nothing beyond the facts given, so
// it cannot invent a candidate, metric, or competitor. The batch appends a fixed signature
// + CAN-SPAM footer afterward, so those never vary. Returns { subject, body } (pitch only).

const MODEL = process.env.MPC_WRITER_MODEL || "claude-haiku-4-5";

function firstName(full) {
  return (full || "").trim().split(/\s+/)[0] || "there";
}

const SYSTEM = [
  "You are Ryan Nead, a senior recruiter at Lume Search Partners who places accounting and finance talent. You write cold BD emails to the hiring decision-maker that prove, in a few sentences, that you actually understand THEIR specific situation, so they read as a sharp operator, not a mass blast.",
  "",
  "DEPTH IS THE WHOLE POINT. A shallow email like 'Saw <Company> is hiring for <role>. We work with vetted accounting and finance candidates.' is a FAILURE. Every email must earn attention with real, specific insight. Include, woven naturally (not as a checklist):",
  "  1. A pointed read on THEIR situation: connect the hiring signal (e.g. many open roles / fast scaling) to the real strain it puts on a finance team, and what that means for THIS role specifically.",
  "  2. The actual role and what it truly takes. Use the job-posting excerpt when given: name a concrete responsibility or skill it calls for (e.g. technical accounting under tight close cycles, regulatory reporting, board-level FP&A modeling), so it is unmistakably about THIS req.",
  "  3. If a metro is given, real local-market nuance, not just 'around <metro>': speak to how tight/competitive that specific market is for this kind of finance talent, and that you have vetted people local to it. If the role is remote, speak to the remote/national talent angle instead. NEVER drop the metro when one is provided.",
  "  4. Position your bench with specificity to THIS role, honestly, and one soft CTA.",
  "",
  "HARD RULES:",
  "- Use ONLY the facts and the job-posting excerpt provided. Never invent a candidate, a name, a metric, a competitor, a number, or a detail not given. If the excerpt is thin, lean on the role title and signal, do not fabricate.",
  "- Honest angle: you keep a bench of vetted accounting/finance candidates and can fill their role faster. Do NOT claim one specific named person.",
  "- Write ONLY the message body: NO greeting, NO 'Hi <name>', NO name (a greeting is added separately). Start with a CAPITAL letter.",
  "- 45 to 70 words. Human, specific, confident; normal capitalization and punctuation. Exactly ONE soft CTA (e.g. 'Worth a quick call?').",
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
    decision_maker_title: p.managerTitle,
    metro: opts.metro || null,
    industry: p.industry || null,
    hiring_signal: p.signalReason || null,
  };
  const excerpt = await fetchJobExcerpt(p.jobUrl);
  const userMsg =
    "Facts:\n" + JSON.stringify(facts, null, 2) +
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

// Fixed signature + CAN-SPAM footer appended to every send (never AI-varied).
export function signature() {
  return "\n\nBest,\nRyan Nead\nLume Search Partners\n929-543-0608";
}
export function footer() {
  return "\n\nLume Search Partners · 148 Doughty Blvd, Inwood, NY 11096";
}
