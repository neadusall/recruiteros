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
  if (!ctx) { location.replace("/login"); return; }
  var API = (window.RECRUITEROS_API_BASE || "") + "/api";
  var motion = localStorage.getItem("ros_motion") || "recruiting";

  // RBAC: the session carries the capabilities the user's role allows; the UI
  // only shows what they can actually use.
  var CAPS = Array.isArray(ctx.capabilities) ? ctx.capabilities : [];
  function can(cap) { return CAPS.indexOf(cap) >= 0; }

  /* ---------------- tiny dom helpers ---------------- */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var view = $("#view");
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function toast(t) { var el = $("#toast"); el.textContent = t; el.classList.add("show"); setTimeout(function () { el.classList.remove("show"); }, 2200); }

  /* Reusable modal: openModal(title, sub, bodyHtml, onMount) -> returns close fn.
     bodyHtml should include its own .modal-foot with buttons; onMount(root, close)
     wires them. */
  function openModal(title, sub, bodyHtml, onMount) {
    var bg = document.createElement("div");
    bg.className = "modal-bg";
    bg.innerHTML = '<div class="modal-card"><button class="modal-x" aria-label="Close">×</button>' +
      "<h3>" + esc(title) + "</h3>" + (sub ? '<div class="sub">' + esc(sub) + "</div>" : "") +
      '<div class="modal-body"></div></div>';
    document.body.appendChild(bg);
    var card = bg.querySelector(".modal-card");
    bg.querySelector(".modal-body").innerHTML = bodyHtml;
    function close() { if (bg.parentNode) bg.parentNode.removeChild(bg); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") close(); }
    bg.querySelector(".modal-x").addEventListener("click", close);
    bg.addEventListener("click", function (e) { if (e.target === bg) close(); });
    document.addEventListener("keydown", onKey);
    if (onMount) onMount(card, close);
    return close;
  }
  // GET helper: resolves to parsed JSON, or null on any error (caller renders an
  // empty/needs-setup state). The session cookie authenticates every call.
  function api(path) {
    return fetch(API + path, { credentials: "include" }).then(function (r) {
      if (r.status === 401) { signOut(); throw 0; }
      if (!r.ok) throw 0;
      return r.json();
    });
  }
  // Mutating call (POST/PUT/DELETE) -> { ok, status, data }.
  function send(path, method, payload) {
    return fetch(API + path, {
      method: method, credentials: "include",
      headers: payload ? { "Content-Type": "application/json" } : undefined,
      body: payload ? JSON.stringify(payload) : undefined
    }).then(function (r) {
      if (r.status === 401) { signOut(); throw 0; }
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
    });
  }

  /* ---------------- reference content (product knowledge, not customer data) -- */
  var REF = ref();

  /* ---------------- chrome ---------------- */
  $("#wsName").textContent = (ctx.workspace && ctx.workspace.name) || "Workspace";
  $("#userName").textContent = (ctx.user && ctx.user.name) || "You";
  $("#userInitials").textContent = initials((ctx.user && ctx.user.name) || "You");
  var envPill = $("#envPill");
  if (envPill) envPill.style.display = "none"; // no demo/live badge: this is the product
  function signOut() {
    fetch(API + "/auth/session", { method: "DELETE", credentials: "include" }).catch(function () {});
    localStorage.removeItem("ros_ctx"); localStorage.removeItem("ros_session");
    location.href = "/login";
  }
  $("#signOut").addEventListener("click", signOut);

  // motion toggle
  Array.prototype.forEach.call(document.querySelectorAll(".mt"), function (b) {
    b.classList.toggle("active", b.dataset.motion === motion);
    b.addEventListener("click", function () {
      motion = b.dataset.motion; localStorage.setItem("ros_motion", motion);
      Array.prototype.forEach.call(document.querySelectorAll(".mt"), function (x) { x.classList.toggle("active", x === b); });
      render();
    });
  });

  // Response badge: live count of hot, unreviewed replies from the API.
  function refreshBadge() {
    api("/response/list").then(function (d) {
      var items = (d && d.items) || [];
      var hot = items.filter(function (p) {
        var c = p.classification && p.classification.class;
        return c === "positive" || c === "referral";
      }).length;
      var bd = $("#badgeResponse");
      if (!bd) return;
      bd.textContent = hot; bd.classList.toggle("show", hot > 0);
    }).catch(function () {});
  }
  refreshBadge();

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
    studio: { title: "Campaign Studio", crumb: "Build", action: null, render: renderStudio },
    builder: { title: "Target Builder", crumb: "Build", action: null, render: renderBuilder },
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
    el.innerHTML = head("Overview", "Real-time capacity and pipeline health for " + (ctx.workspace ? ctx.workspace.name : "your workspace") + ".") +
      '<div id="ovBody">' + loading() + "</div>" +
      '<div class="card" style="margin-top:16px"><h3>Daily cadence</h3>' + cadenceHtml() + "</div>";

    api("/overview").then(function (o) {
      o = o || {};
      // Each capacity card deep-links to where you manage that resource. The
      // capability check keeps recruiters from landing on a gated tab.
      var capLink = { "LinkedIn accounts": "accounts", "Sending domains": "accounts", "Email capacity/day": "accounts", "LinkedIn capacity/day": "accounts" };
      var cap = o.capacity || [];
      var stats = cap.map(function (c) {
        var route = capLink[c.label];
        var go = (route && (!ROUTES[route].cap || can(ROUTES[route].cap))) ? ' data-go="' + route + '"' : "";
        return '<div class="stat' + (go ? " clickable" : "") + '"' + go + '><span class="rag ' + (c.status || "red") + '"></span><div class="sv">' + (c.value != null ? c.value : 0) + '</div><div class="sl">' + esc(c.label) + "</div></div>";
      }).join("") || emptyCard("Connect your sending accounts and domains to see capacity.");
      // KPI cards deep-link into the matching operational tab.
      var kpis = [
        ["Active prospects", o.activeProspects || 0, "prospects"],
        ["Appointments today", o.appointmentsToday || 0, "prospects"],
        ["This week", o.appointmentsThisWeek || 0, "prospects"],
        ["Warm convos today", o.warmConversationsToday || 0, "response"],
        [motion === "bd" ? "Won accounts" : "Placements", o.wonAccounts || 0, "prospects"]
      ].map(function (k) {
        var go = k[2] && (!ROUTES[k[2]].cap || can(ROUTES[k[2]].cap)) ? ' data-go="' + k[2] + '"' : "";
        return '<div class="stat' + (go ? " clickable" : "") + '"' + go + '><div class="sv">' + k[1] + '</div><div class="sl">' + k[0] + "</div></div>";
      }).join("");

      var canPros = !ROUTES.prospects.cap || can(ROUTES.prospects.cap);
      var rowGo = canPros ? ' data-go="prospects" class="list-row clickable"' : ' class="list-row"';
      var appts = (o.recentAppointments || []).map(function (a) {
        return "<div" + rowGo + '><div><div class="lr-main">' + esc(a.name) + '</div><div class="lr-sub">' + esc(a.channel || "") + "</div></div><div class=\"lr-right\">" + esc(a.at || "") + "</div></div>";
      }).join("") || '<div class="empty">No appointments booked yet.</div>';

      var drips = (o.activeDrips || []).map(function (d) {
        return "<div" + rowGo + '><div class="lr-main">' + esc(d.name) + '</div><div class="lr-right">' + esc(d.stage) + "</div></div>";
      }).join("") || '<div class="empty">No active drips yet. Launch a campaign to start.</div>';

      var body = $("#ovBody"); if (!body) return;
      body.innerHTML =
        '<div class="stat-grid" style="margin-bottom:14px">' + stats + "</div>" +
        '<div class="stat-grid" style="margin-bottom:18px">' + kpis + "</div>" +
        '<div class="two-col"><div class="card"><h3>Recent appointments</h3>' + appts + "</div>" +
        '<div class="card"><h3>Active drips</h3>' + drips + "</div></div>";

      // Delegated navigation: any element with data-go jumps to that tab.
      body.addEventListener("click", function (e) {
        var t = e.target.closest("[data-go]"); if (!t) return;
        location.hash = t.getAttribute("data-go");
      });
    }).catch(function () {
      var body = $("#ovBody"); if (body) body.innerHTML = needsSetup();
    });
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

    var inbox = [];        // loaded from the API
    var loaded = false;
    function paint() {
      if (!loaded) { listWrap.innerHTML = loading(); return; }
      var items = inbox.filter(function (r) { return active === "all" || r.channel === active; });
      listWrap.innerHTML = items.map(respItem).join("") ||
        '<div class="empty">No replies' + (active === "all" ? "" : " on " + active) + " yet. As your campaigns run, every reply lands here, auto-classified.</div>";
    }
    filter.addEventListener("click", function (e) {
      var cf = e.target.closest(".cf"); if (!cf) return;
      active = cf.dataset.c;
      Array.prototype.forEach.call(filter.children, function (x) { x.classList.toggle("active", x === cf); });
      paint();
    });
    paint();

    function load() {
      api("/response/list").then(function (d) {
        inbox = ((d && d.items) || []).map(mapProcessed);
        loaded = true; paint(); wireActions();
      }).catch(function () { loaded = true; paint(); });
    }
    load();

    // Working inbox actions: Book / Suppress persist via the API and reload.
    function wireActions() {
      Array.prototype.forEach.call(listWrap.querySelectorAll("[data-act]"), function (btn) {
        btn.addEventListener("click", function () {
          var act = btn.getAttribute("data-act"), pid = btn.getAttribute("data-pid");
          if (!pid) { toast("This reply isn't linked to a prospect yet."); return; }
          btn.disabled = true;
          send("/response/actions", "POST", { action: act, prospectId: pid })
            .then(function (r) {
              if (r.ok) { toast(act === "book" ? "Marked booked" : "Suppressed (do-not-contact)"); load(); refreshBadge(); }
              else { toast("Could not " + act + " (" + (r.data.error || r.status) + ")"); btn.disabled = false; }
            }).catch(function () { toast("Could not reach the server."); btn.disabled = false; });
        });
      });
    }

    // rules matrix (product reference: how every reply is classified + routed)
    var rows = REF.rules.map(function (r) {
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
  }

  function respItem(r) {
    var pid = r.prospectId ? ' data-pid="' + esc(r.prospectId) + '"' : "";
    return '<div class="resp-item"><div class="resp-top">' +
      '<span class="avatar" style="background:' + colorFor(r.name) + '">' + esc(initials(r.name)) + "</span>" +
      '<div><div class="resp-name">' + esc(r.name) + '</div><div class="resp-chan">' + esc(r.channel) + " · " + esc(r.source) + "</div></div>" +
      '<span class="cls cls-' + r.cls + '">' + esc(clsLabel(r.cls)) + "</span></div>" +
      '<div class="resp-text">"' + esc(r.text) + '"</div>' +
      '<div class="resp-actions">' + r.actions.map(function (a) { return '<span class="resp-act">' + esc(a) + "</span>"; }).join("") +
      '<button class="resp-btn" data-act="book"' + pid + '>📅 Book</button>' +
      '<button class="resp-btn ghost" data-act="suppress"' + pid + '>🚫 Suppress</button>' +
      "</div></div>";
  }

  function renderProspects(el) {
    el.innerHTML = head("Prospects", "Your live pipeline, synced bidirectionally with the ATS.") +
      '<div class="btn-row" style="margin-bottom:14px">' +
      '<button class="btn btn-ghost btn-sm" id="importBtn">⇪ Import (CSV / paste)</button></div>' +
      '<div id="prBody">' + loading() + "</div>";

    $("#importBtn").addEventListener("click", importProspects);

    function load() {
      api("/prospects").then(function (d) {
        var list = (d && d.prospects) || [];
        var lifecycle = (d && d.lifecycle) || REF.lifecycle;
        var counts = list.reduce(function (m, p) { m[p.status] = (m[p.status] || 0) + 1; return m; }, {});
        var stages = lifecycle.map(function (l) {
          return '<div class="stage"><b>' + (counts[l.status] || 0) + "</b><span>" + esc(l[motion] || l.status) + "</span></div>";
        }).join("");
        var rows = list.map(function (p) {
          var opts = lifecycle.map(function (l) {
            return '<option value="' + esc(l.status) + '"' + (l.status === p.status ? " selected" : "") + ">" + esc(l[motion] || l.status) + "</option>";
          }).join("");
          return '<div class="list-row"><span class="avatar" style="width:28px;height:28px;font-size:11px;background:' + colorFor(p.fullName) + '">' + esc(initials(p.fullName)) + "</span>" +
            '<div><div class="lr-main">' + esc(p.fullName) + '</div><div class="lr-sub">' + esc((p.title || "") + (p.company ? " · " + p.company : "")) + "</div></div>" +
            '<select class="stage-select cls cls-' + statusCls(p.status) + '" data-pid="' + esc(p.id) + '" style="margin-left:auto">' + opts + "</select>" +
            '<div class="lr-right">' + (p.dripStage ? "Touch " + p.dripStage : "") + "</div></div>";
        }).join("");
        var body = $("#prBody"); if (!body) return;
        body.innerHTML = '<div class="pipe">' + stages + "</div>" +
          '<div class="card"><h3>Pipeline</h3>' + (rows ||
            '<div class="empty">No prospects yet. Click ＋ Add prospect above, or build a target list in the Target Builder.</div>') + "</div>";

        // Working stage transitions: change the dropdown -> persist via the API.
        Array.prototype.forEach.call(body.querySelectorAll(".stage-select"), function (sel) {
          sel.addEventListener("change", function () {
            var pid = sel.getAttribute("data-pid"), status = sel.value;
            sel.disabled = true;
            send("/prospects", "POST", { action: "transition", prospectId: pid, status: status })
              .then(function (r) {
                if (r.ok) { toast("Moved to " + statusLabel(status, lifecycle)); load(); }
                else { toast("Could not update (" + (r.data.error || r.status) + ")"); sel.disabled = false; }
              }).catch(function () { toast("Could not reach the server."); sel.disabled = false; });
          });
        });
      }).catch(function () { var b = $("#prBody"); if (b) b.innerHTML = needsSetup(); });
    }
    load();
    prospectsReload = load;
  }
  var prospectsReload = null;

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

    var rows = savedRows;
    if (!rows) rows = '<div class="empty">No ' + motion + " campaigns yet. Click ＋ New campaign to open the Studio and build your first multi-channel sequence.</div>";
    el.innerHTML = head("Campaigns", "The unit of work. Drag-and-drop multi-channel sequences, ICP, signals, and A/B variants in one place.") +
      '<div class="btn-row" style="margin-bottom:14px"><a class="btn btn-primary btn-sm" href="#studio">🧩 Open Campaign Studio</a>' +
      '<a class="btn btn-ghost btn-sm" href="#builder">🧱 Target builder</a></div>' +
      '<div id="cmpBody">' + rows + "</div>";

    // Merge any server-side campaigns the backend knows about.
    api("/campaigns").then(function (d) {
      var server = (d && d.campaigns) || [];
      if (!server.length) return;
      var extra = server.filter(function (c) { return c.motion === motion; }).map(function (c) {
        var pill = c.status === "active" ? "live" : "draft";
        return '<div class="card" style="margin-bottom:12px"><div style="display:flex;align-items:center;gap:10px">' +
          '<b style="font-size:15px">' + esc(c.name) + "</b>" +
          '<span class="status-pill ' + pill + '">' + esc(c.status) + "</span>" +
          '<span class="lr-right" style="margin-left:auto">cap ' + esc(c.dailyCap || 25) + "/day</span></div>" +
          '<div class="muted" style="font-size:13px;margin:6px 0 10px">' + esc(c.goal || "") + "</div>" +
          (c.signals && c.signals.length ? '<div class="muted" style="font-size:12.5px">Signals: ' + c.signals.map(esc).join(", ") + "</div>" : "") + "</div>";
      }).join("");
      var body = $("#cmpBody"); if (body && extra) body.insertAdjacentHTML("beforeend", extra);
    }).catch(function () {});

    // open a saved campaign in the embedded Studio (in-app route)
    Array.prototype.forEach.call(el.querySelectorAll("[data-open]"), function (card) {
      card.addEventListener("click", function () { studioOpenId = card.getAttribute("data-open"); location.hash = "studio"; });
    });
  }

  /* ---------------- Campaign Studio (embedded drag-and-drop builder) ---------------- */
  var studioOpenId = null; // set when opening a saved campaign from the Campaigns view

  // Persistence the Studio writes through: it upserts to the backend (the source
  // of truth) and mirrors to localStorage as a fast local cache for instant load.
  function studioStore() {
    function all() { try { return JSON.parse(localStorage.getItem("ros_campaigns") || "[]"); } catch (e) { return []; } }
    return {
      all: all,
      save: function (c) {
        var l = all().filter(function (x) { return x.id !== c.id; }); l.unshift(c);
        localStorage.setItem("ros_campaigns", JSON.stringify(l));
        send("/campaigns", "PUT", c).catch(function () {});
      },
      remove: function (id) {
        localStorage.setItem("ros_campaigns", JSON.stringify(all().filter(function (x) { return x.id !== id; })));
        fetch(API + "/campaigns?id=" + encodeURIComponent(id), { method: "DELETE", credentials: "include" }).catch(function () {});
      }
    };
  }

  function renderStudio(el) {
    if (typeof CampaignStudio === "undefined") { el.innerHTML = '<div class="empty">Campaign Studio failed to load.</div>'; return; }
    var root = document.createElement("div");
    el.appendChild(root);
    var openId = studioOpenId;
    studioOpenId = null; // consumed

    function mount(assignees, accounts) {
      CampaignStudio.mount(root, {
        motion: motion === "bd" ? "bd" : "recruiting",
        embedded: true,
        openId: openId,
        toast: toast,
        assignees: assignees,
        accounts: accounts,
        store: studioStore(),
        sendTestSms: function (to, body, done) {
          send("/sms/send", "POST", { to: to, text: body })
            .then(function (r) { done(r.ok ? "Test SMS sent to " + to : "Could not send. Check SMS setup in Connected."); })
            .catch(function () { done("Could not reach the server."); });
        }
      });
    }

    // Assignees = the workspace team; sending accounts = connected LinkedIn handles.
    Promise.all([
      api("/team").catch(function () { return null; }),
      api("/accounts").catch(function () { return null; })
    ]).then(function (res) {
      var members = (res[0] && res[0].members) || [];
      var team = members.map(function (m) { return m.userId === ctx.user.id ? "You" : m.name; });
      var assignees = team.concat(["Round-robin team", "Unassigned"]).filter(function (v, i, a) { return v && a.indexOf(v) === i; });
      if (assignees.length === 0) assignees = ["You", "Unassigned"];
      var li = (res[1] && res[1].linkedin) || [];
      var accounts = li.map(function (a) { return a.handle; }).concat(["auto-rotate"]);
      mount(assignees, accounts);
    });
  }

  /* ---------------- Target Builder (in-portal) ----------------
     The signal -> target -> filter -> launch wizard, embedded inside the portal
     chrome via an iframe so it lives in the tool, not as a standalone web page. */
  function renderBuilder(el) {
    el.innerHTML = head("Target Builder", "Search the market, pull live hiring signals, filter by ICP, and launch a campaign, all inside your workspace.") +
      '<div class="card" style="padding:0;overflow:hidden">' +
      '<iframe src="/campaign-builder?embed=1" title="Target Builder" ' +
      'style="width:100%;height:calc(100vh - 220px);min-height:560px;border:0;border-radius:12px;background:var(--bg)"></iframe>' +
      "</div>";
  }

  function renderOutreach(el) {
    var phases = REF.phases.map(function (p) {
      return '<div class="phase"><div class="phase-h"><span class="phase-n">' + p.n + "</span><h4>" + esc(p.title) + '</h4><span class="phase-time">' + esc(p.time) + "</span></div>" +
        "<ul>" + p.items.map(function (i) { return "<li>" + esc(i) + "</li>"; }).join("") + "</ul>" +
        '<div class="done">✓ Done when: ' + esc(p.done) + "</div></div>";
    }).join("");
    var touches = REF.touches.map(function (t) {
      return '<div class="touch"><div class="day">Day ' + t.day + '</div><div><div class="tn">' + esc(t.name) +
        '<span class="chip-c">' + esc(t.channel) + "</span></div>" +
        '<div class="ti">' + esc(t.intent) + (t.constraints ? ' <span class="spark">(' + esc(t.constraints) + ")</span>" : "") + "</div></div></div>";
    }).join("");
    el.innerHTML = head("Outreach", "The 7-phase deployment workflow and the 28-day multi-channel sequence.") +
      '<div class="two-col"><div><h3 style="margin-bottom:10px">Deploy a campaign</h3>' + phases + "</div>" +
      '<div><div class="card"><h3>Sequence anatomy (28 days)</h3>' + touches + "</div>" +
      '<div class="card" style="margin-top:14px"><h3>Decision rules</h3><ul class="phase" style="border:0;padding:0;margin:0">' +
      REF.seqRules.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul></div></div></div>";
  }

  function renderContent(el) {
    el.innerHTML = head("Content Library", "Case studies and comp benchmarks the AI injects into Touch 2 and Touch 3.") +
      '<div id="ctBody">' + loading() + "</div>";
    api("/content").then(function (d) {
      var assets = (d && d.assets) || [];
      var rows = assets.map(function (a) {
        var n = (a.campaignIds || []).length;
        return '<div class="list-row"><div><div class="lr-main">' + esc(a.name) + '</div><div class="lr-sub">' + esc(a.type) + "</div></div>" +
          '<div class="lr-right">' + (n ? n + " campaign(s)" : "unassigned") + "</div></div>";
      }).join("") || '<div class="empty">No assets yet. Add a case study or comp benchmark, the AI weaves it into your value-drop touches.</div>';
      var body = $("#ctBody"); if (body) body.innerHTML = '<div class="card">' + rows + "</div>";
    }).catch(function () { var b = $("#ctBody"); if (b) b.innerHTML = needsSetup(); });
  }

  function renderAccounts(el) {
    el.innerHTML = head("Accounts", "LinkedIn sending accounts, sending domains, and API keys. Health auto-syncs nightly.") +
      '<div class="btn-row" style="margin-bottom:14px">' +
      '<button class="btn btn-primary btn-sm" data-add="linkedin">＋ LinkedIn account</button>' +
      '<button class="btn btn-ghost btn-sm" data-add="domain">＋ Sending domain</button>' +
      '<button class="btn btn-ghost btn-sm" data-add="apikey">＋ API key</button></div>' +
      '<div id="acBody">' + loading() + "</div>";

    function load() {
      api("/accounts").then(function (d) {
        d = d || {};
        var li = (d.linkedin || []).map(function (a) {
          var q = (a.quotas && a.quotas.connects) || 0;
          return '<div class="integ"><span class="dot3" style="background:' + (a.warmup === "flagged" ? "var(--accent-red)" : a.warmup === "warmed" ? "var(--accent-green)" : "var(--accent-amber)") + '"></span>' +
            '<div class="meta"><b>' + esc(a.handle) + "</b><small>" + esc(a.platform) + " · " + esc(a.warmup) + " · " + q + " connects/day</small></div></div>";
        }).join("") || '<div class="empty">No LinkedIn accounts connected yet.</div>';
        var dom = (d.domains || []).map(function (x) {
          var color = x.health === "blacklisted" || x.bounceRate >= 0.02 ? "var(--accent-red)" : x.health === "healthy" ? "var(--accent-green)" : "var(--accent-amber)";
          return '<div class="integ"><span class="dot3" style="background:' + color + '"></span><div class="meta"><b>' + esc(x.domain) + "</b><small>" + (x.inboxes || 0) + " inboxes · " + esc(x.health) + " · bounce " + (((x.bounceRate || 0) * 100).toFixed(1)) + "%</small></div></div>";
        }).join("") || '<div class="empty">No sending domains yet.</div>';
        var keys = (d.apiKeys || []).map(function (k) {
          return '<div class="integ"><span class="dot3" style="background:var(--accent-green)"></span><div class="meta"><b>' + esc(k.service) + "</b><small>" + esc(k.masked) + "</small></div></div>";
        }).join("") || '<div class="empty">No API keys stored yet.</div>';
        var body = $("#acBody"); if (!body) return;
        body.innerHTML = '<div class="two-col"><div class="card"><h3>LinkedIn accounts</h3>' + li + "</div>" +
          '<div class="card"><h3>Sending domains</h3>' + dom + "</div></div>" +
          '<div class="card" style="margin-top:14px"><h3>API keys</h3>' + keys + "</div>";
      }).catch(function () { var b = $("#acBody"); if (b) b.innerHTML = needsSetup(); });
    }
    load();

    Array.prototype.forEach.call(el.querySelectorAll("[data-add]"), function (btn) {
      btn.addEventListener("click", function () {
        var t = btn.getAttribute("data-add"), payload;
        if (t === "linkedin") { var h = prompt("LinkedIn account email/username:"); if (!h) return; payload = { type: "linkedin", handle: h, platform: (prompt("Platform (unipile, salesrobot, ...):", "unipile") || "unipile") }; }
        else if (t === "domain") { var dn = prompt("Sending domain (e.g. go-yourco.com):"); if (!dn) return; payload = { type: "domain", domain: dn, inboxes: 3 }; }
        else { var svc = prompt("Service (Instantly, Telnyx, Loxo, ...):"); if (!svc) return; var key = prompt("API key for " + svc + ":"); if (!key) return; payload = { type: "apikey", service: svc, key: key }; }
        send("/accounts", "POST", payload).then(function (r) {
          toast(r.ok ? "Added" : "Could not add (" + (r.data.error || r.status) + ")"); if (r.ok) load();
        }).catch(function () { toast("Could not reach the server."); });
      });
    });
  }

  function renderConnected(el) {
    el.innerHTML = head("Connected", "Integration pre-flight. Red → Yellow → Green. All required must be green to activate.") +
      '<div id="cnBody">' + loading() + "</div>";

    function load() {
      api("/connected").then(function (d) {
        var ints = (d && d.integrations) || [];
        var rows = ints.map(function (i) {
          var color = i.status === "green" ? "var(--accent-green)" : i.status === "yellow" ? "var(--accent-amber)" : "var(--accent-red)";
          var req = (i.requiredFor || []).indexOf(motion) >= 0 ? '<span class="req-tag">required</span>' : "";
          return '<div class="integ"><span class="dot3" style="background:' + color + '"></span><div class="meta"><b>' + esc(i.label) + "</b><small>" + esc(i.status) + (i.error ? " · " + esc(i.error) : "") + "</small></div>" +
            '<button class="btn btn-ghost btn-sm" data-test="' + esc(i.id) + '">Test</button>' + req + "</div>";
        }).join("") || '<div class="empty">No integrations available.</div>';
        var pre = ints.filter(function (i) { return (i.requiredFor || []).indexOf(motion) >= 0 && i.status !== "green"; });
        var gate = pre.length ? '<div class="card" style="border-color:rgba(255,194,77,0.4);margin-bottom:14px"><b class="muted">⚠ ' + pre.length + " required integration(s) not green. Campaign activation is blocked for " + motion + ".</b></div>"
          : '<div class="card" style="border-color:rgba(56,224,166,0.4);margin-bottom:14px"><b style="color:var(--accent-green)">✓ All required integrations are green. You can activate ' + motion + " campaigns.</b></div>";
        var body = $("#cnBody"); if (!body) return;
        body.innerHTML = gate + '<div class="card">' + rows + "</div>";
        Array.prototype.forEach.call(body.querySelectorAll("[data-test]"), function (btn) {
          btn.addEventListener("click", function () {
            btn.disabled = true; btn.textContent = "Testing...";
            send("/connected", "POST", { action: "test", id: btn.getAttribute("data-test") })
              .then(function () { load(); }).catch(function () { toast("Could not reach the server."); });
          });
        });
      }).catch(function () { var b = $("#cnBody"); if (b) b.innerHTML = needsSetup(); });
    }
    load();
    connectedReload = load; // let the "Test all" header button refresh
  }
  var connectedReload = null;

  function renderAts(el) {
    el.innerHTML = head("ATS", "Your system of record. Loxo is the verified, primary integration.") +
      '<div id="atBody">' + loading() + "</div>";
    api("/ats").then(function (d) {
      d = d || {};
      var vendors = (d.vendors || []).map(function (v) {
        return '<div class="integ"><span class="dot3" style="background:' + (v.status === "verified" ? "var(--accent-green)" : "var(--text-dim)") + '"></span><div class="meta"><b>' + esc(v.label) + "</b><small>" + esc(v.status) + (v.vendor === d.active ? " · active" : "") + "</small></div></div>";
      }).join("") || '<div class="empty">No ATS vendors available.</div>';
      var map = (d.objectMap || []).map(function (m) {
        return '<div class="list-row"><div><div class="lr-main">' + esc(m.concept) + '</div><div class="lr-sub">' + esc(m.how) + '</div></div><div class="lr-right">' + esc(m.object) + "</div></div>";
      }).join("");
      var body = $("#atBody"); if (!body) return;
      body.innerHTML = '<div class="two-col"><div class="card"><h3>Choose your ATS</h3>' + vendors + "</div>" +
        '<div class="card"><h3>Loxo object mapping</h3>' + map + "</div></div>";
    }).catch(function () { var b = $("#atBody"); if (b) b.innerHTML = needsSetup(); });
  }

  function cadenceHtml() {
    return REF.cadence.map(function (c) {
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

    el.innerHTML += matrix + '<div class="card"><h3>Members</h3><div id="tmBody">' + loading() + "</div></div>" +
      '<div class="card" style="margin-top:14px"><h3>Pending invites</h3><div id="tmInvites"><div class="empty">None.</div></div></div>';

    api("/team").then(function (d) {
      var members = (d && d.members) || [];
      var rows = members.map(function (m) {
        var you = m.userId === ctx.user.id;
        var ctrl = (!you && (d.assignableRoles || []).length)
          ? '<button class="btn btn-ghost btn-sm" data-remove="' + esc(m.userId) + '">Remove</button>' : "";
        return '<div class="integ"><span class="avatar" style="width:30px;height:30px;font-size:11px;background:' + colorFor(m.name) + '">' + esc(initials(m.name)) + "</span>" +
          '<div class="meta"><b>' + esc(m.name) + (you ? ' <span class="muted">(you)</span>' : "") + "</b><small>" + esc(m.email) + (m.emailVerified ? "" : " · unverified") + "</small></div>" +
          '<span class="cls cls-' + (m.role === "owner" ? "positive" : m.role === "admin" ? "soft_yes" : "unclassified") + '">' + esc(m.role) + "</span>" + ctrl + "</div>";
      }).join("") || '<div class="empty">No teammates yet. Invite your first recruiter with the button above.</div>';
      var body = $("#tmBody"); if (body) body.innerHTML = rows;
      var invs = ((d && d.invites) || []).map(function (i) {
        return '<div class="integ"><span class="dot3" style="background:var(--accent-amber)"></span><div class="meta"><b>' + esc(i.email) + "</b><small>invited as " + esc(i.role) + "</small></div></div>";
      }).join("");
      var ib = $("#tmInvites"); if (ib) ib.innerHTML = invs || '<div class="empty">None.</div>';
      if (body) Array.prototype.forEach.call(body.querySelectorAll("[data-remove]"), function (btn) {
        btn.addEventListener("click", function () {
          if (!confirm("Remove this teammate?")) return;
          send("/team", "POST", { action: "remove", userId: btn.getAttribute("data-remove") })
            .then(function (r) { toast(r.ok ? "Removed" : "Could not remove"); if (r.ok) renderTeam($("#view")); });
        });
      });
    }).catch(function () { var b = $("#tmBody"); if (b) b.innerHTML = needsSetup(); });
  }

  function inviteRecruiter() {
    var email = prompt("Recruiter's work email:");
    if (!email) return;
    var role = (prompt("Role: admin or member (recruiter)?", "member") || "member").toLowerCase();
    if (role !== "admin" && role !== "member") role = "member";
    send("/team", "POST", { action: "invite", email: email, role: role })
      .then(function (r) {
        if (r.ok) { toast("Invited " + email + " as " + role); renderTeam($("#view")); }
        else toast("Could not invite (" + (r.data.error || r.status) + ")");
      })
      .catch(function () { toast("Could not reach the server."); });
  }

  /* ---------------- primary actions ---------------- */
  function primaryAction(key) {
    if (key === "team") { inviteRecruiter(); return; }
    if (key === "campaigns") { studioOpenId = null; location.hash = "studio"; return; }
    if (key === "prospects") { addProspect(); return; }
    if (key === "content") { addAsset(); return; }
    if (key === "connected") {
      toast("Testing all connections...");
      send("/connected", "POST", { action: "test-all" })
        .then(function (r) { toast(r.ok ? "Tested all connections" : "Could not test"); if (connectedReload) connectedReload(); })
        .catch(function () { toast("Could not reach the server."); });
      return;
    }
  }

  function addProspect() {
    // Pull real campaigns from the API so this works on any device.
    api("/campaigns").then(function (d) {
      var camps = ((d && d.campaigns) || []).filter(function (c) { return c.motion === motion; });
      if (!camps.length) { toast("Create a campaign first (＋ New campaign)."); location.hash = "campaigns"; return; }
      var name = prompt("Prospect full name:"); if (!name) return;
      var email = prompt("Email (optional):") || undefined;
      var company = prompt("Company (optional):") || undefined;
      var campaignId;
      if (camps.length === 1) campaignId = camps[0].id;
      else {
        var menu = camps.map(function (c, i) { return (i + 1) + ". " + c.name; }).join("\n");
        var pick = prompt("Add to which campaign?\n" + menu + "\n\nEnter a number:", "1");
        var idx = parseInt(pick, 10) - 1;
        if (isNaN(idx) || !camps[idx]) return;
        campaignId = camps[idx].id;
      }
      send("/prospects", "POST", { fullName: name, email: email, company: company, campaignId: campaignId })
        .then(function (r) {
          if (r.ok) { toast("Prospect added"); if (prospectsReload) prospectsReload(); else renderProspects($("#view")); }
          else toast("Could not add (" + (r.data.error || r.status) + ")");
        })
        .catch(function () { toast("Could not reach the server."); });
    }).catch(function () { toast("Could not reach the server."); });
  }

  /* Bulk import: paste CSV / TSV / lines. Header optional; recognizes
     name,email,company,title,linkedin,phone in any order. Dedupe handled server-side. */
  function importProspects() {
    api("/campaigns").then(function (d) {
      var camps = ((d && d.campaigns) || []).filter(function (c) { return c.motion === motion; });
      if (!camps.length) { toast("Create a campaign first (＋ New campaign)."); location.hash = "campaigns"; return; }
      var campOpts = camps.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + "</option>"; }).join("");
      var bodyHtml =
        '<label>Add to campaign</label><select id="impCamp">' + campOpts + "</select>" +
        '<label>Paste rows (CSV, TSV, or one per line)</label>' +
        '<textarea id="impText" placeholder="Jane Doe, jane@acme.com, Acme, VP Engineering&#10;John Smith, john@globex.com, Globex, Head of Talent"></textarea>' +
        '<div class="imp-preview" id="impPrev">Columns auto-detected: name, email, company, title, linkedin, phone. A header row is optional.</div>' +
        '<div class="modal-foot"><button class="btn btn-ghost btn-sm" id="impCancel">Cancel</button>' +
        '<button class="btn btn-primary btn-sm" id="impGo">Import</button></div>';

      openModal("Import prospects", "Paste from a spreadsheet, Apollo, LinkedIn export, anywhere.", bodyHtml, function (root, close) {
        var ta = root.querySelector("#impText"), prev = root.querySelector("#impPrev");
        function parse() {
          var lines = ta.value.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
          if (!lines.length) return [];
          // detect + drop a header row
          var first = lines[0].toLowerCase();
          var hasHeader = /(name|email|company|title|linkedin|phone)/.test(first) && /[,\t]/.test(first);
          var cols = hasHeader ? first.split(/[,\t]/).map(function (s) { return s.trim(); }) : null;
          if (hasHeader) lines.shift();
          return lines.map(function (line) {
            var parts = line.split(/[,\t]/).map(function (s) { return s.trim(); });
            var row = {};
            if (cols) {
              cols.forEach(function (c, i) {
                if (/name/.test(c)) row.fullName = parts[i];
                else if (/email/.test(c)) row.email = parts[i];
                else if (/company/.test(c)) row.company = parts[i];
                else if (/title|role/.test(c)) row.title = parts[i];
                else if (/linkedin|url/.test(c)) row.linkedinUrl = parts[i];
                else if (/phone|mobile/.test(c)) row.phone = parts[i];
              });
            } else {
              // positional: name, email, company, title
              row.fullName = parts[0];
              parts.slice(1).forEach(function (p) {
                if (/@/.test(p)) row.email = p;
                else if (/linkedin\.com/.test(p)) row.linkedinUrl = p;
                else if (/^[+\d][\d\s().-]{6,}$/.test(p)) row.phone = p;
                else if (!row.company) row.company = p;
                else if (!row.title) row.title = p;
              });
            }
            return row;
          }).filter(function (r) { return r.fullName; });
        }
        ta.addEventListener("input", function () {
          var n = parse().length;
          prev.innerHTML = n ? "Ready to import <b>" + n + "</b> prospect" + (n === 1 ? "" : "s") + "." : "Paste rows above.";
        });
        root.querySelector("#impCancel").addEventListener("click", close);
        root.querySelector("#impGo").addEventListener("click", function () {
          var rows = parse();
          if (!rows.length) { toast("Nothing to import, paste some rows."); return; }
          var cid = root.querySelector("#impCamp").value;
          rows.forEach(function (r) { r.campaignId = cid; });
          var go = root.querySelector("#impGo"); go.disabled = true; go.textContent = "Importing…";
          send("/prospects", "POST", { action: "bulk", rows: rows }).then(function (res) {
            if (res.ok) {
              var added = res.data && res.data.added != null ? res.data.added : rows.length;
              var dup = res.data && res.data.deduped ? " (" + res.data.deduped + " already existed)" : "";
              toast("Imported " + added + " prospect" + (added === 1 ? "" : "s") + dup);
              close(); if (prospectsReload) prospectsReload();
            } else { toast("Import failed (" + (res.data.error || res.status) + ")"); go.disabled = false; go.textContent = "Import"; }
          }).catch(function () { toast("Could not reach the server."); go.disabled = false; go.textContent = "Import"; });
        });
      });
    }).catch(function () { toast("Could not reach the server."); });
  }

  function addAsset() {
    var name = prompt("Asset name:"); if (!name) return;
    var type = (prompt("Type: case_study, comp_benchmark, value_prop, video_script", "case_study") || "case_study");
    var bodyText = prompt("Content / text:") || "";
    send("/content", "POST", { name: name, type: type, body: bodyText })
      .then(function (r) { if (r.ok) { toast("Asset added"); renderContent($("#view")); } else toast("Could not add (" + (r.data.error || r.status) + ")"); })
      .catch(function () { toast("Could not reach the server."); });
  }

  /* ---------------- helpers ---------------- */
  function initials(n) { return (n || "?").split(/\s+/).map(function (x) { return x[0]; }).slice(0, 2).join("").toUpperCase(); }
  function colorFor(n) { var c = ["#7c5cff", "#4dd0ff", "#ff7ac6", "#38e0a6", "#ffc24d"]; var s = 0; for (var i = 0; i < (n || "").length; i++) s += n.charCodeAt(i); return c[s % c.length]; }
  function clsLabel(c) { var m = { positive: "Positive", soft_yes: "Soft yes", referral: "Referral", timing_objection: "Timing", fit_objection: "Fit", not_interested: "Not interested", stop: "STOP", unclassified: "Review" }; return m[c] || c; }
  function statusCls(s) { var m = { booked: "positive", won: "positive", replied: "soft_yes", in_sequence: "soft_yes", nurture: "timing_objection", queued: "unclassified", closed_lost: "not_interested", do_not_contact: "stop" }; return m[s] || "unclassified"; }
  function statusLabel(s, lifecycle) {
    var l = (lifecycle || REF.lifecycle).find(function (x) { return x.status === s; });
    return l ? (l[motion] || l.status) : s;
  }
  function mapProcessed(p) {
    return { name: (p.inbound.fromName || "Unknown"), channel: p.inbound.channel, source: p.inbound.source, text: p.inbound.text, cls: p.classification.class, actions: p.actionsTaken, prospectId: p.prospectId || (p.prospect && p.prospect.id) || null };
  }
  // shared UI states
  function loading() { return '<div class="empty">Loading…</div>'; }
  function emptyCard(msg) { return '<div class="empty">' + esc(msg) + "</div>"; }
  function needsSetup() {
    return '<div class="empty">Couldn\'t load this yet. If you just created your workspace, connect your tools under <a href="#connected">Connected</a> to get started.</div>';
  }

  render();

  /* ---------------- reference content (product knowledge, NOT customer data) -- */
  // Everything here is how the product WORKS (rules, schedule, sequence anatomy,
  // ATS mapping). All real customer data is fetched live from the API.
  function ref() {
    return {
      rules: [
        { cls: "positive", label: "Positive", triggers: ["yes", "tell me more", "booking-link click"], actions: ["push notification", "pause all sequences", "status replied"], sla: "same day" },
        { cls: "soft_yes", label: "Soft yes", triggers: ["asks a question", "requests an asset"], actions: ["send asset", "tag engaged", "advance +1 touch"], sla: "4 hours" },
        { cls: "timing_objection", label: "Timing", triggers: ["not now", "next quarter"], actions: ["capture timing", "90-day nurture"], sla: "same day" },
        { cls: "fit_objection", label: "Fit", triggers: ["recruit internally", "happy with current"], actions: ["6-month nurture", "suppress signals"], sla: "same day" },
        { cls: "referral", label: "Referral", triggers: ["talk to X", "not me, but"], actions: ["capture referral", "tag advocate", "notify"], sla: "same day" },
        { cls: "stop", label: "STOP", triggers: ["stop", "unsubscribe", "remove me"], actions: ["suppress all channels", "do-not-contact"], sla: "immediate" }
      ],
      lifecycle: [
        { status: "queued", bd: "Queued", recruiting: "Queued" },
        { status: "in_sequence", bd: "In sequence", recruiting: "In sequence" },
        { status: "replied", bd: "Replied", recruiting: "Replied" },
        { status: "booked", bd: "Discovery booked", recruiting: "Submitted" },
        { status: "won", bd: "Mandate signed", recruiting: "Placed" },
        { status: "nurture", bd: "Nurture", recruiting: "Nurture" }
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
          { handle: "jamie@recruitersos.co", platform: "unipile", warmup: "warmed", quotas: { connects: 20 } },
          { handle: "bd@recruitersos.co", platform: "salesrobot", warmup: "in_warmup", quotas: { connects: 12 } }
        ],
        domains: [
          { domain: "go-recruitersos.com", inboxes: 3, health: "healthy", bounceRate: 0.004 },
          { domain: "try-recruitersos.com", inboxes: 3, health: "healthy", bounceRate: 0.009 },
          { domain: "hey-recruitersos.com", inboxes: 3, health: "warming", bounceRate: 0.0 }
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

  /* The ATS object map is also exposed by GET /api/ats; this local copy is only a
     fallback so the ATS screen renders if that call is briefly unavailable. */

  /* ============================================================
     Account menu (upper right): logo upload + enterprise dropdown
     ============================================================ */
  (function accountMenu() {
    var btn = $("#acctBtn"), menu = $("#acctMenu"), acct = $("#acct");
    if (!btn || !menu) return;

    var name = (ctx.user && ctx.user.name) || "You";
    var email = (ctx.user && ctx.user.email) || "you@company.com";
    var plan = (ctx.workspace && ctx.workspace.plan) ? ctx.workspace.plan : "Workspace";
    var inits = initials(name);
    var LOGO_KEY = "ros_logo_" + ((ctx.workspace && ctx.workspace.id) || "ws");

    var avatar = $("#acctAvatar"), avatarLg = $("#acctAvatarLg");
    var sideAvatar = $("#userInitials"); // sidebar footer chip avatar, kept in sync
    $("#acctName").textContent = name;
    $("#acctEmail").textContent = email;
    $("#acctPlan").textContent = plan;

    function applyImg(dataUrl) {
      [avatar, avatarLg, sideAvatar].forEach(function (a) {
        if (!a) return;
        a.textContent = inits;
        if (dataUrl) { a.style.backgroundImage = "url(" + dataUrl + ")"; a.style.backgroundSize = "cover"; a.style.backgroundPosition = "center"; a.classList.add("has-img"); }
        else { a.style.backgroundImage = ""; a.classList.remove("has-img"); }
      });
    }
    var saved = null; try { saved = localStorage.getItem(LOGO_KEY); } catch (e) {}
    applyImg(saved);

    function setOpen(o) { menu.hidden = !o; btn.setAttribute("aria-expanded", String(o)); }
    btn.addEventListener("click", function (e) { e.stopPropagation(); setOpen(menu.hidden); });
    // The sidebar footer chip opens the same account menu, so there is one
    // consistent place to manage your profile, photo, workspace and sign-out.
    var sideChip = $("#userChip");
    if (sideChip) {
      sideChip.style.cursor = "pointer";
      sideChip.setAttribute("title", "Account & settings");
      sideChip.addEventListener("click", function (e) { e.stopPropagation(); setOpen(menu.hidden); });
    }
    document.addEventListener("click", function (e) { if (!acct.contains(e.target) && !(sideChip && sideChip.contains(e.target))) setOpen(false); });
    window.addEventListener("keydown", function (e) { if (e.key === "Escape") setOpen(false); });

    // Image upload, any size, downscaled to a 256px square data URL (cover-fit).
    var fileInput = $("#logoFile");
    if (fileInput) {
      fileInput.addEventListener("change", function () {
        var f = fileInput.files && fileInput.files[0];
        if (!f) return;
        if (!/^image\//.test(f.type)) { toast("Please choose an image file."); return; }
        var reader = new FileReader();
        reader.onload = function () {
          var img = new Image();
          img.onload = function () {
            var S = 256, cv = document.createElement("canvas"); cv.width = cv.height = S;
            var c = cv.getContext("2d");
            var scale = Math.max(S / img.width, S / img.height);
            var w = img.width * scale, h = img.height * scale;
            c.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
            var out = cv.toDataURL("image/png");
            try { localStorage.setItem(LOGO_KEY, out); } catch (e) { toast("Image too large to save."); return; }
            applyImg(out); toast("Logo updated");
          };
          img.src = reader.result;
        };
        reader.readAsDataURL(f);
      });
    }
    var rm = $("#logoRemove");
    if (rm) rm.addEventListener("click", function () {
      try { localStorage.removeItem(LOGO_KEY); } catch (e) {}
      applyImg(null); toast("Reset to initials");
    });

    Array.prototype.forEach.call(menu.querySelectorAll("[data-route]"), function (a) {
      a.addEventListener("click", function () { setOpen(false); location.hash = a.getAttribute("data-route"); });
    });
    var billing = $("#billingLink");
    if (billing) billing.addEventListener("click", function () { setOpen(false); location.hash = "accounts"; });

    var ownerLink = $("#ownerLink");
    if (ownerLink && (ctx.role === "owner" || can("workspace:delete"))) {
      ownerLink.hidden = false;
      ownerLink.addEventListener("click", function () { location.href = "/owner-console"; });
    }
    var so = $("#acctSignOut");
    if (so) so.addEventListener("click", signOut);
  })();
})();
