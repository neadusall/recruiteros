/**
 * RecruiterOS · Signal Engine
 * Cheap-first contact enrichment via RapidAPI (and similar marketplace APIs).
 *
 * Strategy: spend as little as possible. RapidAPI hosts dozens of email-finder,
 * phone-lookup, and LinkedIn/person APIs at $0.004–0.02 per call — a fraction of the
 * named premium providers. We call those FIRST and only fall through to a premium
 * backup on a miss. Because the waterfall short-circuits on the first confident hit,
 * the expensive providers only ever touch the small remainder, so the blended cost
 * stays close to the cheap tier.
 *
 * The catch with marketplace APIs (resellers/scrapers): variable uptime, deprecation
 * risk, and UNVERIFIED accuracy. So cheap providers here return deliberately MODEST
 * confidence, and the plan always inserts a cheap verification step that can upgrade or
 * reject their output before outreach trusts it.
 *
 * Every specific RapidAPI listing differs and listings come and go, so each provider's
 * host + path + field mapping is configurable via env. Point them at whichever listing
 * you subscribe to; swapping a deprecated API is a one-line env change, not a code edit.
 */

import {
  makeProvider,
  type EnrichmentInput,
  type EnrichmentProvider,
  type EnrichmentPlan,
  type ProviderOutcome,
  type WaterfallSpec,
  guessDomainProvider,
  emailPatternProvider,
} from "./waterfall";
import { apifyDirectDialFinder } from "./apify";
import { cred } from "../providers/http";

/* ------------------------------------------------------------------ */
/* Shared RapidAPI transport                                           */
/* ------------------------------------------------------------------ */

// Workspace-first at call time so enrichment bills to the customer's own RapidAPI
// account inside withWorkspaceCreds, never the operator's (cred() suppresses the
// house env fallback in an isolated context).
const RAPIDAPI_KEY = () => cred("RAPIDAPI_KEY");

