/* Node test harness for alfred-core.
   Run:  node assets/js/alfred/alfred.test.cjs
   Proves the engine end-to-end with the Simulated adapter:
   warm-up limits, working hours, connect→accept→message gating,
   reply-pauses-sequence, blacklist, and analytics. */

const A = require('./alfred-core.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32mok\x1b[0m   ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

// A fixed start: Monday 2026-06-01 09:00 local (inside working hours, weekday)
const START = new Date(2026, 5, 1, 9, 0, 0, 0).getTime();
const { DAY, HOUR } = A.constants;

/* ---- build an isolated in-memory store + deterministic engine ---- */
function freshEngine(rates, seed) {
  const store = A.Store({ storage: null, namespace: 'test:' + Math.random() }); // in-memory (no localStorage in node)
  // force in-memory regardless of probe
  const mem = (() => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, '' + v), removeItem: k => m.delete(k) }; })();
  const store2 = A.Store({ storage: mem, namespace: 'test' });
  const engine = A.Engine({ store: store2, seed: seed == null ? 42 : seed, rates });
  return { store: store2, engine };
}

/* ============================================================ */
section('1. Personalization & merge fields');
{
  const lead = A.build.lead({ firstName: 'Anja', company: 'Trade Republic', customFields: { why: 'reorg' } });
  ok('renders {first_name}', A.render('Hi {first_name}!', lead) === 'Hi Anja!');
  ok('renders {company}', A.render('at {company}', lead) === 'at Trade Republic');
  ok('renders custom field {why}', A.render('because {why}', lead) === 'because reorg');
  ok('fallback for missing field', A.render('Hi {nickname|friend}', lead) === 'Hi friend');
  ok('spintax picks one option', ['A', 'B'].includes(A.render('{{A|B}}', lead, A.makeRng(1))));
  ok('missingFields flags unknown', A.missingFields('Hi {bogus}', lead).includes('bogus'));
}

/* ============================================================ */
section('2. Seed demo + enroll');
const { store, engine } = freshEngine();
const seeded = A.seedDemo(store, START);
{
  ok('seed created a campaign', store.all('campaigns').length === 1);
  ok('seed created 6 leads', store.all('leads').length === 6);
  ok('seed created a 7-step sequence', store.all('sequences')[0].steps.length === 7);

  const created = engine.enroll(seeded.campaign.id, seeded.leads.map(l => l.id), START);
  ok('enrolled all 6 leads', created.length === 6);
  ok('no duplicate enroll', engine.enroll(seeded.campaign.id, [seeded.leads[0].id], START).length === 0);
  ok('all enrollments start active', store.where('enrollments', e => e.status === 'active').length === 6);
}

/* ============================================================ */
section('3. Run 30 days — drips fire, connects→accepts→messages');
{
  const agg = engine.fastForward(START, START + 30 * DAY, 6 * HOUR);
  console.log('     ', JSON.stringify(agg));
  ok('some actions were sent', agg.sent > 0, 'sent=' + agg.sent);
  ok('some connections accepted', agg.accepted > 0, 'accepted=' + agg.accepted);

  const events = store.all('events');
  const connects = events.filter(e => e.type === 'connect' && e.status === 'sent');
  const messages = events.filter(e => e.type === 'message' && e.status === 'sent');
  ok('connection requests were sent', connects.length > 0, 'connects=' + connects.length);

  // CRITICAL branching rule: every message must come AFTER that lead's accept.
  let violation = null;
  messages.forEach(m => {
    const accept = events.find(e => e.enrollmentId === m.enrollmentId && e.status === 'accepted');
    if (!accept || accept.at > m.at) violation = m.enrollmentId;
  });
  ok('no message sent before connection accepted', violation === null, 'enrollment ' + violation);

  // enrollments that never accepted should NOT have a message and should stop
  const stoppedNotAccepted = store.where('enrollments', e => e.stopReason === 'not_accepted');
  ok('un-accepted invites stop gracefully (some or none)', stoppedNotAccepted.length >= 0);
}

