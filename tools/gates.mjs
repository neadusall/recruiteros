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
const ORG_NAME = /\b(chamber|commerce|llc|inc|corp|corporation|company|association|foundation|institute|university|college|department|bureau|council|committee|society|organization|organisation|agency|coalition|alliance|federation|ministry|authority|advocates?|solutions?|services|staffing|consulting|consultants|associates|enterprises?|recruiting|recruitment|technologies|systems|global|dedicated)\b|[()@]/i;

// Scraper artifacts that slip in as a "name" or email local-part (e.g. "Toggle Description",
// "Trending Topics", "Founder Managing", "measurable.results@..."). These are never a real person.
// Applied to the NAME and the email local-part only (NOT the title), so legit titles like
// "Founder" or "Managing Partner" are unaffected while a NAME of "Founder Managing" is rejected.
const JUNK_TOKEN = /\b(toggle|description|example|sample|measurable|results|placeholder|lorem|ipsum|undefined|unknown|noreply|no-reply|webmaster|postmaster|mailer|test|trending|topics?|founder|managing|ventures?|latest|news|blog|update|updates|subscribe|newsletter|header|footer|sidebar|cookie|privacy|terms|sitemap|categor(?:y|ies)|archive|featured|popular|related|readmore|learnmore|signup|signin|login|register|download|untitled|anonymous|admin|website|homepage|continue|submit|\bapply\b|expand|collapse|loading|getstarted|viewmore|seemore|showmore|clickhere|gethelp|skipto|maincontent|thanks?|shopping|bio|select|compare|recent|previously|committee|profiles?|templates?|longterm|dedicated|engagement|county|journal|valuation|serve|executive|what|who|by)\b/i;

// A mangled character-encoding remnant in a "name" or a guessed email local-part: an HTML
// entity's digits surviving a strip ("president8217s" from &#8217;) or a de-slashed hex
// escape ("ox27donovan" from \x27, "jessxe9" from \xe9). Real people's names never carry
// these, and every one that reached the send queue on 8/18-19 bounced. 4+ consecutive
// digits included: pattern-guessed first.last locals never legitimately contain them.
const MANGLED_ENCODING = /\d{4,}|x2[0-9a-f]|xe[0-9a-f]/i;
// Role/shared inboxes are never a named person we can pitch.
const ROLE_ACCOUNT = /^(info|admin|sales|hello|contact|support|careers?|jobs?|hr|team|office|marketing|billing|accounts?|enquir(?:y|ies)|inquiry|general|mail|email|newsletter|press|media|help|service|noreply|no-reply)$/i;

// A "title" that is actually a scraped page heading ("Message from the CEO", "A word from our founder").
const HEADING_ARTIFACT = /\b(message|letter|note|word|greeting)\s+from\b|welcome\s+to|about\s+us/i;
// A single-word "name" that is really a website section, not a person (the "Hi Sustainability" leak).
const SECTION_WORD = /^(sustainability|careers?|about|leadership|team|company|contact|home|overview|mission|values|culture|news|blog|investors?|media|resources?|solutions?|products?|services?|support|community|events?|partners?)$/i;

/* ------------------------------------------------------------------------------------------
 * COMPETITOR GATE: never pitch a staffing/recruiting firm (owner mandate 2026-08-12, after the
 * MMD Services send: clean company name, but the founder's own title said "Queen of Staffing").
 * The app's classifyEmployer() is name-only; this judges the WHOLE record — name, industry,
 * the decision-maker's title, and domain — at the send chokepoint, where it's final.
 * ---------------------------------------------------------------------------------------- */

// Recruiting-TECH vendors (software companies, legitimate clients) whose names carry agency
// tokens; never treat these as competitors.
const RECRUITING_TECH_OK = /\b(smartrecruiters|recruitee|recruiterflow|zoho\s+recruit|recruit\s+holdings|recruitics|hireez|loxo)\b/i;

// Major staffing/recruiting/search brands whose names carry no generic token.
const KNOWN_AGENCY_BRAND = /\b(robert\s+half|randstad|adecco|manpower(?:group)?|kelly\s+services|aerotek|teksystems|insight\s+global|kforce|express\s+employment|korn\s+ferry|heidrick|spencer\s+stuart|russell\s+reynolds|michael\s+page|pagegroup|hays\s+(?:recruitment|plc)|allegis|apex\s+systems|beacon\s+hill|lasalle\s+network|lucas\s+group|cybercoders|jobot|\bgpac\b|aston\s+carter|yoh|volt\s+workforce|nelson\s+connects|vaco|jackson\s+(?:physician|nurse)|amn\s+healthcare|cross\s+country\s+healthcare|medical\s+solutions|aya\s+healthcare)\b/i;

