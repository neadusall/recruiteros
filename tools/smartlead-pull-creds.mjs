// Pull mailbox credentials straight from the Smartlead email-accounts API and write a
// CSV in the exact format the Sending.ac importer already accepts (same columns as the
// tal-fleet Smartlead export that imported cleanly). Runs inside a throwaway container
// that has SMARTLEAD_API_KEY, writes to the mounted /creds dir, and touches nothing else.
//
// Default scope: accounts whose email domain contains "lume" AND carry a password (the
// 900-box gap). Pass --all to include every credentialed account.
//
// Read-only against Smartlead (GET only). Prints counts, never secrets, to stdout.

import { writeFileSync } from "node:fs";

const KEY = process.env.SMARTLEAD_API_KEY;
const BASE = (process.env.SMARTLEAD_API_BASE || "https://server.smartlead.ai/api/v1").replace(/\/+$/, "");
const ALL = process.argv.includes("--all");
const OUT = process.argv.find((a) => a.endsWith(".csv")) || "/creds/lume-from-smartlead.csv";

if (!KEY) { console.error("SMARTLEAD_API_KEY not present in this environment"); process.exit(2); }

async function fetchAll() {
  const out = [];
  let offset = 0;
  const limit = 100;
  for (;;) {
    const url = `${BASE}/email-accounts/?api_key=${encodeURIComponent(KEY)}&offset=${offset}&limit=${limit}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    const arr = Array.isArray(d) ? d : (d.data || d.email_accounts || []);
    out.push(...arr);
    if (arr.length < limit) break;
    offset += limit;
    if (offset > 5000) break; // runaway guard
  }
  return out;
}

const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

// Same header order as the proven tal Smartlead export.
const HEADER = "from_name,from_email,user_name,password,smtp_host,smtp_port,imap_host,imap_port,max_email_per_day,warmup_enabled,total_warmup_per_day,daily_rampup,reply_rate_percentage,imap_user_name,imap_password";

const accounts = await fetchAll();
console.log(`fetched ${accounts.length} accounts from Smartlead`);

const rows = [];
let seenLume = 0, lumeNoPw = 0;
for (const a of accounts) {
  const email = a.from_email || a.email || "";
  const domain = (email.split("@")[1] || "").toLowerCase();
  const isLume = domain.includes("lume");
  if (!ALL && !isLume) continue;
  if (isLume) seenLume++;
  if (!a.password) { if (isLume) lumeNoPw++; continue; }
  rows.push([
    a.from_name || "", email, a.username || email, a.password,
    a.smtp_host || "", a.smtp_port || "", a.imap_host || "", a.imap_port || "",
    a.max_email_per_day ?? 2, a.warmup_enabled ?? true, 10, "", a.reply_rate_percentage ?? 70,
    a.imap_username || email, a.imap_password || a.password,
  ].map(cell).join(","));
}

writeFileSync(OUT, HEADER + "\n" + rows.join("\n") + "\n");

const hosts = [...new Set(accounts.filter(a => (a.from_email||a.email||"").includes("lume") && a.password).map(a => a.smtp_host))].filter(Boolean);
console.log(`lume-domain accounts seen: ${seenLume}`);
console.log(`lume without a password:   ${lumeNoPw}`);
console.log(`rows written (with creds):  ${rows.length}`);
console.log(`smtp hosts in output:       ${hosts.join(", ") || "(none)"}`);
console.log(`wrote ${OUT}`);
if (!rows.length) console.log("\nNo credentialed rows. The API may not expose passwords for these; use the UI CSV export instead.");
