/* RecruitersOS · Owner Console (private, owner-only)
 *
 * The single-operator back office: business overview, pricing brain, unified
 * spend, full account control (see everyone, hard reset, delete), and the
 * editable cost model. Every call hits /api/owner/* which is walled to the
 * OWNER_EMAIL allow-list server-side; this script only renders what that allows.
 *
 * ── NAVIGATION (hash route → view function) ──────────────────────────────────
 *   Registry + dispatcher:  var ROUTES = … ,  function route()
 *   #overview    viewOverview    business KPIs + spend rollup
 *   #pricing     viewPricing     published tiers (→ runCalc, tierCard, recoCard)
 *   #spend       viewSpend       unified spend
 *   #people      viewPeople      users & roles (→ renderRoster, roleChip)
 *   #accounts    viewAccounts    full account control (see/reset/delete)
 *   #costs       viewCosts       editable cost model
 *   #passwords   viewPasswords   account vault: portal URL + username + password
 *   #security    viewSecurity
 *   Projection calculator (cost model UI): viewCalculator, computeCalc,
 *                                recompute, renderScenarios, calcState
 *   Backend  api(path) / send(path,method,payload)  ← all /api/owner/* calls
 *   Helpers  esc(), toast(), usd(), pct(), card(), grid(), fld()
 *
 * Source of truth is repo-root assets/js/; run integration/sync-public.cjs after
 * editing (never edit integration/public/). See docs/STRUCTURE.md.
 */
