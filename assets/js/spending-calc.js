/* RecruitersOS · Spending scenario planner (in-app, Business Development)
 *
 * A dynamic "what will my outreach cost" model anyone can play with from their
 * dashboard. Account-based: starts at ONE account (2,500 prospects × 3 emails =
 * 7,500/mo); add accounts or change any number to see how spend scales.
 *
 * Cost is organised by WHERE IT LIVES, three buckets:
 *   • Email outreach     = activity + sending + enrichment + message AI + signals
 *   • Voice outreach     = a LinkedIn-first reach funnel (see below) + cloned voice
 *   • LinkedIn outreach  = per-profile messaging seat + message AI
 *
 * VOICE FUNNEL (cheapest path first):
 *   Every target gets a LinkedIn connection request. The ~50% who ACCEPT get a
 *   cloned-voice NOTE on LinkedIn (no phone number, no Telnyx send, cheap). The
 *   ~50% who DON'T accept get a landline/VoIP enriched cheapest-first (Apify →
 *   Apollo); where we find a number (~40%), they get an AMD voicemail drop. This
 *   minimises the expensive enrichment + AMD path to only the non-connectors.
 *
 * Cost lines are deliberately GENERIC, real vendors/tools are never named where
 * a customer can see, only the function performed and an editable price.
 *
 * Mount with: window.SpendingCalc.mount(rootEl)
 */
