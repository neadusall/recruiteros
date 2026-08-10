#!/usr/bin/env node
/**
 * Sending.ac Partner API probe.
 *
 * Answers, in one command and without touching any RecruitersOS data, the only
 * question that matters before wiring the fleet in: does this API key hand back real
 * SMTP passwords for our mailboxes?
 *
 * That was the open blocker. The Sending.ac mailboxes are Microsoft 365 accounts
 * connected to Smartlead over OAuth, and OAuth carries no password, so every one of
 * them imported into RecruitersOS unsendable. If this probe prints SMTP hosts and
 * "password: yes", the fleet can send from RecruitersOS. If it prints an auth error,
 * the key or its scopes are wrong and nothing else is worth trying yet.
 *
 * Usage:
 *   SENDINGAC_API_KEY=sac_live_xxx node integration/scripts/sendingac-probe.mjs
 *   node integration/scripts/sendingac-probe.mjs --key sac_live_xxx
 *   ... --full          list every mailbox rather than a per-sender sample
 *   ... --csv out.csv   write an email,smtp,imap credential CSV (SECRETS ON DISK)
 *
 * Read-only: it calls GET endpoints only, so it can never alter or deprovision
 * mailboxes someone is paying for.
 */

import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const KEY = (opt("key") || process.env.SENDINGAC_API_KEY || "").trim();
const FULL = flag("full");
const CSV_OUT = opt("csv");

if (!KEY) {
  console.error("No API key. Pass --key sac_live_xxx or set SENDINGAC_API_KEY.");
  console.error("Generate one at https://api.customers.ac/request-live-setup (sign in with your sending.ac account).");
  process.exit(2);
}

// The published spec says keys look like `sac_live_…` / `sac_test_…`, but the key
// Sending.ac actually issued was `sk_sandbox_…`. Match the environment word rather than
// one literal prefix, and treat anything unclassifiable as NOT live: guessing "live" is
// the only guess that can aim a non-production key at production infrastructure.
const LIVE_KEY = /^[a-z]+_(live|prod|production)_/i.test(KEY);
const SANDBOX = !LIVE_KEY;
const BASE = (process.env.SENDINGAC_API_BASE || "").trim().replace(/\/+$/, "")
  || (LIVE_KEY ? "https://live-api.customers.ac/v1" : "https://sandbox-api.customers.ac/v1");

// Upstream allows 120 req/min/token; pace under it so a full pull never trips 429.
const GAP_MS = 550;
let lastAt = 0;

async function api(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = GAP_MS - (Date.now() - lastAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();

    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      // A host that does not resolve is not a transient network blip and retrying it
      // just burns two minutes. As of 2026-08-07 BOTH hosts the spec advertises are
      // NXDOMAIN, so this is the likely first failure and it deserves a real answer
      // rather than "fetch failed".
      const cause = String(e?.cause?.code || e?.code || "");
      if (/ENOTFOUND|EAI_AGAIN/.test(cause)) {
        const err = new Error(`the API host ${new URL(BASE).hostname} does not resolve (${cause})`);
        err.code = "host.unresolved";
        throw err;
      }
      if (attempt === 4) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (res.ok) return res.json();

    let code = `http.${res.status}`, message = res.statusText;
    try {
      const b = await res.json();
      if (b?.error?.code) code = b.error.code;
      if (b?.error?.message) message = b.error.message;
      else if (b?.message) message = b.message; // Laravel-style envelope, seen live
    } catch { /* non-JSON error body */ }

    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get("retry-after"));
      await new Promise((r) => setTimeout(r, (Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) : 2 ** attempt) * 1000));
      continue;
    }
    const err = new Error(`${code}: ${message}`);
    err.code = code;
    throw err;
  }
  throw new Error("rate.quota_exceeded: gave up after retries");
}

async function listAll(path, params = {}) {
  const out = [];
  let cursor;
  for (let page = 0; page < 200; page++) {
    const r = await api(path, { ...params, "page[size]": 100, "page[after]": cursor });
    out.push(...(r.data || []));
    if (!r.pagination?.has_more || !r.pagination?.next_cursor) return out;
    cursor = r.pagination.next_cursor;
  }
  return out;
}

const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

