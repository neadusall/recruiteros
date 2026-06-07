/* RecruitersOS · Spending scenario planner (in-app, Business Development)
 *
 * A dynamic "what will my outreach cost" model anyone can play with from their
 * dashboard. Account-based: starts at ONE account (2,500 prospects × 3 emails =
 * 7,500/mo); add accounts or change any number to see how spend scales.
 *
 * Cost is organised by WHERE IT LIVES — three buckets:
 *   • Email outreach     = activity + sending + enrichment + message AI + signals
 *   • Voice outreach     = direct-dial enrichment (confirmed) + cloned voice
 *   • LinkedIn outreach  = per-profile messaging + message AI
 *
 * Direct dials are PDL-only by design: free/cheap sources can't confirm a number
 * is the person's own line (often a switchboard), so we only count confirmed,
 * person-attributed dials at the premium rate, scaled by a find rate.
 *
 * Cost lines are deliberately GENERIC — real vendors/tools are never named where
 * a customer can see, only the function performed and an editable price.
 *
 * Mount with: window.SpendingCalc.mount(rootEl)
 */
(function () {
  "use strict";

  var KEY = "ros_spend_calc_v3";

  var DEFAULTS = {
    accounts: 1,
    // activity — emails derive from prospects × steps (2,500 × 3 = 7,500)
    prospectsPerAccount: 2500,
    stepsPerProspect: 3,
    // Email Sending (own inboxes + domains; counts auto-size to volume)
    inboxCost: 2.5, domainCost: 1.0, sendsPerInbox: 750, inboxesPerDomain: 3,
    // Email enrichment (find + verify, per prospect)
    emailFindCost: 0.006, emailVerifyCost: 0.001,
    // Message AI (writes each unique message) — shared rate for email + LinkedIn
    emailChars: 2000, llmPer1k: 0.005,
    // Hiring Signals (per lookup + optional one-time data pack)
    signalCost: 0.017, signalSetup: 85, signalSetupOn: 1,
    // Direct Phone Numbers (PDL-only, confirmed): wanted × find rate → found
    phonePerAccount: 500, phoneFindRate: 35, phoneFoundCost: 0.10, phoneCheckCost: 0.0025,
    // Cloned Voice (plan + per-drop synthesis + LLM script + 1-min send)
    voicePerAccount: 200, voicePlan: 39, voiceSynthCost: 0.01, voiceLlmCost: 0.004, voiceSendCost: 0.007,
    // LinkedIn outreach (per profile messaging + per-message AI)
    linkedinProfilesPerAccount: 1, linkedinPerProfile: 55, linkedinMsgsPerAccount: 500, linkedinChars: 2000
  };
  var LADDER = [1, 2, 3, 5, 10, 25, 50];

  /* ---------------- helpers ---------------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function usd(n, dp) { n = Number(n) || 0; if (dp != null) return "$" + n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }); return "$" + n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }); }
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
    var emails = prospects * s.stepsPerProspect;
    var voice = accounts * s.voicePerAccount;

    // --- Email outreach ---
    var inboxes = s.sendsPerInbox > 0 ? Math.ceil(emails / s.sendsPerInbox) : 0;
    var domains = s.inboxesPerDomain > 0 ? Math.ceil(inboxes / s.inboxesPerDomain) : 0;
    var emailSend = inboxes * s.inboxCost + domains * s.domainCost;
    var emailEnrich = prospects * (s.emailFindCost + s.emailVerifyCost);
    var emailLlm = emails * (s.emailChars / 1000) * s.llmPer1k;   // AI writes each message
    var signalRecurring = prospects * s.signalCost;
    var signalOneTime = s.signalSetupOn ? s.signalSetup : 0;
    var emailOutreach = emailSend + emailEnrich + emailLlm + signalRecurring;

    // --- Voice outreach ---
    // Direct dials are PDL-only & confirmed: you pay $0.10 per number FOUND,
    // misses are free, find rate models PDL's coverage of your contacts.
    var phoneWanted = accounts * s.phonePerAccount;
    var phoneRate = Math.min(1, Math.max(0, (s.phoneFindRate || 0) / 100));
    var phoneFound = Math.round(phoneWanted * phoneRate);
    var phoneLookup = phoneFound * s.phoneFoundCost;
    var phoneCheck = phoneFound * s.phoneCheckCost;   // line-type check (drop to landline/VoIP only)
    var phoneEnrich = phoneLookup + phoneCheck;
    var phoneBlended = phoneWanted > 0 ? phoneEnrich / phoneWanted : 0;
    // Each drop = synthesis + LLM script + 1-min send.
    var voicePerDrop = s.voiceSynthCost + s.voiceLlmCost + s.voiceSendCost;
    var voiceRecurring = s.voicePlan + voice * voicePerDrop;
    var voiceOutreach = phoneEnrich + voiceRecurring;

    // --- LinkedIn outreach ---
    var liProfiles = accounts * s.linkedinProfilesPerAccount;
    var liSeat = liProfiles * s.linkedinPerProfile;
    var liMsgs = accounts * s.linkedinMsgsPerAccount;
    var liLlm = liMsgs * (s.linkedinChars / 1000) * s.llmPer1k;
    var linkedinOutreach = liSeat + liLlm;

    var recurring = emailOutreach + voiceOutreach + linkedinOutreach;
    var oneTime = signalOneTime;
    return {
      accounts: accounts, prospects: prospects, emails: emails, voice: voice,
      inboxes: inboxes, domains: domains, emailSend: emailSend, emailEnrich: emailEnrich, emailLlm: emailLlm,
      signalRecurring: signalRecurring, signalOneTime: signalOneTime, emailOutreach: emailOutreach,
      phoneWanted: phoneWanted, phoneFound: phoneFound, phoneEnrich: phoneEnrich, phoneBlended: phoneBlended,
      voiceRecurring: voiceRecurring, voiceOutreach: voiceOutreach,
      liProfiles: liProfiles, liSeat: liSeat, liMsgs: liMsgs, liLlm: liLlm, linkedinOutreach: linkedinOutreach,
      recurring: recurring, oneTime: oneTime,
      perAccount: accounts > 0 ? recurring / accounts : 0,
      perEmail: emails > 0 ? recurring / emails : 0
    };
  }

  /* ---------------- markup helpers ---------------- */
  function card(title, sub, inner, readoutId) {
    return '<div class="sc-card"><h3>' + esc(title) + '</h3>' + (sub ? '<p class="sc-note" style="margin:-2px 0 12px">' + esc(sub) + '</p>' : '') +
      '<div class="sc-grid">' + inner + '</div>' + (readoutId ? '<div id="' + readoutId + '" class="sc-readout"></div>' : '') + '</div>';
  }
  function section(t) { return '<div class="sc-section">' + esc(t) + '</div>'; }
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
    html += '<div class="sc-head"><h2>Spending</h2><p>Model what your outreach will cost each month — start with one account and add more to see how it scales. Costs group by where they live: <strong>email</strong>, <strong>voice</strong>, and <strong>LinkedIn</strong> outreach. Every number is editable; the table at the bottom compares account counts. Live what-if sandbox.</p></div>';

    html += '<div class="sc-accounts">' +
      '<div class="sc-acc-ctl"><button class="sc-step" data-acc="-1">−</button>' +
      '<input data-sc="accounts" type="number" min="1" step="1" value="' + s.accounts + '">' +
      '<button class="sc-step" data-acc="1">+</button>' +
      '<button class="sc-add" id="scAddAcct">+ Add account</button></div>' +
      '<div class="sc-acc-read" id="scAccRead"></div></div>';

    html += '<div class="sc-wrap"><div class="sc-inputs">';

    // ---- Email outreach ----
    html += section("Email outreach");
    html += card("Email Sending", "Activity and the sending cost it drives. Emails = prospects × steps; inboxes & domains auto-size to that volume.",
      fld("Prospects / mo", "prospectsPerAccount", s.prospectsPerAccount, 50, 0) +
      fld("Emails per prospect (steps)", "stepsPerProspect", s.stepsPerProspect, 1, 1) +
      fld("Cost / inbox / mo ($)", "inboxCost", s.inboxCost, 0.5, 0) +
      fld("Cost / domain / mo ($)", "domainCost", s.domainCost, 0.5, 0) +
      fld("Sends / inbox / mo", "sendsPerInbox", s.sendsPerInbox, 50, 1) +
      fld("Inboxes / domain", "inboxesPerDomain", s.inboxesPerDomain, 1, 1), "scEmailRead");
    html += card("Email Enrichment & AI", "Finding + verifying each address, plus the AI that writes each message (per 1,000 characters — a 2,000-char email ≈ 2 units).",
      fld("Find / prospect ($)", "emailFindCost", s.emailFindCost, 0.001, 0) +
      fld("Verify / prospect ($)", "emailVerifyCost", s.emailVerifyCost, 0.001, 0) +
      fld("Characters / email msg", "emailChars", s.emailChars, 100, 0) +
      fld("AI ($ / 1k chars)", "llmPer1k", s.llmPer1k, 0.001, 0), "scEnrichRead");
    html += card("Hiring Signals", "Lookups that surface companies actively hiring. Priced per lookup, with an optional one-time data pack.",
      fld("Cost / lookup ($)", "signalCost", s.signalCost, 0.005, 0) +
      fld("One-time data pack ($)", "signalSetup", s.signalSetup, 5, 0) +
      fld("Include pack? (1 / 0)", "signalSetupOn", s.signalSetupOn, 1, 0));

    // ---- Voice outreach ----
    html += section("Voice outreach");
    html += card("Direct Phone Numbers", "Confirmed, person-attributed direct dials — paid per number FOUND (misses are free). Find rate models how many of your contacts have a findable direct line. Each found number is line-type checked so drops only go to landline / VoIP.",
      fld("Numbers wanted / mo", "phonePerAccount", s.phonePerAccount, 50, 0) +
      fld("Find rate (%)", "phoneFindRate", s.phoneFindRate, 5, 0) +
      fld("Cost / number found ($)", "phoneFoundCost", s.phoneFoundCost, 0.01, 0) +
      fld("Line-type check ($/number)", "phoneCheckCost", s.phoneCheckCost, 0.0005, 0), "scPhoneRead");
    html += card("Cloned Voice", "AI voicemail drops in a cloned voice. Flat monthly plan + per drop: voice synthesis, the LLM that writes the script, and a ~1-minute send.",
      fld("Voice drops / mo", "voicePerAccount", s.voicePerAccount, 25, 0) +
      fld("Plan / mo ($)", "voicePlan", s.voicePlan, 1, 0) +
      fld("Synthesis ($/drop)", "voiceSynthCost", s.voiceSynthCost, 0.005, 0) +
      fld("LLM script ($/drop)", "voiceLlmCost", s.voiceLlmCost, 0.001, 0) +
      fld("Send ($/drop, 1 min)", "voiceSendCost", s.voiceSendCost, 0.001, 0), "scVoiceRead");

    // ---- LinkedIn outreach ----
    html += section("LinkedIn outreach");
    html += card("LinkedIn Messaging", "Automated connection + messaging per connected profile, billed per profile per month, plus the AI that writes each message.",
      fld("Profiles / account", "linkedinProfilesPerAccount", s.linkedinProfilesPerAccount, 1, 0) +
      fld("Cost / profile / mo ($)", "linkedinPerProfile", s.linkedinPerProfile, 0.5, 0) +
      fld("Messages / account / mo", "linkedinMsgsPerAccount", s.linkedinMsgsPerAccount, 50, 0) +
      fld("Characters / message", "linkedinChars", s.linkedinChars, 100, 0), "scLiRead");

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
        inp.value = Math.max(1, (Number(inp.value) || 1) + Number(b.dataset.acc)); recompute(root);
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
      r.prospects.toLocaleString() + '</strong> prospects · <strong>' + r.emails.toLocaleString() + '</strong> emails / mo';

    var er = $("#scEmailRead", root);
    if (er) er.innerHTML = '<strong>' + r.emails.toLocaleString() + '</strong> emails → <strong>' + r.inboxes.toLocaleString() +
      '</strong> inboxes · <strong>' + r.domains.toLocaleString() + '</strong> domains = <strong>' + usd(r.emailSend) + '</strong>/mo sending';

    var enr = $("#scEnrichRead", root);
    if (enr) enr.innerHTML = 'Find+verify <strong>' + usd(r.emailEnrich) + '</strong> + message AI <strong>' + usd(r.emailLlm) +
      '</strong> (' + r.emails.toLocaleString() + ' msgs × ' + s.emailChars + ' chars)';

    var pr = $("#scPhoneRead", root);
    if (pr) pr.innerHTML = 'Of <strong>' + r.phoneWanted.toLocaleString() + '</strong> wanted, ≈<strong>' + r.phoneFound.toLocaleString() +
      '</strong> found @ ' + usd(s.phoneFoundCost, 2) + ' = <strong>' + usd(r.phoneEnrich) + '</strong> → blended <strong>' + usd(r.phoneBlended, 3) + '</strong>/contact';

    var vr = $("#scVoiceRead", root);
    if (vr) vr.innerHTML = '<strong>' + usd(s.voicePlan) + '</strong> plan + <strong>' + r.voice.toLocaleString() + '</strong> drops × (' +
      usd(s.voiceSynthCost, 3) + ' synth + ' + usd(s.voiceLlmCost, 3) + ' LLM + ' + usd(s.voiceSendCost, 3) + ' send) = <strong>' + usd(r.voiceRecurring) + '</strong>/mo';

    var li = $("#scLiRead", root);
    if (li) li.innerHTML = '<strong>' + r.liProfiles.toLocaleString() + '</strong> profile' + (r.liProfiles === 1 ? '' : 's') + ' × ' + usd(s.linkedinPerProfile) +
      ' + AI on <strong>' + r.liMsgs.toLocaleString() + '</strong> msgs = <strong>' + usd(r.linkedinOutreach) + '</strong>/mo';

    var b = {};
    b["Email Sending"] = round2(r.emailSend);
    b["Email Enrich + AI"] = round2(r.emailEnrich + r.emailLlm);
    b["Hiring Signals"] = round2(r.signalRecurring);
    b["Direct Phone (confirmed)"] = round2(r.phoneEnrich);
    b["Cloned Voice"] = round2(r.voiceRecurring);
    b["LinkedIn"] = round2(r.linkedinOutreach);

    var html = '<div class="sc-hero"><div class="sc-hl">Projected recurring · ' + r.accounts + ' account' + (r.accounts === 1 ? '' : 's') + '</div>' +
      '<div class="sc-hv">' + usd(r.recurring) + '<span>/mo</span></div>' +
      (r.oneTime > 0 ? '<div class="sc-hs">+ ' + usd(r.oneTime) + ' one-time setup</div>' : '') + '</div>';

    html += '<div class="sc-metrics">' +
      metric(usd(r.perAccount), "per account / mo") +
      metric(usd(r.perEmail, 4), "per email") +
      metric(usd(r.recurring * 12), "per year") + '</div>';

    html += '<h3 class="sc-h3">Cost buckets</h3><div class="sc-lines">' +
      tl("Email outreach", usd(r.emailOutreach) + " / mo") +
      tl("Voice outreach", usd(r.voiceOutreach) + " / mo") +
      tl("LinkedIn outreach", usd(r.linkedinOutreach) + " / mo") + '</div>';

    html += '<h3 class="sc-h3">Where it goes</h3>' + bars(b);

    html += '<h3 class="sc-h3">At a glance</h3><div class="sc-lines">' +
      tl("Emails / mo", r.emails.toLocaleString()) +
      tl("Sending inboxes", r.inboxes.toLocaleString() + " · " + r.domains.toLocaleString() + " domains") +
      tl("Direct dials found", r.phoneFound.toLocaleString() + " of " + r.phoneWanted.toLocaleString() + " (" + usd(r.phoneBlended, 3) + "/ea)") +
      tl("Voice drops", r.voice.toLocaleString()) +
      tl("LinkedIn profiles", r.liProfiles.toLocaleString()) + '</div>';

    $("#scResults", root).innerHTML = html;
    renderScenarios(root, s, r.accounts);
  }

  function renderScenarios(root, s, current) {
    var el = $("#scScenarios", root); if (!el) return;
    var counts = LADDER.slice();
    if (counts.indexOf(current) === -1 && current > 0) counts.push(current);
    counts = counts.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });

    var html = '<h3 class="sc-h3" style="margin-top:0">Cost by number of accounts</h3>' +
      '<p class="sc-note" style="margin:-2px 0 12px">Same per-account assumptions, different account counts. <strong>Click any row to load it.</strong> Per-account cost falls as fixed pieces spread across more accounts.</p>';
    html += '<div class="sc-twrap"><table class="sc-table"><thead><tr>' +
      '<th>Accounts</th><th class="num">Emails / mo</th><th class="num">Email</th><th class="num">Voice</th><th class="num">LinkedIn</th>' +
      '<th class="num">Recurring / mo</th><th class="num">Per account</th><th class="num">Setup</th>' +
      '</tr></thead><tbody>';
    counts.forEach(function (n) {
      var c = compute(assign(s, "accounts", n));
      html += '<tr class="sc-row' + (n === current ? ' cur' : '') + '" data-n="' + n + '">' +
        '<td><strong>' + n + '</strong></td>' +
        '<td class="num">' + c.emails.toLocaleString() + '</td>' +
        '<td class="num">' + usd(c.emailOutreach) + '</td>' +
        '<td class="num">' + usd(c.voiceOutreach) + '</td>' +
        '<td class="num">' + usd(c.linkedinOutreach) + '</td>' +
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
