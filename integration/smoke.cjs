/* Backend smoke test — hits a RUNNING server (npm run dev / start on :3000).
   Proves the team flow: register -> add LinkedIn account -> create campaign ->
   add prospect -> list. Run:  node integration/smoke.cjs  (server must be up)  */
const http = require('http');

const PORT = +(process.env.PORT || 3000);
let cookie = '';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  \x1b[32mok\x1b[0m   ' + n); } else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + n + (x ? ' -> ' + x : '')); } };

function call(method, path, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ port: PORT, path, method, headers }, (res) => {
      const sc = res.headers['set-cookie'];
      if (sc) cookie = sc.map(c => c.split(';')[0]).join('; ');
      let raw = ''; res.on('data', c => raw += c); res.on('end', () => { let j = {}; try { j = JSON.parse(raw || '{}'); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', (e) => resolve({ status: 0, body: { error: e.message } }));
    req.end(data);
  });
}

(async () => {
  console.log('\n\x1b[1mBackend smoke (\x1b[0m:' + PORT + '\x1b[1m)\x1b[0m');
  const email = 'smoke+' + Date.now() + '@example.com';

  const reg = await call('POST', '/api/auth/register', { email, password: 'Test1234!', name: 'Smoke Tester' });
  ok('register returns 200/201 + session', (reg.status === 200 || reg.status === 201) && !!cookie, 'status ' + reg.status + ' ' + JSON.stringify(reg.body).slice(0, 120));

  const ses = await call('GET', '/api/auth/session');
  ok('session resolves the user', ses.status === 200 && ses.body && ses.body.user, JSON.stringify(ses.body).slice(0, 120));

  const acc = await call('POST', '/api/accounts', { type: 'linkedin', handle: email, platform: 'unipile' });
  ok('add LinkedIn account', acc.status === 200 || acc.status === 201, 'status ' + acc.status + ' ' + JSON.stringify(acc.body).slice(0, 160));

  const accList = await call('GET', '/api/accounts');
  ok('list shows the account (multi-account)', accList.status === 200 && accList.body && Array.isArray(accList.body.linkedin), JSON.stringify(accList.body).slice(0, 120));

  const camp = await call('POST', '/api/campaigns', { name: 'Smoke Campaign', goal: 'Book calls', motion: 'recruiting', icp: { accountProfile: 'Series B fintech', persona: 'Frontend lead', disqualifiers: [] }, signals: ['hiring_velocity'] });
  ok('create campaign', camp.status === 200 || camp.status === 201, 'status ' + camp.status + ' ' + JSON.stringify(camp.body).slice(0, 160));
  const campaignId = camp.body && camp.body.campaign && camp.body.campaign.id;

  const pros = await call('POST', '/api/prospects', { fullName: 'Anja Kohler', firstName: 'Anja', company: 'Trade Republic', title: 'Sr FE', linkedinUrl: 'https://linkedin.com/in/anjakohler', campaignId });
  ok('add prospect', pros.status === 200 || pros.status === 201, 'status ' + pros.status + ' ' + JSON.stringify(pros.body).slice(0, 160));

  const plist = await call('GET', '/api/prospects' + (campaignId ? '?campaign=' + campaignId : ''));
  ok('list prospects', plist.status === 200, 'status ' + plist.status);

  console.log('\n' + (fail === 0 ? '\x1b[32m' : '\x1b[31m') + '  ' + pass + ' passed, ' + fail + ' failed\x1b[0m\n');
  process.exit(fail === 0 ? 0 : 1);
})();
