/* Popup control panel — talks to the background worker via ROS messages. */
(function () {
  'use strict';
  const { TYPE, ACTION, send } = window.ROS;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  let state = null;

  async function refresh() {
    const res = await send({ type: TYPE.GET_STATE });
    if (!res || !res.ok) { $('#acct').textContent = 'Extension error'; return; }
    state = res.state; render();
  }

  function render() {
    const s = state;
    $('#acct').textContent = s.account ? ('Connected as ' + s.account.name) : (s.connected ? 'LinkedIn open' : 'Not connected');
    $('#connectBtn').textContent = s.account ? 'Reconnect' : 'Connect';
    $('#statusDot') && $('#statusDot').classList.toggle('on', s.connected);

    // scrape status
    if (s.scrape) {
      const box = $('#scrapeStatus'); box.style.display = 'block';
      const running = s.scrape.status === 'running';
      box.innerHTML = `<div class="p-row"><span>${running ? '⏳ Scraping' : s.scrape.status === 'done' ? '✅ Done' : '⏹ Stopped'}: <b>${s.scrape.name}</b></span></div>
        <div class="p-row"><span class="p-k">Page</span><span>${s.scrape.page} / ${s.scrape.maxPages}</span></div>
        <div class="p-row"><span class="p-k">Leads captured</span><span class="p-v">${s.scrape.total}</span></div>
        ${running ? '<button id="stopScrape" class="p-btn ghost sm" style="width:100%;margin-top:6px">Stop</button>' : ''}`;
      const stop = $('#stopScrape'); if (stop) stop.onclick = async () => { await send({ type: TYPE.SCRAPE_STOP, finished: false }); refresh(); };
    }

    // datasets
    $('#dsCount').textContent = (s.datasets || []).length;
    $('#datasetList').innerHTML = (s.datasets || []).length ? s.datasets.map(d => `
      <div class="p-item col">
        <div class="p-row"><span class="nm"><b>${escapeHtml(d.name)}</b></span><span class="pill">${d.count} leads</span></div>
        <div class="p-row" style="gap:6px;margin-top:6px">
          <button class="p-btn ghost xs" data-export="${d.id}">⬇ CSV</button>
          <button class="p-btn ghost xs" data-camp="${d.id}">→ Campaign</button>
          <button class="p-btn ghost xs danger" data-del="${d.id}">Delete</button>
        </div>
      </div>`).join('') : '<div class="p-empty">No datasets yet. Scrape a Sales Nav search.</div>';
    $$('[data-export]').forEach(b => b.onclick = async () => { const r = await send({ type: TYPE.EXPORT_CSV, id: b.dataset.export }); flash(r.ok ? 'Downloading ' + r.filename : 'Export failed: ' + r.info); });
    $$('[data-camp]').forEach(b => b.onclick = async () => { const r = await send({ type: TYPE.DATASET_TO_CAMPAIGN, id: b.dataset.camp }); flash(r.ok ? (r.via === 'backend' ? 'Sent ' + r.sent + ' leads to portal' : r.info) : 'Failed'); });
    $$('[data-del]').forEach(b => b.onclick = async () => { await send({ type: TYPE.DELETE_DATASET, id: b.dataset.del }); refresh(); });

    // outreach
    const toggle = $('#runToggle');
    toggle.textContent = s.running ? '⏸ Pause' : '▶ Start';
    toggle.classList.toggle('running', s.running);
    $('#runInfo').textContent = s.running ? 'Running' : 'Idle';
    $('#liveWarn').style.display = s.settings.liveActions ? 'block' : 'none';
    $('#qCount').textContent = s.queue.length;
    $('#queueList').innerHTML = s.queue.length ? s.queue.slice(0, 6).map(a => item(a.type, a.target && a.target.name, a.status)).join('')
      : ((s.done || []).length ? (s.done.slice(-5).reverse().map(d => item(d.type, d.target && d.target.name, d.ok ? 'ok' : 'fail')).join('')) : '<div class="p-empty">No actions yet</div>');

    // meters
    const key = dateKey();
    const caps = s.settings.dailyLimits || {};
    $('#limitMeters').innerHTML = Object.keys(caps).map(a => {
      const used = (s.counts || {})[key + '|' + a] || 0, cap = caps[a], pct = Math.min(100, used / cap * 100);
      return `<div class="meter"><div class="ml"><span>${a}</span><span>${used} / ${cap}</span></div><div class="mt"><div class="mf ${used >= cap ? 'full' : ''}" style="width:${pct}%"></div></div></div>`;
    }).join('');

    // settings
    $('#setLive').checked = !!s.settings.liveActions;
    $('#setBackend').value = s.settings.backendBaseUrl || '';
    $('#setStart').value = s.settings.workingHours.start;
    $('#setEnd').value = s.settings.workingHours.end;
    $('#setGapMin').value = s.settings.pacing.minSeconds;
    $('#setGapMax').value = s.settings.pacing.maxSeconds;
    $('#setWeekends').checked = !!s.settings.weekendsOff;
  }

  function item(type, name, status) {
    const cls = status === 'ok' ? 'ok' : status === 'fail' ? 'fail' : '';
    return `<div class="p-item"><span class="pill ${cls}">${type}</span><span class="nm">${escapeHtml(name) || '—'}</span></div>`;
  }
  function dateKey() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  let toastT; function flash(msg) { let t = $('#pToast'); if (!t) { t = document.createElement('div'); t.id = 'pToast'; t.className = 'p-toast'; document.body.appendChild(t); } t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2400); }

  /* ---- tabs ---- */
  $$('.p-tab').forEach(t => t.addEventListener('click', () => {
    $$('.p-tab').forEach(x => x.classList.remove('active')); t.classList.add('active');
    $$('.p-panel').forEach(p => p.classList.toggle('active', p.id === 'pp-' + t.dataset.tab));
  }));

  /* ---- account ---- */
  $('#connectBtn').addEventListener('click', async () => {
    $('#connectBtn').textContent = '...';
    const r = await send({ type: TYPE.CONNECT_ACCOUNT });
    flash(r.ok ? 'Connected as ' + r.account.name : (r.info || 'Could not connect'));
    refresh();
  });

  /* ---- scrape ---- */
  $('#startScrape').addEventListener('click', async () => {
    const url = $('#snUrl').value.trim();
    const r = await send({ type: TYPE.SCRAPE_START, url, name: $('#snName').value.trim(), maxPages: +$('#snPages').value });
    flash(r.ok ? 'Scrape started, opening the search...' : (r.info || 'Could not start'));
    setTimeout(refresh, 800);
  });
  $('#dryRun').addEventListener('click', async () => {
    // ask the active tab to scrape just the current page
    const tabs = await chrome.tabs.query({ active: true, url: 'https://www.linkedin.com/*' });
    if (!tabs.length) { flash('Open your Sales Nav search in the active tab first'); return; }
    chrome.tabs.sendMessage(tabs[0].id, { type: TYPE.SCRAPE_ONE_PAGE, name: 'sample' }, (res) => {
      if (chrome.runtime.lastError || !res) { flash('No response — are you on a Sales Nav search page?'); return; }
      flash(res.ok ? ('Found ' + res.count + ' on this page (' + ((res.sample[0] && res.sample[0].fullName) || '') + '...)') : (res.info || 'No cards found'));
    });
  });

  /* ---- outreach ---- */
  $('#runToggle').addEventListener('click', async () => { await send({ type: TYPE.SET_RUNNING, running: !state.running }); refresh(); });
  $('#testCapture').addEventListener('click', async () => {
    const r = await send({ type: TYPE.TEST_ACTION, action: { type: ACTION.VIEW, target: {}, meta: { test: true } } });
    flash(r && r.ok ? 'Profile read OK' : ('Failed: ' + (r && r.info)));
  });
  $('#testConnect').addEventListener('click', async () => {
    if (!state.settings.liveActions && !confirm('Live actions are OFF, so this will be simulated. Continue?')) return;
    if (state.settings.liveActions && !confirm('This sends a REAL connection request on the profile open in your active tab. Continue?')) return;
    const r = await send({ type: TYPE.TEST_ACTION, action: { type: ACTION.CONNECT, target: {}, payload: {} } });
    flash(r && r.ok ? (r.info || 'Connect sent') : ('Failed: ' + (r && r.info)));
  });

  /* ---- settings ---- */
  $('#setLive').addEventListener('change', async (e) => {
    if (e.target.checked && !confirm('Turn ON live actions? Real clicks will fire on LinkedIn. Keep volumes humane and within ToS.')) { e.target.checked = false; return; }
    await send({ type: TYPE.SET_LIVE, live: e.target.checked }); refresh();
  });
  $('#saveSettings').addEventListener('click', async () => {
    await send({ type: TYPE.UPDATE_SETTINGS, settings: {
      backendBaseUrl: $('#setBackend').value.trim(),
      workingHours: { start: +$('#setStart').value, end: +$('#setEnd').value },
      pacing: { minSeconds: +$('#setGapMin').value, maxSeconds: +$('#setGapMax').value },
      weekendsOff: $('#setWeekends').checked,
    }});
    flash('Settings saved'); refresh();
  });

  refresh();
  setInterval(refresh, 2500);
})();
