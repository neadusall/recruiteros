/* Popup control panel — talks to the background worker via ROS messages. */
(function () {
  'use strict';
  const { TYPE, ACTION, send } = window.ROS;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  let state = null;

  // best-practice daily caps + pacing per preset (mirrors the engine)
  const PRESETS = {
    conservative: { caps: { connect: 15, message: 35, inmail: 5, view: 50, follow: 15, endorse: 10, like: 25 }, pacing: { minSeconds: 90, maxSeconds: 240 } },
    balanced: { caps: { connect: 25, message: 60, inmail: 10, view: 80, follow: 30, endorse: 20, like: 40 }, pacing: { minSeconds: 35, maxSeconds: 140 } },
    aggressive: { caps: { connect: 40, message: 90, inmail: 15, view: 100, follow: 45, endorse: 30, like: 60 }, pacing: { minSeconds: 18, maxSeconds: 70 } },
  };

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
      box.innerHTML = `<div class="p-row"><span>${running ? '⏳ Scraping' : s.scrape.status === 'done' ? '✅ Done' : '⏹ Stopped'}: <b>${escapeHtml(s.scrape.name)}</b></span></div>
        <div class="p-row"><span class="p-k">Page</span><span>${s.scrape.page} / ${s.scrape.maxPages}</span></div>
        <div class="p-row"><span class="p-k">Leads captured</span><span class="p-v">${s.scrape.total}</span></div>
        ${s.progress ? '<div class="p-note" style="margin-top:6px">' + escapeHtml(s.progress) + '</div>' : ''}
        ${running ? '<button id="stopScrape" class="p-btn ghost sm" style="width:100%;margin-top:6px">Stop</button>' : ''}`;
      const stop = $('#stopScrape'); if (stop) stop.onclick = async () => { await send({ type: TYPE.SCRAPE_STOP, finished: false }); refresh(); };
    }

    // scrape destination toggle (BD vs Recruiting)
    const sm = s.settings.backendMotion || 'recruiting';
    $$('#snMotion .seg').forEach(b => b.classList.toggle('active', b.dataset.motion === sm));
    // portal connection status — make it obvious leads go to the portal, not just CSV
    const portalOn = !!(s.settings.backendBaseUrl && s.settings.backendApiKey);
    const dest = $('#snDest');
    if (dest) {
      dest.className = 'p-dest ' + (portalOn ? 'on' : 'off');
      let line = portalOn
        ? '✅ Connected — leads post straight into your portal <b>Prospects</b> (' + (sm === 'bd' ? 'Business Dev' : 'Recruiting') + '), with photos &amp; data.'
        : '⚠ <b>Not connected to the portal.</b> Leads save here only (CSV). In the portal: open <b>Enrich LinkedIn searches</b> → <b>Connect this workspace</b>.';
      // Last sync result — proof of whether leads actually reached the portal.
      const lp = s.lastPush;
      if (lp) {
        const ago = Math.max(0, Math.round((Date.now() - lp.at) / 1000));
        const when = ago < 60 ? ago + 's ago' : Math.round(ago / 60) + 'm ago';
        line += lp.ok
          ? '<br><span style="color:#8ff0cd">Last sync: ' + lp.count + ' → portal ✓ (' + when + ')</span>'
          : '<br><span style="color:#ffb4b4">Last sync FAILED (' + when + '): ' + escapeHtml(lp.error || 'unknown') + '</span>';
      }
      dest.innerHTML = line;
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
    // Outreach + Settings moved to the portal — the popup is the scraper only.
  }
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

  /* ---- scrape destination: BD vs Recruiting ---- */
  $$('#snMotion .seg').forEach(b => b.addEventListener('click', async (ev) => {
    ev.preventDefault();
    $$('#snMotion .seg').forEach(x => x.classList.remove('active')); b.classList.add('active');
    if (state && state.settings) state.settings.backendMotion = b.dataset.motion; // keep render() from reverting
    await send({ type: TYPE.UPDATE_SETTINGS, settings: { backendMotion: b.dataset.motion } });
    flash('Scraping to ' + (b.dataset.motion === 'bd' ? 'Business Dev' : 'Recruiting') + ' folder');
  }));

  /* ---- test portal connection (one-click diagnostic) ---- */
  $('#testPush').addEventListener('click', async () => {
    const b = $('#testPush'); b.disabled = true; b.textContent = 'Testing…';
    const r = await send({ type: 'ros.testPush' });
    b.disabled = false; b.textContent = '🔌 Test portal connection';
    if (!r) { flash('No response from the extension worker.'); return; }
    if (r.ok) flash('✓ Portal reachable — a "RecruitersOS Test" prospect was added. Check Prospects, then delete it.');
    else if (r.noBackend || !r.base) flash('✗ Not connected — open the portal → Enrich LinkedIn searches → Connect this workspace.');
    else if (!r.hasToken) flash('✗ No ingest token — click Connect this workspace in the portal.');
    else flash('✗ Failed posting to ' + r.base + ' → ' + (r.error || 'unknown'));
    refresh();
  });

  /* ---- scrape ---- */
  $('#startScrape').addEventListener('click', async () => {
    const url = $('#snUrl').value.trim();
    // No blocking prompt — the status line above already shows where leads go.
    const connected = state && state.settings && state.settings.backendBaseUrl && state.settings.backendApiKey;
    if (!connected) flash('Heads up: not connected to the portal — leads will be local (CSV) until you Connect.');
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

  // Outreach + Settings are managed in the RecruitersOS portal now — no handlers here.

  refresh();
  setInterval(refresh, 2500);
})();