(function () {
  "use strict";

  var KEY = "ros_spend_calc_v4";

  var DEFAULTS = {
    accounts: 1,
    // activity, emails derive from prospects × steps (2,500 × 3 = 7,500)
    prospectsPerAccount: 2500,
    stepsPerProspect: 3,
    // Email Sending (own inboxes + domains; counts auto-size to volume)
    inboxCost: 2.5, domainCost: 1.0, sendsPerInbox: 750, inboxesPerDomain: 3,
    // Email enrichment (find + verify, per prospect)
    emailFindCost: 0.006, emailVerifyCost: 0.001,
    // Message AI (writes each unique message), shared rate for email + LinkedIn
    emailChars: 2000, llmPer1k: 0.005,
    // Hiring Signals (per lookup + optional one-time data pack)
    signalCost: 0.017, signalSetup: 85, signalSetupOn: 1,
    // Voice reach funnel, LinkedIn-first, AMD fallback
    linkedinAcceptRate: 50,    // % of connection requests accepted → cloned-voice NOTE
    landlineFillRate: 40,      // % of non-accepters we find a landline/VoIP for (Apify→Apollo)
    landlineEnrichCost: 0.08,  // blended Apify → Apollo, per number FOUND
    lineCheckCost: 0.0025,     // Telnyx line-type check (landline/VoIP only)
    apolloPlan: 49,            // Apollo seat / mo (flat)
    // Cloned voice delivery (per touch synth + LLM script; AMD adds a 1-min send)
    voicePlan: 39, voiceSynthCost: 0.01, voiceLlmCost: 0.004, amdSendCost: 0.007,
    // LinkedIn outreach (per profile messaging seat + per-message AI)
    linkedinProfilesPerAccount: 1, linkedinPerProfile: 55, linkedinMsgsPerAccount: 500, linkedinChars: 2000
  };
  var LADDER = [1, 2, 3, 5, 10, 25, 50];

  /* ---------------- helpers ---------------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function usd(n, dp) { n = Number(n) || 0; if (dp != null) return "$" + n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }); return "$" + n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }); }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function clamp01(n) { return Math.min(1, Math.max(0, (Number(n) || 0) / 100)); }

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

    // --- Email outreach ---
    var inboxes = s.sendsPerInbox > 0 ? Math.ceil(emails / s.sendsPerInbox) : 0;
    var domains = s.inboxesPerDomain > 0 ? Math.ceil(inboxes / s.inboxesPerDomain) : 0;
    var emailSend = inboxes * s.inboxCost + domains * s.domainCost;
    var emailEnrich = prospects * (s.emailFindCost + s.emailVerifyCost);
    var emailLlm = emails * (s.emailChars / 1000) * s.llmPer1k;
    var signalRecurring = prospects * s.signalCost;
    var signalOneTime = s.signalSetupOn ? s.signalSetup : 0;
    var emailOutreach = emailSend + emailEnrich + emailLlm + signalRecurring;

    // --- Voice outreach (LinkedIn-first funnel) ---
    var voiceTargets = prospects;                                  // everyone is a voice target
    var liNotes = Math.round(voiceTargets * clamp01(s.linkedinAcceptRate));   // accepters → cloned voice NOTE
    var amdCand = Math.max(0, voiceTargets - liNotes);             // non-accepters
    var landFound = Math.round(amdCand * clamp01(s.landlineFillRate));        // Apify→Apollo finds a landline
    var amdDrops = landFound;                                      // AMD drop only where we have a number
    var landlineEnrich = landFound * (s.landlineEnrichCost + s.lineCheckCost);
    var noteCost = liNotes * (s.voiceSynthCost + s.voiceLlmCost);  // native LinkedIn, no send fee
    var amdCost = amdDrops * (s.voiceSynthCost + s.voiceLlmCost + s.amdSendCost);
    var voiceFlat = s.voicePlan + s.apolloPlan;                    // Cartesia + Apollo seats
    var voiceTouches = liNotes + amdDrops;
    var voiceReachPct = voiceTargets > 0 ? voiceTouches / voiceTargets : 0;
    var voiceOutreach = voiceFlat + landlineEnrich + noteCost + amdCost;

    // --- LinkedIn outreach (seat + message AI) ---
    var liProfiles = accounts * s.linkedinProfilesPerAccount;
    var liSeat = liProfiles * s.linkedinPerProfile;
    var liMsgs = accounts * s.linkedinMsgsPerAccount;
    var liLlm = liMsgs * (s.linkedinChars / 1000) * s.llmPer1k;
    var linkedinOutreach = liSeat + liLlm;

    var recurring = emailOutreach + voiceOutreach + linkedinOutreach;
    var oneTime = signalOneTime;
    return {
      accounts: accounts, prospects: prospects, emails: emails,
      inboxes: inboxes, domains: domains, emailSend: emailSend, emailEnrich: emailEnrich, emailLlm: emailLlm,
      signalRecurring: signalRecurring, signalOneTime: signalOneTime, emailOutreach: emailOutreach,
      voiceTargets: voiceTargets, liNotes: liNotes, amdCand: amdCand, landFound: landFound, amdDrops: amdDrops,
      landlineEnrich: landlineEnrich, noteCost: noteCost, amdCost: amdCost, voiceFlat: voiceFlat,
      voiceTouches: voiceTouches, voiceReachPct: voiceReachPct, voiceOutreach: voiceOutreach,
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
    html += '<div class="sc-head"><h2>Spending</h2><p>Model what your outreach will cost each month, start with one account and add more to see how it scales. Costs group by where they live: <strong>email</strong>, <strong>voice</strong>, and <strong>LinkedIn</strong>. Voice runs a LinkedIn-first funnel so the expensive enrichment + AMD path only hits the people who don\'t connect. Every number is editable.</p></div>';

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
    html += card("Email Enrichment & AI", "Finding + verifying each address, plus the AI that writes each message (per 1,000 characters, a 2,000-char email ≈ 2 units).",
      fld("Find / prospect ($)", "emailFindCost", s.emailFindCost, 0.001, 0) +
      fld("Verify / prospect ($)", "emailVerifyCost", s.emailVerifyCost, 0.001, 0) +
      fld("Characters / message", "emailChars", s.emailChars, 100, 0) +
      fld("AI ($ / 1k chars)", "llmPer1k", s.llmPer1k, 0.001, 0), "scEnrichRead");
    html += card("Hiring Signals", "Lookups that surface companies actively hiring. Priced per lookup, with an optional one-time data pack.",
      fld("Cost / lookup ($)", "signalCost", s.signalCost, 0.005, 0) +
      fld("One-time data pack ($)", "signalSetup", s.signalSetup, 5, 0) +
      fld("Include pack? (1 / 0)", "signalSetupOn", s.signalSetupOn, 1, 0));

    // ---- Voice outreach (LinkedIn-first funnel) ----
    html += section("Voice outreach, LinkedIn-first, AMD fallback");
    html += card("Voice reach funnel", "Everyone gets a LinkedIn connection request first. Accepters get a cloned-voice NOTE (no phone, no send fee). Non-accepters get a landline/VoIP found cheapest-first, then an AMD voicemail drop where a number exists.",
      fld("LinkedIn accept rate (%)", "linkedinAcceptRate", s.linkedinAcceptRate, 5, 0) +
      fld("Landline/VoIP fill (%)", "landlineFillRate", s.landlineFillRate, 5, 0), "scFunnelRead");
    html += card("Landline enrichment (cheapest-first)", "Direct landline/VoIP for the non-accepters, found via the cheap scraper waterfall first, then Apollo's API. A flat Apollo seat + a per-number-found cost; each found number is line-type checked so drops only go to landline/VoIP.",
      fld("Apollo seat ($/mo)", "apolloPlan", s.apolloPlan, 5, 0) +
      fld("Enrichment ($/found)", "landlineEnrichCost", s.landlineEnrichCost, 0.01, 0) +
      fld("Line-type check ($/number)", "lineCheckCost", s.lineCheckCost, 0.0005, 0), "scEnrich2Read");
    html += card("Cloned voice delivery", "Cloned-voice synthesis + the LLM that scripts each touch. LinkedIn notes send free (native); AMD drops add a ~1-minute Telnyx send.",
      fld("Voice plan ($/mo)", "voicePlan", s.voicePlan, 1, 0) +
      fld("Synthesis ($/touch)", "voiceSynthCost", s.voiceSynthCost, 0.005, 0) +
      fld("LLM script ($/touch)", "voiceLlmCost", s.voiceLlmCost, 0.001, 0) +
      fld("AMD send ($/drop, 1 min)", "amdSendCost", s.amdSendCost, 0.001, 0), "scDeliverRead");

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

    var fr = $("#scFunnelRead", root);
    if (fr) fr.innerHTML = '<strong>' + r.voiceTargets.toLocaleString() + '</strong> targets → <strong>' + r.liNotes.toLocaleString() +
      '</strong> LinkedIn notes (' + s.linkedinAcceptRate + '%) + <strong>' + r.amdCand.toLocaleString() + '</strong> non-accepters → <strong>' +
      r.landFound.toLocaleString() + '</strong> landlines (' + s.landlineFillRate + '%) → <strong>' + r.amdDrops.toLocaleString() +
      '</strong> AMD drops. Reached <strong>' + r.voiceTouches.toLocaleString() + '</strong> (' + Math.round(r.voiceReachPct * 100) + '%).';

    var e2 = $("#scEnrich2Read", root);
    if (e2) e2.innerHTML = '<strong>' + r.landFound.toLocaleString() + '</strong> found × (' + usd(s.landlineEnrichCost, 2) + ' + ' + usd(s.lineCheckCost, 4) +
      ') + Apollo ' + usd(s.apolloPlan) + ' = <strong>' + usd(r.landlineEnrich + s.apolloPlan) + '</strong>/mo';

    var dr = $("#scDeliverRead", root);
    if (dr) dr.innerHTML = 'Notes <strong>' + usd(r.noteCost) + '</strong> (no send) + AMD <strong>' + usd(r.amdCost) +
      '</strong> (incl. 1-min send) + plan ' + usd(s.voicePlan);

    var li = $("#scLiRead", root);
    if (li) li.innerHTML = '<strong>' + r.liProfiles.toLocaleString() + '</strong> profile' + (r.liProfiles === 1 ? '' : 's') + ' × ' + usd(s.linkedinPerProfile) +
      ' + AI on <strong>' + r.liMsgs.toLocaleString() + '</strong> msgs = <strong>' + usd(r.linkedinOutreach) + '</strong>/mo';

    var b = {};
    b["Email Sending"] = round2(r.emailSend);
    b["Email Enrich + AI"] = round2(r.emailEnrich + r.emailLlm);
    b["Hiring Signals"] = round2(r.signalRecurring);
    b["LinkedIn voice notes"] = round2(r.noteCost);
    b["AMD drops + enrichment"] = round2(r.amdCost + r.landlineEnrich);
    b["Voice + Apollo seats"] = round2(r.voiceFlat);
    b["LinkedIn messaging"] = round2(r.linkedinOutreach);

    var html = '<div class="sc-hero"><div class="sc-hl">Projected recurring · ' + r.accounts + ' account' + (r.accounts === 1 ? '' : 's') + '</div>' +
      '<div class="sc-hv">' + usd(r.recurring) + '<span>/mo</span></div>' +
      (r.oneTime > 0 ? '<div class="sc-hs">+ ' + usd(r.oneTime) + ' one-time setup</div>' : '') + '</div>';

    html += '<div class="sc-metrics">' +
      metric(usd(r.perAccount), "per account / mo") +
      metric(Math.round(r.voiceReachPct * 100) + "%", "voice-reached") +
      metric(usd(r.recurring * 12), "per year") + '</div>';

    html += '<h3 class="sc-h3">Cost buckets</h3><div class="sc-lines">' +
      tl("Email outreach", usd(r.emailOutreach) + " / mo") +
      tl("Voice outreach", usd(r.voiceOutreach) + " / mo") +
      tl("LinkedIn outreach", usd(r.linkedinOutreach) + " / mo") + '</div>';

    html += '<h3 class="sc-h3">Where it goes</h3>' + bars(b);

    html += '<h3 class="sc-h3">Voice funnel</h3><div class="sc-lines">' +
      tl("LinkedIn voice notes", r.liNotes.toLocaleString() + " (free send)") +
      tl("Landlines found → AMD drops", r.landFound.toLocaleString() + " of " + r.amdCand.toLocaleString()) +
      tl("Total voice-reached", r.voiceTouches.toLocaleString() + " of " + r.voiceTargets.toLocaleString()) + '</div>';

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
        '<td class="num">' + (c.oneTime > 0 ? usd(c.oneTime) : '-') + '</td>' +
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

  /* ===================================================================== *
   *  AI VETTING cost model (Recruiting motion)
   *
   *  A focused "what does an hour on the phone cost" calculator for the inbound
   *  AI Vetting agent. Only two cost drivers, exactly as scoped:
   *    • Cloned voice, Cartesia cost structure (per minute SPOKEN)
   *    • Telephony   , Telnyx (per call minute + number rental)
   *
   *  Key realism: across a 60-minute call the cloned voice only SPEAKS for part
   *  of it (the candidate talks the rest), so Cartesia is billed on ~20 of every
   *  60 minutes (editable). Telnyx bills the full 60. Everything is per-hour-first
   *  so you can read cost/hour straight off the hero. Optional STT+LLM and
   *  post-call scoring lines default to 0 to keep the model to the two drivers.
   *
   *  Mount with: window.SpendingCalc.mountVetting(rootEl)
   * ===================================================================== */
  var VKEY = "ros_vetting_cost_v1";
  var VDEFAULTS = {
    // Usage
    hoursPerMonth: 40,        // phone-hours/mo the desk(s) are on calls
    avgCallMin: 6,            // average vetting call length → derives calls/mo
    talkMinPerHour: 20,       // minutes the cloned voice actually SPEAKS per hour
    // Cloned voice, Cartesia
    cartesiaPlan: 0,          // flat plan $/mo (0 = pay-as-you-go)
    cartesiaPerMin: 0.025,    // $ per minute of generated (spoken) audio
    // Telephony, Telnyx
    telnyxPerMin: 0.007,      // $ per inbound call minute
    numberRental: 1.0,        // $ per number / mo
    numbers: 1,               // how many vetting numbers are live
    // Optional extras (off by default, the two drivers above are the spec)
    aiPerMin: 0,              // realtime STT+LLM $/min (whole call), if you include it
    scoringPerCall: 0         // post-call LLM scoring $ per call
  };
  var VLADDER = [10, 20, 40, 80, 160, 320];

  function vstate() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(VKEY) || "{}"); } catch (e) { s = {}; }
    var o = {};
    Object.keys(VDEFAULTS).forEach(function (k) { o[k] = s[k] != null ? s[k] : VDEFAULTS[k]; });
    return o;
  }
  function vsave(s) { try { localStorage.setItem(VKEY, JSON.stringify(s)); } catch (e) {} }
  function vassign(s, k, v) { var o = {}; Object.keys(s).forEach(function (x) { o[x] = s[x]; }); o[k] = v; return o; }

  function computeVetting(s) {
    var hours = Math.max(0, Number(s.hoursPerMonth) || 0);
    var avgCall = Math.max(0.1, Number(s.avgCallMin) || 0);
    var calls = (hours * 60) / avgCall;
    var talkMin = Math.min(60, Math.max(0, Number(s.talkMinPerHour) || 0)); // per hour
    var talkRatio = talkMin / 60;

    // ---- per ONE hour on the phone (the headline unit) ----
    var telnyxPerHour = 60 * s.telnyxPerMin;            // Telnyx bills every minute
    var cartesiaPerHour = talkMin * s.cartesiaPerMin;   // Cartesia only the spoken minutes
    var aiPerHour = 60 * s.aiPerMin;                    // optional STT+LLM, whole call
    var variablePerHour = telnyxPerHour + cartesiaPerHour + aiPerHour;

    // ---- monthly ----
    var voiceMonthly = cartesiaPerHour * hours;         // talkMin × hours × cartesiaPerMin
    var telnyxMinMonthly = telnyxPerHour * hours;
    var aiMonthly = aiPerHour * hours;
    var scoringMonthly = calls * s.scoringPerCall;
    var cartesiaPlanMonthly = Number(s.cartesiaPlan) || 0;
    var numberMonthly = (Number(s.numbers) || 0) * s.numberRental;

    var recurring = voiceMonthly + telnyxMinMonthly + aiMonthly + scoringMonthly + cartesiaPlanMonthly + numberMonthly;
    var fixedMonthly = cartesiaPlanMonthly + numberMonthly;
    var allInPerHour = hours > 0 ? recurring / hours : variablePerHour; // incl. fixed at this volume
    var perCall = calls > 0 ? recurring / calls : 0;
    var voiceMinPerMonth = talkMin * hours;

    return {
      hours: hours, calls: calls, avgCall: avgCall, talkMin: talkMin, talkRatio: talkRatio,
      telnyxPerHour: telnyxPerHour, cartesiaPerHour: cartesiaPerHour, aiPerHour: aiPerHour,
      variablePerHour: variablePerHour, allInPerHour: allInPerHour, perCall: perCall,
      voiceMonthly: voiceMonthly, telnyxMinMonthly: telnyxMinMonthly, aiMonthly: aiMonthly,
      scoringMonthly: scoringMonthly, cartesiaPlanMonthly: cartesiaPlanMonthly, numberMonthly: numberMonthly,
      fixedMonthly: fixedMonthly, recurring: recurring, voiceMinPerMonth: voiceMinPerMonth
    };
  }

  function mountVetting(root) {
    if (!root) return;
    var s = vstate();

    var html = '<div class="sc">';
    html += '<div class="sc-head"><h2>Spending</h2><p>What the <strong>AI Vetting</strong> agent costs to run, modelled per <strong>hour on the phone</strong>. Two drivers only: your <strong>cloned voice</strong> (Cartesia, billed per minute spoken) and <strong>telephony</strong> (Telnyx, billed per call minute). Across a 60-minute call the agent only <em>speaks</em> for part of it, the candidate talks the rest, so Cartesia is billed on ~20 of every 60 minutes. Every number is editable.</p></div>';

    html += '<div class="sc-wrap"><div class="sc-inputs">';

    html += section("Usage");
    html += card("Call volume", "How much time the desk(s) spend on calls. Calls per month are derived from the average call length.",
      fld("Phone-hours / month", "hoursPerMonth", s.hoursPerMonth, 5, 0) +
      fld("Avg call length (min)", "avgCallMin", s.avgCallMin, 1, 0.5) +
      fld("Cloned voice speaks / hour (min)", "talkMinPerHour", s.talkMinPerHour, 1, 0), "vcUsageRead");

    html += section("Cloned voice, Cartesia");
    html += card("Cartesia voice", "Cost to synthesize your cloned voice. Billed only on the minutes the agent actually speaks (≈ talk time per hour). Per-minute is plan-dependent, edit to match your Cartesia tier.",
      fld("Plan ($/mo, 0 = PAYG)", "cartesiaPlan", s.cartesiaPlan, 5, 0) +
      fld("Voice ($ / min spoken)", "cartesiaPerMin", s.cartesiaPerMin, 0.005, 0), "vcVoiceRead");

    html += section("Telephony, Telnyx");
    html += card("Telnyx calls & numbers", "Inbound call minutes (every minute of the call) plus the monthly rental for each live vetting number.",
      fld("Inbound ($ / call min)", "telnyxPerMin", s.telnyxPerMin, 0.001, 0) +
      fld("Number rental ($/mo)", "numberRental", s.numberRental, 0.25, 0) +
      fld("Live numbers", "numbers", s.numbers, 1, 0), "vcTelnyxRead");

    html += section("Optional extras (off by default)");
    html += card("Realtime AI & scoring", "Not part of the two headline drivers, leave at 0 to model voice + telephony only. STT+LLM is the live speech-to-text/brain per call minute; scoring is the one post-call analysis pass.",
      fld("Realtime STT+LLM ($ / min)", "aiPerMin", s.aiPerMin, 0.005, 0) +
      fld("Post-call scoring ($ / call)", "scoringPerCall", s.scoringPerCall, 0.005, 0), "vcExtrasRead");

    html += '<div class="sc-btnrow"><button class="sc-reset" id="vcReset">Reset to defaults</button></div>';
    html += '</div>'; // /sc-inputs

    html += '<div class="sc-results" id="vcResults"></div>';
    html += '</div>'; // /sc-wrap

    html += '<div class="sc-card" id="vcScenarios" style="margin-top:18px"></div>';
    html += '</div>'; // /sc

    root.innerHTML = html;

    $$("[data-sc]", root).forEach(function (inp) {
      inp.addEventListener("input", function () { recomputeVetting(root); });
      inp.addEventListener("change", function () { recomputeVetting(root); });
    });
    $("#vcReset", root).addEventListener("click", function () {
      try { localStorage.removeItem(VKEY); } catch (e) {}
      mountVetting(root);
    });
    recomputeVetting(root);
  }

  function recomputeVetting(root) {
    var s = vstate();
    $$("[data-sc]", root).forEach(function (inp) { s[inp.dataset.sc] = Number(inp.value) || 0; });
    vsave(s);
    var r = computeVetting(s);

    var u = $("#vcUsageRead", root);
    if (u) u.innerHTML = '<strong>' + r.hours.toLocaleString() + '</strong> hrs/mo → <strong>' + Math.round(r.calls).toLocaleString() +
      '</strong> calls (' + r.avgCall + ' min avg) · voice speaks <strong>' + r.talkMin + '</strong> of every 60 min (' + Math.round(r.talkRatio * 100) + '%)';

    var vv = $("#vcVoiceRead", root);
    if (vv) vv.innerHTML = '<strong>' + r.talkMin + '</strong> min/hr × ' + usd(s.cartesiaPerMin, 3) + ' = <strong>' + usd(r.cartesiaPerHour, 2) +
      '</strong>/hr · <strong>' + Math.round(r.voiceMinPerMonth).toLocaleString() + '</strong> spoken min/mo = <strong>' + usd(r.voiceMonthly) + '</strong>/mo';

    var vt = $("#vcTelnyxRead", root);
    if (vt) vt.innerHTML = '60 min × ' + usd(s.telnyxPerMin, 4) + ' = <strong>' + usd(r.telnyxPerHour, 2) + '</strong>/hr + ' +
      (Number(s.numbers) || 0) + ' number' + ((Number(s.numbers) || 0) === 1 ? '' : 's') + ' × ' + usd(s.numberRental) + ' = <strong>' + usd(r.numberMonthly) + '</strong>/mo rental';

    var ve = $("#vcExtrasRead", root);
    if (ve) ve.innerHTML = (r.aiPerHour + r.scoringMonthly) > 0
      ? 'STT+LLM <strong>' + usd(r.aiPerHour, 2) + '</strong>/hr + scoring <strong>' + usd(r.scoringMonthly) + '</strong>/mo'
      : 'Excluded, modelling Cartesia + Telnyx only.';

    // Per-hour breakdown bars
    var b = {};
    b["Telephony (Telnyx, 60 min)"] = round2(r.telnyxPerHour);
    b["Cloned voice (Cartesia, " + r.talkMin + " min)"] = round2(r.cartesiaPerHour);
    if (r.aiPerHour > 0) b["Realtime STT+LLM"] = round2(r.aiPerHour);

    var html = '<div class="sc-hero"><div class="sc-hl">Cost per hour on the phone</div>' +
      '<div class="sc-hv">' + usd(r.variablePerHour, 2) + '<span>/hr</span></div>' +
      '<div class="sc-hs">' + usd(r.allInPerHour, 2) + '/hr all-in at ' + r.hours.toLocaleString() + ' hrs/mo (incl. plan + number rental)</div></div>';

    html += '<div class="sc-metrics">' +
      metric(usd(r.perCall, 2), "per vetting call") +
      metric(usd(r.recurring), "per month") +
      metric(usd(r.recurring * 12), "per year") + '</div>';

    html += '<h3 class="sc-h3">Per-hour breakdown</h3>' + bars(b);

    html += '<h3 class="sc-h3">Monthly cost</h3><div class="sc-lines">' +
      tl("Cloned voice (Cartesia)", usd(r.voiceMonthly + r.cartesiaPlanMonthly) + " / mo") +
      tl("Telephony minutes (Telnyx)", usd(r.telnyxMinMonthly) + " / mo") +
      tl("Number rental (Telnyx)", usd(r.numberMonthly) + " / mo") +
      ((r.aiMonthly + r.scoringMonthly) > 0 ? tl("Realtime AI + scoring", usd(r.aiMonthly + r.scoringMonthly) + " / mo") : "") +
      tl("Total recurring", usd(r.recurring) + " / mo") + '</div>';

    $("#vcResults", root).innerHTML = html;
    renderVettingScenarios(root, s, r.hours);
  }

  function renderVettingScenarios(root, s, current) {
    var el = $("#vcScenarios", root); if (!el) return;
    var counts = VLADDER.slice();
    if (counts.indexOf(current) === -1 && current > 0) counts.push(current);
    counts = counts.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });

    var html = '<h3 class="sc-h3" style="margin-top:0">Cost by phone-hours per month</h3>' +
      '<p class="sc-note" style="margin:-2px 0 12px">Same per-hour assumptions, different monthly volumes. <strong>Click any row to load it.</strong> Per-hour all-in falls as the plan + number rental spread across more hours.</p>';
    html += '<div class="sc-twrap"><table class="sc-table"><thead><tr>' +
      '<th>Hours / mo</th><th class="num">Calls / mo</th><th class="num">Cloned voice</th><th class="num">Telephony</th>' +
      '<th class="num">Recurring / mo</th><th class="num">All-in / hr</th><th class="num">Per call</th>' +
      '</tr></thead><tbody>';
    counts.forEach(function (n) {
      var c = computeVetting(vassign(s, "hoursPerMonth", n));
      html += '<tr class="sc-row' + (n === current ? ' cur' : '') + '" data-n="' + n + '">' +
        '<td><strong>' + n + '</strong></td>' +
        '<td class="num">' + Math.round(c.calls).toLocaleString() + '</td>' +
        '<td class="num">' + usd(c.voiceMonthly + c.cartesiaPlanMonthly) + '</td>' +
        '<td class="num">' + usd(c.telnyxMinMonthly + c.numberMonthly) + '</td>' +
        '<td class="num"><strong>' + usd(c.recurring) + '</strong></td>' +
        '<td class="num">' + usd(c.allInPerHour, 2) + '</td>' +
        '<td class="num">' + usd(c.perCall, 2) + '</td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
    el.innerHTML = html;

    $$(".sc-row", el).forEach(function (tr) {
      tr.addEventListener("click", function () {
        var inp = $('[data-sc="hoursPerMonth"]', root);
        if (inp) { inp.value = Number(tr.dataset.n) || 0; recomputeVetting(root); }
        var res = $("#vcResults", root);
        if (res && res.scrollIntoView) res.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  window.SpendingCalc = { mount: mount, mountVetting: mountVetting };
})();
