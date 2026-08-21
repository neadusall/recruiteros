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
// NOTE the acronym class: it was `c[efoimrph]o`, which has no "t" — so a decision-maker titled
// plainly "CTO" was rejected as "not a senior buyer", losing the single most correct owner of every
// engineering req. "t" and "s" (CTO, CSO) added 2026-08-20. Bare "director" stays out on purpose:
// "Board Director" is not a hiring buyer, while "Director of X" is.
const VALID_DM_TITLE = /\b(c[efoimrphts]o|chief\s+(?:executive|financial|accounting|operating|revenue|marketing|technology|technical|product|people|human|legal|information|nursing|medical|clinical|data|customer)\w*|president|vice\s+president|\bvp\b|\bsvp\b|\bevp\b|head\s+of\s+\w+|director\s+of\s+\w+|managing\s+(?:director|partner)|\bpartner\b|founder|co-?founder|owner|general\s+manager|\bgm\b|plant\s+manager|nurse\s+manager|practice\s+(?:manager|administrator))\b/i;

// "Controller" titles that are NOT accounting: document/quality/inventory control etc. (the
// 2026-08-11 "EPC Document Controller" leak). Rejected unless the role is otherwise clearly finance.
const NON_FINANCE_CONTROLLER = /\b(document|doc|quality|inventory|materials?|production|stock|warehouse|traffic|pest|project|export|logistics)\s+control/i;

/* ------------------------------------------------------------------------------------------
 * NON-DESK PROFESSIONAL FAMILIES (added 2026-08-20). Before this, roleFamily() knew only the
 * office functions, so every clinical, trades, construction and insurance req fell through to
 * "Other" and was hard-rejected by assessProspect — AFTER the pipeline had already paid to
 * resolve a domain, name a decision-maker and validate an email for it. 35.7% of the curated
 * pool (6,361 of 17,833 rows) was landing there. These four patterns give those reqs a real
 * family, which means a real owning function, which means a real decision-maker to target.
 * ---------------------------------------------------------------------------------------- */

// Clinical + allied health. "counselor" is qualified on purpose: a bare match would swallow
// "Financial Counselor" / "Admissions Counselor", which are not clinical hires.
const CLINICAL_ROLE = /\b(registered nurse|\brn\b|\blpn\b|\blvn\b|\bcna\b|nurse practitioner|nursing|nurse|physician assistant|physician|surgeon|medical assistant|medical technologist|clinical (?:director|manager|supervisor|specialist|coordinator|research|liaison|pharmacist)|physical therap(?:y|ist)|occupational therap(?:y|ist)|speech(?:[- ]language)? patholog(?:y|ist)|respiratory therap(?:y|ist)|radiolog(?:y|ic|ist)|sonographer|ultrasound tech\w*|phlebotom(?:y|ist)|pharmacist|pharmacy tech\w*|dental (?:hygienist|assistant)|dentist|optometrist|veterinar(?:y|ian)|behavior(?:al)? (?:technician|analyst)|\bbcba\b|\brbt\b|social worker|\blcsw\b|(?:mental health|behavioral|clinical|substance abuse|school|guidance) counselor|therapist|dietitian|paramedic|\bemt\b|surgical tech\w*|medical (?:coder|biller|records)|patient care|caregiver|home health aide|\bhha\b|certified nursing assistant)\b/i;

// Licensed trades + plant floor. Deliberately below the Engineering pattern above, so an
// "HVAC Service Engineer" still reads as engineering.
const TRADES_ROLE = /\b(welder|welding|machinist|\bcnc\b|fabricator|millwright|electrician|plumber|pipefitter|steamfitter|hvac|refrigeration|diesel mechanic|automotive technician|maintenance (?:technician|mechanic|supervisor)|industrial maintenance|assembler|assembly (?:technician|operator)|machine operator|forklift|warehouse associate|production (?:associate|operator|technician|supervisor)|quality (?:inspector|technician)|tool and die|sheet metal|boilermaker|lineman|cdl|truck driver|delivery driver)\b/i;

// Construction / field trades leadership.
const CONSTRUCTION_ROLE = /\b(construction|superintendent|estimator|foreman|general contractor|carpenter|mason|roofer|glazier|concrete|drywall|heavy equipment operator|crane operator|safety (?:manager|coordinator|officer))\b/i;

