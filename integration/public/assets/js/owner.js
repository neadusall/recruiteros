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
  var ROUTES = { overview: viewOverview, pricing: viewPricing, burn: viewBurn, spend: viewSpend, people: viewPeople, accounts: viewAccounts, costs: viewCosts, security: viewSecurity };
  var TITLES = { overview: "Overview", pricing: "Pricing", burn: "Spend master", spend: "Spend", people: "Users & roles", accounts: "Accounts", costs: "Cost model", security: "Security" };
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
      html += receiptKpis(rcptData);
      html += receiptAlerts(rcptData);
      html += receiptMatrix(rcptData);
      html += receiptSourcing(rcptData);
      html += receiptUnmatched(rcptData);
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
    var html = '<div class="otable-wrap"><table class="otable"><thead><tr>' +
      '<th>Vendor / item</th><th>Billing</th><th class="num">Cost / mo</th><th>Usage against the plan</th><th>Status</th>' +
      '</tr></thead><tbody>';
    rows.forEach(function (i) {
      html += '<tr class="clickrow" data-spend="' + esc(i.id) + '">' +
        '<td><div class="lr-main">' + esc(i.vendor) + ' · ' + esc(i.label) + '</div>' +
        '<div class="lr-sub note">' + esc(i.purpose || labelFor(BURN_CATEGORIES, i.category)) + '</div></td>' +
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
     Dates come from the public registry, money is owner-entered. */
  function burnDomains(b) {
    var rows = (b.items || []).filter(function (i) { return !!i.domain; });
    var soon = b.domainsExpiringSoon || [];
    var html = '<div class="card" style="margin-top:14px"><div class="burn-head"><h3>Domains</h3>' +
      '<div class="btn-row" style="margin:0"><button class="btn btn-sm" id="dmImport">Import from sending fleet</button>' +
      '<button class="btn btn-sm" id="dmRefresh">Refresh registry dates</button></div></div>';
    html += '<p class="note" style="margin-top:2px">' + (b.domainCount || 0) + ' domains tracked · ' + usd(b.domainRenewalAnnualUsd || 0) + ' to renew them all for another year. Registration and expiry come from the public registry; purchase price and renewal price are yours to enter.</p>';

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
    html += '<div class="otable-wrap"><table class="otable"><thead><tr>' +
      '<th>Domain</th><th>Registrar</th><th>Purchased</th><th>Expires</th><th class="num">Days left</th><th class="num">Paid</th><th class="num">Renewal</th><th>Auto</th>' +
      '</tr></thead><tbody>';
    rows.sort(function (x, y) { return (x.expiresAt || "9999").localeCompare(y.expiresAt || "9999"); }).forEach(function (i) {
      var days = i.expiresAt ? Math.round((Date.parse(i.expiresAt) - Date.now()) / 86400000) : null;
      var dcls = days == null ? "" : days < 0 ? "margin-bad" : days <= 60 ? "margin-mid" : "margin-good";
      html += '<tr class="clickrow" data-spend="' + esc(i.id) + '">' +
        '<td><div class="lr-main">' + esc(i.domain) + '</div>' + (i.registryError ? '<div class="lr-sub bad-t">' + esc(i.registryError) + '</div>' : '') + '</td>' +
        '<td>' + esc(i.registrar || "-") + '</td>' +
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
    html += '<div class="otable-wrap"><table class="otable"><thead><tr><th>Vendor / item</th><th>Type</th><th>Date</th><th class="num">Amount</th></tr></thead><tbody>';
    rows.forEach(function (i) {
      html += '<tr class="clickrow" data-spend="' + esc(i.id) + '">' +
        '<td><div class="lr-main">' + esc(i.vendor) + ' · ' + esc(i.label) + '</div><div class="lr-sub note">' + esc(i.purpose || "") + '</div></td>' +
        '<td>' + esc(labelFor(BURN_BILLING, i.billing)) + '</td>' +
        '<td>' + esc(i.at || "") + '</td>' +
        '<td class="num">' + (i.needsAmount ? '<span class="pill needs">Set amount</span>' : usd(i.amountUsd)) + '</td></tr>';
    });
    return html + '</tbody></table></div></div>';
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

  function wireBurn() {
    $$("#burnFilters .burn-chip").forEach(function (c) {
      c.addEventListener("click", function () { burnFilter = c.dataset.filter; viewBurn(); });
    });
    $$("#view .clickrow[data-spend]").forEach(function (tr) {
      tr.addEventListener("click", function () { openSpendItem(tr.dataset.spend); });
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
   *   receiptKpis / receiptAlerts / receiptMatrix / receiptSourcing / receiptUnmatched
   *   openReceipt      the receipt viewer (the actual invoice image)
   *   openAttach       hand-attach an invoice downloaded from a vendor portal
   *   Backend          GET/POST/PATCH/DELETE /api/owner/receipts
   */
  var rcptData = null;
  var rcptMonths = Number(localStorage.getItem("owner_rcpt_months")) || 12;
  var rcptPoll = null;

  var CELL_LABEL = {
    paid: "receipt on file", mismatch: "amount differs from the register", missing: "no receipt",
    pending: "not charged yet", unexpected: "charged with nothing expected", metered: "pay per use",
    prepaid: "covered by the annual payment", none: "nothing charged", before: "before this service started",
    cancelled: "cancelled"
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
  function receiptMatrix(d) {
    if (!d) return "";
    var m = d.matrix, months = m.months || [];
    var html = '<div class="card" style="margin-top:14px"><div class="burn-head"><h3>Month by month</h3>' +
      '<div class="btn-row" style="margin:0">' +
      '<select id="rcMonths" class="rc-months">' +
      [6, 12, 18, 24].map(function (n) { return '<option value="' + n + '"' + (n === rcptMonths ? " selected" : "") + '>Last ' + n + ' months</option>'; }).join("") +
      '</select>' +
      '<button class="btn btn-sm" id="rcHarvest">Pull receipts from the mailbox</button>' +
      '<button class="btn btn-sm" id="rcAttach">Attach an invoice</button>' +
      '</div></div>' +
      '<p class="note" style="margin-top:2px">Each cell is one month for one service. Click a receipt to see the invoice itself; click an empty month to attach one. Solid figures are proven by a receipt, faded figures are the register\'s estimate.</p>';

    html += '<div class="otable-wrap rc-wrap"><table class="otable rc-matrix"><thead><tr><th class="rc-svc">Service</th>';
    months.forEach(function (p) { html += '<th class="num">' + esc(monthLabel(p)) + '</th>'; });
    html += '<th class="num">Total</th></tr></thead><tbody>';

    (m.rows || []).forEach(function (r) {
      if (!r.totalCountedUsd && !r.receiptCount && r.monthlyUsd === 0 && r.billing !== "metered") return;
      html += '<tr><th class="rc-svc"><div class="lr-main">' + esc(r.vendor) + '</div>' +
        '<div class="lr-sub note">' + esc(r.label) + '</div>' +
        (r.missingCount ? '<div class="lr-sub bad-t">' + r.missingCount + ' month' + (r.missingCount > 1 ? "s" : "") + ' unreceipted</div>' : "") +
        '</th>';
      (r.cells || []).forEach(function (c) { html += matrixCell(r, c); });
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
    return html + '</tfoot></table></div></div>';
  }

  function matrixCell(row, c) {
    var cls = "rc-cell rc-" + c.status;
    var attr = ' data-cell="' + esc((row.itemId || "") + "|" + c.period) + '"';
    var inner;
    if (c.receipts && c.receipts.length) {
      var r = c.receipts[0];
      inner = '<div class="rc-amt">' + usd(c.actualUsd) + '</div>' +
        (r.hasShot
          ? '<img class="rc-thumb" src="' + API + '/owner/receipts/file/' + esc(r.id) + '?v=thumb" alt="receipt" loading="lazy" />'
          : '<div class="rc-noshot">no image</div>') +
        (c.receipts.length > 1 ? '<div class="note" style="font-size:10.5px">' + c.receipts.length + ' receipts</div>' : "") +
        (c.note ? '<div class="note" style="font-size:10.5px">' + esc(c.note) + '</div>' : "");
    } else if (c.status === "missing") {
      inner = '<div class="rc-amt est">' + usd(c.expectedUsd) + '</div><div class="rc-gap">no receipt</div>';
    } else if (c.status === "pending") {
      inner = '<div class="rc-amt est">' + usd(c.expectedUsd) + '</div><div class="note" style="font-size:10.5px">due</div>';
    } else if (c.status === "metered") {
      inner = '<div class="rc-amt">' + usd(c.countedUsd) + '</div><div class="note" style="font-size:10.5px">metered</div>';
    } else {
      inner = '<div class="rc-dash">·</div>';
    }
    return '<td class="' + cls + '"' + attr + ' title="' + esc(monthLabel(c.period) + " · " + (CELL_LABEL[c.status] || c.status)) + '">' + inner + '</td>';
  }

  function monthLabel(p) {
    var parts = String(p || "").split("-");
    var names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return (names[Number(parts[1]) - 1] || p) + " " + String(parts[0] || "").slice(2);
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
      var sweep = (inbox.sweeps || [])[0];
      html += '<p class="note" style="margin-top:2px">Reading ' + mb + '. ' +
        (inbox.lastSweepAt ? 'Last pull ' + esc(fmtDate(inbox.lastSweepAt)) + '. ' : 'No pull has run yet. ') +
        (sweep
          ? (sweep.ok
            ? 'Scanned ' + sweep.scanned + ' messages back to ' + esc(sweep.since) + ': ' + sweep.imported + ' receipts imported, ' + sweep.duplicates + ' already on file, ' + sweep.shotFailures + ' images failed.'
            : '<span class="bad-t">Last pull failed: ' + esc(sweep.error || "unknown error") + '</span>')
          : "") +
        '</p>';
      if (sweep && sweep.rejects && sweep.rejects.length) {
        html += '<details class="rc-rejects"><summary>' + sweep.rejects.length + ' billing-looking messages were not imported</summary><ul>';
        sweep.rejects.forEach(function (r) {
          html += '<li><strong>' + esc(r.subject) + '</strong> <span class="note">' + esc(r.from) + ' · ' + esc(r.date) + ' · ' + esc(r.reason) + '</span></li>';
        });
        html += '</ul></details>';
      }
      if (inbox.harvest && inbox.harvest.running) {
        html += '<p class="note">A pull is running now (started ' + esc(fmtDate(inbox.harvest.startedAt)) + '). Rendering each receipt takes a few seconds, so this page refreshes itself when it finishes.</p>';
      }
    }

    var rows = d.sourcing || [];
    html += '<div class="otable-wrap"><table class="otable"><thead><tr>' +
      '<th>Vendor</th><th>How the receipt arrives</th><th class="num">On file</th><th>Last</th><th>What is needed</th>' +
      '</tr></thead><tbody>';
    rows.forEach(function (r) {
      var pill = r.state === "auto" ? '<span class="pill active">Automatic</span>'
        : r.state === "manual" ? '<span class="pill needs">By hand</span>'
        : r.state === "unproven" ? '<span class="pill dead">Not arriving</span>'
        : '<span class="pill unknown">Not billed</span>';
      html += '<tr><td><div class="lr-main">' + esc(r.vendor) + '</div>' + pill + '</td>' +
        '<td><div class="lr-sub">' + esc(channelLabel(r.channel)) + '</div>' +
        (r.from && r.from.length ? '<div class="note" style="font-size:11px">from ' + esc(r.from.slice(0, 3).join(", ")) + '</div>' : "") +
        (r.api ? '<div class="note" style="font-size:11px">' + esc(r.api) + '</div>' : "") + '</td>' +
        '<td class="num">' + (r.emailCount + r.manualCount) + (r.manualCount ? ' <span class="note">(' + r.manualCount + ' by hand)</span>' : "") + '</td>' +
        '<td>' + esc((r.lastAt || "").slice(0, 10) || "-") + '</td>' +
        '<td><div class="lr-sub">' + esc(r.advice) + '</div>' +
        (r.portal ? '<a class="note" href="' + esc(r.portal) + '" target="_blank" rel="noopener">open the billing page</a>' : "") +
        (r.setup ? '<div class="note" style="font-size:11px">' + esc(r.setup) + '</div>' : "") + '</td></tr>';
    });
    return html + '</tbody></table></div></div>';
  }

  function channelLabel(c) {
    return c === "email_vendor" ? "The vendor emails a receipt"
      : c === "email_processor" ? "A payment processor emails it (Stripe / Paddle / PayPal)"
      : c === "portal_only" ? "No email at all: download it from the portal"
      : c === "api" ? "An invoice API exists" : "Email";
  }

  /* Charges with no line item behind them: the spend nobody catalogued. */
  function receiptUnmatched(d) {
    if (!d || !d.matrix.unmatched || !d.matrix.unmatched.length) return "";
    var html = '<div class="card" style="margin-top:14px"><h3>Charges with no line item</h3>' +
      '<p class="note" style="margin-top:-4px">Real money left the account for these and the spend register has never heard of them.</p>' +
      '<div class="otable-wrap"><table class="otable"><thead><tr><th>Vendor</th><th class="num">Total</th><th class="num">Receipts</th><th>Months</th><th></th></tr></thead><tbody>';
    d.matrix.unmatched.forEach(function (u) {
      html += '<tr><td><div class="lr-main">' + esc(u.vendor) + '</div></td>' +
        '<td class="num">' + usd(u.totalUsd) + '</td><td class="num">' + u.count + '</td>' +
        '<td>' + esc(u.periods.join(", ")) + '</td>' +
        '<td>' + u.receipts.slice(0, 4).map(function (r) {
          return '<button class="btn btn-sm" data-receipt="' + esc(r.id) + '">' + esc((r.chargedAt || "").slice(0, 10)) + '</button>';
        }).join(" ") + '</td></tr>';
    });
    return html + '</tbody></table></div></div>';
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

    $$("#view .rc-cell").forEach(function (td) {
      td.addEventListener("click", function () {
        var parts = (td.dataset.cell || "").split("|");
        var row = ((rcptData && rcptData.matrix.rows) || []).filter(function (r) { return r.itemId === parts[0]; })[0];
        var cell = row && (row.cells || []).filter(function (c) { return c.period === parts[1]; })[0];
        if (cell && cell.receipts && cell.receipts.length) openReceipt(cell.receipts[0].id);
        else if (row) openAttach(row, cell);
      });
    });

    $$("#view [data-receipt]").forEach(function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); openReceipt(b.dataset.receipt); });
    });

    if (rcptData && rcptData.inbox && rcptData.inbox.harvest && rcptData.inbox.harvest.running) pollHarvest();
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

  /* The receipt itself. The image is the point: it is the thing an accountant asks for. */
  function openReceipt(id) {
    var r = ((rcptData && rcptData.receipts) || []).filter(function (x) { return x.id === id; })[0];
    var refs = [];
    ((rcptData && rcptData.matrix.rows) || []).forEach(function (row) {
      (row.cells || []).forEach(function (c) { (c.receipts || []).forEach(function (x) { refs.push(x); }); });
    });
    ((rcptData && rcptData.matrix.unmatched) || []).forEach(function (u) { u.receipts.forEach(function (x) { refs.push(x); }); });
    var ref = refs.filter(function (x) { return x.id === id; })[0];
    if (!r && !ref) return;
    var v = r || ref;

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
    $("#rcConfirm").addEventListener("click", function () {
      send("/owner/receipts", "PATCH", { id: v.id, reviewed: true }).then(function () { toast("Confirmed"); closeDrawer(); viewBurn(); });
    });
    $("#rcDelete").addEventListener("click", function () {
      send("/owner/receipts?id=" + encodeURIComponent(v.id), "DELETE").then(function () { toast("Removed"); closeDrawer(); viewBurn(); });
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
    if (!i) return;
    var L = i.live || {};
    var html = '<div style="display:flex;justify-content:space-between;align-items:start">' +
      '<div><h2>' + esc(i.vendor) + '</h2><div class="sub">' + esc(i.label) + '</div></div>' +
      '<a class="btn btn-sm" id="dwClose">✕</a></div>';

    if (i.impact) html += '<div class="impact-box"><div class="ib-label">How this builds the business</div><p>' + esc(i.impact) + '</p></div>';

    html += '<div class="kv">' +
      kv("Status", stateCell(i)) +
      kv("Signal", '<span class="note">' + esc(L.reason || "") + '</span>') +
      kv("Monthly equivalent", usd(monthlyOf(i))) +
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
        status: $("#seStatus").value
      }).then(function (r) {
        if (!r.ok) { toast("Could not save"); return; }
        toast("Saved"); closeDrawer(); viewBurn();
      });
    });
    $("#seDelete").addEventListener("click", function () {
      send("/owner/burn?id=" + encodeURIComponent(i.id), "DELETE").then(function (r) {
        if (!r.ok) { toast("Could not remove"); return; }
        toast("Removed"); closeDrawer(); viewBurn();
      });
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
      if (!s.byWorkspace.length) html += '<p class="note">No account has incurred cost in this window.</p>';
      else {
        html += '<table class="otable"><thead><tr><th>Account</th><th class="num">Cost</th><th class="num">Events</th></tr></thead><tbody>';
        s.byWorkspace.forEach(function (w) {
          html += '<tr class="clickrow" data-id="' + esc(w.workspaceId) + '"><td>' + esc(w.name) + '</td><td class="num">' + usd(w.costUsd) + '</td><td class="num">' + w.events + '</td></tr>';
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

    // cost by category
    if (a.costByCategory && Object.keys(a.costByCategory).length) {
      html += '<h3 style="font-size:13px;margin:16px 0 6px">Cost by category · ' + esc(win) + '</h3>' + barsFromObj(a.costByCategory);
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

    // recent usage
    if (d.recentUsage && d.recentUsage.length) {
      html += '<h3 style="font-size:13px;margin:16px 0 6px">Recent cost events</h3><table class="otable"><tbody>';
      d.recentUsage.slice(0, 12).forEach(function (e) {
        html += '<tr><td>' + esc(e.type) + ' <span class="note">' + esc(e.source || e.category) + '</span></td><td class="num">' + (e.quantity || 0).toLocaleString() + '</td><td class="num">' + usd(e.costUsd) + '</td></tr>';
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

  function wireDrawer(a) {
    var id = a.workspaceId;
    loadGrants(id);
    $("#dwClose").addEventListener("click", closeDrawer);
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

  /* ================= SECURITY (2FA) ================= */
  /* Authenticator-app two-factor on the owner sign-in. Enrolling here protects
   * every owner route behind a rolling code; one-time recovery codes are shown
   * once at activation so a lost device never locks you out. */
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
