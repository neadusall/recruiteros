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

// A senior buyer for ANY function Lume recruits: C-level, President/VP/SVP/EVP, Head of X,
// Director of X, Managing Director/Partner, Founder/Owner, GM. The decision-maker resolver already
// targets the OPEN ROLE's owning function, so this just confirms the person is senior enough to buy.
const VALID_DM_TITLE = /\b(c[efoimrph]o|chief\s+(?:executive|financial|accounting|operating|revenue|marketing|technology|technical|product|people|human|legal|information)\w*|president|vice\s+president|\bvp\b|\bsvp\b|\bevp\b|head\s+of\s+\w+|director\s+of\s+\w+|managing\s+(?:director|partner)|\bpartner\b|founder|co-?founder|owner|general\s+manager|\bgm\b)\b/i;

// "Controller" titles that are NOT accounting: document/quality/inventory control etc. (the
// 2026-08-11 "EPC Document Controller" leak). Rejected unless the role is otherwise clearly finance.
const NON_FINANCE_CONTROLLER = /\b(document|doc|quality|inventory|materials?|production|stock|warehouse|traffic|pest|project|export|logistics)\s+control/i;

// A "name" that is actually an organization (the "Hispanic Chamber of Commerce" leak): org words,
// or any parenthetical/@ in the name field. Real people's names carry none of these.
const ORG_NAME = /\b(chamber|commerce|llc|inc|corp|corporation|company|association|foundation|institute|university|college|department|bureau|council|committee|society|organization|organisation|agency|coalition|alliance|federation|ministry|authority)\b|[()@]/i;

// Scraper artifacts that slip in as a "name" or email local-part (e.g. "Toggle Description",
// "Trending Topics", "Founder Managing", "measurable.results@..."). These are never a real person.
// Applied to the NAME and the email local-part only (NOT the title), so legit titles like
// "Founder" or "Managing Partner" are unaffected while a NAME of "Founder Managing" is rejected.
const JUNK_TOKEN = /\b(toggle|description|example|sample|measurable|results|placeholder|lorem|ipsum|undefined|unknown|noreply|no-reply|webmaster|postmaster|mailer|test|trending|topics?|founder|managing|ventures?|latest|news|blog|update|updates|subscribe|newsletter|header|footer|sidebar|cookie|privacy|terms|sitemap|categor(?:y|ies)|archive|featured|popular|related|readmore|learnmore|signup|signin|login|register|download|untitled|anonymous|admin|website|homepage|continue|submit|\bapply\b|expand|collapse|loading|getstarted|viewmore|seemore|showmore|clickhere|gethelp|skipto|maincontent)\b/i;
// Role/shared inboxes are never a named person we can pitch.
const ROLE_ACCOUNT = /^(info|admin|sales|hello|contact|support|careers?|jobs?|hr|team|office|marketing|billing|accounts?|enquir(?:y|ies)|inquiry|general|mail|email|newsletter|press|media|help|service|noreply|no-reply)$/i;

