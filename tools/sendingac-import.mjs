/**
 * RecruitersOS · Sending.ac fleet readiness (one-shot, runs while the app is STOPPED)
 *
 * Run via /opt/recruiteros/sendingac-ready.sh, never by hand against a running app:
 * the app holds the senders store in memory and would clobber direct file edits.
 *
 * What it does, in order:
 *   1. ASSIGN  every unassigned Sending.ac inbox to its recruiter by mailbox name
 *              (house workspace: everything to the owner; Lume: name-matched).
 *   2. IMPORT  SMTP/IMAP credentials from any CSV dropped in /creds (the
 *              Sending.ac dashboard export). Tolerant header detection.
 *   3. PROBE   a sample of newly credentialed mailboxes with a real SMTP login
 *              (nodemailer verify) so a dead credential set is known TONIGHT,
 *              not on launch morning.
 *
 * Flags: --dry-run (report only, write nothing)
 *        --unpause-talsearches (revive the 50 paused talsearches.com inboxes)
 *        --probe N (sample size for the SMTP login check, default 8, 0 disables)
 *
 * Encryption matches integration/lib/senders/crypto.ts exactly (scrypt key from
 * SENDERS_ENCRYPTION_KEY / APP_ENCRYPTION_KEY, else the dev fallback, AES-256-GCM,
 * "v1:" prefix). The wrapper passes through whatever the app itself uses.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync } from "fs";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { createRequire } from "module";

const DATA = "/data/snap_senders_v1.json";
const CREDS_DIR = "/creds";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const UNPAUSE_TAL = args.includes("--unpause-talsearches");
const probeIdx = args.indexOf("--probe");
const PROBE_N = probeIdx >= 0 ? Math.max(0, parseInt(args[probeIdx + 1], 10) || 0) : 8;

/* ---------- crypto (mirror of lib/senders/crypto.ts) ---------- */
const SECRET =
  process.env.SENDERS_ENCRYPTION_KEY ||
  process.env.APP_ENCRYPTION_KEY ||
  "ros-senders-dev-key-do-not-use-in-prod";
