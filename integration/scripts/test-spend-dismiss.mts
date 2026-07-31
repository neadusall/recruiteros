/**
 * Spend register: a deleted line stays deleted. Regression suite.
 * Run: npx tsx scripts/test-spend-dismiss.mts   (exits non-zero on failure)
 *
 * Spend master grew a Delete on every row, and two things in this file put rows back on
 * their own: applySeed, which adds any SEED row the register does not hold and runs on
 * every version bump, and the domain adopter, which runs on any boot that finds a domain
 * with no registrar yet. Without the rules below a deleted subscription reappeared at the
 * next deploy and a deleted domain within minutes, so the delete looked like it had never
 * worked. That is worse than not having the button.
 *
 * What is pinned:
 *   - a deleted row is remembered by vendor + label, and a deleted DOMAIN by its own name,
 *     because the registry lookup rewrites a domain row's vendor to its registrar and a key
 *     that moves is a key that stops matching;
 *   - the seed skips what was deleted and still adds everything else;
 *   - the domain adopter skips what was deleted;
 *   - "Import from sending fleet" forgets the domain deletions and ONLY those, so pressing
 *     it can never bring a deleted subscription (and its charge) back;
 *   - all four rules are stable on a second pass.
 */

import {
  dismissKey, seedAdditions, domainsToAdopt, forgetDomainDismissals,
  type SpendItem,
} from "../lib/owner/spendRegister";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` (got ${g}, want ${w})`}`);
}

const T = "2026-07-01T00:00:00.000Z";
function row(vendor: string, label: string, over: Partial<SpendItem> = {}): SpendItem {
  return {
    id: "sp_" + label.replace(/\W+/g, "").slice(0, 12),
    vendor, label, category: "infra", billing: "monthly",
    amountUsd: 0, needsAmount: true, at: "2026-06-02", status: "active",
    seeded: true, createdAt: T, updatedAt: T,
    ...over,
  };
}
const seed = (vendor: string, label: string) => ({ vendor, label }) as never;

/* ---- what a deleted row is remembered by ---- */
{
  check("an ordinary row is keyed by vendor and label",
    dismissKey(row("Smartlead", "Warm-up pool")), "smartlead|warm-up pool");
  check("the key ignores case", dismissKey(row("SMARTLEAD", "Warm-Up Pool")), "smartlead|warm-up pool");
  // The vendor here is the registrar the lookup filled in, NOT what it was adopted as.
  check("a domain is keyed by its own name",
    dismissKey(row("Dynadot", "talentrecru.com", { domain: "talentrecru.com" })), "domain:talentrecru.com");
  check("a domain keeps its key when the registrar is renamed",
    dismissKey(row("Porkbun", "talentrecru.com", { domain: "talentrecru.com" })), "domain:talentrecru.com");
}

/* ---- the seed does not undo a delete ---- */
{
  const SEED = [seed("Smartlead", "Warm-up pool"), seed("Hetzner", "App server (CCX13)")];
  check("with nothing held and nothing deleted, everything seeds",
    seedAdditions([], SEED, []).map((s) => s.vendor), ["Smartlead", "Hetzner"]);
  check("a row already held is not seeded twice",
    seedAdditions([row("Smartlead", "Warm-up pool")], SEED, []).map((s) => s.vendor), ["Hetzner"]);
  check("a deleted row is NOT put back",
    seedAdditions([], SEED, ["smartlead|warm-up pool"]).map((s) => s.vendor), ["Hetzner"]);
  check("deleting one row does not stop the others seeding",
    seedAdditions([], SEED, ["smartlead|warm-up pool"]).length, 1);
  check("second pass changes nothing",
    seedAdditions([row("Hetzner", "App server (CCX13)")], SEED, ["smartlead|warm-up pool"]).length, 0);
  check("a domain key never blocks a subscription",
    seedAdditions([], SEED, ["domain:smartlead"]).length, 2);
}

/* ---- the domain adopter does not undo a delete ---- */
{
  const FLEET = ["talentrecru.com", "hiretalpros.com", "lumesearch.co"];
  check("with nothing deleted the whole fleet is adopted", domainsToAdopt(FLEET, []).length, 3);
  check("a deleted domain is skipped",
    domainsToAdopt(FLEET, ["domain:hiretalpros.com"]), ["talentrecru.com", "lumesearch.co"]);
  check("the key is matched case-insensitively",
    domainsToAdopt(["HireTalPros.com"], ["domain:hiretalpros.com"]), []);
  check("a subscription key never blocks a domain",
    domainsToAdopt(FLEET, ["smartlead|warm-up pool"]).length, 3);
}

/* ---- Import is the one thing that forgets, and only for domains ---- */
{
  const gone = ["smartlead|warm-up pool", "domain:hiretalpros.com", "domain:lumesearch.co"];
  check("Import forgets the domain deletions", forgetDomainDismissals(gone), ["smartlead|warm-up pool"]);
  check("Import never brings a deleted subscription back",
    seedAdditions([], [seed("Smartlead", "Warm-up pool")], forgetDomainDismissals(gone)).length, 0);
  check("after Import the fleet is adopted again",
    domainsToAdopt(["hiretalpros.com"], forgetDomainDismissals(gone)).length, 1);
  check("second pass changes nothing",
    forgetDomainDismissals(forgetDomainDismissals(gone)), ["smartlead|warm-up pool"]);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
