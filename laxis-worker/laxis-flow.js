/**
 * RecruiterOS · Laxis worker — the browser flow.
 *
 * Laxis has no API, so this drives the real app.laxis.tech UI with a headless Chromium:
 * log in once (cookies persist), upload the candidate CSV to the "Enrich Prospects"
 * feature, wait for Laxis to finish, then export the enriched CSV and hand the bytes back.
 * RecruiterOS merges those onto its candidate rows.
 *
 * ── VERIFIED FLOW (calibrated against the live site 2026-06-18) ────────────────────
 * LOGIN (email/password is hidden behind two clicks):
 *   /login → "Other ways to sign in" → "Continue with Email" → fill #signin-email +
 *   #signin-password → "Sign In".
 * ENRICH (the upload lives on /prospect, NOT /prospect-search — that one is people-search):
 *   /prospect → "Enrich Prospects" (opens a dialog) → set the CSV on the file input →
 *   "Enrich Contacts". Laxis creates a job row named "CSV Enrich <date>_<filename>" that
 *   goes Processing → Completed (~20s for one contact). We name the file with a unique
 *   token so we can find OUR job row and wait for ITS "Completed".
 * EXPORT:
 *   Click the completed job row (opens /prospect-view/<id>) → "Export" downloads the CSV.
 *   Export columns: First Name, Last Name, Full Name, Email Address, Cellphone, …,
 *   LinkedIn URL, Company Name, … (missing values come back as the literal string "null").
 *
 * If Laxis changes its UI, the selectors + button text below are the only things to touch.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require("playwright");

const CONFIG = {
  baseUrl: process.env.LAXIS_BASE_URL || "https://app.laxis.tech",
  loginPath: process.env.LAXIS_LOGIN_PATH || "/login",
  // The Prospect List page that hosts the "Enrich Prospects" CSV upload + per-job Export.
  prospectPath: process.env.LAXIS_PROSPECT_PATH || "/prospect",

  statePath: process.env.LAXIS_STATE_PATH || "/data/laxis-state.json",
  email: process.env.LAXIS_EMAIL || "",
  password: process.env.LAXIS_PASSWORD || "",
  headed: process.env.LAXIS_HEADED === "1",

  navTimeoutMs: Number(process.env.LAXIS_NAV_TIMEOUT_MS || 60_000),
  enrichTimeoutMs: Number(process.env.LAXIS_ENRICH_TIMEOUT_MS || 18 * 60_000),

  // Button/labels Laxis renders (visible text — resilient to class/id churn).
  text: {
    otherWays: "Other ways to sign in",
    continueWithEmail: "Continue with Email",
    signIn: "Sign In",
    googleMarker: "Continue with Google", // only on the login screen → "not authenticated"
    enrichOpen: "Enrich Prospects",       // opens the upload dialog
    enrichStart: "Enrich Contacts",       // submits the upload
    completed: "Completed",
    export: "Export",
  },
  selectors: {
    loginEmail: "#signin-email",
    loginPassword: "#signin-password",
    fileInput: 'input[type=file]',
  },
};

/* ----------------------------------------------------------------------------- */
/* small helpers                                                                  */
/* ----------------------------------------------------------------------------- */

async function clickText(page, text, timeout = 10_000) {
  const loc = page.getByText(text, { exact: false }).first();
  await loc.waitFor({ state: "visible", timeout });
  await loc.click();
}

async function visible(page, selOrText, { byText = false, timeout = 3000 } = {}) {
  const loc = byText ? page.getByText(selOrText, { exact: false }).first() : page.locator(selOrText).first();
  try { await loc.waitFor({ state: "visible", timeout }); return true; } catch { return false; }
}

/** On the login screen? URL says /login, or the Google button is on screen. */
async function onLoginPage(page) {
  if (/\/login/.test(page.url())) return true;
  return visible(page, CONFIG.text.googleMarker, { byText: true, timeout: 2500 });
}

