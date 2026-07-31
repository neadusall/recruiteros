/**
 * /api/owner/spend/verified  (OWNER, or a service key)
 *
 * Where the PLAN CHECK reports in, as opposed to the receipt pullers next door.
 *
 * A receipt proves money moved. It does not prove the TERM: a $71 charge is the same
 * bank line whether it renews next month or next year, and the register was carrying
 * guesses at that term which nothing in the system could contradict. Guess monthly on an
 * annual box and the burn figure is 12x too high; guess the other way and the business
 * budgets for a twelfth of a real bill.
 *
 * The only place the truth is written down is the vendor's own account page, behind a
 * login. So the plan check (spend-ledger/plans.mjs) drives a browser session the owner
 * signed in themselves, reads each service with its billing cycle and recurring price,
 * and POSTs the result here. Those figures are the vendor's own statement, so they
 * overwrite a seeded guess outright and land marked `verified`.
 *
 *   POST { vendor, plans: [...], force?, sourceUrl?, checkedAt? }
 *
 * Authenticated by an owner session OR Bearer RECEIPTS_INGEST_KEY, so a scheduled run
 * can report unattended. It never deletes: a register row the vendor page did not
 * mention comes back as `missingFromVendor` for a human to judge, because "cancelled"
 * and "the reader missed a table" must not look the same.
 */

import { ok, fail, body, context } from "../../../../../lib/api";
import { isOwnerEmail } from "../../../../../lib/owner";
import {
  applyVerifiedPlans,
  listSpendItems,
  type VerifiedPlan,
  type BillingType,
} from "../../../../../lib/owner/spendRegister";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: Request): boolean {
  const key = process.env.RECEIPTS_INGEST_KEY;
  const h = req.headers.get("authorization") ?? "";
  if (key && h === `Bearer ${key}`) return true;
  const ctx = context(req);
  return Boolean(ctx && isOwnerEmail(ctx.user.email));
}

const CYCLES: BillingType[] = ["monthly", "annual", "one_time", "credit", "metered"];

/** GET: what the register currently believes, so the checker can diff before it writes
 *  and can name real row ids when it has to ask which service pairs with which row. */
export async function GET(req: Request) {
  if (!authed(req)) return fail("not_found", 404);
  const vendor = new URL(req.url).searchParams.get("vendor");
  const items = await listSpendItems();
  const rows = (vendor ? items.filter((i) => i.vendor.toLowerCase() === vendor.toLowerCase()) : items)
    .map((i) => ({
      id: i.id, vendor: i.vendor, label: i.label, billing: i.billing,
      amountUsd: i.amountUsd, verified: !!i.verified, seeded: !!i.seeded, status: i.status,
      vendorLabel: i.vendorLabel,
    }));
  return ok({ items: rows });
}

export async function POST(req: Request) {
  if (!authed(req)) return fail("not_found", 404);

  const b = await body<{
    vendor?: string;
    plans?: VerifiedPlan[];
    force?: boolean;
    sourceUrl?: string;
    checkedAt?: string;
    /** { "the vendor's product name": "<register row id>" }: a pairing a human has
     *  confirmed. Stored on the row, so the question is only ever asked once. */
    map?: Record<string, string>;
  }>(req);

  const vendor = String(b?.vendor || "").trim();
  if (!vendor) return fail("vendor required", 400);
  if (!Array.isArray(b?.plans)) return fail("plans[] required", 400);

  /* Nothing read means nothing is written. An empty list from a reader that failed to
     find the services table would otherwise flag every row as gone from the vendor. */
  if (!b.plans.length) return fail("no plans in the payload: a read that found nothing must not rewrite the register", 400);

  const plans: VerifiedPlan[] = [];
  for (const p of b.plans) {
    const label = String(p?.label || "").trim();
    if (!label) return fail("every plan needs a label", 400);
    const billing = p?.billing as BillingType;
    if (!CYCLES.includes(billing)) {
      return fail(`plan "${label}": billing must be one of ${CYCLES.join(", ")}`, 400);
    }
    const amountUsd = Number(p?.amountUsd);
    if (!isFinite(amountUsd) || amountUsd < 0) return fail(`plan "${label}": amountUsd must be a number`, 400);
    plans.push({
      vendor,
      label,
      billing,
      amountUsd,
      nativeAmount: isFinite(Number(p?.nativeAmount)) ? Number(p.nativeAmount) : undefined,
      currency: p?.currency ? String(p.currency).toUpperCase().slice(0, 3) : undefined,
      nextDueAt: p?.nextDueAt ? String(p.nextDueAt).slice(0, 10) : undefined,
      status: p?.status === "cancelled" ? "cancelled" : "active",
      reference: p?.reference ? String(p.reference) : undefined,
      sourceUrl: p?.sourceUrl ? String(p.sourceUrl) : b.sourceUrl,
      checkedAt: p?.checkedAt || b.checkedAt,
      category: p?.category,
    });
  }

  const res = await applyVerifiedPlans(vendor, plans, {
    force: !!b.force,
    sourceUrl: b.sourceUrl,
    checkedAt: b.checkedAt,
    map: b.map && typeof b.map === "object" ? b.map : undefined,
  });

  return ok({ vendor, read: plans.length, ...res });
}