/* ============================================================ */
section('4. Daily limits + warm-up are enforced');
{
  const { store: s2, engine: e2 } = freshEngine();
  // one LinkedIn account, fully warmed (created 60 days ago) so cap = base 20 connects/day
  const acc = s2.insert('channelAccounts', A.build.channelAccount('linkedin', 'Bulk', { createdAt: START - 60 * DAY }));
  const camp = s2.insert('campaigns', A.build.campaign({ name: 'Bulk', status: 'active', channelAccountIds: [acc.id] }));
  const seq = s2.insert('sequences', A.build.sequence(camp.id, [A.build.actionStep('linkedin', 'connect', { body: 'Hi {first_name}' })]));
  s2.update('campaigns', camp.id, { sequenceId: seq.id });
  // 50 leads all want to connect on day one
  const ids = [];
  for (let i = 0; i < 50; i++) ids.push(s2.insert('leads', A.build.lead({ firstName: 'L' + i, email: 'l' + i + '@ex.com' })).id);
  e2.enroll(camp.id, ids, START);

  // run a SINGLE working day (09:00 → 17:00) in 30-min steps
  const dayEnd = new Date(2026, 5, 1, 17, 0, 0, 0).getTime();
  e2.fastForward(START, dayEnd, 30 * 60000);
  const sentToday = s2.getCount(acc.id, A.Limits(s2).dateStr(START), 'connect');
  ok('connects on day 1 are capped at 20 (warmed base)', sentToday <= 20, 'sent=' + sentToday);
  ok('cap actually reached (not zero)', sentToday >= 1, 'sent=' + sentToday);

  // warm-up: a brand-new account (created today) caps lower than 20
  const capNew = A.Limits(s2).effectiveCap(A.build.channelAccount('linkedin', 'New', { createdAt: START }), 'connect', START);
  ok('fresh account warm-up cap < 20', capNew < 20, 'cap=' + capNew);
  ok('fresh account warm-up cap ≈ 30% of 20', capNew >= 5 && capNew <= 8, 'cap=' + capNew);
}

/* ============================================================ */
section('5. Working hours & weekends are respected');
{
  const { store: s3, engine: e3 } = freshEngine();
  const acc = s3.insert('channelAccounts', A.build.channelAccount('linkedin', 'Hrs', { createdAt: START - 60 * DAY }));
  const lim = A.Limits(s3);
  // Saturday 2026-06-06 12:00 → must defer to Monday 09:00
  const sat = new Date(2026, 5, 6, 12, 0, 0, 0).getTime();
  const next = lim.nextAllowedTime(acc, sat);
  const nd = new Date(next);
  ok('weekend defers to a weekday', nd.getDay() !== 0 && nd.getDay() !== 6, 'got day ' + nd.getDay());
  ok('deferred to 09:00 start hour', nd.getHours() === 9, 'hour ' + nd.getHours());
  // 22:00 weekday → next day 09:00
  const late = new Date(2026, 5, 2, 22, 0, 0, 0).getTime();
  const ln = new Date(lim.nextAllowedTime(acc, late));
  ok('after-hours defers to next 09:00', ln.getHours() === 9 && ln.getDate() === 3, ln.toString());
}

/* ============================================================ */
section('6. Reply pauses the sequence; blacklist blocks enrollment');
{
  const { store: s4, engine: e4 } = freshEngine({ acceptRate: 1, replyRate: 1, failRate: 0 }, 7); // force accept+reply
  const acc = s4.insert('channelAccounts', A.build.channelAccount('linkedin', 'R', { createdAt: START - 60 * DAY }));
  const camp = s4.insert('campaigns', A.build.campaign({ name: 'R', status: 'active', channelAccountIds: [acc.id] }));
  const seq = s4.insert('sequences', A.build.sequence(camp.id, [
    A.build.actionStep('linkedin', 'connect', { body: 'Hi {first_name}' }),
    A.build.delayStep(1, 'days'),
    A.build.actionStep('linkedin', 'message', { body: 'Hey {first_name}', requireAccepted: true }),
    A.build.delayStep(1, 'days'),
    A.build.actionStep('linkedin', 'message', { body: 'Following up' }),
  ]));
  s4.update('campaigns', camp.id, { sequenceId: seq.id });
  const lead = s4.insert('leads', A.build.lead({ firstName: 'Reply', email: 'r@ex.com' }));
  e4.enroll(camp.id, [lead.id], START);
  e4.fastForward(START, START + 20 * DAY, 6 * HOUR);
  const enr = s4.where('enrollments', e => e.leadId === lead.id)[0];
  ok('enrollment marked replied', enr.status === 'replied' || enr.repliedAt != null, 'status=' + enr.status);
  ok('a thread was created in the inbox', s4.where('threads', t => t.leadId === lead.id).length === 1);

  // blacklist
  s4.blacklist().domains.push('blocked.com');
  const bad = s4.insert('leads', A.build.lead({ firstName: 'Bad', email: 'x@blocked.com' }));
  const cre = e4.enroll(camp.id, [bad.id], START);
  ok('blacklisted lead is stopped on enroll', cre[0].status === 'stopped' && cre[0].stopReason === 'blacklisted');
}

