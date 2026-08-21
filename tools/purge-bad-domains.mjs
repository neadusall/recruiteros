#!/usr/bin/env node
/**
 * purge-bad-domains.mjs — evict company-domain cache entries the OLD substring matcher accepted
 * and the new brand matcher rejects.
 *
 * WHY THIS EXISTS. domain.ts caches a resolved domain for 30 DAYS (POS_TTL_MS). Fixing the matcher
 * therefore does nothing for a company already resolved: the poisoned verdict is served straight
 * from cache until it expires. Every one of those companies keeps feeding the WRONG domain to the
 * email pattern builder and the owner finder, so it keeps producing junk addresses and no_name
 * outcomes for another month. This drops the bad verdicts so they re-resolve against the fixed
 * rule on next touch (a dropped entry simply resolves again; nothing is lost).
 *
 * DELIBERATELY CONSERVATIVE. It only evicts the exact failure mode the fix addresses: a cached root
 * that STARTS WITH the company anchor and then carries extra brand material that is not a known
 * affix (loop -> loopnet, alma -> almanac, warp -> warpedspeed, modernhealth -> modernhealthcare).
 * It never touches a root SHORTER than the anchor, because those were matched through the token
 * path ("Ramp Financial" -> ramp.com) and are usually right. Under-purging costs nothing; the
 * entry expires on its own. Over-purging would re-resolve tens of thousands of companies for no
 * reason.
 *
 * Read-only unless --write is passed. After writing, RESTART THE APP: the running process holds
 * this snapshot in memory and will re-save over any file edited underneath it (CLAUDE.md
 * hydration trap).
 *
 *   node /tools/purge-bad-domains.mjs            # report only
 *   node /tools/purge-bad-domains.mjs --write    # evict, then restart the app
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";

const FILE = process.env.DOMAIN_CACHE_FILE || "/data/snap_inmarket_domain_v2.json";
const WRITE = process.argv.includes("--write");

// Mirrors integration/lib/inmarket/domain.ts exactly. Keep in step with it.
const BRAND_PREFIX = /^(get|try|join|use|go|my|the|hey|with|team|meet|hi)$/;
const BRAND_SUFFIX = /^(hq|app|io|ai|inc|co|hr|now|one)$/;

/** Registrable root of a domain, minus the public suffix ("acme.co.uk" -> "acme"). */
function rootOf(domain) {
  const parts = String(domain || "").toLowerCase().split(".").filter(Boolean);
  if (parts.length < 2) return "";
  const twoLevel = /^(co|com|org|net|gov|ac|edu)$/;
  if (parts.length >= 3 && twoLevel.test(parts[parts.length - 2])) return parts[parts.length - 3];
  return parts[parts.length - 2];
}

const cache = JSON.parse(readFileSync(FILE, "utf8"));
const entries = Object.entries(cache);

const evicted = [];
let positives = 0;
for (const [anchor, v] of entries) {
  if (!v || !v.ok || !v.domain) continue;
  positives++;
  const root = rootOf(v.domain);
  if (!root || !anchor || anchor.length < 3) continue;
  if (root === anchor) continue;                       // exact brand: correct
  if (!root.startsWith(anchor)) continue;              // shorter/other root: token path, leave alone
  const rest = root.slice(anchor.length);
  if (!rest) continue;
  if (BRAND_SUFFIX.test(rest)) continue;               // anchor + known affix: correct (getjobber)
  if (BRAND_PREFIX.test(rest)) continue;
  evicted.push({ anchor, domain: v.domain, via: v.via, extra: rest });
}

console.log(`domain cache: ${entries.length} companies (${positives} resolved)`);
console.log(`wrong-company verdicts to evict: ${evicted.length}`);
for (const e of evicted.slice(0, 40)) {
  console.log(`  ${e.anchor.padEnd(28)} -> ${String(e.domain).padEnd(34)} (extra "${e.extra}", via ${e.via})`);
}
if (evicted.length > 40) console.log(`  ... and ${evicted.length - 40} more`);

if (!WRITE) {
  console.log(`\nreport only. re-run with --write to evict, then restart the app.`);
  process.exit(0);
}

for (const e of evicted) delete cache[e.anchor];
const tmp = `${FILE}.purge.tmp`;
writeFileSync(tmp, JSON.stringify(cache));
renameSync(tmp, FILE);
console.log(`\nevicted ${evicted.length} entries; ${Object.keys(cache).length} remain.`);
console.log(`RESTART THE APP NOW or the running process will re-save the old map over this file.`);
