/* ============================================================
   Service worker (MV3) — the brain.
   Owns: logged-in account, the live/simulate flag, the outreach
   queue + scheduler, the Sales Navigator scrape job, the dataset
   "database", and CSV export.

   Host tools talk to ALL of this through messaging.js types only.
   ============================================================ */
importScripts('config.js', 'lib/messaging.js', 'lib/limiter.js');

const CFG = self.ROS_CONFIG;
const { TYPE, LEAD_FIELDS } = self.ROS;
const limiter = self.ROS_Limiter(CFG);

const DEFAULT_STATE = {
  running: false,
  connected: false,
  account: null,                 // { name, publicId, ... } logged-in LinkedIn user
  settings: {
    liveActions: CFG.liveActions,
    dailyLimits: CFG.dailyLimits,
    pacing: CFG.pacing,
    workingHours: CFG.workingHours,
    weekendsOff: CFG.weekendsOff,
    backendBaseUrl: CFG.backendBaseUrl,
    // Ingest token (from the app's "Enrich LinkedIn searches" dialog). Also used
    // as the bearer for the backend bridge agent endpoints (/api/linkedin/agent/*).
    backendApiKey: CFG.backendApiKey,
    // Which portal folder scraped leads land in (set by the portal at Connect).
    backendMotion: 'recruiting',
    // Browser-execution bridge: when enabled, this extension acts as the
    // executor for the backend's cadence. It polls the outreach bridge for
    // actions targeted at `accountId`, performs them in the user's session,
    // and reports results. See bridge/outreach-bridge.cjs.
    bridge: { enabled: false, url: CFG.bridge.url, token: CFG.bridge.token, accountId: '' },
  },
  queue: [],
  done: [],
  counts: {},
};

async function getState() { const { state } = await chrome.storage.local.get('state'); return Object.assign({}, DEFAULT_STATE, state || {}); }
async function setState(patch) { const s = await getState(); const n = Object.assign(s, patch); await chrome.storage.local.set({ state: n }); return n; }
async function getDatasets() { const { datasets } = await chrome.storage.local.get('datasets'); return datasets || {}; }
async function setDatasets(d) { await chrome.storage.local.set({ datasets: d }); }
async function getJob() { const { scrapeJob } = await chrome.storage.local.get('scrapeJob'); return scrapeJob || null; }
async function setJob(j) { await chrome.storage.local.set({ scrapeJob: j }); return j; }

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ state: DEFAULT_STATE });
  chrome.alarms.create('ros-tick', { periodInMinutes: Math.max(0.5, CFG.tickMinutes || 1) });
  log('info', 'RecruiterOS Outreach installed');
});
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('ros-tick', { periodInMinutes: Math.max(0.5, CFG.tickMinutes || 1) }));
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'ros-tick') { drainQueue(); agentTick(); } });

/* ============================================================
   BRIDGE AGENT — execute backend-driven actions in this session.
   Polls the outreach bridge, navigates to the target profile,
   performs the action via the content script, and reports back.
   ============================================================ */
