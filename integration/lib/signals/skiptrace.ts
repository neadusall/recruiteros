/**
 * RecruitersOS · Signal Engine · Skip-trace phone finder (RapidAPI)
 *
 * The "$0.10 tool": a RapidAPI skip-tracing / people-search listing that keys on
 * NAME + CITY/STATE (no LinkedIn URL needed) and returns the person's own phone
 * numbers, mobiles included, from US public records. This is the recruiter-triggered
 * "Boost phones" rung in JD Sourcing: it only ever runs manually, after the free
 * chain (KoldInfo, Laxis, LandlineDB, cache) has taken everything it can.
 *
 * Every listing in this category shapes its response differently (nested arrays,
 * `phones: [{number, type}]`, plain strings), so instead of a fixed field map the
 * parser deep-scans the whole payload for phone-like values and prefers entries
 * labeled mobile/cell/wireless. Endpoint config is Setup-pasted per workspace:
 *
 *   RAPIDAPI_SKIPTRACE_HOST      e.g. "skip-tracing-working-api.p.rapidapi.com"
 *   RAPIDAPI_SKIPTRACE_PATH      path template; placeholders {name} {first} {last}
 *                                {company} {city} {state} {citystatezip} {location}
 *                                {linkedin} {domain} {title}
 *   RAPIDAPI_SKIPTRACE_METHOD    GET (default) or POST
 *   RAPIDAPI_SKIPTRACE_BODY     POST only: JSON body template, same placeholders
 *   RAPIDAPI_SKIPTRACE_COST_USD  what the listing bills per lookup (default 0.10)
 *   RAPIDAPI_SKIPTRACE_BILLING   "call" (default: every request bills, hit or miss)
 *                                or "hit" (pay-per-result listings)
 *
 * Found numbers still pass the forced Telnyx cell-line check at OS Text push, so a
 * bad number costs a dime, never a wrong text.
 */

import {
  makeProvider,
  type EnrichmentInput,
  type EnrichmentProvider,
  type ProviderOutcome,
} from "./waterfall";
import { cred } from "../providers/http";

export const SKIPTRACE_DEFAULT_COST_USD = 0.1;

/** The listing's per-lookup price, Setup-tunable so a cheaper listing bills honestly. */
export function skipTraceUnitCost(): number {
  const v = Number(cred("RAPIDAPI_SKIPTRACE_COST_USD"));
  return Number.isFinite(v) && v > 0 ? v : SKIPTRACE_DEFAULT_COST_USD;
}

/** "call" = billed per request (the RapidAPI norm); "hit" = pay-per-result listings. */
export function skipTraceBilling(): "call" | "hit" {
  return cred("RAPIDAPI_SKIPTRACE_BILLING").trim().toLowerCase() === "hit" ? "hit" : "call";
}

export function skipTraceConfigured(): boolean {
  return Boolean(cred("RAPIDAPI_KEY") && cred("RAPIDAPI_SKIPTRACE_HOST") && cred("RAPIDAPI_SKIPTRACE_PATH"));
}

/* ------------------------------------------------------------------ */
/* Response parsing: deep-scan any shape for the best phone            */
/* ------------------------------------------------------------------ */

/** Toll-free prefixes: never a person's own line, skip outright. */
const TOLL_FREE = /^1?(800|888|877|866|855|844|833)/;

/** Normalize any phone-looking string to +1XXXXXXXXXX, or null if it isn't one. */
function normalizeUsPhone(raw: string): string | null {
  const digits = raw.replace(/\D+/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length !== 10) return null;
  if (/^[01]/.test(ten)) return null; // US numbers never start with 0/1
  if (TOLL_FREE.test(ten)) return null;
  return `+1${ten}`;
}

/** Keys whose values (or children) plausibly hold a phone number. */
const PHONE_KEY = /phone|mobile|cell|wireless|number|dial|tel/i;
/** Keys/values that mark an entry's line type. */
const MOBILE_LABEL = /mobile|cell|wireless/i;
const DNC_KEY = /\bdnc\b|do_?not_?call/i;

interface FoundPhone {
  number: string;
  mobile: boolean;
}

/**
 * Walk the whole payload. A string is a candidate when its key looks phone-ish OR the
 * string itself parses as a US number inside a phone-ish container. Sibling type
 * fields (type/lineType/phoneType/...) and key names decide the mobile preference;
 * entries whose object carries a truthy DNC flag are dropped entirely.
 */
function collectPhones(node: unknown, keyHint: string, out: FoundPhone[], depth: number): void {
  if (out.length >= 40 || depth > 8 || node == null) return;
  if (typeof node === "string" || typeof node === "number") {
    if (!PHONE_KEY.test(keyHint)) return;
    const norm = normalizeUsPhone(String(node));
    if (norm) out.push({ number: norm, mobile: MOBILE_LABEL.test(keyHint) });
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectPhones(item, keyHint, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  // A DNC-flagged record is skipped wholesale: we never buy a number we cannot text.
  for (const [k, v] of Object.entries(obj)) {
    if (DNC_KEY.test(k) && (v === true || String(v).toLowerCase() === "true" || v === "Y")) return;
  }
  // {number/value/phone: "...", type: "mobile"} shaped entries: label from the sibling.
  const typeLabel = ["type", "lineType", "line_type", "phoneType", "phone_type", "kind", "label"]
    .map((k) => obj[k])
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" || typeof v === "number") {
      const phoneish = PHONE_KEY.test(k) || (PHONE_KEY.test(keyHint) && ["value", "display"].includes(k));
      if (!phoneish) continue;
      const norm = normalizeUsPhone(String(v));
      if (norm) out.push({ number: norm, mobile: MOBILE_LABEL.test(typeLabel) || MOBILE_LABEL.test(k) });
    } else {
      collectPhones(v, k, out, depth + 1);
    }
  }
}

