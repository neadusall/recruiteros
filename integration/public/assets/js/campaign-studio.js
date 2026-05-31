/* ============================================================
   RecruiterOS · Campaign Studio
   A dynamic, full-canvas, drag-and-drop multi-channel sequence builder.

   Build campaigns on a freeform 2D canvas: drop channel blocks anywhere,
   move them side to side and up and down, draw connections between them,
   pan by dragging the canvas, and zoom in and out. Works for both the
   Recruiting OS and the BD OS. Exposed as a mountable module so it is a
   first-class part of the portal (the Command Center mounts it inside the
   app shell) and also runs standalone. Shapes mirror
   integration/lib/campaigns + channels (nodes + edges persist as the
   campaign's visual sequence).

   Usage:
     CampaignStudio.mount(rootEl, {
       motion, embedded, openId,
       toast(msg), onMotionChange(motion), sendTestSms(to, body, done),
       assignees: [...], accounts: [...],
       store: { all(), save(camp), remove(id) }   // optional; localStorage default
     })
   ============================================================ */
(function (global) {
  "use strict";

  /* ---------------- tiny dom helpers ---------------- */
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function uid(p) { return (p || "s") + "_" + Math.random().toString(36).slice(2, 9); }
  function nowIso() { return new Date().toISOString(); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  var NODE_W = 244, ROW_H = 132, WORLD = 6000;
  var SVGNS = "http://www.w3.org/2000/svg";

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
  var DEFAULT_ACCOUNTS = ["jamie@recruitersos.co", "bd@recruitersos.co", "auto-rotate"];

  function mkNode(key, cfg, x, y) { var b = BLOCK[key]; return { uid: uid(), key: key, channel: b.channel, label: b.label, ic: b.ic, cfg: cfg || {}, delay: 0, x: x || 60, y: y || 40 }; }

  /* ---- starter templates per motion: a vertical chain you can rearrange ---- */
  function starter(motion) {
    var seq = motion === "bd" ? [
      ["li_view"], ["li_connect", { withNote: false }], ["lg_delay", null, 2],
      ["em_cold", { subject: "{{company}} + {{role}}", body: "Hi {{firstName}}, saw {{signal}}. Worth a quick note on how we'd fill {{role}}?" }], ["lg_delay", null, 2],
      ["li_message", { body: "Hi {{firstName}}, just sent a note over email re: {{role}} - happy to share a comparable we placed." }], ["lg_delay", null, 3],
      ["vo_call"], ["lg_delay", null, 4],
      ["em_followup", { subject: "Should I close the file?", body: "No worries if the timing is off, {{firstName}}. Want me to circle back next quarter?" }],
    ] : [
      ["li_view"], ["li_connect", { withNote: true, body: "Hi {{firstName}}, came across your work at {{company}} - would love to connect." }], ["lg_delay", null, 2],
      ["li_message", { body: "Hi {{firstName}}, I'm working a {{role}} role that lines up with your background. Open to hearing about it?" }], ["lg_delay", null, 2],
      ["em_cold", { subject: "{{role}} - thought of you", body: "Hi {{firstName}}, quick one about a {{role}} opportunity. Worth sending the details?" }], ["lg_delay", null, 3],
      ["sms_send", { body: "Hi {{firstName}}, it's {{me}} re: the {{role}} role - good time for a quick call this week?" }], ["lg_delay", null, 4],
      ["vo_call"],
    ];
    var nodes = [], edges = [];
    seq.forEach(function (s, i) {
      var n = mkNode(s[0], s[1] || {}, 80, 36 + i * ROW_H);
      if (s[2] != null) n.delay = s[2];
      if (nodes.length) edges.push({ id: uid("e"), from: nodes[nodes.length - 1].uid, to: n.uid });
      nodes.push(n);
    });
    return { nodes: nodes, edges: edges };
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
        '<button class="btn btn-ghost btn-sm cs-addblock-btn" data-cs="addblock">＋ Add block</button>' +
        '<button class="btn btn-ghost btn-sm" data-cs="full" title="Toggle full screen">⛶ Full screen</button>' +
        '<button class="btn btn-ghost btn-sm" data-cs="new">＋ New</button>' +
        '<button class="btn btn-ghost btn-sm" data-cs="library">📚 Library</button>' +
        '<button class="btn btn-ghost btn-sm" data-cs="saveas">Save as</button>' +
        '<button class="btn btn-ghost btn-sm" data-cs="save">💾 Save</button>' +
        '<button class="btn btn-primary btn-sm" data-cs="launch">🚀 Activate</button>' +
      '</div>' +
    '</div>' +
    '<div class="cs-grid" data-cs="grid">' +
      '<aside class="cs-col cs-palette">' +
        '<div class="pal-head">' +
          '<h4 class="cs-col-title pal-title">Blocks</h4>' +
          '<button class="insp-toggle" data-cs="palToggle" title="Collapse panel" aria-label="Collapse blocks panel">⟨</button>' +
        '</div>' +
        '<div class="pal-body" data-cs="palBody">' +
          '<input data-cs="palSearch" class="pal-search" placeholder="Search blocks..." />' +
          '<div data-cs="palette"></div>' +
        '</div></aside>' +
      '<section class="cs-canvas-col">' +
        '<div class="cs-viewport" data-cs="viewport">' +
          '<div class="cs-world" data-cs="world">' +
            '<svg class="cs-edges" data-cs="edges" width="' + WORLD + '" height="' + WORLD + '"></svg>' +
            '<div class="cs-nodes" data-cs="nodes"></div>' +
          '</div>' +
          '<div class="cs-empty-float" data-cs="emptyfloat" hidden>' +
            '<div class="big">🧩</div><b>Drop a block anywhere on the canvas</b>' +
            '<p>Drag from the left, or tap a block / use ＋ Add block. Move nodes around freely, then connect them by dragging the dot at the bottom of a card.</p>' +
            '<button class="btn btn-ghost btn-sm" data-cs="loadStarter">Use a starter template</button>' +
          '</div>' +
          '<div class="cs-help" data-cs="help">Drag the canvas to pan · scroll to zoom · drag a node’s ● to connect</div>' +
          '<div class="cs-canvas-controls">' +
            '<button class="ctrl-btn" data-cs="zoomout" title="Zoom out">−</button>' +
            '<button class="ctrl-btn zoom-label" data-cs="zoomlabel" title="Reset zoom">100%</button>' +
            '<button class="ctrl-btn" data-cs="zoomin" title="Zoom in">+</button>' +
            '<button class="ctrl-btn" data-cs="fit" title="Fit to screen">⤢</button>' +
            '<button class="ctrl-btn wide" data-cs="arrange" title="Tidy vertically">↕ Tidy</button>' +
          '</div>' +
        '</div>' +
      '</section>' +
      '<aside class="cs-col cs-inspector" data-cs="inspector">' +
        '<div class="insp-head">' +
          '<button class="insp-toggle" data-cs="inspToggle" title="Collapse panel" aria-label="Collapse panel">⟩</button>' +
          '<h4 class="cs-col-title insp-title">Campaign</h4>' +
        '</div>' +
        '<div class="insp-body" data-cs="inspBody">' +
          '<div class="insp-field"><label>Goal</label><textarea data-cs="goal" rows="2" placeholder="Book discovery calls with VP Eng at recently funded fintechs."></textarea></div>' +
          '<div class="insp-field"><label>Assigned to</label><select data-cs="assignee"></select></div>' +
          '<div class="insp-field"><label>Sending account</label><select data-cs="account"></select></div>' +
          '<div class="insp-row">' +
            '<div class="insp-field"><label>Daily cap</label><input data-cs="cap" type="number" min="1" value="25" title="Prospects per day" /></div>' +
            '<div class="insp-field"><label>Voice threshold</label><input data-cs="threshold" type="number" min="0" max="100" value="80" title="Warmth score that unlocks a voice note" /></div>' +
          '</div>' +
          '<div class="insp-node" data-cs="nodePanel" hidden>' +
            '<h4 class="cs-col-title" style="display:flex;align-items:center;gap:8px">Selected step' +
              '<button class="s-btn del" data-cs="nodeDel" title="Delete step" style="margin-left:auto">🗑</button></h4>' +
            '<div class="insp-node-title" data-cs="nodeTitle"></div>' +
            '<div data-cs="nodeConfig"></div>' +
          '</div>' +
          '<h4 class="cs-col-title" style="margin-top:8px">Sequence stats</h4>' +
          '<div class="insp-stats">' +
            '<div class="stat"><span>Outreach touches</span><b data-cs="stTouches">0</b></div>' +
            '<div class="stat"><span>Total steps</span><b data-cs="stSteps">0</b></div>' +
            '<div class="stat"><span>Channels used</span><b data-cs="stChannels">0</b></div>' +
            '<div class="stat"><span>Connections</span><b data-cs="stEdges">0</b></div>' +
            '<div class="stat"><span>Span (days of waits)</span><b data-cs="stDays">0</b></div>' +
          '</div>' +
          '<div class="mix-bar" data-cs="mixBar"></div><div class="mix-legend" data-cs="mixLegend"></div>' +
        '</div>' +
      '</aside>' +
    '</div>' +
    '<div class="cs-modal" data-cs="libModal"><div class="cs-modal-card">' +
      '<button class="modal-close" data-cs="libClose">×</button>' +
      '<h3>Campaign library</h3>' +
      '<p class="sub">Every campaign you save lives here, for both the Recruiting OS and the BD OS. Open one to keep editing, duplicate it as a starting point, or delete it.</p>' +
      '<div data-cs="libList"></div>' +
    '</div></div>' +
    '<div class="cs-modal" data-cs="addModal"><div class="cs-modal-card">' +
      '<button class="modal-close" data-cs="addClose">×</button>' +
      '<h3>Add a block</h3>' +
      '<p class="sub">Tap any block to drop it on the canvas. It lands next to the selected step, or in open space.</p>' +
      '<div data-cs="addList"></div>' +
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
    var viewport = $("viewport"), world = $("world"), svg = $("edges"), nodesHost = $("nodes");

    /* toast */
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
      dailyCap: 25, voiceThreshold: 80,
      nodes: [], edges: [], selected: null,
      view: { panX: 28, panY: 24, zoom: 1 },
    };

    function fillSelect(node, items, val) { node.innerHTML = ""; items.forEach(function (o) { var op = el("option", null, esc(o)); op.value = o; if (o === val) op.selected = true; node.appendChild(op); }); }
    fillSelect($("assignee"), assignees, state.assignee);
    fillSelect($("account"), accounts, state.account);

    function nodeById(u) { for (var i = 0; i < state.nodes.length; i++) if (state.nodes[i].uid === u) return state.nodes[i]; return null; }
    function nodeEl(u) { return nodesHost.querySelector('.cs-node[data-uid="' + u + '"]'); }
    function barColor(ch) { return { linkedin: "#7c5cff", email: "#4dd0ff", sms: "#38e0a6", voice: "#ffc24d", logic: "#ff7ac6" }[ch] || "#7c5cff"; }

    /* ---------- topological order (for touch numbering + legacy steps) ---------- */
    function orderNodes() {
      var indeg = {}, adj = {}, byId = {};
      state.nodes.forEach(function (n) { indeg[n.uid] = 0; adj[n.uid] = []; byId[n.uid] = n; });
      state.edges.forEach(function (e) { if (byId[e.from] && byId[e.to]) { adj[e.from].push(e.to); indeg[e.to]++; } });
      var q = [], out = [];
      state.nodes.forEach(function (n) { if (indeg[n.uid] === 0) q.push(n.uid); });
      while (q.length) { var u = q.shift(); out.push(byId[u]); adj[u].forEach(function (v) { if (--indeg[v] === 0) q.push(v); }); }
      if (out.length < state.nodes.length) state.nodes.forEach(function (n) { if (out.indexOf(n) < 0) out.push(n); });
      return out;
    }
    function touchNumbers() { var m = {}, n = 0; orderNodes().forEach(function (nd) { if (nd.key !== "lg_delay" && nd.channel !== "logic") { n++; m[nd.uid] = n; } }); return m; }

    /* ---------- transform / coordinates ---------- */
    function applyTransform() {
      var v = state.view;
      world.style.transform = "translate(" + v.panX + "px," + v.panY + "px) scale(" + v.zoom + ")";
      $("zoomlabel").textContent = Math.round(v.zoom * 100) + "%";
    }
    function screenToWorld(cx, cy) { var r = viewport.getBoundingClientRect(); return { x: (cx - r.left - state.view.panX) / state.view.zoom, y: (cy - r.top - state.view.panY) / state.view.zoom }; }
    function setZoom(z, cx, cy) {
      var r = viewport.getBoundingClientRect();
      if (cx == null) cx = r.width / 2; if (cy == null) cy = r.height / 2;
      var wx = (cx - state.view.panX) / state.view.zoom, wy = (cy - state.view.panY) / state.view.zoom;
      state.view.zoom = clamp(z, 0.4, 1.8);
      state.view.panX = cx - wx * state.view.zoom; state.view.panY = cy - wy * state.view.zoom;
      applyTransform();
    }
    function fit() {
      if (!state.nodes.length) { state.view = { panX: 28, panY: 24, zoom: 1 }; applyTransform(); return; }
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      state.nodes.forEach(function (n) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x + NODE_W); maxY = Math.max(maxY, n.y + 92); });
      var pad = 44, r = viewport.getBoundingClientRect();
      var cw = (maxX - minX) + pad * 2, ch = (maxY - minY) + pad * 2;
      var z = clamp(Math.min(r.width / cw, r.height / ch, 1.6), 0.4, 1.6);
      state.view.zoom = z;
      state.view.panX = r.width / 2 - ((minX + maxX) / 2) * z;
      state.view.panY = r.height / 2 - ((minY + maxY) / 2) * z;
      applyTransform();
    }
    function ensureVisible(n) {
      var r = viewport.getBoundingClientRect();
      var sx = n.x * state.view.zoom + state.view.panX, sy = n.y * state.view.zoom + state.view.panY;
      if (sx < 30 || sy < 30 || sx > r.width - 60 || sy > r.height - 60) {
        state.view.panX = r.width / 2 - (n.x + NODE_W / 2) * state.view.zoom;
        state.view.panY = r.height / 2 - (n.y + 40) * state.view.zoom;
        applyTransform();
      }
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
          item.title = "Drag onto the canvas, or click to add";
          item.setAttribute("role", "button"); item.setAttribute("tabindex", "0");
          item.innerHTML = '<span class="pb-grip" aria-hidden="true">⠿</span>' +
            '<span class="pb-ic ch-' + b.channel + '">' + b.ic + '</span>' +
            '<span class="pb-meta"><b>' + esc(b.label) + '</b><span>' + esc(b.desc) + '</span></span>' +
            '<span class="pb-add" aria-hidden="true">＋</span>';
          item.addEventListener("dragstart", function (e) { paletteDrag = b.key; item.classList.add("dragging"); e.dataTransfer.effectAllowed = "copy"; try { e.dataTransfer.setData("text/plain", b.key); } catch (x) {} });
          item.addEventListener("dragend", function () { item.classList.remove("dragging"); paletteDrag = null; });
          item.addEventListener("click", function () { addBlock(b.key); });
          item.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); addBlock(b.key); } });
          grp.appendChild(item);
        });
        wrap.appendChild(grp);
      });
    }

    /* ---------- node ops ---------- */
    function selectNode(u) { state.selected = u; renderNodes(); renderInspectorNode(); }
    function addNodeAt(key, x, y, fromUid) {
      var n = mkNode(key, {}, x, y);
      state.nodes.push(n);
      if (fromUid) state.edges.push({ id: uid("e"), from: fromUid, to: n.uid });
      state.selected = n.uid;
      renderNodes(); renderInspectorNode(); renderStats();
      return n;
    }
    function addBlock(key) {
      var x = 80, y = 40, from = null;
      if (state.selected) { var s = nodeById(state.selected); if (s) { x = s.x; y = s.y + ROW_H; from = s.uid; } }
      else if (state.nodes.length) { var last = orderNodes().slice(-1)[0]; if (last) { x = last.x; y = last.y + ROW_H; from = last.uid; } }
      var n = addNodeAt(key, x, y, from); ensureVisible(n); toast(BLOCK[key].label + " added");
    }
    function duplicateNode(n) { var c = JSON.parse(JSON.stringify(n)); c.uid = uid(); c.x = n.x + 36; c.y = n.y + 36; state.nodes.push(c); state.selected = c.uid; renderNodes(); renderInspectorNode(); renderStats(); toast("Step duplicated"); }
    function removeNode(u) {
      state.nodes = state.nodes.filter(function (n) { return n.uid !== u; });
      state.edges = state.edges.filter(function (e) { return e.from !== u && e.to !== u; });
      if (state.selected === u) state.selected = null;
      renderNodes(); renderInspectorNode(); renderStats(); toast("Step removed");
    }
    function addEdge(from, to) {
      if (from === to) return;
      var exists = state.edges.some(function (e) { return e.from === from && e.to === to; });
      if (exists) return;
      state.edges.push({ id: uid("e"), from: from, to: to });
      redrawEdges(); renderStats(); toast("Connected");
    }
    function removeEdge(id) { state.edges = state.edges.filter(function (e) { return e.id !== id; }); redrawEdges(); renderStats(); }

    function summarize(n) {
      var b = BLOCK[n.key];
      if (n.key === "lg_delay") return "Wait " + (n.delay || 0) + (n.delay === 1 ? " day" : " days");
      if (n.key === "lg_branch") return "If " + (n.cfg.condition || CONDITIONS[0]);
      if (n.key === "lg_assign") return "Assign to " + (n.cfg.assignee || state.assignee);
      if (n.cfg.subject) return n.cfg.subject;
      if (n.cfg.body) return n.cfg.body.slice(0, 52) + (n.cfg.body.length > 52 ? "..." : "");
      return b ? b.desc : "";
    }

    /* ---------- render nodes + edges ---------- */
    function renderNodes() {
      nodesHost.innerHTML = "";
      $("emptyfloat").hidden = state.nodes.length > 0;
      $("help").style.display = state.nodes.length ? "" : "none";
      var nums = touchNumbers();
      state.nodes.forEach(function (n) {
        var node = el("div", "cs-node ch-" + n.channel + (state.selected === n.uid ? " sel" : ""));
        node.dataset.uid = n.uid; node.style.left = n.x + "px"; node.style.top = n.y + "px";
        var numHtml = (n.key !== "lg_delay" && n.channel !== "logic") ? '<span class="node-num">#' + (nums[n.uid] || "") + "</span>" : "";
        node.innerHTML =
          '<span class="port port-in" title="Input"></span>' +
          '<div class="node-bar"></div>' +
          '<div class="node-head">' +
            '<span class="s-ic ch-' + n.channel + '">' + n.ic + '</span>' +
            '<div class="node-meta"><b>' + esc(n.label) + '</b><span class="node-sub">' + esc(summarize(n)) + '</span></div>' +
            numHtml +
          '</div>' +
          '<div class="node-tools"><button class="s-btn dup" title="Duplicate">⧉</button><button class="s-btn del" title="Delete">🗑</button></div>' +
          '<span class="port port-out" title="Drag to connect"></span>';
        node.querySelector(".node-bar").style.background = barColor(n.channel);
        node.querySelector(".dup").addEventListener("pointerdown", function (e) { e.stopPropagation(); });
        node.querySelector(".dup").addEventListener("click", function (e) { e.stopPropagation(); duplicateNode(n); });
        node.querySelector(".del").addEventListener("pointerdown", function (e) { e.stopPropagation(); });
        node.querySelector(".del").addEventListener("click", function (e) { e.stopPropagation(); removeNode(n.uid); });
        nodesHost.appendChild(node);
      });
      redrawEdges();
    }

    function edgePath(x1, y1, x2, y2) { var dy = Math.max(26, Math.abs(y2 - y1) * 0.4); return "M " + x1 + " " + y1 + " C " + x1 + " " + (y1 + dy) + " " + x2 + " " + (y2 - dy) + " " + x2 + " " + y2; }
    function redrawEdges() {
      svg.innerHTML = '<defs><marker id="csArrow" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#9b86ff"/></marker></defs>';
      state.edges.forEach(function (edge) {
        var a = nodeEl(edge.from), b = nodeEl(edge.to); if (!a || !b) return;
        var x1 = a.offsetLeft + a.offsetWidth / 2, y1 = a.offsetTop + a.offsetHeight;
        var x2 = b.offsetLeft + b.offsetWidth / 2, y2 = b.offsetTop;
        var d = edgePath(x1, y1, x2, y2);
        var hit = document.createElementNS(SVGNS, "path"); hit.setAttribute("d", d); hit.setAttribute("class", "edge-hit"); hit.addEventListener("click", function () { removeEdge(edge.id); toast("Connection removed"); });
        var p = document.createElementNS(SVGNS, "path"); p.setAttribute("d", d); p.setAttribute("class", "edge-path"); p.setAttribute("marker-end", "url(#csArrow)");
        svg.appendChild(p); svg.appendChild(hit);
      });
    }

    /* ---------- pointer interactions: pan / move / connect ---------- */
    var pdrag = null, tempPath = null, paletteDrag = null;
    viewport.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      // Let the on-canvas controls (zoom / fit / tidy) and empty-state button
      // handle their own clicks; don't start a pan or capture the pointer.
      if (e.target.closest && e.target.closest(".cs-canvas-controls, .cs-empty-float")) return;
      var portOut = e.target.closest && e.target.closest(".port-out");
      var nodeEl0 = e.target.closest && e.target.closest(".cs-node");
      if (portOut && nodeEl0) {
        pdrag = { mode: "connect", from: nodeEl0.dataset.uid };
        tempPath = document.createElementNS(SVGNS, "path"); tempPath.setAttribute("class", "edge-path temp"); svg.appendChild(tempPath);
        viewport.setPointerCapture(e.pointerId); e.preventDefault(); return;
      }
      if (nodeEl0 && !(e.target.closest(".node-tools"))) {
        var n = nodeById(nodeEl0.dataset.uid);
        selectNode(n.uid);
        pdrag = { mode: "node", uid: n.uid, sx: n.x, sy: n.y, px: e.clientX, py: e.clientY, moved: false };
        nodeEl0.classList.add("dragging");
        viewport.setPointerCapture(e.pointerId); e.preventDefault(); return;
      }
      // background -> pan (and deselect)
      pdrag = { mode: "pan", px: e.clientX, py: e.clientY, panX: state.view.panX, panY: state.view.panY, moved: false };
      viewport.classList.add("panning"); viewport.setPointerCapture(e.pointerId);
    });
    viewport.addEventListener("pointermove", function (e) {
      if (!pdrag) return;
      if (pdrag.mode === "pan") { state.view.panX = pdrag.panX + (e.clientX - pdrag.px); state.view.panY = pdrag.panY + (e.clientY - pdrag.py); if (Math.abs(e.clientX - pdrag.px) + Math.abs(e.clientY - pdrag.py) > 3) pdrag.moved = true; applyTransform(); return; }
      if (pdrag.mode === "node") {
        var n = nodeById(pdrag.uid); if (!n) return;
        n.x = Math.round(pdrag.sx + (e.clientX - pdrag.px) / state.view.zoom);
        n.y = Math.round(pdrag.sy + (e.clientY - pdrag.py) / state.view.zoom);
        var eln = nodeEl(n.uid); if (eln) { eln.style.left = n.x + "px"; eln.style.top = n.y + "px"; }
        pdrag.moved = true; redrawEdges(); return;
      }
      if (pdrag.mode === "connect") {
        var a = nodeEl(pdrag.from); if (!a) return;
        var x1 = a.offsetLeft + a.offsetWidth / 2, y1 = a.offsetTop + a.offsetHeight;
        var w = screenToWorld(e.clientX, e.clientY);
        tempPath.setAttribute("d", edgePath(x1, y1, w.x, w.y));
      }
    });
    function endPointer(e) {
      if (!pdrag) return;
      if (pdrag.mode === "connect") {
        var over = document.elementFromPoint(e.clientX, e.clientY);
        var target = over && over.closest && over.closest(".cs-node");
        if (target && target.dataset.uid !== pdrag.from) addEdge(pdrag.from, target.dataset.uid);
        if (tempPath) { tempPath.remove(); tempPath = null; }
      }
      if (pdrag.mode === "node") { var eln = nodeEl(pdrag.uid); if (eln) eln.classList.remove("dragging"); }
      if (pdrag.mode === "pan" && !pdrag.moved) { if (state.selected) { state.selected = null; renderNodes(); renderInspectorNode(); } }
      viewport.classList.remove("panning");
      try { viewport.releasePointerCapture(e.pointerId); } catch (x) {}
      pdrag = null;
    }
    viewport.addEventListener("pointerup", endPointer);
    viewport.addEventListener("pointercancel", endPointer);

    // wheel zoom (toward cursor)
    viewport.addEventListener("wheel", function (e) {
      e.preventDefault();
      var r = viewport.getBoundingClientRect();
      setZoom(state.view.zoom * (e.deltaY < 0 ? 1.12 : 0.89), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    // palette drag -> drop on canvas at the drop point
    viewport.addEventListener("dragover", function (e) { if (paletteDrag) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; viewport.classList.add("drop-hot"); } });
    viewport.addEventListener("dragleave", function (e) { if (e.target === viewport) viewport.classList.remove("drop-hot"); });
    viewport.addEventListener("drop", function (e) {
      viewport.classList.remove("drop-hot");
      var key = paletteDrag || (e.dataTransfer && e.dataTransfer.getData("text/plain")); if (!key || !BLOCK[key]) return;
      e.preventDefault();
      var w = screenToWorld(e.clientX, e.clientY);
      var n = addNodeAt(key, Math.round(w.x - NODE_W / 2), Math.round(w.y - 30), null);
      toast(BLOCK[key].label + " added");
    });

    /* ---------- canvas controls ---------- */
    $("zoomin").addEventListener("click", function () { setZoom(state.view.zoom * 1.15); });
    $("zoomout").addEventListener("click", function () { setZoom(state.view.zoom * 0.87); });
    $("zoomlabel").addEventListener("click", function () { setZoom(1); });
    $("fit").addEventListener("click", fit);
    $("arrange").addEventListener("click", function () {
      var order = orderNodes();
      order.forEach(function (n, i) { n.x = 80; n.y = 36 + i * ROW_H; });
      renderNodes(); fit(); toast("Tidied vertically");
    });
    $("full").addEventListener("click", toggleFull);
    function toggleFull() {
      var on = root.classList.toggle("cs-full");
      $("full").innerHTML = on ? "⤡ Exit full screen" : "⛶ Full screen";
      setTimeout(fit, 60);
    }

    /* ---------- collapsing / expanding a side panel reframes the canvas ----
       Toggling a rail changes the room the canvas has, so we re-fit: pull every
       step into view and zoom to fill the freed space. Runs after the column
       transition (180ms) settles so the measurement is the final width. */
    function refit() { setTimeout(fit, 230); }
    function setInspector(collapsed, silent) {
      $("grid").classList.toggle("insp-collapsed", collapsed);
      var btn = $("inspToggle");
      btn.innerHTML = collapsed ? "⟨" : "⟩";
      btn.title = collapsed ? "Expand panel" : "Collapse panel";
      try { localStorage.setItem("cs_insp_collapsed", collapsed ? "1" : "0"); } catch (e) {}
      if (!silent) refit();
    }
    $("inspToggle").addEventListener("click", function () {
      setInspector(!$("grid").classList.contains("insp-collapsed"));
    });
    function setPalette(collapsed, silent) {
      $("grid").classList.toggle("pal-collapsed", collapsed);
      var btn = $("palToggle");
      btn.innerHTML = collapsed ? "⟩" : "⟨";
      btn.title = collapsed ? "Expand panel" : "Collapse panel";
      try { localStorage.setItem("cs_pal_collapsed", collapsed ? "1" : "0"); } catch (e) {}
      if (!silent) refit();
    }
    $("palToggle").addEventListener("click", function () {
      setPalette(!$("grid").classList.contains("pal-collapsed"));
    });
    // Restore saved collapse state silently; the initial fit() owns the baseline zoom.
    var inspStart = false, palStart = false;
    try { inspStart = localStorage.getItem("cs_insp_collapsed") === "1"; } catch (e) {}
    try { palStart = localStorage.getItem("cs_pal_collapsed") === "1"; } catch (e) {}
    if (inspStart) setInspector(true, true);
    if (palStart) setPalette(true, true);

    /* ---------- inspector: selected node config ---------- */
    function renderInspectorNode() {
      var panel = $("nodePanel");
      if (!state.selected) { panel.hidden = true; return; }
      var n = nodeById(state.selected); if (!n) { panel.hidden = true; return; }
      panel.hidden = false;
      $("nodeTitle").innerHTML = '<span class="s-ic ch-' + n.channel + '" style="width:26px;height:26px;font-size:14px">' + n.ic + '</span> ' + esc(n.label);
      renderConfig($("nodeConfig"), n);
    }
    $("nodeDel").addEventListener("click", function () { if (state.selected) removeNode(state.selected); });

    function renderConfig(host, step) {
      host.innerHTML = "";
      var b = BLOCK[step.key]; var cfg = b.cfg || [];
      cfg.forEach(function (f) {
        if (f === "delayOnly") { host.appendChild(numField("Wait (days)", step.delay || 0, function (v) { step.delay = Math.max(0, v); refreshSub(step); })); host.appendChild(hint("Pause the sequence before the next connected step.")); return; }
        if (f === "withNote") { host.appendChild(toggleField("Include a note", !!step.cfg.withNote, function (on) { step.cfg.withNote = on; renderConfig(host, step); })); return; }
        if (f === "condition") { host.appendChild(selectField("Condition", CONDITIONS, step.cfg.condition || CONDITIONS[0], function (v) { step.cfg.condition = v; refreshSub(step); })); host.appendChild(hint("Wire the true path and the false path to different next steps.")); return; }
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
      if (b.testSend) host.appendChild(testSendPanel(step));
      if (!cfg.length && step.key.indexOf("lg_") !== 0) host.appendChild(hint("No configuration needed. This is an automated touch."));
      if (step.key === "lg_enrich") host.appendChild(hint("Runs the cheapest-first enrichment waterfall (Fresh LinkedIn + Tomba) to resolve email/phone before the next channel."));
      if (step.key === "lg_goal") host.appendChild(hint("When the prospect reaches this point, the sequence exits and is marked a win."));
    }
    function refreshSub(step) { var eln = nodeEl(step.uid); if (eln) eln.querySelector(".node-sub").textContent = summarize(step); renderStats(); }

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
      var nodes = state.nodes;
      var touches = nodes.filter(function (n) { return n.channel !== "logic"; }).length;
      var days = 0; nodes.forEach(function (n) { if (n.key === "lg_delay") days += (n.delay || 0); });
      var byCh = {}; nodes.forEach(function (n) { if (n.channel === "logic") return; byCh[n.channel] = (byCh[n.channel] || 0) + 1; });
      $("stTouches").textContent = touches; $("stSteps").textContent = nodes.length; $("stDays").textContent = days;
      $("stChannels").textContent = Object.keys(byCh).length; $("stEdges").textContent = state.edges.length;
      var order = ["linkedin", "email", "sms", "voice"];
      var total = order.reduce(function (a, c) { return a + (byCh[c] || 0); }, 0);
      var bar = $("mixBar"); bar.innerHTML = ""; var legend = $("mixLegend"); legend.innerHTML = "";
      var names = { linkedin: "LinkedIn", email: "Email", sms: "SMS", voice: "Voice" };
      order.forEach(function (c) { var n = byCh[c] || 0; if (!n) return; var seg = el("span"); seg.style.width = (total ? (n / total * 100) : 0) + "%"; seg.style.background = barColor(c); bar.appendChild(seg); legend.appendChild(el("span", null, '<i style="background:' + barColor(c) + '"></i>' + names[c] + " " + n)); });
      if (!total) legend.innerHTML = '<span style="color:var(--text-dim)">No outreach touches yet</span>';
    }

    /* ---------- meta sync ---------- */
    function syncMeta() {
      $("name").value = state.name; $("goal").value = state.goal;
      $("assignee").value = state.assignee; $("account").value = state.account;
      $("cap").value = state.dailyCap; $("threshold").value = state.voiceThreshold;
      var sp = $("status"); sp.textContent = state.status; sp.className = "cs-status-pill " + state.status;
      if (!opts.embedded) Array.prototype.forEach.call(root.querySelectorAll(".cs-motion .mt"), function (b) { b.classList.toggle("active", b.dataset.motion === state.motion); });
      renderStats();
    }

    /* ---------- snapshot / persistence ---------- */
    function snapshot() {
      return {
        id: state.id || uid("camp"), name: state.name, goal: state.goal, motion: state.motion,
        status: state.status, assignee: state.assignee, account: state.account,
        dailyCap: state.dailyCap, voiceThreshold: state.voiceThreshold,
        nodes: state.nodes.map(function (n) { return { uid: n.uid, key: n.key, channel: n.channel, label: n.label, ic: n.ic, cfg: n.cfg, delay: n.delay, x: n.x, y: n.y }; }),
        edges: state.edges.map(function (e) { return { id: e.id, from: e.from, to: e.to, label: e.label }; }),
        view: { panX: state.view.panX, panY: state.view.panY, zoom: state.view.zoom },
        // derived linear order, so legacy views/stats that read `steps` still work
        steps: orderNodes().map(function (n) { return { uid: n.uid, key: n.key, channel: n.channel, label: n.label, ic: n.ic, cfg: n.cfg, delay: n.delay }; }),
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
      state.id = c.id; state.name = c.name; state.goal = c.goal || ""; state.motion = c.motion === "bd" ? "bd" : "recruiting";
      state.status = c.status || "draft"; state.assignee = c.assignee || assignees[0]; state.account = c.account || c.senderAccount || accounts[0];
      state.dailyCap = c.dailyCap || 25; state.voiceThreshold = c.voiceThreshold || c.voiceNoteThreshold || 80;
      if (c.nodes && c.nodes.length) {
        state.nodes = c.nodes.map(function (n) { return { uid: n.uid || uid(), key: n.key, channel: n.channel, label: n.label || (BLOCK[n.key] && BLOCK[n.key].label), ic: n.ic || (BLOCK[n.key] && BLOCK[n.key].ic), cfg: n.cfg || {}, delay: n.delay || 0, x: n.x || 80, y: n.y || 40 }; });
        state.edges = (c.edges || []).map(function (e) { return { id: e.id || uid("e"), from: e.from, to: e.to, label: e.label }; });
      } else if (c.steps && c.steps.length) {
        // migrate an older linear sequence onto the canvas
        state.nodes = c.steps.map(function (s, i) { return { uid: s.uid || uid(), key: s.key, channel: s.channel, label: s.label, ic: s.ic, cfg: s.cfg || {}, delay: s.delay || 0, x: 80, y: 36 + i * ROW_H }; });
        state.edges = [];
        for (var i = 1; i < state.nodes.length; i++) state.edges.push({ id: uid("e"), from: state.nodes[i - 1].uid, to: state.nodes[i].uid });
      } else { state.nodes = []; state.edges = []; }
      state.view = c.view || { panX: 28, panY: 24, zoom: 1 };
      state.selected = null;
      fillSelect($("assignee"), assignees, state.assignee);
      fillSelect($("account"), accounts, state.account);
      syncMeta(); renderPalette(); renderNodes(); renderInspectorNode(); applyTransform();
    }

    /* ---------- library ---------- */
    function relTime(iso) { if (!iso) return "just now"; var d = (Date.now() - new Date(iso).getTime()) / 1000; if (d < 60) return "just now"; if (d < 3600) return Math.floor(d / 60) + "m ago"; if (d < 86400) return Math.floor(d / 3600) + "h ago"; return Math.floor(d / 86400) + "d ago"; }
    function openLibrary() {
      var list = store.all(); var host = $("libList"); host.innerHTML = "";
      if (!list.length) host.innerHTML = '<div class="cs-empty"><div class="big">📚</div><b>No saved campaigns yet</b><p style="font-size:13px;margin-top:6px">Build a sequence and hit Save to store it here.</p></div>';
      list.forEach(function (c) {
        var touches = (c.nodes || c.steps || []).filter(function (s) { return s.key !== "lg_delay" && s.channel !== "logic"; }).length;
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

    /* ---------- add-block picker (universal / mobile path) ---------- */
    function openAddBlock() {
      var host = $("addList"); host.innerHTML = "";
      CATALOG.forEach(function (g) {
        var grp = el("div", "pal-group");
        grp.appendChild(el("h5", null, '<span class="gd ch-' + g.channel + '"></span>' + esc(g.group)));
        var wrap = el("div", "add-grid");
        g.blocks.forEach(function (b) {
          var item = el("button", "pal-block"); item.type = "button";
          item.innerHTML = '<span class="pb-ic ch-' + b.channel + '">' + b.ic + '</span>' +
            '<span class="pb-meta"><b>' + esc(b.label) + '</b><span>' + esc(b.desc) + '</span></span><span class="pb-add">＋</span>';
          item.addEventListener("click", function () { addBlock(b.key); closeAddBlock(); });
          wrap.appendChild(item);
        });
        grp.appendChild(wrap); host.appendChild(grp);
      });
      $("addModal").classList.add("show");
    }
    function closeAddBlock() { $("addModal").classList.remove("show"); }

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
      if (state.nodes.length && !confirm("Start a new campaign? Unsaved changes will be lost.")) return;
      state.id = null; state.name = "Untitled campaign"; state.goal = ""; state.status = "draft"; state.nodes = []; state.edges = []; state.selected = null;
      state.view = { panX: 28, panY: 24, zoom: 1 };
      syncMeta(); renderNodes(); renderInspectorNode(); renderPalette(); applyTransform();
    });
    $("library").addEventListener("click", openLibrary);
    $("libClose").addEventListener("click", closeLibrary);
    $("libModal").addEventListener("click", function (e) { if (e.target === $("libModal")) closeLibrary(); });
    $("addblock").addEventListener("click", openAddBlock);
    $("addClose").addEventListener("click", closeAddBlock);
    $("addModal").addEventListener("click", function (e) { if (e.target === $("addModal")) closeAddBlock(); });
    $("loadStarter").addEventListener("click", function () { var s = starter(state.motion); state.nodes = s.nodes; state.edges = s.edges; state.selected = null; renderNodes(); renderInspectorNode(); renderStats(); fit(); toast("Loaded " + (state.motion === "bd" ? "BD" : "Recruiting") + " starter"); });
    $("launch").addEventListener("click", function () {
      if (!state.nodes.filter(function (n) { return n.channel !== "logic"; }).length) { toast("Add at least one outreach touch first"); return; }
      state.status = state.status === "active" ? "paused" : "active"; save(true); syncMeta();
      toast(state.status === "active" ? "Campaign activated 🚀" : "Campaign paused");
    });

    function onKey(e) {
      if (root.isConnected === false) { document.removeEventListener("keydown", onKey); return; }
      if (!root.querySelector(".cs-toolbar")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
      if (e.key === "Escape") { if (root.classList.contains("cs-full")) toggleFull(); closeLibrary(); closeAddBlock(); }
      if ((e.key === "Delete" || e.key === "Backspace") && state.selected && document.activeElement === document.body) { e.preventDefault(); removeNode(state.selected); }
    }
    document.addEventListener("keydown", onKey);

    /* ---------- initial load ---------- */
    var openId = opts.openId;
    if (openId) { var found = store.all().filter(function (c) { return c.id === openId; })[0]; if (found) { loadCampaign(found); setTimeout(fit, 40); return controller(); } }
    var s0 = starter(state.motion); state.nodes = s0.nodes; state.edges = s0.edges;
    syncMeta(); renderPalette(); renderNodes(); renderInspectorNode(); applyTransform(); setTimeout(fit, 40);

    function controller() {
      return {
        load: loadCampaign,
        newCampaign: function (motion) { var s = starter(motion || state.motion); state.id = null; state.name = "Untitled campaign"; state.goal = ""; state.status = "draft"; state.nodes = s.nodes; state.edges = s.edges; state.motion = motion || state.motion; state.selected = null; syncMeta(); renderNodes(); renderInspectorNode(); renderPalette(); fit(); },
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
    if (!root) return;
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