let agentBusy = false;
let activeBridgeSearch = null;   // { actionId, bridge, datasetId } while a backend search scrape runs
async function agentTick() {
  if (agentBusy) return;
  if (activeBridgeSearch) return;            // a search scrape owns the tab right now
  const s = await getState();
  // Prefer RecruiterOS's OWN backend bridge: the same backend URL + ingest token
  // the user pastes for scraping also drives backend-queued actions (searches,
  // connects, …) — no separate bridge process, no Unipile. The backend is
  // workspace-scoped by the token, so no accountId is needed. Falls back to a
  // standalone bridge only if one is explicitly configured.
  const backendTok = s.settings.backendApiKey || (s.settings.bridge && s.settings.bridge.token);
  const b = (s.settings.backendBaseUrl && backendTok)
    ? { enabled: true, url: s.settings.backendBaseUrl, token: backendTok, accountId: '' }
    : (s.settings.bridge || {});
  if (!b.enabled || !b.url) return;
  if (!limiter.withinWorkingWindow(Date.now())) return;
  agentBusy = true;
  try {
    const poll = await bridgeCall(b, '/agent/poll', { accountId: b.accountId });
    const action = poll && poll.action;
    if (!action) return;
    // A backend-driven search: page through the URL human-like and stream the
    // scraped profiles back. It manages its own tab + pacing, so we hand off and
    // let the scrape loop report results (no DO_ACTION dispatch).
    if (action.type === 'search') { await runBridgeSearch(b, action); return; }
    const tab = await linkedInTab();
    if (!tab) { log('warn', 'bridge: no LinkedIn tab to execute in'); return; }

    // navigate to the target profile, then execute
    let result;
    try {
      if (action.target && action.target.profileUrl) await navigateTab(tab.id, action.target.profileUrl);
      const act = {
        id: action.id, type: action.type, channel: 'linkedin',
        target: action.target || {},
        payload: action.payload || {},
        meta: { live: s.settings.liveActions, bridge: true },
      };
      result = await dispatchToTab(tab.id, { type: TYPE.DO_ACTION, action: act });
    } catch (e) { result = { ok: false, info: e.message }; }

    await bridgeCall(b, '/agent/report', { actionId: action.id, ok: !!(result && result.ok), providerMessageId: action.id, info: result && result.info });
    // account for the action against this session's caps too
    const key = limiter.dateKey(Date.now()) + '|' + action.type;
    s.counts[key] = (s.counts[key] || 0) + (result && result.ok ? 1 : 0);
    recordDone(s, Object.assign({ id: action.id }, action), result, Date.now());
    await setState({ counts: s.counts, done: s.done });
    log(result && result.ok ? 'info' : 'warn', 'bridge action ' + action.type + ' -> ' + (result && result.ok ? 'ok' : 'failed'));
  } catch (e) { log('error', 'agentTick: ' + e.message); }
  finally { agentBusy = false; }
}
function bridgeCall(b, path, body) {
  return fetch(b.url.replace(/\/$/, '') + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (b.token || '') },
    body: JSON.stringify(body),
  }).then(r => r.ok ? r.json() : null).catch(() => null);
}
// post an observed accept/reply event back to the bridge (forwarded to backend)
async function bridgePostEvent(evt) {
  const s = await getState(); const b = s.settings.bridge || {};
  if (!b.enabled || !b.url) return;
  return bridgeCall(b, '/agent/event', evt);
}
function navigateTab(tabId, url) {
  return new Promise((resolve) => {
    chrome.tabs.update(tabId, { url }, () => {
      const onDone = (tid, info) => {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(onDone);
          setTimeout(resolve, 1500); // let the SPA settle + content script attach
        }
      };
      chrome.tabs.onUpdated.addListener(onDone);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(onDone); resolve(); }, 15000); // hard cap
    });
  });
}

/* ---------------- bridge-driven search (backend searchProfiles) ----------------
   The backend posts a `search` action with { url, limit }. We run it through the
   SAME human-paced Sales Navigator scraper the popup uses (jittered page-to-page
   pacing, resume-safe), and stream the scraped profiles back to the bridge as
   each page lands, so the backend's long-poll gets results as they come. */
async function runBridgeSearch(b, action) {
  const url = action.payload && action.payload.url;
  const limit = (action.payload && action.payload.limit) || 100;
  if (!url) { await postSearchResult(b, action.id, [], true); return; }
  // ~25 results per Sales Nav page; cap to the hard page limit.
  const maxPages = Math.min(Math.max(1, Math.ceil(limit / 25)), CFG.scrape.hardMaxPages);
  const started = await startScrape({ url, maxPages, name: 'Backend search · ' + new Date().toLocaleString() });
  if (!started.ok) { await postSearchResult(b, action.id, [], true); return; }
  // Hand control to the scrape loop; onScrapePage/stopScrape stream results to
  // the bridge for this datasetId until the job finishes.
  activeBridgeSearch = { actionId: action.id, bridge: b, datasetId: started.datasetId, limit };
}