/** Best phone out of an unknown payload: first mobile-labeled, else first plain hit. */
export function extractSkipTracePhone(data: unknown): { number: string; mobile: boolean } | null {
  const found: FoundPhone[] = [];
  collectPhones(data, "", found, 0);
  if (!found.length) return null;
  const seen = new Set<string>();
  const uniq = found.filter((f) => (seen.has(f.number) ? false : (seen.add(f.number), true)));
  return uniq.find((f) => f.mobile) ?? uniq[0];
}

/* ------------------------------------------------------------------ */
/* The provider                                                        */
/* ------------------------------------------------------------------ */

function fillTemplate(tpl: string, subject: Record<string, unknown>): string {
  const name = String(subject.fullName ?? "").trim();
  const [first, ...rest] = name.split(/\s+/);
  const city = String(subject.city ?? "").trim();
  const state = String(subject.state ?? "").trim();
  const vals: Record<string, string> = {
    name,
    first: String(subject.firstName ?? first ?? "").trim(),
    last: String(subject.lastName ?? rest.join(" ")).trim(),
    company: String(subject.companyName ?? subject.company ?? "").trim(),
    city,
    state,
    citystatezip: [city, state].filter(Boolean).join(", "),
    location: String(subject.location ?? "").trim(),
    linkedin: String(subject.linkedinUrl ?? "").trim(),
    domain: String(subject.domain ?? "").trim(),
    title: String(subject.title ?? "").trim(),
  };
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in vals ? encodeURIComponent(vals[k]) : m));
}

/** Same fill, but for a JSON body template: values are JSON-escaped, not URL-encoded. */
function fillBodyTemplate(tpl: string, subject: Record<string, unknown>): unknown {
  const filled = tpl.replace(/\{(\w+)\}/g, (m, k: string) => {
    const url = fillTemplate(`{${k}}`, subject);
    return url === `{${k}}` ? m : JSON.stringify(decodeURIComponent(url)).slice(1, -1);
  });
  try { return JSON.parse(filled); } catch { return null; }
}

/**
 * Build the skip-trace provider at the CALL site so its cost reflects the
 * workspace's configured per-lookup price (provider cost is static by contract).
 * Slots into the mobilePhone rung after `rapidMobileFinder`, or runs standalone
 * from the JD Sourcing "Boost phones" action.
 */
export function makeSkipTracePhoneProvider(unitCostUsd: number): EnrichmentProvider<string> {
  const billing = skipTraceBilling();
  return makeProvider<string>({
    id: "rapidapi_skiptrace",
    label: "Skip-trace phone finder (RapidAPI)",
    cost: unitCostUsd,
    typicalConfidence: 0.55,
    envKeys: ["RAPIDAPI_KEY", "RAPIDAPI_SKIPTRACE_HOST", "RAPIDAPI_SKIPTRACE_PATH"],
    fn: async ({ subject }: EnrichmentInput): Promise<ProviderOutcome<string>> => {
      const host = cred("RAPIDAPI_SKIPTRACE_HOST");
      const tpl = cred("RAPIDAPI_SKIPTRACE_PATH");
      const name = String(subject.fullName ?? "").trim();
      // Skip-trace keys on a person's name; without one there is nothing to bill for.
      if (!name || name.split(/\s+/).length < 2) return { status: "miss" };

      const method = cred("RAPIDAPI_SKIPTRACE_METHOD").trim().toUpperCase() === "POST" ? "POST" : "GET";
      const path = fillTemplate(tpl, subject);
      const missCost = billing === "call" ? unitCostUsd : 0;

      const headers: Record<string, string> = {
        "X-RapidAPI-Key": cred("RAPIDAPI_KEY"),
        "X-RapidAPI-Host": host,
        Accept: "application/json",
      };
      let res: Response;
      if (method === "POST") {
        const bodyTpl = cred("RAPIDAPI_SKIPTRACE_BODY");
        const body = bodyTpl ? fillBodyTemplate(bodyTpl, subject) : null;
        res = await fetch(`https://${host}${path}`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {}),
        });
      } else {
        res = await fetch(`https://${host}${path}`, { headers });
      }
      // 404-style "no record" answers are a billed miss, not an error; real transport
      // or auth failures surface as errors so a broken listing stops the run loudly.
      if (res.status === 404 || res.status === 204) return { status: "miss", cost: missCost };
      if (!res.ok) return { status: "error", error: `RapidAPI ${host} ${res.status}`, cost: 0 };
      const data = (await res.json().catch(() => null)) as unknown;
      const best = data ? extractSkipTracePhone(data) : null;
      if (!best) return { status: "miss", cost: missCost };
      return {
        status: "hit",
        value: best.number,
        confidence: best.mobile ? 0.6 : 0.5,
        cost: unitCostUsd,
        raw: data,
      };
    },
  });
}
