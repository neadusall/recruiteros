'use strict';
/* Lume Search Partners — jobs + applications backend.
 *
 * Zero npm dependencies (Node built-ins only) so it builds fast and has no
 * supply-chain surface. Caddy proxies only /api/* on lumesp.com to this service;
 * the rest of the marketing site stays static. Data is persisted as JSON files
 * on a Docker named volume so jobs/applications survive every redeploy.
 *
 * Auth: a single shared team username/password (env) issues an HMAC-signed,
 * HttpOnly session cookie. Read endpoints (job list, single job, apply) are
 * public; create/delete and the applications inbox require the cookie.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.LUME_DATA_DIR || process.env.ROS_DATA_DIR || '/data';
const SEED_FILE = path.join(__dirname, 'seed', 'jobs.json');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const APPS_FILE = path.join(DATA_DIR, 'applications.json');

const USER = process.env.LUME_JOBS_USER || 'lume';
const PASS = process.env.LUME_JOBS_PASS || 'lume-admin';
// Secret used to sign session cookies. Falls back to a value derived from the
// password so sessions are still tamper-proof if the operator forgets to set it
// (changing the password then invalidates old sessions, which is fine).
const SECRET = process.env.LUME_JOBS_SECRET || crypto.createHash('sha256').update('lume::' + PASS).digest('hex');
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
// Email notification of each application/inquiry. Primary path is Resend, reusing
// the main app's RESEND_API_KEY from .env.production. The sender MUST be a Lume
// address — these are lumesp.com leads, so they go out from lumesp.com, NOT the
// shared recruitersos EMAIL_FROM. Override with LUME_EMAIL_FROM if needed; the
// lumesp.com domain must be a verified sending domain in Resend. Web3Forms is an
// optional fallback.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.LUME_EMAIL_FROM || 'Lume Search Partners <no-reply@lumesp.com>';
const WEB3FORMS_KEY = process.env.LUME_WEB3FORMS_KEY || '';
// Who receives the lead alerts (comma-separated). Applications + SMS opt-ins go
// to Ryan, who owns intake and the 10DLC consent records. Override with
// LUME_NOTIFY_EMAILS to add/replace recipients.
const NOTIFY_EMAILS = (process.env.LUME_NOTIFY_EMAILS || 'ryan@lumesp.com')
  .split(',').map(function (s) { return s.trim(); }).filter(Boolean);

/* ----------------------------------------------------------------- storage -- */
function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJSON(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file); // atomic-ish: never leave a half-written file
}

// First boot: import the bundled seed jobs into the data volume.
function loadJobs() {
  let jobs = readJSON(JOBS_FILE, null);
  if (!Array.isArray(jobs)) {
    const seed = readJSON(SEED_FILE, []);
    const base = 1700000000000; // fixed base so order is deterministic across boots
    jobs = seed.map((j, i) => normalizeJob({
      ...j,
      // Preserve seed order with newest-first sorting: earlier seed = larger ts.
      createdAt: base + (seed.length - i) * 1000,
      updatedAt: base + (seed.length - i) * 1000,
    }));
    writeJSON(JOBS_FILE, jobs);
  }
  return jobs;
}
function saveJobs(jobs) { writeJSON(JOBS_FILE, jobs); }
function loadApps() { return readJSON(APPS_FILE, []); }
function saveApps(apps) { writeJSON(APPS_FILE, apps); }

/* -------------------------------------------------------------- job shape -- */
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[''"]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || ('role-' + Date.now());
}
function asArray(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (v == null) return [];
  return String(v).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}
