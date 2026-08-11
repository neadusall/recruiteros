// RecruitersOS · MPC quality gates (single source of truth, plain-node so it runs in the
// prod app container AND under the test harness). Every failure the Lume launch hit on
// 2026-08-10 came from junk data reaching the send path: the wrong ROLE (a "Data Science
// Intern" matched because a finance-titled manager sat nearby), the wrong PERSON (a
// decision-maker who actually works at a DIFFERENT company), and UNVERIFIED emails
// (catch-all guesses that bounce). These gates make that structurally impossible: a
// prospect must clear assessProspect() to be enrolled, and a written email must clear
// checkRenderedEmail() to be queued. Each failure returns a reason, so a held record
// always says why.

const ACCOUNTING_ROLE = /\b(controller|comptroller|cpa|certified public accountant|accountant|accounting|bookkeep(?:er|ing)|regulatory reporting|financial report|tax (?:manager|accountant|analyst|associate|director)|audit(?:or)?|fp&a|finance manager|finance director|director of finance|vp,? finance|head of finance)\b/i;

const VALID_DM_TITLE = /\b(cfo|chief financial officer|chief accounting officer|controller|comptroller|vp,? finance|vice president,? finance|head of finance|director of finance|finance director|chief executive|ceo|founder|owner|president|managing partner|chief operating officer|coo|head of talent|head of people|chief people)\b/i;

// Scraper artifacts that slip in as a "name" or email local-part (e.g. "Toggle Description",
// "Trending Topics", "Founder Managing", "measurable.results@..."). These are never a real person.
// Applied to the NAME and the email local-part only (NOT the title), so legit titles like
// "Founder" or "Managing Partner" are unaffected while a NAME of "Founder Managing" is rejected.
const JUNK_TOKEN = /\b(toggle|description|example|sample|measurable|results|placeholder|lorem|ipsum|undefined|unknown|noreply|no-reply|webmaster|postmaster|mailer|test|trending|topics?|founder|managing|ventures?|latest|news|blog|update|updates|subscribe|newsletter|header|footer|sidebar|cookie|privacy|terms|sitemap|categor(?:y|ies)|archive|featured|popular|related|readmore|learnmore|signup|signin|login|register|download|untitled|anonymous|admin|website|homepage)\b/i;
// Role/shared inboxes are never a named person we can pitch.
const ROLE_ACCOUNT = /^(info|admin|sales|hello|contact|support|careers?|jobs?|hr|team|office|marketing|billing|accounts?|enquir(?:y|ies)|inquiry|general|mail|email|newsletter|press|media|help|service|noreply|no-reply)$/i;

