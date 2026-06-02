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

  /* ---------------- Chrome extension bridge ----------------
     The extension's portal-bridge content script announces itself and accepts a
     one-click "configure" (backend URL + ingest token) via window.postMessage, so
     the user never copies/pastes. Set EXT_STORE_URL once published for "Add to Chrome". */
  var EXT_STORE_URL = ""; // e.g. "https://chrome.google.com/webstore/detail/<id>"
  var extState = { installed: false, version: "" };
  window.addEventListener("message", function (e) {
    if (e.source !== window || !e.data || e.data.source !== "ros-ext") return;
    if (e.data.type === "present") {
      extState.installed = true; extState.version = e.data.version || "";
      document.dispatchEvent(new CustomEvent("ros-ext-present", { detail: extState }));
    } else if (e.data.type === "configured") {
      document.dispatchEvent(new CustomEvent("ros-ext-configured", { detail: e.data }));
    }
  });
  function extPing() { try { window.postMessage({ source: "ros-portal", type: "ping" }, window.location.origin); } catch (e) {} }
  function extConfigure(backendBaseUrl, token) { try { window.postMessage({ source: "ros-portal", type: "configure", backendBaseUrl: backendBaseUrl, token: token, motion: motion }, window.location.origin); } catch (e) {} }

  // RBAC: the session carries the capabilities the user's role allows; the UI
  // only shows what they can actually use.
  var CAPS = Array.isArray(ctx.capabilities) ? ctx.capabilities : [];
  function can(cap) { return CAPS.indexOf(cap) >= 0; }

  /* ---------------- tiny dom helpers ---------------- */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var view = $("#view");

  // Auto-refresh registry: views that poll for live data push their interval id
  // here; render() clears them all when you navigate away, so nothing keeps
  // fetching in the background.
  var viewTimers = [];
  function clearViewTimers() { viewTimers.forEach(function (t) { clearInterval(t); }); viewTimers = []; }
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
  function delay(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  // GET helper: resolves to parsed JSON, or null on any error (caller renders an
  // empty/needs-setup state). The session cookie authenticates every call.
  // A 401 is retried once after a short delay before signing out: just after a
  // redeploy the backend may still be hydrating its session store from the DB,
  // and we must not nuke a valid local session during that boot window.
  function api(path, _retried) {
    return fetch(API + path, { credentials: "include" }).then(function (r) {
      if (r.status === 401) {
        if (!_retried) return delay(1200).then(function () { return api(path, true); });
        signOut(); throw 0;
      }
      if (!r.ok) throw 0;
      return r.json();
    });
  }
  // Mutating call (POST/PUT/DELETE) -> { ok, status, data }. Same 401-retry guard.
  function send(path, method, payload, _retried) {
    return fetch(API + path, {
      method: method, credentials: "include",
      headers: payload ? { "Content-Type": "application/json" } : undefined,
      body: payload ? JSON.stringify(payload) : undefined
    }).then(function (r) {
      if (r.status === 401) {
        if (!_retried) return delay(1200).then(function () { return send(path, method, payload, true); });
        signOut(); throw 0;
      }
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
    });
  }

  /* ---------------- reference content (product knowledge, not customer data) -- */
  var REF = ref();

  /* ---------------- chrome ---------------- */
  var wsNameEl = $("#wsName"); if (wsNameEl) wsNameEl.textContent = (ctx.workspace && ctx.workspace.name) || "Workspace";
  var envPill = $("#envPill");
  if (envPill) envPill.style.display = "none"; // no demo/live badge: this is the product
  function signOut() {
    fetch(API + "/auth/session", { method: "DELETE", credentials: "include" }).catch(function () {});
    localStorage.removeItem("ros_ctx"); localStorage.removeItem("ros_session");
    location.href = "/login";
  }

  // motion toggle
  Array.prototype.forEach.call(document.querySelectorAll(".mt"), function (b) {
    b.classList.toggle("active", b.dataset.motion === motion);
    b.addEventListener("click", function () {
      motion = b.dataset.motion; localStorage.setItem("ros_motion", motion);
      Array.prototype.forEach.call(document.querySelectorAll(".mt"), function (x) { x.classList.toggle("active", x === b); });
      syncMotionNav();
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

  // Initial motion-specific nav visibility (In-Market Leads is BD-only).
  syncMotionNav();

  /* ---------------- router ---------------- */
  var ROUTES = {
    overview: { title: "Overview", crumb: "Operate", action: null, render: renderOverview },
    response: { title: "Response", crumb: "Operate", action: null, render: renderResponse },
    inmarket: { title: "Hire Signals", crumb: "Operate", action: null, render: renderInMarket },
    prospects: { title: "Prospects", crumb: "Operate", action: "＋ Add prospect", render: renderProspects },
    campaigns: { title: "Campaigns", crumb: "Build", action: null, render: renderCampaigns },
    studio: { title: "Campaign Studio", crumb: "Build", action: null, render: renderStudio },
    builder: { title: "In-Market Leads", crumb: "Build", action: null, render: renderInMarket, motionOnly: "bd" },
    outreach: { title: "Outreach", crumb: "Build", action: null, render: renderOutreach },
    automation: { title: "LinkedIn Automation", crumb: "Build", action: null, render: renderAutomation },
    content: { title: "Content Library", crumb: "Build", action: "＋ Add asset", render: renderContent },
    analytics: { title: "Analytics", crumb: "Measure", action: null, render: renderAnalytics },
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
    // Aliases. #builder stays the BD-branded entry (it forces BD via its own
    // route); Hire Signals (#inmarket) is motion-agnostic and shows in both.
    var ALIAS = { "in-market": "inmarket", leads: "inmarket" };
    if (ALIAS[h]) h = ALIAS[h];
    if (!ROUTES[h]) return "overview";
    // A motion-only route (e.g. the BD-only #builder) switches the workspace to
    // its motion rather than bouncing the user to Overview.
    if (ROUTES[h].motionOnly && ROUTES[h].motionOnly !== motion) {
      motion = ROUTES[h].motionOnly; localStorage.setItem("ros_motion", motion); syncMotionNav();
    }
    if (ROUTES[h].cap && !can(ROUTES[h].cap)) return "overview"; // recruiter hit a gated route
    return h;
  }

  // Show/hide motion-specific nav items (e.g. In-Market Leads is BD-only).
  function syncMotionNav() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-motion-only]"), function (el) {
      el.style.display = (el.getAttribute("data-motion-only") === motion) ? "" : "none";
    });
  }

  function render() {
    var key = currentRoute();
    if (key !== "campaigns") cmpEdit = null; // leave the sequence editor when navigating away
    var r = ROUTES[key];
    $("#pageTitle").textContent = r.title;
    $("#crumb").textContent = (ctx.workspace ? ctx.workspace.name + " / " : "") + r.crumb;
    Array.prototype.forEach.call(document.querySelectorAll(".nav-item"), function (n) { n.classList.toggle("active", n.dataset.route === key); });
    var pa = $("#primaryAction");
    if (r.action) { pa.style.display = ""; pa.textContent = r.action; pa.onclick = function () { primaryAction(key); }; }
    else pa.style.display = "none";
    Array.prototype.forEach.call(document.querySelectorAll(".mt"), function (x) { x.classList.toggle("active", x.dataset.motion === motion); });
    clearViewTimers(); // stop any auto-refresh from the view we're leaving
    view.innerHTML = "";
    r.render(view);
  }

  window.addEventListener("hashchange", render);
  Array.prototype.forEach.call(document.querySelectorAll(".nav-item"), function (n) {
    n.setAttribute("href", "#" + n.dataset.route);
  });

  /* ---------------- views ---------------- */

  // The page title already shows in the topbar (#pageTitle), so the in-view header
  // renders only the description — no duplicate title — and sits tight under the header.
  function head(title, sub) {
    return sub ? '<div class="v-head"><p>' + esc(sub) + "</p></div>" : "";
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

  /* ---------------- In-Market Leads (BD: who is hiring right now) ------------ */
  var inMarketResults = [];      // last search results (full lead objects)
  var imMode = "industry";       // "industry" | "company"
  var imSelectedIndustry = null;
  var imMinScore = 0;            // narrow-down: minimum hiring-intent score shown
  var imLabel = "";             // current result label, kept for re-renders
  var imPicks = {};             // key -> { lead, manager } selected to push to Prospects

  // Industries + sub-sectors recruiters sell into. Drives the refined in-market search.
  // (Free job-board coverage is strongest for the tech-adjacent rows; traditional
  // verticals post on Workday/Taleo/iCIMS, so those return fewer free results — a paid
  // data feed fills them out. See the note rendered above the chips.)
  var IM_INDUSTRIES = [
    "Technology / SaaS", "AI / Machine Learning", "Cybersecurity", "Data / Analytics",
    "DevOps / Cloud", "Hardware / IoT", "Semiconductors", "Robotics", "Gaming",
    "Fintech", "Banking", "Insurance", "Investment / PE / VC", "Crypto / Web3",
    "Healthcare", "Biotech / Pharma", "Medical Devices", "Hospitals / Health Systems",
    "Manufacturing", "Aerospace / Defense", "Automotive", "Industrial / Automation",
    "Energy", "Oil & Gas", "Renewables / CleanTech", "Utilities", "Mining / Metals",
    "Construction", "Architecture / Engineering", "Real Estate", "PropTech",
    "Logistics / Supply Chain", "Freight / Transportation", "Warehousing",
    "Retail / eCommerce", "Consumer Goods (CPG)", "Fashion / Apparel", "Food & Beverage",
    "Agriculture / AgTech", "Hospitality", "Travel / Tourism", "Media / Entertainment",
    "Telecom", "Education", "EdTech", "Legal", "Accounting / Tax", "Consulting",
    "Marketing / Agency", "HR / Staffing", "Sales / GTM", "Government / Public", "Nonprofit"
  ];
  var IM_PLACEHOLDER = {
    industry: "Search an industry or market, e.g. fintech, healthcare, manufacturing",
    company: "Search a company by name, e.g. Stripe, Verla Health, Brightwave"
  };

  // Hiring-signal types you can filter the search by (company-side). Pulled from the
  // engine's signal catalog; these are what the free/open sources can surface.
  var IM_SIGNALS = [
    { t: "job_posting", l: "📋 New job posting" },
    { t: "hiring_velocity", l: "📈 Hiring surge" },
    { t: "job_repost", l: "🔁 Role reposted" },
    { t: "evergreen_role", l: "⏳ Long-open role" },
    { t: "headcount_growth", l: "👥 Headcount growth" },
    { t: "careers_page_launch", l: "🌐 Careers page launched" },
    { t: "ats_detected", l: "🧩 ATS adopted" },
    { t: "funding_round", l: "💰 Funding round" },
    { t: "ipo_or_s1", l: "🏛️ IPO / S-1" },
    { t: "acquisition", l: "🤝 Acquisition" },
    { t: "merger", l: "🔗 Merger" },
    { t: "revenue_milestone", l: "📊 Revenue milestone" },
    { t: "grant_or_contract", l: "📜 Grant / contract win" },
    { t: "exec_hire", l: "👔 New exec" },
    { t: "department_head_change", l: "🧭 New function lead" },
    { t: "exec_departure", l: "🚪 Exec departure" },
    { t: "board_change", l: "🪑 Board change" },
    { t: "office_expansion", l: "🏢 Expansion" },
    { t: "market_entry", l: "🌍 New market" },
    { t: "product_launch", l: "🚀 Product launch" },
    { t: "partnership", l: "🤝 Partnership" },
    { t: "tech_stack_change", l: "🛠️ Tech adoption" },
    { t: "layoff", l: "📉 Layoff" },
    { t: "warn_notice", l: "⚠️ WARN notice" }
  ];
  var imSelectedSignals = [];   // selected SignalType keys to filter the search by

  function imPickKey(leadId, role) { return leadId + "::" + (role || "__company"); }
  function imFindLead(id) { return inMarketResults.find(function (x) { return x.id === id; }); }
  function imVisibleLeads() { return inMarketResults.filter(function (l) { return Math.round(l.score || 0) >= imMinScore; }); }

  function renderInMarket(el) {
    imPicks = {}; imMinScore = 0; imSelectedSignals = [];
    el.innerHTML =
      '<div class="im-hero">' +
        '<h1 class="im-title">Who\'s hiring <span class="gradient-text">right now.</span></h1>' +
        '<div class="im-modes" id="imModes">' +
          '<button type="button" class="im-mode active" data-mode="industry">By industry / market</button>' +
          '<button type="button" class="im-mode" data-mode="company">By company name</button>' +
        "</div>" +
        '<form class="im-search" id="imForm">' +
          '<span class="ico">⌕</span>' +
          '<input id="imQuery" type="text" autocomplete="off" placeholder="' + esc(IM_PLACEHOLDER[imMode]) + '" />' +
          '<button type="submit" class="btn btn-primary" id="imSearchBtn">Find in-market companies</button>' +
        "</form>" +
        '<div class="im-hint">Pick a sector, or type any industry, role, or keyword in the box above (e.g. “claims adjuster”, “RN”, “plant manager”, “solar”). Coverage is deepest for tech-adjacent sectors today — a paid data feed broadens the rest.</div>' +
        '<div class="im-industries" id="imIndustries">' +
          IM_INDUSTRIES.map(function (n) { return '<button type="button" class="im-chip" data-ind="' + esc(n) + '">' + esc(n) + "</button>"; }).join("") +
        "</div>" +
        '<div class="im-sig-wrap"><div class="im-sig-label">Filter by hiring signal <span class="muted">— optional, click to toggle. Pulls from open / free sources.</span></div>' +
          '<div class="im-signals" id="imSignals">' +
            IM_SIGNALS.map(function (s) { return '<button type="button" class="im-sigchip" data-sig="' + esc(s.t) + '">' + esc(s.l) + "</button>"; }).join("") +
          "</div></div>" +
      "</div>" +
      '<div id="imSaved"></div>' +
      '<div id="imBody"><div class="empty">Pick an industry to surface companies actively hiring in that market, ranked by hiring intent.</div></div>';

    renderSavedSignals();
    var form = $("#imForm"), input = $("#imQuery");

    // Search mode toggle: industry/market OR company name — one or the other.
    Array.prototype.forEach.call(el.querySelectorAll(".im-mode"), function (m) {
      m.addEventListener("click", function () {
        imMode = m.getAttribute("data-mode");
        Array.prototype.forEach.call(el.querySelectorAll(".im-mode"), function (x) { x.classList.toggle("active", x === m); });
        imSelectedIndustry = null; syncChips();
        input.value = ""; input.placeholder = IM_PLACEHOLDER[imMode];
        $("#imIndustries").style.display = (imMode === "industry") ? "" : "none";
        $("#imBody").innerHTML = '<div class="empty">' + (imMode === "industry"
          ? "Pick an industry to surface companies actively hiring in that market, ranked by hiring intent."
          : "Type a company name to check if they’re hiring right now, and who owns the open roles.") + "</div>";
        input.focus();
      });
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var v = input.value.trim(); if (!v) return;
      if (imMode === "company") { runSearch({ companyName: v }, v); }
      else { imSelectedIndustry = null; syncChips(); runSearch({ query: v }, v); }
    });

    Array.prototype.forEach.call(el.querySelectorAll(".im-chip"), function (c) {
      c.addEventListener("click", function () {
        var ind = c.getAttribute("data-ind");
        imSelectedIndustry = (imSelectedIndustry === ind) ? null : ind;
        syncChips();
        if (imSelectedIndustry) { input.value = imSelectedIndustry; runSearch({ industries: [imSelectedIndustry] }, imSelectedIndustry); }
      });
    });

    // Signal-type chips: toggle, then re-run the current search filtered to those signals.
    Array.prototype.forEach.call(el.querySelectorAll(".im-sigchip"), function (c) {
      c.addEventListener("click", function () {
        var t = c.getAttribute("data-sig");
        var i = imSelectedSignals.indexOf(t);
        if (i >= 0) imSelectedSignals.splice(i, 1); else imSelectedSignals.push(t);
        syncSigChips();
        rerunSearch();
      });
    });

    function syncChips() {
      Array.prototype.forEach.call(el.querySelectorAll(".im-chip"), function (c) {
        c.classList.toggle("active", c.getAttribute("data-ind") === imSelectedIndustry);
      });
    }
    function syncSigChips() {
      Array.prototype.forEach.call(el.querySelectorAll(".im-sigchip"), function (c) {
        c.classList.toggle("active", imSelectedSignals.indexOf(c.getAttribute("data-sig")) >= 0);
      });
    }

    // Re-run whatever search is in context (industry / company / keyword), or a
    // signals-only sweep when nothing else is chosen.
    function rerunSearch() {
      if (imMode === "company") {
        var v = input.value.trim();
        if (v) runSearch({ companyName: v }, v);
        else if (imSelectedSignals.length) runSearch({}, "selected signals");
      } else if (imSelectedIndustry) {
        runSearch({ industries: [imSelectedIndustry] }, imSelectedIndustry);
      } else {
        var q = input.value.trim();
        if (q) runSearch({ query: q }, q);
        else if (imSelectedSignals.length) runSearch({}, "selected signals");
      }
    }

    function runSearch(criteria, label) {
      var body = $("#imBody"); body.innerHTML = loading();
      imPicks = {}; imMinScore = 0; imLabel = label || "";
      var payload = { limit: 500 };
      if (criteria.companyName) payload.companyName = criteria.companyName;
      if (criteria.industries) payload.industries = criteria.industries;
      if (criteria.query) payload.query = criteria.query;
      if (imSelectedSignals.length) payload.signalTypes = imSelectedSignals.slice();
      send("/in-market", "POST", payload).then(function (r) {
        if (!r.ok) { body.innerHTML = needsSetup(); return; }
        inMarketResults = (r.data && r.data.leads) || [];
        renderImResults();
      }).catch(function () { body.innerHTML = needsSetup(); });
    }
  }

  // Render the results region: a bulk toolbar (select-all + narrow-down) over the cards.
  function renderImResults() {
    var body = document.getElementById("imBody"); if (!body) return;
    if (!inMarketResults.length) {
      body.innerHTML = '<div class="empty">No in-market companies matched yet. Try another search, or connect more signal sources under <a href="#connected">Connected</a>.</div>';
      return;
    }
    var leads = imVisibleLeads();
    var bands = [["0", "All"], ["50", "50+"], ["75", "75+"]];
    var toolbar =
      '<div class="im-toolbar">' +
        '<label class="im-checkall"><input type="checkbox" id="imAll"> Select all hiring managers</label>' +
        '<span class="im-count">' + leads.length + " of " + inMarketResults.length + " companies" + (imLabel ? " · " + esc(imLabel) : "") + "</span>" +
        '<div class="im-narrow" title="Narrow by hiring-intent score">' +
          bands.map(function (b) { return '<button type="button" class="im-nbtn' + (String(imMinScore) === b[0] ? " active" : "") + '" data-min="' + b[0] + '">' + b[1] + "</button>"; }).join("") +
        "</div>" +
        '<button class="btn btn-ghost btn-sm" id="imSave" disabled>💾 Save as hiring signals</button>' +
        '<button class="btn btn-primary btn-sm" id="imBulk" disabled>Push selected to Prospects</button>' +
      "</div>";
    body.innerHTML = toolbar + '<div id="imList">' + leads.map(leadCard).join("") + "</div>";
    wireImResults(body);
    updateImBulk();
  }

  function leadCard(l) {
    var score = Math.round(l.score || 0);
    var scoreCls = score >= 75 ? "positive" : score >= 50 ? "soft_yes" : "unclassified";
    var src = l.sourceUrl ? ' · <a href="' + esc(l.sourceUrl) + '" target="_blank" rel="noopener">source</a>' : "";

    // Deep dive: each open role mapped to the hiring manager who would own it. Each row
    // is selectable as the prospect to push to Prospects + sequence.
    var mgrs = (l.hiringManagers && l.hiringManagers.length) ? l.hiringManagers : null;
    var rows;
    if (mgrs) {
      rows = mgrs.map(function (m) {
        var who = m.managerName
          ? '<b>' + esc(m.managerName) + "</b>"
          : '<span class="muted">resolve on push</span>';
        return '<label class="im-mgr"><input type="checkbox" class="im-pick" data-id="' + esc(l.id) + '" data-role="' + esc(m.role) + '" ' + (imPicks[imPickKey(l.id, m.role)] ? "checked" : "") + ">" +
          '<span class="im-mgr-role">' + esc(m.role) + "</span>" +
          '<span class="im-mgr-arrow">→</span>' +
          '<span class="im-mgr-title">' + esc(m.managerTitle) + "</span>" +
          '<span class="im-fn">' + esc(m.function) + "</span>" +
          '<span class="im-mgr-who">' + who + "</span></label>";
      }).join("");
    } else {
      // No role breakdown: offer the company's buyer / decision-maker as the prospect.
      var who = l.buyerName ? '<b>' + esc(l.buyerName) + "</b>" : '<span class="muted">resolve on push</span>';
      rows = '<label class="im-mgr"><input type="checkbox" class="im-pick" data-id="' + esc(l.id) + '" data-role="" ' + (imPicks[imPickKey(l.id, "")] ? "checked" : "") + ">" +
        '<span class="im-mgr-role">Decision-maker</span>' +
        '<span class="im-mgr-arrow">→</span>' +
        '<span class="im-mgr-title">' + esc(l.buyerTitle || "Hiring manager") + "</span>" +
        '<span class="im-mgr-who">' + who + "</span></label>";
    }

    var renew = l.renewed
      ? '<div class="im-renew"><div class="im-renew-top">🔥 <b>' + esc(l.renewedReason || "Renewed demand") + "</b> " +
          '<span class="muted">— already in your Prospects, but hiring again. Re-engage:</span></div>' +
          '<div class="im-renew-msg">' + esc(l.renewedMessage || "") + "</div>" +
          '<button class="im-renew-copy" data-msg="' + esc(l.renewedMessage || "") + '">Copy follow-up message</button></div>'
      : "";

    return '<div class="im-lead' + (l.renewed ? " im-lead-renew" : "") + '" data-id="' + esc(l.id) + '">' +
      '<div class="im-lead-head">' +
        '<span class="avatar" style="background:' + colorFor(l.company) + '">' + esc(initials(l.company)) + "</span>" +
        '<div class="im-lead-id"><div class="im-lead-name">' + esc(l.company) +
          (l.renewed ? ' <span class="im-renew-badge">🔥 Renewed</span>' : "") +
          (l.industry ? ' <span class="muted" style="font-weight:400">· ' + esc(l.industry) + "</span>" : "") + "</div>" +
        '<div class="im-lead-meta">' + esc(l.headcountBand || "") + (l.location ? " · " + esc(l.location) : "") + "</div></div>" +
        '<span class="cls cls-' + scoreCls + ' im-score" title="Hiring-intent score">' + score + "</span></div>" +
      '<div class="im-reason">' + esc(l.reason) + src + "</div>" +
      renew +
      '<div class="im-managers"><div class="im-mgr-head">Hiring managers &amp; open roles <span class="muted">(' + (mgrs ? mgrs.length : 1) + ")</span></div>" + rows + "</div>" +
      (l.scoreReasons && l.scoreReasons.length ? '<div class="im-lead-reasons">' + l.scoreReasons.slice(0, 3).map(esc).join(" · ") + "</div>" : "") +
      "</div>";
  }

  function wireImResults(body) {
    // Per-manager selection.
    Array.prototype.forEach.call(body.querySelectorAll(".im-pick"), function (cb) {
      cb.addEventListener("change", function () {
        var id = cb.getAttribute("data-id"), role = cb.getAttribute("data-role");
        var lead = imFindLead(id); if (!lead) return;
        var mgr = role ? (lead.hiringManagers || []).find(function (m) { return m.role === role; }) : null;
        var key = imPickKey(id, role);
        if (cb.checked) imPicks[key] = { lead: lead, manager: mgr || null };
        else delete imPicks[key];
        updateImBulk();
      });
    });
    // Select all visible hiring managers.
    var all = body.querySelector("#imAll");
    if (all) all.addEventListener("change", function () {
      Array.prototype.forEach.call(body.querySelectorAll(".im-pick"), function (cb) {
        if (cb.checked !== all.checked) { cb.checked = all.checked; cb.dispatchEvent(new Event("change")); }
      });
    });
    // Narrow-down by score.
    Array.prototype.forEach.call(body.querySelectorAll(".im-nbtn"), function (b) {
      b.addEventListener("click", function () { imMinScore = parseInt(b.getAttribute("data-min"), 10) || 0; renderImResults(); });
    });
    // Bulk push.
    var bulk = body.querySelector("#imBulk");
    if (bulk) bulk.addEventListener("click", bulkPushToProspects);
    // Save selected as hiring signals (a staging step before Prospects).
    var save = body.querySelector("#imSave");
    if (save) save.addEventListener("click", saveSelectedSignals);
    // Copy the auto-generated renewed-demand follow-up message.
    Array.prototype.forEach.call(body.querySelectorAll(".im-renew-copy"), function (btn) {
      btn.addEventListener("click", function () {
        var msg = btn.getAttribute("data-msg") || "";
        var done = function () { btn.textContent = "✓ Copied"; setTimeout(function () { btn.textContent = "Copy follow-up message"; }, 1800); };
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(msg).then(done).catch(done); }
        else { try { var ta = document.createElement("textarea"); ta.value = msg; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta); } catch (e) {} done(); }
      });
    });
  }

  function updateImBulk() {
    var n = Object.keys(imPicks).length;
    var btn = document.getElementById("imBulk");
    if (btn) { btn.disabled = n === 0; btn.textContent = n ? ("Push " + n + " to Prospects →") : "Push selected to Prospects"; }
    var save = document.getElementById("imSave");
    if (save) { save.disabled = n === 0; save.textContent = n ? ("💾 Save " + n + " as hiring signals") : "💾 Save as hiring signals"; }
    var all = document.getElementById("imAll");
    var picks = document.querySelectorAll(".im-pick");
    if (all && picks.length) {
      var checked = document.querySelectorAll(".im-pick:checked").length;
      all.checked = checked === picks.length;
      all.indeterminate = checked > 0 && checked < picks.length;
    }
  }

  /* ---- Saved hiring signals: a staging shelf between search and Prospects ---- */
  function loadSavedSignals() { try { return JSON.parse(localStorage.getItem("ros_saved_signals") || "[]"); } catch (e) { return []; } }
  function storeSavedSignals(arr) { try { localStorage.setItem("ros_saved_signals", JSON.stringify(arr)); } catch (e) {} }

  // Save the currently-selected hiring managers to the shelf (deduped), without
  // touching Prospects yet — the recruiter reviews them first.
  function saveSelectedSignals() {
    var picks = Object.keys(imPicks).map(function (k) { return imPicks[k]; });
    if (!picks.length) return;
    var saved = loadSavedSignals();
    var seen = {};
    saved.forEach(function (s) { seen[imPickKey(s.lead.id, s.manager ? s.manager.role : "")] = true; });
    var added = 0;
    picks.forEach(function (p) {
      var key = imPickKey(p.lead.id, p.manager ? p.manager.role : "");
      if (!seen[key]) { saved.push({ lead: p.lead, manager: p.manager || null }); seen[key] = true; added++; }
    });
    storeSavedSignals(saved);
    toast("Saved " + added + " hiring signal" + (added === 1 ? "" : "s") + (added !== picks.length ? " (" + (picks.length - added) + " already saved)" : ""));
    imPicks = {}; renderImResults(); renderSavedSignals();
  }

  // Render the saved-signals shelf at the top of the In-Market view.
  function renderSavedSignals() {
    var box = document.getElementById("imSaved"); if (!box) return;
    var saved = loadSavedSignals();
    if (!saved.length) { box.innerHTML = ""; return; }
    box.innerHTML =
      '<div class="im-saved"><div class="im-saved-head">' +
        '<b>💾 Saved hiring signals</b> <span class="muted">(' + saved.length + ")</span>" +
        '<button class="btn btn-primary btn-sm" id="imSavedPush">Push all to Prospects →</button>' +
        '<button class="btn btn-ghost btn-sm" id="imSavedClear">Clear</button>' +
      "</div><div class=\"im-saved-list\">" +
        saved.map(function (s, i) {
          var who = (s.manager && s.manager.managerName) || s.lead.buyerName || (s.manager && s.manager.managerTitle) || "Hiring manager";
          var role = (s.manager && s.manager.role) ? s.manager.role : "Decision-maker";
          return '<div class="im-saved-row"><span class="im-saved-co">' + esc(s.lead.company) + "</span>" +
            '<span class="muted">' + esc(role) + " → " + esc(who) + "</span>" +
            '<button class="im-saved-x" data-rm="' + i + '" title="Remove">✕</button></div>';
        }).join("") +
      "</div></div>";
    var pushBtn = box.querySelector("#imSavedPush");
    if (pushBtn) pushBtn.addEventListener("click", pushSavedToProspects);
    var clearBtn = box.querySelector("#imSavedClear");
    if (clearBtn) clearBtn.addEventListener("click", function () { storeSavedSignals([]); renderSavedSignals(); });
    Array.prototype.forEach.call(box.querySelectorAll("[data-rm]"), function (x) {
      x.addEventListener("click", function () {
        var arr = loadSavedSignals(); arr.splice(parseInt(x.getAttribute("data-rm"), 10), 1);
        storeSavedSignals(arr); renderSavedSignals();
      });
    });
  }

  // Promote every saved signal into Prospects (paired to its company), then clear the shelf.
  function pushSavedToProspects() {
    var saved = loadSavedSignals(); if (!saved.length) return;
    var btn = document.getElementById("imSavedPush"); if (btn) btn.disabled = true;
    resolveBdCampaign(function (campaignId) {
      if (!campaignId) { toast("Create a campaign first."); if (btn) btn.disabled = false; return; }
      var done = 0;
      (function next(i) {
        if (i >= saved.length) {
          toast(done + " prospect" + (done === 1 ? "" : "s") + " pushed to Prospects");
          storeSavedSignals([]); renderSavedSignals();
          return;
        }
        if (btn) btn.textContent = "Pushing " + (i + 1) + "/" + saved.length + "…";
        var payload = { action: "promote", campaignId: campaignId, lead: saved[i].lead };
        if (saved[i].manager) payload.manager = saved[i].manager;
        send("/in-market", "POST", payload)
          .then(function (r) { if (r.ok) done++; next(i + 1); })
          .catch(function () { next(i + 1); });
      })(0);
    });
  }

  // Resolve (or create) the BD campaign that holds promoted in-market prospects.
  function resolveBdCampaign(cb) {
    var saved = [];
    try { saved = JSON.parse(localStorage.getItem("ros_campaigns") || "[]"); } catch (e) {}
    var camp = saved.filter(function (c) { return c.motion === motion; })[0] || saved[0];
    if (camp && camp.id) { cb(camp.id); return; }
    var c = { id: "camp_" + Math.random().toString(36).slice(2), name: "In-Market Pipeline", motion: motion, goal: "Hiring managers promoted from In-Market Leads.", status: "active", dailyCap: 25, steps: [] };
    send("/campaigns", "PUT", c).then(function () {
      try { var l = JSON.parse(localStorage.getItem("ros_campaigns") || "[]"); l.unshift(c); localStorage.setItem("ros_campaigns", JSON.stringify(l)); } catch (e) {}
      cb(c.id);
    }).catch(function () { cb(null); });
  }

  // Push every selected hiring manager to Prospects (paired to its company) + sequence.
  function bulkPushToProspects() {
    var picks = Object.keys(imPicks).map(function (k) { return imPicks[k]; });
    if (!picks.length) return;
    var btn = document.getElementById("imBulk"); if (btn) btn.disabled = true;
    resolveBdCampaign(function (campaignId) {
      if (!campaignId) { toast("Create a campaign first."); if (btn) btn.disabled = false; return; }
      var done = 0;
      (function next(i) {
        if (i >= picks.length) {
          toast(done + " prospect" + (done === 1 ? "" : "s") + " pushed to Prospects");
          imPicks = {}; renderImResults();
          return;
        }
        if (btn) btn.textContent = "Pushing " + (i + 1) + "/" + picks.length + "…";
        var payload = { action: "promote", campaignId: campaignId, lead: picks[i].lead };
        if (picks[i].manager) payload.manager = picks[i].manager;
        send("/in-market", "POST", payload)
          .then(function (r) { if (r.ok) done++; next(i + 1); })
          .catch(function () { next(i + 1); });
      })(0);
    });
  }

  function renderProspects(el) {
    el.innerHTML = head("Prospects", "Your live pipeline, synced bidirectionally with the ATS.") +
      '<div class="btn-row" style="margin-bottom:12px">' +
      '<button class="btn btn-primary btn-sm" id="enrichAllBtn">⚡ Enrich all contacts</button>' +
      '<button class="btn btn-ghost btn-sm" id="importBtn">⇪ Import (CSV / paste)</button>' +
      '<button class="btn btn-ghost btn-sm" id="liSearchBtn">🔗 Enrich LinkedIn searches</button>' +
      '<button class="btn btn-ghost btn-sm" id="prListsBtn">📁 Saved lists</button>' +
      '<select id="prSavedSelect" title="Open a saved search / list" style="margin-left:auto;background:var(--surface-2,#16161f);color:var(--text,#f4f4f8);border:1px solid var(--border,#2a2a36);border-radius:8px;padding:6px 11px;font-size:13px;max-width:240px"><option value="">📂 Saved searches…</option></select>' +
      '</div>' +
      '<div id="liProgress"></div>' +
      '<div class="pr-searchbar"><span class="ico">⌕</span>' +
      '<input id="prSearch" type="text" autocomplete="off" placeholder="Search prospects by name, job title, company, or keyword…" /></div>' +
      '<div id="prBody">' + loading() + "</div>";

    $("#importBtn").addEventListener("click", importProspects);
    $("#liSearchBtn").addEventListener("click", importLinkedInSearch);
    $("#enrichAllBtn").addEventListener("click", function () { enrichAllProspects(this); });
    $("#prListsBtn").addEventListener("click", openListsModal);

    var prAll = [], prLifecycle = REF.lifecycle, prFilter = "", prSel = {};
    // Saved-search view: when a saved list is chosen, only its prospects show.
    var prListIds = null, prListId = "", prListName = "";
    var savedSelect = $("#prSavedSelect");
    if (savedSelect) savedSelect.addEventListener("change", function () { selectSavedList(savedSelect.value); });
    function selectSavedList(id) {
      var l = id && listStore().all().filter(function (x) { return x.id === id; })[0];
      if (!l) { prListIds = null; prListId = ""; prListName = ""; }
      else { prListIds = {}; (l.prospectIds || []).forEach(function (pid) { prListIds[pid] = true; }); prListId = l.id; prListName = l.name; }
      if (savedSelect) savedSelect.value = prListId;
      paint();
    }
    // Rebuild the dropdown options from the saved lists for this motion.
    function refreshSavedDropdown() {
      if (!savedSelect) return;
      var lists = listStore().all().filter(function (l) { return !l.motion || l.motion === motion; });
      savedSelect.innerHTML = '<option value="">📂 Saved searches…</option>' +
        lists.map(function (l) { return '<option value="' + esc(l.id) + '">' + esc(l.name) + " · " + (l.prospectIds || []).length + "</option>"; }).join("");
      savedSelect.value = prListId;
    }
    var searchEl = $("#prSearch");
    if (searchEl) searchEl.addEventListener("input", function () { prFilter = (searchEl.value || "").toLowerCase().trim(); paint(); });

    // Keyword filter over name (incl. first name), job title, company, email, source.
    function matches(p) {
      if (prListIds && !prListIds[p.id]) return false;   // viewing a saved search
      if (!prFilter) return true;
      var hay = ((p.fullName || "") + " " + (p.title || "") + " " + (p.company || "") + " " +
        (p.email || "") + " " + (p.category || "")).toLowerCase();
      return prFilter.split(/\s+/).every(function (t) { return hay.indexOf(t) >= 0; });
    }

    function rowHtml(p, lifecycle) {
      var opts = lifecycle.map(function (l) {
        return '<option value="' + esc(l.status) + '"' + (l.status === p.status ? " selected" : "") + ">" + esc(l[motion] || l.status) + "</option>";
      }).join("");
      var contact = [];
      if (p.email) contact.push("✉ " + esc(p.email));
      if (p.phone) contact.push("☎ " + esc(p.phone));
      var contactLine = '<div class="lr-contact' + (contact.length ? "" : " muted") + '">' +
        (contact.length ? contact.join(" · ") : "No work contact yet") + "</div>";
      // Experience summary: stored on the prospect, hidden by default so the row
      // stays clean; expand on demand. Backend populates `experienceSummary`.
      var exp = p.experienceSummary || p.experience || p.summary || "";
      var expHtml = exp
        ? '<button type="button" class="pr-exp-toggle" data-exp="' + esc(p.id) + '" style="background:none;border:0;color:var(--brand-2,#4dd0ff);font-size:12px;cursor:pointer;padding:3px 0 0">Experience ▾</button>' +
          '<div class="pr-exp" id="exp_' + esc(p.id) + '" hidden style="margin-top:5px;font-size:12.5px;line-height:1.5;color:var(--text-muted,#aab);white-space:pre-line;max-width:640px">' + esc(exp) + "</div>"
        : "";
      // A "role placeholder" prospect: the hiring manager's real name isn't researched yet.
      var pending = !p.linkedinUrl && (/ [—–] /.test(p.fullName || "") || /hiring manager/i.test(p.fullName || ""));
      var name = pending
        ? esc(p.title || "Hiring manager") + ' <span class="pr-pending">name pending research</span>'
        : esc(p.fullName);
      var enrichLbl = pending ? "🔎 Find hiring manager" : (p.email && p.phone) ? "↻ Re-enrich" : "⚡ Enrich contact";
      return '<div class="list-row' + (prSel[p.id] ? " pr-selected" : "") + '" data-pid="' + esc(p.id) + '">' +
        '<input type="checkbox" class="pr-check" data-pid="' + esc(p.id) + '"' + (prSel[p.id] ? " checked" : "") + ' />' +
        '<span class="avatar" style="position:relative;width:30px;height:30px;font-size:11px;flex:none;background:' + colorFor(p.fullName) + '">' + esc(initials(pending ? (p.company || "?") : p.fullName)) +
          (p.photoUrl && !pending ? '<img src="' + esc(p.photoUrl) + '" alt="" style="position:absolute;inset:0;width:100%;height:100%;border-radius:50%;object-fit:cover" onerror="this.remove()" />' : "") + "</span>" +
        '<div class="lr-id"><div class="lr-main">' + name + '</div><div class="lr-sub">' + esc((p.company ? p.company : "") + (pending && p.title ? "" : (p.title ? " · " + p.title : "")) + (p.location ? " · " + p.location : "")) + "</div>" + contactLine + expHtml + "</div>" +
        '<button class="pr-enrich" data-enrich="' + esc(p.id) + '">' + enrichLbl + "</button>" +
        '<select class="stage-select cls cls-' + statusCls(p.status) + '" data-pid="' + esc(p.id) + '">' + opts + "</select>" +
        '<div class="lr-right">' + (p.dripStage ? "Touch " + p.dripStage : "") + "</div></div>";
    }

    function paint() {
      var body = $("#prBody"); if (!body) return;
      var lifecycle = prLifecycle;
      var list = prAll.filter(matches);
      var counts = list.reduce(function (m, p) { m[p.status] = (m[p.status] || 0) + 1; return m; }, {});
      var stages = lifecycle.map(function (l) {
        return '<div class="stage"><b>' + (counts[l.status] || 0) + "</b><span>" + esc(l[motion] || l.status) + "</span></div>";
      }).join("");
      var rows = list.map(function (p) { return rowHtml(p, lifecycle); }).join("");
      var countLbl = prFilter ? (list.length + " of " + prAll.length) : String(prAll.length);
      var selIds = list.filter(function (p) { return prSel[p.id]; }).map(function (p) { return p.id; });
      var allOn = list.length > 0 && selIds.length === list.length;
      var bulk = '<div class="pr-bulk">' +
        '<label class="pr-selall"><input type="checkbox" id="prSelAll"' + (allOn ? " checked" : "") + " /> Select all" + (prFilter ? " (filtered)" : "") + "</label>" +
        (selIds.length
          ? '<span class="pr-selcount">' + selIds.length + " selected</span>" +
            '<span class="pr-bulk-actions"><button class="btn btn-primary btn-sm" id="prSaveList">💾 Save as list</button>' +
            '<button class="btn btn-ghost btn-sm" id="prDelSel">🗑 Delete</button>' +
            '<button class="btn btn-ghost btn-sm" id="prClearSel">Clear</button></span>'
          : '<span class="pr-selcount muted">Select prospects to save them as a named list or delete in bulk.</span>') +
        "</div>";
      var listBanner = prListName
        ? '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;padding:8px 12px;border:1px solid var(--border,#2a2a36);border-radius:10px;font-size:13px;background:rgba(124,92,255,.08)">' +
          '📂 Viewing saved search: <b>' + esc(prListName) + "</b> · " + list.length + " shown" +
          '<button class="btn btn-ghost btn-sm" id="prShowAll" style="margin-left:auto">Show all prospects</button></div>'
        : "";
      body.innerHTML = '<div class="pipe">' + stages + "</div>" +
        '<div class="card"><h3>Pipeline <span class="muted" style="font-weight:400;font-size:13px">· ' + countLbl + "</span></h3>" +
        listBanner + bulk +
        (rows || '<div class="empty">' + (prListName
          ? "This saved search has no matching prospects in your current pipeline."
          : prFilter
          ? "No prospects match “" + esc(prFilter) + "”."
          : "No prospects yet. Import, pull from a LinkedIn search above, or promote from In-Market Leads.") + "</div>") + "</div>";
      var showAll = $("#prShowAll"); if (showAll) showAll.addEventListener("click", function () { selectSavedList(""); });

      // Selection wiring
      var selAll = $("#prSelAll");
      if (selAll) selAll.addEventListener("change", function () {
        list.forEach(function (p) { if (selAll.checked) prSel[p.id] = true; else delete prSel[p.id]; });
        paint();
      });
      Array.prototype.forEach.call(body.querySelectorAll(".pr-check"), function (cb) {
        cb.addEventListener("change", function () {
          var pid = cb.getAttribute("data-pid");
          if (cb.checked) prSel[pid] = true; else delete prSel[pid];
          paint();
        });
      });
      var saveBtn = $("#prSaveList"); if (saveBtn) saveBtn.addEventListener("click", function () { saveSelectedAsList(selIds); });
      var delBtn = $("#prDelSel"); if (delBtn) delBtn.addEventListener("click", function () { deleteSelected(selIds); });
      var clrBtn = $("#prClearSel"); if (clrBtn) clrBtn.addEventListener("click", function () { prSel = {}; paint(); });

      // Expand / collapse a prospect's experience summary (hidden by default).
      Array.prototype.forEach.call(body.querySelectorAll(".pr-exp-toggle"), function (t) {
        t.addEventListener("click", function () {
          var box = body.querySelector("#exp_" + (window.CSS && CSS.escape ? CSS.escape(t.getAttribute("data-exp")) : t.getAttribute("data-exp")));
          if (!box) return;
          var open = box.hasAttribute("hidden");
          if (open) box.removeAttribute("hidden"); else box.setAttribute("hidden", "");
          t.textContent = open ? "Experience ▴" : "Experience ▾";
        });
      });

      // Stage transitions: change the dropdown -> persist via the API.
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

      // Enrich a prospect's outreach contact (company email + phone), cheapest-first.
      Array.prototype.forEach.call(body.querySelectorAll(".pr-enrich"), function (btn) {
        btn.addEventListener("click", function () {
          var pid = btn.getAttribute("data-enrich");
          var researching = /Find hiring manager/.test(btn.textContent);
          var old = btn.textContent; btn.disabled = true; btn.textContent = researching ? "Researching…" : "Enriching…";
          send("/prospects", "POST", { action: "enrich", prospectId: pid }).then(function (r) {
            if (r.ok) {
              var f = (r.data && r.data.found) || {};
              var pr = (r.data && r.data.prospect) || {};
              var bits = [];
              if (f.name) bits.push("hiring manager: " + (pr.fullName || "name"));
              if (f.email) bits.push("email");
              if (f.phone) bits.push("phone");
              toast(bits.length ? ("Found " + bits.join(" + "))
                : (researching ? "Couldn’t resolve a name yet — connect a LinkedIn account (Accounts → LinkedIn) so it can research the manager."
                  : "No new contact found — add a provider under Connected, or enter manually."));
              load();
            } else { btn.disabled = false; btn.textContent = old; toast("Could not enrich (" + (r.data.error || r.status) + ")"); }
          }).catch(function () { btn.disabled = false; btn.textContent = old; toast("Could not reach the server."); });
        });
      });
    }

    function load() {
      api("/prospects").then(function (d) {
        prAll = (d && d.prospects) || [];
        prLifecycle = (d && d.lifecycle) || REF.lifecycle;
        paint();
      }).catch(function () { var b = $("#prBody"); if (b) b.innerHTML = needsSetup(); });
      // Populate the Saved searches dropdown (local cache first, then merge server).
      refreshSavedDropdown();
      api("/prospect-lists?motion=" + encodeURIComponent(motion)).then(function (d) {
        var server = (d && d.lists) || [];
        if (!server.length) return;
        try { localStorage.setItem("ros_prospect_lists", JSON.stringify(server.concat(listStore().all().filter(function (l) { return !server.some(function (s) { return s.id === l.id; }); })))); } catch (e) {}
        refreshSavedDropdown();
      }).catch(function () {});
    }

    /* ---- saved prospect lists (named audiences) ---- */
    function listStore() {
      function all() { try { return JSON.parse(localStorage.getItem("ros_prospect_lists") || "[]"); } catch (e) { return []; } }
      return {
        all: all,
        save: function (l) {
          var arr = all().filter(function (x) { return x.id !== l.id; }); arr.unshift(l);
          localStorage.setItem("ros_prospect_lists", JSON.stringify(arr));
          send("/prospect-lists", "PUT", l).catch(function () {});
        },
        remove: function (id) {
          localStorage.setItem("ros_prospect_lists", JSON.stringify(all().filter(function (x) { return x.id !== id; })));
          fetch(API + "/prospect-lists?id=" + encodeURIComponent(id), { method: "DELETE", credentials: "include" }).catch(function () {});
        }
      };
    }
    function saveSelectedAsList(ids) {
      if (!ids.length) return;
      var name = prompt("Name this list (" + ids.length + " prospect" + (ids.length === 1 ? "" : "s") + "):");
      if (!name) return;
      var list = { id: "plist_" + Date.now(), name: name.trim(), prospectIds: ids.slice(), motion: motion === "bd" ? "bd" : "recruiting", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      listStore().save(list);
      refreshSavedDropdown();   // surface it in the Saved searches dropdown immediately
      toast('Saved "' + list.name + '" · ' + ids.length + " prospect" + (ids.length === 1 ? "" : "s"));
    }
    function deleteSelected(ids) {
      if (!ids.length) return;
      if (!confirm("Delete " + ids.length + " prospect" + (ids.length === 1 ? "" : "s") + " from your pipeline? This can't be undone.")) return;
      send("/prospects", "POST", { action: "delete", ids: ids }).then(function (r) {
        if (r.ok) { toast("Deleted " + (r.data.deleted != null ? r.data.deleted : ids.length) + " prospect(s)"); prSel = {}; load(); }
        else toast("Could not delete (" + (r.data.error || r.status) + ")");
      }).catch(function () { toast("Could not reach the server."); });
    }
    function openListsModal() {
      openModal("Saved prospect lists", "Pull these up in Campaign Studio to assign as a campaign's audience.",
        '<div id="plBody">' + loading() + '</div><div class="modal-foot"><button class="btn btn-ghost btn-sm" data-x>Close</button></div>',
        function (rootEl, close) {
          rootEl.querySelector("[data-x]").addEventListener("click", close);
          function paintLists(lists) {
            var host = rootEl.querySelector("#plBody"); if (!host) return;
            if (!lists.length) { host.innerHTML = '<div class="empty">No saved lists yet. Select prospects and click “Save as list”.</div>'; return; }
            host.innerHTML = lists.map(function (l) {
              return '<div class="integ"><span class="dot3" style="background:var(--brand-2)"></span><div class="meta"><b>' + esc(l.name) + "</b><small>" + (l.prospectIds || []).length + " prospects · " + esc(l.motion || "recruiting") + "</small></div>" +
                '<button class="btn btn-ghost btn-sm" data-del-list="' + esc(l.id) + '">Delete</button></div>';
            }).join("");
            Array.prototype.forEach.call(host.querySelectorAll("[data-del-list]"), function (b) {
              b.addEventListener("click", function () { if (!confirm("Delete this list? (The prospects themselves are not deleted.)")) return; listStore().remove(b.getAttribute("data-del-list")); loadLists(); });
            });
          }
          function loadLists() {
            paintLists(listStore().all());
            api("/prospect-lists?motion=" + encodeURIComponent(motion)).then(function (d) {
              var server = (d && d.lists) || [];
              if (server.length) {
                try { localStorage.setItem("ros_prospect_lists", JSON.stringify(server.concat(listStore().all().filter(function (l) { return !server.some(function (s) { return s.id === l.id; }); })))); } catch (e) {}
                paintLists(listStore().all());
              }
            }).catch(function () {});
          }
          loadLists();
        });
    }

    load();
    prospectsReload = load;
  }
  var prospectsReload = null;

  // Bulk-enrich every prospect missing a work email or phone, cheapest-first, in sequence.
  function enrichAllProspects(btn) {
    api("/prospects").then(function (d) {
      var list = ((d && d.prospects) || []).filter(function (p) { return !(p.email && p.phone); });
      if (!list.length) { toast("Every prospect already has an email and phone."); return; }
      btn.disabled = true; var done = 0;
      (function next(i) {
        if (i >= list.length) {
          btn.disabled = false; btn.textContent = "⚡ Enrich all contacts";
          toast("Enriched " + done + " of " + list.length + " prospect" + (list.length === 1 ? "" : "s"));
          if (prospectsReload) prospectsReload();
          return;
        }
        btn.textContent = "Enriching " + (i + 1) + "/" + list.length + "…";
        send("/prospects", "POST", { action: "enrich", prospectId: list[i].id })
          .then(function (r) { var f = r.ok && r.data && r.data.found; if (f && (f.email || f.phone)) done++; next(i + 1); })
          .catch(function () { next(i + 1); });
      })(0);
    }).catch(function () { toast("Could not reach the server."); });
  }

  /* ---------------- Campaigns (channel sequence builder) ----------------
     Campaigns is where you AUTHOR the message sequences — one per channel
     (Email / LinkedIn / SMS). Each opens a step-by-step editor modelled on a
     dedicated outreach sequencer: a named sequence, ordered steps with delays,
     merge fields + reusable custom variables, and a live overview. Assigning a
     prospect list and deploying happens in Campaign Studio. */

  var CHANNELS = {
    email: { label: "Email", icon: "✉️", blurb: "Subject + body touches with merge fields and open/click tracking.", unit: "emails" },
    linkedin: { label: "LinkedIn", icon: "🔗", blurb: "Connection requests, messages, InMail, and voice notes.", unit: "touches" },
    sms: { label: "SMS", icon: "💬", blurb: "Short, compliant post-engagement texts.", unit: "texts" }
  };
  var STD_VARS = [
    { key: "first_name", label: "First name" }, { key: "last_name", label: "Last name" },
    { key: "company", label: "Company" }, { key: "title", label: "Job title" },
    { key: "role", label: "Role hiring for" }, { key: "signal", label: "Trigger signal" },
    { key: "sender_name", label: "Your name" }
  ];
  var LI_ACTIONS = [
    { v: "connect", label: "Connection request" }, { v: "message", label: "Message" },
    { v: "inmail", label: "InMail" }, { v: "voice_note", label: "Voice note" }
  ];
  function seqTemplate(channel) {
    if (channel === "email") return [
      { id: sid(), day: 0, tracking: true, subject: "{{role}} at {{company}} — quick idea", body: "Hi {{first_name}},\n\nNoticed {{signal}}. I work with people who'd be a strong fit for the {{role}} role — worth a short call this week?\n\nBest,\n{{sender_name}}" },
      { id: sid(), day: 3, tracking: true, subject: "Re: {{role}}", body: "Following up, {{first_name}} — happy to send a couple of profiles if it's useful." },
      { id: sid(), day: 5, tracking: true, subject: "Should I close the file?", body: "No worries if the timing's off, {{first_name}} — just let me know and I'll step back." }
    ];
    if (channel === "linkedin") return [
      { id: sid(), day: 0, action: "connect", text: "" },
      { id: sid(), day: 2, action: "message", text: "Thanks for connecting, {{first_name}}! Reaching out about {{signal}} — open to a quick chat?" },
      { id: sid(), day: 5, action: "message", text: "Circling back in case this got buried — happy to share details whenever works." }
    ];
    return [
      { id: sid(), day: 0, text: "Hi {{first_name}}, it's {{sender_name}} following up on {{role}} at {{company}}. Got 10 min this week? Reply STOP to opt out." }
    ];
  }
  function sid() { return "s_" + Math.random().toString(36).slice(2, 9); }

  // Sequence persistence: server is the source of truth, localStorage is a fast
  // mirror so the list paints instantly and survives offline (same pattern as
  // the Studio store).
  function seqStore() {
    function all() { try { return JSON.parse(localStorage.getItem("ros_sequences") || "[]"); } catch (e) { return []; } }
    return {
      all: all,
      save: function (s) {
        var l = all().filter(function (x) { return x.id !== s.id; }); l.unshift(s);
        localStorage.setItem("ros_sequences", JSON.stringify(l));
        send("/sequences", "PUT", s).catch(function () {});
      },
      remove: function (id) {
        localStorage.setItem("ros_sequences", JSON.stringify(all().filter(function (x) { return x.id !== id; })));
        fetch(API + "/sequences?id=" + encodeURIComponent(id), { method: "DELETE", credentials: "include" }).catch(function () {});
      }
    };
  }

  var cmpEdit = null; // null = home; else the sequence object being edited

  function renderCampaigns(el) {
    if (cmpEdit) { renderSeqEditor(el, cmpEdit); return; }
    renderSeqHome(el);
  }

  function seqDuration(s) { return (s.steps || []).reduce(function (a, st) { return a + (parseInt(st.day, 10) || 0); }, 0); }

  function renderSeqHome(el) {
    var store = seqStore();
    var cards = Object.keys(CHANNELS).map(function (ch) {
      var c = CHANNELS[ch];
      var n = store.all().filter(function (s) { return s.channel === ch && s.motion === motion; }).length;
      return '<button class="seq-new" data-new="' + ch + '"><span class="seq-new-ic">' + c.icon + "</span>" +
        '<span class="seq-new-t">' + c.label + " sequence</span>" +
        '<span class="seq-new-b">' + esc(c.blurb) + "</span>" +
        '<span class="seq-new-f">' + (n ? n + " saved · " : "") + "＋ New " + c.label + " sequence</span></button>";
    }).join("");

    el.innerHTML = head("Campaigns",
      "Build your outreach sequences here — one per channel. Pick a channel to create the message steps; assign prospects and deploy from Campaign Studio.") +
      '<div class="seq-new-grid">' + cards + "</div>" +
      '<div class="v-head" style="margin-top:8px"><h2 style="font-size:16px">Your sequences</h2></div>' +
      '<div id="seqList">' + loading() + "</div>";

    el.querySelector(".seq-new-grid").addEventListener("click", function (e) {
      var b = e.target.closest("[data-new]"); if (!b) return;
      openEditor(newSequence(b.getAttribute("data-new")));
    });

    paintList();

    function paintList() {
      // Local mirror first, then reconcile with the server.
      render(store.all());
      api("/sequences?motion=" + encodeURIComponent(motion)).then(function (d) {
        var server = (d && d.sequences) || [];
        if (server.length) {
          // Server wins; refresh the local mirror so both stay in sync.
          try { localStorage.setItem("ros_sequences", JSON.stringify(server.concat(store.all().filter(function (l) { return !server.some(function (s) { return s.id === l.id; }); })))); } catch (e) {}
          render(store.all());
        }
      }).catch(function () {});
    }

    function render(list) {
      var lb = $("#seqList"); if (!lb) return;
      var mine = list.filter(function (s) { return s.motion === motion; });
      if (!mine.length) { lb.innerHTML = '<div class="empty">No sequences yet. Pick a channel above to create your first one.</div>'; return; }
      lb.innerHTML = mine.map(function (s) {
        var c = CHANNELS[s.channel] || CHANNELS.email;
        var n = (s.steps || []).length;
        return '<div class="seq-row" data-edit="' + esc(s.id) + '"><span class="seq-ic">' + c.icon + "</span>" +
          '<div class="seq-meta"><div class="seq-name">' + esc(s.name) + "</div>" +
          '<div class="seq-sub"><span class="seq-chip ' + s.channel + '">' + c.label + "</span> " + n + " step" + (n === 1 ? "" : "s") + " · " + seqDuration(s) + " day" + (seqDuration(s) === 1 ? "" : "s") + "</div></div>" +
          '<button class="btn btn-ghost btn-sm" data-deploy="' + esc(s.id) + '">Deploy in Studio</button>' +
          '<button class="seq-del" data-del="' + esc(s.id) + '" title="Delete">🗑</button></div>';
      }).join("");
      Array.prototype.forEach.call(lb.querySelectorAll(".seq-row"), function (row) {
        row.addEventListener("click", function (e) {
          if (e.target.closest("[data-del]")) {
            var id = e.target.closest("[data-del]").getAttribute("data-del");
            if (!confirm("Delete this sequence?")) return;
            store.remove(id); toast("Deleted"); paintList(); return;
          }
          if (e.target.closest("[data-deploy]")) { location.hash = "studio"; return; }
          var eid = row.getAttribute("data-edit");
          var seq = store.all().filter(function (x) { return x.id === eid; })[0];
          if (seq) openEditor(seq);
        });
      });
    }
  }

  function newSequence(channel) {
    return { id: "seq_" + Date.now(), channel: channel, name: "New " + (CHANNELS[channel] || {}).label + " sequence",
      motion: motion === "bd" ? "bd" : "recruiting", steps: seqTemplate(channel), tags: [], variables: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), _isNew: true };
  }
  function openEditor(seq) {
    // Work on a deep copy so Cancel discards cleanly.
    cmpEdit = JSON.parse(JSON.stringify(seq));
    render();
  }

  function renderSeqEditor(el, seq) {
    var C = CHANNELS[seq.channel] || CHANNELS.email;
    var lastField = null; // last focused input/textarea, for merge-field insertion

    el.innerHTML =
      '<div class="seq-top">' +
        '<button class="seq-back" id="seqBack">← Sequences</button>' +
        '<span class="seq-edit-lbl">' + (seq._isNew ? "NEW" : "EDIT") + " · " + C.label.toUpperCase() + "</span>" +
        '<div class="seq-top-actions"><button class="btn btn-ghost btn-sm" id="seqDeploy">Assign in Studio</button>' +
        '<button class="btn btn-primary btn-sm" id="seqSave">Save changes</button></div>' +
      "</div>" +
      '<div class="seq-edit-grid">' +
        '<div class="seq-main">' +
          '<input class="seq-title" id="seqTitle" value="' + esc(seq.name) + '" placeholder="Sequence name" />' +
          '<div class="seq-steps-h"><b>Steps</b> <span class="muted" id="seqStepCount"></span></div>' +
          '<div class="seq-enroll">▷ Enrollment starts</div>' +
          '<div id="seqSteps"></div>' +
          '<button class="seq-add" id="seqAdd">＋ Add step</button>' +
        "</div>" +
        '<aside class="seq-rail">' +
          '<div class="rail-card"><div class="rail-h">OVERVIEW</div><div class="rail-stats" id="seqOverview"></div></div>' +
          '<div class="rail-card"><div class="rail-h">TAGS</div><div id="seqTags" class="rail-tags"></div></div>' +
          '<div class="rail-card"><div class="rail-h">CUSTOM VARIABLES <button class="rail-add" id="seqAddVar">＋ Add</button></div>' +
            '<div class="muted" style="font-size:11px;margin:2px 0 8px">Click any field to place your cursor, then click a variable to insert it.</div>' +
            '<div id="seqVars" class="rail-vars"></div></div>' +
          '<div class="rail-card"><div class="rail-h">MERGE FIELDS</div><div id="seqMerge" class="rail-vars"></div></div>' +
        "</aside>" +
      "</div>";

    $("#seqBack").addEventListener("click", function () { cmpEdit = null; render(); });
    $("#seqDeploy").addEventListener("click", function () { saveSeq(true); });
    $("#seqSave").addEventListener("click", function () { saveSeq(false); });
    $("#seqAdd").addEventListener("click", function () {
      var last = seq.steps[seq.steps.length - 1];
      seq.steps.push(seq.channel === "email" ? { id: sid(), day: 3, tracking: true, subject: "", body: "" }
        : seq.channel === "linkedin" ? { id: sid(), day: 2, action: "message", text: "" }
        : { id: sid(), day: 2, text: "" });
      paintSteps();
    });
    $("#seqAddVar").addEventListener("click", function () {
      var label = prompt("What does this variable hold? (e.g. Candidate A sell-in)");
      if (!label) return;
      var n = (seq.variables || []).length + 1;
      seq.variables = seq.variables || [];
      seq.variables.push({ key: "custom_variable" + n, label: label });
      paintVars();
    });

    // Track focus so a merge/variable click inserts at the cursor.
    el.addEventListener("focusin", function (e) {
      if (e.target.matches("input.seq-f, textarea.seq-f")) lastField = e.target;
    });

    paintSteps(); paintVars(); paintMerge(); paintTags(); updateOverview();

    /* ---- steps ---- */
    function paintSteps() {
      var host = $("#seqSteps"); if (!host) return;
      host.innerHTML = seq.steps.map(function (st, i) { return stepCard(st, i); }).join("");
      // wire each step
      Array.prototype.forEach.call(host.querySelectorAll(".seq-step"), function (cardEl) {
        var i = parseInt(cardEl.getAttribute("data-i"), 10);
        cardEl.querySelector("[data-del-step]").addEventListener("click", function () {
          seq.steps.splice(i, 1); paintSteps(); updateOverview();
        });
        var coll = cardEl.querySelector("[data-collapse]");
        if (coll) coll.addEventListener("click", function () { cardEl.classList.toggle("collapsed"); });
        // field bindings
        Array.prototype.forEach.call(cardEl.querySelectorAll("[data-f]"), function (f) {
          var key = f.getAttribute("data-f");
          var ev = (f.type === "checkbox") ? "change" : "input";
          f.addEventListener(ev, function () {
            if (f.type === "checkbox") seq.steps[i][key] = f.checked;
            else seq.steps[i][key] = (key === "day") ? (parseInt(f.value, 10) || 0) : f.value;
            if (key === "day") updateOverview();
            if (key === "text" && seq.channel === "sms") { var cc = cardEl.querySelector("[data-sms-count]"); if (cc) cc.textContent = smsCount(f.value); }
            if (key === "action") paintSteps(); // LinkedIn fields depend on the action
          });
        });
        var mt = cardEl.querySelector("[data-manual]");
        if (mt) mt.addEventListener("click", function () { seq.steps[i].manualSend = !seq.steps[i].manualSend; mt.classList.toggle("on", seq.steps[i].manualSend); });
      });
      var sc = $("#seqStepCount"); if (sc) sc.textContent = "· " + seq.steps.length + " total";
    }

    function stepCard(st, i) {
      var delayLbl = i === 0 ? "days after enrollment" : "days after previous step";
      var head = '<div class="seq-step-h"><span class="seq-grip">≡</span><b>Step ' + (i + 1) + "</b>" +
        '<span class="seq-chip ' + seq.channel + '">' + C.label + "</span>" +
        (seq.channel === "email" ? '<label class="seq-manual"><span class="muted">Manual send</span><button type="button" class="or-sw' + (st.manualSend ? " on" : "") + '" data-manual></button></label>' : "") +
        '<button class="seq-mini" data-collapse title="Collapse">▾</button>' +
        '<button class="seq-mini" data-del-step title="Delete step">🗑</button></div>';
      var delay = '<div class="seq-delay"><label>Delay</label><input class="seq-f seq-day" type="number" min="0" data-f="day" value="' + (st.day || 0) + '" /><span class="muted">' + delayLbl + "</span></div>";
      return '<div class="seq-step" data-i="' + i + '">' + head + '<div class="seq-step-b">' + delay + channelFields(st) + "</div></div>";
    }

    function channelFields(st) {
      if (seq.channel === "email") {
        return fieldLabel("Subject") +
          '<input class="seq-f seq-input" data-f="subject" value="' + esc(st.subject || "") + '" placeholder="Subject line" />' +
          fieldLabel("Body") + bodyToolbar() +
          '<textarea class="seq-f seq-area" data-f="body" rows="7" placeholder="Write your email… use merge fields like {{first_name}}">' + esc(st.body || "") + "</textarea>" +
          '<label class="seq-check"><input class="seq-f" type="checkbox" data-f="tracking"' + (st.tracking ? " checked" : "") + " /> Enable open &amp; click tracking</label>";
      }
      if (seq.channel === "linkedin") {
        var opts = LI_ACTIONS.map(function (a) { return '<option value="' + a.v + '"' + (st.action === a.v ? " selected" : "") + ">" + a.label + "</option>"; }).join("");
        var sel = fieldLabel("Action") + '<select class="seq-f seq-input" data-f="action">' + opts + "</select>";
        if (st.action === "inmail") {
          return sel + fieldLabel("Subject") + '<input class="seq-f seq-input" data-f="subject" value="' + esc(st.subject || "") + '" placeholder="InMail subject" />' +
            fieldLabel("Message") + '<textarea class="seq-f seq-area" data-f="text" rows="6" placeholder="InMail body…">' + esc(st.text || "") + "</textarea>";
        }
        var lbl = st.action === "connect" ? "Connection note (optional)" : st.action === "voice_note" ? "Voice note script" : "Message";
        var ph = st.action === "connect" ? "Short note sent with the request — empty often accepts higher." : "Write your message… merge fields like {{first_name}} work here.";
        return sel + fieldLabel(lbl) + '<textarea class="seq-f seq-area" data-f="text" rows="5" placeholder="' + esc(ph) + '">' + esc(st.text || "") + "</textarea>";
      }
      // sms
      return fieldLabel("Message") +
        '<textarea class="seq-f seq-area" data-f="text" rows="4" placeholder="Short text… keep it under 160 chars. Include an opt-out.">' + esc(st.text || "") + "</textarea>" +
        '<div class="muted" style="font-size:11px;margin-top:4px" data-sms-count>' + smsCount(st.text || "") + "</div>";
    }

    function fieldLabel(t) { return '<div class="seq-flabel">' + esc(t) + ' <button type="button" class="seq-insert" data-insert>{} Insert merge field</button></div>'; }
    function bodyToolbar() {
      return '<div class="seq-toolbar"><button type="button" data-fmt="b"><b>B</b></button><button type="button" data-fmt="i"><i>I</i></button>' +
        '<button type="button" data-fmt="ul">• List</button><button type="button" data-fmt="ol">1. List</button>' +
        '<button type="button" class="seq-insert" data-insert>{} Insert merge field</button></div>';
    }

    /* ---- variables / merge fields ---- */
    function paintVars() {
      var host = $("#seqVars"); if (!host) return;
      var vars = seq.variables || [];
      host.innerHTML = vars.length ? vars.map(function (v) {
        return '<div class="var-chip" data-ins-key="' + esc(v.key) + '"><code>{{' + esc(v.key) + "}}</code><span>" + esc(v.label) + "</span>" +
          '<button class="var-x" data-del-var="' + esc(v.key) + '" title="Remove">×</button></div>';
      }).join("") : '<div class="muted" style="font-size:12px">None yet. Add reusable values like "Candidate A sell-in".</div>';
      Array.prototype.forEach.call(host.querySelectorAll(".var-chip"), function (chip) {
        chip.addEventListener("click", function (e) {
          if (e.target.closest("[data-del-var]")) {
            var k = e.target.closest("[data-del-var]").getAttribute("data-del-var");
            seq.variables = seq.variables.filter(function (v) { return v.key !== k; }); paintVars(); return;
          }
          insertToken(chip.getAttribute("data-ins-key"));
        });
      });
    }
    function paintMerge() {
      var host = $("#seqMerge"); if (!host) return;
      host.innerHTML = STD_VARS.map(function (v) {
        return '<div class="var-chip" data-ins-key="' + v.key + '"><code>{{' + v.key + "}}</code><span>" + esc(v.label) + "</span></div>";
      }).join("");
      Array.prototype.forEach.call(host.querySelectorAll(".var-chip"), function (chip) {
        chip.addEventListener("click", function () { insertToken(chip.getAttribute("data-ins-key")); });
      });
    }
    function paintTags() {
      var host = $("#seqTags"); if (!host) return;
      var tags = seq.tags || [];
      host.innerHTML = tags.map(function (t, i) { return '<span class="tag-chip">' + esc(t) + '<button data-del-tag="' + i + '">×</button></span>'; }).join("") +
        '<button class="tag-add" id="seqAddTag">＋ Add tag</button>';
      var add = $("#seqAddTag");
      if (add) add.addEventListener("click", function () {
        if ((seq.tags || []).length >= 10) { toast("Up to 10 tags."); return; }
        var t = prompt("Tag:"); if (!t) return; seq.tags = (seq.tags || []).concat(t.trim()); paintTags();
      });
      Array.prototype.forEach.call(host.querySelectorAll("[data-del-tag]"), function (b) {
        b.addEventListener("click", function () { seq.tags.splice(parseInt(b.getAttribute("data-del-tag"), 10), 1); paintTags(); });
      });
    }

    function insertToken(key) {
      var token = "{{" + key + "}}";
      if (!lastField) { toast("Click into a subject or body first."); return; }
      var f = lastField, start = f.selectionStart || 0, end = f.selectionEnd || 0, v = f.value;
      f.value = v.slice(0, start) + token + v.slice(end);
      var pos = start + token.length; f.focus(); try { f.setSelectionRange(pos, pos); } catch (e) {}
      f.dispatchEvent(new Event("input", { bubbles: true })); // sync into seq
    }

    function updateOverview() {
      var host = $("#seqOverview"); if (!host) return;
      var dur = seqDuration(seq), n = seq.steps.length;
      var cells = [["DURATION", dur + (dur === 1 ? " day" : " days")], ["STEPS", n]];
      if (seq.channel === "email") {
        cells.push([C.unit.toUpperCase(), seq.steps.length]);
        cells.push(["TASKS", seq.steps.filter(function (s) { return s.manualSend; }).length]);
      } else cells.push([C.unit.toUpperCase(), n]);
      host.innerHTML = cells.map(function (c) { return '<div class="rail-stat"><b>' + c[1] + "</b><span>" + c[0] + "</span></div>"; }).join("");
    }

    // formatting toolbar (basic) — wrap selection / prefix lines in the focused body
    el.addEventListener("click", function (e) {
      var fmt = e.target.closest("[data-fmt]"); if (!fmt) return;
      var f = lastField; if (!f || f.tagName !== "TEXTAREA") { toast("Click into the body first."); return; }
      applyFormat(f, fmt.getAttribute("data-fmt"));
    });

    // Inline "{} Insert merge field" — focus the field this label/toolbar owns,
    // then open a small picker of custom + standard variables.
    el.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-insert]"); if (!btn) return;
      var step = btn.closest(".seq-step"); if (!step) return;
      // The owned field is the next text input/textarea after this button.
      var fields = Array.prototype.slice.call(step.querySelectorAll("input.seq-f, textarea.seq-f"));
      var after = null, seen = false, walker = step.querySelectorAll("*");
      Array.prototype.forEach.call(walker, function (node) {
        if (node === btn) seen = true;
        else if (seen && !after && (node.matches("input.seq-f") || node.matches("textarea.seq-f"))) after = node;
      });
      lastField = after || fields[fields.length - 1];
      if (lastField) { lastField.focus(); }
      openVarMenu(btn, seq.variables || []);
    });

    function openVarMenu(anchor, vars) {
      var old = document.getElementById("seqVarMenu"); if (old) old.remove();
      var menu = document.createElement("div"); menu.id = "seqVarMenu"; menu.className = "seq-varmenu";
      var items = (vars || []).concat(STD_VARS);
      menu.innerHTML = items.map(function (v) { return '<button data-k="' + esc(v.key) + '"><code>{{' + esc(v.key) + "}}</code><span>" + esc(v.label) + "</span></button>"; }).join("");
      document.body.appendChild(menu);
      var r = anchor.getBoundingClientRect();
      menu.style.top = (r.bottom + 4) + "px"; menu.style.left = Math.min(r.left, window.innerWidth - 280) + "px";
      function close() { menu.remove(); document.removeEventListener("click", outside, true); }
      function outside(ev) { if (!menu.contains(ev.target) && ev.target !== anchor) close(); }
      setTimeout(function () { document.addEventListener("click", outside, true); }, 0);
      menu.addEventListener("click", function (ev) { var b = ev.target.closest("[data-k]"); if (!b) return; insertToken(b.getAttribute("data-k")); close(); });
    }

    function saveSeq(toStudio) {
      var title = $("#seqTitle"); if (title) seq.name = (title.value || "").trim() || seq.name;
      if (!seq.steps.length) { toast("Add at least one step."); return; }
      delete seq._isNew;
      seq.updatedAt = new Date().toISOString();
      seqStore().save(seq);
      toast("Sequence saved");
      cmpEdit = null;
      if (toStudio) location.hash = "studio"; else render();
    }
  }

  function smsCount(t) {
    var len = (t || "").length, seg = Math.max(1, Math.ceil(len / 160));
    return len + " chars · " + seg + " segment" + (seg === 1 ? "" : "s");
  }
  function applyFormat(f, kind) {
    var s = f.selectionStart || 0, e = f.selectionEnd || 0, v = f.value, sel = v.slice(s, e);
    var out, caret;
    if (kind === "b" || kind === "i") {
      var w = kind === "b" ? "**" : "_"; out = v.slice(0, s) + w + (sel || "text") + w + v.slice(e); caret = s + w.length + (sel || "text").length + w.length;
    } else {
      var pre = kind === "ul" ? "- " : "1. ";
      var lines = (sel || "item").split("\n").map(function (l) { return pre + l; }).join("\n");
      out = v.slice(0, s) + lines + v.slice(e); caret = s + lines.length;
    }
    f.value = out; f.focus(); try { f.setSelectionRange(caret, caret); } catch (x) {}
    f.dispatchEvent(new Event("input", { bubbles: true }));
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

    function mount(assignees, accounts, sequences, prospectLists) {
      CampaignStudio.mount(root, {
        motion: motion === "bd" ? "bd" : "recruiting",
        embedded: true,
        openId: openId,
        toast: toast,
        assignees: assignees,
        accounts: accounts,
        sequences: sequences,
        prospectLists: prospectLists,
        store: studioStore(),
        sendTestSms: function (to, body, done) {
          send("/sms/send", "POST", { to: to, text: body })
            .then(function (r) { done(r.ok ? "Test SMS sent to " + to : "Could not send. Check SMS setup in Connected."); })
            .catch(function () { done("Could not reach the server."); });
        }
      });
    }

    // Assignees = the workspace team; sending accounts = connected LinkedIn
    // handles; sequences = the named micro-sequences authored under Campaigns,
    // so they can be dropped onto the canvas by name.
    Promise.all([
      api("/team").catch(function () { return null; }),
      api("/accounts").catch(function () { return null; }),
      api("/sequences?motion=" + encodeURIComponent(motion)).catch(function () { return null; }),
      api("/prospect-lists?motion=" + encodeURIComponent(motion)).catch(function () { return null; })
    ]).then(function (res) {
      var members = (res[0] && res[0].members) || [];
      var team = members.map(function (m) { return m.userId === ctx.user.id ? "You" : m.name; });
      var assignees = team.concat(["Round-robin team", "Unassigned"]).filter(function (v, i, a) { return v && a.indexOf(v) === i; });
      if (assignees.length === 0) assignees = ["You", "Unassigned"];
      var li = (res[1] && res[1].linkedin) || [];
      var accounts = li.map(function (a) { return a.handle; }).concat(["auto-rotate"]);
      // Server sequences, merged with the local mirror (covers just-saved ones),
      // scoped to the current motion.
      var server = (res[2] && res[2].sequences) || [];
      var local = []; try { local = JSON.parse(localStorage.getItem("ros_sequences") || "[]"); } catch (e) {}
      var byId = {}; server.concat(local).forEach(function (s) { if (s && s.id && !byId[s.id]) byId[s.id] = s; });
      var sequences = Object.keys(byId).map(function (k) { return byId[k]; })
        .filter(function (s) { return (s.motion === motion) || (!s.motion && motion === "recruiting"); });
      // Saved prospect lists, server + local mirror, scoped to motion.
      var serverL = (res[3] && res[3].lists) || [];
      var localL = []; try { localL = JSON.parse(localStorage.getItem("ros_prospect_lists") || "[]"); } catch (e) {}
      var lById = {}; serverL.concat(localL).forEach(function (l) { if (l && l.id && !lById[l.id]) lById[l.id] = l; });
      var prospectLists = Object.keys(lById).map(function (k) { return lById[k]; })
        .filter(function (l) { return !l.motion || l.motion === motion; });
      mount(assignees, accounts, sequences, prospectLists);
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

  /* ---------------- Outreach (sending readiness control panel) ----------------
     The working interface for everything you need wired before you can send:
     ATS, SMS (TalTxt), the enrichment waterfall + its credit balance, Job
     Search (the white-labelled signal feed), sending domains down to each
     inbox, and the LinkedIn accounts — each with live status, the switch to
     turn it on, and a path to connect what's missing. Talks to /api/outreach. */
  var orSnap = null;       // last /outreach snapshot
  var orPanel = null;      // expanded drill-down: 'domains' | 'linkedin' | null

  function renderOutreach(el) {
    var canInteg = can("integrations:manage");
    var canAts = can("ats:manage");
    var canAcct = can("accounts:manage");

    el.innerHTML = head("Outreach",
      "Your sending readiness in one place. Connect what's missing, watch your domains and LinkedIn warm up, top up enrichment credits, and switch the engine on.") +
      '<div id="orBody">' + loading() + "</div>";

    // One delegated listener for the whole panel — survives repaints.
    $("#orBody").addEventListener("click", function (e) {
      var t;
      if ((t = e.target.closest("[data-toggle]"))) { doToggle(t.getAttribute("data-toggle"), t); return; }
      if ((t = e.target.closest("[data-topup]"))) { topUpModal(); return; }
      if ((t = e.target.closest("[data-connect]"))) { howToModal(t.getAttribute("data-connect")); return; }
      if ((t = e.target.closest("[data-panel]"))) { var p = t.getAttribute("data-panel"); orPanel = (orPanel === p ? null : p); paint(); return; }
      if ((t = e.target.closest("[data-go]"))) {
        var route = t.getAttribute("data-go");
        if (ROUTES[route] && ROUTES[route].cap && !can(ROUTES[route].cap)) { toast("Ask a workspace admin to set this up."); return; }
        location.hash = route; return;
      }
    });

    load();

    function load() {
      api("/outreach?motion=" + encodeURIComponent(motion))
        .then(function (d) { orSnap = d || {}; paint(); })
        .catch(function () { var b = $("#orBody"); if (b) b.innerHTML = needsSetup(); });
    }

    function doToggle(key, btn) {
      if (!canInteg) { toast("Ask a workspace admin to change this."); return; }
      var action = key === "enrichment" ? "toggle-enrichment" : "toggle-jobsearch";
      var nowOn = !btn.classList.contains("on");
      btn.classList.toggle("on", nowOn); // optimistic
      send("/outreach", "POST", { action: action, on: nowOn, motion: motion }).then(function (r) {
        if (r.ok) { orSnap = r.data; paint(); toast((key === "enrichment" ? "Enrichment" : "Job Search") + (nowOn ? " turned on" : " turned off")); }
        else { btn.classList.toggle("on", !nowOn); toast("Could not update (" + (r.data.error || r.status) + ")"); }
      }).catch(function () { btn.classList.toggle("on", !nowOn); toast("Could not reach the server."); });
    }

    function topUpModal() {
      if (!canInteg) { toast("Ask a workspace admin to manage credits."); return; }
      var amts = [1000, 5000, 10000];
      var btns = amts.map(function (a) { return '<button class="btn btn-ghost" data-amt="' + a + '">+ ' + a.toLocaleString() + " credits</button>"; }).join("");
      openModal("Add enrichment credits", "Credits are spent finding work emails and direct dials. They top up instantly for this demo.",
        '<div class="btn-row" style="flex-wrap:wrap;gap:10px">' + btns + "</div>" +
        '<div class="modal-foot"><button class="btn btn-ghost btn-sm" data-x>Close</button></div>',
        function (root, close) {
          root.querySelector("[data-x]").addEventListener("click", close);
          Array.prototype.forEach.call(root.querySelectorAll("[data-amt]"), function (b) {
            b.addEventListener("click", function () {
              b.disabled = true;
              send("/outreach", "POST", { action: "topup-credits", amount: parseInt(b.getAttribute("data-amt"), 10), motion: motion })
                .then(function (r) { if (r.ok) { orSnap = r.data; paint(); toast("Credits added"); close(); } else { b.disabled = false; toast("Could not add credits"); } })
                .catch(function () { b.disabled = false; toast("Could not reach the server."); });
            });
          });
        });
    }

    function howToModal(which) {
      var ats = which === "ats";
      var title = ats ? "Connect your ATS" : "Connect SMS (TalTxt)";
      var sub = ats ? "Loxo is the verified, primary ATS. Every reply, touch, and placement syncs once it's connected."
        : "Add compliant post-engagement texting and opt-outs to your sequences.";
      var steps = ats
        ? ["Open the ATS tab and choose Loxo as your system of record.",
           "Under Accounts → API key, add your Loxo API key (service: Loxo).",
           "Go to Connected and press Test on Loxo until it turns green."]
        : ["Get your TalTxt API key from your TalTxt dashboard.",
           "Under Accounts → API key, add it (service: TalTxt).",
           "Go to Connected and press Test on TalTxt until it turns green."];
      var goRoute = ats ? "ats" : "connected";
      var goCap = ats ? canAts : canInteg;
      var foot = goCap
        ? '<div class="modal-foot"><button class="btn btn-ghost btn-sm" data-x>Close</button><button class="btn btn-primary btn-sm" data-open>' + (ats ? "Open ATS settings" : "Open Connected") + "</button></div>"
        : '<div class="modal-foot"><span class="muted" style="margin-right:auto">You don\'t have access — ask a workspace admin.</span><button class="btn btn-ghost btn-sm" data-x>Close</button></div>';
      openModal(title, sub,
        "<ol class=\"or-steps\">" + steps.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") + "</ol>" + foot,
        function (root, close) {
          root.querySelector("[data-x]").addEventListener("click", close);
          var op = root.querySelector("[data-open]");
          if (op) op.addEventListener("click", function () { close(); location.hash = goRoute; });
        });
    }

    function pill(state) {
      var m = { ready: ["ready", "Ready"], warming: ["warming", "Warming up"], action: ["action", "Action needed"], off: ["off", "Off"] };
      var x = m[state] || m.action;
      return '<span class="or-pill ' + x[0] + '">' + x[1] + "</span>";
    }
    function bar(pct, cls) { return '<div class="or-bar"><span class="' + (cls || "") + '" style="width:' + Math.max(0, Math.min(100, pct || 0)) + '%"></span></div>'; }
    function sw(on, key) { return '<button class="or-sw' + (on ? " on" : "") + '" role="switch" aria-checked="' + (on ? "true" : "false") + '" data-toggle="' + key + '"' + (canInteg ? "" : " disabled title='Admin only'") + "><span></span></button>"; }
    function fmt(n) { return (n || 0).toLocaleString(); }

    function card(opts) {
      // opts: { icon, name, state, body, foot }
      return '<div class="or-card or-' + (opts.state || "action") + '">' +
        '<div class="or-card-h"><span class="or-ic">' + opts.icon + "</span>" +
        '<div class="or-name">' + esc(opts.name) + "</div>" + pill(opts.state) + "</div>" +
        '<div class="or-card-b">' + opts.body + "</div>" +
        (opts.foot ? '<div class="or-card-f">' + opts.foot + "</div>" : "") + "</div>";
    }

    function paint() {
      var body = $("#orBody"); if (!body || !orSnap) return;
      var s = orSnap;
      var pf = s.preflight || { ok: false, blocking: [] };
      var gate = pf.ok
        ? '<div class="or-gate ok">✓ All required tools are green — you can activate ' + esc(motion === "bd" ? "Business Development" : "Recruiting") + " campaigns.</div>"
        : '<div class="or-gate warn">⚠ ' + ((pf.blocking || []).length) + " required tool(s) not ready yet. Connect the cards marked <b>Action needed</b> to activate " + esc(motion === "bd" ? "Business Development" : "Recruiting") + " campaigns.</div>";

      // ATS
      var ats = s.ats || {};
      var atsCard = card({
        icon: "🗂️", name: ats.label || "ATS", state: ats.state,
        body: '<p class="or-detail">' + esc(ats.detail || "") + "</p>",
        foot: ats.connected
          ? '<button class="btn btn-ghost btn-sm" data-go="ats">Manage ATS</button>'
          : '<button class="btn btn-primary btn-sm" data-connect="ats">How to connect</button>'
      });

      // SMS
      var sms = s.sms || {};
      var smsCard = card({
        icon: "💬", name: sms.label || "SMS", state: sms.state,
        body: '<p class="or-detail">' + esc(sms.detail || "") + "</p>",
        foot: sms.connected
          ? '<button class="btn btn-ghost btn-sm" data-go="connected">Manage</button>'
          : '<button class="btn btn-primary btn-sm" data-connect="sms">How to connect</button>'
      });

      // Enrichment + credits
      var en = s.enrichment || {}, cr = en.credits || {};
      var enCard = card({
        icon: "🧪", name: "Enrichment waterfall", state: en.state,
        body: '<p class="or-detail">' + esc(en.detail || "") + "</p>" +
          '<div class="or-credits"><div class="or-credit-top"><b>' + fmt(cr.remaining) + "</b> <span class=\"muted\">/ " + fmt(cr.included) + " credits</span></div>" +
          bar(cr.pct, cr.low ? "warn" : "ok") + "</div>",
        foot: '<div class="or-foot-row"><label class="or-swrap"><span class="muted">' + (en.enabled ? "On" : "Off") + "</span>" + sw(en.enabled, "enrichment") + "</label>" +
          '<button class="btn btn-ghost btn-sm" data-topup' + (canInteg ? "" : " disabled") + ">Top up credits</button></div>"
      });

      // Job Search (white-labelled)
      var js = s.jobSearch || {};
      var jsCard = card({
        icon: "🛰️", name: js.label || "Job Search", state: js.state,
        body: '<p class="or-detail">' + esc(js.detail || "") + "</p>",
        foot: '<label class="or-swrap"><span class="muted">' + (js.enabled ? "On" : "Off") + "</span>" + sw(js.enabled, "jobSearch") + "</label>"
      });

      // Domains
      var dm = s.domains || { list: [] };
      var dmCard = card({
        icon: "📧", name: "Warm sending domains", state: dm.state,
        body: '<p class="or-detail">' + (dm.total
          ? "<b>" + dm.total + "</b> domain" + (dm.total === 1 ? "" : "s") + " · <b>" + (dm.inboxesWarm || 0) + "</b> of " + (dm.inboxesTotal || 0) + " inboxes warm" + (dm.inboxesWarming ? ", " + dm.inboxesWarming + " warming" : "")
          : "No sending domains yet. Add one to start warming inboxes.") + "</p>",
        foot: '<div class="or-foot-row">' +
          (dm.total ? '<button class="btn btn-ghost btn-sm" data-panel="domains">' + (orPanel === "domains" ? "Hide details" : "Manage domains") + "</button>" : "") +
          (canAcct ? '<button class="btn ' + (dm.total ? "btn-ghost" : "btn-primary") + ' btn-sm" data-go="accounts">＋ Add domain</button>' : "") + "</div>"
      });

      // LinkedIn
      var li = s.linkedin || { list: [] };
      var liCard = card({
        icon: "🔗", name: "Warm LinkedIn accounts", state: li.state,
        body: '<p class="or-detail">' + (li.total
          ? "<b>" + li.warmed + "</b> of " + li.total + " warmed" + (li.flagged ? ' · <span style="color:var(--accent-red)">' + li.flagged + " flagged</span>" : "")
          : "No LinkedIn accounts yet. Connect one to start warming it.") + "</p>",
        foot: '<div class="or-foot-row">' +
          (li.total ? '<button class="btn btn-ghost btn-sm" data-panel="linkedin">' + (orPanel === "linkedin" ? "Hide details" : "View accounts") + "</button>" : "") +
          (canAcct ? '<button class="btn ' + (li.total ? "btn-ghost" : "btn-primary") + ' btn-sm" data-go="accounts">＋ Add account</button>' : "") + "</div>"
      });

      var panel = "";
      if (orPanel === "domains") panel = domainsPanel(dm);
      else if (orPanel === "linkedin") panel = linkedinPanel(li);

      body.innerHTML = gate +
        '<div class="or-grid">' + atsCard + smsCard + enCard + jsCard + dmCard + liCard + "</div>" +
        panel + playbook();

      // reflect the on/off label live as the switch is clicked (handled in doToggle repaint)
    }

    function domainsPanel(dm) {
      var rows = (dm.list || []).map(function (d) {
        var hp = d.state === "ready" ? "ready" : d.state === "action" ? "action" : "warming";
        var inboxes = (d.inboxes || []).map(function (ib) {
          var ip = ib.state === "warm" ? "ready" : ib.state === "paused" ? "action" : "warming";
          return '<div class="or-inbox"><span class="or-dot ' + ip + '"></span><span class="or-email">' + esc(ib.email) + "</span>" +
            '<span class="or-mini">' + (ib.state === "warm" ? "Warm" : ib.state === "paused" ? "Paused" : "Warming · " + ib.warmupPct + "%") + "</span>" +
            '<div class="or-bar mini">' + '<span class="' + ip + '" style="width:' + ib.warmupPct + '%"></span></div></div>';
        }).join("");
        return '<div class="or-dom"><div class="or-dom-h"><b>' + esc(d.domain) + "</b>" + pill(d.state) +
          '<span class="or-mini">bounce ' + ((d.bounceRate || 0) * 100).toFixed(1) + "% · " + esc(d.health) + "</span></div>" +
          '<div class="or-inboxes">' + inboxes + "</div></div>";
      }).join("");
      return '<div class="card or-panel"><h3>Sending domains &amp; inboxes</h3>' +
        '<p class="muted" style="margin-top:-4px">Each inbox warms on its own ramp. Keep volume low until every inbox is green; paused inboxes are auto-held when bounce climbs.</p>' +
        (rows || '<div class="empty">No domains.</div>') + "</div>";
    }

    function linkedinPanel(li) {
      var rows = (li.list || []).map(function (a) {
        return '<div class="or-li"><div class="or-li-h"><b>' + esc(a.handle) + "</b>" + pill(a.state) +
          '<span class="or-mini">' + a.warmupPct + "% warmed</span></div>" +
          '<div class="or-bar">' + '<span class="' + (a.state === "ready" ? "ready" : a.state === "action" ? "action" : "warming") + '" style="width:' + a.warmupPct + '%"></span></div>' +
          '<div class="or-mini" style="margin-top:6px">' + (a.limits.connects || 0) + " connects · " + (a.limits.dms || 0) + " DMs · " + (a.limits.profileViews || 0) + " views / day</div>" +
          (a.issue ? '<div class="or-issue">' + esc(a.issue) + "</div>" : "") + "</div>";
      }).join("");
      return '<div class="card or-panel"><h3>LinkedIn accounts</h3>' +
        '<p class="muted" style="margin-top:-4px">Daily limits ramp automatically as each account warms. Flagged accounts are paused until they recover.</p>' +
        (rows || '<div class="empty">No accounts.</div>') + "</div>";
    }

    function playbook() {
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
      return '<details class="or-playbook"><summary>Deployment playbook — 7 phases &amp; the 28-day sequence</summary>' +
        '<div class="two-col" style="margin-top:14px"><div><h3 style="margin-bottom:10px">Deploy a campaign</h3>' + phases + "</div>" +
        '<div><div class="card"><h3>Sequence anatomy (28 days)</h3>' + touches + "</div>" +
        '<div class="card" style="margin-top:14px"><h3>Decision rules</h3><ul class="phase" style="border:0;padding:0;margin:0">' +
        REF.seqRules.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul></div></div></div></details>";
    }
  }

  /* ---------------- LinkedIn Automation ----------------
     Drives the LinkedIn cadence engine from the portal: enroll prospects into
     account-safe sequences, run the cadence on demand, and watch every touch
     (connect, message, follow-up) advance through the daily limits. Talks to
     the session-authed /api/automation façade over the engine. */
  var autoState = null; // last /automation snapshot, so the enroll modal can read it

  function renderAutomation(el) {
    el.innerHTML = head("LinkedIn Automation",
      "Enroll prospects into account-safe LinkedIn cadences. The engine paces every touch, connect, message, accept-triggered follow-up, inside each account's daily limits, and pauses the instant someone replies.") +
      '<div class="btn-row" style="margin-bottom:14px">' +
        '<button class="btn btn-primary btn-sm" id="autoEnroll">＋ Enroll a prospect</button>' +
        '<button class="btn btn-ghost btn-sm" id="autoTick">▶ Run cadence now</button>' +
      "</div>" +
      '<div id="autoBody">' + loading() + "</div>";

    $("#autoEnroll").addEventListener("click", function () { openEnrollModal(); });
    $("#autoTick").addEventListener("click", function () {
      var b = $("#autoTick"); b.disabled = true; b.textContent = "Running…";
      send("/automation", "POST", { action: "tick" }).then(function (r) {
        b.disabled = false; b.textContent = "▶ Run cadence now";
        if (r.ok) { toast("Cadence ran · " + (r.data.processed || 0) + " step(s) processed"); load(); }
        else toast("Could not run cadence (" + (r.data.error || r.status) + ")");
      }).catch(function () { b.disabled = false; b.textContent = "▶ Run cadence now"; toast("Could not reach the server."); });
    });

    // Delegated, attached once: #autoBody persists across reloads, so wiring it
    // inside paint() would stack a fresh handler on every reload.
    $("#autoBody").addEventListener("click", function (e) {
      var go = e.target.closest("[data-go]");
      if (go) { location.hash = go.getAttribute("data-go"); return; }
      var act = e.target.closest("[data-enr-act]"); if (!act) return;
      var id = act.getAttribute("data-enr"), action = act.getAttribute("data-enr-act");
      act.disabled = true;
      send("/automation", "POST", { action: action, enrollmentId: id }).then(function (r) {
        if (r.ok) { toast(action === "stop" ? "Enrollment stopped" : "Enrollment resumed"); load(); }
        else { act.disabled = false; toast("Could not " + action + " (" + (r.data.error || r.status) + ")"); }
      }).catch(function () { act.disabled = false; toast("Could not reach the server."); });
    });

    load();

    function load() {
      api("/automation").then(function (d) { autoState = d || {}; paint(); })
        .catch(function () { var b = $("#autoBody"); if (b) b.innerHTML = needsSetup(); });
    }

    function paint() {
      var body = $("#autoBody"); if (!body) return;
      var s = autoState.stats || {};
      var statCells = [
        ["Connected accounts", s.accounts || 0, "accounts"],
        ["Active enrollments", s.active || 0],
        ["Replied (handed off)", s.replied || 0, "response"],
        ["Completed", s.completed || 0],
        ["Invites/day", s.invitesPerDay || 0, "accounts"]
      ].map(function (k) {
        var go = k[2] && (!ROUTES[k[2]] || !ROUTES[k[2]].cap || can(ROUTES[k[2]].cap)) ? ' data-go="' + k[2] + '"' : "";
        return '<div class="stat' + (go ? " clickable" : "") + '"' + go + '><div class="sv">' + k[1] + '</div><div class="sl">' + esc(k[0]) + "</div></div>";
      }).join("");

      body.innerHTML =
        '<div class="stat-grid" style="margin-bottom:18px">' + statCells + "</div>" +
        '<div class="two-col">' +
          '<div class="card"><h3>Live enrollments</h3>' + enrollmentsHtml() + "</div>" +
          '<div><div class="card"><h3>Sending accounts</h3>' + accountsHtml() + "</div>" +
          '<div class="card" style="margin-top:14px"><h3>Cadences</h3>' + sequencesHtml() + "</div></div>" +
        "</div>" +
        '<div class="card" style="margin-top:18px"><h3>Recent activity</h3>' + eventsHtml() + "</div>";
    }

    function enrollmentsHtml() {
      var list = autoState.enrollments || [];
      if (!list.length) {
        return '<div class="empty">No one enrolled yet. Click ＋ Enroll a prospect to start an account-safe LinkedIn cadence.</div>';
      }
      return list.map(function (e) {
        var step = (e.currentStepOrder || 0) + (e.totalSteps ? " / " + e.totalSteps : "");
        var next = e.status === "active" && e.nextRunAt ? "Next: " + fmtWhen(e.nextRunAt) : autoEnrStatusLabel(e.status);
        var canStop = e.status === "active" || e.status === "paused_replied";
        var btn = canStop
          ? '<button class="resp-btn ghost" data-enr-act="stop" data-enr="' + esc(e.id) + '">Stop</button>'
          : (e.status === "stopped" ? '<button class="resp-btn" data-enr-act="resume" data-enr="' + esc(e.id) + '">Resume</button>' : "");
        return '<div class="list-row"><span class="avatar" style="width:28px;height:28px;font-size:11px;background:' + colorFor(e.prospectName) + '">' + esc(initials(e.prospectName || "?")) + "</span>" +
          '<div><div class="lr-main">' + esc(e.prospectName || e.prospectId) + (e.company ? ' <span class="muted" style="font-weight:400">· ' + esc(e.company) + "</span>" : "") + "</div>" +
          '<div class="lr-sub">' + esc(e.sequenceName || "Sequence") + " · step " + esc(step) + "</div></div>" +
          '<span class="cls cls-' + autoEnrCls(e.status) + '" style="margin-left:auto">' + esc(autoEnrStatusLabel(e.status)) + "</span>" +
          '<div class="lr-right" style="min-width:120px;text-align:right">' + esc(next) + " " + btn + "</div></div>";
      }).join("");
    }

    function accountsHtml() {
      var list = autoState.accounts || [];
      if (!list.length) {
        return '<div class="empty">No LinkedIn sending accounts yet. Connect one under <a href="#accounts">Accounts</a> to enroll prospects.</div>';
      }
      return list.map(function (a) {
        var lim = a.limits || {};
        return '<div class="list-row"><div><div class="lr-main">' + esc(a.displayName) + '</div>' +
          '<div class="lr-sub">' + (lim.invitesPerDay || 0) + " invites · " + (lim.messagesPerDay || 0) + " msgs · " + (lim.profileViewsPerDay || 0) + " views /day</div></div>" +
          '<span class="cls cls-' + autoAcctCls(a.status) + '" style="margin-left:auto">' + esc(a.status) + "</span></div>";
      }).join("");
    }

    function sequencesHtml() {
      var list = autoState.sequences || [];
      if (!list.length) return '<div class="empty">No cadences yet.</div>';
      return list.map(function (sq) {
        var steps = (sq.steps || []).slice().sort(function (a, b) { return a.order - b.order; })
          .map(function (st) { return esc(autoActionLabel(st.action)); }).join(" → ");
        return '<div class="list-row"><div><div class="lr-main">' + esc(sq.name) + '</div>' +
          '<div class="lr-sub">' + steps + "</div></div>" +
          '<div class="lr-right">' + (sq.steps || []).length + " steps</div></div>";
      }).join("");
    }

    function eventsHtml() {
      var list = autoState.events || [];
      if (!list.length) return '<div class="empty">No activity yet. Enroll a prospect, then Run cadence now to fire the first touch.</div>';
      return list.slice(0, 20).map(function (ev) {
        var what = autoKindLabel(ev.kind) + (ev.action ? " · " + autoActionLabel(ev.action) : "");
        return '<div class="list-row"><div class="lr-main">' + esc(what) + "</div>" +
          '<div class="lr-right">' + esc(fmtWhen(ev.at)) + "</div></div>";
      }).join("");
    }

    function openEnrollModal() {
      var st = autoState || {};
      var accts = st.accounts || [], seqs = st.sequences || [], pros = st.prospects || [];
      if (!accts.length) { toast("Connect a LinkedIn account under Accounts first."); location.hash = "accounts"; return; }
      if (!pros.length) { toast("Add a prospect first."); location.hash = "prospects"; return; }
      var prosOpts = pros.map(function (p) {
        var tag = p.enrolled ? " (enrolled)" : (p.hasLinkedin ? "" : " (no LinkedIn URL)");
        return '<option value="' + esc(p.id) + '"' + (p.enrolled ? " disabled" : "") + ">" + esc(p.fullName) + (p.company ? " · " + esc(p.company) : "") + esc(tag) + "</option>";
      }).join("");
      var seqOpts = seqs.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.name) + "</option>"; }).join("");
      var acctOpts = accts.map(function (a) {
        return '<option value="' + esc(a.id) + '"' + (a.status === "ok" || a.status === "warming" ? "" : " disabled") + ">" + esc(a.displayName) + " (" + esc(a.status) + ")</option>";
      }).join("");
      var bodyHtml =
        "<label>Prospect</label><select id=\"enrPros\">" + prosOpts + "</select>" +
        "<label>Cadence</label><select id=\"enrSeq\">" + seqOpts + "</select>" +
        "<label>Sending account</label><select id=\"enrAcct\">" + acctOpts + "</select>" +
        '<div class="imp-preview">The first step runs on the next cadence tick, then the engine paces the rest within this account\'s daily limits.</div>' +
        '<div class="modal-foot"><button class="btn btn-ghost btn-sm" id="enrCancel">Cancel</button>' +
        '<button class="btn btn-primary btn-sm" id="enrGo">Enroll</button></div>';
      openModal("Enroll into a LinkedIn cadence", "Pick who to reach, the cadence, and which account sends.", bodyHtml, function (root, close) {
        root.querySelector("#enrCancel").addEventListener("click", close);
        root.querySelector("#enrGo").addEventListener("click", function () {
          var prospectId = root.querySelector("#enrPros").value;
          var sequenceId = root.querySelector("#enrSeq").value;
          var accountId = root.querySelector("#enrAcct").value;
          if (!prospectId || !sequenceId || !accountId) { toast("Pick a prospect, cadence and account."); return; }
          var go = root.querySelector("#enrGo"); go.disabled = true; go.textContent = "Enrolling…";
          send("/automation", "POST", { action: "enroll", prospectId: prospectId, sequenceId: sequenceId, accountId: accountId })
            .then(function (r) {
              if (r.ok) { toast("Enrolled · cadence starts on the next tick"); close(); load(); }
              else { go.disabled = false; go.textContent = "Enroll"; toast("Could not enroll (" + (r.data.error || r.status) + ")"); }
            }).catch(function () { go.disabled = false; go.textContent = "Enroll"; toast("Could not reach the server."); });
        });
      });
    }
  }

  // enrollment + engine vocabulary, mapped onto the shared classification colors
  function autoEnrCls(s) { var m = { active: "soft_yes", paused_replied: "positive", completed: "unclassified", stopped: "stop", failed: "not_interested" }; return m[s] || "unclassified"; }
  function autoEnrStatusLabel(s) { var m = { active: "Active", paused_replied: "Replied", completed: "Completed", stopped: "Stopped", failed: "Failed" }; return m[s] || s; }
  function autoAcctCls(s) { var m = { ok: "positive", warming: "timing_objection", restricted: "not_interested", disconnected: "stop" }; return m[s] || "unclassified"; }
  function autoActionLabel(a) { var m = { profile_view: "Profile view", endorse: "Endorse", connect: "Connect", message: "Message", inmail: "InMail", voice_note: "Voice note", withdraw_invite: "Withdraw invite" }; return m[a] || a; }
  function autoKindLabel(k) { var m = { step_sent: "Step sent", step_deferred: "Step deferred", step_failed: "Step failed", invite_accepted: "Invite accepted", reply_received: "Reply received", reply_classified: "Reply classified", sequence_completed: "Sequence completed", enrollment_paused: "Paused", enrollment_stopped: "Stopped" }; return m[k] || k; }
  // Compact relative/absolute timestamp for cadence schedule + activity.
  function fmtWhen(iso) {
    if (!iso) return "";
    var t = Date.parse(iso); if (isNaN(t)) return "";
    var diff = t - Date.now(), abs = Math.abs(diff), mins = Math.round(abs / 60000);
    if (mins < 1) return "now";
    var s = mins < 60 ? mins + "m" : mins < 1440 ? Math.round(mins / 60) + "h" : Math.round(mins / 1440) + "d";
    return diff >= 0 ? "in " + s : s + " ago";
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

  /* ---------------- Analytics (signal → placement, live) ---------------- */
  // The operational dashboard the marketing site promises: which signals create
  // meetings, which channels and messages earn replies, which industries and
  // recruiters convert, and the full funnel end to end. Motion-aware: recruiting
  // measures placements, BD measures job orders. Reads /analytics, renders from
  // the local seed when no backend is connected.
  // Stage buckets for the live pipeline funnel. Status vocabularies differ
  // between the local shim (queued/discovery_booked/placed) and the real backend
  // (new/booked/won), so each bucket lists every synonym it should count.
  var FN_CONTACTED = ["in_sequence", "contacted", "replied", "discovery_booked", "booked", "meeting", "won", "placed", "nurture"];
  var FN_REPLIED = ["replied", "discovery_booked", "booked", "meeting", "won", "placed"];
  var FN_MEETING = ["discovery_booked", "booked", "meeting", "won", "placed"];
  var FN_WON = ["won", "placed"];

  // Normalizers that read either response shape (real backend nests under
  // inbound/classification; the local shim is flat).
  function rChannel(p) { return (p.inbound && p.inbound.channel) || p.channel || "other"; }
  function rClass(p) { return (p.classification && p.classification.class) || p.cls || "unclassified"; }

  function renderAnalytics(el) {
    var bd = motion === "bd";
    el.innerHTML = head("Analytics",
      "A live operational view of the whole motion, from signal to " + (bd ? "job order" : "placement") +
      ". KPIs, funnel, channels and appointments are computed from your live workspace; benchmark cards layer in once an analytics source is connected.") +
      '<div class="an-tools" style="display:flex;align-items:center;gap:12px;margin-bottom:14px">' +
        '<span style="display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600">' +
          '<span style="width:8px;height:8px;border-radius:50%;background:var(--accent-green);box-shadow:0 0 0 0 rgba(56,224,166,.6);animation:anPulse 2s infinite"></span>Live</span>' +
        '<span id="anUpdated" class="muted" style="font-size:12px"></span>' +
        '<span style="flex:1"></span>' +
        '<button class="btn btn-ghost btn-sm" id="anRefresh">↻ Refresh</button>' +
      "</div>" +
      '<style>@keyframes anPulse{0%{box-shadow:0 0 0 0 rgba(56,224,166,.55)}70%{box-shadow:0 0 0 7px rgba(56,224,166,0)}100%{box-shadow:0 0 0 0 rgba(56,224,166,0)}}</style>' +
      '<div id="anBody">' + loading() + "</div>";

    // Horizontal bar chart: rows scaled so the largest value fills the track.
    function bars(items, suffix) {
      items = items || [];
      var max = items.reduce(function (mx, it) { return Math.max(mx, it.pct); }, 0) || 1;
      return items.map(function (it) {
        var w = Math.max(Math.round((it.pct / max) * 100), 8);
        return '<div class="bar-row"><span class="blabel">' + esc(it.label) + '</span>' +
          '<span class="btrack"><span class="bfill" style="width:' + w + '%">' + esc(it.pct) + (suffix || "") + "</span></span></div>";
      }).join("") || '<div class="empty">No data yet.</div>';
    }
    // Tag a card title as live-computed or a curated benchmark.
    function tag(kind) {
      return kind === "live"
        ? ' <span style="font-size:10.5px;font-weight:700;color:var(--accent-green);vertical-align:middle">● LIVE</span>'
        : ' <span class="muted" style="font-size:10.5px;font-weight:700;vertical-align:middle">BENCHMARK</span>';
    }
    function notConnected(what) {
      return '<div class="empty">No ' + esc(what) + " yet. Connect an analytics source (or let campaign data accrue) and this fills in.</div>";
    }
    function tally(list, keyFn, labelFn) {
      var counts = {}, total = list.length;
      list.forEach(function (x) { var k = keyFn(x); counts[k] = (counts[k] || 0) + 1; });
      return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).map(function (k) {
        return { label: labelFn ? labelFn(k) : k, pct: total ? Math.round((counts[k] / total) * 100) : 0 };
      });
    }

    var canPros = !ROUTES.prospects.cap || can(ROUTES.prospects.cap);
    var rowGo = canPros ? ' data-go="prospects" class="list-row clickable"' : ' class="list-row"';
    var first = true;

    function load() {
      // Pull live operational data + (optional) curated benchmarks in parallel.
      // Each call degrades to null so one missing endpoint never blanks the page.
      Promise.all([
        api("/overview").catch(function () { return null; }),
        api("/prospects").catch(function () { return null; }),
        api("/response/list").catch(function () { return null; }),
        api("/analytics").catch(function () { return null; })
      ]).then(function (res) {
        var body = $("#anBody"); if (!body) return;
        var ov = res[0] || {};
        var prospects = (res[1] && res[1].prospects) || [];
        var replies = (res[2] && res[2].items) || [];
        var curated = ((res[3] || {})[bd ? "bd" : "recruiting"]) || {};

        if (!ov.activeProspects && !prospects.length && !replies.length) {
          body.innerHTML = needsSetup(); return;
        }

        // KPIs, live from /overview (same shape in shim + real backend).
        var kpiDefs = [
          { v: ov.activeProspects || 0, l: "Active prospects", s: "in sequence now" },
          { v: ov.appointmentsThisWeek || 0, l: "Meetings this week", s: (ov.appointmentsToday || 0) + " booked today" },
          { v: ov.warmConversationsToday || 0, l: "Warm convos today", s: "hot replies in play" },
          { v: ov.wonAccounts || 0, l: bd ? "Won accounts" : "Placements", s: "closed this period" }
        ];
        var kpis = kpiDefs.map(function (k) {
          return '<div class="rstat"><div class="big gradient-text">' + esc(k.v) + '</div><div class="lbl">' + esc(k.l) + "</div>" +
            '<div class="delta up" style="color:var(--text-dim)">' + esc(k.s) + "</div></div>";
        }).join("");

        // Pipeline funnel, live from /prospects (portable status buckets).
        function cnt(set) { return prospects.filter(function (p) { return set.indexOf(p.status) >= 0; }).length; }
        var fn = [
          { label: "Sourced", value: prospects.length },
          { label: "Contacted", value: cnt(FN_CONTACTED) },
          { label: "Replied", value: cnt(FN_REPLIED) },
          { label: "Meetings", value: cnt(FN_MEETING) },
          { label: bd ? "Won accounts" : "Placements", value: cnt(FN_WON) }
        ];
        var top = fn[0].value || 1;
        var funnel = prospects.length ? fn.map(function (s, i) {
          var w = Math.max(Math.round((s.value / top) * 100), 6);
          var conv = i > 0 && fn[i - 1].value ? Math.round((s.value / fn[i - 1].value) * 100) + "%" : "";
          return '<div class="bar-row"><span class="blabel">' + esc(s.label) + '</span>' +
            '<span class="btrack"><span class="bfill" style="width:' + w + '%">' + esc(s.value) + "</span></span>" +
            '<span class="bval">' + esc(conv) + "</span></div>";
        }).join("") : notConnected("pipeline data");

        // Replies by channel + reply-quality mix, live from /response/list.
        var byChannel = replies.length ? bars(tally(replies, rChannel, function (c) { return c === "sms" ? "SMS" : c.charAt(0).toUpperCase() + c.slice(1); }), "%") : notConnected("replies");
        var byQuality = replies.length ? bars(tally(replies, rClass, clsLabel), "%") : notConnected("replies");

        // Curated benchmark cards (no live source): signal types, industries,
        // message variants, recruiter efficiency. Absent against the real backend
        // until an /analytics source is wired — they show a connect hint then.
        var bySignal = (curated.bySignal && curated.bySignal.length) ? bars(curated.bySignal, "%") : notConnected("signal attribution");
        var industries = (curated.industries && curated.industries.length) ? bars(curated.industries, "%") : notConnected("industry data");
        var variants = (curated.variants || []).map(function (v) {
          return '<div class="list-row"><div><div class="lr-main">' + esc(v.name) + '</div><div class="lr-sub">' +
            esc(v.channel || "") + " · " + (v.sent || 0) + " sent</div></div>" +
            '<div class="lr-right">' + esc(v.reply) + "% reply · " + esc(v.meeting) + "% mtg</div></div>";
        }).join("") || notConnected("message variants tested");
        var winLabel = bd ? "job orders" : "placements";
        var recruiters = (curated.recruiters || []).map(function (r) {
          return '<div class="list-row"><span class="avatar" style="background:' + colorFor(r.name) + '">' + esc(initials(r.name)) + "</span>" +
            '<div><div class="lr-main">' + esc(r.name) + '</div><div class="lr-sub">' + (r.meetings || 0) + " meetings · " + (r.replies || 0) + " replies</div></div>" +
            '<div class="lr-right">' + (r.wins || 0) + " " + winLabel + "</div></div>";
        }).join("") || notConnected("per-recruiter output");

        // Recent appointments, live from /overview.
        var appts = (ov.recentAppointments || []).map(function (ap) {
          return "<div" + rowGo + '><div><div class="lr-main">' + esc(ap.name) + '</div><div class="lr-sub">' +
            esc(ap.channel || "") + (ap.company ? " · " + esc(ap.company) : "") + "</div></div>" +
            '<div class="lr-right">' + esc(ap.at || "") + "</div></div>";
        }).join("") || '<div class="empty">No appointments booked yet.</div>';

        body.innerHTML =
          '<div class="report-stats">' + kpis + "</div>" +
          '<div class="report-cols">' +
            '<div class="report-card"><h3>' + (bd ? "Signal → job-order funnel" : "Signal → placement funnel") + tag("live") + "</h3>" + funnel + "</div>" +
            '<div class="report-card"><h3>Replies by channel' + tag("live") + "</h3>" + byChannel + "</div>" +
          "</div>" +
          '<div class="two-col" style="margin-top:16px">' +
            '<div class="card"><h3>Reply quality mix' + tag("live") + "</h3>" + byQuality + "</div>" +
            '<div class="card"><h3>Meetings booked by signal type' + tag("benchmark") + "</h3>" + bySignal + "</div>" +
          "</div>" +
          '<div class="two-col" style="margin-top:16px">' +
            '<div class="card"><h3>Best industries by conversion' + tag("benchmark") + "</h3>" + industries + "</div>" +
            '<div class="card"><h3>Top message variants' + tag("benchmark") + "</h3>" + variants + "</div>" +
          "</div>" +
          '<div class="two-col" style="margin-top:16px">' +
            '<div class="card"><h3>Recruiter efficiency' + tag("benchmark") + "</h3>" + recruiters + "</div>" +
            '<div class="card"><h3>Recent appointments' + tag("live") + "</h3>" + appts + "</div>" +
          "</div>";

        // Delegated navigation: appointment rows jump into the pipeline.
        body.addEventListener("click", function (e) {
          var t = e.target.closest("[data-go]"); if (!t) return;
          location.hash = t.getAttribute("data-go");
        });

        var stamp = $("#anUpdated");
        if (stamp) stamp.textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        first = false;
      }).catch(function () { if (first) { var b = $("#anBody"); if (b) b.innerHTML = needsSetup(); } });
    }

    load();
    var rb = $("#anRefresh"); if (rb) rb.addEventListener("click", load);
    // Auto-refresh every 15s while this view is open; render() clears it on nav.
    viewTimers.push(setInterval(load, 15000));
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
  // CSV/paste import with file upload + explicit column → field mapping. No campaign
  // gate — a holding BD campaign is auto-created on import if none is chosen.
  var IMP_FIELDS = [
    ["", "— Ignore —"], ["fullName", "Full name"], ["firstName", "First name"],
    ["lastName", "Last name"], ["email", "Email"], ["company", "Company"],
    ["title", "Job title"], ["linkedinUrl", "LinkedIn URL"], ["phone", "Phone"]
  ];
  function guessField(header) {
    var h = (header || "").toLowerCase();
    if (/first\s*name|^first$|fname/.test(h)) return "firstName";
    if (/last\s*name|^last$|lname|surname/.test(h)) return "lastName";
    if (/full\s*name|^name$|contact/.test(h)) return "fullName";
    if (/e-?mail/.test(h)) return "email";
    if (/company|organization|org|employer|account/.test(h)) return "company";
    if (/title|role|position|job/.test(h)) return "title";
    if (/linkedin|profile|url/.test(h)) return "linkedinUrl";
    if (/phone|mobile|cell|tel/.test(h)) return "phone";
    return "";
  }

  function importProspects() {
    api("/campaigns").then(function (d) {
      openImpModal(((d && d.campaigns) || []).filter(function (c) { return c.motion === motion; }));
    }).catch(function () { openImpModal([]); });
  }

  function openImpModal(camps) {
    var campField = (camps && camps.length)
      ? '<label>Add to campaign</label><select id="impCamp">' +
          camps.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + "</option>"; }).join("") + "</select>"
      : '<div class="imp-note">Imported prospects go to an auto-created <b>Imported prospects</b> campaign.</div>';
    var bodyHtml =
      campField +
      '<label>Upload a CSV file</label>' +
      '<input id="impFile" type="file" accept=".csv,.tsv,.txt" class="imp-file" />' +
      '<label>…or paste rows (CSV / TSV)</label>' +
      '<textarea id="impText" placeholder="name, email, company, title&#10;Jane Doe, jane@acme.com, Acme, VP Engineering"></textarea>' +
      '<label class="imp-check"><input type="checkbox" id="impHeader" checked> First row is a header</label>' +
      '<div id="impMap" class="imp-map"></div>' +
      '<div class="imp-preview" id="impPrev">Upload a CSV or paste rows, then map each column to a field below.</div>' +
      '<div class="modal-foot"><button class="btn btn-ghost btn-sm" id="impCancel">Cancel</button>' +
      '<button class="btn btn-primary btn-sm" id="impGo">Import</button></div>';

    openModal("Import prospects", "Upload a CSV (or paste), map the columns, and import.", bodyHtml, function (root, close) {
      var ta = root.querySelector("#impText"), prev = root.querySelector("#impPrev");
      var fileEl = root.querySelector("#impFile"), headerEl = root.querySelector("#impHeader");
      var mapEl = root.querySelector("#impMap");
      var mapping = null;    // array of field keys per column, set once columns are known

      function delim(line) { return line.indexOf("\t") >= 0 ? "\t" : ","; }
      function lines() { return ta.value.split(/\r?\n/).map(function (l) { return l.replace(/\s+$/, ""); }).filter(function (l) { return l.trim(); }); }
      function columns() {
        var ls = lines(); if (!ls.length) return [];
        return ls[0].split(delim(ls[0])).map(function (s) { return s.trim(); });
      }

      function renderMap() {
        var cols = columns();
        if (cols.length < 2) { mapEl.innerHTML = ""; mapping = null; refreshPreview(); return; }
        var hdr = headerEl.checked;
        mapping = cols.map(function (c, i) { return hdr ? guessField(c) : ""; });
        // positional fallback default when no header
        if (!hdr) { var pos = ["fullName", "email", "company", "title"]; mapping = cols.map(function (_, i) { return pos[i] || ""; }); }
        mapEl.innerHTML = '<div class="imp-map-title">Map your columns</div>' + cols.map(function (c, i) {
          var sample = hdr ? c : ("col " + (i + 1));
          var opts = IMP_FIELDS.map(function (f) { return '<option value="' + f[0] + '"' + (f[0] === mapping[i] ? " selected" : "") + ">" + esc(f[1]) + "</option>"; }).join("");
          return '<div class="imp-map-row"><span class="imp-col">' + esc(sample) + '</span><select data-col="' + i + '">' + opts + "</select></div>";
        }).join("");
        Array.prototype.forEach.call(mapEl.querySelectorAll("select"), function (sel) {
          sel.addEventListener("change", function () { mapping[parseInt(sel.getAttribute("data-col"), 10)] = sel.value; refreshPreview(); });
        });
      }

      function buildRows() {
        var ls = lines(); if (!ls.length) return [];
        var hdr = headerEl.checked, cols = columns();
        var dataLines = (hdr && cols.length >= 2) ? ls.slice(1) : ls;
        return dataLines.map(function (line) {
          var parts = line.split(delim(line)).map(function (s) { return s.trim(); });
          var row = {};
          if (mapping && cols.length >= 2) {
            mapping.forEach(function (field, i) { if (field && parts[i]) row[field] = parts[i]; });
            if (!row.fullName && (row.firstName || row.lastName)) row.fullName = [row.firstName, row.lastName].filter(Boolean).join(" ");
          } else {
            // single column → treat as full name
            row.fullName = parts[0];
          }
          delete row.firstName; delete row.lastName;
          return row;
        }).filter(function (r) { return r.fullName; });
      }

      function refreshPreview() {
        var n = buildRows().length;
        prev.innerHTML = n ? "Ready to import <b>" + n + "</b> prospect" + (n === 1 ? "" : "s") + "."
          : (columns().length ? "Map at least the name column to import." : "Upload a CSV or paste rows above.");
      }

      ta.addEventListener("input", renderMap);
      headerEl.addEventListener("change", renderMap);
      fileEl.addEventListener("change", function () {
        var f = fileEl.files && fileEl.files[0]; if (!f) return;
        var reader = new FileReader();
        reader.onload = function () { ta.value = String(reader.result || ""); renderMap(); };
        reader.readAsText(f);
      });

      root.querySelector("#impCancel").addEventListener("click", close);
      root.querySelector("#impGo").addEventListener("click", function () {
        var rows = buildRows();
        if (!rows.length) { toast("Nothing to import — map the name column."); return; }
        var sel = root.querySelector("#impCamp");
        var go = root.querySelector("#impGo"); go.disabled = true; go.textContent = "Importing…";
        function send_rows(cid) {
          if (!cid) { toast("Could not prepare a campaign."); go.disabled = false; go.textContent = "Import"; return; }
          rows.forEach(function (r) { r.campaignId = cid; });
          send("/prospects", "POST", { action: "bulk", rows: rows }).then(function (res) {
            if (res.ok) {
              var added = res.data && res.data.added != null ? res.data.added : rows.length;
              var dup = res.data && res.data.deduped ? " (" + res.data.deduped + " already existed)" : "";
              toast("Imported " + added + " prospect" + (added === 1 ? "" : "s") + dup);
              close(); if (prospectsReload) prospectsReload();
            } else { toast("Import failed (" + (res.data.error || res.status) + ")"); go.disabled = false; go.textContent = "Import"; }
          }).catch(function () { toast("Could not reach the server."); go.disabled = false; go.textContent = "Import"; });
        }
        if (sel && sel.value) send_rows(sel.value);
        else resolveBdCampaign(send_rows);
      });
    });
  }

  /* Enrich LinkedIn searches: paste a Sales Navigator / LinkedIn search URL; the
     connected LinkedIn account pulls every matching member into the pipeline
     (name, company, title, profile). Contact data (email / phone / cell) is then
     enriched per-prospect on demand via the ⚡ Enrich button — discovery is free. */
  function importLinkedInSearch() {
    // Load campaigns to offer a target, but NEVER block on it — the URL input must
    // always show. If the user has no campaign, we auto-create one on submit.
    api("/campaigns").then(function (d) {
      var camps = ((d && d.campaigns) || []).filter(function (c) { return c.motion === motion; });
      openLiModal(camps);
    }).catch(function () { openLiModal([]); });
  }

  function openLiModal(camps) {
    var campField = (camps && camps.length)
      ? '<label>Add to campaign</label><select id="liCamp">' +
          camps.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + "</option>"; }).join("") +
        "</select>"
      : '<div class="imp-note" id="liCampNote">New prospects will be added to an auto-created <b>LinkedIn Imports</b> campaign.</div>';
    var extHtml =
      '<div class="li-ext"><div class="li-ext-h">🧩 Pull real profiles with the Chrome extension <span class="li-ext-tag">recommended</span></div>' +
        '<div id="liExtStatus" style="font-size:13px;margin:6px 0">Checking for the extension…</div>' +
        '<div id="liExtActions" class="btn-row" style="margin:8px 0"></div>' +
        '<div class="muted" style="font-size:12px;margin-top:4px">Once connected, run your Sales Navigator search and click <b>Scrape this search</b> in the extension — it pages through slowly and posts every profile (photo, title, company) straight into Prospects.</div>' +
        '<details style="margin-top:8px"><summary style="cursor:pointer;font-size:12.5px;color:var(--text-muted,#aab)">Manual setup (advanced)</summary>' +
          '<div class="li-ext-row" style="margin-top:6px"><label>Ingest token</label><span class="li-copy"><code id="liTok">loading…</code><button class="btn btn-ghost btn-sm" id="liTokCopy">Copy</button></span></div>' +
          '<div class="li-ext-row"><label>Backend URL</label><span class="li-copy"><code id="liBase">loading…</code><button class="btn btn-ghost btn-sm" id="liBaseCopy">Copy</button></span></div>' +
        '</details>' +
      "</div>" +
      '<div class="li-or">— or quick-pull from a URL (needs the extension connected) —</div>';
    var bodyHtml =
      extHtml +
      campField +
      '<label>Sales Navigator or LinkedIn search URL</label>' +
      '<input id="liUrl" type="url" autocomplete="off" placeholder="https://www.linkedin.com/sales/search/people?query=…" />' +
      '<label>Max profiles to pull</label>' +
      '<input id="liLimit" type="number" min="1" max="500" value="100" />' +
      '<div class="imp-preview" id="liPrev">Run a search in Sales Navigator (or regular LinkedIn), copy the URL from the address bar, paste it above, and hit <b>Pull profiles</b>. ' +
      "We'll pull each member into Prospects — then you enrich business email, phone &amp; cell per prospect from the pipeline.</div>" +
      '<div class="modal-foot"><button class="btn btn-ghost btn-sm" id="liCancel">Cancel</button>' +
      '<button class="btn btn-primary btn-sm" id="liGo">Pull profiles</button></div>';

    openModal("Pull LinkedIn profiles", "Use the Chrome extension to scrape a Sales Navigator search into Prospects (recommended), or quick-pull from a URL.", bodyHtml, function (root, close) {
      // Fill the extension token + backend URL (manual fallback) and wire copy buttons.
      var extTokenData = null;
      api("/ext-token").then(function (d) {
        extTokenData = d || {};
        var tok = root.querySelector("#liTok"), base = root.querySelector("#liBase");
        if (tok) tok.textContent = (d && d.token) || "—";
        if (base) base.textContent = (d && d.backendBaseUrl) || (location.origin + "/api/linkedin");
      }).catch(function () {});
      function copyFrom(id, btn) {
        var node = root.querySelector(id); if (!node) return;
        navigator.clipboard.writeText(node.textContent).then(function () { var b = root.querySelector(btn); if (b) { var o = b.textContent; b.textContent = "Copied ✓"; setTimeout(function () { b.textContent = o; }, 1200); } });
      }
      var tc = root.querySelector("#liTokCopy"); if (tc) tc.addEventListener("click", function () { copyFrom("#liTok", "#liTokCopy"); });
      var bc = root.querySelector("#liBaseCopy"); if (bc) bc.addEventListener("click", function () { copyFrom("#liBase", "#liBaseCopy"); });

      // --- one-click extension detect + connect (no copy/paste) ---
      function paintExt() {
        var st = root.querySelector("#liExtStatus"), acts = root.querySelector("#liExtActions");
        if (!st || !acts || !document.body.contains(root)) return;
        if (extState.installed) {
          st.innerHTML = '✅ Extension installed' + (extState.version ? ' <span class="muted">(v' + esc(extState.version) + ")</span>" : "");
          acts.innerHTML = '<button class="btn btn-primary btn-sm" id="liExtConnect">🔗 Connect this workspace</button>';
          root.querySelector("#liExtConnect").addEventListener("click", function () {
            var b = this;
            var token = extTokenData && extTokenData.token;
            if (!token) { toast("Loading your ingest token — try again in a second."); return; }
            b.disabled = true; b.textContent = "Connecting…";
            extConfigure((extTokenData && extTokenData.backendBaseUrl) || (location.origin + "/api/linkedin"), token);
          });
        } else {
          st.innerHTML = "⬇ Extension not detected.";
          acts.innerHTML = (EXT_STORE_URL
            ? '<a class="btn btn-primary btn-sm" href="' + esc(EXT_STORE_URL) + '" target="_blank" rel="noopener">➕ Add to Chrome</a> '
            : '<span class="muted" style="font-size:12.5px">Install it (Chrome → Extensions → Developer mode → Load unpacked → the <code>extension/</code> folder). </span>') +
            '<button class="btn btn-ghost btn-sm" id="liExtRecheck">Re-check</button>';
          var rc = root.querySelector("#liExtRecheck"); if (rc) rc.addEventListener("click", extPing);
        }
      }
      function onExtConfigured(e) {
        if (!document.body.contains(root)) return;
        var c = root.querySelector("#liExtConnect");
        if (e.detail && e.detail.ok) { toast("Extension connected ✅ — searches run here automatically now."); if (c) { c.disabled = true; c.textContent = "✅ Connected"; } }
        else { if (c) { c.disabled = false; c.textContent = "🔗 Connect this workspace"; } toast("Could not connect the extension" + (e.detail && e.detail.error ? " (" + e.detail.error + ")" : ".")); }
      }
      document.addEventListener("ros-ext-present", paintExt);
      document.addEventListener("ros-ext-configured", onExtConfigured);
      paintExt(); extPing();

      var urlEl = root.querySelector("#liUrl"), prev = root.querySelector("#liPrev");
      if (urlEl.focus) try { urlEl.focus(); } catch (e) {}
      function valid() { return /^https?:\/\/(www\.)?linkedin\.com\//i.test((urlEl.value || "").trim()); }
      urlEl.addEventListener("input", function () {
        prev.innerHTML = !urlEl.value.trim()
          ? "Paste a LinkedIn / Sales Navigator search URL above."
          : valid() ? "✓ Ready to pull profiles from this search."
            : "That doesn't look like a linkedin.com URL.";
      });
      root.querySelector("#liCancel").addEventListener("click", close);
      root.querySelector("#liGo").addEventListener("click", function () {
        var url = (urlEl.value || "").trim();
        if (!valid()) { toast("Paste a LinkedIn or Sales Navigator search URL."); urlEl.focus(); return; }
        var limit = parseInt(root.querySelector("#liLimit").value, 10) || 100;
        var sel = root.querySelector("#liCamp");
        var chosen = (sel && sel.value) ? sel.value : null;
        close();   // dismiss the popup right away; progress shows in the Prospects view
        if (chosen) startLinkedInPull(chosen, url, limit);
        else resolveBdCampaign(function (cid) {
          if (!cid) { toast("Could not prepare a campaign."); return; }
          startLinkedInPull(cid, url, limit);
        });
      });
    });
  }

  // Drive the LinkedIn pull with a live progress bar in the Prospects view, then
  // populate the pipeline. (Date.now() is fine here — this is browser code.)
  function startLinkedInPull(cid, url, limit) {
    var box = document.getElementById("liProgress");
    if (!box) { location.hash = "prospects"; box = document.getElementById("liProgress"); }
    if (!box) return;
    var started = Date.now();
    box.innerHTML =
      '<div class="li-prog running"><div class="li-prog-top">' +
        '<span class="li-prog-title">🔗 Pulling LinkedIn profiles…</span>' +
        '<span class="li-prog-meta" id="liProgMeta">target ' + limit + " · 0s</span></div>" +
        '<div class="li-bar"><span class="li-bar-fill indet"></span></div>' +
        '<div class="li-prog-sub">Running your search and adding members to Prospects — this can take a moment.</div></div>';
    var meta = document.getElementById("liProgMeta");
    var tick = setInterval(function () {
      var s = Math.round((Date.now() - started) / 1000);
      if (meta) meta.textContent = "target " + limit + " · " + s + "s";
    }, 1000);
    viewTimers.push(tick);

    send("/prospects", "POST", { action: "linkedin_search", campaignId: cid, url: url, limit: limit }).then(function (res) {
      clearInterval(tick);
      if (res.ok) { finishLinkedInPull(box, (res.data || {}).added || 0, (res.data || {}).deduped || 0); if (prospectsReload) prospectsReload(); }
      else {
        var err = res.data && res.data.error;
        var isUnavail = /^search_unavailable|^search_failed/.test(err || "");
        errorLinkedInPull(box, err === "no_linkedin_account" ? "Connect a LinkedIn account first (Accounts → LinkedIn)."
          : err === "not_a_search_url" ? "That's not a search URL — copy a people-search URL from Sales Navigator/LinkedIn."
          : err === "not_a_linkedin_url" ? "That wasn't a linkedin.com URL."
          : isUnavail ? "No server-side LinkedIn provider is connected, so this URL can't be pulled directly. Use the Chrome extension’s “Scrape this search” button above — it pages through the search slowly and posts real profiles (with photos) straight into Prospects."
          : "Could not pull profiles (" + (err || res.status) + ").");
      }
    }).catch(function () { clearInterval(tick); errorLinkedInPull(box, "Could not reach the server."); });
  }

  function finishLinkedInPull(box, added, deduped) {
    var dup = deduped ? " · " + deduped + " already in pipeline" : "";
    box.innerHTML =
      '<div class="li-prog done"><div class="li-prog-top">' +
        '<span class="li-prog-title">✓ LinkedIn pull complete</span>' +
        '<span class="li-prog-meta"><b id="liCount">0</b> profiles added' + dup + "</span></div>" +
        '<div class="li-bar"><span class="li-bar-fill" style="width:100%"></span></div>' +
        '<div class="li-prog-sub">New prospects are in your pipeline below. <a href="#" id="liDismiss">Dismiss</a></div></div>';
    var el = document.getElementById("liCount"), n = 0, step = Math.max(1, Math.round(added / 30));
    var t = setInterval(function () { n = Math.min(added, n + step); if (el) el.textContent = n; if (n >= added) clearInterval(t); }, 30);
    viewTimers.push(t);
    var dz = document.getElementById("liDismiss");
    if (dz) dz.addEventListener("click", function (e) { e.preventDefault(); box.innerHTML = ""; });
  }

  function errorLinkedInPull(box, msg) {
    box.innerHTML =
      '<div class="li-prog error"><div class="li-prog-top">' +
        '<span class="li-prog-title">⚠ Could not pull profiles</span>' +
        '<a href="#" id="liDismiss" class="li-prog-meta">Dismiss</a></div>' +
        '<div class="li-prog-sub">' + esc(msg) + "</div></div>";
    var dz = document.getElementById("liDismiss");
    if (dz) dz.addEventListener("click", function (e) { e.preventDefault(); box.innerHTML = ""; });
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
  function clsLabel(c) { var m = { positive: "Positive", soft_yes: "Soft yes", referral: "Referral", timing: "Timing", timing_objection: "Timing", fit: "Fit", fit_objection: "Fit", not_interested: "Not interested", stop: "STOP", unclassified: "Review" }; return m[c] || c; }
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
        { n: 1, title: "Infrastructure pre-flight", time: "one-time", done: "Overview capacity strip is green", items: ["≥1 warmed LinkedIn account", "≥5 warmed domains", "Job Search signal feed", "Enrichment waterfall", "ATS connected", "TalTxt + Telnyx 10DLC"] },
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
        { at: "07:30", name: "Enrich", automated: true, detail: "Enrichment waterfall finds work emails and direct dials." },
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
        { id: "rapidapi", label: "Job Search (signal feed)", status: "green", requiredFor: ["bd", "recruiting"] },
        { id: "fresh_linkedin", label: "Profile enrichment", status: "green", requiredFor: ["bd", "recruiting"] },
        { id: "tomba", label: "Email finder", status: "yellow", requiredFor: ["bd"] },
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
    $("#acctName").textContent = name;
    $("#acctEmail").textContent = email;
    $("#acctPlan").textContent = plan;

    function applyImg(dataUrl) {
      [avatar, avatarLg].forEach(function (a) {
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
    document.addEventListener("click", function (e) { if (!acct.contains(e.target)) setOpen(false); });
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