async function main() {
  console.log(`Sending.ac Partner API probe`);
  console.log(`  host : ${BASE}${SANDBOX ? "  (SANDBOX - no real mailboxes)" : ""}`);
  console.log(`  key  : ${KEY.slice(0, 9)}…${KEY.slice(-4)}\n`);

  let senders;
  try {
    senders = await listAll("/senders");
  } catch (e) {
    console.error(`FAILED to list senders -> ${e.message}`);
    if (e.code === "host.unresolved") {
      console.error("\nThat is Sending.ac's side, not yours and not a key problem.");
      console.error("Both hosts their spec advertises were NXDOMAIN when this was written:");
      console.error("  live-api.customers.ac       sandbox-api.customers.ac");
      console.error("The only host that resolves, api.customers.ac, serves the dashboard and");
      console.error("openapi.json but has no API routes deployed (every path 404s route-not-found).");
      console.error("\nAsk Sending.ac for the real base URL, then re-run with:");
      console.error("  SENDINGAC_API_BASE=https://<their-host>/<prefix> node integration/scripts/sendingac-probe.mjs");
    }
    if (String(e.code).startsWith("auth.")) {
      console.error("\nThat is an authentication problem, not a network one:");
      console.error("  auth.invalid_key        the key is wrong, revoked, or for the other environment");
      console.error("  auth.insufficient_scope the key needs the senders:read and mailboxes:read scopes");
    }
    process.exit(1);
  }

  console.log(`Senders: ${senders.length}`);
  if (!senders.length) {
    console.log("\nNo senders on this key. If your mailboxes live under a different partner account,");
    console.log("generate the key from that account.");
    return;
  }

  let total = 0, withSmtp = 0, withImap = 0, notActive = 0;
  const rows = [];

  for (const s of senders) {
    if (s.status === "deprovisioned") continue;
    let mailboxes = [];
    try {
      mailboxes = await listAll(`/senders/${encodeURIComponent(s.id)}/mailboxes`, { include: "credentials" });
    } catch (e) {
      console.log(`\n  ${s.name || s.id}  ->  could not list mailboxes: ${e.message}`);
      continue;
    }
    total += mailboxes.length;
    const credentialed = mailboxes.filter((m) => m.credentials?.smtp?.password);
    withSmtp += credentialed.length;
    withImap += mailboxes.filter((m) => m.credentials?.imap?.password).length;
    notActive += mailboxes.filter((m) => m.status !== "active").length;

    console.log(`\n  ${s.name || s.id}  ·  ${s.status}  ·  ${mailboxes.length} mailboxes, ${credentialed.length} with SMTP logins`);
    const show = FULL ? mailboxes : mailboxes.slice(0, 3);
    for (const m of show) {
      const smtp = m.credentials?.smtp, imap = m.credentials?.imap;
      console.log(
        `     ${(m.email || m.id).padEnd(38)} ${String(m.status).padEnd(13)}` +
        ` smtp ${smtp ? `${smtp.host}:${smtp.port} ${smtp.encryption || ""} password: ${smtp.password ? "yes" : "NO"}` : "none"}` +
        ` | imap ${imap ? `${imap.host}:${imap.port} password: ${imap.password ? "yes" : "NO"}` : "none"}`,
      );
    }
    if (!FULL && mailboxes.length > show.length) console.log(`     … ${mailboxes.length - show.length} more (--full to list all)`);

    if (CSV_OUT) {
      for (const m of mailboxes) {
        const smtp = m.credentials?.smtp || {}, imap = m.credentials?.imap || {};
        rows.push([
          m.email, m.display_name || "", m.status,
          smtp.host || "", smtp.port || "", smtp.username || "", smtp.password || "", smtp.encryption || "",
          imap.host || "", imap.port || "", imap.username || "", imap.password || "", imap.encryption || "",
        ].map(csvCell).join(","));
      }
    }
  }

  console.log(`\n${"─".repeat(72)}`);
  console.log(`Mailboxes total        : ${total}`);
  console.log(`With SMTP password     : ${withSmtp}   <- these can send from RecruitersOS`);
  console.log(`With IMAP password     : ${withImap}   <- these can sync replies`);
  console.log(`Not yet active upstream: ${notActive}`);

  if (CSV_OUT) {
    const header = "email,display_name,status,smtp_host,smtp_port,smtp_user,smtp_pass,smtp_encryption,imap_host,imap_port,imap_user,imap_pass,imap_encryption";
    writeFileSync(CSV_OUT, header + "\n" + rows.join("\n") + "\n");
    console.log(`\nWrote ${rows.length} rows to ${CSV_OUT}`);
    console.log("That file holds live mailbox passwords in the clear. Delete it once imported.");
  }

  if (withSmtp > 0) {
    console.log(`\nThe key works and the fleet is credentialed. Set SENDINGAC_API_KEY on the server,`);
    console.log(`then press "Pull Sending.ac logins" on the Senders tab (or let the 6h auto-sync run).`);
  } else if (total > 0) {
    console.log(`\nMailboxes exist but none returned an SMTP password. Credentials are only issued for`);
    console.log(`mailboxes in "active" status, so if these are still provisioning, re-run this later.`);
  }
}

main().catch((e) => {
  console.error(`Probe failed: ${e?.message || e}`);
  process.exit(1);
});
