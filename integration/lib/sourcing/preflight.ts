/**
 * RecruitersOS · JD Sourcing
 * Pre-push preflight: everything checks out BEFORE a list leaves the building.
 *
 * WHY THIS EXISTS (2026-07-31). A campaign went out with a merge token the SMS
 * engine couldn't resolve. Nothing upstream checked, so the break surfaced at
 * send time as per-contact failures and the campaign simply read "0 sent". The
 * list had been pushed, the enrichment had run, every stage reported success,
 * and the whole audience still fell through the crack between them.
 *
 * The rule this encodes: a push must be able to say, in advance, exactly how
 * many people will land and what happens to everyone who won't. Anything that
 * cannot be accounted for is an issue, not silence.
 *
 * Blocking is deliberately narrow. Pushing a list with no phones yet is NORMAL
 * (first-sight delivery puts every search in OS Text within ~2 minutes and the
 * top-up fills it as enrichment finds numbers), so an empty push is never a
 * blocker. What IS a blocker is a push that would deliver nobody for a reason a
 * human can fix — the Hill Valley case.
 */

import type { SourcingRun } from "./types";
import type { OsTextContact } from "../ostextImport";

export type PreflightSeverity = "block" | "warn" | "info";

export interface PreflightIssue {
  code: string;
  severity: PreflightSeverity;
  /** Plain sentence, safe to show a recruiter. */
  message: string;
  count?: number;
}

export interface PreflightReport {
  at: string;
  /** False when a blocking issue is present: the push must not proceed as-is. */
  ok: boolean;
  people: number;
  withPhone: number;
  /** Contacts that would actually be textable: phone present AND template resolves. */
  deliverable: number;
  chain: "not-started" | "in-flight" | "finished";
  issues: PreflightIssue[];
}

/* --- Merge-token model -------------------------------------------------------
 * MUST STAY IN STEP WITH money-maker-sms/src/lib/merge.ts. The engine is a
 * separate service, so this is a deliberate mirror rather than an import: the
 * point of the check is to catch a template the ENGINE will choke on, which
 * means modelling the engine's rules here. Both sides ignore case and
 * underscores and map the same aliases.
 */
const STANDARD_KEYS = [
  "first_name", "last_name", "full_name", "company", "company_name",
  "job_title", "email", "location", "linkedin_url",
] as const;

const ALIASES: Record<string, string> = {
  name: "first_name", fname: "first_name", givenname: "first_name",
  lname: "last_name", surname: "last_name", familyname: "last_name",
  fullname: "full_name", companyname: "company", employer: "company",
  organization: "company", org: "company", title: "job_title",
  jobtitle: "job_title", currenttitle: "job_title", role: "job_title",
  position: "job_title", city: "location", metro: "location",
  linkedin: "linkedin_url", linkedinprofile: "linkedin_url",
  emailaddress: "email",
};

const TOKEN = /\{\{?\s*([a-zA-Z0-9_]+)\s*\}?\}/g;

function norm(k: string): string {
  return k.toLowerCase().replace(/_/g, "");
}

/** The contact field a token resolves to, or null when it is a custom column. */
function standardFieldFor(rawKey: string): string | null {
  const n = norm(rawKey);
  const direct = STANDARD_KEYS.find((k) => norm(k) === n);
  if (direct) return direct === "company_name" ? "company" : direct;
  return ALIASES[n] ?? null;
}

/** Value the engine would merge for one token on one contact ("" = would fail). */
function valueFor(rawKey: string, c: OsTextContact): string {
  const std = standardFieldFor(rawKey);
  switch (std) {
    case "first_name": return c.firstName || "";
    case "last_name": return c.lastName || "";
    case "full_name": return [c.firstName, c.lastName].filter(Boolean).join(" ");
    case "company": return c.company || "";
    case "job_title": return c.jobTitle || "";
    case "email": return c.email || "";
    case "location": return c.location || "";
    case "linkedin_url": return c.linkedinUrl || "";
    default: break;
  }
  const custom = c.customFields || {};
  const exact = custom[rawKey] ?? custom[rawKey.toLowerCase()];
  if (exact != null && exact !== "") return exact;
  for (const [k, v] of Object.entries(custom)) if (norm(k) === norm(rawKey)) return v ?? "";
  return "";
}

function tokensIn(template: string): string[] {
  const set = new Set<string>();
  for (const m of template.matchAll(TOKEN)) set.add(m[1]);
  return [...set];
}

/** True when the enrichment chain still owes this run work. */
function chainState(run: SourcingRun): PreflightReport["chain"] {
  if (run.koldJob || run.koldDbJob || run.laxisJob) return "in-flight";
  if (!run.enrichStartedAt) return "not-started";
  return "finished";
}