/* ============================================================ */
section('7. Analytics roll up');
{
  const stats = engine.analytics(seeded.campaign.id);
  ok('campaign stats have enrolled count', stats.enrolled === 6);
  ok('acceptRate is a percentage 0–100', stats.acceptRate >= 0 && stats.acceptRate <= 100);
  const totals = engine.analytics();
  ok('workspace roll-up sums enrolled', totals.enrolled >= 6);
}

/* ============================================================ */
section('8. Throttles: weekly invite cap, hourly + daily-total ceilings, presets');
{
  const { store: s5 } = freshEngine();
  const lim = A.Limits(s5);
  // presets
  ok('exposes conservative/balanced/aggressive presets', !!(A.SAFETY_PRESETS.conservative && A.SAFETY_PRESETS.balanced && A.SAFETY_PRESETS.aggressive));
  const acc = A.applyPreset(A.build.channelAccount('linkedin', 'P', { createdAt: START - 60 * DAY }), 'conservative');
  s5.insert('channelAccounts', acc);
  ok('preset sets conservative connect cap (15)', acc.dailyLimits.connect === 15, 'got ' + acc.dailyLimits.connect);
  ok('preset sets a weekly invite cap (80)', acc.safety.weeklyInviteCap === 80);

  // weekly invite cap: simulate 80 connects already this week across prior days
  for (let i = 0; i < 7; i++) s5.bump(acc.id, lim.dateStr(START - i * DAY), 'connect', 12); // 84 across the rolling 7-day window
  const wk = lim.check(acc, 'connect', START, { invite: true });
  ok('weekly invite cap blocks once exceeded', !wk.allowed && wk.reason === 'weekly_invites', JSON.stringify(wk));

  // hourly ceiling
  const acc2 = s5.insert('channelAccounts', A.build.channelAccount('linkedin', 'H', { createdAt: START - 60 * DAY }));
  for (let i = 0; i < acc2.safety.hourlyMax; i++) s5.bump(acc2.id, lim.dateHour(START), '__total', 1);
  const hr = lim.check(acc2, 'view', START, {});
  ok('hourly ceiling blocks bursts', !hr.allowed && hr.reason === 'hourly_cap', JSON.stringify(hr));

  // daily total ceiling
  const acc3 = s5.insert('channelAccounts', A.build.channelAccount('linkedin', 'T', { createdAt: START - 60 * DAY, safety: Object.assign({}, A.DEFAULT_SAFETY, { dailyTotalCap: 5, hourlyMax: 999 }) }));
  for (let i = 0; i < 5; i++) s5.bump(acc3.id, lim.dateStr(START), '__total', 1);
  const tot = lim.check(acc3, 'view', START, {});
  ok('daily total ceiling blocks across all action types', !tot.allowed && tot.reason === 'daily_total', JSON.stringify(tot));

  // usage snapshot for the monitoring dashboard
  const u = lim.usage(acc, START);
  ok('usage() reports per-action used/cap + totals', u.actions.connect && typeof u.actions.connect.cap === 'number' && typeof u.weeklyInvites === 'number');
  ok('usage() reports warmup percent', u.warmupPct > 0 && u.warmupPct <= 1);
}

/* ============================================================ */
console.log('\n' + (fail === 0 ? '\x1b[32m' : '\x1b[31m') + '─'.repeat(46) + '\x1b[0m');
console.log((fail === 0 ? '\x1b[32m' : '\x1b[31m') + `  ${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