function normCompany(s) {
  return (s || "")
    .toLowerCase()
    .replace(/&#0?38;|&amp;/g, "&")
    .replace(/\b(inc|llc|ltd|corp|co|company|group|holdings|capital|partners|technologies|labs|the)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

// Detect a decision-maker whose title names a DIFFERENT employer (the FinTech-Futures/Xeal/
// Kapor mismatches). Returns the foreign company string, or null.
export function foreignAffiliation(managerTitle, company) {
  const t = (managerTitle || "").replace(/&#0?38;|&amp;/g, "&").trim();
  const co = normCompany(company);
  const patterns = [
    /@\s*([A-Za-z][\w.&' -]{1,50})$/,
    /\bat\s+([A-Z][\w.&' -]{1,50})$/,
    /\s[-–]\s*([A-Z][\w.&' -]{1,50})$/,
    /,\s*([A-Z][\w.&' -]{1,50})$/,
    /\bof\s+([A-Z][\w.&' -]{1,50})$/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const raw = m[1].trim();
      if (/^(finance|accounting|operations|strategy|talent|people)$/i.test(raw)) continue;
      const claimed = normCompany(raw);
      if (claimed && co && claimed !== co && !claimed.includes(co) && !co.includes(claimed)) return raw;
    }
  }
  return null;
}

function emailDomain(email) {
  return (email || "").split("@")[1]?.toLowerCase().trim() || "";
}

// The enrollment gate. Returns { eligible, failures[], warnings[] }.
export function assessProspect(p) {
  const failures = [];
  const warnings = [];

  if (!p.role || !ACCOUNTING_ROLE.test(p.role)) {
    failures.push(`role "${p.role || "?"}" is not an accounting/finance hire`);
  }

  const dmText = (p.managerName || "") + " " + (p.managerTitle || "");
  if (!p.managerName || !p.managerName.trim()) {
    failures.push("no named decision-maker");
  } else if (/coordinator|wellness|\bintern\b|talent (coordinator|solutions)|recruit(?:er|ing)|sourcer/i.test(dmText)) {
    failures.push(`decision-maker "${p.managerName} / ${p.managerTitle}" is not a buyer`);
  } else if (JUNK_TOKEN.test(p.managerName)) {
    failures.push(`decision-maker "${p.managerName}" looks like a parsed artifact, not a person`);
  } else if (!VALID_DM_TITLE.test(p.managerTitle || "")) {
    failures.push(`decision-maker title "${p.managerTitle || "?"}" is not a finance buyer`);
  }
  const foreign = foreignAffiliation(p.managerTitle || "", p.company);
  if (foreign) failures.push(`decision-maker works at a different company ("${foreign}"), not ${p.company}`);

  if (!p.likelyEmail) {
    failures.push("no email");
  } else {
    const local = p.likelyEmail.split("@")[0]?.toLowerCase().trim() || "";
    if (ROLE_ACCOUNT.test(local)) failures.push(`email ${p.likelyEmail} is a role/shared inbox, not a person`);
    if (JUNK_TOKEN.test(local)) failures.push(`email ${p.likelyEmail} local-part looks like a parsed artifact`);
    if (p.emailInvalid) failures.push("email marked undeliverable");
    if (!p.emailValidated) failures.push("email not validated");
    if (p.emailCatchAll) failures.push("email is a catch-all guess (person unconfirmed)");
    if (p.domain && emailDomain(p.likelyEmail) && emailDomain(p.likelyEmail) !== p.domain.toLowerCase()) {
      failures.push(`email domain (${emailDomain(p.likelyEmail)}) != company domain (${p.domain})`);
    }
  }

  if (p.jobLocation && /remote|united states|usa|anywhere/i.test(p.jobLocation) && !/,\s*[A-Z]{2}\b/.test(p.jobLocation)) {
    warnings.push("role is remote/national (no metro to pair)");
  }

  return { eligible: failures.length === 0, failures, warnings };
}

// Real metro (City, ST) to pair the pitch to, or null if remote/national.
export function metroOf(p) {
  const loc = (p.jobLocation || "").trim();
  const m = loc.match(/([A-Za-z .'-]+,\s*[A-Z]{2})\b/);
  if (!m || /remote/i.test(m[1])) return null;
  return m[1].trim();
}

const PLACEHOLDER = /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/;
const EM_DASH = /—/;

// The render gate. A written email may be QUEUED only if this passes.
export function checkRenderedEmail(subject, body) {
  const problems = [];
  const s = (subject || "").trim();
  const b = (body || "").trim();
  if (!s) problems.push("empty subject");
  if (!b) problems.push("empty body");
  if (PLACEHOLDER.test(s) || PLACEHOLDER.test(b)) problems.push("unfilled {{merge token}}");
  if (/\[[A-Za-z0-9 _/-]+\]/.test(b)) problems.push("leftover [placeholder]");
  if (EM_DASH.test(s) || EM_DASH.test(b)) problems.push("contains an em-dash");
  if (/\S {2,}\S|,\s*,|\byour {2,}/.test(b)) problems.push("blank merge hole (a field rendered empty)");
  const words = b.split(/\s+/).filter(Boolean).length;
  if (words > 130) problems.push(`body too long for cold (${words} words)`);
  return { ok: problems.length === 0, problems };
}
