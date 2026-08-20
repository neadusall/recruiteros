// One-off, guarded: release domains benched purely by the pre-floor bounce-RATIO rule
// (a ratio over <25 sends is statistical noise, mostly warm-up NDR subjects leaking
// through the campaign heuristic). Everything else stays resting.
//
// Deliberately KEEPS resting:
//   - any domain with >=25 sends in the window (real evidence)
//   - every internal-fleet domain while that server's IP is blocklisted (the rest is
//     correct even though the stated reason was noisy)
//   - any domain whose deliverability audit is not clean (auth/reputation/hard-fail)
import { readFileSync, writeFileSync, renameSync } from "node:fs";

const V = "/data";
const F = `${V}/snap_mpc_domain_rest_v1.json`;
const led = JSON.parse(readFileSync(F, "utf8"));
const senders = JSON.parse(readFileSync(`${V}/snap_senders_v1.json`, "utf8"));
const rows = senders.inboxes || senders.state?.inboxes || [];
const internal = new Set(
  rows.filter((m) => m && m.provider === "own-smtp" && m.email).map((m) => m.email.split("@")[1].toLowerCase()),
);
let byDom = new Map();
try {
  const audit = JSON.parse(readFileSync(`${V}/snap_mpc_deliverability_v1.json`, "utf8"));
  byDom = new Map((audit.byDomain || []).map((d) => [d.domain, d]));
} catch { /* no audit: nothing qualifies as provably clean */ }

const now = Date.now();
const released = [], kept = [];
for (const [d, v] of Object.entries(led.domains || {})) {
  if (!v || v.state !== "resting") continue;
  if (v.until && Date.parse(v.until) <= now) continue; // already expired
  const reason = String(v.reason || (v.history || []).slice(-1)[0]?.reason || "");
  const m = reason.match(/(\d+) bounce notices against (\d+) sends/);
  if (!m) { kept.push(`${d} :: other signal (${reason.slice(0, 45)})`); continue; }
  const sends = Number(m[2]);
  if (sends >= 25) { kept.push(`${d} :: REAL (${reason.slice(0, 45)})`); continue; }
  if (internal.has(d)) { kept.push(`${d} :: internal fleet, server IP blocklisted - rest is correct`); continue; }
  const a = byDom.get(d);
  const clean = a && a.auth && a.auth.fullyAuthed
    && (a.warmupReputationPct == null || a.warmupReputationPct >= 90)
    && (a.hardFailRatePct == null || a.hardFailRatePct <= 5);
  if (!clean) { kept.push(`${d} :: audit not clean or absent`); continue; }
  v.until = new Date(now - 60_000).toISOString();
  v.history = [...(v.history || []), { at: new Date().toISOString(), event: "revived", reason: "false bench: bounce ratio below the 25-send floor, audit clean" }].slice(-20);
  released.push(`${d} [${reason.slice(0, 45)}]`);
}
writeFileSync(`${F}.tmp`, JSON.stringify(led, null, 1));
renameSync(`${F}.tmp`, F);
console.log(`RELEASED ${released.length}`);
released.forEach((x) => console.log(`  + ${x}`));
console.log(`KEPT RESTING ${kept.length}`);
kept.forEach((x) => console.log(`  - ${x}`));
