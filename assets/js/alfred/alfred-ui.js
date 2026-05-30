/* ============================================================
   Alfred Outreach Studio — browser controller
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

  // seed a realistic demo on first run, then enroll its leads
  (function bootstrap() {
    if (!store.all('campaigns').length) {
      const seeded = A.seedDemo(store, simNow - 8 * DAY); // start campaign 8 days "ago"
      engine.enroll(seeded.campaign.id, seeded.leads.map(l => l.id), simNow - 8 * DAY);
      engine.fastForward(simNow - 8 * DAY, simNow, 6 * HOUR); // warm it up so there's live data
      saveSim(simNow);
    }
  })();

  /* ---- small helpers ---- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const initials = (n) => (n || '?').split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();
  const colorFor = (s) => { const palette = ['#7c5cff', '#4dd0ff', '#ff7ac6', '#38e0a6', '#ffc24d']; let h = 0; for (const c of (s || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return palette[h % palette.length]; };
  const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const relDay = (t) => { const d = Math.round((t - simNow) / DAY); return d === 0 ? 'today' : d < 0 ? -d + 'd ago' : 'in ' + d + 'd'; };

  let toastT;
  function toast(msg, kind) {
    const t = $('#a-toast'); t.innerHTML = (kind === 'warn' ? '⚡ ' : '✓ ') + msg; t.classList.add('show');
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
     RENDER — top-level dispatcher
     ============================================================ */
  function renderAll() {
    $('#simNow').textContent = '🕐 ' + fmtDate(simNow);
    renderCampaigns();
    renderHeader();
    renderTab(activeTab);
  }
  function renderTab(name) {
    if (name === 'sequence') renderSequence();
    else if (name === 'leads') renderLeads();
    else if (name === 'inbox') renderInbox();
    else if (name === 'templates') renderTemplates();
    else if (name === 'analytics') renderAnalytics();
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
  function renderSequence() {
    const seq = sequence();
    const canvas = $('#seqCanvas'); canvas.innerHTML = '';
    if (!seq || !seq.steps.length) {
      canvas.innerHTML = '<div class="empty"><div class="big">🧩</div><p>No steps yet. Add an action to begin your sequence.</p></div>';
      $('#inspector').innerHTML = '<div class="empty"><div class="big">🧩</div><p>Add your first step.</p></div>';
      return;
    }
    seq.steps.forEach((step, i) => {
      if (step.kind === 'delay') {
        canvas.appendChild(el('div', 'seq-delay', `⏱️ Wait ${step.delay.amount} ${step.delay.unit}`));
        return;
      }
      const meta = ACTION_CATALOG[step.action.channel].actions[step.action.type] || {};
      const chMeta = ACTION_CATALOG[step.action.channel];
      const node = el('div', 'seq-node' + (i === selectedStepIdx ? ' sel' : ''));
      const cond = step.action.requireAccepted || (step.condition && step.condition.type === 'if_accepted')
        ? '<span class="seq-cond">after accept</span>'
        : (step.condition && step.condition.type === 'if_replied' ? '<span class="seq-cond">if replied</span>' : '');
      node.innerHTML = `
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
      node.addEventListener('click', (e) => { if (e.target.dataset.up == null && e.target.dataset.down == null && e.target.dataset.del == null) { selectedStepIdx = i; renderSequence(); } });
      canvas.appendChild(node);
      if (i < seq.steps.length - 1) { const rail = el('div', 'seq-rail'); rail.innerHTML = '<span class="line"></span>'; canvas.appendChild(rail); }
    });
    $$('[data-up]', canvas).forEach(b => b.addEventListener('click', () => moveStep(+b.dataset.up, -1)));
    $$('[data-down]', canvas).forEach(b => b.addEventListener('click', () => moveStep(+b.dataset.down, 1)));
    $$('[data-del]', canvas).forEach(b => b.addEventListener('click', () => deleteStep(+b.dataset.del)));
    renderInspector();
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
      insp.innerHTML = `<h3>⏱️ Delay</h3>
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
    const tplOpts = '<option value="">— inline copy —</option>' + store.all('templates').map(t => `<option value="${t.id}" ${a.templateId===t.id?'selected':''}>${esc(t.name)}</option>`).join('');

    insp.innerHTML = `<h3>${ACTION_CATALOG[a.channel].icon} Edit step</h3>
      <div class="row" style="gap:8px">
        <div class="a-field" style="flex:1"><label class="a-label">Channel</label><select class="a-select" id="iCh">${chOpts}</select></div>
        <div class="a-field" style="flex:1"><label class="a-label">Action</label><select class="a-select" id="iAct">${actOpts}</select></div>
      </div>
      <div class="a-field"><label class="a-label">Template</label><select class="a-select" id="iTpl">${tplOpts}</select></div>
      ${needsSubject ? `<div class="a-field"><label class="a-label">Subject</label><input class="a-input" id="iSubj" value="${esc(a.subject||'')}"></div>` : ''}
      ${needsBody ? `<div class="a-field"><label class="a-label">${a.type==='connect'?'Connection note':'Message body'}</label><textarea class="a-textarea" id="iBody" placeholder="Hi {first_name}, ...">${esc(a.body||a.note||'')}</textarea></div>` : ''}
      ${meta.requiresAccepted || a.type==='connect' ? '' : `<div class="a-field"><label class="row" style="font-size:12.5px;color:var(--text-muted)"><input type="checkbox" id="iAccept" ${a.requireAccepted?'checked':''} style="width:auto"> Only run after connection accepted</label></div>`}
      <div class="a-label">Live preview · ${esc(firstLeadName())}</div>
      <div class="preview-box"><div class="preview-to" id="pvTo"></div><div id="pvBody"></div></div>
      <div class="warnflag" id="pvWarn"></div>`;

    $('#iCh').addEventListener('change', e => { a.channel = e.target.value; a.type = Object.keys(ACTION_CATALOG[a.channel].actions)[0]; a.templateId = null; store.save(); renderSequence(); });
    $('#iAct').addEventListener('change', e => { a.type = e.target.value; store.save(); renderSequence(); });
    $('#iTpl').addEventListener('change', e => { a.templateId = e.target.value || null; store.save(); renderSequence(); });
    $('#iSubj') && $('#iSubj').addEventListener('input', e => { a.subject = e.target.value; store.save(); updatePreview(step); });
    $('#iBody') && $('#iBody').addEventListener('input', e => { if (a.type === 'connect') a.note = e.target.value; a.body = e.target.value; store.save(); updatePreview(step); });
    $('#iAccept') && $('#iAccept').addEventListener('change', e => { a.requireAccepted = e.target.checked; store.save(); renderSequence(); });
    updatePreview(step);
  }

  function firstLead() { return store.all('leads')[0] || A.build.lead({ firstName: 'Anja', company: 'Trade Republic' }); }
  function firstLeadName() { const l = firstLead(); return l.fullName || l.firstName; }
  function updatePreview(step) {
    const a = step.action, lead = firstLead();
    let subjSrc = a.subject, bodySrc = a.body || a.note;
    if (a.templateId) { const t = store.get('templates', a.templateId); if (t) { subjSrc = subjSrc || t.subject; bodySrc = bodySrc || A.pickVariant(t); } }
    const channelMeta = ACTION_CATALOG[a.channel];
    $('#pvTo') && ($('#pvTo').textContent = `${channelMeta.label} · to ${lead.fullName || lead.firstName}`);
    const body = A.render(bodySrc || ACTION_CATALOG[a.channel].actions[a.type].label, lead);
    $('#pvBody') && ($('#pvBody').textContent = (subjSrc ? A.render(subjSrc, lead) + '\n\n' : '') + body);
    const miss = A.missingFields(bodySrc || '', lead).concat(A.missingFields(subjSrc || '', lead));
    $('#pvWarn') && ($('#pvWarn').textContent = miss.length ? '⚠ Unknown merge fields: ' + [...new Set(miss)].map(m => '{' + m + '}').join(', ') : '');
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
  function renderLeads() {
    const leads = store.all('leads');
    $('#leadCount').textContent = leads.length + ' leads · ' + store.where('enrollments', e => e.campaignId === activeCampaignId).length + ' enrolled in this campaign';
    const enrolledLeadIds = new Set(store.where('enrollments', e => e.campaignId === activeCampaignId).map(e => e.leadId));
    const t = $('#leadsTable');
    t.innerHTML = `<thead><tr>
      <th style="width:30px"><input type="checkbox" id="lAll"></th>
      <th>Lead</th><th>Company</th><th>Title</th><th>Location</th><th>°</th><th>In campaign</th>
    </tr></thead><tbody>${leads.map(l => {
      const enr = enrolledLeadIds.has(l.id);
      const e = store.where('enrollments', x => x.campaignId === activeCampaignId && x.leadId === l.id)[0];
      return `<tr>
        <td><input type="checkbox" data-lead="${l.id}" ${leadSel.has(l.id) ? 'checked' : ''}></td>
        <td><span class="av"><span class="avatar2" style="background:${colorFor(l.fullName)}">${initials(l.fullName)}</span>${esc(l.fullName)}</span></td>
        <td>${esc(l.company)}</td><td class="dim">${esc(l.position || l.headline)}</td><td class="dim">${esc(l.location)}</td>
        <td><span class="deg">${esc(l.degree || '')}</span></td>
        <td>${enr ? `<span class="pillbar ${e.status==='replied'?'ok':e.status==='stopped'?'bad':'info'}">${e.status}</span>` : '<span class="dim">—</span>'}</td>
      </tr>`;
    }).join('')}</tbody>`;
    $('#lAll').addEventListener('change', e => { leads.forEach(l => e.target.checked ? leadSel.add(l.id) : leadSel.delete(l.id)); renderLeads(); });
    $$('[data-lead]', t).forEach(cb => cb.addEventListener('change', e => { e.target.checked ? leadSel.add(e.target.dataset.lead) : leadSel.delete(e.target.dataset.lead); $('#enrollSelected').disabled = leadSel.size === 0; }));
    $('#enrollSelected').disabled = leadSel.size === 0;
  }

  $('#addLead').addEventListener('click', () => {
    modal(`<h2>Add lead</h2>
      <div class="row" style="gap:8px"><div class="a-field" style="flex:1"><label class="a-label">First name</label><input class="a-input" id="mFn"></div>
      <div class="a-field" style="flex:1"><label class="a-label">Last name</label><input class="a-input" id="mLn"></div></div>
      <div class="row" style="gap:8px"><div class="a-field" style="flex:1"><label class="a-label">Company</label><input class="a-input" id="mCo"></div>
      <div class="a-field" style="flex:1"><label class="a-label">Title</label><input class="a-input" id="mTi"></div></div>
      <div class="a-field"><label class="a-label">Email</label><input class="a-input" id="mEm"></div>
      <div class="a-field"><label class="a-label">LinkedIn URL</label><input class="a-input" id="mUrl"></div>
      <div class="modal-foot"><button class="a-btn ghost" id="mCancel">Cancel</button><button class="a-btn primary" id="mSave">Add lead</button></div>`);
    $('#mCancel').addEventListener('click', closeModal);
    $('#mSave').addEventListener('click', () => {
      const l = A.build.lead({ firstName: $('#mFn').value.trim(), lastName: $('#mLn').value.trim(), company: $('#mCo').value.trim(), position: $('#mTi').value.trim(), email: $('#mEm').value.trim(), profileUrl: $('#mUrl').value.trim(), source: 'manual' });
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
    if (!threads.length) { list.innerHTML = '<div class="empty" style="grid-column:1/-1"><div class="big">💬</div><p>No conversations yet. Advance the sim clock to generate replies.</p></div>'; $('#chat').innerHTML = ''; return; }
    if (!activeThreadId || !threads.find(t => t.id === activeThreadId)) activeThreadId = threads[0].id;
    threads.forEach(th => {
      const last = th.messages[th.messages.length - 1];
      const row = el('div', 'thread-row' + (th.id === activeThreadId ? ' active' : ''));
      row.innerHTML = `<div class="tn"><span class="avatar2" style="background:${colorFor(th.name)};width:24px;height:24px;font-size:10px">${initials(th.name)}</span>${esc(th.name)} ${th.hot ? '<span class="hotbadge">🔥 HOT</span>' : ''}</div>
        <div class="tp">${last ? (last.dir === 'out' ? 'You: ' : '') + esc(last.text) : ''}</div>`;
      row.addEventListener('click', () => { activeThreadId = th.id; renderInbox(); });
      list.appendChild(row);
    });
    renderChat();
  }
  function renderChat() {
    const th = store.get('threads', activeThreadId); const chat = $('#chat'); if (!th) { chat.innerHTML = ''; return; }
    chat.innerHTML = `<div class="chat-head"><span class="avatar2" style="background:${colorFor(th.name)};width:26px;height:26px;font-size:11px">${initials(th.name)}</span> ${esc(th.name)} ${th.hot ? '<span class="hotbadge">🔥 interest detected</span>' : ''}</div><div class="chat-body" id="chatBody"></div>`;
    const body = $('#chatBody');
    th.messages.forEach(m => body.appendChild(el('div', 'bubble2 ' + (m.dir === 'out' ? 'out' : 'in'), esc(m.text))));
    if (th.status === 'replied') body.appendChild(el('div', 'bubble2 sys', '↳ Prospect replied — sequence auto-paused, routed for a human reply'));
    body.scrollTop = body.scrollHeight;
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
      <div class="a-field"><label class="a-label">Body</label><textarea class="a-textarea" id="tBody" style="min-height:120px">${esc(t.variants && t.variants.length ? t.variants[0].body : t.body)}</textarea></div>
      <p class="dim" style="font-size:11.5px">Merge fields: {first_name} {last_name} {company} {position} {location} · spintax {{a|b}}</p>
      <div class="modal-foot">${id ? '<button class="a-btn danger ghost" id="tDel">Delete</button>' : ''}<span style="flex:1"></span><button class="a-btn ghost" id="tCancel">Cancel</button><button class="a-btn primary" id="tSave">Save</button></div>`);
    $('#tCancel').addEventListener('click', closeModal);
    $('#tDel') && $('#tDel').addEventListener('click', () => { store.remove('templates', id); closeModal(); renderTemplates(); toast('Template deleted'); });
    $('#tSave').addEventListener('click', () => {
      const patch = { name: $('#tName').value.trim(), channel: $('#tCh').value, action: $('#tAct').value.trim(), subject: $('#tSubj').value, body: $('#tBody').value };
      if (id) { if (t.variants && t.variants.length) t.variants[0].body = patch.body; store.update('templates', id, patch); }
      else store.insert('templates', A.build.template(patch));
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
    $('#byChannel').innerHTML = Object.keys(byCh).length ? Object.entries(byCh).map(([k, v]) => `<div class="bar-row"><span class="bl">${ACTION_CATALOG[k] ? ACTION_CATALOG[k].icon : ''} ${k}</span><span class="bar-track"><span class="bar-fill" style="width:${v / max * 100}%"></span></span><span class="dim">${v}</span></div>`).join('') : '<p class="dim">No activity yet — enroll leads and advance the clock.</p>';
  }

  /* ============================================================
     SETTINGS
     ============================================================ */
  function renderSettings() {
    // accounts
    $('#accList').innerHTML = store.all('channelAccounts').map(a => `<div class="acc-chip">
      <span class="healthdot ${a.health}"></span><span style="font-size:18px">${ACTION_CATALOG[a.type] ? ACTION_CATALOG[a.type].icon : '🔌'}</span>
      <div style="flex:1"><div style="font-size:13px;font-weight:600">${esc(a.displayName)}</div><div class="dim" style="font-size:11px">${a.type} · ${a.status}</div></div></div>`).join('') || '<p class="dim">No accounts.</p>';

    // limits for the campaign's first account
    const c = campaign(); const acc = c && store.get('channelAccounts', (c.channelAccountIds || [])[0]);
    if (acc) {
      const limits = acc.dailyLimits || {};
      $('#limitsBox').innerHTML = Object.keys(limits).map(k => `<div class="limit-row"><span>${k}</span><input class="a-input" type="number" data-lim="${k}" value="${limits[k]}"></div>`).join('');
      $$('[data-lim]').forEach(inp => inp.addEventListener('change', e => { acc.dailyLimits[e.target.dataset.lim] = +e.target.value; store.save(); toast('Limit updated'); }));
      const s = acc.safety || A.DEFAULT_SAFETY;
      $('#safetyBox').innerHTML = `
        <div class="limit-row"><span>Working hours start</span><input class="a-input" type="number" id="sStart" value="${s.workingHours.start}"></div>
        <div class="limit-row"><span>Working hours end</span><input class="a-input" type="number" id="sEnd" value="${s.workingHours.end}"></div>
        <div class="limit-row"><span>Pause on weekends</span><input type="checkbox" id="sWk" ${s.weekendsOff ? 'checked' : ''}></div>
        <div class="limit-row"><span>Warm-up enabled</span><input type="checkbox" id="sWarm" ${s.warmup.enabled ? 'checked' : ''}></div>
        <div class="limit-row"><span>Random delay min (min)</span><input class="a-input" type="number" id="sDmin" value="${s.randomDelayMin}"></div>
        <div class="limit-row"><span>Random delay max (min)</span><input class="a-input" type="number" id="sDmax" value="${s.randomDelayMax}"></div>
        <div class="limit-row"><span>Pending invite cap</span><input class="a-input" type="number" id="sPend" value="${s.pendingInviteCap}"></div>`;
      const bind = (id, fn) => { const e = $('#' + id); e && e.addEventListener('change', ev => { fn(ev.target); store.save(); toast('Saved'); }); };
      bind('sStart', t => acc.safety.workingHours.start = +t.value); bind('sEnd', t => acc.safety.workingHours.end = +t.value);
      bind('sWk', t => acc.safety.weekendsOff = t.checked); bind('sWarm', t => acc.safety.warmup.enabled = t.checked);
      bind('sDmin', t => acc.safety.randomDelayMin = +t.value); bind('sDmax', t => acc.safety.randomDelayMax = +t.value);
      bind('sPend', t => acc.safety.pendingInviteCap = +t.value);
    } else { $('#limitsBox').innerHTML = '<p class="dim">Connect an account first.</p>'; $('#safetyBox').innerHTML = ''; }

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
    engine.activateCampaign(c.id);
    const all = store.all('leads').map(l => l.id);
    const created = engine.enroll(c.id, all, simNow);
    renderAll(); toast(created.length + ' new leads enrolled · campaign live');
  });

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
    if (!confirm('Reset all studio data and reseed the demo?')) return;
    store.reset(); localStorage.removeItem(SIM_KEY); location.reload();
  });

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

  /* ---- go ---- */
  renderAll();
})();
