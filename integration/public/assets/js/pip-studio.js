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
  // Prefer the SERVER-SIGNED share URLs (exp+sig) returned by /video; fall back to an unsigned
  // shape only if we don't have them yet (re-render mints fresh signed links).
  function shareFor(vk) { for (var k in state.results) { if (state.results[k] && state.results[k].videoKey === vk) return state.results[k].share || null; } return null; }
  function watchPage(vk, co, ro) { var s = shareFor(vk); if (s && s.watch) return s.watch; return origin() + "/watch?k=" + encodeURIComponent(vk) + "&c=" + encodeURIComponent(co || "") + "&r=" + encodeURIComponent(ro || ""); }
  function publicGif(vk) { var s = shareFor(vk); if (s && s.gif) return s.gif; return origin() + "/api/in-market/watch?key=" + encodeURIComponent(vk) + "&fmt=gif"; }
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
  function showModal(html) { var o = $("modal"); $("modalBody").innerHTML = html; o.classList.add("show"); }
  function hideModal() { $("modal").classList.remove("show"); }

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
  var recTimer = null, recStart = 0;
  function fmtT(ms) { var s = Math.floor(ms / 1000); return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2); }
  function startTimer() {
    recStart = Date.now();
    recTimer = setInterval(function () {
      var ms = Date.now() - recStart, t = fmtT(ms);
      // Gentle guidance: green in the sweet spot (8–25s), amber past 45s.
      var hint = ms < 8000 ? "keep going…" : ms <= 25000 ? "good length — wrap when ready" : ms <= 45000 ? "" : "getting long";
      $("recHint").innerHTML = '<span style="color:#ff6b6b">●</span> Recording <b>' + t + "</b>" + (hint ? ' · <span class="muted">' + hint + "</span>" : "");
    }, 250);
  }
  function stopTimer() { if (recTimer) { clearInterval(recTimer); recTimer = null; } }
  $("btnRec").onclick = function () {
    if (state.recorder && state.recorder.state === "recording") { state.recorder.stop(); return; }
    state.chunks = [];
    var mime = pickMime();
    try { state.recorder = new MediaRecorder(state.stream, mime ? { mimeType: mime } : undefined); }
    catch (e) { $("recHint").textContent = "Recorder error: " + e.message; return; }
    state.recorder.ondataavailable = function (ev) { if (ev.data && ev.data.size) state.chunks.push(ev.data); };
    state.recorder.onstop = function () {
      stopTimer();
      state.recordedBlob = new Blob(state.chunks, { type: (state.recorder.mimeType || mime || "video/webm").split(";")[0] });
      preview.srcObject = null; preview.src = URL.createObjectURL(state.recordedBlob); preview.muted = false; preview.controls = true;
      $("btnSave").disabled = false; $("btnDiscard").disabled = false; $("btnRec").textContent = "● Record";
      $("recHint").textContent = "Preview it, then Save (or Discard and re-record).";
    };
    state.recorder.start();
    startTimer();
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
  bindPills("corners", "data-c", "corner", function () { delete state.pip.xPct; delete state.pip.yPct; });
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
    var W = stage.clientWidth, H = stage.clientHeight, p = state.pip;
    var pw = (p.sizePct / 100) * W, ph = p.shape === "circle" ? pw : pw * 0.62, m = (p.marginPct / 100) * W;
    box.style.width = pw + "px"; box.style.height = ph + "px";
    box.style.top = box.style.bottom = box.style.left = box.style.right = "auto";
    if (p.xPct != null && p.yPct != null) {
      // free drag: bubble top-left at % of the free space
      box.style.left = ((p.xPct / 100) * Math.max(0, W - pw)) + "px";
      box.style.top = ((p.yPct / 100) * Math.max(0, H - ph)) + "px";
    } else {
      if (p.corner === "tl" || p.corner === "tr") box.style.top = m + "px"; else box.style.bottom = m + "px";
      if (p.corner === "tl" || p.corner === "bl") box.style.left = m + "px"; else box.style.right = m + "px";
    }
    box.style.borderRadius = p.shape === "circle" ? "50%" : (p.shape === "rounded" ? (p.radiusPct / 100) * pw + "px" : "0");
    box.style.border = p.borderPx ? (p.borderPx + "px solid " + p.borderColor) : "none";
    box.style.cursor = "grab"; box.title = "Drag me anywhere";
    var v = box.querySelector("video");
    if (!v) { v = document.createElement("video"); v.muted = true; v.playsInline = true; v.autoplay = true; box.appendChild(v); }
    if (state.stream && !state.recordedBlob) { if (v.srcObject !== state.stream) { v.srcObject = state.stream; v.play(); } var nc = box.querySelector(".nocam"); if (nc) nc.remove(); }
    else if (!state.stream && !box.querySelector(".nocam")) { var n = document.createElement("div"); n.className = "nocam"; n.textContent = "you"; box.appendChild(n); }
  }
  window.addEventListener("resize", renderPip);

  /* Loom-style drag-anywhere: grab the bubble and drop it; persists as xPct/yPct (overrides corner). */
  (function setupPipDrag() {
    var box = $("pipBox"); if (!box) return;
    var drag = null;
    function start(e) {
      var pt = e.touches ? e.touches[0] : e, r = box.getBoundingClientRect();
      drag = { dx: pt.clientX - r.left, dy: pt.clientY - r.top, bw: r.width, bh: r.height };
      box.style.cursor = "grabbing"; if (e.cancelable) e.preventDefault();
    }
    function move(e) {
      if (!drag) return;
      var pt = e.touches ? e.touches[0] : e, stage = $("stage"), sr = stage.getBoundingClientRect();
      var freeW = Math.max(1, stage.clientWidth - drag.bw), freeH = Math.max(1, stage.clientHeight - drag.bh);
      state.pip.xPct = Math.max(0, Math.min(100, ((pt.clientX - sr.left - drag.dx) / freeW) * 100));
      state.pip.yPct = Math.max(0, Math.min(100, ((pt.clientY - sr.top - drag.dy) / freeH) * 100));
      renderPip(); if (e.cancelable) e.preventDefault();
    }
    function end() { if (!drag) return; drag = null; box.style.cursor = "grab"; setPill("corners", "data-c", ""); saveStyle(); }
    box.addEventListener("mousedown", start); window.addEventListener("mousemove", move); window.addEventListener("mouseup", end);
    box.addEventListener("touchstart", start, { passive: false }); window.addEventListener("touchmove", move, { passive: false }); window.addEventListener("touchend", end);
  })();

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
            state.results[s.key] = { videoKey: res.key, company: s.company, roleTitle: s.roleTitle, share: res.share }; saveResults();
            renderResult(s, res.key); resolve(true);
          } else { resultErr(s, genReason(res)); resolve(false); }
        }).catch(function (e) { resultErr(s, e.message); resolve(false); });
      })();
    });
  }
  function renderResult(s, vk) {
    var t = tileEl(s.key); if (!t) return;
    t.classList.add("done");
    // Swap the card thumbnail to the actual composite (you on the scroll), so the tile shows
    // the personalized result, not the plain page capture. Operator is authed -> video endpoint.
    var thumb = t.querySelector(".thumb img");
    if (thumb) thumb.src = API + "/api/in-market/video?key=" + encodeURIComponent(vk) + "&fmt=gif";
    var go = t.querySelector(".thumb .go"); if (go) go.textContent = "↻ Re-render";
    var act = t.querySelector("[data-act]");
    var w = watchPage(vk, s.company, s.roleTitle);
    act.innerHTML =
      '<a class="lk" href="' + esc(w) + '" target="_blank">▶ Watch</a>' +
      '<button class="primary small" data-email title="Copy a clickable GIF for your email">Copy email</button>' +
      '<button class="ghost small" data-link title="Copy the watch link (LinkedIn, SMS)">Link</button>' +
      '<button class="ghost small" data-opener title="Draft an AI email opener that wraps this video">✨ Opener</button>' +
      '<button class="ghost small" data-out title="Attach this video to the hiring-manager prospects at this company">→ Outreach</button>';
    act.querySelector("[data-email]").onclick = function () { copyRich(emailSnippet(vk, s.company, s.roleTitle)).then(function () { toast("Email snippet copied — paste into your sequence"); }); };
    act.querySelector("[data-link]").onclick = function () { copyText(w).then(function () { toast("Watch link copied"); }); };
    act.querySelector("[data-opener]").onclick = function () { openOpener(s, vk); };
    act.querySelector("[data-out]").onclick = function () { attachToOutreach(s, vk); };
  }

  /* AI opener: draft a short email (Claude) that wraps this video, shown in a modal with a
     rendered preview + copy. Falls back to a built-in template server-side when no key. */
  function openOpener(s, vk) {
    showModal('<div class="muted"><span class="spin"></span> Drafting opener for ' + esc(s.company) + ' — ' + esc(s.roleTitle) + '…</div>');
    api("/api/in-market/opener", { method: "POST", body: JSON.stringify({
      company: s.company, roleTitle: s.roleTitle, videoKey: vk,
      watchUrl: watchPage(vk, s.company, s.roleTitle), gifUrl: publicGif(vk),
    }) }).then(function (d) {
      var badge = d.source === "ai" ? '<span class="srcbadge ai">✨ Claude</span>' : '<span class="srcbadge">template</span>';
      var e1 = d.firstEmail || { subject: d.subject, body: d.body, bodyFilled: d.body };
      var e1html = esc(e1.bodyFilled || e1.body).replace(/\n/g, "<br>");
      var e2html = d.bodyHtml || esc(d.body).replace(/\n/g, "<br>"); // email 2 carries the video
      showModal(
        '<div class="mh"><b>Email sequence</b> ' + badge + '<span class="muted" style="margin-left:8px;font-size:12px">text intro → video follow-up</span><button class="mx" data-close>✕</button></div>' +
        '<div class="seqstep"><div class="mlbl">Email 1 · text only <span class="muted">(first touch — no video)</span></div>' +
          '<div class="msub">' + esc(e1.subject) + '</div>' +
          '<div class="mbody">' + e1html + '</div>' +
          '<div class="mfoot"><button class="ghost small" data-cpy-e1>Copy email 1 (text)</button></div></div>' +
        '<div class="seqstep"><div class="mlbl">Email 2 · video follow-up <span class="muted">(sent a few days later)</span></div>' +
          '<div class="msub">' + esc(d.subject) + '</div>' +
          '<div class="mbody">' + e2html + '</div>' +
          '<div class="mfoot">' +
            '<button class="primary small" data-cpy-html>Copy email 2 (with video)</button>' +
            '<button class="ghost small" data-cpy-text>Copy text only</button>' +
            '<span class="muted" style="flex:1"></span>' +
            '<button class="ghost small" data-close>Close</button>' +
          '</div></div>'
      );
      var box = $("modalBody");
      box.querySelectorAll("[data-close]").forEach(function (b) { b.onclick = hideModal; });
      box.querySelector("[data-cpy-e1]").onclick = function () { copyText(e1.bodyFilled || e1.body).then(function () { toast("Email 1 (text) copied — send this first"); }); };
      box.querySelector("[data-cpy-html]").onclick = function () { copyRich(e2html).then(function () { toast("Email 2 copied (with video) — send as the follow-up"); }); };
      box.querySelector("[data-cpy-text]").onclick = function () { copyText(d.body).then(function () { toast("Email 2 text copied (keeps {{videoembed}} merge field)"); }); };
    }).catch(function (e) { showModal('<div class="mh"><b>Opener failed</b><button class="mx" data-close>✕</button></div><p class="muted">' + esc(e.message) + "</p>"); $("modalBody").querySelector("[data-close]").onclick = hideModal; });
  }

  /* Recipient bridge: stamp this video onto the company's hiring-manager prospects, so their
     running sequence renders it via {{videoembed}} / {{watchlink}}. Prospects come from Hire
     Signals (promote managers into a campaign first). */
  function attachToOutreach(s, vk) {
    api("/api/in-market/attach?company=" + encodeURIComponent(s.company)).then(function (j) {
      var n = (j && j.count) || 0;
      if (!n) { toast("No prospects at " + s.company + " yet — promote them from Hire Signals first"); return; }
      if (!confirm("Attach the 2-email sequence (text intro → video follow-up) to " + n + " prospect" + (n > 1 ? "s" : "") + " at " + s.company + "?\nThe video is the SECOND touch; signed links are generated automatically.")) return;
      api("/api/in-market/attach", { method: "POST", body: JSON.stringify({
        videoKey: vk, roleTitle: s.roleTitle, company: s.company,
        clipId: state.clipId, pip: state.pip, roleUrl: s.pageUrl, // enable per-recipient "Hey {name}" intros
      }) }).then(function (r) {
        var msg = "Sequence attached to " + (r.attached || 0) + " prospect(s) at " + s.company;
        if (r.personalizedNames) msg += " · " + r.personalizedNames + ' personalized "Hey {name}" intro' + (r.personalizedNames > 1 ? "s" : "");
        if (r.armed) msg += r.automationOn ? " — sending email 1 now, video follow-up in a few days" : " — armed (turn on automation to send)";
        toast(msg);
      })
        .catch(function (e) { toast("Attach failed: " + e.message); });
    }).catch(function (e) { toast("Lookup failed: " + e.message); });
  }
  function resultErr(s, msg) { var t = tileEl(s.key); if (!t) return; var a = t.querySelector("[data-act]"); if (a) a.innerHTML = '<span class="muted" style="color:#ffb4ba">' + esc(msg) + '</span>'; }
  function genReason(res) {
    var m = { no_shot: "page not verified", no_clip: "clip missing", no_ffmpeg: "ffmpeg not installed", error: "render failed" };
    return (m[res.status] || res.status) + (res.reason ? " — " + res.reason : "");
  }

  /* Bulk export: every generated role as a CSV row ready to merge into a sequence tool
     (Instantly/ColdForge/Smartlead). Columns map cleanly to merge fields + an HTML snippet. */
  $("btnExport").onclick = function () {
    var rows = [];
    Object.keys(state.results).forEach(function (roleKey) {
      var r = state.results[roleKey]; if (!r || !r.videoKey) return;
      rows.push({
        company: r.company || "",
        role: r.roleTitle || "",
        watch_url: watchPage(r.videoKey, r.company, r.roleTitle),
        email_gif_url: publicGif(r.videoKey),
        mp4_url: origin() + "/api/in-market/watch?key=" + encodeURIComponent(r.videoKey) + "&fmt=mp4",
        email_html: emailSnippet(r.videoKey, r.company, r.roleTitle),
      });
    });
    if (!rows.length) { toast("Generate at least one role first"); return; }
    var cols = ["company", "role", "watch_url", "email_gif_url", "mp4_url", "email_html"];
    var csv = cols.join(",") + "\r\n" + rows.map(function (row) {
      return cols.map(function (c) { return '"' + String(row[c]).replace(/"/g, '""') + '"'; }).join(",");
    }).join("\r\n");
    var blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pip-videos-" + rows.length + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    toast("Exported " + rows.length + " roles to CSV");
  };

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

  /* ================= PERFORMANCE dashboard ================= */
  var perfTimer = null;
  function showView(which) {
    var perf = which === "perf";
    $("createView").style.display = perf ? "none" : "";
    $("perfView").style.display = perf ? "" : "none";
    $("tabCreate").classList.toggle("on", !perf);
    $("tabPerf").classList.toggle("on", perf);
    if (perf) { loadPerf(); if (!perfTimer) perfTimer = setInterval(loadPerf, 15000); }
    else if (perfTimer) { clearInterval(perfTimer); perfTimer = null; }
  }
  $("tabCreate").onclick = function () { showView("create"); };
  $("tabPerf").onclick = function () { showView("perf"); };
  $("perfRefresh").onclick = function () { loadPerf(); };

  function loadPerf() {
    api("/api/in-market/track?days=14").then(renderPerf).catch(function (e) {
      $("kpis").innerHTML = '<div class="empty" style="grid-column:1/-1">Could not load stats: ' + esc(e.message) + "</div>";
    });
  }
  function nfmt(n) { n = n || 0; return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n); }
  function dur(s) { s = Math.round(s || 0); return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + ("0" + (s % 60)).slice(-2) + "s"; }
  function pct(x) { return Math.round((x || 0) * 100) + "%"; }
  function ago(iso) {
    var d = (Date.now() - Date.parse(iso)) / 1000;
    if (d < 60) return Math.max(1, Math.floor(d)) + "s";
    if (d < 3600) return Math.floor(d / 60) + "m";
    if (d < 86400) return Math.floor(d / 3600) + "h";
    return Math.floor(d / 86400) + "d";
  }

  function renderPerf(o) {
    var t = (o && o.totals) || {};
    $("perfSub").textContent = (t.videos || 0) + " video" + (t.videos === 1 ? "" : "s") + " · engagement across every personalized role video.";
    $("perfUpdated").textContent = "updated just now";
    var kpis = [
      { v: nfmt(t.gifOpens), l: "Email opens", sub: "teaser GIF loads" },
      { v: nfmt(t.opens), l: "Page visits", sub: "watch-page loads" },
      { v: nfmt(t.plays), l: "Plays", sub: pct(t.opens ? t.plays / t.opens : 0) + " of visits" },
      { v: nfmt(t.uniqueViewers), l: "Unique viewers", sub: "" },
      { v: dur(t.avgWatchSeconds), l: "Avg watch", sub: "" },
      { v: pct(t.completionRate), l: "Completion", sub: nfmt(t.completes) + " finished" },
    ];
    $("kpis").innerHTML = kpis.map(function (k) {
      return '<div class="kpi"><div class="v">' + k.v + '</div><div class="l">' + k.l + "</div>" + (k.sub ? '<div class="sub">' + esc(k.sub) + "</div>" : "") + "</div>";
    }).join("");

    $("chart").innerHTML = chartSvg((o && o.trend) || []);
    renderFeed((o && o.recent) || []);
    renderLeaderboard((o && o.videos) || []);
  }

  // Inline SVG area+line chart for the daily plays trend (no external libs).
  function chartSvg(trend) {
    if (!trend.length) return '<div class="empty">No data yet.</div>';
    var W = 720, H = 200, padL = 28, padB = 22, padT = 12, padR = 8;
    var iw = W - padL - padR, ih = H - padT - padB;
    var max = Math.max(1, Math.max.apply(null, trend.map(function (d) { return d.plays; })));
    var step = trend.length > 1 ? iw / (trend.length - 1) : 0;
    var pts = trend.map(function (d, i) { return [padL + i * step, padT + ih - (d.plays / max) * ih]; });
    var line = pts.map(function (p, i) { return (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join(" ");
    var area = line + " L" + (padL + (trend.length - 1) * step).toFixed(1) + " " + (padT + ih) + " L" + padL + " " + (padT + ih) + " Z";
    var grid = [0, 0.5, 1].map(function (f) { var y = padT + ih - f * ih; return '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#1a212b"/><text x="2" y="' + (y + 3) + '" fill="#5b6675" font-size="9">' + Math.round(f * max) + "</text>"; }).join("");
    var dots = pts.map(function (p, i) { return '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="2.5" fill="#19c37d"><title>' + esc(trend[i].date) + ": " + trend[i].plays + " plays</title></circle>"; }).join("");
    var labels = trend.map(function (d, i) { if (i % Math.ceil(trend.length / 7) && i !== trend.length - 1) return ""; return '<text x="' + (padL + i * step).toFixed(1) + '" y="' + (H - 6) + '" fill="#5b6675" font-size="9" text-anchor="middle">' + d.date.slice(5) + "</text>"; }).join("");
    return '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none">' +
      '<defs><linearGradient id="ag" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#19c37d" stop-opacity=".35"/><stop offset="1" stop-color="#19c37d" stop-opacity="0"/></linearGradient></defs>' +
      grid + '<path d="' + area + '" fill="url(#ag)"/><path d="' + line + '" fill="none" stroke="#19c37d" stroke-width="2"/>' + dots + labels + "</svg>";
  }

  function renderFeed(recent) {
    if (!recent.length) { $("feed").innerHTML = '<div class="empty">No activity yet.</div>'; return; }
    var label = { open: "Visited", play: "Played", complete: "Finished", gif_open: "Opened email" };
    $("feed").innerHTML = recent.slice(0, 40).map(function (e) {
      var who = (e.company || "Unknown") + (e.roleTitle ? " · " + e.roleTitle : "");
      return '<div class="fe"><span class="ic ' + e.type + '">' + ({ open: "👁", play: "▶", complete: "✓", gif_open: "✉" }[e.type] || "•") +
        '</span><span class="t"><b>' + esc(label[e.type] || e.type) + "</b> · " + esc(who) + '</span><span class="ago">' + ago(e.at) + "</span></div>";
    }).join("");
  }

  function renderLeaderboard(videos) {
    if (!videos.length) { $("leaderboard").innerHTML = '<div class="empty">Generate and send a video to start seeing performance here.</div>'; return; }
    var maxPlays = Math.max.apply(null, videos.map(function (v) { return v.plays || 0; }).concat([1]));
    var rows = videos.slice(0, 50).map(function (v) {
      return "<tr>" +
        '<td class="l"><div class="co">' + esc(v.company || "—") + '</div><div class="ro">' + esc(v.roleTitle || "") + "</div></td>" +
        "<td>" + nfmt(v.gifOpens) + "</td>" +
        "<td>" + nfmt(v.opens) + "</td>" +
        "<td>" + nfmt(v.plays) + "</td>" +
        "<td>" + nfmt(v.uniqueViewers) + "</td>" +
        "<td>" + dur(v.avgWatchSeconds) + "</td>" +
        '<td><span class="pill-rate">' + pct(v.completionRate) + "</span></td>" +
        '<td class="l"><div class="bar"><i style="width:' + Math.round((v.plays / maxPlays) * 100) + '%"></i></div></td>' +
        "<td>" + (v.lastAt ? ago(v.lastAt) + " ago" : "—") + "</td>" +
        "</tr>";
    }).join("");
    $("leaderboard").innerHTML =
      '<table class="lbt"><thead><tr><th class="l">Company · Role</th><th>Email</th><th>Visits</th><th>Plays</th><th>Viewers</th><th>Avg watch</th><th>Compl.</th><th class="l">Plays</th><th>Last</th></tr></thead><tbody>' +
      rows + "</tbody></table>";
  }

  /* ---------------- init ---------------- */
  applyStyleControls();
  loadGallery();
  loadClips();
  renderPip();
  refreshBanner();
})();