/* ----------------------------------------------------------------------------- */
/* login + session                                                                */
/* ----------------------------------------------------------------------------- */

async function logIn(page, log) {
  if (!CONFIG.email || !CONFIG.password) {
    throw new Error("laxis_credentials_missing: set LAXIS_EMAIL and LAXIS_PASSWORD");
  }
  log("login: opening login page");
  await page.goto(CONFIG.baseUrl + CONFIG.loginPath, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // Email/password is two clicks deep behind the OAuth options.
  try { await clickText(page, CONFIG.text.otherWays, 15_000); } catch {
    throw new Error(`laxis_login_step_missing: "${CONFIG.text.otherWays}" (CALIBRATE text.otherWays)`);
  }
  await page.waitForTimeout(1500);
  try { await clickText(page, CONFIG.text.continueWithEmail, 10_000); } catch {
    throw new Error(`laxis_login_step_missing: "${CONFIG.text.continueWithEmail}" (CALIBRATE text.continueWithEmail)`);
  }
  await page.waitForTimeout(2500);

  const email = page.locator(CONFIG.selectors.loginEmail).first();
  const password = page.locator(CONFIG.selectors.loginPassword).first();
  if (!(await visible(page, CONFIG.selectors.loginEmail, { timeout: 10_000 }))) {
    throw new Error("laxis_login_form_not_found (CALIBRATE selectors.loginEmail/loginPassword)");
  }
  await email.fill(CONFIG.email);
  await password.fill(CONFIG.password);
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => {}),
    clickText(page, CONFIG.text.signIn, 8000),
  ]);
  await page.waitForTimeout(5000);
  if (await onLoginPage(page)) {
    throw new Error("laxis_login_failed: still on the login screen after submit — check credentials, or a 2FA/captcha challenge");
  }
  log("login: success");
}

async function ensureSession(context, log) {
  const page = await context.newPage();
  page.setDefaultTimeout(CONFIG.navTimeoutMs);
  log("session: opening prospect list");
  await page.goto(CONFIG.baseUrl + CONFIG.prospectPath, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  if (await onLoginPage(page)) {
    log("session: not authenticated — logging in");
    await logIn(page, log);
    await context.storageState({ path: CONFIG.statePath });
    log("session: saved storage state");
  } else {
    log("session: reused existing login");
  }
  return page;
}

/* ----------------------------------------------------------------------------- */
/* enrich + export                                                                */
/* ----------------------------------------------------------------------------- */

async function uploadAndEnrich(page, csvPath, token, log) {
  await page.goto(CONFIG.baseUrl + CONFIG.prospectPath, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  log("upload: opening Enrich Prospects dialog");
  await clickText(page, CONFIG.text.enrichOpen, 15_000);
  await page.waitForTimeout(2000);

  const fileInput = page.locator(CONFIG.selectors.fileInput).first();
  if (!(await visible(page, CONFIG.selectors.fileInput, { timeout: 15_000 }))) {
    throw new Error("laxis_file_input_not_found (CALIBRATE selectors.fileInput)");
  }
  log("upload: setting file " + path.basename(csvPath));
  await fileInput.setInputFiles(csvPath);
  await page.waitForTimeout(1500);

  log("enrich: starting (Enrich Contacts)");
  await clickText(page, CONFIG.text.enrichStart, 10_000);

  // Laxis made a job row named "CSV Enrich <date>_<token>". Wait until OUR row shows
  // "Completed". Scope precisely: find the SMALLEST element whose text contains both our
  // unique token AND a status word — that element is our row (it bundles name + status),
  // so a neighbouring older "Completed" job can't trip a false positive. Then require the
  // row to read "Completed" and NOT "Processing".
  log("enrich: waiting for completion (job token " + token + ")");
  await page.waitForFunction(
    (tk) => {
      const all = Array.from(document.querySelectorAll("*"));
      let bestTxt = null;
      let bestSize = Infinity;
      for (const e of all) {
        const txt = e.textContent || "";
        if (txt.includes(tk) && /(processing|completed|failed|error|in progress)/i.test(txt)) {
          const size = e.querySelectorAll("*").length; // smaller = tighter = our row
          if (size < bestSize) { bestSize = size; bestTxt = txt; }
        }
      }
      if (bestTxt === null) return false;               // status not rendered yet
      if (/processing|in progress/i.test(bestTxt)) return false;
      if (/failed|error/i.test(bestTxt)) throw new Error("laxis_enrich_failed: job reported a failure");
      return /completed/i.test(bestTxt);
    },
    token,
    { timeout: CONFIG.enrichTimeoutMs, polling: 4000 }
  );
  log("enrich: completed");
  await page.waitForTimeout(1500);
}

async function exportEnriched(page, token, outDir, log) {
  log("export: opening the enriched job");
  await clickText(page, token, 15_000); // opens /prospect-view/<id>
  await page.waitForTimeout(3500);

  log("export: downloading CSV");
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: CONFIG.navTimeoutMs }),
    clickText(page, CONFIG.text.export, 12_000),
  ]);
  const dest = path.join(outDir, "laxis-enriched.csv");
  await download.saveAs(dest);
  log("export: saved " + dest);
  return fs.readFileSync(dest, "utf8");
}