/**
 * Audit a push before it happens.
 *
 * @param run       the saved list being pushed
 * @param contacts  the exact payload sendRun would hand the SMS engine
 * @param template  the exact template that payload would be texted with
 */
export function preflightPush(
  run: SourcingRun,
  contacts: OsTextContact[],
  template: string,
): PreflightReport {
  const issues: PreflightIssue[] = [];
  const people = run.candidates.length;
  const withPhone = contacts.length;
  const chain = chainState(run);

  // 1) Template. The Hill Valley guard, moved upstream of the send: count the
  //    contacts this payload could not text and say which token is at fault.
  const tokens = tokensIn(template);
  const failuresByToken = new Map<string, number>();
  let deliverable = 0;
  for (const c of contacts) {
    let ok = true;
    for (const t of tokens) {
      if (!valueFor(t, c)) {
        failuresByToken.set(t, (failuresByToken.get(t) ?? 0) + 1);
        ok = false;
      }
    }
    if (ok) deliverable++;
  }
  const worst = [...failuresByToken.entries()].sort((a, b) => b[1] - a[1])[0];
  if (worst && contacts.length > 0) {
    const [token, n] = worst;
    const known = standardFieldFor(token) != null;
    const detail = known
      ? `${n} of them have no ${token.replace(/_/g, " ")} on file`
      : `"{${token}}" is not a field on these contacts`;
    if (deliverable === 0) {
      issues.push({
        code: "template_resolves_for_nobody",
        severity: "block",
        count: n,
        message: `None of the ${contacts.length} contacts can be texted with this message: ${detail}.`,
      });
    } else {
      issues.push({
        code: "template_partial",
        severity: "warn",
        count: contacts.length - deliverable,
        message: `${contacts.length - deliverable} of ${contacts.length} contacts can't be texted with this message: ${detail}.`,
      });
    }
  }

  // 2) Duplicate numbers inside the payload. The engine dedupes by (campaign,
  //    phone), so these are silently collapsed — count them so the drop between
  //    "phones on the list" and "contacts in the campaign" is explained here
  //    rather than looking like loss later.
  const seen = new Set<string>();
  let dupes = 0;
  for (const c of contacts) {
    const key = (c.phone || "").replace(/\D/g, "");
    if (!key) continue;
    if (seen.has(key)) dupes++;
    else seen.add(key);
  }
  if (dupes > 0) {
    issues.push({
      code: "duplicate_phones",
      severity: "info",
      count: dupes,
      message: `${dupes} duplicate number${dupes === 1 ? "" : "s"} in this list will collapse into one contact each.`,
    });
  }

  // 3) Ownership. A creator-less run lands Unassigned in OS Text and its
  //    starter text says "a recruiter" instead of a name.
  if (!run.createdBy?.email) {
    issues.push({
      code: "no_owner",
      severity: "warn",
      message: "No recruiter is attached to this list, so the campaign will land unassigned.",
    });
  }

  // 4) Enrichment still owes work. Not a blocker: the push is what makes the
  //    search visible. Recorded so an unfinished chain is a stated obligation
  //    the top-up has to clear, not something to infer from the numbers.
  if (chain === "in-flight") {
    issues.push({
      code: "enrichment_in_flight",
      severity: "info",
      count: people - withPhone,
      message: `Enrichment is still running: ${people - withPhone} of ${people} people have no number yet and will be added as it finds them.`,
    });
  }

  return {
    at: new Date().toISOString(),
    ok: !issues.some((i) => i.severity === "block"),
    people,
    withPhone,
    deliverable,
    chain,
    issues,
  };
}

/**
 * Reconcile what the engine actually took against what preflight promised.
 * Every contact must be accounted for as added, held back for a known reason,
 * or reported here. An unexplained shortfall is exactly the shape of the bug
 * this module exists to prevent, so it is surfaced rather than averaged away.
 */
export function reconcilePush(
  report: PreflightReport,
  imported: { added: number; knownNonMobile: number; confirmedCell: number },
): PreflightIssue | null {
  const accounted = (imported.added || 0) + (imported.knownNonMobile || 0);
  const unexplained = report.deliverable - accounted;
  if (unexplained <= 0) return null;
  return {
    code: "unexplained_shortfall",
    severity: "warn",
    count: unexplained,
    message: `${unexplained} contact${unexplained === 1 ? "" : "s"} were sent but didn't land in the campaign and weren't reported as non-mobile.`,
  };
}

/** One line for the ops log: the whole verdict at a glance. */
export function summarizePreflight(run: SourcingRun, r: PreflightReport): string {
  const bits = r.issues.map((i) => `${i.severity}:${i.code}${i.count != null ? `(${i.count})` : ""}`);
  return `[preflight] "${run.name}" people=${r.people} phones=${r.withPhone} deliverable=${r.deliverable} chain=${r.chain} ${bits.length ? bits.join(" ") : "clean"}`;
}
