/**
 * RecruitersOS · Signal Engine · Apify direct-dial finder
 *
 * The PERSON'S own direct line, resolved lazily at the email-sent trigger (the
 * Voice-Drop rule, Appendix A). Where the cheap RapidAPI landline rung tends to
 * surface an HQ switchboard, this actor is purpose-built for direct dials, so it
 * sits as the trustworthy backup once the cheap rung misses.
 *
 * Engine used: the ryanclinton "Phone Number Finder — Direct Dials" Apify actor
 * (actor id `ryanclinton~phone-number-finder`). Its phone data comes from
 * People Data Labs (3B-record database) with company-website scraping as a
 * fallback, so it needs YOUR OWN PDL key in addition to the Apify token. Pricing
 * is pay-per-result: ~$0.10 per number FOUND (records with no number are free),
 * plus your PDL usage (the free trial covers 500 lookups for 30 days).
 *
 * We call Apify's synchronous run endpoint (run-sync-get-dataset-items), pass the
 * person under the actor's `persons` array, and read the first phone back. The
 * found number is then routed through the existing Telnyx classify step
 * (phone_classify) so we trust the carrier's line type, not the actor's own label.
 *
 * Env (all tunable so a renamed actor / different key is a one-line .env change):
 *   APIFY_TOKEN              — your Apify API token (required to run the actor)
 *   PDL_API_KEY              — People Data Labs key (required for real numbers;
 *                              without it the actor only website-scrapes a company line)
 *   APIFY_DIRECT_DIAL_ACTOR — actor id, default "ryanclinton~phone-number-finder"
 *   APIFY_DIRECT_DIAL_MODE   — fast | balanced | thorough | auto (default "balanced")
 */

import {
  makeProvider,
  type EnrichmentInput,
  type EnrichmentProvider,
  type ProviderOutcome,
} from "./waterfall";

const APIFY_TOKEN = () => process.env.APIFY_TOKEN ?? "";
const PDL_API_KEY = () => process.env.PDL_API_KEY ?? "";
const DIRECT_DIAL_ACTOR = () =>
  process.env.APIFY_DIRECT_DIAL_ACTOR ?? "ryanclinton~phone-number-finder";
const DIRECT_DIAL_MODE = () => process.env.APIFY_DIRECT_DIAL_MODE ?? "balanced";

/**
 * Run an Apify actor synchronously and return its dataset items. The
 * run-sync-get-dataset-items endpoint blocks until the run finishes and responds
 * with the output array directly — ideal for a single lazy lookup at send time.
 */
async function apifyRunSync(actorId: string, input: unknown): Promise<unknown[]> {
  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(
    actorId,
  )}/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_TOKEN())}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Apify ${actorId} ${res.status}`);
  const data = (await res.json()) as unknown;
  return Array.isArray(data) ? data : [];
}

/** Pull a value out of an unknown object by trying several candidate keys (one level deep). */
function pick(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const flat = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = flat[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  for (const nestKey of ["data", "result", "person", "profile", "contact", "phones", "phoneNumbers"]) {
    const nested = flat[nestKey];
    if (nested && typeof nested === "object") {
      const hit = pick(Array.isArray(nested) ? nested[0] : nested, keys);
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * The person's own direct line via the ryanclinton "Phone Number Finder" Apify
 * actor (People Data Labs + website fallback). Resolves into the `landlinePhone`
 * field; the waterfall's downstream classify step confirms the carrier line type
 * before the voice channel trusts it. Confidence is modest (0.6): a real
 * direct-dial source, but still verified by Telnyx before any drop.
 */
export const apifyDirectDialFinder: EnrichmentProvider<string> = makeProvider<string>({
  id: "apify_direct_dial",
  label: "Apify direct-dial finder (ryanclinton / PDL)",
  cost: 0.1, // USD $0.10 per number FOUND (pay-per-result). SKIPPED by the default $0.03
  //          dial cap — only runs if you raise RECRUITEROS_MAX_DIAL_USD to >= $0.10.
  typicalConfidence: 0.6,
  envKeys: ["APIFY_TOKEN"],
  fn: async ({ subject, resolved }: EnrichmentInput): Promise<ProviderOutcome<string>> => {
    const fullName = String(subject.fullName ?? "").trim();
    const company = String(subject.companyName ?? subject.company ?? "").trim();
    const domain =
      (resolved.domain?.value as string | undefined) ?? String(subject.domain ?? "").trim();
    const email =
      (resolved.email?.value as string | undefined) ?? String(subject.email ?? "").trim();

    // The actor needs at least: name + domain, OR email, OR name + company.
    const enough = (fullName && (domain || company)) || Boolean(email);
    if (!enough) return { status: "miss" };

    // One person, shaped to the actor's `persons` schema. Empty fields are omitted.
    const person: Record<string, string> = {};
    if (fullName) person.name = fullName;
    if (email) person.email = email;
    if (company) person.company = company;
    if (domain) person.domain = domain;

    const input: Record<string, unknown> = {
      persons: [person],
      mode: DIRECT_DIAL_MODE(),
      scrapeWebsites: true,
    };
    // Phone numbers come from PDL; pass the key when present (else website-scrape only).
    if (PDL_API_KEY()) input.pdlApiKey = PDL_API_KEY();

    const items = await apifyRunSync(DIRECT_DIAL_ACTOR(), input);
    if (!items.length) return { status: "miss" }; // pay-per-result: a no-find is FREE

    // The actor emits an error record (e.g. { recordType: "error", error: true,
    // failureType: "auth" }) when PDL auth fails — treat that as a clean miss.
    const rec = items[0] as Record<string, unknown>;
    if (rec?.error === true || rec?.recordType === "error") return { status: "miss" };

    // PERSON-DIRECT ONLY: accept the person's own direct dial / mobile / desk line.
    // A generic company/HQ switchboard ("companyPhone") is intentionally NOT accepted —
    // we only ever pay for, and dial, the person's own number, never a front desk.
    const number =
      pick(items[0], ["directDial", "direct_dial", "directPhone", "mobilePhone", "mobile"]) ??
      pick(items[0], ["phone", "phoneNumber", "phone_number", "number", "landline"]);
    if (!number) return { status: "miss" }; // company-only / no person dial = free miss
    return { status: "hit", value: number, confidence: 0.6, cost: 0.1, raw: items[0] };
  },
});
