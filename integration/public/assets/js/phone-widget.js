/*
 * RecruitersOS · Popup dialer (/phone-widget)
 *
 * A compact click-to-call window opened by other apps on this origin (OS Text
 * conversation rows, and anywhere else a phone number shows). The page hosts
 * the SAME persistent BD Phone engine the portal uses (bd-phone.js mounts its
 * client + call bar overlay on any body.app page with a portal session), so a
 * call placed here uses the recruiter's assigned line, records into call
 * history, and gets AI notes exactly like a call placed in the portal.
 *
 * This file is only the thin idle-state UI around the engine: contact card,
 * status line, the Call button, and the sign-in / no-line / other-tab edge
 * states. In-call controls (mute, hold, keypad, live notes, hang up) are the
 * engine's own floating bar at the bottom of the window.
 *
 * Query params: to (E.164 or raw), name, company, theme, accent.
 */
(function () {
  "use strict";

  var qs = new URLSearchParams(location.search);
  var TO = (qs.get("to") || qs.get("dial") || "").trim();
  var NAME = (qs.get("name") || "").trim();
  var COMPANY = (qs.get("company") || "").trim();
  var ACCENT = (qs.get("accent") || "").trim();

  if (ACCENT && window.__wlTheme) { try { window.__wlTheme(ACCENT); } catch (e) {} }
  if (NAME || TO) document.title = "Call " + (NAME || fmtNum(TO));

  var main = document.getElementById("pwgMain");
  var lineEl = document.getElementById("pwgLine");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtNum(n) {
    var d = String(n || "").replace(/\D/g, "");
    if (d.length === 11 && d.charAt(0) === "1") d = d.slice(1);
    if (d.length === 10) return "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6);
    return n || "";
  }
  function initials() {
    var src = NAME || "";
    var parts = src.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "#";
    return (parts[0].charAt(0) + (parts[1] ? parts[1].charAt(0) : "")).toUpperCase();
  }

  /* Not signed in to the portal in this browser: the engine never started. */
  var ctx = null;
  try { ctx = JSON.parse(localStorage.getItem("ros_ctx") || "null"); } catch (e) {}
  if (!ctx || !window.__bdPhone) {
    main.innerHTML =
      '<div class="pwg-status"><span class="pwg-dot red"></span><span>Not connected</span></div>' +
      '<div class="pwg-note">Sign in to RecruitersOS in this browser first, then reopen this dialer.</div>' +
      '<button class="pwg-ghost" id="pwgLogin">Open RecruitersOS</button>';
    var lb = document.getElementById("pwgLogin");
    if (lb) lb.addEventListener("click", function () { window.open("/login", "_blank"); });
    return;
  }

  var eng = window.__bdPhone;
  var autoDialed = false;
  var takeoverTried = false;
  var dialError = "";
  var liveElsewhereNote = "";

  function card() {
    var who = NAME || fmtNum(TO) || "Unknown";
    return (
      '<div class="pwg-avatar">' + esc(initials()) + "</div>" +
      '<div class="pwg-who">' +
        '<div class="pwg-name">' + esc(who) + "</div>" +
        '<div class="pwg-meta">' +
          (TO ? '<span class="pwg-num">' + esc(fmtNum(TO)) + "</span>" : "") +
          (COMPANY ? (TO ? " · " : "") + esc(COMPANY) : "") +
        "</div>" +
      "</div>"
    );
  }
  function status(dotCls, text) {
    return '<div class="pwg-status"><span class="pwg-dot ' + dotCls + '"></span><span>' + esc(text) + "</span></div>";
  }
  function callBtn(label, disabled) {
    return (
      '<div class="pwg-actions"><button class="pwg-call" id="pwgCall"' + (disabled ? " disabled" : "") + ">" +
      '<svg class="isvg"><use href="#pwg-phone"/></svg>' + esc(label) + "</button></div>"
    );
  }

  function dialNow() {
    if (!TO) return;
    dialError = "";
    eng.dial(TO).catch(function (e) {
      var code = (e && e.body && e.body.error) || "";
      if (code === "no_line" || code === "line_not_assigned") {
        dialError = "No phone number is assigned to you yet. An admin can assign one in the portal under BD Phone, Numbers.";
      } else {
        dialError = (e && e.message) || "The call could not be started.";
      }
      render(eng.getState());
    });
  }

  /* Another portal tab currently owns the phone. If it is NOT mid-call, take
   * the phone over into this window (that is what opening a dialer means);
   * if it is mid-call, say so instead of killing the live call. */
  function maybeTakeover() {
    if (takeoverTried) return;
    takeoverTried = true;
    fetch("/api/phone/summary?motion=bd", { credentials: "include" })
      .then(function (r) { if (!r.ok) throw new Error("api_" + r.status); return r.json(); })
      .then(function (sum) {
        var live = sum && sum.liveCall &&
          ["ringing", "active", "held"].indexOf(sum.liveCall.status) >= 0;
        if (live) {
          liveElsewhereNote = "You are already on a call in another tab. Finish it there, then call from here.";
          render(eng.getState());
        } else {
          eng.takeLeader();
        }
      })
      .catch(function () { eng.takeLeader(); });
  }

  function render(S) {
    /* Header: which line this call presents. */
    var line = null;
    if (S.summary && S.summary.lines) {
      for (var i = 0; i < S.summary.lines.length; i++) {
        if (S.summary.lines[i].id === S.summary.activeLineId) line = S.summary.lines[i];
      }
      if (!line && S.summary.lines.length) line = S.summary.lines[0];
    }
    lineEl.textContent = line ? "from " + fmtNum(line.e164) : "";

    var html = card();
    var phase = S.phase;

    if (phase === "leaderelse") {
      html += status("amber", "Phone is open in another tab");
      html += '<div class="pwg-note">' + esc(liveElsewhereNote || "Taking the phone over into this window.") + "</div>";
      // No takeover button while a call is live elsewhere: taking the phone
      // would drop that call.
      if (!liveElsewhereNote) {
        html += '<div class="pwg-actions"><button class="pwg-ghost" id="pwgTake">Use the phone here</button></div>';
      }
    } else if (phase === "nolines") {
      html += status("red", "No line assigned");
      html += '<div class="pwg-note">No phone number is assigned to you yet. An admin can assign one in the portal under BD Phone, Numbers.</div>';
    } else if (phase === "boot" || phase === "connecting" || phase === "reconnecting") {
      html += status("amber", phase === "reconnecting" ? "Reconnecting" : "Connecting");
      html += callBtn("Call", true);
    } else if (phase === "ready") {
      if (dialError) {
        html += status("red", "Could not start the call");
        html += '<div class="pwg-note err">' + esc(dialError) + "</div>";
        html += callBtn("Try again", false);
      } else {
        html += status("green", "Ready");
        html += callBtn("Call", !TO);
        if (!TO) html += '<div class="pwg-note">No number was passed to this dialer.</div>';
      }
    } else if (phase === "dialing") {
      html += status("amber", "Calling");
      html += '<div class="pwg-note">Ringing the number now. Use the bar below to end the call.</div>';
    } else if (phase === "incoming") {
      html += status("amber", "Incoming call");
      html += '<div class="pwg-note">Answer or decline in the card below.</div>';
    } else if (phase === "active" || phase === "held") {
      html += status(phase === "active" ? "green" : "amber", phase === "active" ? "On call" : "On hold");
      html += '<div class="pwg-timer">' + eng.fmtDur(S.elapsed) + "</div>" +
        '<div class="pwg-note">Mute, hold, keypad, notes, and hang up live in the bar below. Keep this window open while you talk.</div>';
    } else if (phase === "ended") {
      var st = S.call && S.call.status;
      html += status("", st === "completed" ? "Call ended" : "Ended");
      html += callBtn("Call again", !TO);
    } else if (phase === "error-mic") {
      html += status("red", "Microphone blocked");
      html += '<div class="pwg-note err">Allow the microphone for this site in your browser, then try again.</div>';
      html += callBtn("Try again", !TO);
    } else if (phase === "error-conn") {
      html += status("red", "Not connected");
      html += '<div class="pwg-note err">' + esc(S.error || "The phone service is unreachable.") + "</div>" +
        '<div class="pwg-actions"><button class="pwg-ghost" id="pwgRetry">Retry</button></div>';
    } else {
      html += status("", "");
    }

    main.innerHTML = html;

    var b = document.getElementById("pwgCall");
    if (b) b.addEventListener("click", dialNow);
    var tk = document.getElementById("pwgTake");
    if (tk) tk.addEventListener("click", function () { takeoverTried = true; eng.takeLeader(); });
    var rt = document.getElementById("pwgRetry");
    if (rt) rt.addEventListener("click", function () { eng.reconnect(); });
  }

  eng.subscribe(function (S) {
    if (S.phase === "leaderelse") maybeTakeover();
    if (S.phase === "ready" && TO && !autoDialed) {
      autoDialed = true;
      dialNow();
    }
    render(S);
  });
  render(eng.getState());
  if (eng.getState().phase === "leaderelse") maybeTakeover();
})();
