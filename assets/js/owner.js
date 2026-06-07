/* RecruiterOS · Owner Console (private, owner-only)
 *
 * The single-operator back office: business overview, pricing brain, unified
 * spend, full account control (see everyone, hard reset, delete), and the
 * editable cost model. Every call hits /api/owner/* which is walled to the
 * OWNER_EMAIL allow-list server-side; this script only renders what that allows.
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
  var ROUTES = { overview: viewOverview, pricing: viewPricing, spend: viewSpend, accounts: viewAccounts, costs: viewCosts };
  var TITLES = { overview: "Overview", pricing: "Pricing", spend: "Spend", accounts: "Accounts", costs: "Cost model" };
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
   * Cartesia cloned-voice. Fully client-side and live — every keystroke
   * recomputes. Inputs persist in localStorage so they survive navigation.
   * Real-world defaults (June 2026):
   *   TheirStack — 1 API credit = 1 job posting; ~$0.017/credit at Pro
   *                ($169 / 10k), down to ~$0.0015/credit at volume.
   *   Cartesia   — Startup $39/mo = 1.25M credits; IVC 1 credit/char (no
   *                training), Pro Voice Cloning = one-time 1M-credit train
   *                + 1.5 credits/char.
   */
  var CALC_DEFAULTS = {
    // scale — everything scales off the recruiter count
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

  /* Pure cost model — given a state, return every derived number. Reused by the
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

    // People Data Labs — person/phone enrichment (only successful matches billed).
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
    var html = '<div class="v-head"><h2>Projection · ' + esc(motionName()) + '</h2><p>Model what the stack will cost <em>before</em> you spend — the new sending system, TheirStack signals + People Data Labs enrichment, and Cartesia cloned voice. Everything scales off the recruiter count, so changing it re-derives the whole deploy (inboxes, domains, credits, voice) live. The table at the bottom compares different team sizes. Each operating system below keeps its own numbers; nothing here touches the ledger — it is a sandbox.</p></div>';

    // Operating-system tabs — the package is presented for both motions, each with its own saved inputs.
    html += '<div class="calc-motion" id="calcMotion">' +
      '<button class="cm" data-motion="recruiting">Recruiting OS</button>' +
      '<button class="cm" data-motion="bd">Business Development OS</button></div>';

    html += '<div class="calc-wrap"><div class="calc-inputs">';

    // Scale — recruiter-driven
    html += card("Recruiters & per-seat volume", "The whole model scales from here. Set the team size and what one recruiter runs per month; totals derive automatically.",
      grid(
        xin("Recruiters on the system", "recruiters", s.recruiters, 1, 0) +
        xin("Prospects / recruiter / mo", "prospectsPerRec", s.prospectsPerRec, 100, 0) +
        xin("Emails / recruiter / mo", "emailsPerRec", s.emailsPerRec, 500, 0) +
        xin("Voice recordings / recruiter / mo", "recordingsPerRec", s.recordingsPerRec, 50, 0)
      ) + '<div id="scaleOut" class="calc-readout"></div>');

    // Emailing system — counts auto-derive from send volume
    html += card("Emailing system", "Inboxes & domains auto-derive from send volume at a safe deliverability ceiling — this is how the system actually provisions. (Reseller mailbox ≈ $1.50–3/mo, throwaway domain ≈ $1/mo.)",
      grid(
        xin("Cost / inbox / mo ($)", "inboxCost", s.inboxCost, 0.5, 0) +
        xin("Cost / domain / mo ($)", "domainCost", s.domainCost, 0.5, 0) +
        xin("Sends / inbox / mo", "sendsPerInbox", s.sendsPerInbox, 50, 1) +
        xin("Inboxes / domain", "inboxesPerDomain", s.inboxesPerDomain, 1, 1) +
        xin("Platform / ESP flat ($/mo)", "esp", s.esp, 5, 0) +
        xin("API send cost ($ / 1k emails)", "perKSends", s.perKSends, 0.05, 0)
      ) + '<div id="emailOut" class="calc-readout"></div>');

    // TheirStack signals + People Data Labs enrichment
    html += card("Hiring signals · TheirStack + People Data Labs", "TheirStack: 1 API credit = 1 job posting, 3 = 1 company (~$0.017/credit at Pro $169/10k, ~$0.0015 at volume). People Data Labs: person/phone enrichment, only successful matches are billed (~$0.28/match Pro, ~$0.20–0.25 at volume). Set PDL matches to 0 to leave it out.",
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

    html += '<p class="note" style="margin-top:14px">Annualized: <strong>' + usd(r.recurring * 12) + '/yr</strong> recurring' + (r.oneTime > 0 ? ' + ' + usd(r.oneTime) + ' once' : '') + '. Recruiting OS and Business Development OS share the same unit costs — switch the tab above to model each with its own team size and volumes.</p>';

    $("#calcResults").innerHTML = html;

    // ---- scenario comparison: same per-seat assumptions, varied team size ----
    renderScenarios(full, r.recruiters);
  }

  function renderScenarios(full, current) {
    var el = $("#calcScenarios"); if (!el) return;
    var counts = CALC_LADDER.slice();
    if (counts.indexOf(current) === -1 && current > 0) counts.push(current);
    counts = counts.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });

    var html = '<h3>Cost by team size</h3><p class="note" style="margin:-2px 0 12px">Same per-recruiter assumptions, different headcount. <strong>Click any row to load it above.</strong> Your current size is highlighted — watch cost-per-recruiter fall as the fixed pieces (the voice plan, signal pack, domains) spread across more seats.</p>';
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
        '<td class="num">' + (c.oneTime > 0 ? usd(c.oneTime) : '—') + '</td>' +
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
      $("#view").innerHTML = html;
      $$("#view .clickrow").forEach(function (tr) { tr.addEventListener("click", function () { openAccount(tr.dataset.id); }); });
    }).catch(fail);
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
    if (!a.monthlyPriceUsd) return '<span class="note">—</span>';
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
      kv("Last active", a.lastActiveAt ? fmtDate(a.lastActiveAt) : "—") +
      kv("Active sessions", a.activeSessions) +
      kv("Price / mo", usd(a.monthlyPriceUsd)) +
      kv("Cost · " + esc(win), usd(a.costUsd)) +
      kv("Gross margin", a.monthlyPriceUsd ? pct(a.grossMarginPct) + " (" + usd(a.grossProfitUsd) + ")" : "—") +
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
    html += '<h3 style="font-size:13px;margin:16px 0 6px">Billing</h3>' +
      '<div class="calc">' +
      fld("Monthly price ($)", '<input id="dwPrice" type="number" min="0" step="10" value="' + (a.monthlyPriceUsd || 0) + '">') +
      fld("Tier label", '<input id="dwTier" type="text" value="' + esc(m.tier || "") + '">') +
      '</div>' +
      '<div class="fld" style="margin-top:10px"><label>Notes</label><input id="dwNotes" type="text" value="' + esc(m.notes || "") + '"></div>' +
      '<div class="btn-row"><a class="btn btn-primary btn-sm" id="dwSave">Save billing</a>' +
      '<a class="btn btn-sm" id="dwSuspend">' + (a.suspended ? "Unsuspend" : "Suspend") + '</a>' +
      '<a class="btn btn-sm" id="dwRevoke">Revoke sessions</a></div>';

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

  function wireDrawer(a) {
    var id = a.workspaceId;
    $("#dwClose").addEventListener("click", closeDrawer);
    $("#dwSave").addEventListener("click", function () {
      send("/owner/accounts/" + id, "PATCH", {
        monthlyPriceUsd: Number($("#dwPrice").value) || 0,
        tier: $("#dwTier").value, notes: $("#dwNotes").value
      }).then(function (res) { if (res.ok) { toast("Billing saved"); openAccount(id); refreshList(); } else toast("Save failed"); });
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

  function fail(status) {
    if (status === 401) { location.href = "/login"; return; }
    $("#view").innerHTML = '<div class="card"><p class="note">Could not load this view. ' + (status === 404 ? "Access restricted." : "Try again.") + '</p></div>';
  }

  boot();
})();