function normalizeJob(input) {
  const summary = asArray(input.summary);
  let sections = Array.isArray(input.sections)
    ? input.sections
        .map((s) => ({ heading: String(s.heading || '').trim(), items: asArray(s.items) }))
        .filter((s) => s.items.length)
    : [];
  // Portal convenience: a flat "responsibilities" list becomes one section.
  if (!sections.length && input.responsibilities) {
    const items = asArray(input.responsibilities);
    if (items.length) sections = [{ heading: 'Responsibilities', items }];
  }
  return {
    id: String(input.id || slugify(input.title)),
    title: String(input.title || '').trim(),
    category: String(input.category || '').trim(),
    location: String(input.location || '').trim(),
    salary: String(input.salary || '').trim(),
    summary,
    sections,
    createdAt: input.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
}
function validJob(j) {
  return j.title && j.category && j.location;
}

/* ----------------------------------------------------------------- session -- */
function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}
function makeToken() {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ u: USER, exp })).toString('base64url');
  return payload + '.' + sign(payload);
}
function verifyToken(token) {
  if (!token || token.indexOf('.') === -1) return false;
  const [payload, mac] = token.split('.');
  if (sign(payload) !== mac) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.exp > Date.now() ? data : false;
  } catch (_) { return false; }
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function isAuthed(req) {
  return !!verifyToken(parseCookies(req).lume_session);
}
function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* ------------------------------------------------------------------ helpers -- */
function send(res, status, body, headers) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }, headers || {}));
  res.end(payload);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''; let tooBig = false;
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { tooBig = true; req.destroy(); } // 1MB cap
    });
    req.on('end', () => {
      if (tooBig) return reject(new Error('payload too large'));
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (_) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}
async function forwardApplication(app) {
  if (typeof fetch !== 'function') return;
  const subject = 'New application: ' + (app.jobTitle || 'Open role') + ' — lumesp.com';
  const consentLine = app.smsConsent
    ? 'SMS consent: YES — opted in to text messages'
    : 'SMS consent: no';
  const lines = [
    'Role: ' + (app.jobTitle || '—'),
    'Name: ' + (app.name || '—'),
    'Email: ' + (app.email || '—'),
    'Phone: ' + (app.phone || '—'),
    'Company: ' + (app.company || '—'),
    consentLine,
    '',
    (app.message || '(no message)'),
    '',
    'Submitted via lumesp.com' + (app.source ? ' (' + app.source + ')' : ''),
  ];
  if (app.smsConsent) {
    // 10DLC proof of consent: timestamped, with the exact language agreed to.
    lines.push(
      '',
      '— SMS opt-in record (10DLC) —',
      'Opted in at: ' + new Date(app.createdAt || Date.now()).toISOString(),
      'Opt-in page: ' + (app.consentUrl || app.source || '—'),
      'Consent shown: ' + (app.consentText || '(language not captured)')
    );
  }
  const body = lines.join('\n');

  // Primary: Resend to Josh + Ryan, reply-to the applicant so they can answer directly.
  if (RESEND_API_KEY && NOTIFY_EMAILS.length) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: EMAIL_FROM,
          to: NOTIFY_EMAILS,
          reply_to: app.email || undefined,
          subject: subject,
          text: body,
          html: body.split('\n').map(function (l) {
            return l ? l.replace(/&/g, '&amp;').replace(/</g, '&lt;') : '';
          }).join('<br>'),
        }),
      });
      if (res.ok) return;
      console.error('[email] Resend failed ' + res.status + ': ' + (await res.text().catch(function () { return ''; })));
    } catch (e) { console.error('[email] Resend error: ' + (e && e.message)); }
  }

  // Fallback: Web3Forms (only if configured).
  if (WEB3FORMS_KEY) {
    try {
      await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          access_key: WEB3FORMS_KEY,
          subject: subject,
          to: NOTIFY_EMAILS.join(','),
          from_name: app.name || 'Applicant',
          replyto: app.email || '',
          Role: app.jobTitle || '', Name: app.name || '', Email: app.email || '',
          Company: app.company || '', Phone: app.phone || '', Message: app.message || '',
          SMS_Consent: app.smsConsent ? 'YES — opted in' : 'no',
          Consent_Shown: app.smsConsent ? (app.consentText || '') : '',
          Opt_In_Page: app.smsConsent ? (app.consentUrl || '') : '',
        }),
      });
    } catch (_) { /* best-effort; the record is already stored in the portal */ }
  }
}

