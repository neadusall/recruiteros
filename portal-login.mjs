#!/usr/bin/env node
/**
 * Mint a browser session for a vendor billing portal.
 *
 *   node portal-login.mjs smartlead
 *
 * Opens a normal, visible browser at the vendor's sign-in page and waits for YOU to log in.
 * Once you are through (including any two-factor step), it saves the resulting session to a
 * file and prints the one command that installs it on the server.
 *
 * WHY IT WORKS THIS WAY. The server pulls invoices with a logged-in headless browser, and it
 * needs a login to do that. Storing the vendor password on the server would mean a password
 * sitting in an env file, readable by anything that can read the environment, and re-typed
 * by a robot on a login form that may add a captcha or a 2FA prompt at any time. So the
 * password never leaves your hands: this script types nothing and reads nothing. It only
 * captures the session the vendor handed YOUR browser after you signed in yourself.
 *
 * WHAT THE FILE IS. A Playwright storage state: cookies and local storage for that one
 * vendor domain. It is a live login to your billing account, so treat it like a password:
 *   - it goes on the server's data volume and nowhere else
 *   - it is never committed, and this script writes it outside the repo by default
 *   - signing out at the vendor, or changing your password there, revokes it immediately
 *
 * WHEN IT LAPSES. Vendors expire sessions on their own schedule, usually weeks to months.
 * The console says so plainly when it happens ("Sign-in needed before it can pull") and the
 * fix is to run this again. Nothing is lost in the meantime: months already downloaded stay
 * on file, and the ones that are not get flagged rather than silently skipped.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";

/* Kept in step with lib/owner/portalPullers.ts. Adding a vendor there means adding it here. */
const PORTALS = {
  smartlead: {
    vendor: "Smartlead",
    loginUrl: "https://app.smartlead.ai/login",
    billingUrl: "https://app.smartlead.ai/app/settings/billing",
    /* Reaching this without being bounced to /login is what proves the session works. */
    proof: /billing|invoice/i,
  },
};

const REMOTE = process.env.ROS_HOST || "ros";
const REMOTE_DIR = "/data/portal-sessions";

function usage() {
  console.log(`
mint a vendor billing session

  node portal-login.mjs <vendor> [--out <file>] [--keep-open]

vendors: ${Object.keys(PORTALS).join(", ")}

The browser opens visible. Sign in as you normally would, get yourself to the billing page,
then come back here and press Enter.
`.trim());
}

async function main() {
  const args = process.argv.slice(2);
  const key = (args.find((a) => !a.startsWith("--")) || "").toLowerCase();
  const portal = PORTALS[key];
  if (!portal) {
    usage();
    process.exit(key ? 1 : 0);
  }

  const outFlag = args.indexOf("--out");
  const out = resolve(
    outFlag >= 0 && args[outFlag + 1]
      ? args[outFlag + 1]
      : join(homedir(), ".ros-portal-sessions", `${key}.json`),
  );

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error("Playwright is not installed here. Run:  npm i -D playwright && npx playwright install chromium");
    process.exit(1);
  }

  console.log(`\nOpening ${portal.loginUrl}`);
  console.log("Sign in in the window that just opened. Take as long as you need.\n");

  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 }, acceptDownloads: true });
  const page = await ctx.newPage();

  try {
    await page.goto(portal.loginUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("Press Enter once you are signed in and looking at your account… ");
    rl.close();

    /* Do not take the user's word for it: drive to the billing page and confirm we are not
       looking at a login wall. A session saved from a half-finished login fails silently on
       the server three days later, which is exactly the failure mode worth spending ten
       seconds to prevent. */
    console.log("\nChecking the session actually reaches the billing page…");
    await page.goto(portal.billingUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(3000);

    const url = page.url();
    const bodyText = ((await page.textContent("body").catch(() => "")) || "");
    const bounced = /\/login|\/signin/i.test(url) || (await page.locator('input[type="password"]').count()) > 0;

    if (bounced) {
      console.error(`\nStill at a sign-in page (${url}). Nothing was saved. Run it again and finish signing in first.`);
      process.exitCode = 1;
      return;
    }
    if (portal.proof && !portal.proof.test(bodyText)) {
      console.warn(`\nReached ${url} but the page does not look like a billing page. Saving anyway; if the pull fails, run this again from the billing page itself.`);
    }

    const state = await ctx.storageState();
    await mkdir(dirname(out), { recursive: true });
    /* mintedAt rides along so the console can say how old a session is. Playwright ignores
       unknown keys when it loads the state back. */
    await writeFile(out, JSON.stringify({ ...state, mintedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });

    const cookies = (state.cookies || []).length;
    console.log(`\nSaved ${cookies} cookie(s) to ${out}`);
    console.log("\nInstall it on the server:\n");
    console.log(`  ssh ${REMOTE} "mkdir -p ${REMOTE_DIR}"`);
    console.log(`  scp "${out}" ${REMOTE}:${REMOTE_DIR}/${key}.json`);
    console.log(`  ssh ${REMOTE} "chmod 600 ${REMOTE_DIR}/${key}.json"`);
    console.log(`\nThen open the Spend master and press "Try again now" on the ${portal.vendor} row.`);
    console.log("\nThis file is a live login to your billing account. Do not commit it or copy it anywhere else.\n");

    if (!args.includes("--keep-open")) return;
    console.log("Leaving the browser open (--keep-open). Close it yourself when done.");
    await new Promise(() => {});
  } finally {
    if (!args.includes("--keep-open")) {
      await ctx.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }
}

main().catch((e) => {
  console.error(`\nFailed: ${e?.message || e}`);
  process.exit(1);
});