// Insurance underwriting, claims and actuarial: these roll up the finance leadership chain.
const INSURANCE_ROLE = /\b(underwrit(?:er|ing)|claims (?:adjuster|examiner|specialist|manager|representative)|actuar(?:y|ial|ies)|loss control|risk analyst|insurance (?:agent|producer))\b/i;

// A department / function / region name, as it appears in the TAIL of a title ("Director of
// Nursing", "VP, Supply Chain", "Head of Revenue Operations - EMEA"). Used by foreignAffiliation
// to tell a title's own department from a different employer's name.
const FUNCTION_TAIL = /\b(financ\w*|accounting|tax|audit\w*|treasury|payroll|operations|ops|sales|marketing|growth|communications|engineering|technolog\w*|technical|software|product|design|data|analytics|strategy|talent|people|human resources|\bhr\b|legal|counsel|compliance|risk|nursing|clinical|medical|quality|safety|manufacturing|production|supply chain|logistics|procurement|purchasing|facilities|maintenance|construction|field|customer|support|business development|partnerships|underwriting|claims|admissions|education|research|training|administration|program\w*|project\w*|retail|ecommerce|digital|content|brand|public relations|investor relations|development|services|affairs|success|experience|acquisition|planning|management|excellence|innovation|transformation|infrastructure|security|revenue|corporate|global|north america|americas|\bemea\b|\bapac\b|east|west|central|region\w*)\b/i;

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
  // Pairs of [pattern, isTitleGrammar]. "of X" / ", X" / "- X" are how a title names its own
  // DEPARTMENT ("Director of Nursing", "Director, Finance"), so those get the full function-word
  // check below. "at X" / "@ X" almost always name a real employer, so they keep the strict read.
  //
  // THE BUG THIS FIXES (found 2026-08-20): the skip list here was six words long
  // (finance|accounting|operations|strategy|talent|people), so "Director of Nursing", "VP of
  // Manufacturing", "Head of Engineering" and every other function tail were being reported as a
  // DIFFERENT EMPLOYER and rejected. Titles with no "of" tail — "Chief Executive Officer" — were
  // never touched, so this quietly deleted the function owners and kept the founders. It is a
  // direct contributor to the CEO-heavy send mix the 08-20 audit measured.
  const patterns = [
    [/@\s*([A-Za-z][\w.&' -]{1,50})$/, false],
    [/\bat\s+([A-Z][\w.&' -]{1,50})$/, false],
    [/\s[-–]\s*([A-Z][\w.&' -]{1,50})$/, true],
    [/,\s*([A-Z][\w.&' -]{1,50})$/, true],
    [/\bof\s+([A-Z][\w.&' -]{1,50})$/, true],
  ];
  for (const [re, titleGrammar] of patterns) {
    const m = t.match(re);
    if (m) {
      const raw = m[1].trim();
      if (/^(finance|accounting|operations|strategy|talent|people)$/i.test(raw)) continue;
      if (titleGrammar && FUNCTION_TAIL.test(raw)) continue;
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
    // ROLE-OWNER ONLY (owner mandate 2026-08-20). The audit of the live store found 68.5% of
    // sendable rows pointed at a CEO/founder rather than the person who owns the open req, and
    // in 48.7% of those the pool ALREADY named the right function leader at that same company.
    // The rule is now absolute: for a normal req we mail the leader of the function the role sits
    // in, and nobody else. The only carve-out is an executive search (a VP+/C-suite req), where
    // the CEO/President genuinely IS the hiring decision-maker for that particular role.
    const fam = roleFamily(p.role);
    const roleFn = roleFunctionGroup(fam);
    const dmFn = dmFunction(p.managerTitle);
    const execReq = roleFn === "Executive" || isSeniorHire(p.role);
    // TRANSITION vs STRICT (owner decision 2026-08-20, after the first strict dry run).
    //   strict     — the mandate in full: owner of the role's function, or hold.
    //   transition — keep the desk running on the store we already have while the pipeline
    //                re-curates under the new targeting. The owner is still ALWAYS preferred
    //                (batch.mjs re-points to them whenever the pool knows who they are, and
    //                sends in rank order), but a whole-company exec or an ambiguous senior is
    //                allowed through when nobody better is known for that req. What stays
    //                rejected in BOTH modes is a clearly different-function exec, which was
    //                never defensible.
    // Flip with MPC_TARGETING_MODE=strict in .env.production. No code change needed.
    const strictOwner = (process.env.MPC_TARGETING_MODE || "transition").toLowerCase() === "strict";
    const isOwner = !!(dmFn && dmFn !== "universal" && dmFn === roleFn);
    // The talent leader buys hiring for every function (see isTalentBuyer). STRICT mode still
    // holds a company-level buyer row, because strict exists to demand a buyer resolved against
    // THIS req and those rows never were: they are the CHRO mined once per company carrying
    // whatever req happened to be in hand, and 45.7% of the store looks like that. In transition
    // mode, which is what runs today, they send, and that is where the unlocked volume comes from.
    const talentBuyer = isTalentBuyer(p.managerTitle) && !(strictOwner && p.companyBuyerRow);
    if (execReq) {
      // A leadership hire: the whole-company exec or that function's own exec both qualify,
      // and so does the talent leader, who typically runs executive search at that company.
      if (dmFn && dmFn !== "universal" && dmFn !== roleFn && !talentBuyer) {
        failures.push(`decision-maker "${p.managerTitle}" owns ${dmFn}, not the ${roleFn} function this leadership role sits in`);
      }
    } else if (isOwner || talentBuyer) {
      /* the owner of the req, or the talent leader who buys hiring for every function */
    } else if (!strictOwner) {
      // Transition: everything except a clearly different-function exec.
      if (dmFn && dmFn !== "universal" && dmFn !== roleFn) {
        failures.push(`decision-maker "${p.managerTitle}" owns ${dmFn}, not the ${roleFn} function this role sits in`);
      }
    } else if (p.companyBuyerRow) {
      // A company-level buyer row (the Head of People / C-suite mined once per company by the
      // curation pass). Those people were never resolved against THIS req, so they are not the
      // owner of it. 45.7% of the curated store is these rows.
      failures.push(`decision-maker "${p.managerName}" is a company-level buyer, not the owner of the "${p.role}" req`);
    } else if (dmFn === "universal") {
      failures.push(`decision-maker "${p.managerTitle}" is a whole-company exec; this ${fam} req is owned by the ${roleFn} function, re-target the owner`);
    } else if (dmFn === null) {
      failures.push(`decision-maker title "${p.managerTitle}" names no function, so it cannot be confirmed as the owner of a ${roleFn} req`);
    } else if (dmFn !== roleFn) {
      failures.push(`decision-maker "${p.managerTitle}" owns ${dmFn}, not the ${roleFn} function this role sits in`);
    }
  }

  // HEADCOUNT BAND (owner mandate 2026-08-20): only companies of 100-1,000 employees. This is a
  // CONFIRMED-size gate and it fails closed — an unconfirmed company is held, never mailed on a
  // guess. tools/company-size.mjs resolves real LinkedIn headcounts into the shared size cache,
  // and batch.mjs attaches them to the prospect before this runs.
  // A company we have POSITIVELY CONFIRMED is outside 100-1,000 is rejected in BOTH modes: that is
  // not unused data, it is data telling us not to send. Only the treatment of an UNCONFIRMED size
  // differs: strict holds it (never mail on a guess), transition lets it through with a warning so
  // the desk is not throttled by resolver coverage while the cache fills in.
  const minHeads = Number(process.env.MPC_MIN_HEADCOUNT || 100);
  const maxHeads = Number(process.env.MPC_MAX_HEADCOUNT || 1000);
  const sizeStrict = (process.env.MPC_SIZE_MODE || "known-bad-only").toLowerCase() === "confirmed";
  const heads = Number(p.employeeCount);
  if (!Number.isFinite(heads) || heads <= 0) {
    if (sizeStrict) {
      failures.push(`company size for ${p.company} is unconfirmed; the ${minHeads}-${maxHeads} employee mandate needs a verified headcount`);
    } else {
      warnings.push(`${p.company} size unconfirmed (sent under transition mode; run tools/company-size.mjs to resolve it)`);
    }
  } else if (heads < minHeads || heads > maxHeads) {
    failures.push(`${p.company} has ${heads} employees, outside the ${minHeads}-${maxHeads} employee target band`);
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
  // GTM / revenue operations sits with Sales: the CRO owns the number these seats serve.
  if (/\b(revenue operations|revops|sales operations|gtm operations|deal desk|sales enablement)\b/.test(r)) return "Sales";
  if (/\b(operations manager|head of operations|supply chain|logistics|procurement|\bcoo\b|director of operations|ops manager)\b/.test(r)) return "Operations";
  if (/\b(human resources|people operations|\bchro\b|head of people|vp,? people|talent acquisition (?:manager|director|lead)|hr (?:manager|director|business partner))\b/.test(r)) return "People / HR";
  if (/\b(general counsel|corporate counsel|attorney|associate general counsel|compliance officer|chief legal)\b/.test(r)) return "Legal";
  if (/\b(customer success|customer experience|client success|client services|account management|customer support manager|implementation manager|onboarding manager)\b/.test(r)) return "Customer Success";
  if (/\b(data analyst|data scien\w*|analytics|business intelligence|\bbi\b|data engineer\w*|reporting analyst)\b/.test(r)) return "Data";
  // ---- Non-desk professional hires (added 2026-08-20). These were ALL falling into "Other" and
  // being hard-rejected after we had already paid to name a decision-maker for them.
  // Clinical / allied health: owned by the nursing, medical or clinical leader, never the CEO.
  if (CLINICAL_ROLE.test(r)) return "Healthcare";
  // Licensed skilled trades + plant floor: owned by the plant/production/operations leader.
  if (TRADES_ROLE.test(r)) return "Skilled Trades";
  // Construction / field: owned by the operations or construction leader.
  if (CONSTRUCTION_ROLE.test(r)) return "Construction";
  // Insurance underwriting/claims/actuarial: sits under the finance leadership chain.
  if (INSURANCE_ROLE.test(r)) return "Insurance";
  if (/\b(chief executive|\bceo\b|\bpresident\b|general manager|managing director|executive director)\b/.test(r)) return "Executive";
  // ---- PROFESSIONAL OFFICE FAMILIES the patterns above miss (added 2026-08-21).
  // Measured on the live store: 803 IN-BAND rows had already been fully enriched (domain resolved,
  // decision-maker named, email verified) and were then hard-rejected as "not a professional hire
  // we staff for". Reviewing all 373 distinct titles behind those rows, roughly half are genuinely
  // this desk's work and half are correctly refused (freelance translators, contract interpreters,
  // per-diem physicians, retail store leaders, a news columnist). Only the first half is added.
  //
  // Each maps onto an EXISTING family on purpose. Inventing a "Design" or "IT" family would only
  // trade a role-family rejection for an owns-the-wrong-function one, because dmFunction() and
  // roleFunctionGroup() would have no owner chain for the new name.
  //
  // EVERY branch below is guarded against the function it would otherwise STEAL. These patterns run
  // ahead of the last-resort block, so an unguarded verb quietly re-homes reqs that were already
  // classified correctly: a diff over all 20,031 curated roles caught "Product Designer" reading as
  // Marketing, "Payroll Specialist" as People/HR and "Legal Billing Specialist" as Accounting.
  // Re-run tools/test-rolefamily.mjs after touching any of them.
  //
  // Accounting operations: AR/AP, billing, collections, credit. The word "accounting" never
  // appears in these titles, which is exactly why they fell through to Other. Healthcare revenue
  // cycle IS medical billing, so it belongs here and not in Sales (where "revenue" used to put it);
  // law-firm billing stays with Legal.
  if (!/\blegal\b/.test(r) && /\b(accounts? (?:receivable|payable)|billing (?:specialist|analyst|manager|coordinator|clerk)|collections? (?:specialist|analyst|manager|representative)|credit and collections|revenue cycle|invoic\w+)\b/.test(r)) return "Accounting";
  // Credit and financial-risk analysis sit on the finance chain (the CFO buys these).
  if (/\b(credit (?:analyst|risk|manager|officer)|financial risk)\b/.test(r)) return "Finance";
  // Talent, compensation and employee relations are People/HR work even with no "HR" in the title.
  // "patient recruiter" is a clinical-trials seat, not a talent one. Payroll stays with Finance
  // (dmFunction puts payroll on the CFO chain), so a combined "Payroll & Benefits Administrator"
  // must not be pulled across by the benefits half of this pattern.
  if (!/\b(patient|payroll)\b/.test(r) && /\b(recruit(?:er|ing|ment)|talent (?:partner|sourcer)|sourcer|compensation|benefits (?:analyst|manager|specialist|administrator)|employee relations|labor relations|hris)\b/.test(r)) return "People / HR";
  // Advertising / paid media / lifecycle report to the CMO with the rest of marketing.
  if (/\b(advertis\w+|paid (?:social|search|media)|sem|ppc|media buyer|lifecycle marketing|growth manager|merchandis\w+|copywriter|public relations)\b/.test(r)) return "Marketing";
  // Design + creative also report into marketing at 100-1,000 employees, so the CMO is the buyer.
  // Guarded against product and engineering: a "Product Designer" is a Product req and a "Software
  // UX/UI Design Lead" is an Engineering one, and both were being pulled into Marketing.
  if (!/\b(product|software|engineer\w*)\b/.test(r) && /\b(ux|ui|user experience|user interface|graphic design\w*|web design\w*|visual design\w*|art director|creative director|motion design\w*|designer)\b/.test(r)) return "Marketing";
  // IT / internal systems is the technology leader's remit, the same buyer as engineering.
  if (/\b(it (?:analyst|support|manager|director|administrator|specialist)|help ?desk|service desk|desktop support|systems? administrator|sysadmin|network (?:administrator|engineer|analyst)|salesforce (?:administrator|admin|developer)|business applications administrator|database administrator|dba|information technology|cybersecurity|information security|infosec)\b/.test(r)) return "Engineering";
  // Presales / solutions engineering carries the number, so it belongs to Sales.
  if (/\b(solutions? (?:consultant|engineer|architect)|sales engineer|presales|pre-sales|technical account manager|account development)\b/.test(r)) return "Sales";
  // Implementation / onboarding is post-sale delivery, owned by the customer-success leader.
  if (/\b(implementation|onboarding)\s+(?:specialist|consultant|analyst|coordinator|lead|manager)\b/.test(r)) return "Customer Success";

  // LAST RESORT: the req names a function, but in a phrasing none of the patterns above cover
  // ("VP of Finance", "Head of Manufacturing", "Financial Systems Analyst", "Director of Nursing
  // Services"). Recall matters more than precision at this point: an unrecognised family is
  // hard-rejected downstream, so every miss here throws away a req we already paid to enrich.
  if (/\b(financ\w*|accounting|treasury|payroll)\b/.test(r)) return "Finance";
  if (/\b(sales|revenue|business development)\b/.test(r)) return "Sales";
  if (/\b(marketing|brand|communications)\b/.test(r)) return "Marketing";
  if (/\b(engineering|software|technology)\b/.test(r)) return "Engineering";
  if (/\bproduct\b/.test(r)) return "Product";
  if (/\b(operations|manufacturing|production|warehouse|supply chain|logistics|project manager|program manager|facilities|procurement|sourcing manager|vendor management|inventory|fulfillment|dispatch|scheduler)\b/.test(r)) return "Operations";
  if (/\b(people|talent|human resources|training|learning and development)\b/.test(r)) return "People / HR";
  if (/\b(legal|counsel|compliance)\b/.test(r)) return "Legal";
  if (/\b(clinical|nursing|patient|health)\b/.test(r)) return "Healthcare";
  if (/\b(customer|client|account manager)\b/.test(r)) return "Customer Success";
  if (/\b(data|analytics|reporting)\b/.test(r)) return "Data";
  // EXECUTIVE SUPPORT, dead last on purpose (2026-08-21). An EA / chief of staff / office manager
  // is a real professional hire, but the seat belongs to whichever leader it supports: "Executive
  // Assistant, Finance" and "Chief of Staff, Data" must keep their own function so the owner chain
  // points at the CFO and the Head of Data. Running this branch above the last-resort block sent 23
  // such reqs to Operations and lost their real owner, so it sits below every function pattern and
  // only catches an EA req that names no function at all.
  if (/\b(executive assistant|chief of staff|administrative assistant|office manager)\b/.test(r)) return "Operations";
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
    case "Healthcare": return "clinical and allied health";
    case "Skilled Trades": return "skilled trades and production";
    case "Construction": return "construction and field";
    case "Insurance": return "insurance and underwriting";
    case "Customer Success": return "customer success and account management";
    case "Data": return "data and analytics";
    default: return "";
  }
}

// Collapse families into the FUNCTION GROUP that owns them, so the buyer check compares like with
// like: a CFO is the buyer for any accounting/finance/tax/audit/insurance role, and a plant or
// operations leader is the buyer for trades and construction. Everything else maps to itself.
export function roleFunctionGroup(fam) {
  if (fam === "Accounting" || fam === "Finance" || fam === "Tax" || fam === "Audit" || fam === "Insurance") return "Finance";
  if (fam === "Skilled Trades" || fam === "Construction") return "Operations";
  if (fam === "Healthcare") return "Clinical";
  if (fam === "Data") return "Engineering";
  return fam;
}

// The function a decision-maker OWNS, inferred from their title. "universal" = a whole-company buyer
// (CEO/founder/owner/president) who hires across every function. null = ambiguous (a plain VP/Director/
// Head with no clear function).
//
// RECALL MATTERS (owner mandate 2026-08-20: pitch ONLY the owner of the open role). Once a null
// function means "held", every function word this misses throws away a REAL owner: "Director of
// Accounting", "Tax Partner", "VP of Manufacturing" all returned null before, so the strict rule
// would have binned the exact people we want. Each branch below therefore carries the whole
// vocabulary of its function, not just the C-suite acronym. Order is deliberate: "universal" wins
// over everything, and Sales runs before Engineering so "business development" never reads as dev.
export function dmFunction(title) {
  const t = (title || "").toLowerCase();
  // "president" carries a negative lookbehind: a VICE president is not a whole-company buyer, and
  // without the guard "Vice President of Finance" read as "universal" and was held.
  if (/\b(ceo|chief executive|founder|co-?founder|owner|(?<!vice )president|general manager|\bgm\b|managing director|managing partner)\b/.test(t)) return "universal";
  // Clinical runs first: "Director of Clinical Operations" is a clinical leader, not an ops one.
  // "medical" is only matched as "medical director" / "chief medical" so a Medical Device SALES
  // Director stays with Sales.
  if (/\b(cno|chief nursing|chief medical|chief clinical|director of nursing|clinical|nurs(?:e|ing)|medical director|practice (?:manager|administrator))\b/.test(t)) return "Clinical";
  if (/\b(cfo|chief financial|chief accounting|controller|comptroller)\b/.test(t)
    || /\b(finance|financial|accounting|accountant|tax|audit(?:or|ing)?|treasur\w*|payroll|bookkeep\w*|fp&a)\b/.test(t)) return "Finance";
  if (/\b(chief customer|customer success|customer experience|client success|client services|account management)\b/.test(t)) return "Customer Success";
  if (/\b(cro|chief revenue|chief commercial)\b/.test(t) || /\b(sales|revenue|business development|commercial)\b/.test(t)) return "Sales";
  if (/\b(cmo|chief marketing)\b/.test(t) || /\b(marketing|demand gen(?:eration)?|brand|communications)\b/.test(t)) return "Marketing";
  // Data/analytics leaders sit in the Engineering group (see roleFunctionGroup), so a Head of Data
  // and a CTO are both legitimate owners of a data req.
  if (/\b(cto|chief technology|chief technical|chief data)\b/.test(t) || /\b(engineering|technology|software|data|analytics)\b/.test(t)) return "Engineering";
  if (/\b(cpo|chief product)\b/.test(t) || /\bproduct\b/.test(t)) return "Product";
  if (/\b(coo|chief operating)\b/.test(t) || /\b(operations|manufacturing|production|logistics|procurement|fulfillment|warehouse|plant manager|plant director|maintenance manager)\b/.test(t) || /supply chain/.test(t)) return "Operations";
  if (/\b(chro|chief people|chief human)\b/.test(t) || /\b(people|talent)\b/.test(t) || /human (?:resources|capital)/.test(t)) return "People / HR";
  if (/chief legal|general counsel/.test(t) || /\b(legal|counsel)\b/.test(t)) return "Legal";
  return null;
}

/**
 * TALENT BUYER (owner call 2026-08-20).
 *
 * What this desk sells is recruiting, and hiring is the People/HR function's OWN remit whatever
 * function the req sits in: a CHRO or Head of Talent signs search agreements for engineering and
 * finance reqs alike, in a way a CFO signing off on an engineering hire does not. So a People/HR
 * leader is a legitimate buyer for ANY req, rather than being held for "owning the wrong
 * function". This was the single largest recoverable pool in the gate: on 2026-08-20, 7,772 of
 * 12,104 curated rows were held on decision-maker mismatch and People/HR titles led every one of
 * the top rejection reasons.
 *
 * This does NOT weaken the rule the gate exists for. The 2026-08-12 leak was a Founder & CEO
 * receiving a Lead Accountant pitch, and a CEO is still held. The function owner is still
 * PREFERRED wherever the pool knows one: buyerFit ranks the owner above the talent leader and
 * batch.mjs sends in rank order, so this only stops the talent leader being discarded when they
 * are the best contact actually available for that req.
 *
 * Deliberately narrow, in two ways. It requires dmFunction's "People / HR" verdict, and it
 * requires the person to be a LEADER who carries budget. In-house practitioners are excluded
 * on purpose: an HR business partner, TA partner, specialist, generalist or coordinator does
 * not sign a search agreement, and in-house talent acquisition staff in particular are usually
 * measured on REDUCING agency spend, so they are the worst audience for this pitch, not the
 * best. Without that guard "Talent Acquisition Partner" qualified, because VALID_DM_TITLE
 * matches the bare word "partner".
 */
const TALENT_PRACTITIONER = /\b(business partner|hrbp|partner|specialist|generalist|coordinator|associate|assistant|consultant|analyst|administrator|advisor|recruiter|sourcer)\b/;
const TALENT_LEADER = /\b(chro|chief|vp|svp|evp|vice president|head of|director|officer)\b/;
export function isTalentBuyer(managerTitle) {
  const t = String(managerTitle || "").toLowerCase();
  if (dmFunction(t) !== "People / HR") return false;
  if (TALENT_PRACTITIONER.test(t)) return false;
  return TALENT_LEADER.test(t);
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
//
// OWNER-ONLY as of 2026-08-20. This used to accept a CEO/founder as a fallback buyer whenever the
// pool could not prove somebody better existed, which is how two thirds of the send volume ended up
// on founders' desks. It now agrees exactly with assessProspect: the owner of the role's function,
// or nobody. `know` is still consulted, but only to write a SHARPER hold reason — whether the right
// person is already named at that company (recoverable today) or has yet to be found.
//   rank 0 — owns the role's function, or the CEO/President on an executive-search req.
//   held   — everything else, with the reason recorded.
export function buyerFit(p, know, opts = {}) {
  const fam = roleFamily(p.role);
  const roleFn = roleFunctionGroup(fam);
  const fn = dmFunction(p.managerTitle);
  const k = know ? know.get(companyKeyOf(p.company)) : null;
  const hasLeader = !!(k && k.fnLeaders.has(roleFn));

  if (roleFn === "Executive" || isSeniorHire(p.role)) {
    // Leadership hire: the whole-company exec IS the decision-maker for this particular role.
    if (fn && fn !== "universal" && fn !== roleFn && !isTalentBuyer(p.managerTitle)) {
      return { ok: false, why: `"${p.managerTitle}" owns ${fn}, not the ${roleFn} function this leadership role sits in` };
    }
    return { ok: true, rank: 0 };
  }
  if (p.companyBuyerRow) {
    return { ok: false, why: `"${p.managerName}" is a company-level buyer row, never resolved against the "${p.role}" req` };
  }
  if (fn && fn !== "universal" && fn === roleFn) return { ok: true, rank: 0 };
  // The talent leader buys hiring for every function, so they are a valid buyer for any req --
  // but rank 1, BELOW the function owner, so a req that knows its real owner still goes there.
  if (isTalentBuyer(p.managerTitle)) return { ok: true, rank: 1 };
  if (fn === "universal") {
    return {
      ok: false,
      why: hasLeader
        ? `${p.company} already names a ${roleFn} leader in the pool; that person owns this req, not "${p.managerTitle}"`
        : `"${p.managerTitle}" is a whole-company exec; hold until the ${roleFn} owner at ${p.company} is named`,
    };
  }
  if (fn === null) {
    return { ok: false, why: `"${p.managerTitle}" names no function, so it cannot be confirmed as the ${roleFn} owner` };
  }
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
