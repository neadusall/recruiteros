/* RecruitersOS · Command Center UX layer
 *
 * Self-contained, DOM-driven enhancements on top of command.js. Reads the
 * rendered chrome (nav items, account menu, motion + theme switches), never
 * the router's internals, so it is automatically RBAC-, motion- and
 * white-label-aware and safe to load on any build of the SPA.
 *
 *   1. Command palette (Ctrl/Cmd+K): jump to any tab, switch motion or
 *      theme, open settings surfaces, sign out.
 *   2. Sidebar rail: collapse the sidebar to an icon rail (persisted).
 *   3. Mobile navigation drawer: below 920px the sidebar opens as a drawer
 *      from a topbar menu button (it previously just disappeared).
 *   4. Accessibility: skip link, aria-current on the active nav item.
 *   5. View transition: a 140ms fade when the route changes.
 */
(function () {
  "use strict";
  if (!document.body || !document.body.classList.contains("app")) return;

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ---------------- 4. Accessibility base ---------------- */
  var skip = document.createElement("a");
  skip.href = "#view";
  skip.className = "skip-link";
  skip.textContent = "Skip to content";
  document.body.insertBefore(skip, document.body.firstChild);

  function syncAria() {
    $$(".nav-item").forEach(function (n) {
      if (n.classList.contains("active")) n.setAttribute("aria-current", "page");
      else n.removeAttribute("aria-current");
    });
  }
  window.addEventListener("hashchange", function () { setTimeout(syncAria, 0); });
  setTimeout(syncAria, 0);

  /* ---------------- 5. View transition ---------------- */
  var view = $("#view");
  if (view) {
    window.addEventListener("hashchange", function () {
      view.classList.remove("view-in");
      // force a reflow so the animation restarts
      void view.offsetWidth;
      view.classList.add("view-in");
    });
    view.classList.add("view-in");
  }

  /* ---------------- 2. Sidebar rail ---------------- */
  var side = $(".sidebar.cmd-side");
  if (side) {
    var railBtn = document.createElement("button");
    railBtn.type = "button";
    railBtn.id = "railToggle";
    railBtn.setAttribute("aria-label", "Collapse sidebar");
    railBtn.title = "Collapse sidebar (Ctrl+B)";
    railBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>';
    side.appendChild(railBtn);

    function setRail(on, persist) {
      document.body.classList.toggle("side-rail", on);
      railBtn.setAttribute("aria-label", on ? "Expand sidebar" : "Collapse sidebar");
      railBtn.title = (on ? "Expand" : "Collapse") + " sidebar (Ctrl+B)";
      if (persist) { try { localStorage.setItem("ros_siderail", on ? "1" : "0"); } catch (e) {} }
      // Icon-only items keep their meaning through native tooltips.
      $$(".nav-item").forEach(function (n) {
        if (on) n.title = n.textContent.trim(); else n.removeAttribute("title");
      });
    }
    railBtn.addEventListener("click", function () { setRail(!document.body.classList.contains("side-rail"), true); });
    try { if (localStorage.getItem("ros_siderail") === "1") setRail(true, false); } catch (e) {}

    /* ---------------- 3. Mobile drawer ---------------- */
    var topbar = $(".topbar");
    if (topbar) {
      var burger = document.createElement("button");
      burger.type = "button";
      burger.id = "navBurger";
      burger.setAttribute("aria-label", "Open navigation");
      burger.setAttribute("aria-expanded", "false");
      burger.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
      topbar.insertBefore(burger, topbar.firstChild);

      var scrim = document.createElement("div");
      scrim.id = "navScrim";
      document.body.appendChild(scrim);

      function setDrawer(open) {
        document.body.classList.toggle("nav-open", open);
        burger.setAttribute("aria-expanded", open ? "true" : "false");
        burger.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
      }
      burger.addEventListener("click", function () { setDrawer(!document.body.classList.contains("nav-open")); });
      scrim.addEventListener("click", function () { setDrawer(false); });
      side.addEventListener("click", function (e) {
        // Navigating from the drawer closes it.
        if (e.target.closest && e.target.closest(".nav-item")) setDrawer(false);
      });
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && document.body.classList.contains("nav-open")) setDrawer(false);
      });
    }
  }

  /* ---------------- 1. Command palette ---------------- */
  var pal, palInput, palList, palItems = [], palSel = 0;

  function buildIndex() {
    var items = [];
    var seen = {};
    // Tabs: only the ones currently visible (RBAC + motion already applied).
    $$(".nav-item[data-route]").forEach(function (n) {
      if (n.style.display === "none" || n.offsetParent === null && !document.body.classList.contains("nav-open")) {
        if (n.style.display === "none") return;
      }
      var label = n.textContent.trim();
      var route = n.getAttribute("data-route");
      if (!label || seen["r:" + route + label]) return;
      seen["r:" + route + label] = 1;
      items.push({ group: "Go to", label: label, hint: "#" + route, run: function () { location.hash = route; } });
    });
    // Settings surfaces from the account menu.
    $$("#acctMenu .acct-item[data-route]").forEach(function (a) {
      if (a.hidden || a.style.display === "none") return;
      var label = a.textContent.trim();
      var route = a.getAttribute("data-route");
      if (!label || seen["s:" + route]) return;
      seen["s:" + route] = 1;
      items.push({ group: "Settings", label: label, hint: "#" + route, run: function () { location.hash = route; } });
    });
    // Motion switch.
    $$(".motion-toggle .mt").forEach(function (b) {
      if (b.classList.contains("active")) return;
      var label = b.textContent.trim();
      items.push({ group: "Switch", label: "Switch to " + label, hint: "workspace motion", run: function () { b.click(); } });
    });
    // Theme switch.
    $$("#themeSeg .ts").forEach(function (b) {
      if (b.classList.contains("active")) return;
      items.push({ group: "Switch", label: b.textContent.trim() + " theme", hint: "appearance", run: function () { b.click(); } });
    });
    // Sidebar rail.
    items.push({ group: "Switch", label: document.body.classList.contains("side-rail") ? "Expand sidebar" : "Collapse sidebar", hint: "Ctrl+B", run: function () { var b = $("#railToggle"); if (b) b.click(); } });
    // Help + sign out.
    items.push({ group: "Help", label: "Help Center", hint: "/helpcenter", run: function () { location.href = "/helpcenter"; } });
    items.push({ group: "Help", label: "Playbooks: how it works", hint: "#playbooks", run: function () { location.hash = "playbooks"; } });
    var out = $("#acctSignOut");
    if (out) items.push({ group: "Account", label: "Sign out", hint: "", run: function () { out.click(); } });
    return items;
  }

  function score(q, label) {
    q = q.toLowerCase(); label = label.toLowerCase();
    if (!q) return 1;
    var ix = label.indexOf(q);
    if (ix === 0) return 100;
    if (ix > 0) return 60 - Math.min(ix, 40);
    // subsequence match
    var li = 0;
    for (var qi = 0; qi < q.length; qi++) {
      li = label.indexOf(q[qi], li);
      if (li < 0) return 0;
      li++;
    }
    return 10;
  }

  function renderPal(q) {
    var ranked = buildIndex()
      .map(function (it) { return { it: it, s: score(q, it.label) }; })
      .filter(function (r) { return r.s > 0; })
      .sort(function (a, b) { return b.s - a.s; })
      .slice(0, 12);
    palItems = ranked.map(function (r) { return r.it; });
    palSel = 0;
    if (!palItems.length) {
      palList.innerHTML = '<div class="pal-empty">No matches. Try a tab name, "dark", or "sign out".</div>';
      return;
    }
    var html = "", lastGroup = "";
    palItems.forEach(function (it, i) {
      if (it.group !== lastGroup) { html += '<div class="pal-group">' + it.group + "</div>"; lastGroup = it.group; }
      html += '<button type="button" class="pal-item' + (i === palSel ? " sel" : "") + '" data-i="' + i + '">' +
        '<span class="pal-label">' + it.label.replace(/</g, "&lt;") + "</span>" +
        (it.hint ? '<span class="pal-hint">' + it.hint.replace(/</g, "&lt;") + "</span>" : "") +
        "</button>";
    });
    palList.innerHTML = html;
  }

  function paintSel() {
    $$(".pal-item", palList).forEach(function (el, i) {
      el.classList.toggle("sel", i === palSel);
      if (i === palSel) el.scrollIntoView({ block: "nearest" });
    });
  }

  function openPal() {
    if (pal) { closePal(); }
    pal = document.createElement("div");
    pal.className = "pal-bg";
    pal.setAttribute("role", "dialog");
    pal.setAttribute("aria-modal", "true");
    pal.setAttribute("aria-label", "Command palette");
    pal.innerHTML =
      '<div class="pal">' +
      '<div class="pal-head"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
      '<input id="palInput" type="text" placeholder="Jump to a tab or run a command..." autocomplete="off" spellcheck="false" aria-label="Search commands" />' +
      '<span class="pal-esc">esc</span></div>' +
      '<div class="pal-list" id="palList" role="listbox"></div>' +
      '<div class="pal-foot"><span><b>&uarr;&darr;</b> navigate</span><span><b>&crarr;</b> select</span><span><b>esc</b> close</span></div>' +
      "</div>";
    document.body.appendChild(pal);
    palInput = $("#palInput", pal);
    palList = $("#palList", pal);
    renderPal("");
    palInput.focus();
    palInput.addEventListener("input", function () { renderPal(palInput.value.trim()); });
    palList.addEventListener("click", function (e) {
      var b = e.target.closest(".pal-item");
      if (!b) return;
      var it = palItems[Number(b.getAttribute("data-i"))];
      closePal();
      if (it) it.run();
    });
    pal.addEventListener("click", function (e) { if (e.target === pal) closePal(); });
  }

  function closePal() {
    if (pal && pal.parentNode) pal.parentNode.removeChild(pal);
    pal = null;
  }

  document.addEventListener("keydown", function (e) {
    var mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "k" || e.key === "K")) { e.preventDefault(); pal ? closePal() : openPal(); return; }
    if (mod && (e.key === "b" || e.key === "B")) {
      var tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
        e.preventDefault(); var b = $("#railToggle"); if (b) b.click();
      }
      return;
    }
    if (!pal) return;
    if (e.key === "Escape") { closePal(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); palSel = Math.min(palSel + 1, palItems.length - 1); paintSel(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); palSel = Math.max(palSel - 1, 0); paintSel(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      var it = palItems[palSel];
      closePal();
      if (it) it.run();
    }
  });

  // Discoverable entry point in the topbar (right of the title block).
  var bar = $(".topbar");
  if (bar) {
    var kbtn = document.createElement("button");
    kbtn.type = "button";
    kbtn.id = "palOpen";
    kbtn.setAttribute("aria-label", "Open command palette");
    kbtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><span>Search</span><kbd>Ctrl K</kbd>';
    var spacer = $(".topbar .spacer");
    if (spacer) bar.insertBefore(kbtn, spacer.nextSibling); else bar.appendChild(kbtn);
    kbtn.addEventListener("click", openPal);
  }
})();
