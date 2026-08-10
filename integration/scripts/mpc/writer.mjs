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
  "You are Ryan Nead, a recruiter at Lume Search Partners who places accounting and finance talent.",
  "Write ONE short cold business-development email to a hiring decision-maker at a company that is hiring for a finance/accounting role.",
  "HARD RULES:",
  "- Use ONLY the facts provided. Never invent a candidate, a name, a metric, a competitor, a number, or a detail not given.",
  "- The honest angle: you keep a bench of vetted accounting/finance candidates and can help fill their open role faster. Do NOT claim to have one specific named person.",
  "- Reference their actual company and the actual role. If a metro is given, work the local market in naturally ('candidates right around <metro>' / 'local to <metro>'). If no metro, do not mention location.",
  "- Under 55 words. Lowercase, casual, reads like a person typed it fast. Exactly ONE soft call to action (e.g. 'worth a quick call?').",
  "- No hype, no buzzwords, no em-dashes, no signature (it is added later), no subject-line clickbait.",
  "Return STRICT JSON only: {\"subject\": string, \"body\": string}. Subject lowercase, short, curiosity-driven. Body is the pitch only, no sign-off.",
].join("\n");

export async function writeEmail(p, opts = {}) {
  const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const facts = {
    company: p.company,
    open_role: p.role,
    decision_maker_first_name: firstName(p.managerName),
    decision_maker_title: p.managerTitle,
    metro: opts.metro || null,
    industry: p.industry || null,
    hiring_signal: p.signalReason || null,
  };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system: SYSTEM,
      messages: [{ role: "user", content: "Facts:\n" + JSON.stringify(facts, null, 2) + "\n\nWrite the email as strict JSON." }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).join("");
  const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  return { subject: String(json.subject || "").trim(), body: String(json.body || "").trim() };
}

// Fixed signature + CAN-SPAM footer appended to every send (never AI-varied).
export function signature() {
  return "\n\nBest,\nRyan Nead\nLume Search Partners\n929-543-0608";
}
export function footer() {
  return "\n\nLume Search Partners · 148 Doughty Blvd, Inwood, NY 11096";
}
