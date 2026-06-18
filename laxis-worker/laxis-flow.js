/**
 * RecruiterOS · Laxis worker — the browser flow.
 *
 * Laxis has no API, so this drives the real app.laxis.tech UI with a headless
 * Chromium: log in once (cookies persist), upload the CSV that JD Sourcing made to
 * /prospect-search, run the enrichment, then download the enriched CSV and hand the
 * bytes back. The RecruiterOS app merges those bytes onto its candidate rows.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 *  THE CALIBRATION SURFACE
 * ────────────────────────────────────────────────────────────────────────────────
 * Everything Laxis-specific lives in CONFIG below — URLs, selectors, button text,
 * and the CSV column names Laxis imports/exports. When Laxis ships a UI change and a
 * job starts failing, this is the ONLY block you touch. To re-learn the real
 * selectors against the live site, run `npm run codegen` (Playwright opens a browser,
 * you click through the upload → enrich → export flow, and it prints the selectors).
 *
 * Each selector is a list of candidates tried in order, so the flow survives small
 * markup changes (a renamed class still matches by role/text). The values shipped
 * here are EDUCATED GUESSES based on a typical prospect-search UI — they must be
 * confirmed against the live site during calibration. Where a guess is load-bearing
 * it's marked `// CALIBRATE`.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const CONFIG = {
  baseUrl: process.env.LAXIS_BASE_URL || "https://app.laxis.tech",
  prospectSearchPath: process.env.LAXIS_PROSPECT_PATH || "/prospect-search",
  loginPath: process.env.LAXIS_LOGIN_PATH || "/login",

  // Where the persisted browser session (cookies + localStorage) lives. Logging in
  // once writes this; every later job reuses it so we never re-trigger a fresh login.
  statePath: process.env.LAXIS_STATE_PATH || "/data/laxis-state.json",

  // Credentials. Email + password login (confirmed with the user).
  email: process.env.LAXIS_EMAIL || "",
  password: process.env.LAXIS_PASSWORD || "",

  // Run the browser headed for debugging (LAXIS_HEADED=1). Default headless.
  headed: process.env.LAXIS_HEADED === "1",

  // Generous ceilings — enrichment of a big list is slow, and that's fine; the app
  // polls. A whole job is allowed up to LAXIS_JOB_TIMEOUT_MS (default 20 min).
  navTimeoutMs: Number(process.env.LAXIS_NAV_TIMEOUT_MS || 60_000),
  enrichTimeoutMs: Number(process.env.LAXIS_ENRICH_TIMEOUT_MS || 18 * 60_000),

  selectors: {
    // --- Login page --------------------------------------------------------- CALIBRATE
    loginEmail: ['input[type="email"]', 'input[name="email"]', '#email'],
    loginPassword: ['input[type="password"]', 'input[name="password"]', '#password'],
    loginSubmit: ['button[type="submit"]', 'button:has-text("Log in")', 'button:has-text("Sign in")'],

    // A selector that ONLY exists once we're authenticated on prospect-search. Used to
    // decide "are we logged in?" without guessing. CALIBRATE to something real on the page.
    loggedInMarker: ['text=Prospect Search', '[data-testid="prospect-search"]', 'main'],

    // A selector that ONLY appears on the login screen (so we can detect a bounce). CALIBRATE.
    loginMarker: ['input[type="password"]'],

    // --- Import / upload on prospect-search --------------------------------- CALIBRATE
    importOpen: ['button:has-text("Import")', 'button:has-text("Upload")', 'button:has-text("Upload CSV")'],
    fileInput: ['input[type="file"]'],
    importConfirm: ['button:has-text("Import")', 'button:has-text("Upload")', 'button:has-text("Continue")', 'button:has-text("Next")'],

    // --- Run enrichment ----------------------------------------------------- CALIBRATE
    enrichStart: ['button:has-text("Enrich")', 'button:has-text("Find emails")', 'button:has-text("Run")'],
    // Something that appears while enrichment is in flight…
    enrichInProgress: ['text=Enriching', 'text=In progress', '[role="progressbar"]'],
    // …and something that appears when it has finished.
    enrichDone: ['text=Completed', 'text=Done', 'text=Finished'],

    // --- Export the enriched list ------------------------------------------- CALIBRATE
    exportOpen: ['button:has-text("Export")', 'button:has-text("Download")'],
    exportCsv: ['text=CSV', 'button:has-text("Export CSV")', 'text=Export as CSV'],
  },

  // Our CSV already uses Laxis's exact import headers (email, linkedin_url — confirmed
  // from the sample_enrich_template Laxis hands out), so the importer should auto-recognize
  // them with NO mapping step. If Laxis ever shows a column-mapping dropdown, map here
  // (left = our header, right = the Laxis field label). CALIBRATE only if that step appears.
  columnMap: {
    email: "email",
    linkedin_url: "linkedin_url",
  },
};

function firstSelector(page, candidates, { timeout } = {}) {
  // Returns a locator for the first candidate selector that resolves to a visible
  // element, or null. Tries each quickly so a missing optional step doesn't hang.
  return (async () => {
    for (const sel of candidates) {
      const loc = page.locator(sel).first();
      try {
        await loc.waitFor({ state: "visible", timeout: timeout ?? 4_000 });
        return loc;
      } catch {
        /* try next */
      }
    }
    return null;
  })();
}