/** GET a RapidAPI endpoint with the standard marketplace auth headers. */
async function rapidGet<T>(host: string, path: string): Promise<T> {
  const res = await fetch(`https://${host}${path}`, {
    headers: {
      "X-RapidAPI-Key": RAPIDAPI_KEY(),
      "X-RapidAPI-Host": host,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`RapidAPI ${host} ${res.status}`);
  return (await res.json()) as T;
}

/** POST a RapidAPI endpoint with a JSON body. */
async function rapidPost<T>(host: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`https://${host}${path}`, {
    method: "POST",
    headers: {
      "X-RapidAPI-Key": RAPIDAPI_KEY(),
      "X-RapidAPI-Host": host,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`RapidAPI ${host} ${res.status}`);
  return (await res.json()) as T;
}

/** Pull a value out of an unknown JSON object by trying several candidate keys. */
function pick(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const flat = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = flat[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  // one level deep (e.g. { data: { email } }, { result: { phone } })
  for (const nestKey of ["data", "result", "results", "person", "profile"]) {
    const nested = flat[nestKey];
    if (nested && typeof nested === "object") {
      const hit = pick(Array.isArray(nested) ? nested[0] : nested, keys);
      if (hit) return hit;
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Stage 1 — cheap RapidAPI EMAIL finder                               */
/* ------------------------------------------------------------------ */

/**
 * Resolve a business email from name + domain via a RapidAPI email-finder listing.
 * Configure with:
 *   RAPIDAPI_EMAIL_HOST   e.g. "email-finder7.p.rapidapi.com"
 *   RAPIDAPI_EMAIL_PATH   path template with {first} {last} {domain} placeholders,
 *                         e.g. "/find?first_name={first}&last_name={last}&domain={domain}"
 *
 * Confidence is modest (0.6): marketplace finders are cheap but unverified, so the
 * downstream verification step should confirm before outreach relies on it.
 */
export const rapidEmailFinder: EnrichmentProvider<string> = makeProvider<string>({
  id: "rapidapi_email",
  label: "RapidAPI email finder",
  cost: 1,
  typicalConfidence: 0.6,
  envKeys: ["RAPIDAPI_KEY", "RAPIDAPI_EMAIL_HOST", "RAPIDAPI_EMAIL_PATH"],
  fn: async ({ subject, resolved }: EnrichmentInput): Promise<ProviderOutcome<string>> => {
    const host = process.env.RAPIDAPI_EMAIL_HOST!;
    const tpl = process.env.RAPIDAPI_EMAIL_PATH!;
    const first = String(subject.firstName ?? "").trim();
    const last =
      String(subject.lastName ?? "").trim() ||
      String(subject.fullName ?? "").trim().split(/\s+/).pop() ||
      "";
    const domain =
      (resolved.domain?.value as string | undefined) ?? String(subject.domain ?? "");
    if (!first || !last || !domain) return { status: "miss" };

    const path = tpl
      .replace("{first}", encodeURIComponent(first))
      .replace("{last}", encodeURIComponent(last))
      .replace("{domain}", encodeURIComponent(domain));
    const data = await rapidGet<unknown>(host, path);
    const email = pick(data, ["email", "email_address", "value", "work_email"]);
    if (!email || !email.includes("@")) return { status: "miss", cost: 1 };
    // If the listing reports its own validation status, lift confidence a touch.
    const verified = pick(data, ["status", "verification", "state"])?.toLowerCase();
    const confidence = verified === "valid" || verified === "deliverable" ? 0.75 : 0.6;
    return { status: "hit", value: email, confidence, cost: 1, raw: data };
  },
});

/* ------------------------------------------------------------------ */
/* Stage 1b — cheap RapidAPI PERSON / LinkedIn enrichment              */
/* ------------------------------------------------------------------ */

/**
 * Resolve a hiring manager's name + title (and sometimes email) from a LinkedIn URL or
 * a company + role, via a RapidAPI LinkedIn/person listing (e.g. "Fresh LinkedIn
 * Profile Data", ~$49/mo for 10k credits). Used to put a NAME on a company-level signal
 * before the email/phone steps run.
 *
 *   RAPIDAPI_PERSON_HOST  e.g. "fresh-linkedin-profile-data.p.rapidapi.com"
 *   RAPIDAPI_PERSON_PATH  e.g. "/get-profile-by-url?url={linkedin}"  ({linkedin} | {company} | {title})
 */
export interface PersonEnrichment {
  fullName?: string;
  title?: string;
  email?: string;
  linkedinUrl?: string;
}

export const rapidPersonEnrich: EnrichmentProvider<PersonEnrichment> =
  makeProvider<PersonEnrichment>({
    id: "rapidapi_person",
    label: "RapidAPI person / LinkedIn data",
    cost: 1,
    typicalConfidence: 0.65,
    envKeys: ["RAPIDAPI_KEY", "RAPIDAPI_PERSON_HOST", "RAPIDAPI_PERSON_PATH"],
    fn: async ({ subject }: EnrichmentInput): Promise<ProviderOutcome<PersonEnrichment>> => {
      const host = process.env.RAPIDAPI_PERSON_HOST!;
      const tpl = process.env.RAPIDAPI_PERSON_PATH!;
      const linkedin = String(subject.linkedinUrl ?? "");
      const company = String(subject.companyName ?? "");
      const title = String(subject.targetTitle ?? subject.title ?? "");
      if (!linkedin && !company) return { status: "miss" };

      const path = tpl
        .replace("{linkedin}", encodeURIComponent(linkedin))
        .replace("{company}", encodeURIComponent(company))
        .replace("{title}", encodeURIComponent(title));
      const data = await rapidGet<unknown>(host, path);
      const out: PersonEnrichment = {
        fullName: pick(data, ["full_name", "fullName", "name"]),
        title: pick(data, ["job_title", "title", "headline", "occupation"]),
        email: pick(data, ["email", "work_email", "email_address"]),
        linkedinUrl: pick(data, ["linkedin_url", "profile_url", "url"]) ?? linkedin,
      };
      if (!out.fullName && !out.email) return { status: "miss", cost: 1 };
      return { status: "hit", value: out, confidence: 0.65, cost: 1, raw: data };
    },
  });

/* ------------------------------------------------------------------ */
/* Stage 3 — cheap RapidAPI PHONE lookup (mobile + direct landline)    */
/* ------------------------------------------------------------------ */

export interface PhoneResult {
  number: string;
  /** "mobile" | "direct" (direct-dial landline) | "hq" | "unknown" */
  kind: "mobile" | "direct" | "hq" | "unknown";
}

/**
 * Resolve a phone number (mobile or direct-dial landline) from a person/company via a
 * RapidAPI phone listing. Phone coverage from cheap marketplace sources is the weakest
 * link — expect low hit rates and UNVERIFIED numbers — so confidence is the lowest of
 * any stage and the plan pairs it with a phone-validation step.
 *
 *   RAPIDAPI_PHONE_HOST  e.g. "phone-number-lookup.p.rapidapi.com"
 *   RAPIDAPI_PHONE_PATH  e.g. "/lookup?name={name}&company={company}&domain={domain}"
 */
export const rapidPhoneFinder: EnrichmentProvider<PhoneResult> = makeProvider<PhoneResult>({
  id: "rapidapi_phone",
  label: "RapidAPI phone lookup",
  cost: 1,
  typicalConfidence: 0.45,
  envKeys: ["RAPIDAPI_KEY", "RAPIDAPI_PHONE_HOST", "RAPIDAPI_PHONE_PATH"],
  fn: async ({ subject, resolved }: EnrichmentInput): Promise<ProviderOutcome<PhoneResult>> => {
    const host = process.env.RAPIDAPI_PHONE_HOST!;
    const tpl = process.env.RAPIDAPI_PHONE_PATH!;
    const name = String(subject.fullName ?? "");
    const company = String(subject.companyName ?? "");
    const domain =
      (resolved.domain?.value as string | undefined) ?? String(subject.domain ?? "");
    if (!name && !company && !domain) return { status: "miss" };

    const path = tpl
      .replace("{name}", encodeURIComponent(name))
      .replace("{company}", encodeURIComponent(company))
      .replace("{domain}", encodeURIComponent(domain));
    const data = await rapidGet<unknown>(host, path);
    const number = pick(data, ["phone", "mobile", "phone_number", "direct_dial", "number"]);
    if (!number) return { status: "miss", cost: 1 };
    const rawKind = pick(data, ["type", "line_type", "kind"])?.toLowerCase() ?? "";
    const kind: PhoneResult["kind"] = rawKind.includes("mobile") || rawKind.includes("cell")
      ? "mobile"
      : rawKind.includes("direct")
      ? "direct"
      : rawKind.includes("land") || rawKind.includes("hq")
      ? "hq"
      : "unknown";
    // Mobile/direct are more useful for outreach than a switchboard, so weight them up.
    const confidence = kind === "mobile" || kind === "direct" ? 0.5 : 0.35;
    return { status: "hit", value: { number, kind }, confidence, cost: 1, raw: data };
  },
});

/* ------------------------------------------------------------------ */
/* Stage 3a/3b — SEPARATE mobile + landline finders (placeholder rungs) */
/* ------------------------------------------------------------------ */

/**
 * Mobile and landline are resolved as SEPARATE fields, each with its own
 * env-configured RapidAPI listing, so you can point a better/dedicated provider
 * at each line type as you find cheap ones. Both are placeholders until you set
 * their host/path; until then they report "not configured" and the waterfall
 * simply skips them. The generic `rapidPhoneFinder` above still exists for the
 * legacy single-`phone` field.
 *
 *   Mobile:   RAPIDAPI_MOBILE_HOST   + RAPIDAPI_MOBILE_PATH
 *   Landline: RAPIDAPI_LANDLINE_HOST + RAPIDAPI_LANDLINE_PATH
 *   Path templates accept {name} {company} {domain} {linkedin} placeholders, e.g.
 *     "/find?name={name}&company={company}&domain={domain}"
 */
function makeLineFinder(
  id: string,
  label: string,
  hostKey: string,
  pathKey: string,
): EnrichmentProvider<string> {
  return makeProvider<string>({
    id,
    label,
    cost: 0.01, // USD estimate per RapidAPI call (per-call billing; tune to your listing)
    typicalConfidence: 0.45,
    envKeys: ["RAPIDAPI_KEY", hostKey, pathKey],
    fn: async ({ subject, resolved }: EnrichmentInput): Promise<ProviderOutcome<string>> => {
      const host = process.env[hostKey]!;
      const tpl = process.env[pathKey]!;
      const name = String(subject.fullName ?? "");
      const company = String(subject.companyName ?? "");
      const linkedin = String(subject.linkedinUrl ?? "");
      const domain = (resolved.domain?.value as string | undefined) ?? String(subject.domain ?? "");
      if (!name && !company && !domain && !linkedin) return { status: "miss" };
      const path = tpl
        .replace("{name}", encodeURIComponent(name))
        .replace("{company}", encodeURIComponent(company))
        .replace("{domain}", encodeURIComponent(domain))
        .replace("{linkedin}", encodeURIComponent(linkedin));
      const data = await rapidGet<unknown>(host, path);
      const number = pick(data, ["mobile", "cell", "phone", "phone_number", "direct_dial", "number"]);
      if (!number) return { status: "miss", cost: 0.01 }; // RapidAPI bills per call, even on a miss
      return { status: "hit", value: number, confidence: 0.5, cost: 0.01, raw: data };
    },
  });
}

/** Mobile-number finder. Configure RAPIDAPI_MOBILE_HOST / RAPIDAPI_MOBILE_PATH. */
export const rapidMobileFinder: EnrichmentProvider<string> = makeLineFinder(
  "rapidapi_mobile",
  "RapidAPI mobile lookup",
  "RAPIDAPI_MOBILE_HOST",
  "RAPIDAPI_MOBILE_PATH",
);

/** Landline / direct-dial finder. Configure RAPIDAPI_LANDLINE_HOST / RAPIDAPI_LANDLINE_PATH. */
export const rapidLandlineFinder: EnrichmentProvider<string> = makeLineFinder(
  "rapidapi_landline",
  "RapidAPI landline / direct-dial lookup",
  "RAPIDAPI_LANDLINE_HOST",
  "RAPIDAPI_LANDLINE_PATH",
);

/* ------------------------------------------------------------------ */
/* Stage 1c — Icypeas: the cheapest CREDIBLE email API (recommended)   */
/* ------------------------------------------------------------------ */

/**
 * Icypeas is the cheapest credible contact-finder API we found (~$0.003/email at scale,
 * 3–10x cheaper than Findymail/Dropcontact/Wiza, with the lowest bounce rate on the
 * market). Unlike raw RapidAPI scraper listings, its data is real enough to trust after
 * a verify pass, which is why it sits as the RECOMMENDED cheap primary ahead of the
 * generic marketplace finder.
 *
 * Its API is async (submit → poll), but for a single lookup the synchronous
 * "email-search" endpoint returns inline. Auth is an API key + secret in headers.
 *   ICYPEAS_API_KEY, ICYPEAS_API_SECRET
 */
export const icypeasEmailFinder: EnrichmentProvider<string> = makeProvider<string>({
  id: "icypeas_email",
  label: "Icypeas email finder (cheapest credible)",
  cost: 0.3, // ~0.1 credit, far below a premium reveal
  typicalConfidence: 0.7,
  envKeys: ["ICYPEAS_API_KEY", "ICYPEAS_API_SECRET"],
  fn: async ({ subject, resolved }: EnrichmentInput): Promise<ProviderOutcome<string>> => {
    const first = String(subject.firstName ?? "").trim();
    const last =
      String(subject.lastName ?? "").trim() ||
      String(subject.fullName ?? "").trim().split(/\s+/).pop() ||
      "";
    const domain =
      (resolved.domain?.value as string | undefined) ?? String(subject.domain ?? "");
    if ((!first && !last) || !domain) return { status: "miss" };

    const res = await fetch("https://app.icypeas.com/api/email-search", {
      method: "POST",
      headers: {
        Authorization: process.env.ICYPEAS_API_KEY!,
        "X-ROCK-SECRET": process.env.ICYPEAS_API_SECRET!,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ firstname: first, lastname: last, domainOrCompany: domain }),
    });
    if (!res.ok) throw new Error(`Icypeas ${res.status}`);
    const data = (await res.json()) as unknown;
    const email = pick(data, ["email", "value"]);
    if (!email || !email.includes("@")) return { status: "miss", cost: 0.3 };
    const certainty = (pick(data, ["certainty", "status"]) ?? "").toLowerCase();
    // Icypeas grades certainty (e.g. "ultra_sure" | "sure" | "probable").
    const confidence = certainty.includes("ultra")
      ? 0.85
      : certainty.includes("sure")
      ? 0.75
      : 0.6;
    return { status: "hit", value: email, confidence, cost: 0.3, raw: data };
  },
});

/* ------------------------------------------------------------------ */
/* Stage 2 — cheap VERIFICATION (the trust gate for marketplace data)  */
/* ------------------------------------------------------------------ */

/**
 * Verify a found email's deliverability via a cheap verification API (MyEmailVerifier
 * ~$0.0025/check, MillionVerifier, or a RapidAPI verifier). This is what makes the cheap
 * tier safe: it upgrades a confident-but-unverified marketplace hit to a trusted one, or
 * rejects it so the waterfall keeps falling through to a backup.
 *
 * Unlike a finder, a verifier doesn't *produce* an email — it RE-SCORES the one already
 * resolved. It reads `resolved.email`, checks it, and returns the same value at higher
 * (or, on a fail, near-zero) confidence.
 *
 *   EMAIL_VERIFY_HOST  e.g. "api.millionverifier.com" or a RapidAPI verifier host
 *   EMAIL_VERIFY_PATH  e.g. "/api/v3/?api=KEY&email={email}"  ({email} placeholder)
 */
export const emailVerifier: EnrichmentProvider<string> = makeProvider<string>({
  id: "email_verify",
  label: "Email verification",
  cost: 0.3, // verification is far cheaper than finding
  typicalConfidence: 0.95,
  envKeys: ["EMAIL_VERIFY_HOST", "EMAIL_VERIFY_PATH"],
  fn: async ({ resolved, subject }: EnrichmentInput): Promise<ProviderOutcome<string>> => {
    const email =
      (resolved.email?.value as string | undefined) ?? String(subject.email ?? "");
    if (!email) return { status: "miss" };
    const host = process.env.EMAIL_VERIFY_HOST!;
    const path = process.env.EMAIL_VERIFY_PATH!.replace("{email}", encodeURIComponent(email));
    const data = await rapidGet<unknown>(host, path);
    const result = (pick(data, ["result", "status", "deliverability", "state"]) ?? "").toLowerCase();
    const good = ["ok", "valid", "deliverable", "good"].some((s) => result.includes(s));
    const risky = ["catch", "accept_all", "unknown", "risky"].some((s) => result.includes(s));
    if (good) return { status: "hit", value: email, confidence: 0.97, cost: 0.3, raw: data };
    if (risky) return { status: "hit", value: email, confidence: 0.55, cost: 0.3, raw: data };
    // Verified-bad: report a hit at near-zero confidence so "best" mode discards it.
    return { status: "hit", value: email, confidence: 0.05, cost: 0.3, raw: data };
  },
});

/* ------------------------------------------------------------------ */
/* The cheap-first plan builder                                        */
/* ------------------------------------------------------------------ */

export interface CheapFirstOptions {
  /** Premium providers used ONLY as a backup, appended after the cheap tier. */
  backupEmailProviders?: EnrichmentProvider[];
  backupPhoneProviders?: EnrichmentProvider[];
  /** Premium MOBILE backups, appended after the cheap mobile finder. */
  backupMobileProviders?: EnrichmentProvider[];
  /** Premium LANDLINE backups, appended after the cheap landline finder. */
  backupLandlineProviders?: EnrichmentProvider[];
  /** Extra cheap email finders to try in order before the backups (RapidAPI listings). */
  extraEmailFinders?: EnrichmentProvider[];
  /** Legacy single-field phone waterfall (off by default — costly + low-yield). */
  includePhone?: boolean;
  /** Resolve a MOBILE number into its own field (off by default). */
  includeMobile?: boolean;
  /** Resolve a LANDLINE / direct-dial number into its own field (off by default). */
  includeLandline?: boolean;
  /** Global credit ceiling across the whole pipeline. */
  budget?: number;
  /**
   * HARD USD ceiling on what a single contact's DIAL (mobile/landline) may cost.
   * Defaults to RECRUITEROS_MAX_DIAL_USD, or $0.03. The waterfall skips any dial
   * provider whose cost would push the per-contact dial spend over this ceiling, so
   * a contact's dial spend NEVER exceeds it. NOTE: at $0.03 the $0.10 Apify direct-dial
   * rung is always skipped — set this to >= 0.10 to unlock it.
   */
  maxDialUsd?: number;
}

/**
 * Build the cost-optimized enrichment plan: free heuristics → cheap RapidAPI finders →
 * cheap verification → (optional) cheap RapidAPI phone → premium backups last.
 *
 *   domain : local guess → premium backup
 *   email  : local pattern → RapidAPI finder(s) → [premium backups] → verify (best mode,
 *            so it keeps the highest-confidence VERIFIED value and never settles for an
 *            unverified guess while a better option remains)
 *   phone  : RapidAPI phone → premium backups (first mode — take the first usable number)
 *
 * Order encodes the user's rule: cheapest sources first, premium only as a fallback.
 */
export function cheapFirstContactWaterfall(opts: CheapFirstOptions = {}): EnrichmentPlan {
  // Hard per-contact USD ceiling on the DIAL steps. Default $0.03; env-tunable.
  // Providers pricier than the remaining cap are skipped, so dial spend stays <= cap.
  const dialCapUsd =
    opts.maxDialUsd ?? Number(process.env.RECRUITEROS_MAX_DIAL_USD ?? "0.03");

  const emailFinders: EnrichmentProvider[] = [
    emailPatternProvider as EnrichmentProvider, // free permutation guess
    icypeasEmailFinder as EnrichmentProvider, // cheapest credible API (~$0.003/email)
    rapidEmailFinder as EnrichmentProvider, // generic cheap RapidAPI finder
    ...(opts.extraEmailFinders ?? []), // more cheap RapidAPI listings
    ...(opts.backupEmailProviders ?? []), // premium, only reached on misses
  ];

  const steps: WaterfallSpec[] = [
    {
      field: "domain",
      providers: [guessDomainProvider as EnrichmentProvider],
      mode: "best",
      acceptConfidence: 0.9,
    },
    {
      field: "email",
      providers: emailFinders,
      mode: "best", // fall through cheap→premium, keep the best, then verify upgrades it
      acceptConfidence: 0.97, // only a verified email short-circuits
    },
    {
      field: "email", // second pass on the same field: verify the chosen email
      providers: [emailVerifier as EnrichmentProvider],
      mode: "best",
      acceptConfidence: 0.97,
    },
  ];

  if (opts.includePhone) {
    steps.push({
      field: "phone",
      providers: [
        rapidPhoneFinder as EnrichmentProvider, // cheap first
        ...(opts.backupPhoneProviders ?? []), // premium phone backup
      ],
      mode: "first", // take the first usable number; phone calls are costly
      acceptConfidence: 0.5,
    });
  }

  // Mobile and landline are SEPARATE fields with their own cheap-first rung +
  // premium backup, so each line type can be enriched (and priced) independently.
  if (opts.includeMobile) {
    steps.push({
      field: "mobilePhone",
      maxCost: dialCapUsd, // HARD per-contact USD cap on the dial (default $0.03)
      providers: [
        rapidMobileFinder as EnrichmentProvider, // cheap first (~$0.01/call, placeholder until configured)
        ...(opts.backupMobileProviders ?? []), // premium mobile reveal on miss (also cap-gated)
      ],
      mode: "first",
      acceptConfidence: 0.5,
    });
  }
  if (opts.includeLandline) {
    steps.push({
      field: "landlinePhone",
      maxCost: dialCapUsd, // HARD per-contact USD cap on the dial (default $0.03)
      providers: [
        rapidLandlineFinder as EnrichmentProvider, // cheap first (~$0.01/call, placeholder until configured)
        apifyDirectDialFinder as EnrichmentProvider, // ryanclinton actor $0.10/found — SKIPPED while cap < $0.10
        ...(opts.backupLandlineProviders ?? []), // premium direct-dial reveal on miss (also cap-gated)
      ],
      mode: "first",
      acceptConfidence: 0.5,
    });
  }

  return { steps, budget: opts.budget };
}

/** The cheap RapidAPI provider tier on its own, in call order (for docs / inspection). */
export function cheapTier(): EnrichmentProvider[] {
  return [
    emailPatternProvider as EnrichmentProvider,
    rapidEmailFinder as EnrichmentProvider,
    rapidPersonEnrich as unknown as EnrichmentProvider,
    emailVerifier as EnrichmentProvider,
    rapidPhoneFinder as unknown as EnrichmentProvider,
  ];
}
