/* ============================================================
   RecruiterOS · Campaign Studio
   An interactive drag-and-drop, multi-channel sequence builder.

   Exposed as a mountable module so it is a first-class, functioning
   part of the portal: the Command Center mounts it inside the app shell
   (sharing auth, motion, and persistence), and the standalone
   campaign-studio.html page mounts it for the marketing site. Drag
   channel blocks (LinkedIn connect / message / voice note / InMail, cold
   + follow-up email, individual SMS, voice calls, logic) into a canvas,
   reorder them, configure each touch, assign the campaign, and save it to
   a stored library. Shapes mirror integration/lib/campaigns + channels.

   Usage:
     CampaignStudio.mount(rootEl, {
       motion, embedded, openId,
       toast(msg), onMotionChange(motion),
       store: { all(), save(camp), remove(id) }   // optional; defaults to localStorage
     })
   ============================================================ */
(function (global) {
  "use strict";

  /* ---------------- tiny dom helpers ---------------- */
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function uid(p) { return (p || "s") + "_" + Math.random().toString(36).slice(2, 9); }
  function nowIso() { return new Date().toISOString(); }

  /* ---------------- block catalog --------------------------------------- */
  var FIELDS = {
    note:    { key: "body", type: "textarea", label: "Note (optional)", placeholder: "Hi {{firstName}}, saw {{company}} is hiring...", vars: true },
    message: { key: "body", type: "textarea", label: "Message", placeholder: "Hi {{firstName}}, {{signal}} caught my eye...", vars: true },
    subject: { key: "subject", type: "text", label: "Subject", placeholder: "{{role}} at {{company}}?" },
    sms:     { key: "body", type: "textarea", label: "Text message", placeholder: "Hi {{firstName}}, quick one re: {{role}} - worth a chat?", vars: true, max: 160 },
    script:  { key: "body", type: "textarea", label: "Talking points / script", placeholder: "Reference the funding signal, ask for a thumbs up, keep it under 30s.", vars: true },
  };

  // channel: linkedin | email | sms | voice | logic
  var CATALOG = [
    { group: "LinkedIn", channel: "linkedin", blocks: [
      { key: "li_view",    label: "Profile view",        ic: "👁️", desc: "Passive warmup", cfg: [] },
      { key: "li_follow",  label: "Follow",              ic: "➕", desc: "Low-commitment touch", cfg: [] },
      { key: "li_connect", label: "Connection request",  ic: "🤝", desc: "Connect, with or without a note", cfg: ["withNote", "note"] },
      { key: "li_like",    label: "Like a post",         ic: "👍", desc: "Engage their latest post", cfg: [] },
      { key: "li_comment", label: "Comment on post",     ic: "💭", desc: "Manual, signals attention", cfg: ["message"] },
      { key: "li_message", label: "LinkedIn message",    ic: "💬", desc: "Direct message (needs connection)", cfg: ["message"] },
      { key: "li_voice",   label: "LinkedIn voice note", ic: "🎙️", desc: "Recorded voice DM, highest-converting", cfg: ["script"] },
      { key: "li_inmail",  label: "InMail",              ic: "📨", desc: "Paid message, no connection needed", cfg: ["subject", "message"] },
    ] },
    { group: "Email", channel: "email", blocks: [
      { key: "em_cold",     label: "Cold email",     ic: "✉️", desc: "Signal-anchored opener", cfg: ["subject", "message"] },
      { key: "em_followup", label: "Follow-up email", ic: "↩️", desc: "Reply in the same thread", cfg: ["subject", "message"] },
    ] },
    { group: "Text / SMS", channel: "sms", blocks: [
      { key: "sms_send", label: "Send text (SMS)", ic: "📱", desc: "Individual text via TalTxt / Telnyx", cfg: ["sms"], testSend: true },
      { key: "sms_mms",  label: "Send MMS",        ic: "🖼️", desc: "Text with an image attachment", cfg: ["sms"], testSend: true },
      { key: "wa_send",  label: "WhatsApp message", ic: "🟢", desc: "1:1 WhatsApp message", cfg: ["message"] },
    ] },
    { group: "Voice", channel: "voice", blocks: [
      { key: "vo_call",      label: "Phone call",     ic: "📞", desc: "Telnyx dialer with Premium AMD", cfg: ["script"] },
      { key: "vo_voicemail", label: "Voicemail drop", ic: "📭", desc: "Pre-recorded ringless voicemail", cfg: ["script"] },
    ] },
    { group: "Logic & flow", channel: "logic", blocks: [
      { key: "lg_delay",  label: "Wait / delay",   ic: "⏱️", desc: "Pause before the next step", cfg: ["delayOnly"] },
      { key: "lg_branch", label: "If / branch",    ic: "🔀", desc: "Split on replied, accepted, opened...", cfg: ["condition"] },
      { key: "lg_ab",     label: "A/B split",      ic: "⚗️", desc: "Test two variants of the next touch", cfg: ["abtest"] },
      { key: "lg_task",   label: "Manual task",    ic: "📋", desc: "A to-do for the recruiter", cfg: ["message"] },
      { key: "lg_assign", label: "Assign to",      ic: "🧑‍💼", desc: "Route to a teammate or account", cfg: ["assignee"] },
      { key: "lg_enrich", label: "Enrich contact", ic: "⚡", desc: "Find email / phone (waterfall)", cfg: [] },
      { key: "lg_crm",    label: "Update ATS/CRM", ic: "🗂️", desc: "Write a stage / note to the ATS", cfg: ["message"] },
      { key: "lg_goal",   label: "Goal reached",   ic: "🎯", desc: "Exit the sequence as a win", cfg: [] },
    ] },
  ];

  var BLOCK = {};
  CATALOG.forEach(function (g) { g.blocks.forEach(function (b) { b.channel = g.channel; BLOCK[b.key] = b; }); });

  var CONDITIONS = ["replied on any channel", "connection accepted", "email opened", "link clicked", "no reply", "marked HOT"];
  var DEFAULT_ASSIGNEES = ["You", "Jamie Dawson", "BD desk", "Round-robin team", "Unassigned"];
  var DEFAULT_ACCOUNTS = ["jamie@recruiteros.co", "bd@recruiteros.co", "auto-rotate"];

  /* ---- starter templates per motion ---- */
  function mk(key, cfg) { var b = BLOCK[key]; return { uid: uid(), key: key, channel: b.channel, label: b.label, ic: b.ic, cfg: cfg || {}, delay: 0 }; }
  function delay(days) { var s = mk("lg_delay"); s.delay = days; return s; }
  function starter(motion) {
    if (motion === "bd") {
      return [
        mk("li_view"), mk("li_connect", { withNote: false }), delay(2),
        mk("em_cold", { subject: "{{company}} + {{role}}", body: "Hi {{firstName}}, saw {{signal}}. Worth a quick note on how we'd fill {{role}}?" }), delay(2),
        mk("li_message", { body: "Hi {{firstName}}, just sent a note over email re: {{role}} - happy to share a comparable we placed." }), delay(3),
        mk("vo_call"), delay(4),
        mk("em_followup", { subject: "Should I close the file?", body: "No worries if the timing is off, {{firstName}}. Want me to circle back next quarter?" }),
      ];
    }
    return [
      mk("li_view"), mk("li_connect", { withNote: true, body: "Hi {{firstName}}, came across your work at {{company}} - would love to connect." }), delay(2),
      mk("li_message", { body: "Hi {{firstName}}, I'm working a {{role}} role that lines up with your background. Open to hearing about it?" }), delay(2),
      mk("em_cold", { subject: "{{role}} - thought of you", body: "Hi {{firstName}}, quick one about a {{role}} opportunity. Worth sending the details?" }), delay(3),
      mk("sms_send", { body: "Hi {{firstName}}, it's {{me}} re: the {{role}} role - good time for a quick call this week?" }), delay(4),
      mk("vo_call"),
    ];
  }

  /* ---------------- default localStorage store ---------------- */
  var LS = "ros_campaigns";
  function lsAll() { try { return JSON.parse(localStorage.getItem(LS) || "[]"); } catch (e) { return []; } }
  var localStore = {
    all: function () { return lsAll(); },
    save: function (camp) { var l = lsAll().filter(function (c) { return c.id !== camp.id; }); l.unshift(camp); localStorage.setItem(LS, JSON.stringify(l)); },
    remove: function (id) { localStorage.setItem(LS, JSON.stringify(lsAll().filter(function (c) { return c.id !== id; }))); },
  };

  /* ---------------- the inner markup the module injects ---------------- */
  function template(opts) {
    var motionToggle = opts.embedded ? "" :
      '<div class="cs-motion">' +
        '<button class="mt active" data-motion="recruiting">👤 Recruiting</button>' +
        '<button class="mt" data-motion="bd">🏢 BD</button>' +
      '</div>';
    return '' +
    '<div class="cs-toolbar">' +
      '<div class="name-wrap"><label>Campaign name</label>' +
        '<input data-cs="name" class="cs-name" value="Untitled campaign" spellcheck="false" /></div>' +
      motionToggle +
      '<span data-cs="status" class="cs-status-pill draft">draft</span>' +
      '<div class="cs-tool-actions">' +
        '<button class="btn btn-ghost btn-sm" data-cs="new">＋ New</button>' +
        '<button class="btn btn-ghost btn-sm" data-cs="library">📚 Library</button>' +
        '<button class="btn btn-ghost btn-sm" data-cs="saveas">Save as</button>' +
        '<button class="btn btn-ghost btn-sm" data-cs="save">💾 Save</button>' +
        '<button class="btn btn-primary btn-sm" data-cs="launch">🚀 Activate</button>' +
      '</div>' +
    '</div>' +
    '<div class="cs-grid">' +
      '<aside class="cs-col cs-palette"><h4 class="cs-col-title">Blocks</h4>' +
        '<input data-cs="palSearch" class="pal-search" placeholder="Search blocks..." />' +
        '<div data-cs="palette"></div></aside>' +
      '<section class="cs-col cs-canvas-col"><div class="cs-canvas" data-cs="canvas"></div></section>' +
      '<aside class="cs-col cs-inspector"><h4 class="cs-col-title">Campaign</h4>' +
        '<div class="insp-field"><label>Goal</label><textarea data-cs="goal" rows="2" placeholder="Book discovery calls with VP Eng at recently funded fintechs."></textarea></div>' +
        '<div class="insp-field"><label>Assigned to</label><select data-cs="assignee"></select></div>' +
        '<div class="insp-field"><label>Sending account</label><select data-cs="account"></select></div>' +
        '<div class="insp-field"><label>Daily cap (prospects/day)</label><input data-cs="cap" type="number" min="1" value="25" /></div>' +
        '<div class="insp-field"><label>Voice-note threshold (warmth)</label><input data-cs="threshold" type="number" min="0" max="100" value="80" /></div>' +
        '<h4 class="cs-col-title" style="margin-top:8px">Sequence stats</h4>' +
        '<div class="insp-stats">' +
          '<div class="stat"><span>Outreach touches</span><b data-cs="stTouches">0</b></div>' +
          '<div class="stat"><span>Total steps</span><b data-cs="stSteps">0</b></div>' +
          '<div class="stat"><span>Channels used</span><b data-cs="stChannels">0</b></div>' +
          '<div class="stat"><span>Span (days of waits)</span><b data-cs="stDays">0</b></div>' +
        '</div>' +
        '<div class="mix-bar" data-cs="mixBar"></div><div class="mix-legend" data-cs="mixLegend"></div>' +
      '</aside>' +
    '</div>' +
    '<div class="cs-modal" data-cs="libModal"><div class="cs-modal-card">' +
      '<button class="modal-close" data-cs="libClose">×</button>' +
      '<h3>Campaign library</h3>' +
      '<p class="sub">Every campaign you save lives here, for both the Recruiting OS and the BD OS. Open one to keep editing, duplicate it as a starting point, or delete it.</p>' +
      '<div data-cs="libList"></div>' +
    '</div></div>';
  }

  /* ============================================================
     mount
     ============================================================ */
  function mount(root, opts) {
    opts = opts || {};
    var store = opts.store || localStore;
    var assignees = opts.assignees || DEFAULT_ASSIGNEES;
    var accounts = opts.accounts || DEFAULT_ACCOUNTS;

    root.classList.add("studio");
    if (opts.embedded) root.classList.add("cs-embedded");
    root.innerHTML = template(opts);

    var $ = function (sel) { return root.querySelector('[data-cs="' + sel + '"]'); };

    /* toast: host-provided or self-built */
    var tT;
    function toast(msg) {
      if (opts.toast) { opts.toast(msg); return; }
      var t = document.getElementById("csToast");
      if (!t) { t = el("div", "toast"); t.id = "csToast"; document.body.appendChild(t); }
      t.innerHTML = '<span class="tok">✓</span> ' + esc(msg); t.classList.add("show");
      clearTimeout(tT); tT = setTimeout(function () { t.classList.remove("show"); }, 2400);
    }

    /* state */
    var state = {
      id: null, name: "Untitled campaign", goal: "",
      motion: opts.motion === "bd" ? "bd" : "recruiting",
      status: "draft", assignee: assignees[0], account: accounts[0],
      dailyCap: 25, voiceThreshold: 80, steps: [], selected: null,
    };

    /* populate selects */
    function fillSelect(node, items, val) {
      node.innerHTML = "";
      items.forEach(function (o) { var op = el("option", null, esc(o)); op.value = o; if (o === val) op.selected = true; node.appendChild(op); });
    }
    fillSelect($("assignee"), assignees, state.assignee);
    fillSelect($("account"), accounts, state.account);

    /* ---------- snapshot / persistence ---------- */
    function snapshot() {
      return {
        id: state.id || uid("camp"), name: state.name, goal: state.goal, motion: state.motion,
        status: state.status, assignee: state.assignee, account: state.account,
        dailyCap: state.dailyCap, voiceThreshold: state.voiceThreshold,
        steps: state.steps.map(function (s) { return { uid: s.uid, key: s.key, channel: s.channel, label: s.label, ic: s.ic, cfg: s.cfg, delay: s.delay }; }),
        updatedAt: nowIso(),
      };
    }
    function save(silent) {
      var snap = snapshot();
      if (!state.id) { snap.createdAt = nowIso(); state.id = snap.id; }
      else { var prev = store.all().filter(function (c) { return c.id === state.id; })[0]; if (prev) snap.createdAt = prev.createdAt; }
      store.save(snap);
      if (!silent) toast("Saved to library");
      syncMeta();
    }
    function loadCampaign(c) {
      state.id = c.id; state.name = c.name; state.goal = c.goal || ""; state.motion = c.motion;
      state.status = c.status || "draft"; state.assignee = c.assignee || assignees[0]; state.account = c.account || accounts[0];
      state.dailyCap = c.dailyCap || 25; state.voiceThreshold = c.voiceThreshold || 80;
      state.steps = (c.steps || []).map(function (s) { return { uid: s.uid || uid(), key: s.key, channel: s.channel, label: s.label, ic: s.ic, cfg: s.cfg || {}, delay: s.delay || 0 }; });
      state.selected = null;
      fillSelect($("assignee"), assignees, state.assignee);
      fillSelect($("account"), accounts, state.account);
      syncMeta(); renderCanvas(); renderPalette();
    }

    /* ---------- meta sync ---------- */
    function syncMeta() {
      $("name").value = state.name;
      $("goal").value = state.goal;
      $("assignee").value = state.assignee;
      $("account").value = state.account;
      $("cap").value = state.dailyCap;
      $("threshold").value = state.voiceThreshold;
      var sp = $("status"); sp.textContent = state.status; sp.className = "cs-status-pill " + state.status;
      if (!opts.embedded) Array.prototype.forEach.call(root.querySelectorAll(".cs-motion .mt"), function (b) { b.classList.toggle("active", b.dataset.motion === state.motion); });
      renderStats();
    }

    /* ---------- palette ---------- */
    function renderPalette() {
      var q = ($("palSearch").value || "").toLowerCase();
      var wrap = $("palette"); wrap.innerHTML = "";
      CATALOG.forEach(function (g) {
        var blocks = g.blocks.filter(function (b) { return !q || b.label.toLowerCase().indexOf(q) >= 0 || b.desc.toLowerCase().indexOf(q) >= 0; });
        if (!blocks.length) return;
        var grp = el("div", "pal-group");
        grp.appendChild(el("h5", null, '<span class="gd ch-' + g.channel + '"></span>' + esc(g.group)));
        blocks.forEach(function (b) {
          var item = el("div", "pal-block");
          item.draggable = true; item.dataset.key = b.key;
          item.innerHTML = '<span class="pb-ic ch-' + b.channel + '">' + b.ic + '</span>' +
            '<span class="pb-meta"><b>' + esc(b.label) + '</b><span>' + esc(b.desc) + '</span></span>';
          item.addEventListener("dragstart", function (e) { drag = { type: "new", key: b.key }; item.classList.add("dragging"); e.dataTransfer.effectAllowed = "copy"; try { e.dataTransfer.setData("text/plain", b.key); } catch (x) {} });
          item.addEventListener("dragend", function () { item.classList.remove("dragging"); clearDrag(); });
          grp.appendChild(item);
        });
        wrap.appendChild(grp);
      });
    }

    /* ---------- drag engine ---------- */
    var drag = null;
    function clearDrag() {
      drag = null;
      Array.prototype.forEach.call(root.querySelectorAll(".step"), function (s) { s.classList.remove("drag-over-top", "drag-over-bot", "dragging"); });
      var tail = $("canvas").querySelector(".drop-tail"); if (tail) tail.classList.remove("drop-hot");
      var e = root.querySelector(".cs-empty"); if (e) e.classList.remove("drop-hot");
    }
    function indexOfUid(u) { for (var i = 0; i < state.steps.length; i++) if (state.steps[i].uid === u) return i; return -1; }
    function insertStep(step, atIndex) { if (atIndex == null || atIndex > state.steps.length) atIndex = state.steps.length; state.steps.splice(atIndex, 0, step); state.selected = step.uid; renderCanvas(); }
    function moveStep(u, toIndex) { var from = indexOfUid(u); if (from < 0) return; var step = state.steps.splice(from, 1)[0]; if (toIndex > from) toIndex--; state.steps.splice(Math.max(0, toIndex), 0, step); renderCanvas(); }
    function commitDrop(index) { if (!drag) return; if (drag.type === "new") insertStep(mk(drag.key), index); else if (drag.type === "move") moveStep(drag.uid, index); clearDrag(); }
    function attachDrop(node, indexFn) {
      node.addEventListener("dragover", function (e) { if (!drag) return; e.preventDefault(); node.classList.add("drop-hot"); });
      node.addEventListener("dragleave", function () { node.classList.remove("drop-hot"); });
      node.addEventListener("drop", function (e) { e.preventDefault(); node.classList.remove("drop-hot"); commitDrop(indexFn()); });
    }

    /* ---------- canvas ---------- */
    function barColor(ch) { return { linkedin: "#7c5cff", email: "#4dd0ff", sms: "#38e0a6", voice: "#ffc24d", logic: "#ff7ac6" }[ch] || "#7c5cff"; }
    function countTouchesUpTo(i) { var n = 0; for (var k = 0; k <= i; k++) if (state.steps[k].key !== "lg_delay") n++; return n; }

    function renderCanvas() {
      var c = $("canvas"); c.innerHTML = "";
      if (!state.steps.length) {
        var empty = el("div", "cs-empty", '<div class="big">🧩</div><b>Drag a block here to start</b>' +
          '<p style="margin-top:6px;font-size:13px">Pull LinkedIn, email, SMS, voice, or logic blocks from the left to build your sequence. Or load a template.</p>' +
          '<button class="btn btn-ghost btn-sm" data-cs="loadStarter" style="margin-top:12px">Use a starter template</button>');
        attachDrop(empty, function () { return 0; });
        c.appendChild(empty);
        empty.querySelector('[data-cs="loadStarter"]').addEventListener("click", function () { state.steps = starter(state.motion); state.selected = null; renderCanvas(); toast("Loaded " + (state.motion === "bd" ? "BD" : "Recruiting") + " starter"); });
        renderStats(); return;
      }
      c.appendChild(el("div", "canvas-start", '<span class="pin"></span> Prospect enters the sequence'));
      state.steps.forEach(function (step, i) { c.appendChild(connector(step)); c.appendChild(stepCard(step, i)); });
      var tail = el("div", "drop-tail"); attachDrop(tail, function () { return state.steps.length; }); c.appendChild(tail);
      renderStats();
    }

    function connector(step) {
      var wrap = el("div", "delay-wrap");
      wrap.appendChild(el("div", "flow-line"));
      if (step.key !== "lg_delay" && step.delay && step.delay > 0) {
        var pill = el("div", "delay-pill", "⏱️ wait " + step.delay + (step.delay === 1 ? " day" : " days"));
        pill.addEventListener("click", function () { var d = prompt("Wait how many days before \"" + step.label + "\"?", step.delay); if (d !== null) { step.delay = Math.max(0, parseInt(d, 10) || 0); renderCanvas(); } });
        wrap.appendChild(pill); wrap.appendChild(el("div", "flow-line"));
      }
      return wrap;
    }

    function summarize(step) {
      var b = BLOCK[step.key];
      if (step.key === "lg_delay") return "Wait " + (step.delay || 0) + (step.delay === 1 ? " day" : " days");
      if (step.key === "lg_branch") return "If " + (step.cfg.condition || CONDITIONS[0]);
      if (step.key === "lg_assign") return "Assign to " + (step.cfg.assignee || state.assignee);
      if (step.cfg.subject) return step.cfg.subject;
      if (step.cfg.body) return step.cfg.body.slice(0, 60) + (step.cfg.body.length > 60 ? "..." : "");
      return b ? b.desc : "";
    }

    function stepCard(step, i) {
      var card = el("div", "step" + (state.selected === step.uid ? " sel open" : ""));
      card.dataset.uid = step.uid; card.draggable = true;
      var num = step.key === "lg_delay" ? "⏱️" : "#" + countTouchesUpTo(i);
      card.innerHTML =
        '<div class="step-bar"></div>' +
        '<div class="step-head">' +
          '<span class="s-ic ch-' + step.channel + '">' + step.ic + '</span>' +
          '<span class="s-meta"><b>' + esc(step.label) + '</b><span class="s-sub">' + esc(summarize(step)) + '</span></span>' +
          '<span class="s-num">' + num + '</span>' +
          '<span class="step-actions"><button class="s-btn dup" title="Duplicate">⧉</button><button class="s-btn del" title="Delete">🗑</button></span>' +
        '</div><div class="step-config"></div>';
      card.querySelector(".step-bar").style.background = barColor(step.channel);

      card.querySelector(".step-head").addEventListener("click", function (e) {
        if (e.target.closest(".s-btn")) return;
        state.selected = state.selected === step.uid ? null : step.uid; renderCanvas();
      });
      card.querySelector(".dup").addEventListener("click", function () { var copy = JSON.parse(JSON.stringify(step)); copy.uid = uid(); insertStep(copy, i + 1); toast("Step duplicated"); });
      card.querySelector(".del").addEventListener("click", function () { state.steps.splice(i, 1); if (state.selected === step.uid) state.selected = null; renderCanvas(); });

      if (state.selected === step.uid) renderConfig(card.querySelector(".step-config"), step);

      card.addEventListener("dragstart", function (e) { drag = { type: "move", uid: step.uid }; card.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", step.uid); } catch (x) {} e.stopPropagation(); });
      card.addEventListener("dragend", function () { clearDrag(); });
      card.addEventListener("dragover", function (e) { if (!drag) return; e.preventDefault(); var rect = card.getBoundingClientRect(); var top = (e.clientY - rect.top) < rect.height / 2; card.classList.toggle("drag-over-top", top); card.classList.toggle("drag-over-bot", !top); });
      card.addEventListener("dragleave", function () { card.classList.remove("drag-over-top", "drag-over-bot"); });
      card.addEventListener("drop", function (e) { e.preventDefault(); e.stopPropagation(); var rect = card.getBoundingClientRect(); var before = (e.clientY - rect.top) < rect.height / 2; commitDrop(i + (before ? 0 : 1)); });
      return card;
    }

    /* ---------- step config editor ---------- */
    function renderConfig(host, step) {
      host.innerHTML = "";
      var b = BLOCK[step.key]; var cfg = b.cfg || [];
      cfg.forEach(function (f) {
        if (f === "delayOnly") { host.appendChild(numField("Wait (days)", step.delay || 0, function (v) { step.delay = Math.max(0, v); refreshSub(step); })); host.appendChild(hint("Pause the sequence before the next touch.")); return; }
        if (f === "withNote") { host.appendChild(toggleField("Include a note", !!step.cfg.withNote, function (on) { step.cfg.withNote = on; renderConfig(host, step); })); return; }
        if (f === "condition") { host.appendChild(selectField("Condition", CONDITIONS, step.cfg.condition || CONDITIONS[0], function (v) { step.cfg.condition = v; refreshSub(step); })); host.appendChild(hint("Steps after this run only when the condition is met.")); return; }
        if (f === "abtest") {
          host.appendChild(textField("Variant A label", step.cfg.varA || "Direct", function (v) { step.cfg.varA = v; }));
          host.appendChild(textField("Variant B label", step.cfg.varB || "Curiosity", function (v) { step.cfg.varB = v; }));
          host.appendChild(rangeField("Split to A (%)", step.cfg.weight == null ? 50 : step.cfg.weight, function (v) { step.cfg.weight = v; }));
          host.appendChild(hint("Only one variable should differ between A and B.")); return;
        }
        if (f === "assignee") {
          host.appendChild(selectField("Assign to", assignees, step.cfg.assignee || state.assignee, function (v) { step.cfg.assignee = v; refreshSub(step); }));
          host.appendChild(selectField("Sending account", accounts, step.cfg.account || state.account, function (v) { step.cfg.account = v; })); return;
        }
        var spec = FIELDS[f]; if (!spec) return;
        host.appendChild(spec.type === "textarea"
          ? textareaField(spec.label, step.cfg[spec.key] || "", spec.placeholder, function (v) { step.cfg[spec.key] = v; refreshSub(step); }, spec)
          : textField(spec.label, step.cfg[spec.key] || "", function (v) { step.cfg[spec.key] = v; refreshSub(step); }, spec.placeholder));
      });
      if (step.key !== "lg_delay" && cfg.indexOf("delayOnly") < 0) host.appendChild(numField("Wait before this step (days)", step.delay || 0, function (v) { step.delay = Math.max(0, v); refreshSub(step); }));
      if (b.testSend) host.appendChild(testSendPanel(step));
      if (!cfg.length && step.key.indexOf("lg_") !== 0) host.appendChild(hint("No configuration needed. This is an automated touch."));
      if (step.key === "lg_enrich") host.appendChild(hint("Runs the cheapest-first enrichment waterfall (Fresh LinkedIn + Tomba) to resolve email/phone before the next channel."));
      if (step.key === "lg_goal") host.appendChild(hint("When the prospect reaches this point, the sequence exits and is marked a win."));
    }
    function refreshSub(step) { var card = root.querySelector('.step[data-uid="' + step.uid + '"]'); if (card) card.querySelector(".s-sub").textContent = summarize(step); }

    /* field factories */
    function wrapField(label) { var f = el("div", "cfg-field"); if (label) f.appendChild(el("label", null, esc(label))); return f; }
    function textField(label, val, on, ph) { var f = wrapField(label); var i = el("input"); i.type = "text"; i.value = val || ""; if (ph) i.placeholder = ph; i.addEventListener("input", function () { on(i.value); }); f.appendChild(i); return f; }
    function numField(label, val, on) { var f = wrapField(label); var i = el("input"); i.type = "number"; i.min = 0; i.value = val; i.addEventListener("input", function () { on(parseInt(i.value, 10) || 0); }); f.appendChild(i); return f; }
    function textareaField(label, val, ph, on, spec) {
      var f = wrapField(label); var t = el("textarea"); t.value = val || ""; if (ph) t.placeholder = ph;
      var counter; t.addEventListener("input", function () { on(t.value); if (counter) updateCount(); }); f.appendChild(t);
      if (spec && spec.vars) {
        var vars = el("div", "cfg-vars");
        ["{{firstName}}", "{{company}}", "{{role}}", "{{signal}}", "{{me}}"].forEach(function (v) {
          var cc = el("button", "var-chip", v); cc.type = "button";
          cc.addEventListener("click", function () { var p = t.selectionStart || t.value.length; t.value = t.value.slice(0, p) + v + t.value.slice(p); on(t.value); if (counter) updateCount(); t.focus(); });
          vars.appendChild(cc);
        });
        f.appendChild(vars);
      }
      if (spec && spec.max) { counter = el("div", "cfg-hint"); var updateCount = function () { var n = t.value.length; counter.textContent = n + " / " + spec.max + " chars" + (n > spec.max ? " - may split into 2 segments" : ""); counter.style.color = n > spec.max ? "var(--accent-amber)" : ""; }; updateCount(); f.appendChild(counter); }
      return f;
    }
    function selectField(label, optsList, val, on) { var f = wrapField(label); var s = el("select"); optsList.forEach(function (o) { var op = el("option", null, esc(o)); op.value = o; if (o === val) op.selected = true; s.appendChild(op); }); s.addEventListener("change", function () { on(s.value); }); f.appendChild(s); return f; }
    function toggleField(label, on, cb) { var row = el("div", "cfg-toggle-row"); row.appendChild(el("span", null, esc(label))); var sw = el("div", "switch" + (on ? " on" : "")); sw.appendChild(el("i")); sw.addEventListener("click", function () { on = !on; sw.classList.toggle("on", on); cb(on); }); row.appendChild(sw); return row; }
    function rangeField(label, val, on) { var f = wrapField(label + ": " + val + " / " + (100 - val)); var lab = f.querySelector("label"); var r = el("input"); r.type = "range"; r.min = 0; r.max = 100; r.value = val; r.addEventListener("input", function () { lab.textContent = label + ": " + r.value + " / " + (100 - r.value); on(parseInt(r.value, 10)); }); f.appendChild(r); return f; }
    function hint(t) { return el("div", "cfg-hint", esc(t)); }
    function testSendPanel(step) {
      var p = el("div", "test-send");
      p.innerHTML = '<b>📲 Send one test text</b><div class="cfg-hint" style="margin-top:3px">Individual SMS via TalTxt / Telnyx. Not a batch blast, one message to one number.</div>';
      var row = el("div", "ts-row"); var num = el("input"); num.type = "tel"; num.placeholder = "+1 555 010 0000";
      var btn = el("button", "btn btn-primary btn-sm", "Send test");
      btn.addEventListener("click", function () {
        var to = (num.value || "").trim(); if (!to) { toast("Enter a phone number"); return; }
        if (!step.cfg.body) { toast("Write the message first"); return; }
        if (opts.sendTestSms) { opts.sendTestSms(to, step.cfg.body, function (okMsg) { toast(okMsg || ("Test SMS sent to " + to)); }); }
        else toast("Test SMS queued to " + to + " (demo)");
      });
      row.appendChild(num); row.appendChild(btn); p.appendChild(row); return p;
    }

    /* ---------- stats ---------- */
    function renderStats() {
      var steps = state.steps;
      var touches = steps.filter(function (s) { return s.key !== "lg_delay" && s.channel !== "logic"; }).length;
      var days = 0; steps.forEach(function (s) { days += (s.delay || 0); });
      var byCh = {}; steps.forEach(function (s) { if (s.channel === "logic") return; byCh[s.channel] = (byCh[s.channel] || 0) + 1; });
      $("stTouches").textContent = touches; $("stSteps").textContent = steps.length; $("stDays").textContent = days; $("stChannels").textContent = Object.keys(byCh).length;
      var order = ["linkedin", "email", "sms", "voice"];
      var total = order.reduce(function (a, c) { return a + (byCh[c] || 0); }, 0);
      var bar = $("mixBar"); bar.innerHTML = ""; var legend = $("mixLegend"); legend.innerHTML = "";
      var names = { linkedin: "LinkedIn", email: "Email", sms: "SMS", voice: "Voice" };
      order.forEach(function (c) { var n = byCh[c] || 0; if (!n) return; var seg = el("span"); seg.style.width = (total ? (n / total * 100) : 0) + "%"; seg.style.background = barColor(c); bar.appendChild(seg); legend.appendChild(el("span", null, '<i style="background:' + barColor(c) + '"></i>' + names[c] + " " + n)); });
      if (!total) legend.innerHTML = '<span style="color:var(--text-dim)">No outreach touches yet</span>';
    }

    /* ---------- library ---------- */
    function relTime(iso) { if (!iso) return "just now"; var d = (Date.now() - new Date(iso).getTime()) / 1000; if (d < 60) return "just now"; if (d < 3600) return Math.floor(d / 60) + "m ago"; if (d < 86400) return Math.floor(d / 3600) + "h ago"; return Math.floor(d / 86400) + "d ago"; }
    function openLibrary() {
      var list = store.all(); var host = $("libList"); host.innerHTML = "";
      if (!list.length) host.innerHTML = '<div class="cs-empty"><div class="big">📚</div><b>No saved campaigns yet</b><p style="font-size:13px;margin-top:6px">Build a sequence and hit Save to store it here.</p></div>';
      list.forEach(function (c) {
        var touches = (c.steps || []).filter(function (s) { return s.key !== "lg_delay"; }).length;
        var item = el("div", "lib-item");
        item.innerHTML =
          '<span class="s-ic ch-' + (c.motion === "bd" ? "email" : "linkedin") + '">' + (c.motion === "bd" ? "🏢" : "👤") + '</span>' +
          '<div class="li-meta"><b>' + esc(c.name) + '</b><div class="li-sub">' + touches + ' touches · ' + (c.motion === "bd" ? "BD OS" : "Recruiting OS") + ' · ' + esc(c.status) + ' · ' + relTime(c.updatedAt) + '</div></div>' +
          '<span class="lib-tag">' + esc(c.status) + '</span>' +
          '<div class="li-actions"><button class="btn btn-ghost btn-sm" data-act="load">Open</button><button class="btn btn-ghost btn-sm" data-act="dup">Duplicate</button><button class="s-btn del" data-act="del" title="Delete">🗑</button></div>';
        item.querySelector('[data-act="load"]').addEventListener("click", function () { loadCampaign(c); closeLibrary(); toast("Opened " + c.name); });
        item.querySelector('[data-act="dup"]').addEventListener("click", function () { var copy = JSON.parse(JSON.stringify(c)); copy.id = uid("camp"); copy.name = c.name + " (copy)"; copy.createdAt = nowIso(); copy.updatedAt = nowIso(); store.save(copy); openLibrary(); toast("Duplicated"); });
        item.querySelector('[data-act="del"]').addEventListener("click", function () { if (!confirm("Delete \"" + c.name + "\"?")) return; store.remove(c.id); openLibrary(); toast("Deleted"); });
        host.appendChild(item);
      });
      $("libModal").classList.add("show");
    }
    function closeLibrary() { $("libModal").classList.remove("show"); }

    /* ---------- bind ---------- */
    $("name").addEventListener("input", function (e) { state.name = e.target.value || "Untitled campaign"; });
    $("goal").addEventListener("input", function (e) { state.goal = e.target.value; });
    $("assignee").addEventListener("change", function (e) { state.assignee = e.target.value; });
    $("account").addEventListener("change", function (e) { state.account = e.target.value; });
    $("cap").addEventListener("input", function (e) { state.dailyCap = parseInt(e.target.value, 10) || 25; });
    $("threshold").addEventListener("input", function (e) { state.voiceThreshold = parseInt(e.target.value, 10) || 80; });
    $("palSearch").addEventListener("input", renderPalette);
    if (!opts.embedded) Array.prototype.forEach.call(root.querySelectorAll(".cs-motion .mt"), function (b) {
      b.addEventListener("click", function () { state.motion = b.dataset.motion; if (opts.onMotionChange) opts.onMotionChange(state.motion); syncMeta(); renderPalette(); });
    });
    $("save").addEventListener("click", function () { save(); });
    $("saveas").addEventListener("click", function () { state.id = null; state.name = state.name + " (copy)"; syncMeta(); save(); });
    $("new").addEventListener("click", function () {
      if (state.steps.length && !confirm("Start a new campaign? Unsaved changes will be lost.")) return;
      state.id = null; state.name = "Untitled campaign"; state.goal = ""; state.status = "draft"; state.steps = []; state.selected = null;
      syncMeta(); renderCanvas(); renderPalette();
    });
    $("library").addEventListener("click", openLibrary);
    $("libClose").addEventListener("click", closeLibrary);
    $("libModal").addEventListener("click", function (e) { if (e.target === $("libModal")) closeLibrary(); });
    $("launch").addEventListener("click", function () {
      if (!state.steps.filter(function (s) { return s.channel !== "logic"; }).length) { toast("Add at least one outreach touch first"); return; }
      state.status = state.status === "active" ? "paused" : "active"; save(true); syncMeta();
      toast(state.status === "active" ? "Campaign activated 🚀" : "Campaign paused");
    });

    function onKey(e) { if (root.isConnected === false) { document.removeEventListener("keydown", onKey); return; } if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && root.querySelector(".cs-toolbar")) { e.preventDefault(); save(); } if (e.key === "Escape") closeLibrary(); }
    document.addEventListener("keydown", onKey);

    /* ---------- initial load ---------- */
    var openId = opts.openId;
    if (openId) { var found = store.all().filter(function (c) { return c.id === openId; })[0]; if (found) { loadCampaign(found); return controller(); } }
    state.steps = starter(state.motion);
    syncMeta(); renderPalette(); renderCanvas();

    function controller() {
      return {
        load: loadCampaign,
        newCampaign: function (motion) { state.id = null; state.name = "Untitled campaign"; state.goal = ""; state.status = "draft"; state.steps = starter(motion || state.motion); state.motion = motion || state.motion; state.selected = null; syncMeta(); renderCanvas(); renderPalette(); },
        getState: function () { return state; },
        save: save,
      };
    }
    return controller();
  }

  /* ---------------- export + standalone auto-mount ---------------- */
  global.CampaignStudio = { mount: mount, CATALOG: CATALOG };

  function autoMount() {
    var root = document.getElementById("csRoot");
    if (!root) return; // not the standalone page
    var params = new URLSearchParams(location.search);
    mount(root, {
      motion: params.get("motion") === "bd" ? "bd" : (localStorage.getItem("ros_motion") || "recruiting"),
      openId: params.get("id"),
      onMotionChange: function (m) { localStorage.setItem("ros_motion", m); },
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoMount);
  else autoMount();
})(typeof window !== "undefined" ? window : this);
