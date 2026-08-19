#!/usr/bin/env node
/**
 * zapmail-alert.mjs : the ros half of the Zapmail fleet monitor.
 *
 * The local machine holds the mailbox app passwords, so it does the SMTP
 * truth-check and drops a secret-free status file here (zapmail-status.json:
 * counts, per-mailbox state, and a pre-rendered digest). This script owns the
 * two things ros is better at: it has the Resend key, and it is always on. It
 * reads that status file, and:
 *
 *   - if the file is missing or stale (older than STALE_H hours) it emails the
 *     owner that the check has gone dark, which is itself a failure worth knowing;
 *   - otherwise it diffs the fleet state against the last run and emails on any
 *     change (a box stops sending, recovers, or an app password gets rejected);
 *   - and it sends one plain digest a day even when nothing changed, so the
 *     fleet is never silently assumed healthy.
 *
 * Runs from a systemd timer. Secrets come from /opt/recruiteros/.env.production
 * via the unit's EnvironmentFile. No npm dependencies.
 *
 *   node zapmail-alert.mjs          normal run
 *   node zapmail-alert.mjs --digest force the digest email
 *   node zapmail-alert.mjs --test   send one delivery-check email
 */
import https from 'node:https';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

// Load secrets from the RecruitersOS env file the same way systemd would, but
// without shell word-splitting (values here contain spaces and <>). Only fills
// keys not already set, so the systemd EnvironmentFile still wins if present.
(function loadEnvFile() {
  const p = process.env.ZAPMAIL_ENV_FILE || '/opt/recruiteros/.env.production';
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
})();

const ARGV = process.argv.slice(2);
const FORCE_DIGEST = ARGV.includes('--digest');
const TEST = ARGV.includes('--test');

const STATUS_FILE = process.env.ZAPMAIL_STATUS_FILE || '/opt/recruiteros/tools/zapmail-status.json';
const STATE_DIR = process.env.ZAPMAIL_STATE_DIR || '/var/lib/zapmail-monitor';
const LOG_FILE = process.env.ZAPMAIL_LOG || '/var/log/zapmail-monitor.log';
const OWNER = process.env.ZAPMAIL_ALERT_EMAIL || process.env.RECRUITEROS_NOTIFY_EMAIL || 'neadusall@gmail.com';
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const STALE_H = Number(process.env.ZAPMAIL_STALE_HOURS || 40);
const DIGEST_MIN_GAP_H = 20;

try { mkdirSync(STATE_DIR, { recursive: true }); } catch { /* best effort */ }

function log(line) {
  const msg = `[${new Date().toISOString()}] alert: ${line}`;
  console.log(msg);
  try { writeFileSync(LOG_FILE, msg + '\n', { flag: 'a' }); } catch { /* best effort */ }
}
function readState(name, fallback) {
  const p = `${STATE_DIR}/${name}`;
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeStateFile(name, value) { writeFileSync(`${STATE_DIR}/${name}`, JSON.stringify(value, null, 1)); }

function getJson(url, headers = {}) {
  return new Promise((resolve) => {
    https.get(url, { headers }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}
function httpsRequest(opts, body) {
  return new Promise((resolve) => {
    const req = https.request(opts, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e) }));
    if (body) req.write(body);
    req.end();
  });
}
async function resolveFrom() {
  const j = await getJson('https://api.resend.com/domains', { Authorization: `Bearer ${RESEND_KEY}` });
  const domains = (j && j.data) || [];
  const verified = domains.find((d) => d.status === 'verified') || domains[0];
  if (verified && verified.name) return `Zapmail Monitor <alerts@${verified.name}>`;
  return 'Zapmail Monitor <onboarding@resend.dev>';
}
async function sendEmail(subject, text) {
  if (!RESEND_KEY) { log('no RESEND_API_KEY, cannot email'); return false; }
  const from = await resolveFrom();
  const payload = JSON.stringify({ from, to: [OWNER], subject, text });
  const r = await httpsRequest({
    method: 'POST', hostname: 'api.resend.com', path: '/emails',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: `Bearer ${RESEND_KEY}` },
  }, payload);
  const ok = r.status >= 200 && r.status < 300;
  log(`email "${subject}" -> ${ok ? 'sent' : 'FAILED ' + r.status + ' ' + r.body.slice(0, 200)}`);
  return ok;
}

