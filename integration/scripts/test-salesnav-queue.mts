/**
 * Functional suite for the overnight queue's LinkedIn-URL recovery (2026-07-31).
 * Run: npx tsx scripts/test-salesnav-queue.mts   (from integration/)
 *
 * Drives the REAL queue against a scratch ROS_DATA_DIR with no provider keys, so
 * the search itself finds nobody and every assertion is about ROUTING and the
 * attempt ledger rather than about search results:
 *
 *  - a URL-driven item must reach the LinkedIn branch, not die on the JD bail
 *    ("no job description on the queued search") that every URL item would hit;
 *  - each attempt must be stamped BEFORE the work, because a search killed
 *    mid-pull leaves no other trace;
 *  - an item that has already burned its attempts must stop instead of re-running
 *    a paid search on every tick.
 */
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

process.env.ROS_DATA_DIR = mkdtempSync(join(tmpdir(), "snav-queue-"));
delete process.env.DATABASE_URL;

const { addNightItem, listNightItems, tickNightQueue } = await import("../lib/sourcing/nightQueue.js");

const WS = "ws_test_snav_queue";
const URL = "https://www.linkedin.com/sales/search/people?query=titles%3ACFO";
const CREATED_BY = { userId: "usr_test", name: "Test Recruiter", email: "test@example.com" };

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) failed++;
}

/* 1. A URL-driven item routes to the LinkedIn branch. --------------------- */
const queued = await addNightItem(WS, {
  kind: "search", name: "CFO search", createdBy: CREATED_BY,
  salesNav: { url: URL, expand: true },
});
await tickNightQueue();
await tickNightQueue(); // queued -> search, then the search itself

const after = (await listNightItems(WS)).find((i) => i.id === queued.id)!;
check("the item left the queued stage", after.stage !== "queued", `stage=${after.stage}`);
check("it did NOT die on the JD bail (that bail would hit every URL search)",
  !/no job description/i.test(after.error || ""), `error=${after.error}`);
check("with no keys and no seat it stops honestly, saying nobody was found",
  after.stage !== "error" || /nobody/i.test(after.error || ""), `error=${after.error}`);
check("the attempt was stamped", (after.searchAttempts ?? 0) >= 1, `attempts=${after.searchAttempts}`);

/* 2. An item that already burned its attempts stops instead of re-running.
      (Attempts are stamped before the work precisely so attempts killed
      mid-pull — which leave nothing else behind — still count.) ----------- */
const item2 = await addNightItem(WS, {
  kind: "search", name: "CFO search 2", createdBy: CREATED_BY,
  salesNav: { url: URL, expand: true },
});
// addNightItem starts work immediately (fire-and-forget), and the queue holds a
// one-at-a-time latch: wait that first pass out, or the tick below no-ops.
const settled = await (async () => {
  for (let i = 0; i < 60; i++) {
    const it = (await listNightItems(WS)).find((x) => x.id === item2.id)!;
    if (it.stage !== "queued" && (it.searchAttempts ?? 0) >= 1) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
})();
check("the queue picked the new item up on its own (no tick needed)", settled);
const live2 = (await listNightItems(WS)).find((i) => i.id === item2.id)!;
live2.stage = "search";        // as if a previous tick had started it
live2.searchAttempts = 3;      // and three attempts had already been killed mid-pull
delete live2.error;
await tickNightQueue();

const after2 = (await listNightItems(WS)).find((i) => i.id === item2.id)!;
check("a search that kept getting interrupted stops instead of looping",
  after2.stage === "error", `stage=${after2.stage}`);
check("and says so in recruiter language, with nothing claimed to be saved",
  /restarted mid-search/i.test(after2.error || "") && /run it again/i.test(after2.error || ""),
  `error=${after2.error}`);
check("the counter did not run away", (after2.searchAttempts ?? 0) === 4, `attempts=${after2.searchAttempts}`);

console.log(failed ? `\n${failed} FAILED` : `\nall checks passed`);
process.exit(failed ? 1 : 0);
