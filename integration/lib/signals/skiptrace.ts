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
 *   RAPIDAPI_SKIPTRACE_COST_USD  what the listing bills per REQUEST (default 0.10)
 *   RAPIDAPI_SKIPTRACE_BILLING   "call" (default: every request bills, hit or miss)
 *                                or "hit" (pay-per-result listings)
 *   RAPIDAPI_SKIPTRACE_DETAILS_PATH  two-step listings only: the person-details path,
 *                                {id} = the id from the search step (default fits
 *                                Skip Tracing Working API: /search/detailsbyID?peo_id={id})
 *
 * TWO-STEP LISTINGS: directory-style listings (Skip Tracing Working API et al.)
 * answer the name search with a people LIST (ids + addresses, no phones) and sell
 * the phones behind a second per-person call. When the first response carries no
 * phone but does carry that directory shape, the provider picks the ONE record the
 * candidate's own city/state corroborates (its search ignores location server-side,
 * verified 2026-07-20, and a wrong person's number is worse than none) and buys the
 * details for just that record. A lookup is then TWO billed requests, which the
 * quote and cost accounting reflect.
 *
 * Found numbers still pass the forced Telnyx cell-line check at OS Text push, so a
 * bad number costs pennies, never a wrong text.
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

/** Directory hosts whose search step never returns phones — the details call always follows. */
const TWO_STEP_HOST = /skip-tracing-working-api/i;

/**
 * Billed requests a completed lookup takes on the configured listing: 2 for
 * two-step directory listings (search + details), 1 otherwise. Quotes and budget
 * math use this so a two-step listing is never under-estimated.
 */
export function skipTraceCallsPerLookup(): number {
  if (cred("RAPIDAPI_SKIPTRACE_DETAILS_PATH").trim()) return 2;
  return TWO_STEP_HOST.test(cred("RAPIDAPI_SKIPTRACE_HOST")) ? 2 : 1;
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
  // Dedup keeps first-seen order but MERGES labels: payloads often list the same
  // number twice (an unlabeled summary field + a typed phone-list entry), and the
  // mobile flag must survive whichever copy came first.
  const byNumber = new Map<string, FoundPhone>();
  for (const f of found) {
    const prev = byNumber.get(f.number);
    if (!prev) byNumber.set(f.number, { ...f });
    else prev.mobile = prev.mobile || f.mobile;
  }
  const uniq = Array.from(byNumber.values());
  return uniq.find((f) => f.mobile) ?? uniq[0];
}

/* ------------------------------------------------------------------ */
/* Two-step directory listings: search answer -> pick person -> details */
/* ------------------------------------------------------------------ */

interface DirectoryRecord {
  id: string;
  name: string;
  livesIn: string;       // "Brook Park, OH"
  usedToLiveIn: string;  // "Cleveland OH, Lakewood OH"
}

/** The search step's people list, when the payload has one (TruePeopleSearch-shaped). */
export function directoryRecords(data: unknown): DirectoryRecord[] {
  if (!data || typeof data !== "object") return [];
  const rows = (data as Record<string, unknown>)["PeopleDetails"];
  if (!Array.isArray(rows)) return [];
  const out: DirectoryRecord[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const id = String(o["Person ID"] ?? o["PersonID"] ?? o["person_id"] ?? "").trim();
    if (!id) continue;
    out.push({
      id,
      name: String(o["Name"] ?? "").trim(),
      livesIn: String(o["Lives in"] ?? "").trim(),
      usedToLiveIn: String(o["Used to live in"] ?? "").trim(),
    });
  }
  return out;
}

const NAME_SUFFIX = /\s+(jr|sr|ii|iii|iv|v)\.?$/i;
function normPersonName(s: string): string {
  return s.toLowerCase().replace(NAME_SUFFIX, "").replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
}

/** "Brook Park, OH" -> { city: "brook park", state: "OH" } (best effort). */
function splitCityState(s: string): { city: string; state: string } {
  const [c, st] = s.split(",").map((p) => p.trim());
  return { city: (c || "").toLowerCase(), state: (st || "").toUpperCase() };
}

/**
 * The ONE record the candidate's own location corroborates, else null. Exact
 * (suffix-stripped) name match is mandatory; then current city+state, else the
 * single same-state record, else a single past-address city+state hit. Ambiguity
 * = no purchase: same rung philosophy as LandlineDB matching.
 */
export function matchDirectoryRecord(
  records: DirectoryRecord[],
  subject: { fullName?: unknown; city?: unknown; state?: unknown },
): DirectoryRecord | null {
  const wantName = normPersonName(String(subject.fullName ?? ""));
  const city = String(subject.city ?? "").trim().toLowerCase();
  const state = String(subject.state ?? "").trim().toUpperCase();
  if (!wantName || !state) return null; // nothing to corroborate with -> never buy blind
  const named = records.filter((r) => normPersonName(r.name) === wantName);
  if (!named.length) return null;

  const liveExact = city
    ? named.filter((r) => { const l = splitCityState(r.livesIn); return l.state === state && l.city === city; })
    : [];
  if (liveExact.length === 1) return liveExact[0];
  if (liveExact.length > 1) return null; // same name, same city: cannot tell them apart

  const liveState = named.filter((r) => splitCityState(r.livesIn).state === state);
  if (liveState.length === 1) return liveState[0];

  if (city) {
    // Past addresses come as "City ST, City ST" (no comma inside a pair).
    const needle = `${city} ${state.toLowerCase()}`;
    const past = named.filter((r) => r.usedToLiveIn.toLowerCase().includes(needle));
    if (past.length === 1) return past[0];
  }
  return null;
}

const DEFAULT_DETAILS_PATH = "/search/detailsbyID?peo_id={id}";

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
      if (best) {
        return {
          status: "hit",
          value: best.number,
          confidence: best.mobile ? 0.6 : 0.5,
          cost: unitCostUsd,
          raw: data,
        };
      }

      // No phone in the search answer: two-step directory listings put it behind a
      // per-person details call. Only buy it for a location-corroborated match.
      const dir = directoryRecords(data);
      if (!dir.length) return { status: "miss", cost: missCost };
      const match = matchDirectoryRecord(dir, subject as { fullName?: unknown; city?: unknown; state?: unknown });
      if (!match) return { status: "miss", cost: missCost }; // search call billed, no confident person
      const detailsTpl = cred("RAPIDAPI_SKIPTRACE_DETAILS_PATH").trim() || DEFAULT_DETAILS_PATH;
      const detailsPath = detailsTpl.replace(/\{id\}/gi, encodeURIComponent(match.id));
      const twoCallCost = billing === "call" ? unitCostUsd * 2 : 0;
      const res2 = await fetch(`https://${host}${detailsPath}`, { headers });
      if (res2.status === 404 || res2.status === 204) return { status: "miss", cost: twoCallCost };
      if (!res2.ok) return { status: "error", error: `RapidAPI ${host} details ${res2.status}`, cost: missCost };
      const data2 = (await res2.json().catch(() => null)) as unknown;
      const best2 = data2 ? extractSkipTracePhone(data2) : null;
      if (!best2) return { status: "miss", cost: twoCallCost };
      return {
        status: "hit",
        value: best2.number,
        confidence: best2.mobile ? 0.6 : 0.5,
        cost: billing === "call" ? unitCostUsd * 2 : unitCostUsd,
        raw: data2,
      };
    },
  });
}