const STATE_WORD = {
  ready: 'sending',
  blocked: 'blocked by Google (needs one web sign-in)',
  badpass: 'app password rejected',
  unreachable: 'unreachable right now',
};
function diff(prev, curr) {
  const emails = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  const regressed = [], recovered = [], newbad = [];
  for (const e of emails) {
    const a = prev[e], b = curr[e];
    if (a === b) continue;
    if (a === 'ready' && b && b !== 'ready') regressed.push(`${e} (${STATE_WORD[b]})`);
    else if (a && a !== 'ready' && b === 'ready') recovered.push(e);
    else if (b === 'badpass' && a !== 'badpass') newbad.push(e);
  }
  const events = [];
  if (recovered.length) events.push(`Recovered and now sending: ${recovered.length} box${recovered.length === 1 ? '' : 'es'} (${recovered.slice(0, 6).join(', ')}${recovered.length > 6 ? ', ...' : ''}).`);
  if (regressed.length) events.push(`Stopped sending: ${regressed.length} box${regressed.length === 1 ? '' : 'es'} (${regressed.slice(0, 6).join(', ')}${regressed.length > 6 ? ', ...' : ''}).`);
  if (newbad.length) events.push(`App password now rejected: ${newbad.join(', ')}.`);
  return events;
}

async function main() {
  if (TEST) {
    const ok = await sendEmail('Zapmail monitor: delivery test', 'This confirms the ros Zapmail alerter can email you. No action needed.');
    process.exit(ok ? 0 : 1);
  }

  const meta = readState('meta.json', { lastDigestEpoch: 0, lastStaleEpoch: 0 });
  const nowEpoch = Date.now();

  // Freshness gate: a missing or old status file means the local probe stopped
  // running, which hides the fleet. Warn once, then every 6h while it stays dark.
  let status = null, ageH = Infinity;
  if (existsSync(STATUS_FILE)) {
    try {
      status = JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
      ageH = (nowEpoch - new Date(status.checkedAt).getTime()) / 3.6e6;
    } catch { status = null; }
  }
  if (!status || ageH > STALE_H) {
    const since = (nowEpoch - (meta.lastStaleEpoch || 0)) / 3.6e6;
    if (since >= 6) {
      await sendEmail(
        'Zapmail monitor is not receiving fresh checks',
        [
          'The Zapmail fleet check has gone quiet.',
          '',
          status ? `The last check was ${ageH.toFixed(0)} hours ago (older than the ${STALE_H}h limit).`
                 : 'No status file has arrived yet.',
          '',
          'The SMTP truth-check runs on the local machine and pushes its result to ros.',
          'If that machine has been off or asleep, the check simply has not run. It will',
          'catch up on the next wake. If this keeps repeating, check the scheduled task',
          'named "ZapmailMonitor" on the local machine.',
        ].join('\n'),
      );
      writeStateFile('meta.json', { ...meta, lastStaleEpoch: nowEpoch });
    } else {
      log(`status stale (${status ? ageH.toFixed(0) + 'h' : 'missing'}); already warned within 6h`);
    }
    return;
  }

  const prev = readState('snapshot.json', null);
  const events = prev ? diff(prev.state, status.state || {}) : [];
  writeStateFile('snapshot.json', { checkedAt: status.checkedAt, state: status.state || {} });

  const hoursSinceDigest = (nowEpoch - (meta.lastDigestEpoch || 0)) / 3.6e6;
  const wantDigest = FORCE_DIGEST || hoursSinceDigest >= DIGEST_MIN_GAP_H;

  if (events.length) {
    const head = [
      'ZAPMAIL FLEET CHANGED SINCE THE LAST CHECK',
      '',
      ...events.map((e) => '  ' + e),
      '',
      `  Now sending ${status.ready} of ${status.total}, blocked ${status.blocked}.`,
      '',
      '---',
      '',
    ].join('\n');
    await sendEmail(`Zapmail fleet changed: ${status.ready}/${status.total} sending`, head + (status.digest || ''));
    writeStateFile('meta.json', { ...meta, lastDigestEpoch: nowEpoch });
  } else if (wantDigest) {
    await sendEmail(`Zapmail fleet daily: ${status.ready}/${status.total} sending`, status.digest || 'No digest text in status file.');
    writeStateFile('meta.json', { ...meta, lastDigestEpoch: nowEpoch });
  } else {
    log(`no change, digest already sent (${hoursSinceDigest.toFixed(1)}h ago); quiet`);
  }
}

main().catch((e) => { log('FATAL ' + (e.stack || e.message)); process.exit(1); });
