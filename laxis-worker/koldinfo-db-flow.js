/**
 * RecruiterOS · enrichment worker · KoldInfo DATABASE lookup flow (name + city/state).
 *
 * The sibling koldinfo-flow.js drives ONE KoldInfo door: /protected/enrichment, which
 * matches a person by their LinkedIn URL. That leaves every sourced candidate WITHOUT a
 * LinkedIn URL un-enrichable. This flow drives the OTHER doors — the searchable
 * databases behind the left nav — so we can enrich by name + city/state with no
 * LinkedIn URL at all:
 *
 *   People DB        /protected/pdl   129.5M rows · name, email, phone_number, address
 *   Business Email DB /protected/abo   57.4M rows · person_name, person_email,
 *                                       person_sanitized_phone (E.164), Company Name,
 *                                       person_title, person_seniority, city/state,
 *                                       person_email_status_cd (Verified/Unavailable)
 *
 * Each DB has a Filters rule-builder (Column + Condition[Contains|Equals|Is Empty|
 * Is Not Empty] + a Search box; rules joined AND/OR). Filter state is CLIENT-side (not
 * in the URL) and PERSISTS across navigations, so we clear it before every candidate.
 * Reading the on-screen grid returns unmasked emails+phones and appears free — this flow
 * NEVER clicks Export (that is the credit sink). Calibrated against the live site
 * 2026-07-16 (creds on the box: KOLDINFO_EMAIL / KOLDINFO_PASSWORD).
 *
 * Contract mirrors laxis-flow / koldinfo-flow: runJob(job, {log,setPhase}) -> CSV string.
 * Input CSV headers (from buildKoldInfoDbCsv): ros_id, full_name, company, title, city, state.
 * Output CSV headers: ros_id, person_email, person_sanitized_phone, person_email_status_cd,
 *   person_title, person_company, person_seniority, source_db — the first four are what
 *   the app's format-agnostic parseKoldInfoCsv already re-links and merges.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

const CONFIG = {
  baseUrl: process.env.KOLDINFO_BASE_URL || "https://app.koldinfo.com",
  loginPath: process.env.KOLDINFO_LOGIN_PATH || "/sign-in",
  peoplePath: process.env.KOLDINFO_PEOPLE_PATH || "/protected/pdl",
  bizEmailPath: process.env.KOLDINFO_BIZEMAIL_PATH || "/protected/abo",
  statePath: process.env.KOLDINFO_STATE_PATH || "/data/koldinfo-state.json",
  email: process.env.KOLDINFO_EMAIL || "",
  password: process.env.KOLDINFO_PASSWORD || "",
  headed: process.env.KOLDINFO_HEADED === "1",
  navTimeoutMs: Number(process.env.KOLDINFO_NAV_TIMEOUT_MS || 60_000),
  // Per-candidate query budget; a run of N rows takes ~N * a few seconds (single browser).
  perRowTimeoutMs: Number(process.env.KOLDINFO_DB_ROW_TIMEOUT_MS || 45_000),
  // Batched lookups: how many candidate names ride one filter sweep (chips OR within a
  // rule), the wall-clock budget for one sweep, and how many batches one browser serves
  // before a preventive relaunch (the KoldInfo SPA leaks across many navigations; a
  // browser that dies mid-run used to silently zero the whole job).
  batchSize: Number(process.env.KOLDINFO_DB_BATCH || 15),
  batchTimeoutMs: Number(process.env.KOLDINFO_DB_BATCH_TIMEOUT_MS || 240_000),
  batchesPerBrowser: Number(process.env.KOLDINFO_DB_BATCHES_PER_BROWSER || 8),
};

/* ----------------------------------------------------------------------------- */
/* login/session (shared shape with koldinfo-flow.js)                             */
/* ----------------------------------------------------------------------------- */