/* ----------------------------------------------------------------------------- */
/* public entry points                                                            */
/* ----------------------------------------------------------------------------- */

function launchArgs() {
  return { headless: !CONFIG.headed, args: ["--no-sandbox", "--disable-dev-shm-usage"] };
}

/** Run the full Laxis enrichment for one CSV. Returns the enriched CSV as a string. */
async function enrichCsv(inputCsv, { log = () => {} } = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "laxis-"));
  // Unique, recognizable filename → Laxis names the job after it, so we can find OUR row.
  const token = "rosjob-" + crypto.randomBytes(5).toString("hex");
  const csvPath = path.join(workDir, token + ".csv");
  fs.writeFileSync(csvPath, inputCsv, "utf8");

  const haveState = fs.existsSync(CONFIG.statePath);
  const browser = await chromium.launch(launchArgs());
  try {
    const context = await browser.newContext(
      haveState ? { storageState: CONFIG.statePath, acceptDownloads: true } : { acceptDownloads: true }
    );
    const page = await ensureSession(context, log);
    await uploadAndEnrich(page, csvPath, token, log);
    const enriched = await exportEnriched(page, token, workDir, log);
    await context.storageState({ path: CONFIG.statePath }); // refresh rotated cookies
    return enriched;
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** Log in once and persist the session, without running a job. */
async function warmLogin({ log = () => {} } = {}) {
  const browser = await chromium.launch(launchArgs());
  try {
    const haveState = fs.existsSync(CONFIG.statePath);
    const context = await browser.newContext(haveState ? { storageState: CONFIG.statePath } : {});
    await ensureSession(context, log);
    await context.storageState({ path: CONFIG.statePath });
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Diagnostic: log in, screenshot the prospect list, dump it to LAXIS_PROBE_DIR. */
async function probe({ log = () => {} } = {}) {
  const outDir = process.env.LAXIS_PROBE_DIR || "/data";
  const browser = await chromium.launch(launchArgs());
  try {
    const haveState = fs.existsSync(CONFIG.statePath);
    const context = await browser.newContext(
      haveState ? { storageState: CONFIG.statePath, acceptDownloads: true } : { acceptDownloads: true }
    );
    const page = await ensureSession(context, log);
    await context.storageState({ path: CONFIG.statePath });
    await page.goto(CONFIG.baseUrl + CONFIG.prospectPath, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    await page.screenshot({ path: path.join(outDir, "laxis-prospect.png"), fullPage: true }).catch(() => {});
    log("probe: wrote laxis-prospect.png to " + outDir);
    return { ok: true };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { enrichCsv, warmLogin, probe, CONFIG };