async function isLoggedIn(page) {
  const marker = await firstSelector(page, CONFIG.selectors.loginMarker, { timeout: 3_000 });
  if (marker) return false; // a password field on screen means we got bounced to login
  const ok = await firstSelector(page, CONFIG.selectors.loggedInMarker, { timeout: 6_000 });
  return Boolean(ok);
}

async function logIn(page, log) {
  if (!CONFIG.email || !CONFIG.password) {
    throw new Error("laxis_credentials_missing: set LAXIS_EMAIL and LAXIS_PASSWORD");
  }
  log("login: navigating to login page");
  await page.goto(CONFIG.baseUrl + CONFIG.loginPath, { waitUntil: "domcontentloaded" });

  const email = await firstSelector(page, CONFIG.selectors.loginEmail, { timeout: 15_000 });
  const password = await firstSelector(page, CONFIG.selectors.loginPassword, { timeout: 15_000 });
  if (!email || !password) throw new Error("laxis_login_form_not_found (CALIBRATE selectors.loginEmail/loginPassword)");

  await email.fill(CONFIG.email);
  await password.fill(CONFIG.password);
  const submit = await firstSelector(page, CONFIG.selectors.loginSubmit, { timeout: 8_000 });
  if (!submit) throw new Error("laxis_login_submit_not_found (CALIBRATE selectors.loginSubmit)");

  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => {}),
    submit.click(),
  ]);
  // Land on prospect-search and confirm we're really in.
  await page.goto(CONFIG.baseUrl + CONFIG.prospectSearchPath, { waitUntil: "domcontentloaded" });
  if (!(await isLoggedIn(page))) {
    throw new Error("laxis_login_failed: still seeing the login screen after submit — check credentials or a 2FA/captcha challenge");
  }
  log("login: success");
}

async function ensureSession(context, log) {
  const page = await context.newPage();
  page.setDefaultTimeout(CONFIG.navTimeoutMs);
  log("session: opening prospect-search");
  await page.goto(CONFIG.baseUrl + CONFIG.prospectSearchPath, { waitUntil: "domcontentloaded" });
  if (!(await isLoggedIn(page))) {
    log("session: not authenticated — logging in");
    await logIn(page, log);
    await context.storageState({ path: CONFIG.statePath });
    log("session: saved storage state");
  } else {
    log("session: reused existing login");
  }
  return page;
}

async function uploadAndEnrich(page, csvPath, log) {
  await page.goto(CONFIG.baseUrl + CONFIG.prospectSearchPath, { waitUntil: "domcontentloaded" });

  // Open the import affordance if there's a button before the file input appears.
  const opener = await firstSelector(page, CONFIG.selectors.importOpen, { timeout: 6_000 });
  if (opener) {
    log("upload: clicking import");
    await opener.click();
  }

  const fileInput = await firstSelector(page, CONFIG.selectors.fileInput, { timeout: 15_000 });
  if (!fileInput) throw new Error("laxis_file_input_not_found (CALIBRATE selectors.fileInput)");
  log("upload: setting file " + path.basename(csvPath));
  await fileInput.setInputFiles(csvPath);

  // Optional column-mapping / confirm step.
  const confirm = await firstSelector(page, CONFIG.selectors.importConfirm, { timeout: 8_000 });
  if (confirm) {
    log("upload: confirming import");
    await confirm.click();
  }

  // Kick off enrichment if it isn't automatic.
  const start = await firstSelector(page, CONFIG.selectors.enrichStart, { timeout: 10_000 });
  if (start) {
    log("enrich: starting");
    await start.click();
  }

  // Wait for completion: poll for a done marker, bounded by enrichTimeoutMs.
  const deadline = Date.now() + CONFIG.enrichTimeoutMs;
  log("enrich: waiting for completion");
  // (Date.now is fine here — this is a live service, not a replayable workflow script.)
  while (Date.now() < deadline) {
    const done = await firstSelector(page, CONFIG.selectors.enrichDone, { timeout: 5_000 });
    if (done) {
      log("enrich: completed");
      return;
    }
    await page.waitForTimeout(5_000);
  }
  throw new Error("laxis_enrich_timeout: enrichment did not finish within the allotted time");
}

