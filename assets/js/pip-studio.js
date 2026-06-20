/* RecruitersOS · PiP Studio
 *
 * Killer-simple workflow: (1) record your clip once, (2) set your PiP style once,
 * (3) click any hiring-signal role to mint a personalized GIF + MP4 + watch link —
 * or "Generate all" to batch every captured role. Fuses the page-scroll capture
 * pipeline with webcam picture-in-picture. Same-origin cookie session. No demo mode.
 */
(function () {
  "use strict";

  var API = (window.RECRUITEROS_API_BASE || "").replace(/\/$/, "");
  var $ = function (id) { return document.getElementById(id); };
  function origin() { return API || (location.protocol + "//" + location.host); }

  function api(path, opts) {
    opts = opts || {};
    opts.credentials = "include";
    opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    return fetch(API + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) { location.href = "/login?next=/pip-studio"; throw new Error("unauthorized"); }
        if (!r.ok) throw new Error((j && (j.error || j.reason)) || ("HTTP " + r.status));
        return j;
      });
    });
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]; }); }

  var state = {
    pip: { corner: "br", shape: "circle", sizePct: 26, marginPct: 3, borderPx: 4, borderColor: "#19c37d", radiusPct: 18 },
    clipId: null,
    shots: [],
    stream: null, recorder: null, chunks: [], recordedBlob: null,
  };
  function shotGif(key) { return API + "/api/in-market/shot?key=" + encodeURIComponent(key) + "&fmt=gif"; }

  /* Gate: you need a clip before generating. Show a friendly banner instead of silent fails. */
  function ready() { return !!state.clipId; }
  function refreshBanner() {
    var b = $("banner");
    if (!ready()) { b.style.display = ""; b.textContent = "Record or pick a clip on the left, then click a role to personalize it."; }
    else { b.style.display = "none"; }
  }

  /* ================= 1 · clip (record once, reuse) ================= */
  var preview = $("preview");
  $("btnCam").onclick = function () {
    navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true })
      .then(function (s) {
        state.stream = s; preview.srcObject = s; preview.play();
        $("btnRec").disabled = false; $("btnCam").textContent = "Camera on"; $("btnCam").disabled = true;
        renderPip();
      })
      .catch(function (e) { $("recHint").textContent = "Camera blocked: " + e.message; });
  };
  function pickMime() {
    var prefs = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
    for (var i = 0; i < prefs.length; i++) if (window.MediaRecorder && MediaRecorder.isTypeSupported(prefs[i])) return prefs[i];
    return "";
  }
  $("btnRec").onclick = function () {
    if (state.recorder && state.recorder.state === "recording") { state.recorder.stop(); return; }
    state.chunks = [];
    var mime = pickMime();
    try { state.recorder = new MediaRecorder(state.stream, mime ? { mimeType: mime } : undefined); }
    catch (e) { $("recHint").textContent = "Recorder error: " + e.message; return; }
    state.recorder.ondataavailable = function (ev) { if (ev.data && ev.data.size) state.chunks.push(ev.data); };
    state.recorder.onstop = function () {
      state.recordedBlob = new Blob(state.chunks, { type: (state.recorder.mimeType || mime || "video/webm").split(";")[0] });
      preview.srcObject = null; preview.src = URL.createObjectURL(state.recordedBlob); preview.muted = false; preview.controls = true;
      $("btnSave").disabled = false; $("btnDiscard").disabled = false; $("btnRec").textContent = "● Record";
      $("recHint").textContent = "Preview it, then Save (or Discard and re-record).";
    };
    state.recorder.start();
    $("btnRec").textContent = "■ Stop"; $("btnSave").disabled = true; $("btnDiscard").disabled = true;
  };
  $("btnDiscard").onclick = function () {
    state.recordedBlob = null; preview.src = ""; preview.controls = false; preview.muted = true;
    if (state.stream) { preview.srcObject = state.stream; preview.play(); }
    $("btnSave").disabled = true; $("btnDiscard").disabled = true;
    $("recHint").textContent = "Talk for ~10–20s. The page scroll loops behind you.";
  };
  $("btnSave").onclick = function () {
    if (!state.recordedBlob) return;
    $("btnSave").disabled = true; $("recHint").textContent = "Saving…";
    var reader = new FileReader();
    reader.onload = function () {
      api("/api/in-market/clip", { method: "POST", body: JSON.stringify({ dataUrl: reader.result }) })
        .then(function (j) { state.clipId = j.clip.id; $("recHint").textContent = "Saved ✓ — now click a role."; loadClips(); refreshBanner(); })
        .catch(function (e) { $("recHint").textContent = "Save failed: " + e.message; $("btnSave").disabled = false; });
    };
    reader.readAsDataURL(state.recordedBlob);
  };
  function loadClips() {
    api("/api/in-market/clip").then(function (j) {
      var clips = (j && j.clips) || [], box = $("clips");
      if (!clips.length) { box.innerHTML = ""; return; }
      if (!state.clipId) state.clipId = clips[0].id; // default to most recent
      box.innerHTML = "";
      clips.forEach(function (c) {
        var el = document.createElement("div");
        el.className = "clip" + (c.id === state.clipId ? " on" : "");
        var kb = Math.round(c.bytes / 1024);
        el.innerHTML = '<span class="d"></span><span class="meta">' + esc(c.label || ("Clip " + new Date(c.at).toLocaleDateString())) + ' · ' + kb + ' KB</span><button class="danger small" data-del="' + c.id + '">✕</button>';
        el.onclick = function (ev) { if (ev.target.getAttribute("data-del")) return; state.clipId = c.id; loadClips(); refreshBanner(); };
        box.appendChild(el);
      });
      box.querySelectorAll("[data-del]").forEach(function (b) {
        b.onclick = function (ev) {
          ev.stopPropagation();
          var id = b.getAttribute("data-del");
          api("/api/in-market/clip?id=" + encodeURIComponent(id), { method: "DELETE" })
            .then(function () { if (state.clipId === id) state.clipId = null; loadClips(); refreshBanner(); });
        };
      });
      refreshBanner();
    }).catch(function () {});
  }

  /* ================= 2 · style (set once, applied to all) ================= */
  function bindPills(containerId, attr, key, after) {
    var c = $(containerId);
    c.querySelectorAll(".pill").forEach(function (p) {
      p.onclick = function () {
        c.querySelectorAll(".pill").forEach(function (x) { x.classList.remove("on"); });
        p.classList.add("on"); state.pip[key] = p.getAttribute(attr); if (after) after(); renderPip();
      };
    });
  }
  bindPills("corners", "data-c", "corner");
  bindPills("shapes", "data-s", "shape", function () { $("radiusWrap").style.display = state.pip.shape === "rounded" ? "" : "none"; });
  function bindRange(id, key, label) {
    var el = $(id);
    el.oninput = function () { state.pip[key] = Number(el.value); if (label) $(label).textContent = el.value; renderPip(); };
  }
  bindRange("size", "sizePct", "sizeV");
  bindRange("margin", "marginPct", "marginV");
  bindRange("border", "borderPx", "borderV");
  bindRange("radius", "radiusPct");
  $("borderColor").oninput = function () { state.pip.borderColor = $("borderColor").value; renderPip(); };

  function setStageBg(url) {
    var stage = $("stage"), bg = stage.querySelector("img.bg");
    if (!bg) { bg = document.createElement("img"); bg.className = "bg"; stage.insertBefore(bg, $("pipBox")); }
    bg.src = url; $("stagePh").style.display = "none";
  }
  function renderPip() {
    var stage = $("stage"), box = $("pipBox");
    var W = stage.clientWidth, H = stage.clientHeight, p = state.pip;
    var pw = (p.sizePct / 100) * W, ph = p.shape === "circle" ? pw : pw * 0.62, m = (p.marginPct / 100) * W;
    box.style.width = pw + "px"; box.style.height = ph + "px";
    box.style.top = box.style.bottom = box.style.left = box.style.right = "auto";
    if (p.corner === "tl" || p.corner === "tr") box.style.top = m + "px"; else box.style.bottom = m + "px";
    if (p.corner === "tl" || p.corner === "bl") box.style.left = m + "px"; else box.style.right = m + "px";
    box.style.borderRadius = p.shape === "circle" ? "50%" : (p.shape === "rounded" ? (p.radiusPct / 100) * pw + "px" : "0");
    box.style.border = p.borderPx ? (p.borderPx + "px solid " + p.borderColor) : "none";
    var v = box.querySelector("video");
    if (!v) { v = document.createElement("video"); v.muted = true; v.playsInline = true; v.autoplay = true; box.appendChild(v); }
    if (state.stream && !state.recordedBlob) { if (v.srcObject !== state.stream) { v.srcObject = state.stream; v.play(); } var nc = box.querySelector(".nocam"); if (nc) nc.remove(); }
    else if (!state.stream && !box.querySelector(".nocam")) { var n = document.createElement("div"); n.className = "nocam"; n.textContent = "you"; box.appendChild(n); }
  }
  window.addEventListener("resize", renderPip);

  /* ================= 3 · roles (the workflow) ================= */
  function loadGallery(cb) {
    api("/api/in-market/shot?list=1").then(function (j) { state.shots = (j && j.shots) || []; renderGallery(); cb && cb(); })
      .catch(function (e) { $("gallery").innerHTML = '<div class="empty">Could not load roles: ' + e.message + '</div>'; });
  }
  $("btnRefresh").onclick = function () { loadGallery(); };
  $("gsearch").oninput = renderGallery;

  function renderGallery() {
    var q = ($("gsearch").value || "").toLowerCase();
    var list = state.shots.filter(function (s) { return !q || (s.company + " " + s.roleTitle).toLowerCase().indexOf(q) >= 0; });
    var box = $("gallery");
    if (state.shots.length && !$("stage").querySelector("img.bg")) setStageBg(shotGif(state.shots[0].key)); // seed the style preview
    if (!list.length) { box.innerHTML = '<div class="empty">' + (state.shots.length ? "No matches." : "No captured roles yet — capture one below.") + "</div>"; return; }
    box.innerHTML = "";
    list.forEach(function (s) {
      var t = document.createElement("div");
      t.className = "tile"; t.setAttribute("data-key", s.key);
      t.innerHTML =
        '<div class="thumb"><img loading="lazy" src="' + shotGif(s.key) + '" alt="" /><div class="go">⚡ Personalize</div></div>' +
        '<div class="lbl"><div class="co">' + esc(s.company || "—") + '</div><div class="ro">' + esc(s.roleTitle || "") + '</div></div>' +
        '<div class="act" data-act></div>';
      t.querySelector(".thumb").onclick = function () { setStageBg(shotGif(s.key)); generate(s); };
      box.appendChild(t);
    });
  }

  function tileActions(key) {
    var t = $("gallery").querySelector('.tile[data-key="' + cssEsc(key) + '"]');
    return t ? t.querySelector("[data-act]") : null;
  }
  function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }

  /* Compose one role using the active clip + current style; render result on its tile. */
  function generate(s, opts) {
    opts = opts || {};
    if (!ready()) { refreshBanner(); return Promise.resolve(false); }
    var act = tileActions(s.key);
    if (act) act.innerHTML = '<span class="muted"><span class="spin"></span>Rendering…</span>';
    var payload = { company: s.company, roleTitle: s.roleTitle, roleUrl: s.pageUrl, clipId: state.clipId, pip: state.pip, force: !!opts.force };
    return new Promise(function (resolve) {
      var tries = 0;
      (function tick() {
        api("/api/in-market/video", { method: "POST", body: JSON.stringify(payload) }).then(function (res) {
          payload.force = false;
          if (res.status === "composing") { if (tries++ > 40) { setTile(s, null, "timed out"); return resolve(false); } setTimeout(tick, 2500); return; }
          if (res.status === "ready") { setTile(s, res); resolve(true); }
          else { setTile(s, null, genReason(res)); resolve(false); }
        }).catch(function (e) { setTile(s, null, e.message); resolve(false); });
      })();
    });
  }
  function setTile(s, res, err) {
    var act = tileActions(s.key); if (!act) return;
    if (err) { act.innerHTML = '<span class="muted" style="color:#ffb4ba">' + esc(err) + '</span>'; return; }
    var watch = origin() + "/watch?k=" + encodeURIComponent(res.key) + "&c=" + encodeURIComponent(s.company) + "&r=" + encodeURIComponent(s.roleTitle);
    var bId = "cp" + Math.random().toString(36).slice(2);
    act.innerHTML = '<a class="lk" href="' + esc(watch) + '" target="_blank">▶ Watch</a><button id="' + bId + '" class="small ghost">Copy link</button>';
    var b = $(bId);
    b.onclick = function () { navigator.clipboard.writeText(watch).then(function () { b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy link"; }, 1200); }); };
  }
  function genReason(res) {
    var m = { no_shot: "page not verified", no_clip: "clip missing", no_ffmpeg: "ffmpeg not installed", error: "render failed" };
    return (m[res.status] || res.status) + (res.reason ? " — " + res.reason : "");
  }

  /* Batch: personalize every visible role, one at a time (steady on CPU; live progress). */
  $("btnGenAll").onclick = function () {
    if (!ready()) { refreshBanner(); return; }
    var q = ($("gsearch").value || "").toLowerCase();
    var list = state.shots.filter(function (s) { return !q || (s.company + " " + s.roleTitle).toLowerCase().indexOf(q) >= 0; });
    if (!list.length) return;
    var btn = $("btnGenAll"); btn.disabled = true;
    var i = 0;
    (function next() {
      if (i >= list.length) { btn.disabled = false; btn.textContent = "⚡ Generate all"; return; }
      btn.textContent = "Generating " + (i + 1) + "/" + list.length + "…";
      generate(list[i++]).then(next);
    })();
  };

  /* ---- capture a new role (kick the shot pipeline) ---- */
  $("btnCapture").onclick = function () {
    var company = $("capCompany").value.trim(), roleTitle = $("capRole").value.trim(), roleUrl = $("capUrl").value.trim();
    if (!company || !roleTitle) { capStatus("Enter company + role.", true); return; }
    captureRole(company, roleTitle, roleUrl || undefined);
  };
  function captureRole(company, roleTitle, roleUrl) {
    capStatus('<span class="spin"></span>Capturing…'); $("btnCapture").disabled = true;
    var payload = { company: company, roleTitle: roleTitle, roleUrl: roleUrl }, tries = 0;
    (function tick() {
      api("/api/in-market/shot", { method: "POST", body: JSON.stringify(payload) }).then(function (res) {
        if (res.status === "capturing") { if (tries++ > 40) { capStatus("Still working — hit ↻ shortly.", true); $("btnCapture").disabled = false; return; } setTimeout(tick, 2500); return; }
        $("btnCapture").disabled = false;
        if (res.status === "company_site") { capStatus("Captured ✓"); loadGallery(); }
        else { capStatus(shotReason(res), true); }
      }).catch(function (e) { $("btnCapture").disabled = false; capStatus(e.message, true); });
    })();
  }
  function shotReason(res) {
    var m = { no_company_page: "couldn't verify on the company's own site", staffing_blocked: "staffing/recruiting firm — skipped", error: "capture failed" };
    return (m[res.status] || res.status) + (res.reason ? " — " + res.reason : "");
  }
  $("btnFindRoles").onclick = function () {
    var company = $("capCompany").value.trim();
    if (!company) { capStatus("Enter a company first.", true); return; }
    capStatus('<span class="spin"></span>Finding roles…');
    api("/api/in-market", { method: "POST", body: JSON.stringify({ action: "company_roles", company: company }) })
      .then(function (j) {
        var detail = (j && j.detail) || [], chips = $("roleChips"); chips.innerHTML = "";
        if (!detail.length) { capStatus("No public roles found.", true); return; }
        capStatus(detail.length + " roles — click to capture.");
        detail.slice(0, 24).forEach(function (r) {
          var c = document.createElement("span"); c.className = "pill"; c.textContent = r.title; c.style.cursor = "pointer";
          c.onclick = function () { $("capRole").value = r.title; $("capUrl").value = r.url || ""; captureRole(company, r.title, r.url || undefined); };
          chips.appendChild(c);
        });
      })
      .catch(function (e) { capStatus(e.message, true); });
  };
  function capStatus(html, err) { var el = $("capStatus"); el.innerHTML = html; el.style.color = err ? "#ffb4ba" : ""; }

  /* ---------------- init ---------------- */
  loadGallery();
  loadClips();
  renderPip();
  refreshBanner();
})();
