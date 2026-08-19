// Checks where the seed-test emails landed in each Gmail seed box: INBOX vs Spam.
// Raw IMAP over TLS, no dependencies. Runs on the ros host: node /tmp/imap-check.mjs
// Also writes /data/snap_mpc_placement_v1.json (via the docker volume path): the volume
// ramp governor and the Gmail placement gate in batch.mjs read it, so running this test
// is what unlocks volume growth and re-opens google-hosted sending after a failure.
import tls from "node:tls";
import { writeFileSync, renameSync } from "node:fs";

const PLACEMENT_FILE = process.env.MPC_PLACEMENT_FILE
  || "/var/lib/docker/volumes/recruiteros_app_data/_data/snap_mpc_placement_v1.json";

const SEEDS = [
  { email: "sam@lumesearchgroupmusic.com", pass: "jves sopm yrxs csbu" },
  { email: "noah@artlumesearchgroup.com", pass: "auqz oefo pues nthk" },
  { email: "josh@lumesearchgroupmusic.com", pass: "aswd zbht kirh gqci" },
  { email: "ryan@newlumesearchgroup.com", pass: "digd gunj mmrd dgks" },
];
const SENDERS = [
  "rnead@lumerecruiters.com",
  "nead.r@lumetalentsearch.com",
  "ryan.nead@lumesearchgroup.com",
  "ryann@lumeplacement.com",
  "ryan.nead@lumeprofessional.com",
  "rn@lumepeople.com",
];
const d = new Date();
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const SINCE = `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;

function imapSession(user, pass) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect(993, "imap.gmail.com", { servername: "imap.gmail.com" });
    let buf = "", tagN = 0, handlers = [];
    sock.on("data", (c) => {
      buf += c.toString("utf8");
      if (handlers.length) {
        const h = handlers[0];
        if (new RegExp(`^${h.tag} (OK|NO|BAD)`, "m").test(buf)) {
          const out = buf; buf = "";
          handlers.shift();
          h.resolve(out);
        }
      }
    });
    sock.on("error", reject);
    const cmd = (c) => new Promise((res) => {
      const tag = "A" + ++tagN;
      handlers.push({ tag, resolve: res });
      sock.write(`${tag} ${c}\r\n`);
    });
    setTimeout(async () => {
      try {
        await cmd(`LOGIN ${user} "${pass}"`);
        resolve({ cmd, end: () => sock.end() });
      } catch (e) { reject(e); }
    }, 800);
  });
}

const rows = [];
for (const seed of SEEDS) {
  try {
    const s = await imapSession(seed.email, seed.pass);
    for (const [label, folder] of [["INBOX", "INBOX"], ["SPAM", "[Gmail]/Spam"]]) {
      await s.cmd(`EXAMINE "${folder}"`);
      for (const from of SENDERS) {
        const r = await s.cmd(`UID SEARCH FROM "${from}" SINCE ${SINCE}`);
        const m = r.match(/\* SEARCH([ \d]*)/);
        const hits = m && m[1].trim() ? m[1].trim().split(/\s+/).length : 0;
        if (hits) rows.push({ seed: seed.email, from, folder: label, hits });
      }
    }
    s.end();
    console.error(`checked ${seed.email}`);
  } catch (e) { rows.push({ seed: seed.email, error: String(e.message || e).slice(0, 100) }); }
}

const summary = {};
const gmail = { inbox: 0, spam: 0 };
for (const r of rows.filter((x) => !x.error)) {
  const dom = r.from.split("@")[1];
  summary[dom] = summary[dom] || { inbox: 0, spam: 0 };
  const slot = r.folder === "INBOX" ? "inbox" : "spam";
  summary[dom][slot] += r.hits;
  gmail[slot] += r.hits;
}
console.log(JSON.stringify({ SINCE, gmail, perDomain: summary, detail: rows }, null, 1));

// Feed the governor + placement gate in batch.mjs. Atomic write; fail-open with a warning.
try {
  const tmp = PLACEMENT_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify({ checkedAt: new Date().toISOString(), source: "gmail-seed-test", gmail, perDomain: summary }, null, 1));
  renameSync(tmp, PLACEMENT_FILE);
  console.error(`placement sidecar written: ${PLACEMENT_FILE}`);
} catch (e) {
  console.error(`WARNING: could not write placement sidecar (${e.message}); the volume ramp stays at base until it exists`);
}
