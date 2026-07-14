/* RecruitersOS · Command Center UX layer
 *
 * Self-contained, DOM-driven enhancements on top of command.js. Reads the
 * rendered chrome (nav items, account menu, motion + theme switches), never
 * the router's internals, so it is automatically RBAC-, motion- and
 * white-label-aware and safe to load on any build of the SPA.
 *
 *   1. Command palette (Ctrl/Cmd+K): jump to any tab (recents first),
 *      quick-create, switch motion or theme, open settings, sign out.
 *   2. Keyboard chords: press g then a letter to jump between tabs;
 *      ? opens the shortcuts reference.
 *   3. Sidebar rail (Ctrl+B, persisted) + mobile navigation drawer.
 *   4. Wayfinding: breadcrumb reflects drill-down details, the browser tab
 *      title follows the active view, route changes scroll to top and hand
 *      focus to the page title, and opening /command bare restores the last
 *      route you were working in.
 *   5. Accessibility: skip link, aria-current on the active nav item.
 */
(function () {
  "use strict";
  if (!document.body || !document.body.classList.contains("app")) return;

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  /* ---------------- route helpers ---------------- */
  function routeOf(hash) {
    var h = (hash || location.hash || "#overview").replace(/^#/, "");
    var parts = h.split("/");
    if (parts[0] === "bd" || parts[0] === "recruiting") parts.shift();
    return parts[0] || "overview";
  }
  function detailOf(hash) {
    var h = (hash || location.hash || "").replace(/^#/, "");
    var parts = h.split("/");
    if (parts[0] === "bd" || parts[0] === "recruiting") parts.shift();
    return parts[1] || "";
  }
  function pretty(slug) {
    return String(slug).replace(/[-_]+/g, " ").replace(/^\w/, function (c) { return c.toUpperCase(); });
  }
  function navItemFor(route) {
    return $$('.nav-item[data-route="' + route + '"]').filter(function (n) { return n.style.display !== "none"; })[0] || null;
  }
  // The visible label only: icon spans and count badges stripped.
  function labelOf(n) {
    if (!n) return "";
    var c = n.cloneNode(true);
    $$(".ni, .ni-badge, .ic, svg", c).forEach(function (x) { x.remove(); });
    return c.textContent.trim();
  }

  /* ---------------- 5. Accessibility base ---------------- */
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

  /* ---------------- 4. Wayfinding ---------------- */
  var pageTitle = $("#pageTitle");
  var crumb = $("#crumb");
  var panelWrap = $(".panel-wrap");
  var view = $("#view");
  var lastRoute = routeOf();
  var lastComposedTitle = null;

  if (pageTitle) pageTitle.setAttribute("tabindex", "-1");

  function syncTitle() {
    if (!pageTitle) return;
    var page = pageTitle.textContent.trim();
    if (!page) return;
    // Base = whatever command.js (portal identity or white-label branding)
    // last set. If someone else changed the title since our last compose,
    // re-adopt theirs as the new base.
    if (lastComposedTitle === null || document.title !== lastComposedTitle) {
      syncTitle.base = document.title;
    }
    var composed = page + " · " + (syncTitle.base || "RecruitersOS");
    document.title = composed;
    lastComposedTitle = composed;
  }

  function syncCrumbDetail() {
    if (!crumb) return;
    var d = detailOf();
    var old = crumb.querySelector(".crumb-detail");
    if (old) old.remove();
    if (!d) return;
    var span = document.createElement("span");
    span.className = "crumb-detail";
    span.textContent = " / " + pretty(d);
    crumb.appendChild(span);
  }

  function onRoute() {
    var r = routeOf();
    var routeChanged = r !== lastRoute;
    lastRoute = r;
    lsSet("ros_lastroute", r);
    // recents: most-recent-first, unique, capped
    try {
      var rec = JSON.parse(lsGet("ros_recents") || "[]").filter(function (x) { return x !== r; });
      rec.unshift(r);
      lsSet("ros_recents", JSON.stringify(rec.slice(0, 8)));
    } catch (e) {}
    syncAria();
    syncTitle();
    syncCrumbDetail();
    if (routeChanged) {
      if (panelWrap) panelWrap.scrollTop = 0;
      // Hand focus to the title so screen readers announce the new view,
      // unless the user is already typing somewhere.
      var ae = document.activeElement, tag = ae && ae.tagName;
      if (pageTitle && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
        try { pageTitle.focus({ preventScroll: true }); } catch (e) {}
      }
    }
    if (view) {
      view.classList.remove("view-in");
      void view.offsetWidth;
      view.classList.add("view-in");
    }
  }
  // command.js registered its hashchange render() first (it loads first), so
  // this runs after each render with the fresh DOM.
  window.addEventListener("hashchange", function () { setTimeout(onRoute, 0); });
  setTimeout(onRoute, 0);

  // Opening /command with no hash resumes where you left off.
  (function restore() {
    var h = location.hash.replace(/^#/, "");
    if (h) return;
    var last = lsGet("ros_lastroute");
    if (last && last !== "overview") location.hash = last;
  })();

  /* ---------------- 3a. Sidebar rail ---------------- */
  var side = $(".sidebar.cmd-side");
  if (side) {
    var railBtn = document.createElement("button");
    railBtn.type = "button";
    railBtn.id = "railToggle";
    railBtn.setAttribute("aria-label", "Collapse sidebar");
    railBtn.title = "Collapse sidebar (Ctrl+B)";
    railBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>';
    side.appendChild(railBtn);

    var setRail = function (on, persist) {
      document.body.classList.toggle("side-rail", on);
      railBtn.setAttribute("aria-label", on ? "Expand sidebar" : "Collapse sidebar");
      railBtn.title = (on ? "Expand" : "Collapse") + " sidebar (Ctrl+B)";
      if (persist) lsSet("ros_siderail", on ? "1" : "0");
      $$(".nav-item").forEach(function (n) {
        if (on) n.title = labelOf(n); else n.removeAttribute("title");
      });
    };
    railBtn.addEventListener("click", function () { setRail(!document.body.classList.contains("side-rail"), true); });
    if (lsGet("ros_siderail") === "1") setRail(true, false);
  }

  /* ---------------- 3b. Mobile drawer ---------------- */
  var topbar = $(".topbar");
  if (side && topbar) {
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

    var setDrawer = function (open) {
      document.body.classList.toggle("nav-open", open);
      burger.setAttribute("aria-expanded", open ? "true" : "false");
      burger.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    };
    burger.addEventListener("click", function () { setDrawer(!document.body.classList.contains("nav-open")); });
    scrim.addEventListener("click", function () { setDrawer(false); });
    side.addEventListener("click", function (e) {
      if (e.target.closest && e.target.closest(".nav-item")) setDrawer(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && document.body.classList.contains("nav-open")) setDrawer(false);
    });
  }

  /* ---------------- 1. Command palette ---------------- */
  var pal, palInput, palList, palItems = [], palSel = 0;

  // Quick-create: navigate to the owning tab, then press its primary action.
  function runCreate(route) {
    location.hash = route;
    var tries = 0;
    (function poll() {
      var pa = $("#primaryAction");
      if (pa && pa.style.display !== "none" && routeOf() === route) { pa.click(); return; }
      if (++tries < 12) setTimeout(poll, 130);
    })();
  }

  function buildIndex() {
    var items = [];
    var seen = {};
    var recents = [];
    try { recents = JSON.parse(lsGet("ros_recents") || "[]"); } catch (e) {}
    var current = routeOf();

    // Tabs currently visible (RBAC + motion already applied by command.js).
    $$(".nav-item[data-route]").forEach(function (n) {
      if (n.style.display === "none") return;
      var label = labelOf(n);
      var route = n.getAttribute("data-route");
      if (!label || seen["r:" + route + label]) return;
      seen["r:" + route + label] = 1;
      var ri = recents.indexOf(route);
      items.push({
        group: (ri >= 0 && ri < 4 && route !== current) ? "Recent" : "Go to",
        label: label, hint: "#" + route,
        boost: ri >= 0 ? (8 - ri) : 0,
        run: function () { location.hash = route; }
      });
    });

    // Quick-create, phrased from the live nav labels.
    var campNav = navItemFor("campaigns");
    if (campNav) items.push({ group: "Create", label: "New campaign", hint: "in Campaigns", boost: 2, run: function () { runCreate("campaigns"); } });
    var prosNav = navItemFor("prospects");
    if (prosNav) {
      var noun = labelOf(prosNav).toLowerCase().replace(/s$/, "");
      items.push({ group: "Create", label: "Add " + noun, hint: "in " + labelOf(prosNav), boost: 2, run: function () { runCreate("prospects"); } });
    }
    var teamNav = navItemFor("team");
    if (teamNav) items.push({ group: "Create", label: "Invite recruiter", hint: "in Team", boost: 2, run: function () { runCreate("team"); } });

    // Settings surfaces from the account menu.
    $$("#acctMenu .acct-item[data-route]").forEach(function (a) {
      if (a.hidden || a.style.display === "none") return;
      var label = labelOf(a);
      var route = a.getAttribute("data-route");
      if (!label || seen["s:" + route]) return;
      seen["s:" + route] = 1;
      items.push({ group: "Settings", label: label, hint: "#" + route, boost: 0, run: function () { location.hash = route; } });
    });

    // Mode switches.
    $$(".motion-toggle .mt").forEach(function (b) {
      if (b.classList.contains("active")) return;
      items.push({ group: "Switch", label: "Switch to " + b.textContent.trim(), hint: "workspace motion", boost: 0, run: function () { b.click(); } });
    });
    $$("#themeSeg .ts").forEach(function (b) {
      if (b.classList.contains("active")) return;
      items.push({ group: "Switch", label: b.textContent.trim() + " theme", hint: "appearance", boost: 0, run: function () { b.click(); } });
    });
    items.push({ group: "Switch", label: document.body.classList.contains("side-rail") ? "Expand sidebar" : "Collapse sidebar", hint: "Ctrl+B", boost: 0, run: function () { var b = $("#railToggle"); if (b) b.click(); } });

    items.push({ group: "Help", label: "Keyboard shortcuts", hint: "?", boost: 0, run: openKeys });
    items.push({ group: "Help", label: "Help Center", hint: "/helpcenter", boost: 0, run: function () { location.href = "/helpcenter"; } });
    items.push({ group: "Help", label: "Playbooks: how it works", hint: "#playbooks", boost: 0, run: function () { location.hash = "playbooks"; } });
    var out = $("#acctSignOut");
    if (out) items.push({ group: "Account", label: "Sign out", hint: "", boost: 0, run: function () { out.click(); } });
    return items;
  }

  function score(q, label) {
    q = q.toLowerCase(); label = label.toLowerCase();
    if (!q) return 1;
    var ix = label.indexOf(q);
    if (ix === 0) return 100;
    if (ix > 0) return 60 - Math.min(ix, 40);
    var li = 0;
    for (var qi = 0; qi < q.length; qi++) {
      li = label.indexOf(q[qi], li);
      if (li < 0) return 0;
      li++;
    }
    return 10;
  }

  var GROUP_ORDER = { Recent: 0, "Go to": 1, Create: 2, Switch: 3, Settings: 4, Help: 5, Account: 6 };

  function renderPal(q) {
    var ranked = buildIndex()
      .map(function (it) { return { it: it, s: score(q, it.label) + (q ? it.boost : 0) }; })
      .filter(function (r) { return r.s > 0; });
    function gOrd(it) { return it.group in GROUP_ORDER ? GROUP_ORDER[it.group] : 9; }
    if (q) ranked.sort(function (a, b) { return b.s - a.s; });
    else ranked.sort(function (a, b) {
      var g = gOrd(a.it) - gOrd(b.it);
      return g !== 0 ? g : (b.it.boost - a.it.boost);
    });
    ranked = ranked.slice(0, 14);
    palItems = ranked.map(function (r) { return r.it; });
    palSel = 0;
    if (!palItems.length) {
      palList.innerHTML = '<div class="pal-empty">No matches. Try a tab name, "new campaign", or "dark".</div>';
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
    if (pal) closePal();
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
      '<div class="pal-foot"><span><b>&uarr;&darr;</b> navigate</span><span><b>&crarr;</b> select</span><span><b>?</b> shortcuts</span><span><b>esc</b> close</span></div>' +
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

  /* ---------------- 2. Keyboard chords + shortcuts sheet ---------------- */
  // g then letter. Only routes whose nav item is visible right now qualify,
  // so chords follow RBAC and the active motion exactly like the sidebar.
  var CHORDS = [
    ["d", "overview", "Dashboard"],
    ["a", "analytics", "Analytics"],
    ["r", "response", "Replies"],
    ["h", "inmarket", "Hire Signals"],
    ["c", "clients", "Clients"],
    ["e", "email", "Email"],
    ["q", "sendqueue", "Send Queue"],
    ["s", "senders", "Senders"],
    ["u", "autopilot", "Autopilot"],
    ["m", "campaigns", "Campaigns"],
    ["n", "data", "Candidates"],
    ["j", "jdsourcing", "JD Sourcing"],
    ["v", "voicedrops", "Voice Drops"],
    ["p", "pipstudio", "PiP Studio"],
    ["t", "team", "Team"],
    ["o", "outreach-stats", "Outreach Statistics"],
    ["i", "vetting", "AI Vetting"],
    ["x", "setup", "Setup"],
    ["b", "playbooks", "Playbooks"],
  ];
  var chordArmed = 0;

  var keysOv = null;
  function openKeys() {
    closeKeys();
    var rows = CHORDS.filter(function (c) { return navItemFor(c[1]); })
      .map(function (c) {
        var n = navItemFor(c[1]);
        return '<div class="keys-row"><span>' + (n ? labelOf(n) : c[2]).replace(/</g, "&lt;") +
          '</span><span class="keys-k"><kbd>g</kbd> then <kbd>' + c[0] + "</kbd></span></div>";
      }).join("");
    keysOv = document.createElement("div");
    keysOv.className = "pal-bg";
    keysOv.setAttribute("role", "dialog");
    keysOv.setAttribute("aria-modal", "true");
    keysOv.setAttribute("aria-label", "Keyboard shortcuts");
    keysOv.innerHTML =
      '<div class="pal keys">' +
      '<div class="keys-head"><b>Keyboard shortcuts</b><button type="button" class="keys-x" aria-label="Close">×</button></div>' +
      '<div class="keys-body">' +
      '<div class="keys-col"><div class="keys-cap">General</div>' +
      '<div class="keys-row"><span>Command palette</span><span class="keys-k"><kbd>Ctrl</kbd><kbd>K</kbd></span></div>' +
      '<div class="keys-row"><span>Collapse sidebar</span><span class="keys-k"><kbd>Ctrl</kbd><kbd>B</kbd></span></div>' +
      '<div class="keys-row"><span>This sheet</span><span class="keys-k"><kbd>?</kbd></span></div>' +
      '<div class="keys-row"><span>Close dialogs</span><span class="keys-k"><kbd>esc</kbd></span></div>' +
      "</div>" +
      '<div class="keys-col"><div class="keys-cap">Go to</div>' + rows + "</div>" +
      "</div></div>";
    document.body.appendChild(keysOv);
    keysOv.addEventListener("click", function (e) {
      if (e.target === keysOv || e.target.closest(".keys-x")) closeKeys();
    });
  }
  function closeKeys() {
    if (keysOv && keysOv.parentNode) keysOv.parentNode.removeChild(keysOv);
    keysOv = null;
  }

  function inEditable() {
    var ae = document.activeElement, tag = ae && ae.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (ae && ae.isContentEditable);
  }

  document.addEventListener("keydown", function (e) {
    var mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "k" || e.key === "K")) { e.preventDefault(); pal ? closePal() : openPal(); return; }
    if (mod && (e.key === "b" || e.key === "B")) {
      if (!inEditable()) { e.preventDefault(); var b = $("#railToggle"); if (b) b.click(); }
      return;
    }

    // Palette-internal keys
    if (pal) {
      if (e.key === "Escape") { closePal(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); palSel = Math.min(palSel + 1, palItems.length - 1); paintSel(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); palSel = Math.max(palSel - 1, 0); paintSel(); }
      else if (e.key === "Enter") {
        e.preventDefault();
        var it = palItems[palSel];
        closePal();
        if (it) it.run();
      }
      return;
    }
    if (keysOv && e.key === "Escape") { closeKeys(); return; }
    if (mod || e.altKey || inEditable()) return;

    // Shortcuts sheet
    if (e.key === "?") { e.preventDefault(); keysOv ? closeKeys() : openKeys(); return; }

    // g chords
    var now = Date.now();
    if (e.key === "g" || e.key === "G") { chordArmed = now; return; }
    if (chordArmed && now - chordArmed < 1200) {
      chordArmed = 0;
      var k = e.key.toLowerCase();
      for (var i = 0; i < CHORDS.length; i++) {
        if (CHORDS[i][0] === k && navItemFor(CHORDS[i][1])) {
          e.preventDefault();
          location.hash = CHORDS[i][1];
          return;
        }
      }
    } else {
      chordArmed = 0;
    }
  });

  // Discoverable entry point in the topbar.
  if (topbar) {
    var kbtn = document.createElement("button");
    kbtn.type = "button";
    kbtn.id = "palOpen";
    kbtn.setAttribute("aria-label", "Open command palette");
    kbtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><span>Search</span><kbd>Ctrl K</kbd>';
    var spacer = $(".topbar .spacer");
    if (spacer) topbar.insertBefore(kbtn, spacer.nextSibling); else topbar.appendChild(kbtn);
    kbtn.addEventListener("click", openPal);
  }
})();
