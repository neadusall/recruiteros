/**
 * /api/owner/burn  (OWNER ONLY)
 *
 * The master spend dashboard behind Owner Console -> Spend master. Joins the editable
 * spend register (subscriptions, servers, domains, one-time buys) with the live system:
 * the RapidAPI credit meter, the usage ledger, and the credential store. That join is
 * the point: it is what lets the console say "this $150/mo subscription has no key
 * configured" instead of just listing a price.
 *
 *   GET    ?window=today|7d|30d|all  -> rollup + every line item with its live signal
 *   POST   { vendor, label, ... }    -> add a line item
 *   PATCH  { id, ...fields }         -> edit one (entering an amount marks it verified)
 *   DELETE ?id=…                     -> remove one
 */

import { requireOwner, ok, fail, body } from "../../../../lib/api";
import type { SpendWindow } from "../../../../lib/billing/ledger";
import { spendRollup } from "../../../../lib/billing/ledger";
import { ensureVendorUsageReady } from "../../../../lib/owner/vendorUsage";
import {
  listSpendItems,
  addSpendItem,
  updateSpendItem,
  deleteSpendItem,
  attachLive,
  rollupBurn,
  fetchPhoneOutcomes,
  rollupEffectiveness,
  importSendingDomains,
  refreshDomainFacts,
  priceDomains,
  type SpendItem,
} from "../../../../lib/owner/spendRegister";

export async function GET(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const url = new URL(req.url);
  const window = (url.searchParams.get("window") as SpendWindow) || "30d";

  const base = await listSpendItems();
  /* Vendor-billed figures are read synchronously inside attachLive/rollupBurn, so hydrate
     the store first or a cold container prices every metered line off the internal ledger
     for one page view. */
  await ensureVendorUsageReady();
  const [items, outcomes] = await Promise.all([attachLive(base, window), fetchPhoneOutcomes()]);
  const rollup = rollupBurn(items, window);
  const ledger = spendRollup(window);

  return ok({
    ...rollup,
    items,
    /* What each data source produced, priced per reply. Empty when the OS Text engine
       is unreachable, which the UI reports rather than hiding. */
    effectiveness: rollupEffectiveness(outcomes, base),
    /* The metered half, sliced the way the existing Spend view slices it, so the master
       dashboard shows committed and metered cost side by side rather than in two tabs. */
    metered: {
      totalCostUsd: ledger.totalCostUsd,
      events: ledger.events,
      byCategory: ledger.byCategory,
      bySource: ledger.bySource,
      byMotion: ledger.byMotion,
    },
  });
}

export async function POST(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const b = await body<Partial<SpendItem> & { action?: string }>(req);
  if (!b) return fail("bad_request", 400);

  /* Domain maintenance runs through the same endpoint:
       action=import_domains  adopt every domain the sending fleet uses
       action=refresh_domains pull registration/expiry/registrar from the public registry */
  if (b.action === "import_domains") return ok(await importSendingDomains());
  if (b.action === "refresh_domains") return ok(await refreshDomainFacts());
  /* action=price_domains  price a whole registrar batch at once. Domains are bought 29
     at a time at one price, so pricing them one row at a time is how the panel stops
     being maintained. */
  if (b.action === "price_domains") {
    const p = b as unknown as { vendor?: string; amountUsd?: number; renewalUsd?: number; autoRenew?: boolean; overwrite?: boolean };
    if (!String(p.vendor || "").trim()) return fail("vendor_required", 400);
    return ok(await priceDomains({
      vendor: String(p.vendor),
      amountUsd: p.amountUsd,
      renewalUsd: p.renewalUsd,
      autoRenew: p.autoRenew,
      overwrite: p.overwrite,
    }));
  }

  if (!String(b.vendor || "").trim()) return fail("vendor_required", 400);
  return ok({ item: await addSpendItem(b) });
}

export async function PATCH(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const b = await body<Partial<SpendItem> & { id?: string }>(req);
  if (!b?.id) return fail("id_required", 400);
  const item = await updateSpendItem(b.id, b);
  if (!item) return fail("not_found", 404);
  return ok({ item });
}

export async function DELETE(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail("id_required", 400);
  if (!(await deleteSpendItem(id))) return fail("not_found", 404);
  return ok({ deleted: true });
}
