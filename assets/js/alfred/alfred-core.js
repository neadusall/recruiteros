/* ============================================================
   Alfred Core, Multi-channel outreach automation engine
   A MeetAlfred-style sequence engine for RecruiterOS.

   Runs unchanged in two environments:
     • Browser , loaded as a classic <script>, attaches window.Alfred
                  (works over file://, no build step, matching RecruiterOS)
     • Node    , require('./alfred-core.js') for tests / a future backend

   Design seams (so this lifts to a real SaaS backend later):
     • Storage  , pluggable backend (localStorage | in-memory | swap for DB)
     • Channels , pluggable adapters (Simulated default | LinkedIn/Email/X)
     • Clock    , every engine op takes an explicit `now`, so time is
                   injectable: tests fast-forward, the UI runs a sim clock,
                   a backend passes the real wall clock.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Alfred = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ============================================================
     0. Constants, MeetAlfred-faithful action surface & limits
     ============================================================ */

  // Channels and the actions each supports (the "scope of work").
  const CHANNELS = {
    linkedin: {
      label: 'LinkedIn',
      icon: '💼',
      actions: {
        view:    { label: 'View profile',        needs: [],            counts: 'view'    },
        follow:  { label: 'Follow',              needs: [],            counts: 'follow'  },
        endorse: { label: 'Endorse skills',      needs: [],            counts: 'endorse' },
        connect: { label: 'Connection request',  needs: ['note?'],     counts: 'connect', opensRelationship: true },
        message: { label: 'Message',             needs: ['body'],      counts: 'message', requiresAccepted: true },
        inmail:  { label: 'InMail',              needs: ['subject', 'body'], counts: 'inmail' },
        like:    { label: 'Like recent post',    needs: [],            counts: 'like'    },
      },
    },
    email: {
      label: 'Email',
      icon: '✉️',
      actions: {
        email: { label: 'Send email', needs: ['subject', 'body'], counts: 'email', tracksOpen: true },
      },
    },
    twitter: {
      label: 'X / Twitter',
      icon: '𝕏',
      actions: {
        tw_follow:  { label: 'Follow',   needs: [],       counts: 'tw_follow'  },
        tw_like:    { label: 'Like',     needs: [],       counts: 'tw_like'    },
        tw_retweet: { label: 'Retweet',  needs: [],       counts: 'tw_retweet' },
        tw_dm:      { label: 'Direct message', needs: ['body'], counts: 'tw_dm', requiresAccepted: false },
      },
    },
  };

  // Conservative per-day caps Alfred ships by default (pre-warmup, full ramp).
  const DEFAULT_DAILY_LIMITS = {
    linkedin: { connect: 20, message: 50, inmail: 10, view: 80, follow: 30, endorse: 20, like: 40 },
    email:    { email: 100 },
    twitter:  { tw_follow: 40, tw_dm: 30, tw_like: 60, tw_retweet: 30 },
  };

  const DEFAULT_SAFETY = {
    warmup:        { enabled: true, startPct: 0.30, rampDays: 14 }, // ramp 30% → 100% over 14 days
    workingHours:  { start: 9, end: 17 },        // 24h clock, account-local
    weekendsOff:   true,
    timezone:      'local',
    randomDelayMin: 8,                            // minutes between consecutive actions
    randomDelayMax: 35,
    speed:         'normal',                       // slow | normal | fast (maps to delays)
    pendingInviteCap: 500,                        // keep pending connection requests under this
    withdrawInviteAfterDays: 21,                  // auto-withdraw stale invites
    weeklyInviteCap: 100,                         // LinkedIn weekly invitation ceiling (hard ~100-200)
    hourlyMax:     12,                            // max actions per rolling hour (anti-burst)
    dailyTotalCap: 130,                           // max total actions/day across ALL types
    maxConsecutiveErrors: 8,                       // auto-pause the account after this many failures in a row
    pauseOnErrors: true,                           // LinkedIn-jail protection
  };

  // One-click safety profiles, following best practices from the major tools.
  // Each sets per-action daily caps AND the safety envelope together.
  const SAFETY_PRESETS = {
    conservative: {
      label: 'Conservative', risk: 'lowest',
      desc: 'Safest. Best for new, cold, or recently restricted accounts.',
      dailyLimits: { connect: 15, message: 35, inmail: 5, view: 50, follow: 15, endorse: 10, like: 25 },
      safety: { warmup: { enabled: true, startPct: 0.20, rampDays: 21 }, workingHours: { start: 9, end: 16 }, weekendsOff: true, randomDelayMin: 25, randomDelayMax: 75, speed: 'slow', pendingInviteCap: 200, withdrawInviteAfterDays: 14, weeklyInviteCap: 80, hourlyMax: 6, dailyTotalCap: 70 },
    },
    balanced: {
      label: 'Balanced', risk: 'low',
      desc: 'Recommended for warmed-up accounts in steady use.',
      dailyLimits: { connect: 25, message: 60, inmail: 10, view: 80, follow: 30, endorse: 20, like: 40 },
      safety: { warmup: { enabled: true, startPct: 0.30, rampDays: 14 }, workingHours: { start: 9, end: 17 }, weekendsOff: true, randomDelayMin: 8, randomDelayMax: 35, speed: 'normal', pendingInviteCap: 500, withdrawInviteAfterDays: 21, weeklyInviteCap: 100, hourlyMax: 12, dailyTotalCap: 130 },
    },
    aggressive: {
      label: 'Aggressive', risk: 'elevated',
      desc: 'Higher volume. Only for old, healthy, Sales Navigator accounts. Watch acceptance rate.',
      dailyLimits: { connect: 40, message: 90, inmail: 15, view: 100, follow: 45, endorse: 30, like: 60 },
      safety: { warmup: { enabled: true, startPct: 0.40, rampDays: 7 }, workingHours: { start: 8, end: 19 }, weekendsOff: false, randomDelayMin: 4, randomDelayMax: 18, speed: 'fast', pendingInviteCap: 800, withdrawInviteAfterDays: 28, weeklyInviteCap: 180, hourlyMax: 22, dailyTotalCap: 240 },
    },
  };
  const SPEED_DELAYS = { slow: [25, 75], normal: [8, 35], fast: [4, 18] };

  function applyPreset(acc, name) {
    const p = SAFETY_PRESETS[name];
    if (!p) return acc;
    acc.dailyLimits = JSON.parse(JSON.stringify(p.dailyLimits));
    acc.safety = Object.assign({}, DEFAULT_SAFETY, JSON.parse(JSON.stringify(p.safety)));
    acc.preset = name;
    return acc;
  }

  const STATUS = {
    enrollment: { ACTIVE: 'active', PAUSED: 'paused', COMPLETED: 'completed', STOPPED: 'stopped', REPLIED: 'replied' },
    campaign:   { DRAFT: 'draft', ACTIVE: 'active', PAUSED: 'paused', ARCHIVED: 'archived' },
    event:      { QUEUED: 'queued', SENT: 'sent', SKIPPED: 'skipped', FAILED: 'failed', ACCEPTED: 'accepted', REPLIED: 'replied', DEFERRED: 'deferred' },
  };

  const DAY = 86400000, HOUR = 3600000, MINUTE = 60000;

  /* ============================================================
     1. Utilities, id, seeded RNG, clone, merge-field render
     ============================================================ */

  let _idSeq = 0;
  function uid(prefix) {
    _idSeq += 1;
    // time + counter + small random, unique without external deps
    return (prefix || 'id') + '_' + Date.now().toString(36) + _idSeq.toString(36) +
      Math.floor(Math.random() * 1e6).toString(36);
  }

  // Mulberry32, small deterministic PRNG so simulations/tests are reproducible.
  function makeRng(seed) {
    let a = seed >>> 0 || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const clone = (o) => JSON.parse(JSON.stringify(o));

  // Personalization: {first_name} {last_name} {full_name} {company} {position}
  // {location} {headline} plus any lead.customFields key. {{spintax|variants}}
  // are resolved with the supplied rng for natural variation.
  function render(template, lead, rng) {
    if (!template) return '';
    const map = {
      first_name: lead.firstName || (lead.fullName || '').split(' ')[0] || 'there',
      last_name:  lead.lastName || '',
      full_name:  lead.fullName || [lead.firstName, lead.lastName].filter(Boolean).join(' '),
      company:    lead.company || 'your company',
      position:   lead.position || lead.headline || '',
      headline:   lead.headline || '',
      location:   lead.location || '',
      email:      lead.email || '',
      unsubscribe_link: lead.unsubscribeUrl || ('https://recruitersos.co/u/' + (lead.id || '')),
      sender_name: lead.senderName || '',
    };
    Object.assign(map, lead.customFields || {});
    let out = String(template)
      // spintax: {{a|b|c}} -> one of a,b,c
      .replace(/\{\{([^}]+)\}\}/g, (_, group) => {
        const opts = group.split('|');
        const r = rng ? rng() : Math.random();
        return opts[Math.floor(r * opts.length)].trim();
      })
      // merge fields: {key}  (with optional |fallback)
      .replace(/\{([a-z0-9_]+)(?:\|([^}]*))?\}/gi, (m, key, fb) => {
        const v = map[key.toLowerCase()];
        return (v != null && v !== '') ? v : (fb != null ? fb : '');
      });
    return out.trim();
  }

  // List unresolved merge fields (used by the UI to flag broken templates).
  function missingFields(template, lead) {
    const used = [];
    String(template || '').replace(/\{([a-z0-9_]+)(?:\|[^}]*)?\}/gi, (m, k) => { used.push(k.toLowerCase()); return m; });
    const known = new Set(['first_name','last_name','full_name','company','position','headline','location','email',
      ...Object.keys(lead && lead.customFields || {})]);
    return [...new Set(used)].filter(k => !known.has(k));
  }

  /* ============================================================
     2. Storage, pluggable persistence backend
     ============================================================ */

  function MemoryStorage() {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(k, String(v)); },
      removeItem: (k) => { m.delete(k); },
    };
  }

  function pickStorage(explicit) {
    if (explicit) return explicit;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('__alfred_probe__', '1');
        localStorage.removeItem('__alfred_probe__');
        return localStorage;
      }
    } catch (_) { /* private mode / node */ }
    return MemoryStorage();
  }

  /* ============================================================
     3. Store, typed collections over a storage backend
     ============================================================ */

  const COLLECTIONS = [
    'workspaces', 'members', 'channelAccounts', 'leads', 'lists',
    'templates', 'campaigns', 'sequences', 'enrollments', 'events',
    'threads', 'blacklist', 'counters',
  ];

  function Store(opts) {
    opts = opts || {};
    const backend = pickStorage(opts.storage);
    const key = opts.namespace || 'alfred:v1';
    let db = load();

    function blank() {
      const o = {};
      COLLECTIONS.forEach(c => { o[c] = []; });
      o.counters = {}; // { 'channelAccountId|YYYY-MM-DD|action': n }
      o.blacklist = { emails: [], domains: [], profileUrls: [], names: [], unsubscribed: [], bounced: [] };
      o.meta = { version: 1, createdAt: Date.now() };
      return o;
    }
    function load() {
      try {
        const raw = backend.getItem(key);
        if (raw) return Object.assign(blank(), JSON.parse(raw));
      } catch (_) {}
      return blank();
    }
    function persist() {
      try { backend.setItem(key, JSON.stringify(db)); } catch (_) {}
      return api;
    }

    const api = {
      _db: () => db,
      reset() { db = blank(); return persist(); },
      save: persist,
      all: (c) => db[c] || [],
      get: (c, id) => (db[c] || []).find(x => x.id === id) || null,
      where: (c, pred) => (db[c] || []).filter(pred),
      insert(c, obj) {
        if (!obj.id) obj.id = uid(c.slice(0, 3));
        db[c].push(obj); persist(); return obj;
      },
      update(c, id, patch) {
        const x = api.get(c, id);
        if (x) { Object.assign(x, patch); persist(); }
        return x;
      },
      remove(c, id) {
        db[c] = (db[c] || []).filter(x => x.id !== id); persist();
      },
      // daily action counters (limit accounting)
      counterKey: (accId, dateStr, action) => accId + '|' + dateStr + '|' + action,
      getCount(accId, dateStr, action) { return db.counters[api.counterKey(accId, dateStr, action)] || 0; },
      bump(accId, dateStr, action, by) {
        const k = api.counterKey(accId, dateStr, action);
        db.counters[k] = (db.counters[k] || 0) + (by == null ? 1 : by);
        persist(); return db.counters[k];
      },
      blacklist: () => db.blacklist,
    };
    return api;
  }

  /* ============================================================
     4. Limits, warm-up, daily caps, working hours, weekends
     ============================================================ */

  function dateStr(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function isWeekend(ts) { const d = new Date(ts).getDay(); return d === 0 || d === 6; }

  function Limits(store) {
    function safety(acc) { return Object.assign({}, DEFAULT_SAFETY, acc.safety || {}); }

    // Effective per-day cap for an action after warm-up ramp.
    function effectiveCap(acc, action, now) {
      const base = (acc.dailyLimits && acc.dailyLimits[action] != null)
        ? acc.dailyLimits[action]
        : (DEFAULT_DAILY_LIMITS[acc.type] || {})[action];
      if (base == null) return Infinity; // unknown action -> uncapped (UI guards real ones)
      const s = safety(acc);
      if (!s.warmup || !s.warmup.enabled) return base;
      const ageDays = Math.max(0, Math.floor((now - (acc.createdAt || now)) / DAY));
      const ramp = Math.min(1, s.warmup.startPct + (1 - s.warmup.startPct) * (ageDays / s.warmup.rampDays));
      return Math.max(1, Math.round(base * ramp));
    }

    function remaining(acc, action, now) {
      const cap = effectiveCap(acc, action, now);
      if (cap === Infinity) return Infinity;
      return Math.max(0, cap - store.getCount(acc.id, dateStr(now), action));
    }

    // Is `now` inside this account's working window? Returns the next allowed
    // timestamp if not (so the engine can defer precisely instead of polling).
    function nextAllowedTime(acc, now) {
      const s = safety(acc);
      let t = now;
      for (let guard = 0; guard < 14; guard++) {          // at most two weeks of skips
        const d = new Date(t);
        const hour = d.getHours();
        if (s.weekendsOff && isWeekend(t)) { t = startOfNextDay(t, s); continue; }
        if (hour < s.workingHours.start) { d.setHours(s.workingHours.start, 0, 0, 0); return d.getTime(); }
        if (hour >= s.workingHours.end) { t = startOfNextDay(t, s); continue; }
        return t; // inside the window
      }
      return t;
    }
    function startOfNextDay(ts, s) {
      const d = new Date(ts); d.setDate(d.getDate() + 1);
      d.setHours(s.workingHours.start, 0, 0, 0); return d.getTime();
    }

    // Pending (sent, not-yet-accepted) connection invites for an account.
    function pendingInvites(acc) {
      return store.where('enrollments', e =>
        e._channelAccountId === acc.id && e.connectionSent && !e.connectionAccepted &&
        e.status !== STATUS.enrollment.STOPPED).length;
    }

    function randomDelayMs(acc, rng) {
      const s = safety(acc);
      let lo = s.randomDelayMin, hi = s.randomDelayMax;
      if (s.speed && SPEED_DELAYS[s.speed]) { lo = SPEED_DELAYS[s.speed][0]; hi = SPEED_DELAYS[s.speed][1]; }
      const r = rng ? rng() : Math.random();
      return (lo + r * (hi - lo)) * MINUTE;
    }

    function dateHour(ts) { return dateStr(ts) + '-' + String(new Date(ts).getHours()).padStart(2, '0'); }
    // rolling 7-day connection-request count (LinkedIn weekly invite ceiling)
    function weeklyInvites(acc, now) { let n = 0; for (let i = 0; i < 7; i++) n += store.getCount(acc.id, dateStr(now - i * DAY), 'connect'); return n; }
    function dailyTotal(acc, now) { return store.getCount(acc.id, dateStr(now), '__total'); }
    function hourlyTotal(acc, now) { return store.getCount(acc.id, dateHour(now), '__total'); }
    function nextDayStartTs(acc, now) { const s = safety(acc); const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(s.workingHours.start, 0, 0, 0); return nextAllowedTime(acc, d.getTime()); }

    // The single safety gate. Returns { allowed, reason, retryAt } so the engine
    // can defer precisely and the UI can show WHY something is held.
    function check(acc, action, now, opts) {
      opts = opts || {};
      const s = safety(acc);
      const at = nextAllowedTime(acc, now);
      if (at > now) return { allowed: false, reason: 'outside_hours', retryAt: at };
      if (remaining(acc, action, now) <= 0) return { allowed: false, reason: 'daily_cap', retryAt: nextDayStartTs(acc, now) };
      if (s.dailyTotalCap && dailyTotal(acc, now) >= s.dailyTotalCap) return { allowed: false, reason: 'daily_total', retryAt: nextDayStartTs(acc, now) };
      if (s.hourlyMax && hourlyTotal(acc, now) >= s.hourlyMax) return { allowed: false, reason: 'hourly_cap', retryAt: now + HOUR };
      if (opts.invite) {
        if (s.weeklyInviteCap && weeklyInvites(acc, now) >= s.weeklyInviteCap) return { allowed: false, reason: 'weekly_invites', retryAt: now + DAY };
        if (pendingInvites(acc) >= s.pendingInviteCap) return { allowed: false, reason: 'pending_cap', retryAt: now + DAY };
      }
      return { allowed: true };
    }

    // Snapshot for the monitoring dashboard: today's usage vs effective caps.
    function usage(acc, now) {
      now = now || Date.now();
      const out = { actions: {}, total: dailyTotal(acc, now), totalCap: safety(acc).dailyTotalCap, hour: hourlyTotal(acc, now), hourCap: safety(acc).hourlyMax, weeklyInvites: weeklyInvites(acc, now), weeklyInviteCap: safety(acc).weeklyInviteCap, pending: pendingInvites(acc), pendingCap: safety(acc).pendingInviteCap, warmupPct: warmupPct(acc, now) };
      const caps = acc.dailyLimits || DEFAULT_DAILY_LIMITS[acc.type] || {};
      Object.keys(caps).forEach(a => { out.actions[a] = { used: store.getCount(acc.id, dateStr(now), a), cap: effectiveCap(acc, a, now), base: caps[a] }; });
      return out;
    }
    function warmupPct(acc, now) {
      const s = safety(acc); if (!s.warmup || !s.warmup.enabled) return 1;
      const ageDays = Math.max(0, Math.floor(((now || Date.now()) - (acc.createdAt || now)) / DAY));
      return Math.min(1, s.warmup.startPct + (1 - s.warmup.startPct) * (ageDays / s.warmup.rampDays));
    }

    return { safety, effectiveCap, remaining, nextAllowedTime, pendingInvites, randomDelayMs, dateStr, dateHour, isWeekend, weeklyInvites, dailyTotal, hourlyTotal, nextDayStartTs, check, usage, warmupPct };
  }

  /* ============================================================
     5. Channels, adapter interface + Simulated/LinkedIn/Email/X
     ============================================================ */

  // An adapter executes a single rendered action against a channel and returns
  //   { ok, status, info, willAccept?, willReply?, acceptInMs?, replyInMs? }
  // The Simulated adapter is fully functional end-to-end (zero account risk);
  // the real adapters are typed stubs documenting the integration surface.

  function SimulatedAdapter(opts) {
    opts = opts || {};
    // Outcome probabilities, tuned to feel like real B2B outreach.
    const P = Object.assign({
      acceptRate: 0.38,        // connection request acceptance
      replyRate: 0.22,         // reply to a message/email after contact
      openRate: 0.55,          // email open
      clickRate: 0.12,         // email link click
      bounceRate: 0.03,        // email hard bounce -> suppress
      failRate: 0.02,          // transient send failure
    }, opts.rates);
    return {
      id: 'simulated',
      label: 'Simulated (safe demo)',
      supports: () => true,
      connect: () => ({ ok: true, status: 'connected', info: 'Simulated channel ready' }),
      execute(action, ctx) {
        const rng = ctx.rng || Math.random;
        if (rng() < P.failRate) return { ok: false, status: STATUS.event.FAILED, info: 'Simulated transient failure' };
        const meta = (CHANNELS[action.channel].actions[action.type]) || {};
        const res = { ok: true, status: STATUS.event.SENT, info: 'Simulated ' + action.type };
        if (meta.opensRelationship) {           // a connection request
          res.willAccept = rng() < P.acceptRate;
          res.acceptInMs = (6 * HOUR) + rng() * 3 * DAY;
        }
        if (action.type === 'email') {
          // deliverability first: a hard bounce means nothing else happens
          res.bounced = rng() < P.bounceRate;
          if (!res.bounced) {
            res.opened = rng() < P.openRate;
            res.clicked = res.opened && rng() < (P.clickRate / Math.max(0.01, P.openRate));
            res.willReply = rng() < P.replyRate;
            res.replyInMs = (2 * HOUR) + rng() * 2 * DAY;
          }
          return res;
        }
        if (action.type === 'message' || action.type === 'inmail' || action.type === 'tw_dm') {
          res.willReply = rng() < P.replyRate;
          res.replyInMs = (2 * HOUR) + rng() * 2 * DAY;
        }
        return res;
      },
    };
  }

  // Real adapters: same interface, throw until credentials/integration wired.
  function stubAdapter(id, label) {
    return {
      id, label, supports: () => true,
      connect() { return { ok: false, status: 'unconfigured', info: label + ' adapter needs credentials (see channels.connect)' }; },
      execute() { throw new Error(label + ' adapter not configured, running in Simulated mode is required until credentials + a server-side worker are wired. Browser/file:// cannot legally drive ' + label + '.'); },
    };
  }
  const LinkedInAdapter = () => stubAdapter('linkedin', 'LinkedIn');
  const EmailAdapter = () => stubAdapter('email', 'Email/SMTP');
  const TwitterAdapter = () => stubAdapter('twitter', 'X/Twitter');

  /* ============================================================
     6. Engine, enrollment + the tick() scheduler
     ============================================================ */

  function Engine(config) {
    config = config || {};
    const store = config.store || Store(config);
    const limits = Limits(store);
    const rng = config.seed != null ? makeRng(config.seed) : Math.random;
    // adapter registry keyed by channel; defaults to Simulated for all.
    const adapters = Object.assign({
      linkedin: SimulatedAdapter(config.rates ? { rates: config.rates } : {}),
      email: SimulatedAdapter(config.rates ? { rates: config.rates } : {}),
      twitter: SimulatedAdapter(config.rates ? { rates: config.rates } : {}),
    }, config.adapters || {});

    function adapterFor(channel) { return adapters[channel] || SimulatedAdapter(); }

    /* ---- blacklist + suppression enforcement ---- */
    function isBlacklisted(lead) {
      const bl = store.blacklist();
      const email = (lead.email || '').toLowerCase();
      const domain = email.split('@')[1] || '';
      return (
        bl.emails.includes(email) ||
        bl.domains.includes(domain) ||
        (bl.unsubscribed || []).includes(email) ||
        (bl.bounced || []).includes(email) ||
        (lead.profileUrl && bl.profileUrls.includes(lead.profileUrl)) ||
        bl.names.includes((lead.fullName || '').toLowerCase())
      );
    }
    // Add an email to a suppression list and stop its active enrollments.
    function suppress(email, listName) {
      email = (email || '').toLowerCase(); if (!email) return;
      const bl = store.blacklist(); const list = bl[listName] || (bl[listName] = []);
      if (!list.includes(email)) list.push(email);
      store.where('leads', l => (l.email || '').toLowerCase() === email).forEach(l => {
        store.where('enrollments', en => en.leadId === l.id && en.status === STATUS.enrollment.ACTIVE)
          .forEach(en => { en.status = STATUS.enrollment.STOPPED; en.stopReason = listName; en.nextRunAt = null; });
      });
      store.save();
    }

    /* ---- email mailbox rotation (cold-email inbox rotation) ---- */
    function emailAccountsFor(campaign) {
      const ids = (campaign.emailAccountIds && campaign.emailAccountIds.length)
        ? campaign.emailAccountIds
        : store.where('channelAccounts', a => a.type === 'email').map(a => a.id);
      return ids.map(id => store.get('channelAccounts', id)).filter(Boolean);
    }
    // Returns the mailbox with the most remaining quota today, or null if all
    // are exhausted, or undefined if no mailboxes are configured (fall back).
    function pickEmailAccount(campaign, now) {
      const accts = emailAccountsFor(campaign);
      if (!accts.length) return undefined;
      let best = null, bestRem = -1;
      accts.forEach(a => { const rem = limits.remaining(a, 'email', now); if (rem > bestRem) { bestRem = rem; best = a; } });
      return bestRem > 0 ? best : null;
    }

    /* ---- enroll leads into a campaign ---- */
    function enroll(campaignId, leadIds, now) {
      now = now || Date.now();
      const campaign = store.get('campaigns', campaignId);
      if (!campaign) throw new Error('Unknown campaign ' + campaignId);
      const accId = (campaign.channelAccountIds || [])[0] || null;
      const created = [];
      leadIds.forEach(leadId => {
        const lead = store.get('leads', leadId);
        if (!lead) return;
        // de-dupe: never enroll the same lead in the same campaign twice
        if (store.where('enrollments', e => e.campaignId === campaignId && e.leadId === leadId).length) return;
        if (isBlacklisted(lead)) {
          created.push(store.insert('enrollments', baseEnrollment(campaign, leadId, accId, now, STATUS.enrollment.STOPPED, 'blacklisted')));
          return;
        }
        created.push(store.insert('enrollments', baseEnrollment(campaign, leadId, accId, now, STATUS.enrollment.ACTIVE)));
      });
      recomputeCampaignStats(campaignId);
      return created;
    }

    function baseEnrollment(campaign, leadId, accId, now, status, stopReason) {
      return {
        campaignId: campaign.id,
        leadId,
        _channelAccountId: accId,
        status: status || STATUS.enrollment.ACTIVE,
        stopReason: stopReason || null,
        stepIndex: 0,
        nextRunAt: now,
        enrolledAt: now,
        connectionSent: false,
        connectionAccepted: false,
        repliedAt: null,
        // scheduled future facts the Simulated adapter "promised" (accept/reply)
        _pendingAccept: null,   // { at }
        _pendingReply: null,    // { at }
        history: [],
      };
    }

    /* ---- the core scheduler: advance everything due at `now` ---- */
    function tick(now, opts) {
      now = now || Date.now();
      opts = opts || {};
      const maxActions = opts.maxActions || 10000;
      const report = { processed: 0, sent: 0, deferred: 0, skipped: 0, completed: 0, failed: 0, accepted: 0, replied: 0 };

      // 1) resolve simulated promises (accepts/replies) + auto-withdraw stale invites
      store.all('enrollments').forEach(e => { autoWithdraw(e, now, report); settlePromises(e, now, report); });

      // 2) process due enrollments, oldest first
      const due = store.where('enrollments', e =>
        e.status === STATUS.enrollment.ACTIVE && e.nextRunAt != null && e.nextRunAt <= now
      ).sort((a, b) => a.nextRunAt - b.nextRunAt);

      for (const e of due) {
        if (report.processed >= maxActions) break;
        report.processed++;
        stepEnrollment(e, now, report);
      }
      return report;
    }

    function settlePromises(e, now, report) {
      if (e._pendingAccept && e._pendingAccept.at <= now && !e.connectionAccepted) {
        e.connectionAccepted = true;
        e._pendingAccept = null;
        logEvent(e, { type: 'connect', channel: 'linkedin', status: STATUS.event.ACCEPTED, at: now, info: 'Connection accepted' });
        report.accepted++;
        // an accepted enrollment that was waiting can run immediately
        if (e.status === STATUS.enrollment.ACTIVE && e.nextRunAt > now) e.nextRunAt = now;
        store.save();
      }
      if (e._pendingReply && e._pendingReply.at <= now && !e.repliedAt) {
        e.repliedAt = now;
        e._pendingReply = null;
        e.status = STATUS.enrollment.REPLIED;            // reply pauses the sequence (smart wait)
        logEvent(e, { type: 'reply', channel: e._lastChannel || 'email', status: STATUS.event.REPLIED, at: now, info: 'Prospect replied, sequence paused' });
        ensureThread(e, now);
        report.replied++;
        store.save();
      }
    }

    function stepEnrollment(e, now, report) {
      const campaign = store.get('campaigns', e.campaignId);
      if (!campaign || campaign.status !== STATUS.campaign.ACTIVE) { return; }
      const seq = store.get('sequences', campaign.sequenceId);
      const steps = (seq && seq.steps) || [];
      const acc = store.get('channelAccounts', e._channelAccountId);

      if (e.stepIndex >= steps.length) { return complete(e, report); }
      const step = steps[e.stepIndex];

      /* delay step, just schedule the next run */
      if (step.kind === 'delay') {
        e.nextRunAt = now + delayMs(step.delay);
        e.stepIndex++;
        store.save();
        return;
      }

      /* action step */
      const action = step.action;
      const lead = store.get('leads', e.leadId);

      // condition gate (e.g. "message only after connect accepted")
      const meta = CHANNELS[action.channel].actions[action.type] || {};

      // already a 1st-degree connection? skip the invite, treat as connected.
      if (action.type === 'connect' && /1|first/i.test(String(lead.degree || ''))) {
        e.connectionAccepted = true; e.connectionSent = true;
        logEvent(e, { type: 'connect', channel: 'linkedin', status: STATUS.event.SKIPPED, at: now, info: 'Already a 1st-degree connection' });
        e.stepIndex++; e.nextRunAt = now + (acc ? limits.randomDelayMs(acc, rng) : MINUTE);
        report.skipped++;
        if (e.stepIndex >= steps.length) return complete(e, report);
        store.save(); return;
      }

      const needsAccepted = action.requireAccepted != null ? action.requireAccepted : meta.requiresAccepted;
      if ((needsAccepted || (step.condition && step.condition.type === 'if_accepted')) && !e.connectionAccepted) {
        // not yet accepted: keep the prospect pending and re-check. autoWithdraw()
        // times the invite out (and stops the enrollment) after the withdraw window,
        // matching how a real LinkedIn pending invite behaves.
        e.nextRunAt = now + 6 * HOUR;
        store.save();
        report.skipped++;
        return;
      }
      if (step.condition && step.condition.type === 'if_replied' && !e.repliedAt) {
        if (step.condition.else === 'stop') return stop(e, 'no_reply', report);
        e.stepIndex++; store.save(); report.skipped++; return;
      }

      // suppression: never contact unsubscribed / bounced / blacklisted leads
      if (isBlacklisted(lead)) return stop(e, 'suppressed', report);

      // choose the sending account. Email steps rotate across the campaign's
      // mailboxes (cold-email inbox rotation); other channels use the bound account.
      let useAcc = acc;
      if (action.channel === 'email') {
        const mb = pickEmailAccount(campaign, now);
        if (mb) useAcc = mb;
        else if (mb === null) { e.nextRunAt = now + DAY; e._lastHold = 'mailboxes_exhausted'; store.save(); report.deferred++; return; }
      }

      // unified safety gate: working hours, weekend, per-action daily cap (warmup),
      // daily total ceiling, hourly anti-burst, weekly invite cap, pending cap.
      if (useAcc) {
        const verdict = limits.check(useAcc, meta.counts, now, { invite: meta.opensRelationship });
        if (!verdict.allowed) {
          e.nextRunAt = verdict.retryAt || (now + HOUR);
          e._lastHold = verdict.reason;
          store.save(); report.deferred++; return;
        }
      }

      // render the message and execute through the adapter
      const rendered = renderAction(action, lead);
      const adapter = adapterFor(action.channel);
      let result;
      try {
        result = adapter.execute({ channel: action.channel, type: action.type, ...rendered }, { lead, account: useAcc, rng });
      } catch (err) {
        result = { ok: false, status: STATUS.event.FAILED, info: err.message };
      }

      if (!result.ok) {
        logEvent(e, { type: action.type, channel: action.channel, status: STATUS.event.FAILED, at: now, info: result.info, body: rendered.body });
        e.nextRunAt = now + 2 * HOUR;   // retry shortly
        report.failed++;
        // LinkedIn-jail protection: auto-pause the account after repeated failures.
        if (useAcc) {
          useAcc._consecFails = (useAcc._consecFails || 0) + 1;
          const s = limits.safety(useAcc);
          if (s.pauseOnErrors && useAcc._consecFails >= (s.maxConsecutiveErrors || 8)) {
            useAcc.health = 'bad';
            pauseAccountCampaigns(useAcc, 'repeated_errors', now);
          }
        }
        store.save();
        return;
      }
      if (useAcc) useAcc._consecFails = 0;   // healthy send resets the streak

      // success, record, count (per-action + daily total + hourly), schedule outcomes
      if (useAcc) {
        store.bump(useAcc.id, limits.dateStr(now), meta.counts, 1);
        store.bump(useAcc.id, limits.dateStr(now), '__total', 1);
        store.bump(useAcc.id, limits.dateHour(now), '__total', 1);
      }
      e._lastChannel = action.channel;
      e._lastAccountId = useAcc ? useAcc.id : null;
      logEvent(e, { type: action.type, channel: action.channel, accountId: useAcc ? useAcc.id : null, status: STATUS.event.SENT, at: now, subject: rendered.subject, body: rendered.body, info: result.info });
      report.sent++;

      // email bounce -> suppress + stop (deliverability protection)
      if (result.bounced) {
        logEvent(e, { type: 'bounce', channel: 'email', status: 'bounced', at: now, info: 'Hard bounce' });
        suppress(lead.email, 'bounced');
        report.bounced = (report.bounced || 0) + 1;
        return stop(e, 'bounced', report);
      }

      if (meta.opensRelationship) {
        e.connectionSent = true;
        e.connectionSentAt = now;                 // for auto-withdraw of stale invites
        if (result.willAccept) e._pendingAccept = { at: now + (result.acceptInMs || DAY) };
      }
      if (result.willReply) e._pendingReply = { at: now + (result.replyInMs || DAY) };
      if (result.opened) logEvent(e, { type: 'open', channel: action.channel, status: 'opened', at: now + 1 * HOUR, info: 'Email opened' });
      if (result.clicked) logEvent(e, { type: 'click', channel: action.channel, status: 'clicked', at: now + 90 * MINUTE, info: 'Link clicked' });

      ensureThreadMessage(e, action, rendered, now);

      // advance, with a human-like random delay before the next step fires
      e.stepIndex++;
      e.nextRunAt = now + (useAcc ? limits.randomDelayMs(useAcc, rng) : 5 * MINUTE);
      if (e.stepIndex >= steps.length) return complete(e, report);
      store.save();
    }

    function renderAction(action, lead) {
      const tpl = action.templateId ? store.get('templates', action.templateId) : null;
      const subjectSrc = action.subject != null ? action.subject : (tpl && tpl.subject) || '';
      let bodySrc;
      if (action.variants && action.variants.length) bodySrc = pickVariant({ variants: action.variants, body: action.body }, rng); // inline A/B
      else bodySrc = action.body != null ? action.body : (tpl && pickVariant(tpl, rng)) || action.note || '';
      return { subject: render(subjectSrc, lead, rng), body: render(bodySrc, lead, rng), note: render(action.note || '', lead, rng) };
    }

    function delayMs(delay) {
      if (!delay) return 0;
      const u = delay.unit === 'days' ? DAY : delay.unit === 'hours' ? HOUR : MINUTE;
      return (delay.amount || 0) * u;
    }
    function nextDayStart(acc, now) {
      const s = limits.safety(acc); const d = new Date(now);
      d.setDate(d.getDate() + 1); d.setHours(s.workingHours.start, 0, 0, 0);
      return limits.nextAllowedTime(acc, d.getTime());
    }

    function complete(e, report) {
      if (e.status === STATUS.enrollment.ACTIVE) { e.status = STATUS.enrollment.COMPLETED; e.nextRunAt = null; store.save(); report.completed++; }
    }
    function stop(e, reason, report) {
      e.status = STATUS.enrollment.STOPPED; e.stopReason = reason; e.nextRunAt = null; store.save(); report.skipped++;
    }

    // Auto-withdraw connection requests that were never accepted within the window.
    function autoWithdraw(e, now, report) {
      if (e.status !== STATUS.enrollment.ACTIVE) return;
      if (!e.connectionSent || e.connectionAccepted || !e.connectionSentAt) return;
      const acc = store.get('channelAccounts', e._channelAccountId);
      const days = limits.safety(acc || {}).withdrawInviteAfterDays;
      if (days && (now - e.connectionSentAt) > days * DAY) {
        e._pendingAccept = null;
        logEvent(e, { type: 'withdraw_invite', channel: 'linkedin', status: STATUS.event.SENT, at: now, info: 'Auto-withdrew a stale invite (' + days + 'd)' });
        report.withdrawn = (report.withdrawn || 0) + 1;
        stop(e, 'invite_withdrawn', report);
      }
    }

    // Pause every campaign that uses this account (LinkedIn-jail protection).
    function pauseAccountCampaigns(acc, reason, now) {
      store.where('campaigns', c => (c.channelAccountIds || []).includes(acc.id) || (c.emailAccountIds || []).includes(acc.id))
        .forEach(c => { if (c.status === STATUS.campaign.ACTIVE) { c.status = STATUS.campaign.PAUSED; c._pausedReason = reason; c._pausedAt = now; } });
      store.save();
    }

    function logEvent(e, ev) {
      const full = Object.assign({ id: uid('ev'), enrollmentId: e.id, campaignId: e.campaignId, leadId: e.leadId }, ev);
      e.history.push({ stepIndex: e.stepIndex, type: ev.type, status: ev.status, at: ev.at });
      store.insert('events', full);
    }

    /* ---- conversation threads (inbox) ---- */
    function ensureThread(e, now) {
      let th = store.where('threads', t => t.enrollmentId === e.id)[0];
      if (!th) th = ensureThreadMessage(e, null, null, now);
      th.status = 'replied'; th.hot = true; store.save();
      return th;
    }
    function ensureThreadMessage(e, action, rendered, now) {
      const lead = store.get('leads', e.leadId);
      let th = store.where('threads', t => t.enrollmentId === e.id)[0];
      if (!th) {
        th = store.insert('threads', {
          enrollmentId: e.id, campaignId: e.campaignId, leadId: e.leadId,
          name: lead.fullName, channel: action ? action.channel : 'email',
          messages: [], status: 'active', hot: false,
        });
      }
      if (rendered && (rendered.body || rendered.note)) {
        th.messages.push({ dir: 'out', text: rendered.body || rendered.note, channel: action.channel, at: now });
        store.save();
      }
      return th;
    }

    /* ---- analytics ---- */
    function recomputeCampaignStats(campaignId) {
      const enrollments = store.where('enrollments', e => e.campaignId === campaignId);
      const evs = store.where('events', ev => ev.campaignId === campaignId);
      const count = (pred) => evs.filter(pred).length;
      const stats = {
        enrolled: enrollments.length,
        active: enrollments.filter(e => e.status === STATUS.enrollment.ACTIVE).length,
        completed: enrollments.filter(e => e.status === STATUS.enrollment.COMPLETED).length,
        stopped: enrollments.filter(e => e.status === STATUS.enrollment.STOPPED).length,
        connectsSent: count(ev => ev.type === 'connect' && ev.status === STATUS.event.SENT),
        accepted: count(ev => ev.status === STATUS.event.ACCEPTED),
        messages: count(ev => (ev.type === 'message' || ev.type === 'inmail') && ev.status === STATUS.event.SENT),
        emails: count(ev => ev.type === 'email' && ev.status === STATUS.event.SENT),
        opens: count(ev => ev.type === 'open'),
        clicks: count(ev => ev.type === 'click'),
        bounces: count(ev => ev.type === 'bounce'),
        replies: enrollments.filter(e => e.repliedAt).length,
      };
      stats.acceptRate = stats.connectsSent ? +(stats.accepted / stats.connectsSent * 100).toFixed(1) : 0;
      const contacted = stats.messages + stats.emails + stats.connectsSent;
      stats.replyRate = contacted ? +(stats.replies / contacted * 100).toFixed(1) : 0;
      stats.openRate = stats.emails ? +(stats.opens / stats.emails * 100).toFixed(1) : 0;
      stats.clickRate = stats.emails ? +(stats.clicks / stats.emails * 100).toFixed(1) : 0;
      stats.bounceRate = stats.emails ? +(stats.bounces / (stats.emails + stats.bounces) * 100).toFixed(1) : 0;
      store.update('campaigns', campaignId, { stats });
      return stats;
    }

    function analytics(campaignId) {
      if (campaignId) return recomputeCampaignStats(campaignId);
      // workspace roll-up across campaigns
      const totals = { enrolled: 0, accepted: 0, connectsSent: 0, replies: 0, messages: 0, emails: 0 };
      store.all('campaigns').forEach(c => {
        const s = recomputeCampaignStats(c.id);
        Object.keys(totals).forEach(k => { totals[k] += s[k] || 0; });
      });
      totals.acceptRate = totals.connectsSent ? +(totals.accepted / totals.connectsSent * 100).toFixed(1) : 0;
      const contacted = totals.messages + totals.emails + totals.connectsSent;
      totals.replyRate = contacted ? +(totals.replies / contacted * 100).toFixed(1) : 0;
      return totals;
    }

    /* ---- public engine API ---- */
    return {
      store, limits, adapters, CHANNELS,
      setAdapter(channel, adapter) { adapters[channel] = adapter; },
      enroll, tick,
      pauseCampaign: (id) => store.update('campaigns', id, { status: STATUS.campaign.PAUSED }),
      activateCampaign: (id) => store.update('campaigns', id, { status: STATUS.campaign.ACTIVE }),
      analytics, recomputeCampaignStats,
      isBlacklisted, emailAccountsFor, pickEmailAccount,
      unsubscribe: (email) => suppress(email, 'unsubscribed'),
      suppress,
      // run many days forward in `stepMs` increments (UI sim + tests)
      fastForward(fromTs, toTs, stepMs, onTick) {
        stepMs = stepMs || 6 * HOUR;
        const agg = { sent: 0, accepted: 0, replied: 0, completed: 0, deferred: 0, failed: 0, skipped: 0, processed: 0, bounced: 0 };
        for (let t = fromTs; t <= toTs; t += stepMs) {
          const r = tick(t);
          Object.keys(agg).forEach(k => { agg[k] += r[k] || 0; });
          if (onTick) onTick(t, r);
        }
        return agg;
      },
    };
  }

  /* ============================================================
     7. Builders, ergonomic factory helpers for the data model
     ============================================================ */

  function pickVariant(template, rng) {
    if (template.variants && template.variants.length) {
      // weighted A/B selection
      const total = template.variants.reduce((s, v) => s + (v.weight || 1), 0);
      let r = (rng ? rng() : Math.random()) * total;
      for (const v of template.variants) { r -= (v.weight || 1); if (r <= 0) return v.body; }
      return template.variants[0].body;
    }
    return template.body;
  }

  const build = {
    workspace: (name, tz) => ({ name, timezone: tz || 'local', plan: 'pro', createdAt: Date.now() }),
    channelAccount: (type, displayName, over) => Object.assign({
      type, displayName, status: 'connected', health: 'good',
      dailyLimits: clone(DEFAULT_DAILY_LIMITS[type] || {}),
      safety: clone(DEFAULT_SAFETY),
      createdAt: Date.now(),
    }, over || {}),
    // A cold-email mailbox (sending inbox). New mailboxes warm up slowly;
    // start conservative and ramp. Used for inbox rotation.
    emailAccount: (fromEmail, fromName, over) => Object.assign({
      type: 'email', displayName: fromEmail, fromEmail, fromName: fromName || '',
      provider: 'smtp', domain: (fromEmail || '').split('@')[1] || '',
      status: 'connected', health: 'good',
      dailyLimits: { email: 40 },                       // safe per-mailbox daily send
      safety: Object.assign(clone(DEFAULT_SAFETY), { warmup: { enabled: true, startPct: 0.25, rampDays: 21 }, dailyTotalCap: 40, hourlyMax: 8 }),
      createdAt: Date.now(),
    }, over || {}),
    lead: (o) => Object.assign({
      firstName: '', lastName: '', fullName: '', headline: '', company: '', position: '',
      location: '', profileUrl: '', email: '', twitterHandle: '', degree: '2nd',
      tags: [], customFields: {}, source: 'manual', status: 'new', createdAt: Date.now(),
    }, o, { fullName: o.fullName || [o.firstName, o.lastName].filter(Boolean).join(' ') }),
    template: (o) => Object.assign({ name: 'Untitled', channel: 'linkedin', action: 'message', subject: '', body: '', variants: [], tags: [] }, o),
    campaign: (o) => Object.assign({
      name: 'New campaign', status: STATUS.campaign.DRAFT, channelAccountIds: [],
      sequenceId: null, listId: null, createdAt: Date.now(), stats: {},
    }, o),
    sequence: (campaignId, steps) => ({ campaignId, steps: steps || [] }),
    // step helpers
    actionStep: (channel, type, fields) => ({ id: uid('st'), kind: 'action', action: Object.assign({ channel, type }, fields || {}), condition: { type: 'always' } }),
    delayStep: (amount, unit) => ({ id: uid('st'), kind: 'delay', delay: { amount, unit: unit || 'days' } }),
  };

  /* ============================================================
     8. Seed, a realistic demo workspace (matches RecruiterOS tone)
     ============================================================ */

  function seedDemo(store, now) {
    now = now || Date.now();
    if (store.all('campaigns').length) return store;   // already seeded

    const accLi = store.insert('channelAccounts', build.channelAccount('linkedin', 'Jamie Rourke · LinkedIn', { createdAt: now - 20 * DAY }));
    store.insert('channelAccounts', build.channelAccount('email', 'jamie@recruitersos.co', { createdAt: now - 30 * DAY }));

    const tplConnect = store.insert('templates', build.template({
      name: 'Greenfield React, connect', channel: 'linkedin', action: 'connect',
      body: 'Hi {first_name}, your work on the {company} order flow is genuinely impressive, would love to connect.',
    }));
    const tplMsg = store.insert('templates', build.template({
      name: 'Greenfield React, message', channel: 'linkedin', action: 'message',
      variants: [
        { label: 'Direct', weight: 1, body: 'Thanks for connecting, {first_name}. I\'m hiring a staff React engineer (remote, greenfield, $120-145k) where you\'d own architecture from day one. Worth a 15-min call this week?' },
        { label: 'Curiosity', weight: 1, body: '{first_name}, quick one, after {company}, are you open to owning a greenfield React platform end-to-end? Remote, staff-level. Happy to share details.' },
      ],
    }));
    const tplEmail = store.insert('templates', build.template({
      name: 'Breakup + value', channel: 'email', action: 'email',
      subject: 'Closing the loop, {first_name}',
      body: 'Hi {first_name},\n\nI\'ll close the loop here. If a remote, architecture-owning React role ever becomes interesting, my door\'s open.\n\n- Jamie',
    }));

    const leadsSeed = [
      { firstName: 'Anja', lastName: 'Köhler', headline: 'Sr. Frontend Engineer', company: 'Trade Republic', position: 'Sr. Frontend Engineer', location: 'Berlin, DE', email: 'anja.kohler@proton.me', profileUrl: 'https://linkedin.com/in/anjakohler', degree: '2nd', customFields: { why: 'Team reorg + 4yr tenure' } },
      { firstName: 'Marco', lastName: 'Silva', headline: 'Staff Engineer', company: 'N26', position: 'Staff Engineer', location: 'Berlin, DE', email: 'm.silva@hey.com', profileUrl: 'https://linkedin.com/in/marcosilva', degree: '2nd' },
      { firstName: 'Lena', lastName: 'Dietrich', headline: 'Frontend Lead', company: 'Pitch', position: 'Frontend Lead', location: 'Berlin, DE', email: 'lena.d@gmail.com', degree: '3rd' },
      { firstName: 'Tomas', lastName: 'Berg', headline: 'Sr. React Developer', company: 'Zalando', position: 'Sr. React Developer', location: 'Berlin, DE', email: 'tomasberg@fastmail.com', degree: '2nd' },
      { firstName: 'Yuki', lastName: 'Tanaka', headline: 'Senior SWE, Frontend', company: 'Delivery Hero', position: 'Senior SWE', location: 'Berlin, DE', email: 'yuki.t@outlook.com', degree: '2nd' },
      { firstName: 'Oskar', lastName: 'Wendt', headline: 'Sr. React Engineer', company: 'SoundCloud', position: 'Sr. React Engineer', location: 'Berlin, DE', email: 'oskar.wendt@proton.me', degree: '2nd' },
    ];
    const leads = leadsSeed.map(l => store.insert('leads', build.lead(l)));

    const campaign = store.insert('campaigns', build.campaign({
      name: 'Senior React · Berlin', status: STATUS.campaign.ACTIVE, channelAccountIds: [accLi.id],
    }));
    const seq = store.insert('sequences', build.sequence(campaign.id, [
      build.actionStep('linkedin', 'view'),
      build.delayStep(1, 'days'),
      build.actionStep('linkedin', 'connect', { templateId: tplConnect.id }),
      build.delayStep(2, 'days'),
      build.actionStep('linkedin', 'message', { templateId: tplMsg.id, requireAccepted: true }),
      build.delayStep(3, 'days'),
      build.actionStep('email', 'email', { templateId: tplEmail.id }),
    ]));
    store.update('campaigns', campaign.id, { sequenceId: seq.id });

    return { store, campaign, leads, accLi };
  }

  /* ============================================================
     9. Public surface
     ============================================================ */

  return {
    VERSION: '1.1.0',
    CHANNELS, DEFAULT_DAILY_LIMITS, DEFAULT_SAFETY, STATUS,
    SAFETY_PRESETS, SPEED_DELAYS, applyPreset,
    Store, Engine, Limits,
    SimulatedAdapter, LinkedInAdapter, EmailAdapter, TwitterAdapter,
    build, render, missingFields, pickVariant, makeRng, uid, seedDemo,
    constants: { DAY, HOUR, MINUTE },
  };
});