const KEY = scryptSync(SECRET, "ros-senders-salt-v1", 32);
function enc(plain) {
  if (!plain) return "";
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", KEY, iv);
  const e = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "v1:" + Buffer.concat([iv, c.getAuthTag(), e]).toString("base64");
}
function dec(stored) {
  if (!stored) return "";
  if (!stored.startsWith("v1:")) return stored;
  try {
    const raw = Buffer.from(stored.slice(3), "base64");
    const d = createDecipheriv("aes-256-gcm", KEY, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch { return ""; }
}

/* ---------- CSV ---------- */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}
const norm = (h) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function pickCol(headers, candidates) {
  for (const c of candidates) { const i = headers.indexOf(c); if (i >= 0) return i; }
  return -1;
}

function loadCredsCsvs() {
  const creds = new Map(); // email -> {pass, host, port, user, imapHost, imapPort, imapUser, imapPass}
  if (!existsSync(CREDS_DIR)) return { creds, files: 0 };
  const files = readdirSync(CREDS_DIR).filter((f) => f.toLowerCase().endsWith(".csv"));
  for (const f of files) {
    const rows = parseCsv(readFileSync(`${CREDS_DIR}/${f}`, "utf8"));
    if (rows.length < 2) continue;
    const h = rows[0].map(norm);
    const iEmail = pickCol(h, ["email", "email address", "e mail", "from email", "smtp username", "username"]);
    const iPass = pickCol(h, ["smtp password", "app password", "password", "smtp pass"]);
    if (iEmail < 0 || iPass < 0) {
      console.log(`[csv] ${f}: could not find email + password columns (headers: ${rows[0].join(", ")}), skipped`);
      continue;
    }
    const iHost = pickCol(h, ["smtp host", "smtp server", "host"]);
    const iPort = pickCol(h, ["smtp port"]);
    const iUser = pickCol(h, ["smtp username", "smtp user"]);
    const iImapHost = pickCol(h, ["imap host", "imap server"]);
    const iImapPort = pickCol(h, ["imap port"]);
    const iImapUser = pickCol(h, ["imap username", "imap user"]);
    const iImapPass = pickCol(h, ["imap password", "imap pass"]);
    let n = 0;
    for (const r of rows.slice(1)) {
      const email = (r[iEmail] || "").toLowerCase().trim();
      const pass = (r[iPass] || "").trim();
      if (!email || !email.includes("@") || !pass) continue;
      creds.set(email, {
        pass,
        host: iHost >= 0 ? (r[iHost] || "").trim() : "",
        port: iPort >= 0 ? parseInt(r[iPort], 10) : NaN,
        user: iUser >= 0 ? (r[iUser] || "").trim() : "",
        imapHost: iImapHost >= 0 ? (r[iImapHost] || "").trim() : "",
        imapPort: iImapPort >= 0 ? parseInt(r[iImapPort], 10) : NaN,
        imapUser: iImapUser >= 0 ? (r[iImapUser] || "").trim() : "",
        imapPass: iImapPass >= 0 ? (r[iImapPass] || "").trim() : "",
      });
      n++;
    }
    console.log(`[csv] ${f}: ${n} credential rows`);
  }
  return { creds, files: files.length };
}

/* ---------- recruiter matching ---------- */
const HOUSE_WS = "ws_mqb8g6wf002";
const LUME_WS = "ws_mqf6o989003";
const HOUSE_OWNER = { id: "usr_mqb8g6s7001", name: "Nead Usall" };
const LUME_PEOPLE = [
  { first: "josh", last: "gurin", id: "usr_mrozx1jk001", name: "Josh Gurin" },
  { first: "noah", last: "wilkowski", id: "usr_mrp05a34002", name: "Noah Wilkowski" },
  { first: "sam", last: "wagner", id: "usr_mrp4snrc001", name: "Sam Wagner" },
  { first: "ryan", last: "nead", id: "usr_mqf6o967002", name: "Ryan" },
];
const LUME_FALLBACK = { id: "usr_mqf6o967002", name: "Ryan" };
function variants(f, l) {
  return new Set([
    f, l, f + l, l + f,
    f[0] + l, f + l[0], f[0] + l[0],
    l + f[0], l[0] + f, l[0] + l, f[0] + f,
  ]);
}
const LUME_MATCH = LUME_PEOPLE.map((p) => ({ p, set: variants(p.first, p.last) }));
function ownerFor(ws, email) {
  if (ws === HOUSE_WS) return { ...HOUSE_OWNER, matched: true };
  if (ws !== LUME_WS) return null;
  const lp = email.split("@")[0].toLowerCase().replace(/[^a-z]/g, "");
  for (const { p, set } of LUME_MATCH) if (set.has(lp)) return { id: p.id, name: p.name, matched: true };
  return { ...LUME_FALLBACK, matched: false };
}

/* ---------- main ---------- */
const state = JSON.parse(readFileSync(DATA, "utf8"));
const inboxes = state.inboxes || [];
const fleet = inboxes.filter((m) => m.provider === "sending-ac");
const { creds, files } = loadCredsCsvs();

const now = new Date().toISOString();
const r = {
  fleet: fleet.length, csvFiles: files, csvRows: creds.size,
  assigned: 0, assignedFallback: 0, alreadyAssigned: 0,
  credsSet: 0, credsAlready: 0, credsMissing: 0, unpaused: 0,
  errorsReset: 0, csvNotInFleet: 0,
};
const fleetEmails = new Set(fleet.map((m) => m.email.toLowerCase()));
for (const e of creds.keys()) if (!fleetEmails.has(e)) r.csvNotInFleet++;

const probeCandidates = [];
for (const m of fleet) {
  // 1. assignment (never clobber an existing owner)
  if (m.ownerId) r.alreadyAssigned++;
  else {
    const o = ownerFor(m.workspaceId, m.email);
    if (o) {
      m.ownerId = o.id; m.ownerName = o.name; m.updatedAt = now;
      r.assigned++; if (!o.matched) r.assignedFallback++;
    }
  }
  // 2. credentials
  const c = creds.get(m.email.toLowerCase());
  if (c) {
    const already = m.smtpPassEnc && dec(m.smtpPassEnc) === c.pass;
    if (already) r.credsAlready++;
    else {
      m.smtpHost = c.host || m.smtpHost || "smtp.office365.com";
      m.smtpPort = Number.isFinite(c.port) && c.port > 0 ? c.port : 587;
      m.smtpSecure = m.smtpPort === 465;
      m.smtpUser = c.user || m.email;
      m.smtpPassEnc = enc(c.pass);
      if (c.imapHost || c.imapPass) {
        m.imapHost = c.imapHost || m.imapHost || "outlook.office365.com";
        m.imapPort = Number.isFinite(c.imapPort) && c.imapPort > 0 ? c.imapPort : 993;
        m.imapUser = c.imapUser || m.email;
        m.imapPassEnc = enc(c.imapPass || c.pass);
      }
      if (m.status === "error") { m.status = "warming"; m.lastError = undefined; r.errorsReset++; }
      m.updatedAt = now;
      r.credsSet++;
    }
    probeCandidates.push(m);
  } else if (!m.smtpPassEnc) r.credsMissing++;
  // 3. optional unpause
  if (UNPAUSE_TAL && m.status === "paused" && m.email.endsWith("@talsearches.com")) {
    m.status = "warming"; m.pausedReason = undefined; m.updatedAt = now; r.unpaused++;
  }
}

console.log("[summary]", JSON.stringify(r, null, 2));
if (DRY) { console.log("[dry-run] nothing written"); process.exit(0); }

copyFileSync(DATA, `${DATA}.bak-${Date.now()}`);
writeFileSync(DATA, JSON.stringify(state));
console.log("[write] store updated (backup kept alongside)");

/* ---------- SMTP probe ---------- */
if (PROBE_N > 0 && probeCandidates.length) {
  const require2 = createRequire("/app/integration/probe-anchor.js");
  let nodemailer;
  try { nodemailer = require2("nodemailer"); }
  catch { console.log("[probe] nodemailer not found in image, probe skipped"); process.exit(0); }
  const sample = [];
  const pool = [...probeCandidates];
  while (sample.length < Math.min(PROBE_N, pool.length + sample.length) && pool.length) {
    sample.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  console.log(`[probe] SMTP login check on ${sample.length} mailboxes...`);
  let ok = 0, fail = 0;
  for (const m of sample) {
    const t = nodemailer.createTransport({
      host: m.smtpHost, port: m.smtpPort, secure: !!m.smtpSecure,
      auth: { user: m.smtpUser, pass: dec(m.smtpPassEnc) },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
    });
    try { await t.verify(); console.log(`[probe] OK   ${m.email}`); ok++; }
    catch (e) { console.log(`[probe] FAIL ${m.email}: ${String(e.message || e).slice(0, 120)}`); fail++; }
    finally { t.close(); }
  }
  console.log(`[probe] result: ${ok} ok, ${fail} failed`);
  if (fail && !ok) console.log("[probe] EVERY sampled login failed. Check the export, or SMTP AUTH may be disabled on the tenant. Do not launch until this is green.");
}
