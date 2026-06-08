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
      // Remember the active motion server-side so LinkedIn scrapes from the
      // Chrome extension land in this bucket (not a fixed one).
      send("/ext-token", "POST", { action: "set-motion", motion: motion }).catch(function () {});
      Array.prototype.forEach.call(document.querySelectorAll(".mt"), function (x) { x.classList.toggle("active", x === b); });
      // If the current view belongs only to the other motion (e.g. Hire Signals is
      // BD-only), leave it for Overview instead of bouncing the motion back.
      var cur = (location.hash || "#overview").replace(/^#/, "").split("/").pop();
      if (ROUTES[cur] && ROUTES[cur].motionOnly && ROUTES[cur].motionOnly !== motion && cur !== "overview") {
        location.hash = "overview";
      }
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
    inmarket: { title: "Hire Signals", crumb: "Operate", action: null, render: renderInMarket, motionOnly: "bd" },
    prospects: { title: "Prospects", crumb: "Operate", action: "＋ Add prospect", render: renderProspects },
    campaigns: { title: "Campaigns", crumb: "Build", action: null, render: renderCampaigns },
    studio: { title: "Campaign Studio", crumb: "Build", action: null, render: renderStudio },
    jdsourcing: { title: "JD Sourcing", crumb: "Build", action: null, render: renderJdSourcing },
    data: { title: "Candidates", crumb: "Build", action: null, render: renderData },
    sending: { title: "Sending", crumb: "Build", action: null, render: renderSending },
    ostext: { title: "OS Text", crumb: "Build", action: null, render: renderOstext },
    voicedrops: { title: "Voice Drops", crumb: "Build", action: null, render: renderVoiceDrops },
    builder: { title: "In-Market Leads", crumb: "Build", action: null, render: renderInMarket, motionOnly: "bd" },
    outreach: { title: "Outreach", crumb: "Build", action: null, render: renderOutreach },
    automation: { title: "LinkedIn Automation", crumb: "Build", action: null, render: renderAutomation },
    content: { title: "Campaign Sequences Library", crumb: "Build", action: "＋ New sequence", render: renderContent },
    analytics: { title: "Analytics", crumb: "Measure", action: null, render: renderAnalytics },
    spending: { title: "Spending", crumb: "Measure", action: null, render: renderSpending, motionOnly: "bd" },
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

  // Recruiting calls them Candidates; BD calls them Prospects.
  function prospectsLabel() { return motion === "recruiting" ? "Candidates" : "Prospects"; }
  function prospectNoun() { return motion === "recruiting" ? "candidate" : "prospect"; }
  // The "data" route is the people warehouse (Candidates) in recruiting, and the
  // book-of-business company list (Companies) in BD.
  function dataLabel() { return motion === "recruiting" ? "Candidates" : "Companies"; }

  // Show/hide motion-specific nav items (Hire Signals is BD-only) and relabel the
  // Prospects/Candidates nav item for the active motion.
  function syncMotionNav() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-motion-only]"), function (el) {
      el.style.display = (el.getAttribute("data-motion-only") === motion) ? "" : "none";
    });
    relabelNav('prospects', prospectsLabel());
    relabelNav('data', dataLabel());
  }
  // Swap a nav item's text label while preserving its leading icon span.
  function relabelNav(route, label) {
    var n = document.querySelector('.nav-item[data-route="' + route + '"]');
    if (!n) return;
    var ni = n.querySelector(".ni");
    n.textContent = "";
    if (ni) n.appendChild(ni);
    n.appendChild(document.createTextNode(" " + label));
  }

  function render() {
    var key = currentRoute();
    if (key !== "campaigns") cmpEdit = null; // leave the sequence editor when navigating away
    var r = ROUTES[key];
    syncMotionNav(); // keep motion-only visibility + Prospects/Candidates label current
    $("#pageTitle").textContent = (key === "prospects") ? prospectsLabel() : (key === "data") ? dataLabel() : r.title;
    $("#crumb").textContent = (ctx.workspace ? ctx.workspace.name + " / " : "") + r.crumb;
    Array.prototype.forEach.call(document.querySelectorAll(".nav-item"), function (n) { n.classList.toggle("active", n.dataset.route === key); });
    var pa = $("#primaryAction");
    if (r.action) { pa.style.display = ""; pa.textContent = (key === "prospects") ? ("＋ Add " + prospectNoun()) : r.action; pa.onclick = function () { primaryAction(key); }; }
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
  var imSelectedIndustries = []; // multi-select industries
  var imSearchTimer = null;      // debounce for chip-driven searches
  var imMinScore = 0;            // narrow-down: minimum hiring-intent score shown
  var imLabel = "";             // current result label, kept for re-renders
  var imTotal = 0;              // total companies available for this query in the pool (grows daily)
  var imStats = null;          // accumulation activity (added today, total, daily log)
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
  // Unique key per hiring-manager option (role + manager title), so the two managers we
  // surface for a role can be selected independently.
  function imMgrKey(m) { return (m && m.role ? m.role : "") + "||" + (m && m.managerTitle ? m.managerTitle : ""); }
  function imFindLead(id) { return inMarketResults.find(function (x) { return x.id === id; }); }
  function imVisibleLeads() { return inMarketResults.filter(function (l) { return Math.round(l.score || 0) >= imMinScore; }); }

  function renderInMarket(el) {
    imPicks = {}; imMinScore = 0; imSelectedSignals = []; imSelectedIndustries = [];
    el.innerHTML =
      '<div class="im-hero">' +
        '<div class="im-bar">' +
          '<h1 class="im-title">Who\'s hiring <span class="gradient-text">right now.</span></h1>' +
          '<div class="im-modes" id="imModes">' +
            '<button type="button" class="im-mode active" data-mode="industry">Industry / market</button>' +
            '<button type="button" class="im-mode" data-mode="company">Company name</button>' +
          "</div>" +
        "</div>" +
        '<form class="im-search" id="imForm">' +
          '<span class="ico">⌕</span>' +
          '<input id="imQuery" type="text" autocomplete="off" placeholder="' + esc(IM_PLACEHOLDER[imMode]) + '" />' +
          '<button type="submit" class="btn btn-primary" id="imSearchBtn">Find companies</button>' +
        "</form>" +
        // Daily import read — populated on open so you see today's intake immediately.
        '<div id="imImportBanner" class="im-import"></div>' +
        // Industries — multi-select with Select all / Clear, in a compact scroll area.
        '<div class="im-group" id="imIndGroup">' +
          '<div class="im-group-head"><span class="im-group-title">Industries</span>' +
            '<button type="button" class="im-mini" data-all="ind">Select all</button>' +
            '<button type="button" class="im-mini" data-clear="ind">Clear</button></div>' +
          '<div class="im-industries im-scroll" id="imIndustries">' +
            IM_INDUSTRIES.map(function (n) { return '<button type="button" class="im-chip" data-ind="' + esc(n) + '">' + esc(n) + "</button>"; }).join("") +
          "</div>" +
        "</div>" +
        // Hiring signals — collapsed by default to de-clutter; Select all / Clear inside.
        '<details class="im-group im-sig-details" id="imSigGroup">' +
          '<summary class="im-group-summary">Hiring signals <span class="muted">— optional filter</span></summary>' +
          '<div class="im-group-head im-group-head-sub">' +
            '<button type="button" class="im-mini" data-all="sig">Select all</button>' +
            '<button type="button" class="im-mini" data-clear="sig">Clear</button></div>' +
          '<div class="im-signals" id="imSignals">' +
            IM_SIGNALS.map(function (s) { return '<button type="button" class="im-sigchip" data-sig="' + esc(s.t) + '">' + esc(s.l) + "</button>"; }).join("") +
          "</div>" +
        "</details>" +
      "</div>" +
      '<div id="imSaved"></div>' +
      '<div id="imBody"><div class="empty">Pick one or more industries (or Select all) to see who\'s hiring, ranked by hiring intent.</div></div>';

    renderSavedSignals();
    loadImportBanner();
    var form = $("#imForm"), input = $("#imQuery");

    function syncChips() {
      Array.prototype.forEach.call(el.querySelectorAll(".im-chip"), function (c) {
        c.classList.toggle("active", imSelectedIndustries.indexOf(c.getAttribute("data-ind")) >= 0);
      });
    }
    function syncSigChips() {
      Array.prototype.forEach.call(el.querySelectorAll(".im-sigchip"), function (c) {
        c.classList.toggle("active", imSelectedSignals.indexOf(c.getAttribute("data-sig")) >= 0);
      });
    }

    // Build the active search from the current selections (multi-industry + signals + box).
    function currentSearch() {
      if (imMode === "company") {
        var cv = input.value.trim();
        return cv ? { criteria: { companyName: cv }, label: cv } : null;
      }
      var crit = {}, labels = [];
      if (imSelectedIndustries.length) {
        crit.industries = imSelectedIndustries.slice();
        labels.push(imSelectedIndustries.length === IM_INDUSTRIES.length ? "all industries"
          : imSelectedIndustries.length === 1 ? imSelectedIndustries[0]
          : imSelectedIndustries.length + " industries");
      }
      var q = input.value.trim();
      if (q) { crit.query = q; labels.push(q); }
      if (imSelectedSignals.length) labels.push(imSelectedSignals.length + " signal" + (imSelectedSignals.length === 1 ? "" : "s"));
      if (!imSelectedIndustries.length && !q && !imSelectedSignals.length) return null;
      return { criteria: crit, label: labels.join(" · ") };
    }
    function runNow() {
      clearTimeout(imSearchTimer);
      var s = currentSearch();
      if (s) runSearch(s.criteria, s.label);
      else $("#imBody").innerHTML = '<div class="empty">Pick one or more industries (or Select all) to see who\'s hiring.</div>';
    }
    function scheduleSearch() { clearTimeout(imSearchTimer); imSearchTimer = setTimeout(runNow, 350); }

    // Search mode toggle: industry/market OR company name.
    Array.prototype.forEach.call(el.querySelectorAll(".im-mode"), function (m) {
      m.addEventListener("click", function () {
        imMode = m.getAttribute("data-mode");
        Array.prototype.forEach.call(el.querySelectorAll(".im-mode"), function (x) { x.classList.toggle("active", x === m); });
        input.value = ""; input.placeholder = IM_PLACEHOLDER[imMode];
        $("#imIndGroup").style.display = (imMode === "industry") ? "" : "none";
        $("#imSigGroup").style.display = (imMode === "industry") ? "" : "none";
        $("#imBody").innerHTML = '<div class="empty">' + (imMode === "industry"
          ? "Pick one or more industries (or Select all) to see who's hiring."
          : "Type a company name to check if they're hiring right now, and who owns the open roles.") + "</div>";
        input.focus();
      });
    });

    form.addEventListener("submit", function (e) { e.preventDefault(); runNow(); });

    // Industry chips: multi-select toggle → debounced search.
    Array.prototype.forEach.call(el.querySelectorAll(".im-chip"), function (c) {
      c.addEventListener("click", function () {
        var ind = c.getAttribute("data-ind");
        var i = imSelectedIndustries.indexOf(ind);
        if (i >= 0) imSelectedIndustries.splice(i, 1); else imSelectedIndustries.push(ind);
        syncChips(); scheduleSearch();
      });
    });
    // Signal chips: multi-select toggle → debounced search.
    Array.prototype.forEach.call(el.querySelectorAll(".im-sigchip"), function (c) {
      c.addEventListener("click", function () {
        var t = c.getAttribute("data-sig");
        var i = imSelectedSignals.indexOf(t);
        if (i >= 0) imSelectedSignals.splice(i, 1); else imSelectedSignals.push(t);
        syncSigChips(); scheduleSearch();
      });
    });
    // Select all / Clear for each group.
    Array.prototype.forEach.call(el.querySelectorAll(".im-mini"), function (b) {
      b.addEventListener("click", function () {
        if (b.getAttribute("data-all") === "ind") imSelectedIndustries = IM_INDUSTRIES.slice();
        else if (b.getAttribute("data-clear") === "ind") imSelectedIndustries = [];
        else if (b.getAttribute("data-all") === "sig") imSelectedSignals = IM_SIGNALS.map(function (s) { return s.t; });
        else if (b.getAttribute("data-clear") === "sig") imSelectedSignals = [];
        syncChips(); syncSigChips(); scheduleSearch();
      });
    });

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
        imTotal = (r.data && typeof r.data.pulled === "number") ? r.data.pulled : inMarketResults.length;
        imStats = (r.data && r.data.stats) || null;
        renderImResults();
      }).catch(function () { body.innerHTML = needsSetup(); });
    }
  }

  // Render the results region: a bulk toolbar (select-all + narrow-down) over the cards.
  function renderImResults() {
    var body = document.getElementById("imBody"); if (!body) return;
    if (!inMarketResults.length) {
      body.innerHTML = '<div class="empty">No in-market companies matched yet. Try another search, or connect more signal sources under <a href="#connected">Connected</a>.</div>' + imTickerHtml();
      wireTicker(body);
      return;
    }
    var leads = imVisibleLeads();
    var bands = [["0", "All"], ["50", "50+"], ["75", "75+"]];
    var toolbar =
      '<div class="im-toolbar">' +
        '<label class="im-checkall"><input type="checkbox" id="imAll"> <b>Select all</b> <span class="muted">companies + managers</span></label>' +
        '<button type="button" class="btn btn-ghost btn-sm" id="imClearSel" style="display:none">Clear</button>' +
        '<span class="im-count">' + leads.length + " shown · <b>" + Math.max(imTotal, inMarketResults.length) + "</b> companies hiring" + (imLabel ? " in " + esc(imLabel) : "") + " <span class=\"muted\">(grows daily)</span></span>" +
        '<div class="im-narrow" title="Narrow by hiring-intent score">' +
          bands.map(function (b) { return '<button type="button" class="im-nbtn' + (String(imMinScore) === b[0] ? " active" : "") + '" data-min="' + b[0] + '">' + b[1] + "</button>"; }).join("") +
        "</div>" +
        '<button class="btn btn-ghost btn-sm" id="imSave" disabled>💾 Save as hiring signals</button>' +
        '<button class="btn btn-primary btn-sm" id="imBulk" disabled>Push selected to Prospects</button>' +
      "</div>";
    body.innerHTML = toolbar + '<div id="imList">' + leads.map(leadCard).join("") + "</div>" + imTickerHtml();
    wireImResults(body);
    wireTicker(body);
    updateImBulk();
  }

  // Pinned bottom-right running feed: how many new hiring companies were added to the
  // pool, by day, and when it last updated. Always renders (shows a "building" state
  // while the pool fills) and is dismissible.
  function imTickerHtml() {
    var s = imStats || { total: 0, addedToday: 0, lastAddedAt: null, days: [] };
    var added = s.addedToday || 0, total = s.total || 0;
    var lastStr = "filling now";
    if (s.lastAddedAt) {
      try { lastStr = new Date(s.lastAddedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch (e) {}
    }
    var log = (s.days || []).map(function (d) {
      var lbl = d.date;
      try { lbl = new Date(d.date + "T00:00:00").toLocaleDateString([], { month: "short", day: "numeric" }); } catch (e) {}
      return '<div class="im-tick-row"><span>' + esc(lbl) + "</span><b>+" + (d.added || 0) + "</b></div>";
    }).join("");
    var main = total > 0
      ? '<b>+' + added + '</b> new companies today · <b>' + total + '</b> in the pool'
      : "Building your hiring pool — first companies land within ~15 min, then it grows daily.";
    return '<div class="im-ticker" id="imTicker">' +
      '<button class="im-ticker-x" id="imTickerX" title="Hide">✕</button>' +
      '<div class="im-ticker-h">📈 Hiring-signal feed <span class="muted">· updates ~90 min</span></div>' +
      '<div class="im-ticker-main">' + main + "</div>" +
      '<div class="im-ticker-sub">Last update: ' + esc(lastStr) + "</div>" +
      (log ? '<div class="im-ticker-log">' + log + "</div>" : "") +
      "</div>";
  }
  function wireTicker(body) {
    var x = body.querySelector("#imTickerX");
    if (x) x.addEventListener("click", function () { var t = body.querySelector("#imTicker"); if (t) t.style.display = "none"; });
  }

  // Prominent daily-import banner at the top of Hire Signals — loads on open so today's
  // intake from the free APIs is visible before you even search.
  function loadImportBanner() {
    api("/in-market").then(function (d) { if (d && d.stats) { imStats = d.stats; renderImportBanner(); } }).catch(function () {});
    renderImportBanner(); // render whatever we have (or the "importing now" state) immediately
  }
  function renderImportBanner() {
    var el = document.getElementById("imImportBanner"); if (!el) return;
    var s = imStats || { total: 0, addedToday: 0, lastAddedAt: null, days: [] };
    var added = s.addedToday || 0, total = s.total || 0;
    var lastStr = "";
    if (s.lastAddedAt) { try { lastStr = " · updated " + new Date(s.lastAddedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } catch (e) {} }
    var log = (s.days || []).slice(0, 5).map(function (d) {
      var lbl = d.date; try { lbl = new Date(d.date + "T00:00:00").toLocaleDateString([], { month: "short", day: "numeric" }); } catch (e) {}
      return '<span class="im-import-day">' + esc(lbl) + " <b>+" + (d.added || 0) + "</b></span>";
    }).join("");
    if (total > 0) {
      el.innerHTML = '<div class="im-import-main">📈 <b>+' + added + '</b> companies imported today from free job APIs · <b>' + total + '</b> in your hiring pool' + esc(lastStr) + "</div>" +
        (log ? '<div class="im-import-log">' + log + "</div>" : "");
    } else {
      el.innerHTML = '<div class="im-import-main">📈 Importing now from the free job APIs — first companies land within ~15 min, then this climbs every day.</div>';
    }
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
        return '<label class="im-mgr"><input type="checkbox" class="im-pick" data-id="' + esc(l.id) + '" data-mk="' + esc(imMgrKey(m)) + '" ' + (imPicks[imPickKey(l.id, imMgrKey(m))] ? "checked" : "") + ">" +
          '<span class="im-mgr-role">' + esc(m.role) + "</span>" +
          '<span class="im-mgr-arrow">→</span>' +
          '<span class="im-mgr-title">' + esc(m.managerTitle) + "</span>" +
          '<span class="im-fn">' + esc(m.function) + "</span>" +
          '<span class="im-mgr-who">' + who + "</span>" +
          (m.why ? '<span class="im-mgr-why" title="Why this owner">' + esc(m.why) + "</span>" : "") + "</label>";
      }).join("");
    } else {
      // No role breakdown: offer the company's buyer / decision-maker as the prospect.
      var who = l.buyerName ? '<b>' + esc(l.buyerName) + "</b>" : '<span class="muted">resolve on push</span>';
      rows = '<label class="im-mgr"><input type="checkbox" class="im-pick" data-id="' + esc(l.id) + '" data-mk="" ' + (imPicks[imPickKey(l.id, "")] ? "checked" : "") + ">" +
        '<span class="im-mgr-role">Decision-maker</span>' +
        '<span class="im-mgr-arrow">→</span>' +
        '<span class="im-mgr-title">' + esc(l.buyerTitle || "Hiring manager") + "</span>" +
        '<span class="im-mgr-who">' + who + "</span></label>";
    }

    var renew = l.renewed
      ? '<div class="im-renew"><div class="im-renew-top">🔥 <b>' + esc(l.renewedReason || "Renewed demand") + "</b> " +
          '<span class="muted">— already taken, but hiring again. Re-engage:</span></div>' +
          '<div class="im-renew-msg">' + esc(l.renewedMessage || "") + "</div>" +
          '<button class="im-renew-copy" data-msg="' + esc(l.renewedMessage || "") + '">Copy follow-up message</button></div>'
      : "";

    var nRoles = mgrs ? mgrs.length : 1;
    // The company checkbox is "checked" when every one of its managers is selected.
    var allChecked = mgrs
      ? mgrs.every(function (m) { return imPicks[imPickKey(l.id, imMgrKey(m))]; })
      : !!imPicks[imPickKey(l.id, "")];
    var anyChecked = mgrs
      ? mgrs.some(function (m) { return imPicks[imPickKey(l.id, imMgrKey(m))]; })
      : !!imPicks[imPickKey(l.id, "")];
    var metaBits = [];
    if (l.headcountBand) metaBits.push(esc(l.headcountBand));
    if (l.location) metaBits.push(esc(l.location));
    metaBits.push(nRoles + " open role" + (nRoles === 1 ? "" : "s"));

    return '<div class="im-lead' + (l.renewed ? " im-lead-renew" : "") + '" data-id="' + esc(l.id) + '">' +
      '<div class="im-lead-head">' +
        '<input type="checkbox" class="im-co-check" data-id="' + esc(l.id) + '"' + (allChecked ? " checked" : "") + ' title="Select this company" />' +
        '<span class="avatar" style="background:' + colorFor(l.company) + '">' + esc(initials(l.company)) + "</span>" +
        '<div class="im-lead-id"><div class="im-lead-name">' + esc(l.company) +
          (l.renewed ? ' <span class="im-renew-badge">🔥 Renewed</span>' : "") +
          (l.industry ? ' <span class="muted" style="font-weight:400">· ' + esc(l.industry) + "</span>" : "") + "</div>" +
        '<div class="im-lead-meta">' + metaBits.join(" · ") + "</div></div>" +
        '<span class="cls cls-' + scoreCls + ' im-score" title="Hiring-intent score">' + score + "</span></div>" +
      '<div class="im-reason">' + esc(l.reason) + src + "</div>" +
      renew +
      '<details class="im-managers-d"' + ((anyChecked || l.aiRefined) ? " open" : "") + '>' +
        '<summary class="im-mgr-summary">👤 ' + nRoles + " hiring manager" + (nRoles === 1 ? "" : "s") + " &amp; open role" + (nRoles === 1 ? "" : "s") +
          (l.aiRefined ? ' <span class="im-ai-tag">🤖 AI-matched</span>' : "") + "</summary>" +
        '<div class="im-managers">' + rows +
          '<button type="button" class="im-ai-refine" data-id="' + esc(l.id) + '">' + (l.aiRefined ? "🤖 Re-run AI match" : "🤖 Refine with AI") + "</button>" +
        "</div></details>" +
      (l.scoreReasons && l.scoreReasons.length ? '<div class="im-lead-reasons">' + l.scoreReasons.slice(0, 3).map(esc).join(" · ") + "</div>" : "") +
      "</div>";
  }

  function wireImResults(body) {
    // Keep a company's header checkbox in sync with its manager rows.
    function syncCoCheck(card) {
      if (!card) return;
      var co = card.querySelector(".im-co-check"); if (!co) return;
      var picks = card.querySelectorAll(".im-pick");
      var checked = card.querySelectorAll(".im-pick:checked").length;
      co.checked = picks.length > 0 && checked === picks.length;
      co.indeterminate = checked > 0 && checked < picks.length;
    }
    // Per-manager selection.
    Array.prototype.forEach.call(body.querySelectorAll(".im-pick"), function (cb) {
      cb.addEventListener("change", function () {
        var id = cb.getAttribute("data-id"), mk = cb.getAttribute("data-mk");
        var lead = imFindLead(id); if (!lead) return;
        var mgr = mk ? (lead.hiringManagers || []).find(function (m) { return imMgrKey(m) === mk; }) : null;
        var key = imPickKey(id, mk);
        if (cb.checked) imPicks[key] = { lead: lead, manager: mgr || null };
        else delete imPicks[key];
        syncCoCheck(cb.closest(".im-lead"));
        updateImBulk();
      });
    });
    // Per-company checkbox: select/clear all of that company's managers at once.
    Array.prototype.forEach.call(body.querySelectorAll(".im-co-check"), function (co) {
      co.addEventListener("change", function () {
        var card = co.closest(".im-lead"); if (!card) return;
        Array.prototype.forEach.call(card.querySelectorAll(".im-pick"), function (cb) {
          if (cb.checked !== co.checked) { cb.checked = co.checked; cb.dispatchEvent(new Event("change")); }
        });
      });
    });
    // Select all / clear — operates directly on imPicks (fast for hundreds of cards),
    // then reflects into every checkbox so it's visibly selected.
    function setAllSelection(on) {
      imVisibleLeads().forEach(function (l) {
        var mgrs = (l.hiringManagers && l.hiringManagers.length) ? l.hiringManagers : null;
        if (mgrs) mgrs.forEach(function (m) {
          var k = imPickKey(l.id, imMgrKey(m));
          if (on) imPicks[k] = { lead: l, manager: m }; else delete imPicks[k];
        });
        else { var k = imPickKey(l.id, ""); if (on) imPicks[k] = { lead: l, manager: null }; else delete imPicks[k]; }
      });
      Array.prototype.forEach.call(body.querySelectorAll(".im-pick"), function (cb) { cb.checked = on; });
      Array.prototype.forEach.call(body.querySelectorAll(".im-co-check"), function (co) { co.checked = on; co.indeterminate = false; });
      updateImBulk();
    }
    var all = body.querySelector("#imAll");
    if (all) all.addEventListener("change", function () { setAllSelection(all.checked); });
    var clr = body.querySelector("#imClearSel");
    if (clr) clr.addEventListener("click", function () { if (all) all.checked = false; setAllSelection(false); });
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
    // AI decision-maker refinement for a single company (on demand, uses the LLM key).
    Array.prototype.forEach.call(body.querySelectorAll(".im-ai-refine"), function (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        var id = btn.getAttribute("data-id");
        var lead = imFindLead(id); if (!lead) return;
        btn.disabled = true; btn.textContent = "🤖 Thinking…";
        var roles = (lead.roles && lead.roles.length) ? lead.roles
          : (lead.hiringManagers || []).map(function (m) { return m.role; }).filter(function (v, i, a) { return v && a.indexOf(v) === i; });
        send("/in-market", "POST", { action: "refine_managers", lead: { company: lead.company, industry: lead.industry, headcountBand: lead.headcountBand, roles: roles } }).then(function (r) {
          if (r.ok && r.data && r.data.hiringManagers && r.data.hiringManagers.length) {
            lead.hiringManagers = r.data.hiringManagers; lead.aiRefined = true;
            Object.keys(imPicks).forEach(function (k) { if (k.indexOf(id + "::") === 0) delete imPicks[k]; });
            var y = window.scrollY; renderImResults(); window.scrollTo(0, y);
            toast("AI matched the decision-makers for " + lead.company);
          } else {
            btn.disabled = false; btn.textContent = "🤖 Refine with AI";
            toast((r.data && r.data.error) === "ai_unavailable" ? "Add ANTHROPIC_API_KEY to enable AI matching." : "Couldn't refine right now.");
          }
        }).catch(function () { btn.disabled = false; btn.textContent = "🤖 Refine with AI"; toast("Could not reach the server."); });
      });
    });
  }

  function updateImBulk() {
    var n = Object.keys(imPicks).length;
    var btn = document.getElementById("imBulk");
    if (btn) { btn.disabled = n === 0; btn.textContent = n ? ("Push " + n + " to Prospects →") : "Push selected to Prospects"; }
    var save = document.getElementById("imSave");
    if (save) { save.disabled = n === 0; save.textContent = n ? ("💾 Save " + n + " as hiring signals") : "💾 Save as hiring signals"; }
    var clr = document.getElementById("imClearSel");
    if (clr) clr.style.display = n ? "" : "none";
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
      '<input id="prSearch" type="text" autocomplete="off" placeholder="Search by name, job title, company, or keyword…" /></div>' +
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
      // Motion bucket: Recruiting and BD pipelines are separate. Legacy prospects
      // with no motion default into Recruiting.
      if ((p.motion || "recruiting") !== motion) return false;
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
      var exp = p.experienceSummary || p.experience || p.summary || "";
      // A "role placeholder" prospect: the hiring manager's real name isn't researched yet.
      var pending = !p.linkedinUrl && (/ [—–] /.test(p.fullName || "") || /hiring manager/i.test(p.fullName || ""));
      var name = pending
        ? esc(p.title || "Hiring manager") + ' <span class="pr-pending">name pending</span>'
        : esc(p.fullName);
      var avatar = '<span class="avatar pr-av" style="position:relative;background:' + colorFor(p.fullName) + '">' + esc(initials(pending ? (p.company || "?") : p.fullName)) +
        (p.photoUrl && !pending ? '<img src="' + esc(p.photoUrl) + '" alt="" onerror="this.remove()" />' : "") + "</span>";
      var expToggle = exp ? ' <button type="button" class="pr-exp-toggle" data-exp="' + esc(p.id) + '">Experience ▾</button>' : "";
      var li = p.linkedinUrl ? '<a class="pr-li" href="' + esc(p.linkedinUrl) + '" target="_blank" rel="noopener" title="View LinkedIn profile">in</a>' : '<span class="pr-na">—</span>';
      var enrichLbl = pending ? "🔎" : (p.email && p.phone) ? "↻" : "⚡";
      var enrichTitle = pending ? "Find hiring manager" : (p.email && p.phone) ? "Re-enrich contact" : "Enrich contact";
      var cell = function (v) { return v ? esc(v) : '<span class="pr-na">—</span>'; };
      var tr = '<tr class="pr-row' + (prSel[p.id] ? " pr-selected" : "") + '" data-pid="' + esc(p.id) + '">' +
        '<td class="pr-c-check"><input type="checkbox" class="pr-check" data-pid="' + esc(p.id) + '"' + (prSel[p.id] ? " checked" : "") + ' /></td>' +
        '<td class="pr-c-name">' + avatar + '<span class="pr-name-t">' + name + expToggle +
          (p.sequenceName ? '<span class="pr-seqtag" title="Assigned sequence">▸ ' + esc(p.sequenceName) + "</span>" : "") + "</span></td>" +
        "<td>" + cell(p.title) + "</td>" +
        "<td>" + cell(p.company) + "</td>" +
        '<td class="pr-c-email">' + (p.email ? '<a href="mailto:' + esc(p.email) + '">' + esc(p.email) + "</a>" : '<span class="pr-na">—</span>') + "</td>" +
        '<td class="pr-c-li">' + li + "</td>" +
        "<td>" + cell(p.phone) + "</td>" +
        "<td>" + cell(p.location) + "</td>" +
        '<td><select class="stage-select cls cls-' + statusCls(p.status) + '" data-pid="' + esc(p.id) + '">' + opts + "</select></td>" +
        '<td class="pr-c-act"><button class="pr-enrich" data-enrich="' + esc(p.id) + '" data-pending="' + (pending ? "1" : "") + '" title="' + enrichTitle + '">' + enrichLbl + "</button></td>" +
        "</tr>";
      if (exp) tr += '<tr class="pr-exp-row" id="exp_' + esc(p.id) + '" hidden><td></td><td colspan="9" class="pr-exp">' + esc(exp) + "</td></tr>";
      return tr;
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
      var statusOpts = '<option value="">Set status…</option>' + lifecycle.map(function (l) {
        return '<option value="' + esc(l.status) + '">' + esc(l[motion] || l.status) + "</option>";
      }).join("");
      var seqs = seqStore().all().filter(function (s) { return (s.motion || "recruiting") === motion; });
      var seqOpts = '<option value="">Assign sequence…</option>' + seqs.map(function (s) {
        var c = (CHANNELS[s.channel] || {}).label || s.channel;
        return '<option value="' + esc(s.id) + '">' + esc(s.name) + " · " + esc(c) + "</option>";
      }).join("");
      var bulk = selIds.length
        ? '<div class="pr-bulk"><span class="pr-selcount">' + selIds.length + " selected</span>" +
            '<span class="pr-bulk-actions">' +
              '<span class="pr-enrich-grp">⚡ Enrich' +
                '<label><input type="checkbox" id="prEnrEmail" checked /> Email</label>' +
                '<label><input type="checkbox" id="prEnrPhone" checked /> Phone</label>' +
                '<button class="btn btn-primary btn-sm" id="prEnrichSel">Run</button></span>' +
              '<select class="pr-bulk-sel" id="prBulkStatus">' + statusOpts + "</select>" +
              '<span class="pr-seq-grp"><select class="pr-bulk-sel" id="prBulkSeq">' + seqOpts + "</select>" +
                '<button class="btn btn-ghost btn-sm" id="prSeqAssign">Assign</button></span>' +
              '<button class="btn btn-ghost btn-sm" id="prSaveList">💾 Save as list</button>' +
              '<button class="btn btn-ghost btn-sm" id="prDelSel">🗑 Delete</button>' +
              '<button class="btn btn-ghost btn-sm" id="prClearSel">Clear</button></span></div>'
        : "";
      var listBanner = prListName
        ? '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;padding:8px 12px;border:1px solid var(--border,#2a2a36);border-radius:10px;font-size:13px;background:rgba(124,92,255,.08)">' +
          '📂 Viewing saved search: <b>' + esc(prListName) + "</b> · " + list.length + " shown" +
          '<button class="btn btn-ghost btn-sm" id="prShowAll" style="margin-left:auto">Show all prospects</button></div>'
        : "";
      var tableHead = '<thead><tr>' +
        '<th class="pr-c-check"><input type="checkbox" id="prSelAll"' + (allOn ? " checked" : "") + ' title="Select all' + (prFilter ? " (filtered)" : "") + '" /></th>' +
        "<th>Name</th><th>Job Title</th><th>Company</th><th>Email</th><th>LinkedIn</th><th>Phone</th><th>Location</th><th>Status</th><th></th></tr></thead>";
      var table = rows
        ? '<div class="pr-table-wrap"><table class="pr-table">' + tableHead + "<tbody>" + rows + "</tbody></table></div>"
        : '<div class="empty">' + (prListName
          ? "This saved search has no matching prospects in your current pipeline."
          : prFilter
          ? "No " + prospectNoun() + "s match “" + esc(prFilter) + "”."
          : "No " + prospectNoun() + "s yet. Import, pull from a LinkedIn search above" + (motion === "recruiting" ? "." : ", or promote from Hire Signals.")) + "</div>";
      body.innerHTML = '<div class="pipe">' + stages + "</div>" +
        '<div class="card" style="padding:0;overflow:hidden"><div class="pr-card-h"><h3>Pipeline <span class="muted" style="font-weight:400;font-size:13px">· ' + countLbl + "</span></h3>" +
        listBanner + bulk + "</div>" + table + "</div>";
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
      var enrSelBtn = $("#prEnrichSel"); if (enrSelBtn) enrSelBtn.addEventListener("click", function () { enrichSelected(selIds, enrSelBtn); });
      var stSel = $("#prBulkStatus"); if (stSel) stSel.addEventListener("change", function () { if (stSel.value) bulkSetStatus(selIds, stSel.value); });
      var seqAssignBtn = $("#prSeqAssign"); if (seqAssignBtn) seqAssignBtn.addEventListener("click", function () {
        var sel = $("#prBulkSeq"); if (!sel || !sel.value) { toast("Pick a sequence to assign."); return; }
        assignSequence(selIds, sel.value, sel.options[sel.selectedIndex].text.split(" · ")[0]);
      });
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
          var researching = btn.getAttribute("data-pending") === "1";
          var old = btn.textContent; btn.disabled = true; btn.textContent = researching ? "…" : "…";
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
    // Bulk-enrich the selected prospects, cheapest-first, one at a time (so we
    // stay within provider rate limits) with live progress on the button.
    // The Email / Phone checkboxes choose which field(s) to enrich individually.
    function enrichSelected(ids, btn) {
      if (!ids.length) return;
      var doEmail = $("#prEnrEmail") ? $("#prEnrEmail").checked : true;
      var doPhone = $("#prEnrPhone") ? $("#prEnrPhone").checked : true;
      if (!doEmail && !doPhone) { toast("Check Email and/or Phone first."); return; }
      var field = (doEmail && doPhone) ? null : (doEmail ? "email" : "phone");
      var total = ids.length, found = 0;
      btn.disabled = true;
      (function next(i) {
        if (i >= total) {
          btn.disabled = false; btn.textContent = "Run";
          toast("Enriched " + found + " of " + total + (field ? " (" + field + ")" : ""));
          load();
          return;
        }
        btn.textContent = (i + 1) + "/" + total + "…";
        var payload = { action: "enrich", prospectId: ids[i] };
        if (field) payload.field = field;
        send("/prospects", "POST", payload)
          .then(function (r) { var f = r.ok && r.data && r.data.found; if (f && (f.email || f.phone || f.name)) found++; next(i + 1); })
          .catch(function () { next(i + 1); });
      })(0);
    }
    // Bulk-set a lifecycle status on the selected prospects.
    function bulkSetStatus(ids, status) {
      if (!ids.length || !status) return;
      send("/prospects", "POST", { action: "bulk-update", ids: ids, status: status }).then(function (r) {
        if (r.ok) { toast("Moved " + (r.data.updated != null ? r.data.updated : ids.length) + " to " + statusLabel(status, prLifecycle)); load(); }
        else toast("Could not update (" + (r.data.error || r.status) + ")");
      }).catch(function () { toast("Could not reach the server."); });
    }
    // Bulk-assign a saved sequence (from the Campaign Sequences Library) to the
    // selected prospects, and move them into the sequence.
    function assignSequence(ids, seqId, seqName) {
      if (!ids.length || !seqId) return;
      send("/prospects", "POST", { action: "bulk-update", ids: ids, sequenceId: seqId, sequenceName: seqName }).then(function (r) {
        if (r.ok) { toast("Assigned " + (r.data.updated != null ? r.data.updated : ids.length) + " to “" + (seqName || "sequence") + "”"); load(); }
        else toast("Could not assign (" + (r.data.error || r.status) + ")");
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
      motion: motion === "bd" ? "bd" : "recruiting", owner: (ctx.user && ctx.user.name) || "You", status: "inactive",
      steps: seqTemplate(channel), tags: [], variables: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), _isNew: true };
  }
  function openEditor(seq) {
    // Work on a deep copy so Cancel discards cleanly. Editor lives on #campaigns,
    // so jump there if we're opening from elsewhere (e.g. the Library).
    cmpEdit = JSON.parse(JSON.stringify(seq));
    if (currentRoute() !== "campaigns") location.hash = "campaigns";
    else render();
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

  /* ---------------- Data ----------------
     The people-data warehouse. Import the CSV you export from the provider's own
     portal (or pull via the official API once a key is configured) -> records land
     here, deduped + persisted -> search/browse manually, enrich email/phone, and
     send to Candidates. Backend: /api/data + lib/data/*. */
  var DATA_FIELDS = [
    ["ignore", "— ignore —"], ["fullName", "Full name"], ["firstName", "First name"],
    ["lastName", "Last name"], ["title", "Job title"], ["company", "Company"],
    ["companyDomain", "Company domain"], ["industry", "Industry"], ["email", "Email"],
    ["email2", "Email (secondary)"], ["phone", "Phone / mobile"], ["directPhone", "Direct phone"],
    ["companyPhone", "Company phone"], ["linkedinUrl", "LinkedIn URL"], ["city", "City"],
    ["state", "State"], ["country", "Country"], ["seniority", "Seniority"],
    ["stage", "Pipeline stage"], ["tags", "Tags / skills"], ["bio", "Notes / summary"],
    ["compensation", "Compensation"], ["owner", "Owner / recruiter"], ["recordType", "Record type"],
    ["origin", "Source / origin"], ["lastActivityAt", "Last activity date"], ["providerId", "Provider id"]
  ];

  // Quote-aware delimited parse -> { headers, rows(objects keyed by header) }.
  function parseDelimited(text) {
    var s = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!s.trim()) return { headers: [], rows: [] };
    var delim = s.indexOf("\t") >= 0 && (s.indexOf("\t") < (s.indexOf(",") < 0 ? 1e9 : s.indexOf(","))) ? "\t" : ",";
    var recs = [], field = "", row = [], inQ = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (inQ) {
        if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === delim) { row.push(field); field = ""; }
      else if (ch === "\n") { row.push(field); recs.push(row); row = []; field = ""; }
      else field += ch;
    }
    if (field.length || row.length) { row.push(field); recs.push(row); }
    recs = recs.filter(function (r) { return r.some(function (c) { return String(c).trim(); }); });
    if (!recs.length) return { headers: [], rows: [] };
    var headers = recs[0].map(function (h) { return String(h).trim(); });
    var rows = recs.slice(1).map(function (r) {
      var o = {}; headers.forEach(function (h, j) { o[h] = (r[j] != null ? String(r[j]).trim() : ""); }); return o;
    });
    return { headers: headers, rows: rows };
  }

  /* ============================ Candidates (Data warehouse) ============================
     Full Loxo-style People view: a faceted left rail, stage tabs with live counts, a
     bulk action toolbar, a select-all header, and a candidate-card feed. All filtering
     is client-side over the loaded set (the warehouse is small + already in memory),
     so tabs/facets/search are instant. Cards render ONLY real fields — never invented
     experience, skills, or stages. */
  var DT_STAGE_ORDER = ["Applied", "Longlist", "Shortlist", "Outbound", "Screening", "Submitted", "Interviewing", "Rejected", "Hired"];
  // Each facet: [field key, label, value-extractor(record) -> string[]].
  var DT_FACETS = [
    ["title", "Title", function (r) { return r.title ? [r.title] : []; }],
    ["company", "Company", function (r) { return r.company ? [r.company] : []; }],
    ["location", "Location", function (r) { var v = [r.city, r.state].filter(Boolean).join(", "); return v ? [v] : []; }],
    ["owner", "Owner", function (r) { return r.owner ? [r.owner] : []; }],
    ["origin", "Source", function (r) { return r.origin ? [r.origin] : []; }],
    ["recordType", "Type", function (r) { return r.recordType ? [r.recordType] : []; }],
    ["stage", "Job Stage", function (r) { return r.stage ? [r.stage] : []; }],
    ["tags", "Tags", function (r) { return Array.isArray(r.tags) ? r.tags : []; }]
  ];

  // ---- BD "Companies" — book-of-business CRM list (Crelate-style) -------------
  // Seeded from the Lume Search Partners company export. No backend store yet, so
  // rows live in-memory; Add Company persists for the session only. Real attributes
  // only — Jobs is 0 until wired to an openings count (we never fabricate counts).
  function renderCompanies(el) {
    var SEED = [
      ["Arbor Infusion", "https://arborinfusion.com/", "", "Josh Gurin", "5/27/2026"],
      ["CFO Squad LLC", "", "", "Josh Gurin", "11/3/2025"],
      ["David Lawrence Centers", "", "", "Josh Gurin", "11/30/2025"],
      ["Deepgram", "", "", "Josh Gurin", "6/4/2026"],
      ["Eastern Healthcare Group", "ehg.care", "Clifton, NJ", "Noah Wilkowski", "5/26/2026"],
      ["Everest", "", "", "Josh Gurin", "12/4/2025"],
      ["Everest Reinsurance Company", "", "", "Josh Gurin", "12/4/2025"],
      ["Everside Capital Partners", "", "", "Josh Gurin", "6/3/2026"],
      ["Family Office", "", "", "Josh Gurin", "11/4/2025"],
      ["Garden Springs Healthcare", "gardenspringshc.com", "Cleveland, OH", "Noah Wilkowski", "6/3/2026"],
      ["JonesTrading", "", "", "Noah Wilkowski", "6/1/2026"],
      ["MDManage", "mdmanage.com", "", "Noah Wilkowski", "5/26/2026"],
      ["Mitek Systems", "", "", "Josh Gurin", "5/26/2026"],
      ["Paragon Management SNF, LLC", "paragonmanagementsnf.com", "City of Glen Cove, NY", "Noah Wilkowski", "5/26/2026"],
      ["Piping Rock Health Products", "", "", "Josh Gurin", "12/25/2025"],
      ["Ralph Lauren", "", "", "Josh Gurin", "11/16/2025"],
      ["Ramp", "", "", "Josh Gurin", "10/31/2025"],
      ["Sunshine Lighting", "sunshinelighting.com", "Brooklyn, NY", "Noah Wilkowski", "6/3/2026"],
      ["Teachers Federal Credit Union", "", "", "Ariel Grosser", "5/1/2026"],
      ["Templeton & Company", "", "", "Josh Gurin", "1/2/2026"],
      ["The Perfect Child ABA", "http://tpcaba.com", "", "Josh Gurin", "4/17/2026"],
      ["Therapy Management Solutions", "https://therapyms.com/", "", "Josh Gurin", "5/26/2026"],
      ["Wunderkind", "", "", "Josh Gurin", "6/1/2026"],
      ["iCapital", "", "", "Josh Gurin", "12/23/2025"],
      ["reap", "https://getreap.com/", "", "Josh Gurin", "6/8/2026"]
    ];
    // Status tabs mirror the CRM pipeline; tabs are functional — set a company's
    // status from the bulk bar and it moves under the matching tab.
    var TABS = [
      ["total", "Total"], ["in_progress", "In Progress"], ["active_opportunity", "Active Opportunity"],
      ["current_client", "Current Client"], ["dead_opportunity", "Dead Opportunity"],
      ["do_not_prospect", "Do Not Prospect"], ["uncontacted", "Uncontacted"]
    ];
    // Columns the table renders (Jobs/Type/Tags aren't sortable).
    var COLS = [
      { key: "name", label: "Name", sort: true }, { key: "jobs", label: "Jobs", sort: false },
      { key: "url", label: "URL", sort: true }, { key: "location", label: "Location", sort: true },
      { key: "owner", label: "Creator", sort: true }, { key: "created", label: "Created Date", sort: true },
      { key: "type", label: "Company Type", sort: false }, { key: "tags", label: "Tags", sort: false }
    ];
    var GRAD = ["#7c5cff,#4dd0ff", "#ff7ac6,#7c5cff", "#4dd0ff,#38e0a6", "#ffc24d,#ff7ac6", "#38e0a6,#4dd0ff", "#ff6b6b,#ffc24d"];

    // Persistence: no backend store yet, so tags, status, added rows and deletions
    // survive in localStorage keyed by company name. SEED stays the source of truth
    // for base rows; we persist only user-contributed overrides.
    var STORE_KEY = "ros_companies_v1";
    var store = (function () { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; } })();
    var meta = store.meta || {}, deleted = store.deleted || [];
    var companies = [];
    SEED.forEach(function (r) {
      if (deleted.indexOf(r[0]) >= 0) return;
      var m = meta[r[0]] || {};
      companies.push({ name: r[0], url: r[1], location: r[2], owner: r[3], created: r[4], type: "Client", status: m.status || "", jobs: 0, tags: (m.tags || []).slice(), added: false });
    });
    (store.added || []).forEach(function (a) {
      companies.unshift({ name: a.name, url: a.url || "", location: a.location || "", owner: a.owner || "You", created: a.created || "", type: a.type || "Client", status: a.status || "", jobs: 0, tags: (a.tags || []).slice(), added: true });
    });
    function persist() {
      var m = {};
      companies.forEach(function (c) {
        if (c.added) return;
        if ((c.tags && c.tags.length) || c.status) m[c.name] = { tags: c.tags, status: c.status };
      });
      var added = companies.filter(function (c) { return c.added; }).map(function (c) {
        return { name: c.name, url: c.url, location: c.location, owner: c.owner, created: c.created, type: c.type, status: c.status, tags: c.tags };
      });
      try { localStorage.setItem(STORE_KEY, JSON.stringify({ meta: m, added: added, deleted: deleted })); } catch (e) {}
    }

    var state = { q: "", tab: "total", sel: {}, tags: [], sort: { key: null, dir: 1 } };

    function findByName(n) { for (var i = 0; i < companies.length; i++) if (companies[i].name === n) return companies[i]; return null; }
    function selected() { return companies.filter(function (c) { return state.sel[c.name]; }); }
    function initials(name) {
      var p = String(name || "").trim().split(/\s+/).filter(Boolean);
      return ((p.length > 1 ? p[0][0] + p[p.length - 1][0] : (p[0] || "?").slice(0, 1))).toUpperCase();
    }
    function gradFor(name) {
      var h = 0, s = String(name || "");
      for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
      return GRAD[h % GRAD.length];
    }
    // Deterministic per-tag color so a given tag always reads the same hue.
    function tagStyle(t) {
      var h = 0; for (var i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
      var hue = h % 360;
      return "background:hsla(" + hue + ",70%,55%,.16);color:hsl(" + hue + ",75%,74%);border:1px solid hsla(" + hue + ",70%,55%,.34)";
    }
    function href(u) { return /^https?:\/\//i.test(u) ? u : "https://" + u; }
    function allTags() {
      var set = {};
      companies.forEach(function (c) { (c.tags || []).forEach(function (t) { set[t] = (set[t] || 0) + 1; }); });
      return Object.keys(set).sort().map(function (t) { return [t, set[t]]; });
    }
    function countFor(key) {
      if (key === "total") return companies.length;
      return companies.filter(function (c) { return c.status === key; }).length;
    }
    function dateNum(s) { var p = String(s || "").split("/"); return p.length === 3 ? (+p[2] * 10000 + +p[0] * 100 + +p[1]) : 0; }
    function sortVal(c, k) { return k === "created" ? dateNum(c.created) : String(c[k] || "").toLowerCase(); }
    function visible() {
      var q = state.q.trim().toLowerCase();
      var list = companies.filter(function (c) {
        if (state.tab !== "total" && c.status !== state.tab) return false;
        if (state.tags.length && !state.tags.some(function (t) { return (c.tags || []).indexOf(t) >= 0; })) return false;
        if (!q) return true;
        return (c.name + " " + c.url + " " + c.location + " " + c.owner + " " + (c.tags || []).join(" ")).toLowerCase().indexOf(q) >= 0;
      });
      if (state.sort.key) {
        var k = state.sort.key, d = state.sort.dir;
        list = list.slice().sort(function (a, b) { var x = sortVal(a, k), y = sortVal(b, k); return x < y ? -d : x > y ? d : 0; });
      }
      return list;
    }

    el.innerHTML = head("Companies", "Your book of business — target accounts and active clients for the BD motion.") +
      '<style>' +
      '.co-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}' +
      '.co-search{flex:1;min-width:220px;display:flex;align-items:center;gap:9px;padding:9px 13px;border-radius:10px;border:1px solid var(--border);background:var(--bg-soft)}' +
      '.co-search span{color:var(--text-dim);font-size:14px}' +
      '.co-search input{flex:1;border:0;background:transparent;color:inherit;font:inherit;outline:none}' +
      '.co-search input::placeholder{color:var(--text-dim)}' +
      '.co-tool{display:grid;place-items:center;width:38px;height:38px;border-radius:10px;border:1px solid var(--border);background:var(--bg-soft);color:var(--text-muted);cursor:pointer;font-size:15px}' +
      '.co-tool:hover{color:var(--text);border-color:var(--border-strong)}' +
      '.co-pill{display:inline-flex;align-items:center;gap:7px;height:38px;padding:0 14px;border-radius:10px;border:1px solid var(--border);background:var(--bg-soft);color:var(--text-muted);cursor:pointer;font-weight:600;font-size:13px}' +
      '.co-pill:hover{color:var(--text);border-color:var(--border-strong)}' +
      '.co-tabs{display:flex;gap:2px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--border);margin-top:16px}' +
      '.co-tab{display:inline-flex;align-items:center;gap:7px;padding:11px 14px;cursor:pointer;color:var(--text-muted);font-weight:600;font-size:13.5px;border-bottom:2px solid transparent;margin-bottom:-1px}' +
      '.co-tab:hover{color:var(--text)}' +
      '.co-tab.on{color:var(--text);border-bottom-color:var(--brand)}' +
      '.co-ct{font-size:11px;font-weight:700;min-width:20px;height:18px;padding:0 6px;border-radius:9px;background:var(--surface-2);color:var(--text-muted);display:inline-grid;place-items:center}' +
      '.co-tab.on .co-ct{background:var(--brand);color:#fff}' +
      '.co-wrap{overflow-x:auto}' +
      '.co-table{width:100%;border-collapse:collapse;font-size:13.5px;min-width:880px}' +
      '.co-table thead th{text-align:left;padding:12px 14px;color:var(--text-dim);font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;font-weight:700;border-bottom:1px solid var(--border);white-space:nowrap}' +
      '.co-sort{margin-left:5px;opacity:.45}' +
      '.co-table tbody td{padding:12px 14px;border-bottom:1px solid var(--border);vertical-align:middle;color:var(--text-muted);white-space:nowrap}' +
      '.co-table tbody tr:hover{background:var(--bg-soft)}' +
      '.co-name{display:flex;align-items:center;gap:11px;min-width:0}' +
      '.co-logo{flex:0 0 auto;width:34px;height:34px;border-radius:9px;display:grid;place-items:center;font-weight:700;font-size:13px;color:#fff}' +
      '.co-nm{font-weight:600;color:var(--text);text-decoration:none}' +
      '.co-nm:hover{color:var(--brand-2)}' +
      '.co-ext{color:var(--text-dim);text-decoration:none;font-size:12px}' +
      '.co-ext:hover{color:var(--brand-2)}' +
      '.co-jobs{display:inline-grid;place-items:center;min-width:30px;height:24px;padding:0 8px;border-radius:7px;background:var(--surface-2);color:var(--text-muted);font-weight:700;font-size:12px}' +
      '.co-url{color:var(--text-muted);text-decoration:none}.co-url:hover{color:var(--brand-2)}' +
      '.co-type{display:inline-block;padding:3px 10px;border-radius:7px;background:rgba(56,224,166,.14);color:var(--accent-green);font-size:12px;font-weight:600}' +
      '.co-miss{color:var(--text-dim)}' +
      '.co-pick{width:15px;height:15px;cursor:pointer;accent-color:var(--brand)}' +
      '.co-empty{padding:40px;text-align:center;color:var(--text-dim)}' +
      '.co-table tbody tr.sel{background:rgba(124,92,255,.07)}' +
      /* ---- tags ---- */
      '.co-tags{display:flex;align-items:center;gap:5px;flex-wrap:wrap}' +
      '.co-tag{display:inline-flex;align-items:center;gap:3px;font-size:11.5px;font-weight:600;padding:3px 5px 3px 9px;border-radius:7px;white-space:nowrap}' +
      '.co-tagx{border:0;background:transparent;color:inherit;cursor:pointer;font-size:13px;line-height:1;opacity:.55;padding:0 1px}' +
      '.co-tagx:hover{opacity:1}' +
      '.co-tagadd{border:1px dashed var(--border-strong);background:transparent;color:var(--text-dim);cursor:pointer;border-radius:7px;min-width:22px;height:22px;padding:0 6px;display:inline-grid;place-items:center;font-size:12px}' +
      '.co-tagadd:hover{color:var(--text);border-color:var(--brand)}' +
      /* ---- tag filter bar + bulk bar ---- */
      '.co-filter{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:12px;font-size:12px;color:var(--text-dim)}' +
      '.co-fchip{cursor:pointer;padding:4px 11px;border-radius:999px;border:1px solid var(--border);background:var(--bg-soft);color:var(--text-muted);font-size:12px;font-weight:600}' +
      '.co-fchip:hover{color:var(--text)}' +
      '.co-fchip.on{background:var(--surface-2);color:var(--text);border-color:var(--border-strong)}' +
      '.co-bulk{display:none;align-items:center;gap:9px;flex-wrap:wrap;margin-top:12px;padding:10px 13px;border:1px solid var(--border);border-radius:10px;background:var(--bg-soft)}' +
      '.co-bulk b{color:var(--text);font-size:13px}' +
      '.co-bulk select{background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:6px 9px;font:inherit;font-size:12.5px;cursor:pointer}' +
      '</style>' +
      '<div class="card">' +
        '<div class="co-bar">' +
          '<div class="co-search"><span>🔍</span><input type="search" id="coQ" placeholder="Search Companies…" autocomplete="off"></div>' +
          '<button class="co-pill" id="coLists">☰ Lists</button>' +
          '<button class="co-tool" title="Filter">⛃</button>' +
          '<button class="co-tool" title="Sort">⇅</button>' +
          '<button class="co-tool" title="Columns">⚙</button>' +
          '<button class="btn btn-primary btn-sm" id="coAdd">＋ Add Company</button>' +
        '</div>' +
        '<div class="co-tabs" id="coTabs"></div>' +
        '<div class="co-filter" id="coFilter" style="display:none"></div>' +
        '<div class="co-bulk" id="coBulk">' +
          '<b id="coSelN">0 selected</b>' +
          '<button class="btn btn-sm" id="coTagSel">＋ Tag</button>' +
          '<select id="coStatusSel"><option value="">Set status…</option>' +
            TABS.slice(1).map(function (t) { return '<option value="' + t[0] + '">' + esc(t[1]) + '</option>'; }).join("") +
          '</select>' +
          '<button class="btn btn-ghost btn-sm" id="coClearSel">Clear tags</button>' +
          '<button class="btn btn-ghost btn-sm" id="coDelSel">🗑 Delete</button>' +
        '</div>' +
        '<div class="co-wrap"><table class="co-table">' +
          '<thead><tr id="coHead"></tr></thead>' +
          '<tbody id="coRows"></tbody>' +
        '</table></div>' +
      '</div>';

    function paintTabs() {
      $("#coTabs", el).innerHTML = TABS.map(function (t) {
        return '<div class="co-tab' + (state.tab === t[0] ? " on" : "") + '" data-tab="' + t[0] + '">' +
          esc(t[1]) + '<span class="co-ct">' + countFor(t[0]) + '</span></div>';
      }).join("");
    }
    function paintFilter() {
      var tags = allTags(), f = $("#coFilter", el);
      if (!tags.length) { f.style.display = "none"; f.innerHTML = ""; state.tags = []; return; }
      f.style.display = "flex";
      f.innerHTML = '<span>Filter by tag:</span>' + tags.map(function (t) {
        var on = state.tags.indexOf(t[0]) >= 0;
        return '<span class="co-fchip' + (on ? " on" : "") + '" data-ftag="' + esc(t[0]) + '">' + esc(t[0]) + ' · ' + t[1] + '</span>';
      }).join("") + (state.tags.length ? ' <span class="co-fchip" data-ftag="__clear">✕ Clear</span>' : "");
    }
    function paintHead() {
      var vis = visible(), allOn = vis.length > 0 && vis.every(function (c) { return state.sel[c.name]; });
      $("#coHead", el).innerHTML =
        '<th style="width:34px"><input type="checkbox" class="co-pick" id="coAll"' + (allOn ? " checked" : "") + '></th>' +
        COLS.map(function (col) {
          var arrow = col.sort
            ? '<span class="co-sort' + (state.sort.key === col.key ? " on" : "") + '">' + (state.sort.key === col.key ? (state.sort.dir > 0 ? "↑" : "↓") : "⇅") + '</span>'
            : "";
          return '<th' + (col.sort ? ' data-sort="' + col.key + '" style="cursor:pointer"' : "") + '>' + esc(col.label) + arrow + '</th>';
        }).join("");
    }
    function tagsCell(c) {
      var chips = (c.tags || []).map(function (t, j) {
        return '<span class="co-tag" style="' + tagStyle(t) + '">' + esc(t) +
          '<button class="co-tagx" data-untag="' + esc(c.name) + '" data-tagi="' + j + '" title="Remove">×</button></span>';
      }).join("");
      return '<div class="co-tags">' + chips + '<button class="co-tagadd" data-tagadd="' + esc(c.name) + '" title="Add tag">＋</button></div>';
    }
    function rowHtml(c) {
      var ext = c.url ? ' <a class="co-ext" href="' + esc(href(c.url)) + '" target="_blank" rel="noopener" title="Open site">↗</a>' : '';
      var urlCell = c.url
        ? '<a class="co-url" href="' + esc(href(c.url)) + '" target="_blank" rel="noopener">' + esc(c.url) + '</a>'
        : '<span class="co-miss">—</span>';
      return '<tr' + (state.sel[c.name] ? ' class="sel"' : "") + '>' +
        '<td><input type="checkbox" class="co-pick" data-pick="' + esc(c.name) + '"' + (state.sel[c.name] ? " checked" : "") + '></td>' +
        '<td><div class="co-name">' +
          '<div class="co-logo" style="background:linear-gradient(135deg,' + gradFor(c.name) + ')">' + esc(initials(c.name)) + '</div>' +
          '<a class="co-nm" href="#prospects">' + esc(c.name) + '</a>' + ext +
        '</div></td>' +
        '<td><span class="co-jobs">' + (Number(c.jobs) || 0) + '</span></td>' +
        '<td>' + urlCell + '</td>' +
        '<td>' + (c.location ? esc(c.location) : '<span class="co-miss">—</span>') + '</td>' +
        '<td>' + esc(c.owner || "—") + '</td>' +
        '<td>' + esc(c.created || "—") + '</td>' +
        '<td><span class="co-type">' + esc(c.type) + '</span></td>' +
        '<td>' + tagsCell(c) + '</td>' +
      '</tr>';
    }
    function paintRows() {
      var rows = visible();
      $("#coRows", el).innerHTML = rows.length
        ? rows.map(rowHtml).join("")
        : '<tr><td colspan="9"><div class="co-empty">No companies match.</div></td></tr>';
    }
    function refreshBulk() {
      var n = selected().length;
      $("#coBulk", el).style.display = n ? "flex" : "none";
      $("#coSelN", el).textContent = n + " selected";
    }
    function paint() { paintTabs(); paintFilter(); paintHead(); paintRows(); refreshBulk(); }
    paint();

    function addTagsTo(list, label) {
      if (!list.length) return;
      var input = window.prompt("Add tag(s) for " + label + " — separate multiple with commas:", "");
      if (input == null) return;
      var tags = input.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      if (!tags.length) return;
      list.forEach(function (c) { tags.forEach(function (t) { if (c.tags.indexOf(t) < 0) c.tags.push(t); }); });
      persist(); paint();
    }

    var qEl = $("#coQ", el);
    qEl.oninput = function () { state.q = qEl.value; paint(); };
    $("#coTabs", el).addEventListener("click", function (e) {
      var t = e.target.closest(".co-tab"); if (!t) return;
      state.tab = t.getAttribute("data-tab"); paint();
    });
    $("#coFilter", el).addEventListener("click", function (e) {
      var c = e.target.closest("[data-ftag]"); if (!c) return;
      var t = c.getAttribute("data-ftag");
      if (t === "__clear") state.tags = [];
      else { var i = state.tags.indexOf(t); if (i >= 0) state.tags.splice(i, 1); else state.tags.push(t); }
      paint();
    });
    var headEl = $("#coHead", el);
    headEl.addEventListener("change", function (e) {
      if (e.target.id !== "coAll") return;
      var chk = e.target.checked;
      visible().forEach(function (c) { state.sel[c.name] = chk; });
      paint();
    });
    headEl.addEventListener("click", function (e) {
      var th = e.target.closest("th[data-sort]"); if (!th) return;
      var k = th.getAttribute("data-sort");
      if (state.sort.key === k) state.sort.dir = -state.sort.dir; else { state.sort.key = k; state.sort.dir = 1; }
      paint();
    });
    var rowsEl = $("#coRows", el);
    rowsEl.addEventListener("change", function (e) {
      var cb = e.target.closest("[data-pick]"); if (!cb) return;
      state.sel[cb.getAttribute("data-pick")] = cb.checked;
      paintRows(); paintHead(); refreshBulk();
    });
    rowsEl.addEventListener("click", function (e) {
      var add = e.target.closest("[data-tagadd]");
      if (add) { var c = findByName(add.getAttribute("data-tagadd")); if (c) addTagsTo([c], c.name); return; }
      var rm = e.target.closest("[data-untag]");
      if (rm) {
        var co = findByName(rm.getAttribute("data-untag"));
        if (co) { co.tags.splice(+rm.getAttribute("data-tagi"), 1); persist(); paint(); }
      }
    });
    $("#coTagSel", el).onclick = function () { addTagsTo(selected(), selected().length + " selected"); };
    $("#coClearSel", el).onclick = function () { selected().forEach(function (c) { c.tags = []; }); persist(); paint(); };
    $("#coStatusSel", el).onchange = function () {
      var v = this.value; if (!v) return;
      selected().forEach(function (c) { c.status = v; });
      this.value = ""; persist(); paint();
    };
    $("#coDelSel", el).onclick = function () {
      var sel = selected(); if (!sel.length) return;
      if (!window.confirm("Delete " + sel.length + " compan" + (sel.length > 1 ? "ies" : "y") + "? This can't be undone.")) return;
      sel.forEach(function (c) { if (!c.added && deleted.indexOf(c.name) < 0) deleted.push(c.name); });
      companies = companies.filter(function (c) { return !state.sel[c.name]; });
      state.sel = {}; persist(); paint();
    };
    $("#coAdd", el).onclick = function () {
      var name = (window.prompt("Company name") || "").trim(); if (!name) return;
      if (findByName(name)) { toast("That company already exists."); return; }
      var url = (window.prompt("Website URL (optional)") || "").trim();
      var now = new Date();
      companies.unshift({
        name: name, url: url, location: "", owner: (ctx.user && ctx.user.name) || "You",
        created: (now.getMonth() + 1) + "/" + now.getDate() + "/" + now.getFullYear(),
        type: "Client", status: "", jobs: 0, tags: [], added: true
      });
      persist(); paint();
    };
    $("#coLists", el).onclick = function () { toast("Lists are coming soon."); };
  }

  // In the BD motion this route is the book of business (Companies); in recruiting
  // it is the people database below.
  function renderData(el) {
    if (motion === "bd") return renderCompanies(el);
    el.innerHTML = head("Candidates", "Your people database. Filter by stage, owner, title and more on the left; email, enrich, submit, or export the people you select.") +
      '<style>' +
      '.dt-sub{color:var(--muted,#8b93a1);font-size:12px}' +
      '.dt-prov{font-size:12px;color:var(--muted,#8b93a1);margin-bottom:10px}' +
      '.cd-wrap{display:grid;grid-template-columns:232px 1fr;gap:18px;align-items:start}' +
      '@media(max-width:900px){.cd-wrap{grid-template-columns:1fr}}' +
      '.cd-facets{position:sticky;top:8px;background:var(--panel,#16181d);border:1px solid var(--line,#262a33);border-radius:12px;padding:8px 10px;max-height:calc(100vh - 120px);overflow:auto}' +
      '.cd-search{width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line,#262a33);background:var(--bg,#0e0f13);color:inherit;margin:4px 0 6px}' +
      '.cd-facet{border-bottom:1px solid var(--line,#20242c)}.cd-facet:last-child{border-bottom:0}' +
      '.cd-fhead{display:flex;align-items:center;gap:6px;padding:10px 4px;cursor:pointer;font-size:13px;font-weight:600;user-select:none}' +
      '.cd-fhead .cd-fc{font-size:11px;color:#fff;background:var(--accent,#3b82f6);border-radius:10px;padding:1px 7px}' +
      '.cd-fcaret{margin-left:auto;color:var(--muted,#8b93a1);font-size:11px;transition:transform .15s}' +
      '.cd-facet.open .cd-fcaret{transform:rotate(180deg)}' +
      '.cd-fbody{padding:0 2px 10px}' +
      '.cd-fopt{display:flex;align-items:center;gap:8px;font-size:12.5px;padding:4px 2px;cursor:pointer}' +
      '.cd-fopt input{margin:0;flex:0 0 auto}' +
      '.cd-fopt .cd-ol{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.cd-fopt .cd-oc{color:var(--muted,#8b93a1);font-size:11px}' +
      '.cd-more{font-size:12px;color:var(--accent,#3b82f6);cursor:pointer;padding:5px 2px}' +
      '.cd-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:12px}' +
      '.cd-tbtn{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;padding:7px 11px;border-radius:8px;border:1px solid var(--line,#262a33);background:var(--panel,#16181d);color:inherit;cursor:pointer}' +
      '.cd-tbtn:hover:not(:disabled){border-color:var(--accent,#3b82f6)}' +
      '.cd-tbtn.primary{background:var(--accent,#3b82f6);border-color:transparent;color:#fff}' +
      '.cd-tbtn:disabled{opacity:.4;cursor:not-allowed}' +
      '.cd-tsep{width:1px;align-self:stretch;background:var(--line,#262a33);margin:2px 4px}' +
      '.cd-spacer{flex:1}' +
      '.cd-tabs{display:flex;gap:2px;flex-wrap:wrap;border-bottom:1px solid var(--line,#262a33);margin-bottom:12px}' +
      '.cd-tab{display:inline-flex;align-items:center;gap:7px;padding:9px 12px;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;color:var(--muted,#8b93a1)}' +
      '.cd-tab.active{color:inherit;border-bottom-color:var(--accent,#3b82f6);font-weight:600}' +
      '.cd-tab .cd-tc{font-size:11px;background:var(--line,#20242c);color:var(--muted,#8b93a1);border-radius:10px;padding:1px 7px}' +
      '.cd-tab.active .cd-tc{background:var(--accent,#3b82f6);color:#fff}' +
      '.cd-selbar{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--muted,#8b93a1);margin-bottom:10px}' +
      '.cd-link{color:var(--accent,#3b82f6);cursor:pointer}' +
      '.dt-list{display:flex;flex-direction:column;gap:14px}' +
      '.dt-card{position:relative;background:var(--panel,#16181d);border:1px solid var(--line,#262a33);border-radius:14px;padding:16px 20px;transition:border-color .15s,box-shadow .15s}' +
      '.dt-card:hover{border-color:var(--accent,#3b82f6);box-shadow:0 8px 26px -16px rgba(0,0,0,.6)}' +
      '.dt-card.sel{border-color:var(--accent,#3b82f6)}' +
      '.dt-pick{position:absolute;top:16px;right:18px;width:16px;height:16px;cursor:pointer}' +
      '.cd-act{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--muted,#8b93a1);margin-bottom:12px}' +
      '.cd-act b{color:var(--accent,#3b82f6);font-weight:600}' +
      '.dt-head{display:flex;align-items:flex-start;gap:14px;padding-right:28px}' +
      '.dt-avatar{flex:0 0 auto;width:52px;height:52px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:18px;color:#fff;background:linear-gradient(135deg,#7c5cff,#4dd0ff)}' +
      '.dt-id{flex:1;min-width:0}' +
      '.dt-name{display:flex;align-items:center;gap:7px;font-size:16px;font-weight:700;line-height:1.2}' +
      '.dt-name a.dt-li{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:4px;background:#0a66c2;color:#fff;font-size:11px;font-weight:800;text-decoration:none;flex:0 0 auto}' +
      '.dt-title{font-size:13px;margin-top:2px}' +
      '.dt-loc{font-size:12px;color:var(--muted,#8b93a1);margin-top:1px}' +
      '.dt-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto}' +
      '.dt-contact{display:inline-flex;border:1px solid var(--line,#262a33);border-radius:9px;overflow:hidden}' +
      '.dt-contact button{display:grid;place-items:center;width:38px;height:34px;border:0;background:transparent;color:inherit;cursor:pointer;font-size:15px;border-left:1px solid var(--line,#262a33)}' +
      '.dt-contact button:first-child{border-left:0}' +
      '.dt-contact button:hover{background:rgba(124,92,255,.12)}' +
      '.dt-contact button.off{color:var(--muted,#5b626f)}' +
      '.dt-contact button.off:hover{color:var(--accent,#3b82f6)}' +
      '.dt-stage{font-size:12px;font-weight:600;padding:7px 15px;border-radius:8px;white-space:nowrap;border:1px solid transparent}' +
      '.dt-add{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;padding:7px 15px;border-radius:8px;border:0;cursor:pointer;background:var(--accent,#3b82f6);color:#fff}' +
      '.dt-add:hover{filter:brightness(1.08)}' +
      '.dt-body{display:grid;grid-template-columns:1.4fr 1fr;gap:24px;margin-top:16px;padding-top:14px;border-top:1px solid var(--line,#20242c)}' +
      '@media(max-width:720px){.dt-body{grid-template-columns:1fr}.dt-actions{margin-left:0}}' +
      '.dt-seclbl{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted,#8b93a1);margin-bottom:8px}' +
      '.dt-exp-row{display:flex;gap:10px;align-items:flex-start}' +
      '.dt-exp-ic{flex:0 0 auto;width:30px;height:30px;border-radius:7px;display:grid;place-items:center;background:var(--accent,#3b82f6);color:#fff;font-size:14px}' +
      '.dt-exp-t{font-weight:600;font-size:13px}' +
      '.dt-exp-c{font-size:12px;color:var(--muted,#8b93a1)}' +
      '.dt-side-row{display:flex;gap:9px;align-items:center;font-size:13px;margin-bottom:8px}' +
      '.dt-side-ic{flex:0 0 auto;width:26px;height:26px;border-radius:6px;display:grid;place-items:center;background:var(--accent,#3b82f6);color:#fff;font-size:12px}' +
      '.dt-skills{margin-top:14px}' +
      '.dt-tag{display:inline-block;font-size:12px;padding:5px 11px;border-radius:7px;background:var(--line,#20242c);color:var(--muted,#9aa3b2);margin:0 6px 6px 0}' +
      '.cd-showmore{text-align:center;border-top:1px solid var(--line,#20242c);margin-top:14px;padding-top:10px;font-size:12px;color:var(--accent,#3b82f6);cursor:pointer}' +
      '.cd-bio{font-size:12.5px;color:var(--muted,#9aa3b2);line-height:1.55;white-space:pre-wrap;margin-top:12px;padding-top:12px;border-top:1px solid var(--line,#20242c)}' +
      '</style>' +
      '<div id="dtProv" class="dt-prov"></div>' +
      '<div class="cd-wrap">' +
        '<aside class="cd-facets"><input type="search" class="cd-search" id="cdSearch" placeholder="Search name, title, company…" autocomplete="off"><div id="cdFacets"></div></aside>' +
        '<div class="cd-main">' +
          '<div class="cd-toolbar" id="cdToolbar"></div>' +
          '<div class="cd-tabs" id="cdTabs"></div>' +
          '<div class="cd-selbar" id="cdSelbar"></div>' +
          '<div id="dtBody">' + loading() + '</div>' +
        '</div>' +
      '</div>';

    // all = everything loaded; sel = picked ids; stage = active tab; facets = {field:[vals]}
    var state = { all: [], q: "", stage: "", facets: {}, sel: {}, open: {}, showAll: {}, bios: {}, providers: [] };
    var bodyEl = $("#dtBody", el), searchTimer = null;

    function load() {
      api("/data?limit=1000").then(function (d) {
        d = d || {};
        state.all = d.records || [];
        state.providers = d.providers || [];
        paintProv();
        renderAll();
      }).catch(function () { bodyEl.innerHTML = '<div class="empty">Could not load the database.</div>'; });
    }
    function paintProv() {
      var prov = (state.providers || []).map(function (p) {
        return (p.configured ? "🟢 " : "⚪ ") + esc(p.label) + (p.configured ? " · live" : " · awaiting key");
      }).join(" &nbsp;·&nbsp; ");
      $("#dtProv", el).innerHTML = prov ? ("Providers: " + prov) : "";
    }

    /* ---- filtering ---- */
    function matchesQ(r) {
      if (!state.q) return true;
      var hay = (r.fullName + " " + (r.title || "") + " " + (r.company || "") + " " + (r.email || "") + " " + ((r.tags || []).join(" "))).toLowerCase();
      return hay.indexOf(state.q.toLowerCase()) >= 0;
    }
    function facetFn(field) { for (var i = 0; i < DT_FACETS.length; i++) if (DT_FACETS[i][0] === field) return DT_FACETS[i][2]; return function () { return []; }; }
    // Filter `all` by search + stage-tab + every facet, optionally skipping one facet
    // (so that facet's own option counts reflect "what you could still add").
    function filtered(exceptField, applyStage) {
      return state.all.filter(function (r) {
        if (!matchesQ(r)) return false;
        if (applyStage !== false && state.stage) { if (state.stage === "__none__" ? r.stage : (r.stage || "") !== state.stage) return false; }
        for (var f in state.facets) {
          if (f === exceptField) continue;
          var sel = state.facets[f]; if (!sel || !sel.length) continue;
          var vals = facetFn(f)(r);
          var hit = false; for (var i = 0; i < vals.length; i++) if (sel.indexOf(vals[i]) >= 0) { hit = true; break; }
          if (!hit) return false;
        }
        return true;
      });
    }
    function view() { return filtered(null, true); }

    function renderAll() { paintFacets(); paintTabs(); paintToolbar(); paintFeed(); }

    /* ---- facets ---- */
    function paintFacets() {
      var host = $("#cdFacets", el);
      host.innerHTML = DT_FACETS.map(function (f) {
        var field = f[0], label = f[1];
        var base = filtered(field, true);
        var counts = {};
        base.forEach(function (r) { f[2](r).forEach(function (v) { counts[v] = (counts[v] || 0) + 1; }); });
        var opts = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || (a < b ? -1 : 1); });
        if (!opts.length) return "";
        var sel = state.facets[field] || [];
        var open = !!state.open[field];
        var limit = state.showAll[field] ? opts.length : 8;
        var body = opts.slice(0, limit).map(function (v) {
          var on = sel.indexOf(v) >= 0;
          return '<label class="cd-fopt"><input type="checkbox" data-facet="' + esc(field) + '" data-val="' + esc(v) + '"' + (on ? " checked" : "") + '>' +
            '<span class="cd-ol" title="' + esc(v) + '">' + esc(v) + '</span><span class="cd-oc">' + counts[v] + '</span></label>';
        }).join("");
        if (opts.length > limit) body += '<div class="cd-more" data-more="' + esc(field) + '">Show ' + (opts.length - limit) + ' more</div>';
        else if (state.showAll[field] && opts.length > 8) body += '<div class="cd-more" data-more="' + esc(field) + '">Show less</div>';
        return '<div class="cd-facet' + (open ? " open" : "") + '">' +
          '<div class="cd-fhead" data-fhead="' + esc(field) + '">' + esc(label) +
            (sel.length ? '<span class="cd-fc">' + sel.length + '</span>' : '') +
            '<span class="cd-fcaret">▾</span></div>' +
          (open ? '<div class="cd-fbody">' + body + '</div>' : '') +
        '</div>';
      }).join("");

      Array.prototype.forEach.call(host.querySelectorAll("[data-fhead]"), function (h) {
        h.addEventListener("click", function () { var f = h.getAttribute("data-fhead"); state.open[f] = !state.open[f]; paintFacets(); });
      });
      Array.prototype.forEach.call(host.querySelectorAll("[data-facet]"), function (cb) {
        cb.addEventListener("change", function () {
          var f = cb.getAttribute("data-facet"), v = cb.getAttribute("data-val");
          var arr = state.facets[f] || (state.facets[f] = []);
          var i = arr.indexOf(v);
          if (cb.checked) { if (i < 0) arr.push(v); } else if (i >= 0) arr.splice(i, 1);
          if (!arr.length) delete state.facets[f];
          renderAll();
        });
      });
      Array.prototype.forEach.call(host.querySelectorAll("[data-more]"), function (m) {
        m.addEventListener("click", function () { var f = m.getAttribute("data-more"); state.showAll[f] = !state.showAll[f]; paintFacets(); });
      });
    }

    /* ---- stage tabs ---- */
    function paintTabs() {
      var base = filtered(null, false); // everything except the stage selection
      var counts = {}; var noStage = 0;
      base.forEach(function (r) { if (r.stage) counts[r.stage] = (counts[r.stage] || 0) + 1; else noStage++; });
      // Always show the full canonical pipeline (even at 0), then any extra
      // stages present in the data, then a No-stage bucket — all clickable.
      var ordered = DT_STAGE_ORDER.slice();
      Object.keys(counts).forEach(function (s) { if (ordered.indexOf(s) < 0) ordered.push(s); });
      var tabs = [["", "Total", base.length]];
      ordered.forEach(function (s) { tabs.push([s, s, counts[s] || 0]); });
      if (noStage) tabs.push(["__none__", "No stage", noStage]);
      $("#cdTabs", el).innerHTML = tabs.map(function (t) {
        return '<div class="cd-tab' + (state.stage === t[0] ? " active" : "") + '" data-stage="' + esc(t[0]) + '">' + esc(t[1]) + '<span class="cd-tc">' + t[2] + '</span></div>';
      }).join("");
      Array.prototype.forEach.call($("#cdTabs", el).querySelectorAll("[data-stage]"), function (t) {
        t.addEventListener("click", function () { state.stage = t.getAttribute("data-stage"); renderAll(); });
      });
    }

    /* ---- toolbar ---- */
    function paintToolbar() {
      var n = Object.keys(state.sel).length, dis = n ? "" : " disabled";
      $("#cdToolbar", el).innerHTML =
        '<button class="cd-tbtn primary" id="cdAdd">＋ Add people ▾</button>' +
        '<span class="cd-tsep"></span>' +
        '<button class="cd-tbtn" id="cdDelete"' + dis + '>🗑 Delete</button>' +
        '<span class="cd-tsep"></span>' +
        '<button class="cd-tbtn" id="cdEmail"' + dis + '>✉️ Email</button>' +
        '<button class="cd-tbtn" id="cdSms"' + dis + '>📱 SMS</button>' +
        '<button class="cd-tbtn" id="cdFind"' + dis + '>🔎 Find contact</button>' +
        '<button class="cd-tbtn" id="cdSubmit"' + dis + '>➤ Submit candidates</button>' +
        '<span class="cd-spacer"></span>' +
        '<button class="cd-tbtn" id="cdAddTo"' + dis + '>＋ Add to…</button>' +
        '<button class="cd-tbtn" id="cdExport">⬇ Export</button>';
      var sel = function () { return Object.keys(state.sel); };
      $("#cdAdd", el).addEventListener("click", function () { openDataImport(load); });
      $("#cdDelete", el).addEventListener("click", function () { if (n) delSel(); });
      $("#cdEmail", el).addEventListener("click", function () { if (n) bulkEmail(); });
      $("#cdSms", el).addEventListener("click", function () { if (n) bulkSms(); });
      $("#cdFind", el).addEventListener("click", function () { if (n) enrichSel($("#cdFind", el)); });
      $("#cdSubmit", el).addEventListener("click", function () { if (n) promote(sel()); });
      $("#cdAddTo", el).addEventListener("click", function () { if (n) promote(sel()); });
      $("#cdExport", el).addEventListener("click", function () { exportCsv(); });
    }

    /* ---- select-all header ---- */
    function paintSelbar(rows) {
      var n = Object.keys(state.sel).length;
      var allSel = rows.length && rows.every(function (r) { return state.sel[r.id]; });
      $("#cdSelbar", el).innerHTML =
        '<span class="cd-link" id="cdUnsel">Unselect all</span><span>|</span>' +
        '<span class="cd-link" id="cdSelAll">' + (allSel ? "Deselect" : "Select all") + " " + rows.length + '</span>' +
        '<span>(' + n + ' selected)</span>';
      $("#cdUnsel", el).addEventListener("click", function () { state.sel = {}; paintFeed(); paintToolbar(); });
      $("#cdSelAll", el).addEventListener("click", function () {
        if (allSel) rows.forEach(function (r) { delete state.sel[r.id]; });
        else rows.forEach(function (r) { state.sel[r.id] = true; });
        paintFeed(); paintToolbar();
      });
    }

    /* ---- card rendering ---- */
    function initials(name) {
      var p = String(name || "").trim().split(/\s+/).filter(Boolean);
      return ((p[0] || "?")[0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
    }
    function sourceLabel(s) { return s === "zoominfo-api" ? "API" : s === "manual" ? "Manual" : "Imported"; }
    function stageMeta(s) {
      var map = { applied: ["#0ea5e9", "rgba(14,165,233,.16)"], longlist: ["#94a3b8", "rgba(148,163,184,.16)"], shortlist: ["#a855f7", "rgba(168,85,247,.16)"],
        outbound: ["#e0961f", "rgba(245,158,11,.16)"], screening: ["#3b82f6", "rgba(59,130,246,.16)"], submitted: ["#e0961f", "rgba(245,158,11,.16)"],
        interviewing: ["#22c55e", "rgba(34,197,94,.16)"], rejected: ["#ef4444", "rgba(239,68,68,.16)"], hired: ["#16a34a", "rgba(22,163,74,.2)"], contact: ["#94a3b8", "rgba(148,163,184,.16)"] };
      return map[String(s || "").toLowerCase()] || ["#e0961f", "rgba(245,158,11,.16)"];
    }
    function relTime(s) {
      if (!s) return "";
      var t = Date.parse(String(s).replace(" ", "T")); if (isNaN(t)) return "";
      var d = Math.max(0, Date.now() - t), m = Math.round(d / 60000);
      if (m < 1) return "just now"; if (m < 60) return m + " min ago";
      var h = Math.round(m / 60); if (h < 24) return h + " hr ago";
      var dd = Math.round(h / 24); if (dd < 30) return dd + " day" + (dd === 1 ? "" : "s") + " ago";
      var mo = Math.round(dd / 30); if (mo < 12) return mo + " mo ago";
      return Math.round(mo / 12) + " yr ago";
    }

    function card(r) {
      var loc = [r.city, r.state, r.country].filter(Boolean).join(", ");
      var phone = r.phone || r.directPhone || r.companyPhone;
      var li = r.linkedinUrl ? ' <a class="dt-li" href="' + esc(r.linkedinUrl) + '" target="_blank" rel="noopener" title="LinkedIn">in</a>' : '';
      var emailBtn = r.email
        ? '<button title="' + esc(r.email) + '" data-mail="' + esc(r.email) + '">✉️</button>'
        : '<button class="off" title="Find email" data-enrich="email" data-id="' + esc(r.id) + '">✉️</button>';
      var phoneBtn = phone
        ? '<button title="' + esc(phone) + '" data-tel="' + esc(phone) + '">📞</button>'
        : '<button class="off" title="Find phone" data-enrich="phone" data-id="' + esc(r.id) + '">📞</button>';

      var sm = stageMeta(r.stage || r.recordType);
      var stageLabel = r.stage || r.recordType || sourceLabel(r.source);
      var stageBadge = '<span class="dt-stage" style="color:' + sm[0] + ';background:' + sm[1] + '">' + esc(stageLabel) + '</span>';

      // Activity meta line (real owner + real last-activity time; never fabricated).
      var rel = relTime(r.lastActivityAt);
      var actBits = [];
      if (r.stage) actBits.push('<b>' + esc(r.stage) + '</b>'); else if (r.recordType) actBits.push('<b>' + esc(r.recordType) + '</b>');
      if (rel) actBits.push(esc(rel));
      if (r.owner) actBits.push((r.recordType === "Contact" ? "owned by " : "with ") + esc(r.owner));
      var act = actBits.length ? '<div class="cd-act">📋 ' + actBits.join(" · ") + '</div>' : '';

      // EXPERIENCE: only the current role — we never invent prior history.
      var exp = (r.title || r.company)
        ? '<div class="dt-exp-row"><div class="dt-exp-ic">🏢</div><div>' +
            (r.title ? '<div class="dt-exp-t">' + esc(r.title) + '</div>' : '') +
            (r.company ? '<div class="dt-exp-c">' + esc(r.company) + '</div>' : '') +
          '</div></div>'
        : '<div class="dt-sub">No role on file.</div>';

      var side = "";
      if (r.company) side += '<div class="dt-side-row"><span class="dt-side-ic">🏢</span><span>' + esc(r.company) + (r.companyDomain ? ' · <span class="dt-sub">' + esc(r.companyDomain) + '</span>' : '') + '</span></div>';
      if (loc) side += '<div class="dt-side-row"><span class="dt-side-ic">📍</span><span>' + esc(loc) + '</span></div>';
      if (r.compensation) side += '<div class="dt-side-row"><span class="dt-side-ic">💰</span><span>' + esc(r.compensation) + '</span></div>';
      if (!side) side = '<div class="dt-sub">—</div>';

      // Skills/tags row -> real tags from the export (fallback to industry/seniority).
      var tagList = (Array.isArray(r.tags) && r.tags.length) ? r.tags : [r.industry, r.seniority].filter(Boolean);
      var tagHtml = tagList.map(function (t) { return '<span class="dt-tag">' + esc(t) + '</span>'; }).join("");
      var skills = tagHtml ? '<div class="dt-skills"><div class="dt-seclbl">Skills &amp; tags</div>' + tagHtml + '</div>' : "";

      // Bio / intake notes behind a SHOW MORE toggle.
      var bioOpen = !!state.bios[r.id];
      var bio = r.bio
        ? '<div class="cd-showmore" data-bio="' + esc(r.id) + '">' + (bioOpen ? "Hide notes ▴" : "Show notes ▾") + '</div>' +
          (bioOpen ? '<div class="cd-bio">' + esc(r.bio) + '</div>' : '')
        : '';

      return '<div class="dt-card' + (state.sel[r.id] ? ' sel' : '') + '" data-card="' + esc(r.id) + '">' +
        '<input class="dt-pick" type="checkbox" data-pick="' + esc(r.id) + '"' + (state.sel[r.id] ? " checked" : "") + '>' +
        act +
        '<div class="dt-head">' +
          '<div class="dt-avatar">' + esc(initials(r.fullName)) + '</div>' +
          '<div class="dt-id">' +
            '<div class="dt-name">' + esc(r.fullName) + li + '</div>' +
            (r.title ? '<div class="dt-title">' + esc(r.title) + '</div>' : '') +
            (loc ? '<div class="dt-loc">' + esc(loc) + '</div>' : '') +
          '</div>' +
          '<div class="dt-actions">' +
            '<div class="dt-contact">' + emailBtn + phoneBtn + '</div>' +
            stageBadge +
            '<button class="dt-add" data-add="' + esc(r.id) + '">＋ Add to…</button>' +
          '</div>' +
        '</div>' +
        '<div class="dt-body">' +
          '<div><div class="dt-seclbl">Experience</div>' + exp + skills + '</div>' +
          '<div>' + side + '</div>' +
        '</div>' + bio +
      '</div>';
    }

    function paintFeed() {
      var rows = view();
      paintSelbar(rows);
      if (!state.all.length) {
        bodyEl.innerHTML = '<div class="empty">No people yet.<br><br>' +
          '<button class="cd-tbtn primary" id="cdSeed">⬇ Load Lume Search Partners export</button> &nbsp; ' +
          '<button class="cd-tbtn" id="cdImport2">⬆ Import a CSV</button></div>';
        var seed = $("#cdSeed", el); if (seed) seed.addEventListener("click", function () { seedLume(seed); });
        var imp = $("#cdImport2", el); if (imp) imp.addEventListener("click", function () { openDataImport(load); });
        return;
      }
      if (!rows.length) { bodyEl.innerHTML = '<div class="empty">No people match these filters.</div>'; return; }
      bodyEl.innerHTML = '<div class="dt-list">' + rows.map(card).join("") + '</div>';

      Array.prototype.forEach.call(bodyEl.querySelectorAll("[data-pick]"), function (cb) {
        cb.addEventListener("change", function () {
          var id = cb.getAttribute("data-pick");
          if (cb.checked) state.sel[id] = true; else delete state.sel[id];
          var c = bodyEl.querySelector('[data-card="' + id + '"]'); if (c) c.classList.toggle("sel", cb.checked);
          paintSelbar(rows); paintToolbar();
        });
      });
      Array.prototype.forEach.call(bodyEl.querySelectorAll("[data-enrich]"), function (b) {
        b.addEventListener("click", function () { enrichOne(b.getAttribute("data-id"), b.getAttribute("data-enrich"), b); });
      });
      Array.prototype.forEach.call(bodyEl.querySelectorAll("[data-mail]"), function (b) {
        b.addEventListener("click", function () { location.href = "mailto:" + b.getAttribute("data-mail"); });
      });
      Array.prototype.forEach.call(bodyEl.querySelectorAll("[data-tel]"), function (b) {
        b.addEventListener("click", function () { location.href = "tel:" + b.getAttribute("data-tel"); });
      });
      Array.prototype.forEach.call(bodyEl.querySelectorAll("[data-add]"), function (b) {
        b.addEventListener("click", function () { promote([b.getAttribute("data-add")]); });
      });
      Array.prototype.forEach.call(bodyEl.querySelectorAll("[data-bio]"), function (b) {
        b.addEventListener("click", function () { var id = b.getAttribute("data-bio"); state.bios[id] = !state.bios[id]; paintFeed(); });
      });
    }

    /* ---- record actions ---- */
    function enrichOne(id, field, btn) {
      if (btn) { btn.disabled = true; btn.textContent = "…"; }
      send("/data", "POST", { action: "enrich", id: id, field: field }).then(function (res) {
        if (res.ok && res.data && res.data.record) {
          var i = state.all.findIndex(function (r) { return r.id === id; });
          if (i >= 0) state.all[i] = res.data.record;
          var f = res.data.found || {};
          toast((f.email || f.phone) ? "Enriched ✓" : "Nothing new found");
          paintFeed();
        } else { toast("Enrich failed"); if (btn) { btn.disabled = false; btn.textContent = "↻"; } }
      }).catch(function () { toast("Could not reach the server."); if (btn) { btn.disabled = false; btn.textContent = "↻"; } });
    }
    function enrichSel(btn) {
      var ids = Object.keys(state.sel); if (!ids.length) return;
      if (btn) { btn.disabled = true; }
      var done = 0;
      (function next(i) {
        if (i >= ids.length) { if (btn) { btn.disabled = false; } toast("Enriched " + done + " record" + (done === 1 ? "" : "s")); load(); return; }
        if (btn) btn.textContent = "Finding… " + (i + 1) + "/" + ids.length;
        send("/data", "POST", { action: "enrich", id: ids[i] }).then(function (res) {
          if (res.ok && res.data && res.data.found && (res.data.found.email || res.data.found.phone)) done++;
          next(i + 1);
        }).catch(function () { next(i + 1); });
      })(0);
    }
    function delSel() {
      var ids = Object.keys(state.sel); if (!ids.length) return;
      send("/data", "POST", { action: "delete", ids: ids }).then(function (res) {
        if (res.ok) { toast("Deleted " + (res.data.deleted || ids.length)); state.sel = {}; load(); } else toast("Delete failed");
      });
    }
    function promote(ids) {
      if (!ids || !ids.length) return;
      resolveBdCampaign(function (campaignId) {
        if (!campaignId) { toast("Create a campaign first."); return; }
        send("/data", "POST", { action: "promote", ids: ids, campaignId: campaignId, motion: motion }).then(function (res) {
          if (res.ok) {
            toast("Submitted " + (res.data.added || ids.length) + " to " + prospectsLabel());
            ids.forEach(function (id) { delete state.sel[id]; });
            renderAll();
          } else toast("Submit failed");
        });
      });
    }
    function bulkEmail() {
      var emails = Object.keys(state.sel).map(function (id) { var r = state.all.find(function (x) { return x.id === id; }); return r && r.email; }).filter(Boolean);
      if (!emails.length) { toast("None of the selected have an email yet."); return; }
      location.href = "mailto:?bcc=" + encodeURIComponent(emails.join(","));
    }
    function bulkSms() {
      var phones = Object.keys(state.sel).map(function (id) { var r = state.all.find(function (x) { return x.id === id; }); return r && (r.phone || r.directPhone); }).filter(Boolean);
      if (!phones.length) { toast("None of the selected have a phone yet."); return; }
      location.href = "sms:" + phones[0];
    }
    function exportCsv() {
      var rows = view(); if (!rows.length) { toast("Nothing to export."); return; }
      var cols = ["fullName", "title", "company", "email", "phone", "city", "state", "stage", "owner", "origin", "tags", "linkedinUrl"];
      var head2 = ["Name", "Title", "Company", "Email", "Phone", "City", "State", "Stage", "Owner", "Source", "Tags", "LinkedIn"];
      function cell(v) { v = v == null ? "" : (Array.isArray(v) ? v.join("; ") : String(v)); return '"' + v.replace(/"/g, '""') + '"'; }
      var csv = head2.join(",") + "\n" + rows.map(function (r) {
        return cols.map(function (c) { return cell(c === "phone" ? (r.phone || r.directPhone) : r[c]); }).join(",");
      }).join("\n");
      var blob = new Blob([csv], { type: "text/csv" }), url = URL.createObjectURL(blob);
      var a = document.createElement("a"); a.href = url; a.download = "candidates.csv"; a.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast("Exported " + rows.length + " row" + (rows.length === 1 ? "" : "s"));
    }
    function seedLume(btn) {
      if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
      send("/dev/seed-data", "POST", {}).then(function (res) {
        if (res.ok) { toast("Loaded " + (res.data.added || 0) + " new, updated " + (res.data.updated || 0)); load(); }
        else { toast("Load failed (" + (res.data.error || res.status) + ")"); if (btn) { btn.disabled = false; btn.textContent = "⬇ Load Lume Search Partners export"; } }
      }).catch(function () { toast("Could not reach the server."); if (btn) { btn.disabled = false; btn.textContent = "⬇ Load Lume Search Partners export"; } });
    }

    // search wiring
    $("#cdSearch", el).addEventListener("input", function (e) {
      if (searchTimer) clearTimeout(searchTimer);
      var v = e.target.value.trim();
      searchTimer = setTimeout(function () { state.q = v; renderAll(); }, 200);
    });

    load();
  }

  // Import modal: parse the exported CSV, auto-map columns (override per column), ingest.
  function openDataImport(onDone) {
    var bodyHtml =
      '<label>Upload the CSV you exported from the provider portal</label>' +
      '<input id="diFile" type="file" accept=".csv,.tsv,.txt" class="imp-file" />' +
      '<label>…or paste rows (CSV / TSV, first row = headers)</label>' +
      '<textarea id="diText" placeholder="Full Name,Job Title,Company,Email,Mobile Phone&#10;Jane Doe,VP Sales,Acme,jane@acme.com,+1..."></textarea>' +
      '<div id="diMap" class="imp-map"></div>' +
      '<div class="imp-preview" id="diPrev">Upload or paste an export to begin.</div>' +
      '<div class="modal-foot"><button class="btn btn-ghost btn-sm" id="diCancel">Cancel</button>' +
      '<button class="btn btn-primary btn-sm" id="diGo">Import</button></div>';
    openModal("Import data export", "Map the columns (auto-detected) and import. Re-importing updates existing records — nothing is duplicated.", bodyHtml, function (root, close) {
      var ta = root.querySelector("#diText"), fileEl = root.querySelector("#diFile");
      var mapEl = root.querySelector("#diMap"), prev = root.querySelector("#diPrev");
      var parsed = { headers: [], rows: [] }, mapping = {};

      function rebuild() {
        parsed = parseDelimited(ta.value);
        mapping = {};
        if (!parsed.headers.length) { mapEl.innerHTML = ""; prev.textContent = "Upload or paste an export to begin."; return; }
        mapEl.innerHTML = '<div class="imp-map-title">Map your columns (' + parsed.rows.length + ' rows)</div>' +
          parsed.headers.map(function (h, i) {
            var guess = guessDataField(h);
            mapping[h] = guess;
            var opts = DATA_FIELDS.map(function (f) { return '<option value="' + f[0] + '"' + (f[0] === guess ? " selected" : "") + ">" + esc(f[1]) + "</option>"; }).join("");
            return '<div class="imp-map-row"><span class="imp-col">' + esc(h) + '</span><select data-h="' + esc(h) + '">' + opts + "</select></div>";
          }).join("");
        Array.prototype.forEach.call(mapEl.querySelectorAll("select"), function (sel) {
          sel.addEventListener("change", function () { mapping[sel.getAttribute("data-h")] = sel.value; refresh(); });
        });
        refresh();
      }
      function refresh() {
        var named = parsed.rows.filter(function (r) {
          var hasName = false;
          for (var h in mapping) { if ((mapping[h] === "fullName" || mapping[h] === "firstName") && r[h]) hasName = true; }
          return hasName;
        }).length;
        prev.innerHTML = parsed.rows.length ? ("Ready to import <b>" + named + "</b> of " + parsed.rows.length + " rows (rows need a name).") : "Upload or paste an export to begin.";
      }
      ta.addEventListener("input", rebuild);
      fileEl.addEventListener("change", function () {
        var f = fileEl.files && fileEl.files[0]; if (!f) return;
        var reader = new FileReader();
        reader.onload = function () { ta.value = String(reader.result || ""); rebuild(); };
        reader.readAsText(f);
      });
      root.querySelector("#diCancel").addEventListener("click", close);
      root.querySelector("#diGo").addEventListener("click", function () {
        if (!parsed.rows.length) { toast("Nothing to import."); return; }
        var go = root.querySelector("#diGo"); go.disabled = true; go.textContent = "Importing…";
        send("/data", "POST", { action: "import", rows: parsed.rows, mapping: mapping }).then(function (res) {
          if (res.ok) {
            toast("Imported " + (res.data.added || 0) + " new, updated " + (res.data.updated || 0));
            close(); if (onDone) onDone();
          } else { toast("Import failed (" + (res.data.error || res.status) + ")"); go.disabled = false; go.textContent = "Import"; }
        }).catch(function () { toast("Could not reach the server."); go.disabled = false; go.textContent = "Import"; });
      });
    });
  }

  // Client mirror of the backend header→field guess (best-effort; user can override).
  function guessDataField(header) {
    var h = String(header || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    function has() { for (var i = 0; i < arguments.length; i++) if (h.indexOf(arguments[i]) >= 0) return true; return false; }
    if (has("linkedin")) return "linkedinUrl";
    if (has("fullname") || h === "name" || h === "contactname") return "fullName";
    if (has("firstname") || h === "first") return "firstName";
    if (has("lastname") || h === "last" || h === "surname") return "lastName";
    if (has("jobtitle", "title", "position")) return "title";
    if (has("companydomain", "website", "companyurl", "domain")) return "companyDomain";
    if (has("companyname") || h === "company" || h === "employer" || h === "account") return "company";
    if (has("industry", "sector")) return "industry";
    if (has("personalemail", "secondaryemail", "email2", "otheremail")) return "email2";
    if (has("emailaddress", "workemail", "businessemail") || h === "email") return "email";
    if (has("workphone")) return "companyPhone";
    if (has("personalphone")) return "phone";
    if (has("mobile", "cell")) return "phone";
    if (has("directphone", "directdial", "directnumber")) return "directPhone";
    if (has("companyphone", "hqphone", "mainphone", "officephone")) return "companyPhone";
    if (h === "phone" || has("phonenumber", "phone1")) return "phone";
    if (h === "city") return "city";
    if (h === "state" || has("region", "province")) return "state";
    if (h === "country") return "country";
    if (has("seniority", "managementlevel", "joblevel")) return "seniority";
    if (has("jobstage", "pipelinestage") || h === "stage" || h === "status") return "stage";
    if (h === "tags" || h === "tag" || has("labels", "skills")) return "tags";
    if (has("intake", "candidatesummary") || h === "notes" || h === "summary" || h === "bio" || h === "about") return "bio";
    if (has("compensation", "salary") || h === "comp") return "compensation";
    if (has("recordowner", "accountowner", "recruiter") || h === "owner") return "owner";
    if (has("recordtype") || h === "type") return "recordType";
    if (has("recentactivity", "lastactivity", "activitydate")) return "lastActivityAt";
    if (has("leadsource") || h === "source" || h === "origin") return "origin";
    if (has("zoominfoid", "contactid", "personid", "recordid") || h === "id") return "providerId";
    return "ignore";
  }

  // Pull modal: programmatic pull via the official provider API (dormant until keyed).
  function openDataPull(onDone) {
    var bodyHtml =
      '<label>Provider</label><select id="dpProvider"><option value="zoominfo">ZoomInfo (official API)</option></select>' +
      '<label>Job title</label><input id="dpTitle" placeholder="VP of Sales">' +
      '<label>Company</label><input id="dpCompany" placeholder="Acme">' +
      '<label>Location</label><input id="dpLoc" placeholder="United States">' +
      '<label>Max records</label><input id="dpLimit" type="number" value="50" min="1" max="100">' +
      '<div class="imp-note">Uses the provider\'s official, licensed API. Dormant until <code>ZOOMINFO_API_KEY</code> is set — until then, use <b>Import export</b>.</div>' +
      '<div class="modal-foot"><button class="btn btn-ghost btn-sm" id="dpCancel">Cancel</button>' +
      '<button class="btn btn-primary btn-sm" id="dpGo">Pull</button></div>';
    openModal("Pull via API", "Programmatic pull from the official provider API into your warehouse.", bodyHtml, function (root, close) {
      root.querySelector("#dpCancel").addEventListener("click", close);
      root.querySelector("#dpGo").addEventListener("click", function () {
        var go = root.querySelector("#dpGo"); go.disabled = true; go.textContent = "Pulling…";
        var query = {
          title: root.querySelector("#dpTitle").value.trim(),
          company: root.querySelector("#dpCompany").value.trim(),
          location: root.querySelector("#dpLoc").value.trim(),
          limit: parseInt(root.querySelector("#dpLimit").value, 10) || 50
        };
        send("/data", "POST", { action: "pull", provider: root.querySelector("#dpProvider").value, query: query }).then(function (res) {
          if (res.ok) { toast("Pulled " + (res.data.added || 0) + " new, updated " + (res.data.updated || 0)); close(); if (onDone) onDone(); }
          else if (res.status === 503) { toast("Provider not configured yet — use Import export."); go.disabled = false; go.textContent = "Pull"; }
          else { toast("Pull failed (" + (res.data.error || res.status) + ")"); go.disabled = false; go.textContent = "Pull"; }
        }).catch(function () { toast("Could not reach the server."); go.disabled = false; go.textContent = "Pull"; });
      });
    });
  }

  /* ---------------- Sending ----------------
     Owned cold-email infrastructure. Provision a Hetzner MTA server, then FEED IN
     DOMAINS — each one auto-generates DKIM, creates the Hetzner DNS zone, writes the
     full record set (SPF/DKIM/DMARC/MX/tracking/return-path), and sets PTR on the IP.
     The only manual step is a one-time nameserver delegation at the registrar.
     Backend: /api/sending + lib/sending/*. */
  function renderSending(el) {
    el.innerHTML = head("Sending", "Your owned cold-email infrastructure. Provision an MTA server, feed in domains, and every DNS record (SPF, DKIM, DMARC, MX, PTR, tracking) is set automatically on Hetzner.") +
      '<style>' +
      '.sd-card{margin-bottom:16px}' +
      '.sd-cfg{display:flex;gap:14px;flex-wrap:wrap;font-size:13px;margin-bottom:14px}' +
      '.sd-dot{display:inline-flex;align-items:center;gap:6px}' +
      '.sd-step{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted,#8b93a1);margin-bottom:8px}' +
      '.sd-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}' +
      '.sd-table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}' +
      '.sd-table th,.sd-table td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line,#20242c);vertical-align:top}' +
      '.sd-table th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,#8b93a1)}' +
      '.sd-badge{font-size:11px;padding:2px 8px;border-radius:20px;white-space:nowrap}' +
      '.sd-b-active{background:#10491f;color:#7ff0a0}.sd-b-wait{background:#4a3a10;color:#f0d27f}' +
      '.sd-b-err{background:#4a1414;color:#f08f8f}.sd-b-prov{background:#15324a;color:#7fc4f0}.sd-b-pending{background:#262a33;color:#9aa3b2}' +
      '.sd-chk{display:inline-flex;gap:5px;flex-wrap:wrap}' +
      '.sd-chip{font-size:10px;padding:2px 7px;border-radius:6px;border:1px solid var(--line,#2a2f3a)}' +
      '.sd-chip.ok{background:#10491f;color:#7ff0a0;border-color:transparent}' +
      '.sd-chip.no{background:#20242c;color:#6b7280}' +
      '.sd-ns{background:var(--bg,#0e0f13);border:1px dashed #f0d27f;border-radius:8px;padding:10px 12px;margin-top:8px;font-size:12px}' +
      '.sd-ns code{background:rgba(255,255,255,.06);padding:2px 6px;border-radius:4px;font-family:monospace}' +
      '.sd-mono{font-family:monospace;font-size:12px}' +
      '#sdDomains{width:100%;min-height:90px;font-family:monospace;font-size:13px;padding:10px;border-radius:8px;border:1px solid var(--line,#262a33);background:var(--bg,#0e0f13);color:inherit}' +
      '</style>' +
      '<div id="sdCfg" class="sd-cfg"></div>' +
      '<div class="card sd-card"><div class="sd-step">Step 1 · MTA server (Hetzner)</div><div id="sdServers">' + loading() + '</div></div>' +
      '<div class="card sd-card"><div class="sd-step">Step 2 · Feed in domains</div>' +
        '<p class="muted" style="font-size:13px;margin:0 0 8px">Paste sending domains (one per line). Each is added and fully provisioned automatically — DKIM, zone, all records, PTR.</p>' +
        '<textarea id="sdDomains" placeholder="recruitco.io&#10;recruiters-co.com&#10;recruitersteam.com"></textarea>' +
        '<div class="sd-row" style="margin-top:8px"><button class="btn btn-primary btn-sm" id="sdAdd">⚡ Add &amp; auto-provision</button>' +
        '<span class="muted" style="font-size:12px">Needs an active MTA server + Hetzner tokens.</span></div>' +
      '</div>' +
      '<div class="card sd-card"><div class="sd-row" style="justify-content:space-between"><div class="sd-step" style="margin:0">Domains</div>' +
        '<div class="sd-row"><button class="btn btn-ghost btn-sm" id="sdTick">↻ Daily tick</button><button class="btn btn-ghost btn-sm" id="sdGov">🛡 Run governor</button></div></div>' +
        '<div id="sdList">' + loading() + '</div></div>' +
      '<div class="card sd-card"><div class="sd-step">Deliverability</div><div id="sdDeliv">' + loading() + '</div></div>' +
      '<div class="card sd-card"><div class="sd-step">Seed inboxes (placement testing)</div><div id="sdSeeds">' + loading() + '</div></div>';

    var state = { domains: [], servers: [], mailboxes: [], providers: { dns: false, cloud: false }, suppression: [], events: [], seeds: [], seedTests: [], stats: {} };

    function badge(s) {
      var m = { active: ["sd-b-active", "active"], awaiting_ns: ["sd-b-wait", "awaiting NS"], verifying: ["sd-b-prov", "verifying"],
        provisioning: ["sd-b-prov", "provisioning"], error: ["sd-b-err", "error"], pending: ["sd-b-pending", "pending"], paused: ["sd-b-err", "paused"] };
      var x = m[s] || ["sd-b-pending", s];
      return '<span class="sd-badge ' + x[0] + '">' + esc(x[1]) + '</span>';
    }

    function load() {
      api("/sending").then(function (d) {
        d = d || {};
        state.domains = d.domains || []; state.servers = d.servers || []; state.mailboxes = d.mailboxes || [];
        state.providers = d.providers || { dns: false, cloud: false };
        state.suppression = d.suppression || []; state.events = d.events || [];
        state.seeds = d.seeds || []; state.seedTests = d.seedTests || []; state.stats = d.stats || {};
        paintCfg(); paintServers(); paintList(); paintDeliv(); paintSeeds();
      }).catch(function () { $("#sdList", el).innerHTML = '<div class="empty">Could not load sending infrastructure.</div>'; });
    }

    function paintCfg() {
      var p = state.providers;
      function dot(on, label) { return '<span class="sd-dot">' + (on ? "🟢" : "⚪") + ' ' + label + '</span>'; }
      $("#sdCfg", el).innerHTML =
        dot(p.cloud, "Hetzner Cloud") + dot(p.dns, "Hetzner DNS") +
        dot(p.mta, "MTA send (SENDING_EMAIL_PROVIDER=mta)") + dot(p.snds, "MS SNDS") + dot(p.postmaster, "Google Postmaster");
    }

    function paintServers() {
      var body = $("#sdServers", el);
      var inp = 'padding:7px 10px;border-radius:8px;border:1px solid var(--line,#262a33);background:var(--bg,#0e0f13);color:inherit';
      var rows = state.servers.map(function (s) {
        var act = s.status === "active";
        var postal = s.postalReady ? '🟢 ready' : (s.postalApiKey ? '🟡 key set' : '⚪ not set');
        return '<tr><td><b>' + esc(s.name) + '</b><div class="muted sd-mono">' + esc(s.hostname) + '</div></td>' +
          '<td>' + (s.ip ? '<span class="sd-mono">' + esc(s.ip) + '</span>' : '<span class="muted">—</span>') + '</td>' +
          '<td>' + (s.ptr ? '✅ ' + esc(s.ptr) : '<span class="muted">no PTR</span>') + '</td>' +
          '<td>' + badge(s.status) + (s.lastError ? '<div class="muted" style="font-size:11px">' + esc(s.lastError) + '</div>' : '') + '</td>' +
          '<td><span class="sd-mono" style="font-size:11px">Postal: ' + postal + '</span></td>' +
          '<td>' + (act ? '<button class="btn btn-ghost btn-sm" data-postal="' + esc(s.id) + '">Postal creds</button>' : '<button class="btn btn-ghost btn-sm" data-prov-server="' + esc(s.id) + '">Provision</button>') + '</td></tr>' +
          '<tr id="sdPostal-' + esc(s.id) + '" style="display:none"><td colspan="6"><div class="sd-row" style="padding:6px 0">' +
            '<input data-phost="' + esc(s.id) + '" placeholder="https://' + esc(s.hostname) + '" value="' + esc(s.postalHost || ("https://" + s.hostname)) + '" style="flex:1;min-width:220px;' + inp + '">' +
            '<input data-pkey="' + esc(s.id) + '" placeholder="X-Server-API-Key from Postal" style="flex:1;min-width:200px;' + inp + '">' +
            '<button class="btn btn-sm" data-psave="' + esc(s.id) + '">Save</button>' +
          '</div><div class="muted" style="font-size:11px">After the box boots, create an org + mail server in Postal at the host above, then paste its server API key here.</div></td></tr>';
      }).join("");
      body.innerHTML =
        (state.servers.length ? '<table class="sd-table"><thead><tr><th>Server</th><th>IP</th><th>PTR / rDNS</th><th>Status</th><th>Postal</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' : '<p class="muted" style="font-size:13px;margin:0 0 10px">No MTA server yet. Add one — it becomes the MX target + PTR host for all domains.</p>') +
        '<div class="sd-row" style="margin-top:10px">' +
          '<input id="sdSrvName" placeholder="server name (e.g. mta-1)" style="' + inp + '">' +
          '<input id="sdSrvHost" placeholder="mail hostname (e.g. mail.recruitco.io)" style="flex:1;min-width:220px;' + inp + '">' +
          '<button class="btn btn-sm" id="sdAddSrv">＋ Add server</button>' +
        '</div>';
      Array.prototype.forEach.call(body.querySelectorAll("[data-prov-server]"), function (b) {
        b.addEventListener("click", function () { provisionServer(b.getAttribute("data-prov-server"), b); });
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-postal]"), function (b) {
        b.addEventListener("click", function () { var r = document.getElementById("sdPostal-" + b.getAttribute("data-postal")); if (r) r.style.display = r.style.display === "none" ? "" : "none"; });
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-psave]"), function (b) {
        b.addEventListener("click", function () {
          var id = b.getAttribute("data-psave");
          var host = body.querySelector('[data-phost="' + id + '"]').value.trim();
          var key = body.querySelector('[data-pkey="' + id + '"]').value.trim();
          if (!host || !key) { toast("Host + API key required"); return; }
          send("/sending", "POST", { action: "set-postal", id: id, host: host, apiKey: key }).then(function (r) {
            if (r.ok) { toast("Postal creds saved"); load(); } else toast("Save failed");
          });
        });
      });
      $("#sdAddSrv", el).addEventListener("click", function () {
        var name = $("#sdSrvName", el).value.trim(), host = $("#sdSrvHost", el).value.trim();
        if (!name || !host) { toast("Name + hostname required"); return; }
        send("/sending", "POST", { action: "add-server", name: name, hostname: host }).then(function (r) {
          if (r.ok) { toast("Server added — provision it to create the box + PTR"); load(); } else toast("Add failed (" + (r.data.error || r.status) + ")");
        });
      });
    }

    function provisionServer(id, btn) {
      if (btn) { btn.disabled = true; btn.textContent = "Provisioning…"; }
      send("/sending", "POST", { action: "provision-server", id: id }).then(function (r) {
        if (r.ok) toast("Server provisioned — IP + PTR set"); else toast(r.data.error || "Provision failed");
        load();
      }).catch(function () { toast("Server error"); load(); });
    }

    function paintList() {
      var body = $("#sdList", el);
      if (!state.domains.length) { body.innerHTML = '<div class="empty">No domains yet. Paste some above and hit auto-provision.</div>'; return; }
      body.innerHTML = state.domains.map(function (d) {
        var chk = (d.checklist || []).map(function (c) {
          return '<span class="sd-chip ' + (c.present ? "ok" : "no") + '">' + (c.present ? "✓ " : "") + esc(c.label) + '</span>';
        }).join("");
        var mboxes = state.mailboxes.filter(function (m) { return m.domainId === d.id; });
        var ns = (d.status === "awaiting_ns" || d.status === "verifying") && d.nameservers && d.nameservers.length
          ? '<div class="sd-ns">⚠️ One-time step: at your registrar, set this domain\'s nameservers to:<br>' +
            d.nameservers.map(function (n) { return '<code>' + esc(n) + '</code>'; }).join(" ") +
            '<br><span class="muted">Then click Verify. Everything else is already written into Hetzner DNS.</span></div>'
          : '';
        var m = d.metrics || { sent: 0, delivered: 0, bounced: 0, complained: 0 };
        var pct = function (p, w) { return w > 0 ? ((p / w) * 100).toFixed(1) + "%" : "0%"; };
        var metrics = m.sent ? '<div class="sd-chk" style="margin-top:6px">' +
          '<span class="sd-chip">📤 ' + m.sent + ' sent</span>' +
          '<span class="sd-chip ' + (m.bounced / m.sent > 0.02 ? "no" : "ok") + '">↩ ' + pct(m.bounced, m.sent) + ' bounce</span>' +
          '<span class="sd-chip ' + (m.complained / m.sent > 0.001 ? "no" : "ok") + '">🚩 ' + pct(m.complained, m.sent) + ' complaint</span>' +
          (d.reputation ? '<span class="sd-chip">⭐ rep: ' + esc(d.reputation.tier || "—") + '</span>' : '') +
          '</div>' : '';
        var warm = mboxes.length ? '<div class="muted" style="font-size:11px;margin-top:4px">warm-up: ' +
          mboxes.map(function (x) { return esc(x.address.split("@")[0]) + " d" + x.warmupDay + " (" + x.sentToday + "/" + x.dailyCap + ")"; }).join(" · ") + '</div>' : '';
        var paused = d.pausedReason ? '<div class="sd-chip no" style="margin-top:6px">⏸ paused: ' + esc(d.pausedReason) + '</div>' : '';
        return '<div style="border:1px solid var(--line,#20242c);border-radius:10px;padding:12px;margin-bottom:10px">' +
          '<div class="sd-row" style="justify-content:space-between">' +
            '<div><b class="sd-mono">' + esc(d.domain) + '</b> ' + badge(d.status) + '</div>' +
            '<div class="sd-row">' +
              '<button class="btn btn-ghost btn-sm" data-verify="' + esc(d.id) + '">Verify</button>' +
              '<button class="btn btn-ghost btn-sm" data-seedtest="' + esc(d.id) + '">Seed test</button>' +
              '<button class="btn btn-ghost btn-sm" data-psetup="' + esc(d.id) + '">Postal setup</button>' +
              '<button class="btn btn-ghost btn-sm" data-reprov="' + esc(d.id) + '">Re-provision</button>' +
              '<button class="btn btn-ghost btn-sm" data-del="' + esc(d.id) + '">Delete</button>' +
            '</div>' +
          '</div>' +
          '<div class="sd-chk" style="margin-top:8px">' + chk + '</div>' +
          metrics + paused + ns +
          '<div class="sd-row" style="margin-top:8px"><span class="muted" style="font-size:12px">' + mboxes.length + ' mailbox' + (mboxes.length === 1 ? '' : 'es') + '</span>' +
            '<input data-mbox-addr="' + esc(d.id) + '" placeholder="ryan@' + esc(d.domain) + '" style="padding:6px 9px;border-radius:7px;border:1px solid var(--line,#262a33);background:var(--bg,#0e0f13);color:inherit;font-size:12px">' +
            '<button class="btn btn-ghost btn-sm" data-add-mbox="' + esc(d.id) + '">＋ mailbox</button></div>' +
          warm +
          '<div id="sdSetup-' + esc(d.id) + '"></div>' +
          (d.lastError ? '<div class="muted" style="font-size:11px;margin-top:6px">' + esc(d.lastError) + '</div>' : '') +
          '</div>';
      }).join("");

      Array.prototype.forEach.call(body.querySelectorAll("[data-verify]"), function (b) {
        b.addEventListener("click", function () { act("verify-domain", b.getAttribute("data-verify"), b, "Verified"); });
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-reprov]"), function (b) {
        b.addEventListener("click", function () { act("provision-domain", b.getAttribute("data-reprov"), b, "Re-provisioned"); });
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-del]"), function (b) {
        b.addEventListener("click", function () { send("/sending", "POST", { action: "delete-domain", id: b.getAttribute("data-del") }).then(function () { load(); }); });
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-add-mbox]"), function (b) {
        b.addEventListener("click", function () {
          var id = b.getAttribute("data-add-mbox");
          var addr = body.querySelector('[data-mbox-addr="' + id + '"]').value.trim();
          if (!addr) { toast("Enter an address"); return; }
          send("/sending", "POST", { action: "add-mailbox", domainId: id, address: addr }).then(function (r) {
            if (r.ok) { toast("Mailbox added (warming)"); load(); } else toast("Add failed");
          });
        });
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-seedtest]"), function (b) {
        b.addEventListener("click", function () {
          b.disabled = true; b.textContent = "Sending…";
          send("/sending", "POST", { action: "seed-test", domainId: b.getAttribute("data-seedtest") }).then(function (r) {
            b.disabled = false; b.textContent = "Seed test";
            toast(r.ok ? "Seed probes sent — placement fills in as seeds report" : (r.data.error || "Need seed inboxes first"));
            load();
          });
        });
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-psetup]"), function (b) {
        b.addEventListener("click", function () {
          var id = b.getAttribute("data-psetup");
          var host = document.getElementById("sdSetup-" + id);
          if (host && host.innerHTML) { host.innerHTML = ""; return; }
          send("/sending", "POST", { action: "domain-setup", id: id }).then(function (r) {
            if (!r.ok || !r.data.setup) { toast("No setup available"); return; }
            var s = r.data.setup;
            host.innerHTML = '<div class="sd-ns" style="border-color:#7fc4f0">🔑 Postal config for this domain (paste once into Postal):<br>' +
              'Selector: <code>' + esc(s.selector) + '</code><br>' +
              '<div class="muted" style="margin:4px 0">' + esc(s.note) + '</div>' +
              (s.privateKeyPem ? '<details><summary style="cursor:pointer">Show DKIM private key</summary><textarea readonly style="width:100%;height:120px;font-family:monospace;font-size:11px;margin-top:4px">' + esc(s.privateKeyPem) + '</textarea></details>' : '') +
              '</div>';
          });
        });
      });
    }

    function paintDeliv() {
      var body = $("#sdDeliv", el); if (!body) return;
      var st = state.stats || {};
      var tot = state.domains.reduce(function (a, d) { var m = d.metrics || {}; return { sent: a.sent + (m.sent || 0), bounced: a.bounced + (m.bounced || 0), complained: a.complained + (m.complained || 0), delivered: a.delivered + (m.delivered || 0) }; }, { sent: 0, bounced: 0, complained: 0, delivered: 0 });
      var pct = function (p, w) { return w > 0 ? ((p / w) * 100).toFixed(2) + "%" : "—"; };
      var ev = (state.events || []).slice(0, 20).map(function (e) {
        var ic = { sent: "📤", delivered: "✅", bounce: "↩", complaint: "🚩", open: "👁" }[e.type] || "•";
        return '<div style="font-size:12px;padding:3px 0;border-bottom:1px solid var(--line,#1a1d24)">' + ic + ' <b>' + esc(e.type) + '</b> ' + esc(e.to || "") + (e.detail ? ' <span class="muted">' + esc(String(e.detail).slice(0, 60)) + '</span>' : '') + '</div>';
      }).join("") || '<p class="muted" style="font-size:12px">No delivery events yet. They flow in from the Postal webhook (/api/sending/webhook).</p>';
      body.innerHTML =
        '<div class="dt-stats" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">' +
          '<div class="dt-stat"><b>' + (tot.sent || 0).toLocaleString() + '</b><span>sent</span></div>' +
          '<div class="dt-stat"><b>' + pct(tot.bounced, tot.sent) + '</b><span>bounce rate</span></div>' +
          '<div class="dt-stat"><b>' + pct(tot.complained, tot.sent) + '</b><span>complaint rate</span></div>' +
          '<div class="dt-stat"><b>' + (st.suppressed || 0).toLocaleString() + '</b><span>suppressed</span></div>' +
        '</div>' +
        '<div class="muted" style="font-size:11px;margin-bottom:6px">Governor auto-pauses a domain at bounce&gt;2% or complaint&gt;0.1%. Webhook: <code class="sd-mono">/api/sending/webhook</code></div>' +
        '<div class="sd-step" style="margin-top:8px">Recent events</div>' + ev;
    }

    function paintSeeds() {
      var body = $("#sdSeeds", el); if (!body) return;
      var inp = 'padding:6px 9px;border-radius:7px;border:1px solid var(--line,#262a33);background:var(--bg,#0e0f13);color:inherit;font-size:12px';
      var list = (state.seeds || []).map(function (s) {
        return '<span class="sd-chip" style="margin:2px">' + esc(s.provider) + ': ' + esc(s.address) + ' <a href="#" data-delseed="' + esc(s.id) + '" style="color:#f08f8f">✕</a></span>';
      }).join("") || '<span class="muted" style="font-size:12px">No seed inboxes yet. Add a few across Gmail/Outlook/Yahoo to run placement tests.</span>';
      var tests = (state.seedTests || []).slice(0, 5).map(function (t) {
        var done = t.status === "complete";
        var label = done ? (t.inboxRatePct != null ? ('<b>' + t.inboxRatePct + '% inbox</b>') : 'complete') : 'sending…';
        return '<div style="font-size:12px;padding:3px 0">' + esc(t.domainId) + ' · ' + label +
          ' <span class="muted">' + t.results.map(function (r) { return r.provider + ":" + r.placement; }).join(" ") + '</span></div>';
      }).join("");
      body.innerHTML =
        '<div style="margin-bottom:8px">' + list + '</div>' +
        '<div class="sd-row"><select id="sdSeedProv" style="' + inp + '"><option value="gmail">Gmail</option><option value="outlook">Outlook</option><option value="yahoo">Yahoo</option><option value="other">Other</option></select>' +
          '<input id="sdSeedAddr" placeholder="seed@gmail.com" style="flex:1;min-width:180px;' + inp + '">' +
          '<button class="btn btn-ghost btn-sm" id="sdAddSeed">＋ Add seed</button></div>' +
        (tests ? ('<div class="sd-step" style="margin-top:10px">Recent placement tests</div>' + tests) : '');
      Array.prototype.forEach.call(body.querySelectorAll("[data-delseed]"), function (a) {
        a.addEventListener("click", function (e) { e.preventDefault(); send("/sending", "POST", { action: "delete-seed", id: a.getAttribute("data-delseed") }).then(load); });
      });
      $("#sdAddSeed", el).addEventListener("click", function () {
        var addr = $("#sdSeedAddr", el).value.trim(); if (!addr) { toast("Enter a seed address"); return; }
        send("/sending", "POST", { action: "add-seed", provider: $("#sdSeedProv", el).value, address: addr }).then(function (r) {
          if (r.ok) { toast("Seed added"); load(); } else toast("Add failed");
        });
      });
    }

    function act(action, id, btn, okMsg) {
      if (btn) { btn.disabled = true; var t = btn.textContent; btn.textContent = "…"; }
      send("/sending", "POST", { action: action, id: id }).then(function (r) {
        if (r.ok) toast(okMsg); else toast(r.data.error || "Failed");
        load();
      }).catch(function () { toast("Server error"); load(); });
    }

    $("#sdTick", el).addEventListener("click", function () {
      var b = $("#sdTick", el); b.disabled = true; b.textContent = "Running…";
      send("/sending", "POST", { action: "daily-tick" }).then(function (r) {
        b.disabled = false; b.textContent = "↻ Daily tick";
        if (r.ok) { var rep = r.data.report || {}; toast("Tick: " + (rep.warmup ? rep.warmup.advanced + " ramped" : "") + (rep.paused && rep.paused.length ? ", " + rep.paused.length + " paused" : "")); load(); } else toast("Tick failed");
      });
    });
    $("#sdGov", el).addEventListener("click", function () {
      send("/sending", "POST", { action: "run-governor" }).then(function (r) {
        if (r.ok) { var p = r.data.paused || []; toast(p.length ? ("Paused " + p.length + " domain(s)") : "All domains healthy"); load(); } else toast("Governor failed");
      });
    });

    $("#sdAdd", el).addEventListener("click", function () {
      var domains = $("#sdDomains", el).value.split(/[\s,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (!domains.length) { toast("Paste at least one domain"); return; }
      var btn = $("#sdAdd", el); btn.disabled = true; btn.textContent = "Provisioning " + domains.length + "…";
      send("/sending", "POST", { action: "add-domains", domains: domains }).then(function (r) {
        btn.disabled = false; btn.textContent = "⚡ Add & auto-provision";
        if (r.ok) {
          var res = r.data.results || [];
          var okN = res.filter(function (x) { return !x.error; }).length;
          var errs = res.filter(function (x) { return x.error; });
          toast("Provisioned " + okN + "/" + res.length + (errs.length ? " — " + (errs[0].error || "some errors") : ""));
          $("#sdDomains", el).value = "";
          load();
        } else { toast("Failed (" + (r.data.error || r.status) + ")"); }
      }).catch(function () { btn.disabled = false; btn.textContent = "⚡ Add & auto-provision"; toast("Could not reach server"); });
    });

    load();
  }

  /* ---------------- JD Sourcing ----------------
     Upload a job description -> parse an ideal-candidate profile -> generate Boolean /
     X-ray + LinkedIn searches -> run discovery (RapidAPI people-search) into a ranked,
     deduped candidate list -> save it under a NAME here (staging) -> send it to
     Candidates under that same name. Backend: /api/sourcing + lib/sourcing/*. */
  function renderJdSourcing(el) {
    var state = { jd: "", icp: null, queries: [], candidates: [], warnings: [], note: "" };

    el.innerHTML =
      '<style>' +
      '.jd-chip{display:inline-block;background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:3px 10px;margin:2px 5px 2px 0;font-size:12px;color:var(--text-muted)}' +
      '.jd-icp{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-top:12px}' +
      '.jd-icp>div b{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim);margin-bottom:7px;font-weight:700}' +
      '.jd-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:14px}' +
      '.jd-cap{font-size:12.5px;color:var(--text-muted);display:inline-flex;align-items:center;gap:6px}' +
      '.jd-cap input{width:62px;background:var(--bg-soft);border:1px solid var(--border-strong);border-radius:7px;color:var(--text);font:inherit;font-size:12.5px;padding:5px 7px;margin:0 2px}' +
      '#jdName,#jdText{width:100%;background:var(--bg-soft);border:1px solid var(--border-strong);border-radius:10px;color:var(--text);font:inherit;font-size:14px;padding:11px 13px}' +
      '#jdName{margin-bottom:10px;font-weight:600}#jdText{line-height:1.55;resize:vertical;min-height:170px}' +
      '#jdName::placeholder,#jdText::placeholder{color:var(--text-dim)}' +
      '#jdName:focus,#jdText:focus,.jd-cap input:focus{outline:0;border-color:var(--brand);box-shadow:0 0 0 3px rgba(124,92,255,.18)}' +
      '.jd-queries{max-height:240px;overflow:auto;border:1px solid var(--border);border-radius:10px;padding:6px 12px;background:var(--bg-soft)}' +
      '.jd-q{padding:8px 0;font-size:13px;border-bottom:1px solid var(--border)}.jd-q:last-child{border-bottom:0}' +
      '.jd-q-label{display:inline-block;min-width:260px;font-weight:600}' +
      '.jd-q a{color:var(--brand-2);text-decoration:none}.jd-q a:hover{text-decoration:underline}' +
      '.jd-tablewrap{max-height:460px;overflow:auto;border:1px solid var(--border);border-radius:12px;margin-top:10px}' +
      '.jd-table{width:100%;border-collapse:collapse;font-size:13px}' +
      '.jd-table th,.jd-table td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums}' +
      '.jd-table tbody tr:hover td{background:var(--surface-2)}' +
      '.jd-table th{position:sticky;top:0;background:var(--bg-soft);font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-dim);font-weight:700;white-space:nowrap}' +
      '.jd-table a{color:var(--brand-2);text-decoration:none}.jd-table a:hover{text-decoration:underline}' +
      '.jd-run{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--border)}.jd-run:last-child{border-bottom:0}' +
      '.jd-run-actions{display:flex;gap:6px;flex-wrap:wrap}' +
      '</style>' +
      head("JD Sourcing", "Upload a job description → find & rank candidates by geography, role, and qualifications → save the list, then send it to Candidates under the same name.") +
      '<div class="card">' +
        '<input id="jdName" type="text" placeholder="Name this list — e.g. JAGGAER VP Sales · East" />' +
        '<textarea id="jdText" rows="8" placeholder="Paste the full job description here…"></textarea>' +
        '<div class="jd-actions">' +
          '<button class="btn btn-primary btn-sm" id="jdAnalyze">Analyze JD</button>' +
          '<button class="btn btn-ghost btn-sm" id="jdFind" disabled>🧲 Find candidates</button>' +
          '<span class="jd-cap muted">Max <input id="jdCap" type="number" min="100" max="5000" value="3000"> · min fit <input id="jdMinFit" type="number" min="0" max="100" value="45"></span>' +
          '<button class="btn btn-ghost btn-sm" id="jdSave" disabled>💾 Save to JD Sourcing</button>' +
        '</div>' +
        '<div id="jdMsg" class="muted" style="margin-top:8px"></div>' +
      '</div>' +
      '<div id="jdPlan"></div>' +
      '<div id="jdResults"></div>' +
      '<div class="card"><h3>Saved sourcing lists</h3><div id="jdRuns">' + loading() + '</div></div>';

    function msg(t) { var m = $("#jdMsg"); if (m) m.textContent = t || ""; }
    function chips(arr) { return (arr || []).map(function (x) { return '<span class="jd-chip">' + esc(x) + '</span>'; }).join("") || '<span class="muted">—</span>'; }

    function renderPlan() {
      var host = $("#jdPlan"); if (!host) return;
      if (!state.icp) { host.innerHTML = ""; return; }
      var i = state.icp;
      host.innerHTML = '<div class="card"><h3>Ideal candidate · ' + esc(i.label || "") + '</h3>' +
        '<div class="jd-icp">' +
          '<div><b>Titles</b><br>' + chips(i.titles) + '</div>' +
          '<div><b>Geos</b><br>' + chips(i.geos) + '</div>' +
          '<div><b>Target companies</b><br>' + chips(i.targetCompanies) + '</div>' +
          '<div><b>Industries</b><br>' + chips(i.industries) + '</div>' +
          '<div><b>Sells to</b><br>' + chips(i.sellsTo) + '</div>' +
          '<div><b>Disqualifiers</b><br>' + chips(i.disqualifiers) + '</div>' +
        '</div>' +
        '<h4 style="margin-top:14px">Generated searches (' + state.queries.length + ')</h4>' +
        '<div class="jd-queries">' + state.queries.map(function (q) {
          return '<div class="jd-q"><span class="jd-q-label">' + esc(q.label) + '</span>' +
            '<a href="' + esc(q.googleUrl) + '" target="_blank" rel="noopener">Google X-ray</a> · ' +
            '<a href="' + esc(q.linkedinUrl) + '" target="_blank" rel="noopener">LinkedIn</a></div>';
        }).join("") + '</div>' +
        (state.note ? '<p class="muted" style="margin-top:10px">' + esc(state.note) + '</p>' : '') +
      '</div>';
    }

    function renderResults() {
      var host = $("#jdResults"); if (!host) return;
      if (!state.candidates.length) { host.innerHTML = ""; return; }
      var rows = state.candidates.slice(0, 300).map(function (c) {
        return '<tr><td>' + c.fitScore + '</td><td>' + esc(c.fullName) + '</td><td>' + esc(c.title || c.headline || "") +
          '</td><td>' + esc(c.company || "") + '</td><td>' + esc(c.location || "") + '</td>' +
          '<td>' + (c.linkedinUrl ? '<a href="' + esc(c.linkedinUrl) + '" target="_blank" rel="noopener">view</a>' : '') + '</td></tr>';
      }).join("");
      host.innerHTML = '<div class="card"><h3>Ranked candidates · ' + state.candidates.length + '</h3>' +
        (state.warnings.length ? '<p class="muted">⚠ ' + esc(state.warnings.join(" · ")) + '</p>' : '') +
        '<div class="jd-tablewrap"><table class="jd-table"><thead><tr><th>Fit</th><th>Name</th><th>Title</th><th>Company</th><th>Location</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        (state.candidates.length > 300 ? '<p class="muted">Showing top 300 of ' + state.candidates.length + '. Save to keep the full set.</p>' : '') +
      '</div>';
    }

    function loadRuns() {
      api("/sourcing").then(function (d) {
        var host = $("#jdRuns"); if (!host) return;
        var runs = (d && d.runs) || [];
        if (!runs.length) { host.innerHTML = '<p class="muted">No saved lists yet. Analyze a JD, find candidates, then Save.</p>'; return; }
        host.innerHTML = runs.map(function (r) {
          var n = r.candidates ? r.candidates.length : 0;
          return '<div class="jd-run"><div><b>' + esc(r.name) + '</b> <span class="muted">· ' + n + ' candidates' +
            (r.promotedCount ? (' · sent ' + r.promotedCount + ' to Candidates') : '') + '</span></div>' +
            '<div class="jd-run-actions">' +
              '<button class="btn btn-primary btn-sm" data-promote="' + esc(r.id) + '">Send to Candidates →</button>' +
              '<button class="btn btn-ghost btn-sm" data-enrich="' + esc(r.id) + '">⚡ Enrich top 50</button>' +
              '<button class="btn btn-ghost btn-sm" data-del="' + esc(r.id) + '">Delete</button>' +
            '</div></div>';
        }).join("");
      }).catch(function () { var host = $("#jdRuns"); if (host) host.innerHTML = '<p class="muted">Could not load saved lists.</p>'; });
    }

    $("#jdAnalyze").addEventListener("click", function () {
      var jd = $("#jdText").value.trim(); if (!jd) { msg("Paste a job description first."); return; }
      state.jd = jd; msg("Analyzing…");
      send("/sourcing", "POST", { action: "plan", jd: jd }).then(function (r) {
        if (!r.ok) { msg("Analyze failed: " + ((r.data && r.data.error) || r.status)); return; }
        state.icp = r.data.icp; state.queries = r.data.queries || []; state.note = r.data.note || "";
        $("#jdFind").disabled = false; msg(""); renderPlan();
      });
    });

    $("#jdFind").addEventListener("click", function () {
      if (!state.jd) { msg("Analyze a JD first."); return; }
      var cap = parseInt($("#jdCap").value, 10) || 3000;
      var minFit = parseInt($("#jdMinFit").value, 10); if (isNaN(minFit)) minFit = 45;
      msg("Searching… finding and ranking profiles can take a moment.");
      $("#jdFind").disabled = true;
      send("/sourcing", "POST", { action: "run", jd: state.jd, cap: cap, minFit: minFit }).then(function (r) {
        $("#jdFind").disabled = false;
        if (!r.ok) { msg("Find failed: " + ((r.data && r.data.error) || r.status)); return; }
        state.icp = r.data.icp || state.icp; state.queries = r.data.queries || state.queries;
        state.candidates = r.data.candidates || []; state.warnings = r.data.warnings || [];
        $("#jdSave").disabled = !state.candidates.length;
        msg("Found " + state.candidates.length + " candidates (scanned " + (r.data.scanned || 0) + ").");
        renderPlan(); renderResults();
      });
    });

    $("#jdSave").addEventListener("click", function () {
      var name = $("#jdName").value.trim(); if (!name) { msg("Give the list a name to save it."); $("#jdName").focus(); return; }
      if (!state.icp) { msg("Analyze a JD first."); return; }
      msg("Saving…");
      send("/sourcing", "POST", { action: "save", name: name, jd: state.jd, icp: state.icp, queries: state.queries, candidates: state.candidates, warnings: state.warnings }).then(function (r) {
        if (!r.ok) { msg("Save failed: " + ((r.data && r.data.error) || r.status)); return; }
        msg('Saved "' + name + '" to JD Sourcing. Review it below, then send to Candidates.'); loadRuns();
      });
    });

    $("#jdRuns").addEventListener("click", function (e) {
      var t = e.target; if (t.tagName !== "BUTTON") return;
      var id;
      if ((id = t.getAttribute("data-promote"))) {
        if (!confirm("Send this list to Candidates under its saved name?")) return;
        t.disabled = true; t.textContent = "Sending…";
        send("/sourcing", "POST", { action: "promote", id: id }).then(function (r) {
          if (!r.ok) { t.disabled = false; t.textContent = "Send to Candidates →"; alert("Promote failed: " + ((r.data && r.data.error) || r.status)); return; }
          alert('Sent ' + r.data.added + ' to Candidates as "' + r.data.name + '"' + (r.data.deduped ? (' (' + r.data.deduped + ' already in pipeline)') : '') + '.'); loadRuns();
        });
      } else if ((id = t.getAttribute("data-enrich"))) {
        t.disabled = true; t.textContent = "Enriching…";
        send("/sourcing", "POST", { action: "enrich", id: id, top: 50 }).then(function (r) {
          t.disabled = false; t.textContent = "⚡ Enrich top 50";
          if (!r.ok) { alert("Enrich failed: " + ((r.data && r.data.error) || r.status)); return; }
          alert("Enriched " + r.data.enriched + " contacts."); loadRuns();
        });
      } else if ((id = t.getAttribute("data-del"))) {
        if (!confirm("Delete this saved list?")) return;
        send("/sourcing", "POST", { action: "delete", id: id }).then(loadRuns);
      }
    });

    loadRuns();
  }

  /* ---------------- OS Text (taltxt), single sign-on embed ----------------
     OS Text loads right inside the Command Center panel (the sidebar stays), so
     it populates in the tab like every other view. The iframe loads the portal's
     /api/ostext/enter endpoint, which (server-side, session-gated) signs you into
     taltxt and lands you straight in the app — no second login. The same app is
     also available full-screen at /text.

     Local dev: set window.RECRUITEROS_OSTEXT_URL to a taltxt URL to embed it
     directly (bypassing the SSO endpoint). */
  var OSTEXT_SRC = (typeof window !== "undefined" && window.RECRUITEROS_OSTEXT_URL) || "/api/ostext/enter";

  function ostextFrame(src) {
    return '<div class="card" style="padding:0;overflow:hidden">' +
      '<iframe src="' + esc(src) + '" title="OS Text" ' +
      'style="width:100%;height:calc(100vh - 160px);min-height:620px;border:0;border-radius:12px;background:var(--bg)" ' +
      'allow="clipboard-read; clipboard-write; microphone"></iframe>' +
      "</div>";
  }

  function renderOstext(el) {
    el.innerHTML = head("OS Text", "The texting engine, right inside your workspace.") + ostextFrame(OSTEXT_SRC);
  }

  /* ---------------- Voice Drops ----------------
     Compliant landline/VoIP voicemail outreach. Premium AMD detects the voicemail
     and drops a cloned-voice message with the first name + role spliced in. Mobiles
     are filtered out and never dialed; each lead is dialed only inside its own local
     window (default 6–7 PM). Three tabs: Campaigns, Voice & Consent, Test. Talks to
     /api/voice/*. Shared by BD + Recruiting (the active motion tags the campaign). */
  var VD_DEFAULT_SCRIPT =
    "Hi {first_name}, this is {agent_name} with {agent_company}. I came across your {role} search and wanted to reach out — we help teams hire faster. If it’s useful, give me a call back at this number. Thanks {first_name}.";
  var VD_CONSENT_TEXT =
    "I consent to RecruiterOS creating and using a synthetic copy of my voice for outreach that I authorize.";

  function renderVoiceDrops(el) {
    var vd = { tab: "campaigns" };
    el.innerHTML = head("Voice Drops",
      "Personalized voicemail outreach to verified business landline/VoIP lines. Premium AMD finds the voicemail, then drops a cloned-voice message with the first name and role spliced in. Mobiles are filtered out and never dialed; each lead is dialed only inside its own local window (default 6–7 PM).") +
      '<div class="vd-tabs" style="display:flex;gap:8px;margin:2px 0 16px;flex-wrap:wrap"></div>' +
      '<div id="vdBody">' + loading() + "</div>";

    function tabBar() {
      var tabs = [["campaigns", "📞 Campaigns"], ["voice", "🎙️ Voice & Consent"], ["test", "🧪 Test"]];
      $(".vd-tabs", el).innerHTML = tabs.map(function (t) {
        return '<button class="btn btn-sm ' + (vd.tab === t[0] ? "btn-primary" : "") + '" data-vdtab="' + t[0] + '">' + t[1] + "</button>";
      }).join("");
    }
    $(".vd-tabs", el).addEventListener("click", function (e) {
      var b = e.target.closest("[data-vdtab]"); if (!b) return;
      vd.tab = b.getAttribute("data-vdtab"); tabBar(); paint();
    });

    function paint() {
      var body = $("#vdBody"); if (!body) return;
      if (vd.tab === "campaigns") return paintCampaigns(body);
      if (vd.tab === "voice") return paintVoice(body);
      return paintTest(body);
    }

    /* ---- shared bits ---- */
    function fieldChips(targetId) {
      return ["first_name", "role", "company", "agent_name", "agent_company"].map(function (f) {
        return '<button type="button" class="btn btn-sm" data-chip="' + f + '" data-target="' + targetId + '">{' + f + "}</button>";
      }).join(" ");
    }
    function wireChips(scope) {
      Array.prototype.forEach.call(scope.querySelectorAll("[data-chip]"), function (b) {
        b.addEventListener("click", function () {
          var ta = $("#" + b.getAttribute("data-target")); if (!ta) return;
          var ins = "{" + b.getAttribute("data-chip") + "}";
          var s = ta.selectionStart || ta.value.length;
          ta.value = ta.value.slice(0, s) + ins + ta.value.slice(ta.selectionEnd || s);
          ta.focus();
        });
      });
    }
    function statRow(stats) {
      stats = stats || {};
      var order = [["voicemail_delivered", "VM dropped", "#34d399"], ["dialing", "Dialing", "#ffc24d"],
        ["scheduled", "Scheduled", "#8aa0c6"], ["queued", "Queued", "#8aa0c6"],
        ["human_answered", "Human", "#b9a6ff"], ["no_answer", "No answer", "#8aa0c6"],
        ["filtered_mobile", "Mobiles filtered", "#ff7a90"], ["suppressed", "Suppressed", "#ff7a90"]];
      return '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px">' + order.map(function (o) {
        return '<span style="font-size:13px"><b style="color:' + o[2] + '">' + (stats[o[0]] || 0) + "</b> <span class='muted'>" + o[1] + "</span></span>";
      }).join("") + "</div>";
    }

    /* ---- Campaigns tab ---- */
    function newCampaignForm() {
      return '<div class="vd-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
        inp("vdName", "Campaign name", "Q3 VP Sales — landlines") +
        inp("vdCaller", "Approved 10DLC caller-ID (E.164)", "+13105551234") +
        inp("vdAgentName", "Your name (stated on the call)", "Ryan") +
        inp("vdAgentCompany", "Your firm (stated on the call)", "Executive Search") +
        inp("vdWinStart", "Window start (local hour, 24h)", "18", "number") +
        inp("vdWinEnd", "Window end (local hour, 24h)", "19", "number") +
        inp("vdDailyCap", "Daily cap", "100", "number") +
        inp("vdFreq", "Min days between attempts", "30", "number") +
        "</div>" +
        '<div class="vd-field vd-script"><label>Voicemail script <span>— first name &amp; role splice in like an email merge</span></label>' +
        '<div class="vd-chips">' + fieldChips("vdScript") + "</div>" +
        '<textarea id="vdScript" rows="4">' + esc(VD_DEFAULT_SCRIPT) + "</textarea>" +
        '<div class="vd-hint">Sweet spot is 15–25s. Human-answer sign-off: “' + esc("Sorry, wrong number. Thanks.") + '” (editable per campaign).</div></div>' +
        '<div class="vd-actions"><button class="btn btn-primary btn-sm" id="vdCreate">Create campaign</button></div>';
    }
    function inp(id, label, ph, type) {
      return '<div class="vd-field"><label>' + esc(label) + "</label>" +
        '<input id="' + id + '" type="' + (type || "text") + '" placeholder="' + esc(ph) + '" /></div>';
    }
    function campaignCard(c) {
      var win = "6–7 PM"; try { win = hr(c.window.startHour) + "–" + hr(c.window.endHour); } catch (e) {}
      var ready = c.consentAttested;
      return '<div class="card" data-cid="' + c.id + '" style="margin-top:12px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
        "<h3 style='margin:0'>" + esc(c.name) + ' <span class="muted" style="font-size:12px">· ' + esc(c.status) + "</span></h3>" +
        '<span class="muted" style="font-size:12px">caller ' + esc(c.callerId || "—") + " · window " + esc(win) + " local · " + esc(c.motion) + "</span></div>" +
        statRow(c.stats) +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">' +
        '<button class="btn btn-sm" data-vdact="import" data-cid="' + c.id + '">⬆ Import leads</button>' +
        '<button class="btn btn-sm ' + (ready ? "" : "btn-primary") + '" data-vdact="attest" data-cid="' + c.id + '">' + (ready ? "✓ Consent attested" : "Attest consent") + "</button>" +
        '<button class="btn btn-sm btn-primary" data-vdact="launch" data-cid="' + c.id + '">▶ Launch</button>' +
        '<button class="btn btn-sm" data-vdact="run" data-cid="' + c.id + '">⏱ Run window now</button>' +
        '<button class="btn btn-sm" data-vdact="del" data-cid="' + c.id + '">🗑</button></div>' +
        '<div class="vd-msg muted" data-msg="' + c.id + '" style="font-size:12px;margin-top:8px"></div></div>';
    }
    function hr(h) { var n = ((h + 11) % 12) + 1; return n + (h < 12 ? " AM" : " PM"); }

    function paintCampaigns(body) {
      body.innerHTML = loading();
      api("/voice/campaigns?motion=" + motion).then(function (d) {
        var list = ((d && d.campaigns) || []).map(campaignCard).join("");
        body.innerHTML = '<div class="card"><h3>New voice campaign</h3>' + newCampaignForm() + "</div>" +
          (list || '<p class="muted" style="margin-top:16px">No voice campaigns yet — create one above.</p>') +
          '<div style="margin-top:14px;padding:10px;border-radius:8px;background:rgba(255,255,255,.03)" class="muted">' +
          '<b>Compliance:</b> only landline/VoIP leads are dialed (mobiles are stripped on import via Telnyx). Each lead is dialed only inside its own local time window (default 6–7 PM, hard-bounded to 8 AM–9 PM). Launch requires a consent attestation and an identifying script.</div>';
        wireChips(body);
        $("#vdCreate").addEventListener("click", createCampaign);
        Array.prototype.forEach.call(body.querySelectorAll("[data-vdact]"), function (b) {
          b.addEventListener("click", function () { campaignAction(b.getAttribute("data-vdact"), b.getAttribute("data-cid")); });
        });
      }).catch(function () { body.innerHTML = needsSetup(); });
    }
    function val(id) { var e = $("#" + id); return e ? e.value.trim() : ""; }
    function createCampaign() {
      var payload = {
        name: val("vdName"), motion: motion, callerId: val("vdCaller"),
        scriptTemplate: val("vdScript"),
        persona: { agentName: val("vdAgentName") || "Ryan", agentCompany: val("vdAgentCompany") || "Executive Search" },
        window: { startHour: parseInt(val("vdWinStart") || "18", 10), endHour: parseInt(val("vdWinEnd") || "19", 10) },
        dailyCap: parseInt(val("vdDailyCap") || "100", 10), frequencyCapDays: parseInt(val("vdFreq") || "30", 10)
      };
      if (!payload.name) { toast("Name the campaign first."); return; }
      send("/voice/campaigns", "PUT", payload).then(function (r) {
        if (!r.ok) { toast("Create failed"); return; }
        toast("Campaign created"); paint();
      });
    }
    function setMsg(cid, t) { var m = $('[data-msg="' + cid + '"]'); if (m) m.innerHTML = t; }
    function campaignAction(act, cid) {
      if (act === "del") { send("/voice/campaigns?id=" + cid, "DELETE").then(function () { toast("Deleted"); paint(); }); return; }
      if (act === "import") return importModal(cid);
      if (act === "attest") {
        send("/voice/campaigns", "POST", { action: "attest", campaignId: cid }).then(function (r) {
          if (r.ok) { toast("Consent attested"); paint(); }
        });
        return;
      }
      if (act === "launch") {
        send("/voice/campaigns", "POST", { action: "launch", campaignId: cid }).then(function (r) {
          if (r.ok) { toast("Launched"); paint(); }
          else { var errs = (r.data && r.data.errors) || ["Not ready"]; setMsg(cid, "⚠ " + errs.map(esc).join(" · ")); }
        });
        return;
      }
      if (act === "run") {
        setMsg(cid, "Running this window…");
        send("/voice/campaigns", "POST", { action: "run", campaignId: cid }).then(function (r) {
          if (!r.ok) { setMsg(cid, "Run failed"); return; }
          var s = r.data.summary || {};
          setMsg(cid, "Dialed " + s.dialed + " · scheduled " + s.scheduled + " (outside window) · skipped " + s.skipped + " · synthesized " + s.synthesized + " / cached " + s.cached + (s.dryRun ? " · dry-run (no Telnyx/clone keys)" : ""));
          paint();
        });
        return;
      }
    }
    function importModal(cid) {
      openModal("Import leads", "Paste rows: first_name, role, company, phone, location (one per line, header optional). Mobiles are auto-stripped — only landline/VoIP get dialed.",
        '<textarea id="vdCsv" rows="8" style="width:100%" placeholder="Hector,VP Sales,Jaggaer,+18015551234,Salt Lake City UT"></textarea>' +
        '<div class="modal-foot" style="margin-top:10px"><button class="btn btn-primary btn-sm" id="vdImportGo">Classify &amp; import</button></div>',
        function (root, close) {
          $("#vdImportGo", root).addEventListener("click", function () {
            var leads = parseCsv($("#vdCsv", root).value);
            if (!leads.length) { toast("No rows parsed"); return; }
            send("/voice/campaigns", "POST", { action: "import", campaignId: cid, leads: leads }).then(function (r) {
              close();
              if (!r.ok) { toast("Import failed"); return; }
              var s = r.data.summary || {};
              toast("Imported " + s.imported + " · dialable " + s.dialable + " · mobiles stripped " + s.filteredMobile);
              setMsg(cid, "Imported " + s.imported + " — " + s.dialable + " dialable landline/VoIP, " + s.filteredMobile + " mobiles stripped" + (s.noTimezone ? ", " + s.noTimezone + " missing a resolvable location" : ""));
              paint();
            });
          });
        });
    }
    function parseCsv(text) {
      var lines = String(text || "").split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
      if (!lines.length) return [];
      var out = [];
      var first = lines[0].toLowerCase();
      var hasHeader = /first|phone|role|name/.test(first) && /,/.test(first);
      var start = hasHeader ? 1 : 0;
      for (var i = start; i < lines.length; i++) {
        var c = lines[i].split(",").map(function (x) { return x.trim(); });
        if (!c.length) continue;
        var phone = c[3] || c.find(function (x) { return /\+?\d{7,}/.test(x); }) || "";
        if (!phone) continue;
        out.push({ firstName: c[0] || "", role: c[1] || "", company: c[2] || "", phone: phone, location: c[4] || "" });
      }
      return out;
    }

    /* ---- Voice & Consent tab ---- */
    function paintVoice(body) {
      body.innerHTML = loading();
      api("/voice/clones").then(function (d) {
        d = d || {};
        var cache = d.cache || { total: 0, byKind: {} };
        var prov = d.provider || { configured: false, id: "—" };
        var kinds = Object.keys(cache.byKind || {}).map(function (k) { return "<b>" + (cache.byKind[k]) + "</b> " + esc(k); }).join(" · ") || "none yet";
        var consent = (d.consent || []).map(function (c) {
          return '<div style="font-size:13px;margin-top:4px">🎙️ <b>' + esc(c.agentName) + "</b> " + (c.voiceId ? '<span class="muted">voice ' + esc(c.voiceId) + "</span>" : '<span class="muted">(no voice id)</span>') + "</div>";
        }).join("") || '<p class="muted">No consented voices recorded yet.</p>';
        body.innerHTML =
          '<div class="card"><h3>Cloned voice &amp; consent</h3>' +
          '<p class="muted" style="font-size:13px">Use your OWN voice, captured with a recorded consent statement. The clone provider is <b>' + esc(prov.id) + "</b> — " + (prov.configured ? "configured." : "not configured (dry-run; set VOICE_CLONE_API_KEY).") + "</p>" +
          '<div class="vd-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
          inp("vcName", "Whose voice (your name)", "Ryan") +
          inp("vcVoiceId", "Provider voice id (optional)", "el_xxx") + "</div>" +
          '<div style="margin-top:10px"><label class="muted" style="font-size:12px">Consent statement</label>' +
          '<textarea id="vcStatement" rows="2" style="width:100%">' + esc(VD_CONSENT_TEXT) + "</textarea></div>" +
          '<div style="margin-top:10px"><button class="btn btn-primary btn-sm" id="vcSave">Record consent</button></div></div>' +
          '<div class="card" style="margin-top:14px"><h3>Cloned-snippet repository (the token-saver)</h3>' +
          '<p class="muted" style="font-size:13px">First names, roles, and static prose are synthesized once and reused forever — repeat names/roles cost $0. Rendered segments: <b>' + (cache.total || 0) + "</b> (" + kinds + ").</p>" +
          '<div>' + consent + "</div></div>";
        $("#vcSave").addEventListener("click", function () {
          var payload = { agentName: val("vcName"), statement: val("vcStatement"), voiceId: val("vcVoiceId") || undefined };
          if (!payload.agentName || !payload.statement) { toast("Name + consent statement required"); return; }
          send("/voice/clones", "POST", payload).then(function (r) {
            if (r.ok) { toast("Consent recorded" + (r.data && r.data.dryRun ? " (dry-run)" : "")); paint(); }
            else { toast("Save failed"); }
          });
        });
      }).catch(function () { body.innerHTML = needsSetup(); });
    }

    /* ---- Test tab ---- */
    function paintTest(body) {
      body.innerHTML =
        '<div class="card"><h3>Test a single drop</h3>' +
        '<p class="muted" style="font-size:13px">Fire one personalized drop to a number YOU control to verify the path (classify → assemble cloned voicemail → dial with AMD). Skips the time window; otherwise identical to production.</p>' +
        '<div class="vd-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
        inp("vtTo", "Your test number (E.164)", "+13105551234") +
        inp("vtFirst", "First name", "Hector") +
        inp("vtRole", "Role", "VP of Sales") +
        inp("vtCompany", "Company", "Jaggaer") +
        inp("vtAgentName", "Your name", "Ryan") +
        inp("vtAgentCompany", "Your firm", "Executive Search") + "</div>" +
        '<div style="margin-top:10px"><div style="margin:4px 0">' + fieldChips("vtScript") + "</div>" +
        '<textarea id="vtScript" rows="4" style="width:100%">' + esc(VD_DEFAULT_SCRIPT) + "</textarea></div>" +
        '<div style="margin-top:10px"><button class="btn btn-primary btn-sm" id="vtGo">Send test drop</button></div>' +
        '<div id="vtResult" style="margin-top:12px"></div></div>';
      wireChips(body);
      $("#vtGo").addEventListener("click", function () {
        var payload = {
          to: val("vtTo"), firstName: val("vtFirst"), role: val("vtRole"), company: val("vtCompany"),
          scriptTemplate: val("vtScript"), motion: motion,
          persona: { agentName: val("vtAgentName") || "Ryan", agentCompany: val("vtAgentCompany") || "Executive Search" }
        };
        if (!payload.to) { toast("Enter your test number"); return; }
        $("#vtResult").innerHTML = loading();
        send("/voice/test-drop", "POST", payload).then(function (r) {
          if (!r.ok) { $("#vtResult").innerHTML = '<p class="muted">Test failed: ' + esc((r.data && r.data.detail) || (r.data && r.data.error) || r.status) + "</p>"; return; }
          var d = r.data;
          $("#vtResult").innerHTML = '<div style="padding:10px;border-radius:8px;background:rgba(255,255,255,.03)">' +
            "<div style='font-size:13px'><b>Rendered (~" + d.estSeconds + "s" + (d.withinSweetSpot ? ", in the 15–25s sweet spot" : ", outside sweet spot") + "):</b></div>" +
            '<div style="font-size:13px;margin:6px 0">“' + esc(d.rendered) + "”</div>" +
            '<div class="muted" style="font-size:12px">segments ' + d.playlistLength + ' · synthesized ' + d.synthesized + ' · cached ' + d.cached + (d.dryRun ? ' · dry-run (no Telnyx/clone keys — nothing dialed)' : ' · dialing ' + esc(d.callControlId)) + '</div>' +
            ((d.warnings && d.warnings.length) ? '<div style="font-size:12px;color:#ffc24d;margin-top:4px">⚠ ' + d.warnings.map(esc).join(" · ") + "</div>" : "") +
            "</div>";
        });
      });
    }

    tabBar(); paint();
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

  /* ---------------- Campaign Sequences Library ----------------
     The master list of every sequence in the workspace (table layout). Shares
     one store (ros_sequences + /api/sequences) with Campaigns (which creates
     them) and Campaign Studio (which drops + assigns them) — so all three work
     off the same data. Create / Edit here open the same channel editor. */
  function newSequenceFlow() {
    openModal("New sequence", "Pick a channel to build.",
      '<div class="seq-new-grid">' + Object.keys(CHANNELS).map(function (ch) {
        var c = CHANNELS[ch];
        return '<button class="seq-new" data-ch="' + ch + '"><span class="seq-new-ic">' + c.icon + "</span>" +
          '<span class="seq-new-t">' + c.label + " sequence</span><span class=\"seq-new-b\">" + esc(c.blurb) + "</span></button>";
      }).join("") + "</div>",
      function (root, close) {
        root.querySelector(".seq-new-grid").addEventListener("click", function (e) {
          var b = e.target.closest("[data-ch]"); if (!b) return;
          close(); openEditor(newSequence(b.getAttribute("data-ch")));
        });
      });
  }

  function renderContent(el) {
    var store = seqStore();
    var meName = (ctx.user && ctx.user.name) || "You";
    var filter = "", mineOnly = false, tagFilter = "";
    function fmtDate(iso) { try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); } catch (e) { return ""; } }
    function allTags() { var set = {}; store.all().forEach(function (s) { (s.tags || []).forEach(function (t) { set[t] = 1; }); }); return Object.keys(set).sort(); }

    el.innerHTML = head("Sequences", "Every outreach sequence in your workspace. Build them in Campaigns, then drop them into Campaign Studio to assign prospects and deploy.") +
      '<div class="seqlib-tools">' +
        '<button class="sl-fbtn" id="slMine"><span>👤</span> My Sequences</button>' +
        '<span class="sl-tagwrap"><button class="sl-fbtn" id="slTagBtn"><span>🏷</span> Tags <b id="slTagLbl"></b></button>' +
          '<select id="slTag" class="sl-tagsel"><option value="">All tags</option></select></span>' +
        '<label class="seqlib-search"><span>⌕</span><input id="slSearch" placeholder="Search…" autocomplete="off"/></label>' +
        '<span class="sl-count" id="slCount"></span>' +
      "</div>" +
      '<div id="slBody">' + loading() + "</div>" +
      '<div id="slVoice" style="margin-top:18px"></div>';

    $("#slSearch").addEventListener("input", function () { filter = (this.value || "").toLowerCase().trim(); paint(); });
    $("#slMine").addEventListener("click", function () { mineOnly = !mineOnly; this.classList.toggle("active", mineOnly); paint(); });
    var tagSel = $("#slTag");
    tagSel.addEventListener("change", function () { tagFilter = this.value; var lbl = $("#slTagLbl"); if (lbl) lbl.textContent = tagFilter ? "· " + tagFilter : ""; $("#slTagBtn").classList.toggle("active", !!tagFilter); paint(); });
    $("#slTagBtn").addEventListener("click", function () { try { tagSel.focus(); tagSel.click(); } catch (e) {} });

    function syncTagOptions() {
      var tags = allTags();
      tagSel.innerHTML = '<option value="">All tags</option>' + tags.map(function (t) { return '<option value="' + esc(t) + '"' + (t === tagFilter ? " selected" : "") + ">" + esc(t) + "</option>"; }).join("");
    }
    function matchesF(s) {
      if (mineOnly && (s.owner || "") !== meName) return false;
      if (tagFilter && (s.tags || []).indexOf(tagFilter) < 0) return false;
      if (!filter) return true;
      return ((s.name || "") + " " + (s.owner || "") + " " + (s.tags || []).join(" ") + " " + (s.channel || "")).toLowerCase().indexOf(filter) >= 0;
    }
    function emptyCreate(msg) {
      return '<div class="card" style="text-align:center;padding:34px 22px">' +
        '<p class="muted" style="margin-bottom:18px">' + msg + "</p>" +
        '<div class="seq-new-grid" id="slCreate" style="max-width:760px;margin:0 auto">' +
        Object.keys(CHANNELS).map(function (ch) { var c = CHANNELS[ch]; return '<button class="seq-new" data-ch="' + ch + '"><span class="seq-new-ic">' + c.icon + "</span><span class=\"seq-new-t\">" + c.label + " sequence</span><span class=\"seq-new-b\">" + esc(c.blurb) + "</span></button>"; }).join("") +
        "</div></div>";
    }
    function paint() {
      var list = store.all();
      var body = $("#slBody"); if (!body) return;
      syncTagOptions();
      var rows = list.filter(matchesF).sort(function (a, b) { return (b.updatedAt || "") < (a.updatedAt || "") ? -1 : 1; });
      var cn = $("#slCount"); if (cn) cn.textContent = rows.length + " of " + list.length;
      if (!list.length) { body.innerHTML = emptyCreate("No sequences yet — pick a channel to build your first one. It'll appear here and in Campaign Studio."); wireCreate(); return; }
      if (!rows.length) { body.innerHTML = '<div class="empty">No sequences match that filter.</div>'; return; }
      var trs = rows.map(function (s) {
        var c = CHANNELS[s.channel] || CHANNELS.email;
        var n = (s.steps || []).length;
        var tags = (s.tags || []).map(function (t) { return '<span class="sl-tag">' + esc(t) + "</span>"; }).join("") || '<span class="muted">—</span>';
        var active = s.status === "active";
        return '<tr data-id="' + esc(s.id) + '">' +
          '<td class="sl-name"><span class="seq-chip ' + s.channel + '">' + c.label + "</span> " + esc(s.name) + "</td>" +
          "<td>" + esc(s.owner || "—") + "</td>" +
          '<td class="sl-c">' + n + "</td>" +
          "<td>" + tags + "</td>" +
          '<td><button class="sl-status ' + (active ? "on" : "off") + '" data-status="' + esc(s.id) + '">' + (active ? "● Active" : "● Inactive") + "</button></td>" +
          '<td class="muted">' + esc(fmtDate(s.createdAt)) + "</td>" +
          '<td class="sl-actions"><button class="btn btn-ghost btn-sm" data-edit="' + esc(s.id) + '">Edit</button>' +
            '<button class="btn btn-ghost btn-sm" data-dup="' + esc(s.id) + '">Duplicate</button>' +
            '<button class="btn btn-ghost btn-sm" data-go="studio" title="Assign + deploy in Studio">Deploy</button></td></tr>';
      }).join("");
      body.innerHTML = '<div class="card" style="padding:0;overflow:auto"><table class="seqlib"><thead><tr>' +
        "<th>Sequence</th><th>Owner</th><th>Steps</th><th>Tags</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead><tbody>" + trs + "</tbody></table></div>";
      Array.prototype.forEach.call(body.querySelectorAll("[data-edit]"), function (b) {
        b.addEventListener("click", function () { var s = store.all().filter(function (x) { return x.id === b.getAttribute("data-edit"); })[0]; if (s) openEditor(s); });
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-go]"), function (b) {
        b.addEventListener("click", function () { location.hash = b.getAttribute("data-go"); });
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-dup]"), function (b) {
        b.addEventListener("click", function () {
          var s = store.all().filter(function (x) { return x.id === b.getAttribute("data-dup"); })[0]; if (!s) return;
          var copy = JSON.parse(JSON.stringify(s));
          copy.id = "seq_" + Date.now(); copy.name = "Copy of " + s.name; copy.status = "inactive"; copy.owner = meName;
          copy.createdAt = new Date().toISOString(); copy.updatedAt = copy.createdAt; delete copy._isNew;
          store.save(copy); toast("Duplicated"); reload();
        });
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-status]"), function (b) {
        b.addEventListener("click", function () {
          var s = store.all().filter(function (x) { return x.id === b.getAttribute("data-status"); })[0]; if (!s) return;
          s.status = (s.status === "active") ? "inactive" : "active"; s.updatedAt = new Date().toISOString();
          store.save(s); reload();
        });
      });
    }
    function wireCreate() {
      var grid = $("#slCreate"); if (!grid) return;
      grid.addEventListener("click", function (e) { var b = e.target.closest("[data-ch]"); if (b) openEditor(newSequence(b.getAttribute("data-ch"))); });
    }
    // One-time starter sequences so the Library + Studio dropdown show the
    // connection on a brand-new (empty) workspace. Guarded so it never
    // re-seeds after the user edits/deletes them. Saved through the shared
    // store, so they appear in Campaigns + Campaign Studio (by name) too.
    function seedExamples() {
      if (localStorage.getItem("ros_seq_seeded")) return;
      try { localStorage.setItem("ros_seq_seeded", "1"); } catch (e) {}
      var now = new Date().toISOString();
      [["email", "Job-Board Lead Chase", ["job board"], "active"],
       ["linkedin", "Connect → Signal Nurture", ["sourcing"], "inactive"],
       ["sms", "Post-Reply Booking", ["hot"], "active"]].forEach(function (e, i) {
        store.save({ id: "seq_ex" + Date.now() + i, channel: e[0], name: e[1], tags: e[2], status: e[3],
          motion: motion === "bd" ? "bd" : "recruiting", owner: meName, variables: [], steps: seqTemplate(e[0]),
          createdAt: now, updatedAt: now });
      });
    }
    function reload() {
      paint();
      api("/sequences").then(function (d) {
        var server = (d && d.sequences) || [];
        if (server.length) {
          try { localStorage.setItem("ros_sequences", JSON.stringify(server.concat(store.all().filter(function (l) { return !server.some(function (s) { return s.id === l.id; }); })))); } catch (e) {}
        }
        if (!store.all().length) seedExamples();
        paint();
      }).catch(function () { if (!store.all().length) seedExamples(); paint(); });
    }
    reload();
    loadVoiceScripts();
  }

  /* Voice Drops scripts inside the Library: reusable cloned-voice voicemails,
     managed here or in the Voice Drops panel, deployable as a "Voice drop" step in
     Campaign Studio. A separate section (not the sequence table) since the data
     shape + editor differ. Talks to /api/voice/scripts. */
  function loadVoiceScripts() {
    var host = $("#slVoice"); if (!host) return;
    host.innerHTML = '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center">' +
      '<h3 style="margin:0">📞 Voice Drops scripts <span class="muted" style="font-size:12px">· reusable cloned-voice voicemails</span></h3>' +
      '<button class="btn btn-sm btn-primary" id="vsNew">＋ New voice script</button></div>' +
      '<div id="vsList" style="margin-top:10px">' + loading() + "</div></div>";
    $("#vsNew").addEventListener("click", function () { voiceScriptModal(null); });
    paintVoiceScripts();
  }
  function paintVoiceScripts() {
    var list = $("#vsList"); if (!list) return;
    api("/voice/scripts?motion=" + motion).then(function (d) {
      var rows = (d && d.scripts) || [];
      if (!rows.length) {
        list.innerHTML = '<p class="muted" style="font-size:13px">No voice scripts yet. Create one here or in the <a href="#voicedrops">Voice Drops</a> panel, then add it to a sequence as a “Voice drop” step in Campaign Studio.</p>';
        return;
      }
      list.innerHTML = '<table class="seqlib"><thead><tr><th>Script</th><th>Preview</th><th>Length</th><th>Actions</th></tr></thead><tbody>' +
        rows.map(function (s) {
          var dot = s.withinSweetSpot ? "#34d399" : "#ffc24d";
          return "<tr><td class=\"sl-name\"><span class=\"seq-chip\" style=\"background:#2a2440;color:#b9a6ff\">Voice</span> " + esc(s.name) + "</td>" +
            '<td class="muted" style="max-width:340px">' + esc((s.preview || "").slice(0, 90)) + "…</td>" +
            '<td><span style="color:' + dot + '">~' + (s.estSeconds || 0) + "s</span></td>" +
            '<td class="sl-actions"><button class="btn btn-ghost btn-sm" data-vsedit="' + esc(s.id) + '">Edit</button>' +
            '<button class="btn btn-ghost btn-sm" data-vsgo="studio" title="Add as a Voice drop step in Studio">Deploy</button>' +
            '<button class="btn btn-ghost btn-sm" data-vsdel="' + esc(s.id) + '">Delete</button></td></tr>';
        }).join("") + "</tbody></table>";
      Array.prototype.forEach.call(list.querySelectorAll("[data-vsedit]"), function (b) {
        b.addEventListener("click", function () { var s = rows.filter(function (x) { return x.id === b.getAttribute("data-vsedit"); })[0]; if (s) voiceScriptModal(s); });
      });
      Array.prototype.forEach.call(list.querySelectorAll("[data-vsdel]"), function (b) {
        b.addEventListener("click", function () { send("/voice/scripts?id=" + b.getAttribute("data-vsdel"), "DELETE").then(function () { toast("Deleted"); paintVoiceScripts(); }); });
      });
      Array.prototype.forEach.call(list.querySelectorAll("[data-vsgo]"), function (b) {
        b.addEventListener("click", function () { location.hash = b.getAttribute("data-vsgo"); });
      });
    }).catch(function () { list.innerHTML = '<p class="muted" style="font-size:13px">Voice Drops scripts unavailable.</p>'; });
  }
  function voiceScriptModal(s) {
    var isEdit = !!s;
    var chips = ["first_name", "role", "company", "agent_name", "agent_company"].map(function (f) {
      return '<button type="button" class="btn btn-sm" data-vschip="' + f + '">{' + f + "}</button>";
    }).join(" ");
    openModal(isEdit ? "Edit voice script" : "New voice script", "First name & role splice in like an email merge. Sweet spot 15–25s.",
      '<input id="vsName" placeholder="Script name" style="width:100%" value="' + esc(isEdit ? s.name : "") + '"/>' +
      '<div style="margin:8px 0">' + chips + "</div>" +
      '<textarea id="vsTpl" rows="4" style="width:100%">' + esc(isEdit ? s.template : VD_DEFAULT_SCRIPT) + "</textarea>" +
      '<div class="modal-foot" style="margin-top:10px"><button class="btn btn-primary btn-sm" id="vsSave">Save to Library</button></div>',
      function (root, close) {
        Array.prototype.forEach.call(root.querySelectorAll("[data-vschip]"), function (b) {
          b.addEventListener("click", function () {
            var ta = $("#vsTpl", root); var ins = "{" + b.getAttribute("data-vschip") + "}";
            var p = ta.selectionStart || ta.value.length;
            ta.value = ta.value.slice(0, p) + ins + ta.value.slice(ta.selectionEnd || p); ta.focus();
          });
        });
        $("#vsSave", root).addEventListener("click", function () {
          var name = ($("#vsName", root).value || "").trim();
          var tpl = ($("#vsTpl", root).value || "").trim();
          if (!name || !tpl) { toast("Name + script required"); return; }
          var payload = { name: name, template: tpl, motion: motion };
          if (isEdit) payload.id = s.id;
          send("/voice/scripts", "PUT", payload).then(function (r) { close(); if (r.ok) { toast("Saved to Library"); paintVoiceScripts(); } else toast("Save failed"); });
        });
      });
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

  // Spending scenario planner — a live what-if cost model anyone can play with.
  // The model + UI live in the self-contained spending-calc.js module so the
  // underlying tools stay generic (no vendor names exposed here).
  function renderSpending(el) {
    if (window.SpendingCalc && window.SpendingCalc.mount) window.SpendingCalc.mount(el);
    else el.innerHTML = '<div class="empty">Spending module did not load — refresh and try again.</div>';
  }

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
    if (key === "content") { newSequenceFlow(); return; }
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
      send("/prospects", "POST", { fullName: name, email: email, company: company, campaignId: campaignId, motion: motion })
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
          rows.forEach(function (r) { r.campaignId = cid; r.motion = motion; });
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
      '<label>Engine</label>' +
      '<select id="liEngine">' +
        '<option value="unipile">Unipile API — paste a people-search URL</option>' +
        '<option value="scraper">Open-source scraper — li_at cookie, profile or search URL</option>' +
      '</select>' +
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
      var engineEl = root.querySelector("#liEngine");
      if (urlEl.focus) try { urlEl.focus(); } catch (e) {}
      function engine() { return engineEl && engineEl.value === "scraper" ? "scraper" : "unipile"; }
      function isProfileUrl(u) { return /linkedin\.com\/in\//i.test(u); }
      function valid() { return /^https?:\/\/(www\.)?linkedin\.com\//i.test((urlEl.value || "").trim()); }
      function repaintPrev() {
        var u = (urlEl.value || "").trim();
        if (!u) { prev.innerHTML = engine() === "scraper"
          ? "Paste a <b>profile URL</b> (linkedin.com/in/…) for a reliable single pull, or a people-search URL for a best-effort list."
          : "Paste a LinkedIn / Sales Navigator search URL above."; return; }
        if (!valid()) { prev.innerHTML = "That doesn't look like a linkedin.com URL."; return; }
        if (engine() === "scraper") {
          prev.innerHTML = isProfileUrl(u)
            ? "✓ Ready to scrape this profile (cookie engine). Pulls slowly to stay under LinkedIn's radar."
            : "✓ Ready — best-effort: the scraper pages through this search with delays. List markup can be brittle; a profile URL is more reliable.";
        } else {
          prev.innerHTML = "✓ Ready to pull profiles from this search.";
        }
      }
      urlEl.addEventListener("input", repaintPrev);
      if (engineEl) engineEl.addEventListener("change", repaintPrev);
      root.querySelector("#liCancel").addEventListener("click", close);
      root.querySelector("#liGo").addEventListener("click", function () {
        var url = (urlEl.value || "").trim();
        if (!valid()) { toast("Paste a LinkedIn or Sales Navigator search URL."); urlEl.focus(); return; }
        var limit = parseInt(root.querySelector("#liLimit").value, 10) || 100;
        var eng = engine();
        var sel = root.querySelector("#liCamp");
        var chosen = (sel && sel.value) ? sel.value : null;
        close();   // dismiss the popup right away; progress shows in the Prospects view
        if (chosen) startLinkedInPull(chosen, url, limit, eng);
        else resolveBdCampaign(function (cid) {
          if (!cid) { toast("Could not prepare a campaign."); return; }
          startLinkedInPull(cid, url, limit, eng);
        });
      });
    });
  }

  // Drive the LinkedIn pull with a live progress bar in the Prospects view, then
  // populate the pipeline. (Date.now() is fine here — this is browser code.)
  function startLinkedInPull(cid, url, limit, engine) {
    engine = engine || "unipile";
    var slow = engine === "scraper";
    var box = document.getElementById("liProgress");
    if (!box) { location.hash = "prospects"; box = document.getElementById("liProgress"); }
    if (!box) return;
    var started = Date.now();
    box.innerHTML =
      '<div class="li-prog running"><div class="li-prog-top">' +
        '<span class="li-prog-title">🔗 ' + (slow ? "Scraping LinkedIn (cookie engine)…" : "Pulling LinkedIn profiles…") + '</span>' +
        '<span class="li-prog-meta" id="liProgMeta">target ' + limit + " · 0s</span></div>" +
        '<div class="li-bar"><span class="li-bar-fill indet"></span></div>' +
        '<div class="li-prog-sub">' + (slow
          ? "Paging through slowly with human-like delays so the account stays safe — this can take a few minutes."
          : "Running your search and adding members to Prospects — this can take a moment.") + "</div></div>";
    var meta = document.getElementById("liProgMeta");
    var tick = setInterval(function () {
      var s = Math.round((Date.now() - started) / 1000);
      if (meta) meta.textContent = "target " + limit + " · " + s + "s";
    }, 1000);
    viewTimers.push(tick);

    send("/prospects", "POST", { action: "linkedin_search", campaignId: cid, url: url, limit: limit, motion: motion, engine: engine }).then(function (res) {
      clearInterval(tick);
      if (res.ok) { finishLinkedInPull(box, (res.data || {}).added || 0, (res.data || {}).deduped || 0, (res.data || {}).warnings); if (prospectsReload) prospectsReload(); }
      else {
        var err = res.data && res.data.error;
        var isUnavail = /^search_unavailable|^search_failed/.test(err || "");
        var isScrape = /^scrape_/.test(err || "");
        errorLinkedInPull(box, err === "no_linkedin_account" ? "Connect a LinkedIn account first (Accounts → LinkedIn)."
          : err === "scraper_not_configured" ? "The scraper engine needs a LinkedIn session cookie. Set LINKEDIN_LI_AT (and SCRAPER_TOKEN) in the server env, or switch the engine to Unipile."
          : /^scrape_429/.test(err || "") ? "LinkedIn rate-limited the scraper — it cools down automatically. Try again later or pull fewer profiles."
          : /^scrape_401/.test(err || "") ? "The li_at cookie was rejected (expired or invalid). Refresh it from a logged-in browser."
          : /^scrape_503/.test(err || "") ? "The scraper service is unreachable (still booting or not deployed). Try again shortly."
          : isScrape ? "The scraper couldn't pull this URL (" + err + "). A profile URL (/in/…) is the most reliable."
          : err === "not_a_search_url" ? "That's not a search URL — copy a people-search URL from Sales Navigator/LinkedIn."
          : err === "not_a_linkedin_url" ? "That wasn't a linkedin.com URL."
          : isUnavail ? "No server-side LinkedIn provider is connected, so this URL can't be pulled directly. Use the Chrome extension’s “Scrape this search” button above — it pages through the search slowly and posts real profiles (with photos) straight into Prospects."
          : "Could not pull profiles (" + (err || res.status) + ").");
      }
    }).catch(function () { clearInterval(tick); errorLinkedInPull(box, "Could not reach the server."); });
  }

  function finishLinkedInPull(box, added, deduped, warnings) {
    var dup = deduped ? " · " + deduped + " already in pipeline" : "";
    var warn = (warnings && warnings.length)
      ? '<div class="li-prog-sub" style="color:var(--warn,#c80)">⚠ ' + esc(warnings.join(" ")) + "</div>" : "";
    box.innerHTML =
      '<div class="li-prog done"><div class="li-prog-top">' +
        '<span class="li-prog-title">✓ LinkedIn pull complete</span>' +
        '<span class="li-prog-meta"><b id="liCount">0</b> profiles added' + dup + "</span></div>" +
        '<div class="li-bar"><span class="li-bar-fill" style="width:100%"></span></div>' +
        warn +
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

    // Appearance: light/dark theme toggle. Persists + applies to <html> (the
    // pre-paint script in command.html sets it on load so there's no flash).
    var themeSeg = $("#themeSeg");
    if (themeSeg) {
      var applyTheme = function (t) {
        t = (t === "light") ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", t);
        try { localStorage.setItem("ros_theme", t); } catch (e) {}
        Array.prototype.forEach.call(themeSeg.querySelectorAll(".ts"), function (b) {
          b.classList.toggle("active", b.getAttribute("data-theme") === t);
        });
      };
      var saved = null; try { saved = localStorage.getItem("ros_theme"); } catch (e) {}
      applyTheme(saved || document.documentElement.getAttribute("data-theme") || "dark");
      Array.prototype.forEach.call(themeSeg.querySelectorAll(".ts"), function (b) {
        b.addEventListener("click", function (e) { e.stopPropagation(); applyTheme(b.getAttribute("data-theme")); });
      });
    }
  })();
})();
