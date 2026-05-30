/* End-to-end test of the outreach bridge — plays BOTH sides.
   Run: node bridge/bridge.test.cjs
   Simulates: backend enqueues a connect, the extension agent polls/executes/
   reports, then reports an invite_accepted event that forwards to a fake
   backend webhook. No browser or Next.js needed. */

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

(async () => {
  // a fake backend webhook receiver to prove event forwarding
  let webhookHits = [];
  const webhook = http.createServer((rq, rs) => { let raw = ''; rq.on('data', c => raw += c); rq.on('end', () => { webhookHits.push(JSON.parse(raw || '{}')); rs.writeHead(200); rs.end('{}'); }); });
  await new Promise(r => webhook.listen(0, r));
  const webhookPort = webhook.address().port;

  // boot the bridge with test env
  process.env.PORT = '0';
  process.env.OUTREACH_TOKEN = OUTREACH_TOKEN;
  process.env.AGENT_TOKEN = AGENT_TOKEN;
  process.env.BACKEND_WEBHOOK_URL = 'http://localhost:' + webhookPort + '/api/linkedin/webhook';
  const { server } = require('./outreach-bridge.cjs');
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  console.log('\n\x1b[1mOutreach bridge end-to-end\x1b[0m');

  // 1) auth is enforced
  const bad = await req(port, '/connect', 'wrong', { account: 'acc1', prospect: {} });
  ok('rejects bad outreach token', bad.status === 401);
  const badAgent = await req(port, '/agent/poll', 'wrong', { accountId: 'acc1' });
  ok('rejects bad agent token', badAgent.status === 401);

  // 2) backend enqueues a connection (internalProvider.sendConnection -> /connect)
  const enq = await req(port, '/connect', OUTREACH_TOKEN, { account: 'acc1', prospect: { fullName: 'Anja Kohler', publicProfileUrl: 'https://www.linkedin.com/in/anjakohler', providerProfileId: 'anjakohler' }, note: 'Hi Anja, would love to connect.' });
  ok('connect returns a providerMessageId (optimistic)', !!enq.body.providerMessageId, JSON.stringify(enq.body));
  const actionId = enq.body.providerMessageId;

  // 3) the extension agent polls and gets the action
  const poll = await req(port, '/agent/poll', AGENT_TOKEN, { accountId: 'acc1' });
  ok('agent receives the queued action', poll.body.action && poll.body.action.id === actionId, JSON.stringify(poll.body));
  ok('action carries the target profile URL', poll.body.action && poll.body.action.target.profileUrl === 'https://www.linkedin.com/in/anjakohler');
  ok('action carries the personalized note', poll.body.action && poll.body.action.payload.note.includes('Anja'));

  // 4) polling again returns nothing (claimed, not re-served)
  const poll2 = await req(port, '/agent/poll', AGENT_TOKEN, { accountId: 'acc1' });
  ok('claimed action is not served twice', poll2.body.action === null);

  // 5) a DIFFERENT account does not see acc1's work
  const pollOther = await req(port, '/agent/poll', AGENT_TOKEN, { accountId: 'acc2' });
  ok('queues are isolated per account', pollOther.body.action === null);

  // 6) agent reports success
  const report = await req(port, '/agent/report', AGENT_TOKEN, { actionId, ok: true, providerMessageId: 'li_invite_123', info: 'invite sent' });
  ok('agent report accepted', report.body.ok === true);
  const status = await req(port, '/agent/status', AGENT_TOKEN);
  ok('action marked done', status.body.queues.acc1.find(a => a.id === actionId).status === 'done');

  // 7) later, the prospect accepts -> agent posts an event -> forwarded to backend webhook
  const evt = await req(port, '/agent/event', AGENT_TOKEN, { type: 'invite_accepted', accountId: 'acc1', providerProfileId: 'anjakohler', at: new Date(0).toISOString() });
  ok('accept event forwarded to backend', evt.body.forwarded === true, JSON.stringify(evt.body));
  await new Promise(r => setTimeout(r, 50));
  ok('backend webhook received invite_accepted', webhookHits.some(h => h.type === 'invite_accepted' && h.providerProfileId === 'anjakohler'), JSON.stringify(webhookHits));

  // 8) a reply event is stored and retrievable via /messages (listMessages)
  await req(port, '/agent/event', AGENT_TOKEN, { type: 'message_received', accountId: 'acc1', providerProfileId: 'anjakohler', text: 'Sure, lets talk Thursday', at: new Date(0).toISOString() });
  const msgs = await req(port, '/messages', OUTREACH_TOKEN, { account: 'acc1', providerProfileId: 'anjakohler' });
  ok('reply is retrievable via /messages', Array.isArray(msgs.body) && msgs.body.some(m => /Thursday/.test(m.text)), JSON.stringify(msgs.body));

  server.close(); webhook.close();
  console.log('\n' + (fail === 0 ? '\x1b[32m' : '\x1b[31m') + '  ' + pass + ' passed, ' + fail + ' failed\x1b[0m\n');
  process.exit(fail === 0 ? 0 : 1);
})();
