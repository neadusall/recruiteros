/* ============================================================
   Alfred Outreach Studio, browser controller
   Wires alfred.html to the Alfred engine (window.Alfred).
   Persists to localStorage; runs a simulation clock so you can
   watch multi-day campaigns drip against the Simulated channel.
   ============================================================ */
(function () {
  'use strict';
  const A = window.Alfred;
  if (!A) { console.error('alfred-core.js failed to load'); return; }
  const { DAY, HOUR } = A.constants;

  /* ---- engine + persistence ---- */
  const engine = A.Engine({ seed: 42, namespace: 'alfred:studio:v1' });
  const store = engine.store;

  const SIM_KEY = 'alfred:studio:simNow';
  function loadSim() { const v = +localStorage.getItem(SIM_KEY); return v || Date.now(); }
  function saveSim(t) { localStorage.setItem(SIM_KEY, String(t)); }
  let simNow = loadSim();

  // Start clean: a real, empty workspace with one starter campaign and NO fake
  // leads. (Sample data is available on demand from the sidebar.)
  (function bootstrap() {
    if (!store.all('campaigns').length) {
      const acc = store.all('channelAccounts')[0] || store.insert('channelAccounts', A.build.channelAccount('linkedin', 'My LinkedIn', { createdAt: simNow }));
      const c = store.insert('campaigns', A.build.campaign({ name: 'My first campaign', status: 'draft', channelAccountIds: [acc.id] }));
      const seq = store.insert('sequences', A.build.sequence(c.id, [
        A.build.actionStep('linkedin', 'view'),
        A.build.delayStep(1, 'days'),
        A.build.actionStep('linkedin', 'connect', { body: 'Hi {first_name}, would love to connect.' }),
        A.build.delayStep(2, 'days'),
        A.build.actionStep('linkedin', 'message', { body: 'Thanks for connecting, {first_name}!', requireAccepted: true }),
      ]));
      store.update('campaigns', c.id, { sequenceId: seq.id });
      saveSim(simNow);
    }
  })();
  function loadSampleData() {
    const seeded = A.seedDemo(store, simNow - 8 * DAY);
    if (seeded && seeded.campaign) {
      engine.enroll(seeded.campaign.id, seeded.leads.map(l => l.id), simNow - 8 * DAY);
      engine.fastForward(simNow - 8 * DAY, simNow, 6 * HOUR);
      activeCampaignId = seeded.campaign.id;
    }
    renderAll(); toast('Sample campaign loaded for preview');
  }

  /* ---- small helpers ---- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const initials = (n) => (n || '?').split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();
  const colorFor = (s) => { const palette = ['var(--brand)', 'var(--info)', 'var(--brand-2)', 'var(--ok)', 'var(--warn)']; let h = 0; for (const c of (s || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return palette[h % palette.length]; };
  const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const relDay = (t) => { const d = Math.round((t - simNow) / DAY); return d === 0 ? 'today' : d < 0 ? -d + 'd ago' : 'in ' + d + 'd'; };

  /* ---- inline stroke icons (replace emoji glyphs) ---- */
  const icn = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em;vertical-align:-0.125em">' + p + '</svg>';
  const ICON = {
    zap: icn('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
    layers: icn('<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>'),
    clock: icn('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>'),
    target: icn('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>'),
    msgCircle: icn('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'),
    briefcase: icn('<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>'),
    link: icn('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
    check: icn('<polyline points="20 6 9 17 4 12"/>'),
  };

  let toastT;
  function toast(msg, kind) {
    const t = $('#a-toast'); t.innerHTML = (kind === 'warn' ? ICON.zap + ' ' : '✓ ') + msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function modal(html) { $('#modal').innerHTML = html; $('#modalBg').classList.add('show'); }
  function closeModal() { $('#modalBg').classList.remove('show'); }
  $('#modalBg').addEventListener('click', (e) => { if (e.target.id === 'modalBg') closeModal(); });

  /* ---- active selection state ---- */
  let activeCampaignId = store.all('campaigns')[0] ? store.all('campaigns')[0].id : null;
  let selectedStepIdx = 0;
  let activeThreadId = null;
  let activeTab = 'sequence';

  const ACTION_CATALOG = A.CHANNELS; // {linkedin:{actions:{...}}, email, twitter}

  /* ============================================================
     RENDER, top-level dispatcher
     ============================================================ */
  function updateMode() {
    const banner = $('#modeBanner'); if (!banner) return;
    const c = campaign();
    const reachable = window.StudioExt && window.StudioExt.env().canReach;
    if (c && c._liveRoute && reachable) {
      banner.style.borderColor = 'color-mix(in srgb, var(--ok) 40%, transparent)';
      banner.innerHTML = '<span class="healthdot good"></span> <b>Live.</b> This campaign\'s LinkedIn steps run through your real account via the browser extension, with throttles and working hours enforced. The Test clock does not affect live sending.';
    } else {
      banner.style.borderColor = '';
      banner.innerHTML = '<b>Test mode.</b> Actions are simulated so you can build and preview safely. To send for real, open the <b>LinkedIn Live</b> tab, connect the extension, link your account, then enable "Route this campaign through my real account".';
    }
  }
  function renderAll() {
    $('#simNow').textContent = fmtDate(simNow);
    renderCampaigns();
    renderHeader();
    updateMode();
    renderTab(activeTab);
  }
  function renderTab(name) {
    if (name === 'sequence') renderSequence();
    else if (name === 'leads') renderLeads();
    else if (name === 'inbox') renderInbox();
    else if (name === 'templates') renderTemplates();
    else if (name === 'analytics') renderAnalytics();
    else if (name === 'live') renderLive();
    else if (name === 'settings') renderSettings();
  }

  function campaign() { return store.get('campaigns', activeCampaignId); }
  function sequence() { const c = campaign(); return c ? store.get('sequences', c.sequenceId) : null; }

  /* ---- sidebar ---- */
  function renderCampaigns() {
    const list = $('#campList'); list.innerHTML = '';
    store.all('campaigns').forEach(c => {
      const row = el('div', 'camp-row' + (c.id === activeCampaignId ? ' active' : ''));
      row.innerHTML = `<span class="cdot" style="background:${c.status === 'active' ? 'var(--accent-green)' : c.status === 'paused' ? 'var(--accent-red)' : 'var(--accent-amber)'}"></span>
        <span class="cname">${esc(c.name)}</span>
        <span class="cstatus ${c.status}">${c.status}</span>`;
      row.addEventListener('click', () => { activeCampaignId = c.id; selectedStepIdx = 0; renderAll(); });
      list.appendChild(row);
    });
  }

  /* ---- header ---- */
  function renderHeader() {
    const c = campaign();
    if (!c) { $('#campTitle').textContent = 'No campaign'; return; }
    $('#campTitle').textContent = c.name;
    const sp = $('#campStatus'); sp.textContent = c.status; sp.className = 'cstatus ' + c.status;
    $('#headDot').style.background = c.status === 'active' ? 'var(--accent-green)' : c.status === 'paused' ? 'var(--accent-red)' : 'var(--accent-amber)';
    $('#toggleStatus').textContent = c.status === 'active' ? 'Pause' : 'Activate';
  }

  /* ============================================================
     SEQUENCE BUILDER
     ============================================================ */
  let dragFrom = null;
  function renderSequence() {
    const seq = sequence();
    const canvas = $('#seqCanvas'); canvas.innerHTML = '';
    if (!seq || !seq.steps.length) {
      canvas.innerHTML = '<div class="empty"><div class="big">' + ICON.layers + '</div><p>No steps yet. Drag an action from the palette above, or click “Add action step”.</p></div>';
      $('#inspector').innerHTML = '<div class="empty"><div class="big">' + ICON.layers + '</div><p>Add your first step.</p></div>';
      wireCanvasDrop(canvas, seq);
      return;
    }
    seq.steps.forEach((step, i) => {
      const node = el('div', 'seq-node' + (i === selectedStepIdx ? ' sel' : '') + (step.kind === 'delay' ? ' is-delay' : ''));
      node.draggable = true; node.dataset.idx = i;
      if (step.kind === 'delay') {
        node.style.padding = '9px 13px';
        node.innerHTML = `<span class="sn-grip" title="Drag to reorder">⠿</span>
          <div class="sn-ico" style="font-size:15px;width:30px;height:30px">${ICON.clock}</div>
          <div class="sn-body"><div class="sn-title" style="font-size:13px">Wait ${step.delay.amount} ${step.delay.unit}</div></div>
          <div class="sn-actions"><button class="sn-iconbtn" data-del="${i}" title="Delete">✕</button></div>`;
      } else {
        const meta = ACTION_CATALOG[step.action.channel].actions[step.action.type] || {};
        const chMeta = ACTION_CATALOG[step.action.channel];
        const cond = step.action.requireAccepted || (step.condition && step.condition.type === 'if_accepted')
          ? '<span class="seq-cond">after accept</span>'
          : (step.condition && step.condition.type === 'if_replied' ? '<span class="seq-cond">if replied</span>' : '');
        node.innerHTML = `<span class="sn-grip" title="Drag to reorder">⠿</span>
          <div class="sn-ico">${chMeta.icon}</div>
          <div class="sn-body">
            <div class="sn-title">${meta.label || step.action.type} ${cond}</div>
            <div class="sn-sub">${chMeta.label} · ${esc(previewLine(step))}</div>
          </div>
          <div class="sn-actions">
            <button class="sn-iconbtn" data-up="${i}" title="Move up">↑</button>
            <button class="sn-iconbtn" data-down="${i}" title="Move down">↓</button>
            <button class="sn-iconbtn" data-del="${i}" title="Delete">✕</button>
          </div>`;
      }
      node.addEventListener('click', (e) => { if (!e.target.dataset.up && !e.target.dataset.down && !e.target.dataset.del) { selectedStepIdx = i; renderSequence(); } });
      canvas.appendChild(node);
      if (i < seq.steps.length - 1) { const rail = el('div', 'seq-rail'); rail.innerHTML = '<span class="line"></span>'; canvas.appendChild(rail); }
    });
    $$('[data-up]', canvas).forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); moveStep(+b.dataset.up, -1); }));
    $$('[data-down]', canvas).forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); moveStep(+b.dataset.down, 1); }));
    $$('[data-del]', canvas).forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); deleteStep(+b.dataset.del); }));
    wireNodeDnD(canvas);
    wireCanvasDrop(canvas, seq);
    renderInspector();
  }

  function wireNodeDnD(canvas) {
    const nodes = $$('.seq-node', canvas);
    nodes.forEach(node => {
      node.addEventListener('dragstart', (e) => { dragFrom = +node.dataset.idx; node.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'reorder'); });
      node.addEventListener('dragend', () => { dragFrom = null; nodes.forEach(n => n.classList.remove('dragging', 'drop-before', 'drop-after')); });
      node.addEventListener('dragover', (e) => { e.preventDefault(); const r = node.getBoundingClientRect(); const after = (e.clientY - r.top) > r.height / 2; node.classList.toggle('drop-after', after); node.classList.toggle('drop-before', !after); });
      node.addEventListener('dragleave', () => node.classList.remove('drop-before', 'drop-after'));
      node.addEventListener('drop', (e) => {
        e.preventDefault(); e.stopPropagation();
        const r = node.getBoundingClientRect(); const after = (e.clientY - r.top) > r.height / 2;
        let target = (+node.dataset.idx) + (after ? 1 : 0);
        const data = e.dataTransfer.getData('text/plain');
        if (data && data.indexOf('add:') === 0) return insertStepAt(data.slice(4), target);
        if (dragFrom != null) reorderStep(dragFrom, target);
      });
    });
  }
  function wireCanvasDrop(canvas, seq) {
    canvas.addEventListener('dragover', (e) => { if ((dragFrom != null) || (e.dataTransfer.types || []).includes('text/plain')) { e.preventDefault(); canvas.classList.add('drop-active'); } });
    canvas.addEventListener('dragleave', () => canvas.classList.remove('drop-active'));
    canvas.addEventListener('drop', (e) => {
      canvas.classList.remove('drop-active');
      const data = e.dataTransfer.getData('text/plain');
      if (data && data.indexOf('add:') === 0) { e.preventDefault(); insertStepAt(data.slice(4), (seq && seq.steps.length) || 0); }
    });
  }
  function makeStepFromType(typeStr) {
    if (typeStr === 'delay') return A.build.delayStep(2, 'days');
    const [ch, type] = typeStr.split(':');
    const fields = (type === 'connect') ? { body: 'Hi {first_name}, would love to connect.' }
      : (type === 'message') ? { body: 'Thanks for connecting, {first_name}!', requireAccepted: ch === 'linkedin' }
      : (type === 'email') ? { subject: 'Quick question, {first_name}', body: 'Hi {first_name},\n\n' }
      : (type === 'inmail') ? { subject: 'Quick note, {first_name}', body: 'Hi {first_name},\n\n' } : {};
    return A.build.actionStep(ch, type, fields);
  }
  function insertStepAt(typeStr, idx) {
    const seq = sequence(); if (!seq) return;
    const step = makeStepFromType(typeStr);
    idx = Math.max(0, Math.min(idx, seq.steps.length));
    seq.steps.splice(idx, 0, step);
    selectedStepIdx = idx; store.save(); renderSequence(); toast('Step added');
  }
  function reorderStep(from, to) {
    const seq = sequence(); if (!seq || from === to) return;
    const [moved] = seq.steps.splice(from, 1);
    if (to > from) to--;
    to = Math.max(0, Math.min(to, seq.steps.length));
    seq.steps.splice(to, 0, moved);
    selectedStepIdx = to; store.save(); renderSequence();
  }

  function previewLine(step) {
    const a = step.action;
    if (a.templateId) { const t = store.get('templates', a.templateId); return t ? t.name : ''; }
    return (a.subject || a.body || a.note || ACTION_CATALOG[a.channel].actions[a.type].label || '').slice(0, 60);
  }

  function renderInspector() {
    const seq = sequence(); if (!seq) return;
    const step = seq.steps[selectedStepIdx];
    const insp = $('#inspector');
    if (!step) { insp.innerHTML = '<div class="empty"><p>Select a step.</p></div>'; return; }
    if (step.kind === 'delay') {
      insp.innerHTML = `<h3>Delay</h3>
        <div class="a-field"><label class="a-label">Wait</label>
          <div class="row"><input class="a-input" id="delayAmt" type="number" min="0" value="${step.delay.amount}" style="width:90px">
          <select class="a-select" id="delayUnit"><option ${step.delay.unit==='minutes'?'selected':''}>minutes</option><option ${step.delay.unit==='hours'?'selected':''}>hours</option><option ${step.delay.unit==='days'?'selected':''}>days</option></select></div></div>`;
      $('#delayAmt').addEventListener('change', e => { step.delay.amount = +e.target.value; store.save(); renderSequence(); });
      $('#delayUnit').addEventListener('change', e => { step.delay.unit = e.target.value; store.save(); renderSequence(); });
      return;
    }
    const a = step.action;
    const chOpts = Object.keys(ACTION_CATALOG).map(ch => `<option value="${ch}" ${ch===a.channel?'selected':''}>${ACTION_CATALOG[ch].label}</option>`).join('');
    const actOpts = Object.keys(ACTION_CATALOG[a.channel].actions).map(t => `<option value="${t}" ${t===a.type?'selected':''}>${ACTION_CATALOG[a.channel].actions[t].label}</option>`).join('');
    const meta = ACTION_CATALOG[a.channel].actions[a.type] || {};
    const needsBody = (meta.needs || []).some(n => n.indexOf('body') === 0) || a.type === 'connect';
    const needsSubject = (meta.needs || []).includes('subject');
    const tplOpts = '<option value="">- inline copy -</option>' + store.all('templates').map(t => `<option value="${t.id}" ${a.templateId===t.id?'selected':''}>${esc(t.name)}</option>`).join('');

    insp.innerHTML = `<h3>${ACTION_CATALOG[a.channel].icon} Edit step</h3>
      <div class="row" style="gap:8px">
        <div class="a-field" style="flex:1"><label class="a-label">Channel</label><select class="a-select" id="iCh">${chOpts}</select></div>
        <div class="a-field" style="flex:1"><label class="a-label">Action</label><select class="a-select" id="iAct">${actOpts}</select></div>
      </div>
      <div class="a-field"><label class="a-label">Template</label><select class="a-select" id="iTpl">${tplOpts}</select></div>
      ${needsSubject ? `<div class="a-field"><label class="a-label">Subject</label><input class="a-input" id="iSubj" value="${esc(a.subject||'')}"></div>` : ''}
      ${needsBody && !(a.variants && a.variants.length) ? `<div class="a-field"><label class="a-label">${a.type==='connect'?'Connection note':'Message body'}</label><textarea class="a-textarea" id="iBody" placeholder="Hi {first_name}, ...">${esc(a.body||a.note||'')}</textarea></div>` : ''}
      ${needsBody ? `<div class="a-field" id="iVarsWrap"><label class="a-label" style="display:flex;justify-content:space-between;align-items:center">A/B variants <button class="a-btn ghost sm" id="iAddVar" style="padding:2px 8px">+ Variant</button></label><div id="iVars"></div></div>` : ''}
      ${a.type==='connect' ? '' : `<div class="a-field"><label class="a-label">Run condition</label><select class="a-select" id="iCond">
          <option value="always">Always (after previous step)</option>
          <option value="accept">Only after connection accepted</option>
          <option value="reply">Only if they replied</option></select></div>
        <div class="a-field" id="iElseWrap"><label class="a-label">If condition not met</label><select class="a-select" id="iElse"><option value="skip">Skip this step</option><option value="stop">Stop the sequence</option></select></div>`}
      <div class="a-label">Live preview · ${esc(firstLeadName())}</div>
      <div class="preview-box"><div class="preview-to" id="pvTo"></div><div id="pvBody"></div></div>
      <div class="warnflag" id="pvWarn"></div>`;

    $('#iCh').addEventListener('change', e => { a.channel = e.target.value; a.type = Object.keys(ACTION_CATALOG[a.channel].actions)[0]; a.templateId = null; store.save(); renderSequence(); });
    $('#iAct').addEventListener('change', e => { a.type = e.target.value; store.save(); renderSequence(); });
    $('#iTpl').addEventListener('change', e => { a.templateId = e.target.value || null; store.save(); renderSequence(); });
    $('#iSubj') && $('#iSubj').addEventListener('input', e => { a.subject = e.target.value; store.save(); updatePreview(step); });
    $('#iBody') && $('#iBody').addEventListener('input', e => { if (a.type === 'connect') a.note = e.target.value; a.body = e.target.value; store.save(); updatePreview(step); });

    // condition editor
    const condSel = $('#iCond');
    if (condSel) {
      const cur = a.requireAccepted || (step.condition && step.condition.type === 'if_accepted') ? 'accept'
        : (step.condition && step.condition.type === 'if_replied') ? 'reply' : 'always';
      condSel.value = cur;
      const elseWrap = $('#iElseWrap'); if (elseWrap) elseWrap.style.display = cur === 'reply' ? 'block' : 'none';
      if ($('#iElse') && step.condition) $('#iElse').value = step.condition.else || 'skip';
      condSel.addEventListener('change', e => {
        const v = e.target.value;
        a.requireAccepted = v === 'accept';
        step.condition = v === 'reply' ? { type: 'if_replied', else: ($('#iElse') && $('#iElse').value) || 'skip' } : { type: v === 'accept' ? 'if_accepted' : 'always' };
        store.save(); renderSequence();
      });
      $('#iElse') && $('#iElse').addEventListener('change', e => { if (step.condition) { step.condition.else = e.target.value; store.save(); } });
    }

    // inline A/B variants
    renderStepVariants(step);
    $('#iAddVar') && $('#iAddVar').addEventListener('click', (e) => {
      e.preventDefault();
      if (!a.variants || !a.variants.length) a.variants = [{ label: 'A', weight: 1, body: a.body || a.note || '' }];
      a.variants.push({ label: String.fromCharCode(65 + a.variants.length), weight: 1, body: '' });
      store.save(); renderInspector();
    });
    updatePreview(step);
  }

  function renderStepVariants(step) {
    const wrap = $('#iVars'); if (!wrap) return;
    const a = step.action;
    if (!a.variants || !a.variants.length) { wrap.innerHTML = '<p class="dim" style="font-size:11.5px">One message. Add a variant to A/B test.</p>'; return; }
    wrap.innerHTML = a.variants.map((v, i) => `
      <div class="card" style="padding:9px;margin-bottom:6px">
        <div class="row" style="justify-content:space-between;margin-bottom:5px"><b style="font-size:12px">Variant ${esc(v.label || String.fromCharCode(65 + i))}</b>
          <span class="row" style="gap:6px"><input class="a-input" type="number" min="1" data-vw="${i}" value="${v.weight || 1}" style="width:54px" title="Traffic weight"><button class="a-btn ghost sm danger" data-vdel="${i}" style="padding:2px 7px">✕</button></span></div>
        <textarea class="a-textarea" data-vb="${i}" style="min-height:64px">${esc(v.body || '')}</textarea>
      </div>`).join('');
    $$('[data-vb]', wrap).forEach(t => t.addEventListener('input', e => { a.variants[+e.target.dataset.vb].body = e.target.value; store.save(); updatePreview(step); }));
    $$('[data-vw]', wrap).forEach(inp => inp.addEventListener('change', e => { a.variants[+e.target.dataset.vw].weight = Math.max(1, +e.target.value); store.save(); }));
    $$('[data-vdel]', wrap).forEach(b => b.addEventListener('click', (e) => { e.preventDefault(); a.variants.splice(+b.dataset.vdel, 1); if (a.variants.length === 1) { a.body = a.variants[0].body; a.variants = []; } store.save(); renderInspector(); }));
  }

  function firstLead() { return store.all('leads')[0] || A.build.lead({ firstName: 'Anja', company: 'Trade Republic' }); }
  function firstLeadName() { const l = firstLead(); return l.fullName || l.firstName; }
  function updatePreview(step) {
    const a = step.action, lead = firstLead();
    let subjSrc = a.subject, bodySrc = (a.variants && a.variants.length) ? a.variants[0].body : (a.body || a.note);
    if (a.templateId) { const t = store.get('templates', a.templateId); if (t) { subjSrc = subjSrc || t.subject; bodySrc = bodySrc || A.pickVariant(t); } }
    const channelMeta = ACTION_CATALOG[a.channel];
    $('#pvTo') && ($('#pvTo').textContent = `${channelMeta.label} · to ${lead.fullName || lead.firstName}`);
    const body = A.render(bodySrc || ACTION_CATALOG[a.channel].actions[a.type].label, lead);
    $('#pvBody') && ($('#pvBody').textContent = (subjSrc ? A.render(subjSrc, lead) + '\n\n' : '') + body);
    const miss = A.missingFields(bodySrc || '', lead).concat(A.missingFields(subjSrc || '', lead));
    $('#pvWarn') && ($('#pvWarn').textContent = miss.length ? 'Unknown merge fields: ' + [...new Set(miss)].map(m => '{' + m + '}').join(', ') : '');
  }

  function moveStep(i, dir) {
    const seq = sequence(); const j = i + dir;
    if (j < 0 || j >= seq.steps.length) return;
    const tmp = seq.steps[i]; seq.steps[i] = seq.steps[j]; seq.steps[j] = tmp;
    selectedStepIdx = j; store.save(); renderSequence();
  }
  function deleteStep(i) {
    const seq = sequence(); seq.steps.splice(i, 1);
    selectedStepIdx = Math.max(0, i - 1); store.save(); renderSequence(); toast('Step removed');
  }
  $('#addAction').addEventListener('click', () => {
    const seq = sequence(); if (!seq) return;
    seq.steps.push(A.build.actionStep('linkedin', 'connect', { body: 'Hi {first_name}, would love to connect.' }));
    selectedStepIdx = seq.steps.length - 1; store.save(); renderSequence();
  });
  $('#addDelay').addEventListener('click', () => {
    const seq = sequence(); if (!seq) return;
    seq.steps.push(A.build.delayStep(2, 'days')); store.save(); renderSequence();
  });

  /* ============================================================
     LEADS
     ============================================================ */
  let leadSel = new Set();
  let leadFilter = '';
  function renderLeads() {
    const allLeads = store.all('leads');
    const q = leadFilter.trim().toLowerCase();
    const leads = q ? allLeads.filter(l => (l.fullName + ' ' + l.company + ' ' + (l.tags || []).join(' ')).toLowerCase().includes(q)) : allLeads;
    $('#leadCount').textContent = (q ? leads.length + ' of ' + allLeads.length : allLeads.length) + ' leads · ' + store.where('enrollments', e => e.campaignId === activeCampaignId).length + ' enrolled';
    const enrolledLeadIds = new Set(store.where('enrollments', e => e.campaignId === activeCampaignId).map(e => e.leadId));
    const t = $('#leadsTable');
    if (!allLeads.length) {
      t.innerHTML = `<tbody><tr><td><div class="empty"><div class="big">${ICON.target}</div><h3>No leads yet</h3>
        <p>Bring people in to start outreach. Three ways:</p>
        <div class="row" style="justify-content:center;gap:8px;margin-top:10px;flex-wrap:wrap">
          <button class="a-btn primary sm" id="empSrc">Source from Sales Navigator</button>
          <button class="a-btn sm" id="empImp">⇪ Import a CSV</button>
          <button class="a-btn sm" id="empAdd">+ Add one manually</button>
        </div></div></td></tr></tbody>`;
      $('#empSrc') && $('#empSrc').addEventListener('click', () => $('#sourceSalesNav').click());
      $('#empImp') && $('#empImp').addEventListener('click', () => $('#importLeads').click());
      $('#empAdd') && $('#empAdd').addEventListener('click', () => $('#addLead').click());
      return;
    }
    if (!leads.length) { t.innerHTML = '<tbody><tr><td><div class="empty"><p>No leads match “' + esc(leadFilter) + '”.</p></div></td></tr></tbody>'; return; }
    t.innerHTML = `<thead><tr>
      <th style="width:30px"><input type="checkbox" id="lAll"></th>
      <th>Lead</th><th>Company</th><th>Title</th><th>Location</th><th>°</th><th>In campaign</th>
    </tr></thead><tbody>${leads.map(l => {
      const enr = enrolledLeadIds.has(l.id);
      const e = store.where('enrollments', x => x.campaignId === activeCampaignId && x.leadId === l.id)[0];
      return `<tr>
        <td><input type="checkbox" data-lead="${l.id}" ${leadSel.has(l.id) ? 'checked' : ''}></td>
        <td><span class="av"><span class="avatar2" style="background:${colorFor(l.fullName)}">${initials(l.fullName)}</span><span>${esc(l.fullName)}${(l.tags && l.tags.length) ? '<br>' + l.tags.map(tg => `<span class="tag">${esc(tg)}</span>`).join('') : ''}</span></span></td>
        <td>${esc(l.company)}</td><td class="dim">${esc(l.position || l.headline)}</td><td class="dim">${esc(l.location)}</td>
        <td><span class="deg">${esc(l.degree || '')}</span></td>
        <td>${enr ? `<span class="pillbar ${e.status==='replied'?'ok':e.status==='stopped'?'bad':'info'}">${e.status}</span>` : '<span class="dim">-</span>'}</td>
      </tr>`;
    }).join('')}</tbody>`;
    $('#lAll').addEventListener('change', e => { leads.forEach(l => e.target.checked ? leadSel.add(l.id) : leadSel.delete(l.id)); renderLeads(); });
    $$('[data-lead]', t).forEach(cb => cb.addEventListener('change', e => { e.target.checked ? leadSel.add(e.target.dataset.lead) : leadSel.delete(e.target.dataset.lead); updateLeadBulk(); }));
    updateLeadBulk();
  }
  function updateLeadBulk() { $('#enrollSelected').disabled = leadSel.size === 0; $('#tagSelected') && ($('#tagSelected').disabled = leadSel.size === 0); }
  $('#leadFilter') && $('#leadFilter').addEventListener('input', (e) => { leadFilter = e.target.value; renderLeads(); $('#leadFilter').focus(); });
  $('#tagSelected') && $('#tagSelected').addEventListener('click', () => {
    if (!leadSel.size) return;
    modal(`<h2>Tag ${leadSel.size} lead${leadSel.size > 1 ? 's' : ''}</h2>
      <div class="a-field"><label class="a-label">Add tags (comma-separated)</label><input class="a-input" id="tgVal" placeholder="warm, q3-target"></div>
      <div class="modal-foot"><button class="a-btn ghost" id="tgCancel">Cancel</button><button class="a-btn primary" id="tgSave">Apply</button></div>`);
    $('#tgCancel').addEventListener('click', closeModal);
    $('#tgSave').addEventListener('click', () => {
      const tags = $('#tgVal').value.split(',').map(s => s.trim()).filter(Boolean);
      if (tags.length) leadSel.forEach(id => { const l = store.get('leads', id); if (l) { l.tags = [...new Set([...(l.tags || []), ...tags])]; } });
      store.save(); closeModal(); renderLeads(); toast('Tagged ' + leadSel.size + ' leads');
    });
  });

  $('#addLead').addEventListener('click', () => {
    modal(`<h2>Add lead</h2>
      <div class="row" style="gap:8px"><div class="a-field" style="flex:1"><label class="a-label">First name</label><input class="a-input" id="mFn"></div>
      <div class="a-field" style="flex:1"><label class="a-label">Last name</label><input class="a-input" id="mLn"></div></div>
      <div class="row" style="gap:8px"><div class="a-field" style="flex:1"><label class="a-label">Company</label><input class="a-input" id="mCo"></div>
      <div class="a-field" style="flex:1"><label class="a-label">Title</label><input class="a-input" id="mTi"></div></div>
      <div class="a-field"><label class="a-label">Email</label><input class="a-input" id="mEm"></div>
      <div class="a-field"><label class="a-label">LinkedIn URL</label><input class="a-input" id="mUrl"></div>
      <div class="a-field"><label class="a-label">Tags (comma-separated)</label><input class="a-input" id="mTags" placeholder="cto, fintech, warm-intro"></div>
      <div class="modal-foot"><button class="a-btn ghost" id="mCancel">Cancel</button><button class="a-btn primary" id="mSave">Add lead</button></div>`);
    $('#mCancel').addEventListener('click', closeModal);
    $('#mSave').addEventListener('click', () => {
      const l = A.build.lead({ firstName: $('#mFn').value.trim(), lastName: $('#mLn').value.trim(), company: $('#mCo').value.trim(), position: $('#mTi').value.trim(), email: $('#mEm').value.trim(), profileUrl: $('#mUrl').value.trim(), tags: $('#mTags').value.split(',').map(s => s.trim()).filter(Boolean), source: 'manual' });
      if (!l.fullName) { toast('Name required', 'warn'); return; }
      store.insert('leads', l); closeModal(); renderLeads(); toast('Lead added');
    });
  });

  $('#importLeads').addEventListener('click', () => {
    modal(`<h2>Import leads</h2><p class="dim" style="font-size:12.5px;margin-bottom:10px">One per line: <code>First,Last,Company,Title,Email</code></p>
      <textarea class="a-textarea" id="mBulk" style="min-height:160px" placeholder="Anja,Köhler,Trade Republic,Sr. Frontend Engineer,anja@proton.me"></textarea>
      <div class="modal-foot"><button class="a-btn ghost" id="mCancel">Cancel</button><button class="a-btn primary" id="mImp">Import</button></div>`);
    $('#mCancel').addEventListener('click', closeModal);
    $('#mImp').addEventListener('click', () => {
      let n = 0;
      $('#mBulk').value.split('\n').forEach(line => {
        const p = line.split(',').map(s => s.trim()); if (!p[0]) return;
        store.insert('leads', A.build.lead({ firstName: p[0], lastName: p[1] || '', company: p[2] || '', position: p[3] || '', email: p[4] || '', source: 'import' })); n++;
      });
      closeModal(); renderLeads(); toast(n + ' leads imported');
    });
  });

  $('#enrollSelected').addEventListener('click', () => {
    const created = engine.enroll(activeCampaignId, [...leadSel], simNow);
    leadSel.clear(); renderLeads();
    toast(created.length + ' enrolled into "' + campaign().name + '"');
  });

  /* ============================================================
     INBOX
     ============================================================ */
  function renderInbox() {
    const threads = store.where('threads', t => t.campaignId === activeCampaignId);
    const list = $('#threadList'); list.innerHTML = '';
    if (!threads.length) { list.innerHTML = '<div class="empty" style="grid-column:1/-1"><div class="big">' + ICON.msgCircle + '</div><p>No conversations yet. Advance the sim clock to generate replies.</p></div>'; $('#chat').innerHTML = ''; return; }
    if (!activeThreadId || !threads.find(t => t.id === activeThreadId)) activeThreadId = threads[0].id;
    threads.forEach(th => {
      const last = th.messages[th.messages.length - 1];
      const row = el('div', 'thread-row' + (th.id === activeThreadId ? ' active' : ''));
      row.innerHTML = `<div class="tn"><span class="avatar2" style="background:${colorFor(th.name)};width:24px;height:24px;font-size:10px">${initials(th.name)}</span>${esc(th.name)} ${th.hot ? '<span class="hotbadge">HOT</span>' : ''}</div>
        <div class="tp">${last ? (last.dir === 'out' ? 'You: ' : '') + esc(last.text) : ''}</div>`;
      row.addEventListener('click', () => { activeThreadId = th.id; renderInbox(); });
      list.appendChild(row);
    });
    renderChat();
  }
  function renderChat() {
    const th = store.get('threads', activeThreadId); const chat = $('#chat'); if (!th) { chat.innerHTML = ''; return; }
    const enr = store.get('enrollments', th.enrollmentId);
    chat.innerHTML = `<div class="chat-head"><span class="avatar2" style="background:${colorFor(th.name)};width:26px;height:26px;font-size:11px">${initials(th.name)}</span> ${esc(th.name)} ${th.hot ? '<span class="hotbadge">interest detected</span>' : ''}
        <span class="spacer" style="flex:1"></span>
        <button class="a-btn ghost sm" id="chHot" title="Toggle hot">${th.hot ? '★' : '☆'}</button>
        ${enr && enr.status === 'replied' ? '<button class="a-btn ghost sm" id="chResume" title="Resume the automated sequence">Resume</button>' : ''}
      </div>
      <div class="chat-body" id="chatBody"></div>
      <form class="chat-compose" id="chForm"><input class="a-input" id="chMsg" placeholder="Write a reply..." autocomplete="off"><button class="a-btn primary sm" type="submit">Send</button></form>`;
    const body = $('#chatBody');
    th.messages.forEach(m => body.appendChild(el('div', 'bubble2 ' + (m.dir === 'out' ? 'out' : 'in'), esc(m.text))));
    if (enr && enr.status === 'replied') body.appendChild(el('div', 'bubble2 sys', '↳ Prospect replied. Sequence auto-paused so you can take over.'));
    body.scrollTop = body.scrollHeight;
    $('#chForm').addEventListener('submit', (e) => {
      e.preventDefault(); const v = $('#chMsg').value.trim(); if (!v) return;
      th.messages.push({ dir: 'out', text: v, channel: th.channel, at: simNow }); store.save();
      $('#chMsg').value = ''; renderChat();
    });
    $('#chHot') && $('#chHot').addEventListener('click', () => { th.hot = !th.hot; store.save(); renderInbox(); });
    $('#chResume') && $('#chResume').addEventListener('click', () => {
      if (enr) { enr.status = 'active'; enr.nextRunAt = simNow; store.save(); toast('Sequence resumed for ' + th.name); renderInbox(); }
    });
  }

  /* ============================================================
     TEMPLATES
     ============================================================ */
  function renderTemplates() {
    const wrap = $('#templateList'); wrap.innerHTML = '';
    store.all('templates').forEach(t => {
      const card = el('div', 'card');
      const variants = (t.variants && t.variants.length) ? `<span class="pillbar info">${t.variants.length} A/B variants</span>` : '';
      card.innerHTML = `<div class="row" style="justify-content:space-between"><h3 style="font-size:14px">${esc(t.name)}</h3>
        <button class="a-btn ghost sm" data-edit="${t.id}">Edit</button></div>
        <div class="row wrap" style="margin:8px 0"><span class="pillbar">${ACTION_CATALOG[t.channel] ? ACTION_CATALOG[t.channel].icon : ''} ${t.channel}</span><span class="pillbar">${t.action}</span>${variants}</div>
        <div class="preview-box" style="font-size:12px;max-height:120px;overflow:auto">${esc((t.subject ? 'Subj: ' + t.subject + '\n\n' : '') + (t.variants && t.variants.length ? t.variants[0].body : t.body))}</div>`;
      card.querySelector('[data-edit]').addEventListener('click', () => editTemplate(t.id));
      wrap.appendChild(card);
    });
  }
  $('#addTemplate').addEventListener('click', () => editTemplate(null));
  function editTemplate(id) {
    const t = id ? store.get('templates', id) : A.build.template({ name: 'New template', channel: 'linkedin', action: 'message', body: 'Hi {first_name}, ...' });
    modal(`<h2>${id ? 'Edit' : 'New'} template</h2>
      <div class="a-field"><label class="a-label">Name</label><input class="a-input" id="tName" value="${esc(t.name)}"></div>
      <div class="row" style="gap:8px"><div class="a-field" style="flex:1"><label class="a-label">Channel</label>
        <select class="a-select" id="tCh">${Object.keys(ACTION_CATALOG).map(c => `<option ${c===t.channel?'selected':''}>${c}</option>`).join('')}</select></div>
        <div class="a-field" style="flex:1"><label class="a-label">Action</label><input class="a-input" id="tAct" value="${esc(t.action)}"></div></div>
      <div class="a-field"><label class="a-label">Subject (email/InMail)</label><input class="a-input" id="tSubj" value="${esc(t.subject||'')}"></div>
      <div class="a-field"><label class="a-label" style="display:flex;justify-content:space-between;align-items:center">Body / A&#47;B variants <button class="a-btn ghost sm" id="tAddVar" style="padding:2px 8px">+ A/B variant</button></label><div id="tVars"></div></div>
      <p class="dim" style="font-size:11.5px">Merge fields: {first_name} {last_name} {company} {position} {location} · spintax {{a|b}}</p>
      <div class="modal-foot">${id ? '<button class="a-btn danger ghost" id="tDel">Delete</button>' : ''}<span style="flex:1"></span><button class="a-btn ghost" id="tCancel">Cancel</button><button class="a-btn primary" id="tSave">Save</button></div>`);
    let vars = (t.variants && t.variants.length) ? t.variants.map(v => ({ label: v.label, weight: v.weight || 1, body: v.body })) : [{ label: 'A', weight: 1, body: t.body || '' }];
    function renderVars() {
      $('#tVars').innerHTML = vars.map((v, i) => `
        <div class="card" style="padding:9px;margin-bottom:6px">
          ${vars.length > 1 ? `<div class="row" style="justify-content:space-between;margin-bottom:5px"><b style="font-size:12px">Variant ${esc(v.label || String.fromCharCode(65 + i))}</b><span class="row" style="gap:6px"><input class="a-input" type="number" min="1" data-w="${i}" value="${v.weight}" style="width:54px" title="Traffic weight"><button class="a-btn ghost sm danger" data-d="${i}" style="padding:2px 7px">✕</button></span></div>` : ''}
          <textarea class="a-textarea" data-b="${i}" style="min-height:100px">${esc(v.body)}</textarea>
        </div>`).join('');
      $$('#tVars [data-b]').forEach(x => x.addEventListener('input', e => vars[+e.target.dataset.b].body = e.target.value));
      $$('#tVars [data-w]').forEach(x => x.addEventListener('change', e => vars[+e.target.dataset.w].weight = Math.max(1, +e.target.value)));
      $$('#tVars [data-d]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); vars.splice(+b.dataset.d, 1); renderVars(); }));
    }
    renderVars();
    $('#tAddVar').addEventListener('click', e => { e.preventDefault(); vars.push({ label: String.fromCharCode(65 + vars.length), weight: 1, body: '' }); renderVars(); });
    $('#tCancel').addEventListener('click', closeModal);
    $('#tDel') && $('#tDel').addEventListener('click', () => { store.remove('templates', id); closeModal(); renderTemplates(); toast('Template deleted'); });
    $('#tSave').addEventListener('click', () => {
      vars.forEach((v, i) => v.label = v.label || String.fromCharCode(65 + i));
      const patch = { name: $('#tName').value.trim(), channel: $('#tCh').value, action: $('#tAct').value.trim(), subject: $('#tSubj').value, body: vars[0].body, variants: vars.length > 1 ? vars : [] };
      if (id) store.update('templates', id, patch); else store.insert('templates', A.build.template(patch));
      closeModal(); renderTemplates(); toast('Template saved');
    });
  }

  /* ============================================================
     ANALYTICS
     ============================================================ */
  function renderAnalytics() {
    const s = engine.analytics(activeCampaignId);
    $('#kpiGrid').innerHTML = [
      ['Enrolled', s.enrolled], ['Connects sent', s.connectsSent], ['Accepted', s.accepted + (s.acceptRate ? ` · ${s.acceptRate}%` : '')],
      ['Messages', s.messages + s.emails], ['Replies', s.replies + (s.replyRate ? ` · ${s.replyRate}%` : '')],
    ].map(([l, v]) => `<div class="kpi"><div class="big">${typeof v === 'number' ? v : v}</div><div class="lbl">${l}</div></div>`).join('');

    const funnel = [
      { l: 'Enrolled', n: s.enrolled }, { l: 'Connection sent', n: s.connectsSent }, { l: 'Accepted', n: s.accepted },
      { l: 'Messaged', n: s.messages + s.emails }, { l: 'Replied', n: s.replies },
    ];
    const top = funnel[0].n || 1;
    $('#funnel').innerHTML = funnel.map(f => `<div class="funnel-step"><span class="fn-n">${f.n}</span><span class="fn-l">${f.l}</span><span class="fn-pct">${Math.round(f.n / top * 100)}%</span></div>`).join('');

    const evs = store.where('events', e => e.campaignId === activeCampaignId && e.status === 'sent');
    const byCh = {}; evs.forEach(e => { byCh[e.channel] = (byCh[e.channel] || 0) + 1; });
    const max = Math.max(1, ...Object.values(byCh));
    $('#byChannel').innerHTML = Object.keys(byCh).length ? Object.entries(byCh).map(([k, v]) => `<div class="bar-row"><span class="bl">${ACTION_CATALOG[k] ? ACTION_CATALOG[k].icon : ''} ${k}</span><span class="bar-track"><span class="bar-fill" style="width:${v / max * 100}%"></span></span><span class="dim">${v}</span></div>`).join('') : '<p class="dim">No activity yet, enroll leads and advance the clock.</p>';
  }

  /* ============================================================
     SETTINGS
     ============================================================ */
  function renderSettings() {
    // accounts
    $('#accList').innerHTML = store.all('channelAccounts').map(a => `<div class="acc-chip">
      <span class="healthdot ${a.health}"></span><span style="font-size:18px">${ACTION_CATALOG[a.type] ? ACTION_CATALOG[a.type].icon : ICON.link}</span>
      <div style="flex:1"><div style="font-size:13px;font-weight:600">${esc(a.displayName)}</div><div class="dim" style="font-size:11px">${a.type} · ${a.status}</div></div></div>`).join('') || '<p class="dim">No accounts.</p>';

    // limits for the campaign's first account
    const c = campaign(); const acc = c && store.get('channelAccounts', (c.channelAccountIds || [])[0]);
    if (acc) {
      acc.safety = Object.assign({}, A.DEFAULT_SAFETY, acc.safety || {});
      const s = acc.safety;
      $('#monAcc').textContent = acc.displayName;
      $('#presetSel').value = acc.preset || 'custom';
      $('#presetHint').textContent = (A.SAFETY_PRESETS[acc.preset] && A.SAFETY_PRESETS[acc.preset].desc) || 'Custom limits. Pick a preset to apply best-practice defaults, then fine-tune any value.';

      // per-action daily caps
      const limits = acc.dailyLimits || {};
      $('#limitsBox').innerHTML = Object.keys(limits).map(k => `<div class="limit-row"><span>${k} / day</span><input class="a-input" type="number" min="0" data-lim="${k}" value="${limits[k]}"></div>`).join('') + `
        <div class="limit-row" style="border-top:1px solid var(--border);margin-top:6px;padding-top:10px"><span>Warm-up enabled</span><input type="checkbox" id="sWarm" ${s.warmup.enabled ? 'checked' : ''}></div>
        <div class="limit-row"><span>Warm-up start %</span><input class="a-input" type="number" min="5" max="100" id="sWpct" value="${Math.round(s.warmup.startPct * 100)}"></div>
        <div class="limit-row"><span>Warm-up ramp (days)</span><input class="a-input" type="number" min="1" id="sWramp" value="${s.warmup.rampDays}"></div>`;
      $$('[data-lim]').forEach(inp => inp.addEventListener('change', e => { acc.dailyLimits[e.target.dataset.lim] = +e.target.value; markCustom(acc); store.save(); renderSettings(); }));

      // schedule, pacing, anti-burst throttles
      $('#safetyBox').innerHTML = `
        <div class="limit-row"><span>Working hours start</span><input class="a-input" type="number" min="0" max="23" id="sStart" value="${s.workingHours.start}"></div>
        <div class="limit-row"><span>Working hours end</span><input class="a-input" type="number" min="1" max="24" id="sEnd" value="${s.workingHours.end}"></div>
        <div class="limit-row"><span>Pause on weekends</span><input type="checkbox" id="sWk" ${s.weekendsOff ? 'checked' : ''}></div>
        <div class="limit-row"><span>Speed</span><select class="a-select" id="sSpeed" style="width:auto">${['slow','normal','fast'].map(v => `<option ${s.speed===v?'selected':''}>${v}</option>`).join('')}</select></div>
        <div class="limit-row"><span>Delay between actions (min)</span><span class="row" style="gap:6px"><input class="a-input" type="number" id="sDmin" value="${s.randomDelayMin}" style="width:60px"><span class="dim">to</span><input class="a-input" type="number" id="sDmax" value="${s.randomDelayMax}" style="width:60px"></span></div>
        <div class="limit-row" style="border-top:1px solid var(--border);margin-top:6px;padding-top:10px"><span>Max per hour (anti-burst)</span><input class="a-input" type="number" id="sHr" value="${s.hourlyMax}"></div>
        <div class="limit-row"><span>Max total / day</span><input class="a-input" type="number" id="sTot" value="${s.dailyTotalCap}"></div>
        <div class="limit-row"><span>Weekly invite cap</span><input class="a-input" type="number" id="sWk7" value="${s.weeklyInviteCap}"></div>
        <div class="limit-row"><span>Pending invite cap</span><input class="a-input" type="number" id="sPend" value="${s.pendingInviteCap}"></div>
        <div class="limit-row"><span>Auto-withdraw invites after (days)</span><input class="a-input" type="number" id="sWd" value="${s.withdrawInviteAfterDays}"></div>`;
      const bind = (id, fn) => { const e = $('#' + id); e && e.addEventListener('change', ev => { fn(ev.target); markCustom(acc); store.save(); renderMonitor(acc); toast('Saved'); }); };
      bind('sWarm', t => acc.safety.warmup.enabled = t.checked); bind('sWpct', t => acc.safety.warmup.startPct = Math.max(0.05, Math.min(1, (+t.value) / 100))); bind('sWramp', t => acc.safety.warmup.rampDays = Math.max(1, +t.value));
      bind('sStart', t => acc.safety.workingHours.start = +t.value); bind('sEnd', t => acc.safety.workingHours.end = +t.value);
      bind('sWk', t => acc.safety.weekendsOff = t.checked);
      bind('sSpeed', t => { acc.safety.speed = t.value; const d = A.SPEED_DELAYS[t.value]; if (d) { acc.safety.randomDelayMin = d[0]; acc.safety.randomDelayMax = d[1]; } renderSettings(); });
      bind('sDmin', t => acc.safety.randomDelayMin = +t.value); bind('sDmax', t => acc.safety.randomDelayMax = +t.value);
      bind('sHr', t => acc.safety.hourlyMax = +t.value); bind('sTot', t => acc.safety.dailyTotalCap = +t.value);
      bind('sWk7', t => acc.safety.weeklyInviteCap = +t.value); bind('sPend', t => acc.safety.pendingInviteCap = +t.value);
      bind('sWd', t => acc.safety.withdrawInviteAfterDays = +t.value);

      renderMonitor(acc);
    } else { $('#limitsBox').innerHTML = '<p class="dim">Connect an account first.</p>'; $('#safetyBox').innerHTML = ''; $('#monitorBox').innerHTML = ''; $('#monAcc').textContent = ''; }

    const bl = store.blacklist();
    $('#blacklistBox').value = [...bl.domains, ...bl.emails, ...bl.names].join('\n');
  }
  $('#saveBlacklist').addEventListener('click', () => {
    const bl = store.blacklist(); bl.emails = []; bl.domains = []; bl.names = [];
    $('#blacklistBox').value.split('\n').map(s => s.trim().toLowerCase()).filter(Boolean).forEach(v => {
      if (v.includes('@')) bl.emails.push(v); else if (v.includes('.') && !v.includes(' ')) bl.domains.push(v); else bl.names.push(v);
    });
    store.save(); toast('Blacklist saved');
  });

  /* ---- throttle presets + live monitoring ---- */
  const monLimits = A.Limits(store);
  function markCustom(acc) { acc.preset = 'custom'; }
  function renderMonitor(acc) {
    const box = $('#monitorBox'); if (!box) return;
    if (!acc) { box.innerHTML = ''; return; }
    const u = monLimits.usage(acc, simNow);
    const bar = (used, cap, label) => {
      const capped = cap && cap !== Infinity;
      const pct = capped ? Math.min(100, used / cap * 100) : 0;
      const cls = !capped ? '' : pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : 'ok';
      return `<div class="mon-row"><span class="mon-l">${label}</span><span class="mon-track"><span class="mon-fill ${cls}" style="width:${pct}%"></span></span><span class="mon-v">${used}${capped ? ' / ' + cap : ''}</span></div>`;
    };
    let html = '<div class="mon-grid">';
    html += bar(u.total, u.totalCap, 'Total today');
    html += bar(u.hour, u.hourCap, 'This hour');
    html += bar(u.weeklyInvites, u.weeklyInviteCap, 'Invites this week');
    html += bar(u.pending, u.pendingCap, 'Pending invites');
    html += '</div>';
    const acts = Object.keys(u.actions);
    if (acts.length) html += '<div class="mon-grid" style="margin-top:6px">' + acts.map(a => bar(u.actions[a].used, u.actions[a].cap, a)).join('') + '</div>';
    html += `<div class="dim" style="font-size:11.5px;margin-top:8px">Warm-up: effective caps at <b>${Math.round(u.warmupPct * 100)}%</b> of base ${u.warmupPct < 1 ? '(ramping up as the account ages)' : '(fully warmed)'}.</div>`;
    box.innerHTML = html;
  }
  $('#presetSel') && $('#presetSel').addEventListener('change', (e) => {
    const c = campaign(); const acc = c && store.get('channelAccounts', (c.channelAccountIds || [])[0]);
    if (!acc) return;
    if (e.target.value === 'custom') { acc.preset = 'custom'; store.save(); renderSettings(); return; }
    if (!confirm('Apply the ' + e.target.value + ' preset? It overwrites this account\'s caps and safety settings.')) { renderSettings(); return; }
    A.applyPreset(acc, e.target.value); store.save(); renderSettings(); toast(e.target.value + ' preset applied');
  });
  $('#addAccount').addEventListener('click', () => {
    modal(`<h2>Connect account</h2>
      <div class="a-field"><label class="a-label">Channel</label><select class="a-select" id="aType"><option value="linkedin">LinkedIn</option><option value="email">Email</option><option value="twitter">X / Twitter</option></select></div>
      <div class="a-field"><label class="a-label">Display name</label><input class="a-input" id="aName" placeholder="you@company.com"></div>
      <p class="dim" style="font-size:11.5px">In Simulated mode this just registers limits & warm-up. Real sending needs server-side credentials.</p>
      <div class="modal-foot"><button class="a-btn ghost" id="aCancel">Cancel</button><button class="a-btn primary" id="aSave">Connect</button></div>`);
    $('#aCancel').addEventListener('click', closeModal);
    $('#aSave').addEventListener('click', () => { store.insert('channelAccounts', A.build.channelAccount($('#aType').value, $('#aName').value.trim() || 'New account')); closeModal(); renderSettings(); toast('Account connected'); });
  });

  /* ============================================================
     HEADER ACTIONS + SIM CLOCK + TABS
     ============================================================ */
  $('#toggleStatus').addEventListener('click', () => {
    const c = campaign(); if (!c) return;
    if (c.status === 'active') engine.pauseCampaign(c.id); else engine.activateCampaign(c.id);
    renderAll(); toast('Campaign ' + campaign().status);
  });
  $('#launchBtn').addEventListener('click', () => {
    const c = campaign(); if (!c) return;
    const seq = sequence();
    if (!seq || !seq.steps.length) { toast('Add sequence steps first', 'warn'); return; }
    if (!store.all('leads').length) { toast('Add leads first (Leads tab)', 'warn'); switchTab('leads'); return; }
    const live = c._liveRoute && window.StudioExt && window.StudioExt.env().canReach;
    const n = store.all('leads').filter(l => !store.where('enrollments', e => e.campaignId === c.id && e.leadId === l.id).length).length;
    if (live) {
      if (!confirm('Launch LIVE? ' + n + ' leads will be enrolled and their LinkedIn steps will run through your real account, respecting your throttles and working hours. Continue?')) return;
    } else {
      if (n && !confirm('Launch in Test mode? ' + n + ' leads will be enrolled and simulated (no real sends). Turn on Live in the LinkedIn Live tab to send for real.')) return;
    }
    engine.activateCampaign(c.id);
    const created = engine.enroll(c.id, store.all('leads').map(l => l.id), live ? Date.now() : simNow);
    renderAll(); toast(created.length + ' enrolled · campaign ' + (live ? 'LIVE' : 'in test mode'));
  });

  $('#campMenu') && $('#campMenu').addEventListener('click', openCampaignMenu);
  function openCampaignMenu() {
    const c = campaign(); if (!c) return;
    const liAccts = store.where('channelAccounts', a => a.type === 'linkedin');
    const emAccts = store.where('channelAccounts', a => a.type === 'email');
    modal(`<h2>Campaign settings</h2>
      <div class="a-field"><label class="a-label">Name</label><input class="a-input" id="cmName" value="${esc(c.name)}"></div>
      <div class="a-field"><label class="a-label">LinkedIn account</label>
        <select class="a-select" id="cmAcc"><option value="">(none)</option>${liAccts.map(a => `<option value="${a.id}" ${(c.channelAccountIds || [])[0] === a.id ? 'selected' : ''}>${esc(a.displayName)}</option>`).join('')}</select></div>
      ${emAccts.length ? `<div class="a-field"><label class="a-label">Email mailboxes (rotation)</label><div style="display:grid;gap:5px">${emAccts.map(a => `<label class="row" style="font-size:12.5px;color:var(--text-muted)"><input type="checkbox" data-em="${a.id}" ${(c.emailAccountIds || []).includes(a.id) ? 'checked' : ''} style="width:auto"> ${esc(a.displayName)}</label>`).join('')}</div></div>` : ''}
      <div class="modal-foot"><button class="a-btn danger ghost" id="cmDel">Delete</button><button class="a-btn ghost" id="cmDup">Duplicate</button><span style="flex:1"></span><button class="a-btn ghost" id="cmCancel">Cancel</button><button class="a-btn primary" id="cmSave">Save</button></div>`);
    $('#cmCancel').addEventListener('click', closeModal);
    $('#cmSave').addEventListener('click', () => {
      const acc = $('#cmAcc').value;
      const emails = $$('[data-em]').filter(cb => cb.checked).map(cb => cb.dataset.em);
      store.update('campaigns', c.id, { name: $('#cmName').value.trim() || c.name, channelAccountIds: acc ? [acc] : [], emailAccountIds: emails });
      closeModal(); renderAll(); toast('Campaign updated');
    });
    $('#cmDup').addEventListener('click', () => { duplicateCampaign(c); closeModal(); });
    $('#cmDel').addEventListener('click', () => {
      if (!confirm('Delete "' + c.name + '" and its sequence + enrollments? This cannot be undone.')) return;
      const seqId = c.sequenceId;
      store.where('enrollments', e => e.campaignId === c.id).forEach(e => store.remove('enrollments', e.id));
      store.where('threads', t => t.campaignId === c.id).forEach(t => store.remove('threads', t.id));
      if (seqId) store.remove('sequences', seqId);
      store.remove('campaigns', c.id);
      activeCampaignId = (store.all('campaigns')[0] || {}).id || null;
      if (!activeCampaignId) newCampaign(); else { closeModal(); renderAll(); }
      toast('Campaign deleted');
    });
  }
  function duplicateCampaign(c) {
    const seq = store.get('sequences', c.sequenceId);
    const nc = store.insert('campaigns', A.build.campaign({ name: c.name + ' (copy)', status: 'draft', channelAccountIds: (c.channelAccountIds || []).slice(), emailAccountIds: (c.emailAccountIds || []).slice() }));
    const ns = store.insert('sequences', A.build.sequence(nc.id, seq ? JSON.parse(JSON.stringify(seq.steps)) : []));
    store.update('campaigns', nc.id, { sequenceId: ns.id });
    activeCampaignId = nc.id; selectedStepIdx = 0; renderAll(); toast('Campaign duplicated');
  }

  function newCampaign() {
    const c = store.insert('campaigns', A.build.campaign({ name: 'Untitled campaign', status: 'draft', channelAccountIds: store.all('channelAccounts').slice(0, 1).map(a => a.id) }));
    const seq = store.insert('sequences', A.build.sequence(c.id, [
      A.build.actionStep('linkedin', 'connect', { body: 'Hi {first_name}, would love to connect.' }),
      A.build.delayStep(2, 'days'),
      A.build.actionStep('linkedin', 'message', { body: 'Thanks for connecting, {first_name}!', requireAccepted: true }),
    ]));
    store.update('campaigns', c.id, { sequenceId: seq.id });
    activeCampaignId = c.id; selectedStepIdx = 0; renderAll(); switchTab('sequence'); toast('Campaign created');
  }
  $('#newCampaign').addEventListener('click', newCampaign);
  $('#topNewCampaign').addEventListener('click', (e) => { e.preventDefault(); newCampaign(); });
  $('#resetData').addEventListener('click', () => {
    if (!confirm('Reset this workspace? This clears all campaigns, leads, and history in your browser.')) return;
    store.reset(); localStorage.removeItem(SIM_KEY); location.reload();
  });
  $('#loadSample') && $('#loadSample').addEventListener('click', loadSampleData);

  $$('[data-ff]').forEach(b => b.addEventListener('click', () => {
    const days = +b.dataset.ff; const to = simNow + days * DAY;
    const r = engine.fastForward(simNow, to, 6 * HOUR);
    simNow = to; saveSim(simNow); renderAll();
    toast(`+${days < 1 ? days * 24 + 'h' : days + 'd'} · ${r.sent} sent, ${r.accepted} accepted, ${r.replied} replies`);
  }));

  function switchTab(name) {
    activeTab = name;
    $$('#tabs .st-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    $$('.st-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
    renderTab(name);
  }
  $$('#tabs .st-tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // palette drag sources (wired once)
  $$('#seqPalette .pal-chip').forEach(chip => chip.addEventListener('dragstart', (e) => { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/plain', 'add:' + chip.dataset.add); }));

  /* ============================================================
     LINKEDIN LIVE, portal drives the browser extension
     ============================================================ */
  const Ext = window.StudioExt;
  let scrapePoll = null;

  function renderLive() {
    if (!Ext) { $('#liveEnvBanner').style.display = 'block'; $('#liveEnvBanner').innerHTML = 'studio-bridge.js failed to load.'; return; }
    const e = Ext.env();
    const banner = $('#liveEnvBanner');
    if (!e.canReach) { banner.style.display = 'block'; banner.innerHTML = '<b>To go live:</b> ' + esc(e.reason); }
    else { banner.style.display = 'none'; }
    $('#extId').value = Ext.getExtId();
    // reflect persisted live-route toggle for this campaign
    const c = campaign();
    $('#liveRoute').checked = !!(c && c._liveRoute);
    refreshExtStatus();
    renderDatasets();
    renderBackend();
  }

  async function refreshExtStatus() {
    const box = $('#extStatus'); const acc = $('#liAccount');
    if (!Ext.env().canReach) { box.innerHTML = '<span class="pillbar warn">not connected</span>'; return; }
    const p = await Ext.ping();
    if (p && p.ok) {
      box.innerHTML = `<span class="pillbar ok">extension v${esc(p.version)} connected</span>`;
      $('#liveActions').checked = !!p.live;
      acc.innerHTML = p.account
        ? `<div class="acc-chip"><span class="healthdot good"></span><span style="font-size:18px">${ICON.briefcase}</span><div style="flex:1"><div style="font-size:13px;font-weight:600">${esc(p.account.name)}</div><div class="dim" style="font-size:11px">logged-in LinkedIn account</div></div></div>`
        : '<p class="dim" style="font-size:12px">Extension connected. Now link your LinkedIn account.</p>';
    } else {
      box.innerHTML = `<span class="pillbar bad">${esc((p && p.info) || 'unreachable')}</span>`;
    }
  }

  async function renderDatasets() {
    const wrap = $('#dsList'); if (!wrap) return;
    if (!Ext.env().canReach) { wrap.innerHTML = '<p class="dim" style="font-size:12px">Connect the extension to see scraped datasets.</p>'; return; }
    const r = await Ext.getDatasets();
    const list = (r && r.datasets) || [];
    wrap.innerHTML = list.length ? list.map(d => `
      <div class="acc-chip" style="align-items:stretch;flex-direction:column;gap:8px">
        <div class="row" style="justify-content:space-between"><b style="font-size:13px">${esc(d.name)}</b><span class="pillbar info">${d.count} leads</span></div>
        <div class="row wrap" style="gap:6px">
          <button class="a-btn sm" data-import="${d.id}">→ Import as leads</button>
          <button class="a-btn sm" data-push="${d.id}">Push to backend</button>
          <button class="a-btn ghost sm" data-csv="${d.id}">CSV</button>
        </div>
      </div>`).join('') : '<p class="dim" style="font-size:12px">No datasets yet. Use “Source from Sales Navigator” on the Leads tab.</p>';
    $$('[data-import]', wrap).forEach(b => b.addEventListener('click', () => importDataset(b.dataset.import)));
    $$('[data-csv]', wrap).forEach(b => b.addEventListener('click', async () => { const r2 = await Ext.exportCsv(b.dataset.csv); toast(r2 && r2.ok ? 'Downloading CSV' : 'Export failed', r2 && r2.ok ? '' : 'warn'); }));
    $$('[data-push]', wrap).forEach(b => b.addEventListener('click', () => pushDatasetToBackend(b.dataset.push)));
  }

  async function importDataset(id) {
    const r = await Ext.getDataset(id);
    if (!r || !r.ok) { toast('Could not load dataset', 'warn'); return; }
    const recs = r.dataset.records || [];
    let n = 0;
    recs.forEach(rec => {
      store.insert('leads', A.build.lead({
        firstName: rec.firstName, lastName: rec.lastName, fullName: rec.fullName,
        headline: rec.headline, company: rec.company, position: rec.title || rec.headline,
        location: rec.location, profileUrl: rec.profileUrl || rec.salesNavUrl, degree: rec.connectionDegree,
        source: 'sales-navigator',
      })); n++;
    });
    toast(n + ' leads imported from "' + r.dataset.name + '"');
    renderLeads();
  }

  $('#extConnect') && $('#extConnect').addEventListener('click', async () => {
    Ext.setExtId($('#extId').value);
    const p = await Ext.ping();
    toast(p && p.ok ? 'Extension connected (v' + p.version + ')' : ('Cannot reach extension: ' + ((p && p.info) || '')), p && p.ok ? '' : 'warn');
    renderLive();
  });
  $('#liConnect') && $('#liConnect').addEventListener('click', async () => {
    const r = await Ext.connectAccount();
    toast(r && r.ok ? ('Connected as ' + r.account.name) : ('Could not connect: ' + ((r && r.info) || '')), r && r.ok ? '' : 'warn');
    refreshExtStatus();
  });
  $('#liveActions') && $('#liveActions').addEventListener('change', async (e) => {
    if (e.target.checked && !confirm('Turn ON live actions? Real clicks will fire on LinkedIn from your account. Keep volumes humane and within ToS.')) { e.target.checked = false; return; }
    const r = await Ext.setLive(e.target.checked);
    toast(r && r.ok ? ('Live actions ' + (e.target.checked ? 'ON' : 'off')) : 'Failed', r && r.ok ? '' : 'warn');
  });
  $('#liveRoute') && $('#liveRoute').addEventListener('change', (e) => {
    const c = campaign(); if (!c) return;
    store.update('campaigns', c.id, { _liveRoute: e.target.checked });
    if (e.target.checked) {
      if (window.AlfredExtensionBridge) { engine.setAdapter('linkedin', window.AlfredExtensionBridge({ extensionId: Ext.getExtId(), mode: 'queue' })); toast('LinkedIn steps will route through your real account'); }
      else toast('Load alfred-bridge.js to route live', 'warn');
    } else { toast('Reverted to Simulated channel'); }
  });
  $('#refreshDs') && $('#refreshDs').addEventListener('click', renderDatasets);

  /* ============================================================
     RECRUITEROS BACKEND, team accounts, throttles, prospects, inbox
     ============================================================ */
  const Backend = window.RosBackend;

  async function renderBackend() {
    if (!Backend) return;
    $('#beBase').value = Backend.getBase();
    const ses = await Backend.session();
    const st = $('#beStatus');
    if (ses.ok) {
      const ws = ses.data && (ses.data.workspace || {});
      const user = ses.data && (ses.data.user || {});
      st.innerHTML = `<span class="pillbar ok">${esc(ws.name || 'workspace')} · ${esc(user.name || user.email || 'member')}</span>`;
    } else {
      st.innerHTML = `<span class="pillbar warn">${esc(ses.info || 'offline')}</span>`;
      $('#beAccounts').innerHTML = '<p class="dim" style="font-size:12px">' + esc(ses.info || 'Backend not connected.') + '</p>';
      $('#beInbox').innerHTML = '<p class="dim" style="font-size:12px">-</p>';
      return;
    }
    // team LinkedIn accounts (multi-account, quotas, warmup)
    const acc = await Backend.accounts();
    const list = (acc.ok && acc.data && acc.data.linkedin) || [];
    $('#beAccounts').innerHTML = list.length ? list.map(a => {
      const q = a.quotas || a.limits || {};
      const warm = a.warmup || a.status || '';
      return `<div class="acc-chip"><span class="healthdot ${/warm/i.test(warm) ? 'warn' : /flag|restrict/i.test(warm) ? 'bad' : 'good'}"></span>
        <div style="flex:1"><div style="font-size:13px;font-weight:600">${esc(a.handle || a.displayName || a.id)}</div>
        <div class="dim" style="font-size:11px">${esc(a.platform || 'linkedin')} · ${esc(warm)} · caps ${q.connects ?? q.invitesPerDay ?? '?'}c / ${q.dms ?? q.messagesPerDay ?? '?'}m / ${q.profileViews ?? q.profileViewsPerDay ?? '?'}v</div></div></div>`;
    }).join('') : '<p class="dim" style="font-size:12px">No LinkedIn accounts yet. Add one in the backend (/api/accounts).</p>';
    // assignment dropdown
    const c = campaign();
    const sel = $('#beAssign');
    sel.innerHTML = '<option value="">(none / Simulated)</option>' + list.map(a => `<option value="${esc(a.id)}" ${c && c._backendAccountId === a.id ? 'selected' : ''}>${esc(a.handle || a.displayName || a.id)}</option>`).join('');
    // inbox
    const inb = await Backend.responses();
    const items = (inb.ok && inb.data && inb.data.items) || [];
    $('#beInbox').innerHTML = items.length
      ? `<div class="pillbar info">${items.length} responses</div>` + items.slice(0, 3).map(m => `<div class="dim" style="font-size:11.5px;margin-top:4px">${esc(m.fromName || m.fromHandle || 'unknown')}: ${esc((m.text || '').slice(0, 60))}</div>`).join('')
      : '<p class="dim" style="font-size:12px">Inbox empty.</p>';
  }

  async function pushDatasetToBackend(id) {
    if (!Backend) { toast('Backend client missing', 'warn'); return; }
    const ses = await Backend.session();
    if (!ses.ok) { toast('Connect the backend first (LinkedIn Live tab)', 'warn'); switchTab('live'); return; }
    const r = await Ext.getDataset(id);
    if (!r || !r.ok) { toast('Could not load dataset', 'warn'); return; }
    const recs = r.dataset.records || [];
    const c = campaign();
    const rows = recs.map(rec => Backend.toProspectRow(rec, c && c._backendCampaignId));
    const res = await Backend.addProspectsBulk(rows);
    toast(res.ok ? ('Pushed ' + rows.length + ' prospects to the backend') : ('Push failed: ' + (res.info || '')), res.ok ? '' : 'warn');
  }

  $('#beConnect') && $('#beConnect').addEventListener('click', async () => { Backend.setBase($('#beBase').value); await renderBackend(); toast('Backend base saved'); });
  $('#beRefresh') && $('#beRefresh').addEventListener('click', renderBackend);
  $('#beAssign') && $('#beAssign').addEventListener('change', (e) => {
    const c = campaign(); if (!c) return;
    store.update('campaigns', c.id, { _backendAccountId: e.target.value || null });
    toast(e.target.value ? 'Account assigned to this campaign' : 'Account unassigned');
  });

  /* ---- Sales Navigator sourcing (from the Leads tab) ---- */
  $('#sourceSalesNav') && $('#sourceSalesNav').addEventListener('click', () => {
    const reach = Ext && Ext.env();
    modal(`<h2>Source from Sales Navigator</h2>
      ${reach && !reach.canReach ? `<div class="banner" style="margin-bottom:14px">${esc(reach.reason)}</div>` : ''}
      <p class="dim" style="font-size:12.5px;margin-bottom:10px">Paste a Sales Navigator <b>people-search URL</b>. The extension opens it and pulls every person, page by page, into a dataset.</p>
      <div class="a-field"><label class="a-label">Sales Navigator search URL</label><input class="a-input" id="snU" placeholder="https://www.linkedin.com/sales/search/people?query=..."></div>
      <div class="row" style="gap:8px">
        <div class="a-field" style="flex:2"><label class="a-label">Dataset name</label><input class="a-input" id="snN" placeholder="Berlin React leads"></div>
        <div class="a-field" style="flex:1"><label class="a-label">Max pages</label><input class="a-input" id="snP" type="number" value="10" min="1" max="100"></div>
      </div>
      <div id="snProg" class="dim" style="font-size:12px;min-height:18px"></div>
      <div class="modal-foot"><button class="a-btn ghost" id="snCancel">Close</button><button class="a-btn primary" id="snGo">Start scrape</button></div>`);
    $('#snCancel').addEventListener('click', () => { if (scrapePoll) clearInterval(scrapePoll); closeModal(); });
    $('#snGo').addEventListener('click', async () => {
      if (!Ext || !Ext.env().canReach) { $('#snProg').textContent = (Ext && Ext.env().reason) || 'Extension unavailable'; return; }
      const url = $('#snU').value.trim();
      const r = await Ext.startScrape(url, $('#snN').value.trim(), +$('#snP').value);
      if (!r || !r.ok) { $('#snProg').textContent = (r && r.info) || 'Could not start'; return; }
      $('#snProg').textContent = 'Scrape started. A LinkedIn tab will open and page through results...';
      const dsId = r.datasetId;
      if (scrapePoll) clearInterval(scrapePoll);
      scrapePoll = setInterval(async () => {
        const st = await Ext.getState();
        const sc = st && st.state && st.state.scrape;
        if (sc) {
          $('#snProg').innerHTML = `${sc.status === 'running' ? ICON.clock : ICON.check} page ${sc.page}/${sc.maxPages} · <b>${sc.total}</b> leads`;
          if (sc.status !== 'running') {
            clearInterval(scrapePoll); scrapePoll = null;
            $('#snProg').innerHTML += ', done. Importing...';
            await importDataset(dsId); switchTab('leads'); closeModal();
          }
        }
      }, 2000);
    });
  });

  /* ---- embedded mode: hide the marketing chrome when hosted inside the portal
     (iframe) or when opened with ?embed=1, so it reads as a native panel ---- */
  (function embedMode() {
    let embedded = false;
    try { embedded = (window.self !== window.top) || new URLSearchParams(location.search).get('embed') === '1'; } catch (_) { embedded = true; }
    if (embedded) {
      document.body.classList.add('embedded');
      const nav = document.querySelector('header.nav'); if (nav) nav.style.display = 'none';
      const aurora = document.querySelector('.aurora'); if (aurora) aurora.style.display = 'none';
    }
  })();

  /* ---- go ---- */
  renderAll();
})();
