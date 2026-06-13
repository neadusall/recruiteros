/* ============================================================
   RecruitersOS Outreach Bridge — closes the browser-execution seam.

   The backend's `internalProvider` (RECRUITEROS_OUTREACH_PROVIDER=internal,
   RECRUITEROS_OUTREACH_URL -> this service) POSTs LinkedIn actions here.
   Instead of calling a vendor API, the bridge ENQUEUES each action per
   account. The browser extension drains the queue, performs the action
   through the user's own LinkedIn session, and reports the result plus
   any accept/reply events, which the bridge forwards to the backend
   webhook so the sequence engine advances.

       backend (cadence)                     extension (browser)
            │ POST /connect /message ...           │ POST /agent/poll
            ▼                                       ▼  -> action
        [ per-account queues ] <───── claim ────────┤
            │  forward events                       │ POST /agent/report
            ▼                                        │ POST /agent/event
     backend POST /api/linkedin/webhook  <──────────┘

   Search (internalProvider.searchProfiles -> /search): the backend posts a
   pasted Sales Navigator / classic search URL and long-polls; the extension
   claims the queued `search` action, pages through the results human-like in
   the user's own session, and streams the scraped profiles back via
   /agent/search-result until done. The long-poll then returns { items }.

       backend POST /search (long-poll) ──► [ search action ] ──► /agent/poll
       backend ◄── { items } ◄── /agent/search-result (partial…done) ◄── scrape

   Zero dependencies. Run:  node bridge/outreach-bridge.cjs
   Config via env (see bridge/.env.example):
     PORT                       default 8787
     OUTREACH_TOKEN             bearer the BACKEND must send  (== RECRUITEROS_OUTREACH_TOKEN)
     AGENT_TOKEN                bearer the EXTENSION must send (default == OUTREACH_TOKEN)
     BACKEND_WEBHOOK_URL        where to forward accept/reply events (optional)
     BACKEND_WEBHOOK_SECRET     HMAC secret header for the webhook (optional)
   ============================================================ */
const http = require('http');
const crypto = require('crypto');

const PORT = +(process.env.PORT || 8787);
const OUTREACH_TOKEN = process.env.OUTREACH_TOKEN || 'dev-outreach-token';
const AGENT_TOKEN = process.env.AGENT_TOKEN || OUTREACH_TOKEN;
const BACKEND_WEBHOOK_URL = process.env.BACKEND_WEBHOOK_URL || '';
const BACKEND_WEBHOOK_SECRET = process.env.BACKEND_WEBHOOK_SECRET || '';

/* ---------------- in-memory state (swap for Redis in prod) ---------------- */
const queues = new Map();      // accountId -> [action]
const byId = new Map();        // actionId -> action
const chats = new Map();       // accountId|profileId -> [chatMessage]
const events = [];             // audit of forwarded events
const searchWaiters = new Map(); // actionId -> { resolve, items } (backend /search long-poll)

// How long the backend's searchProfiles() call holds open while the extension
// pages through the search. On timeout we return whatever the agent has posted
// so far (the extension keeps streaming pages via /agent/search-result), so a
// long scrape degrades to partial results instead of an error.
const SEARCH_TIMEOUT_MS = +(process.env.SEARCH_TIMEOUT_MS || 110000);

let seq = 0;
function uid(p) { seq += 1; return p + '_' + Date.now().toString(36) + seq.toString(36); }
function queueFor(accountId) { if (!queues.has(accountId)) queues.set(accountId, []); return queues.get(accountId); }

function enqueue(type, accountId, target, payload) {
  const action = {
    id: uid('act'), type, accountId,
    target: target || {}, payload: payload || {},
    status: 'queued', createdAt: new Date().toISOString(), result: null,
  };
  queueFor(accountId).push(action);
  byId.set(action.id, action);
  return action;
}

