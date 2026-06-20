/* RecruitersOS · PiP Studio
 *
 * Record a webcam clip (MediaRecorder), pick a hiring-signal role, lay out the
 * picture-in-picture, and composite server-side (POST /api/in-market/video).
 * Same-origin, cookie session — every call sends credentials. No demo mode.
 */
(function () {
  "use strict";

  var API = (window.RECRUITEROS_API_BASE || "").replace(/\/$/, "");
  var $ = function (id) { return document.getElementById(id); };

  function api(path, opts) {
    opts = opts || {};
    opts.credentials = "include";
    opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    return fetch(API + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) { location.href = "/login?next=/pip-studio.html"; throw new Error("unauthorized"); }
        if (!r.ok) throw new Error((j && (j.error || j.reason)) || ("HTTP " + r.status));
        return j;
      });
    });
  }

  /* ---------------- state ---------------- */
  var state = {
    pip: { corner: "br", shape: "circle", sizePct: 26, marginPct: 3, borderPx: 4, borderColor: "#19c37d", radiusPct: 18 },
    clipId: null,
    bgUrl: null,        // last generated composite gif (also reused as live-preview background)
    stream: null,
    recorder: null,
    chunks: [],
    recordedBlob: null,
  };

  /* ---------------- recording ---------------- */
  var preview = $("preview");

  $("btnCam").onclick = function () {
    navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true })
      .then(function (s) {
        state.stream = s;
        preview.srcObject = s;
        preview.play();
        $("btnRec").disabled = false;
        $("btnCam").textContent = "Camera on";
        $("btnCam").disabled = true;
        livePreview();
      })
      .catch(function (e) { setStatus("Camera blocked: " + e.message, "err"); });
  };

  function pickMime() {
    var prefs = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
    for (var i = 0; i < prefs.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(prefs[i])) return prefs[i];
    }
    return "";
  }

  $("btnRec").onclick = function () {
    if (state.recorder && state.recorder.state === "recording") {
      state.recorder.stop();
      return;
    }
    state.chunks = [];
    var mime = pickMime();
    try {
      state.recorder = new MediaRecorder(state.stream, mime ? { mimeType: mime } : undefined);
    } catch (e) { setStatus("Recorder error: " + e.message, "err"); return; }
    state.recorder.ondataavailable = function (ev) { if (ev.data && ev.data.size) state.chunks.push(ev.data); };
    state.recorder.onstop = function () {
      state.recordedBlob = new Blob(state.chunks, { type: (state.recorder.mimeType || mime || "video/webm").split(";")[0] });
      preview.srcObject = null;
      preview.src = URL.createObjectURL(state.recordedBlob);
      preview.muted = false;
      preview.controls = true;
      $("btnSave").disabled = false;
      $("btnDiscard").disabled = false;
      $("btnRec").textContent = "● Record";
      $("btnRec").classList.add("primary");
      $("recHint").textContent = "Preview your take. Save it, or discard and re-record.";
    };
    state.recorder.start();
    $("btnRec").textContent = "■ Stop";
    $("btnRec").classList.remove("primary");
    $("btnSave").disabled = true;
    $("btnDiscard").disabled = true;
  };

  $("btnDiscard").onclick = function () {
    state.recordedBlob = null;
    preview.src = "";
    preview.controls = false;
    preview.muted = true;
    if (state.stream) { preview.srcObject = state.stream; preview.play(); }
    $("btnSave").disabled = true;
    $("btnDiscard").disabled = true;
    $("recHint").textContent = "Talk to the camera for ~10–20s. The page scroll loops behind you.";
  };

  $("btnSave").onclick = function () {
    if (!state.recordedBlob) return;
    $("btnSave").disabled = true;
    setStatus("Uploading clip…");
    var reader = new FileReader();
    reader.onload = function () {
      api("/api/in-market/clip", { method: "POST", body: JSON.stringify({ dataUrl: reader.result }) })
        .then(function (j) {
          setStatus("Clip saved.", "ok");
          state.clipId = j.clip.id;
          loadClips();
          syncGenEnabled();
        })
        .catch(function (e) { setStatus("Save failed: " + e.message, "err"); $("btnSave").disabled = false; });
    };
    reader.readAsDataURL(state.recordedBlob);
  };

  /* ---------------- clip library ---------------- */
  function loadClips() {
    api("/api/in-market/clip").then(function (j) {
      var box = $("clips");
      var clips = (j && j.clips) || [];
      if (!clips.length) { box.innerHTML = '<p class="muted">No clips yet.</p>'; return; }
      box.innerHTML = "";
      clips.forEach(function (c) {
        var el = document.createElement("div");
        el.className = "clip" + (c.id === state.clipId ? " on" : "");
        var when = new Date(c.at).toLocaleString();
        var kb = Math.round(c.bytes / 1024);
        el.innerHTML =
          '<span class="dot"></span>' +
          '<span class="meta">' + (c.label || when) + ' · ' + kb + ' KB</span>' +
          '<button class="ghost small" data-use="' + c.id + '">Use</button>' +
          '<button class="danger small" data-del="' + c.id + '">✕</button>';
        box.appendChild(el);
      });
      box.querySelectorAll("[data-use]").forEach(function (b) {
        b.onclick = function () { state.clipId = b.getAttribute("data-use"); loadClips(); syncGenEnabled(); };
      });
      box.querySelectorAll("[data-del]").forEach(function (b) {
        b.onclick = function () {
          api("/api/in-market/clip?id=" + encodeURIComponent(b.getAttribute("data-del")), { method: "DELETE" })
            .then(function () { if (state.clipId === b.getAttribute("data-del")) state.clipId = null; loadClips(); syncGenEnabled(); });
        };
      });
    }).catch(function () {});
  }

  /* ---------------- layout controls ---------------- */
  function bindPills(containerId, attr, key, after) {
    var c = $(containerId);
    c.querySelectorAll(".pill").forEach(function (p) {
      p.onclick = function () {
        c.querySelectorAll(".pill").forEach(function (x) { x.classList.remove("on"); });
        p.classList.add("on");
        state.pip[key] = p.getAttribute(attr);
        if (after) after();
        livePreview();
      };
    });
  }
  bindPills("corners", "data-c", "corner");
  bindPills("shapes", "data-s", "shape", function () {
    $("radiusWrap").style.display = state.pip.shape === "rounded" ? "" : "none";
  });

  function bindRange(id, key, label, pct) {
    var el = $(id);
    el.oninput = function () {
      state.pip[key] = Number(el.value);
      if (label) $(label).textContent = el.value;
      livePreview();
    };
  }
  bindRange("size", "sizePct", "sizeV");
  bindRange("margin", "marginPct", "marginV");
  bindRange("border", "borderPx", "borderV");
  bindRange("radius", "radiusPct");
  $("borderColor").oninput = function () { state.pip.borderColor = $("borderColor").value; livePreview(); };

  /* ---------------- live preview (CSS approximation of the composite) ---------------- */
  function livePreview() {
    var stage = $("stage");
    var box = $("pipBox");
    var W = stage.clientWidth, H = stage.clientHeight;
    var p = state.pip;
    var pw = (p.sizePct / 100) * W;
    var ph = p.shape === "circle" ? pw : pw * 0.62;
    var m = (p.marginPct / 100) * W;

    box.style.width = pw + "px";
    box.style.height = ph + "px";
    box.style.top = box.style.bottom = box.style.left = box.style.right = "auto";
    if (p.corner === "tl" || p.corner === "tr") box.style.top = m + "px"; else box.style.bottom = m + "px";
    if (p.corner === "tl" || p.corner === "bl") box.style.left = m + "px"; else box.style.right = m + "px";
    box.style.borderRadius = p.shape === "circle" ? "50%" : (p.shape === "rounded" ? (p.radiusPct / 100) * pw + "px" : "0");
    box.style.border = p.borderPx ? (p.borderPx + "px solid " + p.borderColor) : "none";

    // Show the live camera (or recorded take) inside the PiP box.
    var v = box.querySelector("video");
    if (!v) { v = document.createElement("video"); v.muted = true; v.playsInline = true; v.autoplay = true; box.appendChild(v); }
    if (state.stream && !state.recordedBlob) { if (v.srcObject !== state.stream) { v.srcObject = state.stream; v.play(); } }

    // Background = last generated composite (if any).
    var empty = $("stageEmpty");
    if (state.bgUrl) {
      var bg = stage.querySelector("img.bg");
      if (!bg) { bg = document.createElement("img"); bg.className = "bg"; stage.insertBefore(bg, box); }
      bg.src = state.bgUrl;
      empty.style.display = "none";
    } else {
      empty.style.display = "";
    }
  }
  window.addEventListener("resize", livePreview);

  /* ---------------- generate ---------------- */
  function role() {
    return {
      company: $("company").value.trim(),
      roleTitle: $("roleTitle").value.trim(),
      roleUrl: $("roleUrl").value.trim() || undefined,
    };
  }
  function syncGenEnabled() {
    var r = role();
    $("btnGen").disabled = !(state.clipId && r.company && r.roleTitle);
  }
  ["company", "roleTitle"].forEach(function (id) { $(id).oninput = syncGenEnabled; });

  var polling = false;
  function generate(force) {
    var r = role();
    if (!state.clipId || !r.company || !r.roleTitle) return;
    $("btnGen").disabled = true;
    setStatus("Compositing — capturing the page scroll (first time ~20s) then overlaying you…");
    $("out").innerHTML = "";

    var payload = Object.assign({}, r, { clipId: state.clipId, pip: state.pip, force: !!force });

    function tick() {
      api("/api/in-market/video", { method: "POST", body: JSON.stringify(payload) })
        .then(function (res) {
          payload.force = false; // only force the first call
          if (res.status === "composing") {
            if (!polling) return;
            setStatus("Working… (this can take ~10–30s)");
            setTimeout(tick, 2500);
            return;
          }
          polling = false;
          $("btnGen").disabled = false;
          if (res.status === "ready") return showResult(res);
          setStatus(label(res.status) + (res.reason ? " — " + res.reason : ""), "err");
        })
        .catch(function (e) { polling = false; $("btnGen").disabled = false; setStatus(e.message, "err"); });
    }
    polling = true;
    tick();
  }
  function label(s) {
    return ({
      no_shot: "Couldn't verify this role's page on the company's own site",
      no_clip: "Clip not found",
      no_ffmpeg: "ffmpeg isn't installed on the server",
      error: "Render failed",
    })[s] || s;
  }

  function showResult(res) {
    var r = role();
    var gif = API + "/api/in-market/video?key=" + encodeURIComponent(res.key) + "&fmt=gif";
    var mp4 = API + "/api/in-market/video?key=" + encodeURIComponent(res.key) + "&fmt=mp4";
    // The shareable, login-free landing page for the prospect (Loom/BombBomb style).
    var watch = origin() + "/watch?k=" + encodeURIComponent(res.key) +
      "&c=" + encodeURIComponent(r.company) + "&r=" + encodeURIComponent(r.roleTitle);
    state.bgUrl = gif + "&t=" + Date.now();
    setStatus("Done. " + (res.pageUrl ? "Background: " + res.pageUrl : ""), "ok");
    var out = $("out");
    out.innerHTML =
      '<img src="' + state.bgUrl + '" alt="composite gif" />' +
      '<video src="' + mp4 + '" controls style="width:100%;border-radius:10px"></video>' +
      linkRow("Watch link (send this)", watch) +
      linkRow("GIF (embed in email)", gif) +
      (res.files && res.files.mp4 ? linkRow("MP4 (direct, with audio)", mp4) : "");
    livePreview();
  }
  function origin() {
    // Prefer the configured API base (when the static site points at a separate app origin),
    // otherwise the page's own origin.
    return API || (location.protocol + "//" + location.host);
  }
  function linkRow(name, url) {
    var id = "lnk" + Math.random().toString(36).slice(2);
    setTimeout(function () {
      var b = document.getElementById(id);
      if (b) b.onclick = function () { navigator.clipboard.writeText(url).then(function () { b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy"; }, 1200); }); };
    }, 0);
    return '<div class="linkrow"><span class="muted" style="flex:none;width:160px">' + name + '</span><code>' + url + '</code><button id="' + id + '" class="ghost small" style="flex:none">Copy</button></div>';
  }

  $("btnGen").onclick = function () { generate(false); };
  $("btnForce").onclick = function () { generate(true); };

  function setStatus(msg, kind) {
    var s = $("status");
    s.style.display = "";
    s.className = "status" + (kind ? " " + kind : "");
    s.textContent = msg;
  }

  /* ---------------- init ---------------- */
  loadClips();
  livePreview();
  syncGenEnabled();
})();