async function onLoginPage(page) {
  if (/sign-?in|log-?in/i.test(page.url())) return true;
  try { await page.locator("input[type=password]").first().waitFor({ state: "visible", timeout: 2000 }); return true; }
  catch { return false; }
}
async function waitForLeaveLogin(page, ms) {
  try {
    await page.waitForFunction(() => {
      const pw = document.querySelector("input[type=password]");
      return !(pw && pw.offsetParent !== null) && !/sign-?in|log-?in/i.test(location.pathname);
    }, { timeout: ms, polling: 500 });
    return true;
  } catch { return false; }
}
async function logIn(page, log) {
  if (!CONFIG.email || !CONFIG.password) throw new Error("koldinfo_credentials_missing: set KOLDINFO_EMAIL and KOLDINFO_PASSWORD");
  log("login: opening sign-in");
  await page.goto(CONFIG.baseUrl + CONFIG.loginPath, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const email = page.locator("input[type=email], input[autocomplete=email], input[name=email], #email").first();
  const password = page.locator("input[type=password]").first();
  if (!(await email.count()) || !(await password.count())) throw new Error("koldinfo_login_form_not_found");
  await email.fill(CONFIG.email);
  await password.fill(CONFIG.password);
  await password.press("Enter").catch(() => {});
  if (!(await waitForLeaveLogin(page, 12_000))) {
    const btn = page.locator("button[type=submit]").first();
    if (await btn.count()) await btn.click().catch(() => {});
    if (!(await waitForLeaveLogin(page, 12_000))) {
      await page.screenshot({ path: "/data/koldinfo-db-login-fail.png", fullPage: true }).catch(() => {});
      throw new Error("koldinfo_login_failed: still on sign-in after submit (see /data/koldinfo-db-login-fail.png)");
    }
  }
  log("login: success");
}
async function ensureSession(context, log) {
  const page = await context.newPage();
  page.setDefaultTimeout(CONFIG.navTimeoutMs);
  await page.goto(CONFIG.baseUrl + CONFIG.peoplePath, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  if (await onLoginPage(page)) { log("session: logging in"); await logIn(page, log); await context.storageState({ path: CONFIG.statePath }); }
  else log("session: reused existing login");
  return page;
}

/* ----------------------------------------------------------------------------- */
/* small text/normalize helpers                                                   */
/* ----------------------------------------------------------------------------- */

function norm(s) { return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
/** Parse a cell that may be a JSON-ish array string (["a","b"]) or a plain value → array. */
function cellList(v) {
  const s = (v || "").trim();
  if (!s) return [];
  if (s[0] === "[") { try { const a = JSON.parse(s.replace(/'/g, '"')); return Array.isArray(a) ? a.map(String) : [String(a)]; } catch { /* fall through */ } }
  return [s];
}
const RE_EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;
function firstEmail(v) { for (const e of cellList(v)) { const t = e.trim(); if (RE_EMAIL.test(t)) return t.toLowerCase(); } return ""; }
/** First phone from a cell, digits kept; prefer a US-looking 10/11-digit or +country form. */
function firstPhone(v) {
  for (const p of cellList(v)) {
    const d = (p || "").replace(/[^\d+]/g, "");
    if (d.replace(/\D/g, "").length >= 10) return d;
  }
  return "";
}
function csvCell(v) { const s = (v == null ? "" : String(v)).replace(/\r?\n/g, " ").trim(); return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

/* ----------------------------------------------------------------------------- */
/* filter modal driving (calibrated 2026-07-16)                                   */
/* ----------------------------------------------------------------------------- */

/** Open Filters, remove any leftover rules, and add exactly `n` fresh empty rules. */
async function openAndResetFilters(page, n, log) {
  await page.getByRole("button", { name: /^filters$/i }).first().click({ timeout: 8000 });
  await page.waitForTimeout(800);
  // Clear whatever rules persisted from the previous candidate.
  let guard = 0;
  while (guard++ < 10) {
    const rm = page.getByRole("button", { name: /remove rule/i });
    if (!(await rm.count())) break;
    await rm.first().click().catch(() => {});
    await page.waitForTimeout(250);
  }
  // Add the rules we need.
  for (let i = 0; i < n; i++) {
    const need = i + 1;
    let cols = await page.locator("input[placeholder='Select column...']").count();
    if (cols < need) {
      const add = page.getByRole("button", { name: /\+\s*add rule/i }).first();
      await add.click().catch(() => {});
      await page.waitForTimeout(350);
    }
  }
}

/**
 * Close any open autocomplete popover by clicking the modal's own "Filter" title (a
 * neutral spot INSIDE the dialog — same trick applyFilters uses). The search box's
 * suggestion list stays open after Enter and its overlay intercepts clicks on the
 * NEXT rule's inputs, which is exactly how the multi-rule discovery sweep got stuck.
 */
async function dismissOverlays(page) {
  await page.getByText(/^Filter$/).first().click({ timeout: 1500 }).catch(() => {});
  await page.waitForTimeout(200);
}

/** Set rule #i (0-based) to `column <condition> value`, joined by `joiner` (rules > 0). */
async function setRule(page, i, column, condition, value, joiner) {
  if (i > 0 && joiner) {
    const joinSel = page.locator("select").filter({ has: page.locator("option", { hasText: /^AND$/ }) });
    if (await joinSel.count() > i - 1) await joinSel.nth(i - 1).selectOption({ label: joiner }).catch(() => {});
  }
  const col = page.locator("input[placeholder='Select column...']").nth(i);
  await col.click();
  await col.fill("");
  await col.type(column, { delay: 30 });
  await page.waitForTimeout(600);
  const opt = page.locator("[role=option], li").filter({ hasText: new RegExp("^\\s*" + column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$", "i") }).first();
  if (await opt.count()) await opt.click().catch(() => {}); else await col.press("Enter").catch(() => {});
  await page.waitForTimeout(300);
  const condSel = page.locator("select").filter({ has: page.locator("option", { hasText: /^Contains$/ }) });
  if (await condSel.count() > i) await condSel.nth(i).selectOption({ label: condition }).catch(() => {});
  const search = page.locator("input[placeholder='Search (Enter to add new)']").nth(i);
  await search.click();
  await search.type(value, { delay: 30 });
  await search.press("Enter");
  await page.waitForTimeout(300);
  await dismissOverlays(page); // suggestion list must not block the next rule's inputs
}

async function applyFilters(page, log) {
  // Close any open column-autocomplete listbox by clicking the modal's own title
  // (a neutral spot INSIDE the dialog, so we don't hit a backdrop that would close it).
  await page.getByText(/^Filter$/).first().click({ timeout: 1500 }).catch(() => {});
  await page.waitForTimeout(200);
  const apply = page.getByRole("button", { name: /^apply$/i }).first();
  try {
    await apply.waitFor({ state: "visible", timeout: 8000 });
  } catch (e) {
    if (log) {
      await page.screenshot({ path: "/data/koldinfo-db-apply-fail.png", fullPage: true }).catch(() => {});
      const btns = await page.locator("button:visible").allTextContents().catch(() => []);
      log("apply: button not found; visible buttons=[" + btns.join(" | ").slice(0, 300) + "] (screenshot saved)");
    }
    throw e;
  }
  await apply.click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(2500);
}

/** Scrape the visible grid as {heads, rows[]} using the header cells as keys. */
async function readGrid(page, maxRows) {
  const cap = Number(maxRows) || 25;
  return page.evaluate((limit) => {
    const tbl = document.querySelector("table");
    if (!tbl) return { heads: [], rows: [] };
    const heads = Array.from(tbl.querySelectorAll("thead th, tr:first-child th, tr:first-child td")).map((h) => (h.textContent || "").trim());
    const rows = [];
    tbl.querySelectorAll("tbody tr").forEach((tr) => {
      const cells = Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent || "").trim());
      if (!cells.length) return;
      const o = {}; cells.forEach((c, i) => { o[heads[i] || ("c" + i)] = c; }); rows.push(o);
    });
    return { heads, rows: rows.slice(0, limit) };
  }, cap);
}

/** Like setRule, but adds SEVERAL value chips to one rule (chips OR within the rule). */
async function setRuleChips(page, i, column, condition, values, joiner) {
  await setRule(page, i, column, condition, values[0], joiner);
  const search = page.locator("input[placeholder='Search (Enter to add new)']").nth(i);
  for (let v = 1; v < values.length; v++) {
    await search.click();
    await search.type(values[v], { delay: 30 });
    await search.press("Enter");
    await page.waitForTimeout(250);
  }
  await dismissOverlays(page); // suggestion list must not block the next rule's inputs
}

/**
 * Advance the grid one page. Pagination controls vary, so this probes the common
 * shapes (a "Next" button, an aria-labeled next-page chevron) and reports whether it
 * actually moved. Defensive: any miss returns false and the caller just stops paging.
 */
async function nextGridPage(page) {
  const candidates = [
    page.getByRole("button", { name: /^next$/i }),
    page.getByRole("button", { name: /next page/i }),
    page.locator("button[aria-label*='next' i]"),
    page.locator("a[aria-label*='next' i]"),
  ];
  for (const c of candidates) {
    const btn = c.first();
    if (!(await btn.count().catch(() => 0))) continue;
    const disabled = await btn.isDisabled().catch(() => false);
    const aria = await btn.getAttribute("aria-disabled").catch(() => null);
    if (disabled || aria === "true") return false;
    await btn.click().catch(() => {});
    await page.waitForTimeout(1800);
    return true;
  }
  return false;
}

/* ----------------------------------------------------------------------------- */
/* name hygiene - LinkedIn names carry credentials the DBs never store            */
/* ----------------------------------------------------------------------------- */

// Credential/suffix tokens that follow a comma or ride the end of a LinkedIn name
// ("Theodore Bender PhD, MBA", "Kelly Asato, LCSW"). The DBs store plain names, so a
// query keyed on the raw string matches nothing - the single biggest silent miss.
const CRED_TOKENS = new Set([
  "phd", "md", "do", "mba", "jd", "esq", "cpa", "cfa", "cma", "cfe", "cia", "cisa",
  "rn", "bsn", "msn", "dnp", "np", "pa-c", "lcsw", "licsw", "lmsw", "lmhc", "lpc",
  "lmft", "bcba", "laba", "ot", "pt", "dpt", "ccc-slp", "cebs", "phr", "sphr",
  "shrm-cp", "shrm-scp", "pmp", "crcr", "chc", "cphq", "fache", "cpc", "cscp",
  "cpsm", "csm", "pe", "lssbb", "lssgb", "ms", "ma", "med", "mha", "mph", "msw",
  "bs", "ba", "jr", "sr", "ii", "iii", "iv",
]);

/** "Robyn Manley Lees, M.Ed., BCBA, LABA" -> "Robyn Manley Lees". */
function cleanPersonName(raw) {
  let s = String(raw || "").trim().replace(/["“”]/g, "");
  s = s.split(/[,(]/, 1)[0].trim(); // everything after a comma/paren is credentials/aka
  const parts = s.split(/\s+/).filter((w) => !CRED_TOKENS.has(w.toLowerCase().replace(/\./g, "")));
  return parts.join(" ").trim();
}

/** A name we can actually identify in a DB: at least first + last, last not an initial
 *  ("Muhammad S." can never be matched safely - skip it instead of burning a query). */
function usableName(name) {
  const parts = (name || "").split(/\s+/).filter(Boolean);
  if (parts.length < 2) return false;
  return parts[parts.length - 1].replace(/\./g, "").length >= 2;
}

// State corroboration must be abbreviation-aware: the DBs mix "NJ" and "New Jersey",
// and a plain substring check matches neither from the other (the same trap the
// discovery sweep's geoChips already works around).
const US_STATES = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca", colorado: "co",
  connecticut: "ct", delaware: "de", florida: "fl", georgia: "ga", hawaii: "hi", idaho: "id",
  illinois: "il", indiana: "in", iowa: "ia", kansas: "ks", kentucky: "ky", louisiana: "la",
  maine: "me", maryland: "md", massachusetts: "ma", michigan: "mi", minnesota: "mn",
  mississippi: "ms", missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv",
  "new hampshire": "nh", "new jersey": "nj", "new mexico": "nm", "new york": "ny",
  "north carolina": "nc", "north dakota": "nd", ohio: "oh", oklahoma: "ok", oregon: "or",
  pennsylvania: "pa", "rhode island": "ri", "south carolina": "sc", "south dakota": "sd",
  tennessee: "tn", texas: "tx", utah: "ut", vermont: "vt", virginia: "va", washington: "wa",
  "west virginia": "wv", wisconsin: "wi", wyoming: "wy", "district of columbia": "dc",
};
const US_STATE_CODES = new Set(Object.values(US_STATES));
/** "New Jersey" / "NJ" / "nj." -> "nj"; anything unrecognized -> "". */
function stateCode(s) {
  const n = norm(s);
  if (!n) return "";
  if (US_STATES[n]) return US_STATES[n];
  if (n.length === 2 && US_STATE_CODES.has(n)) return n;
  return "";
}
/** True when `stated` (a state cell or an address blob) agrees with the wanted state. */
function stateAgrees(wantStateNorm, wantCode, stated) {
  if (!wantStateNorm || !stated) return false;
  if (stated.includes(wantStateNorm) || wantStateNorm.includes(stated)) return true;
  if (!wantCode) return false;
  if (stateCode(stated) === wantCode) return true;
  return new RegExp("\\b" + wantCode + "\\b").test(stated); // "..., nj 07731" inside an address
}

/* ----------------------------------------------------------------------------- */
/* batched lookups - one filter sweep answers a whole group of candidates         */
/* ----------------------------------------------------------------------------- */

/**
 * Collect grid rows for a batch: apply the given single chips-rule, then page through
 * the grid until we have `maxPages` pages or the pager stops advancing.
 */
async function sweepGrid(page, url, column, condition, chips, maxPages, log) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await openAndResetFilters(page, 1, log);
  await setRuleChips(page, 0, column, condition, chips, undefined);
  await applyFilters(page, log);
  const rows = [];
  let lastSig = "";
  for (let p = 0; p < maxPages; p++) {
    const { rows: got } = await readGrid(page, 100);
    if (!got.length) break;
    const sig = JSON.stringify(got[0]);
    if (p > 0 && sig === lastSig) break; // pager didn't actually advance
    lastSig = sig;
    rows.push(...got);
    if (got.length < 20) break; // short page = last page; don't probe the pager for nothing
    if (!(await nextGridPage(page))) break;
  }
  return rows;
}

/**
 * ONE Business Email DB sweep for a whole batch (person_name Contains [name chips,
 * OR'd]), then per-candidate exact-name matching + the same corroboration rules the
 * per-candidate lookup used. Fills cand._hit in place for every candidate it answers.
 */
async function batchBizEmailDb(page, batch, log) {
  const chips = batch.map((c) => c.cleanName);
  const rows = await sweepGrid(page, CONFIG.baseUrl + CONFIG.bizEmailPath, "person_name", "Contains", chips, 6, log);
  for (const cand of batch) {
    if (cand._hit && cand._hit.email && cand._hit.phone) continue;
    const wantName = norm(cand.cleanName);
    const wantCity = norm(cand.city);
    const wantState = norm(cand.state);
    const wantCode = stateCode(cand.state);
    const wantCompany = norm(cand.company);
    const exact = rows.filter((r) => norm(cleanPersonName(r.person_name)) === wantName);
    const corroborated = exact.filter((r) => {
      const city = norm(r.person_location_city);
      const state = norm(r.person_location_state);
      const company = norm(r["Company Name"]);
      if (wantCity && city && city.includes(wantCity)) return true;
      if (state && stateAgrees(wantState, wantCode, state)) return true;
      if (wantCompany && company && (company.includes(wantCompany) || wantCompany.includes(company))) return true;
      return false;
    });
    let pool = corroborated;
    if (!pool.length && !wantCity && !wantState && !wantCompany && exact.length === 1) pool = exact;
    if (!pool.length) continue;
    pool.sort((a, b) => (/(verified)/i.test(b.person_email_status_cd) ? 1 : 0) - (/(verified)/i.test(a.person_email_status_cd) ? 1 : 0));
    const p = pool[0];
    const hit = cand._hit || {};
    const email = RE_EMAIL.test((p.person_email || "").trim()) ? p.person_email.trim().toLowerCase() : "";
    if (!hit.email && email) { hit.email = email; hit.status = p.person_email_status_cd || ""; hit.source = "biz_email_db"; }
    if (!hit.phone) hit.phone = firstPhone(p.person_sanitized_phone || p.person_phone);
    if (!hit.title) hit.title = p.person_title || "";
    if (!hit.company) hit.company = p["Company Name"] || "";
    if (!hit.seniority) hit.seniority = p.person_seniority || "";
    if (!hit.source) hit.source = "biz_email_db";
    cand._hit = hit;
  }
}

/**
 * ONE People DB sweep for the batch's still-unanswered candidates (name Equals [chips];
 * People DB stores names lowercase). Location corroboration happens client-side against
 * the address column, mirroring the per-candidate rules.
 */
async function batchPeopleDb(page, batch, log) {
  const open = batch.filter((c) => !c._hit || !c._hit.email || !c._hit.phone);
  if (!open.length) return;
  const chips = open.map((c) => c.cleanName.toLowerCase());
  const rows = await sweepGrid(page, CONFIG.baseUrl + CONFIG.peoplePath, "name", "Equals", chips, 6, log);
  for (const cand of open) {
    const wantName = norm(cand.cleanName);
    const wantCity = norm(cand.city);
    const wantState = norm(cand.state);
    const wantCode = stateCode(cand.state);
    const matches = rows.filter((r) => norm(r.name) === wantName);
    const pick = matches.find((r) => {
      if (!wantCity && !wantState) return matches.length === 1; // no location -> only trust a unique hit
      const addr = norm(r.address);
      return (wantCity && addr.includes(wantCity)) || stateAgrees(wantState, wantCode, addr);
    });
    if (!pick) continue;
    const hit = cand._hit || {};
    if (!hit.email) { const e = firstEmail(pick.email); if (e) { hit.email = e; if (!hit.source) hit.source = "people_db"; } }
    if (!hit.phone) { const ph = firstPhone(pick.phone_number); if (ph) { hit.phone = ph; if (!hit.source) hit.source = "people_db"; } }
    cand._hit = hit;
  }
}

/** True when an error means the browser/page under us is gone (crash, OOM, closed). */
function browserGone(err) {
  return /has been closed|browser has been disconnected|target crashed|browser closed/i.test(String((err && err.message) || err));
}

/* ----------------------------------------------------------------------------- */
/* per-candidate lookups                                                          */
/* ----------------------------------------------------------------------------- */

/**
 * People DB: filter name Equals "<lower full name>" (+ address Contains city when known).
 * People DB stores name lowercase, so we lowercase. Returns {email, phone} or {} .
 */
async function lookupPeopleDb(page, cand, log) {
  await page.goto(CONFIG.baseUrl + CONFIG.peoplePath, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const wantCity = (cand.city || "").trim();
  const rules = [{ column: "name", condition: "Equals", value: cand.fullName.toLowerCase() }];
  if (wantCity) rules.push({ column: "address", condition: "Contains", value: wantCity.toLowerCase(), joiner: "AND" });
  await openAndResetFilters(page, rules.length, log);
  for (let i = 0; i < rules.length; i++) await setRule(page, i, rules[i].column, rules[i].condition, rules[i].value, rules[i].joiner);
  await applyFilters(page, log);
  const { rows } = await readGrid(page, 50);
  const wantName = norm(cand.fullName);
  const wantState = norm(cand.state);
  const matches = rows.filter((r) => norm(r.name) === wantName);
  // Corroborate location when we have one AND we did not already constrain by city.
  const pick = matches.find((r) => {
    if (!wantCity && !wantState) return matches.length === 1; // no location → only trust a unique hit
    const addr = norm(r.address);
    return (wantCity && addr.includes(norm(wantCity))) || stateAgrees(wantState, stateCode(cand.state), addr) || Boolean(wantCity); // city already filtered
  }) || (matches.length === 1 && (wantCity || wantState) ? matches[0] : undefined);
  if (!pick) return {};
  return { email: firstEmail(pick.email), phone: firstPhone(pick.phone_number), source: "people_db" };
}

/**
 * Business Email DB: filter person_name Contains "<name>" (casing varies), verify exact
 * name client-side, corroborate by city/state or company, prefer Verified email. Returns
 * {email, phone, status, title, company, seniority} or {}.
 */
async function lookupBizEmailDb(page, cand, log) {
  await page.goto(CONFIG.baseUrl + CONFIG.bizEmailPath, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await openAndResetFilters(page, 1, log);
  await setRule(page, 0, "person_name", "Contains", cand.fullName, undefined);
  await applyFilters(page, log);
  const { rows } = await readGrid(page, 50);
  const wantName = norm(cand.fullName);
  const wantCity = norm(cand.city);
  const wantState = norm(cand.state);
  const wantCompany = norm(cand.company);
  const exact = rows.filter((r) => norm(r.person_name) === wantName);
  const corroborated = exact.filter((r) => {
    const city = norm(r.person_location_city);
    const state = norm(r.person_location_state);
    const company = norm(r["Company Name"]);
    if (wantCity && city && city.includes(wantCity)) return true;
    if (state && stateAgrees(wantState, stateCode(cand.state), state)) return true;
    if (wantCompany && company && (company.includes(wantCompany) || wantCompany.includes(company))) return true;
    return false;
  });
  // Choose from corroborated first; if we have NO signals to corroborate against, only a
  // single exact-name hit is trusted (avoids grabbing a stranger who shares a common name).
  let pool = corroborated;
  if (!pool.length && !wantCity && !wantState && !wantCompany && exact.length === 1) pool = exact;
  if (!pool.length) return {};
  pool.sort((a, b) => (/(verified)/i.test(b.person_email_status_cd) ? 1 : 0) - (/(verified)/i.test(a.person_email_status_cd) ? 1 : 0));
  const p = pool[0];
  return {
    email: RE_EMAIL.test((p.person_email || "").trim()) ? p.person_email.trim().toLowerCase() : "",
    phone: firstPhone(p.person_sanitized_phone || p.person_phone),
    status: p.person_email_status_cd || "",
    title: p.person_title || "",
    company: p["Company Name"] || "",
    seniority: p.person_seniority || "",
    source: "biz_email_db",
  };
}

/* ----------------------------------------------------------------------------- */
/* CSV in/out                                                                      */
/* ----------------------------------------------------------------------------- */

function parseInputCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase().trim());
  const idx = (name) => header.indexOf(name);
  const iId = idx("ros_id"), iName = idx("full_name"), iCo = idx("company"), iTitle = idx("title"), iCity = idx("city"), iState = idx("state");
  const out = [];
  for (let r = 1; r < lines.length; r++) {
    const c = splitCsvLine(lines[r]);
    const fullName = (iName >= 0 ? c[iName] : "").trim();
    if (!fullName) continue;
    out.push({
      rosId: (iId >= 0 ? c[iId] : "").trim(),
      fullName,
      company: (iCo >= 0 ? c[iCo] : "").trim(),
      title: (iTitle >= 0 ? c[iTitle] : "").trim(),
      city: (iCity >= 0 ? c[iCity] : "").trim(),
      state: (iState >= 0 ? c[iState] : "").trim(),
    });
  }
  return out;
}
function splitCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else { if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch; }
  }
  out.push(cur); return out;
}
const OUT_HEADER = ["ros_id", "person_email", "person_sanitized_phone", "person_email_status_cd", "person_title", "person_company", "person_seniority", "source_db"];
function outRow(rosId, hit) {
  return [rosId, hit.email || "", hit.phone || "", hit.status || "", hit.title || "", hit.company || "", hit.seniority || "", hit.source || ""].map(csvCell).join(",");
}

/* ----------------------------------------------------------------------------- */
/* public entry points                                                            */
/* ----------------------------------------------------------------------------- */

function launchArgs() { return { headless: !CONFIG.headed, args: ["--no-sandbox", "--disable-dev-shm-usage"] }; }

/**
 * Run a KoldInfo DB-lookup job - BATCHED: candidates ride the filter rule as OR'd name
 * chips, ~batchSize per sweep, one Business Email DB sweep + one People DB sweep per
 * batch (2 queries per ~15 people instead of 2 per person; an 800-row job drops from
 * hours to tens of minutes). Grid reads only - zero credits.
 *
 * Resilience (an early browser death used to fail 800 rows in a burst yet finish as
 * "done, 0 enriched"):
 *  - a dead browser/page ABORTS the run with a retryable error (the server requeues it)
 *    instead of burning the remaining batches;
 *  - progress checkpoints onto the job after every batch (persisted by the server's
 *    store), so a retry RESUMES at the first unprocessed batch;
 *  - the browser is relaunched every `batchesPerBrowser` batches to pre-empt SPA leaks.
 */
async function runJob(job, { log = () => {}, setPhase = () => {} } = {}) {
  const inputCsv = job.csv;
  if (typeof inputCsv !== "string" || !inputCsv) throw new Error("koldinfo_no_input_csv");
  const all = parseInputCsv(inputCsv);
  for (const c of all) c.cleanName = cleanPersonName(c.fullName);
  const cands = all.filter((c) => usableName(c.cleanName));
  const skippedNames = all.length - cands.length;
  log("db-lookup: " + all.length + " candidate(s), " + cands.length + " identifiable" +
    (skippedNames ? " (" + skippedNames + " skipped: name too truncated to match safely)" : ""));
  if (!cands.length) return OUT_HEADER.join(",") + "\n";

  const size = Math.max(1, CONFIG.batchSize);
  const batches = [];
  for (let i = 0; i < cands.length; i += size) batches.push(cands.slice(i, i + size));

  // Resume from the checkpoint a previous attempt left on the job (the server persists
  // job.checkpoint through its store; a fresh job starts clean).
  const ck = job.checkpoint && job.checkpoint.batchSize === size ? job.checkpoint : null;
  const outLines = ck && Array.isArray(ck.outLines) ? ck.outLines.slice() : [OUT_HEADER.join(",")];
  let firstBatch = ck ? Math.min(ck.doneBatches, batches.length) : 0;
  let emails = ck ? ck.emails || 0 : 0, phones = ck ? ck.phones || 0 : 0, hitRows = ck ? ck.hitRows || 0 : 0;
  if (firstBatch) log("db-lookup: resuming at batch " + (firstBatch + 1) + "/" + batches.length + " (checkpoint)");

  let browser = null, page = null, batchesOnBrowser = 0;
  async function freshBrowser() {
    if (browser) await browser.close().catch(() => {});
    browser = await chromium.launch(launchArgs());
    const haveState = fs.existsSync(CONFIG.statePath);
    const context = await browser.newContext(haveState ? { storageState: CONFIG.statePath } : {});
    page = await ensureSession(context, log);
    batchesOnBrowser = 0;
  }

  try {
    await freshBrowser();
    await setPhase("processing");

    for (let b = firstBatch; b < batches.length; b++) {
      const batch = batches[b];
      if (batchesOnBrowser >= CONFIG.batchesPerBrowser) { log("db-lookup: preventive browser relaunch"); await freshBrowser(); }
      let batchErr = null;
      try {
        await Promise.race([
          (async () => { await batchBizEmailDb(page, batch, log); await batchPeopleDb(page, batch, log); })(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("koldinfo_batch_timeout")), CONFIG.batchTimeoutMs)),
        ]);
      } catch (e) { batchErr = e; }

      if (batchErr && browserGone(batchErr)) {
        // The browser under us is gone. Abort RETRYABLY - the server requeues and the
        // checkpoint resumes here - rather than burning every remaining batch on a corpse.
        throw new Error("koldinfo_db_browser_died at batch " + (b + 1) + "/" + batches.length + ": " + ((batchErr && batchErr.message) || batchErr).slice(0, 140));
      }
      if (batchErr) {
        // A timeout leaves in-flight page operations running; recycle the browser so the
        // next batch starts on a clean session instead of a wedged page.
        log("batch " + (b + 1) + "/" + batches.length + " error: " + ((batchErr && batchErr.message) || batchErr).slice(0, 140));
        await freshBrowser();
      }

      for (const cand of batch) {
        const hit = cand._hit;
        if (hit && (hit.email || hit.phone)) {
          outLines.push(outRow(cand.rosId, hit));
          hitRows++; if (hit.email) emails++; if (hit.phone) phones++;
        }
      }
      batchesOnBrowser++;
      const seen = Math.min((b + 1) * size, cands.length);
      // Checkpoint AFTER the batch: the server's log hook persists the job (and with it
      // this checkpoint) to the durable store on every log line.
      job.checkpoint = { batchSize: size, doneBatches: b + 1, outLines, emails, phones, hitRows };
      log("db-lookup: " + seen + "/" + cands.length + " done - " + hitRows + " hit, " + emails + " email, " + phones + " phone");
      setPhase("processing:" + seen + "/" + cands.length);
    }
    if (page) await page.context().storageState({ path: CONFIG.statePath }).catch(() => {});
    await setPhase("exported");
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  job.checkpoint = undefined; // job is complete; drop the (large) resume payload
  log("db-lookup DONE: " + hitRows + "/" + cands.length + " rows enriched (" + emails + " emails, " + phones + " phones)" +
    (skippedNames ? " · " + skippedNames + " unmatchable name(s) skipped" : ""));
  return outLines.join("\n") + "\n";
}

/* ----------------------------------------------------------------------------- */
/* DISCOVERY: one filtered sweep of the Business Email DB → many people ($0)       */
/* ----------------------------------------------------------------------------- */

/**
 * The lookup flows above answer "find THIS person's contact info". Discovery answers
 * the Sales-Navigator question instead: "who ARE the <titles> in <cities/states>?" —
 * one filter query over the 57M-row Business Email DB, grid read page by page. Rows
 * arrive WITH emails/phones (the grid shows them unmasked), and reading the grid is
 * free, so this is a zero-credit candidate SOURCE, not an enrichment.
 *
 * Input CSV (one data row; multi-values pipe-joined):
 *   titles,cities,states,limit
 *   Director of Nursing|Nursing Director,Fair Lawn|Paramus,NJ|New Jersey,300
 * Output CSV:
 *   full_name,title,company,email,email_status,phone,seniority,city,state,linkedin_url
 */
function parseSpecCsv(text) {
  const lines = (text || "").split(/\r?\n/).filter((l) => l.length);
  if (lines.length < 2) return null;
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase().trim());
  const c = splitCsvLine(lines[1]);
  const get = (name) => { const i = header.indexOf(name); return i >= 0 ? (c[i] || "").trim() : ""; };
  const list = (s) => s.split("|").map((x) => x.trim()).filter(Boolean);
  return {
    titles: list(get("titles")).slice(0, 8),
    cities: list(get("cities")).slice(0, 8),
    states: list(get("states")).slice(0, 6),
    limit: Math.max(1, Math.min(parseInt(get("limit"), 10) || 200, 1000)),
  };
}

const DISCOVERY_HEADER = ["full_name", "title", "company", "email", "email_status", "phone", "seniority", "city", "state", "linkedin_url"];

async function runDiscoveryJob(job, { log = () => {}, setPhase = () => {} } = {}) {
  const spec = parseSpecCsv(job.csv);
  if (!spec || !spec.titles.length) throw new Error("koldinfo_no_search_spec: discovery needs at least one title");
  log(`db-discovery: ${spec.titles.length} title(s) × ${spec.cities.length} city / ${spec.states.length} state chip(s), limit ${spec.limit}`);

  const browser = await chromium.launch(launchArgs());
  const outLines = [DISCOVERY_HEADER.join(",")];
  try {
    const haveState = fs.existsSync(CONFIG.statePath);
    const context = await browser.newContext(haveState ? { storageState: CONFIG.statePath } : {});
    const page = await ensureSession(context, log);
    await setPhase("processing");

    await page.goto(CONFIG.baseUrl + CONFIG.bizEmailPath, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const rules = [{ column: "person_title", condition: "Contains", values: spec.titles }];
    if (spec.states.length) rules.push({ column: "person_location_state", condition: "Contains", values: spec.states, joiner: "AND" });
    if (spec.cities.length) rules.push({ column: "person_location_city", condition: "Contains", values: spec.cities, joiner: "AND" });
    await openAndResetFilters(page, rules.length, log);
    for (let i = 0; i < rules.length; i++) await setRuleChips(page, i, rules[i].column, rules[i].condition, rules[i].values, rules[i].joiner);
    await applyFilters(page, log);

    const seen = new Set();
    let lastSig = "";
    for (let guard = 0; guard < 40 && seen.size < spec.limit; guard++) {
      const { rows } = await readGrid(page, 200);
      if (!rows.length) break;
      const sig = JSON.stringify(rows[0]);
      if (guard > 0 && sig === lastSig) break; // pager didn't actually advance
      lastSig = sig;
      for (const r of rows) {
        const name = (r.person_name || "").trim();
        if (!name) continue;
        const key = ((r.person_linkedin_url || "").trim() || name + "|" + (r["Company Name"] || "")).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const email = RE_EMAIL.test((r.person_email || "").trim()) ? r.person_email.trim().toLowerCase() : "";
        outLines.push([
          name, r.person_title || "", r["Company Name"] || "", email, r.person_email_status_cd || "",
          firstPhone(r.person_sanitized_phone || r.person_phone), r.person_seniority || "",
          r.person_location_city || "", r.person_location_state || "", (r.person_linkedin_url || "").trim(),
        ].map(csvCell).join(","));
        if (seen.size >= spec.limit) break;
      }
      log(`db-discovery: page ${guard + 1} read — ${seen.size} unique so far`);
      setPhase("processing:" + seen.size);
      if (seen.size >= spec.limit) break;
      if (!(await nextGridPage(page))) break;
    }
    await context.storageState({ path: CONFIG.statePath }).catch(() => {});
    await setPhase("exported");
    log(`db-discovery DONE: ${outLines.length - 1} people found (grid reads only, zero credits spent)`);
  } finally {
    await browser.close().catch(() => {});
  }
  return outLines.join("\n") + "\n";
}

/** Canary: log in and confirm both DB pages + their Filters button are reachable. */
async function selfTest({ log = () => {} } = {}) {
  const browser = await chromium.launch(launchArgs());
  try {
    const haveState = fs.existsSync(CONFIG.statePath);
    const ctx = await browser.newContext(haveState ? { storageState: CONFIG.statePath } : {});
    const page = await ensureSession(ctx, log);
    await ctx.storageState({ path: CONFIG.statePath }).catch(() => {});
    for (const p of [CONFIG.peoplePath, CONFIG.bizEmailPath]) {
      await page.goto(CONFIG.baseUrl + p, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      if (!(await page.getByRole("button", { name: /^filters$/i }).first().count())) {
        return { ok: false, healed: false, resolvedTo: null, detail: "no Filters button on " + p };
      }
    }
    return { ok: true, healed: false, resolvedTo: "People DB + Business Email DB filters reachable" };
  } finally { await browser.close().catch(() => {}); }
}

module.exports = { runJob, runDiscoveryJob, selfTest, CONFIG, _internals: { parseInputCsv, parseSpecCsv, lookupPeopleDb, lookupBizEmailDb, firstEmail, firstPhone, cleanPersonName, usableName, browserGone } };