/* ---------------- tiny HTTP helpers ---------------- */
function send(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
}
function bearer(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

/* ---------------- forward accept/reply events to the backend ---------------- */
async function forwardEvent(evt) {
  events.push(evt);
  if (!BACKEND_WEBHOOK_URL) return { forwarded: false };
  const body = JSON.stringify(evt);
  const headers = { 'Content-Type': 'application/json' };
  if (BACKEND_WEBHOOK_SECRET) {
    headers['x-unipile-signature'] = crypto.createHmac('sha256', BACKEND_WEBHOOK_SECRET).update(body).digest('hex');
  }
  try {
    await fetch(BACKEND_WEBHOOK_URL, { method: 'POST', headers, body });
    return { forwarded: true };
  } catch (e) { return { forwarded: false, error: e.message }; }
}

/* ---------------- routes ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  if (method === 'GET' && path === '/health') return send(res, 200, { ok: true, queues: [...queues.keys()], depth: [...queues.values()].reduce((n, q) => n + q.length, 0) });

  const body = (method === 'POST') ? await readBody(req) : {};
  const tok = bearer(req);

  /* ---- backend-facing (internalProvider contract) ---- */
  const BACKEND_PATHS = ['/resolve', '/connect', '/message', '/inmail', '/voice', '/view', '/endorse', '/withdraw', '/messages'];
  if (BACKEND_PATHS.includes(path)) {
    if (tok !== OUTREACH_TOKEN) return send(res, 401, { error: 'bad outreach token' });
    const acc = body.account;
    switch (path) {
      case '/resolve': {
        // browser executes against the public URL directly; echo it as the id
        const id = body.identifier;
        return send(res, 200, { providerProfileId: id, publicProfileUrl: /^https?:/.test(id) ? id : `https://www.linkedin.com/in/${id}` });
      }
      case '/connect': { const a = enqueue('connect', acc, prospectTarget(body.prospect), { note: body.note }); return send(res, 200, { providerMessageId: a.id }); }
      case '/message': { const a = enqueue('message', acc, prospectTarget(body.prospect), { body: body.text }); return send(res, 200, { providerMessageId: a.id }); }
      case '/inmail': { const a = enqueue('inmail', acc, prospectTarget(body.prospect), { subject: body.subject, body: body.text }); return send(res, 200, { providerMessageId: a.id }); }
      case '/voice': { const a = enqueue('voice_note', acc, prospectTarget(body.prospect), { audio: body.audio }); return send(res, 200, { providerMessageId: a.id }); }
      case '/view': { const a = enqueue('profile_view', acc, { profileUrl: body.providerProfileId }, {}); return send(res, 200, { providerMessageId: a.id }); }
      case '/endorse': { const a = enqueue('endorse', acc, { profileUrl: body.providerProfileId }, { count: body.count }); return send(res, 200, { providerMessageId: a.id }); }
      case '/withdraw': { const a = enqueue('withdraw_invite', acc, { profileUrl: body.providerProfileId }, {}); return send(res, 200, { providerMessageId: a.id }); }
      case '/messages': { return send(res, 200, chats.get(acc + '|' + body.providerProfileId) || []); }
    }
  }

  /* ---- backend-facing search (internalProvider.searchProfiles -> /search) ----
     Enqueues a `search` action for the extension to fulfil by paging through the
     pasted Sales Navigator / classic search URL in the user's own session, then
     long-polls until the agent streams the scraped profiles back (or we hit the
     timeout and return whatever has arrived so far). Mirrors the Unipile path's
     { items: SearchProfile[] } response so the engine is provider-agnostic. */
  if (path === '/search') {
    if (tok !== OUTREACH_TOKEN) return send(res, 401, { error: 'bad outreach token' });
    const acc = body.account;
    if (!acc || !body.url) return send(res, 422, { error: 'account and url are required' });
    const action = enqueue('search', acc, {}, { url: body.url, limit: Math.max(1, Math.min(+body.limit || 100, 1000)) });
    const items = await new Promise((resolve) => {
      const waiter = { items: [], resolve };
      searchWaiters.set(action.id, waiter);
      setTimeout(() => {
        if (searchWaiters.has(action.id)) { searchWaiters.delete(action.id); resolve(waiter.items); }
      }, SEARCH_TIMEOUT_MS);
    });
    return send(res, 200, { items });
  }

  /* ---- extension-facing ---- */
  if (path.startsWith('/agent/')) {
    if (tok !== AGENT_TOKEN) return send(res, 401, { error: 'bad agent token' });
    if (path === '/agent/poll') {
      const q = queueFor(body.accountId || '');
      const next = q.find((a) => a.status === 'queued');
      if (next) { next.status = 'claimed'; next.claimedAt = new Date().toISOString(); }
      return send(res, 200, { action: next || null });
    }
    if (path === '/agent/report') {
      const a = byId.get(body.actionId);
      if (!a) return send(res, 404, { error: 'unknown action' });
      a.status = body.ok ? 'done' : 'failed';
      a.result = { ok: !!body.ok, providerMessageId: body.providerMessageId, info: body.info, at: new Date().toISOString() };
      return send(res, 200, { ok: true });
    }
    if (path === '/agent/search-result') {
      // The extension streams scraped profiles for a `search` action. Each post
      // carries the FULL set collected so far; `done` resolves the backend's
      // long-poll. Partial posts let a timed-out /search still return results.
      const a = byId.get(body.actionId);
      if (!a || a.type !== 'search') return send(res, 404, { error: 'unknown search action' });
      const items = Array.isArray(body.items) ? body.items : [];
      const waiter = searchWaiters.get(body.actionId);
      if (waiter) waiter.items = items;
      a.result = { ok: true, count: items.length, at: new Date().toISOString() };
      if (body.done) {
        a.status = 'done';
        if (waiter) { searchWaiters.delete(body.actionId); waiter.resolve(items); }
      }
      return send(res, 200, { ok: true, count: items.length });
    }
    if (path === '/agent/event') {
      // normalize to the backend's LinkedInWebhookEvent shape
      const evt = {
        type: body.type, // 'invite_accepted' | 'message_received'
        accountId: body.accountId,
        providerProfileId: body.providerProfileId,
        providerMessageId: body.providerMessageId,
        text: body.text,
        at: body.at || new Date().toISOString(),
      };
      if (evt.type === 'message_received') {
        const k = evt.accountId + '|' + evt.providerProfileId;
        if (!chats.has(k)) chats.set(k, []);
        chats.get(k).push({ providerMessageId: evt.providerMessageId || uid('msg'), fromSelf: false, text: evt.text, at: evt.at });
      }
      const fwd = await forwardEvent(evt);
      return send(res, 200, { ok: true, ...fwd });
    }
    if (path === '/agent/status') {
      return send(res, 200, {
        queues: Object.fromEntries([...queues.entries()].map(([k, v]) => [k, v.map((a) => ({ id: a.id, type: a.type, status: a.status }))])),
        events: events.length,
      });
    }
  }

  send(res, 404, { error: 'not found', path });
});

function prospectTarget(p) {
  p = p || {};
  return { profileUrl: p.publicProfileUrl || p.linkedinUrl || p.providerProfileId || '', name: p.fullName || p.firstName || '', providerProfileId: p.providerProfileId };
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('RecruitersOS Outreach Bridge on http://localhost:' + PORT);
    console.log('  backend  -> set RECRUITEROS_OUTREACH_PROVIDER=internal, RECRUITEROS_OUTREACH_URL=http://localhost:' + PORT);
    console.log('  webhook  -> ' + (BACKEND_WEBHOOK_URL || '(not forwarding; set BACKEND_WEBHOOK_URL)'));
  });
}

module.exports = { server, _state: { queues, byId, chats, events } };