/* -------------------------------------------------------------------- routes -- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method;

  try {
    if (p === '/api/health') return send(res, 200, { ok: true });

    /* ---- auth ---- */
    if (p === '/api/login' && method === 'POST') {
      const b = await readBody(req);
      const ok = timingSafeEqual(b.username || '', USER) && timingSafeEqual(b.password || '', PASS);
      if (!ok) return send(res, 401, { error: 'Invalid username or password.' });
      const cookie = 'lume_session=' + makeToken() +
        '; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000);
      return send(res, 200, { ok: true, username: USER }, { 'Set-Cookie': cookie });
    }
    if (p === '/api/logout' && method === 'POST') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'lume_session=; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=0' });
    }
    if (p === '/api/me') {
      return send(res, 200, { authed: isAuthed(req), username: isAuthed(req) ? USER : null });
    }

    /* ---- public reads ---- */
    if (p === '/api/jobs' && method === 'GET') {
      const id = url.searchParams.get('id');
      const jobs = loadJobs().slice().sort((a, b) => b.createdAt - a.createdAt);
      if (id) {
        const job = jobs.find((j) => j.id === id);
        return job ? send(res, 200, { job }) : send(res, 404, { error: 'Not found' });
      }
      return send(res, 200, { jobs });
    }
    // /api/jobs/<id>
    if (p.startsWith('/api/jobs/') && method === 'GET') {
      const id = decodeURIComponent(p.slice('/api/jobs/'.length));
      const job = loadJobs().find((j) => j.id === id);
      return job ? send(res, 200, { job }) : send(res, 404, { error: 'Not found' });
    }

    /* ---- applications (public create) ---- */
    if (p === '/api/apply' && method === 'POST') {
      const b = await readBody(req);
      if (!b.name || !b.email) return send(res, 400, { error: 'Name and email are required.' });
      const app = {
        id: crypto.randomUUID(),
        jobId: String(b.jobId || '').trim(),
        jobTitle: String(b.jobTitle || '').trim(),
        name: String(b.name || '').trim().slice(0, 200),
        email: String(b.email || '').trim().slice(0, 200),
        company: String(b.company || '').trim().slice(0, 200),
        phone: String(b.phone || '').trim().slice(0, 80),
        message: String(b.message || '').trim().slice(0, 5000),
        // SMS / 10DLC consent record. We store the boolean plus the exact
        // disclosure language the applicant agreed to and the page URL, which
        // together are the auditable proof of express written consent.
        smsConsent: b.smsConsent === true || b.smsConsent === 'yes' || b.smsConsent === 'true',
        consentText: String(b.consentText || '').trim().slice(0, 2000),
        consentUrl: String(b.consentUrl || '').trim().slice(0, 300),
        source: String(b.source || '').trim().slice(0, 200),
        createdAt: Date.now(),
      };
      const apps = loadApps();
      apps.push(app);
      saveApps(apps);
      forwardApplication(app); // fire-and-forget email
      return send(res, 200, { ok: true });
    }

    /* ---- everything below requires auth ---- */
    if (p === '/api/jobs' && method === 'POST') {
      if (!isAuthed(req)) return send(res, 401, { error: 'Not authorized' });
      const b = await readBody(req);
      const jobs = loadJobs();
      const editingId = b.id ? String(b.id) : '';
      const existing = editingId ? jobs.find((j) => j.id === editingId) : null;
      const job = normalizeJob(Object.assign({}, b, {
        id: existing ? existing.id : slugifyUnique(b.title, jobs),
        createdAt: existing ? existing.createdAt : Date.now(),
      }));
      if (!validJob(job)) return send(res, 400, { error: 'Title, category and location are required.' });
      const next = existing ? jobs.map((j) => (j.id === existing.id ? job : j)) : jobs.concat([job]);
      saveJobs(next);
      return send(res, 200, { ok: true, job });
    }
    if (p.startsWith('/api/jobs/') && method === 'DELETE') {
      if (!isAuthed(req)) return send(res, 401, { error: 'Not authorized' });
      const id = decodeURIComponent(p.slice('/api/jobs/'.length));
      const jobs = loadJobs();
      const next = jobs.filter((j) => j.id !== id);
      if (next.length === jobs.length) return send(res, 404, { error: 'Not found' });
      saveJobs(next);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/applications' && method === 'GET') {
      if (!isAuthed(req)) return send(res, 401, { error: 'Not authorized' });
      const apps = loadApps().slice().sort((a, b) => b.createdAt - a.createdAt);
      return send(res, 200, { applications: apps });
    }
    if (p.startsWith('/api/applications/') && method === 'DELETE') {
      if (!isAuthed(req)) return send(res, 401, { error: 'Not authorized' });
      const id = decodeURIComponent(p.slice('/api/applications/'.length));
      const apps = loadApps();
      const next = apps.filter((a) => a.id !== id);
      if (next.length === apps.length) return send(res, 404, { error: 'Not found' });
      saveApps(next);
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    return send(res, 400, { error: err.message || 'Bad request' });
  }
});

function slugifyUnique(title, jobs) {
  let base = slugify(title);
  let id = base; let n = 2;
  const taken = new Set(jobs.map((j) => j.id));
  while (taken.has(id)) { id = base + '-' + n; n++; }
  return id;
}

ensureDataDir();
loadJobs(); // seed on first boot
server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log('lume-jobs listening on :' + PORT + ' (data dir ' + DATA_DIR + ')');
});
