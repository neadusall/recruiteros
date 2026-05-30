/* RecruiterOS · Command Center
 *
 * One screen that ties the whole GTM engine together: Overview, Response,
 * Prospects, Campaigns, Outreach, Content, Accounts, Connected, ATS.
 *
 * It calls the integration backend at /api/* when reachable, and renders from a
 * rich local seed otherwise, so it is fully alive on the static site. Routing is
 * hash-based (#response, #overview, ...) to mirror the reference app.
 */
(function () {
  "use strict";

  /* ---------------- auth gate ---------------- */
  var ctx = null;
  try { ctx = JSON.parse(localStorage.getItem("ros_ctx") || "null"); } catch (e) {}
  if (!ctx) { location.replace("login.html"); return; }
  var LIVE = !ctx.demo && !!(window.RECRUITEROS_API_BASE);
  var API = (window.RECRUITEROS_API_BASE || "") + "/api";
  var motion = localStorage.getItem("ros_motion") || "recruiting";

  // RBAC: live sessions carry a capabilities array; the static demo has none, so
  // we treat demo as full-access (owner) to keep it explorable. Recruiters
  // (members) on a live backend only see what their role allows.
  var CAPS = Array.isArray(ctx.capabilities) ? ctx.capabilities : null;
  function can(cap) { return CAPS === null ? true : CAPS.indexOf(cap) >= 0; }

  /* ---------------- tiny dom helpers ---------------- */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var view = $("#view");
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function toast(t) { var el = $("#toast"); el.textContent = t; el.classList.add("show"); setTimeout(function () { el.classList.remove("show"); }, 2200); }
  function api(path) { return fetch(API + path, { credentials: "include" }).then(function (r) { if (!r.ok) throw 0; return r.json(); }); }

  /* ---------------- seed (mirrors the backend constants/rules) ---------------- */
  var SEED = seed();

  /* ---------------- chrome ---------------- */
  $("#wsName").textContent = (ctx.workspace && ctx.workspace.name) || "Workspace";
  $("#wsPlan").textContent = (ctx.workspace && ctx.workspace.plan) || "trial";
  $("#userName").textContent = (ctx.user && ctx.user.name) || "You";
  $("#userInitials").textContent = initials((ctx.user && ctx.user.name) || "You");
  var envPill = $("#envPill");
  envPill.textContent = LIVE ? "live" : "demo";
  envPill.classList.toggle("live", LIVE);
  $("#signOut").addEventListener("click", function () {
    if (LIVE) fetch(API + "/auth/session", { method: "DELETE", credentials: "include" });
    localStorage.removeItem("ros_ctx"); localStorage.removeItem("ros_session");
    location.href = "login.html";
  });

  // motion toggle
  Array.prototype.forEach.call(document.querySelectorAll(".mt"), function (b) {
    b.classList.toggle("active", b.dataset.motion === motion);
    b.addEventListener("click", function () {
      motion = b.dataset.motion; localStorage.setItem("ros_motion", motion);
      Array.prototype.forEach.call(document.querySelectorAll(".mt"), function (x) { x.classList.toggle("active", x === b); });
      render();
    });
  });

  // response badge (count of hot, unreviewed)
  var hot = SEED.responses.filter(function (r) { return r.cls === "positive" || r.cls === "referral"; }).length;
  if (hot) { var bd = $("#badgeResponse"); bd.textContent = hot; bd.classList.add("show"); }

  // RBAC: hide nav items + group labels the current role can't use.
  Array.prototype.forEach.call(document.querySelectorAll("[data-cap]"), function (el) {
    if (!can(el.getAttribute("data-cap"))) el.style.display = "none";
  });
  // Show the role on the workspace card.
  if (ctx.role) { var wp = $("#wsPlan"); if (wp) wp.textContent = (ctx.workspace && ctx.workspace.plan ? ctx.workspace.plan + " · " : "") + ctx.role; }

  /* ---------------- router ---------------- */
  var ROUTES = {
    overview: { title: "Overview", crumb: "Operate", action: null, render: renderOverview },
    response: { title: "Response", crumb: "Operate", action: null, render: renderResponse },
    prospects: { title: "Prospects", crumb: "Operate", action: "＋ Add prospect", render: renderProspects },
    campaigns: { title: "Campaigns", crumb: "Build", action: "＋ New campaign", render: renderCampaigns },
    outreach: { title: "Outreach", crumb: "Build", action: null, render: renderOutreach },
    content: { title: "Content Library", crumb: "Build", action: "＋ Add asset", render: renderContent },
    accounts: { title: "Accounts", crumb: "Connect", action: null, render: renderAccounts, cap: "accounts:manage" },
    connected: { title: "Connected", crumb: "Connect", action: "Test all", render: renderConnected, cap: "integrations:manage" },
    ats: { title: "ATS", crumb: "Connect", action: null, render: renderAts, cap: "ats:manage" },
    team: { title: "Team", crumb: "Admin", action: "＋ Invite recruiter", render: renderTeam, cap: "team:manage" }
  };

  function currentRoute() {
    var h = (location.hash || "#overview").replace(/^#/, "");
    // support reference-style "#bd/response" -> set motion + route
    var parts = h.split("/");
    if (parts[0] === "bd" || parts[0] === "recruiting") { motion = parts[0]; localStorage.setItem("ros_motion", motion); h = parts[1] || "overview"; }
    else h = parts[0];
    if (!ROUTES[h]) return "overview";
    if (ROUTES[h].cap && !can(ROUTES[h].cap)) return "overview"; // recruiter hit a gated route
    return h;
  }

  function render() {
    var key = currentRoute();
    var r = ROUTES[key];
    $("#pageTitle").textContent = r.title;
    $("#crumb").textContent = (ctx.workspace ? ctx.workspace.name + " / " : "") + r.crumb;
    Array.prototype.forEach.call(document.querySelectorAll(".nav-item"), function (n) { n.classList.toggle("active", n.dataset.route === key); });
    var pa = $("#primaryAction");
    if (r.action) { pa.style.display = ""; pa.textContent = r.action; pa.onclick = function () { primaryAction(key); }; }
    else pa.style.display = "none";
    Array.prototype.forEach.call(document.querySelectorAll(".mt"), function (x) { x.classList.toggle("active", x.dataset.motion === motion); });
    view.innerHTML = "";
    r.render(view);
  }

  window.addEventListener("hashchange", render);
  Array.prototype.forEach.call(document.querySelectorAll(".nav-item"), function (n) {
    n.setAttribute("href", "#" + n.dataset.route);
  });

  /* ---------------- views ---------------- */

  function head(title, sub) {
    return '<div class="v-head"><h2>' + esc(title) + "</h2>" + (sub ? "<p>" + esc(sub) + "</p>" : "") + "</div>";
  }

  function renderOverview(el) {
    var o = SEED.overview;
    var stats = o.capacity.map(function (c) {
      return '<div class="stat"><span class="rag ' + c.status + '"></span><div class="sv">' + c.value + '</div><div class="sl">' + esc(c.label) + "</div></div>";
    }).join("");
    var kpis = [
      ["Active prospects", o.activeProspects], ["Appointments today", o.appointmentsToday],
      ["This week", o.appointmentsThisWeek], ["Warm convos today", o.warmConversationsToday],
      [motion === "bd" ? "Won accounts" : "Placements", o.wonAccounts]
    ].map(function (k) { return '<div class="stat"><div class="sv">' + k[1] + '</div><div class="sl">' + k[0] + "</div></div>"; }).join("");

    var appts = o.recentAppointments.map(function (a) {
      return '<div class="list-row"><div><div class="lr-main">' + esc(a.name) + '</div><div class="lr-sub">' + esc(a.channel || "") + "</div></div><div class=\"lr-right\">" + esc(a.at || "") + "</div></div>";
    }).join("") || '<div class="empty">No appointments yet.</div>';

    var drips = o.activeDrips.map(function (d) {
      return '<div class="list-row"><div class="lr-main">' + esc(d.name) + '</div><div class="lr-right">' + esc(d.stage) + "</div></div>";
    }).join("") || '<div class="empty">No active drips.</div>';

    el.innerHTML = head("Overview", "Real-time capacity and pipeline health for " + (ctx.workspace ? ctx.workspace.name : "your workspace") + ".") +
      '<div class="stat-grid" style="margin-bottom:14px">' + stats + "</div>" +
      '<div class="stat-grid" style="margin-bottom:18px">' + kpis + "</div>" +
      '<div class="two-col"><div class="card"><h3>Recent appointments</h3>' + appts + "</div>" +
      '<div class="card"><h3>Active drips</h3>' + drips + "</div></div>" +
      '<div class="card" style="margin-top:16px"><h3>Daily cadence</h3>' + cadenceHtml() + "</div>";
  }

  function renderResponse(el) {
    var active = "all";
    el.innerHTML = head("Response, the unified inbox",
      "Every reply across email, LinkedIn and SMS, auto-classified by AI and routed by deterministic rules. Hottest first.");
    var filter = document.createElement("div");
    filter.className = "chan-filter";
    ["all", "email", "linkedin", "sms"].forEach(function (c) {
      filter.innerHTML += '<span class="cf ' + (c === "all" ? "active" : "") + '" data-c="' + c + '">' + (c === "all" ? "All channels" : c.toUpperCase()) + "</span>";
    });
    el.appendChild(filter);
    var listWrap = document.createElement("div");
    el.appendChild(listWrap);

    function paint() {
      var items = SEED.responses.filter(function (r) { return active === "all" || r.channel === active; });
      listWrap.innerHTML = items.map(respItem).join("") || '<div class="empty">Inbox is clear.</div>';
    }
    filter.addEventListener("click", function (e) {
      var cf = e.target.closest(".cf"); if (!cf) return;
      active = cf.dataset.c;
      Array.prototype.forEach.call(filter.children, function (x) { x.classList.toggle("active", x === cf); });
      paint();
    });
    paint();

    // rules matrix
    var rows = SEED.rules.map(function (r) {
      return "<tr><td><span class=\"cls cls-" + r.cls + "\">" + esc(r.label) + "</span></td>" +
        "<td>" + r.triggers.map(esc).join(", ") + "</td>" +
        '<td class="acts">' + r.actions.map(esc).join(" → ") + "</td>" +
        '<td><span class="sla">' + esc(r.sla) + "</span></td></tr>";
    }).join("");
    var matrix = document.createElement("div");
    matrix.className = "card";
    matrix.style.marginTop = "18px";
    matrix.innerHTML = "<h3>Classification &amp; routing rules</h3><div style=\"overflow:auto\"><table class=\"matrix\"><thead><tr><th>Class</th><th>Triggers</th><th>System action</th><th>SLA</th></tr></thead><tbody>" + rows + "</tbody></table></div>";
    el.appendChild(matrix);

    if (LIVE) api("/response/list").then(function (d) {
      if (d.items && d.items.length) { SEED.responses = d.items.map(mapProcessed); paint(); }
    }).catch(function () {});
  }

  function respItem(r) {
    return '<div class="resp-item"><div class="resp-top">' +
      '<span class="avatar" style="background:' + colorFor(r.name) + '">' + esc(initials(r.name)) + "</span>" +
      '<div><div class="resp-name">' + esc(r.name) + '</div><div class="resp-chan">' + esc(r.channel) + " · " + esc(r.source) + "</div></div>" +
      '<span class="cls cls-' + r.cls + '">' + esc(clsLabel(r.cls)) + "</span></div>" +
      '<div class="resp-text">"' + esc(r.text) + '"</div>' +
      '<div class="resp-actions">' + r.actions.map(function (a) { return '<span class="resp-act">' + esc(a) + "</span>"; }).join("") + "</div></div>";
  }

  function renderProspects(el) {
    var counts = SEED.prospects.reduce(function (m, p) { m[p.status] = (m[p.status] || 0) + 1; return m; }, {});
    var stages = SEED.lifecycle.map(function (l) {
      return '<div class="stage"><b>' + (counts[l.status] || 0) + "</b><span>" + esc(l[motion]) + "</span></div>";
    }).join("");
    var rows = SEED.prospects.map(function (p) {
      return '<div class="list-row"><span class="avatar" style="width:28px;height:28px;font-size:11px;background:' + colorFor(p.fullName) + '">' + esc(initials(p.fullName)) + "</span>" +
        '<div><div class="lr-main">' + esc(p.fullName) + '</div><div class="lr-sub">' + esc((p.title || "") + (p.company ? " · " + p.company : "")) + "</div></div>" +
        '<span class="cls cls-' + statusCls(p.status) + '" style="margin-left:auto">' + esc(statusLabel(p.status)) + "</span>" +
        '<div class="lr-right">' + (p.dripStage ? "Touch " + p.dripStage : "") + "</div></div>";
    }).join("");
    el.innerHTML = head("Prospects", "Your live pipeline, synced bidirectionally with the ATS.") +
      '<div class="pipe">' + stages + "</div>" +
      '<div class="card"><h3>Pipeline</h3>' + (rows || '<div class="empty">No prospects yet.</div>') + "</div>";
  }

  function renderCampaigns(el) {
    // Campaigns saved from the drag-and-drop Campaign Studio (localStorage), newest first.
    var saved = [];
    try { saved = JSON.parse(localStorage.getItem("ros_campaigns") || "[]"); } catch (e) {}
    var savedRows = saved.filter(function (c) { return c.motion === motion; }).map(function (c) {
      var pill = c.status === "active" ? "live" : "draft";
      var touches = (c.steps || []).filter(function (s) { return s.key !== "lg_delay"; }).length;
      var chans = {};
      (c.steps || []).forEach(function (s) { if (s.channel && s.channel !== "logic") chans[s.channel] = 1; });
      var chList = Object.keys(chans).map(function (x) { return x.replace("linkedin", "LinkedIn").replace("email", "Email").replace("sms", "SMS").replace("voice", "Voice"); });
      return '<div class="card" style="margin-bottom:12px;cursor:pointer" data-open="' + esc(c.id) + '"><div style="display:flex;align-items:center;gap:10px">' +
        '<span class="ni">🧩</span><b style="font-size:15px">' + esc(c.name) + "</b>" +
        '<span class="status-pill ' + pill + '">' + esc(c.status) + "</span>" +
        '<span class="lr-right" style="margin-left:auto">cap ' + (c.dailyCap || 25) + "/day</span></div>" +
        '<div class="muted" style="font-size:13px;margin:6px 0 10px">' + esc(c.goal || "No goal set yet.") + "</div>" +
        '<div class="muted" style="font-size:12.5px">' + touches + " touches across " + (chList.join(", ") || "no channels yet") + " · Studio sequence</div></div>";
    }).join("");

    var seedRows = SEED.campaigns.filter(function (c) { return c.motion === motion; }).map(function (c) {
      var pill = c.status === "active" ? "live" : "draft";
      return '<div class="card" style="margin-bottom:12px"><div style="display:flex;align-items:center;gap:10px">' +
        '<b style="font-size:15px">' + esc(c.name) + "</b>" +
        '<span class="status-pill ' + pill + '">' + c.status + "</span>" +
        '<span class="lr-right" style="margin-left:auto">cap ' + c.dailyCap + "/day</span></div>" +
        '<div class="muted" style="font-size:13px;margin:6px 0 10px">' + esc(c.goal) + "</div>" +
        '<div class="muted" style="font-size:12.5px">Signals: ' + c.signals.map(esc).join(", ") + "</div></div>";
    }).join("");

    var rows = savedRows + seedRows;
    if (!rows) rows = '<div class="empty">No ' + motion + " campaigns yet. Click ＋ New campaign to open the Studio.</div>";
    el.innerHTML = head("Campaigns", "The unit of work. Drag-and-drop multi-channel sequences, ICP, signals, and A/B variants in one place.") +
      '<div class="btn-row" style="margin-bottom:14px"><a class="btn btn-primary btn-sm" href="campaign-studio.html?motion=' + motion + '">🧩 Open Campaign Studio</a>' +
      '<a class="btn btn-ghost btn-sm" href="campaign-builder.html">🧱 Target builder</a></div>' + rows;

    // open a saved campaign in the Studio
    Array.prototype.forEach.call(el.querySelectorAll("[data-open]"), function (card) {
      card.addEventListener("click", function () { location.href = "campaign-studio.html?id=" + card.getAttribute("data-open"); });
    });
  }

  function renderOutreach(el) {
    var phases = SEED.phases.map(function (p) {
      return '<div class="phase"><div class="phase-h"><span class="phase-n">' + p.n + "</span><h4>" + esc(p.title) + '</h4><span class="phase-time">' + esc(p.time) + "</span></div>" +
        "<ul>" + p.items.map(function (i) { return "<li>" + esc(i) + "</li>"; }).join("") + "</ul>" +
        '<div class="done">✓ Done when: ' + esc(p.done) + "</div></div>";
    }).join("");
    var touches = SEED.touches.map(function (t) {
      return '<div class="touch"><div class="day">Day ' + t.day + '</div><div><div class="tn">' + esc(t.name) +
        '<span class="chip-c">' + esc(t.channel) + "</span></div>" +
        '<div class="ti">' + esc(t.intent) + (t.constraints ? ' <span class="spark">(' + esc(t.constraints) + ")</span>" : "") + "</div></div></div>";
    }).join("");
    el.innerHTML = head("Outreach", "The 7-phase deployment workflow and the 28-day multi-channel sequence.") +
      '<div class="two-col"><div><h3 style="margin-bottom:10px">Deploy a campaign</h3>' + phases + "</div>" +
      '<div><div class="card"><h3>Sequence anatomy (28 days)</h3>' + touches + "</div>" +
      '<div class="card" style="margin-top:14px"><h3>Decision rules</h3><ul class="phase" style="border:0;padding:0;margin:0">' +
      SEED.seqRules.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul></div></div></div>";
  }

  function renderContent(el) {
    var rows = SEED.assets.map(function (a) {
      return '<div class="list-row"><div><div class="lr-main">' + esc(a.name) + '</div><div class="lr-sub">' + esc(a.type) + "</div></div>" +
        '<div class="lr-right">' + (a.campaignIds.length ? a.campaignIds.length + " campaign(s)" : "unassigned") + "</div></div>";
    }).join("") || '<div class="empty">No assets yet.</div>';
    el.innerHTML = head("Content Library", "Case studies and comp benchmarks the AI injects into Touch 2 and Touch 3.") +
      '<div class="card">' + rows + "</div>";
  }

  function renderAccounts(el) {
    var li = SEED.accounts.linkedin.map(function (a) {
      return '<div class="integ"><span class="dot3 ' + (a.warmup === "warmed" ? "" : "") + '" style="background:' + (a.warmup === "flagged" ? "var(--accent-red)" : a.warmup === "warmed" ? "var(--accent-green)" : "var(--accent-amber)") + '"></span>' +
        '<div class="meta"><b>' + esc(a.handle) + "</b><small>" + esc(a.platform) + " · " + esc(a.warmup) + " · " + a.quotas.connects + " connects/day</small></div></div>";
    }).join("");
    var dom = SEED.accounts.domains.map(function (d) {
      var color = d.health === "blacklisted" || d.bounceRate >= 0.02 ? "var(--accent-red)" : d.health === "healthy" ? "var(--accent-green)" : "var(--accent-amber)";
      return '<div class="integ"><span class="dot3" style="background:' + color + '"></span><div class="meta"><b>' + esc(d.domain) + "</b><small>" + d.inboxes + " inboxes · " + esc(d.health) + " · bounce " + (d.bounceRate * 100).toFixed(1) + "%</small></div></div>";
    }).join("");
    el.innerHTML = head("Accounts", "LinkedIn sending accounts, sending domains, and API keys. Health auto-syncs nightly.") +
      '<div class="two-col"><div class="card"><h3>LinkedIn accounts</h3>' + (li || '<div class="empty">None yet.</div>') + "</div>" +
      '<div class="card"><h3>Sending domains</h3>' + (dom || '<div class="empty">None yet.</div>') + "</div></div>";
  }

  function renderConnected(el) {
    var rows = SEED.integrations.map(function (i) {
      var color = i.status === "green" ? "var(--accent-green)" : i.status === "yellow" ? "var(--accent-amber)" : "var(--accent-red)";
      var req = i.requiredFor.indexOf(motion) >= 0 ? '<span class="req-tag">required</span>' : "";
      return '<div class="integ"><span class="dot3" style="background:' + color + '"></span><div class="meta"><b>' + esc(i.label) + "</b><small>" + esc(i.status) + "</small></div>" + req + "</div>";
    }).join("");
    var pre = SEED.integrations.filter(function (i) { return i.requiredFor.indexOf(motion) >= 0 && i.status !== "green"; });
    var gate = pre.length ? '<div class="card" style="border-color:rgba(255,194,77,0.4);margin-bottom:14px"><b class="muted">⚠ ' + pre.length + " required integration(s) not green. Campaign activation is blocked for " + motion + ".</b></div>"
      : '<div class="card" style="border-color:rgba(56,224,166,0.4);margin-bottom:14px"><b style="color:var(--accent-green)">✓ All required integrations are green. You can activate ' + motion + " campaigns.</b></div>";
    el.innerHTML = head("Connected", "Integration pre-flight. Red → Yellow → Green. All required must be green to activate.") +
      gate + '<div class="card">' + rows + "</div>";
  }

  function renderAts(el) {
    var vendors = SEED.atsVendors.map(function (v) {
      return '<div class="integ"><span class="dot3" style="background:' + (v.status === "verified" ? "var(--accent-green)" : "var(--text-dim)") + '"></span><div class="meta"><b>' + esc(v.label) + "</b><small>" + esc(v.status) + (v.vendor === SEED.atsActive ? " · active" : "") + "</small></div></div>";
    }).join("");
    var map = SEED.objectMap.map(function (m) {
      return '<div class="list-row"><div><div class="lr-main">' + esc(m.concept) + '</div><div class="lr-sub">' + esc(m.how) + '</div></div><div class="lr-right">' + esc(m.object) + "</div></div>";
    }).join("");
    el.innerHTML = head("ATS", "Your system of record. Loxo is the verified, primary integration.") +
      '<div class="two-col"><div class="card"><h3>Choose your ATS</h3>' + vendors + "</div>" +
      '<div class="card"><h3>Loxo object mapping</h3>' + map + "</div></div>";
  }

  function cadenceHtml() {
    return SEED.cadence.map(function (c) {
      return '<div class="cad"><div class="ct">' + esc(c.at) + '</div><div><div class="cn">' + esc(c.name) +
        ' <span class="' + (c.automated ? "auto" : "manual") + '">' + (c.automated ? "AUTO" : "YOU") + "</span></div>" +
        '<div class="cd">' + esc(c.detail) + "</div></div></div>";
    }).join("");
  }

  /* ---------------- Team (admin sub-accounts) ---------------- */
  function renderTeam(el) {
    el.innerHTML = head("Team",
      "Add recruiters to this workspace and set what they can touch. Recruiters work the inbox, pipeline, sourcing, outreach and the dialer, but never see the Telnyx account, API keys, sending domains, the ATS connection, billing, or the team.");

    // Permission matrix, so an admin sees exactly where the wall is.
    var caps = [
      ["Response inbox + act", true, true, true], ["Prospects + pipeline", true, true, true],
      ["Sourcing + outreach", true, true, true], ["Voice dialer (use)", true, true, true],
      ["Create campaigns", true, true, true], ["Activate campaigns", true, true, false],
      ["LinkedIn accounts + domains", true, true, false], ["API keys", true, true, false],
      ["Telnyx / SMS account", true, true, false], ["Integrations (Connected)", true, true, false],
      ["ATS connection", true, true, false], ["Manage team", true, true, false],
      ["Billing", true, false, false]
    ];
    var matrix = '<div class="card" style="margin-bottom:16px;overflow:auto"><h3>What each role can do</h3><table class="matrix"><thead><tr><th>Capability</th><th>Owner</th><th>Admin</th><th>Recruiter</th></tr></thead><tbody>' +
      caps.map(function (r) {
        return "<tr><td>" + esc(r[0]) + "</td>" + [1, 2, 3].map(function (i) {
          return '<td>' + (r[i] ? '<span style="color:var(--accent-green)">✓</span>' : '<span class="muted">—</span>') + "</td>";
        }).join("") + "</tr>";
      }).join("") + "</tbody></table></div>";

    var members = (SEED.team || []).map(function (m) {
      return '<div class="integ"><span class="avatar" style="width:30px;height:30px;font-size:11px;background:' + colorFor(m.name) + '">' + esc(initials(m.name)) + "</span>" +
        '<div class="meta"><b>' + esc(m.name) + (m.isYou ? ' <span class="muted">(you)</span>' : "") + "</b><small>" + esc(m.email) + "</small></div>" +
        '<span class="cls cls-' + (m.role === "owner" ? "positive" : m.role === "admin" ? "soft_yes" : "unclassified") + '">' + esc(m.role) + "</span></div>";
    }).join("");
    var teamCard = '<div class="card"><h3>Members</h3>' + (members || '<div class="empty">No teammates yet. Invite your first recruiter.</div>') + "</div>";
    el.innerHTML += matrix + teamCard;

    if (LIVE) api("/team").then(function (d) {
      if (d.members) { SEED.team = d.members; renderTeam(el); }
    }).catch(function () {});
  }

  function inviteRecruiter() {
    var email = prompt("Recruiter's work email:");
    if (!email) return;
    var role = (prompt("Role: admin or member (recruiter)?", "member") || "member").toLowerCase();
    if (role !== "admin" && role !== "member") role = "member";
    if (LIVE) {
      fetch(API + "/team", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "invite", email: email, role: role }) })
        .then(function (r) { return r.json(); })
        .then(function () { toast("Invited " + email + " as " + role); })
        .catch(function () { toast("Could not send invite"); });
    } else {
      SEED.team = (SEED.team || []).concat([{ name: email.split("@")[0], email: email, role: role, isYou: false }]);
      var v = $("#view"); v.innerHTML = ""; renderTeam(v);
      toast("Invited " + email + " as " + role + " (demo)");
    }
  }

  /* ---------------- primary actions ---------------- */
  function primaryAction(key) {
    if (key === "team") { inviteRecruiter(); return; }
    if (key === "campaigns") { location.href = "campaign-studio.html?motion=" + motion; return; }
    if (key === "connected") { SEED.integrations.forEach(function (i) { if (i.status === "yellow") i.status = "green"; }); render(); toast("Tested all connections"); return; }
    toast("Demo: " + key + " action. Wire to /api when the backend is deployed.");
  }

  /* ---------------- helpers ---------------- */
  function initials(n) { return (n || "?").split(/\s+/).map(function (x) { return x[0]; }).slice(0, 2).join("").toUpperCase(); }
  function colorFor(n) { var c = ["#7c5cff", "#4dd0ff", "#ff7ac6", "#38e0a6", "#ffc24d"]; var s = 0; for (var i = 0; i < (n || "").length; i++) s += n.charCodeAt(i); return c[s % c.length]; }
  function clsLabel(c) { var m = { positive: "Positive", soft_yes: "Soft yes", referral: "Referral", timing_objection: "Timing", fit_objection: "Fit", not_interested: "Not interested", stop: "STOP", unclassified: "Review" }; return m[c] || c; }
  function statusCls(s) { var m = { booked: "positive", won: "positive", replied: "soft_yes", in_sequence: "soft_yes", nurture: "timing_objection", queued: "unclassified", closed_lost: "not_interested", do_not_contact: "stop" }; return m[s] || "unclassified"; }
  function statusLabel(s) { var l = SEED.lifecycle.find(function (x) { return x.status === s; }); return l ? l[motion] : s; }
  function mapProcessed(p) {
    return { name: (p.inbound.fromName || "Unknown"), channel: p.inbound.channel, source: p.inbound.source, text: p.inbound.text, cls: p.classification.class, actions: p.actionsTaken };
  }

  render();

  /* ---------------- seed data ---------------- */
  function seed() {
    return {
      overview: {
        capacity: [
          { label: "LinkedIn accounts", value: 2, status: "green" },
          { label: "Sending domains", value: 5, status: "green" },
          { label: "Email capacity/day", value: 450, status: "green" },
          { label: "LinkedIn capacity/day", value: 90, status: "green" }
        ],
        activeProspects: 184, appointmentsToday: 3, appointmentsThisWeek: 11, warmConversationsToday: 7, wonAccounts: 4,
        recentAppointments: [
          { name: "Marco Silva", channel: "linkedin", at: "today" },
          { name: "Priya Desai", channel: "email", at: "today" },
          { name: "Jonas Keller", channel: "sms", at: "yesterday" }
        ],
        activeDrips: [
          { name: "Anja Köhler", stage: "Touch 3" }, { name: "Liam O'Brien", stage: "Touch 5" },
          { name: "Sofia Rossi", stage: "Touch 1" }, { name: "Noah Berger", stage: "Touch 7" }
        ]
      },
      responses: [
        { name: "Marco Silva", channel: "linkedin", source: "unipile", text: "Yeah, Thursday afternoon works.", cls: "positive", actions: ["notify: call within 24h", "paused all sequences", "status → replied", "logged person_event"] },
        { name: "Rahel Amanuel", channel: "email", source: "instantly", text: "Interesting, can you send the case study?", cls: "soft_yes", actions: ["queued asset", "tagged \"engaged\"", "advanced +1 touch", "logged person_event"] },
        { name: "Priya Desai", channel: "sms", source: "taltxt", text: "Not me, but talk to my colleague Sam in Talent.", cls: "referral", actions: ["captured referralTo: Sam", "tagged \"advocate\"", "notify: new referral", "logged person_event"] },
        { name: "Jonas Keller", channel: "email", source: "instantly", text: "Not now, maybe revisit in Q3.", cls: "timing_objection", actions: ["captured timing: Q3", "→ 90-day nurture", "status → nurture", "logged person_event"] },
        { name: "Lena Dietrich", channel: "linkedin", source: "salesrobot", text: "We do all our recruiting internally, thanks.", cls: "fit_objection", actions: ["→ 6-month nurture", "tagged \"suppress-signals\"", "logged person_event"] },
        { name: "Oskar Wendt", channel: "sms", source: "taltxt", text: "STOP", cls: "stop", actions: ["suppressed all channels + ATS DNC", "status → do_not_contact", "logged person_event"] }
      ],
      rules: [
        { cls: "positive", label: "Positive", triggers: ["yes", "tell me more", "booking-link click"], actions: ["push notification", "pause all sequences", "status replied"], sla: "same day" },
        { cls: "soft_yes", label: "Soft yes", triggers: ["asks a question", "requests an asset"], actions: ["send asset", "tag engaged", "advance +1 touch"], sla: "4 hours" },
        { cls: "timing_objection", label: "Timing", triggers: ["not now", "next quarter"], actions: ["capture timing", "90-day nurture"], sla: "same day" },
        { cls: "fit_objection", label: "Fit", triggers: ["recruit internally", "happy with current"], actions: ["6-month nurture", "suppress signals"], sla: "same day" },
        { cls: "referral", label: "Referral", triggers: ["talk to X", "not me, but"], actions: ["capture referral", "tag advocate", "notify"], sla: "same day" },
        { cls: "stop", label: "STOP", triggers: ["stop", "unsubscribe", "remove me"], actions: ["suppress all channels", "do-not-contact"], sla: "immediate" }
      ],
      prospects: [
        { fullName: "Anja Köhler", title: "VP Engineering", company: "N26", status: "in_sequence", dripStage: 3 },
        { fullName: "Marco Silva", title: "Staff Engineer", company: "Wise", status: "booked", dripStage: null },
        { fullName: "Liam O'Brien", title: "Head of Talent", company: "Revolut", status: "in_sequence", dripStage: 5 },
        { fullName: "Priya Desai", title: "Founder", company: "Lumen", status: "replied", dripStage: null },
        { fullName: "Jonas Keller", title: "CTO", company: "Trade Republic", status: "nurture", dripStage: null },
        { fullName: "Sofia Rossi", title: "Eng Manager", company: "Scalable", status: "queued", dripStage: null },
        { fullName: "Noah Berger", title: "VP Product", company: "Pleo", status: "won", dripStage: null }
      ],
      lifecycle: [
        { status: "queued", bd: "Queued", recruiting: "Queued" },
        { status: "in_sequence", bd: "In sequence", recruiting: "In sequence" },
        { status: "replied", bd: "Replied", recruiting: "Replied" },
        { status: "booked", bd: "Discovery booked", recruiting: "Submitted" },
        { status: "won", bd: "Mandate signed", recruiting: "Placed" },
        { status: "nurture", bd: "Nurture", recruiting: "Nurture" }
      ],
      campaigns: [
        { name: "Senior React · Berlin", motion: "recruiting", goal: "Source senior React engineers open to a greenfield staff role.", signals: ["hiring_velocity", "leadership_change"], dailyCap: 25, status: "active" },
        { name: "Fintech VPs · DACH", motion: "bd", goal: "Book discovery calls with VP Eng at recently funded fintechs.", signals: ["fundraising", "expansion"], dailyCap: 25, status: "active" },
        { name: "Healthcare Nursing", motion: "recruiting", goal: "Pipeline travel nurses for Q3 mandates.", signals: ["hiring_velocity"], dailyCap: 25, status: "draft" }
      ],
      phases: [
        { n: 1, title: "Infrastructure pre-flight", time: "one-time", done: "Overview capacity strip is green", items: ["≥1 warmed LinkedIn account", "≥5 warmed domains", "RapidAPI job scraper", "Enrichment waterfall", "ATS connected", "TalTxt + Telnyx 10DLC"] },
        { n: 2, title: "Create campaign shell", time: "5 min", done: "Draft with ICP + signals", items: ["Name + one-line goal", "ICP definition", "≥1 signal enabled"] },
        { n: 3, title: "Search & discovery", time: "5 min", done: "Preview shows the right people", items: ["Role hiring for", "Persona title", "Decision-maker target", "Live query preview"] },
        { n: 4, title: "Connect channels", time: "3 min", done: "All channels show ✓", items: ["Instantly campaign id", "LinkedIn account", "TalTxt toggle", "Loxo list id"] },
        { n: 5, title: "Sequence methodology", time: "3 min", done: "Methodology + assets locked", items: ["Methodology", "Voice-note threshold (80)", "LLM personalization", "Content assets"] },
        { n: 6, title: "A/B variants", time: "2 min", done: "2+ variants, weights = 100%", items: ["≥2 variants", "Traffic weights 50/50", "ONE variable differs"] },
        { n: 7, title: "Soft launch & activate", time: "5 min", done: "Status = Active, first 25 live", items: ["Daily cap = 25", "Build prospect list", "Activate campaign", "Day-1 approval review"] }
      ],
      touches: [
        { channel: "email", day: 0, name: "Signal Opener", intent: "Hook on the trigger; ask 'worth sending?'", constraints: "subject ≤8 words, body ≤90 words" },
        { channel: "linkedin", day: 0, name: "Profile view", intent: "Passive warmup." },
        { channel: "linkedin", day: 1, name: "Follow", intent: "Lower commitment than a connect." },
        { channel: "email", day: 3, name: "Value Drop", intent: "Case study or comp benchmark, no ask." },
        { channel: "linkedin", day: 3, name: "Connect, no note", intent: "Empty requests accept higher." },
        { channel: "linkedin", day: 5, name: "Engage with a post", intent: "Manual comment, signals attention." },
        { channel: "email", day: 7, name: "Comparable Proof", intent: "Numbers + timeline." },
        { channel: "linkedin", day: 7, name: "Signal-anchored DM", intent: "Same trigger as email touch 1.", constraints: "≤45 words" },
        { channel: "email", day: 12, name: "Interactive Question", intent: "One sharp question." },
        { channel: "voice", day: 14, name: "Voice note (HOT)", intent: "One point, ask for a thumbs-up.", constraints: "25-30 sec" },
        { channel: "email", day: 18, name: "Market View", intent: "Three sector bullets." },
        { channel: "linkedin", day: 21, name: "Direct DM ask", intent: "Calendar link, 15 min." },
        { channel: "email", day: 24, name: "Direct Ask", intent: "Reference prior drops.", constraints: "subject '15 min next week?'" },
        { channel: "email", day: 28, name: "Break-up", intent: "Highest reply rate.", constraints: "subject 'Should I close the file?'" }
      ],
      seqRules: [
        "Reply on ANY channel → pause ALL, notify, status = replied.",
        "LinkedIn connect not accepted by Day 5 → skip DM, email-only.",
        "Warmth ≥ 80 → voice note enabled Day 14.",
        "Email bounce on Touch 1 → suppress + re-enrich.",
        "STOP / unsubscribe → suppress all channels + DNC.",
        "Day 28 no reply → 90-day nurture."
      ],
      cadence: [
        { at: "07:00", name: "Pull signals", automated: true, detail: "Run enabled signal sources (last 24h)." },
        { at: "07:15", name: "Score & dedupe", automated: true, detail: "Composite score per ICP; dedupe vs ATS; top N advance." },
        { at: "07:30", name: "Enrich", automated: true, detail: "Waterfall (Fresh LinkedIn + Tomba) finds contacts." },
        { at: "07:45", name: "LLM draft", automated: true, detail: "Claude drafts email + LinkedIn + voice; A/B applied." },
        { at: "08:30", name: "Approval queue", automated: false, detail: "Edit / kill / approve; record HOT voice notes." },
        { at: "09:00", name: "Push to channels", automated: true, detail: "Instantly / Unipile / TalTxt; person_events logged." }
      ],
      assets: [
        { name: "Fintech placement case study", type: "case_study", campaignIds: ["c1"] },
        { name: "EU eng comp benchmark 2026", type: "comp_benchmark", campaignIds: ["c1", "c2"] },
        { name: "Why signal-based outreach", type: "value_prop", campaignIds: [] }
      ],
      accounts: {
        linkedin: [
          { handle: "jamie@recruiteros.co", platform: "unipile", warmup: "warmed", quotas: { connects: 20 } },
          { handle: "bd@recruiteros.co", platform: "salesrobot", warmup: "in_warmup", quotas: { connects: 12 } }
        ],
        domains: [
          { domain: "go-recruiteros.com", inboxes: 3, health: "healthy", bounceRate: 0.004 },
          { domain: "try-recruiteros.com", inboxes: 3, health: "healthy", bounceRate: 0.009 },
          { domain: "hey-recruiteros.com", inboxes: 3, health: "warming", bounceRate: 0.0 }
        ]
      },
      integrations: [
        { id: "instantly", label: "Instantly (email)", status: "green", requiredFor: ["bd", "recruiting"] },
        { id: "unipile", label: "Unipile (LinkedIn)", status: "green", requiredFor: ["bd", "recruiting"] },
        { id: "rapidapi", label: "RapidAPI (job scraper)", status: "green", requiredFor: ["bd", "recruiting"] },
        { id: "fresh_linkedin", label: "Fresh LinkedIn (enrich)", status: "green", requiredFor: ["bd", "recruiting"] },
        { id: "tomba", label: "Tomba (email lookup)", status: "yellow", requiredFor: ["bd"] },
        { id: "loxo", label: "Loxo (ATS)", status: "green", requiredFor: ["bd", "recruiting"] },
        { id: "taltxt", label: "TalTxt (SMS)", status: "green", requiredFor: ["recruiting"] },
        { id: "telnyx", label: "Telnyx 10DLC", status: "green", requiredFor: ["recruiting"] }
      ],
      atsVendors: [
        { vendor: "loxo", label: "Loxo", status: "verified" }, { vendor: "bullhorn", label: "Bullhorn", status: "placeholder" },
        { vendor: "crelate", label: "Crelate", status: "placeholder" }, { vendor: "greenhouse", label: "Greenhouse", status: "placeholder" },
        { vendor: "lever", label: "Lever", status: "placeholder" }
      ],
      atsActive: "loxo",
      team: [
        { name: (ctx.user && ctx.user.name) || "You", email: (ctx.user && ctx.user.email) || "you@company.com", role: ctx.role || "owner", isYou: true },
        { name: "Sam Carter", email: "sam@company.com", role: "admin", isYou: false },
        { name: "Riley Chen", email: "riley@company.com", role: "member", isYou: false }
      ],
      objectMap: [
        { concept: "BD prospect", object: "Person + list", how: "POST /people/update_by_email" },
        { concept: "Activity (any touch)", object: "person_event", how: "POST /people/{id}/person_events" },
        { concept: "BD opportunity", object: "Deal", how: "one per pitch → Job when signed" },
        { concept: "Candidate in mandate", object: "Person↔Job", how: "POST /jobs/{id}/apply" },
        { concept: "Mandate", object: "Job", how: "job_type_id, company_id" },
        { concept: "Placement", object: "Placement", how: "triggers billing" }
      ]
    };
  }
})();
