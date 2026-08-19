/**
 * RecruitersOS · Signal Engine · Phone line-type classification
 *
 * The cheap, reliable way to split a found number into MOBILE vs LANDLINE: run
 * it through Telnyx Number Lookup (~$0.0025/query, reuses the Telnyx integration
 * we already have) and read the carrier line type. Deep research (May 2026)
 * confirmed this beats trusting a scraper's own "mobile/landline" label.
 *
 * Every real classify call is METERED into the billing ledger (type
 * "phone_classify", source "telnyx") when a workspace context is supplied, so
 * the owner console tracks this cost like everything else. When Telnyx is not
 * configured the call is a no-op (dry run) and nothing is charged.
 */

import { telnyx } from "../providers";
import { withWorkspaceCreds } from "../connected";
import { recordUsage } from "../billing/ledger";
import { rateCost } from "../billing/rates";
import type { Motion } from "../core/types";

export type LineType = "mobile" | "landline" | "voip" | "toll_free" | "unknown";
export type CallerType = "business" | "consumer" | "unknown";

export interface ClassifyResult {
  number: string;
  lineType: LineType;
  carrier?: string;
  /** CNAM caller name (e.g. "ACME LOGISTICS"), when a caller-name lookup ran. */
  callerName?: string;
  /** BUSINESS vs CONSUMER per the CNAM registry, when looked up. */
  callerType?: CallerType;
  /**
   * True ONLY when we can confirm this is an ACTUAL BUSINESS landline/VoIP line:
   * the CNAM says BUSINESS, or it's VoIP on a known business/UCaaS carrier. A
   * residential landline, a consumer VoIP, or an unconfirmed line is false. This
   * is the gate for the voicemail motions (business lines only, never personal).
   */
  businessLine?: boolean;
  /** The number, placed in the field its line type implies (the routing result). */
  mobilePhone?: string;
  landlinePhone?: string;
  /** USD spent on the lookup (0 when Telnyx is unconfigured / dry run). */
  costUsd: number;
  /** True if a real lookup ran (vs skipped/dry-run). */
  looked: boolean;
  /** True if the cost was written to the ledger. */
  recorded: boolean;
}

export interface ClassifyOptions {
  /** Workspace to bill the lookup to. Omit to skip ledger metering (e.g. preview). */
  workspaceId?: string;
  /** Operating system the cost belongs to (for the by-motion rollup). */
  motion?: Motion;
  /** Set false to classify without writing a cost event (default true). */
  record?: boolean;
  /**
   * Also resolve BUSINESS vs CONSUMER (CNAM caller-name lookup) so we can keep
   * ACTUAL business lines only. Costs a little more per query; used by the
   * voicemail motions, off elsewhere.
   */
  business?: boolean;
}

/**
 * Known business / UCaaS / CLEC carriers. A VoIP number on one of these is a
 * business line with very high confidence (these carriers sell to companies, not
 * households). Substring match, case-insensitive.
 */
const BUSINESS_CARRIERS = [
  "ringcentral", "8x8", "eight by eight", "bandwidth", "twilio", "level 3", "level3",
  "lumen", "vonage", "nextiva", "dialpad", "zoom", "sinch", "telnyx", "peerless",
  "inteliquent", "intrado", "onvoy", "mitel", "avaya", "cisco", "microsoft", "google",
  "ooma", "goto", "jive", "grasshopper", "broadvoice", "fuze", "five9", "genesys",
  "nice", "talkdesk", "aircall", "3cx", "windstream", "west corp", "commio", "flowroute",
  "voip", "communications", "telecom", "cloud", "hosted",
];

export function businessVoipCarrier(carrier?: string): boolean {
  const c = (carrier ?? "").toLowerCase();
  if (!c) return false;
  return BUSINESS_CARRIERS.some((b) => c.includes(b));
}

/**
 * Is this an ACTUAL business landline/VoIP line we may leave a voicemail on?
 * Conservative by design (the operator asked for business lines ONLY): a
 * mobile/toll-free/unknown line is never business; a CONSUMER CNAM is never
 * business even on a landline; we say business only on a BUSINESS CNAM or a
 * business/UCaaS VoIP carrier. An unconfirmed landline defaults to NOT business.
 */
export function isBusinessLine(input: { lineType: LineType; carrier?: string; callerType?: CallerType }): boolean {
  if (input.lineType !== "landline" && input.lineType !== "voip") return false;
  if (input.callerType === "consumer") return false;
  if (input.callerType === "business") return true;
  return businessVoipCarrier(input.carrier);
}