// Generic agency tells in a company NAME (tuned to unambiguous combinations, mirroring the
// app's high-precision bias: a false positive deletes a real lead).
const AGENCY_NAME = /\b(staffing|recruit(?:ing|ment|ers?)|headhunt\w*|\brpo\b|executive\s+search|search\s+(?:firm|partners?|group|consultants?|associates|services|solutions|specialists|professionals|advisors|international)|talent\s+(?:search|solutions|partners|agency|group|acquisition)|personnel\s+(?:agency|services|group)|placement\s+(?:agency|firm|services|group)|temp\s+agency|workforce\s+(?:solutions|group)|employment\s+(?:agency|solutions|services))\b/i;

// Agency tells in an INDUSTRY field ("Staffing and Recruiting", "Human Capital", "RPO"...).
const AGENCY_INDUSTRY = /\b(staffing|recruit(?:ing|ment)|employment\s+agenc\w+|executive\s+search|talent\s+acquisition|human\s+capital|\brpo\b|headhunt\w*)\b/i;

// An owner-level DM whose OWN title says they run a staffing/search shop ("Founder (a.k.a.
// The Queen of Staffing)"). Owner-level words only, so a "VP Talent Acquisition" buyer at a
// real employer never trips this.
const AGENCY_OWNER_TITLE = /\b(founder|co-?founder|owner|principal|managing\s+(?:partner|director))\b/i;
const AGENCY_TRADE_WORD = /\b(staffing|recruit(?:ing|ment|er|ers)?|headhunt\w*|placements?|search\s+firm|talent\s+agency|\brpo\b)\b/i;

/** Is this prospect a staffing/recruiting firm? Returns the human-readable tell, or null. */
export function staffingFirmSignal(p) {
  const name = String(p.company || "");
  if (RECRUITING_TECH_OK.test(name)) return null;
  if (KNOWN_AGENCY_BRAND.test(name)) return `known agency brand in name "${name}"`;
  if (AGENCY_NAME.test(name)) return `agency term in company name "${name}"`;
  const industry = String(p.industry || "");
  if (AGENCY_INDUSTRY.test(industry)) return `industry says "${industry}"`;
  const title = String(p.managerTitle || "");
  if (AGENCY_OWNER_TITLE.test(title) && AGENCY_TRADE_WORD.test(title)) return `decision-maker's own title says they run one ("${title}")`;
  const domain = String(p.domain || (p.likelyEmail || "").split("@")[1] || "");
  if (/(staffing|recruit|headhunt|personnel)/i.test(domain) && !RECRUITING_TECH_OK.test(domain)) return `agency term in domain "${domain}"`;
  return null;
}

/* ------------------------------------------------------------------------------------------
 * DECISION-MAKER RESCUE: a junk "name" is sometimes recoverable — in the MMD Services record
 * the name field held the org string while the real person sat in the TITLE field ("Maria
 * Dubov, Founder (a.k.a. The Queen of Staffing)"). Deterministic extraction, so the lead is
 * FIXED before gating instead of thrown away. Precision-biased: on any doubt, no rescue.
 * ---------------------------------------------------------------------------------------- */

/** Pull an embedded "Firstname Lastname, Title" person out of a title string, or null. */
export function extractPersonFromTitle(title) {
  const t = String(title || "").trim();
  const m = t.match(/^([A-Z][\w'’.-]{1,24}(?:\s+[A-Z][\w'’.-]{1,24}){1,3})\s*[,–-]\s*(.{2,})$/);
  if (!m) return null;
  const name = m[1].trim();
  const rest = m[2].trim();
  const parts = name.split(/\s+/);
  if (parts.length < 2 || parts.length > 4) return null;
  if (ORG_NAME.test(name) || JUNK_TOKEN.test(name) || MANGLED_ENCODING.test(name) || SECTION_WORD.test(name) || HEADING_ARTIFACT.test(name)) return null;
  if (/\d/.test(name) || !/[a-z]/.test(name)) return null;
  // The remainder must read like a TITLE, not the second half of a company name.
  if (!/\b(founder|co-?founder|owner|ceo|cfo|coo|cto|cmo|cpo|cro|chief|president|director|vp|vice\s+president|head|principal|partner|manag(?:er|ing))\b/i.test(rest)) return null;
  return { name, title: rest };
}

