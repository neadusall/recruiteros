/* End-to-end test of the bridge SEARCH seam — plays BOTH sides.
   Run: node bridge/search.test.cjs
   Simulates: the backend's internalProvider.searchProfiles() POSTs /search and
   long-polls; the extension agent polls the queued `search` action, then streams
   scraped profiles back via /agent/search-result (partial, then done). Proves the
   long-poll resolves with the final { items } and that a timeout returns partials.
   No browser or Next.js needed. */

const http = require('http');

const OUTREACH_TOKEN = 'test-outreach';
const AGENT_TOKEN = 'test-agent';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  \x1b[32mok\x1b[0m   ' + n); } else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + n + (x ? ' -> ' + x : '')); } };

function req(port, path, token, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const r = http.request({ port, path, method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: 'Bearer ' + token } }, (res) => {
      let raw = ''; res.on('data', (c) => raw += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') }); } catch { resolve({ status: res.statusCode, body: {} }); } });
    });
    r.on('error', () => resolve({ status: 0, body: {} }));
    r.end(data);
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  process.env.PORT = '0';
  process.env.OUTREACH_TOKEN = OUTREACH_TOKEN;
  process.env.AGENT_TOKEN = AGENT_TOKEN;
  process.env.SEARCH_TIMEOUT_MS = '600'; // short, so the timeout case is fast
  const { server } = require('./outreach-bridge.cjs');
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  console.log('\n\x1b[1mOutreach bridge — search seam\x1b[0m');

  // auth
  const bad = await req(port, '/search', 'wrong', { account: 'acc1', url: 'x' });
  ok('rejects bad outreach token', bad.status === 401);
  const missing = await req(port, '/search', OUTREACH_TOKEN, { account: 'acc1' });
  ok('rejects search with no url', missing.status === 422);

  /* ---- happy path: backend long-polls, agent streams partial then done ---- */
  const url = 'https://www.linkedin.com/sales/search/people?query=react';
  const searchPromise = req(port, '/search', OUTREACH_TOKEN, { account: 'acc1', url, limit: 100 });

  await sleep(30); // let /search enqueue
  const poll = await req(port, '/agent/poll', AGENT_TOKEN, { accountId: 'acc1' });
  ok('agent receives a search action', poll.body.action && poll.body.action.type === 'search', JSON.stringify(poll.body));
  ok('search action carries url + limit', poll.body.action && poll.body.action.payload.url === url && poll.body.action.payload.limit === 100);
  const actionId = poll.body.action.id;

  // page 1 (partial)
  const page1 = [{ providerProfileId: 'danalee', fullName: 'Dana Lee', company: 'Globex', publicProfileUrl: 'https://www.linkedin.com/in/danalee', connectionDegree: 2 }];
  const r1 = await req(port, '/agent/search-result', AGENT_TOKEN, { actionId, items: page1, done: false });
  ok('partial search-result accepted', r1.body.ok === true && r1.body.count === 1, JSON.stringify(r1.body));

  // page 2 (final) — full set
  const full = page1.concat([{ providerProfileId: 'samkim', fullName: 'Sam Kim', company: 'Initech', publicProfileUrl: 'https://www.linkedin.com/in/samkim', connectionDegree: 3 }]);
  await req(port, '/agent/search-result', AGENT_TOKEN, { actionId, items: full, done: true });

  const search = await searchPromise;
  ok('long-poll resolves with final items', search.status === 200 && Array.isArray(search.body.items) && search.body.items.length === 2, JSON.stringify(search.body));
  ok('items carry mapped fields', search.body.items[0].fullName === 'Dana Lee' && search.body.items[1].providerProfileId === 'samkim');

  const status = await req(port, '/agent/status', AGENT_TOKEN);
  ok('search action marked done', status.body.queues.acc1.find(a => a.id === actionId).status === 'done');

  // unknown action id is rejected
  const unknown = await req(port, '/agent/search-result', AGENT_TOKEN, { actionId: 'nope', items: [], done: true });
  ok('unknown search action rejected', unknown.status === 404);

  /* ---- timeout path: agent streams a partial but never says done ---- */
  const p2 = req(port, '/search', OUTREACH_TOKEN, { account: 'acc2', url, limit: 50 });
  await sleep(30);
  const poll2 = await req(port, '/agent/poll', AGENT_TOKEN, { accountId: 'acc2' });
  const aid2 = poll2.body.action.id;
  await req(port, '/agent/search-result', AGENT_TOKEN, { actionId: aid2, items: page1, done: false });
  const timedOut = await p2; // resolves on SEARCH_TIMEOUT_MS with the partial
  ok('timed-out search returns the partial collected so far', timedOut.status === 200 && timedOut.body.items.length === 1, JSON.stringify(timedOut.body));

  server.close();
  console.log('\n' + (fail === 0 ? '\x1b[32m' : '\x1b[31m') + '  ' + pass + ' passed, ' + fail + ' failed\x1b[0m\n');
  process.exit(fail === 0 ? 0 : 1);
})();