function mapCallerType(raw?: string): CallerType {
  const t = (raw ?? "").toLowerCase();
  if (t.includes("business")) return "business";
  if (t.includes("consumer") || t.includes("residential")) return "consumer";
  return "unknown";
}

/** Map Telnyx's carrier.type string onto our line-type buckets. */
export function mapLineType(raw?: string): LineType {
  const t = (raw ?? "").toLowerCase();
  if (!t) return "unknown";
  if (t.includes("mobile") || t.includes("cell") || t.includes("wireless")) return "mobile";
  if (t.includes("toll")) return "toll_free";
  if (t.includes("voip")) return "voip";
  if (t.includes("land") || t.includes("fixed")) return "landline";
  return "unknown";
}

/**
 * Classify one number's line type via Telnyx and route it into the mobile or
 * landline field. Records the lookup cost to the ledger when a workspace is given.
 */
export async function classifyLine(number: string, opts: ClassifyOptions = {}): Promise<ClassifyResult> {
  const base: ClassifyResult = { number, lineType: "unknown", costUsd: 0, looked: false, recorded: false };
  const clean = (number || "").trim();
  if (!clean) return base;

  // Isolation: resolve Telnyx against the workspace's own key (a customer never
  // rides the operator's env). configured() must run inside the same context, so
  // the whole lookup runs in the workspace's credential scope and returns its result.
  const lookup = async (): Promise<{ lineType: LineType; carrier?: string; callerName?: string; callerType?: CallerType; looked: boolean }> => {
    if (!telnyx.configured()) return { lineType: "unknown", looked: false };
    try {
      const res: any = await telnyx.numberLookup(clean, { callerName: opts.business === true });
      if (res && !res.dryRun) {
        const c = res?.data?.carrier ?? res?.carrier ?? {};
        const cn = res?.data?.caller_name ?? res?.caller_name ?? {};
        return {
          lineType: mapLineType(c.type ?? res?.data?.type),
          carrier: c.name ?? c.carrier_name,
          callerName: cn.caller_name ?? cn.name,
          callerType: opts.business ? mapCallerType(cn.caller_type ?? cn.type) : undefined,
          looked: true,
        };
      }
    } catch {
      /* lookup failed; leave unknown, charge nothing */
    }
    return { lineType: "unknown", looked: false };
  };
  const got = opts.workspaceId ? await withWorkspaceCreds(opts.workspaceId, lookup) : await lookup();
  const lineType: LineType = got.lineType;
  const carrier = got.carrier;
  const looked = got.looked;

  const result: ClassifyResult = { ...base, lineType, carrier, callerName: got.callerName, callerType: got.callerType, looked };
  if (opts.business) {
    result.businessLine = isBusinessLine({ lineType, carrier, callerType: got.callerType });
  }
  if (lineType === "mobile") result.mobilePhone = clean;
  else if (lineType === "landline" || lineType === "voip") result.landlinePhone = clean;

  // Meter the real lookup into the cost ledger (the "so it can be tracked" part).
  if (looked && opts.workspaceId && opts.record !== false) {
    const unitCostUsd = rateCost("phone_classify");
    recordUsage({
      workspaceId: opts.workspaceId,
      motion: opts.motion ?? "recruiting",
      category: "enrichment",
      type: "phone_classify",
      source: "telnyx",
      quantity: 1,
      unitCostUsd,
      meta: { number: clean, lineType, carrier },
    });
    result.costUsd = unitCostUsd;
    result.recorded = true;
  }
  return result;
}

/**
 * Classify whatever numbers a contact has and return the mobile/landline split.
 * Skips a field that is already typed. One ledger event per real lookup.
 */
export async function classifyContactNumbers(
  contact: { phone?: string; mobilePhone?: string; landlinePhone?: string },
  opts: ClassifyOptions = {},
): Promise<{ mobilePhone?: string; landlinePhone?: string; costUsd: number; lineType: LineType }> {
  // Already split -> nothing to do.
  if (contact.mobilePhone || contact.landlinePhone) {
    return { mobilePhone: contact.mobilePhone, landlinePhone: contact.landlinePhone, costUsd: 0, lineType: contact.mobilePhone ? "mobile" : "landline" };
  }
  const candidate = contact.phone;
  if (!candidate) return { costUsd: 0, lineType: "unknown" };
  const r = await classifyLine(candidate, opts);
  return { mobilePhone: r.mobilePhone, landlinePhone: r.landlinePhone, costUsd: r.costUsd, lineType: r.lineType };
}