async function exportEnriched(page, outDir, log) {
  const opener = await firstSelector(page, CONFIG.selectors.exportOpen, { timeout: 10_000 });
  if (!opener) throw new Error("laxis_export_button_not_found (CALIBRATE selectors.exportOpen)");
  log("export: opening export menu");
  await opener.click();

  const csvChoice = await firstSelector(page, CONFIG.selectors.exportCsv, { timeout: 6_000 });
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: CONFIG.navTimeoutMs }),
    (csvChoice || opener).click(),
  ]);
  const dest = path.join(outDir, "laxis-enriched.csv");
  await download.saveAs(dest);
  log("export: saved " + dest);
  return fs.readFileSync(dest, "utf8");
}

/**
 * Run the full Laxis enrichment for one CSV. Returns the enriched CSV as a string.
 * `log` is an optional progress sink (worker stamps stage lines onto the job).
 */
async function enrichCsv(inputCsv, { log = () => {} } = {}) {
  // Stage the input on disk for the file input, and give downloads a home.
  const workDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "laxis-"));
  const csvPath = path.join(workDir, "input.csv");
  fs.writeFileSync(csvPath, inputCsv, "utf8");

  const haveState = fs.existsSync(CONFIG.statePath);
  const browser = await chromium.launch({
    headless: !CONFIG.headed,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext(
      haveState ? { storageState: CONFIG.statePath, acceptDownloads: true } : { acceptDownloads: true }
    );
    const page = await ensureSession(context, log);
    await uploadAndEnrich(page, csvPath, log);
    const enriched = await exportEnriched(page, workDir, log);
    await context.storageState({ path: CONFIG.statePath }); // refresh any rotated cookies
    return enriched;
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Calibration probe: log in, open prospect-search, and capture the real page so the
 * selectors in CONFIG.selectors can be pinned to what Laxis actually renders. Writes a
 * full-page screenshot + an element inventory (buttons / inputs / file-inputs / links)
 * to LAXIS_PROBE_DIR (default /data, which is on the worker's named volume so it can be
 * pulled back off the server). Returns the inventory. Headless-friendly — no GUI needed.
 */
async function probe({ log = () => {} } = {}) {
  const outDir = process.env.LAXIS_PROBE_DIR || "/data";
  const browser = await chromium.launch({
    headless: !CONFIG.headed,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const haveState = fs.existsSync(CONFIG.statePath);
    const context = await browser.newContext(
      haveState ? { storageState: CONFIG.statePath, acceptDownloads: true } : { acceptDownloads: true }
    );
    const page = await ensureSession(context, log);
    await context.storageState({ path: CONFIG.statePath });
    await page.goto(CONFIG.baseUrl + CONFIG.prospectSearchPath, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000); // let the SPA paint

    await page.screenshot({ path: path.join(outDir, "laxis-prospect-search.png"), fullPage: true }).catch(() => {});
    const inventory = await page.evaluate(() => {
      const txt = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 70);
      const q = (sel) => Array.from(document.querySelectorAll(sel));
      return {
        url: location.href,
        title: document.title,
        buttons: q("button,[role=button]").map((b) => ({ text: txt(b), id: b.id, cls: (b.className || "").toString().slice(0, 60), type: b.getAttribute("type") })).filter((b) => b.text || b.id).slice(0, 100),
        inputs: q("input,textarea").map((i) => ({ type: i.type, name: i.name, id: i.id, placeholder: i.placeholder })).slice(0, 50),
        fileInputs: q('input[type=file]').map((i) => ({ name: i.name, id: i.id, accept: i.accept })),
        links: q("a").map((a) => ({ text: txt(a), href: a.getAttribute("href") })).filter((a) => a.text).slice(0, 80),
      };
    });
    fs.writeFileSync(path.join(outDir, "laxis-inventory.json"), JSON.stringify(inventory, null, 2));
    log("probe: wrote laxis-prospect-search.png + laxis-inventory.json to " + outDir);
    return inventory;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Log in once interactively/headlessly and persist the session, without a job. */
async function warmLogin({ log = () => {} } = {}) {
  const browser = await chromium.launch({
    headless: !CONFIG.headed,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const haveState = fs.existsSync(CONFIG.statePath);
    const context = await browser.newContext(haveState ? { storageState: CONFIG.statePath } : {});
    await ensureSession(context, log);
    await context.storageState({ path: CONFIG.statePath });
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { enrichCsv, warmLogin, probe, CONFIG };
