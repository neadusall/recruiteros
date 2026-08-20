// RecruitersOS · System Health collector (the checks-and-balances layer).
//
// Born 2026-08-14 after a week of silent failures; tightened same day after the first review:
// readings must survive an adversarial audit against ground truth, or the board is theater.
//   good  = verified working          amber = degraded / needs attention soon
//   bad   = broken or actively risky
// Runs on the HOST (systemd timer, q15min) so it can see systemd, the docker volume, and the
// network; writes /data/snap_system_health_v1.json for /api/owner/system-health. The UI treats
// a snapshot older than 30 min as a RED banner: the collector is itself watched.
//
//   node /opt/recruiteros/tools/system-health.mjs
import { readFileSync, writeFileSync, renameSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const VOL = "/var/lib/docker/volumes/recruiteros_app_data/_data";
const OUT_FILE = `${VOL}/snap_system_health_v1.json`;
const MPC_OUT = "/opt/recruiteros/mpc-out";
const ENV_FILE = "/opt/recruiteros/.env.production";

const now = Date.now();
const checks = [];
function add(group, id, name, status, reading, detail) {
  checks.push({ group, id, name, status, reading: String(reading), detail: detail ? String(detail) : "", checkedAt: new Date().toISOString() });
}
function readJson(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }
function envVal(key) {
  try { const m = readFileSync(ENV_FILE, "utf8").match(new RegExp(`^${key}=(.*)$`, "m")); return m ? m[1].trim() : ""; } catch { return ""; }
}
function ageMin(iso) { const t = Date.parse(iso || 0); return Number.isFinite(t) ? Math.round((now - t) / 60000) : null; }
function fmtAge(min) { return min == null ? "never" : min < 60 ? `${min}m ago` : min < 2880 ? `${Math.round(min / 60)}h ago` : `${Math.round(min / 1440)}d ago`; }

/* ---------------- sent-log facts (today volume, contacted set) ---------------- */
const today = new Date().toISOString().slice(0, 10);
let sentToday = 0;
const sentTo = new Set();
for (const f of readdirSync(MPC_OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
  for (const line of readFileSync(`${MPC_OUT}/${f}`, "utf8").split("\n")) {
    const s = line.trim(); if (!s) continue;
    try { const r = JSON.parse(s); if (r.to_email) { sentTo.add(String(r.to_email).toLowerCase()); if ((r.at || "").slice(0, 10) === today) sentToday++; } } catch {}
  }
}

/* ---------------- Sending & domains ---------------- */
const GROUP_SEND = "Sending & domains";

// Volume vs governor cap — same knobs batch.mjs honors (env-aware, no silent formula drift).
const placement = readJson(`${VOL}/snap_mpc_placement_v1.json`);
const plAge = placement ? ageMin(placement.checkedAt) : null;
const plTotal = placement ? (placement.gmail?.inbox || 0) + (placement.gmail?.spam || 0) : 0;
const plPass = placement && plAge != null && plAge <= 7 * 1440 && plTotal > 0 && (placement.gmail.spam || 0) / plTotal <= 0.3;
{
  const CAP_ENV = Number(envVal("MPC_DAILY_CAP") || 1800);
  const RAMP_START = Date.parse(envVal("MPC_RAMP_START") || "2026-08-13");
  const RAMP_BASE = envVal("MPC_RAMP_BASE") === "" ? 450 : Number(envVal("MPC_RAMP_BASE"));
  let cap = CAP_ENV;
  if (RAMP_BASE > 0 && Number.isFinite(RAMP_START)) {
    const weeks = Math.max(0, (now - RAMP_START) / (7 * 86400000));
    cap = Math.min(cap, Math.min(1500, Math.round(RAMP_BASE * (plPass ? Math.pow(1.2, weeks) : 1))));
  }
  const utc = new Date().getUTCHours();
  const st = sentToday > cap ? "bad" : (utc >= 18 && sentToday === 0) ? "amber" : "good";
  add(GROUP_SEND, "volume", "Daily send volume", st, `${sentToday} sent / cap ${cap}`,
    sentToday > cap ? "Over the governor cap: investigate immediately" :
    st === "amber" ? "Zero sends late in the day usually means the sendable pool is empty" :
    plPass ? "Governor: growth unlocked by the passing seed test" : "Governor holding base volume until a passing seed test exists");
}

// Domain rest ledger.
const rest = readJson(`${VOL}/snap_mpc_domain_rest_v1.json`);
{
  const doms = Object.entries(rest?.domains || {});
  const resting = doms.filter(([, v]) => v?.state === "resting" && (!v.until || Date.parse(v.until) > now));
  const names = resting.map(([d]) => d);
  const nextUp = resting.map(([, v]) => Date.parse(v.until || 0)).filter(Number.isFinite).sort()[0];
  const inMin = nextUp ? Math.round((nextUp - now) / 60000) : null;
  const nextTxt = inMin == null ? "n/a" : inMin <= 0 ? "due now (next breaker run)" : inMin < 60 ? `in ${inMin}m` : `in ${Math.round(inMin / 60)}h`;
  const st = resting.length > 20 ? "bad" : resting.length > 8 ? "amber" : "good";
  add(GROUP_SEND, "resting", "Domains resting (circuit breaker)", st, `${resting.length} resting`,
    names.length ? `Warm-up continues; next auto-revive ${nextTxt}: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` +${names.length - 5} more` : ""}` : "No domain currently benched");
}

// Fresh bounce pressure + suppression from the NDR sidecar.
const ndr = readJson(`${VOL}/snap_mpc_ndr_v1.json`);
{
  const fresh = Object.values(ndr?.perDomain || {}).reduce((s, v) => s + (v.bounces || 0), 0);
  // Severity follows the RECEIVER'S STATED REASON, not the raw count. A pile of dead
  // addresses is a list-quality chore; a handful of spam verdicts, blocklist rejections
  // or auth failures is a reputation emergency, because those are the ones that burn
  // domains. Flagging both at the same threshold trains the operator to ignore red.
  const R = ndr?.byReason || {};
  const reputational = (R.spam_verdict || 0) + (R.blocklist || 0) + (R.auth_fail || 0) + (R.send_limit || 0);
  const dead = (R.dead_address || 0) + (R.mailbox_full || 0);
  const st = reputational >= 10 ? "bad" : reputational >= 3 ? "amber"
    : fresh >= 120 ? "bad" : fresh >= 40 ? "amber" : "good";
  const mix = [reputational ? `${reputational} reputation-class` : null, dead ? `${dead} dead/full mailbox` : null]
    .filter(Boolean).join(", ");
  add(GROUP_SEND, "bounces", "Fresh bounce pressure", ndr ? st : "bad",
    ndr ? `${fresh} recent notices${mix ? ` (${mix})` : ""}` : "no sweep data",
    !ndr ? "NDR sweep has never produced a sidecar"
      : reputational >= 3 ? `Receivers are judging our CONTENT or REPUTATION, not just bad addresses: this is what benches domains. ${(ndr.bounced || []).length} addresses suppressed permanently.`
      : `Mostly undeliverable addresses (list quality), which cost sends but not reputation. ${(ndr.bounced || []).length} addresses suppressed permanently.`);
}

// Send fuse + verification belt (2026-08-20): the fleet kill switch, the per-source breakers
// and the pre-send verdict belt. A tripped fuse is RED on purpose: a person has to look.
{
  const fuse = readJson(`${VOL}/snap_mpc_send_fuse_v1.json`);
  const fAge = fuse ? ageMin(fuse.updatedAt) : null;
  const tripped = !!fuse?.fleet?.tripped;
  const paused = Object.entries(fuse?.sources || {}).filter(([, s]) => s?.paused).map(([k]) => k);
  const w = fuse?.window || {};
  add(GROUP_SEND, "sendfuse", "Send fuse (fleet kill switch + source breakers)",
    !fuse ? "bad" : tripped ? "bad" : fAge > 6 * 60 ? "amber" : paused.length ? "amber" : "good",
    !fuse ? "no ledger" : tripped ? `TRIPPED ${fmtAge(ageMin(fuse.fleet.since))} by ${fuse.fleet.by}` : `armed · ${w.bounces ?? 0} bounces / ${w.sends ?? 0} sends in ${w.windowH ?? 24}h${paused.length ? ` · paused: ${paused.join(", ")}` : ""}`,
    !fuse ? "No sender has evaluated the fuse yet; batch.mjs writes it before every run and the sweep timer re-evaluates it" :
    tripped ? `${fuse.fleet.reason}. Cold sends are stopped on every lane until cleared: bash /opt/recruiteros/tools/send-fuse.sh --clear` :
    fAge > 6 * 60 ? "Ledger is stale: neither the send tick nor the sweep has evaluated it lately" :
    paused.length ? "A bouncing address rung is paused; every other rung keeps sending" :
    `Trips at >${(w.maxRatio ?? 0.05) * 100}% bounces on ${w.minSends ?? 100}+ sends in ${w.windowH ?? 24}h; stays tripped until a person clears it`);
  const b = fuse?.belt;
  const c = b?.canary;
  add(GROUP_SEND, "verifybelt", "Pre-send verification belt",
    !b ? "amber" : c?.tripped ? "bad" : b.heldNoVerifier ? "amber" : "good",
    !b ? "no run yet" : `${b.provenOnFile} proven on file · ${b.reverified} re-verified live (${b.provenLive} ok, ${b.dead} dead, ${b.catchAll} catch-all)${c ? ` · canary ${c.invalid}/${c.sample}` : ""} · ${fmtAge(ageMin(b.at))}`,
    !b ? "Reports after the first send tick" :
    b.heldNoVerifier ? "REOON_API_KEY is not reaching the send tick: unproven addresses are held instead of checked" :
    "Nothing cold-sends without a verifier verdict; dead, catch-all and role verdicts never send, stale verdicts are re-checked");
}

// Google cold lane (Zapmail Gmail boxes): active fleet + today's throughput + failure rate.
{
  const snd = readJson(`${VOL}/snap_senders_v1.json`);
  const rows = snd?.inboxes || snd?.state?.inboxes || [];
  const gmail = rows.filter((m) => m && m.status === "active" && m.smtpPassEnc && /^smtp\.gmail\.com$/i.test(m.smtpHost || ""));
  const gset = new Set(gmail.map((m) => m.email));
  let gSent = 0, gFail = 0;
  for (const f of readdirSync(MPC_OUT).filter((n) => n.startsWith("sent-") && n.includes(today))) {
    for (const line of readFileSync(`${MPC_OUT}/${f}`, "utf8").split("\n")) {
      const s = line.trim(); if (!s) continue;
      try { const r = JSON.parse(s); if (r.from && gset.has(r.from) && (r.at || "").slice(0, 10) === today) { if (r.result?.ok) gSent++; else gFail++; } } catch {}
    }
  }
  const failPct = gSent + gFail ? Math.round((gFail / (gSent + gFail)) * 100) : 0;
  const st = !gmail.length ? "amber" : gSent + gFail >= 5 && failPct > 20 ? "bad" : "good";
  add(GROUP_SEND, "googlelane", "Google cold lane (Gmail boxes)", st,
    gmail.length ? `${gmail.length} boxes active · ${gSent} sent today${gFail ? `, ${gFail} failed` : ""}` : "no active Gmail boxes",
    !gmail.length ? "Lane is built but no Gmail box is active with working credentials" :
    gSent + gFail >= 5 && failPct > 20 ? "High failure rate: check Gmail SMTP auth (534/454) and the ramp caps" :
    "Per-box weekly ramp 8/14/20 with a 50/day per-domain ceiling; follow-ups share the caps");
}

// IMAP bounce sweep: the only bounce visibility for Gmail + internal-SMTP boxes.
{
  const im = readJson(`${VOL}/snap_mpc_ndr_imap_v1.json`);
  const age = im ? ageMin(im.generatedAt) : null;
  const st = !im ? "bad" : age <= 8 * 60 ? "good" : age <= 24 * 60 ? "amber" : "bad";
  add(GROUP_SEND, "imapsweep", "IMAP bounce sweep (Gmail + internal)", st,
    im ? `${im.boxesSwept ?? "?"} boxes swept ${fmtAge(age)}` : "never ran",
    st === "good" ? "" : "Without this sweep, bounces landing in Gmail/Mailcow inboxes are invisible to the stop-list and the domain breaker");
}

// Internal server egress canary. On 2026-08-20 ALL outbound from mail.lumesp.com was found
// leaving as 192.3.221.194 (Spamhaus-listed, Gmail 550 since 08-02) although postfix was
// configured for a two-IP split: the container cannot bind host IPs, so the binds failed
// silently for 24 days. Egress is now pinned by a host SNAT rule to 173.254.242.194.
// The receivers' own rejection text names the IP they saw, so a rejection dated after the
// cutover that names the OLD IP means the pin is gone (Docker re-ordered nat rules, rule
// deleted, box rebuilt). Rejections naming the NEW IP are a different story (reputation
// building), reported amber so they are seen but not confused with a leak.
{
  const im = readJson(`${VOL}/snap_mpc_ndr_imap_v1.json`);
  const markerPath = "/var/lib/recruiteros/internal-egress-cutover-at";
  const cutoverAt = existsSync(markerPath) ? readFileSync(markerPath, "utf8").trim() : null;
  const NEW_IP = "173.254.242.194";
  const ips = Object.entries(im?.egressIps || {});
  const since = (iso) => cutoverAt && iso && iso > cutoverAt;
  const leak = ips.filter(([ip, v]) => ip !== NEW_IP && since(v?.lastSeen));
  const fresh = ips.filter(([ip, v]) => ip === NEW_IP && since(v?.lastSeen));
  // Standing monitor pulled from the Mailcow host (lume-ip-pull.timer, q15min): the
  // receivers' verdicts from the authoritative log + blocklists via the box's resolver.
  const sm = readJson(`${VOL}/snap_internal_egress_status_v1.json`);
  const smAge = sm ? ageMin(sm.at) : null;
  const smFresh = sm && smAge != null && smAge <= 120;
  const g = sm?.receivers?.google || {};
  const gAtt = (g.accepted || 0) + (g.rejected || 0);
  const gPct = gAtt ? Math.round(((g.accepted || 0) / gAtt) * 100) : null;
  const listed = Object.entries(sm?.dnsbl || {}).filter(([, v]) => v !== "clean").map(([z]) => z);
  const pinBad = smFresh && (sm.rulePos1 === false || (sm.egressSeen && sm.egressSeen !== NEW_IP) || (sm.oldIpMentions || 0) > 0);
  const accBad = smFresh && gAtt >= 20 && gPct != null && gPct < 90;
  const accSoft = smFresh && ((gAtt >= 10 && gPct != null && gPct < 95) || (g.rateLimited || 0) > 0);
  const st = !cutoverAt ? "amber" : (leak.length || pinBad || listed.length || accBad) ? "bad" : (fresh.length || accSoft || !smFresh) ? "amber" : "good";
  const standingLine = smFresh
    ? `Gmail ${gPct == null ? "no attempts" : `${gPct}% of ${gAtt} accepted`}${g.rateLimited ? `, ${g.rateLimited} rate-limited` : ""}, blocklists ${listed.length ? "LISTED " + listed.join(",") : "clean"}, monitor ${fmtAge(smAge)}`
    : `standing monitor ${sm ? fmtAge(smAge) : "never pulled"}`;
  add(GROUP_SEND, "internalegress", "Internal server egress IP (mail.lumesp.com)", st,
    !cutoverAt ? "no cutover marker on this host" :
    leak.length ? `receivers named ${leak.map(([ip, v]) => `${ip} (${v.count}, last ${fmtAge(ageMin(v.lastSeen))})`).join(", ")} AFTER the cutover` :
    pinBad ? `egress pin not holding on the Mailcow host (rulePos1=${sm.rulePos1}, egress seen ${sm.egressSeen || "?"}, old IP named ${sm.oldIpMentions || 0}x)` :
    `${NEW_IP}: ${standingLine}`,
    !cutoverAt ? "Write the cutover timestamp to /var/lib/recruiteros/internal-egress-cutover-at" :
    (leak.length || pinBad) ? "Run /usr/local/sbin/lume-smtp-snat.sh on the Mailcow host and check `iptables -t nat -S POSTROUTING` (our SNAT rule must be first)" :
    listed.length ? "The sending IP is on a blocklist: the keeper has dropped warm-up to 8/day; request delisting before it climbs again" :
    accBad ? "Gmail is refusing most of our mail again: keeper steps warm-up back to 8/day; read the rejection text in the IMAP sidecar" :
    accSoft ? "Acceptance is slipping or Gmail is rate-limiting: the keeper holds the current rung until 24h are clean" :
    !smFresh ? "lume-ip-pull.timer on this host is not delivering the Mailcow monitor; the keeper holds its rung until it does" :
    fresh.length ? "Some receiver named the new IP in a rejection: read providerBlocks in the IMAP sidecar before the next rung" :
    "Egress pinned to the clean primary IP; warm-up climbs 8/14/20/28/35 one rung at a time on clean 24h evidence");
}

// Fleet plan (the living "what to expect" list on the Senders tab). Each milestone is
// checked off only when the ledger that gates it proves it happened; the app's outlook
// watcher folds every reading into snap_senders_outlook_ledger_v1 on the maintenance
// tick. Two failures matter here: a milestone that WENT BACKWARDS (something proven is
// now contradicted) and a watcher that stopped folding, which would freeze the board
// mid-plan while it still looked authoritative. Warm-up rungs additionally need the
// keeper's own report, so its absence is called out rather than silently unverifiable.
{
  const led = readJson(`${VOL}/snap_senders_outlook_ledger_v1.json`);
  const age = led ? ageMin(led.at) : null;
  const s = led?.summary || {};
  const wu = readJson(`${VOL}/snap_internal_warmup_v1.json`);
  const wuAge = wu ? ageMin(wu.lastRun || wu.at) : null;
  const wuStale = !wu || wuAge == null || wuAge > 120;
  const stale = !led || age == null || age > 6 * 60;
  // A monitor that cannot READ its evidence is a failure of the monitor, not a clean
  // board: errors and unverified steps are reported here rather than rounding to green.
  const errs = s.errors ?? 0;
  const unver = s.unverified ?? 0;
  const wuErr = wu?.error || null;
  const st = !led ? "amber"
    : (s.regressed > 0 || age > 24 * 60) ? "bad"
    : (s.late > 0 || errs > 0 || stale || wuStale || wuErr) ? "amber"
    : "good";
  add(GROUP_SEND, "fleetplan", "Fleet plan (milestones verified, not assumed)", st,
    !led ? "watcher has not folded a reading yet" :
    `${s.done ?? 0} of ${s.milestones ?? 0} verified done, ${s.late ?? 0} late, ${s.regressed ?? 0} went backwards` +
      `${unver ? `, ${unver} unverifiable` : ""}${errs ? `, ${errs} read errors` : ""} (folded ${fmtAge(age)})`,
    !led ? "The sending cron tick runs the outlook watcher; without it the board still recomputes live on read but keeps no verified dates or slip history" :
    s.regressed > 0 ? "A milestone that had been PROVEN is now contradicted: open Senders > Fleet monitor and read the line marked went backwards" :
    stale ? "The outlook watcher has stopped folding readings: check /api/sending/cron on this host" :
    errs > 0 ? "The watcher could not read some fleet's evidence this run: the affected lines hold their last state instead of moving" :
    wuErr ? `The warm-up keeper ran but could not count the boxes (${wuErr}); rungs stay unchecked until it can` :
    wuStale ? `The warm-up keeper's report is ${wu ? fmtAge(wuAge) : "missing"}, so warm-up rungs cannot be checked off; check lume-warmup-keeper.timer` :
    s.late > 0 ? "A milestone is past its forecast with no evidence it happened; the line on the card says what it is waiting on" :
    unver > 0 ? "Some steps cannot be confirmed from here yet; they stay unchecked rather than being assumed" :
    "Every milestone is either verified done or still inside its forecast");
}

// Provider-block radar: fleet x receiving-provider pairs currently rejecting our servers.
// An active pair is NOT itself an alarm (routing already steers around it); the alarm is
// a MISSING or stale ledger, which would mean the radar went blind like pre-2026-08-19.
{
  const led = readJson(`${VOL}/snap_provider_blocks_v1.json`);
  const age = led ? ageMin(led.generatedAt) : null;
  // Same active rule as the routers (fresh <7d AND count >= 20), so the board only
  // names pairs that are actually steering traffic - never a louder claim than reality.
  const active = Object.values(led?.blocks || {}).filter((b) => b?.lastSeen && now - Date.parse(b.lastSeen) < 7 * 86400000 && (b.count || 0) >= 20);
  const st = !led ? "bad" : age > 26 * 60 ? "amber" : active.length ? "amber" : "good";
  add(GROUP_SEND, "providerblocks", "Provider-block radar (rejection pressure)", st,
    !led ? "no ledger" : active.length ? `${active.length} active: ${active.map((b) => `${b.fleet} blocked by ${b.provider}`).join(", ")}` : "no provider currently rejecting any fleet",
    !led ? "NDR sweeps have not written the block ledger; routing is flying blind on receiver-side blocks" :
    age > 26 * 60 ? "Ledger is stale (sweep not running?); routing may be steering on old data" :
    active.length ? "Routing steers these recipients to other fleets automatically; pairs release after 7 quiet days" :
    "Sweeps scan every bounce notice (campaign + warm-up) for IP/reputation block signatures");
}

// Email IDs that cannot send at all: their own server refuses to relay for them
// (SendAs permission missing / relay auth wrong). The sweeps deliberately keep these
// OFF the reputation books, because no message ever left the building and the
// recipient is unproven - which also made them invisible. They are pure lost capacity
// and they never self-heal, so they need a person, not a timer.
{
  const infra = ndr?.perBoxInfra || {};
  const boxes = Object.keys(infra);
  const st = boxes.length >= 5 ? "bad" : boxes.length ? "amber" : "good";
  add(GROUP_SEND, "cannotsend", "Email IDs refused by their own server", st,
    boxes.length ? `${boxes.length} cannot send` : "every Email ID is accepted by its own server",
    boxes.length
      ? `Authorization refused for: ${boxes.slice(0, 4).join(", ")}${boxes.length > 4 ? ` +${boxes.length - 4} more` : ""}. Fix the SendAs / relay permission for these addresses at the mail provider; they burn no reputation but they send nothing either.`
      : "");
}

// Sending IP reputation. Receivers name the IP they refused and the public blocklist
// they consulted; that is ground truth about our own infrastructure and beats a
// self-probe (public resolvers refuse Spamhaus queries outright). A public listing is
// the most dangerous state a sending server can be in: it stops mail at MANY receivers
// at once and it puts the DOMAINS at risk, not just the IP.
{
  const led = readJson(`${VOL}/snap_provider_blocks_v1.json`);
  const fresh = Object.values(led?.blocks || {}).filter((b) => b?.lastSeen && now - Date.parse(b.lastSeen) < 7 * 86400000 && (b.count || 0) >= 20);
  const listed = fresh.filter((b) => b.blocklist);
  const ips = [...new Set(fresh.map((b) => b.blockedIp).filter(Boolean))];
  const listedIps = [...new Set(listed.map((b) => b.blockedIp).filter(Boolean))];
  const lists = [...new Set(listed.map((b) => b.blocklist))];
  const st = listed.length ? "bad" : ips.length ? "amber" : "good";
  add(GROUP_SEND, "sendingip", "Sending IP reputation", st,
    listed.length ? `${listedIps.join(", ") || "a sending IP"} listed on ${lists.join(", ")}`
      : ips.length ? `${ips.join(", ")} refused by receivers, no public listing cited`
      : "no receiver has named a blocked sending IP",
    listed.length ? `A public listing stops mail at many receivers at once and trains domain-level reputation against you. Stop that server's outbound volume (warm-up included), then request delisting at check.spamhaus.org, or cut over to a clean IP.`
      : ips.length ? "Receivers reject this IP on their own reputation data; routing already steers the affected fleets away."
      : "");
}

// New Email ID onboarding audit: every imported sender is vetted (login, DNS posture,
// blocklists) before it can matter. Failures alert the owner and hold here until fixed.
{
  const ob = readJson(`${VOL}/snap_sender_onboarding_v1.json`);
  const last = ob?.runs?.[0];
  const fails = last?.failures?.length || 0;
  const st = !ob ? "amber" : fails ? "amber" : "good";
  add(GROUP_SEND, "onboarding", "New sender onboarding audit", st,
    !ob ? "no audits yet" : `last run ${fmtAge(ageMin(last?.at))}: ${last?.checked ?? 0} checked, ${fails} with problems`,
    !ob ? "No Email IDs have been imported since the audit layer shipped; first import will populate this" :
    fails ? `Problems: ${last.failures.slice(0, 3).map((f) => `${f.subject}: ${f.problems[0]}`).join(" | ")}` :
    "Imports are vetted for SMTP login, encoded-password traps, SPF/DMARC/MX posture, and blocklists");
}

// Auth + warm-up from the deliverability snapshot.
const deliv = readJson(`${VOL}/snap_mpc_deliverability_v1.json`);
{
  const o = deliv?.overall;
  if (!o) add(GROUP_SEND, "auth", "Domain authentication (SPF/DKIM/DMARC)", "bad", "no data", "Deliverability snapshot missing");
  else {
    const authed = o.domainsFullyAuthed ?? 0, sending = o.domainsSending ?? 0;
    add(GROUP_SEND, "auth", "Domain authentication (SPF/DKIM/DMARC)", authed >= sending ? "good" : "amber",
      `${authed}/${sending} sending domains fully authed`, authed < sending ? "dns-authfix should repair overnight; recheck tomorrow" : "");
    const rep = o.warmupReputationPct;
    add(GROUP_SEND, "warmup", "Warm-up reputation", rep == null ? "amber" : rep >= 95 ? "good" : rep >= 85 ? "amber" : "bad",
      rep == null ? "unavailable" : `${rep}% fleet average`, rep == null ? "Smartlead API not reachable on last refresh" : "");
  }
}

// Seed placement test.
add(GROUP_SEND, "placement", "Gmail inbox placement (seed test)",
  !placement ? "amber" : plPass && plAge <= 5 * 1440 ? "good" : plPass ? "amber" : "bad",
  !placement ? "never run" : `${placement.gmail.inbox} inbox / ${placement.gmail.spam} spam, ${fmtAge(plAge)}`,
  !placement ? "Volume growth stays locked until a passing test exists" :
  !plPass ? "Failing or stale: growth locked, google-hosted prospects deferred" :
  plAge > 5 * 1440 ? "Passing but aging: expires at 7 days and locks growth" : "Feeds the volume governor and the Google gate");

// Candidate job blasts (Candidates tab): an active blast with people still queued
// must be moving; a blast that hasn't sent in over a day during the week means its
// clock or its inbox pool is broken.
{
  const blasts = readJson(`${VOL}/snap_job_blasts_v1.json`);
  if (Array.isArray(blasts) && blasts.length) {
    const active = blasts.filter((b) => b && b.status === "sending");
    const stuck = active.filter((b) => {
      const queued = (b.recipients || []).some((r) => r && r.status === "queued");
      const lastMin = ageMin(b.lastSendAt || b.updatedAt || b.createdAt);
      const weekday = ![0, 6].includes(new Date().getUTCDay());
      return queued && weekday && (lastMin == null || lastMin > 26 * 60);
    });
    add(GROUP_SEND, "jobblasts", "Candidate job blasts",
      stuck.length ? "amber" : "good",
      `${active.length} active / ${blasts.length} total${stuck.length ? `, ${stuck.length} stalled` : ""}`,
      stuck.length ? "A blast with queued candidates has not sent in over a day: check the sending cron and the recruiter's inbox pool" : "");
  }
}

/* ---------------- Supply pipeline ---------------- */
const GROUP_SUPPLY = "Supply pipeline";

const eng = readJson(`${VOL}/snap_inmarket_engine_health_v1.json`);
{
  const okTick = eng?.lastCurationOk === true;
  const engAge = eng ? ageMin(eng.lastCurationAt) : null;
  const bootAge = eng ? ageMin(eng.bootAt) : null;
  const warmingUp = !okTick && bootAge != null && bootAge <= 15;
  add(GROUP_SUPPLY, "tick", "Curation tick (enrichment engine)",
    !eng ? "bad" : okTick && engAge <= 30 ? "good" : warmingUp ? "amber" : okTick ? "amber" : "bad",
    !eng ? "no engine health data" :
    warmingUp ? `app restarted ${fmtAge(bootAge)}, first tick pending` :
    okTick ? `completing, last ${fmtAge(engAge)}` : `FAILING: ${eng.lastCurationError || "unknown error"}`,
    okTick || warmingUp ? "" : "Nothing downstream (managers, emails, validation) advances while this fails");
}

// Curation funnel numbers: rolling 24h windows (calendar-day counts lie at 1am),
// validatedAt for validation (a row curated Tuesday can validate Thursday).
const cur = readJson(`${VOL}/snap_inmarket_curation_v1.json`);
let gatesNote = "";
{
  const arrs = []; const walk = (o) => { if (Array.isArray(o)) { if (o.length && typeof o[0] === "object") arrs.push(o); } else if (o && typeof o === "object") for (const v of Object.values(o)) walk(v); };
  walk(cur || {});
  const rows = (arrs.sort((a, b) => b.length - a.length)[0] || []).map((r) => r.lead || r);
  const h24 = now - 24 * 3600000;
  let curated24 = 0, validated24 = 0, backlog = 0, catchAllHeld = 0;
  const candidates = [];
  for (const r of rows) {
    if (Date.parse(r.curatedAt || 0) >= h24) curated24++;
    if (Date.parse(r.validatedAt || 0) >= h24 && r.emailValidated === true) validated24++;
    if (r.likelyEmail && !r.emailInvalid) {
      // Catch-all is a FINAL verdict, not a queue state: the domain accepts every address,
      // so a specific mailbox can never be proven and these rows never become validated.
      // Counting them as "awaiting validation" reported a backlog of 4,194 on 2026-08-20
      // when the real queue was 10, i.e. a permanent red light nobody could ever clear.
      // This mirrors the app's own pendingValidation rule in lib/inmarket/curation.ts.
      if (r.emailCatchAll) catchAllHeld++;
      else if (r.emailValidated !== true) backlog++;
      else if (!sentTo.has(String(r.likelyEmail).toLowerCase())) candidates.push(r);
    }
  }
  // The honest "ready to send" number applies the SAME quality gates the sender applies —
  // the earlier version skipped them and read thousands while the real pool was 36.
  let passGates = 0, segDeferred = 0, gateRejected = 0, provenVerdict = 0;
  try {
    const g = await import("/opt/recruiteros/tools/gates.mjs");
    const v = await import("/opt/recruiteros/tools/verify.mjs");
    const mx = readJson(`${MPC_OUT}/mx-class.json`) || {};
    for (const r of candidates) {
      if (!g.assessProspect(r).eligible) { gateRejected++; continue; }
      const dom = String(r.likelyEmail).split("@")[1]?.toLowerCase();
      if (mx[dom]?.seg) { segDeferred++; continue; }
      passGates++;
      if (v.isProvenStatus(r.emailVerifyStatus)) provenVerdict++;
    }
    gatesNote = `${gateRejected} fail quality gates, ${segDeferred} gateway-deferred. ${provenVerdict} of the sendable carry a proven verifier verdict; the rest are re-verified at send time`;
  } catch (e) {
    passGates = candidates.length;
    gatesNote = `gates module unavailable (${String(e.message).slice(0, 40)}): count is pre-gate`;
  }
  add(GROUP_SUPPLY, "inflow", "New prospects curated (24h)", curated24 >= 300 ? "good" : curated24 >= 50 ? "amber" : "bad",
    `${curated24} in 24h`, "Sourcing belt output: watchlists, JD feeds, signals");
  add(GROUP_SUPPLY, "validated", "Emails validated (24h)", validated24 >= 200 ? "good" : validated24 >= 50 ? "amber" : "bad",
    `${validated24} in 24h`, "Reoon inline validation inside the curation tick");
  add(GROUP_SUPPLY, "backlog", "Validation backlog", backlog < 500 ? "good" : backlog < 2500 ? "amber" : "bad",
    `${backlog} awaiting validation`,
    catchAllHeld
      ? `${catchAllHeld.toLocaleString("en-US")} further addresses sit on catch-all domains. Those are decided, not queued: the domain accepts anything, so no mailbox can be proven and they never send. Supply comes from finding better addresses, not from more validating.`
      : backlog >= 500 ? "Drains automatically while the curation tick completes" : "");
  add(GROUP_SUPPLY, "sendable", "Prospects ready to send (all gates applied)", passGates >= 450 ? "good" : passGates >= 100 ? "amber" : "bad",
    `${passGates} sendable now`, `Validated, never contacted, gate-passing. Of the rest: ${gatesNote}`);
}

/* ---------------- Watchers (are the safety nets alive?) ---------------- */
const GROUP_WATCH = "Watchers & fail-safes";

function unitProps(unit) {
  const out = execFileSync("systemctl", ["show", unit, "-p", "LastTriggerUSec,Result,ActiveState,SubState,ExecMainStatus,Id"], { encoding: "utf8" });
  const props = {};
  for (const line of out.split("\n")) { const i = line.indexOf("="); if (i > 0) props[line.slice(0, i)] = line.slice(i + 1); }
  return props;
}
const TIMERS = [
  ["mpc-daily.timer", "Daily send rota", 26 * 60],
  ["recruiteros-sending-health.timer", "Hourly sending health", 2 * 60],
  ["mpc-ndr-sweep.timer", "Bounce sweep (4-hourly)", 5 * 60],
  ["mpc-monitor.timer", "Reply monitor bridge", 3 * 60],
  ["email-validate-batch.timer", "Nightly bulk validation", 26 * 60],
  ["mpc-seed-test.timer", "Weekly seed placement test", 8 * 24 * 60],
  ["recruiteros-signals-watch.timer", "Signal watchlists (q15m)", 60],
  ["fleet-verify.timer", "Daily fleet verification", 26 * 60],
  ["recruiteros-numbers.timer", "Daily numbers pass + audit", 26 * 60],
  ["system-health.timer", "This health collector", 45],
];
for (const [unit, label, staleMin] of TIMERS) {
  try {
    const t = unitProps(unit);
    if (!t.Id) throw new Error("unit not found");
    const s = unitProps(unit.replace(/\.timer$/, ".service"));
    const enabled = t.ActiveState === "active";
    const running = s.ActiveState === "activating" || s.ActiveState === "active";
    const trig = t.LastTriggerUSec && t.LastTriggerUSec !== "n/a" ? Date.parse(t.LastTriggerUSec.replace(/^[A-Za-z]{3} /, "")) : NaN;
    const mins = Number.isFinite(trig) ? Math.round((now - trig) / 60000) : null;
    const failed = !running && s.Result && s.Result !== "success";
    const stale = mins == null || mins > staleMin;
    add(GROUP_WATCH, unit, label,
      !enabled ? "bad" : failed ? "bad" : running ? "good" : stale ? "amber" : "good",
      !enabled ? "timer not active" :
      running ? `running now (triggered ${fmtAge(mins)})` :
      mins == null ? "never run yet" :
      `last run ${fmtAge(mins)}${failed ? `, FAILED (${s.Result})` : ", ok"}`,
      failed ? "Last run exited with an error: journalctl -u " + unit.replace(/\.timer$/, ".service") :
      !running && stale && enabled ? "Overdue for its cadence" : "");
  } catch {
    add(GROUP_WATCH, unit, label, unit === "system-health.timer" || unit === "mpc-seed-test.timer" ? "amber" : "bad",
      "not installed", "Install the timer to activate this layer");
  }
}

// Snapshot freshness: the data the breaker and follow-ups act on.
add(GROUP_WATCH, "ndr-fresh", "Bounce data freshness", !ndr ? "bad" : ageMin(ndr.generatedAt) <= 360 ? "good" : "bad",
  ndr ? `swept ${fmtAge(ageMin(ndr.generatedAt))}` : "never", "Stale bounce data means the circuit breaker is flying blind");

// Health guard + warm graduation heartbeat: the layer that auto-activates ready inboxes
// and benches sick ones. Runs from the hourly sending cron.
{
  const g = readJson(`${VOL}/snap_sender_health_guard_v1.json`);
  const rep = g?.lastReport;
  const age = rep ? ageMin(rep.at) : null;
  const hasGrad = !!rep && Object.prototype.hasOwnProperty.call(rep, "graduated");
  const st = !rep ? "bad" : age > 12 * 60 ? "bad" : age > 3 * 60 ? "amber" : "good";
  add(GROUP_WATCH, "graduation", "Health guard + warm graduation", st,
    rep ? `last run ${fmtAge(age)} · ${rep.holding ?? 0} on hold · ${(rep.graduated || []).length} graduated last run` : "never ran",
    !rep ? "Guard has never persisted a report" :
    !hasGrad ? "App predates the graduation feature: redeploy the app" :
    "Warming boxes auto-activate at 14d (provider) / 30d (internal) once reputation holds 95%+");
}

// Daily fleet verification results (the Fleet tab's data).
{
  const fleet = readJson(`${VOL}/snap_fleet_verify_v1.json`);
  const fAge = fleet ? ageMin(fleet.generatedAt) : null;
  const dU = fleet?.domainSummary?.unhealthy || 0, mU = fleet?.mailboxSummary?.unhealthy || 0;
  add(GROUP_WATCH, "fleet", "Fleet verification results",
    !fleet ? "amber" : fAge > 26 * 60 ? "bad" : dU + mU > 0 ? "amber" : "good",
    !fleet ? "never run" : `${dU} domains + ${mU} mailboxes unhealthy, swept ${fmtAge(fAge)}`,
    !fleet ? "Run once or install fleet-verify.timer" : dU + mU > 0 ? "Open the Fleet tab for each asset's reason and fix" : "");

  // Google warm-up pool (Zapmail) health, from the same daily verification.
  const w = fleet?.warmup;
  if (w) {
    const notWarming = w.summary?.unhealthy || 0;
    add(GROUP_SEND, "warmpool", "Google warm-up pool (Zapmail)",
      notWarming > 0 ? "bad" : (w.summary?.warning || 0) > 0 ? "amber" : "good",
      `${w.summary?.healthy || 0}/${w.poolSize} warming`,
      notWarming > 0 ? `${notWarming} fell out of warm-up: Fleet tab has the box list and fix` : `${w.byConn?.oauth || 0} via OAuth, ${w.byConn?.appPassword || 0} via app-password`);
  }
}

// Reply bridge: the monitor log is written as it scans, so its mtime is the honest heartbeat.
{
  const logs = readdirSync(MPC_OUT).filter((n) => /^monitor-.*\.log$/.test(n)).sort();
  const newest = logs[logs.length - 1];
  const mtimeMin = newest ? Math.round((now - statSync(`${MPC_OUT}/${newest}`).mtimeMs) / 60000) : null;
  add(GROUP_WATCH, "replies", "Reply bridge heartbeat", mtimeMin == null ? "bad" : mtimeMin <= 120 ? "good" : "amber",
    mtimeMin == null ? "no monitor log" : `scanning, last activity ${fmtAge(mtimeMin)}`,
    "Reads every sending box for replies; a full pass takes 40-60 min under API rate limits");
}

/* ---------------- API credits & providers ---------------- */
const GROUP_API = "API credits & providers";

async function probe(name, id, fn, readingOnOk) {
  try { const r = await fn(); add(GROUP_API, id, name, r.status, r.reading ?? readingOnOk, r.detail || ""); }
  catch (e) { add(GROUP_API, id, name, "bad", "unreachable", String(e.message || e).slice(0, 120)); }
}

const SENDING_KEY = envVal("SENDINGAC_MAILBOX_API_KEY");
const REOON_KEY = envVal("REOON_API_KEY");
const SMARTLEAD_KEY = envVal("SMARTLEAD_API_KEY");

await probe("Sending.ac mailbox API", "sendingac", async () => {
  if (!SENDING_KEY) return { status: "bad", reading: "no key configured" };
  const r = await fetch("https://api.customers.ac/api/mailbox/v1alpha1/azure/v1.0/users/" + encodeURIComponent("nead.ryan@lumepeople.com") + "/mailFolders",
    { headers: { Authorization: "Bearer " + SENDING_KEY }, signal: AbortSignal.timeout(15000) });
  return r.ok ? { status: "good", reading: "reachable, authenticated" } : { status: "bad", reading: `HTTP ${r.status}`, detail: "Sends and the bounce sweep both depend on this API" };
});

await probe("Reoon validation credits", "reoon", async () => {
  if (!REOON_KEY) return { status: "bad", reading: "no key configured" };
  const r = await fetch(`https://emailverifier.reoon.com/api/v1/check-account-balance/?key=${encodeURIComponent(REOON_KEY)}`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) return { status: "amber", reading: `balance HTTP ${r.status}`, detail: "Key may be fine; watch validated-24h instead" };
  const d = await r.json();
  const instant = Number(d.remaining_instant_credits);
  const daily = Number(d.remaining_daily_credits);
  if (!Number.isFinite(instant)) return { status: "amber", reading: "balance response unrecognized", detail: JSON.stringify(d).slice(0, 100) };
  return {
    status: instant < 500 ? "bad" : instant < 5000 ? "amber" : "good",
    reading: `${instant.toLocaleString("en-US")} instant credits (+${Number.isFinite(daily) ? daily.toLocaleString("en-US") : "?"} daily)`,
    detail: instant < 5000 ? "Running low: validation stops when credits hit zero" : "",
  };
});

await probe("Smartlead warm-up API", "smartlead", async () => {
  if (!SMARTLEAD_KEY) return { status: "amber", reading: "no key configured" };
  const r = await fetch(`https://server.smartlead.ai/api/v1/email-accounts/?api_key=${SMARTLEAD_KEY}&offset=0&limit=1`, { signal: AbortSignal.timeout(15000) });
  return r.ok ? { status: "good", reading: "reachable, authenticated" } : { status: "bad", reading: `HTTP ${r.status}`, detail: "Warm-up reputation readings depend on this API" };
});

/* ---------------- company-size coverage (feeds the 100-1,000 employee send gate) --------------
 * That gate FAILS CLOSED: a company whose headcount we have not confirmed is held out of the
 * batch. So coverage of the size cache IS sendable volume, and a stalled resolver looks exactly
 * like "the pipeline dried up". Watch it directly. */
{
  const curated = readJson(`${VOL}/snap_inmarket_curation_v1.json`) || [];
  const sizes = readJson(`${VOL}/snap_inmarket_company_size_v1.json`) || {};
  const cache = sizes.data || sizes;
  const cos = new Set();
  for (const r of Array.isArray(curated) ? curated : []) {
    const c = String(r.company || "").toLowerCase().trim();
    if (c) cos.add(c);
  }
  let confirmed = 0, inBand = 0;
  const MINH = Number(envVal("MPC_MIN_HEADCOUNT") || 100), MAXH = Number(envVal("MPC_MAX_HEADCOUNT") || 1000);
  for (const c of cos) {
    const e = cache[c];
    if (e && typeof e.count === "number" && e.count > 0) { confirmed++; if (e.count >= MINH && e.count <= MAXH) inBand++; }
  }
  const covPct = cos.size ? Math.round((100 * confirmed) / cos.size) : 0;
  // Below ~40% coverage the gate is holding most of the pool for want of a number, not for cause.
  const status = cos.size === 0 ? "amber" : covPct >= 60 ? "good" : covPct >= 40 ? "amber" : "bad";
  add(GROUP_SUPPLY, "company-size-coverage", "Company size resolved (100-1,000 gate)", status,
    `${confirmed}/${cos.size} companies (${covPct}%), ${inBand} in band`,
    status === "good" ? "" : "The send gate fails closed on unconfirmed size, so low coverage starves volume. Run tools/company-size.mjs (step 0.93 of mpc-daily.sh).");
}

for (const [key, label] of [["ANTHROPIC_API_KEY", "Anthropic key (email writer)"], ["RESEND_API_KEY", "Resend key (owner alerts)"], ["PORKBUN_API_KEY", "Porkbun key (DNS auto-fix)"], ["SERPER_API_KEY", "Serper key (company-size resolver)"]]) {
  add(GROUP_API, key, label, envVal(key) ? "good" : "amber", envVal(key) ? "configured" : "missing",
    envVal(key) ? "" : "The dependent automation silently skips its job without this");
}

/* ---------------- voicemail-drop readiness (role VM on email send) ---------------- */
// The email -> voicemail follow-up has three independent prerequisites, and when any one is
// missing the automation refuses to queue rather than leaving SILENCE on a prospect's mailbox.
// That refusal is correct but invisible, which is exactly the silent-failure shape this board
// exists to catch — so each prerequisite is its own row with the fix in the detail.
try {
  const vd = readJson(`${VOL}/snap_voice_drops.json`) || {};
  const creds = readJson(`${VOL}/snap_integration_credentials_v1.json`) || {};
  const settings = vd.settings || {};
  const consent = (vd.consent || []).filter((c) => c && c.voiceId);

  // Which workspaces actually matter: those the pipeline enrolls into.
  const core = readJson(`${VOL}/snap_core.json`) || {};
  const prospects = (core.prospects || []).map((e) => (Array.isArray(e) ? e[1] : e)).filter(Boolean);
  const counts = {};
  for (const pr of prospects) if (pr.workspaceId) counts[pr.workspaceId] = (counts[pr.workspaceId] || 0) + 1;
  const primary = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const ws = primary ? primary[0] : "";

  // 1. a usable voice for the workspace that owns the prospects
  const mine = consent.filter((c) => c.workspaceId === ws);
  const prov = (settings[ws] || {}).activeProvider || "elevenlabs";
  const usable = mine.filter((c) => (c.provider || "elevenlabs") === prov);
  add(GROUP_API, "role-vm-voice", "Voicemail drop: a voice to speak with",
    usable.length ? "good" : "bad",
    usable.length ? `${usable.length} ${prov} voice(s)` : `none for ${ws || "(no workspace)"}`,
    usable.length ? "" : `No cloned ${prov} voice on the workspace holding ${primary ? primary[1] : 0} prospects, so every role voicemail would render as SILENCE and is refused (reason no_voice). Record a voice in Voice Drops to start the follow-ups.`);

  // 2. the TTS credential behind it
  const hasKey = Object.keys(((creds[ws] || {}).integrations || {}).elevenlabs?.keys || {}).length > 0;
  add(GROUP_API, "role-vm-tts-key", "Voicemail drop: TTS credential",
    hasKey ? "good" : "bad", hasKey ? "configured" : "missing",
    hasKey ? "" : "No ElevenLabs credential on the prospect workspace; synthesis cannot run.");

  // 3. the on-send trigger itself
  const on = /^(1|true|yes|on)$/i.test(envVal("RECRUITEROS_ROLE_VM_ON_SEND"));
  add(GROUP_API, "role-vm-on-send", "Voicemail drop: follow-up on email send",
    on ? "good" : "amber", on ? "armed" : "off",
    on ? "Every email sent stages a role voicemail; dialing still waits for an admin to start the queue."
       : "RECRUITEROS_ROLE_VM_ON_SEND is unset, so emails do not stage a voicemail follow-up.");
} catch { /* never let a readiness probe break the collector */ }

/* ---------------- Numbers & tracking ---------------- */
// Every figure the portal shows is a claim about data that lives somewhere else. tools/numbers-
// audit.mjs re-derives those claims from the ledgers once a day and records where they disagree;
// this surfaces its verdict on the board so a wrong number is as visible as a dead timer. Born
// out of the 2026-08-20 fault where the Dashboard showed "0 replies" against nine real ones and
// refreshed punctually the whole time, so nothing else on this board noticed.
const GROUP_NUM = "Numbers & tracking";
{
  const audit = readJson(`${VOL}/snap_numbers_audit_v1.json`);
  const age = audit ? ageMin(audit.generatedAt) : null;
  if (!audit) {
    add(GROUP_NUM, "numbers-audit", "Portal numbers audited against their source", "bad", "never run",
      "recruiteros-numbers.timer has not produced an audit. No portal figure is being checked against the ledger under it.");
  } else if (age == null || age > 2 * 1440) {
    add(GROUP_NUM, "numbers-audit", "Portal numbers audited against their source", "bad", `last audit ${fmtAge(age)}`,
      "The daily numbers pass has stopped. Check recruiteros-numbers.timer.");
  } else {
    // One row per finding, so the board names the exact surface that is lying rather than a score.
    const map = { ok: "good", warn: "amber", bad: "bad" };
    for (const f of audit.findings || []) {
      add(GROUP_NUM, `num-${f.id}`, f.surface, map[f.status] || "amber", f.reading, f.detail || "");
    }
    add(GROUP_NUM, "numbers-audit", "Portal numbers audited against their source",
      audit.verdict === "bad" ? "bad" : audit.verdict === "warn" ? "amber" : "good",
      `${(audit.summary || {}).ok || 0} agree / ${(audit.summary || {}).warn || 0} drifting / ${(audit.summary || {}).bad || 0} wrong, checked ${fmtAge(age)}`,
      audit.verdict === "ok" ? "" : "A figure on the portal does not match the data underneath it; read the rows above before trusting it.");
  }
}

/* ---------------- write ---------------- */
const summary = { good: checks.filter((c) => c.status === "good").length, amber: checks.filter((c) => c.status === "amber").length, bad: checks.filter((c) => c.status === "bad").length };
const out = { generatedAt: new Date().toISOString(), summary, groups: [GROUP_SEND, GROUP_SUPPLY, GROUP_WATCH, GROUP_NUM, GROUP_API], checks };
const tmp = OUT_FILE + ".tmp";
writeFileSync(tmp, JSON.stringify(out, null, 1));
renameSync(tmp, OUT_FILE);
console.log(`system health: ${summary.good} good / ${summary.amber} amber / ${summary.bad} bad (${checks.length} checks)`);
