/* ============================================================
   RecruitersOS, Command Center logic (mock-data demo)
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- DATA ---------------- */

  const CAMPAIGNS = [
    { id: 'react', name: 'Senior React · Berlin', status: 'live', color: '#38e0a6', motion: 'Recruiting' },
    { id: 'vp-eng', name: 'VP Eng search · Fintech', status: 'live', color: '#38e0a6', motion: 'Recruiting' },
    { id: 'bd-saas', name: 'BD · Series B SaaS hiring', status: 'live', color: '#4dd0ff', motion: 'Business Dev' },
    { id: 'nurses', name: 'ICU Nurses · Remote triage', status: 'draft', color: '#ffc24d', motion: 'Recruiting' },
  ];

  // Candidate pool used to populate the grid on search
  const CANDIDATES = [
    { n: 'Anja Köhler', t: 'Sr. Frontend Engineer', co: 'Trade Republic', loc: 'Berlin, DE', c: '#7c5cff',
      why: 'Team reorg + 4yr tenure', email: 'anja.kohler@proton.me', score: 94 },
    { n: 'Marco Silva', t: 'Staff Engineer', co: 'N26', loc: 'Berlin, DE', c: '#4dd0ff',
      why: 'Posted "open to chats"', email: 'm.silva@hey.com', score: 91 },
    { n: 'Lena Dietrich', t: 'Frontend Lead', co: 'Pitch (closed)', loc: 'Berlin, DE', c: '#ff7ac6',
      why: 'Startup wound down', email: 'lena.d@gmail.com', score: 88 },
    { n: 'Tomas Berg', t: 'Sr. React Developer', co: 'Zalando', loc: 'Berlin, DE', c: '#38e0a6',
      why: 'Promo passed over', email: 'tomasberg@fastmail.com', score: 90 },
    { n: 'Yuki Tanaka', t: 'Senior SWE, Frontend', co: 'Delivery Hero', loc: 'Berlin, DE', c: '#ffc24d',
      why: '5yr tenure milestone', email: 'yuki.t@outlook.com', score: 86 },
    { n: 'Priya Nair', t: 'Frontend Engineer II', co: 'GetYourGuide', loc: 'Berlin, DE', c: '#7c5cff',
      why: 'Visa-portable, active', email: 'priya.nair@gmail.com', score: 84 },
    { n: 'Oskar Wendt', t: 'Sr. React Engineer', co: 'SoundCloud', loc: 'Berlin, DE', c: '#4dd0ff',
      why: 'Recent layoff round', email: 'oskar.wendt@proton.me', score: 89 },
    { n: 'Clara Moreau', t: 'Staff Frontend', co: 'Personio', loc: 'Munich → Berlin', c: '#ff7ac6',
      why: 'Relocating to Berlin', email: 'clara.moreau@hey.com', score: 87 },
    { n: 'Diego Rossi', t: 'Sr. Frontend Engineer', co: 'HelloFresh', loc: 'Berlin, DE', c: '#38e0a6',
      why: 'Endorsed for React 3x', email: 'diego.rossi@gmail.com', score: 83 },
  ];

  const SIGNALS = [
    { type: 'funding', cls: 't-funding', label: 'Funding', co: 'Verla Health', title: 'Verla Health raised a $40M Series B',
      detail: 'Healthcare AI startup plans to triple engineering. 9 open roles posted this week.', time: '2h ago', motion: 'Business Dev' },
    { type: 'exec', cls: 't-exec', label: 'New exec', co: 'Brightwave', title: 'Brightwave hired a new VP of Engineering',
      detail: 'Ex-Datadog leader joining, typically rebuilds platform teams within 90 days.', time: '5h ago', motion: 'Business Dev' },
    { type: 'hire', cls: 't-hire', label: 'Hiring surge', co: 'Trade Republic', title: 'Trade Republic posted 3 frontend leadership roles',
      detail: 'Expanding into 4 new markets. Existing senior FE team is likely stretched.', time: '8h ago', motion: 'Recruiting' },
    { type: 'layoff', cls: 't-layoff', label: 'Layoff', co: 'Pitch', title: 'Pitch announced a 40% workforce reduction',
      detail: 'Strong frontend talent now on the market, move fast before competitors.', time: '1d ago', motion: 'Recruiting' },
    { type: 'expand', cls: 't-expand', label: 'Expansion', co: 'Cobalt', title: 'Cobalt opening a Berlin engineering hub',
      detail: 'Greenfield team, strong fit for relocating senior engineers.', time: '1d ago', motion: 'Business Dev' },
    { type: 'hire', cls: 't-hire', label: 'Movement', co: 'SoundCloud', title: 'SoundCloud completed a restructuring round',
      detail: '6 senior React engineers updated profiles to "open to work" this week.', time: '2d ago', motion: 'Recruiting' },
  ];

  const SEQUENCE = [
    { ch: 'Email', icon: '✉️', wait: null, sub: 'The N26 reorg + your payments work',
      body: 'Hi Anja,\n\nSaw Trade Republic is pushing into four new markets, usually a stretch for the senior frontend team holding it together.\n\nYou\'ve spent 4 years owning complex trading UIs. I\'m working with a team building a greenfield React platform (fully remote, $120-145k) where you\'d set the architecture from day one.\n\nWorth a 15-minute call this week?\n\n, Jamie' },
    { ch: 'LinkedIn', icon: '💼', wait: 'Wait 2 days', sub: 'Connection + soft nudge',
      body: 'Hi Anja, just sent you a note by email about a staff-level React role (remote, greenfield). Would love to connect here either way; your work on the Trade Republic order flow is genuinely impressive.' },
    { ch: 'SMS', icon: '💬', wait: 'Wait 2 days', sub: 'Short, direct, human',
      body: 'Hi Anja, Jamie here, following up on the remote React staff role. No pressure, but happy to share details if the timing\'s right. Open to a quick chat?' },
    { ch: 'Email', icon: '✉️', wait: 'Wait 3 days', sub: 'Breakup + value',
      body: 'Hi Anja,\n\nI\'ll close the loop here. If a remote, architecture-owning React role ever becomes interesting, my door\'s open. Either way, sharing a short write-up on how the team handles design systems at scale; thought you\'d enjoy it.\n\n, Jamie' },
  ];

  const THREADS = [
    { id: 'marco', name: 'Marco Silva', initials: 'MS', c: '#4dd0ff', hot: true,
      msgs: [
        { f: 'out', t: 'Hi Marco, saw N26 just reorged the web platform team. You\'ve been there 4 years shipping the payments flow. Open to hearing about a staff role that\'s pure greenfield?' },
        { f: 'in', t: 'Maybe. Depends on the stack and whether it\'s remote.' },
        { f: 'out', t: 'Fully remote, React + TypeScript, you\'d own architecture from day one. Comp is $120-145k. Worth a 15-min call Thursday?' },
        { f: 'in', t: 'Yeah, Thursday afternoon works.' },
      ],
      note: '🔥 Interest detected → routed to recruiter · meeting suggested' },
    { id: 'oskar', name: 'Oskar Wendt', initials: 'OW', c: '#7c5cff', hot: false,
      msgs: [
        { f: 'out', t: 'Hi Oskar, tough news about the SoundCloud round. You shipped some of the best audio UI on the web. I\'ve got a remote senior React role that might be a great landing spot. Worth a look?' },
        { f: 'in', t: 'Appreciate it. Send me the details?' },
        { f: 'out', t: 'Just emailed them over. Remote, $110-130k, strong design-systems culture. Let me know what you think!' },
      ],
      note: 'AI replied automatically · awaiting candidate' },
    { id: 'clara', name: 'Clara Moreau', initials: 'CM', c: '#ff7ac6', hot: false,
      msgs: [
        { f: 'out', t: 'Hi Clara, congrats on the Berlin move! A team I work with is building a greenfield React platform there. Open to a quick chat?' },
        { f: 'in', t: 'Hi! I just signed somewhere else last week, but thank you.' },
        { f: 'out', t: 'Totally understand, congrats! I\'ll check back in 6 months. Best of luck in the new role. 🎉' },
      ],
      note: 'Politely declined · follow-up scheduled +6mo' },
  ];

  const REPORT = {
    stats: [
      { big: '142', lbl: 'Targets sourced', delta: '+38 this week', up: true },
      { big: '31%', lbl: 'Reply rate', delta: '+12% vs cold', up: true },
      { big: '14', lbl: 'Meetings booked', delta: '+5 this week', up: true },
      { big: '3', lbl: 'Placements', delta: '$84k fees', up: true },
    ],
    signalsToMeetings: [
      { k: 'Layoff', v: 42 }, { k: 'Funding', v: 31 }, { k: 'New exec', v: 27 },
      { k: 'Hiring surge', v: 22 }, { k: 'Expansion', v: 15 },
    ],
    channels: [
      { k: 'SMS', v: 38 }, { k: 'Email', v: 24 }, { k: 'LinkedIn', v: 19 }, { k: 'Phone', v: 11 },
    ],
  };

  /* ---------------- STATE ---------------- */
  let activeCampaign = 'react';
  let gridRows = [];        // rows currently in the grid
  let extraCols = [];       // user-added AI columns
  let activeThread = 'marco';
  let activeSeqStep = 0;

  /* ---------------- HELPERS ---------------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const avatar = (initials, color) => `<span class="avatar" style="background:${color}">${initials}</span>`;
  const initialsOf = (name) => name.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();
  function scoreClass(s) { return s >= 90 ? 'hi' : s >= 85 ? 'mid' : 'lo'; }

  let toastTimer;
  function toast(msg, ok = true) {
    const t = $('#toast');
    t.innerHTML = (ok ? '<span class="tok">✓</span>' : '<span style="color:var(--accent-amber)">⚡</span>') + ' ' + msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  /* ---------------- SIDEBAR / CAMPAIGNS ---------------- */
  function renderCampaigns() {
    const list = $('#campList');
    list.innerHTML = '';
    CAMPAIGNS.forEach(c => {
      const item = el('div', 'camp-item' + (c.id === activeCampaign ? ' active' : ''));
      item.innerHTML = `<span class="cdot" style="background:${c.color}"></span>
        <span class="cname">${c.name}</span>
        <span class="cmeta">${c.motion === 'Recruiting' ? '👤' : '🏢'}</span>`;
      item.addEventListener('click', () => selectCampaign(c.id));
      list.appendChild(item);
    });
  }

  function selectCampaign(id) {
    activeCampaign = id;
    const c = CAMPAIGNS.find(x => x.id === id);
    $('#campTitle').textContent = c.name;
    $('#crumbName').textContent = c.name;
    const sp = $('#campStatus');
    sp.textContent = c.status === 'live' ? 'Live' : 'Draft';
    sp.className = 'status-pill ' + (c.status === 'live' ? 'live' : 'draft');
    // reset grid per campaign for demo realism
    gridRows = []; extraCols = [];
    renderCampaigns();
    renderTargets();
    updateTopStats();
    switchTab('signals');
  }

  /* ---------------- TABS ---------------- */
  function switchTab(name) {
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
  }
  $$('#tabs .tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  /* ---------------- SIGNALS ---------------- */
  function renderSignals() {
    const feed = $('#signalFeed');
    feed.innerHTML = '';
    SIGNALS.forEach(s => {
      const card = el('div', 'sig');
      card.innerHTML = `
        <div class="sig-top">
          <span class="sig-type ${s.cls}">${s.label}</span>
          <span class="sig-time">${s.time}</span>
        </div>
        <h3>${s.title}</h3>
        <p>${s.detail}</p>
        <button class="btn btn-ghost btn-sm">Build campaign from signal →</button>`;
      card.querySelector('button').addEventListener('click', () => {
        toast('Campaign drafted from "' + s.co + '" signal, opening Targets');
        const seed = s.motion === 'Recruiting'
          ? 'Senior engineers affected by ' + s.co + ' changes'
          : 'Decision-makers at ' + s.co + ' hiring right now';
        switchTab('targets');
        $('#searchInput').value = seed;
        runSearch();
      });
      feed.appendChild(card);
    });
    $('#cSignals').textContent = SIGNALS.length;
  }

  /* ---------------- TARGETS & ENRICH ---------------- */
  function renderHints() {
    $$('#searchHints .chip').forEach(chip => {
      chip.addEventListener('click', () => { $('#searchInput').value = chip.textContent.trim(); runSearch(); });
    });
  }

  function parseQuery(q) {
    // naive "AI" extraction of criteria for the demo
    const crits = [];
    const lc = q.toLowerCase();
    if (/senior|sr\.?|staff|lead|principal/.test(lc)) crits.push('Seniority: Senior+');
    if (/react|frontend|front-end|javascript|typescript/.test(lc)) crits.push('Skill: React / Frontend');
    if (/berlin/.test(lc)) crits.push('Location: Berlin');
    if (/remote/.test(lc)) crits.push('Open to: Remote');
    if (/startup|failed|wound|closed|layoff|laid off|affected/.test(lc)) crits.push('Signal: recent movement');
    if (/engineer|developer|swe/.test(lc)) crits.push('Role: Engineer');
    if (!crits.length) crits.push('Intent parsed', 'Ranking by relevance');
    return crits;
  }

  function runSearch() {
    const q = $('#searchInput').value.trim() || 'Senior React engineers in Berlin';
    $('#searchInput').value = q;
    const parse = $('#aiParse');
    parse.classList.add('show');
    parse.innerHTML = '<span class="spinner"></span> <b>Interpreting query…</b>';

    setTimeout(() => {
      const crits = parseQuery(q);
      parse.innerHTML = '<b>✦ Understood:</b> ' + crits.map(c => `<span class="crit">${c}</span>`).join(' ');

      // build rows from candidate pool, fresh enrichment state
      gridRows = CANDIDATES.map(c => ({ ...c, _why: null, _email: null, selected: false, extras: {} }));
      renderTargets();
      $('#cTargets').textContent = gridRows.length;
      updateTopStats();
      toast(gridRows.length + ' matching candidates found');
    }, 850);
  }

  function renderTargets() {
    const wrap = $('#targetsContent');
    if (!gridRows.length) {
      wrap.innerHTML = `<div class="empty-state"><div class="big">🎯</div>
        <h3>No targets yet</h3><p>Run a natural-language search above to populate your candidate grid.</p></div>`;
      return;
    }

    const selCount = gridRows.filter(r => r.selected).length;
    const extraHeads = extraCols.map(c => `<th class="ai-col">✦ ${c.name}</th>`).join('');

    let html = `
      <div class="grid-toolbar">
        <span class="sel-info">${selCount ? selCount + ' selected' : gridRows.length + ' candidates'}</span>
        <button class="btn btn-ghost btn-sm" id="enrichAll">⚡ Enrich all</button>
        <button class="btn btn-ghost btn-sm" id="addToSeq" ${selCount ? '' : 'disabled style="opacity:.5"'}>✉️ Add ${selCount || ''} to sequence</button>
      </div>
      <div class="grid-scroll"><table class="grid"><thead><tr>
        <th class="col-check"><input type="checkbox" id="checkAll"></th>
        <th>Candidate</th><th>Current role</th><th>Location</th>
        <th class="ai-col">✦ Why now</th><th class="ai-col">✉️ Email</th>${extraHeads}
        <th>Fit</th>
        <th class="th-add col-add" id="addColBtn">＋ AI column</th>
      </tr></thead><tbody>`;

    gridRows.forEach((r, i) => {
      const whyCell = r._why
        ? `<span class="pill violet">${r._why}</span>`
        : `<button class="enrich-btn" data-enrich="why" data-i="${i}">Enrich</button>`;
      const emailCell = r._email
        ? `<span class="pill green">${r._email}</span>`
        : `<button class="enrich-btn" data-enrich="email" data-i="${i}">Find email</button>`;
      const extraCells = extraCols.map(c => {
        const v = r.extras[c.id];
        return v
          ? `<td><span class="pill amber">${v}</span></td>`
          : `<td><button class="enrich-btn" data-enrich="extra" data-col="${c.id}" data-i="${i}">Run</button></td>`;
      }).join('');

      html += `<tr class="${r.selected ? 'selected' : ''}">
        <td class="col-check"><input type="checkbox" data-sel="${i}" ${r.selected ? 'checked' : ''}></td>
        <td><span class="cell-name">${avatar(initialsOf(r.n), r.c)} ${r.n}</span></td>
        <td>${r.t} · <span style="color:var(--text-dim)">${r.co}</span></td>
        <td>${r.loc}</td>
        <td>${whyCell}</td>
        <td>${emailCell}</td>
        ${extraCells}
        <td><span class="score ${scoreClass(r.score)}">${r.score}</span></td>
        <td></td>
      </tr>`;
    });
    html += '</tbody></table></div>';
    wrap.innerHTML = html;
    wireGrid();
  }

  function wireGrid() {
    $('#checkAll')?.addEventListener('change', (e) => {
      gridRows.forEach(r => r.selected = e.target.checked);
      renderTargets();
    });
    $$('[data-sel]').forEach(cb => cb.addEventListener('change', (e) => {
      gridRows[+e.target.dataset.sel].selected = e.target.checked;
      renderTargets();
    }));
    $$('[data-enrich]').forEach(btn => btn.addEventListener('click', () => enrichCell(btn)));
    $('#addColBtn')?.addEventListener('click', addColumn);
    $('#enrichAll')?.addEventListener('click', enrichAll);
    $('#addToSeq')?.addEventListener('click', () => {
      const n = gridRows.filter(r => r.selected).length;
      if (!n) return;
      toast(n + ' candidate' + (n > 1 ? 's' : '') + ' added to the outreach sequence');
      switchTab('outreach');
    });
  }

  function enrichCell(btn) {
    const i = +btn.dataset.i, kind = btn.dataset.enrich;
    btn.outerHTML = '<span class="spinner"></span>';
    const delay = 500 + Math.random() * 700;
    setTimeout(() => {
      const r = gridRows[i];
      if (kind === 'why') r._why = r.why;
      else if (kind === 'email') r._email = r.email;
      else if (kind === 'extra') {
        const col = extraCols.find(c => c.id === btn.dataset.col);
        r.extras[col.id] = col.gen(r);
      }
      renderTargets();
    }, delay);
  }

  function enrichAll() {
    toast('Enriching all rows…');
    let i = 0;
    const tick = () => {
      if (i >= gridRows.length) { renderTargets(); toast('All rows enriched'); return; }
      const r = gridRows[i];
      r._why = r.why; r._email = r.email;
      extraCols.forEach(c => { r.extras[c.id] = c.gen(r); });
      i++;
      renderTargets();
      setTimeout(tick, 160);
    };
    tick();
  }

  const COLUMN_LIBRARY = [
    { name: 'Years in role', gen: r => (2 + (r.score % 5)) + ' yrs' },
    { name: 'GitHub activity', gen: r => ['High', 'Medium', 'Very high'][r.score % 3] },
    { name: 'Likely to move', gen: r => (r.score >= 88 ? 'High' : 'Medium') },
    { name: 'Comp estimate', gen: r => '$' + (95 + (r.score % 9) * 5) + 'k' },
    { name: 'Personalized hook', gen: r => 'Mention ' + r.co + ' work' },
  ];
  function addColumn() {
    const next = COLUMN_LIBRARY[extraCols.length % COLUMN_LIBRARY.length];
    extraCols.push({ id: 'x' + extraCols.length, name: next.name, gen: next.gen });
    toast('AI column added: "' + next.name + '"');
    renderTargets();
  }

  function updateTopStats() {
    const n = gridRows.length;
    $('#statTargets').textContent = n;
    $('#statReached').textContent = Math.round(n * 0.66);
    $('#statReplied').textContent = Math.round(n * 0.21);
    $('#cTargets').textContent = n;
  }

  /* ---------------- OUTREACH ---------------- */
  function renderSequence() {
    const steps = $('#seqSteps');
    steps.innerHTML = '';
    SEQUENCE.forEach((s, i) => {
      if (s.wait) {
        const w = el('div', 'seq-wait', '↓ ' + s.wait);
        steps.appendChild(w);
      }
      const step = el('div', 'seq-step' + (i === activeSeqStep ? ' active' : ''));
      step.innerHTML = `<div class="schan"><span class="sicon">${s.icon}</span> ${s.ch}</div><small>${s.sub}</small>`;
      step.addEventListener('click', () => { activeSeqStep = i; renderSequence(); });
      steps.appendChild(step);
    });
    const s = SEQUENCE[activeSeqStep];
    $('#seqPreview').innerHTML = `
      <div class="to">${s.ch} · to Anja Köhler &lt;anja.kohler@proton.me&gt;</div>
      ${s.ch === 'Email' ? `<div class="subj">${s.sub}</div>` : ''}
      <div class="body">${s.body}</div>
      <button class="btn btn-ghost btn-sm regen" id="regenBtn">✦ Regenerate with AI</button>`;
    $('#regenBtn').addEventListener('click', () => toast('Regenerated a fresh variant for Anja'));
  }

  /* ---------------- SMS / CONVERSATIONS ---------------- */
  function renderThreads() {
    const list = $('#threadList');
    list.innerHTML = '';
    THREADS.forEach(th => {
      const item = el('div', 'thread' + (th.id === activeThread ? ' active' : ''));
      const last = th.msgs[th.msgs.length - 1];
      item.innerHTML = `<div class="tname">${avatar(th.initials, th.c)} ${th.name}
        ${th.hot ? '<span class="hot">🔥 HOT</span>' : ''}</div>
        <div class="tprev">${last.f === 'out' ? 'You: ' : ''}${last.t}</div>`;
      item.addEventListener('click', () => { activeThread = th.id; renderThreads(); renderChat(); });
      list.appendChild(item);
    });
    $('#cSms').textContent = THREADS.length;
  }

  function renderChat() {
    const th = THREADS.find(t => t.id === activeThread);
    const area = $('#chatArea');
    area.innerHTML = `
      <div class="chat-head">
        ${avatar(th.initials, th.c)} <b>${th.name}</b>
        <span class="ai-toggle">AI auto-reply <span class="toggle ${th.ai !== false ? 'on' : ''}" id="aiToggle"><i></i></span></span>
      </div>
      <div class="chat-body" id="chatBody"></div>
      <form class="chat-input" id="chatForm">
        <input id="chatMsg" placeholder="Type a message…" autocomplete="off"/>
        <button class="btn btn-primary btn-sm" type="submit">Send</button>
      </form>`;
    const body = $('#chatBody');
    th.msgs.forEach(m => body.appendChild(el('div', 'bubble ' + (m.f === 'out' ? 'out' : 'in'), m.t)));
    if (th.note) body.appendChild(el('div', 'bubble note', th.note));
    body.scrollTop = body.scrollHeight;

    $('#aiToggle').addEventListener('click', (e) => {
      th.ai = th.ai === false ? true : false;
      e.currentTarget.classList.toggle('on', th.ai !== false);
      toast('AI auto-reply ' + (th.ai !== false ? 'enabled' : 'paused') + ' for ' + th.name);
    });
    $('#chatForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const val = $('#chatMsg').value.trim();
      if (!val) return;
      th.msgs.push({ f: 'out', t: val });
      $('#chatMsg').value = '';
      renderChat();
      if (th.ai !== false) {
        setTimeout(() => {
          const replies = ['Sounds good, send it over!', 'Interesting, tell me more.', 'What\'s the comp range?', 'Could do a call next week.'];
          th.msgs.push({ f: 'in', t: replies[th.msgs.length % replies.length] });
          renderThreads(); renderChat();
        }, 1100);
      }
    });
  }

  /* ---------------- REPORTING ---------------- */
  function renderReporting() {
    $('#reportStats').innerHTML = REPORT.stats.map(s => `
      <div class="rstat"><div class="big gradient-text">${s.big}</div>
      <div class="lbl">${s.lbl}</div>
      <div class="delta ${s.up ? 'up' : 'down'}">${s.up ? '▲' : '▼'} ${s.delta}</div></div>`).join('');

    const bars = (data) => {
      const max = Math.max(...data.map(d => d.v));
      return data.map(d => `<div class="bar-row">
        <span class="blabel">${d.k}</span>
        <span class="btrack"><span class="bfill" style="width:${(d.v / max) * 100}%">${d.v}%</span></span>
      </div>`).join('');
    };
    $('#reportCols').innerHTML = `
      <div class="report-card"><h3>Meetings booked by signal type</h3>${bars(REPORT.signalsToMeetings)}</div>
      <div class="report-card"><h3>Reply rate by channel</h3>${bars(REPORT.channels)}</div>`;
  }

  /* ---------------- LAUNCH ---------------- */
  $('#launchBtn').addEventListener('click', () => {
    if (!gridRows.length) { toast('Add targets first, run a search', false); switchTab('targets'); return; }
    toast('Sequence launched to ' + gridRows.length + ' targets across email · LinkedIn · SMS');
  });
  $('#newCampaign').addEventListener('click', () => toast('New campaign, start with a market signal', false));

  /* ---------------- INIT ---------------- */
  function init() {
    renderCampaigns();
    renderSignals();
    renderHints();
    renderSequence();
    renderThreads();
    renderChat();
    renderReporting();
    updateTopStats();

    $('#searchBar').addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });

    // pick up ?q= from the landing page hero search
    const q = new URLSearchParams(location.search).get('q');
    if (q) {
      $('#searchInput').value = q;
      switchTab('targets');
      runSearch();
    }
  }
  init();
})();
