/* RecruitersOS · PiP Studio
 *
 * Killer-simple, launch-ready workflow:
 *   1) record your clip once (persisted as your default),
 *   2) set your PiP style once (persisted),
 *   3) click any hiring-signal role -> personalized GIF + MP4 + a paste-ready email snippet
 *      (clickable animated GIF that opens the watch page) -> or "Generate all" to batch.
 * Generated assets persist across reloads so you always see what's ready to send.
 *
 * Email snippet uses the PUBLIC /watch endpoints so it renders in a recipient's inbox.
 * Same-origin cookie session for the operator surface. No demo mode.
 */
(function () {
  "use strict";

  var API = (window.RECRUITEROS_API_BASE || "").replace(/\/$/, "");
  var $ = function (id) { return document.getElementById(id); };
  function origin() { return API || (location.protocol + "//" + location.host); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]; }); }

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

  /* ---------------- persistence ---------------- */
  var LS = { style: "ros_pip_style", clip: "ros_pip_clip", results: "ros_pip_results" };
  function lsGet(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  var state = {
    pip: Object.assign({ corner: "br", shape: "circle", sizePct: 26, marginPct: 3, borderPx: 4, borderColor: "#19c37d", radiusPct: 18 }, lsGet(LS.style, {})),
    clipId: lsGet(LS.clip, null),
    shots: [],
    results: lsGet(LS.results, {}),   // { roleKey: { videoKey, company, roleTitle } }
    stream: null, recorder: null, chunks: [], recordedBlob: null,
  };
  function saveStyle() { lsSet(LS.style, state.pip); }
  function saveResults() { lsSet(LS.results, state.results); }

  /* ---------------- url helpers (public for email/share) ---------------- */
  function shotGif(key) { return API + "/api/in-market/shot?key=" + encodeURIComponent(key) + "&fmt=gif"; } // operator preview (auth)
  function watchPage(vk, co, ro) { return origin() + "/watch?k=" + encodeURIComponent(vk) + "&c=" + encodeURIComponent(co || "") + "&r=" + encodeURIComponent(ro || ""); }
  function publicGif(vk) { return origin() + "/api/in-market/watch?key=" + encodeURIComponent(vk) + "&fmt=gif"; }
  function emailSnippet(vk, co, ro) {
    var w = watchPage(vk, co, ro), g = publicGif(vk);
    var alt = "A quick note about " + (co || "your team") + (ro ? " — " + ro : "");
    return '<a href="' + w + '" target="_blank" rel="noopener">' +
      '<img src="' + g + '" alt="' + esc(alt) + '" width="600" ' +
      'style="max-width:100%;border-radius:10px;border:1px solid #e5e7eb;display:block" /></a>';
  }

  /* ---------------- clipboard (rich, so Gmail renders; plain for HTML editors) ---------------- */
  function copyRich(html) {
    try {
      if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        var item = new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([html], { type: "text/plain" }),
        });
        return navigator.clipboard.write([item]);
      }
    } catch (e) {}
    return navigator.clipboard.writeText(html);
  }
  function copyText(t) { return navigator.clipboard.writeText(t); }
  var toastT;
  function toast(msg) {
    var el = $("toast"); el.textContent = msg; el.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(function () { el.classList.remove("show"); }, 1400);
  }

  /* gate */
  function ready() { return !!state.clipId; }
  function refreshBanner() {
    var b = $("banner");
    if (!ready()) { b.style.display = ""; b.textContent = "Record or pick a clip on the left, then click a role to personalize it."; }
    else b.style.display = "none";
  }

  /* ================= 1 · clip ================= */
  var preview = $("preview");
  $("btnCam").onclick = function () {
    navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true })
      .then(function (s) {
        state.stream = s; preview.srcObject = s; preview.play();
        $("btnRec").disabled = false; $("btnCam").textContent = "Camera on"; $("btnCam").disabled = true; renderPip();
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
        .then(function (j) { state.clipId = j.clip.id; lsSet(LS.clip, state.clipId); $("recHint").textContent = "Saved ✓ — now click a role."; loadClips(); refreshBanner(); })
        .catch(function (e) { $("recHint").textContent = "Save failed: " + e.message; $("btnSave").disabled = false; });
    };
    reader.readAsDataURL(state.recordedBlob);
  };
  function loadClips() {
    api("/api/in-market/clip").then(function (j) {
      var clips = (j && j.clips) || [], box = $("clips");
      if (!clips.length) { box.innerHTML = ""; state.clipId = null; lsSet(LS.clip, null); refreshBanner(); return; }
      // Keep the persisted clip if it still exists; otherwise default to most recent.
      if (!state.clipId || !clips.some(function (c) { return c.id === state.clipId; })) state.clipId = clips[0].id;
      lsSet(LS.clip, state.clipId);
      box.innerHTML = "";
      clips.forEach(function (c) {
        var el = document.createElement("div");
        el.className = "clip" + (c.id === state.clipId ? " on" : "");
        var kb = Math.round(c.bytes / 1024);
        el.innerHTML = '<span class="d"></span><span class="meta">' + esc(c.label || ("Clip " + new Date(c.at).toLocaleDateString())) + ' · ' + kb + ' KB</span><button class="danger small" data-del="' + c.id + '">✕</button>';
        el.onclick = function (ev) { if (ev.target.getAttribute("data-del")) return; state.clipId = c.id; lsSet(LS.clip, c.id); loadClips(); refreshBanner(); };
        box.appendChild(el);
      });
      box.querySelectorAll("[data-del]").forEach(function (b) {
        b.onclick = function (ev) {
          ev.stopPropagation();
          var id = b.getAttribute("data-del");
          api("/api/in-market/clip?id=" + encodeURIComponent(id), { method: "DELETE" })
            .then(function () { if (state.clipId === id) { state.clipId = null; lsSet(LS.clip, null); } loadClips(); refreshBanner(); });
        };
      });
      refreshBanner();
    }).catch(function () {});
  }

  /* ================= 2 · style (persisted) ================= */
  function setPill(containerId, attr, val) { $(containerId).querySelectorAll(".pill").forEach(function (p) { p.classList.toggle("on", p.getAttribute(attr) === val); }); }
  function applyStyleControls() {
    setPill("corners", "data-c", state.pip.corner);
    setPill("shapes", "data-s", state.pip.shape);
    $("size").value = state.pip.sizePct; $("sizeV").textContent = state.pip.sizePct;
    $("margin").value = state.pip.marginPct; $("marginV").textContent = state.pip.marginPct;
    $("border").value = state.pip.borderPx; $("borderV").textContent = state.pip.borderPx;
    $("radius").value = state.pip.radiusPct;
    $("borderColor").value = state.pip.borderColor;
    $("radiusWrap").style.display = state.pip.shape === "rounded" ? "" : "none";
  }
  function bindPills(containerId, attr, key, after) {
    $(containerId).querySelectorAll(".pill").forEach(function (p) {
      p.onclick = function () {
        setPill(containerId, attr, p.getAttribute(attr));
        state.pip[key] = p.getAttribute(attr); if (after) after(); saveStyle(); renderPip();
      };
    });
  }
  bindPills("corners", "data-c", "corner");
  bindPills("shapes", "data-s", "shape", function () { $("radiusWrap").style.display = state.pip.shape === "rounded" ? "" : "none"; });
  function bindRange(id, key, label) {
    $(id).oninput = function () { state.pip[key] = Number(this.value); if (label) $(label).textContent = this.value; saveStyle(); renderPip(); };
  }
  bindRange("size", "sizePct", "sizeV");
  bindRange("margin", "marginPct", "marginV");
  bindRange("border", "borderPx", "borderV");
  bindRange("radius", "radiusPct");
  $("borderColor").oninput = function () { state.pip.borderColor = this.value; saveStyle(); renderPip(); };

  function setStageBg(url) {
    var stage = $("stage"), bg = stage.querySelector("img.bg");
    if (!bg) { bg = document.createElement("img"); bg.className = "bg"; stage.insertBefore(bg, $("pipBox")); }
    bg.src = url; $("stagePh").style.display = "none";
  }
  function renderPip() {
    var stage = $("stage"), box = $("pipBox");
    var W = stage.clientWidth, p = state.pip;
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

  /* ================= 3 · roles ================= */
  function loadGallery(cb) {
    api("/api/in-market/shot?list=1").then(function (j) { state.shots = (j && j.shots) || []; renderGallery(); cb && cb(); })
      .catch(function (e) { $("gallery").innerHTML = '<div class="empty">Could not load roles: ' + e.message + '</div>'; });
  }
  $("btnRefresh").onclick = function () { loadGallery(); };
  $("gsearch").oninput = renderGallery;
  function visibleRoles() {
    var q = ($("gsearch").value || "").toLowerCase();
    return state.shots.filter(function (s) { return !q || (s.company + " " + s.roleTitle).toLowerCase().indexOf(q) >= 0; });
  }
  function renderGallery() {
    var list = visibleRoles(), box = $("gallery");
    if (state.shots.length && !$("stage").querySelector("img.bg")) setStageBg(shotGif(state.shots[0].key));
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
      var prior = state.results[s.key];
      if (prior && prior.videoKey) renderResult(s, prior.videoKey); // restore prior generations
    });
  }
  function tileEl(key) { return $("gallery").querySelector('.tile[data-key="' + String(key).replace(/["\\]/g, "\\$&") + '"]'); }

  function generate(s, opts) {
    opts = opts || {};
    if (!ready()) { refreshBanner(); return Promise.resolve(false); }
    var t = tileEl(s.key); if (t) { var a = t.querySelector("[data-act]"); if (a) a.innerHTML = '<span class="muted"><span class="spin"></span>Rendering…</span>'; }
    var payload = { company: s.company, roleTitle: s.roleTitle, roleUrl: s.pageUrl, clipId: state.clipId, pip: state.pip, force: !!opts.force };
    return new Promise(function (resolve) {
      var tries = 0;
      (function tick() {
        api("/api/in-market/video", { method: "POST", body: JSON.stringify(payload) }).then(function (res) {
          payload.force = false;
          if (res.status === "composing") { if (tries++ > 48) { resultErr(s, "timed out"); return resolve(false); } setTimeout(tick, 2500); return; }
          if (res.status === "ready") {
            state.results[s.key] = { videoKey: res.key, company: s.company, roleTitle: s.roleTitle }; saveResults();
            renderResult(s, res.key); resolve(true);
          } else { resultErr(s, genReason(res)); resolve(false); }
        }).catch(function (e) { resultErr(s, e.message); resolve(false); });
      })();
    });
  }
  function renderResult(s, vk) {
    var t = tileEl(s.key); if (!t) return;
    t.classList.add("done");
    var act = t.querySelector("[data-act]");
    var w = watchPage(vk, s.company, s.roleTitle);
    act.innerHTML =
      '<a class="lk" href="' + esc(w) + '" target="_blank">▶ Watch</a>' +
      '<button class="primary small" data-email title="Copy a clickable GIF for your email">Copy email</button>' +
      '<button class="ghost small" data-link title="Copy the watch link (LinkedIn, SMS)">Link</button>';
    act.querySelector("[data-email]").onclick = function () { copyRich(emailSnippet(vk, s.company, s.roleTitle)).then(function () { toast("Email snippet copied — paste into your sequence"); }); };
    act.querySelector("[data-link]").onclick = function () { copyText(w).then(function () { toast("Watch link copied"); }); };
  }
  function resultErr(s, msg) { var t = tileEl(s.key); if (!t) return; var a = t.querySelector("[data-act]"); if (a) a.innerHTML = '<span class="muted" style="color:#ffb4ba">' + esc(msg) + '</span>'; }
  function genReason(res) {
    var m = { no_shot: "page not verified", no_clip: "clip missing", no_ffmpeg: "ffmpeg not installed", error: "render failed" };
    return (m[res.status] || res.status) + (res.reason ? " — " + res.reason : "");
  }

  $("btnGenAll").onclick = function () {
    if (!ready()) { refreshBanner(); return; }
    var list = visibleRoles(); if (!list.length) return;
    var btn = $("btnGenAll"); btn.disabled = true;
    var i = 0;
    (function next() {
      if (i >= list.length) { btn.disabled = false; btn.textContent = "⚡ Generate all"; toast("All " + list.length + " roles ready"); return; }
      btn.textContent = "Generating " + (i + 1) + "/" + list.length + "…";
      generate(list[i++]).then(next);
    })();
  };

  /* ---- capture a new role ---- */
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
        if (res.status === "capturing") { if (tries++ > 48) { capStatus("Still working — hit ↻ shortly.", true); $("btnCapture").disabled = false; return; } setTimeout(tick, 2500); return; }
        $("btnCapture").disabled = false;
        if (res.status === "company_site") { capStatus("Captured ✓"); loadGallery(); }
        else capStatus(shotReason(res), true);
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
          var c = document.createElement("span"); c.className = "pill"; c.style.cursor = "pointer"; c.textContent = r.title;
          c.onclick = function () { $("capRole").value = r.title; $("capUrl").value = r.url || ""; captureRole(company, r.title, r.url || undefined); };
          chips.appendChild(c);
        });
      })
      .catch(function (e) { capStatus(e.message, true); });
  };
  function capStatus(html, err) { var el = $("capStatus"); el.innerHTML = html; el.style.color = err ? "#ffb4ba" : ""; }

  /* ---------------- init ---------------- */
  applyStyleControls();
  loadGallery();
  loadClips();
  renderPip();
  refreshBanner();
})();
