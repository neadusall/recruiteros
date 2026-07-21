/*
 * RecruitersOS · BD Phone engine (persistent)
 *
 * The browser side of the Business Development phone. Loaded once by
 * command.html AFTER command.js and mounted OUTSIDE the SPA view (#view), so
 * a live WebRTC call survives every hash-route navigation. The BD Phone tab
 * (renderBdPhone in command.js) is a thin controller over this engine via
 * window.__bdPhone; the engine owns:
 *
 *  - the Telnyx WebRTC client (vendored SDK, lazy-loaded on first need)
 *  - login tokens (minted server-side; the API key never reaches the browser)
 *  - one-leader-per-user tab election (two tabs must not both register, or
 *    inbound calls would ring twice)
 *  - the global overlay: incoming-call card, floating active-call bar,
 *    live notes, DTMF keypad, audio-device pickers
 *  - reconnection, mic-permission and connection error states
 *
 * Server webhooks drive the call RECORD (recording -> transcript -> AI notes);
 * this engine drives the call MEDIA and the in-call UX.
 */
(function () {
  "use strict";
  if (!document.body || !document.body.classList.contains("app")) return;

  /* ---------------- session / api (mirrors command.js) ---------------- */
  var IMP_TOKEN = null;
  try { IMP_TOKEN = sessionStorage.getItem("ros_imp_token") || null; } catch (e) {}
  var ctx = null;
  try {
    ctx = JSON.parse((IMP_TOKEN ? sessionStorage.getItem("ros_imp_ctx") : localStorage.getItem("ros_ctx")) || "null");
  } catch (e) {}
  if (!ctx) return;
  var CAPS = (ctx && ctx.capabilities) || [];
  if (CAPS.length && CAPS.indexOf("voice:dial") < 0) return;

  var API = (window.RECRUITEROS_API_BASE || "") + "/api";
  function headers(extra) {
    var h = extra || {};
    if (IMP_TOKEN) h["Authorization"] = "Bearer " + IMP_TOKEN;
    return h;
  }
  function api(path) {
    return fetch(API + path, { credentials: "include", headers: headers() })
      .then(function (r) { if (!r.ok) throw new Error("api_" + r.status); return r.json(); });
  }
  function send(path, payload) {
    return fetch(API + path, {
      method: "POST", credentials: "include",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload || {}),
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) { var e = new Error((j && j.error) || ("api_" + r.status)); e.body = j; throw e; }
        return j;
      });
    });
  }

  /* ---------------- state ---------------- */
  var S = {
    phase: "boot",        // boot | nolines | leaderelse | connecting | ready |
                          // dialing | incoming | active | held | ended |
                          // error-mic | error-conn | reconnecting
    summary: null,         // /phone/summary payload
    call: null,            // server CallRecord for the live/most recent call
    sdkCall: null,         // Telnyx SDK Call object
    muted: false,
    held: false,
    elapsed: 0,            // seconds since answered
    error: "",
    leader: false,
    notesDraft: null,      // unsent live-notes text
    devices: { mics: [], speakers: [], micId: "", speakerId: "" },
    endedInfo: null,       // {callId, status} shown briefly after hangup
    micLevel: 0,           // live input level 0..1 while a call is active
  };
  var subs = [];
  function emit() {
    for (var i = 0; i < subs.length; i++) { try { subs[i](S); } catch (e) {} }
    renderOverlay();
  }

  /* ---------------- tab leader election ---------------- */
  var TAB_ID = Math.random().toString(36).slice(2);
  var LEADER_KEY = "ros_phone_leader";
  function leaderRec() {
    try { return JSON.parse(localStorage.getItem(LEADER_KEY) || "null"); } catch (e) { return null; }
  }
  function claimLeader(force) {
    var cur = leaderRec();
    var stale = !cur || (Date.now() - (cur.at || 0)) > 10000;
    if (force || stale || cur.id === TAB_ID) {
      try { localStorage.setItem(LEADER_KEY, JSON.stringify({ id: TAB_ID, at: Date.now() })) } catch (e) {}
      return true;
    }
    return cur.id === TAB_ID;
  }
  function heartbeat() {
    if (S.leader) {
      var cur = leaderRec();
      if (cur && cur.id !== TAB_ID) { demote(); return; }
      try { localStorage.setItem(LEADER_KEY, JSON.stringify({ id: TAB_ID, at: Date.now() })) } catch (e) {}
    } else if (!leaderRec() || (Date.now() - (leaderRec().at || 0)) > 12000) {
      promote();
    }
  }
  setInterval(heartbeat, 4000);
  window.addEventListener("storage", function (ev) {
    if (ev.key === LEADER_KEY) {
      var cur = leaderRec();
      if (S.leader && cur && cur.id !== TAB_ID) demote();
    }
  });
  window.addEventListener("beforeunload", function () {
    var cur = leaderRec();
    if (cur && cur.id === TAB_ID) { try { localStorage.removeItem(LEADER_KEY); } catch (e) {} }
  });

  function promote() {
    if (!claimLeader(false)) { S.leader = false; setPhase("leaderelse"); return; }
    S.leader = true;
    boot();
  }
  function demote() {
    S.leader = false;
    teardownClient("leaderelse");
  }
  function takeLeader() {
    claimLeader(true);
    S.leader = true;
    boot();
  }

  /* ---------------- boot / summary ---------------- */
  var client = null;
  var sdkLoaded = false;
  var reconnectTimer = null;
  var reconnectDelay = 2000;

  function setPhase(p, err) {
    S.phase = p;
    S.error = err || "";
    emit();
  }

  function boot() {
    setPhase("connecting");
    api("/phone/summary?motion=bd").then(function (sum) {
      S.summary = sum;
      if (sum.liveCall) S.call = sum.liveCall;
      if (!sum.lines || !sum.lines.length) { setPhase("nolines"); return; }
      loadSdk().then(connect).catch(function () {
        setPhase("error-conn", "The calling library failed to load. Refresh to retry.");
      });
    }).catch(function () {
      setPhase("error-conn", "Could not reach the phone service.");
    });
  }

  function refreshSummary() {
    return api("/phone/summary?motion=bd").then(function (sum) {
      S.summary = sum;
      emit();
      return sum;
    });
  }

  function loadSdk() {
    if (sdkLoaded || window.TelnyxWebRTC) { sdkLoaded = true; return Promise.resolve(); }
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "/assets/js/vendor/telnyx-webrtc.js";
      s.onload = function () { sdkLoaded = true; resolve(); };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function connect() {
    if (!S.leader) return;
    send("/phone/token", {}).then(function (t) {
      if (!t || !t.token) { setPhase("error-conn", "Calling is not configured yet. An admin can connect it in BD Phone, Numbers."); return; }
      try {
        var TelnyxRTC = window.TelnyxWebRTC.TelnyxRTC;
        client = new TelnyxRTC({ login_token: t.token });
        client.remoteElement = "bdpRemote";
        wireClient();
        client.connect();
      } catch (e) {
        setPhase("error-conn", "Could not start the calling client.");
      }
    }).catch(function (e) {
      var msg = String((e && e.message) || "");
      setPhase("error-conn", msg.indexOf("telnyx") >= 0 || msg.indexOf("409") >= 0
        ? "Calling is not configured yet. An admin can connect it in BD Phone, Numbers."
        : "Could not get a calling token.");
    });
  }

  function teardownClient(nextPhase) {
    try { if (client) client.disconnect(); } catch (e) {}
    client = null;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    setPhase(nextPhase || "boot");
  }

  function scheduleReconnect() {
    if (reconnectTimer || !S.leader) return;
    setPhase("reconnecting", "Connection lost. Reconnecting.");
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 1.6, 20000);
      connect();
    }, reconnectDelay);
  }

  function wireClient() {
    client.on("telnyx.ready", function () {
      reconnectDelay = 2000;
      if (S.phase === "connecting" || S.phase === "reconnecting" || S.phase === "boot") {
        setPhase(S.call && isLive(S.call) ? phaseForCall() : "ready");
      }
      refreshDevices();
    });
    client.on("telnyx.error", function () {
      if (S.phase !== "active" && S.phase !== "held") scheduleReconnect();
    });
    client.on("telnyx.socket.close", function () { scheduleReconnect(); });
    client.on("telnyx.notification", function (n) {
      if (n.type === "userMediaError") {
        setPhase("error-mic", "Microphone access is blocked. Allow the microphone in your browser and retry.");
        return;
      }
      if (n.type === "callUpdate" && n.call) handleCallUpdate(n.call);
    });
  }

  /* ---------------- SDK call handling ---------------- */
  var pendingOutbound = null; // {callId, until}
  var callTimer = null;

  function isLive(c) { return c && (c.status === "ringing" || c.status === "active" || c.status === "held"); }
  function phaseForCall() {
    if (!S.call) return "ready";
    if (S.call.status === "active") return S.held ? "held" : "active";
    if (S.call.status === "held") return "held";
    if (S.call.status === "ringing") return S.call.direction === "outbound" ? "dialing" : "incoming";
    return "ready";
  }

  function handleCallUpdate(call) {
    var st = call.state;
    if (st === "ringing") {
      // Every browser leg arrives as an SDK "inbound" call, including the agent
      // leg of our own click-to-dial. Auto-answer that one; ring for real inbound.
      S.sdkCall = call;
      if (pendingOutbound && Date.now() < pendingOutbound.until) {
        try { call.answer(); } catch (e) {}
        return;
      }
      onInboundRinging(call);
      return;
    }
    if (S.sdkCall && call.id !== S.sdkCall.id) return; // stray leg
    if (st === "active") {
      stopRingtone();
      S.sdkCall = call;
      S.muted = false;
      S.held = false;
      if (pendingOutbound) {
        // Our agent leg is up; the far end may still be ringing. The server
        // record flips to active on the PSTN answer webhook; poll it.
        setPhase("dialing");
        pollLiveCall();
      } else {
        startTimer();
        startMicMeter();
        setPhase("active");
        pollLiveCall();
      }
    } else if (st === "held") {
      S.held = true;
      setPhase("held");
    } else if (st === "hangup" || st === "destroy") {
      onSdkEnded();
    }
  }

  function onInboundRinging(sdkCall) {
    startRingtone();
    refreshSummary().then(function (sum) {
      if (sum.liveCall && sum.liveCall.direction === "inbound" && isLive(sum.liveCall)) {
        S.call = sum.liveCall;
      } else {
        S.call = {
          id: "", direction: "inbound", status: "ringing",
          externalNumber: (sdkCall.options && (sdkCall.options.remoteCallerNumber || sdkCall.options.callerNumber)) || "",
          contactName: (sdkCall.options && sdkCall.options.callerName) || "",
        };
      }
      setPhase("incoming");
      browserNotify();
    }).catch(function () { setPhase("incoming"); });
  }

  function onSdkEnded() {
    stopRingtone();
    stopTimer();
    stopMicMeter();
    var ended = S.call;
    S.sdkCall = null;
    pendingOutbound = null;
    S.muted = false;
    S.held = false;
    if (ended && ended.id) {
      S.endedInfo = { callId: ended.id, at: Date.now() };
      // Let the server finalize, then pull the record for accurate status.
      setTimeout(function () {
        api("/phone/calls/" + ended.id).then(function (d) {
          S.call = d.call; emit();
        }).catch(function () {});
      }, 1200);
    }
    setPhase("ended");
    setTimeout(function () {
      if (S.phase === "ended") { S.endedInfo = null; setPhase("ready"); }
    }, 8000);
  }

  var pollTimer = null;
  function pollLiveCall() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      if (!S.call || !S.call.id) return;
      api("/phone/calls/" + S.call.id).then(function (d) {
        var was = S.call.status;
        S.call = d.call;
        if (was !== "active" && d.call.status === "active" && pendingOutbound) {
          pendingOutbound = null;
          startTimer();
          startMicMeter();
          setPhase("active");
        }
        if (!isLive(d.call) && (S.phase === "dialing" || S.phase === "active" || S.phase === "held" || S.phase === "incoming")) {
          // Server says it is over (declined elsewhere, failed, ...); if the
          // SDK leg is somehow still up, drop it.
          try { if (S.sdkCall) S.sdkCall.hangup(); } catch (e) {}
          onSdkEnded();
        }
        emit();
      }).catch(function () {});
      if (!isLive(S.call) && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }, 4000);
  }

  function startTimer() {
    stopTimer();
    S.elapsed = 0;
    callTimer = setInterval(function () { S.elapsed++; emit(); }, 1000);
  }
  function stopTimer() {
    if (callTimer) { clearInterval(callTimer); callTimer = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  /* ---------------- mic level meter (real input level, no fake motion) --- */
  var meterTimer = null, meterAnalyser = null, meterSrc = null;
  function startMicMeter() {
    stopMicMeter();
    try {
      var stream = S.sdkCall && (S.sdkCall.localStream || (S.sdkCall.options && S.sdkCall.options.localStream));
      if (!stream || !stream.getAudioTracks || !stream.getAudioTracks().length) return;
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      meterSrc = audioCtx.createMediaStreamSource(stream);
      meterAnalyser = audioCtx.createAnalyser();
      meterAnalyser.fftSize = 512;
      meterSrc.connect(meterAnalyser);
      var buf = new Uint8Array(meterAnalyser.frequencyBinCount);
      meterTimer = setInterval(function () {
        if (!meterAnalyser) return;
        meterAnalyser.getByteTimeDomainData(buf);
        var peak = 0;
        for (var i = 0; i < buf.length; i += 4) {
          var v = Math.abs(buf[i] - 128) / 128;
          if (v > peak) peak = v;
        }
        // Muted mic reads as silence; show that truthfully.
        S.micLevel = S.muted ? 0 : Math.min(1, peak * 1.6);
      }, 120);
    } catch (e) {}
  }
  function stopMicMeter() {
    if (meterTimer) { clearInterval(meterTimer); meterTimer = null; }
    try { if (meterSrc) meterSrc.disconnect(); } catch (e) {}
    meterSrc = null; meterAnalyser = null;
    S.micLevel = 0;
  }

  /* ---------------- ringtone (WebAudio, no assets) ---------------- */
  var audioCtx = null, ringInterval = null;
  function startRingtone() {
    stopRingtone();
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      var ring = function () {
        var o = audioCtx.createOscillator(), o2 = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.frequency.value = 440; o2.frequency.value = 480;
        g.gain.value = 0.08;
        o.connect(g); o2.connect(g); g.connect(audioCtx.destination);
        o.start(); o2.start();
        setTimeout(function () { try { o.stop(); o2.stop(); g.disconnect(); } catch (e) {} }, 1600);
      };
      ring();
      ringInterval = setInterval(ring, 3600);
    } catch (e) {}
  }
  function stopRingtone() {
    if (ringInterval) { clearInterval(ringInterval); ringInterval = null; }
  }

  function browserNotify() {
    try {
      if (!("Notification" in window) || Notification.permission !== "granted") return;
      var who = (S.call && (S.call.contactName || S.call.externalNumber)) || "Unknown caller";
      var n = new Notification("Incoming call", { body: who + (S.call && S.call.companyName ? " · " + S.call.companyName : ""), tag: "ros-bd-phone" });
      n.onclick = function () { try { window.focus(); } catch (e) {} n.close(); };
    } catch (e) {}
  }

  /* ---------------- devices ---------------- */
  function refreshDevices() {
    if (!client) return;
    Promise.all([
      client.getAudioInDevices ? client.getAudioInDevices() : Promise.resolve([]),
      client.getAudioOutDevices ? client.getAudioOutDevices() : Promise.resolve([]),
    ]).then(function (r) {
      S.devices.mics = (r[0] || []).map(function (d) { return { id: d.deviceId, label: d.label || "Microphone" }; });
      S.devices.speakers = (r[1] || []).map(function (d) { return { id: d.deviceId, label: d.label || "Speaker" }; });
      emit();
    }).catch(function () {});
  }
  function setMic(id) {
    S.devices.micId = id;
    try { if (S.sdkCall && S.sdkCall.setAudioInDevice) S.sdkCall.setAudioInDevice(id); } catch (e) {}
    try { if (client && client.setAudioSettings) client.setAudioSettings({ micId: id }); } catch (e) {}
    emit();
  }
  function setSpeaker(id) {
    S.devices.speakerId = id;
    try { if (S.sdkCall && S.sdkCall.setAudioOutDevice) S.sdkCall.setAudioOutDevice(id); } catch (e) {}
    try { if (client) client.speaker = id; } catch (e) {}
    var el = document.getElementById("bdpRemote");
    try { if (el && el.setSinkId) el.setSinkId(id); } catch (e) {}
    emit();
  }

  /* ---------------- public actions ---------------- */
  function dial(number, lineId) {
    if (!S.leader) return Promise.reject(new Error("Phone is active in another tab."));
    if (S.phase !== "ready" && S.phase !== "ended") return Promise.reject(new Error("A call is already in progress."));
    return send("/phone/dial", { to: number, lineId: lineId || (S.summary && S.summary.activeLineId), motion: "bd" })
      .then(function (d) {
        S.call = d.call;
        pendingOutbound = { callId: d.call.id, until: Date.now() + 45000 };
        setPhase("dialing");
        pollLiveCall();
        return d.call;
      });
  }
  function answer() {
    stopRingtone();
    try { if (S.sdkCall) S.sdkCall.answer(); } catch (e) {}
  }
  function decline() {
    stopRingtone();
    var c = S.call;
    if (c && c.id) send("/phone/calls/" + c.id, { action: "decline" }).catch(function () {});
    try { if (S.sdkCall) S.sdkCall.hangup(); } catch (e) {}
    onSdkEnded();
  }
  function hangup() {
    var c = S.call;
    try { if (S.sdkCall) S.sdkCall.hangup(); } catch (e) {}
    if (c && c.id && (!S.sdkCall)) send("/phone/calls/" + c.id, { action: "hangup" }).catch(function () {});
  }
  function toggleMute() {
    if (!S.sdkCall) return;
    try {
      if (S.muted) { S.sdkCall.unmuteAudio(); S.muted = false; }
      else { S.sdkCall.muteAudio(); S.muted = true; }
    } catch (e) {}
    emit();
  }
  function toggleHold() {
    if (!S.sdkCall) return;
    var next = !S.held;
    var p = next ? S.sdkCall.hold() : S.sdkCall.unhold();
    Promise.resolve(p).then(function () {
      S.held = next;
      setPhase(next ? "held" : "active");
      if (S.call && S.call.id) send("/phone/calls/" + S.call.id, { action: "held", held: next }).catch(function () {});
    }).catch(function () {});
  }
  function sendDtmf(d) {
    try { if (S.sdkCall) S.sdkCall.dtmf(String(d)); } catch (e) {}
  }
  function setRecordingOn(on) {
    if (!S.call || !S.call.id) return Promise.resolve();
    return send("/phone/calls/" + S.call.id, { action: "record", on: !!on }).then(function (d) {
      S.call = d.call; emit();
    });
  }

  /* -- live notes: debounced autosave, never lost on navigation -- */
  var notesTimer = null;
  function setNotes(text) {
    S.notesDraft = text;
    if (notesTimer) clearTimeout(notesTimer);
    notesTimer = setTimeout(flushNotes, 800);
    emit();
  }
  function flushNotes() {
    if (notesTimer) { clearTimeout(notesTimer); notesTimer = null; }
    var c = S.call;
    if (!c || !c.id || S.notesDraft == null) return;
    var text = S.notesDraft;
    send("/phone/calls/" + c.id, { action: "notes", notes: text }).then(function (d) {
      if (S.call && S.call.id === c.id) { S.call.userNotes = d.call.userNotes; }
      if (S.notesDraft === text) S.notesDraft = null;
    }).catch(function () {});
  }

  function requestNotifications() {
    try {
      if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
      }
    } catch (e) {}
  }

  /* ---------------- guard full-page exits during a live call ---------------- */
  window.addEventListener("beforeunload", function (ev) {
    if (S.sdkCall && (S.phase === "active" || S.phase === "held" || S.phase === "dialing")) {
      ev.preventDefault();
      ev.returnValue = "";
      return "";
    }
  });

  /* ---------------- overlay UI ---------------- */
  var overlay = null;
  function h(tag, cls, html) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (html != null) el.innerHTML = html;
    return el;
  }
  var IC = {
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    end: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="22" y1="2" x2="2" y2="22"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>',
    micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" y1="19" x2="12" y2="22"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="1.4"/><circle cx="12" cy="5" r="1.4"/><circle cx="18" cy="5" r="1.4"/><circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/><circle cx="6" cy="19" r="1.4"/><circle cx="12" cy="19" r="1.4"/><circle cx="18" cy="19" r="1.4"/></svg>',
  };

  function mountOverlay() {
    if (overlay) return;
    overlay = h("div", "bdp-root");
    overlay.innerHTML =
      '<audio id="bdpRemote" autoplay></audio>' +
      '<div class="bdp-incoming" id="bdpIncoming" hidden>' +
        '<div class="bdp-inc-label">Incoming call</div>' +
        '<div class="bdp-inc-who"><div class="bdp-inc-name" id="bdpIncName"></div>' +
        '<div class="bdp-inc-meta" id="bdpIncMeta"></div></div>' +
        '<div class="bdp-inc-actions">' +
          '<button class="btn bdp-answer" id="bdpAnswer">' + IC.phone + ' Answer</button>' +
          '<button class="btn bdp-decline" id="bdpDecline">' + IC.end + ' Decline</button>' +
        '</div>' +
      '</div>' +
      '<div class="bdp-bar" id="bdpBar" hidden>' +
        '<span class="bdp-dot" id="bdpDot"></span>' +
        '<div class="bdp-bar-info"><div class="bdp-bar-name" id="bdpBarName"></div>' +
        '<div class="bdp-bar-sub" id="bdpBarSub"></div></div>' +
        '<span class="bdp-rec" id="bdpRec" hidden title="Recording">REC</span>' +
        '<div class="bdp-bar-btns">' +
          '<button class="bdp-ctl" id="bdpMute" title="Mute">' + IC.mic + '</button>' +
          '<button class="bdp-ctl" id="bdpHold" title="Hold">' + IC.pause + '</button>' +
          '<button class="bdp-ctl" id="bdpKeypadBtn" title="Keypad">' + IC.grid + '</button>' +
          '<button class="bdp-ctl" id="bdpNotesBtn" title="Live notes">' + IC.note + '</button>' +
          '<button class="bdp-ctl bdp-end" id="bdpEnd" title="End call">' + IC.end + '</button>' +
        '</div>' +
        '<a class="bdp-bar-link" id="bdpEndedLink" hidden>View call record</a>' +
      '</div>' +
      '<div class="bdp-pop" id="bdpNotesPop" hidden>' +
        '<div class="bdp-pop-title">Live notes<span class="bdp-pop-hint" id="bdpNotesSaved"></span></div>' +
        '<textarea id="bdpNotesArea" placeholder="Type notes while you talk. They save automatically and feed the AI summary."></textarea>' +
      '</div>' +
      '<div class="bdp-pop bdp-keypad" id="bdpKeypadPop" hidden></div>';
    document.body.appendChild(overlay);

    var pad = overlay.querySelector("#bdpKeypadPop");
    "1 2 3 4 5 6 7 8 9 * 0 #".split(" ").forEach(function (d) {
      var b = h("button", "bdp-key", d);
      b.addEventListener("click", function () { sendDtmf(d); });
      pad.appendChild(b);
    });

    overlay.querySelector("#bdpAnswer").addEventListener("click", answer);
    overlay.querySelector("#bdpDecline").addEventListener("click", decline);
    overlay.querySelector("#bdpEnd").addEventListener("click", hangup);
    overlay.querySelector("#bdpMute").addEventListener("click", toggleMute);
    overlay.querySelector("#bdpHold").addEventListener("click", toggleHold);
    overlay.querySelector("#bdpKeypadBtn").addEventListener("click", function () {
      togglePop("bdpKeypadPop");
    });
    overlay.querySelector("#bdpNotesBtn").addEventListener("click", function () {
      togglePop("bdpNotesPop");
      var area = overlay.querySelector("#bdpNotesArea");
      if (!area._wired) {
        area._wired = true;
        area.addEventListener("input", function () {
          setNotes(area.value);
          overlay.querySelector("#bdpNotesSaved").textContent = "saving";
          setTimeout(function () { overlay.querySelector("#bdpNotesSaved").textContent = "saved"; }, 1200);
        });
      }
      if (area.value === "" && S.call && S.call.userNotes) area.value = S.call.userNotes;
      area.focus();
    });
    overlay.querySelector("#bdpEndedLink").addEventListener("click", function () {
      if (!S.endedInfo) return;
      // Outside the portal SPA (the popup dialer page) the hash has no router;
      // open the record in the full portal instead.
      if (document.getElementById("view")) location.hash = "#bdphone/" + S.endedInfo.callId;
      else window.open("/recruiter#bdphone/" + S.endedInfo.callId, "_blank");
    });
  }
  function togglePop(id) {
    ["bdpNotesPop", "bdpKeypadPop"].forEach(function (p) {
      var el = overlay.querySelector("#" + p);
      if (p === id) el.hidden = !el.hidden; else el.hidden = true;
    });
  }

  function fmtDur(s) {
    var m = Math.floor(s / 60), sec = s % 60;
    var hh = Math.floor(m / 60);
    m = m % 60;
    return (hh ? hh + ":" + String(m).padStart(2, "0") : m) + ":" + String(sec).padStart(2, "0");
  }

  var onPhoneRoute = false;
  function renderOverlay() {
    if (!overlay) mountOverlay();
    onPhoneRoute = (location.hash || "").indexOf("bdphone") >= 0;

    var inc = overlay.querySelector("#bdpIncoming");
    var bar = overlay.querySelector("#bdpBar");
    var showInc = S.phase === "incoming";
    inc.hidden = !showInc;
    if (showInc && S.call) {
      overlay.querySelector("#bdpIncName").textContent = S.call.contactName || "Unknown contact";
      var meta = [S.call.externalNumber, S.call.contactTitle, S.call.companyName].filter(Boolean).join(" · ");
      var line = S.call.lineNumber ? "to " + S.call.lineNumber : "";
      overlay.querySelector("#bdpIncMeta").textContent = meta + (line ? (meta ? " · " : "") + line : "");
    }

    var live = S.phase === "dialing" || S.phase === "active" || S.phase === "held" || S.phase === "ended";
    // The BD Phone tab has its own full-size call panel; the floating bar
    // covers everywhere else so navigation never loses the call.
    bar.hidden = !(live && (!onPhoneRoute || S.phase === "ended"));
    if (!bar.hidden) {
      var name = (S.call && (S.call.contactName || S.call.externalNumber)) || "Call";
      overlay.querySelector("#bdpBarName").textContent = name;
      var sub = "";
      var dot = overlay.querySelector("#bdpDot");
      dot.className = "bdp-dot";
      if (S.phase === "dialing") { sub = "Calling"; dot.classList.add("amber"); }
      else if (S.phase === "held") { sub = "On hold · " + fmtDur(S.elapsed); dot.classList.add("amber"); }
      else if (S.phase === "active") { sub = fmtDur(S.elapsed); dot.classList.add("green"); }
      else if (S.phase === "ended") {
        sub = (S.call && S.call.status === "completed") ? "Call ended" : "Ended";
        dot.classList.add("gray");
      }
      overlay.querySelector("#bdpBarSub").textContent = sub;
      overlay.querySelector("#bdpRec").hidden = !(S.call && S.call.recording && S.call.recording.enabled && (S.phase === "active" || S.phase === "held"));
      overlay.querySelector("#bdpMute").innerHTML = S.muted ? IC.micOff : IC.mic;
      overlay.querySelector("#bdpMute").classList.toggle("on", S.muted);
      overlay.querySelector("#bdpHold").innerHTML = S.held ? IC.play : IC.pause;
      overlay.querySelector("#bdpHold").classList.toggle("on", S.held);
      var endedLink = overlay.querySelector("#bdpEndedLink");
      endedLink.hidden = S.phase !== "ended" || !S.endedInfo;
      var btns = overlay.querySelector(".bdp-bar-btns");
      btns.style.display = S.phase === "ended" ? "none" : "";
    } else {
      overlay.querySelector("#bdpNotesPop").hidden = true;
      overlay.querySelector("#bdpKeypadPop").hidden = true;
    }
  }
  window.addEventListener("hashchange", renderOverlay);

  /* ---------------- expose ---------------- */
  window.__bdPhone = {
    getState: function () { return S; },
    subscribe: function (fn) {
      subs.push(fn);
      return function () { var i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); };
    },
    dial: dial,
    answer: answer,
    decline: decline,
    hangup: hangup,
    toggleMute: toggleMute,
    toggleHold: toggleHold,
    sendDtmf: sendDtmf,
    setNotes: setNotes,
    flushNotes: flushNotes,
    setRecordingOn: setRecordingOn,
    setMic: setMic,
    setSpeaker: setSpeaker,
    refreshDevices: refreshDevices,
    refreshSummary: refreshSummary,
    takeLeader: takeLeader,
    requestNotifications: requestNotifications,
    reconnect: function () { reconnectDelay = 2000; connect(); },
    fmtDur: fmtDur,
  };

  /* ---------------- go ---------------- */
  mountOverlay();
  promote();
})();
