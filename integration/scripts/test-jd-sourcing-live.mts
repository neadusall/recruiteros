/**
 * JD Sourcing — LIVE end-to-end proof of the RapidAPI people search.
 *
 *   ROS_DATA_DIR=/data npx tsx scripts/test-jd-sourcing-live.mts            (from integration/)
 *   ROS_DATA_DIR=/data npx tsx scripts/test-jd-sourcing-live.mts --profile  (also deep-vet)
 *
 * WHY THIS EXISTS. The people-search keys sat saved-but-unproven for two months: three
 * workspaces read "green" from a test last run on 2026-06-16, a fourth pointed at an
 * endpoint the listing had removed, and nothing in the product could tell the
 * difference. The Connected tab's Test button proves one workspace at a time and only
 * when a human clicks it; the hourly engine-health watch could not see the paid search
 * at all (it mis-parsed the quota snapshot and reported "stale" forever).
 *
 * So this walks EVERY workspace that has JD Sourcing configured and fires a real
 * search through the production code path — withWorkspaceCreds() -> the same
 * credential resolution the engine uses -> verifySourcingSearch(). Nothing here
 * reimplements the request, so it cannot pass while the engine fails.
 *
 * COST: one billed request per distinct workspace config, plus one more per workspace
 * with --profile. Under ten requests against a 20,000/month plan.
 *
 * EXIT CODE: non-zero if any configured workspace cannot search, so it is safe to run
 * from cron or a deploy gate.
 */

import { adminListAccounts, ensureAuthReady } from "../lib/auth";
import { withWorkspaceCreds } from "../lib/connected";
import {
  rapidApiSearchConfigured, verifySourcingSearch, peopleSearchHost,
} from "../lib/sourcing";
import { profileFetchConfigured, fetchFullProfile } from "../lib/sourcing/profile";
import { getRapidQuotaFor } from "../lib/sourcing/rapidQuota";

const WANT_PROFILE = process.argv.includes("--profile");
/** A public profile that exists and stays put, for the deep-vet rung. */
const PROFILE_PROBE = "https://www.linkedin.com/in/williamhgates";

interface Row {
  workspace: string;
  name: string;
  host: string;
  ok: boolean;
  detail: string;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function main(): Promise<void> {
  await ensureAuthReady();
  const accounts = adminListAccounts().filter((a) => !a.suspended);
  if (!accounts.length) {
    console.error("No workspaces found. Is ROS_DATA_DIR pointing at the live data directory?");
    process.exit(2);
  }

  const rows: Row[] = [];
  let skipped = 0;

  for (const acct of accounts) {
    const res = await withWorkspaceCreds(acct.workspaceId, async () => {
      if (!rapidApiSearchConfigured()) return null; // nothing saved here; not a failure
      const host = peopleSearchHost();

      const search = await verifySourcingSearch();
      const quota = await getRapidQuotaFor(host);
      const credits = quota && quota.limit > 0
        ? `${quota.remaining}/${quota.limit} credits`
        : "no credit headers";

      if (!search.ok) {
        return { host, ok: false, detail: `SEARCH FAILED — ${search.error ?? "no reason given"}` };
      }

      // A search that answers with zero rows for a term this broad is not a pass: the
      // listing is up but returning nothing usable, which reaches the recruiter as an
      // empty list either way.
      if (!search.found) {
        return { host, ok: false, detail: `search answered but returned 0 rows for a broad term (${credits})` };
      }

      let profile = "";
      if (WANT_PROFILE) {
        if (!profileFetchConfigured()) {
          profile = " · deep-vet not configured";
        } else {
          try {
            const p = await fetchFullProfile(PROFILE_PROBE);
            profile = p && p.fullName ? ` · deep-vet ok (${p.fullName})` : " · DEEP-VET returned no profile";
          } catch (e) {
            profile = ` · DEEP-VET FAILED (${(e as Error).message})`;
          }
        }
      }
      return { host, ok: true, detail: `${search.found} rows · ${credits}${profile}` };
    });

    if (!res) { skipped++; continue; }
    rows.push({ workspace: acct.workspaceId, name: acct.name || "(unnamed)", ...res });
  }

  console.log("");
  console.log("JD Sourcing · live people-search proof");
  console.log("=".repeat(78));
  for (const r of rows) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${pad(r.name, 22)} ${pad(r.workspace, 17)} ${r.host}`);
    console.log(`      ${r.detail}`);
  }
  if (skipped) console.log(`\n(${skipped} workspace(s) have no JD Sourcing keys saved — not checked.)`);

  const failed = rows.filter((r) => !r.ok);
  console.log("");
  console.log(`${rows.length - failed.length} passed, ${failed.length} failed, ${skipped} unconfigured`);
  if (!rows.length) {
    console.error("No workspace has JD Sourcing configured — nothing was proven.");
    process.exit(2);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("live proof crashed:", e);
  process.exit(2);
});
