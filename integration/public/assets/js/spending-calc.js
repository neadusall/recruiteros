/* RecruitersOS · Spending scenario planner (in-app, all users)
 *
 * A dynamic "what will my outreach cost" model that anyone can play with from
 * their dashboard. Account-based: starts at ONE account sending 2,500/mo, and
 * you can add accounts (or change any number) to see how spend scales.
 *
 * IMPORTANT: cost lines are deliberately GENERIC. The real vendors/tools behind
 * each line are NOT named anywhere a customer can see — only the function it
 * performs and an editable unit price. This lets people model their spend
 * without handing them the underlying stack to go rebuild themselves.
 *
 * Mount with: window.SpendingCalc.mount(rootEl)
 */
(function () {
  "use strict";

  var KEY = "ros_spend_calc";

  /* Defaults — one account, 2,500 sends/mo. Every value is editable at runtime;
   * the unit costs are generic placeholders the operator can tune. */
  var DEFAULTS = {
    accounts: 1,
    // per-account monthly activity — emails derive from prospects × steps
    // (2,500 prospects × 3 emails/mo = 7,500 emails).
    prospectsPerAccount: 2500,
    stepsPerProspect: 3,
    enrichPerAccount: 2500,
    voicePerAccount: 200,
    // Email Sending (own inboxes + domains; counts auto-size to volume)
    inboxCost: 2.5, domainCost: 1.0, sendsPerInbox: 750, inboxesPerDomain: 3,
    // Hiring Signals (per lookup, optional one-time data pack)
    signalCost: 0.017, signalSetup: 85, signalSetupOn: 1,
    // Contact Enrichment (per contact looked up)
    enrichCost: 0.03,
    // Cloned Voice (monthly plan + per drop)
    voicePlan: 39, voiceCost: 0.01
  };
  var LADDER = [1, 2, 3, 5, 10, 25, 50];

  /* ---------------- helpers ---------------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function usd(n, dp) { n = Number(n) || 0; if (dp != null) return "$" + n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }); return "$" + n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }); }
  function fmt(n, dp) { return (Number(n) || 0).toFixed(dp == null ? 2 : dp); }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  function state() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { s = {}; }
    var o = {};
    Object.keys(DEFAULTS).forEach(function (k) { o[k] = s[k] != null ? s[k] : DEFAULTS[k]; });
    return o;
  }
  function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }
  function assign(s, k, v) { var o = {}; Object.keys(s).forEach(function (x) { o[x] = s[x]; }); o[k] = v; return o; }

  /* ---------------- pure cost model ---------------- */
  function compute(s) {
    var accounts = Math.max(0, Number(s.accounts) || 0);
    var prospects = accounts * s.prospectsPerAccount;
    var emails = prospects * s.stepsPerProspect;       // 2,500 prospects × 3 = 7,500
    var enrich = accounts * s.enrichPerAccount;
    var voice = accounts * s.voicePerAccount;

    // Email Sending — inboxes/domains auto-size to the send volume.
    var inboxes = s.sendsPerInbox > 0 ? Math.ceil(emails / s.sendsPerInbox) : 0;
    var domains = s.inboxesPerDomain > 0 ? Math.ceil(inboxes / s.inboxesPerDomain) : 0;
    var emailCost = inboxes * s.inboxCost + domains * s.domainCost;

    // Hiring Signals — per lookup, with an optional one-time data pack.
    var signalRecurring = prospects * s.signalCost;
    var signalOneTime = s.signalSetupOn ? s.signalSetup : 0;

    // Contact Enrichment — per successful match.
    var enrichTotal = enrich * s.enrichCost;

    // Cloned Voice — flat monthly plan + per-drop cost.
    var voiceRecurring = s.voicePlan + voice * s.voiceCost;

    var recurring = emailCost + signalRecurring + enrichTotal + voiceRecurring;
    var oneTime = signalOneTime;
    return {
      accounts: accounts, emails: emails, prospects: prospects, enrich: enrich, voice: voice,
      inboxes: inboxes, domains: domains,
      emailCost: emailCost, signalRecurring: signalRecurring, signalOneTime: signalOneTime,
      enrichTotal: enrichTotal, voiceRecurring: voiceRecurring,
      recurring: recurring, oneTime: oneTime,
      perAccount: accounts > 0 ? recurring / accounts : 0,
      perEmail: emails > 0 ? recurring / emails : 0
    };
  }

  /* ---------------- markup helpers ---------------- */
  function card(title, sub, inner) {
    return '<div class="sc-card"><h3>' + esc(title) + '</h3>' + (sub ? '<p class="sc-note" style="margin:-2px 0 12px">' + esc(sub) + '</p>' : '') + '<div class="sc-grid">' + inner + '</div></div>';
  }
  function fld(label, id, val, step, min) {
    return '<div class="sc-fld"><label>' + esc(label) + '</label><input data-sc="' + id + '" type="number" step="' + step + '" min="' + (min == null ? 0 : min) + '" value="' + val + '"></div>';
  }
  function bars(obj) {
    var entries = Object.keys(obj).map(function (k) { return [k, obj[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
    var max = Math.max.apply(null, entries.map(function (e) { return e[1]; })) || 1;
    return '<div class="sc-bars">' + entries.map(function (e) {
      return '<div class="sc-bar-row"><div>' + esc(e[0]) + '</div><div class="sc-bar-track"><div class="sc-bar-fill" style="width:' + Math.max(2, (e[1] / max) * 100) + '%"></div></div><div class="sc-num">' + usd(e[1]) + '</div></div>';
    }).join("") + '</div>';
  }
  function metric(v, l) { return '<div class="sc-metric"><div class="sc-mv">' + esc(v) + '</div><div class="sc-ml">' + esc(l) + '</div></div>'; }
  function tl(k, v) { return '<div class="sc-tl"><span>' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>'; }

  /* ---------------- mount ---------------- */
  function mount(root) {
    if (!root) return;
    var s = state();

    var html = '<div class="sc">';
    html += '<div class="sc-head"><h2>Spending</h2><p>Model what your outreach will cost each month — start with one account and add more to see how it scales. Every number is editable; the table at the bottom compares different account counts. This is a live what-if sandbox.</p></div>';

    // Accounts control
    html += '<div class="sc-accounts">' +
      '<div class="sc-acc-ctl"><button class="sc-step" data-acc="-1">−</button>' +
      '<input data-sc="accounts" type="number" min="1" step="1" value="' + s.accounts + '">' +
      '<button class="sc-step" data-acc="1">+</button>' +
      '<button class="sc-add" id="scAddAcct">+ Add account</button></div>' +
      '<div class="sc-acc-read" id="scAccRead"></div></div>';

    html += '<div class="sc-wrap"><div class="sc-inputs">';

    // Per-account activity
    html += card("Per account · monthly activity", "What one account runs each month. Emails = prospects × steps (2,500 × 3 = 7,500). Totals scale by the account count above.",
      fld("Prospects / mo", "prospectsPerAccount", s.prospectsPerAccount, 50, 0) +
      fld("Emails per prospect (steps)", "stepsPerProspect", s.stepsPerProspect, 1, 1) +
      fld("Contact lookups / mo", "enrichPerAccount", s.enrichPerAccount, 25, 0) +
      fld("Voice drops / mo", "voicePerAccount", s.voicePerAccount, 25, 0));

    // Email Sending (generic)
    html += card("Email Sending", "Your own sending inboxes and domains. The counts auto-size to your send volume.",
      fld("Cost / inbox / mo ($)", "inboxCost", s.inboxCost, 0.5, 0) +
      fld("Cost / domain / mo ($)", "domainCost", s.domainCost, 0.5, 0) +
      fld("Sends / inbox / mo", "sendsPerInbox", s.sendsPerInbox, 50, 1) +
      fld("Inboxes / domain", "inboxesPerDomain", s.inboxesPerDomain, 1, 1));

    // Hiring Signals (generic — was a named signals vendor)
    html += card("Hiring Signals", "Lookups that surface companies actively hiring. Priced per lookup, with an optional one-time data pack.",
      fld("Cost / lookup ($)", "signalCost", s.signalCost, 0.005, 0) +
      fld("One-time data pack ($)", "signalSetup", s.signalSetup, 5, 0) +
      fld("Include pack? (1 / 0)", "signalSetupOn", s.signalSetupOn, 1, 0));

    // Contact Enrichment (generic — was a named people-data vendor)
    html += card("Contact Enrichment", "Resolving verified contact details for a person. Priced per contact looked up.",
      fld("Cost / contact ($)", "enrichCost", s.enrichCost, 0.01, 0));

    // Cloned Voice (generic — was a named voice vendor)
    html += card("Cloned Voice", "AI voicemail drops in a cloned voice. A flat monthly plan plus a per-drop cost.",
      fld("Plan / mo ($)", "voicePlan", s.voicePlan, 1, 0) +
      fld("Cost / drop ($)", "voiceCost", s.voiceCost, 0.005, 0));

    html += '<div class="sc-btnrow"><button class="sc-reset" id="scReset">Reset to defaults</button></div>';
    html += '</div>'; // /sc-inputs

    html += '<div class="sc-results" id="scResults"></div>';
    html += '</div>'; // /sc-wrap

    html += '<div class="sc-card" id="scScenarios" style="margin-top:18px"></div>';
    html += '</div>'; // /sc

    root.innerHTML = html;

    $$("[data-sc]", root).forEach(function (inp) {
      inp.addEventListener("input", function () { recompute(root); });
      inp.addEventListener("change", function () { recompute(root); });
    });
    $$(".sc-step", root).forEach(function (b) {
      b.addEventListener("click", function () {
        var inp = $('[data-sc="accounts"]', root);
        var n = Math.max(1, (Number(inp.value) || 1) + Number(b.dataset.acc));
        inp.value = n; recompute(root);
      });
    });
    $("#scAddAcct", root).addEventListener("click", function () {
      var inp = $('[data-sc="accounts"]', root);
      inp.value = Math.max(1, (Number(inp.value) || 1) + 1); recompute(root);
    });
    $("#scReset", root).addEventListener("click", function () {
      try { localStorage.removeItem(KEY); } catch (e) {}
      mount(root);
    });
    recompute(root);
  }

  function recompute(root) {
    var s = state();
    $$("[data-sc]", root).forEach(function (inp) { s[inp.dataset.sc] = Number(inp.value) || 0; });
    save(s);
    var r = compute(s);

    var ar = $("#scAccRead", root);
    if (ar) ar.innerHTML = '<strong>' + r.accounts + '</strong> account' + (r.accounts === 1 ? '' : 's') + ' → <strong>' +
      r.emails.toLocaleString() + '</strong> emails · <strong>' + r.inboxes.toLocaleString() + '</strong> inboxes · <strong>' +
      r.prospects.toLocaleString() + '</strong> prospects / mo';

    var b = {};
    b["Email Sending"] = round2(r.emailCost);
    b["Hiring Signals"] = round2(r.signalRecurring);
    b["Contact Enrichment"] = round2(r.enrichTotal);
    b["Cloned Voice"] = round2(r.voiceRecurring);

    var html = '<div class="sc-hero"><div class="sc-hl">Projected recurring · ' + r.accounts + ' account' + (r.accounts === 1 ? '' : 's') + '</div>' +
      '<div class="sc-hv">' + usd(r.recurring) + '<span>/mo</span></div>' +
      (r.oneTime > 0 ? '<div class="sc-hs">+ ' + usd(r.oneTime) + ' one-time setup</div>' : '') + '</div>';

    html += '<div class="sc-metrics">' +
      metric(usd(r.perAccount), "per account / mo") +
      metric(usd(r.perEmail, 4), "per email") +
      metric(usd(r.recurring * 12), "per year") + '</div>';

    html += '<h3 class="sc-h3">Where it goes</h3>' + bars(b);

    html += '<h3 class="sc-h3">At a glance</h3><div class="sc-lines">' +
      tl("Emails / mo", r.emails.toLocaleString()) +
      tl("Sending inboxes", r.inboxes.toLocaleString() + " · " + r.domains.toLocaleString() + " domains") +
      tl("Contact lookups", r.enrich.toLocaleString()) +
      tl("Voice drops", r.voice.toLocaleString()) + '</div>';

    $("#scResults", root).innerHTML = html;
    renderScenarios(root, s, r.accounts);
  }

  function renderScenarios(root, s, current) {
    var el = $("#scScenarios", root); if (!el) return;
    var counts = LADDER.slice();
    if (counts.indexOf(current) === -1 && current > 0) counts.push(current);
    counts = counts.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });

    var html = '<h3 class="sc-h3" style="margin-top:0">Cost by number of accounts</h3>' +
      '<p class="sc-note" style="margin:-2px 0 12px">Same per-account assumptions, different account counts. <strong>Click any row to load it.</strong> Watch the per-account cost fall as the fixed pieces spread across more accounts.</p>';
    html += '<div class="sc-twrap"><table class="sc-table"><thead><tr>' +
      '<th>Accounts</th><th class="num">Emails / mo</th><th class="num">Email</th><th class="num">Signals</th>' +
      '<th class="num">Enrichment</th><th class="num">Voice</th><th class="num">Recurring / mo</th><th class="num">Per account</th><th class="num">Setup</th>' +
      '</tr></thead><tbody>';
    counts.forEach(function (n) {
      var c = compute(assign(s, "accounts", n));
      html += '<tr class="sc-row' + (n === current ? ' cur' : '') + '" data-n="' + n + '">' +
        '<td><strong>' + n + '</strong></td>' +
        '<td class="num">' + c.emails.toLocaleString() + '</td>' +
        '<td class="num">' + usd(c.emailCost) + '</td>' +
        '<td class="num">' + usd(c.signalRecurring) + '</td>' +
        '<td class="num">' + usd(c.enrichTotal) + '</td>' +
        '<td class="num">' + usd(c.voiceRecurring) + '</td>' +
        '<td class="num"><strong>' + usd(c.recurring) + '</strong></td>' +
        '<td class="num">' + usd(c.perAccount) + '</td>' +
        '<td class="num">' + (c.oneTime > 0 ? usd(c.oneTime) : '—') + '</td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
    el.innerHTML = html;

    $$(".sc-row", el).forEach(function (tr) {
      tr.addEventListener("click", function () {
        var inp = $('[data-sc="accounts"]', root);
        if (inp) { inp.value = Number(tr.dataset.n) || 1; recompute(root); }
        var res = $("#scResults", root);
        if (res && res.scrollIntoView) res.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  window.SpendingCalc = { mount: mount };
})();
