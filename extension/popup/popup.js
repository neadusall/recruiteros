/* Popup control panel — talks to the background worker via ROS messages. */
(function () {
  'use strict';
  const { TYPE, send } = window.ROS;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  let state = null;

  async function refresh() {
    const res = await send({ type: TYPE.GET_STATE });
    if (!res || !res.ok) { $('#acct').textContent = 'Extension error'; return; }
    state = res.state;
    render();
  }

  function render() {
    const s = state;
    $('#statusDot').classList.toggle('on', s.connected);
    $('#acct').textContent = s.account ? s.account.name : (s.connected ? 'LinkedIn connected' : 'Open linkedin.com');
    const toggle = $('#runToggle');
    toggle.textContent = s.running ? '⏸ Pause' : '▶ Start';
    toggle.classList.toggle('running', s.running);
    $('#runInfo').textContent = s.running ? 'Running · draining queue' : 'Idle';

    // queue
    $('#qCount').textContent = s.queue.length;
    $('#queueList').innerHTML = s.queue.length
      ? s.queue.slice(0, 8).map(a => item(a.type, a.target && a.target.name, a.status)).join('')
      : '<div class="p-empty">Queue empty</div>';
    $('#doneList').innerHTML = (s.done || []).slice(-6).reverse().map(d => item(d.type, d.target && d.target.name, d.ok ? 'ok' : 'fail')).join('') || '<div class="p-empty">No actions yet</div>';

    // limits
    const today = new Date(); const key = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
    const caps = s.settings.dailyLimits || {};
    $('#limitMeters').innerHTML = Object.keys(caps).map(action => {
      const used = (s.counts || {})[key + '|' + action] || 0;
      const cap = caps[action]; const pct = Math.min(100, used / cap * 100);
      return `<div class="meter"><div class="ml"><span>${action}</span><span>${used} / ${cap}</span></div>
        <div class="mt"><div class="mf ${used>=cap?'full':''}" style="width:${pct}%"></div></div></div>`;
    }).join('');

    // settings fields
    $('#setBackend').value = s.settings.backendBaseUrl || '';
    $('#setStart').value = s.settings.workingHours.start;
    $('#setEnd').value = s.settings.workingHours.end;
    $('#setGapMin').value = s.settings.pacing.minSeconds;
    $('#setGapMax').value = s.settings.pacing.maxSeconds;
    $('#setWeekends').checked = !!s.settings.weekendsOff;
  }
  function item(type, name, status) {
    const cls = status === 'ok' ? 'ok' : status === 'fail' ? 'fail' : '';
    return `<div class="p-item"><span class="pill ${cls}">${type}</span><span class="nm">${name || '—'}</span></div>`;
  }

  // tabs
  $$('.p-tab').forEach(t => t.addEventListener('click', () => {
    $$('.p-tab').forEach(x => x.classList.remove('active')); t.classList.add('active');
    $$('.p-panel').forEach(p => p.classList.toggle('active', p.id === 'pp-' + t.dataset.tab));
  }));

  // actions
  $('#runToggle').addEventListener('click', async () => { await send({ type: TYPE.SET_RUNNING, running: !state.running }); refresh(); });
  $('#clearQueue').addEventListener('click', async () => { await send({ type: TYPE.CLEAR_QUEUE }); refresh(); });
  $('#saveSettings').addEventListener('click', async () => {
    await send({ type: TYPE.UPDATE_SETTINGS, settings: {
      backendBaseUrl: $('#setBackend').value.trim(),
      workingHours: { start: +$('#setStart').value, end: +$('#setEnd').value },
      pacing: { minSeconds: +$('#setGapMin').value, maxSeconds: +$('#setGapMax').value },
      weekendsOff: $('#setWeekends').checked,
    }});
    refresh();
  });

  refresh();
  setInterval(refresh, 2500);
})();
