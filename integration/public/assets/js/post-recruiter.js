/*
 * RecruitersOS · Post Recruiter
 *
 * Role Hunter's twin, pointed at candidates. Finds qualified people who have
 * told LinkedIn they are open to new roles, confirms it on the profile, and
 * queues the one touch that can actually reach them.
 *
 * The SPA route "postrecruiter" (renderPostRecruiter in command.js) is a thin
 * controller over window.__PostRecruiter; every action goes through
 * /api/post-recruiter and the shared LinkedIn engine behind it. Same shape as
 * linkedin-os.js so the two tools stay readable side by side.
 */
(function () {
  "use strict";
  if (!document.body || !document.body.classList.contains("app")) return;

  /* ---------------- session / api (mirrors command.js) ---------------- */
  var IMP_TOKEN = null;
  try { IMP_TOKEN = sessionStorage.getItem("ros_imp_token") || null; } catch (e) {}

  var API = (window.RECRUITEROS_API_BASE || "") + "/api/post-recruiter";
  function headers(extra) {
    var h = extra || {};
    if (IMP_TOKEN) h["Authorization"] = "Bearer " + IMP_TOKEN;
    return h;
  }
  function apiGet(qs) {
    return fetch(API + (qs || ""), { credentials: "include", headers: headers() })
      .then(function (r) { if (!r.ok) throw new Error("api_" + r.status); return r.json(); });
  }
  function act(action, payload) {
    var b = payload || {};
    b.action = action;
    return fetch(API, {
      method: "POST", credentials: "include",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(b)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error((j && j.error) || ("api_" + r.status)); e.body = j; throw e; }
        return j;
      });
    });
  }

  /* ---------------- helpers ---------------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function ago(iso) {
    if (!iso) return "never";
    var ms = Date.now() - Date.parse(iso);
    if (!isFinite(ms)) return "never";
    var m = Math.round(ms / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + "m ago";
    var h = Math.round(m / 60);
    if (h < 24) return h + "h ago";
    return Math.round(h / 24) + "d ago";
  }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }

  /* Ceilings mirror the server (postRecruiter.ts). Shown live so a recruiter
     never writes a note the engine will refuse. */
  var MAX = { comment: 480, connect: 280, message: 700 };
  var CHANNEL_LABEL = { comment: "Comment on their post", connect: "Connection request", message: "Direct message" };

  var view = null;
  var host = null;
  var tab = "queue";
  var editing = null;   // hunt id being edited, or "new"
  var busy = false;

  /* ---------------- mount ---------------- */
  function render(el) {
    host = el;
    el.innerHTML = '<div class="pr-wrap"><div class="empty">Loading Post Recruiter...</div></div>';
    refresh();
  }

  function refresh() {
    return apiGet("").then(function (d) {
      view = d && d.view ? d.view : d;
      paint();
    }).catch(function () {
      if (host) host.innerHTML = '<div class="pr-wrap"><div class="empty">Post Recruiter could not load. Refresh the page.</div></div>';
    });
  }

  function apply(res) {
    if (res && res.view) { view = res.view; paint(); }
    else refresh();
  }

  function run(fn) {
    if (busy) return;
    busy = true;
    paintBusy(true);
    fn().then(apply).catch(function (e) {
      alert(niceError(e));
    }).then(function () { busy = false; paintBusy(false); });
  }

  function niceError(e) {
    var b = e && e.body;
    if (b && b.reason) return b.reason;
    if (b && b.error) return String(b.error).replace(/_/g, " ");
    return (e && e.message ? String(e.message).replace(/_/g, " ") : "That did not work.");
  }

  function paintBusy(on) {
    $$(".pr-wrap [data-busy]").forEach(function (b) { b.disabled = !!on; });
  }

  /* ---------------- paint ---------------- */
  function paint() {
    if (!host || !view) return;
    host.innerHTML =
      '<div class="pr-wrap">' +
        headerHtml() +
        noticesHtml() +
        barHtml() +
        talliesHtml() +
        tabsHtml() +
        '<div id="prBody"></div>' +
      "</div>";
    paintBody();
    wireBar();
  }

  function headerHtml() {
    return '<div class="pr-head">' +
      "<h1>Post Recruiter</h1>" +
      "<p>Finds qualified people who have told LinkedIn they are open to new roles, confirms it on their profile, " +
      "and queues the one touch that can actually reach them. Nothing goes out until you approve it, unless you arm autopilot.</p>" +
      "</div>";
  }

  function noticesHtml() {
    var out = "";
    if (view.lastError) {
      out += '<div class="pr-note bad"><span class="pr-note-ic">!</span><span><b>Discovery is blocked.</b> ' + esc(view.lastError) + "</span></div>";
    }
    if (view.reasons && view.reasons.length) {
      out += '<div class="pr-note warn"><span class="pr-note-ic">!</span><span><b>Not hunting yet.</b> ' +
        view.reasons.map(esc).join(" ") + "</span></div>";
    }
    // The single highest-value fact in this tool: LinkedIn's own Open-to-Work
    // filter exists and is one licence tier away. Say it plainly, once, and
    // never as an error, because the tool works without it.
    if (view.spotlight && !view.spotlight.ok) {
      out += '<div class="pr-note info"><span class="pr-note-ic">i</span><span>' +
        "<b>Running the slower way.</b> Every candidate here is confirmed by reading their profile one at a time, " +
        "which works but spends a profile view per check. LinkedIn's own Open-to-Work filter would return them directly " +
        "and would also reach the people who signal privately to recruiters rather than showing the green badge. " +
        "It needs Recruiter Professional or Corporate on at least one seat. " +
        "This tool checks once a day and switches over on its own the moment a seat is upgraded." +
        "</span></div>";
    } else if (view.spotlight && view.spotlight.ok) {
      out += '<div class="pr-note"><span class="pr-note-ic">*</span><span>' +
        "<b>Open-to-Work filter is live.</b> Candidates come straight from LinkedIn's own index, including people who signal privately." +
        "</span></div>";
    }
    return out;
  }

  function barHtml() {
    var live = view.ready && !view.paused;
    var cls = view.paused ? "paused" : (view.ready ? "live" : "down");
    var label = view.paused ? "Paused" : (view.ready ? "Hunting" : "Idle");
    var lim = view.limits || { perDay: 12, perWeek: 60 };
    return '<div class="pr-bar">' +
      '<span class="pr-state"><span class="pr-dot ' + cls + '"></span>' + label + "</span>" +
      '<span class="pr-num">Last scan <b>' + esc(ago(view.lastScan)) + "</b></span>" +
      '<span class="pr-bar-spacer"></span>' +
      '<label class="pr-switch" title="Send approved-quality drafts without waiting for a tap">' +
        '<input type="checkbox" id="prAuto"' + (view.autopilot ? " checked" : "") + ' data-busy>' +
        '<span class="pr-track"></span> Autopilot' +
      "</label>" +
      '<span class="pr-num" title="Touches per seat, per working day">Per day ' +
        '<input class="pr-limit" id="prPerDay" type="number" min="1" max="40" value="' + (lim.perDay | 0) + '" data-busy></span>' +
      '<span class="pr-num" title="Touches per seat, per rolling week">Per week ' +
        '<input class="pr-limit" id="prPerWeek" type="number" min="1" max="200" value="' + (lim.perWeek | 0) + '" data-busy></span>' +
      '<button class="btn btn-ghost btn-sm" id="prPause" data-busy>' + (view.paused ? "Resume" : "Pause") + "</button>" +
      '<button class="btn btn-sm" id="prScan" data-busy>Scan now</button>' +
      "</div>";
  }

  function talliesHtml() {
    var t = view.tallies || {};
    function cell(v, k, good) {
      return '<div class="pr-tally-cell' + (good && v ? " good" : "") + '">' +
        '<span class="pr-tally-v">' + (v | 0) + "</span><span class=\"pr-tally-k\">" + esc(k) + "</span></div>";
    }
    return '<div class="pr-tally">' +
      cell(t.drafts, "waiting on you") +
      cell(t.queued, "scheduled to send") +
      cell(t.sent7, "sent this week", true) +
      cell(t.confirmed7, "found this week") +
      cell(t.pushed, "in Candidates") +
      "</div>";
  }

  function tabsHtml() {
    var counts = view.tallies || {};
    var tabs = [
      ["queue", "Queue" + (counts.drafts ? " (" + counts.drafts + ")" : "")],
      ["searches", "Searches" + (view.hunts && view.hunts.length ? " (" + view.hunts.length + ")" : "")],
      ["sent", "Sent"],
      ["activity", "Activity"]
    ];
    return '<div class="pr-tabs" role="tablist">' + tabs.map(function (t) {
      return '<a class="pr-tab' + (t[0] === tab ? " active" : "") + '" href="#" role="tab" aria-selected="' +
        (t[0] === tab ? "true" : "false") + '" data-tab="' + t[0] + '">' + esc(t[1]) + "</a>";
    }).join("") + "</div>";
  }

  function paintBody() {
    var b = $("#prBody", host);
    if (!b) return;
    if (tab === "searches") b.innerHTML = huntsHtml();
    else if (tab === "sent") b.innerHTML = sentHtml();
    else if (tab === "activity") b.innerHTML = activityHtml();
    else b.innerHTML = queueHtml();
    wireBody();
  }

  /* ---------------- searches ---------------- */
  function huntsHtml() {
    var hunts = view.hunts || [];
    var out = "";
    if (editing) out += huntFormHtml(editing === "new" ? null : hunts.filter(function (h) { return h.id === editing; })[0]);
    else out += '<div style="display:flex;justify-content:flex-end;margin-bottom:10px">' +
      '<button class="btn btn-sm" data-newhunt>+ New search</button></div>';

    if (!hunts.length && !editing) {
      return out + '<div class="empty">No saved searches yet. Add one and Post Recruiter starts hunting on the next scan.</div>';
    }
    out += '<div class="pr-hunts">' + hunts.map(function (h) {
      var bits = [];
      if (h.location) bits.push(esc(h.location) + (h.radiusMiles ? " within " + h.radiusMiles + " mi" : ""));
      if (h.credentials && h.credentials.length) bits.push(esc(h.credentials.join(", ")));
      if (h.minYears) bits.push(h.minYears + "+ years");
      if (h.pitchRole) bits.push("pitching " + esc(h.pitchRole));
      return '<div class="pr-hunt' + (h.active ? "" : " off") + '">' +
        '<div class="pr-hunt-main">' +
          '<span class="pr-hunt-name">' + esc(h.label) + "</span>" +
          '<span class="pr-hunt-sub">' + (bits.length ? bits.map(function (x) { return "<span>" + x + "</span>"; }).join("") : "<span>Everywhere in the US</span>") + "</span>" +
          '<span class="pr-hunt-stats">' +
            "<span>screened <b>" + (h.screened | 0) + "</b></span>" +
            "<span>profiles read <b>" + (h.reads | 0) + "</b></span>" +
            "<span>open to work <b>" + (h.confirmed | 0) + "</b></span>" +
            "<span>last run " + esc(ago(h.lastRunAt)) + "</span>" +
          "</span>" +
        "</div>" +
        '<div class="pr-hunt-acts">' +
          '<label class="pr-switch" title="' + (h.active ? "Pause this search" : "Resume this search") + '">' +
            '<input type="checkbox" data-huntactive="' + esc(h.id) + '"' + (h.active ? " checked" : "") + ' data-busy>' +
            '<span class="pr-track"></span></label>' +
          '<button class="btn btn-ghost btn-sm" data-runhunt="' + esc(h.id) + '" data-busy>Run</button>' +
          '<button class="btn btn-ghost btn-sm" data-edithunt="' + esc(h.id) + '">Edit</button>' +
          '<button class="btn btn-ghost btn-sm" data-delhunt="' + esc(h.id) + '" data-busy>Delete</button>' +
        "</div>" +
      "</div>";
    }).join("") + "</div>";
    return out;
  }

  function huntFormHtml(h) {
    h = h || {};
    function f(id, label, val, hint, attrs) {
      return '<div class="pr-field"><label for="' + id + '">' + esc(label) + "</label>" +
        '<input id="' + id + '" value="' + esc(val == null ? "" : val) + '" ' + (attrs || "") + ">" +
        (hint ? '<span class="hint">' + hint + "</span>" : "") + "</div>";
    }
    return '<div class="pr-form">' +
      '<div class="pr-grid">' +
        f("prfLabel", "Name this search", h.label, "What you will recognise it by in this list.") +
        f("prfTitles", "Job titles", (h.titles || []).join(", "),
          "Comma separated. These decide who counts as a fit, and the first one is what the post lane searches for.") +
        f("prfCreds", "Must hold", (h.credentials || []).join(", "),
          "Licences or certifications, comma separated. Leave blank if the desk does not need one.") +
        f("prfLocation", "Location", h.location, "Free text, for example Dallas, Texas.") +
        f("prfRadius", "Radius (miles)", h.radiusMiles, "Optional. Needs a LinkedIn location id to apply as a hard filter.", 'type="number" min="0" max="500"') +
        f("prfLocId", "LinkedIn location id", h.locationId, "Optional. Paste from a Recruiter search URL to filter on LinkedIn's side.") +
        f("prfYears", "Minimum years", h.minYears, "Optional experience floor.", 'type="number" min="0" max="50"') +
        f("prfPitch", "Role you are pitching", h.pitchRole, "Used in the outreach copy, for example Clinical Director.") +
        f("prfKeywords", "Search keywords", h.keywords, "Boolean is allowed. Leave blank to search the job titles above.") +
      "</div>" +
      '<div class="pr-form-acts">' +
        '<button class="btn btn-ghost btn-sm" data-cancelhunt>Cancel</button>' +
        '<button class="btn btn-sm" data-savehunt="' + esc(h.id || "") + '" data-busy>' + (h.id ? "Save changes" : "Create search") + "</button>" +
      "</div></div>";
  }

  /* ---------------- queue ---------------- */
  function queueHtml() {
    var rows = (view.queue || []);
    if (!rows.length) {
      return '<div class="empty">Nothing waiting. Post Recruiter adds people here as it confirms them, ' +
        "roughly every twenty minutes while a search is active.</div>";
    }
    return '<div class="pr-leads">' + rows.map(leadHtml).join("") + "</div>";
  }

  function leadHtml(l) {
    var max = MAX[l.channel] || 300;
    var len = (l.draft || "").length;
    var pending = l.status === "draft";
    var fitCls = l.fit >= 70 ? "hi" : l.fit >= 45 ? "mid" : "";
    var name = l.profileUrl
      ? '<a href="' + esc(l.profileUrl) + '" target="_blank" rel="noopener">' + esc(l.name) + "</a>"
      : esc(l.name);

    var meta = [];
    if (l.location) meta.push(esc(l.location));
    if (l.years) meta.push(l.years + " years");
    if (l.connections) meta.push(l.connections + " connections");
    if (l.credentials && l.credentials.length) meta.push(esc(l.credentials.slice(0, 3).join(", ")));

    var post = "";
    if (l.postText) {
      post = '<div class="pr-post">' + esc(l.postText.slice(0, 340)) + (l.postText.length > 340 ? "..." : "") +
        (l.postUrl ? ' <a href="' + esc(l.postUrl) + '" target="_blank" rel="noopener">Open post</a>' : "") +
        (l.postAt ? ' <span style="color:var(--text-dim)">posted ' + esc(ago(l.postAt)) + "</span>" : "") +
        "</div>";
    }

    var statusChip = l.status === "queued" ? '<span class="pr-chip queued">Scheduled</span>'
      : l.status === "failed" ? '<span class="pr-chip failed">Not sent</span>' : "";

    return '<div class="pr-lead' + (l.status === "failed" ? " failed" : "") + '" data-lead="' + esc(l.id) + '">' +
      '<div class="pr-lead-top">' +
        '<div class="pr-lead-id">' +
          '<span class="pr-lead-name">' + name +
            '<span class="pr-chip otw">Open to work</span>' +
            '<span class="pr-chip ' + esc(l.channel) + '">' + esc(CHANNEL_LABEL[l.channel] || l.channel) + "</span>" +
            statusChip +
          "</span>" +
          '<span class="pr-lead-head">' + esc(l.headline || l.currentTitle || "") + "</span>" +
          '<span class="pr-lead-meta">' + meta.map(function (m) { return "<span>" + m + "</span>"; }).join("") + "</span>" +
        "</div>" +
        '<div class="pr-lead-right">' +
          '<div class="pr-fit"><span class="pr-fit-v ' + fitCls + '">' + (l.fit | 0) + '</span><span class="pr-fit-k">fit</span></div>' +
        "</div>" +
      "</div>" +
      '<div class="pr-why"><span>' + esc(l.evidence) + "</span>" +
        (l.fitWhy || []).map(function (w) { return "<span>" + esc(w) + "</span>"; }).join("") + "</div>" +
      post +
      (l.statusReason ? '<div class="pr-note bad" style="padding:8px 11px">' + esc(l.statusReason) + "</div>" : "") +
      (pending
        ? '<textarea class="pr-draft" data-draft="' + esc(l.id) + '" maxlength="' + (max + 60) + '">' + esc(l.draft || "") + "</textarea>"
        : '<div class="pr-post" style="border-left-color:var(--brand)">' + esc(l.draft || "") + "</div>") +
      '<div class="pr-lead-acts">' +
        (pending
          ? '<button class="btn btn-sm" data-approve="' + esc(l.id) + '" data-busy>Send</button>' +
            '<button class="btn btn-ghost btn-sm" data-skip="' + esc(l.id) + '" data-busy>Skip</button>'
          : "") +
        '<button class="btn btn-ghost btn-sm" data-push="' + esc(l.id) + '" data-busy>' +
          (l.pushedAt ? "In Candidates" : "Add to Candidates") + "</button>" +
        '<span class="pr-count' + (len > max ? " over" : "") + '" data-count="' + esc(l.id) + '">' + len + " / " + max + "</span>" +
      "</div>" +
    "</div>";
  }

  /* ---------------- sent ---------------- */
  function sentHtml() {
    var rows = view.sent || [];
    if (!rows.length) return '<div class="empty">Nothing has gone out yet.</div>';
    return '<div class="pr-table-wrap"><table class="pr-table"><thead><tr>' +
      "<th>Candidate</th><th>Touch</th><th>Evidence</th><th>Sent</th><th></th>" +
      "</tr></thead><tbody>" + rows.map(function (l) {
        return "<tr>" +
          "<td><b>" + (l.profileUrl ? '<a href="' + esc(l.profileUrl) + '" target="_blank" rel="noopener" style="color:inherit">' + esc(l.name) + "</a>" : esc(l.name)) + "</b>" +
            '<div style="color:var(--text-dim);font-size:11.5px">' + esc(l.currentTitle || l.headline || "") + "</div></td>" +
          '<td><span class="pr-chip ' + esc(l.channel) + '">' + esc(CHANNEL_LABEL[l.channel] || l.channel) + "</span></td>" +
          '<td style="color:var(--text-muted)">' + esc(l.evidence) + "</td>" +
          '<td class="n">' + esc(ago(l.sentAt || l.createdAt)) + "</td>" +
          '<td class="n"><button class="btn btn-ghost btn-sm" data-push="' + esc(l.id) + '" data-busy>' +
            (l.pushedAt ? "In Candidates" : "Add to Candidates") + "</button></td>" +
        "</tr>";
      }).join("") + "</tbody></table></div>";
  }

  /* ---------------- activity ---------------- */
  function activityHtml() {
    var seats = view.seats || [];
    var stats = view.stats || [];
    var out = "";

    out += '<h2 style="font-size:15px;margin:0 0 8px">Seats today</h2>';
    if (!seats.length) out += '<div class="empty">No LinkedIn seat is connected.</div>';
    else {
      out += '<div class="pr-table-wrap"><table class="pr-table"><thead><tr>' +
        "<th>Recruiter</th><th>Touches</th><th></th><th>Profile views</th><th></th>" +
        "</tr></thead><tbody>" + seats.map(function (s) {
          var tp = Math.min(100, Math.round(100 * (s.today || 0) / Math.max(1, s.allowance)));
          var vp = Math.min(100, Math.round(100 * (s.views || 0) / Math.max(1, s.viewCap)));
          return "<tr><td><b>" + esc(s.name || s.accountId) + "</b></td>" +
            '<td class="n">' + (s.today | 0) + " / " + (s.allowance | 0) + "</td>" +
            '<td><span class="pr-meter"><i class="' + (tp >= 100 ? "full" : tp >= 75 ? "hot" : "") + '" style="width:' + tp + '%"></i></span></td>' +
            '<td class="n">' + (s.views | 0) + " / " + (s.viewCap | 0) + "</td>" +
            '<td><span class="pr-meter"><i class="' + (vp >= 100 ? "full" : vp >= 75 ? "hot" : "") + '" style="width:' + vp + '%"></i></span></td>' +
          "</tr>";
        }).join("") + "</tbody></table></div>";
      out += '<p style="font-size:11.5px;color:var(--text-dim);margin:8px 0 0;max-width:70ch;line-height:1.5">' +
        "Profile views are the number LinkedIn actually counts against an account, so this lane caps them per seat " +
        "and stops scanning when a seat runs out rather than borrowing from tomorrow. Role Hunter shares these same seats." +
        "</p>";
    }

    out += '<h2 style="font-size:15px;margin:22px 0 8px">What the hunt has been spending</h2>';
    if (!stats.length) out += '<div class="empty">No scans recorded yet.</div>';
    else {
      out += '<div class="pr-table-wrap"><table class="pr-table"><thead><tr>' +
        "<th>Day</th><th>Searches</th><th>Screened</th><th>Ruled out</th><th>Profiles read</th><th>Open to work</th><th>Sent</th>" +
        "</tr></thead><tbody>" + stats.slice().reverse().map(function (s) {
          return "<tr><td class=\"n\">" + esc(s.day) + "</td>" +
            '<td class="n">' + (s.searches | 0) + "</td>" +
            '<td class="n">' + (s.screened | 0) + "</td>" +
            '<td class="n">' + (s.vetoed | 0) + "</td>" +
            '<td class="n">' + (s.reads | 0) + "</td>" +
            '<td class="n" style="color:var(--ok);font-weight:600">' + (s.confirmed | 0) + "</td>" +
            '<td class="n">' + (s.sent | 0) + "</td></tr>";
        }).join("") + "</tbody></table></div>";
    }
    return out;
  }

  /* ---------------- wiring ---------------- */
  function wireBar() {
    var scan = $("#prScan", host);
    if (scan) scan.addEventListener("click", function () { run(function () { return act("scan", {}); }); });

    var pause = $("#prPause", host);
    if (pause) pause.addEventListener("click", function () {
      run(function () { return act(view.paused ? "resume" : "pause", {}); });
    });

    var auto = $("#prAuto", host);
    if (auto) auto.addEventListener("change", function () {
      var on = auto.checked;
      run(function () { return act(on ? "auto_on" : "auto_off", {}); });
    });

    ["prPerDay", "prPerWeek"].forEach(function (id) {
      var inp = $("#" + id, host);
      if (!inp) return;
      inp.addEventListener("change", function () {
        run(function () {
          return act("limits_set", {
            perDay: Number(($("#prPerDay", host) || {}).value) || undefined,
            perWeek: Number(($("#prPerWeek", host) || {}).value) || undefined
          });
        });
      });
    });

    $$(".pr-tab[data-tab]", host).forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        tab = a.getAttribute("data-tab");
        editing = null;
        paint();
      });
    });
  }

  function wireBody() {
    var b = $("#prBody", host);
    if (!b) return;

    // Live character count, so nobody writes a note the engine will refuse.
    $$("[data-draft]", b).forEach(function (t) {
      t.addEventListener("input", function () {
        var id = t.getAttribute("data-draft");
        var lead = (view.queue || []).filter(function (x) { return x.id === id; })[0];
        var max = MAX[lead && lead.channel] || 300;
        var c = $('[data-count="' + id + '"]', b);
        if (c) {
          c.textContent = t.value.length + " / " + max;
          c.classList.toggle("over", t.value.length > max);
        }
      });
    });

    b.addEventListener("click", function (e) {
      var t = e.target.closest("button, [data-huntactive]");
      if (!t) return;

      var id;
      if ((id = t.getAttribute && t.getAttribute("data-approve"))) {
        var box = $('[data-draft="' + id + '"]', b);
        var text = box ? box.value : undefined;
        run(function () { return act("approve", { id: id, text: text }); });
        return;
      }
      if ((id = t.getAttribute("data-skip"))) { run(function () { return act("skip", { id: id }); }); return; }
      if ((id = t.getAttribute("data-push"))) {
        if (t.textContent.indexOf("In Candidates") === 0) return;
        run(function () { return act("push", { ids: [id] }); });
        return;
      }
      if ((id = t.getAttribute("data-runhunt"))) { run(function () { return act("scan", { huntId: id }); }); return; }
      if ((id = t.getAttribute("data-edithunt"))) { editing = id; paintBody(); return; }
      if ((id = t.getAttribute("data-delhunt"))) {
        if (!confirm("Delete this search? Anything already waiting in the queue for it is dropped too.")) return;
        run(function () { return act("hunt_remove", { id: id }); });
        return;
      }
      if (t.hasAttribute && t.hasAttribute("data-newhunt")) { editing = "new"; paintBody(); return; }
      if (t.hasAttribute && t.hasAttribute("data-cancelhunt")) { editing = null; paintBody(); return; }
      if (t.hasAttribute && t.hasAttribute("data-savehunt")) { saveHunt(t.getAttribute("data-savehunt")); return; }
    });

    b.addEventListener("change", function (e) {
      var t = e.target;
      var id = t.getAttribute && t.getAttribute("data-huntactive");
      if (!id) return;
      var on = t.checked;
      run(function () { return act("hunt_toggle", { id: id, active: on }); });
    });
  }

  function saveHunt(id) {
    function val(sel) { var e = $(sel, host); return e ? e.value.trim() : ""; }
    var titles = val("#prfTitles");
    if (!titles) { alert("Add at least one job title, so Post Recruiter knows who counts as a fit."); return; }
    var payload = {
      id: id || undefined,
      label: val("#prfLabel") || titles.split(",")[0].trim(),
      titles: titles,
      credentials: val("#prfCreds"),
      location: val("#prfLocation"),
      locationId: val("#prfLocId"),
      radiusMiles: Number(val("#prfRadius")) || undefined,
      minYears: Number(val("#prfYears")) || undefined,
      pitchRole: val("#prfPitch"),
      keywords: val("#prfKeywords") || titles.split(",").map(function (s) { return '"' + s.trim() + '"'; }).join(" OR ")
    };
    editing = null;
    run(function () { return act("hunt_save", payload); });
  }

  window.__PostRecruiter = { render: render, refresh: refresh };
})();
