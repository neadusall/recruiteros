/* ============================================================
   Service worker (MV3) — the queue + scheduler.
   Owns: action queue, daily counters, the tick alarm, dispatch
   to the LinkedIn tab's content script, and optional relay to
   the host outreach tool's backend.

   The host tool talks to ALL of this through messaging.js types
   — it never needs to know what's inside here.
   ============================================================ */
importScripts('config.js', 'lib/messaging.js', 'lib/limiter.js');

const CFG = self.ROS_CONFIG;
const { TYPE } = self.ROS;
const limiter = self.ROS_Limiter(CFG);

const DEFAULT_STATE = {
  running: false,
  connected: false,
  account: null,            // { name, profileUrl } of the logged-in LinkedIn user
  settings: {
    dailyLimits: CFG.dailyLimits,
    pacing: CFG.pacing,
    workingHours: CFG.workingHours,
    weekendsOff: CFG.weekendsOff,
    backendBaseUrl: CFG.backendBaseUrl,
  },
  queue: [],                // pending actions
  done: [],                 // last 50 results (ring)
  counts: {},               // 'YYYY-MM-DD|action' -> n
};

/* ---------------- state (chrome.storage.local) ---------------- */
async function getState() {
  const { state } = await chrome.storage.local.get('state');
  return Object.assign({}, DEFAULT_STATE, state || {});
}
async function setState(patch) {
  const s = await getState();
  const next = Object.assign(s, patch);
  await chrome.storage.local.set({ state: next });
  return next;
}

/* ---------------- install / alarm ---------------- */
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ state: DEFAULT_STATE });
  chrome.alarms.create('ros-tick', { periodInMinutes: Math.max(0.5, CFG.tickMinutes || 1) });
  log('info', 'RecruiterOS Outreach installed');
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('ros-tick', { periodInMinutes: Math.max(0.5, CFG.tickMinutes || 1) });
});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'ros-tick') drainQueue(); });

/* ---------------- message router (from popup, content, host) ---------------- */
function handle(msg, sender, sendResponse) {
  (async () => {
    const s = await getState();
    switch (msg && msg.type) {
      case TYPE.PING:
        return sendResponse({ ok: true, version: self.ROS.VERSION, account: s.account, connected: s.connected });
      case TYPE.GET_STATE:
        return sendResponse({ ok: true, state: publicState(s) });
      case TYPE.UPDATE_SETTINGS:
        await setState({ settings: Object.assign(s.settings, msg.settings || {}) });
        return sendResponse({ ok: true });
      case TYPE.SET_RUNNING:
        await setState({ running: !!msg.running });
        if (msg.running) drainQueue();
        return sendResponse({ ok: true, running: !!msg.running });
      case TYPE.ENQUEUE:
        s.queue.push(normalize(msg.action)); await setState({ queue: s.queue });
        return sendResponse({ ok: true, queued: s.queue.length });
      case TYPE.ENQUEUE_BATCH:
        (msg.actions || []).forEach(a => s.queue.push(normalize(a)));
        await setState({ queue: s.queue });
        return sendResponse({ ok: true, queued: s.queue.length });
      case TYPE.CLEAR_QUEUE:
        await setState({ queue: [] }); return sendResponse({ ok: true });
      case TYPE.CAPTURE_LEAD:
        await onCapturedLead(msg.profile); return sendResponse({ ok: true });
      case TYPE.ACTION_RESULT:
        return sendResponse({ ok: true }); // results handled inline in drainQueue
      case TYPE.LOG:
        log(msg.level || 'info', msg.msg); return sendResponse({ ok: true });
      default:
        return sendResponse({ ok: false, error: 'unknown message ' + (msg && msg.type) });
    }
  })();
  return true; // async
}
chrome.runtime.onMessage.addListener(handle);
// host outreach tool (web page listed in externally_connectable) talks in too
chrome.runtime.onMessageExternal.addListener(handle);

function publicState(s) {
  return { running: s.running, connected: s.connected, account: s.account, settings: s.settings, queue: s.queue, done: s.done.slice(-20), counts: s.counts };
}
function normalize(a) {
  return Object.assign(self.ROS.makeAction(a.type, a.target, a.payload, a.meta), a, { status: 'queued' });
}

/* ---------------- the core loop ---------------- */
let draining = false;
async function drainQueue() {
  if (draining) return;
  draining = true;
  try {
    const s = await getState();
    if (!s.running || !s.queue.length) return;

    const now = Date.now();
    if (!limiter.withinWorkingWindow(now)) { log('info', 'Outside working hours — holding queue'); return; }

    // find the LinkedIn tab to drive
    const tab = await linkedInTab();
    if (!tab) { await setState({ connected: false }); log('warn', 'No LinkedIn tab open — open linkedin.com to run actions'); return; }
    await setState({ connected: true });

    // process ONE action per tick (human-like; pacing handled by tick interval + gap)
    const idx = s.queue.findIndex(a => {
      const left = limiter.remaining(s.counts, a.type, now);
      return left > 0;
    });
    if (idx === -1) { log('info', 'Daily caps reached for all queued action types'); return; }

    const action = s.queue.splice(idx, 1)[0];
    action.status = 'running';
    await setState({ queue: s.queue });

    const result = await dispatchToTab(tab.id, { type: TYPE.DO_ACTION, action });

    // account for it
    const key = limiter.dateKey(now) + '|' + action.type;
    s.counts[key] = (s.counts[key] || 0) + (result && result.ok ? 1 : 0);
    action.status = result && result.ok ? 'done' : 'failed';
    action.result = result;
    s.done.push({ id: action.id, type: action.type, target: action.target, ok: !!(result && result.ok), at: now, info: result && result.info });
    if (s.done.length > 50) s.done = s.done.slice(-50);
    await setState({ counts: s.counts, done: s.done, queue: s.queue });

    await relayToBackend(s, TYPE.ACTION_RESULT, { action, result });
    log(result && result.ok ? 'info' : 'warn', (action.type + ' → ' + (result && result.ok ? 'ok' : 'failed')) + ' · ' + (action.target && action.target.name || ''));

    // schedule the next drain after a human-like gap (don't wait the full alarm period)
    setTimeout(drainQueue, limiter.nextGapMs());
  } catch (e) {
    log('error', 'drainQueue: ' + e.message);
  } finally {
    draining = false;
  }
}

/* ---------------- helpers ---------------- */
async function linkedInTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
  // prefer an active one
  return tabs.find(t => t.active) || tabs[0] || null;
}
function dispatchToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, info: chrome.runtime.lastError.message });
      else resolve(res || { ok: false, info: 'no response' });
    });
  });
}
async function onCapturedLead(profile) {
  const s = await getState();
  if (profile && profile.isSelf) { await setState({ account: { name: profile.name, profileUrl: profile.profileUrl }, connected: true }); return; }
  await relayToBackend(s, TYPE.CAPTURE_LEAD, { profile });
  notify('Lead captured', (profile && profile.name) || 'Unknown');
}
async function relayToBackend(s, type, body) {
  const base = (s.settings && s.settings.backendBaseUrl) || CFG.backendBaseUrl;
  if (!base) return; // local-only mode
  try {
    await fetch(base.replace(/\/$/, '') + '/' + type.replace('ros.', ''), {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, CFG.backendApiKey ? { Authorization: 'Bearer ' + CFG.backendApiKey } : {}),
      body: JSON.stringify(body),
    });
  } catch (e) { log('warn', 'backend relay failed: ' + e.message); }
}
function notify(title, message) {
  try { chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message }); } catch (_) {}
}
function log(level, msg) { console[(level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log')]('[ROS]', msg); }