// A "title" that is actually a scraped page heading ("Message from the CEO", "A word from our founder").
const HEADING_ARTIFACT = /\b(message|letter|note|word|greeting)\s+from\b|welcome\s+to|about\s+us/i;
// A single-word "name" that is really a website section, not a person (the "Hi Sustainability" leak).
const SECTION_WORD = /^(sustainability|careers?|about|leadership|team|company|contact|home|overview|mission|values|culture|news|blog|investors?|media|resources?|solutions?|products?|services?|support|community|events?|partners?)$/i;

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

  if (!p.role || roleFamily(p.role) === "Other") {
    failures.push(`role "${p.role || "?"}" is not a professional hire we staff for`);
  }

  const dmText = (p.managerName || "") + " " + (p.managerTitle || "");
  if (!p.managerName || !p.managerName.trim()) {
    failures.push("no named decision-maker");
  } else if (/coordinator|wellness|\bintern\b|talent (coordinator|solutions)|recruit(?:er|ing)|sourcer/i.test(dmText)) {
    failures.push(`decision-maker "${p.managerName} / ${p.managerTitle}" is not a buyer`);
  } else if (JUNK_TOKEN.test(p.managerName)) {
    failures.push(`decision-maker "${p.managerName}" looks like a parsed artifact, not a person`);
  } else if (SECTION_WORD.test(p.managerName.trim())) {
    failures.push(`decision-maker "${p.managerName}" is a page section, not a person`);
  } else if (ORG_NAME.test(p.managerName)) {
    failures.push(`decision-maker "${p.managerName}" looks like an organization, not a person`);
  } else if (HEADING_ARTIFACT.test(p.managerTitle || "")) {
    failures.push(`decision-maker title "${p.managerTitle}" is a scraped page heading, not a title`);
  } else if (!VALID_DM_TITLE.test(p.managerTitle || "")) {
    failures.push(`decision-maker title "${p.managerTitle || "?"}" is not a senior buyer`);
  } else {
    // Function alignment: the buyer must OWN the role's function (a CFO can't be the buyer for a
    // sales role). Universal buyers (CEO/founder/owner) hire across everything, so they always pass;
    // ambiguous titles (a plain VP/Director) pass since the resolver targeted them for this role.
    const roleFn = roleFunctionGroup(roleFamily(p.role));
    const dmFn = dmFunction(p.managerTitle);
    if (dmFn && dmFn !== "universal" && roleFn !== "Executive" && dmFn !== roleFn) {
      failures.push(`decision-maker "${p.managerTitle}" owns ${dmFn}, not the ${roleFn} function this role sits in`);
    }
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

// The role family a posting belongs to, ACROSS the functions Lume recruits (not just finance).
// Returns a specific family, or "Other" when the title isn't a professional hire we staff for.
// Used both as the enrollment gate (Other is rejected) and to group prospects into cohorts, and
// it drives the email pitch so each company hears about the RIGHT kind of candidate.
export function roleFamily(role) {
  const r = (role || "").toLowerCase();
  if (/\bintern(ship)?\b|\bvolunteer\b|\bseasonal\b|\bapprentice\b/.test(r)) return "Other";
  // Finance / accounting (guard the "controller" false-positives: document/quality/etc. control).
  if (/\b(controller|comptroller)\b/.test(r) && !NON_FINANCE_CONTROLLER.test(r)) return "Accounting";
  if (/\b(cpa|certified public accountant|accountant|accounting|bookkeep(?:er|ing))\b/.test(r)) return "Accounting";
  if (/\btax\b/.test(r)) return "Tax";
  if (/\baudit(?:or)?\b/.test(r)) return "Audit";
  if (/\b(cfo|chief financial|finance manager|finance director|director of finance|vp,? finance|head of finance|fp&a|financial planning|financial analyst|treasur\w*)\b/.test(r)) return "Finance";
  // Commercial + technical + leadership functions.
  if (/\b(sales|account executive|\bae\b|business development|\bbdr\b|\bsdr\b|account manager|revenue officer|\bcro\b|sales manager|sales director)\b/.test(r)) return "Sales";
  if (/\b(marketing|demand gen(?:eration)?|growth marketing|brand manager|content marketing|\bseo\b|\bcmo\b|communications manager|social media manager)\b/.test(r)) return "Marketing";
  if (/\b(software engineer|engineer|engineering|developer|full[- ]?stack|back[- ]?end|front[- ]?end|devops|\bsre\b|data scientist|data engineer|machine learning|\bml\b|\bcto\b|solutions architect|platform architect)\b/.test(r)) return "Engineering";
  if (/\b(product manager|product owner|head of product|vp,? product|\bcpo\b|director of product)\b/.test(r)) return "Product";
  if (/\b(operations manager|head of operations|supply chain|logistics|procurement|\bcoo\b|director of operations|ops manager)\b/.test(r)) return "Operations";
  if (/\b(human resources|people operations|\bchro\b|head of people|vp,? people|talent acquisition (?:manager|director|lead)|hr (?:manager|director|business partner))\b/.test(r)) return "People / HR";
  if (/\b(general counsel|corporate counsel|attorney|associate general counsel|compliance officer|chief legal)\b/.test(r)) return "Legal";
  if (/\b(chief executive|\bceo\b|\bpresident\b|general manager|managing director|executive director)\b/.test(r)) return "Executive";
  return "Other";
}

// The candidate type we pitch for a given open role, phrased the way a recruiter would say it
// ("accounting and finance", "sales", "software engineering"). Keeps the email on-target.
export function candidateType(role) {
  switch (roleFamily(role)) {
    case "Accounting": case "Finance": case "Tax": case "Audit": return "accounting and finance";
    case "Sales": return "sales";
    case "Marketing": return "marketing";
    case "Engineering": return "software engineering and technical";
    case "Product": return "product management";
    case "Operations": return "operations and supply chain";
    case "People / HR": return "HR and people";
    case "Legal": return "legal";
    case "Executive": return "executive and leadership";
    default: return "";
  }
}

// Collapse the finance-ish families into one "Finance" function group, so a CFO counts as the buyer
// for any accounting/finance/tax/audit role. Other families map to themselves.
export function roleFunctionGroup(fam) {
  return (fam === "Accounting" || fam === "Finance" || fam === "Tax" || fam === "Audit") ? "Finance" : fam;
}

// The function a decision-maker OWNS, inferred from their title. "universal" = a whole-company buyer
// (CEO/founder/owner/president) who hires across every function. null = ambiguous (a plain VP/Director/
// Head with no clear function) which we allow, since the resolver targeted them for the role. A
// CLEAR, different-function exec (a CFO on a sales role) is what we want to catch and reject.
export function dmFunction(title) {
  const t = (title || "").toLowerCase();
  if (/\b(ceo|chief executive|founder|co-?founder|owner|president|general manager|\bgm\b|managing director|managing partner)\b/.test(t)) return "universal";
  if (/\b(cfo|chief financial|chief accounting|controller|comptroller)\b/.test(t) || /\bfinance\b/.test(t)) return "Finance";
  if (/\b(cro|chief revenue)\b/.test(t) || /\bsales\b/.test(t)) return "Sales";
  if (/\b(cmo|chief marketing)\b/.test(t) || /\bmarketing\b/.test(t)) return "Marketing";
  if (/\b(cto|chief technology|chief technical)\b/.test(t) || /\bengineering\b/.test(t)) return "Engineering";
  if (/\b(cpo|chief product)\b/.test(t) || /\bproduct\b/.test(t)) return "Product";
  if (/\b(coo|chief operating)\b/.test(t) || /\boperations\b/.test(t) || /supply chain/.test(t)) return "Operations";
  if (/\b(chro|chief people|chief human)\b/.test(t) || /\bpeople\b/.test(t) || /human resources/.test(t) || /\btalent\b/.test(t)) return "People / HR";
  if (/chief legal|general counsel/.test(t) || /\blegal\b/.test(t)) return "Legal";
  return null;
}

// The cohort key a prospect belongs to (industry | role-family | metro). The Growth Engine groups
// by it, decisions are keyed on it, and the sender skips prospects in a suppressed cohort, so all
// three stay in lockstep.
export function cohortKeyOf(p) {
  const industry = (p.industry || "General").trim();
  const metro = metroOf(p) || "Remote / National";
  return `${industry} | ${roleFamily(p.role)} | ${metro}`;
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
