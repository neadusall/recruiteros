/*
 * RecruitersOS · LinkedIn OS (the unified LinkedIn tool)
 *
 * One LinkedIn product with two contextual entrances: Business Development >
 * Tools > LinkedIn and Recruiting > Build > LinkedIn. Same engine, same
 * accounts, same ledger, same utilization; only the default context differs.
 * The SPA route "linkedin" (renderLinkedInOs in command.js) is a thin
 * controller over window.__LinkedInOS; every action flows through
 * /api/linkedin/os and the shared engine behind it.
 */
(function () {
  "use strict";
  if (!document.body || !document.body.classList.contains("app")) return;

  /* ---------------- session / api (mirrors command.js) ---------------- */
  var IMP_TOKEN = null;
  try { IMP_TOKEN = sessionStorage.getItem("ros_imp_token") || null; } catch (e) {}

  var API = (window.RECRUITEROS_API_BASE || "") + "/api/linkedin/os";
  function headers(extra) {
    var h = extra || {};
    if (IMP_TOKEN) h["Authorization"] = "Bearer " + IMP_TOKEN;
    return h;
  }
  function apiGet(qs) {
    return fetch(API + qs, { credentials: "include", headers: headers() })
      .then(function (r) { if (!r.ok) throw new Error("api_" + r.status); return r.json(); });
  }
  function act(action, payload) {
    var body = payload || {};
    body.action = action;
    return fetch(API, {
      method: "POST", credentials: "include",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error((j && j.error) || ("api_" + r.status)); e.body = j; throw e; }
        return j;
      });
    });
  }

  /* ---------------- tiny dom + format helpers ---------------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }
  function toastMsg(t) {
    var n = document.getElementById("toast");
    if (!n) return;
    n.textContent = t;
    n.classList.add("show");
    setTimeout(function () { n.classList.remove("show"); }, 2400);
  }
  function ago(iso) {
    if (!iso) return "";
    var s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return Math.floor(s) + "s";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    return Math.floor(s / 86400) + "d";
  }
  function when(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  function title(s) {
    s = String(s || "").replace(/_/g, " ");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function pct(n) { return Math.max(0, Math.min(100, Math.round(n))); }

  var HEALTH_PILL = { healthy: "green", watch: "amber", elevated: "amber", cooldown: "red", paused: "red", disconnected: "red" };
  var PRESSURE_PILL = { low: "green", medium: "", elevated: "amber", high: "red" };
  var STATUS_PILL = {
    success: "green", submitted: "green", scheduled: "", queued: "", processing: "",
    capacity_pending: "amber", retry_pending: "amber", paused: "amber",
    failed: "red", cancelled: "", suppressed: "red", requested: "", reserved: ""
  };
  function pill(text, tone) {
    return '<span class="pill ' + (tone || "") + '">' + esc(text) + "</span>";
  }
  function statusPill(status) { return pill(title(status), STATUS_PILL[status] || ""); }

  var CAT_LABEL = {
    connections: "Connections", messages: "Messages", voice_notes: "Voice Notes",
    inmails: "InMail", profile_views: "Profile Views", interactions: "Interactions"
  };
  var ACTION_LABEL = {
    connect: "Connect", connect_note: "Connect with note", message: "Message",
    voice_note: "Voice note", inmail: "InMail", attachment: "Attachment",
    profile_view: "View profile", endorse: "Endorse", like_post: "Like post",
    comment_post: "Comment", withdraw_invite: "Withdraw invite"
  };

  /* ---------------- module state ---------------- */
  var S = {
    root: null,
    motion: "bd",
    tab: "overview",
    sub: "",
    account: "",       // selected account for utilization/limits
    inboxFilter: "all",
    inboxSel: null,
    peopleFilter: "",
    voiceTab: "templates",
    recorder: null,
    recChunks: [],
    wizard: null,
    timers: []
  };
  function bu() { return S.motion === "recruiting" ? "recruiting" : "bd"; }
  function later(fn, ms) { S.timers.push(setTimeout(fn, ms)); }
  function clearTimers() { S.timers.forEach(clearTimeout); S.timers = []; }

  var TABS = [
    ["overview", "Overview"], ["campaigns", "Campaigns"], ["inbox", "Inbox"],
    ["people", "People"], ["voice", "Voice Notes"], ["accounts", "Accounts"],
    ["utilization", "Utilization"], ["limits", "Limits & Policies"]
  ];

  /* ---------------- shell ---------------- */
  function render(view, opts) {
    clearTimers();
    S.root = view;
    S.motion = (opts && opts.motion) || "bd";
    var parts = (location.hash || "").replace(/^#/, "").split("/");
    if (parts[0] === "bd" || parts[0] === "recruiting") parts.shift();
    S.tab = parts[1] || "overview";
    S.sub = parts[2] || "";
    if (!TABS.some(function (t) { return t[0] === S.tab; })) S.tab = "overview";

    var tabsHtml = TABS.map(function (t) {
      return '<a class="vd-tab' + (S.tab === t[0] ? " active" : "") + '" href="#linkedin/' + t[0] + '">' + esc(t[1]) + "</a>";
    }).join("");
    view.innerHTML =
      '<div class="v-head"><p>Unified LinkedIn outreach across RecruitersOS. One shared engine, one set of account policies, one ledger for ' +
      (S.motion === "recruiting" ? "Recruiting and Business Development" : "Business Development and Recruiting") + ".</p></div>" +
      '<div class="vd-tabs lio-tabs">' + tabsHtml + "</div>" +
      '<div id="lioBody" class="lio-body"><div class="empty">Loading LinkedIn OS...</div></div>';

    var body = view.querySelector("#lioBody");
    var fn = {
      overview: tabOverview, campaigns: tabCampaigns, inbox: tabInbox,
      people: tabPeople, voice: tabVoice, accounts: tabAccounts,
      utilization: tabUtilization, limits: tabLimits
    }[S.tab];
    fn(body);
  }

  function fail(body, e) {
    body.innerHTML = '<div class="empty">Could not load this view (' + esc(e && e.message || "error") + "). Retry from the tab bar.</div>";
  }

  /* ================= OVERVIEW ================= */
  function tabOverview(body) {
    apiGet("?view=overview&bu=" + bu()).then(function (d) {
      var a = d.account;
      var u = d.utilization;
      var kpis =
        '<div class="lio-kpis">' +
        kpi("Account", a ? a.displayName : "None connected", a ? "" : "Connect one in Accounts") +
        kpi("Utilization", u ? u.utilizationPct + "%" : "0%", "of RecruitersOS daily targets") +
        kpi("Queued", String(d.counters.queued), "actions in the LinkedIn queue") +
        kpi("Replies", String(d.counters.needsAttention), "conversations need attention") +
        kpi("Health", a ? title(a.health) : "No account", a && a.healthReason ? a.healthReason : "", a ? HEALTH_PILL[a.health] : "") +
        "</div>";

      var bars = "";
      if (u) {
        bars = '<div class="card lio-card"><div class="lio-card-t">Shared LinkedIn utilization <span class="lio-hint" title="These are RecruitersOS utilization policies for this account, not limits LinkedIn publishes or guarantees.">?</span></div>' +
          u.categories.filter(function (c) { return ["connections", "messages", "voice_notes", "inmails"].indexOf(c.category) >= 0; })
            .map(function (c) { return utilBar(c); }).join("") +
          '<div class="lio-split">' +
          '<span>Recruiting <b>' + u.recruitingPct + "%</b> of current allocation</span>" +
          '<span>Business Development <b>' + u.bdPct + "%</b> of current allocation</span>" +
          '<span>Available capacity <b>' + u.availablePct + "%</b></span>" +
          "</div></div>";
      }

      var camps = d.campaigns.slice(0, 6).map(function (c) {
        return '<a class="lio-row" href="#linkedin/campaigns/' + esc(c.id) + '">' +
          '<div><b>' + esc(c.name) + "</b><div class='lio-dim'>" +
          (c.type === "recruiting" ? "Recruiting" : "BD") + " · " + title(c.priority) +
          (c.waitingCapacity ? " · Waiting " + c.waitingCapacity : "") + "</div></div>" +
          '<div class="lio-right">' + pill(title(c.status), c.status === "running" ? "green" : "") +
          '<div class="lio-dim">' + c.people + " people · " + c.replyRate + "% reply</div></div></a>";
      }).join("") || '<div class="empty">No campaigns yet. Create one from the Campaigns tab.</div>';

      var queue = d.queue.map(function (q) {
        return '<div class="lio-row lio-row-sm"><div>' +
          (q.at ? '<span class="lio-mono">' + esc(when(q.at)) + "</span> " : "") +
          esc(ACTION_LABEL[q.actionType] || title(q.actionType)) + " → " + esc(q.personName) +
          "</div><div>" + statusPill(q.status) + "</div></div>";
      }).join("") || '<div class="empty">The LinkedIn queue is empty.</div>';

      var feed = d.feed.map(function (f) {
        return '<div class="lio-row lio-row-sm"><div>' + esc(f.text) + '</div><div class="lio-dim">' + esc(f.tag) + " · " + ago(f.at) + "</div></div>";
      }).join("") || '<div class="empty">No recent LinkedIn activity.</div>';

      body.innerHTML = kpis + bars +
        '<div class="lio-cols">' +
        '<div class="card lio-card"><div class="lio-card-t">Active campaigns</div>' + camps + "</div>" +
        '<div class="card lio-card"><div class="lio-card-t">Live LinkedIn queue <a class="lio-link" href="#linkedin/utilization">View queue</a></div>' + queue + "</div>" +
        "</div>" +
        '<div class="card lio-card"><div class="lio-card-t">Recent activity</div>' + feed + "</div>";
    }).catch(function (e) { fail(body, e); });
  }
  function kpi(label, value, sub, tone) {
    return '<div class="lio-kpi"><div class="lio-kpi-l">' + esc(label) + "</div>" +
      '<div class="lio-kpi-v">' + (tone ? pill(value, tone) : esc(value)) + "</div>" +
      (sub ? '<div class="lio-kpi-s">' + esc(sub) + "</div>" : "") + "</div>";
  }
  function utilBar(c) {
    var total = Math.max(1, c.hardCeiling);
    var usedPct = pct((c.used / total) * 100);
    var resPct = pct((c.reserved / total) * 100);
    return '<div class="lio-bar-row"><div class="lio-bar-l">' + esc(CAT_LABEL[c.category] || c.category) + "</div>" +
      '<div class="lio-bar"><span class="lio-bar-used" style="width:' + usedPct + '%"></span>' +
      '<span class="lio-bar-res" style="width:' + resPct + '%"></span>' +
      '<span class="lio-bar-target" style="left:' + pct((c.effectiveTarget / total) * 100) + '%"></span></div>' +
      '<div class="lio-bar-n">' + c.used + " used / " + c.reserved + " reserved · target " + c.effectiveTarget + " · ceiling " + c.hardCeiling + "</div></div>";
  }

  /* ================= CAMPAIGNS ================= */
  function tabCampaigns(body) {
    if (S.sub && S.sub !== "new") return campaignDetail(body, S.sub);
    apiGet("?view=campaigns").then(function (d) {
      var enrByCampaign = {};
      d.enrollments.forEach(function (e) {
        (enrByCampaign[e.campaignId] = enrByCampaign[e.campaignId] || []).push(e);
      });
      var rows = d.campaigns
        .filter(function (c) { return c.status !== "archived"; })
        .map(function (c) {
          var ce = enrByCampaign[c.id] || [];
          var waiting = ce.filter(function (e) { return e.status === "waiting_capacity"; }).length;
          return "<tr data-id='" + esc(c.id) + "'><td><b>" + esc(c.name) + "</b>" +
            (c.entity && c.entity.name ? "<div class='lio-dim'>" + esc(c.entity.kind + ": " + c.entity.name) + "</div>" : "") + "</td>" +
            "<td>" + (c.type === "recruiting" ? "Recruiting" : "BD") + "</td>" +
            "<td>" + pill(title(c.status), c.status === "running" ? "green" : c.status === "paused" ? "amber" : "") + "</td>" +
            "<td>" + ce.length + "</td>" +
            "<td>" + title(c.priority) + " · w" + c.weight + "</td>" +
            "<td>" + (waiting ? pill("Waiting " + waiting, "amber") : "Dynamic") + "</td>" +
            "<td class='lio-actions'>" +
            (c.status === "running"
              ? "<button class='btn btn-sm btn-ghost' data-op='pause'>Pause</button>"
              : "<button class='btn btn-sm btn-ghost' data-op='start'>Start</button>") +
            "<button class='btn btn-sm btn-ghost' data-op='open'>Open</button></td></tr>";
        }).join("");
      body.innerHTML =
        '<div class="lio-toolbar"><div class="lio-dim">LinkedIn-only campaigns run on the same shared engine and account policies as multichannel workflows.</div>' +
        '<button class="btn btn-primary" id="lioNewCampaign">+ New Campaign</button></div>' +
        (rows
          ? '<div class="card lio-card lio-tablewrap"><table class="lio-table"><thead><tr>' +
            "<th>Name</th><th>Type</th><th>Status</th><th>People</th><th>Priority</th><th>Capacity</th><th></th>" +
            "</tr></thead><tbody>" + rows + "</tbody></table></div>"
          : '<div class="empty">No LinkedIn campaigns yet. Create the first one; the default context here is ' +
            (bu() === "recruiting" ? "Recruiting (candidates)" : "Business Development (prospects and decision makers)") + ".</div>");
      body.querySelector("#lioNewCampaign").onclick = function () { openWizard(body); };
      Array.prototype.forEach.call(body.querySelectorAll("tr[data-id] button"), function (b) {
        b.onclick = function () {
          var id = b.closest("tr").getAttribute("data-id");
          var op = b.getAttribute("data-op");
          if (op === "open") { location.hash = "#linkedin/campaigns/" + id; return; }
          act("campaign_control", { id: id, op: op }).then(function () {
            toastMsg(op === "pause" ? "Campaign paused" : "Campaign running");
            tabCampaigns(body);
          }).catch(function (e) { toastMsg("Failed: " + e.message); });
        };
      });
      if (S.sub === "new") openWizard(body);
    }).catch(function (e) { fail(body, e); });
  }

  function campaignDetail(body, id) {
    apiGet("?view=campaign&id=" + encodeURIComponent(id)).then(function (d) {
      var c = d.campaign;
      var steps = c.steps.map(function (s, i) {
        return '<div class="lio-step"><span class="lio-step-n">' + (i + 1) + "</span>" +
          "<b>" + esc(s.label || title(s.type)) + "</b>" +
          (s.hours ? '<span class="lio-dim">' + s.hours + "h" + (s.maxHours ? " to " + s.maxHours + "h" : "") + "</span>" : "") +
          (s.text ? '<div class="lio-dim lio-clip">' + esc(s.text) + "</div>" : "") + "</div>";
      }).join("") || '<div class="empty">No steps.</div>';
      var enr = d.enrollments.map(function (e) {
        return "<tr><td class='lio-mono'>" + esc(e.personIdentityId.slice(-6)) + "</td>" +
          "<td>" + pill(title(e.status), e.status === "active" ? "green" : /paused|waiting/.test(e.status) ? "amber" : "") + "</td>" +
          "<td>Step " + (e.stepIndex + 1) + " of " + c.steps.length + "</td>" +
          "<td>" + (e.nextRunAt ? when(e.nextRunAt) : "") + "</td>" +
          "<td>" + (e.stopReason ? esc(e.stopReason) : "") + "</td>" +
          "<td>" + (["completed", "stopped", "failed"].indexOf(e.status) < 0
            ? "<button class='btn btn-sm btn-ghost' data-enr='" + esc(e.id) + "'>Stop</button>" : "") + "</td></tr>";
      }).join("");
      body.innerHTML =
        '<div class="lio-toolbar"><a class="btn btn-sm btn-ghost" href="#linkedin/campaigns">&larr; Campaigns</a>' +
        "<div><b>" + esc(c.name) + "</b> " + pill(title(c.status), c.status === "running" ? "green" : "") +
        ' <span class="lio-dim">' + (c.type === "recruiting" ? "Recruiting" : "BD") + " · " + title(c.priority) + " · account " + esc(c.accountId) + "</span></div>" +
        "<span></span>" +
        (c.status === "running"
          ? '<button class="btn btn-ghost" id="lioCtl" data-op="pause">Pause</button>'
          : '<button class="btn btn-primary" id="lioCtl" data-op="start">Start</button>') + "</div>" +
        '<div class="lio-cols">' +
        '<div class="card lio-card"><div class="lio-card-t">Sequence</div>' + steps + "</div>" +
        '<div class="card lio-card"><div class="lio-card-t">People (' + d.enrollments.length + ')</div>' +
        (enr ? '<div class="lio-tablewrap"><table class="lio-table"><thead><tr><th>Person</th><th>Status</th><th>Step</th><th>Next</th><th>Note</th><th></th></tr></thead><tbody>' + enr + "</tbody></table></div>"
          : '<div class="empty">Nobody enrolled yet.</div>') + "</div></div>";
      body.querySelector("#lioCtl").onclick = function () {
        act("campaign_control", { id: c.id, op: this.getAttribute("data-op") }).then(function () { campaignDetail(body, id); });
      };
      Array.prototype.forEach.call(body.querySelectorAll("[data-enr]"), function (b) {
        b.onclick = function () {
          act("enrollment_status", { id: b.getAttribute("data-enr"), status: "stopped" })
            .then(function () { campaignDetail(body, id); });
        };
      });
    }).catch(function (e) { fail(body, e); });
  }

  /* ---------------- campaign wizard ---------------- */
  var WIZ_STEPS = ["Campaign", "Audience", "Sequence", "Voice", "Schedule", "Utilization", "Review"];
  var STEP_MENU = [
    ["view_profile", "View profile"], ["connect", "Connect"], ["connect_note", "Connect with note"],
    ["wait", "Wait"], ["wait_random", "Randomized wait"], ["wait_until_accepted", "Wait until accepted"],
    ["message", "LinkedIn message"], ["voice_note", "LinkedIn voice note"], ["inmail", "InMail"],
    ["like_post", "Like post"], ["comment_post", "Comment"], ["if_else", "Replied anywhere? (branch)"],
    ["wait_for_reply", "Wait for reply"], ["manual_task", "Manual task"], ["add_tag", "Add tag"],
    ["move_stage", "Move stage"], ["notify_user", "Notify user"], ["stop", "Stop campaign"]
  ];
  var RECRUITING_ENTITIES = ["Job", "Search", "Client", "Talent Pool"];
  var BD_ENTITIES = ["Company List", "Market", "Industry", "Prospect List", "Signal Batch", "Territory"];

  function defaultWizard() {
    return {
      step: 0,
      name: "", type: bu(), accountId: "", entityKind: "", entityName: "",
      priority: "normal", weight: 30, objective: "", owner: "",
      audienceText: "", people: [],
      steps: [
        { type: "view_profile", label: "View profile" },
        { type: "wait", hours: 24, label: "Wait 1 day" },
        { type: "connect_note", text: "Hi {first_name}, keen to connect.", label: "Connect with note" },
        { type: "wait_until_accepted", timeoutDays: 21, label: "Wait until accepted" },
        { type: "wait_random", hours: 4, maxHours: 12, label: "Wait 4 to 12 hours" },
        { type: "message", text: "Thanks for connecting, {first_name}.", label: "LinkedIn message" }
      ],
      voiceApproval: "review_first_10",
      startDate: "", endDate: "", dailyEnrollTarget: 25,
      capacity: null
    };
  }

  function openWizard(listBody) {
    S.wizard = defaultWizard();
    apiGet("?view=accounts").then(function (d) {
      S.wizard.accounts = d.accounts || [];
      if (S.wizard.accounts.length) S.wizard.accountId = S.wizard.accounts[0].accountId;
      drawWizard(listBody);
    }).catch(function () { S.wizard.accounts = []; drawWizard(listBody); });
  }

  function drawWizard(listBody) {
    var w = S.wizard;
    var old = document.getElementById("lioWiz");
    if (old) old.remove();
    var crumbs = WIZ_STEPS.map(function (s, i) {
      return '<span class="lio-wstep' + (i === w.step ? " active" : i < w.step ? " done" : "") + '">' + (i + 1) + ". " + s + "</span>";
    }).join("");
    var m = el('<div class="modal-bg" id="lioWiz"><div class="modal-card lio-wiz">' +
      '<div class="lio-wiz-head"><b>New LinkedIn campaign</b><button class="modal-x" id="lioWizX">&times;</button></div>' +
      '<div class="lio-wsteps">' + crumbs + "</div>" +
      '<div class="lio-wiz-body" id="lioWizBody"></div>' +
      '<div class="modal-foot lio-wiz-foot">' +
      '<button class="btn btn-ghost" id="lioWizBack"' + (w.step === 0 ? " disabled" : "") + ">Back</button>" +
      '<button class="btn btn-primary" id="lioWizNext">' + (w.step === WIZ_STEPS.length - 1 ? "Launch with dynamic scheduling" : "Continue") + "</button>" +
      "</div></div></div>");
    document.body.appendChild(m);
    m.querySelector("#lioWizX").onclick = function () { m.remove(); S.wizard = null; };
    m.querySelector("#lioWizBack").onclick = function () { if (w.step > 0) { collectWizard(m); w.step--; drawWizard(listBody); } };
    m.querySelector("#lioWizNext").onclick = function () {
      collectWizard(m);
      if (w.step === WIZ_STEPS.length - 1) { launchWizard(m, listBody); return; }
      if (w.step === 0 && !w.name.trim()) { toastMsg("Give the campaign a name"); return; }
      w.step++;
      if (w.step === 5) prefetchCapacity(listBody);
      drawWizard(listBody);
    };
    drawWizardStep(m.querySelector("#lioWizBody"), listBody);
  }

  function collectWizard(m) {
    var w = S.wizard, q = function (id) { var n = m.querySelector(id); return n ? n.value : null; };
    if (w.step === 0) {
      w.name = q("#wName") || w.name; w.type = q("#wType") || w.type;
      w.accountId = q("#wAccount") || w.accountId;
      w.entityKind = q("#wEntityKind") || ""; w.entityName = q("#wEntityName") || "";
      w.priority = q("#wPriority") || w.priority; w.objective = q("#wObjective") || "";
      w.owner = q("#wOwner") || "";
    }
    if (w.step === 1) { w.audienceText = q("#wAudience") || ""; w.people = parseAudience(w.audienceText); }
    if (w.step === 3) {
      var sel = m.querySelector("input[name=wVoice]:checked");
      if (sel) w.voiceApproval = sel.value;
    }
    if (w.step === 4) {
      w.startDate = q("#wStart") || ""; w.endDate = q("#wEnd") || "";
      w.dailyEnrollTarget = parseInt(q("#wDrip") || "25", 10) || 25;
    }
    if (w.step === 5) {
      w.priority = q("#wPriority2") || w.priority;
      w.weight = parseInt(q("#wWeight") || "30", 10) || 30;
    }
  }

  function parseAudience(text) {
    return String(text || "").split(/\n+/).map(function (line) {
      line = line.trim();
      if (!line) return null;
      var parts = line.split(/[|,;\t]/).map(function (p) { return p.trim(); });
      var person = {};
      parts.forEach(function (p) {
        if (/linkedin\.com\//i.test(p)) person.linkedinUrl = p;
        else if (/@/.test(p)) person.email = p;
        else if (!person.fullName) person.fullName = p;
        else if (!person.company) person.company = p;
        else if (!person.title) person.title = p;
      });
      if (!person.fullName && person.linkedinUrl) {
        var mSlug = person.linkedinUrl.match(/\/in\/([^/?#]+)/i);
        person.fullName = mSlug ? decodeURIComponent(mSlug[1]).replace(/-/g, " ") : "LinkedIn contact";
      }
      return (person.linkedinUrl || person.email) ? person : null;
    }).filter(Boolean);
  }

  function drawWizardStep(bodyEl, listBody) {
    var w = S.wizard;
    if (w.step === 0) {
      var entities = (w.type === "recruiting" ? RECRUITING_ENTITIES : BD_ENTITIES);
      bodyEl.innerHTML =
        row("Campaign name", '<input id="wName" class="lio-input" value="' + esc(w.name) + '" placeholder="VP Sales Search">') +
        row("Campaign type", '<select id="wType" class="lio-input"><option value="bd"' + (w.type === "bd" ? " selected" : "") + ">Business Development</option><option value=\"recruiting\"" + (w.type === "recruiting" ? " selected" : "") + ">Recruiting</option></select>") +
        row("LinkedIn account", w.accounts && w.accounts.length
          ? '<select id="wAccount" class="lio-input">' + w.accounts.map(function (a) {
              return '<option value="' + esc(a.accountId) + '"' + (a.accountId === w.accountId ? " selected" : "") + ">" + esc(a.displayName) + "</option>";
            }).join("") + "</select>"
          : '<div class="lio-dim">No account connected yet. Add one under Accounts; the campaign can still be drafted.</div><input id="wAccount" type="hidden" value="default">') +
        row("Associated entity", '<div class="lio-2col"><select id="wEntityKind" class="lio-input"><option value="">None</option>' +
          entities.map(function (x) { return '<option' + (w.entityKind === x ? " selected" : "") + ">" + x + "</option>"; }).join("") +
          '</select><input id="wEntityName" class="lio-input" placeholder="Name" value="' + esc(w.entityName) + '"></div>') +
        row("Priority", prioritySelect("wPriority", w.priority)) +
        row("Objective", '<input id="wObjective" class="lio-input" value="' + esc(w.objective) + '" placeholder="Book qualified conversations">') +
        row("Owner", '<input id="wOwner" class="lio-input" value="' + esc(w.owner) + '" placeholder="Owner name">');
      var typeSel = bodyEl.querySelector("#wType");
      typeSel.onchange = function () { w.type = typeSel.value; collectWizard(document.getElementById("lioWiz")); drawWizard(listBody); };
    }
    if (w.step === 1) {
      bodyEl.innerHTML =
        '<div class="lio-dim" style="margin-bottom:8px">Paste one person per line: LinkedIn URL, or "Name | Company | URL". ' +
        (w.type === "recruiting" ? "These enroll as candidates." : "These enroll as prospects and decision makers.") +
        " Before enrollment the engine checks duplicates, existing campaigns, replies, suppression and contact pressure.</div>" +
        '<textarea id="wAudience" class="lio-input lio-area" rows="10" placeholder="Sarah Miller | Acme | https://www.linkedin.com/in/sarahmiller">' + esc(w.audienceText) + "</textarea>" +
        '<div class="lio-dim" id="wAudN">' + w.people.length + " people parsed</div>";
      bodyEl.querySelector("#wAudience").oninput = function () {
        var n = parseAudience(this.value).length;
        bodyEl.querySelector("#wAudN").textContent = n + " people parsed";
      };
    }
    if (w.step === 2) drawSequenceEditor(bodyEl);
    if (w.step === 3) {
      bodyEl.innerHTML =
        '<div class="lio-dim" style="margin-bottom:10px">How should AI personalized voice notes go out for this campaign?</div>' +
        voiceRadio("automated", "Fully automated", "Voice notes generate and send without review.", w) +
        voiceRadio("review_first_10", "Review first 10", "You approve the first 10 generated voice notes, then automation takes over.", w) +
        voiceRadio("manual", "Manual approval required", "Every voice note waits in the approval queue.", w) +
        '<div class="lio-dim" style="margin-top:10px">Manage recordings and AI voice templates in the Voice Notes tab.</div>';
    }
    if (w.step === 4) {
      bodyEl.innerHTML =
        row("Start date", '<input id="wStart" type="date" class="lio-input" value="' + esc(w.startDate) + '">') +
        row("End date", '<input id="wEnd" type="date" class="lio-input" value="' + esc(w.endDate) + '">') +
        row("New people per business day", '<input id="wDrip" type="number" min="1" max="500" class="lio-input" value="' + w.dailyEnrollTarget + '">') +
        '<div class="lio-dim">Activation is dynamic: the engine only starts as many people as channel capacity responsibly allows each day.</div>';
    }
    if (w.step === 5) {
      var c = w.capacity;
      bodyEl.innerHTML =
        row("Priority", prioritySelect("wPriority2", w.priority)) +
        row("Allocation weight", '<input id="wWeight" type="number" min="1" max="100" class="lio-input" value="' + w.weight + '">') +
        '<div class="card lio-card" style="margin-top:10px"><div class="lio-card-t">LinkedIn capacity check</div>' +
        (c ? capCheckHtml(c, w.people.length) : '<div class="lio-dim">Checking capacity...</div>') + "</div>";
      if (!c) prefetchCapacity(listBody);
    }
    if (w.step === 6) {
      var cc = w.capacity;
      bodyEl.innerHTML =
        '<div class="lio-review">' +
        rv("Campaign", w.name + " (" + (w.type === "recruiting" ? "Recruiting" : "Business Development") + ")") +
        rv("Account", w.accountId || "default") +
        rv("Audience", w.people.length + " people") +
        rv("Sequence", w.steps.length + " steps") +
        rv("Voice approval", { automated: "Fully automated", review_first_10: "Review first 10", manual: "Manual approval" }[w.voiceApproval]) +
        rv("Priority / weight", title(w.priority) + " / " + w.weight) +
        rv("Slow drip", w.dailyEnrollTarget + " new people per business day") +
        "</div>" +
        (cc && !cc.fitsToday
          ? '<div class="lio-note">This campaign cannot consume all requested LinkedIn actions today. RecruitersOS will slow-drip it based on available capacity; nothing exceeds the account policy.</div>'
          : '<div class="lio-note lio-note-ok">Capacity is available for the first sends today. Pacing and randomized timing still apply.</div>');
    }
  }
  function row(label, control) {
    return '<div class="lio-frow"><label>' + esc(label) + "</label>" + control + "</div>";
  }
  function rv(label, value) {
    return '<div class="lio-rv"><span>' + esc(label) + "</span><b>" + esc(value) + "</b></div>";
  }
  function prioritySelect(id, cur) {
    return '<select id="' + id + '" class="lio-input">' + ["critical", "high", "normal", "low"].map(function (p) {
      return '<option value="' + p + '"' + (cur === p ? " selected" : "") + ">" + title(p) + "</option>";
    }).join("") + "</select>";
  }
  function voiceRadio(v, label, sub, w) {
    return '<label class="lio-radio"><input type="radio" name="wVoice" value="' + v + '"' + (w.voiceApproval === v ? " checked" : "") + "><div><b>" + label + "</b><div class='lio-dim'>" + sub + "</div></div></label>";
  }
  function capCheckHtml(c, demand) {
    return '<div class="lio-rv"><span>Connection requests</span><b>' + c.used + " / " + c.target + " target used</b></div>" +
      '<div class="lio-rv"><span>Reserved</span><b>' + c.reserved + "</b></div>" +
      '<div class="lio-rv"><span>Available before target</span><b>' + c.availableBeforeTarget + "</b></div>" +
      '<div class="lio-rv"><span>Available before hard ceiling</span><b>' + c.availableBeforeCeiling + "</b></div>" +
      '<div class="lio-rv"><span>Estimated campaign demand</span><b>' + demand + "</b></div>";
  }
  function prefetchCapacity(listBody) {
    var w = S.wizard;
    act("capacity_check", { accountId: w.accountId || "default", demand: w.people.length })
      .then(function (c) { w.capacity = c; var m = document.getElementById("lioWiz"); if (m && w.step === 5) drawWizardStep(m.querySelector("#lioWizBody"), listBody); })
      .catch(function () {});
  }

  function drawSequenceEditor(bodyEl) {
    var w = S.wizard;
    var items = w.steps.map(function (s, i) {
      var needsText = ["connect_note", "message", "inmail", "comment_post"].indexOf(s.type) >= 0;
      var isWait = ["wait", "wait_random"].indexOf(s.type) >= 0;
      return '<div class="lio-sedit" data-i="' + i + '">' +
        '<div class="lio-sedit-h"><span class="lio-step-n">' + (i + 1) + "</span><b>" +
        esc((STEP_MENU.filter(function (x) { return x[0] === s.type; })[0] || [s.type, title(s.type)])[1]) + "</b>" +
        '<span class="lio-sedit-btns">' +
        '<button class="btn btn-sm btn-ghost" data-mv="-1" title="Move up">&uarr;</button>' +
        '<button class="btn btn-sm btn-ghost" data-mv="1" title="Move down">&darr;</button>' +
        '<button class="btn btn-sm btn-ghost" data-del="1" title="Remove">&times;</button></span></div>' +
        (needsText ? '<textarea class="lio-input lio-area" rows="2" data-f="text" placeholder="Message with {first_name} variables">' + esc(s.text || "") + "</textarea>" : "") +
        (s.type === "voice_note" ? '<input class="lio-input" data-f="voiceAssetId" placeholder="Voice asset id (Voice Notes tab)" value="' + esc(s.voiceAssetId || "") + '">' : "") +
        (isWait ? '<div class="lio-2col"><input class="lio-input" type="number" min="0" data-f="hours" placeholder="Hours" value="' + (s.hours || 0) + '">' +
          (s.type === "wait_random" ? '<input class="lio-input" type="number" min="0" data-f="maxHours" placeholder="Max hours" value="' + (s.maxHours || 0) + '">' : "<span></span>") + "</div>" : "") +
        (s.type === "wait_until_accepted" ? '<input class="lio-input" type="number" min="1" data-f="timeoutDays" placeholder="Give up after days" value="' + (s.timeoutDays || 21) + '">' : "") +
        (s.type === "if_else" || s.type === "wait_for_reply"
          ? '<div class="lio-dim">Condition: replied anywhere. ' + (s.type === "if_else" ? "Yes ends the campaign for that person by default; No continues to the next step." : "Continues after the wait if no reply.") + "</div>" : "") +
        (s.type === "add_tag" ? '<input class="lio-input" data-f="tag" placeholder="Tag" value="' + esc(s.tag || "") + '">' : "") +
        (s.type === "move_stage" ? '<input class="lio-input" data-f="stage" placeholder="Stage (queued, nurture, ...)" value="' + esc(s.stage || "") + '">' : "") +
        "</div>";
    }).join("");
    bodyEl.innerHTML =
      '<div class="lio-2col lio-seqwrap"><div class="lio-seqlist">' + (items || '<div class="empty">No steps. Add from the right.</div>') + "</div>" +
      '<div class="lio-seqmenu"><div class="lio-card-t">Add step</div>' +
      STEP_MENU.map(function (x) { return '<button class="btn btn-sm btn-ghost lio-addstep" data-t="' + x[0] + '">' + x[1] + "</button>"; }).join("") +
      "</div></div>";
    Array.prototype.forEach.call(bodyEl.querySelectorAll(".lio-addstep"), function (b) {
      b.onclick = function () {
        var t = b.getAttribute("data-t");
        var s = { type: t, label: (STEP_MENU.filter(function (x) { return x[0] === t; })[0] || [])[1] };
        if (t === "wait") s.hours = 24;
        if (t === "wait_random") { s.hours = 4; s.maxHours = 12; }
        if (t === "wait_until_accepted") s.timeoutDays = 21;
        w.steps.push(s);
        drawSequenceEditor(bodyEl);
      };
    });
    Array.prototype.forEach.call(bodyEl.querySelectorAll(".lio-sedit"), function (card) {
      var i = parseInt(card.getAttribute("data-i"), 10);
      Array.prototype.forEach.call(card.querySelectorAll("[data-f]"), function (inp) {
        inp.onchange = function () {
          var f = inp.getAttribute("data-f");
          w.steps[i][f] = inp.type === "number" ? parseFloat(inp.value) || 0 : inp.value;
        };
      });
      Array.prototype.forEach.call(card.querySelectorAll("[data-mv]"), function (b) {
        b.onclick = function () {
          var d = parseInt(b.getAttribute("data-mv"), 10), j = i + d;
          if (j < 0 || j >= w.steps.length) return;
          var tmp = w.steps[i]; w.steps[i] = w.steps[j]; w.steps[j] = tmp;
          drawSequenceEditor(bodyEl);
        };
      });
      var delBtn = card.querySelector("[data-del]");
      if (delBtn) delBtn.onclick = function () { w.steps.splice(i, 1); drawSequenceEditor(bodyEl); };
    });
  }

  function launchWizard(modal, listBody) {
    var w = S.wizard;
    var btn = modal.querySelector("#lioWizNext");
    btn.disabled = true; btn.textContent = "Launching...";
    act("campaign_save", {
      campaign: {
        name: w.name || "Untitled LinkedIn campaign",
        type: w.type,
        accountId: w.accountId || "default",
        entity: w.entityKind ? { kind: w.entityKind, name: w.entityName } : undefined,
        priority: w.priority,
        weight: w.weight,
        objective: w.objective,
        ownerName: w.owner,
        steps: w.steps,
        voiceApproval: w.voiceApproval,
        schedule: { startDate: w.startDate || undefined, endDate: w.endDate || undefined },
        dailyEnrollTarget: w.dailyEnrollTarget
      }
    }).then(function (d) {
      var id = d.campaign.id;
      var enroll = w.people.length
        ? act("campaign_enroll", { campaignId: id, people: w.people })
        : Promise.resolve({ enrolled: 0, skipped: [], conflicts: [] });
      return enroll.then(function (res) {
        return act("campaign_control", { id: id, op: "start" }).then(function () { return res; });
      });
    }).then(function (res) {
      modal.remove(); S.wizard = null;
      var msg = "Campaign launched";
      if (res.enrolled) msg += ": " + res.enrolled + " enrolled";
      if (res.conflicts && res.conflicts.length) msg += ", " + res.conflicts.length + " conflicts need review";
      if (res.skipped && res.skipped.length) msg += ", " + res.skipped.length + " skipped";
      toastMsg(msg);
      location.hash = "#linkedin/campaigns";
      tabCampaigns(listBody);
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = "Launch with dynamic scheduling";
      toastMsg("Launch failed: " + e.message);
    });
  }

  /* ================= INBOX ================= */
  var INBOX_FILTERS = [
    ["all", "All"], ["attention", "Needs Attention"], ["unread", "Unread"],
    ["positive", "Positive"], ["interested", "Interested"], ["recruiting", "Candidate"],
    ["bd", "Business Development"], ["voice", "Voice Replies"]
  ];
  function tabInbox(body) {
    apiGet("?view=inbox").then(function (d) {
      var convos = d.conversations.filter(function (c) {
        switch (S.inboxFilter) {
          case "attention": return c.needsAttention;
          case "unread": return c.unread;
          case "positive": return c.intent === "positive" || c.intent === "soft_yes";
          case "interested": return ["positive", "soft_yes", "referral"].indexOf(c.intent) >= 0;
          case "recruiting": return c.businessUnit === "recruiting";
          case "bd": return c.businessUnit === "bd";
          case "voice": return c.messages.some(function (msg) { return msg.kind === "voice" && !msg.fromSelf; });
          default: return true;
        }
      });
      if (!S.inboxSel && convos.length) S.inboxSel = convos[0].id;
      var filters = INBOX_FILTERS.map(function (f) {
        return '<button class="lio-chip' + (S.inboxFilter === f[0] ? " active" : "") + '" data-f="' + f[0] + '">' + f[1] + "</button>";
      }).join("");
      var list = convos.map(function (c) {
        var last = c.messages[c.messages.length - 1];
        return '<div class="lio-convo' + (S.inboxSel === c.id ? " active" : "") + (c.unread ? " unread" : "") + '" data-id="' + esc(c.id) + '">' +
          "<div><b>" + esc(c.displayName) + "</b><div class='lio-dim lio-clip'>" +
          esc(last ? (last.text || (last.kind === "voice" ? "Voice message" : last.kind)) : "") + "</div></div>" +
          '<div class="lio-dim">' + ago(c.lastMessageAt) + "</div></div>";
      }).join("") || '<div class="empty">No conversations' + (S.inboxFilter !== "all" ? " for this filter" : "") + ".</div>";

      body.innerHTML =
        '<div class="lio-chiprow">' + filters + "</div>" +
        '<div class="lio-inbox">' +
        '<div class="lio-inbox-list card">' + list + "</div>" +
        '<div class="lio-inbox-thread card" id="lioThread"><div class="empty">Select a conversation.</div></div>' +
        '<div class="lio-inbox-side card" id="lioSide"></div>' +
        "</div>";
      Array.prototype.forEach.call(body.querySelectorAll(".lio-chip"), function (b) {
        b.onclick = function () { S.inboxFilter = b.getAttribute("data-f"); S.inboxSel = null; tabInbox(body); };
      });
      Array.prototype.forEach.call(body.querySelectorAll(".lio-convo"), function (n) {
        n.onclick = function () { S.inboxSel = n.getAttribute("data-id"); tabInbox(body); };
      });
      if (S.inboxSel) loadThread(body, S.inboxSel);
    }).catch(function (e) { fail(body, e); });
  }

  var INTENTS = ["positive", "interested", "neutral", "question", "objection", "not_interested",
    "wrong_person", "referral", "follow_up_later", "do_not_contact"];
  function loadThread(body, id) {
    apiGet("?view=conversation&id=" + encodeURIComponent(id)).then(function (d) {
      var c = d.conversation;
      act("inbox_read", { id: c.id }).catch(function () {});
      var msgs = c.messages.map(function (msg) {
        return '<div class="lio-msg' + (msg.fromSelf ? " self" : "") + '">' +
          (msg.kind === "voice" && msg.audioUrl
            ? '<audio controls src="' + esc(msg.audioUrl) + '"></audio>' + (msg.text ? "<div>" + esc(msg.text) + "</div>" : "")
            : esc(msg.text || "(" + msg.kind + ")")) +
          '<div class="lio-msg-t">' + when(msg.at) + "</div></div>";
      }).join("") || '<div class="empty">No messages yet.</div>';
      var thread = body.querySelector("#lioThread");
      thread.innerHTML =
        '<div class="lio-thread-h"><div><b>' + esc(c.displayName) + "</b><div class='lio-dim'>" +
        esc([c.headline, c.company].filter(Boolean).join(" · ")) + "</div></div>" +
        '<div>AI intent <select id="lioIntent" class="lio-input lio-input-sm">' +
        '<option value="">unclassified</option>' +
        INTENTS.map(function (x) { return '<option value="' + x + '"' + (c.intent === x ? " selected" : "") + ">" + title(x) + "</option>"; }).join("") +
        "</select></div></div>" +
        '<div class="lio-msgs">' + msgs + "</div>" +
        '<div class="lio-reply"><textarea id="lioReplyText" class="lio-input" rows="2" placeholder="Type a message..."></textarea>' +
        '<button class="btn btn-primary" id="lioReplySend">Send</button></div>' +
        '<div class="lio-dim" style="padding:0 12px 10px">Manual replies go through the shared engine and count toward account utilization.</div>';
      thread.querySelector("#lioIntent").onchange = function () {
        act("inbox_intent", { id: c.id, intent: this.value }).then(function () { toastMsg("Intent updated"); });
      };
      thread.querySelector("#lioReplySend").onclick = function () {
        var text = thread.querySelector("#lioReplyText").value.trim();
        if (!text) return;
        act("inbox_send", { conversationId: c.id, text: text }).then(function (r) {
          toastMsg(r.accepted ? "Message scheduled" : "Waiting: " + (r.reason || "capacity"));
          loadThread(body, id);
        }).catch(function (e) { toastMsg("Send failed: " + e.message); });
      };

      var t = d.timeline;
      var side = body.querySelector("#lioSide");
      side.innerHTML =
        '<div class="lio-card-t">Person</div>' +
        '<div><b>' + esc(t.identity ? t.identity.name || c.displayName : c.displayName) + "</b></div>" +
        (t.identity && t.identity.title ? '<div class="lio-dim">' + esc(t.identity.title) + "</div>" : "") +
        (t.identity && t.identity.company ? '<div class="lio-dim">' + esc(t.identity.company) + "</div>" : "") +
        (t.identity && t.identity.connected ? pill("Connected", "green") : "") +
        (c.businessUnit ? '<div style="margin-top:6px">' + pill(c.businessUnit === "recruiting" ? "Candidate" : "Prospect") + "</div>" : "") +
        '<div class="lio-card-t" style="margin-top:14px">Timeline</div>' +
        (t.events || []).slice(0, 12).map(function (ev) {
          return '<div class="lio-tl"><span class="lio-dim">' + ago(ev.at) + "</span> " + esc(ev.text) + "</div>";
        }).join("");
    }).catch(function () {});
  }

  /* ================= PEOPLE ================= */
  function tabPeople(body) {
    apiGet("?view=people&bu=" + bu()).then(function (d) {
      var q = (S.peopleFilter || "").toLowerCase();
      var people = d.people.filter(function (p) {
        return !q || (p.name + " " + (p.company || "")).toLowerCase().indexOf(q) >= 0;
      });
      var rows = people.map(function (p) {
        return "<tr data-id='" + esc(p.id) + "'><td><b>" + esc(p.name) + "</b>" +
          (p.company ? "<div class='lio-dim'>" + esc([p.title, p.company].filter(Boolean).join(" · ")) + "</div>" : "") + "</td>" +
          "<td>" + (p.connected ? pill("Connected", "green") : p.connectionDegree ? p.connectionDegree + "&deg;" : "") + "</td>" +
          "<td>" + esc((p.personTypes || []).join(", ")) + "</td>" +
          "<td>" + (p.businessUnit ? (p.businessUnit === "recruiting" ? "Recruiting" : "BD") : "") + "</td>" +
          "<td>" + esc(p.campaignName || "") + (p.enrollmentStatus ? "<div class='lio-dim'>" + title(p.enrollmentStatus) + (p.stepIndex ? " · step " + p.stepIndex + (p.stepCount ? " of " + p.stepCount : "") : "") + "</div>" : "") + "</td>" +
          "<td>" + (p.lastActionAt ? esc(ACTION_LABEL[p.lastActionType] || "") + " · " + ago(p.lastActionAt) : "") + "</td>" +
          "<td>" + (p.lastReplyAt ? ago(p.lastReplyAt) : "") + "</td>" +
          "<td>" + pill(title(p.pressure), PRESSURE_PILL[p.pressure] || "") + "</td>" +
          "<td>" + (p.automationPaused ? pill("Paused", "amber") : pill("Open", "green")) + "</td></tr>";
      }).join("");
      body.innerHTML =
        '<div class="lio-toolbar"><input id="lioPplQ" class="lio-input" style="max-width:280px" placeholder="Search people..." value="' + esc(S.peopleFilter || "") + '">' +
        '<div class="lio-dim">' + people.length + " people known to the LinkedIn engine</div></div>" +
        (rows
          ? '<div class="card lio-card lio-tablewrap"><table class="lio-table"><thead><tr>' +
            "<th>Name</th><th>LinkedIn</th><th>Person Type</th><th>Unit</th><th>Campaign</th><th>Last Action</th><th>Last Reply</th><th>Pressure</th><th>Status</th>" +
            "</tr></thead><tbody>" + rows + "</tbody></table></div>"
          : '<div class="empty">No people yet. People appear here as campaigns enroll them or replies arrive.</div>');
      var qbox = body.querySelector("#lioPplQ");
      qbox.oninput = function () { S.peopleFilter = qbox.value; later(function () { tabPeople(body); }, 350); };
      Array.prototype.forEach.call(body.querySelectorAll("tr[data-id]"), function (tr) {
        tr.onclick = function () { openPersonDrawer(tr.getAttribute("data-id")); };
      });
    }).catch(function (e) { fail(body, e); });
  }

  function openPersonDrawer(personId) {
    apiGet("?view=person&id=" + encodeURIComponent(personId)).then(function (t) {
      var old = document.getElementById("lioDrawer");
      if (old) old.remove();
      var idn = t.identity || {};
      var d = el('<div id="lioDrawer"><div class="lio-drawer-bg"></div><div class="lio-drawer card">' +
        '<div class="lio-drawer-h"><b>' + esc(idn.name || "Person") + '</b><button class="modal-x" id="lioDrX">&times;</button></div>' +
        '<div class="lio-drawer-b">' +
        (idn.title ? '<div class="lio-dim">' + esc(idn.title) + "</div>" : "") +
        (idn.company ? '<div class="lio-dim">' + esc(idn.company) + "</div>" : "") +
        (idn.linkedinUrl ? '<div><a class="lio-link" target="_blank" rel="noopener" href="https://www.' + esc(idn.linkedinUrl) + '">LinkedIn profile</a></div>' : "") +
        (idn.connected ? '<div style="margin-top:6px">' + pill("Connected", "green") + "</div>" : "") +
        '<div style="margin:10px 0"><button class="btn btn-sm btn-ghost" id="lioResume">Resume automation</button></div>' +
        '<div class="lio-card-t">Communication timeline</div>' +
        (t.events || []).map(function (ev) {
          return '<div class="lio-tl"><span class="lio-dim">' + ago(ev.at) + " · " + esc(ev.channel) + "</span> " + esc(ev.text) + "</div>";
        }).join("") +
        "</div></div></div>");
      document.body.appendChild(d);
      d.querySelector("#lioDrX").onclick = function () { d.remove(); };
      d.querySelector(".lio-drawer-bg").onclick = function () { d.remove(); };
      d.querySelector("#lioResume").onclick = function () {
        act("person_resume", { personIdentityId: personId }).then(function () { toastMsg("Automation resumed for this person"); d.remove(); });
      };
    }).catch(function () { toastMsg("Could not load person"); });
  }

  /* ================= VOICE NOTES ================= */
  var VOICE_TABS = [["templates", "Templates"], ["recordings", "My Recordings"], ["ai", "AI Voice"], ["approvals", "Approvals"], ["performance", "Performance"]];
  function tabVoice(body) {
    apiGet("?view=voice").then(function (d) {
      var chips = VOICE_TABS.map(function (t) {
        var n = t[0] === "approvals" ? d.approvals.length : 0;
        return '<button class="lio-chip' + (S.voiceTab === t[0] ? " active" : "") + '" data-v="' + t[0] + '">' + t[1] + (n ? " (" + n + ")" : "") + "</button>";
      }).join("");
      body.innerHTML = '<div class="lio-chiprow">' + chips + '</div><div id="lioVoiceBody"></div>';
      Array.prototype.forEach.call(body.querySelectorAll(".lio-chip"), function (b) {
        b.onclick = function () { S.voiceTab = b.getAttribute("data-v"); tabVoice(body); };
      });
      var vb = body.querySelector("#lioVoiceBody");
      if (S.voiceTab === "approvals") return voiceApprovals(vb, d.approvals);
      if (S.voiceTab === "performance") return voicePerformance(vb, d.assets);
      var mode = S.voiceTab === "ai" ? "ai" : "static";
      var assets = d.assets.filter(function (a) {
        if (S.voiceTab === "templates") return a.isTemplate;
        if (S.voiceTab === "recordings") return a.mode === "static" && !a.isTemplate;
        return a.mode === "ai";
      });
      var cards = assets.map(function (a) {
        return '<div class="card lio-vcard" data-id="' + esc(a.id) + '">' +
          "<div class='lio-vcard-h'><b>" + esc(a.name) + "</b>" + pill(a.mode === "ai" ? "AI Personalized" : "Static", a.mode === "ai" ? "" : "green") + "</div>" +
          (a.script ? '<div class="lio-dim lio-clip2">' + esc(a.script) + "</div>" : "") +
          (a.audioFile ? '<audio controls src="/api/linkedin/os/audio/' + esc(a.audioFile) + '"></audio>' : "") +
          '<div class="lio-dim">Sent ' + a.stats.sent + " · Replies " + a.stats.replies + (a.tags.length ? " · " + esc(a.tags.join(", ")) : "") + "</div>" +
          '<div class="lio-vcard-a">' +
          '<button class="btn btn-sm btn-ghost" data-op="edit">Edit</button>' +
          '<button class="btn btn-sm btn-ghost" data-op="dup">Duplicate</button>' +
          '<button class="btn btn-sm btn-ghost" data-op="tpl">' + (a.isTemplate ? "Untemplate" : "Save as template") + "</button>" +
          '<button class="btn btn-sm btn-ghost" data-op="del">Delete</button>' +
          '<span class="lio-dim lio-mono" title="Use this id on a voice note step">' + esc(a.id) + "</span>" +
          "</div></div>";
      }).join("");
      vb.innerHTML =
        '<div class="lio-toolbar">' +
        (S.voiceTab === "recordings"
          ? '<button class="btn btn-primary" id="lioRec">Record from browser</button><label class="btn btn-ghost" for="lioUp">Upload audio</label><input type="file" id="lioUp" accept="audio/*" style="display:none">'
          : '<button class="btn btn-primary" id="lioNewAi">' + (S.voiceTab === "ai" ? "+ New AI voice note" : "+ New template") + "</button>") +
        "<span></span></div>" +
        (cards ? '<div class="lio-vgrid">' + cards + "</div>"
          : '<div class="empty">Nothing here yet. ' + (S.voiceTab === "recordings" ? "Record or upload your first voice note." : "Create one with variables like {first_name} and {current_company}.") + "</div>");
      wireVoiceCards(vb, assets, body);
      if (S.voiceTab === "recordings") {
        vb.querySelector("#lioRec").onclick = function () { recordFlow(body); };
        vb.querySelector("#lioUp").onchange = function () {
          var f = this.files && this.files[0];
          if (!f) return;
          var rd = new FileReader();
          rd.onload = function () {
            act("voice_save", { asset: { name: f.name.replace(/\.[^.]+$/, ""), mode: "static", audioBase64: rd.result, audioExt: (f.name.split(".").pop() || "mp3") } })
              .then(function () { toastMsg("Uploaded"); tabVoice(body); });
          };
          rd.readAsDataURL(f);
        };
      } else {
        var newBtn = vb.querySelector("#lioNewAi");
        if (newBtn) newBtn.onclick = function () { voiceEditor(body, { mode: mode === "ai" ? "ai" : "static", isTemplate: S.voiceTab === "templates" }); };
      }
    }).catch(function (e) { fail(body, e); });
  }
  function wireVoiceCards(vb, assets, body) {
    Array.prototype.forEach.call(vb.querySelectorAll(".lio-vcard"), function (card) {
      var id = card.getAttribute("data-id");
      var a = assets.filter(function (x) { return x.id === id; })[0];
      Array.prototype.forEach.call(card.querySelectorAll("[data-op]"), function (b) {
        b.onclick = function () {
          var op = b.getAttribute("data-op");
          if (op === "edit") return voiceEditor(body, a);
          if (op === "dup") return act("voice_duplicate", { id: id }).then(function () { tabVoice(body); });
          if (op === "del") return act("voice_delete", { id: id }).then(function () { tabVoice(body); });
          if (op === "tpl") return act("voice_save", { asset: { id: id, name: a.name, mode: a.mode, isTemplate: !a.isTemplate } }).then(function () { tabVoice(body); });
        };
      });
    });
  }
  var VOICE_VARS = "{first_name} {current_company} {current_title} {previous_company} {job_title} {industry} {location} {signal} {company_trigger} {candidate_background} {shared_context}";
  function voiceEditor(body, a) {
    var m = el('<div class="modal-bg"><div class="modal-card lio-wiz">' +
      '<div class="lio-wiz-head"><b>' + (a.id ? "Edit voice note" : "New voice note") + '</b><button class="modal-x">&times;</button></div>' +
      '<div class="lio-wiz-body">' +
      row("Name", '<input id="vName" class="lio-input" value="' + esc(a.name || "") + '">') +
      row("Mode", '<select id="vMode" class="lio-input"><option value="ai"' + (a.mode === "ai" ? " selected" : "") + '>AI Personalized</option><option value="static"' + (a.mode !== "ai" ? " selected" : "") + ">Static recording</option></select>") +
      row("Script", '<textarea id="vScript" class="lio-input lio-area" rows="4" placeholder="Hey {first_name}, Ryan here. I noticed {signal}...">' + esc(a.script || "") + "</textarea>") +
      '<div class="lio-dim" style="margin:4px 0 10px">Variables: ' + esc(VOICE_VARS) + "</div>" +
      row("Voice provider", '<select id="vProv" class="lio-input"><option value="">Default (configured provider)</option><option value="elevenlabs"' + (a.provider === "elevenlabs" ? " selected" : "") + '>ElevenLabs</option><option value="cartesia"' + (a.provider === "cartesia" ? " selected" : "") + '>Cartesia</option><option value="hume"' + (a.provider === "hume" ? " selected" : "") + '>Hume</option><option value="manual"' + (a.provider === "manual" ? " selected" : "") + ">Manual recording</option></select>") +
      row("Voice id", '<input id="vVoice" class="lio-input" value="' + esc(a.voiceId || "") + '" placeholder="Provider voice id (optional)">') +
      row("Tags", '<input id="vTags" class="lio-input" value="' + esc((a.tags || []).join(", ")) + '" placeholder="opener, finance">') +
      '<div id="vPreview"></div>' +
      "</div>" +
      '<div class="modal-foot lio-wiz-foot"><button class="btn btn-ghost" id="vTest">Preview voice</button><button class="btn btn-primary" id="vSave">Save</button></div>' +
      "</div></div>");
    document.body.appendChild(m);
    m.querySelector(".modal-x").onclick = function () { m.remove(); };
    m.querySelector("#vTest").onclick = function () {
      var script = m.querySelector("#vScript").value;
      act("voice_script", { template: script, ctx: { first_name: "Daniel", current_company: "Acme", current_title: "SVP Sales", signal: "Acme posted 4 sales roles" } })
        .then(function (r) {
          return act("voice_test", { script: r.script, provider: m.querySelector("#vProv").value, voiceId: m.querySelector("#vVoice").value })
            .then(function (t) {
              var pv = m.querySelector("#vPreview");
              pv.innerHTML = '<div class="lio-dim" style="margin:6px 0">' + esc(r.script) + "</div>" +
                (t.dryRun ? '<div class="lio-note">' + esc(t.note) + "</div>" : '<audio controls autoplay src="' + esc(t.url) + '"></audio>');
            });
        }).catch(function (e) { toastMsg("Preview failed: " + e.message); });
    };
    m.querySelector("#vSave").onclick = function () {
      act("voice_save", {
        asset: {
          id: a.id,
          name: m.querySelector("#vName").value || "Untitled voice note",
          mode: m.querySelector("#vMode").value,
          script: m.querySelector("#vScript").value,
          provider: m.querySelector("#vProv").value || undefined,
          voiceId: m.querySelector("#vVoice").value || undefined,
          tags: m.querySelector("#vTags").value.split(",").map(function (x) { return x.trim(); }).filter(Boolean),
          isTemplate: a.isTemplate
        }
      }).then(function () { m.remove(); toastMsg("Saved"); tabVoice(body); });
    };
  }
  function recordFlow(body) {
    if (!navigator.mediaDevices || !window.MediaRecorder) { toastMsg("Recording is not supported in this browser"); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var rec = new MediaRecorder(stream);
      S.recorder = rec; S.recChunks = [];
      rec.ondataavailable = function (ev) { if (ev.data.size) S.recChunks.push(ev.data); };
      var m = el('<div class="modal-bg"><div class="modal-card"><div class="lio-wiz-head"><b>Recording...</b></div>' +
        '<div class="lio-wiz-body"><div class="lio-dim">Speak your voice note (20 to 45 seconds works best).</div></div>' +
        '<div class="modal-foot"><button class="btn btn-primary" id="recStop">Stop and save</button><button class="btn btn-ghost" id="recCancel">Cancel</button></div></div></div>');
      document.body.appendChild(m);
      rec.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        if (!S.recChunks.length) { m.remove(); return; }
        var blob = new Blob(S.recChunks, { type: rec.mimeType || "audio/webm" });
        var rd = new FileReader();
        rd.onload = function () {
          var name = "Recording " + new Date().toLocaleString();
          act("voice_save", { asset: { name: name, mode: "static", audioBase64: rd.result, audioExt: /ogg/.test(blob.type) ? "ogg" : /mp4/.test(blob.type) ? "m4a" : "webm" } })
            .then(function () { m.remove(); toastMsg("Recording saved"); tabVoice(body); });
        };
        rd.readAsDataURL(blob);
      };
      m.querySelector("#recStop").onclick = function () { rec.stop(); };
      m.querySelector("#recCancel").onclick = function () { S.recChunks = []; rec.stop(); m.remove(); };
      rec.start();
    }).catch(function () { toastMsg("Microphone permission was refused"); });
  }
  function voiceApprovals(vb, items) {
    vb.innerHTML = items.length
      ? items.map(function (it) {
          return '<div class="card lio-card" data-id="' + esc(it.id) + '">' +
            "<div class='lio-vcard-h'><b>" + esc(it.personName) + "</b><span class='lio-dim'>" + ago(it.createdAt) + "</span></div>" +
            '<textarea class="lio-input lio-area" rows="3" data-f="script">' + esc(it.script) + "</textarea>" +
            (it.audioFile ? '<audio controls src="/api/linkedin/os/audio/' + esc(it.audioFile) + '"></audio>' : '<div class="lio-dim">Audio renders at send time.</div>') +
            '<div class="lio-vcard-a"><button class="btn btn-sm btn-primary" data-op="approved">Approve</button>' +
            '<button class="btn btn-sm btn-ghost" data-op="skipped">Skip</button></div></div>';
        }).join("")
      : '<div class="empty">No voice notes waiting for approval. Campaigns in review mode queue their first sends here.</div>';
    Array.prototype.forEach.call(vb.querySelectorAll(".card[data-id]"), function (card) {
      var id = card.getAttribute("data-id");
      Array.prototype.forEach.call(card.querySelectorAll("[data-op]"), function (b) {
        b.onclick = function () {
          act("voice_approval", { id: id, decision: b.getAttribute("data-op"), script: card.querySelector("[data-f=script]").value })
            .then(function () { toastMsg(b.getAttribute("data-op") === "approved" ? "Approved" : "Skipped"); card.remove(); });
        };
      });
    });
  }
  function voicePerformance(vb, assets) {
    var rows = assets.map(function (a) {
      var rate = a.stats.sent ? Math.round((a.stats.replies / a.stats.sent) * 1000) / 10 : 0;
      return "<tr><td><b>" + esc(a.name) + "</b></td><td>" + (a.mode === "ai" ? "AI" : "Static") + "</td><td>" + a.stats.sent + "</td><td>" + a.stats.replies + "</td><td>" + rate + "%</td></tr>";
    }).join("");
    vb.innerHTML = rows
      ? '<div class="card lio-card lio-tablewrap"><table class="lio-table"><thead><tr><th>Voice note</th><th>Mode</th><th>Sent</th><th>Replies</th><th>Reply rate</th></tr></thead><tbody>' + rows + "</tbody></table></div>"
      : '<div class="empty">No voice note sends yet.</div>';
  }

  /* ================= ACCOUNTS ================= */
  function tabAccounts(body) {
    apiGet("?view=accounts").then(function (d) {
      var cards = d.accounts.map(function (a) {
        return '<div class="card lio-card" data-id="' + esc(a.accountId) + '">' +
          '<div class="lio-vcard-h"><b>' + esc(a.displayName) + "</b>" + pill(title(a.health), HEALTH_PILL[a.health]) + "</div>" +
          '<div class="lio-dim">' +
          (a.products.classic ? "LinkedIn Classic" : "") +
          (a.products.salesNavigator ? " · Sales Navigator" : "") +
          (a.products.recruiter ? " · Recruiter" : "") +
          (a.connected ? "" : " · Disconnected") + "</div>" +
          (a.healthReason ? '<div class="lio-dim">' + esc(a.healthReason) + "</div>" : "") +
          '<div class="lio-rv"><span>Active LinkedIn campaigns</span><b>' + a.activeCampaigns + "</b></div>" +
          '<div class="lio-rv"><span>Actions waiting for capacity</span><b>' + a.waitingActions + "</b></div>" +
          (a.riskSignals.length ? '<div class="lio-card-t" style="margin-top:8px">Risk signals</div>' +
            a.riskSignals.slice(-3).reverse().map(function (rs) {
              return '<div class="lio-tl"><span class="lio-dim">' + ago(rs.at) + "</span> " + esc(rs.kind.replace(/_/g, " ")) + ": " + esc(rs.detail) + "</div>";
            }).join("") : "") +
          '<div class="lio-vcard-a">' +
          '<button class="btn btn-sm ' + (a.killSwitch ? "btn-primary" : "btn-danger") + '" data-op="kill">' + (a.killSwitch ? "Resume all automation" : "Pause ALL LinkedIn automation") + "</button>" +
          (a.health === "paused"
            ? '<button class="btn btn-sm btn-ghost" data-op="resume">Resume</button>'
            : '<button class="btn btn-sm btn-ghost" data-op="pause">Pause automation</button>') +
          '<a class="btn btn-sm btn-ghost" href="#linkedin/limits">Edit limits</a>' +
          "</div></div>";
      }).join("");
      body.innerHTML =
        '<div class="lio-toolbar"><div class="lio-dim">One connected account serves every campaign and workflow in both business units. The kill switch pauses everything on the account at once.</div>' +
        '<button class="btn btn-ghost" id="lioAccRefresh">Refresh status</button>' +
        '<button class="btn btn-primary" id="lioAccAdd">+ Connect account</button></div>' +
        (cards ? '<div class="lio-vgrid">' + cards + "</div>"
          : '<div class="empty">No LinkedIn account is registered with the engine yet. Connect one to start. Unipile credentials (UNIPILE_DSN and UNIPILE_API_KEY) power live execution; without them the engine still plans and paces safely.</div>');
      body.querySelector("#lioAccAdd").onclick = function () { accountModal(body); };
      body.querySelector("#lioAccRefresh").onclick = function () {
        act("account_refresh").then(function () { toastMsg("Status refreshed"); tabAccounts(body); });
      };
      Array.prototype.forEach.call(body.querySelectorAll(".card[data-id]"), function (card) {
        var id = card.getAttribute("data-id");
        var acc = d.accounts.filter(function (x) { return x.accountId === id; })[0];
        Array.prototype.forEach.call(card.querySelectorAll("[data-op]"), function (b) {
          b.onclick = function () {
            var op = b.getAttribute("data-op");
            var p = op === "kill" ? act("account_kill", { accountId: id, paused: !acc.killSwitch })
              : op === "pause" ? act("account_pause", { accountId: id })
              : act("account_resume", { accountId: id });
            p.then(function () { tabAccounts(body); });
          };
        });
      });
    }).catch(function (e) { fail(body, e); });
  }
  function accountModal(body) {
    var m = el('<div class="modal-bg"><div class="modal-card">' +
      '<div class="lio-wiz-head"><b>Connect LinkedIn account</b><button class="modal-x">&times;</button></div>' +
      '<div class="lio-wiz-body">' +
      row("Display name", '<input id="accName" class="lio-input" placeholder="Ryan Nead">') +
      row("Account id", '<input id="accId" class="lio-input" placeholder="ryan (stable internal id)">') +
      row("Unipile account id", '<input id="accProv" class="lio-input" placeholder="From the Unipile dashboard (optional now)">') +
      row("Timezone", '<input id="accTz" class="lio-input" placeholder="America/New_York" value="UTC">') +
      '<label class="lio-radio"><input type="checkbox" id="accSn"><div><b>Sales Navigator detected</b></div></label>' +
      '<label class="lio-radio"><input type="checkbox" id="accRec"><div><b>Recruiter detected</b></div></label>' +
      '<div class="lio-dim">The account itself connects through Unipile; this registers it with the shared engine so policies, utilization and health apply.</div>' +
      "</div>" +
      '<div class="modal-foot"><button class="btn btn-primary" id="accSave">Connect</button></div></div></div>');
    document.body.appendChild(m);
    m.querySelector(".modal-x").onclick = function () { m.remove(); };
    m.querySelector("#accSave").onclick = function () {
      var name = m.querySelector("#accName").value.trim();
      var id = m.querySelector("#accId").value.trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "default";
      act("account_ensure", {
        accountId: id,
        displayName: name || id,
        providerAccountId: m.querySelector("#accProv").value.trim() || undefined,
        timezone: m.querySelector("#accTz").value.trim() || undefined,
        products: { classic: true, salesNavigator: m.querySelector("#accSn").checked, recruiter: m.querySelector("#accRec").checked }
      }).then(function () { m.remove(); toastMsg("Account registered"); tabAccounts(body); });
    };
  }

  /* ================= UTILIZATION ================= */
  function tabUtilization(body) {
    apiGet("?view=utilization" + (S.account ? "&account=" + encodeURIComponent(S.account) : "")).then(function (d) {
      if (d.empty) {
        body.innerHTML = '<div class="empty">Connect a LinkedIn account first (Accounts tab); utilization appears once the engine is tracking one.</div>';
        return;
      }
      var o = d.overview;
      var catRows = o.categories.map(function (c) {
        return "<tr><td><b>" + esc(CAT_LABEL[c.category] || c.category) + "</b></td>" +
          "<td>" + c.used + "</td><td>" + c.reserved + "</td><td>" + c.waiting + "</td>" +
          "<td>" + c.effectiveTarget + (c.effectiveTarget !== c.dailyTarget ? " <span class='lio-dim'>(policy " + c.dailyTarget + ")</span>" : "") + "</td>" +
          "<td>" + c.hardCeiling + "</td></tr>";
      }).join("");
      var alloc = d.allocation.slices.map(function (s) {
        return "<tr><td><b>" + esc(s.name) + "</b></td><td>" + (s.businessUnit === "recruiting" ? "Recruiting" : "BD") + "</td>" +
          "<td>" + title(s.priority) + "</td><td>" + s.weight + "</td><td>" + s.demand + "</td><td>" + s.allocated + "</td><td>" + s.usedToday + "</td></tr>";
      }).join("");
      var queue = d.queue.map(function (q) {
        return "<tr data-id='" + esc(q.id) + "'><td>" + (q.at ? when(q.at) : "") + "</td>" +
          "<td>" + esc(ACTION_LABEL[q.actionType] || title(q.actionType)) + "</td>" +
          "<td>" + esc(q.personName) + "</td><td>" + esc(q.campaignName || title(q.businessUnit)) + "</td>" +
          "<td>" + statusPill(q.status) + (q.statusReason ? "<div class='lio-dim lio-clip'>" + esc(q.statusReason) + "</div>" : "") + "</td>" +
          "<td class='lio-actions'>" +
          (q.status === "capacity_pending" ? "<button class='btn btn-sm btn-ghost' data-op='allow'>Allow temporary capacity</button>" : "") +
          "<button class='btn btn-sm btn-ghost' data-op='explain'>Why</button>" +
          "<button class='btn btn-sm btn-ghost' data-op='cancel'>Cancel</button></td></tr>";
      }).join("");
      var weekly = Object.keys(o.weekly).map(function (k) {
        var wv = o.weekly[k];
        return '<div class="lio-rv"><span>7-day ' + esc(CAT_LABEL[k].toLowerCase()) + " target</span><b>" + wv.used + " / " + wv.target + "</b></div>";
      }).join("");

      body.innerHTML =
        '<div class="lio-kpis">' +
        kpi("Account", o.account ? o.account.displayName : S.account || "default") +
        kpi("Total policy utilization", o.utilizationPct + "%", "of health-adjusted daily targets") +
        kpi("Recruiting", o.recruitingPct + "%", "of current allocation") +
        kpi("Business Development", o.bdPct + "%", "of current allocation") +
        kpi("Available", o.availablePct + "%") +
        "</div>" +
        '<div class="lio-cols">' +
        '<div class="card lio-card"><div class="lio-card-t">Action utilization today <span class="lio-hint" title="Used = provider-confirmed sends. Reserved = capacity held for scheduled actions. Waiting = actions in line for headroom. Targets and ceilings are RecruitersOS account policies.">?</span></div>' +
        '<div class="lio-tablewrap"><table class="lio-table"><thead><tr><th>Category</th><th>Used</th><th>Reserved</th><th>Waiting</th><th>Target</th><th>Hard ceiling</th></tr></thead><tbody>' + catRows + "</tbody></table></div>" +
        '<div style="margin-top:8px">' + weekly + "</div></div>" +
        '<div class="card lio-card"><div class="lio-card-t">Fair capacity allocation</div>' +
        (alloc ? '<div class="lio-tablewrap"><table class="lio-table"><thead><tr><th>Consumer</th><th>Unit</th><th>Priority</th><th>Weight</th><th>Demand</th><th>Allocated</th><th>Used today</th></tr></thead><tbody>' + alloc + "</tbody></table></div>"
          : '<div class="empty">No competing consumers right now. Unused allocation is released dynamically.</div>') + "</div></div>" +
        '<div class="card lio-card"><div class="lio-card-t">Wait queue and scheduled actions</div>' +
        (queue ? '<div class="lio-tablewrap"><table class="lio-table"><thead><tr><th>Time</th><th>Action</th><th>Person</th><th>Source</th><th>Status</th><th></th></tr></thead><tbody>' + queue + "</tbody></table></div>"
          : '<div class="empty">Nothing queued or waiting.</div>') + "</div>";

      Array.prototype.forEach.call(body.querySelectorAll("tr[data-id] [data-op]"), function (b) {
        b.onclick = function () {
          var id = b.closest("tr").getAttribute("data-id");
          var op = b.getAttribute("data-op");
          if (op === "explain") return explainModal(id);
          if (op === "cancel") return act("action_cancel", { id: id }).then(function () { toastMsg("Cancelled; capacity released"); tabUtilization(body); });
          if (op === "allow") return act("action_allow", { id: id }).then(function (r) {
            toastMsg(r.accepted ? "Temporary capacity allowed" : (r.reason || "Still waiting"));
            tabUtilization(body);
          });
        };
      });
      loadActivationQueue(body);
    }).catch(function (e) { fail(body, e); });
  }

  /* Activation queue: approved contacts slow-dripping into workflows at the
     fastest responsible pace channel capacity allows. */
  function loadActivationQueue(body) {
    apiGet("?view=activation").then(function (d) {
      var waiting = d.entries.filter(function (e) { return e.status === "waiting"; });
      var recent = d.entries.filter(function (e) { return e.status !== "waiting"; }).slice(-20).reverse();
      var rows = waiting.concat(recent).slice(0, 60).map(function (e) {
        return "<tr><td><b>" + esc(e.displayName) + "</b></td>" +
          "<td>" + esc(e.signalLabel || "") + "</td>" +
          "<td>" + esc(e.target.name || e.target.id) + "</td>" +
          "<td>" + (e.status === "waiting"
            ? pill(e.waitReason || "Waiting", "amber") + (e.expected ? "<div class='lio-dim'>" + esc(e.expected) + "</div>" : "")
            : pill(title(e.status), e.status === "activated" ? "green" : "")) + "</td>" +
          "<td>" + (e.status === "waiting" ? "<button class='btn btn-sm btn-ghost' data-actq='" + esc(e.id) + "'>Remove</button>" : "") + "</td></tr>";
      }).join("");
      var box = el('<div class="card lio-card"><div class="lio-card-t">Activation queue' +
        (waiting.length ? " · " + waiting.length + " waiting" : "") + "</div>" +
        (rows
          ? '<div class="lio-tablewrap"><table class="lio-table"><thead><tr><th>Contact</th><th>Signal</th><th>Workflow</th><th>Status</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>"
          : '<div class="empty">No approved contacts are waiting for activation. Approved signal batches slow-drip from here based on channel capacity.</div>') +
        "</div>");
      body.appendChild(box);
      Array.prototype.forEach.call(box.querySelectorAll("[data-actq]"), function (b) {
        b.onclick = function () {
          act("activation_cancel", { id: b.getAttribute("data-actq") }).then(function () { b.closest("tr").remove(); });
        };
      });
    }).catch(function () {});
  }
  function explainModal(actionId) {
    act("action_explain", { id: actionId }).then(function (d) {
      var m = el('<div class="modal-bg"><div class="modal-card">' +
        '<div class="lio-wiz-head"><b>Why did RecruitersOS run this LinkedIn action?</b><button class="modal-x">&times;</button></div>' +
        '<div class="lio-wiz-body">' +
        rv("Person", (d.person && d.person.name) || "Unknown") +
        rv("Action", title(d.action.actionType)) +
        rv("Source", title(d.source)) +
        (d.approvedBy ? rv("Approved by", d.approvedBy) : "") +
        (d.campaign ? rv("Workflow", d.campaign.name) : "") +
        rv("Business unit", d.businessUnit === "recruiting" ? "Recruiting" : "Business Development") +
        rv("Person pressure", title(d.pressure)) +
        (d.account ? rv("LinkedIn account", d.account.name) : "") +
        rv("Policy", title(d.policyMode)) +
        rv("Provider", d.provider) +
        rv("Result", title(d.result)) +
        (d.failureReason ? rv("Failure", d.failureReason) : "") +
        '<div class="lio-card-t" style="margin-top:8px">Trace</div>' +
        d.timeline.map(function (t) { return '<div class="lio-tl"><span class="lio-dim">' + when(t.at) + "</span> " + esc(t.label) + "</div>"; }).join("") +
        "</div></div></div>");
      document.body.appendChild(m);
      m.querySelector(".modal-x").onclick = function () { m.remove(); };
      m.onclick = function (ev) { if (ev.target === m) m.remove(); };
    }).catch(function () { toastMsg("Could not load the audit trail"); });
  }

  /* ================= LIMITS & POLICIES ================= */
  function tabLimits(body) {
    apiGet("?view=limits" + (S.account ? "&account=" + encodeURIComponent(S.account) : "")).then(function (d) {
      var p = d.policy;
      var accSel = d.accounts.length > 1
        ? '<select id="lioLimAcc" class="lio-input" style="max-width:220px">' + d.accounts.map(function (a) {
            return '<option value="' + esc(a.accountId) + '"' + (a.accountId === p.accountId ? " selected" : "") + ">" + esc(a.displayName) + "</option>";
          }).join("") + "</select>"
        : '<b>' + esc((d.accounts[0] && d.accounts[0].displayName) || p.accountId) + "</b>";
      var modes = ["conservative", "balanced", "aggressive", "custom"].map(function (mo) {
        return '<label class="lio-radio"><input type="radio" name="lioMode" value="' + mo + '"' + (p.mode === mo ? " checked" : "") + "><div><b>" + title(mo) + "</b><div class='lio-dim'>" + modeBlurb(mo) + "</div></div></label>";
      }).join("");
      var cats = ["connections", "messages", "voice_notes", "inmails", "profile_views", "interactions"].map(function (c) {
        var cp = p.categories[c];
        return "<tr data-cat='" + c + "'><td><b>" + CAT_LABEL[c] + "</b></td>" +
          "<td><input class='lio-input lio-input-n' type='number' min='0' data-f='dailyTarget' value='" + cp.dailyTarget + "'></td>" +
          "<td><input class='lio-input lio-input-n' type='number' min='0' data-f='hardCeiling' value='" + cp.hardCeiling + "'></td>" +
          "<td><input class='lio-input lio-input-n' type='number' min='0' data-f='weeklyTarget' value='" + cp.weeklyTarget + "'></td></tr>";
      }).join("");
      var weights = Object.keys(p.pressure.weights).map(function (k) {
        return "<tr data-w='" + k + "'><td>" + title(k) + "</td><td><input class='lio-input lio-input-n' type='number' min='0' step='0.5' value='" + p.pressure.weights[k] + "'></td></tr>";
      }).join("");
      body.innerHTML =
        '<div class="lio-toolbar"><div>Account: ' + accSel + '</div><div class="lio-dim">These are RecruitersOS utilization policies for pacing this account. They are not numbers LinkedIn publishes or guarantees. <span class="lio-hint" title="RecruitersOS never presents any action count as a guaranteed safe LinkedIn limit. Targets pace normal operation; the hard ceiling is the wall the engine will not cross.">?</span></div></div>' +
        '<div class="lio-cols">' +
        '<div class="card lio-card"><div class="lio-card-t">Operating mode</div>' + modes +
        '<div class="lio-dim" style="margin-top:6px">Selecting a mode applies its recommended starting policy. Adjust any number below and the mode becomes Custom.</div></div>' +
        '<div class="card lio-card"><div class="lio-card-t">Action policies <span class="lio-hint" title="Daily target: the engine paces to this. Hard ceiling: never silently exceeded; only an authorized temporary-capacity grant can pass the target, and nothing passes the ceiling.">?</span></div>' +
        '<div class="lio-tablewrap"><table class="lio-table"><thead><tr><th></th><th>Daily target</th><th>Hard ceiling</th><th>7-day target</th></tr></thead><tbody>' + cats + "</tbody></table></div></div></div>" +
        '<div class="lio-cols">' +
        '<div class="card lio-card"><div class="lio-card-t">Pacing</div>' +
        row("Minimum delay (minutes)", '<input id="pMin" type="number" min="1" class="lio-input lio-input-n" value="' + p.pacing.minDelayMinutes + '">') +
        row("Maximum delay (minutes)", '<input id="pMax" type="number" min="1" class="lio-input lio-input-n" value="' + p.pacing.maxDelayMinutes + '">') +
        toggle("pRand", "Randomized timing", p.pacing.randomizedTiming) +
        toggle("pBurst", "Burst protection", p.pacing.burstProtection) +
        toggle("pCool", "Automatic cooldown", p.pacing.autoCooldown) +
        toggle("pRealloc", "Capacity reallocation", p.pacing.capacityReallocation) +
        row("Working hours", '<div class="lio-2col"><input id="pWhS" type="number" min="0" max="23" class="lio-input lio-input-n" value="' + p.workingHours.startHour + '"><input id="pWhE" type="number" min="1" max="24" class="lio-input lio-input-n" value="' + p.workingHours.endHour + '"></div>') +
        row("Timezone", '<input id="pTz" class="lio-input" value="' + esc(p.timezone) + '">') + "</div>" +
        '<div class="card lio-card"><div class="lio-card-t">Contact pressure</div>' +
        row("Rolling window (days)", '<input id="prWin" type="number" min="1" class="lio-input lio-input-n" value="' + p.pressure.windowDays + '">') +
        row("Maximum automated touches", '<input id="prMax" type="number" min="1" class="lio-input lio-input-n" value="' + p.pressure.maxTouches + '">') +
        row("Elevated threshold", '<input id="prElev" type="number" min="1" class="lio-input lio-input-n" value="' + p.pressure.elevatedThreshold + '">') +
        row("High threshold", '<input id="prHigh" type="number" min="2" class="lio-input lio-input-n" value="' + p.pressure.highThreshold + '">') +
        row("Elevated pressure action", pressureActionSelect("prElevAct", p.pressure.elevatedAction)) +
        row("High pressure action", pressureActionSelect("prHighAct", p.pressure.highAction)) +
        '<div class="lio-card-t" style="margin-top:8px">Channel weighting</div>' +
        '<div class="lio-tablewrap"><table class="lio-table"><tbody>' + weights + "</tbody></table></div></div></div>" +
        '<div class="lio-toolbar"><span></span><button class="btn btn-primary" id="lioPolSave">Save policy</button></div>';

      var accSelEl = body.querySelector("#lioLimAcc");
      if (accSelEl) accSelEl.onchange = function () { S.account = accSelEl.value; tabLimits(body); };
      Array.prototype.forEach.call(body.querySelectorAll("input[name=lioMode]"), function (r) {
        r.onchange = function () {
          act("policy_put", { accountId: p.accountId, patch: { applyPreset: r.value } })
            .then(function () { toastMsg("Applied the " + title(r.value) + " starting policy"); tabLimits(body); });
        };
      });
      body.querySelector("#lioPolSave").onclick = function () {
        var categories = {};
        Array.prototype.forEach.call(body.querySelectorAll("tr[data-cat]"), function (tr) {
          var c = {};
          Array.prototype.forEach.call(tr.querySelectorAll("[data-f]"), function (inp) {
            c[inp.getAttribute("data-f")] = parseInt(inp.value, 10) || 0;
          });
          categories[tr.getAttribute("data-cat")] = c;
        });
        var wobj = {};
        Array.prototype.forEach.call(body.querySelectorAll("tr[data-w]"), function (tr) {
          wobj[tr.getAttribute("data-w")] = parseFloat(tr.querySelector("input").value) || 0;
        });
        act("policy_put", {
          accountId: p.accountId,
          patch: {
            mode: "custom",
            categories: categories,
            pacing: {
              minDelayMinutes: parseInt(body.querySelector("#pMin").value, 10) || 4,
              maxDelayMinutes: parseInt(body.querySelector("#pMax").value, 10) || 17,
              randomizedTiming: body.querySelector("#pRand").checked,
              burstProtection: body.querySelector("#pBurst").checked,
              autoCooldown: body.querySelector("#pCool").checked,
              capacityReallocation: body.querySelector("#pRealloc").checked
            },
            workingHours: {
              startHour: parseInt(body.querySelector("#pWhS").value, 10) || 8,
              endHour: parseInt(body.querySelector("#pWhE").value, 10) || 18
            },
            timezone: body.querySelector("#pTz").value,
            pressure: {
              windowDays: parseInt(body.querySelector("#prWin").value, 10) || 7,
              maxTouches: parseInt(body.querySelector("#prMax").value, 10) || 5,
              elevatedThreshold: parseInt(body.querySelector("#prElev").value, 10) || 5,
              highThreshold: parseInt(body.querySelector("#prHigh").value, 10) || 8,
              elevatedAction: body.querySelector("#prElevAct").value,
              highAction: body.querySelector("#prHighAct").value,
              weights: wobj
            }
          }
        }).then(function () { toastMsg("Policy saved; the engine applies it immediately"); tabLimits(body); })
          .catch(function (e) { toastMsg("Save failed: " + e.message); });
      };
    }).catch(function (e) { fail(body, e); });
  }
  function modeBlurb(mo) {
    return {
      conservative: "Lower daily targets, wider spacing, stricter burst protection, earlier cooldowns.",
      balanced: "RecruitersOS recommended starting policy: steady utilization with pacing and automatic cooldowns.",
      aggressive: "Higher configured targets and closer pacing, still protected by hard ceilings and risk monitoring.",
      custom: "You control every setting below."
    }[mo];
  }
  function pressureActionSelect(id, cur) {
    var opts = [["none", "No change"], ["increase_spacing", "Increase spacing"], ["defer_low_priority", "Defer low priority"], ["pause_review", "Pause and review"]];
    return '<select id="' + id + '" class="lio-input">' + opts.map(function (o) {
      return '<option value="' + o[0] + '"' + (cur === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
    }).join("") + "</select>";
  }
  function toggle(id, label, on) {
    return '<label class="lio-toggle"><input type="checkbox" id="' + id + '"' + (on ? " checked" : "") + "> " + esc(label) + "</label>";
  }

  /* ---------------- export ---------------- */
  window.__LinkedInOS = { render: render };
})();