/** If the lead's name field is junk but the title carries the real person, return a FIXED
 *  copy of the lead ({ managerName, managerTitle } swapped in, rescuedFrom noting the junk).
 *  Returns null when the name is fine or nothing recoverable is found. */
export function rescueDecisionMaker(p) {
  const n = (p.managerName || "").trim();
  const nameBad = !n || ORG_NAME.test(n) || JUNK_TOKEN.test(n) || MANGLED_ENCODING.test(n) || SECTION_WORD.test(n);
  if (!nameBad) return null;
  const found = extractPersonFromTitle(p.managerTitle);
  if (!found) return null;
  return { ...p, managerName: found.name, managerTitle: found.title, rescuedFrom: n || "(empty)" };
}

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

  // Competitor gate: staffing/recruiting firms are never clients (owner mandate 2026-08-12).
  const staffing = staffingFirmSignal(p);
  if (staffing) failures.push(`${p.company} is a staffing/recruiting firm (${staffing}); competitors are never pitched`);

  const dmText = (p.managerName || "") + " " + (p.managerTitle || "");
  if (!p.managerName || !p.managerName.trim()) {
    failures.push("no named decision-maker");
  } else if (/coordinator|wellness|\bintern\b|talent (coordinator|solutions)|recruit(?:er|ing)|sourcer/i.test(dmText)) {
    failures.push(`decision-maker "${p.managerName} / ${p.managerTitle}" is not a buyer`);
  } else if (JUNK_TOKEN.test(p.managerName)) {
    failures.push(`decision-maker "${p.managerName}" looks like a parsed artifact, not a person`);
  } else if (MANGLED_ENCODING.test(p.managerName)) {
    failures.push(`decision-maker "${p.managerName}" carries a mangled-encoding remnant, not a real name`);
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
    // Seniority fit for universal buyers (the 2026-08-12 Ping Identity leak: the FOUNDER & CEO of a
    // ~3,800-person company got the Lead Accountant pitch). At a small company the CEO genuinely is
    // the buyer for every seat, and for a senior-leadership hire (VP+/C-suite) the CEO is the buyer
    // at ANY size; past a few hundred heads an IC/manager hire never reaches that desk, and mailing
    // it reads as a blast and burns the domain. Fail closed with the reason, so the record is held
    // and the resolver can re-target the function that owns the role.
    const maxUniversalHeads = Number(process.env.MPC_UNIVERSAL_DM_MAX_HEADCOUNT || 500);
    if (dmFn === "universal" && roleFn !== "Executive" && !isSeniorHire(p.role)) {
      const heads = Number(p.employeeCount);
      if (Number.isFinite(heads) && heads >= maxUniversalHeads) {
        failures.push(`decision-maker "${p.managerTitle}" is a whole-company exec at a ${heads}-person company; a ${roleFamily(p.role)} hire there is owned by the ${roleFn} function, re-target the buyer`);
      } else if (!Number.isFinite(heads) || heads <= 0) {
        warnings.push(`CEO/founder buyer accepted with company size unknown (verify ${p.company} is small enough for a whole-company buyer)`);
      }
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
    if (MANGLED_ENCODING.test(local)) failures.push(`email ${p.likelyEmail} local-part carries a mangled-encoding remnant`);
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
  // A C-suite HIRE is an executive search, whatever function the seat runs: the buyer for a CFO
  // req is the CEO/board, not another CFO. Must run before the function patterns below (which
  // would otherwise claim "cfo" for Finance). Guarded so "Assistant to the CFO" etc. stay put.
  if (/\b(ceo|cfo|coo|cto|cmo|cpo|cro|chro|cio|ciso|chief\s+[a-z]+(?:\s+[a-z]+)?\s+officer)\b/.test(r) && !/\b(assistant|deputy|analyst|associate|coordinator|office\s+of|reporting\s+to)\b/.test(r)) return "Executive";
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

/* ------------------------------------------------------------------------------------------
 * BUYER CORRELATION (title-to-title): the job title determines who the legitimate buyer is.
 * The 2026-08-12 Ping Identity leak (Founder & CEO emailed a Lead Accountant pitch) happened
 * because "is this person senior?" was the only question asked. These helpers ask the right
 * one: "does THIS buyer's title correlate with THIS role?" — using everything the curated pool
 * knows about the company, not just the single row in hand.
 * ---------------------------------------------------------------------------------------- */

// A senior-leadership hire (VP+/C-suite/head-of): the CEO/President IS a legitimate buyer for
// these at any company size, so the whole-company-exec holds never apply to them.
export function isSeniorHire(role) {
  return /\b(ceo|cfo|coo|cto|cmo|cpo|cro|chro|cio|ciso|chief\s+[a-z]+(?:\s+[a-z]+)?\s+officer|vp|svp|evp|vice\s+president|head\s+of\s+\w+|president|managing\s+director|general\s+manager|executive\s+director)\b/i.test(String(role || ""));
}

export function companyKeyOf(company) {
  return String(company || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// What we KNOW about each company from ALL curated rows — including unnamed and ungated ones:
// how many distinct reqs it has open, and which functions provably have a leader. A row whose
// managerTitle is "Director of Finance" proves a finance org exists even when the person's
// name is still missing, and that knowledge must stop a CEO send for an accounting req.
export function buildCompanyKnowledge(rows) {
  const know = new Map();
  for (const r of rows || []) {
    const p = r.lead || r;
    const ck = companyKeyOf(p.company);
    if (!ck) continue;
    let k = know.get(ck);
    if (!k) know.set(ck, (k = { reqs: new Set(), fnLeaders: new Set() }));
    k.reqs.add(String(p.role || "").toLowerCase().trim());
    const fn = dmFunction(p.managerTitle);
    if (fn && fn !== "universal") k.fnLeaders.add(fn);
  }
  return know;
}

// Does this buyer's TITLE correlate with this ROLE? Returns { ok, rank, why }.
//   rank 0 — owns the role's function (CFO for an accounting req), or the CEO on an
//            executive/senior-leadership hire: always the right person.
//   rank 1 — ambiguous senior (a plain VP / Chief of Staff the resolver targeted): acceptable
//            only when the pool knows of nobody better at this company.
//   rank 2 — whole-company exec (CEO/founder/owner) on a non-senior role: right at a small
//            company, HELD (ok:false, with the reason) when the company demonstrably has a
//            leader for the role's function or looks too big for a founder-buys-everything shop.
export function buyerFit(p, know, opts = {}) {
  const fam = roleFamily(p.role);
  const roleFn = roleFunctionGroup(fam);
  const fn = dmFunction(p.managerTitle);
  if (roleFn === "Executive" || isSeniorHire(p.role)) {
    return { ok: true, rank: fn === "universal" || fn === roleFn ? 0 : 1 };
  }
  if (fn && fn !== "universal" && fn === roleFn) return { ok: true, rank: 0 };
  const k = know ? know.get(companyKeyOf(p.company)) : null;
  const hasLeader = !!(k && k.fnLeaders.has(roleFn));
  const maxHeads = Number(opts.maxUniversalHeads || process.env.MPC_UNIVERSAL_DM_MAX_HEADCOUNT || 500);
  const bigReqs = Number(opts.bigReqs || process.env.MPC_BIG_COMPANY_REQS || 8);
  const heads = Number(p.employeeCount);
  const looksBig = (Number.isFinite(heads) && heads >= maxHeads) || !!(k && k.reqs.size >= bigReqs);
  if (fn === "universal") {
    if (hasLeader) return { ok: false, why: `${p.company} has a ${roleFn} leader in the pool; hold the CEO/founder row until that person is named` };
    if (looksBig) return { ok: false, why: `${p.company} looks too big (${Number.isFinite(heads) && heads > 0 ? heads + " heads" : (k ? k.reqs.size : "?") + " open reqs"}) for a whole-company buyer on a ${fam} hire` };
    return { ok: true, rank: 2 };
  }
  if (fn === null) {
    if (hasLeader) return { ok: false, why: `${p.company} has a ${roleFn} leader in the pool; hold the ambiguous-title ("${p.managerTitle}") row` };
    return { ok: true, rank: 1 };
  }
  // A clear different-function exec: assessProspect rejects these already; belt and suspenders.
  return { ok: false, why: `"${p.managerTitle}" owns ${fn}, not the ${roleFn} function this role sits in` };
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

// Spam-filter trigger vocabulary (mirrors lib/copy/guidelines SPAM_TRIGGERS): content
// filters and enterprise gateways score against promotional-pressure language, and cold
// copy that needs any of it is pitching too hard anyway. Word-boundary + phrase-level so
// normal recruiting prose never false-positives.
const SPAM_TRIGGERS = [
  ["guarantee(d)", /\bguarantee[ds]?\b/i],
  ["risk-free / no risk", /\brisk[\s-]?free\b|\bno\s+risk\b/i],
  ["free-offer language", /\b(for\s+free|free\s+(trial|consultation|demo|gift|quote|offer)|100%\s*free|free\s+of\s+charge)\b/i],
  ["urgency pressure", /\b(act\s+now|don'?t\s+wait|limited\s+time|expires?\s+(today|soon|tomorrow)|last\s+chance|once[\s-]in[\s-]a[\s-]lifetime|urgent(ly)?)\b/i],
  ["click here", /\bclick\s+(here|below|now|this\s+link)\b/i],
  ["no obligation / no cost", /\bno\s+(obligation|cost|catch|strings|hidden\s+fees?)\b/i],
  ["money-promise language", /\b(make|earn|save)\s+(big\s+)?(money|cash|\$)|\bdouble\s+your\b|\bmoney[\s-]back\b|\bget\s+paid\b|\$\$\$/i],
  ["winner / congratulations", /\bcongratulations\b|\byou(?:'?ve| have)\s+(won|been\s+selected)\b|\bwinner\b/i],
  ["promotion language", /\b(special\s+(promotion|offer|deal)|exclusive\s+(deal|offer)|best\s+price|lowest\s+price|order\s+now|buy\s+now)\b/i],
  ["exclamation run", /!{2,}/],
];

// A remote/national role must never claim the candidates are "local to your market" (the
// 2026-08-12 Ping leak: metro=remote yet the body pitched local candidates). Phrase-level so
// a legit named metro ("local to Denver") on a metro'd role never false-positives.
const LOCAL_CLAIM = /\blocal to (?:your|the)\b|\byour (?:local )?(?:market|area|metro|backyard)\b|\bin your (?:city|area|market|region)\b|\bnear you\b/i;

// The render gate. A written email may be QUEUED only if this passes. Pass { remote: true }
// when the role has no metro so local-market claims are rejected.
export function checkRenderedEmail(subject, body, opts = {}) {
  const problems = [];
  const s = (subject || "").trim();
  const b = (body || "").trim();
  if (opts.remote && (LOCAL_CLAIM.test(s) || LOCAL_CLAIM.test(b))) {
    problems.push("claims local candidates on a remote/national role");
  }
  if (!s) problems.push("empty subject");
  if (!b) problems.push("empty body");
  if (PLACEHOLDER.test(s) || PLACEHOLDER.test(b)) problems.push("unfilled {{merge token}}");
  if (/\[[A-Za-z0-9 _/-]+\]/.test(b)) problems.push("leftover [placeholder]");
  if (EM_DASH.test(s) || EM_DASH.test(b)) problems.push("contains an em-dash");
  if (/\S {2,}\S|,\s*,|\byour {2,}/.test(b)) problems.push("blank merge hole (a field rendered empty)");
  for (const [label, re] of SPAM_TRIGGERS) {
    if (re.test(s) || re.test(b)) { problems.push(`spam-filter trigger: ${label}`); break; }
  }
  const words = b.split(/\s+/).filter(Boolean).length;
  if (words > 130) problems.push(`body too long for cold (${words} words)`);
  // Exactly ONE soft CTA: a second question is the writer stacking closes ("Worth a call?
  // Open to a sync this week?"), which reads as pushy template output.
  const questions = (b.match(/\?/g) || []).length;
  if (questions > 1) problems.push(`more than one question/CTA (${questions})`);
  // Stock recruiter filler the writer is told to avoid but sometimes reaches for anyway.
  if (/\brigou?r\s+(?:\w+\s+){0,3}demands\b/i.test(b) || /\bi hope this (?:email )?finds you\b/i.test(b) || /\bi wanted to reach out\b/i.test(b)) {
    problems.push("stock filler phrase (rigor-demands / hope-this-finds-you / wanted-to-reach-out)");
  }
  return { ok: problems.length === 0, problems };
}