// Push the profiles scraped so far for the active bridge search to the bridge.
async function streamBridgeSearch(records, done) {
  const a = activeBridgeSearch; if (!a) return;
  const items = (records || []).slice(0, a.limit).map(toSearchProfile);
  await postSearchResult(a.bridge, a.actionId, items, !!done);
  if (done) activeBridgeSearch = null;
}
function postSearchResult(b, actionId, items, done) {
  return bridgeCall(b, '/agent/search-result', { actionId, items, done });
}

// Map a scraped Sales Nav record onto the backend's SearchProfile shape.
function toSearchProfile(r) {
  const pub = r.profileUrl || '';
  const slug = (pub.match(/\/in\/([^/?#]+)/) || [])[1] || '';
  return {
    providerProfileId: slug || r.salesNavUrl || pub || '',
    fullName: r.fullName,
    firstName: r.firstName,
    lastName: r.lastName,
    headline: r.headline,
    title: r.title,
    company: r.company,
    location: r.location,
    publicProfileUrl: pub || undefined,
    imageUrl: r.photoUrl || undefined,
    connectionDegree: degreeNum(r.connectionDegree),
  };
}
function degreeNum(d) { const m = String(d == null ? '' : d).match(/([123])/); return m ? +m[1] : undefined; }

/* ---------------- message router ---------------- */
function handle(msg, sender, sendResponse) {
  (async () => {
    const s = await getState();
    switch (msg && msg.type) {
      case TYPE.PING: return sendResponse({ ok: true, version: self.ROS.VERSION, account: s.account, connected: s.connected, live: s.settings.liveActions });
      case TYPE.GET_STATE: return sendResponse({ ok: true, state: await publicState(s) });
      case TYPE.UPDATE_SETTINGS: await setState({ settings: Object.assign(s.settings, msg.settings || {}) }); agentTick(); return sendResponse({ ok: true });
      case 'ros.pokeAgent': agentTick(); return sendResponse({ ok: true }); // portal asked us to poll the backend now
      case 'ros.connected': return sendResponse({ ok: true, version: self.ROS.VERSION, account: s.account }); // portal handshake
      case TYPE.SET_LIVE: await setState({ settings: Object.assign(s.settings, { liveActions: !!msg.live }) }); return sendResponse({ ok: true, live: !!msg.live });
      case TYPE.SET_RUNNING: await setState({ running: !!msg.running }); if (msg.running) drainQueue(); return sendResponse({ ok: true, running: !!msg.running });
      case TYPE.ENQUEUE: s.queue.push(normalize(msg.action)); await setState({ queue: s.queue }); return sendResponse({ ok: true, queued: s.queue.length });
      case TYPE.ENQUEUE_BATCH: (msg.actions || []).forEach(a => s.queue.push(normalize(a))); await setState({ queue: s.queue }); return sendResponse({ ok: true, queued: s.queue.length });
      case TYPE.CLEAR_QUEUE: await setState({ queue: [] }); return sendResponse({ ok: true });

      case TYPE.CONNECT_ACCOUNT: return sendResponse(await connectAccount());
      case TYPE.IDENTITY: if (msg.identity) await setState({ account: msg.identity, connected: true }); return sendResponse({ ok: true });
      case TYPE.TEST_ACTION: return sendResponse(await testAction(msg.action, s));

      case TYPE.SCRAPE_START: return sendResponse(await startScrape(msg));
      case TYPE.SCRAPE_PAGE: return sendResponse(await onScrapePage(msg));
      case TYPE.SCRAPE_STOP: return sendResponse(await stopScrape(msg.finished));
      case TYPE.GET_DATASETS: return sendResponse({ ok: true, datasets: await datasetSummaries() });
      case TYPE.GET_DATASET: { const d = (await getDatasets())[msg.id]; return sendResponse({ ok: !!d, dataset: d }); }
      case TYPE.DELETE_DATASET: { const d = await getDatasets(); delete d[msg.id]; await setDatasets(d); return sendResponse({ ok: true }); }
      case TYPE.EXPORT_CSV: return sendResponse(await exportCsv(msg.id));
      case TYPE.DATASET_TO_CAMPAIGN: return sendResponse(await datasetToCampaign(msg.id, msg.campaignName, s));

      case TYPE.CAPTURE_LEAD: await onCapturedLead(msg.profile, s); return sendResponse({ ok: true });
      case TYPE.BRIDGE_EVENT: return sendResponse(await bridgePostEvent(msg.event) || { ok: true });
      case TYPE.LOG: log(msg.level || 'info', msg.msg); return sendResponse({ ok: true });
      default: return sendResponse({ ok: false, error: 'unknown message ' + (msg && msg.type) });
    }
  })();
  return true;
}
chrome.runtime.onMessage.addListener(handle);
chrome.runtime.onMessageExternal.addListener(handle);

async function publicState(s) {
  const job = await getJob();
  return {
    running: s.running, connected: s.connected, account: s.account, settings: s.settings,
    queue: s.queue, done: s.done.slice(-20), counts: s.counts,
    datasets: await datasetSummaries(),
    scrape: job ? { status: job.status, total: job.total, page: job.currentPage, maxPages: job.maxPages, name: job.name, datasetId: job.datasetId } : null,
  };
}
function normalize(a) { return Object.assign(self.ROS.makeAction(a.type, a.target, a.payload, a.meta), a, { status: 'queued' }); }

/* ---------------- account ---------------- */
async function connectAccount() {
  const tab = await linkedInTab();
  if (!tab) return { ok: false, info: 'Open linkedin.com (logged in) in a tab, then try again.' };
  const me = await dispatchToTab(tab.id, { type: TYPE.GET_IDENTITY });
  if (me && me.name) { await setState({ account: me, connected: true }); return { ok: true, account: me }; }
  return { ok: false, info: (me && me.info) || 'Could not read your LinkedIn identity. Make sure you are logged in.' };
}

/* ---------------- one-off test action on the active tab ---------------- */
async function testAction(action, s) {
  const tab = await linkedInTab();
  if (!tab) return { ok: false, info: 'No LinkedIn tab open' };
  const act = normalize(action);
  act.meta = Object.assign({}, act.meta, { live: s.settings.liveActions });
  const res = await dispatchToTab(tab.id, { type: TYPE.DO_ACTION, action: act });
  recordDone(s, act, res, Date.now()); await setState({ done: s.done, counts: s.counts });
  return res;
}

/* ---------------- outreach queue loop ---------------- */
let draining = false;
async function drainQueue() {
  if (draining) return; draining = true;
  try {
    const s = await getState();
    if (!s.running || !s.queue.length) return;
    const now = Date.now();
    if (!limiter.withinWorkingWindow(now)) { log('info', 'Outside working hours, holding queue'); return; }
    const tab = await linkedInTab();
    if (!tab) { await setState({ connected: false }); log('warn', 'No LinkedIn tab open'); return; }
    await setState({ connected: true });

    const idx = s.queue.findIndex(a => limiter.remaining(s.counts, a.type, now) > 0);
    if (idx === -1) { log('info', 'Daily caps reached for all queued action types'); return; }

    const action = s.queue.splice(idx, 1)[0];
    action.meta = Object.assign({}, action.meta, { live: s.settings.liveActions });
    await setState({ queue: s.queue });
    const result = await dispatchToTab(tab.id, { type: TYPE.DO_ACTION, action });

    const key = limiter.dateKey(now) + '|' + action.type;
    s.counts[key] = (s.counts[key] || 0) + (result && result.ok ? 1 : 0);
    recordDone(s, action, result, now);
    await setState({ counts: s.counts, done: s.done, queue: s.queue });
    await relayToBackend(s, 'actionResult', { action, result });
    setTimeout(drainQueue, limiter.nextGapMs());
  } catch (e) { log('error', 'drainQueue: ' + e.message); }
  finally { draining = false; }
}
function recordDone(s, action, result, now) {
  s.done.push({ id: action.id, type: action.type, target: action.target, ok: !!(result && result.ok), at: now, info: result && result.info });
  if (s.done.length > 50) s.done = s.done.slice(-50);
}

/* ---------------- Sales Navigator scraping ---------------- */
async function startScrape({ url, maxPages, name }) {
  if (!url || !/linkedin\.com\/sales\/search\/people/.test(url)) {
    return { ok: false, info: 'Paste a Sales Navigator people-search URL (linkedin.com/sales/search/people...).' };
  }
  const requested = Math.min(Math.max(1, maxPages || CFG.scrape.defaultMaxPages), CFG.scrape.hardMaxPages);
  const startPage = (/[?&]page=(\d+)/.exec(url) || [0, 1])[1] | 0 || 1;
  const datasetId = 'ds_' + Date.now().toString(36);
  const dsName = name || ('Sales Nav · ' + new Date().toLocaleString());

  const datasets = await getDatasets();
  datasets[datasetId] = { id: datasetId, name: dsName, url, createdAt: Date.now(), records: [] };
  await setDatasets(datasets);

  await setJob({
    datasetId, name: dsName, baseUrl: url, requested,
    currentPage: startPage, maxPages: startPage + requested - 1,
    scrapedPages: [], total: 0, status: 'running',
    delayMin: CFG.scrape.pageDelayMin, delayMax: CFG.scrape.pageDelayMax, startedAt: Date.now(),
  });

  const tab = await linkedInTab(true);
  if (tab) chrome.tabs.update(tab.id, { url, active: true });
  else chrome.tabs.create({ url, active: true });
  return { ok: true, datasetId };
}
async function onScrapePage({ datasetId, page, records }) {
  const job = await getJob(); if (!job || job.datasetId !== datasetId) return { ok: false };
  const datasets = await getDatasets(); const ds = datasets[datasetId]; if (!ds) return { ok: false };
  const seen = new Set(ds.records.map(keyOf));
  let added = 0;
  (records || []).forEach(r => { const k = keyOf(r); if (k && !seen.has(k)) { seen.add(k); ds.records.push(r); added++; } });
  await setDatasets(datasets);
  if (!job.scrapedPages.includes(page)) job.scrapedPages.push(page);
  job.currentPage = page; job.total = ds.records.length;
  await setJob(job);
  log('info', 'Scraped page ' + page + ': +' + added + ' (total ' + ds.records.length + ')');
  if (activeBridgeSearch && activeBridgeSearch.datasetId === datasetId) {
    // Backend-driven search: stream profiles back to the long-poll.
    await streamBridgeSearch(ds.records, false);
  } else if (added) {
    // Manual "Scrape this search": push the new leads straight into the portal's
    // Prospects (campaignFromDataset) so they show up live — no extra step. No-op
    // if the extension isn't connected to a backend yet.
    const s = await getState();
    const newOnes = (records || []).filter(function (r) { return r && (r.fullName); });
    await relayToBackend(s, 'campaignFromDataset', { campaignName: ds.name, leads: newOnes, motion: s.settings.backendMotion });
  }
  return { ok: true, total: ds.records.length };
}
function keyOf(r) { return (r.salesNavUrl || r.profileUrl || (r.fullName + '|' + r.company) || '').toLowerCase(); }
async function stopScrape(finished) {
  const job = await getJob(); if (!job) return { ok: true };
  job.status = finished ? 'done' : 'stopped'; await setJob(job);
  // Close out a backend search: send the final result set so the long-poll resolves.
  if (activeBridgeSearch && activeBridgeSearch.datasetId === job.datasetId) {
    const ds = (await getDatasets())[job.datasetId];
    await streamBridgeSearch((ds && ds.records) || [], true);
  }
  if (finished) notify('Scrape complete', job.total + ' leads in "' + job.name + '"');
  return { ok: true, total: job.total, status: job.status };
}
async function datasetSummaries() {
  const d = await getDatasets();
  return Object.values(d).map(x => ({ id: x.id, name: x.name, count: x.records.length, createdAt: x.createdAt, url: x.url }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/* ---------------- CSV export ---------------- */
async function exportCsv(id) {
  const ds = (await getDatasets())[id]; if (!ds) return { ok: false, info: 'dataset not found' };
  const cols = LEAD_FIELDS;
  const esc = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const R = self.ROS;
  // Clean each row on the way out (covers datasets scraped before cleaning landed):
  // names -> "First Last", headline/title/company/location de-junked.
  const cell = (r, c) => {
    const nm = R.cleanName(r.fullName || ((r.firstName || '') + ' ' + (r.lastName || '')));
    if (c === 'fullName') return nm.full;
    if (c === 'firstName') return nm.first;
    if (c === 'lastName') return nm.last;
    if (c === 'company') return R.cleanCompany(r[c]);
    if (c === 'headline' || c === 'title' || c === 'location') return R.cleanText(r[c]);
    if (c === 'capturedAt') return new Date(r[c] || Date.now()).toISOString();
    return r[c];
  };
  const rows = [cols.join(',')];
  ds.records.forEach(r => rows.push(cols.map(c => esc(cell(r, c))).join(',')));
  const csv = rows.join('\r\n');
  const dataUrl = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  const fname = ds.name.replace(/[^a-z0-9]+/gi, '_').slice(0, 60) + '.csv';
  return new Promise((resolve) => {
    chrome.downloads.download({ url: dataUrl, filename: fname, saveAs: true }, (dlId) => {
      if (chrome.runtime.lastError) resolve({ ok: false, info: chrome.runtime.lastError.message });
      else resolve({ ok: true, count: ds.records.length, filename: fname });
    });
  });
}

/* ---------------- dataset -> campaign ---------------- */
async function datasetToCampaign(id, campaignName, s) {
  const ds = (await getDatasets())[id]; if (!ds) return { ok: false, info: 'dataset not found' };
  if (s.settings.backendBaseUrl) {
    await relayToBackend(s, 'campaignFromDataset', { campaignName: campaignName || ds.name, leads: ds.records });
    return { ok: true, sent: ds.records.length, via: 'backend' };
  }
  return { ok: true, sent: ds.records.length, via: 'local', info: 'No backend set. Export CSV and import it in the Studio Leads tab.' };
}

/* ---------------- helpers ---------------- */
async function linkedInTab(anyState) {
  const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
  return tabs.find(t => t.active) || tabs[0] || (anyState ? null : null);
}
function dispatchToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, info: chrome.runtime.lastError.message });
      else resolve(res || { ok: false, info: 'no response' });
    });
  });
}
async function onCapturedLead(profile, s) { await relayToBackend(s, 'captureLead', { profile }); notify('Lead captured', (profile && profile.fullName) || 'Profile'); }
async function relayToBackend(s, path, body) {
  const base = (s.settings && s.settings.backendBaseUrl) || CFG.backendBaseUrl; if (!base) return;
  // Prefer the ingest token set by the portal's one-click Connect; fall back to config.
  const token = (s.settings && s.settings.backendApiKey) || CFG.backendApiKey;
  try {
    const res = await fetch(base.replace(/\/$/, '') + '/' + path, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
      body: JSON.stringify(body),
    });
    if (!res.ok) log('warn', 'backend relay ' + path + ' -> ' + res.status + (res.status === 401 ? ' (connect the extension in the portal first)' : ''));
  } catch (e) { log('warn', 'backend relay failed: ' + e.message); }
}
function notify(title, message) { try { chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message }); } catch (_) {} }
function log(level, msg) { console[(level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log')]('[ROS]', msg); }