(function () {
  "use strict";

  var API = (window.RECRUITEROS_API_BASE || "") + "/api";
  var win = localStorage.getItem("owner_window") || "30d";

  /* ---------------- dom + fetch helpers ---------------- */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function toast(t) { var el = $("#toast"); el.textContent = t; el.classList.add("show"); setTimeout(function () { el.classList.remove("show"); }, 2400); }
  function usd(n, dp) { n = Number(n) || 0; if (dp != null) return "$" + n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }); return "$" + n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }); }
  function pct(n) { return (Number(n) || 0).toFixed(1) + "%"; }

  function api(path) {
    return fetch(API + path, { credentials: "include" }).then(function (r) {
      if (!r.ok) throw r.status;
      return r.json();
    });
  }
  function send(path, method, payload) {
    return fetch(API + path, {
      method: method, credentials: "include",
      headers: payload ? { "Content-Type": "application/json" } : undefined,
      body: payload ? JSON.stringify(payload) : undefined
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); });
  }

  /* ---------------- gate: confirm owner before revealing anything ---------- */
  function boot() {
    api("/owner/overview?window=" + win).then(function (ov) {
      $("#gate").style.display = "none";
      $("#shell").style.display = "";
      if (ov && ov.owner) { $("#ownerEmail").textContent = ov.owner; $("#userName").textContent = ov.owner.split("@")[0]; }
      wireChrome();
      route();
    }).catch(function (status) {
      var msg = $("#gateMsg"), btn = $("#gateLogin");
      if (status === 401) { msg.textContent = "Sign in with the owner account to continue."; btn.style.display = ""; }
      else { msg.textContent = "This area is restricted."; btn.style.display = ""; btn.textContent = "Return to sign in"; }
    });
  }

  function wireChrome() {
    $$("#windowToggle .mt").forEach(function (b) {
      b.classList.toggle("active", b.dataset.window === win);
      b.addEventListener("click", function () {
        win = b.dataset.window; localStorage.setItem("owner_window", win);
        $$("#windowToggle .mt").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active"); $("#windowPill").textContent = win;
        route();
      });
    });
    $("#windowPill").textContent = win;
    $("#signOut").addEventListener("click", function () {
      fetch(API + "/auth/session", { method: "DELETE", credentials: "include" }).catch(function () {});
      location.href = "/login";
    });
    $("#scrim").addEventListener("click", closeDrawer);
    window.addEventListener("hashchange", route);
  }

  /* ---------------- router ---------------- */
  // Projection calculator moved to the in-app command center (Measure → Spending).
  var ROUTES = { overview: viewOverview, pricing: viewPricing, burn: viewBurn, spend: viewSpend, people: viewPeople, accounts: viewAccounts, costs: viewCosts, passwords: viewPasswords, breaks: viewBreaks, security: viewSecurity };
  var TITLES = { overview: "Overview", pricing: "Pricing", burn: "Spend master", spend: "Spend", people: "Users & roles", accounts: "Accounts", costs: "Cost model", passwords: "Passwords", breaks: "Breaks", security: "Security" };
  function route() {
    var r = (location.hash.replace("#", "") || "overview");
    if (!ROUTES[r]) r = "overview";
    $$("#ownerNav .nav-item").forEach(function (a) { a.classList.toggle("active", a.dataset.route === r); });
    $("#pageTitle").textContent = TITLES[r];
    $("#view").innerHTML = '<div class="card">Loading…</div>';
    ROUTES[r]();
  }
  $$("#ownerNav .nav-item").forEach(function (a) {
    a.addEventListener("click", function () { location.hash = a.dataset.route; });
  });

  /* ================= OVERVIEW ================= */
  function viewOverview() {
    api("/owner/overview?window=" + win).then(function (o) {
      var marginClass = o.grossMarginPct >= 80 ? "good" : o.grossMarginPct >= 50 ? "amber" : "bad";
      var html = '<div class="v-head"><h2>Business overview</h2><p>Recurring revenue, real cost, and gross margin across both operating systems. Cost is for the selected window (' + esc(win) + '); MRR is the monthly price on file.</p></div>';
      html += '<div class="stat-grid">' +
        stat(usd(o.mrrUsd), "MRR (monthly recurring)", "amber") +
        stat(usd(o.costUsd), "Cost · " + esc(win), o.costUsd ? "bad" : "") +
        stat(usd(o.grossProfitUsd), "Gross profit", o.grossProfitUsd >= 0 ? "good" : "bad") +
        stat(pct(o.grossMarginPct), "Gross margin", marginClass) +
        stat(o.accounts.total, "Accounts (" + o.accounts.active + " active)") +
        stat(o.accounts.paying, "Paying accounts") +
        '</div>';
      html += '<div class="two-col" style="margin-top:18px">';
      html += '<div class="card"><h3>Cost by category</h3>' + barsFromObj(o.costByCategory) + '</div>';
      html += '<div class="card"><h3>Cost by operating system</h3>' + barsFromObj(motionLabels(o.costByMotion)) + '</div>';
      html += '</div>';
      html += '<div class="card" style="margin-top:14px"><h3>Cost by provider / source</h3>' + barsFromObj(o.costBySource) + '</div>';
      $("#view").innerHTML = html;
    }).catch(fail);
  }
  function stat(v, l, cls) { return '<div class="stat"><div class="sv ' + (cls || "") + '">' + esc(v) + '</div><div class="sl">' + esc(l) + '</div></div>'; }
  function motionLabels(obj) { var o = {}; Object.keys(obj || {}).forEach(function (k) { o[k === "bd" ? "Business Development OS" : k === "recruiting" ? "Recruiting OS" : k] = obj[k]; }); return o; }
  function barsFromObj(obj) {
    var entries = Object.keys(obj || {}).map(function (k) { return [k, obj[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
    if (!entries.length) return '<p class="note">No cost recorded in this window.</p>';
    var max = Math.max.apply(null, entries.map(function (e) { return e[1]; })) || 1;
    return '<div class="bars">' + entries.map(function (e) {
      return '<div class="bar-row"><div>' + esc(e[0]) + '</div><div class="bar-track"><div class="bar-fill" style="width:' + Math.max(2, (e[1] / max) * 100) + '%"></div></div><div class="num">' + usd(e[1]) + '</div></div>';
    }).join("") + '</div>';
  }

  // Human label for a raw cost key (e.g. "boost_phones" -> "Boost phones").
  function titleCase(s) {
    s = String(s || "").replace(/[_-]+/g, " ").trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }
  // A "→ Spending" button that pushes one usage row to the client's Spending tab.
  // Carries the label + amount; wired up in wireDrawer via delegation.
  function spendPushBtn(label, amt) {
    amt = Number(amt) || 0;
    if (amt <= 0) return '<span class="note">—</span>';
    return '<a class="btn btn-sm push-spend" data-label="' + esc(label) + '" data-amt="' + amt + '" title="Stage this row for the client\'s Spending page (you approve it below before it sends)">Stage for Spending</a>';
  }
  // A pushable cost table: [{label, amount}] -> rows with a push button each.
  function pushCostTable(rows) {
    rows = (rows || []).filter(function (r) { return r && (Number(r.amount) || 0) > 0; });
    if (!rows.length) return '<p class="note">No cost recorded in this window.</p>';
    return '<table class="otable"><tbody>' + rows.map(function (r) {
      return '<tr><td>' + esc(r.label) + '</td><td class="num">' + usd(r.amount) + '</td>' +
        '<td class="num">' + spendPushBtn(r.label, r.amount) + '</td></tr>';
    }).join("") + '</tbody></table>';
  }

  /* ================= PEOPLE (users & roles) ================= */
  /* Who is on the platform and what they can do: account / admin / recruiter
   * counts, the LLM-vs-enrichment spend split, a per-account headcount + activity
   * rollup, and a searchable roster of every user with the functions their role
   * grants. Rows open the existing account drawer for full control. */
  var peopleData = null;
  var peopleQuery = "";
  var peopleRole = "all";

  function viewPeople() {
    api("/owner/people?window=" + win).then(function (p) {
      peopleData = p;
      var t = p.totals, s = p.spend;
      var html = '<div class="v-head"><h2>Users &amp; roles</h2><p>Everyone on the platform and what they can do, plus the LLM and enrichment spend driving it. Counts are live; cost is for the selected window (' + esc(win) + '). Click any row to open full account controls.</p></div>';

      html += '<div class="stat-grid">' +
        stat(t.accounts, "Accounts (" + t.activeAccounts + " active)") +
        stat(t.users, "Total users") +
        stat(t.admins, "Admins") +
        stat(t.recruiters, "Recruiters") +
        stat(usd(s.llmUsd), "LLM spend · " + esc(win), s.llmUsd ? "bad" : "") +
        stat(usd(s.enrichmentUsd), "Enrichment · " + esc(win), s.enrichmentUsd ? "bad" : "") +
        '</div>';

      var roleBars = { "Owners": t.owners, "Admins": t.admins, "Recruiters": t.recruiters };
      var spendBars = {};
      spendBars["LLM (AI)"] = s.llmUsd;
      spendBars["Enrichment"] = s.enrichmentUsd;
      if (s.sendingUsd) spendBars["Sending"] = s.sendingUsd;
      if (s.signalsUsd) spendBars["Signals"] = s.signalsUsd;
      if (s.messagingUsd) spendBars["Messaging"] = s.messagingUsd;
      if (s.linkedinUsd) spendBars["LinkedIn"] = s.linkedinUsd;
      if (s.infraUsd) spendBars["Infra"] = s.infraUsd;
      if (s.otherUsd) spendBars["Other"] = s.otherUsd;

      html += '<div class="two-col" style="margin-top:18px">' +
        '<div class="card"><h3>Headcount by role</h3>' + countBars(roleBars) + '</div>' +
        '<div class="card"><h3>Spend by function · ' + esc(win) + '</h3>' + barsFromObj(spendBars) + '</div></div>';

      // Per-account headcount + activity + cost
      html += '<div class="card" style="margin-top:14px"><h3>Accounts &amp; team</h3>';
      if (!p.accounts.length) html += '<p class="note">No accounts yet. They appear here the moment someone signs up.</p>';
      else {
        html += '<div class="otable-wrap"><table class="otable"><thead><tr>' +
          '<th>Account</th><th class="num">Admins</th><th class="num">Recruiters</th><th class="num">Sessions</th><th class="num">Activity</th><th class="num">LLM</th><th class="num">Enrich</th><th class="num">Cost</th><th>Status</th>' +
          '</tr></thead><tbody>';
        p.accounts.forEach(function (a) {
          html += '<tr class="clickrow" data-id="' + esc(a.workspaceId) + '">' +
            '<td><div class="lr-main">' + esc(a.name) + '</div><div class="lr-sub note">' + esc(a.domain || a.plan) + '</div></td>' +
            '<td class="num">' + a.admins + '</td>' +
            '<td class="num">' + a.recruiters + '</td>' +
            '<td class="num">' + a.activeSessions + '</td>' +
            '<td class="num">' + a.activityEvents.toLocaleString() + '</td>' +
            '<td class="num">' + usd(a.llmUsd) + '</td>' +
            '<td class="num">' + usd(a.enrichmentUsd) + '</td>' +
            '<td class="num">' + usd(a.costUsd) + '</td>' +
            '<td>' + (a.suspended ? '<span class="pill susp">Suspended</span>' : '<span class="pill active">Active</span>') + '</td>' +
            '</tr>';
        });
        html += '</tbody></table></div>';
      }
      html += '</div>';

      // User roster with search + role filter
      html += '<div class="card" style="margin-top:14px"><div class="v-head" style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap">' +
        '<div><h3 style="margin:0">User roster</h3><p class="note" style="margin:2px 0 0">Every user across every account, with the functions their role grants. Click a row to manage their account.</p></div>' +
        '<div style="display:flex;gap:8px;align-items:center">' +
        '<select id="peopleRole" class="role-filter"><option value="all">All roles</option><option value="owner">Owners</option><option value="admin">Admins</option><option value="member">Recruiters</option></select>' +
        '<input id="peopleSearch" type="text" placeholder="Search name, email, account…" class="people-search" value="' + esc(peopleQuery) + '">' +
        '</div></div>';
      html += '<div id="rosterWrap"></div></div>';

      $("#view").innerHTML = html;
      $$("#view .clickrow").forEach(function (tr) { tr.addEventListener("click", function () { openAccount(tr.dataset.id); }); });
      var sel = $("#peopleRole"); if (sel) { sel.value = peopleRole; sel.addEventListener("change", function () { peopleRole = sel.value; renderRoster(); }); }
      var box = $("#peopleSearch"); if (box) box.addEventListener("input", function () { peopleQuery = box.value; renderRoster(); });
      renderRoster();
    }).catch(fail);
  }

  function roleChip(role) {
    var label = role === "owner" ? "Owner" : role === "admin" ? "Admin" : "Recruiter";
    return '<span class="role-chip role-' + esc(role) + '">' + label + '</span>';
  }

  function renderRoster() {
    var wrap = $("#rosterWrap"); if (!wrap || !peopleData) return;
    var q = peopleQuery.trim().toLowerCase();
    var rows = (peopleData.users || []).filter(function (u) {
      if (peopleRole !== "all" && u.role !== peopleRole) return false;
      if (!q) return true;
      return (u.name + " " + u.email + " " + u.workspace).toLowerCase().indexOf(q) !== -1;
    });
    if (!rows.length) { wrap.innerHTML = '<p class="note">No users match.</p>'; return; }
    var html = '<div class="otable-wrap"><table class="otable"><thead><tr>' +
      '<th>User</th><th>Role</th><th>Account</th><th class="num">Functions</th><th>Verified</th><th>Joined</th>' +
      '</tr></thead><tbody>';
    rows.forEach(function (u) {
      var caps = (u.capabilities || []).map(function (c) { return c.replace(/:/g, " · "); }).join("\n");
      html += '<tr class="clickrow" data-id="' + esc(u.workspaceId) + '">' +
        '<td><div class="lr-main">' + esc(u.name) + '</div><div class="lr-sub mono">' + esc(u.email) + '</div></td>' +
        '<td>' + roleChip(u.role) + (u.suspended ? ' <span class="pill susp">susp</span>' : '') + '</td>' +
        '<td>' + esc(u.workspace) + ' <span class="note">' + esc(u.plan) + '</span></td>' +
        '<td class="num"><span class="fn-count" title="' + esc(caps) + '">' + (u.capabilities || []).length + ' fns</span></td>' +
        '<td>' + (u.emailVerified ? '<span class="pill active">yes</span>' : '<span class="note">no</span>') + '</td>' +
        '<td class="note">' + fmtDate(u.createdAt) + '</td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
    wrap.innerHTML = html;
    $$("#rosterWrap .clickrow").forEach(function (tr) { tr.addEventListener("click", function () { openAccount(tr.dataset.id); }); });
  }

  /* Count bars (integers, not dollars), reuses the bar visual from cost rollups. */
  function countBars(obj) {
    var entries = Object.keys(obj || {}).map(function (k) { return [k, Number(obj[k]) || 0]; });
    var total = entries.reduce(function (s, e) { return s + e[1]; }, 0);
    if (!total) return '<p class="note">No users yet.</p>';
    var max = Math.max.apply(null, entries.map(function (e) { return e[1]; })) || 1;
    return '<div class="bars">' + entries.map(function (e) {
      return '<div class="bar-row"><div>' + esc(e[0]) + '</div><div class="bar-track"><div class="bar-fill" style="width:' + Math.max(2, (e[1] / max) * 100) + '%"></div></div><div class="num">' + e[1].toLocaleString() + '</div></div>';
    }).join("") + '</div>';
  }

  /* ================= PRICING ================= */
  function viewPricing() {
    var q = pricingQuery();
    api("/owner/pricing?" + q).then(function (p) {
      var html = '<div class="v-head"><h2>Pricing</h2><p>Recommended monthly price per account at 5k / 10k / 20k emails, derived from real enrichment + sending + AI cost and a target gross margin. Recruiting OS and BD OS share infrastructure (same cost); BD carries a higher willingness-to-pay multiplier.</p></div>';

      // calculator
      html += '<div class="card"><h3>Live calculator</h3><div class="calc">' +
        fld("Emails / month", '<input id="cEmails" type="number" min="0" step="1000" value="' + (getParam("emails") || 10000) + '">') +
        fld("Sequence steps", '<input id="cSteps" type="number" min="1" max="10" value="' + (getParam("steps") || 3) + '">') +
        fld("Target margin %", '<input id="cMargin" type="number" min="0" max="95" value="' + (Math.round((getParam("margin") || 0.85) * 100)) + '">') +
        fld("Operating system", '<select id="cMotion"><option value="recruiting">Recruiting OS</option><option value="bd">Business Development OS</option></select>') +
        '</div><div class="toggle-row" style="margin-top:12px">' +
        '<label><input type="checkbox" id="cMobile"> Mobile enrichment</label>' +
        '<label><input type="checkbox" id="cLandline"> Landline enrichment</label>' +
        '<label><input type="checkbox" id="cAi" checked> AI personalization</label>' +
        '<a class="btn btn-primary btn-sm" id="cRun">Recalculate</a></div>';
      if (p.calculator) html += '<div id="calcOut" style="margin-top:14px">' + recoCard(p.calculator, "Calculated") + '</div>';
      else html += '<div id="calcOut"></div>';
      html += '</div>';

      // preset tables per motion
      (p.presets || []).forEach(function (block) {
        var label = block.motion === "bd" ? "Business Development OS" : "Recruiting OS";
        html += '<div class="v-head" style="margin-top:22px"><h2>' + esc(label) + '</h2></div><div class="tier-grid">';
        block.tiers.forEach(function (t) { html += tierCard(t); });
        html += '</div>';
      });

      $("#view").innerHTML = html;
      var motionSel = $("#cMotion"); if (motionSel && getParam("motion")) motionSel.value = getParam("motion");
      if ($("#cMobile")) $("#cMobile").checked = getParam("mobile") === "1" || getParam("phone") === "1";
      if ($("#cLandline")) $("#cLandline").checked = getParam("landline") === "1" || getParam("phone") === "1";
      if ($("#cAi")) $("#cAi").checked = getParam("ai") !== "0";
      if ($("#cRun")) $("#cRun").addEventListener("click", runCalc);
    }).catch(fail);
  }
  function fld(label, inner) { return '<div class="fld"><label>' + esc(label) + '</label>' + inner + '</div>'; }
  function getParam(k) { try { return new URLSearchParams(location.hash.split("?")[1] || "").get(k); } catch (e) { return null; } }
  function pricingQuery() {
    var s = location.hash.split("?")[1] || "";
    return s;
  }
  function runCalc() {
    var params = new URLSearchParams();
    params.set("emails", $("#cEmails").value || "10000");
    params.set("steps", $("#cSteps").value || "3");
    params.set("margin", ((Number($("#cMargin").value) || 85) / 100).toString());
    params.set("motion", $("#cMotion").value);
    params.set("mobile", $("#cMobile").checked ? "1" : "0");
    params.set("landline", $("#cLandline").checked ? "1" : "0");
    params.set("ai", $("#cAi").checked ? "1" : "0");
    location.hash = "pricing?" + params.toString();
  }
  function tierCard(t) {
    var b = t.breakdown;
    var lines = b.lines.filter(function (l) { return l.subtotalUsd > 0; }).map(function (l) {
      return '<div class="tl"><span>' + esc(l.label) + ' <span class="note">×' + l.quantity.toLocaleString() + '</span></span><span class="v">' + usd(l.subtotalUsd) + '</span></div>';
    }).join("");
    return '<div class="tier-card">' +
      '<div class="tier-vol">' + b.emailsPerMonth.toLocaleString() + ' emails / mo</div>' +
      '<div class="tier-price">' + usd(t.recommendedPriceUsd) + '<span> /mo</span></div>' +
      '<div class="tier-meta">' + pct(t.effectiveGrossMarginPct) + ' margin · ' + usd(t.monthlyGrossProfitUsd) + ' profit/mo</div>' +
      '<div class="tier-lines">' + lines +
        '<div class="tl"><span>~' + b.uniqueProspects.toLocaleString() + ' prospects · ' + b.inboxes + ' inboxes</span><span class="v"></span></div>' +
        '<div class="tl total"><span>Our cost</span><span class="v">' + usd(b.totalCostUsd) + '</span></div>' +
      '</div></div>';
  }
  function recoCard(t, tag) {
    return '<div class="tier-grid"><div style="grid-column:1/-1">' + tierCard(t) + '</div></div>';
  }

  /* ================= PROJECTION CALCULATOR ================= */
  /* A forward-looking "what will this cost" calculator for the stack we're
   * standing up: the new sending system, TheirStack signal credits, and
   * Cartesia cloned-voice. Fully client-side and live, every keystroke
   * recomputes. Inputs persist in localStorage so they survive navigation.
   * Real-world defaults (June 2026):
   *   TheirStack, 1 API credit = 1 job posting; ~$0.017/credit at Pro
   *                ($169 / 10k), down to ~$0.0015/credit at volume.
   *   Cartesia  , Startup $39/mo = 1.25M credits; IVC 1 credit/char (no
   *                training), Pro Voice Cloning = one-time 1M-credit train
   *                + 1.5 credits/char.
   */
  var CALC_DEFAULTS = {
    // scale, everything scales off the recruiter count
    recruiters: 5,
    prospectsPerRec: 1000, emailsPerRec: 10000, recordingsPerRec: 400,
    // emailing system (own warmed inboxes; inbox/domain counts auto-derive from volume)
    inboxCost: 2.5, domainCost: 1.0, esp: 0, perKSends: 0,
    sendsPerInbox: 750, inboxesPerDomain: 3,
    // TheirStack signal credits
    tsPrice: 85, tsCredits: 5000, tsPerProspect: 1, tsBilling: "onetime",
    // People Data Labs person/phone enrichment (optional add-on to the signals)
    pdlPrice: 0.28, pdlPerRec: 200,
    // Cartesia cloned voice
    cartFee: 39, cartCredits: 1250000, cartMode: "ivc", cartChars: 320
  };
  // Scenario ladder for the side-by-side "different number of recruiters" table.
  var CALC_LADDER = [1, 3, 5, 10, 25, 50, 100];
  // The package is modelled separately per operating system (Recruiting / BD),
  // so each tab keeps its own saved inputs.
  var calcMotion = localStorage.getItem("owner_calc_motion") || "recruiting";
  function calcKey() { return "owner_calc__" + calcMotion; }
  function motionName(m) { return (m || calcMotion) === "bd" ? "Business Development OS" : "Recruiting OS"; }
  function calcState() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(calcKey()) || "{}"); } catch (e) { s = {}; }
    // First load of the Recruiting tab inherits the pre-motion single bucket so
    // previously-entered numbers carry over rather than reset.
    if (!Object.keys(s).length && calcMotion === "recruiting") {
      try { var legacy = JSON.parse(localStorage.getItem("owner_calc") || "{}"); if (Object.keys(legacy).length) s = legacy; } catch (e) {}
    }
    // Migrate the earlier account/total-volume schema into the recruiter model.
    if (s.recruiters == null && s.accounts != null) {
      var acc = Math.max(1, Number(s.accounts) || 1);
      s.recruiters = acc;
      if (s.prospects != null) s.prospectsPerRec = Math.round((Number(s.prospects) || 0) / acc);
      if (s.emails != null) s.emailsPerRec = Math.round((Number(s.emails) || 0) / acc);
      if (s.cartRecs != null) s.recordingsPerRec = Math.round((Number(s.cartRecs) || 0) / acc);
    }
    var out = {};
    Object.keys(CALC_DEFAULTS).forEach(function (k) { out[k] = s[k] != null ? s[k] : CALC_DEFAULTS[k]; });
    return out;
  }
  function saveCalcState(s) { try { localStorage.setItem(calcKey(), JSON.stringify(s)); } catch (e) {} }

  /* Pure cost model, given a state, return every derived number. Reused by the
   * results pane AND the scenario table (which just varies `recruiters`). */
  function computeCalc(s) {
    var recruiters = Math.max(0, Number(s.recruiters) || 0);
    var prospects = recruiters * s.prospectsPerRec;
    var emails = recruiters * s.emailsPerRec;
    var recordings = recruiters * s.recordingsPerRec;

    // Sending infra derives from the deliverability ceiling (how it really deploys).
    var inboxes = s.sendsPerInbox > 0 ? Math.ceil(emails / s.sendsPerInbox) : 0;
    var domains = s.inboxesPerDomain > 0 ? Math.ceil(inboxes / s.inboxesPerDomain) : 0;
    var emailing = inboxes * s.inboxCost + domains * s.domainCost + s.esp + (emails / 1000) * s.perKSends;

    // TheirStack signal credits.
    var tsCreditPrice = s.tsCredits > 0 ? s.tsPrice / s.tsCredits : 0;
    var tsCreditsUsed = prospects * s.tsPerProspect;
    var tsUsedCost = tsCreditsUsed * tsCreditPrice;
    var signalsRecurring, signalsOneTime;
    if (s.tsBilling === "monthly") {
      signalsRecurring = s.tsPrice + Math.max(0, tsCreditsUsed - s.tsCredits) * tsCreditPrice;
      signalsOneTime = 0;
    } else {
      signalsRecurring = tsUsedCost;
      signalsOneTime = s.tsPrice;
    }

    // People Data Labs, person/phone enrichment (only successful matches billed).
    var pdlMatches = recruiters * s.pdlPerRec;
    var pdlCost = pdlMatches * s.pdlPrice;

    // Cartesia cloned voice.
    var cartCreditPrice = s.cartCredits > 0 ? s.cartFee / s.cartCredits : 0;
    var mult = s.cartMode === "pvc" ? 1.5 : 1;
    var cartCreditsUsed = recordings * s.cartChars * mult;
    var cartUsedCost = cartCreditsUsed * cartCreditPrice;
    var voiceRecurring = Math.max(s.cartFee, cartUsedCost);
    var voiceOneTime = s.cartMode === "pvc" ? 1000000 * cartCreditPrice : 0;

    var recurring = emailing + signalsRecurring + pdlCost + voiceRecurring;
    var oneTime = signalsOneTime + voiceOneTime;
    return {
      recruiters: recruiters, prospects: prospects, emails: emails, recordings: recordings,
      inboxes: inboxes, domains: domains,
      emailing: emailing, signalsRecurring: signalsRecurring, signalsOneTime: signalsOneTime,
      pdlCost: pdlCost, pdlMatches: pdlMatches, pdlPrice: s.pdlPrice,
      voiceRecurring: voiceRecurring, voiceOneTime: voiceOneTime,
      recurring: recurring, oneTime: oneTime,
      tsCreditPrice: tsCreditPrice, tsCreditsUsed: tsCreditsUsed, cartCreditPrice: cartCreditPrice,
      perRecruiter: recruiters > 0 ? recurring / recruiters : 0,
      perProspect: prospects > 0 ? recurring / prospects : 0,
      perEmail: emails > 0 ? emailing / emails : 0,
      perRecording: recordings > 0 ? voiceRecurring / recordings : 0
    };
  }
  function assign(s, k, v) { var o = {}; Object.keys(s).forEach(function (x) { o[x] = s[x]; }); o[k] = v; return o; }

  function viewCalculator() {
    var s = calcState();
    var html = '<div class="v-head"><h2>Projection · ' + esc(motionName()) + '</h2><p>Model what the stack will cost <em>before</em> you spend, the new sending system, TheirStack signals + People Data Labs enrichment, and Cartesia cloned voice. Everything scales off the recruiter count, so changing it re-derives the whole deploy (inboxes, domains, credits, voice) live. The table at the bottom compares different team sizes. Each operating system below keeps its own numbers; nothing here touches the ledger, it is a sandbox.</p></div>';

    // Operating-system tabs, the package is presented for both motions, each with its own saved inputs.
    html += '<div class="calc-motion" id="calcMotion">' +
      '<button class="cm" data-motion="recruiting">Recruiting OS</button>' +
      '<button class="cm" data-motion="bd">Business Development OS</button></div>';

    html += '<div class="calc-wrap"><div class="calc-inputs">';

    // Scale, recruiter-driven
    html += card("Recruiters & per-seat volume", "The whole model scales from here. Set the team size and what one recruiter runs per month; totals derive automatically.",
      grid(
        xin("Recruiters on the system", "recruiters", s.recruiters, 1, 0) +
        xin("Prospects / recruiter / mo", "prospectsPerRec", s.prospectsPerRec, 100, 0) +
        xin("Emails / recruiter / mo", "emailsPerRec", s.emailsPerRec, 500, 0) +
        xin("Voice recordings / recruiter / mo", "recordingsPerRec", s.recordingsPerRec, 50, 0)
      ) + '<div id="scaleOut" class="calc-readout"></div>');

    // Emailing system, counts auto-derive from send volume
    html += card("Emailing system", "Inboxes & domains auto-derive from send volume at a safe deliverability ceiling, this is how the system actually provisions. (Reseller mailbox ≈ $1.50-3/mo, throwaway domain ≈ $1/mo.)",
      grid(
        xin("Cost / inbox / mo ($)", "inboxCost", s.inboxCost, 0.5, 0) +
        xin("Cost / domain / mo ($)", "domainCost", s.domainCost, 0.5, 0) +
        xin("Sends / inbox / mo", "sendsPerInbox", s.sendsPerInbox, 50, 1) +
        xin("Inboxes / domain", "inboxesPerDomain", s.inboxesPerDomain, 1, 1) +
        xin("Platform / ESP flat ($/mo)", "esp", s.esp, 5, 0) +
        xin("API send cost ($ / 1k emails)", "perKSends", s.perKSends, 0.05, 0)
      ) + '<div id="emailOut" class="calc-readout"></div>');

    // TheirStack signals + People Data Labs enrichment
    html += card("Hiring signals · TheirStack + People Data Labs", "TheirStack: 1 API credit = 1 job posting, 3 = 1 company (~$0.017/credit at Pro $169/10k, ~$0.0015 at volume). People Data Labs: person/phone enrichment, only successful matches are billed (~$0.28/match Pro, ~$0.20-0.25 at volume). Set PDL matches to 0 to leave it out.",
      grid(
        xin("TheirStack pack price ($)", "tsPrice", s.tsPrice, 5, 0) +
        xin("Credits in pack", "tsCredits", s.tsCredits, 500, 0) +
        xin("Credits / prospect", "tsPerProspect", s.tsPerProspect, 1, 0) +
        xsel("Billing", "tsBilling", s.tsBilling, [["onetime", "Setup pack (one-time)"], ["monthly", "Monthly plan"]]) +
        xin("PDL enrich ($ / match)", "pdlPrice", s.pdlPrice, 0.01, 0) +
        xin("PDL matches / recruiter / mo", "pdlPerRec", s.pdlPerRec, 50, 0)
      ) + '<div id="signalOut" class="calc-readout"></div>');

    // Cartesia
    html += card("Cloned voice · Cartesia", "Startup $39/mo = 1.25M credits. IVC = 1 credit/char (no training). Pro Voice Cloning = one-time 1M-credit training + 1.5 credits/char. A ~50-word voicemail ≈ 320 chars.",
      grid(
        xin("Plan fee ($/mo)", "cartFee", s.cartFee, 1, 0) +
        xin("Credits included / mo", "cartCredits", s.cartCredits, 50000, 0) +
        xsel("Cloning mode", "cartMode", s.cartMode, [["ivc", "Instant (IVC)"], ["pvc", "Pro clone (PVC)"]]) +
        xin("Characters / recording", "cartChars", s.cartChars, 20, 0)
      ));

    html += '<div class="btn-row" style="margin-top:4px"><a class="btn btn-sm" id="calcReset">Reset to defaults</a></div>';
    html += '</div>'; // /calc-inputs

    // Results pane
    html += '<div class="calc-results" id="calcResults"></div>';
    html += '</div>'; // /calc-wrap

    // Scenario comparison (full width)
    html += '<div class="card" id="calcScenarios" style="margin-top:18px"></div>';

    $("#view").innerHTML = html;

    $$("#calcMotion .cm").forEach(function (b) {
      b.classList.toggle("active", b.dataset.motion === calcMotion);
      b.addEventListener("click", function () {
        calcMotion = b.dataset.motion;
        localStorage.setItem("owner_calc_motion", calcMotion);
        viewCalculator();
      });
    });
    $$("#view [data-calc]").forEach(function (inp) {
      inp.addEventListener("input", recompute);
      inp.addEventListener("change", recompute);
    });
    $("#calcReset").addEventListener("click", function () {
      localStorage.removeItem(calcKey()); viewCalculator();
    });
    recompute();
  }

  function card(title, sub, inner) {
    return '<div class="card"><h3>' + esc(title) + '</h3>' + (sub ? '<p class="note" style="margin:-2px 0 12px">' + esc(sub) + '</p>' : '') + inner + '</div>';
  }
  function grid(inner) { return '<div class="calc">' + inner + '</div>'; }
  function xin(label, id, val, step, min) {
    return '<div class="fld"><label>' + esc(label) + '</label><input data-calc="' + id + '" type="number" step="' + step + '" min="' + (min == null ? 0 : min) + '" value="' + val + '"></div>';
  }
  function xsel(label, id, val, opts) {
    var o = opts.map(function (p) { return '<option value="' + p[0] + '"' + (p[0] === val ? ' selected' : '') + '>' + esc(p[1]) + '</option>'; }).join("");
    return '<div class="fld"><label>' + esc(label) + '</label><select data-calc="' + id + '">' + o + '</select></div>';
  }

  function recompute() {
    var s = {};
    $$("#view [data-calc]").forEach(function (inp) {
      s[inp.dataset.calc] = inp.type === "number" ? (Number(inp.value) || 0) : inp.value;
    });
    // merge with defaults for anything not on screen, then persist
    var full = calcState();
    Object.keys(s).forEach(function (k) { full[k] = s[k]; });
    saveCalcState(full);

    var r = computeCalc(full);

    // ---- live readouts under the input cards ----
    var so = $("#scaleOut");
    if (so) so.innerHTML = '<strong>' + r.recruiters + '</strong> recruiters → <strong>' + r.prospects.toLocaleString() +
      '</strong> prospects · <strong>' + r.emails.toLocaleString() + '</strong> emails · <strong>' +
      r.recordings.toLocaleString() + '</strong> voice drops / mo';
    var eo = $("#emailOut");
    if (eo) eo.innerHTML = 'Auto-derived: <strong>' + r.inboxes.toLocaleString() + '</strong> inboxes · <strong>' +
      r.domains.toLocaleString() + '</strong> domains to carry ' + r.emails.toLocaleString() + ' emails/mo';
    var sio = $("#signalOut");
    if (sio) sio.innerHTML = 'TheirStack <strong>' + usd(r.signalsRecurring) + '</strong>/mo + PDL <strong>' + usd(r.pdlCost) +
      '</strong>/mo (' + r.pdlMatches.toLocaleString() + ' matches) = <strong>' + usd(r.signalsRecurring + r.pdlCost) + '</strong>/mo';

    // ---- results pane ----
    var bars = {};
    bars["Emailing system"] = round2(r.emailing);
    bars["Signals · TheirStack"] = round2(r.signalsRecurring);
    if (r.pdlCost > 0) bars["Person data · PDL"] = round2(r.pdlCost);
    bars["Cloned voice · Cartesia"] = round2(r.voiceRecurring);

    var html = '<div class="result-hero"><div class="rh-label">' + esc(motionName()) + ' · ' + r.recruiters + ' recruiter' + (r.recruiters === 1 ? '' : 's') + '</div>' +
      '<div class="rh-value">' + usd(r.recurring) + '<span>/mo</span></div>' +
      (r.oneTime > 0 ? '<div class="rh-sub">+ ' + usd(r.oneTime) + ' one-time setup</div>' : '') +
      '</div>';

    html += '<div class="result-metrics">' +
      metric(usd(r.perRecruiter), "per recruiter / mo") +
      metric(usd(r.perProspect, 4), "per prospect") +
      metric(usd(r.perEmail, 4), "per email") +
      '</div>';

    html += '<h3 style="font-size:13px;margin:16px 0 8px">Where it goes (recurring)</h3>' + barsFromObj(bars);

    html += '<h3 style="font-size:13px;margin:18px 0 8px">Effective rates</h3>' +
      '<div class="tier-lines">' +
      tl("TheirStack", "$" + fmt(r.tsCreditPrice, 5) + " / credit · " + Math.round(r.tsCreditsUsed).toLocaleString() + " credits used") +
      (r.pdlCost > 0 ? tl("People Data Labs", "$" + fmt(r.pdlPrice, 2) + " / match · " + r.pdlMatches.toLocaleString() + " matches") : "") +
      tl("Cartesia", "$" + fmt(r.cartCreditPrice * 1000, 4) + " / 1k chars · " + usd(r.perRecording, 4) + " / recording") +
      tl("Emailing", usd(r.emailing) + " over " + r.inboxes + " inboxes · " + r.domains + " domains") +
      '</div>';

    if (r.oneTime > 0) {
      html += '<h3 style="font-size:13px;margin:18px 0 8px">One-time setup</h3><div class="tier-lines">';
      if (r.signalsOneTime > 0) html += tlv("TheirStack credit pack", usd(r.signalsOneTime));
      if (r.voiceOneTime > 0) html += tlv("Cartesia PVC voice training", usd(r.voiceOneTime));
      html += '<div class="tl total"><span>Total setup</span><span class="v">' + usd(r.oneTime) + '</span></div></div>';
    }

    html += '<p class="note" style="margin-top:14px">Annualized: <strong>' + usd(r.recurring * 12) + '/yr</strong> recurring' + (r.oneTime > 0 ? ' + ' + usd(r.oneTime) + ' once' : '') + '. Recruiting OS and Business Development OS share the same unit costs, switch the tab above to model each with its own team size and volumes.</p>';

    $("#calcResults").innerHTML = html;

    // ---- scenario comparison: same per-seat assumptions, varied team size ----
    renderScenarios(full, r.recruiters);
  }

  function renderScenarios(full, current) {
    var el = $("#calcScenarios"); if (!el) return;
    var counts = CALC_LADDER.slice();
    if (counts.indexOf(current) === -1 && current > 0) counts.push(current);
    counts = counts.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });

    var html = '<h3>Cost by team size</h3><p class="note" style="margin:-2px 0 12px">Same per-recruiter assumptions, different headcount. <strong>Click any row to load it above.</strong> Your current size is highlighted, watch cost-per-recruiter fall as the fixed pieces (the voice plan, signal pack, domains) spread across more seats.</p>';
    html += '<div class="otable-wrap"><table class="otable scenario"><thead><tr>' +
      '<th>Recruiters</th><th class="num">Email</th><th class="num">Signals + data</th><th class="num">Voice</th>' +
      '<th class="num">Recurring / mo</th><th class="num">Per recruiter</th><th class="num">Setup</th>' +
      '</tr></thead><tbody>';
    counts.forEach(function (n) {
      var c = computeCalc(assign(full, "recruiters", n));
      html += '<tr class="clickrow' + (n === current ? ' cur' : '') + '" data-n="' + n + '">' +
        '<td><strong>' + n + '</strong></td>' +
        '<td class="num">' + usd(c.emailing) + '</td>' +
        '<td class="num">' + usd(c.signalsRecurring + c.pdlCost) + '</td>' +
        '<td class="num">' + usd(c.voiceRecurring) + '</td>' +
        '<td class="num"><strong>' + usd(c.recurring) + '</strong></td>' +
        '<td class="num">' + usd(c.perRecruiter) + '</td>' +
        '<td class="num">' + (c.oneTime > 0 ? usd(c.oneTime) : '-') + '</td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
    html += '<p class="note" style="margin-top:10px">Assumptions: ' + full.sendsPerInbox + ' sends/inbox · ' + full.inboxesPerDomain + ' inboxes/domain · ' +
      full.tsPerProspect + ' TheirStack credit' + (full.tsPerProspect === 1 ? '' : 's') + '/prospect · ' +
      full.pdlPerRec.toLocaleString() + ' PDL matches/recruiter @ $' + fmt(full.pdlPrice, 2) + '/match · Cartesia ' +
      (full.cartMode === "pvc" ? "Pro clone" : "Instant") + '. Edit any input above to reshape every row.</p>';
    el.innerHTML = html;

    $$("#calcScenarios .clickrow").forEach(function (tr) {
      tr.addEventListener("click", function () {
        var inp = $('#view [data-calc="recruiters"]');
        if (inp) { inp.value = Number(tr.dataset.n) || 0; recompute(); }
        var res = $("#calcResults");
        if (res && res.scrollIntoView) res.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }
  function metric(v, l) { return '<div class="rmetric"><div class="rm-v">' + esc(v) + '</div><div class="rm-l">' + esc(l) + '</div></div>'; }
  function tl(k, v) { return '<div class="tl"><span>' + esc(k) + '</span><span class="v" style="font-size:11.5px">' + esc(v) + '</span></div>'; }
  function tlv(k, v) { return '<div class="tl"><span>' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>'; }
  function fmt(n, dp) { return (Number(n) || 0).toFixed(dp == null ? 2 : dp); }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  /* ================= SPEND MASTER =================
   * The whole cost of running the business on one screen: every subscription, server,
   * domain, one-time purchase and credit top-up from the editable spend register, joined
   * with what the live system says about each one. The join is the value: a row can read
   * $150/mo while the signal underneath reads "no key configured anywhere", and that gap
   * is the single most expensive thing an owner can fail to notice.
   *
   *   viewBurn        the screen           burnKpis / burnAlert / burnTable / burnOneTime
   *   openSpendItem   click-through editor (reuses the account drawer)
   *   Backend         GET/POST/PATCH/DELETE /api/owner/burn
   */
  var burnData = null;
  var burnFilter = "all";
  /* Rows ticked for a bulk delete, keyed by id and shared by all three tables on this
     page. The register is one list, so a selection made in Domains and one made in
     One-time purchases go out in the same request. */
  var burnPicked = {};

  var BURN_CATEGORIES = [
    ["search", "Search & job feeds"], ["people", "People & phone data"], ["ai", "AI & voice"],
    ["messaging", "SMS & voice"], ["email", "Email & mailboxes"], ["infra", "Infrastructure"],
    ["domain", "Domains"], ["software", "Software seats"], ["other", "Other"]
  ];
  var BURN_BILLING = [
    ["monthly", "Monthly"], ["annual", "Annual"], ["one_time", "One-time"],
    ["credit", "Credit top-up"], ["metered", "Metered (pay per use)"]
  ];
  function labelFor(pairs, v) {
    for (var i = 0; i < pairs.length; i++) if (pairs[i][0] === v) return pairs[i][1];
    return v || "";
  }

  function viewBurn() {
    Promise.all([
      api("/owner/burn?window=" + win),
      api("/owner/receipts?months=" + rcptMonths).catch(function () { return null; })
    ]).then(function (res) {
      var b = res[0];
      burnData = b;
      rcptData = res[1];
      var html = '<div class="v-head"><h2>Spend master</h2><p>Every dollar leaving the business: subscriptions, servers, domains, one-time buys and pay-per-use, checked against what the running system is actually calling. Metered cost is for the selected window (' + esc(win) + '); recurring cost is per month.</p></div>';
      html += burnKpis(b);
      html += '<div class="vault-sel" id="burnSel" hidden></div>';
      html += receiptKpis(rcptData);
      html += sweepAlert(rcptData);
      html += closeWatch(rcptData);
      html += receiptAlerts(rcptData);
      html += receiptMatrix(rcptData);
      html += receiptGallery(rcptData);
      html += receiptSourcing(rcptData);
      html += burnAlert(b);
      html += '<div class="card" style="margin-top:14px">' +
        '<div class="burn-head"><h3>Recurring cost</h3><div class="burn-filters" id="burnFilters">' +
        burnChip("all", "All", b.items.length) +
        burnChip("dead", "Not earning", b.items.filter(isDead).length) +
        burnChip("needs", "Needs an amount", b.items.filter(function (i) { return i.needsAmount; }).length) +
        '</div></div>' + burnTable(b) + '</div>';
      html += burnEffectiveness(b);
      html += burnDomains(b);
      html += burnOneTime(b);
      html += '<div class="two-col" style="margin-top:14px">' +
        '<div class="card"><h3>Recurring by category</h3>' + barsFromObj(catLabels(b.byCategory)) + '</div>' +
        '<div class="card"><h3>Metered by provider · ' + esc(win) + '</h3>' + barsFromObj(b.metered.bySource) + '</div></div>';
      html += '<div class="card" style="margin-top:14px"><h3>Add a line item</h3>' + burnForm() + '</div>';
      $("#view").innerHTML = html;
      wireBurn();
      wireReceipts();
    }).catch(fail);
  }

  function isDead(i) { return i.live && (i.live.state === "unwired" || i.live.state === "idle") && monthlyOf(i) > 0; }
  function monthlyOf(i) {
    if (i.status !== "active") return 0;
    if (i.billing === "monthly") return i.amountUsd;
    if (i.billing === "annual") return i.amountUsd / 12;
    return 0;
  }
  function catLabels(obj) {
    var o = {}; Object.keys(obj || {}).forEach(function (k) { o[labelFor(BURN_CATEGORIES, k)] = obj[k]; }); return o;
  }
  function burnChip(id, label, n) {
    return '<button class="burn-chip' + (burnFilter === id ? " active" : "") + '" data-filter="' + id + '">' + esc(label) + ' <span>' + n + '</span></button>';
  }

  function burnKpis(b) {
    return '<div class="stat-grid">' +
      stat(usd(b.totalMonthlyUsd), "True monthly burn", "amber") +
      stat(usd(b.committedMonthlyUsd), "Committed / month") +
      stat(usd(b.meteredUsd), "Metered · " + esc(win)) +
      stat(usd(b.deadMonthlyUsd), "Not earning / month", b.deadMonthlyUsd ? "bad" : "good") +
      stat(usd(b.oneTimeTotalUsd), "One-time & credits") +
      stat(usd(b.annualCommittedUsd), "Annual commitments") +
      '</div>';
  }

  /* The money question, answered before anything else on the page: what is being paid
     for and not used, and what to do about each one. */
  function burnAlert(b) {
    var dead = b.items.filter(isDead).sort(function (x, y) { return monthlyOf(y) - monthlyOf(x); });
    if (!dead.length) {
      return '<div class="burn-alert ok" style="margin-top:16px"><div class="ba-title">Every recurring line item is being used.</div>' +
        '<p class="note">No subscription is drawing a charge without traffic behind it.</p></div>';
    }
    var html = '<div class="burn-alert" style="margin-top:16px"><div class="ba-title">' + usd(b.deadMonthlyUsd) + ' a month is being paid for without traffic behind it</div><ul>';
    dead.forEach(function (i) {
      html += '<li><strong>' + esc(i.vendor) + ' · ' + esc(i.label) + '</strong> ' + usd(monthlyOf(i)) + '/mo. ' + esc(i.live.reason) + '</li>';
    });
    html += '</ul><p class="note">Either wire it up or cancel it. Click any row below to record the decision.</p></div>';
    return html;
  }

  function burnTable(b) {
    var rows = b.items.filter(function (i) {
      if (i.billing === "one_time" || i.billing === "credit") return false;
      if (i.domain) return false; // domains have their own section with expiry and renewal
      if (burnFilter === "dead") return isDead(i);
      if (burnFilter === "needs") return !!i.needsAmount;
      return true;
    }).sort(function (x, y) { return monthlyOf(y) - monthlyOf(x); });

    if (!rows.length) return '<p class="note">Nothing matches this filter.</p>';
    var html = '<div class="otable-wrap"><table class="otable"><thead><tr>' + pickHead() +
      '<th>Vendor / item</th><th>Billing</th><th class="num">Cost / mo</th><th>Usage against the plan</th><th>Status</th>' +
      '</tr></thead><tbody>';
    rows.forEach(function (i) {
      html += '<tr class="clickrow" data-spend="' + esc(i.id) + '">' + pickCell(i) +
        '<td><div class="lr-main">' + esc(i.vendor) + ' · ' + esc(i.label) + '</div>' +
        '<div class="lr-sub note">' + esc(i.purpose || labelFor(BURN_CATEGORIES, i.category)) + '</div>' + acts(i.id) + '</td>' +
        '<td>' + esc(labelFor(BURN_BILLING, i.billing)) + '</td>' +
        '<td class="num">' + amountCell(i) + '</td>' +
        '<td>' + usageCell(i) + '</td>' +
        '<td>' + stateCell(i) + '</td>' +
        '</tr>';
    });
    return html + '</tbody></table></div>';
  }

  function amountCell(i) {
    if (i.needsAmount) return '<span class="pill needs">Set amount</span>';
    if (i.billing === "metered") return '<span class="note">per use</span>';
    var m = monthlyOf(i);
    var out = usd(m);
    if (i.billing === "annual") out += '<div class="note" style="font-size:11px">' + usd(i.amountUsd) + '/yr</div>';
    if (!i.verified) out += '<div class="note" style="font-size:11px">estimate</div>';
    return out;
  }

  /* Three different truths depending on what the vendor exposes: a real plan meter from
     the RapidAPI quota headers, a metered dollar figure from the usage ledger, or nothing
     at all (say so rather than implying zero usage). */
  function usageCell(i) {
    var L = i.live || {};
    if (L.quota && L.quota.limit) {
      var q = L.quota;
      var cls = q.pct >= 90 ? "bad" : q.pct >= 60 ? "amber" : "good";
      var perReq = i.amountUsd > 0 && q.limit ? i.amountUsd / q.limit : 0;
      return '<div class="meter"><div class="meter-track"><div class="meter-fill ' + cls + '" style="width:' + Math.max(1, Math.min(100, q.pct)) + '%"></div></div>' +
        '<div class="meter-l">' + q.used.toLocaleString("en-US") + ' / ' + q.limit.toLocaleString("en-US") + ' requests · ' + pct(q.pct) +
        (perReq ? ' · ' + usd(perReq, 4) + '/req' : '') + '</div>' +
        (L.history && L.history.length > 1 ? spark(L.history) : '') + '</div>';
    }
    if (L.meteredUsd != null && L.meteredUsd > 0) {
      return '<div class="meter-l">' + usd(L.meteredUsd) + ' metered in ' + esc(win) + '</div>';
    }
    if (L.state === "unwired") return '<div class="meter-l bad-t">No key configured</div>';
    return '<div class="meter-l note">No usage signal</div>';
  }

  /* Tiny inline sparkline of daily requests. Pure SVG, no library, no network. */
  function spark(hist) {
    var vals = hist.map(function (h) { return h.used; });
    var max = Math.max.apply(null, vals) || 1;
    var w = 120, h = 18, step = vals.length > 1 ? w / (vals.length - 1) : w;
    var pts = vals.map(function (v, idx) { return (idx * step).toFixed(1) + "," + (h - (v / max) * (h - 2)).toFixed(1); }).join(" ");
    return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" aria-hidden="true">' +
      '<polyline points="' + pts + '" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>';
  }

  function stateCell(i) {
    var s = (i.live && i.live.state) || "unknown";
    var map = { live: ["active", "Live"], idle: ["idle", "Idle"], unwired: ["dead", "Not wired"], unknown: ["unknown", "No signal"] };
    var m = map[s] || map.unknown;
    var html = '<span class="pill ' + m[0] + '">' + m[1] + '</span>';
    if (i.live && i.live.workspaces && i.live.workspaces.length) {
      html += '<div class="note" style="font-size:11px">' + i.live.workspaces.length + ' account' + (i.live.workspaces.length > 1 ? "s" : "") + ' connected</div>';
    }
    return html;
  }

  /* What each data source PRODUCED, priced per reply. The cost column is what makes this
     comparable: a 96% cell rate is only impressive next to what it cost to get. */
  function burnEffectiveness(b) {
    var rows = b.effectiveness || [];
    var html = '<div class="card" style="margin-top:14px"><h3>What each source actually produced</h3>' +
      '<p class="note" style="margin-top:-4px">Every phone number the engine handed to OS Text, scored by what happened next: whether the carrier confirmed it as a mobile, whether the text delivered, and whether a human replied. Cost per reply is the comparable number across sources.</p>';
    if (!rows.length) {
      return html + '<p class="note">No outcome data available. The OS Text engine did not answer, so spend is shown without results.</p></div>';
    }
    html += '<div class="otable-wrap"><table class="otable"><thead><tr>' +
      '<th>Source</th><th class="num">Cost / mo</th><th class="num">Cell rate</th><th class="num">Delivery</th>' +
      '<th class="num">Replies</th><th class="num">Reply rate</th><th class="num">Wrong person</th><th class="num">Cost / reply</th>' +
      '</tr></thead><tbody>';
    rows.forEach(function (r) {
      html += '<tr' + (r.itemId ? ' class="clickrow" data-spend="' + esc(r.itemId) + '"' : '') + '>' +
        '<td><div class="lr-main">' + esc(r.label) + '</div><div class="lr-sub note">' + r.checked.toLocaleString("en-US") + ' numbers checked · ' + r.texted.toLocaleString("en-US") + ' texted</div></td>' +
        '<td class="num">' + (r.monthlyUsd ? usd(r.monthlyUsd) : '<span class="note">free</span>') + '</td>' +
        '<td class="num">' + rateCell(r.cellRatePct, 60, 30) + '</td>' +
        '<td class="num">' + rateCell(r.deliveryRatePct, 90, 75) + '</td>' +
        '<td class="num">' + r.replied.toLocaleString("en-US") + '</td>' +
        '<td class="num">' + rateCell(r.replyRatePct, 8, 3) + '</td>' +
        '<td class="num">' + (r.wrongNumber ? r.wrongNumber + ' <span class="note">(' + pct(r.wrongNumberPct) + ')</span>' : '<span class="note">0</span>') + '</td>' +
        '<td class="num">' + (r.costPerReplyUsd != null ? '<strong>' + usd(r.costPerReplyUsd, 2) + '</strong>' : '<span class="note">-</span>') + '</td>' +
        '</tr>';
    });
    return html + '</tbody></table></div></div>';
  }
  function rateCell(v, good, mid) {
    var c = v >= good ? "margin-good" : v >= mid ? "margin-mid" : "margin-bad";
    return '<span class="' + c + '">' + pct(v) + '</span>';
  }

  /* Domains: bought once, forgotten, then they lapse and a sending domain dies with them.
     Dates come from the public registry, money is owner-entered.

     Grouped by the vendor the money actually went to, because that is how they were
     bought: 29 at Dynadot on one day, 15 at Porkbun a month later, 31 through Zapmail
     with the mailboxes that sit on them. A flat list of 75 names hides that entirely,
     and with it the only two questions worth asking, which are what each batch cost and
     what it renews at. Each group prices in one action for the same reason. */
  function burnDomains(b) {
    var rows = (b.items || []).filter(function (i) { return !!i.domain; });
    var soon = b.domainsExpiringSoon || [];
    var html = '<div class="card" style="margin-top:14px"><div class="burn-head"><h3>Domains</h3>' +
      '<div class="btn-row" style="margin:0"><button class="btn btn-sm" id="dmImport">Import from sending fleet</button>' +
      '<button class="btn btn-sm" id="dmRefresh">Refresh registry dates</button></div></div>';
    html += '<p class="note" style="margin-top:2px">' + (b.domainCount || 0) + ' domains tracked · ' + usd(b.domainRenewalAnnualUsd || 0) + ' to renew them all for another year. Registration, expiry and registrar come from the public registry. Price is yours to enter, and can be set for a whole batch at once.</p>';

    if (soon.length) {
      html += '<div class="burn-alert" style="margin:10px 0"><div class="ba-title">' + soon.length + ' domain' + (soon.length > 1 ? 's' : '') + ' expiring within 60 days</div><ul>';
      soon.slice(0, 8).forEach(function (d) {
        html += '<li><strong>' + esc(d.domain) + '</strong> ' + (d.days < 0 ? 'EXPIRED ' + Math.abs(d.days) + ' days ago' : 'in ' + d.days + ' days') +
          ' (' + esc((d.expiresAt || "").slice(0, 10)) + ')' + (d.autoRenew ? ', auto-renew on' : ', auto-renew NOT confirmed') + '</li>';
      });
      html += '</ul></div>';
    }
    if (!rows.length) {
      return html + '<p class="note">No domains tracked yet. Import pulls every domain the sending fleet uses, then Refresh fills in registration and expiry dates from the registry.</p></div>';
    }

    groupDomains(rows).forEach(function (g) { html += domainGroup(g); });
    return html + '</div>';
  }

  /* One group per vendor, biggest batch first. A domain whose registrar lookup has not
     landed yet is not silently dropped: it groups under what it does know. */
  function groupDomains(rows) {
    var by = {};
    rows.forEach(function (i) {
      var k = i.vendor && i.vendor !== "Domain registrar" ? i.vendor : (i.registrar || "Registrar not identified");
      (by[k] = by[k] || []).push(i);
    });
    return Object.keys(by).map(function (k) {
      var list = by[k].sort(function (x, y) { return (x.expiresAt || "9999").localeCompare(y.expiresAt || "9999"); });
      var paid = 0, renew = 0, mailboxes = 0, priced = 0;
      var first = "", last = "";
      list.forEach(function (i) {
        paid += Number(i.amountUsd) || 0;
        renew += Number(i.renewalUsd) > 0 ? Number(i.renewalUsd) : (Number(i.amountUsd) || 0);
        mailboxes += Number(i.mailboxCount) || 0;
        if (!i.needsAmount) priced += 1;
        var d = (i.registeredAt || i.at || "").slice(0, 10);
        if (d) { if (!first || d < first) first = d; if (!last || d > last) last = d; }
      });
      return { vendor: k, rows: list, paid: paid, renew: renew, mailboxes: mailboxes, priced: priced, first: first, last: last };
    }).sort(function (x, y) { return y.rows.length - x.rows.length; });
  }

  function domainGroup(g) {
    var n = g.rows.length;
    var providers = {};
    g.rows.forEach(function (i) { if (i.mailProvider) providers[i.mailProvider] = (providers[i.mailProvider] || 0) + (Number(i.mailboxCount) || 0); });
    var carries = Object.keys(providers).map(function (p) { return providers[p] + ' ' + p + ' inbox' + (providers[p] === 1 ? '' : 'es'); }).join(' · ');

    var when = g.first && g.last && g.first !== g.last ? g.first + ' to ' + g.last : (g.first || 'date unknown');
    // Named once for the batch: every domain in a group shares its registrar, and
    // repeating it per row buys nothing but width.
    var regs = {};
    g.rows.forEach(function (i) { if (i.registrar && i.registrar !== g.vendor) regs[i.registrar] = 1; });
    var regNames = Object.keys(regs);

    var html = '<div class="dm-group" style="margin-top:14px">' +
      '<div class="burn-head" style="align-items:baseline"><h4 style="margin:0">' + esc(g.vendor) + ' <span class="note" style="font-weight:400">· ' + n + ' domain' + (n === 1 ? '' : 's') + '</span></h4>' +
      '<div class="note">' + (g.priced === n ? usd(g.paid) + ' paid · ' + usd(g.renew) + '/yr to renew' : g.priced + ' of ' + n + ' priced') + '</div></div>' +
      '<p class="note" style="margin:2px 0 8px">Registered ' + esc(when) +
      (regNames.length ? ' through ' + esc(regNames.join(', ')) : '') +
      (carries ? ' · carries ' + esc(carries) : '') + '</p>';

    // Price the whole batch in one action: they were bought in one order at one price.
    html += '<div class="dm-batch" data-vendor="' + esc(g.vendor) + '" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">' +
      '<input class="dmPaid" type="number" min="0" step="0.01" placeholder="Paid each ($)" style="max-width:150px" />' +
      '<input class="dmRenew" type="number" min="0" step="0.01" placeholder="Renews at ($)" style="max-width:150px" />' +
      '<label class="note" style="display:flex;gap:5px;align-items:center"><input class="dmAuto" type="checkbox" /> auto-renew on</label>' +
      '<button class="btn btn-sm dmApply">Apply to all ' + n + '</button>' +
      '<span class="note">sets every ' + esc(g.vendor) + ' domain at once</span></div>';

    html += '<div class="otable-wrap"><table class="otable"><thead><tr>' + pickHead() +
      '<th>Domain</th><th>Carries</th><th>Purchased</th><th>Expires</th><th class="num">Days left</th><th class="num">Paid</th><th class="num">Renewal</th><th>Auto</th>' +
      '</tr></thead><tbody>';
    g.rows.forEach(function (i) {
      var days = i.expiresAt ? Math.round((Date.parse(i.expiresAt) - Date.now()) / 86400000) : null;
      var dcls = days == null ? "" : days < 0 ? "margin-bad" : days <= 60 ? "margin-mid" : "margin-good";
      html += '<tr class="clickrow" data-spend="' + esc(i.id) + '">' + pickCell(i) +
        '<td><div class="lr-main">' + esc(i.domain) + '</div>' +
        (i.registryError ? '<div class="lr-sub bad-t">' + esc(i.registryError) + '</div>' : '') +
        acts(i.id) + '</td>' +
        '<td>' + (i.mailboxCount ? esc(i.mailboxCount + ' ' + (i.mailProvider || '') + ' inbox' + (i.mailboxCount === 1 ? '' : 'es')) : '<span class="note">no mailboxes</span>') + '</td>' +
        '<td>' + esc((i.registeredAt || i.at || "").slice(0, 10) || "-") + '</td>' +
        '<td>' + (i.expiresAt ? esc(i.expiresAt.slice(0, 10)) : '<span class="note">unknown</span>') + '</td>' +
        '<td class="num">' + (days == null ? '<span class="note">-</span>' : '<span class="' + dcls + '">' + days + '</span>') + '</td>' +
        '<td class="num">' + (i.needsAmount ? '<span class="pill needs">Set</span>' : usd(i.amountUsd)) + '</td>' +
        '<td class="num">' + (i.renewalUsd ? usd(i.renewalUsd) : '<span class="note">-</span>') + '</td>' +
        '<td>' + (i.autoRenew ? '<span class="pill active">On</span>' : '<span class="pill unknown">Unset</span>') + '</td>' +
        '</tr>';
    });
    return html + '</tbody></table></div></div>';
  }

  function burnOneTime(b) {
    var rows = b.items.filter(function (i) { return i.billing === "one_time" || i.billing === "credit"; })
      .sort(function (x, y) { return (y.at || "").localeCompare(x.at || ""); });
    var html = '<div class="card" style="margin-top:14px"><h3>One-time purchases & credit top-ups</h3>';
    if (!rows.length) {
      html += '<p class="note">Nothing recorded yet. Add domain buys, hardware, and prepaid credit here so the true cost of the business is complete.</p>';
      return html + '</div>';
    }
    html += '<div class="otable-wrap"><table class="otable"><thead><tr>' + pickHead() +
      '<th>Vendor / item</th><th>Type</th><th>Date</th><th class="num">Amount</th></tr></thead><tbody>';
    rows.forEach(function (i) {
      html += '<tr class="clickrow" data-spend="' + esc(i.id) + '">' + pickCell(i) +
        '<td><div class="lr-main">' + esc(i.vendor) + ' · ' + esc(i.label) + '</div><div class="lr-sub note">' + esc(i.purpose || "") + '</div>' + acts(i.id) + '</td>' +
        '<td>' + esc(labelFor(BURN_BILLING, i.billing)) + (i.lifetime ? ' <span class="pill active">No ongoing fee</span>' : '') + '</td>' +
        '<td>' + esc(i.at || "") + '</td>' +
        '<td class="num">' + oneTimeAmountCell(i) + '</td></tr>';
    });
    return html + '</tbody></table></div></div>';
  }

  /* A paid-once row with no price on file is not a $0 purchase and not a missing figure to
     nag about: the money left the account before these books existed. Say that instead. */
  function oneTimeAmountCell(i) {
    if (i.lifetime && !i.amountUsd) return '<span class="note">paid before this register</span>';
    if (i.needsAmount) return '<span class="pill needs">Set amount</span>';
    return usd(i.amountUsd);
  }

  function burnForm() {
    return '<div class="burn-form">' +
      fld("Vendor", '<input id="bfVendor" placeholder="Hetzner" />') +
      fld("Item", '<input id="bfLabel" placeholder="App server (CCX13)" />') +
      fld("Category", select("bfCategory", BURN_CATEGORIES, "infra")) +
      fld("Billing", select("bfBilling", BURN_BILLING, "monthly")) +
      fld("Amount (USD)", '<input id="bfAmount" type="number" min="0" step="0.01" placeholder="0.00" />') +
      fld("Date", '<input id="bfAt" type="date" />') +
      fld("What it buys", '<input id="bfPurpose" placeholder="Runs the portal and every worker" />') +
      '<div class="btn-row"><button class="btn btn-primary btn-sm" id="bfAdd">Add line item</button></div>' +
      '</div>';
  }
  function select(id, pairs, sel) {
    return '<select id="' + id + '">' + pairs.map(function (p) {
      return '<option value="' + p[0] + '"' + (p[0] === sel ? " selected" : "") + '>' + esc(p[1]) + '</option>';
    }).join("") + '</select>';
  }

  /* Every table on this page hands the same two things to a row: Edit, which opens the
     drawer that clicking the row already opened, and Delete, which the row had no way to
     reach at all. Edit is spelled out because a row being clickable was something you had
     to already know.
     They sit UNDER the row's name rather than in a column of their own. Domains is eight
     columns wide before anything is added to it, and a ninth put both links past the right
     edge at 1024px, where they can only be reached by scrolling the table sideways: an
     action you cannot see is not an action the row has. */
  function pickHead() {
    return '<th class="row-pick"><input type="checkbox" class="burn-box" data-pickall="1" title="Select every row in this table"></th>';
  }
  function pickCell(i) {
    return '<td class="row-pick"><input type="checkbox" class="burn-box" data-pick="' + esc(i.id) + '"' +
      (burnPicked[i.id] ? ' checked' : '') + '></td>';
  }
  function acts(id) {
    return '<div class="row-acts"><a class="row-mini" data-bedit="' + esc(id) + '">Edit</a>' +
      '<a class="row-mini danger" data-bdel="' + esc(id) + '">Delete</a></div>';
  }

  function burnItem(id) {
    return ((burnData && burnData.items) || []).filter(function (x) { return x.id === id; })[0];
  }
  function burnName(id) {
    var i = burnItem(id);
    return i ? (i.domain || (i.vendor + " · " + i.label)) : "this line item";
  }

  /* One confirmation and one request, whether it is a row or forty. The two ways a row
     can come back are named in the prompt, because a delete that quietly undoes itself at
     the next deploy is worse than one that never happened. */
  function deleteBurnRows(ids, what) {
    if (!ids.length) return;
    if (!confirm("Remove " + (what || "this line item") + " from the register?\n\n" +
      "Its cost stops counting toward the burn figure. A line the register seeds itself stays gone; " +
      "a deleted domain comes back only if you press Import from sending fleet.")) return;
    send("/owner/burn?ids=" + encodeURIComponent(ids.join(",")), "DELETE").then(function (r) {
      if (!r.ok) { toast(r.status === 404 ? "Already gone" : "Could not remove"); return; }
      var n = (r.data && r.data.deleted) || ids.length;
      ids.forEach(function (id) { delete burnPicked[id]; });
      toast(n === 1 ? "Line item removed" : n + " line items removed");
      closeDrawer();
      viewBurn();
    });
  }

  /* The bar only exists while something is ticked, and it prunes ids that are no longer
     on screen so a delete cannot leave a phantom count behind. */
  function syncBurnSel() {
    var live = {};
    ((burnData && burnData.items) || []).forEach(function (i) { if (burnPicked[i.id]) live[i.id] = true; });
    burnPicked = live;
    var ids = Object.keys(burnPicked);
    var bar = $("#burnSel");
    if (!bar) return;
    if (!ids.length) { bar.hidden = true; bar.innerHTML = ""; return; }
    bar.hidden = false;
    bar.innerHTML = '<span class="vault-sel-n">' + ids.length + ' selected</span>' +
      '<span style="flex:1"></span>' +
      '<a class="row-mini" id="burnSelNone">Clear selection</a>' +
      '<a class="btn btn-danger btn-sm" id="burnSelDel">Delete selected</a>';
    $("#burnSelNone").addEventListener("click", function () {
      burnPicked = {};
      $$("#view input.burn-box").forEach(function (c) { c.checked = false; });
      syncBurnSel();
    });
    $("#burnSelDel").addEventListener("click", function () {
      deleteBurnRows(ids, ids.length === 1 ? burnName(ids[0]) : ids.length + " line items");
    });
  }

  function wireBurn() {
    $$("#burnFilters .burn-chip").forEach(function (c) {
      c.addEventListener("click", function () { burnFilter = c.dataset.filter; viewBurn(); });
    });
    $$("#view .clickrow[data-spend]").forEach(function (tr) {
      tr.addEventListener("click", function () { openSpendItem(tr.dataset.spend); });
    });
    /* The whole row opens the drawer, so the tick box and the two links have to stop the
       click getting there, or ticking a box to delete it would open the editor instead. */
    $$("#view td.row-pick, #view .row-acts").forEach(function (el) {
      el.addEventListener("click", function (ev) { ev.stopPropagation(); });
    });
    $$("#view [data-bedit]").forEach(function (a) {
      a.addEventListener("click", function () { openSpendItem(a.dataset.bedit); });
    });
    $$("#view [data-bdel]").forEach(function (a) {
      a.addEventListener("click", function () { deleteBurnRows([a.dataset.bdel], burnName(a.dataset.bdel)); });
    });
    $$("#view [data-pick]").forEach(function (c) {
      c.addEventListener("change", function () {
        if (c.checked) burnPicked[c.dataset.pick] = true; else delete burnPicked[c.dataset.pick];
        syncBurnSel();
      });
    });
    // Select-all is per table, because that is the group you can actually see.
    $$("#view [data-pickall]").forEach(function (c) {
      c.addEventListener("change", function () {
        $$("[data-pick]", c.closest("table")).forEach(function (b) {
          b.checked = c.checked;
          if (c.checked) burnPicked[b.dataset.pick] = true; else delete burnPicked[b.dataset.pick];
        });
        syncBurnSel();
      });
    });
    syncBurnSel();
    // Price a whole registrar batch in one call. A blank field is left untouched
    // rather than sent as zero, so setting only the renewal price is a real option.
    $$("#view .dm-batch").forEach(function (box) {
      var btn = box.querySelector(".dmApply");
      if (!btn) return;
      btn.addEventListener("click", function () {
        var paid = box.querySelector(".dmPaid").value.trim();
        var renew = box.querySelector(".dmRenew").value.trim();
        var auto = box.querySelector(".dmAuto").checked;
        if (!paid && !renew && !auto) { toast("Enter a price first"); return; }
        var payload = { action: "price_domains", vendor: box.dataset.vendor, overwrite: true };
        if (paid) payload.amountUsd = Number(paid);
        if (renew) payload.renewalUsd = Number(renew);
        if (auto) payload.autoRenew = true;
        btn.classList.add("disabled");
        send("/owner/burn", "POST", payload).then(function (r) {
          btn.classList.remove("disabled");
          if (!r.ok) { toast("Could not price that batch"); return; }
          toast("Priced " + r.data.priced + " " + box.dataset.vendor + " domain(s)");
          viewBurn();
        });
      });
    });

    var imp = $("#dmImport"), ref = $("#dmRefresh");
    if (imp) imp.addEventListener("click", function () {
      imp.classList.add("disabled"); toast("Reading the sending fleet…");
      send("/owner/burn", "POST", { action: "import_domains" }).then(function (r) {
        imp.classList.remove("disabled");
        if (!r.ok) { toast("Import failed"); return; }
        toast(r.data.added ? "Added " + r.data.added + " domain(s)" : "No new domains found");
        viewBurn();
      });
    });
    if (ref) ref.addEventListener("click", function () {
      ref.classList.add("disabled"); toast("Checking the registry, this can take a minute…");
      send("/owner/burn", "POST", { action: "refresh_domains" }).then(function (r) {
        ref.classList.remove("disabled");
        if (!r.ok) { toast("Refresh failed"); return; }
        toast("Updated " + r.data.updated + " of " + r.data.checked + (r.data.failed ? " · " + r.data.failed + " failed" : ""));
        viewBurn();
      });
    });

    var add = $("#bfAdd");
    if (add) add.addEventListener("click", function () {
      var vendor = $("#bfVendor").value.trim();
      if (!vendor) { toast("Vendor is required"); return; }
      send("/owner/burn", "POST", {
        vendor: vendor,
        label: $("#bfLabel").value.trim() || vendor,
        category: $("#bfCategory").value,
        billing: $("#bfBilling").value,
        amountUsd: Number($("#bfAmount").value) || 0,
        at: $("#bfAt").value || undefined,
        purpose: $("#bfPurpose").value.trim() || undefined
      }).then(function (r) {
        if (!r.ok) { toast("Could not add that"); return; }
        toast("Line item added"); viewBurn();
      });
    });
  }

  /* ================= RECEIPTS · MONTH BY MONTH =================
   * Proof, not estimates. Every vendor down the side, every month across the top, the
   * receipt itself behind each cell, and a running total in both directions. A cell with
   * no receipt is not blank — it is reported as a gap, because an unnoticed gap is how a
   * month goes unaccounted for.
   *
   *   receiptKpis / receiptAlerts / receiptMatrix / receiptSourcing
   *   openViewer       the popup: the invoice full size, ✕ to close, arrows to step
   *   openReceipt      one receipt · openCell one service in one month
   *   openMonthReceipts / openMonthAt   a whole month, in vendor order
   *   openMissing      a month with nothing on file: where to get it, how to attach it
   *   editReceipt      correct what the parser read (the drawer behind the popup)
   *   openAttach       hand-attach an invoice downloaded from a vendor portal
   *   Backend          GET/POST/PATCH/DELETE /api/owner/receipts
   */
  var rcptData = null;
  var rcptMonths = Number(localStorage.getItem("owner_rcpt_months")) || 12;
  var rcptPoll = null;
  var rcptLive = localStorage.getItem("owner_rcpt_live") !== "0";
  var rcptLiveTimer = null;

  var CELL_LABEL = {
    paid: "receipt on file", mismatch: "amount differs from the register", missing: "no receipt",
    pending: "not charged yet", unexpected: "charged with nothing expected", metered: "pay per use",
    prepaid: "covered by the annual payment", none: "nothing charged", before: "before this service started",
    paused: "paused by the vendor, nothing due", waived: "marked as no charge — click to restore", cancelled: "cancelled"
  };

  function receiptKpis(d) {
    if (!d) {
      return '<div class="burn-alert" style="margin-top:16px"><div class="ba-title">Receipt tracking could not load</div>' +
        '<p class="note">The month-by-month report is unavailable, so what follows is the register only.</p></div>';
    }
    var t = d.matrix.totals;
    var delta = t.priorMonthUsd ? ((t.currentMonthUsd - t.priorMonthUsd) / t.priorMonthUsd) * 100 : 0;
    return '<div class="stat-grid" style="margin-top:14px">' +
      stat(usd(t.allTimeCountedUsd), "Spent all-time (tracked)", "amber") +
      stat(usd(t.currentMonthUsd), "This month" + (t.priorMonthUsd ? " · " + (delta >= 0 ? "+" : "") + delta.toFixed(0) + "% vs last" : "")) +
      stat(usd(t.priorMonthUsd), "Last month") +
      stat(usd(t.avgMonthUsd), "Average closed month") +
      stat(pct(t.coveragePct), t.receiptCount + " receipts on file" + (t.missingCount ? " · " + t.missingCount + " gaps" : "") + " · backed by a receipt",
        t.coveragePct >= 90 ? "good" : t.coveragePct >= 60 ? "amber" : "bad") +
      '</div>';
  }

  /* Everything the reconciler could not explain, worst first. This is the list that keeps
     a month from passing unreported. */
  /* A pull that cannot sign in is the one failure that stops every receipt at once, so it
     is said at the top rather than left as a line inside the sourcing panel. */
  /**
   * Which mailbox holds which vendor's receipts.
   *
   * Every vendor here mails its invoice SOMEWHERE. Until this panel existed a blank cell
   * meant four different things at once — the vendor did not charge, or it charged and
   * mailed an address nobody reads, or nobody had said which address it uses, or no
   * mailbox was connected at all — and only one of those is "nothing to do". Each row
   * now carries the one thing that would fix it.
   *
   * Vendors that are already collecting are folded away. A working row is not a task,
   * and forty of them buried the four that were.
   */
  function mailRouting(d) {
    var r = d && d.routing;
    if (!r || !r.routes || !r.routes.length) return "";

    var todo = r.routes.filter(function (x) {
      return x.status === "unswept" || x.status === "no_email" || x.status === "no_mailbox";
    });
    var live = r.routes.filter(function (x) { return x.status === "collecting"; });
    var ready = r.routes.filter(function (x) { return x.status === "covered"; });

    var head = !r.mailboxes.length
      ? "No mailbox is connected, so no vendor can report by email"
      : todo.length
        ? todo.length + " vendor" + (todo.length === 1 ? "'s receipts are" : "s' receipts are") + " not reachable from any mailbox being read"
        : "Every vendor's receipts land in a mailbox being read";
    var cls = !r.mailboxes.length ? "" : todo.length ? " warn" : " ok";

    var html = '<div class="burn-alert' + cls + '" style="margin:10px 0"><div class="ba-title">' + esc(head) + '</div>' +
      '<p class="note">Email is the only collection route that needs no password, cannot be blocked by a captcha and covers vendors with no portal session. ' +
      live.length + ' vendor' + (live.length === 1 ? ' is' : 's are') + ' already producing receipts this way' +
      (ready.length
        ? ', and ' + ready.length + (ready.length === 1 ? ' more bills' : ' more bill') + ' a mailbox being read but ' +
          (ready.length === 1 ? 'has' : 'have') + ' not been heard from yet'
        : '') + '.</p>';

    if (r.mailboxes.length) {
      html += '<p class="note">Reading ' + r.mailboxes.map(function (m) {
        return '<span class="mono">' + esc(m.user) + '</span> (' + m.vendors + ' vendor' + (m.vendors === 1 ? '' : 's') + ')' +
          (m.inherited ? ' <span class="dim">(borrowed from the resume inbox)</span>' : '');
      }).join(", ") + '.</p>';
    }
    html += '</div>';

    if (!todo.length) return html;

    html += '<div class="otable-wrap"><table class="otable route-table"><thead><tr>' +
      '<th>Vendor</th><th>Receipts arrive at</th><th>Read by</th><th>What is needed</th>' +
      '</tr></thead><tbody>';
    todo.forEach(function (x) {
      var pill = x.status === "unswept" ? '<span class="pill dead">Nobody reads it</span>'
        : x.status === "no_email" ? '<span class="pill needs">No address on file</span>'
        : '<span class="pill dead">No mailbox</span>';
      html += '<tr><td><div class="lr-main">' + esc(x.vendor) + '</div>' + pill + '</td>' +
        '<td data-l="Bills">' + (x.email
          ? '<span class="mono">' + esc(x.email) + '</span>' +
            (x.emailFrom === "username" ? '<div class="note" style="font-size:11px">taken from the sign-in username</div>' : '')
          : '<span class="note" style="margin:0">not set</span>') + '</td>' +
        '<td data-l="Read by">' + (x.mailbox ? '<span class="mono">' + esc(x.mailbox) + '</span>' : '<span class="note" style="margin:0">no mailbox</span>') + '</td>' +
        '<td data-l="To fix"><div class="lr-sub">' + esc(x.fix || "") + '</div>' +
        (x.accountId ? '<a class="vault-mini" href="#passwords">Open in Passwords</a>' : '') + '</td></tr>';
    });
    html += '</tbody></table></div>';
    return html;
  }

  function sweepAlert(d) {
    var sweep = d && d.inbox && (d.inbox.sweeps || [])[0];
    if (!sweep || sweep.ok) return "";
    /* The banner stays, because it is why the figures below are estimates. The raw error
       string does not: it means nothing to an accountant and lives under Collection
       status, where the owner goes to fix it. */
    return '<div class="burn-alert" style="margin-top:16px"><div class="ba-title">No receipt can be read: the mailbox turned the pull away</div>' +
      '<p class="note">Until this is fixed the months below can only show the register\'s estimate, because nothing new is arriving to prove them.</p></div>';
  }

  /* Whether the books are closing themselves.

     The rest of this page reports what IS; this one line reports that something is
     watching it whether or not anyone opens the console. A monthly check that only runs
     when someone remembers is not a check, so the state of the unattended job belongs on
     the page next to the figures it is guarding. */
  /* "today" / "yesterday" / "3 days ago": a date stamp makes the reader do arithmetic
     to answer the only question they have, which is whether this ran recently. */
  function ago(iso) {
    if (!iso) return "never";
    var days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (!isFinite(days) || days < 0) return "just now";
    return days === 0 ? "today" : days === 1 ? "yesterday" : days + " days ago";
  }

  function closeWatch(d) {
    var c = d && d.close;
    if (!c) return "";
    var last = (c.history || [])[0];
    var line, cls;
    if (!last) {
      line = c.judging
        ? "The books are checked every morning. " + monthLabelLong(c.judging) + " has not been judged yet."
        : "The books are checked every morning. Last month is still inside its grace window, so nothing is called missing yet.";
      cls = " warn";
    } else if (last.state === "settled") {
      line = monthLabelLong(last.period) + " closed with every charge proven by the vendor's own invoice. Checked " + ago(last.checkedAt) + ".";
      cls = " ok";
    } else if (last.state === "blocked") {
      line = monthLabelLong(last.period) + " is not fully proven, and nothing is collecting the missing invoices. Reported " + (last.reportedAt ? ago(last.reportedAt) : "already") + " by email.";
      cls = "";
    } else {
      line = monthLabelLong(last.period) + " is not fully proven yet. Collection is working, so it may still arrive on its own.";
      cls = " warn";
    }
    var who = c.notice && c.notice.configured && (c.notice.to || []).length
      ? "You are emailed at " + esc((c.notice.to || []).join(", ")) + " only when something needs you."
      : "No email can be sent from here yet, so a problem would sit on this page unread.";
    return '<div class="burn-alert' + cls + '" style="margin-top:16px"><div class="ba-title">' + esc(line) + '</div>' +
      '<p class="note">' + who + '</p></div>';
  }

  function receiptAlerts(d) {
    if (!d) return "";
    var a = d.matrix.anomalies || [];
    if (!a.length) {
      return '<div class="burn-alert ok" style="margin-top:16px"><div class="ba-title">Every month reconciles.</div>' +
        '<p class="note">Each active service has a receipt for every elapsed month, and every charge matches the register.</p></div>';
    }
    var high = a.filter(function (x) { return x.severity === "high"; });
    var head = high.length
      ? high.length + " thing" + (high.length > 1 ? "s" : "") + " will leave a month unreported"
      : a.length + " item" + (a.length > 1 ? "s" : "") + " to reconcile";
    var html = '<div class="burn-alert' + (high.length ? "" : " warn") + '" style="margin-top:16px"><div class="ba-title">' + esc(head) + '</div><ul class="rcpt-anoms">';
    a.slice(0, 14).forEach(function (x) {
      html += '<li class="sev-' + esc(x.severity) + '"><span class="anom-kind">' + esc(x.kind.replace(/_/g, " ")) + '</span> ' +
        esc(x.message) + (x.fix ? ' <span class="note">' + esc(x.fix) + '</span>' : "") + '</li>';
    });
    html += '</ul>';
    if (a.length > 14) html += '<p class="note">' + (a.length - 14) + ' more below the fold of this list.</p>';
    return html + '</div>';
  }

  /* The grid itself: services x months, receipts behind the cells, running totals on both
     axes. Amounts a receipt proves are solid; amounts taken from the register are shown as
     estimates so a total is never quietly invented. */
  // The client account that owner-pushed spend lands on (app.lumesp = Lume).
  // Resolved once from the accounts list by domain/name and cached for the session.
  var _clientWs = null;
  function resolveClientWs(cb) {
    if (_clientWs) { cb(_clientWs.id, _clientWs.name); return; }
    api("/owner/accounts").then(function (r) {
      var accts = (r && r.accounts) || [];
      var pick = accts.filter(function (x) {
        var dom = (x.domain || "").toLowerCase(), nm = (x.name || "").toLowerCase();
        return dom.indexOf("lumesp") >= 0 || nm.indexOf("lume") >= 0;
      })[0] || accts[0];
      if (pick) { _clientWs = { id: pick.workspaceId, name: pick.name }; cb(pick.workspaceId, pick.name); }
      else cb(null);
    }).catch(function () { cb(null); });
  }
  // One click from the Month-by-month grid: STAGE the whole row's spend on the
  // client's account as pending. It does NOT go live — the owner approves it on
  // the account's Spending panel, so nothing reaches app.lumesp without sign-off.
  function sendSpendToClient(el, label, amt) {
    if (!(amt > 0)) { toast("Nothing to send on this row."); return; }
    resolveClientWs(function (wsId, wsName) {
      if (!wsId) { toast("No client account found to send to."); return; }
      el.classList.add("is-busy"); var orig = el.textContent; el.textContent = "Staging…";
      send("/owner/portal-spend", "POST", { workspaceId: wsId, source: "usage", label: label, amountUsd: amt }).then(function (r) {
        var cid = r && r.ok && r.data && r.data.charge && r.data.charge.id;
        if (!cid) { toast((r.data && r.data.message) || "Couldn't stage"); el.classList.remove("is-busy"); el.textContent = orig; return; }
        toast("Staged for " + (wsName || "client") + " — approve to send");
        el.classList.remove("is-busy"); el.classList.add("sent"); el.textContent = "Staged ✓";
        showStagedBar(wsId, wsName, 1, 0);
      }).catch(function () { toast("Couldn't reach the server"); el.classList.remove("is-busy"); el.textContent = orig; });
    });
  }
  /**
   * Everything on one row that should become its own line on the client's statement.
   *
   * One line per RECEIPT, carrying that receipt so the invoice travels with the figure.
   * A month with money but no receipt on file still goes, as a bare figure, because
   * leaving it out would understate the row; it is labelled so the gap is visible on the
   * statement rather than hidden inside a total.
   */
  function rowStageItems(r) {
    var out = [];
    (r.cells || []).forEach(function (c) {
      var mlab = monthLabel(c.period);
      var list = (c.receipts || []).map(function (x) { return receiptById(x.id) || x; })
        .filter(function (x) { return x && x.amountUsd > 0; });
      if (list.length) {
        list.forEach(function (x) {
          out.push({
            key: null,
            label: ((r.vendor || "Spend") + " — " + mlab + (x.invoiceNumber ? " · #" + x.invoiceNumber : "")).slice(0, 80),
            amt: x.amountUsd,
            /* Read off the invoice, so a plan fee and a one-off purchase stay apart on
               the client's statement instead of both reading as recurring. */
            cadence: rcCadence[x.id] || (x.cadence === "recurring" ? "monthly" : "one_time"),
            receipt: {
              receiptId: x.id, vendor: r.vendor, chargedAt: x.chargedAt,
              invoiceNumber: x.invoiceNumber, hasShot: !!x.hasShot, hasFile: !!x.hasFile
            }
          });
        });
        return;
      }
      var amt = cellAmt(c);
      if (amt > 0) {
        out.push({
          key: null,
          label: ((r.vendor || "Spend") + " — " + mlab + " (no invoice on file)").slice(0, 80),
          amt: amt, cadence: "one_time"
        });
      }
    });
    return out;
  }

  /** Stage a whole row, one line per invoice, sequentially so one stall cannot wedge the rest. */
  function stageRow(el, r) {
    var items = rowStageItems(r);
    if (!items.length) { toast("This row has no cost to send."); return; }
    var withDoc = items.filter(function (i) { return !!i.receipt; }).length;
    resolveClientWs(function (wsId, wsName) {
      if (!wsId) { toast("No client account found to send to."); return; }
      el.classList.add("is-busy");
      var orig = el.textContent;
      el.textContent = "Staging…";
      var okCount = 0, failCount = 0;
      (function next(i) {
        if (i >= items.length) {
          el.classList.remove("is-busy");
          if (okCount) {
            el.classList.add("sent");
            el.textContent = "Staged ✓";
            showStagedBar(wsId, wsName, okCount, failCount);
            toast(okCount + " line" + (okCount === 1 ? "" : "s") + " staged, " + withDoc + " with the invoice attached");
          } else { el.textContent = orig; toast("Nothing could be staged"); }
          return;
        }
        var it = items[i];
        var payload = { workspaceId: wsId, source: "usage", label: it.label, amountUsd: it.amt, cadence: it.cadence };
        if (it.receipt) payload.receipt = it.receipt;
        send("/owner/portal-spend", "POST", payload).then(function (res) {
          if (res && res.ok && res.data && res.data.charge && res.data.charge.id) okCount++; else failCount++;
          next(i + 1);
        }).catch(function () { failCount++; next(i + 1); });
      })(0);
    });
  }

  /* ---- Cherry-pick receipts and rows -> the client's Spending page ----
     The whole point of this grid: tick the receipts (individual month cells) and
     the rows you want, then push the chosen set to the client's app.lumesp
     Spending tab in one go. Each ticked receipt lands as its OWN one-time line at
     its own proven amount, owner-approved so it shows the moment it is sent. A
     session record of what was already sent greys those boxes so the same receipt
     can't be double-billed by a stray second click. */
  var rcSel = {};      // "ri|period" -> true, a picked cell
  var rcSent = {};     // "ri|period" -> true, sent to Spending this session
  var rcCadence = {};  // receiptId -> "monthly"|"one_time", owner override of the read cadence

  /* The dollar figure a cell can push: a proven receipt amount, or a metered
     cell's counted usage. Estimates ("no receipt", "due") are NOT pushable — you
     only ever forward money that actually left the business. 0 means no checkbox. */
  function cellAmt(c) {
    if (!c) return 0;
    if (c.actualUsd > 0) return c.actualUsd;
    if (c.status === "metered" && c.countedUsd > 0) return c.countedUsd;
    return 0;
  }
  function rcSelKeys() { return Object.keys(rcSel); }

  /* Resolve a "ri|period" pick key back to its live row + cell in the grid data. */
  function cellByKey(pkey) {
    var idx = String(pkey).indexOf("|");
    if (idx < 0) return null;
    var ri = Number(pkey.slice(0, idx)), period = pkey.slice(idx + 1);
    var rows = (rcptData && rcptData.matrix && rcptData.matrix.rows) || [];
    var row = rows[ri]; if (!row) return null;
    var cell = (row.cells || []).filter(function (c) { return c.period === period; })[0];
    return cell ? { row: row, cell: cell, ri: ri } : null;
  }

  /* Flatten the current selection into the actual lines that will be pushed: ONE
     per receipt, not one per cell, so a month that holds two invoices sends two
     separate lines — each with its own amount, its own invoice number, and its
     own receipt image following it to the client. A metered cell (no invoice)
     sends a single receipt-less line for its counted usage. Each item is tagged
     with the cell key it came from so the cell can be marked sent once all of its
     receipts land. */
  function resolvePush() {
    var out = [];
    rcSelKeys().forEach(function (pkey) {
      var rc = cellByKey(pkey); if (!rc) return;
      var row = rc.row, c = rc.cell, mlab = monthLabel(c.period);
      if (c.receipts && c.receipts.length) {
        c.receipts.forEach(function (r) {
          if (!(r.amountUsd > 0)) return;
          var lbl = (row.vendor || "Spend") + " — " + mlab + (r.invoiceNumber ? " · #" + r.invoiceNumber : "");
          // Cadence read off the invoice, overridable by the owner. "recurring" on
          // the receipt means it bills monthly on the client; anything else is a
          // one-time charge. The two ZapMail invoices land on opposite sides of
          // this line, which is what keeps them separated for the client.
          var def = r.cadence === "recurring" ? "monthly" : "one_time";
          out.push({
            key: pkey,
            receiptId: r.id,
            label: lbl.slice(0, 80),
            amt: r.amountUsd,
            cadence: rcCadence[r.id] || def,
            receipt: {
              receiptId: r.id,
              vendor: row.vendor,
              chargedAt: r.chargedAt,
              invoiceNumber: r.invoiceNumber,
              hasShot: !!r.hasShot,
              hasFile: !!r.hasFile
            }
          });
        });
      } else {
        var amt = cellAmt(c);
        if (amt > 0) out.push({ key: pkey, label: (row.vendor || "Spend") + " — " + mlab, amt: amt, cadence: "one_time" });
      }
    });
    return out;
  }

  /** The checkbox that sits on a pushable cell, reflecting current pick/sent state.
      A cell that holds more than one invoice says so, since ticking it forwards
      every one of them as its own line. */
  function cellPick(row, c, ri) {
    var amt = cellAmt(c);
    if (!(amt > 0)) return "";
    var pkey = ri + "|" + c.period;
    var sent = !!rcSent[pkey], on = !!rcSel[pkey];
    var many = c.receipts && c.receipts.length > 1 ? c.receipts.length : 0;
    return '<label class="rc-pick' + (sent ? " sent" : "") + '" title="' +
      esc(sent ? "Already staged for approval"
        : many ? "Select these " + many + " receipts to stage for the client's Spending page"
        : "Select this receipt to stage for the client's Spending page") + '">' +
      '<input type="checkbox" data-rcpick="' + esc(pkey) + '"' +
      (on ? " checked" : "") + (sent ? " disabled" : "") + ' />' +
      (sent ? '<span class="rc-picksent">sent&nbsp;✓</span>'
        : many ? '<span class="rc-pickn">×' + many + '</span>' : "") + '</label>';
  }

  /** Row-level controls: cherry-pick every receipt on the row, or one-click send
      the whole row as a single consolidated line. */
  function sendRowAct(r, ri) {
    var acts = [];
    var pickable = (r.cells || []).filter(function (c) { return cellAmt(c) > 0 && !rcSent[ri + "|" + c.period]; }).length;
    if (pickable) acts.push('<a class="row-mini" data-pickrow="' + ri + '">Select receipt' + (pickable > 1 ? "s" : "") + '</a>');
    if (r.totalCountedUsd > 0) acts.push('<a class="row-mini" data-sendrow="' + ri + '">Stage row →</a>');
    if (!acts.length) return "";
    return '<div class="row-acts">' + acts.join("") + '</div>';
  }

  /** The sticky action bar at the foot of the grid: what's picked, and the button
      that pushes it. Rebuilt from rcSel on every selection change and after a
      re-render, so it always matches the ticked boxes above it. */
  function renderPushBar() {
    var bar = $("#rcPushBar"); if (!bar) return;
    var items = resolvePush();
    if (!items.length) { bar.hidden = true; bar.innerHTML = ""; return; }
    var total = items.reduce(function (t, it) { return t + (it.amt || 0); }, 0);
    var monthlyN = items.filter(function (it) { return it.cadence === "monthly"; }).length;
    var annualN = items.filter(function (it) { return it.cadence === "annual"; }).length;
    var oneN = items.length - monthlyN - annualN;
    var split = [];
    if (monthlyN) split.push(monthlyN + " monthly");
    if (annualN) split.push(annualN + " annual");
    if (oneN) split.push(oneN + " one-time");
    // One reviewable line per receipt, each with a Monthly / Annually / One-time
    // toggle so a month holding a subscription AND a one-off (ZapMail) is billed
    // on the right side and nothing is lumped together. The toggle starts on the
    // receipt's read cadence and the owner sets it from there.
    function cadBtn(rid, val, lab, cur) {
      return '<button type="button" class="rc-cadbtn' + (cur === val ? " on" : "") +
        '" data-cadset="' + esc(rid) + '" data-cad="' + val + '">' + lab + '</button>';
    }
    var lines = items.map(function (it) {
      var toggle = it.receiptId
        ? '<span class="rc-cad">' +
            cadBtn(it.receiptId, "monthly", "Monthly", it.cadence) +
            cadBtn(it.receiptId, "annual", "Annually", it.cadence) +
            cadBtn(it.receiptId, "one_time", "One-time", it.cadence) +
          '</span>'
        : '<span class="rc-cad-note note">pay per use</span>';
      return '<div class="rc-pushrow"><span class="rc-pushrow-l">' + esc(it.label) + '</span>' +
        '<span class="rc-pushrow-a">' + usd(it.amt) + '</span>' + toggle + '</div>';
    }).join("");
    bar.hidden = false;
    bar.innerHTML =
      '<div class="rc-pushbar-in">' +
        '<div class="rc-pushbar-top">' +
          '<span class="rc-pushbar-n">' + items.length + ' receipt' + (items.length > 1 ? "s" : "") +
          ' · <strong>' + usd(total) + '</strong>' + (split.length ? ' · ' + esc(split.join(", ")) : "") +
          ' <span class="note">— staged for your approval, not sent yet</span></span>' +
          '<span class="rc-pushbar-acts">' +
          '<a class="row-mini" id="rcPushClear">Clear</a>' +
          '<button class="btn btn-sm" id="rcPushGo">Stage for approval →</button>' +
          '</span>' +
        '</div>' +
        '<div class="rc-pushlist">' + lines + '</div>' +
      '</div>';
    var go = $("#rcPushGo"); if (go) go.addEventListener("click", pushSelection);
    var cl = $("#rcPushClear"); if (cl) cl.addEventListener("click", clearSelection);
    $$("#rcPushBar [data-cadset]").forEach(function (b) {
      b.addEventListener("click", function () {
        rcCadence[b.dataset.cadset] = b.dataset.cad;
        renderPushBar();
      });
    });
  }
  function setPick(pkey, on) {
    if (on) rcSel[pkey] = true;
    else delete rcSel[pkey];
    renderPushBar();
  }
  function clearSelection() {
    rcSel = {};
    $$('#view .rc-pick input').forEach(function (cb) { cb.checked = false; });
    renderPushBar();
  }
  /** Mark a cell as staged this session: untick, disable, badge it, drop it from
      the pending selection. Guards against staging the same receipt twice. */
  function markSent(pkey) {
    rcSent[pkey] = true;
    delete rcSel[pkey];
    var cb = $('#view .rc-pick input[data-rcpick="' + pkey + '"]');
    if (!cb) return;
    cb.checked = false; cb.disabled = true;
    var lab = cb.closest && cb.closest(".rc-pick");
    if (lab && !lab.querySelector(".rc-picksent")) {
      lab.classList.add("sent");
      var s = document.createElement("span"); s.className = "rc-picksent"; s.innerHTML = "staged";
      lab.appendChild(s);
    }
  }
  /** After staging, the bar becomes a confirmation: the receipts are on the client's
      account as PENDING and nothing shows on app.lumesp until the owner approves
      them. One click from here opens that account's approval panel. */
  function showStagedBar(wsId, wsName, okCount, failCount) {
    var bar = $("#rcPushBar"); if (!bar) return;
    bar.hidden = false;
    bar.innerHTML =
      '<div class="rc-pushbar-in"><div class="rc-pushbar-top">' +
      '<span class="rc-pushbar-n">' + okCount + ' receipt' + (okCount !== 1 ? "s" : "") +
      ' staged for <strong>' + esc(wsName || "client") + '</strong> · pending your approval' +
      (failCount ? ' · ' + failCount + ' failed' : "") +
      ' <span class="note">— nothing shows on their Spending page until you approve it</span></span>' +
      '<span class="rc-pushbar-acts">' +
      '<a class="row-mini" id="rcStagedDismiss">Dismiss</a>' +
      '<button class="btn btn-sm" id="rcStagedApprove">Review &amp; approve →</button>' +
      '</span></div></div>';
    var ap = $("#rcStagedApprove");
    if (ap) ap.addEventListener("click", function () { if (typeof openAccount === "function") openAccount(wsId); });
    var dm = $("#rcStagedDismiss");
    if (dm) dm.addEventListener("click", function () { bar.hidden = true; bar.innerHTML = ""; });
  }
  /** Stage every picked receipt onto the client's account as PENDING — one after
      another so a stall on one doesn't wedge the rest. Nothing is approved here:
      the owner approves each on the account's Spending panel, so nothing reaches
      app.lumesp without a deliberate sign-off. */
  function pushSelection() {
    var items = resolvePush();
    if (!items.length) return;
    resolveClientWs(function (wsId, wsName) {
      if (!wsId) { toast("No client account found to send to."); return; }
      var go = $("#rcPushGo"); if (go) { go.disabled = true; go.textContent = "Staging…"; }
      var okCount = 0, failCount = 0;
      // Per-cell success tally: a cell is marked staged (and locked) only once every
      // receipt it holds has been staged, so a partial failure leaves it pickable.
      var need = {}, done = {};
      items.forEach(function (it) { need[it.key] = (need[it.key] || 0) + 1; });
      (function next(i) {
        if (i >= items.length) {
          Object.keys(done).forEach(function (k) { if (done[k] === need[k]) markSent(k); });
          renderPushBar();
          if (okCount > 0) showStagedBar(wsId, wsName, okCount, failCount);
          else toast(failCount ? failCount + " could not be staged" : "Nothing to stage");
          return;
        }
        var it = items[i];
        // STAGE ONLY. The charge lands as pending; it is invisible to the client
        // until the owner approves it on the account's Spending panel. No approve
        // call here — that is the deliberate sign-off the owner asked to keep.
        var payload = { workspaceId: wsId, source: "usage", label: it.label, amountUsd: it.amt, cadence: it.cadence || "one_time" };
        if (it.receipt) payload.receipt = it.receipt;
        send("/owner/portal-spend", "POST", payload).then(function (r) {
          var cid = r && r.ok && r.data && r.data.charge && r.data.charge.id;
          if (!cid) { failCount++; next(i + 1); return; }
          okCount++; done[it.key] = (done[it.key] || 0) + 1; next(i + 1);
        }).catch(function () { failCount++; next(i + 1); });
      })(0);
    });
  }

  function receiptMatrix(d) {
    if (!d) return "";
    var m = d.matrix, months = m.months || [];
    var gaps = unrendered(d).length;
    var soft = blurry(d).length;
    var loose = d.vault ? (d.vault.linkable || 0) + (d.vault.duplicates || 0) : 0;
    var html = '<div class="card" style="margin-top:14px"><div class="burn-head"><h3>Month by month</h3>' +
      '<div class="btn-row" style="margin:0">' +
      '<select id="rcMonths" class="rc-months">' +
      [6, 12, 18, 24].map(function (n) { return '<option value="' + n + '"' + (n === rcptMonths ? " selected" : "") + '>Last ' + n + ' months</option>'; }).join("") +
      '</select>' +
      '<button class="btn btn-sm" id="rcHarvest">Pull receipts from the mailbox</button>' +
      '<button class="btn btn-sm" id="rcAttach">Attach an invoice</button>' +
      /* Only when there is something to mend: a receipt whose document is filed but whose
         picture never rendered. Those cells read "no image" with the real invoice sitting
         on disk behind them, and one click puts it back. */
      (gaps ? '<button class="btn btn-sm" id="rcRender">Show ' + gaps + ' missing image' + (gaps > 1 ? 's' : '') + '</button>' : '') +
      /* Pictures drawn by the old renderer, which magnified every invoice on the way out.
         The nightly tick redraws them on its own; this is for the owner looking at a soft
         invoice now. Offered only while any are left. */
      (!gaps && soft ? '<button class="btn btn-sm" id="rcRender">Sharpen ' + soft + ' receipt' + (soft > 1 ? 's' : '') + '</button>' : '') +
      /* A vendor that bills several listings separately (RapidAPI bills five) sends one
         invoice per listing. Until each is tied to the row it paid for they pile up as a
         single "not on the register" block worth hundreds while every row underneath it
         reads "no receipt". Offered only when there is something to split or drop. */
      (loose ? '<button class="btn btn-sm" id="rcRelink">' + esc(looseLabel(d)) + '</button>' : "") +
      /* When a wide sweep has stacked more than one receipt in a cell: keep the best one per
         cell and drop the rest, so the grid reads one receipt per service per month. Only
         shown when there is actually something to trim. */
      (cellExtras(d) ? '<button class="btn btn-sm" id="rcOnePer" title="Keep the best receipt in each service-month cell and remove the extras. Add any real second charge back by hand.">Keep one receipt per cell (removes ' + cellExtras(d) + ')</button>' : "") +
      '</div></div>' +
      '<p class="note" style="margin-top:2px">Every charge the business makes, in one grid: subscriptions, one-time buys, credit top-ups, domains, pay-per-use, and anything that arrived with no line item behind it. Each row says which it is. <strong>View receipt</strong> opens the invoice itself, full size, ready to show an accountant; the month heading opens every receipt for that month in turn. Solid figures are proven by a receipt, faded figures are the register\'s estimate. <strong>Tick</strong> the receipts (or a whole row) you want on the client\'s bill and stage them from the bar at the foot of the grid — each is set Monthly, Annual or One-time and lands on the client\'s account as <strong>pending</strong>. Nothing shows on their app.lumesp Spending page until you approve it.' +
      /* Where the books open. Said out loud so the missing earlier months read as a
         starting point rather than as spend that went unrecorded. */
      (d.registerStart ? ' The books open in ' + esc(monthLabelLong(d.registerStart)) + ': nothing charged before then is reported on this page.' : '') +
      '</p>';

    html += '<div class="otable-wrap rc-wrap"><table class="otable rc-matrix"><thead><tr><th class="rc-svc">Service</th>';
    months.forEach(function (p) {
      var t = (m.monthTotals || []).filter(function (x) { return x.period === p; })[0];
      var n = t ? t.receiptCount : 0;
      html += '<th class="num"><button class="rc-mhead" data-month="' + esc(p) + '"' + (n ? "" : " disabled") +
        ' title="' + esc(n ? "Open all " + n + " receipt" + (n > 1 ? "s" : "") + " for " + monthLabel(p) : "No receipts on file for " + monthLabel(p)) + '">' +
        '<span class="rc-mhead-name">' + esc(monthLabel(p)) + '</span>' +
        '<span class="rc-mhead-sub">' + (n ? n + ' receipt' + (n > 1 ? 's' : '') : 'none on file') + '</span>' +
        '</button></th>';
    });
    html += '<th class="num">Total</th></tr></thead><tbody>';

    /* EVERY line, whatever it is billed as. A one-time buy, a credit top-up, a domain
       renewal and a pay-per-use bill are all money out, so they belong in the same grid
       with a word saying which they are, not in a section of their own. Nothing is hidden
       for having no charge in the window: a line that is quiet says so. */
    (m.rows || []).forEach(function (r, ri) {
      html += '<tr><th class="rc-svc"' + (r.purpose ? ' title="' + esc(r.purpose) + '"' : "") + '><div class="lr-main">' + esc(r.vendor) + ' <span class="rc-kind ' + kindClass(r) + '">' + esc(kindLabel(r)) + '</span></div>' +
        '<div class="lr-sub note">' + esc(r.label) + '</div>' +
        (r.missingCount ? '<div class="lr-sub bad-t">' + r.missingCount + ' month' + (r.missingCount > 1 ? "s" : "") + ' unreceipted</div>' : "") +
        (r.needsAmount ? '<div class="lr-sub bad-t">no price on file</div>' : "") +
        /* EVERY row is actionable, including the two kinds that have no line item behind
           them: a charge that arrived with nothing expecting it, and pay-per-use the usage
           ledger totted up. Those used to show nothing at all, which reads as a dead row
           on a page where every neighbour can be edited.
           They still cannot be "edited", because there is no register line to edit - so
           they are offered the thing that would create one, prefilled from what the grid
           already knows. That is the honest version of Edit here: it does something, and
           what it does is what the row needs. The column is sticky, so the actions stay
           put while the months scroll past. */
        (r.itemId ? acts(r.itemId) : registerAct(r, ri)) +
        sendRowAct(r, ri) +
        /* Clearing a row's paperwork is a different act from deleting the register line,
           so it is its own control and only appears when there is something to clear.
           It counts the receipts the GRID is showing on this row, which includes the ones
           an account fold claims at report time, so the number always matches what is
           drawn above it. */
        rowReceiptAct(r, ri) +
        '</th>';
      (r.cells || []).forEach(function (c) { html += matrixCell(r, c, ri); });
      html += '<td class="num rc-total"><strong>' + usd(r.totalCountedUsd) + '</strong>' +
        (r.totalVerifiedUsd < r.totalCountedUsd ? '<div class="note" style="font-size:11px">' + usd(r.totalVerifiedUsd) + ' proven</div>' : "") +
        '</td></tr>';
    });

    html += '</tbody><tfoot>';
    html += '<tr class="rc-foot"><th class="rc-svc">Month total</th>';
    (m.monthTotals || []).forEach(function (t) {
      html += '<td class="num"><strong>' + usd(t.countedUsd) + '</strong>' +
        (t.deltaUsd != null && Math.abs(t.deltaUsd) >= 1
          ? '<div class="rc-delta ' + (t.deltaUsd > 0 ? "margin-bad" : "margin-good") + '">' + (t.deltaUsd > 0 ? "+" : "") + usd(t.deltaUsd) + '</div>'
          : "") +
        '</td>';
    });
    html += '<td class="num"><strong>' + usd(m.totals.allTimeCountedUsd) + '</strong></td></tr>';
    html += '<tr class="rc-foot"><th class="rc-svc">Running total</th>';
    (m.monthTotals || []).forEach(function (t) { html += '<td class="num">' + usd(t.runningUsd) + '</td>'; });
    html += '<td class="num"></td></tr>';
    html += '<tr class="rc-foot"><th class="rc-svc">Proven by receipt</th>';
    (m.monthTotals || []).forEach(function (t) {
      var cls = t.coveragePct >= 90 ? "margin-good" : t.coveragePct >= 60 ? "margin-mid" : "margin-bad";
      html += '<td class="num"><span class="' + cls + '">' + pct(t.coveragePct) + '</span></td>';
    });
    html += '<td class="num"><span class="' + (m.totals.coveragePct >= 90 ? "margin-good" : "margin-mid") + '">' + pct(m.totals.coveragePct) + '</span></td></tr>';
    return html + '</tfoot></table></div>' +
      '<div class="rc-pushbar" id="rcPushBar" hidden></div></div>';
  }

  /* One month of one service. Every month that has paper behind it carries a labelled
     button, because "click the cell" is not a thing an accountant can be told over the
     phone — a button that says View receipt is. Months with nothing on file carry the
     opposite button, so the gap is one click from being filled. */
  /* What kind of money this line is. Said on the row itself so recurring and one-off can
     live in one table without anyone having to guess which they are looking at. */
  function kindLabel(r) {
    if (r.unregistered) return "Not on the register";
    if (r.ledgerOnly) return "Pay per use";
    if (r.lifetime) return "Paid once";
    if (r.domain) return "Domain";
    if (r.billing === "monthly") return "Monthly";
    if (r.billing === "annual") return "Annual";
    if (r.billing === "one_time") return "One-time";
    if (r.billing === "credit") return "Credit top-up";
    if (r.billing === "metered") return "Pay per use";
    return r.billing || "";
  }
  /* How many receipts would go if every cell were trimmed to one: the sum, over every cell
     that holds more than one, of the copies past the first. Zero hides the button. */
  function cellExtras(d) {
    var n = 0;
    ((d && d.matrix && d.matrix.rows) || []).forEach(function (row) {
      (row.cells || []).forEach(function (c) {
        if (c.receipts && c.receipts.length > 1) n += c.receipts.length - 1;
      });
    });
    return n;
  }

  /* The button says what it is about to do, in the numbers it found. */
  function looseLabel(d) {
    var v = d.vault || {}, bits = [];
    if (v.linkable) bits.push("Split " + v.linkable + " charge" + (v.linkable > 1 ? "s" : "") + " onto their own lines");
    if (v.duplicates) bits.push((bits.length ? "drop " : "Drop ") + v.duplicates + " duplicate" + (v.duplicates > 1 ? "s" : ""));
    return bits.join(" and ");
  }

  function kindClass(r) {
    if (r.unregistered) return "k-loose";
    if (r.lifetime) return "k-once";
    if (r.billing === "monthly" || r.billing === "annual") return "k-recur";
    if (r.billing === "metered" || r.ledgerOnly) return "k-use";
    return "k-once";
  }

  /**
   * What a row with no register line behind it can do.
   *
   * "Edit" is meaningless without a line item, so the offer is the one that fixes that:
   * put this vendor ON the register, prefilled from what the grid already knows about it.
   * A charge that arrived unexpected and a pay-per-use total both want the same thing.
   */
  function registerAct(r, ri) {
    /* A row with nothing visible in it still has to be clearable. GoDaddy drew an empty
       row off four receipts dated outside the months the grid covers, so there was
       nothing on screen to delete and no line item to remove: the row could not be got
       rid of at all. "Clear this vendor" goes at it by NAME on the server, which is the
       only handle that reaches a receipt the browser was never sent. */
    return '<div class="row-acts"><a class="row-mini" data-badd="' + ri + '">Add to the register</a>' +
      '<a class="row-mini danger" data-vdel="' + esc(r.vendor) + '">Clear this vendor</a></div>';
  }

  /** Every receipt this row is showing, across all its months, in grid order. */
  function rowReceipts(r) {
    var out = [];
    (r.cells || []).forEach(function (c) { (c.receipts || []).forEach(function (x) { out.push(x); }); });
    return out;
  }

  /** "Delete N receipts" on a row, shown only when the row actually has some. */
  function rowReceiptAct(r, ri) {
    var n = rowReceipts(r).length;
    if (!n) return "";
    return '<div class="row-acts"><a class="row-mini danger" data-rowdel="' + ri + '">Delete ' +
      n + ' receipt' + (n > 1 ? 's' : '') + '</a></div>';
  }

  function matrixCell(row, c, ri) {
    var cls = "rc-cell rc-" + c.status;
    var key = ri + "|" + c.period;
    var attr = ' data-cell="' + esc(key) + '"';
    var inner;
    if (c.receipts && c.receipts.length) {
      var r = c.receipts[0];
      var many = c.receipts.length > 1;
      inner = '<div class="rc-amt">' + usd(c.actualUsd) + '</div>' +
        (r.hasShot
          ? '<img class="rc-thumb" src="' + shotUrl(r, "thumb") + '" alt="receipt" loading="lazy" />'
          : r.source === "api"
            ? '<div class="rc-noshot">figure from the vendor API</div>'
            : '<div class="rc-noshot">no image</div>') +
        '<button class="rc-view" data-view="' + esc(key) + '" title="' + esc("Open the " + monthLabel(c.period) + " receipt for " + row.vendor) + '">' +
        (many ? "View " + c.receipts.length + " receipts" : "View receipt") + '</button>' +
        (c.note ? '<div class="note" style="font-size:10.5px">' + esc(c.note) + '</div>' : "");
    } else if (c.status === "missing") {
      inner = '<div class="rc-amt est">' + usd(c.expectedUsd) + '</div><div class="rc-gap">no receipt</div>' +
        '<button class="rc-view ghost" data-attach="' + esc(key) + '">Attach one</button>';
    } else if (c.status === "pending") {
      inner = '<div class="rc-amt est">' + usd(c.expectedUsd) + '</div><div class="note" style="font-size:10.5px">due</div>';
    } else if (c.status === "metered") {
      inner = '<div class="rc-amt">' + usd(c.countedUsd) + '</div><div class="note" style="font-size:10.5px">metered</div>';
    } else if (c.status === "paused") {
      /* An empty cell on a live monthly line reads as a gap to chase. This one is not:
         the vendor stopped charging, and the note says when it starts again. */
      inner = '<div class="rc-gap">paused</div>' +
        (c.note ? '<div class="note" style="font-size:10.5px">' + esc(c.note) + '</div>' : "");
    } else if (c.status === "waived") {
      /* The owner cleared this month by hand. Shown as a quiet dash, not the estimate and
         not a "no receipt" gap: nothing is owed here and nothing is missing. Still a cell,
         so a click reopens it and offers to restore the estimate. */
      inner = '<div class="rc-dash" title="marked as no charge">—</div>';
    } else {
      inner = '<div class="rc-dash">·</div>';
    }
    /* Per-cell control, VISIBLE on every cell that shows something and styled like the
       other cell buttons ("Attach one", "View receipt") so it is actually found: a labelled
       Clear empties the month to nothing (deleting any receipt in it and marking it no
       charge), and a cleared cell shows Restore to put its estimate back. Only on real
       register lines — a ledger-only or unregistered row has no line to write the waiver to.
       A genuinely empty cell gets nothing, because there is nothing to clear. */
    if (row.itemId && /^\d{4}-\d{2}$/.test(c.period)) {
      var hasReceipt = c.receipts && c.receipts.length;
      if (c.status === "waived") {
        inner += '<button class="rc-view ghost rc-clearbtn" data-restore="' + esc(key) + '" title="' + esc("Restore the estimate for " + monthLabel(c.period)) + '">Restore</button>';
      } else if (!hasReceipt && (c.expectedUsd > 0 || c.status === "paused")) {
        /* Only where there is a phantom ESTIMATE to blank (a "no receipt" or "due" cell). A
           cell backed by a real receipt is deliberately left alone: a charge that actually
           happened is removed only from the receipt itself (View receipt -> Delete), never
           swept away by a cell-level "no charge". This is a single cell, reversible. */
        inner += '<button class="rc-view ghost rc-clearbtn" data-clear="' + esc(key) + '" title="' + esc("No charge for " + monthLabel(c.period) + " — blank this one cell") + '">Clear</button>';
      }
    }
    /* The pick checkbox rides on top of every cell that has real money behind it,
       so an accountant-facing receipt can be ticked and forwarded without leaving
       the grid. It is stopPropagation'd in the wiring so ticking never also opens
       the viewer under it. */
    return '<td class="' + cls + '"' + attr + ' title="' + esc(monthLabel(c.period) + " · " + (CELL_LABEL[c.status] || c.status)) + '">' + cellPick(row, c, ri) + inner + '</td>';
  }

  /* Receipts whose document is on file but whose picture is not. An API figure never had a
     document and is not a gap; a real invoice showing "no image" always is. */
  /* The renderer that drew the pictures now on disk. Anything below it was drawn by an
     older, blurrier one and is worth redrawing from the document, which is still filed.
     Kept in step with SHOT_VERSION in lib/owner/receipts.ts. */
  var SHOT_VERSION = 2;

  function unrendered(d) {
    return (d && d.receipts || []).filter(function (r) {
      return !r.hasShot && r.source !== "api" && (r.fileName || r.fileMime || r.source === "portal");
    });
  }

  /* Has a picture, but not one the current renderer drew. */
  function blurry(d) {
    return (d && d.receipts || []).filter(function (r) {
      return r.hasShot && (r.shotVersion || 0) < SHOT_VERSION && (r.fileName || r.fileMime || r.source === "portal");
    });
  }

  /* The image URL carries the renderer that drew it, so a redrawn receipt is a new URL: the
     artifacts are served with a day of private caching and the browser would otherwise go on
     showing the old blurry one until tomorrow. */
  function shotUrl(r, which) {
    return API + "/owner/receipts/file/" + esc(r.id) + "?v=" + (which || "png") + "&s=" + (r.shotVersion || 0);
  }

  function monthLabel(p) {
    var parts = String(p || "").split("-");
    var names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return (names[Number(parts[1]) - 1] || p) + " " + String(parts[0] || "").slice(2);
  }
  /* Spelled out, for prose rather than a column heading. */
  function monthLabelLong(p) {
    var parts = String(p || "").split("-");
    var names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return (names[Number(parts[1]) - 1] || p) + " " + (parts[0] || "");
  }

  /* How each vendor's receipt is supposed to reach us, and whether it actually does. This
     is the panel that makes next month report itself. */
  function receiptSourcing(d) {
    if (!d) return "";
    var inbox = d.inbox || {};
    var html = '<div class="card" style="margin-top:14px"><div class="burn-head"><h3>Where the receipts come from</h3></div>';

    if (!inbox.configured) {
      html += '<div class="burn-alert" style="margin:10px 0"><div class="ba-title">No billing mailbox is wired up</div>' +
        '<p class="note">Not one vendor here exposes an invoice API, so email is the only channel that works for all of them. Point the console at the mailbox the vendors already send to by setting ' +
        esc((inbox.envKeys || []).join(", ")) + ' on the server, then run the pull. Receipts are read only: nothing is deleted or marked read.</p></div>';
    } else {
      var mb = (inbox.mailboxes || []).map(function (b) {
        return esc(b.user) + ' <span class="note">(' + esc(b.host) + (b.inherited ? ", shared with the resume inbox" : "") + ')</span>';
      }).join(", ");
      /* The mailbox address, the pull clock and the raw error are plumbing: this page gets
         handed to an accountant, who has no use for them and should not be reading a
         private inbox address off it. Folded away, one click from the owner. */
      var sweep = (inbox.sweeps || [])[0];
      html += '<details class="rc-rejects rc-ops"><summary>Collection status</summary><div>';
      html += '<p class="note" style="margin-top:2px">Reading ' + mb + '. ' +
        (inbox.lastSweepAt ? 'Last pull ' + esc(fmtDate(inbox.lastSweepAt)) + '. ' : 'No pull has run yet. ') +
        (sweep
          ? (sweep.ok
            ? 'Scanned ' + sweep.scanned + ' messages back to ' + esc(sweep.since) + ': ' + sweep.imported + ' receipts imported, ' +
              (sweep.documentsLinked ? sweep.documentsLinked + ' of them fetched from a link in the message, ' : '') +
              sweep.duplicates + ' already on file, ' + sweep.shotFailures + ' images failed.'
            : '<span class="bad-t">Last pull failed: ' + esc(sweep.error || "unknown error") + '</span>')
          : "") +
        '</p>';
      /* A receipt found in Spam means that vendor's mail is being filtered, which would
         otherwise read as a month with no charge in it. Worth one line, and worth acting
         on in the mail client rather than here. */
      if (sweep && sweep.byFolder) {
        var junk = 0;
        Object.keys(sweep.byFolder).forEach(function (f) {
          if (/spam|junk|trash|deleted/i.test(f)) junk += sweep.byFolder[f];
        });
        if (junk) {
          html += '<p class="note"><b>' + junk + ' receipt' + (junk === 1 ? '' : 's') +
            ' came out of Spam or Trash.</b> They are filed, but that vendor\'s mail is being ' +
            'filtered or deleted, so mark it as not junk in your mail client or the next one may be missed.</p>';
        }
      }
      /* Charges that are real but are not this company's. A personal mailbox carries
         plenty of them and they are kept out of the books. They are still SHOWN, because
         a vendor genuinely being paid and never registered looks identical from here,
         and that one is worth knowing about. */
      if (sweep && sweep.skippedNotOurs) {
        var os = sweep.otherSpend || [];
        html += '<div class="rc-rejects"><p class="note">' + sweep.skippedNotOurs +
          ' charge' + (sweep.skippedNotOurs === 1 ? ' was' : 's were') + ' not filed, because the sender is not a vendor on your register. ' +
          'If one of these is a real supplier, add it to the register and the next pull will collect it.</p><ul>';
        os.slice(0, 12).forEach(function (r) {
          html += '<li><strong>' + esc(r.vendor) + '</strong> <span class="note">' +
            usd(r.amountUsd) + ' · ' + esc(r.chargedAt) + ' · ' + esc(r.from) + '</span></li>';
        });
        if (os.length > 12) html += '<li><span class="note">and ' + (os.length - 12) + ' more</span></li>';
        html += '</ul></div>';
      }
      /* A message that linked to a document which then failed is a different thing from
         a message that linked to nothing: the vendor IS publishing an invoice and it is
         not being collected, which is fixable and would otherwise be invisible. */
      if (sweep && sweep.documentFailures && sweep.documentFailures.length) {
        html += '<div class="rc-rejects"><p class="note">' + sweep.documentFailures.length +
          ' message' + (sweep.documentFailures.length === 1 ? '' : 's') + ' linked to an invoice that could not be fetched</p><ul>';
        sweep.documentFailures.forEach(function (r) {
          html += '<li><strong>' + esc(r.subject) + '</strong> <span class="note">' + esc(r.from) + ' · ' + esc(r.reason) + '</span></li>';
        });
        html += '</ul></div>';
      }
      if (sweep && sweep.rejects && sweep.rejects.length) {
        html += '<div class="rc-rejects"><p class="note">' + sweep.rejects.length + ' billing-looking messages were not imported</p><ul>';
        sweep.rejects.forEach(function (r) {
          html += '<li><strong>' + esc(r.subject) + '</strong> <span class="note">' + esc(r.from) + ' · ' + esc(r.date) + ' · ' + esc(r.reason) + '</span></li>';
        });
        html += '</ul></div>';
      }
      if (inbox.harvest && inbox.harvest.running) {
        html += '<p class="note">A pull is running now (started ' + esc(fmtDate(inbox.harvest.startedAt)) + '). Rendering each receipt takes a few seconds, so this page refreshes itself when it finishes.</p>';
      }
      html += '</div></details>';
    }

    html += mailRouting(d);

    var rows = d.sourcing || [];

    /* The browser sessions that fetch the invoices no vendor ever emails. Reported at the
       card level as well as per vendor, because a sweep that has stopped running makes
       every row below it stale at once, and no single row can say that. */
    var pl = d.pullers || {};
    var unset = rows.filter(function (r) { return r.state === "portal_unset"; });
    if (!pl.lastReportAt) {
      html += '<div class="burn-alert" style="margin:10px 0"><div class="ba-title">' +
        (unset.length ? unset.length + ' vendor' + (unset.length === 1 ? '' : 's') + ' have no receipt collector set up' : 'No portal puller has ever reported in') + '</div>' +
        '<p class="note">Some vendors email nothing and expose no billing API, so the only way to hold their receipt is a browser session that signs in once and takes the invoice off their own billing page on the day they charge. None is running. Set each one up with <span class="mono">node receipts.mjs login &lt;vendor&gt;</span> in the spend-ledger tool, then schedule <span class="mono">node receipts.mjs sweep</span> daily so it also re-checks for a few days after each charge, since vendors publish late.</p></div>';
    } else {
      var pAge = Math.floor((Date.now() - Date.parse(pl.lastReportAt)) / 86400000);
      if (pAge > 3) {
        html += '<div class="burn-alert" style="margin:10px 0"><div class="ba-title">The portal pullers stopped reporting ' + pAge + ' days ago</div>' +
          '<p class="note">Every invoice those sessions fetch has gone uncollected since. Check the scheduled run of <span class="mono">node receipts.mjs sweep</span>.</p></div>';
      } else {
        html += '<p class="note" style="margin-top:2px">' + pl.count + ' browser session' + (pl.count === 1 ? '' : 's') +
          ' fetching invoices the vendors never email. Last run ' + esc(fmtDate(pl.lastReportAt)) +
          (unset.length ? '. <b>' + unset.length + ' vendor' + (unset.length === 1 ? ' still needs' : 's still need') + ' one set up.</b>' : '.') + '</p>';
      }
    }

    html += '<div class="otable-wrap"><table class="otable"><thead><tr>' +
      '<th>Vendor</th><th>How the receipt arrives</th><th class="num">On file</th><th>Last</th><th>What is needed</th>' +
      '</tr></thead><tbody>';
    rows.forEach(function (r) {
      var pill = r.state === "api" ? '<span class="pill active">Pulled from the API</span>'
        : r.state === "portal" ? '<span class="pill active">Fetched from the portal</span>'
        : r.state === "auto" ? '<span class="pill active">Automatic</span>'
        : r.state === "manual" ? '<span class="pill needs">By hand</span>'
        : r.state === "portal_unset" ? '<span class="pill dead">No collector</span>'
        : r.state === "unproven" ? '<span class="pill dead">Not arriving</span>'
        : r.state === "lifetime" ? '<span class="pill active">Paid once</span>'
        : '<span class="pill unknown">Not billed</span>';
      var pu = r.puller;
      html += '<tr><td><div class="lr-main">' + esc(r.vendor) + '</div>' + pill + '</td>' +
        '<td><div class="lr-sub">' + esc(r.state === "lifetime" ? "Nothing recurring to receipt" : channelLabel(r.channel)) + '</div>' +
        (r.from && r.from.length ? '<div class="note" style="font-size:11px">from ' + esc(r.from.slice(0, 3).join(", ")) + '</div>' : "") +
        (r.api ? '<div class="note" style="font-size:11px">' + esc(r.api) + '</div>' : "") +
        (pu ? '<div class="note" style="font-size:11px">browser session · ' +
          (pu.lastRunAt ? 'last checked ' + (pu.ranDaysAgo === 0 ? 'today' : pu.ranDaysAgo === 1 ? 'yesterday' : pu.ranDaysAgo + ' days ago') : 'never run') +
          '</div>' : "") + '</td>' +
        '<td class="num">' + (r.emailCount + r.manualCount + (r.apiCount || 0) + (r.portalCount || 0)) +
        (r.manualCount ? ' <span class="note">(' + r.manualCount + ' by hand)</span>' : "") +
        (r.apiCount ? ' <span class="note">(' + r.apiCount + ' via API)</span>' : "") +
        (r.portalCount ? ' <span class="note">(' + r.portalCount + ' from the portal)</span>' : "") + '</td>' +
        '<td>' + esc((r.lastAt || "").slice(0, 10) || "-") + '</td>' +
        '<td><div class="lr-sub">' + esc(r.advice) + '</div>' +
        // Charges the vendor billed but has published no document for yet.
        (pu && pu.missing && pu.missing.length
          ? '<div class="note" style="font-size:11px">' + pu.missing.map(function (m) {
              return esc((m.date || "undated") + (m.amount != null ? " · " + usd(m.amount) : "") + " · " + m.reason);
            }).join("<br />") + '</div>'
          : "") +
        (pu && pu.error ? '<div class="note bad-t" style="font-size:11px">' + esc(pu.error) + '</div>' : "") +
        (r.portal ? '<a class="note" href="' + esc(r.portal) + '" target="_blank" rel="noopener">open the billing page</a>' : "") +
        (r.setup ? '<div class="note" style="font-size:11px">' + esc(r.setup) + '</div>' : "") + '</td></tr>';
    });
    return html + '</tbody></table></div></div>';
  }

  function channelLabel(c) {
    return c === "email_vendor" ? "The vendor emails a receipt"
      : c === "email_processor" ? "A payment processor emails it (Stripe / Paddle / PayPal)"
      : c === "portal_only" ? "No email at all: a browser session takes it off the portal"
      : c === "api" ? "Pulled from the vendor's billing API every night" : "Email";
  }

  /* EVERY receipt on file, newest month first. The matrix answers "what did this service
     cost in June"; this answers "show me everything we have paid for, and let me look at
     the paper". It refreshes itself so a pull running in the background fills it in
     without anyone reloading the page. */
  function receiptGallery(d) {
    if (!d) return "";
    var all = (d.receipts || []).slice().sort(function (a, b) {
      return (b.period || "").localeCompare(a.period || "") || (b.chargedAt || "").localeCompare(a.chargedAt || "");
    });
    var html = '<div class="card" style="margin-top:14px" id="rcGalleryCard">' +
      '<div class="burn-head"><h3>Every receipt</h3>' +
      '<div class="btn-row" style="margin:0">' +
      '<label class="rc-live"><input type="checkbox" id="rcLive"' + (rcptLive ? " checked" : "") + ' /> Keep it live</label>' +
      '<button class="btn btn-sm" id="rcRefresh">Refresh</button></div></div>' +
      '<div id="rcGalleryBody">' + galleryBody(all) + '</div></div>';
    return html;
  }

  function galleryBody(all) {
    if (!all.length) {
      return '<p class="note">No receipts on file yet. Pull them from the mailbox above, or attach one by hand.</p>';
    }
    var months = [];
    var byMonth = {};
    all.forEach(function (r) {
      var p = r.period || (r.chargedAt || "").slice(0, 7) || "unknown";
      if (!byMonth[p]) { byMonth[p] = []; months.push(p); }
      byMonth[p].push(r);
    });
    var html = '';
    months.forEach(function (p) {
      var rows = byMonth[p];
      var total = rows.reduce(function (s2, r) { return s2 + (Number(r.amountUsd) || 0); }, 0);
      html += '<div class="rc-month"><div class="rc-month-head"><span class="rc-month-name">' + esc(monthLabel(p)) + '</span>' +
        '<span class="rc-month-sum">' + usd(total) + ' · ' + rows.length + ' receipt' + (rows.length > 1 ? 's' : '') + '</span></div>' +
        '<div class="rc-tiles">';
      rows.forEach(function (r) { html += receiptTile(r); });
      html += '</div></div>';
    });
    return html;
  }

  function receiptTile(r) {
    var badge = r.source === "api" ? '<span class="rc-badge api">API</span>'
      : r.source === "manual" ? '<span class="rc-badge manual">By hand</span>'
      /* A portal pull is not an email, and saying "Email" on it sends anyone looking for
         the original to a mailbox that never had it. */
      : r.source === "portal" ? '<span class="rc-badge portal">Portal</span>'
      : '<span class="rc-badge email">Email</span>';
    var art = r.hasShot
      ? '<img class="rc-tile-shot" src="' + shotUrl(r, "thumb") + '" alt="receipt" loading="lazy" />'
      : '<div class="rc-tile-shot rc-tile-none">' + (r.source === "api" ? "figure from the vendor API" : "no image") + '</div>';
    return '<button class="rc-tile" data-receipt="' + esc(r.id) + '" data-month="' + esc(r.period || (r.chargedAt || "").slice(0, 7)) + '"' +
      ' title="' + esc((r.subject || r.description || r.vendor) + "") + '">' +
      art +
      '<div class="rc-tile-meta"><div class="rc-tile-top"><span class="rc-tile-vendor">' + esc(r.vendor) + '</span>' + badge + '</div>' +
      '<div class="rc-tile-amt">' + usd(Math.abs(r.amountUsd)) + (r.kind && r.kind !== "charge" ? ' <span class="note">' + esc(r.kind.replace("_", " ")) + '</span>' : '') + '</div>' +
      '<div class="rc-tile-date note">' + esc((r.chargedAt || "").slice(0, 10)) + (r.invoiceNumber ? ' · ' + esc(String(r.invoiceNumber).slice(0, 14)) : '') + '</div>' +
      '</div></button>';
  }

  function wireReceipts() {
    var sel = $("#rcMonths");
    if (sel) sel.addEventListener("change", function () {
      rcptMonths = Number(sel.value) || 12;
      localStorage.setItem("owner_rcpt_months", String(rcptMonths));
      viewBurn();
    });

    var h = $("#rcHarvest");
    if (h) h.addEventListener("click", function () {
      h.classList.add("disabled");
      send("/owner/receipts", "POST", { action: "harvest", monthsBack: Math.min(24, rcptMonths) }).then(function (r) {
        h.classList.remove("disabled");
        if (!r.ok) { toast("Could not start the pull"); return; }
        if (!r.data.started) { toast(r.data.reason || "Nothing to pull"); return; }
        toast("Reading " + (r.data.mailboxes || []).join(", ") + "…");
        pollHarvest();
      });
    });

    var at = $("#rcAttach");
    if (at) at.addEventListener("click", function () { openAttach(null, null); });

    /* Render the invoices that are already on file. Each one is a headless browser launch,
       so this is tens of seconds, not instant — say so rather than looking hung. */
    /* Split a vendor's charges onto the individual lines they paid for, and drop any copy
       of a charge already on file. Instant: no browser and no mailbox, just the vault read
       against the register. */
    var rl = $("#rcRelink");
    if (rl) rl.addEventListener("click", function () {
      var was = rl.textContent;
      rl.classList.add("disabled");
      rl.textContent = "Sorting…";
      send("/owner/receipts", "POST", { action: "relink" }).then(function (r) {
        rl.classList.remove("disabled");
        rl.textContent = was;
        var v = r.ok && r.data && r.data.vault;
        if (!v) { toast("Could not sort the receipts"); return; }
        var said = [];
        if (v.linked) said.push(v.linked + " charge" + (v.linked > 1 ? "s" : "") + " now on their own line");
        if (v.deduped) said.push(v.deduped + " duplicate" + (v.deduped > 1 ? "s" : "") + " removed");
        toast(said.length ? said.join(" · ") : "Every charge was already on its own line");
        viewBurn();
      });
    });

    /* Trim every service-month cell down to its single best receipt. Destructive across real
       separate charges too (that is the point — the owner tops those back up by hand), so it
       asks first and says exactly how many copies it removed. */
    var op = $("#rcOnePer");
    if (op) op.addEventListener("click", function () {
      if (!confirm("Keep only the best receipt in each service-month cell and remove the rest?\n\nThis clears the extra invoices a wide sweep stacked up, leaving one receipt per cell. Where a month really did have a second charge, add it back by hand afterwards. This cannot be undone (a fresh pull can re-fetch anything that is still in the mailbox).")) return;
      var was = op.textContent;
      op.classList.add("disabled");
      op.textContent = "Trimming…";
      send("/owner/receipts", "POST", { action: "onePerCell" }).then(function (r) {
        op.classList.remove("disabled");
        op.textContent = was;
        var d = r.ok && r.data;
        if (!d) { toast("Could not trim the receipts"); return; }
        toast(d.removed
          ? "Removed " + d.removed + " extra receipt" + (d.removed > 1 ? "s" : "") + " · one kept in each of " + d.cells + " cell" + (d.cells > 1 ? "s" : "")
          : "Every cell already had just one receipt");
        viewBurn();
      });
    });

    var rr = $("#rcRender");
    if (rr) rr.addEventListener("click", function () {
      var was = rr.textContent;
      rr.classList.add("disabled");
      rr.textContent = "Rendering…";
      send("/owner/receipts", "POST", { action: "render" }).then(function (r) {
        rr.classList.remove("disabled");
        rr.textContent = was;
        var s = r.ok && r.data && r.data.shots;
        if (!s) { toast("Could not render the receipts"); return; }
        toast(s.rendered
          ? s.rendered + " receipt" + (s.rendered > 1 ? "s" : "") + " redrawn from the vendor's own document"
          : s.failed ? "Nothing rendered: " + ((s.failures || [])[0] || {}).error : "Every receipt on file already has its image");
        viewBurn();
      });
    });

    /* The whole cell stays clickable — the button is for the people who need to be told
       where to click. Both land in the same place. */
    $$("#view .rc-cell").forEach(function (td) {
      td.addEventListener("click", function () { openCell(td.dataset.cell); });
    });
    $$("#view .rc-view[data-view]").forEach(function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); openCell(b.dataset.view); });
    });
    $$("#view .rc-view[data-attach]").forEach(function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); openCell(b.dataset.attach); });
    });
    /* The per-cell Clear / Restore buttons. They sit ON the cell, so the click must not
       also open the cell popup underneath. */
    $$("#view [data-clear]").forEach(function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); clearCell(b.dataset.clear); });
    });
    $$("#view [data-restore]").forEach(function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); restoreCell(b.dataset.restore); });
    });
    $$("#view .rc-mhead[data-month]").forEach(function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); openMonthReceipts(b.dataset.month); });
    });
    /* Cherry-pick a receipt into the push selection. The checkbox sits ON the cell,
       so any click inside its label (the box, its padding, the "sent" badge) must
       be stopped from bubbling to the cell and opening the viewer underneath. */
    $$("#view .rc-pick").forEach(function (lab) {
      lab.addEventListener("click", function (e) { e.stopPropagation(); });
    });
    $$("#view .rc-pick input").forEach(function (cb) {
      cb.addEventListener("change", function (e) {
        e.stopPropagation();
        setPick(cb.dataset.rcpick, cb.checked);
      });
    });
    /* Select (or, if all are already ticked, clear) every unsent receipt on a row. */
    $$("#view [data-pickrow]").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.stopPropagation();
        var pre = a.dataset.pickrow + "|";
        var boxes = $$("#view .rc-pick input").filter(function (cb) {
          return cb.dataset.rcpick.indexOf(pre) === 0 && !cb.disabled;
        });
        var allOn = boxes.length && boxes.every(function (cb) { return cb.checked; });
        boxes.forEach(function (cb) {
          cb.checked = !allOn;
          setPick(cb.dataset.rcpick, cb.checked);
        });
      });
    });
    /* Rebuild the bar from whatever selection survived this re-render. */
    renderPushBar();
    /* Put a row that has no line item onto the register, prefilled. The amount comes from
       what was actually charged in the window rather than being left at zero, because a
       row created at $0 immediately reports itself as "no price on file" and the person
       has to go and type the number they were just looking at. */
    $$("#view [data-badd]").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.stopPropagation();
        var r = ((rcptData && rcptData.matrix && rcptData.matrix.rows) || [])[Number(a.dataset.badd)];
        if (!r) return;
        var months = (r.cells || []).filter(function (c) { return c.actualUsd > 0; });
        var typical = months.length ? months[months.length - 1].actualUsd : 0;
        send("/owner/burn", "POST", {
          vendor: r.vendor,
          label: r.label || r.vendor,
          category: "infra",
          billing: r.ledgerOnly ? "metered" : "monthly",
          amountUsd: typical,
          purpose: "Added from Month by month, from a charge that had no line on the register."
        }).then(function (res) {
          if (!res.ok) { toast("Could not add that"); return; }
          toast(r.vendor + " added to the register");
          viewBurn();
        });
      });
    });
    /* Send a whole row's spend to the client's Spending page (one click = create +
       approve). stopPropagation so it never doubles as opening a receipt. */
    $$("#view [data-sendrow]").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.stopPropagation();
        if (a.classList.contains("is-busy") || a.classList.contains("sent")) return;
        var r = ((rcptData && rcptData.matrix && rcptData.matrix.rows) || [])[Number(a.dataset.sendrow)];
        if (!r || !(r.totalCountedUsd > 0)) { toast("This row has no cost to send."); return; }
        /* ⚠️ A ROW MUST BE STAGED RECEIPT BY RECEIPT, NOT AS ONE FIGURE. Staging the row
           total sent a single line carrying no invoice at all: all six charges already on
           the client's account read `receipt: no`, so the accountant got numbers with
           nothing behind them, which is the one thing this whole pipeline exists to avoid.
           Each invoice now goes as its own line with its own document, exactly as ticking
           the cells by hand does; only a month with no receipt on file falls back to the
           bare figure, and it says so. */
        stageRow(a, r);
      });
    });
    /* Clear every receipt for a vendor, including any the grid could not show because it
       falls outside the months the books cover. The confirmation says that plainly: this
       reaches further than the row you are looking at, and that is the whole point of it. */
    $$("#view [data-vdel]").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.stopPropagation();
        var v = a.dataset.vdel;
        if (!confirm("Clear every receipt filed against " + v + "?\n\nThis includes any dated outside the months shown here, " +
          "which is usually why a row looks empty. The row goes once nothing is left pointing at it. " +
          "If those emails are still in the mailbox, a later pull can find them again.")) return;
        send("/owner/receipts?vendor=" + encodeURIComponent(v), "DELETE").then(function (res) {
          if (!res.ok) { toast(res.status === 404 ? "Nothing on file for " + v : "Could not clear that"); return; }
          toast((res.data && res.data.deleted) + " receipt(s) cleared from " + v);
          viewBurn();
        });
      });
    });
    /* Clear a whole row's paperwork. stopPropagation because the row header sits next to
       cells that open the viewer, and a delete that also opened something would be read
       as having done nothing. */
    $$("#view [data-rowdel]").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.stopPropagation();
        var r = ((rcptData && rcptData.matrix && rcptData.matrix.rows) || [])[Number(a.dataset.rowdel)];
        if (!r) return;
        var list = rowReceipts(r);
        var total = list.reduce(function (t, x) { return t + Math.abs(x.amountUsd || 0); }, 0);
        deleteReceipts(list.map(function (x) { return x.id; }), r.vendor + " · " + r.label, total);
      });
    });

    $$("#view [data-receipt]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        if (b.dataset.month) openMonthAt(b.dataset.month, b.dataset.receipt);
        else openReceipt(b.dataset.receipt);
      });
    });

    if (rcptData && rcptData.inbox && rcptData.inbox.harvest && rcptData.inbox.harvest.running) pollHarvest();

    var live = $("#rcLive");
    if (live) live.addEventListener("change", function () {
      rcptLive = live.checked;
      localStorage.setItem("owner_rcpt_live", rcptLive ? "1" : "0");
      startLiveRefresh();
    });
    var refresh = $("#rcRefresh");
    if (refresh) refresh.addEventListener("click", function () { refreshReceipts(true); });
    startLiveRefresh();
  }

  /* Keep the gallery current without redrawing the page under someone who is reading it:
     only the tiles and the headline figures are replaced, so scroll position and any open
     drawer survive. Stops on its own when the view is no longer Spend master. */
  function startLiveRefresh() {
    if (rcptLiveTimer) { clearInterval(rcptLiveTimer); rcptLiveTimer = null; }
    if (!rcptLive) return;
    rcptLiveTimer = setInterval(function () {
      if (location.hash.replace("#", "") !== "burn" || !$("#rcGalleryBody")) {
        clearInterval(rcptLiveTimer); rcptLiveTimer = null; return;
      }
      refreshReceipts(false);
    }, 30000);
  }

  function refreshReceipts(loud) {
    return api("/owner/receipts?months=" + rcptMonths).then(function (d) {
      rcptData = d;
      var body = $("#rcGalleryBody");
      if (body) {
        body.innerHTML = galleryBody((d.receipts || []).slice().sort(function (a, b) {
          return (b.period || "").localeCompare(a.period || "") || (b.chargedAt || "").localeCompare(a.chargedAt || "");
        }));
        $$("#rcGalleryBody [data-receipt]").forEach(function (b) {
          b.addEventListener("click", function (e) {
        e.stopPropagation();
        if (b.dataset.month) openMonthAt(b.dataset.month, b.dataset.receipt);
        else openReceipt(b.dataset.receipt);
      });
        });
      }
      if (loud) toast(d.matrix.totals.receiptCount + " receipts on file · " + pct(d.matrix.totals.coveragePct) + " of spend proven");
    }).catch(function () { if (loud) toast("Could not refresh"); });
  }

  /* A pull renders one screenshot per receipt, so it runs detached; poll until it lands. */
  function pollHarvest() {
    if (rcptPoll) clearInterval(rcptPoll);
    rcptPoll = setInterval(function () {
      api("/owner/receipts?months=" + rcptMonths).then(function (d) {
        if (d && d.inbox && d.inbox.harvest && d.inbox.harvest.running) return;
        clearInterval(rcptPoll); rcptPoll = null;
        var s = (d.inbox.sweeps || [])[0];
        toast(s && s.ok ? "Imported " + s.imported + " receipt(s)" : "Pull finished" + (s && s.error ? ": " + s.error : ""));
        if (location.hash.replace("#", "") === "burn") viewBurn();
      }).catch(function () { clearInterval(rcptPoll); rcptPoll = null; });
    }, 6000);
  }

  /* ---------------- the receipt viewer (the popup) ----------------
   *
   * The invoice, full size, in the middle of the screen, with an ✕ that closes it. This is
   * the thing an accountant is shown: it opens over the console, it prints on its own, and
   * it steps through a month's receipts one at a time without going back to the table.
   *
   *   openReceipt(id)          one receipt
   *   openCell(key)            one service in one month (all its receipts, or attach)
   *   openMonthReceipts(p)     every receipt filed to that month, provider by provider
   */

  var rcvList = [];      // receipts currently in the viewer
  var rcvIndex = 0;
  var rcvContext = "";   // what the viewer was opened from, shown under the title

  /** The fullest record we hold for an id: the gallery record if we have it, else the
      matrix's reference, which carries less but is always present for a cell. */
  function receiptById(id) {
    var full = ((rcptData && rcptData.receipts) || []).filter(function (x) { return x.id === id; })[0];
    if (full) return full;
    var refs = [];
    ((rcptData && rcptData.matrix.rows) || []).forEach(function (row) {
      (row.cells || []).forEach(function (c) {
        (c.receipts || []).forEach(function (x) { refs.push(assign({}, x, { vendor: x.vendor || row.vendor, period: x.period || c.period })); });
      });
    });
    ((rcptData && rcptData.matrix.unmatched) || []).forEach(function (u) {
      u.receipts.forEach(function (x) { refs.push(assign({}, x, { vendor: x.vendor || u.vendor })); });
    });
    return refs.filter(function (x) { return x.id === id; })[0] || null;
  }

  function assign(t) {
    for (var i = 1; i < arguments.length; i++) {
      var s = arguments[i] || {};
      for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k) && s[k] !== undefined) t[k] = s[k];
    }
    return t;
  }

  function openReceipt(id) {
    var v = receiptById(id);
    if (!v) return;
    openViewer([v], 0, monthLabel(v.period || (v.chargedAt || "").slice(0, 7)));
  }

  /** A cell of the matrix: one service, one month. */
  function openCell(key) {
    var parts = String(key || "").split("|");
    var row = ((rcptData && rcptData.matrix.rows) || [])[Number(parts[0])];
    var cell = row && (row.cells || []).filter(function (c) { return c.period === parts[1]; })[0];
    if (!row) return;
    if (cell && cell.receipts && cell.receipts.length) {
      openViewer(cell.receipts.map(function (r) { return receiptById(r.id) || r; }), 0, monthLabel(cell.period));
      return;
    }
    /* Nothing on file. Rather than a dead click, say where this month's receipt lives and
       offer the two ways to get it on file. */
    openMissing(row, cell);
  }

  /** Every receipt filed to one month, in vendor order: "show me July". Takes the matrix's
      own cells as well as the gallery list, so a month heading never opens empty over a
      count the matrix itself put there. */
  function monthReceipts(period) {
    var seen = {}, out = [];
    var push = function (r) { if (r && r.id && !seen[r.id]) { seen[r.id] = 1; out.push(r); } };
    ((rcptData && rcptData.receipts) || []).forEach(function (r) {
      if ((r.period || (r.chargedAt || "").slice(0, 7)) === period) push(r);
    });
    ((rcptData && rcptData.matrix && rcptData.matrix.rows) || []).forEach(function (row) {
      (row.cells || []).forEach(function (c) {
        if (c.period !== period) return;
        (c.receipts || []).forEach(function (x) { push(receiptById(x.id) || assign({}, x, { vendor: x.vendor || row.vendor, period: period })); });
      });
    });
    return out.sort(function (a, b) { return String(a.vendor).localeCompare(String(b.vendor)); });
  }

  function openMonthReceipts(period) {
    var all = monthReceipts(period);
    if (!all.length) { toast("No receipts on file for " + monthLabel(period)); return; }
    openViewer(all, 0, monthLabel(period) + " · every receipt");
  }

  /** The month's receipts, opened at the one that was clicked, so the arrows carry on
      through the rest of that month rather than dead-ending on one image. */
  function openMonthAt(period, id) {
    var all = monthReceipts(period);
    var at = -1;
    all.forEach(function (r, i) { if (r.id === id) at = i; });
    if (at < 0) { openReceipt(id); return; }
    openViewer(all, at, monthLabel(period) + " · every receipt");
  }

  function openViewer(list, index, context) {
    rcvList = (list || []).filter(Boolean);
    if (!rcvList.length) return;
    rcvIndex = Math.max(0, Math.min(index || 0, rcvList.length - 1));
    rcvContext = context || "";
    ensureViewer();
    document.body.classList.add("rcv-open");
    $("#rcv").classList.add("show");
    rcvRender();
  }

  function closeViewer() {
    var el = $("#rcv");
    if (el) el.classList.remove("show");
    document.body.classList.remove("rcv-open");
  }

  /* Built once, on first use, so the console's markup does not carry a dialog nobody has
     opened yet. */
  function ensureViewer() {
    if ($("#rcv")) return;
    var el = document.createElement("div");
    el.id = "rcv";
    el.className = "rcv";
    el.innerHTML =
      '<div class="rcv-scrim" data-rcv-close></div>' +
      '<div class="rcv-sheet" role="dialog" aria-modal="true" aria-labelledby="rcvTitle">' +
      '<div class="rcv-head">' +
      '<div class="rcv-title"><h2 id="rcvTitle"></h2><div class="rcv-sub" id="rcvSub"></div></div>' +
      '<div class="rcv-tools">' +
      '<div class="rcv-zoom" id="rcvZoomBox">' +
      '<button class="rcv-nav" id="rcvOut" aria-label="Zoom out" title="Zoom out (−)">−</button>' +
      '<button class="rcv-zlevel" id="rcvZoomLevel" title="Back to the whole page">Fit</button>' +
      '<button class="rcv-nav" id="rcvIn" aria-label="Zoom in" title="Zoom in (+)">+</button></div>' +
      '<div class="rcv-step" id="rcvStep">' +
      '<button class="rcv-nav" id="rcvPrev" aria-label="Previous receipt">‹</button>' +
      '<span id="rcvCount"></span>' +
      '<button class="rcv-nav" id="rcvNext" aria-label="Next receipt">›</button></div>' +
      '<button class="btn btn-ghost btn-sm" id="rcvPrint">Print</button>' +
      '<button class="rcv-x" id="rcvClose" aria-label="Close" title="Close">✕</button>' +
      '</div></div>' +
      '<div class="rcv-body" id="rcvBody"></div></div>';
    document.body.appendChild(el);

    $$("#rcv [data-rcv-close]").forEach(function (n) { n.addEventListener("click", closeViewer); });
    $("#rcvClose").addEventListener("click", closeViewer);
    $("#rcvPrev").addEventListener("click", function () { rcvStep(-1); });
    $("#rcvNext").addEventListener("click", function () { rcvStep(1); });
    $("#rcvPrint").addEventListener("click", function () { window.print(); });
    $("#rcvIn").addEventListener("click", function () { rcvZoomBy(1); });
    $("#rcvOut").addEventListener("click", function () { rcvZoomBy(-1); });
    $("#rcvZoomLevel").addEventListener("click", function () { rcvSetZoom(0); });
    document.addEventListener("keydown", function (e) {
      if (!document.body.classList.contains("rcv-open")) return;
      if (e.key === "Escape") closeViewer();
      else if (e.key === "ArrowLeft") rcvStep(-1);
      else if (e.key === "ArrowRight") rcvStep(1);
      else if (e.key === "+" || e.key === "=") { e.preventDefault(); rcvZoomBy(1); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); rcvZoomBy(-1); }
      else if (e.key === "0") { e.preventDefault(); rcvSetZoom(0); }
    });
    /* Fit is a measurement of the pane, so it has to be taken again when the pane changes. */
    window.addEventListener("resize", function () {
      if (document.body.classList.contains("rcv-open")) rcvApplyZoom(true);
    });
  }

  /* ---------------------------- zooming the invoice ----------------------------
     Step 0 is "fit": as wide as the pane, or the image's own pixels if it is smaller than
     that, so a small receipt is shown at native size rather than blown up to fill a frame
     it was never big enough for. Every other step multiplies the fit width, and the pane
     scrolls. The steps stop at 4x, past which there is no more detail in the file to find. */
  var RCV_STEPS = [0, 1.25, 1.5, 2, 2.5, 3, 4];
  var rcvZoom = 0;

  function rcvShotEl() { return $("#rcvShot"); }

  function rcvFitWidth() {
    var stage = $("#rcvStage"), img = rcvShotEl();
    if (!stage || !img) return 0;
    var cs = window.getComputedStyle(stage);
    var pad = parseFloat(cs.paddingLeft || "0") + parseFloat(cs.paddingRight || "0");
    var pane = Math.max(160, stage.clientWidth - pad);
    /* naturalWidth is 0 until the image has loaded; fall back to the pane so the first paint
       is still the right size and applyZoom runs again on load. */
    var natural = img.naturalWidth || pane;
    return Math.min(pane, natural);
  }

  /**
   * Resize the invoice to the current step.
   *
   * `anchor` is the point of the INVOICE, in fractions of its own width and height, to leave
   * sitting in the middle of the pane afterwards — the line that was being read, or the line
   * that was clicked. Without it (a fresh receipt) the scroll is left alone, so every invoice
   * opens at its top rather than wherever the last one happened to be.
   */
  function rcvApplyZoom(anchor) {
    var stage = $("#rcvStage"), img = rcvShotEl(), box = $("#rcvZoomBox");
    if (box) box.style.display = img ? "" : "none";
    if (!stage || !img) return;
    var fit = rcvFitWidth();
    if (!fit) return;
    var wasW = img.clientWidth || fit, wasH = img.clientHeight || 0;
    var keep = anchor === true
      ? { fx: wasW ? (stage.scrollLeft + stage.clientWidth / 2) / wasW : 0.5,
          fy: wasH ? (stage.scrollTop + stage.clientHeight / 2) / wasH : 0 }
      : (anchor || null);

    img.style.width = Math.round(rcvZoom ? fit * rcvZoom : fit) + "px";
    img.style.maxWidth = "none";
    stage.classList.toggle("zoomed", !!rcvZoom);

    var lvl = $("#rcvZoomLevel");
    if (lvl) lvl.textContent = rcvZoom ? Math.round(rcvZoom * 100) + "%" : "Fit";
    var out = $("#rcvOut"), zin = $("#rcvIn");
    if (out) out.disabled = rcvZoom === 0;
    if (zin) zin.disabled = rcvZoom === RCV_STEPS[RCV_STEPS.length - 1];

    if (!keep) return;
    stage.scrollLeft = Math.max(0, keep.fx * img.clientWidth - stage.clientWidth / 2);
    stage.scrollTop = Math.max(0, keep.fy * img.clientHeight - stage.clientHeight / 2);
  }

  function rcvSetZoom(z, anchor) { rcvZoom = z; rcvApplyZoom(anchor === undefined ? true : anchor); }

  function rcvZoomBy(dir) {
    var i = RCV_STEPS.indexOf(rcvZoom);
    if (i < 0) i = 0;
    rcvSetZoom(RCV_STEPS[Math.max(0, Math.min(RCV_STEPS.length - 1, i + dir))]);
  }

  /* Click the invoice to go straight to a readable size and back again, on the line that was
     clicked: the two-line address block on a Stripe receipt is the whole reason anyone opens
     it, and a zoom that lands somewhere else means hunting for it again. */
  function rcvWireShot() {
    var img = rcvShotEl();
    var box = $("#rcvZoomBox");
    if (box) box.style.display = img ? "" : "none";
    if (!img) return;
    img.addEventListener("click", function (e) {
      if (rcvZoom) { rcvSetZoom(0, null); return; }
      var r = img.getBoundingClientRect();
      rcvSetZoom(2, { fx: (e.clientX - r.left) / (r.width || 1), fy: (e.clientY - r.top) / (r.height || 1) });
    });
    if (img.complete) rcvApplyZoom(null);
    else img.addEventListener("load", function () { rcvApplyZoom(null); });
  }

  function rcvStep(d) {
    if (rcvList.length < 2) return;
    rcvIndex = (rcvIndex + d + rcvList.length) % rcvList.length;
    rcvRender();
  }

  function rcvRender() {
    var v = rcvList[rcvIndex];
    if (!v) return;
    var many = rcvList.length > 1;
    $("#rcvTitle").textContent = v.vendor || "Receipt";
    $("#rcvSub").textContent = [rcvContext, v.subject || v.description || ""].filter(Boolean).join(" · ");
    $("#rcvStep").style.display = many ? "" : "none";
    $("#rcvCount").textContent = many ? (rcvIndex + 1) + " of " + rcvList.length : "";

    var period = v.period || (v.chargedAt || "").slice(0, 7);
    var html = '<div class="rcv-facts">' +
      fact("Amount", usd(Math.abs(v.amountUsd)) + (v.kind && v.kind !== "charge" ? " " + esc(String(v.kind).replace("_", " ")) : "")) +
      fact("Charged", esc((v.chargedAt || "").slice(0, 10) || "not stated")) +
      fact("Counted in", esc(period ? monthLabel(period) : "not stated")) +
      (v.invoiceNumber ? fact("Invoice #", esc(String(v.invoiceNumber))) : "") +
      (v.currency && v.currency !== "USD" ? fact("Invoiced in", esc(v.nativeAmount + " " + v.currency)) : "") +
      fact("Source", esc(v.source === "email" ? "Emailed by the vendor" : v.source === "api" ? "Vendor billing API" : "Attached by hand")) +
      '</div>';

    if (v.hasShot) {
      /* The invoice fills the width of the sheet and the pane scrolls, rather than the whole
         page being squeezed into whatever height was left over: an invoice shrunk to fit is
         an invoice nobody can read. Zoom goes up from there for the small print. */
      html += '<div class="rcv-stage" id="rcvStage" title="Click the invoice to zoom in">' +
        '<img class="rcv-shot" id="rcvShot" src="' + shotUrl(v) + '" alt="' +
        esc((v.vendor || "") + " receipt") + '" /></div>';
    } else if (v.source === "api") {
      html += apiStatement(v);
    } else {
      html += '<div class="rcv-none"><div class="rcv-none-t">No invoice image on file</div>' +
        '<p class="note">The charge is recorded but the document was never captured. Attach the PDF or a screenshot and it will show here.</p></div>';
    }

    html += '<div class="rcv-foot">';
    if (v.hasShot) {
      html += '<a class="btn btn-ghost btn-sm" href="' + shotUrl(v) + '" target="_blank" rel="noopener">Open the image in a new tab</a>';
    }
    if (v.hasFile) {
      html += '<a class="btn btn-ghost btn-sm" href="' + API + '/owner/receipts/file/' + esc(v.id) + '?v=file" target="_blank" rel="noopener">Download the original ' +
        esc((v.fileMime || "").indexOf("pdf") >= 0 ? "PDF" : "file") + '</a>';
    }
    /* Deleting used to be three clicks down, behind "Correct the details", which is the
       wrong place: correcting a figure and throwing the receipt out are different
       intentions and only one of them is reachable from wanting to look at it. */
    html += '<button class="btn btn-ghost btn-sm" id="rcvEdit">Correct the details</button>' +
      '<button class="btn btn-ghost btn-sm rcv-del" id="rcvDel">Delete this receipt</button>' +
      /* Clearing a whole cell without clearing the row: a vendor-month that collected the
         wrong paperwork should be emptiable on its own, and stepping through six receipts
         pressing Delete six times is not a feature. The cell itself stays and goes back to
         "no receipt", which is the honest state for a month whose proof was thrown out. */
      (many ? '<button class="btn btn-ghost btn-sm rcv-del" id="rcvDelAll">Delete all ' + rcvList.length + ' here</button>' : '') +
      '<button class="btn btn-ghost btn-sm" id="rcvDone">Close</button></div>';

    $("#rcvBody").innerHTML = html;
    $("#rcvBody").scrollTop = 0;
    $("#rcvDone").addEventListener("click", closeViewer);
    $("#rcvEdit").addEventListener("click", function () { closeViewer(); editReceipt(v.id); });
    $("#rcvDel").addEventListener("click", function () {
      deleteReceipts([v.id], v.vendor + " " + usd(Math.abs(v.amountUsd)) + " of " + (v.chargedAt || "").slice(0, 10));
    });
    if ($("#rcvDelAll")) $("#rcvDelAll").addEventListener("click", function () {
      var total = rcvList.reduce(function (t, x) { return t + Math.abs(x.amountUsd || 0); }, 0);
      /* The context is the month heading the viewer was opened under, so the prompt names
         the same cell the person clicked rather than a vendor that may differ per receipt. */
      deleteReceipts(rcvList.map(function (x) { return x.id; }),
        (v.vendor || "this vendor") + (rcvContext ? " · " + rcvContext : ""), total);
    });
    /* Every receipt opens at fit: stepping to the next one keeps the zoom of the last is a
       nice idea until the next invoice is a different shape and opens mid-page. */
    rcvZoom = 0;
    rcvWireShot();
  }

  /**
   * Remove one receipt, or every receipt in a cell or a row.
   *
   * The caller passes the exact ids it is showing, so a click can only ever delete what
   * the person was looking at. The confirmation says WHAT is going and what it is worth,
   * because "delete 6 receipts?" is not enough to check against: the whole risk here is
   * clearing the wrong row, and the money is what makes that obvious.
   *
   * A receipt is not the charge. Deleting it removes the proof, and the register line it
   * belonged to goes back to expecting one, so the month reads as unreceipted rather than
   * as never having happened. Said out loud in the prompt, because it is the thing people
   * get wrong about a books tool.
   */
  function deleteReceipts(ids, what, totalUsd) {
    if (!ids || !ids.length) return;
    var many = ids.length > 1;
    var msg = many
      ? "Delete " + ids.length + " receipts from " + what + (totalUsd ? " (" + usd(totalUsd) + ")" : "") + "?"
      : "Delete the receipt for " + what + "?";
    if (!confirm(msg + "\n\nThe charge stops being proven and the month goes back to asking for a receipt. " +
      "The invoice image is deleted with it. If the email is still in the mailbox, the next pull will find it again.")) return;

    send("/owner/receipts?ids=" + encodeURIComponent(ids.join(",")), "DELETE").then(function (res) {
      if (!res.ok) { toast(res.status === 404 ? "Already gone" : "Could not delete"); return; }
      var n = (res.data && res.data.deleted) || ids.length;
      toast(n === 1 ? "Receipt deleted" : n + " receipts deleted");
      closeViewer();
      closeDrawer();
      viewBurn();
    });
  }

  function fact(k, v) { return '<div class="rcv-fact"><div class="rcv-fact-k">' + esc(k) + '</div><div class="rcv-fact-v">' + v + '</div></div>'; }

  /* Some vendors issue no document at all: the figure comes from their billing API. Rather
     than draw a fake invoice, this states the charge and says plainly where it came from,
     so the page is still something that can be printed and handed over. */
  function apiStatement(v) {
    var period = v.period || (v.chargedAt || "").slice(0, 7);
    return '<div class="rcv-statement">' +
      '<div class="rcv-st-head"><span class="rcv-st-vendor">' + esc(v.vendor || "") + '</span>' +
      '<span class="rcv-st-tag">Billing API statement</span></div>' +
      '<div class="rcv-st-amt">' + usd(Math.abs(v.amountUsd)) + '</div>' +
      '<div class="rcv-st-line">' + esc(v.description || "Usage") + ' · ' + esc(period ? monthLabel(period) : "") + '</div>' +
      '<p class="note rcv-st-note">' + esc(v.vendor || "This vendor") + ' issues no invoice document for this charge. ' +
      'The figure was read from its own billing API, which is authoritative on the amount. Nothing has been drawn to stand in for a receipt. ' +
      'If the accountant needs paper, download the invoice from the vendor portal and attach it here.</p>' +
      '</div>';
  }

  /* A month with nothing on file. Says where that vendor's receipt comes from and offers
     the two ways to close the gap, instead of a click that does nothing. */
  function openMissing(row, cell) {
    var period = (cell && cell.period) || "";
    /* A cell the owner has already cleared by hand. Its estimate is still known (the row
       kept it) so the popup can show what it WOULD be and offer to put it back. */
    var waived = !!(cell && cell.status === "waived");
    /* Whether "no charge this month" can even be offered: it writes to a real register
       line, so a ledger-only or unregistered row (no itemId) has nowhere to record it. */
    var canWaive = !!(row && row.itemId && /^\d{4}-\d{2}$/.test(period));
    ensureViewer();
    rcvList = []; rcvIndex = 0; rcvContext = "";
    document.body.classList.add("rcv-open");
    $("#rcv").classList.add("show");
    $("#rcvTitle").textContent = row.vendor;
    $("#rcvSub").textContent = (period ? monthLabel(period) + " · " : "") + (waived ? "marked as no charge" : "no receipt on file");
    $("#rcvStep").style.display = "none";
    $("#rcvCount").textContent = "";

    /* A waived cell reports $0 expected on purpose, so the figure it WOULD show comes from
       the row's own monthly estimate instead. A live missing cell already carries it. */
    var expected = waived ? (row.monthlyUsd || 0) : (cell ? (cell.expectedUsd || 0) : (row.monthlyUsd || 0));
    var html = '<div class="rcv-facts">' +
      fact(waived ? "Estimate (silenced)" : "Expected", usd(expected)) +
      fact("Month", esc(period ? monthLabel(period) : "not stated")) +
      fact("How it should arrive", esc(channelLabel(row.channel))) +
      '</div>';
    html += waived
      ? '<div class="rcv-none"><div class="rcv-none-t">This month is marked as no charge</div>' +
        '<p class="note">You cleared this cell, so the grid expects nothing here and it does not count as a gap. Restore it to put the ' +
        usd(expected) + ' estimate back, or attach a receipt if a charge did land after all.</p></div>'
      : '<div class="rcv-none"><div class="rcv-none-t">Nothing on file for this month</div>' +
        '<p class="note">This figure is the register\'s estimate, not a proven charge. Pull the mailbox again, download the invoice from the vendor and attach it to ' +
        esc(period ? monthLabel(period) : "the month") + (canWaive ? ', or mark the month as no charge so the estimate stops showing here.' : '.') + '</p></div>';

    html += '<div class="rcv-foot">';
    if (row.portal) html += '<a class="btn btn-ghost btn-sm" href="' + esc(row.portal) + '" target="_blank" rel="noopener">Open the ' + esc(row.vendor) + ' billing page</a>';
    html += '<button class="btn btn-primary btn-sm" id="rcvAttach">Attach the invoice</button>';
    /* The one-cell toggle. Only shown where it can be written and only when there is an
       estimate worth silencing (or a silenced one to restore). */
    if (canWaive && (waived || expected > 0)) {
      html += waived
        ? '<button class="btn btn-ghost btn-sm" id="rcvWaive">Restore the estimate</button>'
        : '<button class="btn btn-ghost btn-sm" id="rcvWaive">No charge this month</button>';
    }
    html += '<button class="btn btn-ghost btn-sm" id="rcvDone">Close</button></div>';

    $("#rcvBody").innerHTML = html;
    $("#rcvBody").scrollTop = 0;
    $("#rcvDone").addEventListener("click", closeViewer);
    $("#rcvAttach").addEventListener("click", function () { closeViewer(); openAttach(row, cell); });
    var wv = $("#rcvWaive");
    if (wv) wv.addEventListener("click", function () { toggleCellCharge(row, period, !waived); });
    /* No picture here, so the zoom control goes away with it. */
    rcvZoom = 0;
    rcvWireShot();
  }

  /* Blank a single month's cell, or put its estimate back. One register line, one month:
     `hide` waives it, and clearing it restores the projected figure. The whole point is
     control over a single cell without touching the row or any other month, so this sends
     exactly the month that was clicked and nothing else. */
  function toggleCellCharge(row, period, hide) {
    if (!row || !row.itemId || !/^\d{4}-\d{2}$/.test(period)) return;
    var payload = { id: row.itemId };
    payload[hide ? "hidePeriod" : "showPeriod"] = period;
    send("/owner/burn", "PATCH", payload).then(function (r) {
      if (!r.ok) { toast(r.status === 404 ? "That line is no longer on file" : "Could not update the cell"); return; }
      toast(hide ? monthLabel(period) + " marked as no charge" : monthLabel(period) + " estimate restored");
      closeViewer();
      viewBurn();
    });
  }

  /* Resolve a "ri|period" cell key to its row + cell, the same way openCell does. */
  function cellFromKey(key) {
    var parts = String(key || "").split("|");
    var row = ((rcptData && rcptData.matrix && rcptData.matrix.rows) || [])[Number(parts[0])];
    var cell = row && (row.cells || []).filter(function (c) { return c.period === parts[1]; })[0];
    return { row: row, cell: cell, period: parts[1] };
  }

  /* Blank ONE cell's estimate — the per-cell Clear on the grid. Deliberately narrow and
     SAFE: it marks just this month as no charge and nothing else. It never deletes a
     receipt and never touches another month, so it can never take a row down; the cell's
     own Restore puts it straight back. (Clear is only offered on estimate/"due" cells that
     have no receipt — removing a real charge is done from the receipt itself.) */
  function clearCell(key) {
    var t = cellFromKey(key), row = t.row, period = t.period;
    if (!row || !row.itemId || !/^\d{4}-\d{2}$/.test(period)) { toast("This cell can't be cleared"); return; }
    toggleCellCharge(row, period, true);
  }

  /* Put a cleared cell's estimate back — the ↺ on a waived cell. */
  function restoreCell(key) {
    var t = cellFromKey(key);
    if (t.row) toggleCellCharge(t.row, t.period, false);
  }

  /* The editor behind the viewer: correcting what the parser read. */
  function editReceipt(id) {
    var v = receiptById(id);
    if (!v) return;

    var html = '<div style="display:flex;justify-content:space-between;align-items:start">' +
      '<div><h2>' + esc(v.vendor || "Receipt") + '</h2><div class="sub">' + esc(v.subject || v.description || "") + '</div></div>' +
      '<a class="btn btn-sm" id="dwClose">✕</a></div>';

    html += '<div class="kv">' +
      kv("Amount", '<strong>' + usd(Math.abs(v.amountUsd)) + '</strong>' + (v.kind && v.kind !== "charge" ? ' <span class="pill needs">' + esc(v.kind.replace("_", " ")) + '</span>' : "")) +
      kv("Charged", esc((v.chargedAt || "").slice(0, 10))) +
      (v.period ? kv("Counted in", esc(monthLabel(v.period))) : "") +
      (v.invoiceNumber ? kv("Invoice / receipt #", esc(v.invoiceNumber)) : "") +
      (v.currency && v.currency !== "USD" ? kv("Invoiced in", esc(v.nativeAmount + " " + v.currency) + ' <span class="note">converted at a fixed rate</span>') : "") +
      (v.from ? kv("Sender", esc(v.from) + (v.processor ? ' <span class="note">via ' + esc(v.processor) + '</span>' : "")) : "") +
      (v.mailbox ? kv("Mailbox", esc(v.mailbox)) : "") +
      kv("How it was matched", '<span class="note">' + esc(v.matchedBy || (v.source === "manual" ? "entered by hand" : "")) + '</span>') +
      kv("Confidence", pct((v.confidence || 0) * 100) + (v.reviewed ? ' <span class="pill active">confirmed</span>' : "")) +
      (v.shotError ? kv("Image", '<span class="bad-t">' + esc(v.shotError) + '</span>') : "") +
      '</div>';

    if (!v.hasShot && v.source === "api") {
      html += '<div class="impact-box"><div class="ib-label">No invoice image</div><p>This figure came straight from the vendor billing API, which is authoritative on the amount but issues no document. Nothing was drawn to stand in for a receipt.</p></div>';
    }
    if (v.hasShot) {
      html += '<a href="' + API + '/owner/receipts/file/' + esc(v.id) + '?v=png" target="_blank" rel="noopener" class="rc-full">' +
        '<img src="' + API + '/owner/receipts/file/' + esc(v.id) + '?v=png" alt="receipt" /></a>';
    }
    if (v.hasFile) {
      html += '<div class="btn-row"><a class="btn btn-sm" href="' + API + '/owner/receipts/file/' + esc(v.id) + '?v=file" target="_blank" rel="noopener">Open the original ' + esc((v.fileMime || "").indexOf("pdf") >= 0 ? "PDF" : "file") + '</a></div>';
    }
    if (v.excerptPreview) html += '<h3 style="margin-top:16px">What the parser read</h3><pre class="rc-excerpt">' + esc(v.excerptPreview) + '</pre>';

    html += '<h3 style="margin-top:18px">Correct it</h3><div class="burn-form">' +
      fld("Vendor", '<input id="rcVendor" value="' + esc(v.vendor || "") + '" />') +
      fld("Amount (USD)", '<input id="rcAmount" type="number" step="0.01" value="' + (v.amountUsd || 0) + '" />') +
      fld("Month", '<input id="rcPeriod" value="' + esc(v.period || "") + '" placeholder="2026-07" />') +
      fld("Charged on", '<input id="rcCharged" type="date" value="' + esc((v.chargedAt || "").slice(0, 10)) + '" />') +
      fld("Line item", itemSelect("rcItem", v.itemId)) +
      '</div><div class="btn-row" style="margin-top:12px">' +
      '<button class="btn btn-primary btn-sm" id="rcSave">Save</button>' +
      '<button class="btn btn-sm" id="rcConfirm">Mark confirmed</button>' +
      '<button class="btn btn-sm btn-danger" id="rcDelete">Remove</button></div>';

    $("#drawerBody").innerHTML = html;
    $("#scrim").classList.add("show"); $("#drawer").classList.add("show");
    $("#dwClose").addEventListener("click", closeDrawer);
    $("#rcSave").addEventListener("click", function () {
      send("/owner/receipts", "PATCH", {
        id: v.id, vendor: $("#rcVendor").value.trim(), amountUsd: Number($("#rcAmount").value),
        period: $("#rcPeriod").value.trim(), chargedAt: $("#rcCharged").value || undefined,
        itemId: $("#rcItem").value || undefined
      }).then(function (r2) {
        if (!r2.ok) { toast("Could not save"); return; }
        toast("Saved"); closeDrawer(); viewBurn();
      });
    });
    /* Both of these used to report success without reading the reply, so a 404 or a
       500 came back as "Confirmed" / "Removed" and the row was still there on the next
       render. The owner hit exactly that: a receipt that said it was gone and was not,
       with no way to tell which had happened. Say what actually occurred. */
    $("#rcConfirm").addEventListener("click", function () {
      send("/owner/receipts", "PATCH", { id: v.id, reviewed: true }).then(function (r2) {
        if (!r2.ok) { toast(r2.status === 404 ? "That receipt is no longer on file" : "Could not confirm"); return; }
        toast("Confirmed"); closeDrawer(); viewBurn();
      });
    });
    // One route for deleting a receipt, so the confirmation, the reply check and the
    // wording cannot drift apart depending on which button was pressed.
    $("#rcDelete").addEventListener("click", function () {
      deleteReceipts([v.id], v.vendor || "this receipt", v.amountUsd);
    });
  }

  function itemSelect(id, sel) {
    var items = (burnData && burnData.items) || [];
    return '<select id="' + id + '"><option value="">Not assigned</option>' +
      items.map(function (i) {
        return '<option value="' + esc(i.id) + '"' + (i.id === sel ? " selected" : "") + '>' + esc(i.vendor + " · " + i.label) + '</option>';
      }).join("") + '</select>';
  }

  /* Hand-attach: the backfill path for a vendor that does not email, or a month the sweep
     could not find. Prefilled from the cell that was clicked so it is two fields and a file. */
  function openAttach(row, cell) {
    var period = (cell && cell.period) || new Date().toISOString().slice(0, 7);
    var amount = cell ? (cell.expectedUsd || cell.actualUsd || "") : "";
    var html = '<div style="display:flex;justify-content:space-between;align-items:start">' +
      '<div><h2>Attach an invoice</h2><div class="sub">' + esc(row ? row.vendor + " · " + row.label : "Any vendor") + '</div></div>' +
      '<a class="btn btn-sm" id="dwClose">✕</a></div>' +
      '<p class="note">Download the invoice or screenshot the receipt, then drop it here. It lands in the month you name and counts towards that month\'s total exactly like an emailed one.</p>' +
      '<div class="burn-form">' +
      fld("Vendor", '<input id="atVendor" value="' + esc(row ? row.vendor : "") + '" />') +
      fld("Line item", itemSelect("atItem", row ? row.itemId : "")) +
      fld("Month", '<input id="atPeriod" value="' + esc(period) + '" placeholder="2026-07" />') +
      fld("Amount (USD)", '<input id="atAmount" type="number" step="0.01" value="' + esc(String(amount)) + '" />') +
      fld("Charged on", '<input id="atCharged" type="date" />') +
      fld("Invoice #", '<input id="atInvoice" />') +
      fld("Receipt file (PDF or image)", '<input id="atFile" type="file" accept="image/*,application/pdf" />') +
      fld("Notes", '<input id="atNotes" placeholder="Downloaded from the vendor portal" />') +
      '</div><div class="btn-row" style="margin-top:12px"><button class="btn btn-primary btn-sm" id="atSave">Attach</button></div>' +
      (row && row.portal ? '<p class="note"><a href="' + esc(row.portal) + '" target="_blank" rel="noopener">Open ' + esc(row.vendor) + '\'s billing page</a> to download it.</p>' : "");

    $("#drawerBody").innerHTML = html;
    $("#scrim").classList.add("show"); $("#drawer").classList.add("show");
    $("#dwClose").addEventListener("click", closeDrawer);
    $("#atSave").addEventListener("click", function () {
      var vendor = $("#atVendor").value.trim();
      var period2 = $("#atPeriod").value.trim();
      var amt = Number($("#atAmount").value);
      if (!vendor) { toast("Vendor is required"); return; }
      if (!/^\d{4}-\d{2}$/.test(period2)) { toast("Month must look like 2026-07"); return; }
      if (!isFinite(amt)) { toast("Enter the amount"); return; }
      var fd = new FormData();
      fd.append("vendor", vendor);
      fd.append("period", period2);
      fd.append("amountUsd", String(amt));
      if ($("#atItem").value) fd.append("itemId", $("#atItem").value);
      if ($("#atCharged").value) fd.append("chargedAt", $("#atCharged").value);
      if ($("#atInvoice").value.trim()) fd.append("invoiceNumber", $("#atInvoice").value.trim());
      if ($("#atNotes").value.trim()) fd.append("notes", $("#atNotes").value.trim());
      var f = $("#atFile").files && $("#atFile").files[0];
      if (f) fd.append("file", f);
      toast("Filing it…");
      fetch(API + "/owner/receipts", { method: "POST", credentials: "include", body: fd })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
        .then(function () { toast("Attached"); closeDrawer(); viewBurn(); })
        .catch(function () { toast("Could not attach that"); });
    });
  }

  /* ---------------- spend item editor (drawer) ---------------- */
  function openSpendItem(id) {
    var i = (burnData && burnData.items || []).filter(function (x) { return x.id === id; })[0];
    /* Reachable from the Month by month grid and the source table as well as the register
       tables, and those are built from a second payload, so an id can name a line this
       page no longer holds. Say so: an Edit that does nothing at all reads as a broken
       page rather than as a row that has moved on. */
    if (!i) { toast("That line is no longer on the register"); return; }
    var L = i.live || {};
    var html = '<div style="display:flex;justify-content:space-between;align-items:start">' +
      '<div><h2>' + esc(i.vendor) + '</h2><div class="sub">' + esc(i.label) + '</div></div>' +
      '<a class="btn btn-sm" id="dwClose">✕</a></div>';

    if (i.impact) html += '<div class="impact-box"><div class="ib-label">How this builds the business</div><p>' + esc(i.impact) + '</p></div>';

    html += '<div class="kv">' +
      kv("Status", stateCell(i)) +
      kv("Signal", '<span class="note">' + esc(L.reason || "") + '</span>') +
      kv("Monthly equivalent", usd(monthlyOf(i)) + (i.lifetime ? ' <span class="note">paid once, nothing recurring</span>' : '')) +
      (i.domain ? kv("Registrar", esc(i.registrar || "unknown")) : "") +
      (i.domain ? kv("Registered", esc((i.registeredAt || "").slice(0, 10) || "unknown")) : "") +
      (i.domain ? kv("Expires", esc((i.expiresAt || "").slice(0, 10) || "unknown")) : "") +
      (i.notes ? kv("Notes", '<span class="note">' + esc(i.notes) + '</span>') : "") +
      (L.lastActivityAt ? kv("Last activity", fmtDate(L.lastActivityAt)) : "") +
      (L.quota ? kv("Plan usage", L.quota.used.toLocaleString("en-US") + " / " + L.quota.limit.toLocaleString("en-US") + " requests" + (L.quota.resetAt ? " · resets " + fmtDate(L.quota.resetAt) : "")) : "") +
      (L.envPresent && L.envPresent.length ? kv("Keys present", esc(L.envPresent.join(", "))) : "") +
      (L.envMissing && L.envMissing.length ? kv("Keys missing", '<span class="bad-t">' + esc(L.envMissing.join(", ")) + '</span>') : "") +
      '</div>';

    if (L.workspaces && L.workspaces.length) {
      html += '<h3 style="margin-top:16px">Connected accounts</h3><div class="kv">';
      L.workspaces.forEach(function (w) {
        html += kv(esc(w.workspaceId), '<span class="pill ' + (w.status === "green" ? "active" : "susp") + '">' + esc(w.status || "unknown") + '</span>' + (w.error ? ' <span class="note">' + esc(w.error) + '</span>' : ""));
      });
      html += '</div>';
    }

    html += '<h3 style="margin-top:18px">Edit</h3><div class="burn-form">' +
      fld("Vendor", '<input id="seVendor" value="' + esc(i.vendor) + '" />') +
      fld("Item", '<input id="seLabel" value="' + esc(i.label) + '" />') +
      fld("Category", select("seCategory", BURN_CATEGORIES, i.category)) +
      fld("Billing", select("seBilling", BURN_BILLING, i.billing)) +
      fld("Amount (USD)", '<input id="seAmount" type="number" min="0" step="0.01" value="' + (i.amountUsd || "") + '" />') +
      fld("Date", '<input id="seAt" type="date" value="' + esc((i.at || "").slice(0, 10)) + '" />') +
      fld("What it buys", '<input id="sePurpose" value="' + esc(i.purpose || "") + '" />') +
      fld("Notes", '<input id="seNotes" value="' + esc(i.notes || "") + '" />') +
      fld("Active", '<select id="seStatus"><option value="active"' + (i.status === "active" ? " selected" : "") + '>Active</option><option value="cancelled"' + (i.status === "cancelled" ? " selected" : "") + '>Cancelled</option></select>') +
      fld("Paid once", '<select id="seLifetime"><option value="0"' + (i.lifetime ? "" : " selected") + '>No, it charges again</option><option value="1"' + (i.lifetime ? " selected" : "") + '>Yes, bought outright: no ongoing fee</option></select>') +
      /* A vendor that has suspended billing is not cancelled and is not late paying. Two
         boxes say so, and emptying them ends the pause. */
      fld("Paused since", '<input id="sePaused" type="month" value="' + esc((i.pausedFrom || "").slice(0, 7)) + '" />') +
      fld("Bills again", '<input id="seResumes" type="date" value="' + esc((i.resumesAt || "").slice(0, 10)) + '" />') +
      (i.domain ? fld("Renewal price (USD)", '<input id="seRenewal" type="number" min="0" step="0.01" value="' + (i.renewalUsd || "") + '" />') : "") +
      (i.domain ? fld("Expires", '<input id="seExpires" type="date" value="' + esc((i.expiresAt || "").slice(0, 10)) + '" />') : "") +
      (i.domain ? fld("Auto-renew", '<select id="seAuto"><option value="">Not set</option><option value="1"' + (i.autoRenew ? " selected" : "") + '>On</option><option value="0"' + (i.autoRenew === false ? " selected" : "") + '>Off</option></select>') : "") +
      '</div>' +
      '<div class="btn-row" style="margin-top:12px"><button class="btn btn-primary btn-sm" id="seSave">Save</button>' +
      '<button class="btn btn-sm btn-danger" id="seDelete">Remove</button></div>';

    $("#drawerBody").innerHTML = html;
    $("#scrim").classList.add("show"); $("#drawer").classList.add("show");
    $("#dwClose").addEventListener("click", closeDrawer);
    $("#seSave").addEventListener("click", function () {
      var auto = $("#seAuto") ? $("#seAuto").value : "";
      send("/owner/burn", "PATCH", {
        id: i.id,
        renewalUsd: $("#seRenewal") ? Number($("#seRenewal").value) || 0 : undefined,
        expiresAt: $("#seExpires") && $("#seExpires").value ? $("#seExpires").value : undefined,
        autoRenew: auto === "" ? undefined : auto === "1",
        vendor: $("#seVendor").value.trim(),
        label: $("#seLabel").value.trim(),
        category: $("#seCategory").value,
        billing: $("#seBilling").value,
        amountUsd: Number($("#seAmount").value) || 0,
        at: $("#seAt").value || i.at,
        purpose: $("#sePurpose").value.trim(),
        notes: $("#seNotes").value.trim(),
        lifetime: $("#seLifetime").value === "1",
        pausedFrom: $("#sePaused") ? $("#sePaused").value : undefined,
        resumesAt: $("#seResumes") ? $("#seResumes").value : undefined,
        status: $("#seStatus").value
      }).then(function (r) {
        if (!r.ok) { toast("Could not save"); return; }
        toast("Saved"); closeDrawer(); viewBurn();
      });
    });
    $("#seDelete").addEventListener("click", function () {
      deleteBurnRows([i.id], burnName(i.id));
    });
  }

  /* ================= SPEND ================= */
  function viewSpend() {
    api("/owner/spend?window=" + win).then(function (s) {
      var html = '<div class="v-head"><h2>Spend</h2><p>Every dollar of cost in the selected window (' + esc(win) + '), sliced by category, provider, operating system, and account.</p></div>';
      html += '<div class="stat-grid">' + stat(usd(s.totalCostUsd), "Total cost · " + esc(win), s.totalCostUsd ? "bad" : "") + stat(s.events, "Cost events") + '</div>';
      html += '<div class="two-col" style="margin-top:18px">' +
        '<div class="card"><h3>By category</h3>' + barsFromObj(s.byCategory) + '</div>' +
        '<div class="card"><h3>By provider</h3>' + barsFromObj(s.bySource) + '</div></div>';
      html += '<div class="card" style="margin-top:14px"><h3>By account</h3>';
      html += '<div class="note" style="margin-bottom:8px">Open an account to select its spend rows and push them to that customer\'s Spending page. Nothing is sent until you approve it, and each row shows whether it is already sent.</div>';
      if (!s.byWorkspace.length) html += '<p class="note">No account has incurred cost in this window.</p>';
      else {
        html += '<table class="otable"><thead><tr><th>Account</th><th class="num">Cost</th><th class="num">Events</th><th></th></tr></thead><tbody>';
        s.byWorkspace.forEach(function (w) {
          html += '<tr class="clickrow" data-id="' + esc(w.workspaceId) + '"><td>' + esc(w.name) + '</td><td class="num">' + usd(w.costUsd) + '</td><td class="num">' + w.events + '</td>' +
            '<td class="num"><a class="btn btn-sm">Push spend →</a></td></tr>';
        });
        html += '</tbody></table>';
      }
      html += '</div>';
      html += '<div id="boostCard" style="margin-top:14px"></div>';
      $("#view").innerHTML = html;
      $$("#view .clickrow").forEach(function (tr) { tr.addEventListener("click", function () { openAccount(tr.dataset.id); }); });
      renderBoostCard();
    }).catch(fail);
  }

  /* Paid phone lookups (JD Sourcing "Boost phones"). Loaded after the spend view
     paints so a slow live plan-quota probe never delays the whole page. */
  function renderBoostCard() {
    var el = $("#boostCard");
    if (!el) return;
    el.innerHTML = '<div class="card"><h3>Boost phones · paid lookups</h3><p class="note">Reading plan balance…</p></div>';
    api("/owner/boost").then(function (b) {
      var t = b.totals || {}, q = b.quota, rows = b.byWorkspace || [];
      var h = '<div class="card"><h3>Boost phones · paid lookups</h3>' +
        '<p class="note">The paid skip-trace rung a recruiter triggers per list in JD Sourcing. Lookups are what the plan is billed for; phones found is what they returned.</p>';

      h += '<div class="stat-grid" style="margin-top:12px">' +
        stat((t.lookups || 0).toLocaleString(), "People looked up") +
        stat((t.found || 0).toLocaleString(), "Phones found") +
        stat(pct(t.hitRatePct || 0), "Hit rate", (t.hitRatePct || 0) >= 25 ? "" : "bad") +
        stat(usd(t.costUsd || 0), "Spent") +
        '</div>';

      // Plan balance: the number that actually ticks down as Boost runs.
      if (q && q.limit != null && q.remaining != null) {
        var used = q.limit - q.remaining;
        var usedPct = q.limit > 0 ? Math.min(100, (used / q.limit) * 100) : 0;
        var col = usedPct >= 90 ? "#c0392b" : usedPct >= 70 ? "#d97706" : "var(--ok)";
        var days = q.resetSec != null ? Math.round((q.resetSec / 86400) * 10) / 10 : null;
        h += '<div style="margin-top:16px"><div class="tl"><span>Plan balance · ' + esc(q.host) + '</span>' +
          '<span class="v">' + q.remaining.toLocaleString() + ' of ' + q.limit.toLocaleString() + ' requests left</span></div>' +
          '<div class="obar" style="margin-top:6px;background:var(--line);border-radius:99px;height:8px;overflow:hidden">' +
          '<div style="width:' + usedPct.toFixed(1) + '%;height:100%;background:' + col + '"></div></div>' +
          '<p class="note" style="margin-top:6px">' + used.toLocaleString() + ' used this cycle' +
          (days != null ? ' · resets in ' + days + ' days' : '') + '. Read live from the provider, cached 30 min.</p></div>';
      } else if (q && q.error) {
        h += '<p class="note" style="margin-top:14px"><b>Plan balance unavailable:</b> ' + esc(q.error) + ' (' + esc(q.host) + ')</p>';
      } else {
        h += '<p class="note" style="margin-top:14px">No account has the skip-trace rung configured, so Boost phones cannot run anywhere. Set it in Setup → JD Sourcing.</p>';
      }

      if (rows.length) {
        h += '<table class="otable" style="margin-top:14px"><thead><tr><th>Account</th><th class="num">Runs</th>' +
          '<th class="num">Lookups</th><th class="num">Found</th><th class="num">Hit rate</th><th class="num">Spend</th></tr></thead><tbody>';
        rows.forEach(function (r) {
          h += '<tr class="clickrow" data-id="' + esc(r.workspaceId) + '"><td>' + esc(r.name) + '</td>' +
            '<td class="num">' + (r.events || 0) + '</td>' +
            '<td class="num">' + (r.lookups || 0).toLocaleString() + '</td>' +
            '<td class="num">' + (r.found || 0).toLocaleString() + '</td>' +
            '<td class="num">' + pct(r.hitRatePct || 0) + '</td>' +
            '<td class="num">' + usd(r.costUsd || 0) + '</td></tr>';
        });
        h += '</tbody></table>';
      } else {
        h += '<p class="note" style="margin-top:14px">No paid lookups yet. Recruiters trigger Boost per list in JD Sourcing after the free enrichment finishes.</p>';
      }

      h += '</div>';
      el.innerHTML = h;
      $$("#boostCard .clickrow").forEach(function (tr) { tr.addEventListener("click", function () { openAccount(tr.dataset.id); }); });
    }).catch(function () {
      el.innerHTML = '<div class="card"><h3>Boost phones · paid lookups</h3><p class="note">Could not load paid-lookup usage.</p></div>';
    });
  }

  /* ================= ACCOUNTS ================= */
  function viewAccounts() {
    api("/owner/accounts?window=" + win).then(function (r) {
      var accts = r.accounts || [];
      var html = '<div class="v-head"><h2>Accounts</h2><p>Every account on the platform. Click a row for full detail, billing, and hard-reset controls. Cost is for the selected window (' + esc(win) + ').</p></div>';
      html += '<div class="card"><table class="otable"><thead><tr>' +
        '<th>Account</th><th>Members</th><th>Plan</th><th class="num">Price/mo</th><th class="num">Cost</th><th class="num">Margin</th><th>Status</th>' +
        '</tr></thead><tbody>';
      if (!accts.length) html += '<tr><td colspan="7"><p class="note">No accounts yet. They appear here the moment someone signs up.</p></td></tr>';
      accts.forEach(function (a) {
        html += '<tr class="clickrow" data-id="' + esc(a.workspaceId) + '">' +
          '<td><div class="lr-main">' + esc(a.name) + '</div><div class="lr-sub note">' + esc(a.domain || a.members[0] && a.members[0].email || "") + '</div></td>' +
          '<td>' + a.members.length + '</td>' +
          '<td>' + esc(a.plan) + (a.meta && a.meta.tier ? ' <span class="note">(' + esc(a.meta.tier) + ')</span>' : '') + '</td>' +
          '<td class="num">' + usd(a.monthlyPriceUsd) + '</td>' +
          '<td class="num">' + usd(a.costUsd) + '</td>' +
          '<td class="num">' + marginCell(a) + '</td>' +
          '<td>' + (a.suspended ? '<span class="pill susp">Suspended</span>' : '<span class="pill active">Active</span>') + '</td>' +
          '</tr>';
      });
      html += '</tbody></table></div>';
      $("#view").innerHTML = html;
      $$("#view .clickrow").forEach(function (tr) { tr.addEventListener("click", function () { openAccount(tr.dataset.id); }); });
    }).catch(fail);
  }
  function marginCell(a) {
    if (a.atCost) return '<span class="pill atcost">At cost</span>';
    if (!a.monthlyPriceUsd) return '<span class="note">-</span>';
    var c = a.grossMarginPct >= 80 ? "margin-good" : a.grossMarginPct >= 50 ? "margin-mid" : "margin-bad";
    return '<span class="' + c + '">' + pct(a.grossMarginPct) + '</span>';
  }

  /* ---------------- account drawer ---------------- */
  function openAccount(id) {
    $("#drawerBody").innerHTML = '<p>Loading…</p>';
    $("#scrim").classList.add("show"); $("#drawer").classList.add("show");
    api("/owner/accounts/" + id + "?window=" + win).then(function (d) { renderDrawer(d); }).catch(function () { $("#drawerBody").innerHTML = '<p class="note">Could not load this account.</p>'; });
  }
  function closeDrawer() { $("#scrim").classList.remove("show"); $("#drawer").classList.remove("show"); }

  function renderDrawer(d) {
    var a = d.account, m = a.meta || {};
    var html = '<div style="display:flex;justify-content:space-between;align-items:start">' +
      '<div><h2>' + esc(a.name) + '</h2><div class="sub">' + esc(a.domain || "") + ' · ' + esc(a.workspaceId) + '</div></div>' +
      '<a class="btn btn-sm" id="dwClose">✕</a></div>';

    html += '<div class="kv">' +
      kv("Status", a.suspended ? '<span class="pill susp">Suspended</span>' : '<span class="pill active">Active</span>') +
      kv("Plan", esc(a.plan)) +
      kv("Created", fmtDate(a.createdAt)) +
      kv("Last active", a.lastActiveAt ? fmtDate(a.lastActiveAt) : "-") +
      kv("Active sessions", a.activeSessions) +
      kv("Price / mo", usd(a.monthlyPriceUsd)) +
      kv("Cost · " + esc(win), usd(a.costUsd)) +
      kv("Gross margin", a.atCost ? '<span class="pill atcost">At cost · no margin</span>' : a.monthlyPriceUsd ? pct(a.grossMarginPct) + " (" + usd(a.grossProfitUsd) + ")" : "-") +
      (m.lastResetAt ? kv("Last reset", fmtDate(m.lastResetAt)) : "") +
      '</div>';

    // members
    html += '<h3 style="font-size:13px;margin:6px 0">Members (' + a.members.length + ')</h3>';
    html += a.members.map(function (u) {
      return '<div class="list-row"><div><div class="lr-main">' + esc(u.name) + ' <span class="note">' + esc(u.role) + '</span></div><div class="lr-sub mono">' + esc(u.email) + '</div></div>' +
        '<div class="lr-right"><a class="btn btn-sm" data-pwreset="' + esc(u.id) + '">Reset password</a></div></div>';
    }).join("");

    // usage counts
    var c = a.counts || {};
    html += '<h3 style="font-size:13px;margin:16px 0 6px">Data on file</h3><div class="kv">' +
      kv("Prospects", (c.prospects || 0).toLocaleString()) + kv("Campaigns", c.campaigns || 0) +
      kv("LinkedIn accts", c.linkedinAccounts || 0) + kv("Sending domains", c.domains || 0) +
      kv("API keys", c.apiKeys || 0) + kv("Content assets", c.contentAssets || 0) + '</div>';

    // cost by category — each row can be pushed to the client's Spending tab.
    if (a.costByCategory && Object.keys(a.costByCategory).length) {
      var catRows = Object.keys(a.costByCategory).map(function (k) {
        return { label: titleCase(k), amount: a.costByCategory[k] };
      }).sort(function (x, y) { return y.amount - x.amount; });
      html += '<h3 style="font-size:13px;margin:16px 0 6px">Cost by category · ' + esc(win) + '</h3>' +
        '<div class="note" style="margin-bottom:6px">Click <strong>Stage for Spending</strong> on any line to add it to the client\'s pending list below — it does not send until you approve it there. Staged rows lock so you can\'t double-stage; remove one below to clear it (only you can, the accountant can only view and download).</div>' +
        pushCostTable(catRows);
    }

    // billing edit
    // Plan control: "demo" is the walk-around tier every self-serve signup lands
    // on (live feature sets dark). Flipping to any other plan activates the full
    // matrix on the customer's next request; back to demo parks them again.
    var planOpts = ["demo", "trial", "team", "enterprise"].map(function (p) {
      return '<option value="' + p + '"' + (a.plan === p ? " selected" : "") + '>' + p + '</option>';
    }).join("");
    html += '<h3 style="font-size:13px;margin:16px 0 6px">Plan &amp; activation</h3>' +
      (a.plan === "demo"
        ? '<div class="note" style="margin-bottom:8px">This is a <b>demo</b> workspace: sourcing, texting, calling and outreach are switched off. Activate it once you have set the customer up on your end.</div>' +
          '<div class="btn-row" style="margin-bottom:10px"><a class="btn btn-primary btn-sm" id="dwActivate">Activate full platform (team plan)</a></div>'
        : '') +
      '<div class="calc">' + fld("Plan", '<select id="dwPlan">' + planOpts + '</select>') + '</div>';

    html += '<h3 style="font-size:13px;margin:16px 0 6px">Billing</h3>' +
      '<div class="calc">' +
      fld("Monthly price ($)", '<input id="dwPrice" type="number" min="0" step="10" value="' + (a.monthlyPriceUsd || 0) + '">') +
      fld("Tier label", '<input id="dwTier" type="text" value="' + esc(m.tier || "") + '">') +
      '</div>' +
      '<div class="fld" style="margin-top:10px"><label>Notes</label><input id="dwNotes" type="text" value="' + esc(m.notes || "") + '"></div>' +
      '<label class="atcost-row"><input type="checkbox" id="dwAtCost"' + (m.atCost ? " checked" : "") + '> <span><strong>At cost, no margin.</strong> Grant this account the tool at exactly what it costs us. Profit/margin show 0 (never a loss) and MRR counts their cost.</span></label>' +
      '<div class="btn-row"><a class="btn btn-primary btn-sm" id="dwSave">Save billing</a>' +
      '<a class="btn btn-sm" id="dwSuspend">' + (a.suspended ? "Unsuspend" : "Suspend") + '</a>' +
      '<a class="btn btn-sm" id="dwRevoke">Revoke sessions</a></div>';

    // Client portal statement: owner-approved, month-to-month charges pushed to
    // this account's Spending tab on the client portal (app.lumesp.com). The
    // amount is always the month-to-month price above; nothing reaches the
    // customer until you approve it here.
    html += '<h3 style="font-size:13px;margin:16px 0 6px">On their Spending page</h3>' +
      '<div class="note" style="margin-bottom:8px">Everything you have sent to this client\'s <strong>Spending</strong> page, live for their accountant to view and download (CSV/PDF). They cannot change or delete anything, only you can. Remove a row here to clear it off their receipt.</div>' +
      '<div class="btn-row" style="margin-bottom:8px">' +
      '<a class="btn btn-sm" id="dwStageCharge">Stage monthly charge (' + usd(a.monthlyPriceUsd) + '/mo)</a></div>' +
      '<div id="dwCharges">Loading…</div>';

    // API access (reselling): lend house keys to this customer, with terms.
    html += '<style>' +
      '.grant-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid var(--line,var(--surface-2))}' +
      '.grant-tog{display:flex;align-items:center;gap:7px;flex:1;min-width:150px}' +
      '.g-fld{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--muted,var(--text-dim))}' +
      '.g-fld input{width:64px;padding:4px 7px;border-radius:7px;border:1px solid var(--line,#2a2f3a);background:var(--bg,var(--bg));color:var(--text,var(--text-muted));font:inherit}' +
      '</style>' +
      '<h3 style="font-size:13px;margin:16px 0 6px">API access · reselling</h3>' +
      '<div class="note" style="margin-bottom:8px">Lend your house API keys to this customer. When on, they use YOUR key for that tool; set the markup % and/or monthly fee your billing applies.</div>' +
      '<div id="dwGrants">Loading…</div>';

    // recent usage — each event can be pushed to the client's Spending tab.
    if (d.recentUsage && d.recentUsage.length) {
      html += '<h3 style="font-size:13px;margin:16px 0 6px">Recent cost events</h3>' +
        '<div class="note" style="margin-bottom:6px">Click <strong>Stage for Spending</strong> to add any event to the client\'s pending list — it sends only after you approve it below. Remove it below to clear it off their receipt.</div>' +
        '<table class="otable"><tbody>';
      d.recentUsage.slice(0, 12).forEach(function (e) {
        var sub = e.source || e.category || "";
        var label = titleCase(e.type) + (sub ? " · " + titleCase(sub) : "");
        html += '<tr><td>' + esc(e.type) + ' <span class="note">' + esc(sub) + '</span></td>' +
          '<td class="num">' + (e.quantity || 0).toLocaleString() + '</td>' +
          '<td class="num">' + usd(e.costUsd) + '</td>' +
          '<td class="num">' + spendPushBtn(label, e.costUsd) + '</td></tr>';
      });
      html += '</tbody></table>';
    }

    // danger zone
    html += '<div class="danger-zone"><h3>Hard reset</h3>' +
      '<div class="checks">' +
      '<label><input type="checkbox" id="hrPurge"> Purge ALL data (prospects, campaigns, content, sending infra, usage)</label>' +
      '<label><input type="checkbox" id="hrPw"> Reset every member password to a temp value</label>' +
      '<label><input type="checkbox" id="hrSuspend"> Suspend after reset</label>' +
      '<label><input type="checkbox" id="hrSessions" checked> Revoke all sessions</label>' +
      '</div>' +
      '<div class="btn-row"><a class="btn btn-danger btn-sm" id="dwReset">Run hard reset</a>' +
      '<a class="btn btn-danger btn-sm" id="dwDelete">Delete account permanently</a></div>' +
      '<div class="note">Hard reset is irreversible. Delete removes the workspace, its users, and all data.</div>' +
      '<div id="hrResult"></div></div>';

    $("#drawerBody").innerHTML = html;
    wireDrawer(a);
  }
  function kv(k, v) { return '<div class="k">' + esc(k) + '</div><div class="v">' + v + '</div>'; }
  function fmtDate(s) { try { return new Date(s).toLocaleString(); } catch (e) { return s; } }

  function loadGrants(wsId) {
    api("/owner/grants?workspaceId=" + encodeURIComponent(wsId)).then(function (d) {
      var grantable = (d && d.grantable) || [];
      var grants = (d && d.grants) || {};
      var box = $("#dwGrants"); if (!box) return;
      box.innerHTML = grantable.map(function (g) {
        var t = grants[g.id] || {}; var on = !!grants[g.id];
        return '<div class="grant-row" data-gid="' + esc(g.id) + '">' +
          '<label class="grant-tog"><input type="checkbox" class="g-on"' + (on ? " checked" : "") + '> <b>' + esc(g.label) + '</b></label>' +
          '<span class="g-fld">Markup <input type="number" class="g-mk" min="0" step="1" value="' + (t.markupPct != null ? t.markupPct : "") + '">%</span>' +
          '<span class="g-fld">Monthly $<input type="number" class="g-mo" min="0" step="1" value="' + (t.monthlyUsd != null ? t.monthlyUsd : "") + '"></span>' +
          '<a class="btn btn-sm g-save">Save</a></div>';
      }).join("") || '<div class="note">No resellable integrations.</div>';
      $$("#dwGrants .grant-row").forEach(function (row) {
        row.querySelector(".g-save").addEventListener("click", function () {
          var mk = row.querySelector(".g-mk").value, mo = row.querySelector(".g-mo").value;
          send("/owner/grants", "POST", {
            workspaceId: wsId, id: row.dataset.gid, on: row.querySelector(".g-on").checked,
            markupPct: mk === "" ? undefined : Number(mk), monthlyUsd: mo === "" ? undefined : Number(mo)
          }).then(function (r) { if (r.ok) { toast("Saved " + row.dataset.gid); loadGrants(wsId); } else toast("Couldn't save"); });
        });
      });
    }).catch(function () { var box = $("#dwGrants"); if (box) box.innerHTML = '<div class="note">Could not load grants.</div>'; });
  }

  // Reflect what has already been pushed to the client onto every "→ Spending"
  // button, matched by label, so each cost row plainly shows whether it is already
  // sent (pending or live on the receipt) and a second click can't double-send it.
  function annotateSent(charges) {
    var byLabel = {};
    (charges || []).forEach(function (c) {
      var k = (c.label || "").trim().toLowerCase();
      if (byLabel[k] !== "approved") byLabel[k] = c.status; // 'approved' wins over 'pending'
    });
    $$("#drawerBody .push-spend").forEach(function (b) {
      var k = (b.getAttribute("data-label") || "").trim().toLowerCase();
      var st = byLabel[k];
      b.classList.remove("is-busy");
      if (st === "approved") {
        b.setAttribute("data-sent", "live"); b.textContent = "On receipt ✓"; b.style.opacity = "0.6";
      } else if (st === "pending") {
        b.setAttribute("data-sent", "pending"); b.textContent = "Staged · pending"; b.style.opacity = "0.72";
      } else {
        b.removeAttribute("data-sent"); b.textContent = "Stage for Spending"; b.style.opacity = "";
      }
    });
  }

  // Owner-approved client-portal charges for one account. Owner view shows all
  // statuses with Approve / Pull-back / Remove; the client only ever sees the
  // approved rows (served by /api/portal-spend, scoped to their own workspace).
  function loadCharges(wsId) {
    api("/owner/portal-spend?workspaceId=" + encodeURIComponent(wsId)).then(function (d) {
      var charges = (d && d.charges) || [];
      annotateSent(charges); // keep every "→ Spending" button's sent-state in sync
      var box = $("#dwCharges"); if (!box) return;
      if (!charges.length) { box.innerHTML = '<div class="note">No charges staged. Nothing shows on their Spending tab.</div>'; return; }
      var pendingIds = charges.filter(function (c) { return c.status !== "approved"; }).map(function (c) { return c.id; });
      // One-time charges are the folded receipts (e.g. "Zapmail … plus 32 names")
      // that pile up on the statement; offer to clear the whole pile at once. The
      // per-row Remove below still handles a single line.
      var oneTimeIds = charges.filter(function (c) { return c.cadence === "one_time"; }).map(function (c) { return c.id; });
      var cadNote = function (c) { return c.cadence === "one_time" ? "one-time" : c.cadence === "annual" ? "/yr" : "/mo"; };
      // A batch staged from the Month-by-month grid arrives as several pending rows
      // at once; approve — or clear the one-time pile — in one click, not row by row.
      var headBtns = "";
      if (pendingIds.length > 1) headBtns += '<a class="btn btn-primary btn-sm" id="cApproveAll">Approve all ' + pendingIds.length + ' pending &amp; send →</a> ';
      if (oneTimeIds.length > 1) headBtns += '<a class="btn btn-sm btn-danger" id="cRemoveOneTime">Remove all ' + oneTimeIds.length + ' one-time</a>';
      var head = headBtns ? '<div class="btn-row" style="margin-bottom:8px">' + headBtns + '</div>' : "";
      box.innerHTML = head + '<table class="otable"><tbody>' + charges.map(function (c) {
        var live = c.status === "approved";
        var pill = live ? '<span class="pill active">Live on portal</span>' : '<span class="pill susp">Pending</span>';
        return '<tr data-cid="' + esc(c.id) + '" data-live="' + (live ? "1" : "") + '">' +
          '<td>' + esc(c.label) + ' <span class="note">' + cadNote(c) + '</span></td>' +
          '<td class="num">' + usd(c.amountUsd) + '</td>' +
          '<td>' + pill + '</td>' +
          '<td class="num"><a class="btn btn-sm c-toggle">' + (live ? "Pull back" : "Approve & send") + '</a> ' +
          '<a class="btn btn-sm c-del">Remove</a></td></tr>';
      }).join("") + '</tbody></table>';
      var appAll = $("#cApproveAll");
      if (appAll) appAll.addEventListener("click", function () {
        appAll.classList.add("disabled"); appAll.textContent = "Approving…";
        var n = 0;
        (function nextApprove(i) {
          if (i >= pendingIds.length) { toast(n + " approved, live on portal"); loadCharges(wsId); return; }
          send("/owner/portal-spend", "PATCH", { workspaceId: wsId, id: pendingIds[i], action: "approve" })
            .then(function (r) { if (r.ok) n++; nextApprove(i + 1); })
            .catch(function () { nextApprove(i + 1); });
        })(0);
      });
      var rmOne = $("#cRemoveOneTime");
      if (rmOne) rmOne.addEventListener("click", function () {
        if (!confirm("Remove all " + oneTimeIds.length + " one-time charges from this client's Spending page?\n\n" +
          "This deletes them for good. Recurring monthly/annual charges are left in place.")) return;
        rmOne.classList.add("disabled"); rmOne.textContent = "Removing…";
        var n = 0;
        (function nextDel(i) {
          if (i >= oneTimeIds.length) { toast(n + " one-time charge" + (n === 1 ? "" : "s") + " removed"); loadCharges(wsId); return; }
          send("/owner/portal-spend?workspaceId=" + encodeURIComponent(wsId) + "&id=" + encodeURIComponent(oneTimeIds[i]), "DELETE")
            .then(function (r) { if (r.ok) n++; nextDel(i + 1); })
            .catch(function () { nextDel(i + 1); });
        })(0);
      });
      $$("#dwCharges tr[data-cid]").forEach(function (row) {
        var cid = row.dataset.cid, isLive = !!row.dataset.live;
        row.querySelector(".c-toggle").addEventListener("click", function () {
          send("/owner/portal-spend", "PATCH", { workspaceId: wsId, id: cid, action: isLive ? "unapprove" : "approve" })
            .then(function (r) { if (r.ok) { toast(isLive ? "Pulled back off portal" : "Approved, live on portal"); loadCharges(wsId); } else toast("Couldn't update"); });
        });
        row.querySelector(".c-del").addEventListener("click", function () {
          send("/owner/portal-spend?workspaceId=" + encodeURIComponent(wsId) + "&id=" + encodeURIComponent(cid), "DELETE")
            .then(function (r) { if (r.ok) { toast("Removed"); loadCharges(wsId); } else toast("Couldn't remove"); });
        });
      });
    }).catch(function () { var box = $("#dwCharges"); if (box) box.innerHTML = '<div class="note">Could not load charges.</div>'; });
  }

  function wireDrawer(a) {
    var id = a.workspaceId;
    loadGrants(id);
    loadCharges(id);
    $("#dwClose").addEventListener("click", closeDrawer);

    // Push a single usage row (Cost by category / Recent cost events) onto the
    // client's Spending tab as a one-time charge. #drawerBody persists across
    // opens, so bind the delegated handler ONCE and read the current workspace
    // from a data attribute at click time (avoids stacked listeners + stale ids).
    var db = $("#drawerBody");
    db.dataset.wsid = id;
    if (!db.dataset.pushWired) {
      db.dataset.pushWired = "1";
      db.addEventListener("click", function (ev) {
        var btn = ev.target.closest && ev.target.closest(".push-spend");
        if (!btn) return;
        ev.preventDefault();
        var wsid = db.dataset.wsid;
        var label = btn.getAttribute("data-label") || "";
        var amt = Number(btn.getAttribute("data-amt")) || 0;
        // Already on their receipt? Block the double-send (remove it below to re-send).
        var sent = btn.getAttribute("data-sent");
        if (sent) { toast("Already on their Spending. Remove it below to re-send."); return; }
        if (amt <= 0) { toast("This row has no cost to send."); return; }
        if (btn.classList.contains("is-busy")) return;
        btn.classList.add("is-busy"); btn.textContent = "Staging…";
        // Stage only: the charge lands as pending. It shows on the client's
        // Spending page only after the owner approves it in the list below.
        send("/owner/portal-spend", "POST", { workspaceId: wsid, source: "usage", label: label, amountUsd: amt }).then(function (r) {
          var cid = r && r.ok && r.data && r.data.charge && r.data.charge.id;
          if (!cid) {
            toast((r.data && r.data.message) || "Couldn't stage that row");
            btn.classList.remove("is-busy"); btn.textContent = "Stage for Spending";
            return;
          }
          toast("Staged “" + label + "” — approve below to send");
          loadCharges(wsid);
        }).catch(function () {
          toast("Couldn't reach the server");
          btn.classList.remove("is-busy"); btn.textContent = "Stage for Spending";
        });
      });
    }
    var stageBtn = $("#dwStageCharge");
    if (stageBtn) stageBtn.addEventListener("click", function () {
      // Stage only: the monthly charge lands as pending and shows on the client's
      // Spending page only after the owner approves it in the list below.
      send("/owner/portal-spend", "POST", { workspaceId: id, source: "monthly_price" }).then(function (r) {
        var cid = r && r.ok && r.data && r.data.charge && r.data.charge.id;
        if (!cid) { toast((r.data && r.data.message) || "Set a month-to-month price first"); return; }
        toast("Monthly charge staged — approve below to send"); loadCharges(id);
      });
    });
    $("#dwSave").addEventListener("click", function () {
      var planSel = $("#dwPlan");
      send("/owner/accounts/" + id, "PATCH", {
        monthlyPriceUsd: Number($("#dwPrice").value) || 0,
        tier: $("#dwTier").value, notes: $("#dwNotes").value,
        atCost: $("#dwAtCost").checked,
        plan: planSel ? planSel.value : undefined
      }).then(function (res) { if (res.ok) { toast("Billing saved"); openAccount(id); refreshList(); } else toast("Save failed"); });
    });
    var actBtn = $("#dwActivate");
    if (actBtn) actBtn.addEventListener("click", function () {
      send("/owner/accounts/" + id, "PATCH", { plan: "team" }).then(function (res) {
        if (res.ok) { toast("Activated: full platform is live for this customer"); openAccount(id); refreshList(); }
        else toast("Activation failed");
      });
    });
    $("#dwSuspend").addEventListener("click", function () {
      send("/owner/accounts/" + id, "PATCH", { suspended: !a.suspended }).then(function (res) {
        if (res.ok) { toast(a.suspended ? "Unsuspended" : "Suspended"); openAccount(id); refreshList(); }
      });
    });
    $("#dwRevoke").addEventListener("click", function () {
      send("/owner/accounts/" + id + "/reset", "POST", { revokeSessions: true }).then(function (res) {
        if (res.ok) toast("Revoked " + (res.data.sessionsRevoked || 0) + " sessions"); openAccount(id);
      });
    });
    $$("[data-pwreset]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (!confirm("Reset this user's password to a new temp value? They will be signed out.")) return;
        // single-user reset via the account reset with resetPasswords scoped is account-wide;
        // for one user we reuse the account reset and surface the matching temp password.
        send("/owner/accounts/" + id + "/reset", "POST", { resetPasswords: true }).then(function (res) {
          var pw = (res.data.passwordsReset || []).filter(function (p) { return p.userId === b.dataset.pwreset; })[0];
          showResetResult(res.data); if (pw) toast("Temp password: " + pw.tempPassword);
        });
      });
    });
    $("#dwReset").addEventListener("click", function () {
      var opts = {
        purgeData: $("#hrPurge").checked, resetPasswords: $("#hrPw").checked,
        suspend: $("#hrSuspend").checked, revokeSessions: $("#hrSessions").checked
      };
      var scope = [];
      if (opts.purgeData) scope.push("purge ALL data");
      if (opts.resetPasswords) scope.push("reset passwords");
      if (opts.suspend) scope.push("suspend");
      if (!confirm("Hard reset \"" + a.name + "\"?\n\nThis will: " + (scope.join(", ") || "revoke sessions") + ".\nThis cannot be undone.")) return;
      send("/owner/accounts/" + id + "/reset", "POST", opts).then(function (res) {
        if (res.ok) { toast("Hard reset complete"); showResetResult(res.data); refreshList(); } else toast("Reset failed");
      });
    });
    $("#dwDelete").addEventListener("click", function () {
      if (!confirm("PERMANENTLY DELETE \"" + a.name + "\"?\n\nWorkspace, all users, and all data will be erased. This cannot be undone.")) return;
      if (!confirm("Final confirmation: delete " + a.name + "?")) return;
      send("/owner/accounts/" + id, "DELETE").then(function (res) {
        if (res.ok) { toast("Account deleted"); closeDrawer(); refreshList(); } else toast("Delete failed");
      });
    });
  }
  function showResetResult(data) {
    var el = $("#hrResult"); if (!el) return;
    var html = "";
    if (data.purged) html += '<div class="note" style="margin-top:8px">Purged: ' + Object.keys(data.purged).map(function (k) { return data.purged[k] + " " + k; }).join(", ") + '</div>';
    if (data.sessionsRevoked != null) html += '<div class="note">Sessions revoked: ' + data.sessionsRevoked + '</div>';
    if (data.passwordsReset && data.passwordsReset.length) {
      html += '<div class="note" style="margin-top:6px">Temp passwords (shown once):</div>';
      data.passwordsReset.forEach(function (p) { html += '<div class="temp-pw">' + esc(p.email) + ' → ' + esc(p.tempPassword) + '</div>'; });
    }
    el.innerHTML = html;
  }
  function refreshList() { var r = location.hash.replace("#", "").split("?")[0]; if (r === "accounts") viewAccounts(); else if (r === "overview") viewOverview(); }

  /* ================= COST MODEL ================= */
  function viewCosts() {
    api("/owner/costs").then(function (c) {
      var html = '<div class="v-head"><h2>Cost model</h2><p>The real unit cost of everything we do. Tune any number to re-base pricing instantly. Signals are free by design; enrichment is the dominant variable cost.</p></div>';

      // group rates by category
      var byCat = {};
      c.rates.forEach(function (r) { (byCat[r.category] = byCat[r.category] || []).push(r); });
      Object.keys(byCat).forEach(function (cat) {
        html += '<div class="card" style="margin-bottom:14px"><h3 style="text-transform:capitalize">' + esc(cat) + '</h3>';
        byCat[cat].forEach(function (r) {
          html += '<div style="padding:10px 0;border-bottom:1px solid var(--border)"><div class="rate-edit">' +
            '<div><div class="lr-main">' + esc(r.label) + '</div><div class="rate-meta">' + esc(r.note) + '</div></div>' +
            '<input type="number" step="0.0001" min="0" data-rate="' + esc(r.id) + '" value="' + r.unitCostUsd + '" title="' + esc(r.unit) + '">' +
            '</div><div class="note">' + esc(r.unit) + (r.unitCostUsd !== r.default ? ' · default ' + usd(r.default) : '') + '</div></div>';
        });
        html += '</div>';
      });

      // constants
      var k = c.constants;
      html += '<div class="card"><h3>Pricing constants</h3><div class="calc">' +
        fld("Sequence steps / prospect", '<input id="kSteps" type="number" min="1" step="1" value="' + k.sequenceStepsPerProspect + '">') +
        fld("Sends / inbox / month", '<input id="kSends" type="number" min="1" step="50" value="' + k.sendsPerInboxMonth + '">') +
        fld("Inboxes / domain", '<input id="kInbox" type="number" min="1" step="1" value="' + k.inboxesPerDomain + '">') +
        fld("Reply rate", '<input id="kReply" type="number" min="0" max="1" step="0.01" value="' + k.replyRate + '">') +
        fld("Target gross margin", '<input id="kMargin" type="number" min="0" max="0.99" step="0.01" value="' + k.targetGrossMargin + '">') +
        '</div></div>';

      html += '<div class="btn-row" style="margin-top:14px"><a class="btn btn-primary btn-sm" id="saveCosts">Save cost model</a><a class="btn btn-sm" href="#pricing">See pricing impact →</a></div>';
      $("#view").innerHTML = html;
      $("#saveCosts").addEventListener("click", saveCosts);
    }).catch(fail);
  }
  function saveCosts() {
    var rateOverrides = {};
    $$("[data-rate]").forEach(function (i) { rateOverrides[i.dataset.rate] = Number(i.value) || 0; });
    var constants = {
      sequenceStepsPerProspect: Number($("#kSteps").value) || 3,
      sendsPerInboxMonth: Number($("#kSends").value) || 750,
      inboxesPerDomain: Number($("#kInbox").value) || 3,
      replyRate: Number($("#kReply").value) || 0.04,
      targetGrossMargin: Number($("#kMargin").value) || 0.85
    };
    send("/owner/costs", "PATCH", { rateOverrides: rateOverrides, constants: constants }).then(function (res) {
      if (res.ok) toast("Cost model saved"); else toast("Save failed");
    });
  }

  /* ================= PASSWORDS (account vault) ================= */
  /* Every account the platform runs on, in one table: the URL you actually sign in at,
   * the username, and the password. The catalogue ships the services and their real
   * portal URLs already filled in (those are often nothing like the vendor's marketing
   * domain), so the only thing left to type is the credential itself.
   *
   * Passwords are AES-256-GCM encrypted server-side and are NEVER included in the list
   * payload. Reveal is one deliberate request per row, which is what keeps a page load
   * (or a screenshot of it) from spilling the whole vault. */
  var vaultData = null;
  var vaultFilter = { q: "", cat: "" };
  /* Which rows are ticked, by id. Kept outside the render so a search, a category
     change or a reload after a delete does not lose a selection half made. */
  var vaultPicked = {};

  function viewPasswords() {
    api("/owner/vault").then(function (v) {
      vaultData = v;
      renderVault();
    }).catch(fail);
  }

  function renderVault() {
    var v = vaultData, s = v.summary;
    var html = '<div class="v-head"><h2>Passwords</h2><p>Every account RecruitersOS depends on, with the page you actually sign in at. Passwords are encrypted before they are stored and are only ever sent to this page one at a time, when you ask to see one.</p></div>';

    html += '<div class="stat-grid">' +
      stat(s.total, "Accounts tracked") +
      stat(s.withPassword, "Passwords on file", s.withPassword ? "good" : "") +
      stat(s.missing, "Still to fill in", s.missing ? "amber" : "good") +
      stat(s.withUsername, "Usernames on file") +
      '</div>';

    if (!v.key.ready) {
      html += '<div class="card vault-warn" style="margin-top:14px"><h3>No encryption key is set</h3>' +
        '<p class="note">Passwords cannot be saved until the server has a key to encrypt them with. Set <span class="mono">OWNER_VAULT_KEY</span> in <span class="mono">.env.production</span> to any long random string and restart the app. Everything else on this page works meanwhile.</p></div>';
    } else if (!v.key.dedicated) {
      html += '<div class="card" style="margin-top:14px"><h3>Using the session secret as the vault key</h3>' +
        '<p class="note">Passwords are encrypted, but with the same secret that signs sign-in cookies. Set a separate <span class="mono">OWNER_VAULT_KEY</span> so rotating one never breaks the other. Do that before you fill the vault in: changing the key locks whatever was stored under the old one.</p></div>';
    }
    if (s.locked) {
      html += '<div class="card vault-warn" style="margin-top:14px"><h3>' + s.locked + ' password' + (s.locked === 1 ? '' : 's') + ' cannot be read</h3>' +
        '<p class="note">These were encrypted with a different key than the server is using now. Restore the previous <span class="mono">OWNER_VAULT_KEY</span> to get them back, or overwrite each one with the current password.</p></div>';
    }

    html += '<div class="vault-bar">' +
      '<input id="vaultQ" class="vault-search" type="search" placeholder="Search service, URL, username or note" value="' + esc(vaultFilter.q) + '">' +
      '<select id="vaultCat" class="vault-cat"><option value="">All categories</option>' +
      v.categories.map(function (c) { return '<option value="' + esc(c) + '"' + (c === vaultFilter.cat ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join("") +
      '</select>' +
      '<span class="spacer" style="flex:1"></span>' +
      '<a class="btn btn-sm" id="vaultReseed" title="Put back any built-in service that was deleted">Restore defaults</a>' +
      '<a class="btn btn-primary btn-sm" id="vaultAdd">Add account</a>' +
      '</div>';

    html += '<div id="vaultSel" class="vault-sel" hidden></div>';
    html += '<div id="vaultRows"></div>';
    $("#view").innerHTML = html;

    $("#vaultQ").addEventListener("input", function () { vaultFilter.q = this.value; renderVaultRows(); });
    $("#vaultCat").addEventListener("change", function () { vaultFilter.cat = this.value; renderVaultRows(); });
    $("#vaultAdd").addEventListener("click", function () { openVaultDrawer(null); });
    $("#vaultReseed").addEventListener("click", function () {
      send("/owner/vault", "POST", { action: "reseed" }).then(function (res) {
        toast(res.ok ? ((res.data.added || 0) + " restored") : "Could not restore");
        viewPasswords();
      });
    });
    renderVaultRows();
  }

  function vaultMatches(e) {
    if (vaultFilter.cat && e.category !== vaultFilter.cat) return false;
    var q = vaultFilter.q.trim().toLowerCase();
    if (!q) return true;
    return [e.service, e.url, e.username, e.billingEmail, e.account, e.used_for, e.notes, e.envKey]
      .join(" ").toLowerCase().indexOf(q) >= 0;
  }

  function renderVaultRows() {
    var all = vaultData.entries || [];
    var rows = all.filter(vaultMatches);
    if (!rows.length) {
      // Deleting everything is now possible, so "nothing matches that search" would be
      // the wrong sentence when there is simply nothing left.
      $("#vaultRows").innerHTML = '<div class="card"><p class="note">' + (all.length
        ? 'Nothing matches that search.'
        : 'The vault is empty. Add an account, or use Restore defaults to bring the built-in list back.') +
        '</p></div>';
      syncVaultSel();
      return;
    }
    var byCat = {};
    rows.forEach(function (e) { (byCat[e.category] = byCat[e.category] || []).push(e); });

    var html = "";
    Object.keys(byCat).forEach(function (cat) {
      /* Six columns is past what a laptop fits, and without a scrolling container the
         table simply ran off the right edge and took Edit/Delete with it. The wrap keeps
         the overflow inside the card instead of on the page. */
      html += '<div class="card" style="margin-top:14px"><h3>' + esc(cat) + '</h3>' +
        '<div class="otable-wrap"><table class="otable vault-table"><thead><tr>' +
        '<th class="vault-pick"><input type="checkbox" class="vault-box" data-pickall="1" title="Select every account in this group"></th>' +
        '<th>Service</th><th>Sign-in URL</th><th>Username / email</th><th>Password</th><th></th>' +
        '</tr></thead><tbody>';
      byCat[cat].forEach(function (e) {
        html += '<tr data-vid="' + esc(e.id) + '">' +
          '<td class="vault-pick"><input type="checkbox" class="vault-box" data-pick="' + esc(e.id) + '"' +
            (vaultPicked[e.id] ? ' checked' : '') + '></td>' +
          '<td><div class="lr-main">' + esc(e.service) + '</div>' +
            (e.account ? '<div class="vault-sub">' + esc(e.account) + '</div>' : '') +
            (e.vendor && e.vendor !== e.service ? '<div class="vault-sub dim">Billed as ' + esc(e.vendor) + ' on Spend master</div>' : '') +
            (e.used_for ? '<div class="vault-sub dim">' + esc(e.used_for) + '</div>' : '') + '</td>' +
          '<td data-l="Sign-in URL"><a class="vault-link" href="' + esc(e.url) + '" target="_blank" rel="noopener" title="' + esc(e.url) + '">' + esc(prettyUrl(e.url)) + '</a></td>' +
          '<td data-l="Username"><span>' + (e.username
            ? '<span class="mono vault-user">' + esc(e.username) + '</span><div class="vault-acts"><a class="vault-mini" data-copy="' + esc(e.username) + '">Copy</a></div>'
            : '<span class="note" style="margin:0">not set</span>') + vaultBillCell(e) + '</span></td>' +
          '<td class="vault-pw" data-l="Password" data-pwcell="' + esc(e.id) + '">' + vaultPwCell(e) + '</td>' +
          '<td class="num"><a class="vault-mini" data-edit="' + esc(e.id) + '">Edit</a>' +
            '<a class="vault-mini danger" data-del="' + esc(e.id) + '">Delete</a></td>' +
          '</tr>';
      });
      html += '</tbody></table></div></div>';
    });
    $("#vaultRows").innerHTML = html;

    $$("#vaultRows [data-edit]").forEach(function (a) {
      a.addEventListener("click", function () { openVaultDrawer(a.dataset.edit); });
    });
    $$("#vaultRows [data-copy]").forEach(function (a) {
      a.addEventListener("click", function () { copyText(a.dataset.copy, "Username copied"); });
    });
    $$("#vaultRows [data-del]").forEach(function (a) {
      a.addEventListener("click", function () {
        var e = vaultEntry(a.dataset.del);
        deleteVaultRows([a.dataset.del], e ? e.service : "this account");
      });
    });
    $$("#vaultRows [data-pick]").forEach(function (c) {
      c.addEventListener("change", function () { pickVault(c.dataset.pick, c.checked); syncVaultSel(); });
    });
    // Select-all is per category table, because that is the group you can actually see.
    $$("#vaultRows [data-pickall]").forEach(function (c) {
      c.addEventListener("change", function () {
        $$("[data-pick]", c.closest("table")).forEach(function (b) {
          b.checked = c.checked;
          pickVault(b.dataset.pick, c.checked);
        });
        syncVaultSel();
      });
    });
    wireVaultPwCells();
    syncVaultSel();
  }

  function vaultEntry(id) {
    return (vaultData.entries || []).filter(function (x) { return x.id === id; })[0];
  }

  function pickVault(id, on) {
    if (on) vaultPicked[id] = true; else delete vaultPicked[id];
  }

  /* The selection bar only exists while something is selected: an empty toolbar sitting
     above the table would be one more thing to read on a page that is already dense.
     It also prunes ids that are no longer on screen, so a delete cannot leave a phantom
     count behind. */
  function syncVaultSel() {
    var live = {};
    (vaultData.entries || []).forEach(function (e) { if (vaultPicked[e.id]) live[e.id] = true; });
    vaultPicked = live;
    var ids = Object.keys(vaultPicked);
    var bar = $("#vaultSel");
    if (!bar) return;
    if (!ids.length) { bar.hidden = true; bar.innerHTML = ""; return; }
    bar.hidden = false;
    bar.innerHTML = '<span class="vault-sel-n">' + ids.length + ' selected</span>' +
      '<span style="flex:1"></span>' +
      '<a class="vault-mini" id="vaultSelNone">Clear selection</a>' +
      '<a class="btn btn-danger btn-sm" id="vaultSelDel">Delete selected</a>';
    $("#vaultSelNone").addEventListener("click", function () {
      vaultPicked = {};
      $$("#vaultRows input[type=checkbox]").forEach(function (c) { c.checked = false; });
      syncVaultSel();
    });
    $("#vaultSelDel").addEventListener("click", function () {
      deleteVaultRows(ids, ids.length === 1 ? (vaultEntry(ids[0]) || {}).service : ids.length + " accounts");
    });
  }

  /* One confirmation, one request, whether it is a row or forty. */
  function deleteVaultRows(ids, what) {
    if (!ids.length) return;
    if (!confirm("Delete " + (what || "this account") + "?\n\nThe stored password goes with it. A built-in service stays gone until you use Restore defaults.")) return;
    send("/owner/vault?ids=" + encodeURIComponent(ids.join(",")), "DELETE").then(function (res) {
      if (!res.ok) { toast(res.status === 404 ? "Already gone" : "Could not delete"); return; }
      var n = (res.data && res.data.deleted) || ids.length;
      ids.forEach(function (id) { delete vaultPicked[id]; });
      toast(n === 1 ? "Account deleted" : n + " accounts deleted");
      closeDrawer();
      viewPasswords();
    });
  }

  /**
   * The mailbox this vendor sends its receipts to, shown under the sign-in identity
   * rather than in a column of its own: at six columns the table ran off the right edge
   * and took Edit and Delete with it, and the two are the same address on nine tenths of
   * these accounts anyway.
   *
   * So nothing is said when the username already IS that address — repeating it would
   * double the length of the table to state the obvious. A line appears only when the
   * answer is genuinely different, and a prompt only where the account signs in with a
   * handle rather than an address, which is the row that really needs the owner.
   */
  function vaultBillCell(e) {
    var stated = e.billingEmail || "";
    var user = e.username || "";
    if (stated && stated.toLowerCase() !== user.toLowerCase()) {
      return '<div class="vault-sub dim">Receipts arrive at <span class="mono">' + esc(stated) + '</span></div>';
    }
    if (stated || user.indexOf("@") > 0) return "";
    return '<div class="vault-sub"><a class="vault-mini" data-edit="' + esc(e.id) + '">Add the receipt address</a></div>';
  }

  function vaultPwCell(e) {
    if (e.locked) return '<span class="pill susp">Locked</span>';
    if (!e.hasSecret) return '<span class="note" style="margin:0">not set</span>';
    return '<span class="vault-dots">••••••••••</span>' +
      '<div class="vault-acts">' +
      '<a class="vault-mini" data-reveal="' + esc(e.id) + '">Show</a>' +
      '<a class="vault-mini" data-pwcopy="' + esc(e.id) + '">Copy</a></div>';
  }

  function wireVaultPwCells() {
    $$("#vaultRows [data-reveal]").forEach(function (a) {
      a.addEventListener("click", function () { revealPw(a.dataset.reveal); });
    });
    $$("#vaultRows [data-pwcopy]").forEach(function (a) {
      a.addEventListener("click", function () {
        api("/owner/vault?reveal=" + encodeURIComponent(a.dataset.pwcopy))
          .then(function (r) { copyText(r.password, "Password copied"); })
          .catch(function () { toast("Could not read that password"); });
      });
    });
  }

  /* Shown passwords hide themselves again after a minute: an unattended tab should not
   * be left holding a credential in plain sight. */
  function revealPw(id) {
    var cell = $('[data-pwcell="' + id + '"]');
    api("/owner/vault?reveal=" + encodeURIComponent(id)).then(function (r) {
      cell.innerHTML = '<span class="mono vault-shown">' + esc(r.password) + '</span>' +
        '<div class="vault-acts">' +
        '<a class="vault-mini" data-hide="1">Hide</a>' +
        '<a class="vault-mini" data-pwcopy2="1">Copy</a></div>';
      var reset = function () {
        var e = (vaultData.entries || []).filter(function (x) { return x.id === id; })[0];
        if (e) { cell.innerHTML = vaultPwCell(e); wireVaultPwCells(); }
      };
      cell.querySelector("[data-hide]").addEventListener("click", reset);
      cell.querySelector("[data-pwcopy2]").addEventListener("click", function () { copyText(r.password, "Password copied"); });
      setTimeout(reset, 60000);
    }).catch(function () { toast("Could not read that password"); });
  }

  function copyText(t, msg) {
    if (navigator.clipboard) navigator.clipboard.writeText(t).then(function () { toast(msg); }, function () { toast("Copy blocked by the browser"); });
    else toast("Copy blocked by the browser");
  }

  function prettyUrl(u) {
    return String(u || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  }

  /* One account, full detail. Password is write-only here: the field starts empty and an
   * empty field means "leave what is stored alone", so saving a note can never wipe a
   * credential by accident. */
  function openVaultDrawer(id) {
    var e = id ? (vaultData.entries || []).filter(function (x) { return x.id === id; })[0] : null;
    var cats = vaultData.categories.slice();
    if (e && cats.indexOf(e.category) < 0) cats.push(e.category);

    var html = '<div style="display:flex;justify-content:space-between;align-items:start">' +
      '<div><h2>' + esc(e ? e.service : "New account") + '</h2>' +
      '<div class="sub">' + esc(e ? e.category : "Add an account to track") + '</div></div>' +
      '<a class="btn btn-sm" id="vdClose">✕</a></div>';

    html += '<div class="vault-form">';
    html += fld("Service", '<input id="vfService" value="' + esc(e ? e.service : "") + '" placeholder="Vendor or tool name">');
    html += fld("Category", '<select id="vfCat">' + cats.map(function (c) {
      return '<option value="' + esc(c) + '"' + (e && e.category === c ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join("") + '</select>');
    html += fld("Sign-in URL", '<input id="vfUrl" value="' + esc(e ? e.url : "") + '" placeholder="https://…">');
    html += fld("Username / email", '<input id="vfUser" value="' + esc(e ? e.username : "") + '" autocomplete="off">');
    html += fld("Receipts arrive at", '<input id="vfBill" value="' + esc(e && e.billingEmail ? e.billingEmail : "") + '" autocomplete="off" placeholder="' +
      (e && e.username && e.username.indexOf("@") > 0 ? esc(e.username) + " (same as the username)" : "the mailbox this vendor bills") + '">');
    html += fld("Password", '<input id="vfPw" type="password" autocomplete="new-password" placeholder="' +
      (e && e.hasSecret ? "Stored. Type to replace it" : "Not set") + '">');
    html += fld("Account label", '<input id="vfAccount" value="' + esc(e && e.account ? e.account : "") + '" placeholder="Which account, when there is more than one">');
    html += fld("Two-factor", '<input id="vfMfa" value="' + esc(e && e.mfa ? e.mfa : "") + '" placeholder="Authenticator app, SMS to …, recovery codes kept …">');
    html += fld("API key env var", '<input id="vfEnv" value="' + esc(e && e.envKey ? e.envKey : "") + '" placeholder="TELNYX_API_KEY">');
    html += '</div>';
    html += '<div class="fld" style="margin-top:12px"><label>Used for</label><textarea id="vfUsed" rows="2">' + esc(e && e.used_for ? e.used_for : "") + '</textarea></div>';
    html += '<div class="fld" style="margin-top:12px"><label>Notes</label><textarea id="vfNotes" rows="4">' + esc(e && e.notes ? e.notes : "") + '</textarea></div>';

    if (e && e.secretUpdatedAt) html += '<p class="note">Password last changed ' + esc(fmtDate(e.secretUpdatedAt)) + '.</p>';
    if (e && e.hasSecret) html += '<p class="note">Leave the password field empty to keep the stored one.</p>';

    html += '<div class="btn-row" style="margin-top:16px"><a class="btn btn-primary btn-sm" id="vfSave">Save</a>';
    if (e && e.hasSecret) html += '<a class="btn btn-sm" id="vfClear">Clear password</a>';
    html += '</div>';

    if (e) {
      html += '<div class="danger-zone"><h3>Remove</h3>' +
        '<p class="note" style="margin-top:0">Deletes this row and its stored password. A built-in service stays gone, including across deploys, until you bring it back with Restore defaults.</p>' +
        '<a class="btn btn-danger btn-sm" id="vfDelete">Delete account</a></div>';
    }

    $("#drawerBody").innerHTML = html;
    $("#scrim").classList.add("show");
    $("#drawer").classList.add("show");
    $("#vdClose").addEventListener("click", closeDrawer);
    $("#vfSave").addEventListener("click", function () { saveVault(e, undefined); });
    if ($("#vfClear")) $("#vfClear").addEventListener("click", function () { saveVault(e, ""); });
    if ($("#vfDelete")) $("#vfDelete").addEventListener("click", function () { deleteVault(e); });
  }

  function saveVault(e, forcePassword) {
    var payload = {
      service: $("#vfService").value.trim(),
      category: $("#vfCat").value,
      url: $("#vfUrl").value.trim(),
      username: $("#vfUser").value.trim(),
      billingEmail: $("#vfBill").value.trim(),
      account: $("#vfAccount").value.trim(),
      mfa: $("#vfMfa").value.trim(),
      envKey: $("#vfEnv").value.trim(),
      used_for: $("#vfUsed").value.trim(),
      notes: $("#vfNotes").value.trim()
    };
    if (e) payload.id = e.id;
    if (forcePassword !== undefined) payload.password = forcePassword;
    else if ($("#vfPw").value) payload.password = $("#vfPw").value;

    if (!payload.service) { toast("Give it a service name"); return; }

    send("/owner/vault", "POST", payload).then(function (res) {
      if (!res.ok) {
        toast(res.data && res.data.message ? res.data.message : "Save failed");
        return;
      }
      toast(forcePassword === "" ? "Password cleared" : "Saved");
      closeDrawer();
      viewPasswords();
    });
  }

  function deleteVault(e) {
    deleteVaultRows([e.id], e.service);
  }

  /* ================= SECURITY (2FA) ================= */
  /* Authenticator-app two-factor on the owner sign-in. Enrolling here protects
   * every owner route behind a rolling code; one-time recovery codes are shown
   * once at activation so a lost device never locks you out. */
  /* ================= BREAKS =================
     Every break the app showed somebody, newest first. The person on the other
     end saw a plain-English notice and a code; this is the same event with the
     screen, the request and the status attached, so a report that arrives as
     "it broke, ROS-SRV" is already actionable. Filed by assets/js/command.js;
     stored in lib/breaks. */
  function viewBreaks() {
    api("/breaks?limit=100").then(function (d) {
      var rows = d.breaks || [];
      var html = '<div class="v-head"><h2>Breaks</h2><p>What the app told someone had gone wrong, newest first. Each one is what they saw on screen, plus the screen they were on and the request behind it. An empty list is the good outcome.</p></div>';
      if (!rows.length) {
        html += '<div class="card"><p class="note">Nothing has broken in front of anyone since the last restart.</p></div>';
        $("#view").innerHTML = html;
        return;
      }
      // Repeat offenders first: one code hitting many people is a different
      // problem from a one-off, and it should not have to be counted by eye.
      var byCode = {};
      rows.forEach(function (b) { byCode[b.code] = (byCode[b.code] || 0) + 1; });
      html += '<div class="stat-grid">' + Object.keys(byCode).sort(function (a, b) { return byCode[b] - byCode[a]; })
        .slice(0, 4).map(function (c) { return stat(byCode[c], esc(c), byCode[c] > 5 ? "bad" : "amber"); }).join("") + '</div>';
      // The reason column is the point of the table, so it must never be the one
      // that falls off a narrow screen: the table scrolls inside the card.
      html += '<div class="card" style="margin-top:18px"><div style="overflow-x:auto"><table class="otable"><thead><tr>' +
        '<th>When</th><th>Code</th><th>Who</th><th>Where</th><th>Request</th><th>Reason</th></tr></thead><tbody>';
      rows.forEach(function (b) {
        html += '<tr>' +
          '<td>' + esc(new Date(b.at).toLocaleString()) + '</td>' +
          '<td><b>' + esc(b.code) + '</b></td>' +
          '<td>' + esc(b.userEmail || "-") + '</td>' +
          '<td>' + esc(b.where || b.screen || "-") + '</td>' +
          '<td>' + esc(b.path || "-") + (b.status ? (" · " + esc(String(b.status))) : "") + '</td>' +
          '<td>' + esc(b.detail || "-") + '</td>' +
          '</tr>';
      });
      html += '</tbody></table></div>';
      $("#view").innerHTML = html;
    });
  }


  function viewSecurity() {
    api("/auth/2fa/status").then(function (st) {
      var html = '<div class="v-head"><h2>Security</h2><p>Two-factor authentication (2FA) puts an authenticator-app code in front of your sign-in, so a stolen or guessed password alone can\'t get in. This protects your account everywhere, the owner console and the main app.</p></div>';
      html += '<div class="card" id="emailHealth" style="margin-bottom:14px"><p class="note">Checking email delivery…</p></div>';
      if (st.enabled) {
        html += '<div class="card"><div style="display:flex;align-items:center;gap:10px;margin-bottom:6px"><span class="pill active">2FA is ON</span>' +
          '<span class="note" style="margin:0">' + st.recoveryRemaining + ' backup recovery code' + (st.recoveryRemaining === 1 ? '' : 's') + ' remaining</span></div>' +
          '<p class="note">Your sign-in now requires a 6-digit code from your authenticator app. Keep your recovery codes somewhere safe, each works once if you lose your device.</p>' +
          '<h3 style="font-size:13px;margin:16px 0 6px">Turn off 2FA</h3>' +
          '<p class="note" style="margin-top:0">Enter a current code (or a recovery code) to disable it.</p>' +
          '<div class="calc">' + fld("Authenticator or recovery code", '<input id="sfDisableCode" type="text" inputmode="numeric" placeholder="6-digit code">') + '</div>' +
          '<div class="btn-row" style="margin-top:10px"><a class="btn btn-danger btn-sm" id="sfDisable">Disable 2FA</a></div>' +
          '<div id="sfMsg"></div></div>';
        $("#view").innerHTML = html;
        loadEmailHealth();
        $("#sfDisable").addEventListener("click", function () {
          var code = $("#sfDisableCode").value.trim();
          if (!code) { toast("Enter a code first"); return; }
          send("/auth/2fa/disable", "POST", { code: code }).then(function (res) {
            if (res.ok) { toast("2FA disabled"); viewSecurity(); }
            else toast(res.data && res.data.error === "invalid_code" ? "That code isn't right" : "Could not disable");
          });
        });
      } else {
        html += '<div class="card"><div style="display:flex;align-items:center;gap:10px;margin-bottom:6px"><span class="pill susp">2FA is OFF</span>' +
          '<span class="note" style="margin:0">Your password is the only thing protecting your account.</span></div>' +
          '<p class="note">Set it up in under a minute with Google Authenticator, Authy, 1Password, or any TOTP app.</p>' +
          '<div class="btn-row" style="margin-top:10px"><a class="btn btn-primary btn-sm" id="sfBegin">Set up 2FA</a></div>' +
          '<div id="sfSetup" style="margin-top:14px"></div></div>';
        $("#view").innerHTML = html;
        loadEmailHealth();
        $("#sfBegin").addEventListener("click", beginSetup);
      }
    }).catch(fail);
  }

  /* Email delivery health: is outbound email wired, and a one-click real test
   * send so the owner can confirm password-reset/verification emails deliver
   * (or see the exact provider rejection). */
  function loadEmailHealth() {
    var box = $("#emailHealth"); if (!box) return;
    api("/owner/email-health").then(function (d) {
      var on = d && d.configured;
      box.innerHTML = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">' +
        (on ? '<span class="pill active">Email ON</span>' : '<span class="pill susp">Email OFF</span>') +
        '<strong>Password reset &amp; verification emails</strong></div>' +
        (on
          ? '<p class="note">Sending from <span class="mono">' + esc(d.from) + '</span>. Send yourself a test to confirm delivery.</p>'
          : '<p class="note"><strong>No email provider is configured</strong>, so reset/verification emails are never sent, only logged. Set <span class="mono">RESEND_API_KEY</span> + <span class="mono">EMAIL_FROM</span> in the server\'s <span class="mono">.env.production</span> and redeploy. Then test here.</p>') +
        '<div class="btn-row" style="margin-top:8px"><a class="btn btn-sm" id="ehTest">Send test email to me</a></div>' +
        '<div id="ehResult"></div>';
      $("#ehTest").addEventListener("click", function () {
        var r = $("#ehResult"); r.innerHTML = '<p class="note">Sending…</p>';
        send("/owner/email-health", "POST", {}).then(function (res) {
          var x = res.data || {};
          if (x.ok) r.innerHTML = '<p class="note" style="color:var(--accent-green)">✓ Sent to ' + esc(x.to) + '. Check your inbox (and spam).</p>';
          else if (x.reason === "no_provider") r.innerHTML = '<p class="note" style="color:var(--accent-red)">No provider configured, set RESEND_API_KEY on the server first.</p>';
          else r.innerHTML = '<p class="note" style="color:var(--accent-red)">Provider rejected it (' + esc(String(x.status || x.reason)) + '): ' + esc(String(x.detail || "").slice(0, 240)) + '</p>';
        }).catch(function () { r.innerHTML = '<p class="note" style="color:var(--accent-red)">Couldn\'t reach the server.</p>'; });
      });
    }).catch(function () { box.innerHTML = '<p class="note">Email status unavailable.</p>'; });
  }

  function beginSetup() {
    var btn = $("#sfBegin"); if (btn) btn.classList.add("disabled");
    send("/auth/2fa/setup", "POST", {}).then(function (res) {
      if (!res.ok) { toast("Could not start setup"); if (btn) btn.classList.remove("disabled"); return; }
      var d = res.data;
      var grouped = (d.secret || "").replace(/(.{4})/g, "$1 ").trim();
      var html = '<div class="setup-step"><div class="step-n">1</div><div><strong>Add it to your authenticator app.</strong>' +
        '<p class="note" style="margin:4px 0 8px">Open your app, choose “Add account → enter a setup key,” and type this key (account: your email). Use this manual key, never share it or paste it into a website.</p>' +
        '<div class="secret-box" id="sfSecret">' + esc(grouped) + '</div>' +
        '<div class="btn-row" style="margin-top:8px"><a class="btn btn-sm" id="sfCopy">Copy key</a></div></div></div>';
      html += '<div class="setup-step"><div class="step-n">2</div><div><strong>Enter the 6-digit code it shows.</strong>' +
        '<p class="note" style="margin:4px 0 8px">This confirms your app is configured correctly before we switch 2FA on.</p>' +
        '<div class="calc">' + fld("Code from app", '<input id="sfCode" type="text" inputmode="numeric" placeholder="123456" maxlength="6">') + '</div>' +
        '<div class="btn-row" style="margin-top:10px"><a class="btn btn-primary btn-sm" id="sfActivate">Activate 2FA</a></div></div></div>';
      html += '<div id="sfResult"></div>';
      $("#sfSetup").innerHTML = html;
      if (btn) btn.style.display = "none";
      $("#sfCopy").addEventListener("click", function () {
        try { navigator.clipboard.writeText(d.secret); toast("Key copied"); } catch (e) { toast("Select and copy the key"); }
      });
      $("#sfActivate").addEventListener("click", function () {
        var code = $("#sfCode").value.trim();
        if (!code) { toast("Enter the code from your app"); return; }
        send("/auth/2fa/enable", "POST", { code: code }).then(function (r2) {
          if (!r2.ok) { toast(r2.data && r2.data.error === "invalid_code" ? "That code isn't right, try the current one" : "Activation failed"); return; }
          showRecoveryCodes(r2.data.recoveryCodes || []);
        });
      });
    });
  }

  function showRecoveryCodes(codes) {
    var html = '<div class="card recovery-card" style="margin-top:14px"><div style="display:flex;align-items:center;gap:10px"><span class="pill active">2FA is ON</span><strong>Save your backup recovery codes</strong></div>' +
      '<p class="note">These are shown <strong>once</strong>. Each works a single time if you lose your authenticator device. Store them in a password manager.</p>' +
      '<div class="recovery-grid">' + codes.map(function (c) { return '<div class="rc">' + esc(c) + '</div>'; }).join("") + '</div>' +
      '<div class="btn-row" style="margin-top:12px"><a class="btn btn-sm" id="rcCopy">Copy all</a><a class="btn btn-sm" id="rcDownload">Download .txt</a><a class="btn btn-primary btn-sm" id="rcDone">Done</a></div></div>';
    $("#sfResult").innerHTML = html;
    var blob = codes.join("\n");
    $("#rcCopy").addEventListener("click", function () { try { navigator.clipboard.writeText(blob); toast("Copied"); } catch (e) { toast("Select and copy"); } });
    $("#rcDownload").addEventListener("click", function () {
      var a = document.createElement("a");
      a.href = "data:text/plain;charset=utf-8," + encodeURIComponent("RecruitersOS 2FA recovery codes\n\n" + blob + "\n");
      a.download = "recruiteros-recovery-codes.txt"; a.click();
    });
    $("#rcDone").addEventListener("click", function () { toast("2FA enabled"); viewSecurity(); });
  }

  function fail(status) {
    if (status === 401) { location.href = "/login"; return; }
    $("#view").innerHTML = '<div class="card"><p class="note">Could not load this view. ' + (status === 404 ? "Access restricted." : "Try again.") + '</p></div>';
  }

  boot();
})();
