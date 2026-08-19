/**
 * RecruitersOS · Phone Intelligence · Batch runner (spec §58)
 *
 * A campaign of 100 people across 20 companies is 20 IVR discoveries, not 100:
 * group by company, learn each switchboard once, reuse the cached route for
 * every remaining prospect there. Explicitly invoked (NOT auto-armed) so Phase-1
 * calling stays supervised — the user triggers a batch, watches the timelines.
 *
 * Number rotation (user rule) is applied per contact: pickFromNumber skips any
 * of our lines already burned by a live answer and prefers the line that reached
 * the contact's voicemail.
 */

import { startCall } from "./orchestrator";
import { pickFromNumber } from "./outreach";
import { activeRoute, companyKeyOf } from "./store";
import { CONFIDENCE, type IntelCall } from "./types";

export interface BatchContact {
  companyName: string;
  domain?: string;
  mainPhone: string;
  first?: string;
  last?: string;
  full: string;
  title?: string;
  contactId?: string;
  location?: string;
  stateCode?: string;
}

export interface BatchOptions {
  workspaceId: string;
  /** Our available caller-ID lines (E.164) to rotate across. */
  numberPool: string[];
  /** Seconds between calls to the SAME company (fatigue pacing). */
  perCompanyGapSec?: number;
  /** Ceiling on calls placed in this batch invocation. */
  maxCalls?: number;
  /** Sleep primitive (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
}

/** Group contacts by the routing-graph company key. */
export function groupByCompany(contacts: BatchContact[]): Map<string, BatchContact[]> {
  const groups = new Map<string, BatchContact[]>();
  for (const c of contacts) {
    const key = companyKeyOf({ domain: c.domain, companyName: c.companyName });
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(c);
  }
  return groups;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface BatchResult {
  placed: IntelCall[];
  skipped: Array<{ contact: string; reason: string }>;
}

/**
 * Run a batch. For each company the FIRST contact runs a discovery call; once a
 * route reaches sufficient confidence, the rest ride the cached route. Calls are
 * paced per company to avoid switchboard fatigue.
 */
export async function runBatch(contacts: BatchContact[], opts: BatchOptions): Promise<BatchResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const gap = (opts.perCompanyGapSec ?? 90) * 1000;
  const max = opts.maxCalls ?? contacts.length;
  const groups = groupByCompany(contacts);

  const placed: IntelCall[] = [];
  const skipped: BatchResult["skipped"] = [];

  for (const [companyKey, group] of groups) {
    // Discovery-first ordering: if no route yet, the first call teaches it.
    const hasRoute = () => {
      const r = activeRoute(opts.workspaceId, companyKey);
      return !!r && r.confidence >= CONFIDENCE.REDISCOVER_BELOW;
    };
    for (let i = 0; i < group.length; i++) {
      if (placed.length >= max) return { placed, skipped };
      const c = group[i];

      const pick = pickFromNumber(
        opts.workspaceId,
        { contactId: c.contactId, companyKey, targetFull: c.full },
        opts.numberPool,
      );
      if (pick.exhausted || !pick.number) {
        // Every line burned for this contact — hold (user rule: don't re-dial
        // from a number they already answered). BD outreach swaps in a fresh
        // number out-of-band before this contact is retried.
        skipped.push({ contact: c.full, reason: "all_numbers_burned" });
        continue;
      }

      const call = await startCall({
        workspaceId: opts.workspaceId,
        companyName: c.companyName, domain: c.domain, mainPhone: c.mainPhone,
        targetFirst: c.first, targetLast: c.last, targetFull: c.full, targetTitle: c.title,
        targetContactId: c.contactId, fromNumber: pick.number,
        location: c.location, stateCode: c.stateCode,
      });
      placed.push(call);

      // Pace within a company; first call of a fresh company gets extra room so
      // its route can be learned before the next prospect there rides it.
      const isDiscoveryLead = i === 0 && !hasRoute();
      await sleep(isDiscoveryLead ? gap : Math.round(gap / 2));
    }
  }
  return { placed, skipped };
}
