/* RecruitersOS · Command Center
 *
 * One screen that ties the whole GTM engine together. It calls the integration
 * backend at /api/* when reachable, and renders from a rich local seed otherwise,
 * so it is fully alive on the static site. Routing is hash-based (#overview,
 * #response, ...) to mirror the reference app.
 *
 * ============================================================================
 *  HOW TO NAVIGATE THIS FILE  (it's big — use search, not scrolling)
 * ============================================================================
 *  Every screen is a `render<Name>(el)` function registered in the ROUTES table
 *  (search:  var ROUTES = ). To jump to a screen, search for `function render…`
 *  using the name below. Map is by NAME (search-stable), not line number.
 *
 *  ── SCREENS (nav group → #hash → function) ─────────────────────────────────
 *  Operate  #overview      renderOverview        (detail: renderOverviewDetail)
 *           #response      renderResponse        (the reply inbox)
 *           #inmarket      renderInMarket        (Hire Signals; also #builder, BD)
 *           #prospects     renderProspects
 *  Build    #campaigns     renderCampaignsHub    (→ renderSeqHome/renderSeqEditor)
 *           #studio        renderStudio
 *           #jdsourcing    renderJdSourcing
 *           #data          renderData            (Candidates; BD: renderCompanies)
 *           #ostext        renderOstext          (→ renderOstextEngine/…Wizard)
 *           #voicedrops    renderVoiceDrops
 *           #vetting       renderVetting
 *           #automation    renderAutomation
 *           #content       renderContent         (Sequences Library)
 *           (outreach)     renderOutreach        (#outreach), renderSending
 *  Measure  #analytics     renderAnalytics       (detail: renderAnalyticsDetail)
 *           #outreach-stats renderOutreachStats  (+ renderSpending)
 *  Connect  #accounts      renderAccounts
 *           #setup         renderSetup           (→ renderBranding/renderDomain/
 *                                                   renderVoiceSetup/…Overview)
 *           #connected     renderConnected
 *           #ats           renderAts
 *  Admin    #team          renderTeam
 *
 *  ── CORE / CHROME / HELPERS ────────────────────────────────────────────────
 *  Routing      render(), currentRoute(), currentDetail(), var ROUTES
 *  Backend      api(path), send(path,method,payload)   ← all /api/* calls
 *  RBAC         can(cap), var CAPS
 *  UI helpers   esc(), toast(), openModal(), head()
 *  Workspace    wsDisplayName(), isLumeWorkspace(), isWhiteLabelWorkspace()
 *  Branding     workspaceBrand()  (logo/accent swap; near end of file)
 *
 *  NOTE: this file is the SOURCE OF TRUTH at repo-root assets/js/. After editing,
 *  run `node integration/sync-public.cjs` (or it runs on build) to mirror into
 *  integration/public/. Never edit integration/public/ directly. See docs/STRUCTURE.md.
 * ============================================================================
 */
(function () {
  "use strict";

  /* ---------------- auth gate + admin "view as recruiter" ----------------
     An admin can open a specific recruiter's portal exactly as that recruiter
     sees it, without their password. The Admin Portal hands off via
     /recruiter#imp=<base64({token,ctx})>, where token is a real recruiter
     session minted by the backend (team:manage gated, members-only).

     We keep the handoff in sessionStorage (PER TAB) and send the token as a
     Bearer header on every API call. The admin's own HttpOnly cookie +
     localStorage session in other tabs is never touched, so the admin stays
     signed in as themselves everywhere else while this one tab "is" the recruiter. */
  var IMP_TOKEN = null;
  (function detectImpersonation() {
    var m = (location.hash || "").match(/[#&]imp=([^&]+)/);
    if (m) {
      try {
        var payload = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(m[1])))));
        if (payload && payload.token && payload.ctx) {
          sessionStorage.setItem("ros_imp_token", payload.token);
          sessionStorage.setItem("ros_imp_ctx", JSON.stringify(payload.ctx));
        }
      } catch (e) {}
      try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
    }
    try { IMP_TOKEN = sessionStorage.getItem("ros_imp_token") || null; } catch (e) {}
  })();

  /* ---------------- auth gate ---------------- */
  var ctx = null;
  if (IMP_TOKEN) {
    try { ctx = JSON.parse(sessionStorage.getItem("ros_imp_ctx") || "null"); } catch (e) {}
  } else {
    try { ctx = JSON.parse(localStorage.getItem("ros_ctx") || "null"); } catch (e) {}
  }
  if (!ctx) { location.replace("/login"); return; }
  var API = (window.RECRUITEROS_API_BASE || "") + "/api";
  var motion = localStorage.getItem("ros_motion") || "recruiting";

  // Image fallback cascade for <img onerror>: walk a `data-fb` chain of backup
  // URLs (e.g. logo provider -> favicon), and when none load, remove the <img>
  // so the initials/monogram underneath shows. Global so inline onerror can call it.
  window.__imgCascade = function (img) {
    var fb = img.getAttribute("data-fb");
    if (fb) { img.removeAttribute("data-fb"); img.src = fb; }
    else { img.remove(); }
  };
  // Build a domain-based company logo URL chain. Primary = a real logo service,
  // fallback = Google's favicon, both free + keyless. Returns "" when no domain.
  function hostFrom(s) {
    if (!s) return "";
    var h = String(s).trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0].split("?")[0].trim().toLowerCase();
    return h.indexOf(".") > 0 ? h : "";
  }
  function companyLogo(c) {
    if (c && c.image) return { src: c.image, fb: "" };
    var host = hostFrom((c && (c.domain || c.url)) || "");
    if (!host) return null;
    return { src: "https://logo.clearbit.com/" + host, fb: "https://www.google.com/s2/favicons?domain=" + host + "&sz=128" };
  }
  // Candidate headshot: ONLY a real photo the ATS/provider already gave us. We do
  // NOT look one up from a candidate's email, that would send candidate PII to a
  // third party. No image → the initials monogram shows.
  function personPhoto(r) {
    return (r && r.image) || "";
  }

  /* ---------------- Chrome extension bridge ----------------
     The extension's portal-bridge content script announces itself and accepts a
     one-click "configure" (backend URL + ingest token) via window.postMessage, so
     the user never copies/pastes. Set EXT_STORE_URL once published for "Add to Chrome". */
  var EXT_STORE_URL = ""; // e.g. "https://chrome.google.com/webstore/detail/<id>"
  var extState = { installed: false, version: "" };
  window.addEventListener("message", function (e) {
    if (e.source !== window || !e.data || e.data.source !== "ros-ext") return;
    if (e.data.type === "present") {
      extState.installed = true; extState.version = e.data.version || "";
      document.dispatchEvent(new CustomEvent("ros-ext-present", { detail: extState }));
    } else if (e.data.type === "configured") {
      document.dispatchEvent(new CustomEvent("ros-ext-configured", { detail: e.data }));
    }
  });
  function extPing() { try { window.postMessage({ source: "ros-portal", type: "ping" }, window.location.origin); } catch (e) {} }
  function extConfigure(backendBaseUrl, token) { try { window.postMessage({ source: "ros-portal", type: "configure", backendBaseUrl: backendBaseUrl, token: token, motion: motion }, window.location.origin); } catch (e) {} }

  // RBAC: the session carries the capabilities the user's role allows; the UI
  // only shows what they can actually use.
  var CAPS = Array.isArray(ctx.capabilities) ? ctx.capabilities : [];

  /* ---------------- portal mode (Admin vs Recruiter) ----------------
     One engine, two faces. The Admin Portal is the agency "brain" (configure
     APIs/tools, manage the team, control what recruiters can touch). The
     Recruiter Portal is the same app scoped to the recruiter surface.

     How we pick the portal:
       1. URL path wins   -> /recruiter => "recruiter", /admin|/command => "admin"
       2. else role       -> member => "recruiter", owner/admin => "admin"
     Persisted to ros_portal so refreshes are stable.

     A real recruiter (role "member") can NEVER reach the Admin Portal; if they
     land on /admin we bounce them to /recruiter. An owner/admin opening
     /recruiter previews the recruiter surface on their own session (no second
     login), that's how both portals are edited side by side. */
  var MEMBER_CAPS = [
    "overview:view", "response:view", "response:act",
    "prospects:view", "prospects:edit", "sourcing:run",
    "campaigns:view", "campaigns:create", "outreach:send",
    "voice:dial", "content:view", "analytics:view"
  ];
  var portal = (function () {
    // Impersonating a recruiter is always the Recruiter Portal, full stop.
    if (IMP_TOKEN) return "recruiter";
    var p = (location.pathname || "").replace(/\/+$/, "").split("/").pop().toLowerCase();
    if (p === "recruiter") return "recruiter";
    if (p === "admin" || p === "command") return "admin";
    var saved = null; try { saved = localStorage.getItem("ros_portal"); } catch (e) {}
    if (saved === "recruiter" || saved === "admin") return saved;
    return ctx.role === "member" ? "recruiter" : "admin";
  })();
  // A member who somehow reaches the Admin Portal is sent to their own portal.
  if (portal === "admin" && ctx.role === "member" && !IMP_TOKEN) { location.replace("/recruiter"); return; }
  // Don't persist the portal while impersonating, ros_portal is shared across
  // tabs and would bleed the recruiter view into the admin's other tabs.
  if (!IMP_TOKEN) { try { localStorage.setItem("ros_portal", portal); } catch (e) {} }
  // In the Recruiter Portal the visible capabilities are floored at the recruiter
  // set, so an owner previewing it sees EXACTLY what a recruiter sees.
  if (portal === "recruiter") CAPS = CAPS.filter(function (c) { return MEMBER_CAPS.indexOf(c) >= 0; });

  function can(cap) { return CAPS.indexOf(cap) >= 0; }

  /* ---------------- tiny dom helpers ---------------- */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var view = $("#view");

  // Auto-refresh registry: views that poll for live data push their interval id
  // here; render() clears them all when you navigate away, so nothing keeps
  // fetching in the background.
  var viewTimers = [];
  function clearViewTimers() { viewTimers.forEach(function (t) { clearInterval(t); }); viewTimers = []; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function toast(t) { var el = $("#toast"); el.textContent = t; el.classList.add("show"); setTimeout(function () { el.classList.remove("show"); }, 2200); }

  /* Reusable modal: openModal(title, sub, bodyHtml, onMount) -> returns close fn.
     bodyHtml should include its own .modal-foot with buttons; onMount(root, close)
     wires them. */
  function openModal(title, sub, bodyHtml, onMount) {
    var bg = document.createElement("div");
    bg.className = "modal-bg";
    bg.innerHTML = '<div class="modal-card"><button class="modal-x" aria-label="Close">×</button>' +
      "<h3>" + esc(title) + "</h3>" + (sub ? '<div class="sub">' + esc(sub) + "</div>" : "") +
      '<div class="modal-body"></div></div>';
    document.body.appendChild(bg);
    var card = bg.querySelector(".modal-card");
    bg.querySelector(".modal-body").innerHTML = bodyHtml;
    function close() { if (bg.parentNode) bg.parentNode.removeChild(bg); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") close(); }
    bg.querySelector(".modal-x").addEventListener("click", close);
    bg.addEventListener("click", function (e) { if (e.target === bg) close(); });
    document.addEventListener("keydown", onKey);
    if (onMount) onMount(card, close);
    return close;
  }
  function delay(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  // GET helper: resolves to parsed JSON, or null on any error (caller renders an
  // empty/needs-setup state). The session cookie authenticates every call.
  // A 401 is retried once after a short delay before signing out: just after a
  // redeploy the backend may still be hydrating its session store from the DB,
  // and we must not nuke a valid local session during that boot window.
  // When impersonating a recruiter, every call carries that recruiter's session
  // as a Bearer token, which the backend honors over the (admin's) cookie.
  function authHeaders(base) {
    var h = base || {};
    if (IMP_TOKEN) h["Authorization"] = "Bearer " + IMP_TOKEN;
    return h;
  }
  function api(path, _retried) {
    return fetch(API + path, { credentials: "include", headers: authHeaders() }).then(function (r) {
      if (r.status === 401) {
        if (!_retried) return delay(1200).then(function () { return api(path, true); });
        signOut(); throw 0;
      }
      if (!r.ok) throw 0;
      return r.json();
    });
  }
  // Mutating call (POST/PUT/DELETE) -> { ok, status, data }. Same 401-retry guard.
  function send(path, method, payload, _retried) {
    return fetch(API + path, {
      method: method, credentials: "include",
      headers: authHeaders(payload ? { "Content-Type": "application/json" } : {}),
      body: payload ? JSON.stringify(payload) : undefined
    }).then(function (r) {
      if (r.status === 401) {
        if (!_retried) return delay(1200).then(function () { return send(path, method, payload, true); });
        signOut(); throw 0;
      }
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
    });
  }

  /* ---------------- reference content (product knowledge, not customer data) -- */
  var REF = ref();

  /* ---------------- chrome ---------------- */
  // The workspace card normally shows the workspace/company name. On Lume (our own
  // tenant) show the signed-in person's name instead, so the card reads like a
  // personal account and doesn't surface the company / white-label structure.
  // Declared before the workspace-label chrome below reads them (else hoisted-undefined -> .indexOf crash blanks the app).
  var WHITE_LABEL_DOMAINS = ["lumesp.com"];
  var OPERATOR_EMAILS = ["neadusall@gmail.com", "ryan@recruiters.co"];
  var wsNameEl = $("#wsName");
  if (wsNameEl) wsNameEl.textContent =
    (isLumeWorkspace() && ctx.user && ctx.user.name) ? ctx.user.name
      : wsDisplayName();
  var envPill = $("#envPill");
  if (envPill) envPill.style.display = "none"; // no demo/live badge: this is the product
  function signOut() {
    // While impersonating, "sign out" must NOT touch the admin's real session
    // (shared cookie/localStorage), just drop the per-tab impersonation.
    if (IMP_TOKEN) { exitImpersonation(); return; }
    fetch(API + "/auth/session", { method: "DELETE", credentials: "include" }).catch(function () {});
    localStorage.removeItem("ros_ctx"); localStorage.removeItem("ros_session");
    location.href = "/login";
  }
  // Leave a recruiter view-as session and return to the Admin Portal in this tab.
  function exitImpersonation() {
    try { sessionStorage.removeItem("ros_imp_token"); sessionStorage.removeItem("ros_imp_ctx"); } catch (e) {}
    IMP_TOKEN = null;
    location.replace("/admin");
  }

  // motion toggle
  Array.prototype.forEach.call(document.querySelectorAll(".mt"), function (b) {
    b.classList.toggle("active", b.dataset.motion === motion);
    b.addEventListener("click", function () {
      motion = b.dataset.motion; localStorage.setItem("ros_motion", motion);
      // Remember the active motion server-side so LinkedIn scrapes from the
      // Chrome extension land in this bucket (not a fixed one).
      send("/ext-token", "POST", { action: "set-motion", motion: motion }).catch(function () {});
      Array.prototype.forEach.call(document.querySelectorAll(".mt"), function (x) { x.classList.toggle("active", x === b); });
      // If the current view belongs only to the other motion (e.g. Hire Signals is
      // BD-only), leave it for Overview instead of bouncing the motion back.
      var cur = (location.hash || "#overview").replace(/^#/, "").split("/").pop();
      if (ROUTES[cur] && ROUTES[cur].motionOnly && ROUTES[cur].motionOnly !== motion && cur !== "overview") {
        location.hash = "overview";
      }
      syncMotionNav();
      render();
    });
  });

  // Response badge: live count of hot, unreviewed replies from the API.
  function refreshBadge() {
    api("/response/list").then(function (d) {
      var items = (d && d.items) || [];
      var hot = items.filter(function (p) {
        var c = p.classification && p.classification.class;
        return c === "positive" || c === "referral";
      }).length;
      var bd = $("#badgeResponse");
      if (!bd) return;
      bd.textContent = hot; bd.classList.toggle("show", hot > 0);
    }).catch(function () {});
  }
  refreshBadge();

  // RBAC: hide nav items + group labels the current role can't use.
  Array.prototype.forEach.call(document.querySelectorAll("[data-cap]"), function (el) {
    if (!can(el.getAttribute("data-cap"))) el.style.display = "none";
  });
  // Show the role on the workspace card. In the Recruiter Portal the role label
  // reads "recruiter" regardless of the viewer's real role (an owner previewing
  // should see the recruiter's-eye view, not "owner").
  if (ctx.role) {
    var wp = $("#wsPlan");
    var shownRole = portal === "recruiter" ? "recruiter" : ctx.role;
    if (wp) wp.textContent = (ctx.workspace && ctx.workspace.plan ? ctx.workspace.plan + " · " : "") + shownRole;
  }

  // Portal identity: each portal says plainly what it is.
  (function () {
    var badge = $("#portalBadge");
    var label = portal === "recruiter" ? "🧑‍💼 Recruiter Portal" : "🛡️ Admin Portal";
    if (badge) { badge.textContent = label; badge.setAttribute("data-portal", portal); }
    // On a white-label custom domain, never suffix the house product name; the
    // workspace/preset brand name (applied below) takes over the tab title.
    var houseHost = /(^|\.)recruitersos\.co$|localhost|127\.0\.0\.1|^$/.test(location.host || "");
    var portalName = portal === "recruiter" ? "Recruiter Portal" : "Admin Portal";
    document.title = portalName + (houseHost ? ", RecruitersOS" : "");
  })();

  // House vs white-label identity. The house product name (RecruitersOS /
  // RecruitersOS) may ONLY surface in a genuine house/operator context. A
  // white-label CUSTOMER workspace (e.g. Lume) must never see it anywhere, even
  // when it's accessed on the house host (recruitersos.co/admin), so the test is
  // workspace-aware, not just host-aware. Every house-brand string resolves to
  // neutral, brand-agnostic wording for white-label.
  var WHITE_LABEL_DOMAINS = ["lumesp.com"]; // extend per resold customer
  // Platform operator accounts. These run the product itself, so they are never
  // subject to the built-in 14-day trial gate (no banner, no paywall). This is
  // intentionally separate from WHITE_LABEL_DOMAINS so the operator still sees
  // full house branding — it only waives billing. Match is by exact email.
  var OPERATOR_EMAILS = ["neadusall@gmail.com", "ryan@recruiters.co"];
  function isWhiteLabelWorkspace() {
    var ws = ctx.workspace || {};
    var wsDom = ((ws.domain) || "").toLowerCase();
    var userDom = (((ctx.user && ctx.user.email) || "").split("@")[1] || "").toLowerCase();
    // A workspace that has set its own brand name is, by definition, white-labelled.
    var ownBrand = !!(ws.brandName && String(ws.brandName).trim());
    return ownBrand || WHITE_LABEL_DOMAINS.indexOf(wsDom) >= 0 || WHITE_LABEL_DOMAINS.indexOf(userDom) >= 0;
  }
  // Lume is OUR OWN white-label tenant. We manage its custom domain on the backend
  // and deliberately keep the white-label scaffolding invisible to the Lume team:
  // hide the self-service Custom domain tab, and show the signed-in PERSON (not the
  // company name) on the workspace card, so nothing reads as a resold/white-label
  // site. Every OTHER white-label workspace keeps the normal behaviour. Detection
  // is synchronous (ctx-based) so chrome can branch without an async branding fetch.
  function isLumeWorkspace() {
    var ws = ctx.workspace || {};
    var wsDom = ((ws.domain) || "").toLowerCase();
    var userDom = (((ctx.user && ctx.user.email) || "").split("@")[1] || "").toLowerCase();
    var cust = ((ws.customDomain) || "").toLowerCase();
    return wsDom === "lumesp.com" || userDom === "lumesp.com" ||
           cust === "app.lumesp.com" || cust.indexOf(".lumesp.com") >= 0;
  }
  // The label shown for this workspace in the chrome (breadcrumb + workspace card).
  // A PERSONAL workspace (a free-email signup, so no company domain) is named after
  // the person who created it, by FIRST name, so it reads "Ryan's Workspace" rather
  // than an email/username-derived string. Corporate (company-domain) and white-label
  // workspaces keep their stored company/brand name.
  function firstNameOf(s) { return String(s || "").trim().split(/\s+/)[0] || ""; }
  function wsDisplayName() {
    var ws = ctx.workspace || {};
    var personal = !(ws.domain && String(ws.domain).trim());
    if (personal && !isWhiteLabelWorkspace() && ctx.user && ctx.user.name) {
      var fn = firstNameOf(ctx.user.name);
      if (fn) return fn + "'s Workspace";
    }
    return ws.name || "Workspace";
  }
  var ON_HOUSE_HOST = /(^|\.)recruitersos\.co$|localhost|127\.0\.0\.1|^$/.test(location.host || "");
  var IS_HOUSE = ON_HOUSE_HOST && !isWhiteLabelWorkspace();
  var HOUSE_BRAND = "RecruitersOS";
  var PLATFORM_LABEL = IS_HOUSE ? "RecruitersOS" : "the platform"; // "via X · billed"
  var PLATFORM_HOST = IS_HOUSE ? "RecruitersOS host" : "the shared platform host";

  // View-as banner: a persistent strip making it unmistakable that an admin is
  // inside a specific recruiter's portal, with one click back to Admin.
  if (IMP_TOKEN) {
    var bn = document.createElement("div");
    bn.className = "imp-banner";
    bn.innerHTML = '<span>👁️ Admin view-as, you are inside <b>' +
      esc((ctx.user && (ctx.user.name || ctx.user.email)) || "a recruiter") +
      "</b>'s Recruiter Portal</span><button type=\"button\" id=\"impExit\">Exit to Admin Portal</button>";
    document.body.appendChild(bn);
    document.body.classList.add("has-imp-banner");
    var ieBtn = bn.querySelector("#impExit");
    if (ieBtn) ieBtn.addEventListener("click", exitImpersonation);
  }

  /* ---------------- 14-day trial / paywall ----------------
     Admin sign-up is free for 14 days, no card required until it ends. After
     that the workspace must subscribe to keep the Admin Portal. Legacy
     workspaces (no trialEndsAt) and paid workspaces are never gated, so no
     existing account is ever locked out by this. Recruiters never see it. */
  if (portal === "admin" && !IMP_TOKEN) (function trialGate() {
    var ws = ctx.workspace || {};
    // White-label customer workspaces are billed by the operator (via the resale
    // model), NOT by the platform's built-in 14-day trial, so they never see the
    // "Add payment" banner or the trial paywall. Billing exemption keys off the
    // resold-domain list only (see module-level WHITE_LABEL_DOMAINS, extend there).
    var userEmail = ((ctx.user && ctx.user.email) || "").toLowerCase();
    if (!userEmail) return; // no identified user yet (session still loading): never show a billing gate
    if (OPERATOR_EMAILS.indexOf(userEmail) >= 0) return; // platform operator, never gated
    // White-label / Lume customers are billed by the operator (resale model), NOT by
    // the platform's trial, so they never see the banner or paywall. Use the same
    // robust detection the rest of the chrome uses — it also covers Lume's custom
    // domain (app.lumesp.com) and any own-branded workspace, which the old inline
    // ws.domain-only check missed, so those accounts still saw the "14 days left" bar.
    if (isWhiteLabelWorkspace() || isLumeWorkspace()) return;
    var tr;
    if (ws.paid) tr = { onTrial: false, expired: false, daysLeft: 0 };
    else if (!ws.trialEndsAt) tr = { onTrial: false, expired: false, daysLeft: 0 };
    else {
      var ms = Date.parse(ws.trialEndsAt) - Date.now();
      tr = { onTrial: ms > 0, expired: ms <= 0, daysLeft: Math.max(0, Math.ceil(ms / 86400000)) };
    }
    if (!can("billing:manage")) return; // only the owner manages billing

    function subscribe(btn) {
      if (btn) btn.disabled = true;
      send("/billing", "POST", { action: "subscribe" }).then(function (r) {
        if (r.ok) {
          try { ctx.workspace.paid = true; localStorage.setItem("ros_ctx", JSON.stringify(ctx)); } catch (e) {}
          location.reload();
        } else { if (btn) btn.disabled = false; toast("Could not start subscription (" + ((r.data && r.data.error) || r.status) + ")"); }
      }).catch(function () { if (btn) btn.disabled = false; toast("Could not reach the server."); });
    }

    if (tr.expired) {
      var ov = document.createElement("div");
      ov.className = "paywall";
      ov.innerHTML =
        '<div class="paywall-card"><div class="paywall-badge">Free trial ended</div>' +
        "<h2>Your 14-day trial is over</h2>" +
        "<p>Subscribe to keep your Admin Portal, your team and everything you've set up. Nothing is deleted, you'll pick up right where you left off.</p>" +
        '<button class="btn btn-primary btn-lg btn-block" id="pwSub">Subscribe & keep working →</button>' +
        '<button class="btn btn-ghost btn-block" id="pwOut" style="margin-top:8px">Sign out</button></div>';
      document.body.appendChild(ov);
      ov.querySelector("#pwSub").addEventListener("click", function () { subscribe(this); });
      ov.querySelector("#pwOut").addEventListener("click", signOut);
    } else if (tr.onTrial) {
      var tb = document.createElement("div");
      tb.className = "trial-banner";
      tb.innerHTML = '<span>✨ <b>' + tr.daysLeft + " day" + (tr.daysLeft === 1 ? "" : "s") +
        "</b> left in your free trial, no card needed until it ends.</span>" +
        '<button type="button" id="trUpgrade">Add payment</button>';
      var mainEl = document.querySelector(".main");
      if (mainEl) mainEl.insertBefore(tb, mainEl.firstChild);
      var up = tb.querySelector("#trUpgrade");
      if (up) up.addEventListener("click", function () { subscribe(this); });
    }
  })();

  // Initial motion-specific nav visibility (In-Market Leads is BD-only).
  syncMotionNav();

  /* ---------------- router ---------------- */
  var ROUTES = {
    overview: { title: "Dashboard", crumb: "Operate", action: null, render: renderOverview },
    response: { title: "Response", crumb: "Operate", action: null, render: renderResponse },
    inmarket: { title: "Hire Signals", crumb: "Operate", action: null, render: renderInMarket, motionOnly: "bd" },
    prospects: { title: "Prospects", crumb: "Operate", action: "＋ Add prospect", render: renderProspects },
    autopilot: { title: "Autopilot", crumb: "Build", action: null, render: renderAutopilot },
    campaigns: { title: "Campaigns", crumb: "Build", action: "＋ New sequence", render: renderCampaignsHub },
    studio: { title: "Campaign Studio", crumb: "Build", action: null, render: renderStudio },
    jdsourcing: { title: "JD Sourcing", crumb: "Build", action: null, render: renderJdSourcing, motionOnly: "recruiting" },
    data: { title: "Candidates", crumb: "Build", action: null, render: renderData },
    ostext: { title: "OS Text", crumb: "Build", action: null, render: renderOstext },
    voicedrops: { title: "Voice Drops", crumb: "Build", action: null, render: renderVoiceDrops },
    bdbulk: { title: "BD Bulk", crumb: "Build", action: null, render: renderBdBulk, motionOnly: "bd" },
    vetting: { title: "AI Vetting", crumb: "Build", action: null, render: renderVetting, motionOnly: "recruiting" },
    builder: { title: "In-Market Leads", crumb: "Build", action: null, render: renderInMarket, motionOnly: "bd" },
    automation: { title: "LinkedIn Automation", crumb: "Build", action: null, render: renderAutomation },
    content: { title: "Campaign Sequences Library", crumb: "Build", action: "＋ New sequence", render: renderContent },
    analytics: { title: "Analytics", crumb: "Measure", action: null, render: renderAnalytics },
    "outreach-stats": { title: "Outreach Statistics", crumb: "Measure", action: null, render: renderOutreachStats, cap: "team:manage" },
    nurture: { title: "Nurture", crumb: "Measure", action: null, render: renderNurture, cap: "team:manage", motionOnly: "bd" },
    accounts: { title: "Accounts", crumb: "Connect", action: null, render: renderAccounts, cap: "accounts:manage" },
    // Admin launch-setup hub. Consolidates Integrations and ATS behind one tab
    // with an ordered readiness checklist. The two sub-routes below stay
    // registered so deep links (#connected, #ats) and in-app cross-links keep
    // resolving; they just have no standalone nav item.
    setup: { title: "Setup", crumb: "Connect", action: null, render: renderSetup, cap: "integrations:manage" },
    connected: { title: "Connected", crumb: "Connect", action: "Test all", render: renderConnected, cap: "integrations:manage" },
    ats: { title: "ATS", crumb: "Connect", action: null, render: renderAts, cap: "ats:manage" },
    team: { title: "Team", crumb: "Admin", action: "＋ Invite recruiter", render: renderTeam, cap: "team:manage" },
    // Playbooks: a visual, wireframe-driven "how it works" gallery (Flip the
    // Script, JD Sourcing, AI Vetting, Voice Drops, Campaign Models). Motion-
    // agnostic, no capability gate, so anyone in either portal can see the
    // vision. Deep links like #playbooks/jd-sourcing open a single walkthrough.
    playbooks: { title: "Playbooks", crumb: "Learn", action: null, render: renderPlaybooks }
  };

  function currentRoute() {
    var h = (location.hash || "#overview").replace(/^#/, "");
    // support reference-style "#bd/response" -> set motion + route
    var parts = h.split("/");
    if (parts[0] === "bd" || parts[0] === "recruiting") { motion = parts[0]; localStorage.setItem("ros_motion", motion); h = parts[1] || "overview"; }
    else h = parts[0];
    // Aliases. #builder stays the BD-branded entry (it forces BD via its own
    // route); Hire Signals (#inmarket) is motion-agnostic and shows in both.
    var ALIAS = { "in-market": "inmarket", leads: "inmarket" };
    if (ALIAS[h]) h = ALIAS[h];
    if (!ROUTES[h]) return "overview";
    // A motion-only route (e.g. the BD-only #builder) switches the workspace to
    // its motion rather than bouncing the user to Overview.
    if (ROUTES[h].motionOnly && ROUTES[h].motionOnly !== motion) {
      motion = ROUTES[h].motionOnly; localStorage.setItem("ros_motion", motion); syncMotionNav();
    }
    if (ROUTES[h].cap && !can(ROUTES[h].cap)) return "overview"; // recruiter hit a gated route
    return h;
  }

  // The segment after the route in the hash drives in-route drill-downs, e.g.
  // "#overview/linkedin-accounts" (or "#bd/overview/linkedin-accounts") -> the
  // route stays "overview" and the detail is "linkedin-accounts".
  function currentDetail() {
    var h = (location.hash || "").replace(/^#/, "");
    var parts = h.split("/");
    if (parts[0] === "bd" || parts[0] === "recruiting") parts.shift();
    return parts[1] || "";
  }

  // Recruiting calls them Candidates; BD calls them Prospects.
  function prospectsLabel() { return motion === "recruiting" ? "Candidates" : "Prospects"; }
  function prospectNoun() { return motion === "recruiting" ? "candidate" : "prospect"; }
  // The "data" route is the people warehouse (Candidates) in recruiting, and the
  // book-of-business company list (Companies) in BD.
  function dataLabel() { return motion === "recruiting" ? "Candidates" : "Companies"; }

  // Show/hide motion-specific nav items (Hire Signals is BD-only) and relabel the
  // Prospects/Candidates nav item for the active motion.
  function syncMotionNav() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-motion-only]"), function (el) {
      el.style.display = (el.getAttribute("data-motion-only") === motion) ? "" : "none";
    });
    relabelNav('prospects', prospectsLabel());
    // 'data' route has two fixed nav items (Candidates in recruiting, Companies in
    // BD), shown by data-motion-only, no dynamic relabel needed.
  }
  // Swap a nav item's text label while preserving its leading icon span.
  function relabelNav(route, label) {
    var n = document.querySelector('.nav-item[data-route="' + route + '"]');
    if (!n) return;
    var ni = n.querySelector(".ni");
    n.textContent = "";
    if (ni) n.appendChild(ni);
    n.appendChild(document.createTextNode(" " + label));
  }

  function render() {
    var key = currentRoute();
    if (key !== "campaigns") cmpEdit = null; // leave the sequence editor when navigating away
    var r = ROUTES[key];
    syncMotionNav(); // keep motion-only visibility + Prospects/Candidates label current
    $("#pageTitle").textContent = (key === "prospects") ? prospectsLabel() : (key === "data") ? dataLabel() : r.title;
    $("#crumb").textContent = (ctx.workspace ? wsDisplayName() + " / " : "") + r.crumb;
    Array.prototype.forEach.call(document.querySelectorAll(".nav-item"), function (n) { n.classList.toggle("active", n.dataset.route === key); });
    var pa = $("#primaryAction");
    if (r.action) { pa.style.display = ""; pa.textContent = (key === "prospects") ? ("＋ Add " + prospectNoun()) : r.action; pa.onclick = function () { primaryAction(key); }; }
    else pa.style.display = "none";
    Array.prototype.forEach.call(document.querySelectorAll(".mt"), function (x) { x.classList.toggle("active", x.dataset.motion === motion); });
    clearViewTimers(); // stop any auto-refresh from the view we're leaving
    view.innerHTML = "";
    r.render(view);
  }

  window.addEventListener("hashchange", render);
  Array.prototype.forEach.call(document.querySelectorAll(".nav-item"), function (n) {
    n.setAttribute("href", "#" + n.dataset.route);
  });

  /* ---------------- views ---------------- */

  // The page title already shows in the topbar (#pageTitle), so the in-view header
  // renders only the description, no duplicate title, and sits tight under the header.
  function head(title, sub) {
    return sub ? '<div class="v-head"><p>' + esc(sub) + "</p></div>" : "";
  }

  // Capacity labels -> drill-down detail slug. Used when the backend doesn't
  // stamp a `detail` on the capacity row itself (e.g. the real server).
  var CAP_DETAIL = {
    "Email capacity/day": "email-capacity",
    "LinkedIn capacity/day": "linkedin-capacity"
  };

  // LinkedIn accounts and sending domains are not surfaced in the recruiter
  // portal (either motion), these capacity cards are dropped from the strip.
  var HIDE_CAP = { "LinkedIn accounts": 1, "Sending domains": 1 };

  var ovRecruiter = null; // admin per-recruiter Dashboard scope (userId, or null = whole workspace)

  function renderOverview(el) {
    var detail = currentDetail();
    if (detail) return renderOverviewDetail(el, detail);

    // The Dashboard is motion-scoped: BD shows the business-development pipeline,
    // Recruiting shows the recruiting pipeline. In either motion an admin sees the
    // "All recruiters" roster (every recruiter's stats individually) and can drill
    // into any single recruiter's numbers via the selector bar.
    var showRecruiterBar = can("team:manage") && !IMP_TOKEN;
    var sub = (motion === "bd"
      ? "Your BD sending engine, capacity, throughput and what's running right now. Pipeline outcomes live in Analytics."
      : "Your recruiting sending engine, capacity, throughput and what's running right now.")
      + (showRecruiterBar ? " Pick a recruiter to scope it, or see every recruiter's stats below." : "");
    el.innerHTML = head("Dashboard", sub) +
      (showRecruiterBar ? '<div class="ov-recruiters" id="ovRecruiters">' + loading() + "</div>" : "") +
      '<div id="ovBody">' + loading() + "</div>";

    if (showRecruiterBar) {
      api("/team").then(function (d) {
        var recs = ((d && d.members) || []).filter(function (m) { return m.role === "member"; });
        var bar = $("#ovRecruiters"); if (!bar) return;
        function chip(id, label) {
          return '<button type="button" class="ov-chip' + (ovRecruiter === id ? " active" : "") +
            '" data-rec="' + (id == null ? "" : esc(id)) + '">' + esc(label) + "</button>";
        }
        bar.innerHTML = chip(null, "All recruiters") + recs.map(function (m) { return chip(m.userId, m.name); }).join("");
        Array.prototype.forEach.call(bar.querySelectorAll(".ov-chip"), function (b) {
          b.addEventListener("click", function () { ovRecruiter = b.getAttribute("data-rec") || null; renderOverview($("#view")); });
        });
      }).catch(function () { var bar = $("#ovRecruiters"); if (bar) bar.innerHTML = ""; });
    }

    var ovQuery = "/overview?motion=" + encodeURIComponent(motion) + (ovRecruiter ? "&recruiter=" + encodeURIComponent(ovRecruiter) : "");
    api(ovQuery).then(function (o) {
      o = o || {};
      // Each capacity card drills into the per-item breakdown for that resource
      // (individual accounts / domains / mailboxes / team capacity).
      var cap = (o.capacity || []).filter(function (c) { return !HIDE_CAP[c.label]; });
      var stats = cap.map(function (c) {
        var slug = c.detail || CAP_DETAIL[c.label];
        var go = slug ? ' data-go="overview/' + slug + '"' : "";
        return '<div class="stat' + (go ? " clickable" : "") + '"' + go + '><span class="rag ' + (c.status || "red") + '"></span><div class="sv">' + (c.value != null ? c.value : 0) + '</div><div class="sl">' + esc(c.label) + "</div></div>";
      }).join("") || emptyCard("Connect your sending accounts to see capacity.");
      // Engine throughput today, pure sending activity + capacity utilisation.
      // No replies, meetings, conversions or per-recruiter results: every outcome
      // lives in Analytics, so the Dashboard and Analytics never track the same
      // subject. Dashboard = the sending engine; Analytics = what it produced.
      var lc = o.linkedinCapacity || {};
      var pace = [
        ["Emails sent today", o.sendsToday || 0],
        ["Connection requests", (lc.connectsUsed || 0) + " / " + (lc.connectTotal || 0)],
        ["Profile views", (lc.viewsUsed || 0) + " / " + (lc.viewTotal || 0)],
        ["Active campaigns", (o.activeDrips || []).length]
      ].map(function (k) {
        return '<div class="stat"><div class="sv">' + k[1] + '</div><div class="sl">' + k[0] + "</div></div>";
      }).join("");

      // Active campaigns running right now, with the recruiter who owns each.
      var campGo = (!ROUTES.campaigns.cap || can(ROUTES.campaigns.cap)) ? ' data-go="campaigns" class="list-row clickable"' : ' class="list-row"';
      var drips = (o.activeDrips || []).map(function (d) {
        var who = d.recruiter ? '<div class="lr-sub">' + esc(d.recruiter) + "</div>" : "";
        return "<div" + campGo + '><div><div class="lr-main">' + esc(d.name) + "</div>" + who + '</div><div class="lr-right">' + esc(d.stage) + "</div></div>";
      }).join("") || '<div class="empty">No active campaigns yet. Launch one to start.</div>';

      // Capacity & health alerts, sending infrastructure that needs attention.
      // LinkedIn accounts and sending domains are not surfaced in this portal.
      var alerts = [];
      (o.mailboxes || []).forEach(function (m) { if (m.health && m.health !== "green") alerts.push({ rag: m.health, main: m.address, sub: "Mailbox · warmup " + m.warmup + "%", go: "overview/email-capacity" }); });
      var alertHtml = alerts.length ? alerts.map(function (al) {
        return '<div class="list-row clickable" data-go="' + al.go + '"><span class="rag ' + al.rag + '" style="width:9px;height:9px;border-radius:50%;display:inline-block;flex:none"></span><div><div class="lr-main">' + esc(al.main) + '</div><div class="lr-sub">' + esc(al.sub) + "</div></div></div>";
      }).join("") : '<div class="empty">All sending infrastructure healthy.</div>';

      // "All recruiters" view (admin, no single recruiter selected): show every
      // recruiter's high-level stats individually for the active motion.
      var roster = (ovRecruiter == null && showRecruiterBar && (o.recruiters || []).length)
        ? recruiterRosterHtml(o) : "";

      var body = $("#ovBody"); if (!body) return;
      body.innerHTML =
        '<div class="stat-grid" style="margin-bottom:14px">' + stats + "</div>" +
        '<div class="stat-grid" style="margin-bottom:18px">' + pace + "</div>" +
        roster +
        '<div class="two-col"><div class="card"><h3>Active campaigns</h3>' + drips + "</div>" +
        '<div class="card"><h3>Capacity &amp; health alerts</h3>' + alertHtml + "</div></div>";

      // Delegated navigation: a recruiter row scopes the dashboard to that
      // recruiter; anything with data-go jumps to that tab/drill-down.
      body.addEventListener("click", function (e) {
        var r = e.target.closest("[data-rec]");
        if (r) { ovRecruiter = r.getAttribute("data-rec") || null; renderOverview($("#view")); return; }
        var t = e.target.closest("[data-go]"); if (!t) return;
        location.hash = t.getAttribute("data-go");
      });
    }).catch(function () {
      var body = $("#ovBody"); if (body) body.innerHTML = needsSetup();
    });
  }

  // The "All recruiters" roster: one row per recruiter with their high-level
  // stats for the active motion (so an admin can compare BD efforts and recruiting
  // efforts per person). Driven by o.recruiters from /overview, which the backend
  // keys to the real team members and scopes by motion. Clicking a row scopes the
  // whole dashboard to that recruiter.
  function recruiterRosterHtml(o) {
    var recs = o.recruiters || [];
    var winLabel = motion === "bd" ? "Job orders" : "Placements";
    var hd = '<div class="card" style="margin:0 0 18px"><div class="lr-sub" style="margin-bottom:8px">' +
      esc(motion === "bd" ? "Business Development" : "Recruiting") +
      ', every recruiter’s stats. Click a recruiter to scope the dashboard to them.</div>';
    if (!recs.length) return hd + '<div class="empty">No recruiters on this workspace yet. Invite recruiters under Team.</div></div>';
    var rows = recs.map(function (r) {
      return '<tr class="clickable" data-rec="' + esc(r.userId || "") + '">' +
        '<td><b>' + esc(r.name) + "</b></td>" +
        "<td>" + (r.activeCampaigns || 0) + "</td>" +
        "<td>" + (r.sentToday || 0) + "</td>" +
        "<td>" + (r.connects || 0) + "</td>" +
        "<td>" + (r.replies || 0) + "</td>" +
        "<td>" + (r.meetings || 0) + "</td>" +
        "<td><b>" + (r.wins || 0) + "</b></td></tr>";
    }).join("");
    return hd + '<div style="overflow:auto"><table class="matrix"><thead><tr>' +
      "<th>Recruiter</th><th>Active campaigns</th><th>Sent today</th><th>Connects</th><th>Replies</th><th>Meetings</th><th>" + esc(winLabel) + "</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table></div></div>";
  }

  // ---- Dashboard drill-downs (full sub-views under #overview/<slug>) ----
  var OV_DETAILS = {
    "email-capacity": { title: "Email capacity", sub: "Daily send capacity per mailbox and the health of each inbox." },
    "linkedin-capacity": { title: "LinkedIn capacity", sub: "Team-wide connection requests and profile views used today." }
  };

  function renderOverviewDetail(el, detail) {
    var meta = OV_DETAILS[detail];
    if (!meta) { location.hash = "overview"; return; }
    el.innerHTML =
      '<div class="v-head" style="display:flex;align-items:baseline;gap:12px">' +
        '<a class="back-link clickable" data-go="overview"><span class="arr">←</span> Back to Dashboard</a>' +
        '<p style="margin:0">' + esc(meta.sub) + "</p></div>" +
      '<h2 style="margin:6px 0 14px">' + esc(meta.title) + "</h2>" +
      '<div id="ovDetailBody">' + loading() + "</div>";

    // Back link + any in-detail navigation.
    el.addEventListener("click", function (e) {
      var t = e.target.closest("[data-go]"); if (!t) return;
      location.hash = t.getAttribute("data-go");
    });

    api("/overview").then(function (o) {
      o = o || {};
      var host = $("#ovDetailBody"); if (!host) return;
      host.innerHTML = ovDetailHtml(detail, o);
    }).catch(function () {
      var host = $("#ovDetailBody"); if (host) host.innerHTML = needsSetup();
    });
  }

  // Reusable health pill + percent-bar helpers for the drill-downs.
  function healthPill(h) { return '<span class="rag ' + (h || "red") + '"></span>'; }
  function capBar(used, total) {
    var pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
    var rag = pct >= 90 ? "red" : pct >= 70 ? "yellow" : "green";
    return '<div class="cap-bar"><div class="cap-fill ' + rag + '" style="width:' + pct + '%"></div></div>';
  }

  function ovDetailHtml(detail, o) {
    if (detail === "email-capacity") {
      var boxes = o.mailboxes || [];
      if (!boxes.length) return emptyCard("No mailboxes connected yet. Add mailboxes under Accounts.");
      var totalCap = boxes.reduce(function (s, b) { return s + (b.dailyCap || 0); }, 0);
      var totalSent = boxes.reduce(function (s, b) { return s + (b.sentToday || 0); }, 0);
      var summary = '<div class="stat-grid" style="margin-bottom:14px">' +
        '<div class="stat"><div class="sv">' + boxes.length + '</div><div class="sl">Mailboxes</div></div>' +
        '<div class="stat"><div class="sv">' + totalCap + '</div><div class="sl">Email capacity/day</div></div>' +
        '<div class="stat"><div class="sv">' + totalSent + '</div><div class="sl">Sent today</div></div></div>';
      return summary + '<div class="card"><div style="overflow:auto"><table class="matrix"><thead><tr>' +
        "<th>Mailbox</th><th>Domain</th><th>Sent today</th><th>Warmup</th><th>Deliverability</th><th>Health</th></tr></thead><tbody>" +
        boxes.map(function (b) {
          return "<tr><td><b>" + esc(b.address) + "</b></td><td>" + esc(b.domain) + "</td>" +
            "<td>" + b.sentToday + " / " + b.dailyCap + capBar(b.sentToday, b.dailyCap) + "</td>" +
            "<td>" + b.warmup + "%</td><td>" + b.deliverability + "%</td><td>" + healthPill(b.health) + "</td></tr>";
        }).join("") + "</tbody></table></div></div>";
    }
    if (detail === "linkedin-capacity") {
      var lc = o.linkedinCapacity || {};
      var by = lc.byAccount || [];
      var summary = '<div class="stat-grid" style="margin-bottom:14px">' +
        '<div class="stat"><div class="sv">' + (lc.connectsUsed || 0) + " / " + (lc.connectTotal || 0) + '</div><div class="sl">Connection requests today</div>' + capBar(lc.connectsUsed || 0, lc.connectTotal || 0) + "</div>" +
        '<div class="stat"><div class="sv">' + (lc.viewsUsed || 0) + " / " + (lc.viewTotal || 0) + '</div><div class="sl">Profile views today</div>' + capBar(lc.viewsUsed || 0, lc.viewTotal || 0) + "</div></div>";
      var table = !by.length ? "" : '<div class="card"><h3>By account</h3><div style="overflow:auto"><table class="matrix"><thead><tr>' +
        "<th>Account</th><th>Connection requests</th><th>Profile views</th></tr></thead><tbody>" +
        by.map(function (a) {
          return "<tr><td><b>" + esc(a.name) + "</b></td>" +
            "<td>" + a.connects + " / " + a.connectCap + capBar(a.connects, a.connectCap) + "</td>" +
            "<td>" + a.views + " / " + a.viewCap + capBar(a.views, a.viewCap) + "</td></tr>";
        }).join("") + "</tbody></table></div></div>";
      return summary + table;
    }
    return emptyCard("Nothing to show here yet.");
  }

  /* ===========================================================================
   * PLAYBOOKS  ·  "How it works", seen.
   * A visual, wireframe-driven walkthrough of the core approaches so a new user
   * (or a prospect being shown the product) instantly catches the mission of
   * each one. Gallery of cards -> click one -> a full animated workflow with a
   * wireframe sketch of the real UI. Lives under #playbooks (+ deep links like
   * #playbooks/jd-sourcing). Static, read-only, no backend calls.
   * ======================================================================== */
  function pbStage(s, i) {
    var when = s.when
      ? '<div class="pb-when">' + esc(s.when) +
        (s.auto ? '<span class="pb-auto ' + (s.auto === "you" ? "you" : "bot") + '">' + (s.auto === "you" ? "You" : "Auto") + "</span>" : "") +
        "</div>"
      : "";
    var hasPeek = !!s.peek;
    var peek = hasPeek ? '<div class="pb-peek"><span class="dot"></span>' + esc(s.peek.cta || "See what's produced") + "</div>" : "";
    var out = s.out ? '<div class="pb-out">' + s.out + "</div>" : "";
    return '<div class="pb-stage' + (hasPeek ? " clk" : "") + '"' + (hasPeek ? ' data-stage="' + i + '"' : "") + ">" +
      '<div><div class="pb-node">' + s.icon + '<span class="num">' + (i + 1) + "</span></div></div>" +
      '<div class="pb-body">' + when + "<h4>" + esc(s.title) + "</h4><p>" + s.body + "</p>" + out + peek + "</div></div>";
  }
  function pbWireChrome(title, body) {
    return '<div class="pb-wire"><div class="pb-wire-chrome"><i></i><i></i><i></i>' +
      '<span class="ttl">' + esc(title) + '</span></div><div class="pb-wire-body">' + body + "</div></div>";
  }
  function pbStripTags(s) { return String(s == null ? "" : s).replace(/<[^>]+>/g, "").trim(); }
  // Channel -> board accent colour.
  var PB_CH_ACC = { email: "v", liconn: "c", lidm: "c", livoice: "p", vm: "a", sms: "g", call: "p" };
  // The Miro-style board: a horizontal canvas of touch cards joined by connectors
  // with a "wait N days" label between them. Cards carry data-idx for the click
  // handler that opens the full message. Scrolls horizontally for long sequences.
  function pbBoard(items, hint) {
    var track = items.map(function (it, i) {
      var cc = it.cond ? " cond" : "";
      var connLabel = it.cond ? '<span class="wait cond">IF ' + esc(it.cond) + "</span>"
        : (it.wait ? '<span class="wait">' + esc(it.wait) + "</span>" : "");
      var conn = i ? '<div class="pb-bconn' + cc + '">' + connLabel + '<span class="dot"></span></div>' : "";
      var iftag = it.cond ? '<span class="pb-iftag">IF</span>' : "";
      return conn +
        '<div class="pb-bcard' + cc + '" data-idx="' + i + '" data-accent="' + (it.accent || "v") + '">' +
          '<div class="pb-bcard-top"><span class="ch">' + iftag + it.icon + " " + esc(it.channel) + '</span><span class="day">' + esc(it.day) + "</span></div>" +
          '<div class="pb-bcard-body"><div class="big">' + it.icon + "</div><h5>" + esc(it.title) + "</h5><p>" + esc(it.teaser) + "</p></div>" +
          '<div class="pb-bcard-foot"><span class="dot"></span>' + esc(it.cta || "Read the message") + "</div></div>";
    }).join("");
    return (hint ? '<p class="pb-board-hint">↔ ' + esc(hint) + "</p>" : "") +
      '<div class="pb-board"><div class="pb-board-track">' + track + "</div></div>";
  }

  /* ---- Artifact builders: the actual "under the hood" content shown in popups ---- */
  function pbNl(s) { return esc(s).replace(/\n/g, "<br>"); }
  function pbArt(tag, pill, body) {
    var p = pill ? '<span class="pb-pill2 ' + pill[0] + '">' + esc(pill[1]) + "</span>" : "";
    return '<div class="pb-art"><div class="pb-art-tag">' + esc(tag) + p + '</div><div class="pb-art-body">' + body + "</div></div>";
  }
  function pbKV(rows) {
    return '<div class="pb-art"><div class="pb-art-body mono">' + rows.map(function (r) {
      return '<div class="pb-kv"><span class="k">' + esc(r[0]) + '</span><span class="v">' + (r[2] ? "<em>" + esc(r[1]) + "</em>" : esc(r[1])) + "</span></div>";
    }).join("") + "</div></div>";
  }
  function pbMail(from, subj, body) {
    return '<div class="pb-mail"><div class="from">' + esc(from) + '</div><div class="subj">' + esc(subj) + '</div><div class="copy">' + pbNl(body) + "</div></div>";
  }
  function pbIM(body) { return '<div class="pb-im"><span class="av"></span><div class="msg">' + pbNl(body) + "</div></div>"; }
  function pbTrans(lines) {
    return '<div class="pb-trans">' + lines.map(function (l) {
      return '<div class="ln ' + l[0] + '"><span class="who">' + esc(l[1]) + '</span><span class="said">' + esc(l[2]) + "</span></div>";
    }).join("") + "</div>";
  }

  /* ---- The popup itself ---- */
  function pbCloseModal() {
    var m = document.getElementById("pbModal");
    if (m) m.remove();
    document.removeEventListener("keydown", pbEsc);
  }
  function pbEsc(e) { if (e.key === "Escape") pbCloseModal(); }
  function pbOpenModal(icon, title, sub, bodyHtml) {
    pbCloseModal();
    var back = document.createElement("div");
    back.className = "pb-modal-back";
    back.id = "pbModal";
    back.innerHTML =
      '<div class="pb-modal"><div class="pb-modal-head"><span class="ic">' + icon + "</span>" +
        "<div><h4>" + esc(title) + '</h4><div class="sub">' + esc(sub) + "</div></div>" +
        '<span class="x" data-x>✕</span></div>' +
      '<div class="pb-modal-body pb-stagger">' + bodyHtml + "</div></div>";
    back.addEventListener("click", function (e) {
      if (e.target === back || e.target.closest("[data-x]")) { pbCloseModal(); return; }
      // A/B/C variant tab switching inside the popup.
      var vt = e.target.closest("[data-vtab]");
      if (vt) {
        var idx = vt.getAttribute("data-vtab");
        var modal = vt.closest(".pb-modal");
        Array.prototype.forEach.call(modal.querySelectorAll("[data-vtab]"), function (b) { b.classList.toggle("active", b === vt); });
        Array.prototype.forEach.call(modal.querySelectorAll("[data-vpane]"), function (p) { p.classList.toggle("active", p.getAttribute("data-vpane") === idx); });
      }
    });
    document.body.appendChild(back);
    document.addEventListener("keydown", pbEsc);
  }

  /* ---- Channels + the Sequence Library data (real outbound workflows) ---- */
  var PB_CH = {
    email:   { icon: "✉️", label: "Email" },
    liconn:  { icon: "➕", label: "LinkedIn connect" },
    lidm:    { icon: "💬", label: "LinkedIn message" },
    livoice: { icon: "🎙️", label: "LinkedIn voice note" },
    vm:      { icon: "📞", label: "Voicemail drop" },
    sms:     { icon: "📱", label: "SMS" },
    call:    { icon: "☎️", label: "Call task" }
  };
  // Body convention for email touches: subj/body = Variant A (control),
  // aSubj/aBody = Variant B (test). Tokens like {first} auto-fill per prospect.
  function PB_SEQS() {
    return [
      /* ===================== BUSINESS DEVELOPMENT ===================== */
      { id: "just-raised", motion: "bd", accent: "c", name: "Just Raised", signal: "Funding round", persona: "VP Eng / Head of Talent",
        goal: "Win the recruiting engagement before the post-raise hiring spike floods the market.",
        touches: [
          { d: 0, ch: "email", t: "One MPC before the crush", subj: "Staff backend eng — scaled payments to 12k tx/sec",
            body: "Hi {first},\n\nSaw the {round}, congrats. The quarter after a raise is when great backend talent gets scarce, so before the crush, one person who isn't applying anywhere:\n\n• Scaled a payments ledger to twelve thousand transactions a second at five-nines (Series C fintech)\n• Go and event-sourcing; cut reconciliation latency by 80 percent\n\nPassive, but would move for real ownership on a platform like yours. Won't be around long.\n\nWant the one-pager?\n\nThanks,\n{you}",
            aSubj: "your next 5 engineering hires",
            aBody: "Hi {first}, saw the {round}, congrats. Most teams lose a quarter standing up a pipeline after a raise. I've got a Staff backend engineer who scaled payments to 12k tx/sec and isn't on the market. Want the one-pager?",
            cSubj: "before you post the Go role again",
            cBody: "Hi {first}, congrats on the {round}. Quick one before you re-post the backend role: I've got a Staff engineer who scaled payments past 12k tx/sec, passive, would move for the right platform. Worth a five-minute call?" },
          { d: 2, ch: "liconn", t: "Connect, ref the email",
            body: "Hi {first}, I just emailed you about a backend engineer for the team you're scaling after the raise. Connecting here too. No pitch, the work speaks for itself.",
            b: "Hi {first}, congrats on the {round}. Sent you a note about a Staff backend engineer who'd fit the team you're building. Connecting here too." },
          { d: 4, ch: "lidm", t: "Lower-friction offer",
            body: "{first}, in case the email got buried: passive Staff backend engineer, scaled payments past twelve thousand a second, fits your Go role. Want the one-pager to start? Yes or no is fine.",
            b: "{first}, no chase, just a yes/no: want me to send the one-pager on that backend engineer, or not the right time?" },
          { d: 6, ch: "livoice", t: "Voice note: the window's real",
            body: "Hi {first}, it's {you}... just touching base about that engineer I sent over after the raise. No pressure at all. I just want to be honest, they already have another conversation going, so the window's real. What you're building is exactly the kind of scope they'd move for. Worth a quick call this week? Thanks {first}.",
            b: "Hi {first}, it's {you}... quick one on that backend engineer. They're getting close with another team, so the timing's real. I'd love five minutes to talk you through them rather than email it all. Reply here. Thanks." },
          { d: 9, ch: "vm", t: "Voicemail in your voice",
            body: "Hi {first}, it's {you} at {firm}. I sent a note about a backend engineer for your team after the {round}... passive, and a real fit. They're getting close elsewhere, so I didn't want you to miss it. Give me a call back when you can. And congrats again.",
            b: "Hi {first}, {you} here at {firm}. Quick follow-up on that engineer for your team... strong, and the window's closing. I'd love five minutes. Call me back when you get a sec. Congrats again on the raise." },
          { d: 12, ch: "email", t: "Second candidate + news", subj: "saw {company} is staffing up — one more for you",
            body: "Hi {first},\n\nSaw {company}'s hiring page light up after the raise, exciting. Here's a second engineer worth your time, since the first is now mid-process elsewhere:\n\n• Led the infra team that held a fintech at five-nines through a ten-x growth year\n• Deep in Kubernetes, Go and observability; the calm one when things break at 3am\n\nOpen to a conversation, selective about where. Worth a quick call?\n\nThanks,\n{you}",
            aSubj: "the first one's gone — here's the second",
            aBody: "Hi {first}, the backend engineer I led with is now mid-process elsewhere, but here's a second who's just as strong: led infra for a fintech through ten-x growth, deep Go and Kubernetes. Want a quick call before they're gone too?" },
          { d: 16, ch: "email", t: "Break-up, door open", subj: "closing the loop",
            body: "Hi {first}, I'll stop here so I'm not noise in your inbox. Standing offer: reply anytime and I'll line up a quick call on whatever's hardest to fill. Congrats again on the {round}.\n\nThanks,\n{you}",
            aSubj: "I'll leave it here",
            aBody: "Hi {first}, last note so I'm not noise. Whenever backend or infra hiring gets loud after the raise, reply and we'll grab fifteen minutes. Congrats again." }
        ] },

      { id: "reposted-3x", motion: "bd", accent: "v", name: "Reposted Three Times", signal: "Job repost (3x)", persona: "Hiring Manager / Talent",
        goal: "Win the hard-to-fill req a team has already given up on filling alone.",
        touches: [
          { d: 0, ch: "email", t: "One who'd land it", subj: "the {role} repost — one person who'd actually land it",
            body: "Hi {first},\n\nThe {role} req has cycled back to the top of your careers page a few times. That's almost never the candidates' fault, it's a thin top-of-funnel against a high bar. One {discipline} person I've spoken with who'd clear it:\n\n• {achv}\n• Has shipped the exact thing your post asks for, twice; passive, not applying anywhere\n\nWant the one-pager?\n\nThanks,\n{you}",
            aSubj: "filling {role} without the repost loop",
            aBody: "Hi {first}, noticed {role} keeps reposting. Usually means strong-on-paper folks who fade in the loop. I source for fit first, and I've got one who'd actually land it: {achv}. Want a look?",
            cSubj: "why {role} keeps reposting (and the fix)",
            cBody: "Hi {first}, a role that reposts three times is a positioning problem, not a sourcing one. I've got one {discipline} person who'd clear your bar and a sharper way to pitch the role. Worth a quick call?" },
          { d: 2, ch: "liconn", t: "Connect, ref the email",
            body: "Hi {first}, just emailed about the {role} repost and someone who'd land it. Connecting here too so it's easy to reply.",
            b: "Hi {first}, reached out about the {role} role and a {discipline} person who fits. Connecting here too." },
          { d: 4, ch: "livoice", t: "Voice note: show, not tell",
            body: "Hey {first}, it's {you}... I saw the {role} role is back open again. I won't pitch you. I've just got someone I think is a real fit, and honestly I'd rather show you than tell you. Worth a quick call? I'll walk you through them. Thanks.",
            b: "Hey {first}, it's {you}... about the {role} search. I've got one person who'd genuinely clear your bar. Rather than email a profile, can I grab five minutes to talk you through them? Reply here. Thanks." },
          { d: 7, ch: "vm", t: "Voicemail drop",
            body: "Hi {first}, {you} here. About the {role} search... I've got a {discipline} person who isn't on the market and would clear your bar. I'd love a few minutes to talk them through. Give me a ring back. Thanks so much.",
            b: "Hi {first}, {you} here, on the {role} role. I think the role's stronger than its post, and I've got someone who'd see that. Quick call back? Thanks." },
          { d: 10, ch: "email", t: "Reframe + second person", subj: "the {role} role — one more angle",
            body: "Hi {first},\n\nHonestly, I think the {role} post undersells the role, the scope is better than the bullets make it sound. The first person I mentioned would get that immediately, and here's a second:\n\n• Quietly one of the best {discipline} people I know, ex-{peer}\n• Mentors and raises the bar around them; would anchor your team\n\nWant a quick call to talk through both and a reframed pitch?\n\nThanks,\n{you}",
            aSubj: "a second {discipline} person for {role}",
            aBody: "Hi {first}, here's a second option for {role}: ex-{peer}, one of the best {discipline} people I know, would anchor your team. Worth a quick call on both?" },
          { d: 13, ch: "lidm", t: "Soft close",
            body: "{first}, still happy to talk you through those two {role} people whenever you want a second pipeline running alongside yours. Just say the word.",
            b: "{first}, the offer stands on {role}: two strong people, a quick call, no obligation. Want to grab time?" },
          { d: 17, ch: "email", t: "Break-up", subj: "last note on {role}",
            body: "Hi {first}, I'll leave it here. If the {role} search drags into another month, reply to this and we'll grab fifteen minutes.\n\nThanks,\n{you}",
            aSubj: "closing out {role}",
            aBody: "Hi {first}, I'll stop here. If {role} is still open in a few weeks, reply and I'll bring two people and a reframed pitch to a quick call." }
        ] },

      { id: "mpc", motion: "bd", accent: "g", name: "MPC · Lead With a Candidate", signal: "Standout candidate available", persona: "VP Eng / Founder",
        goal: "Open doors at multiple target companies by leading with one exceptional person.",
        touches: [
          { d: 0, ch: "email", t: "Present the one", subj: "a {title} who {achv}",
            body: "Hi {first},\n\nI rarely lead with one person, but this {title} is worth it:\n\n• {achv}\n• {discipline}, {years} years, currently at a {peer}-stage company, quietly open\n\nGiven {company}'s {signal}, they could be a real unlock. Worth a quick call to talk through them?\n\nThanks,\n{you}",
            aSubj: "{title} · {achv}",
            aBody: "Hi {first}, I've got a {title} worth an exception to my usual rule. {achv}. Passive, but would move for the right team. Worth a quick look given where {company} is headed?",
            cSubj: "the kind of {title} you don't see on the market",
            cBody: "Hi {first}, every so often someone special comes free. This {title} {achv}, and is quietly open. Given {company}'s {signal}, worth five minutes before they're spoken for?" },
          { d: 2, ch: "liconn", t: "Connect",
            body: "Hi {first}, sent you a note about a {title} I think fits {company} well. Connecting so it's easy to reply.",
            b: "Hi {first}, reached out about a standout {title} for {company}. Connecting here too." },
          { d: 4, ch: "lidm", t: "Lower-friction nudge",
            body: "{first}, quick nudge on that {title}. Happy to talk you through them on a five-minute call, easier than email. Worth it?",
            b: "{first}, that {title} I mentioned is rare and won't stay open. Want five minutes to hear why they'd fit {company}?" },
          { d: 6, ch: "livoice", t: "Voice note: don't miss them",
            body: "Hi {first}, it's {you}... about that {title} I emailed you. I really do think they'd be a fit for what you're building. No pressure at all. They're starting to take a couple of calls though, so I didn't want you to miss them. Worth a quick chat? Thanks.",
            b: "Hi {first}, it's {you}... that {title} is starting to take calls. I'd hate for {company} to miss them. Five minutes and I'll tell you why they stand out. Reply here. Thanks." },
          { d: 9, ch: "vm", t: "Voicemail drop",
            body: "Hi {first}, {you} here, about the {title} I mentioned... I genuinely think they'd be great for {company}. I'd love a few minutes to talk you through them. Call me back. Thanks so much.",
            b: "Hi {first}, {you} here. That {title}... still open, but not for long. Quick call back and I'll walk you through them. Thanks." },
          { d: 12, ch: "email", t: "Honest urgency", subj: "re: the {title}",
            body: "Hi {first}, quick update, the {title} now has a couple of conversations starting. Not pressure, just timing. Want fifteen minutes before their calendar fills?\n\nThanks,\n{you}",
            aSubj: "the {title} is heating up",
            aBody: "Hi {first}, the {title} I mentioned is getting attention now. If {company} wants a look, let's grab a quick call this week before it's moot." },
          { d: 16, ch: "email", t: "Break-up, door open", subj: "I'll close this out",
            body: "Hi {first}, I'll stop here. If a {title} like this would help {company}, reply anytime and we'll grab a few minutes. I keep a few people this good warm at all times.\n\nThanks,\n{you}",
            aSubj: "the door's open",
            aBody: "Hi {first}, I'll leave it. People this good come along a few times a year, and I'll think of {company} when the next one does. Reply anytime." }
        ] },

      { id: "new-vp-eng", motion: "bd", accent: "c", name: "New VP of Engineering", signal: "Exec hire", persona: "Newly-hired eng leader",
        goal: "Get on a new leader's vendor shortlist while they rebuild the team in their first 90 days.",
        touches: [
          { d: 0, ch: "email", t: "One for the first 90 days", subj: "congrats on the {company} role",
            body: "Hi {first},\n\nCongrats on stepping into the VP Engineering seat at {company}. The first ninety days usually come down to two or three hires that unlock the rest, so here's one I've already spoken with:\n\n• {achv}\n• The kind of senior engineer who stabilizes a team fast; passive, would move for a clear mandate\n\nWorth a quick call to map your first hires?\n\nThanks,\n{you}",
            aSubj: "your first 90 days at {company}",
            aBody: "Hi {first}, congrats on the {company} move. New leaders almost always inherit a couple of critical open roles. I've got a senior engineer who could take one off your plate this month. Open to fifteen minutes?",
            cSubj: "the hire that makes your first quarter easier",
            cBody: "Hi {first}, congrats on the {company} role. Every new eng leader has that one hire that unlocks the rest. I've got a senior engineer who fits that bill. Worth five minutes?" },
          { d: 3, ch: "liconn", t: "Connect + congrats",
            body: "Hi {first}, congrats on the new role at {company}. I emailed you about an engineer for your early hires. Connecting here too.",
            b: "Hi {first}, congrats on the {company} move. Reached out about helping with your first hires. Connecting here too." },
          { d: 5, ch: "lidm", t: "No-rush nudge",
            body: "{first}, no rush as you settle in. When you're ready, a quick call to compare notes on your first hires, or I can keep a couple warm for you. Either works.",
            b: "{first}, whenever the dust settles, happy to grab fifteen minutes on your early hires. No agenda, just useful." },
          { d: 7, ch: "livoice", t: "Voice note: make it easier",
            body: "Hey {first}, it's {you}, congratulations again on the {company} role. I know the first quarter is a blur. The engineer I mentioned would make it easier, and honestly they'd be excited about a fresh mandate under a new leader. Worth a quick call? Thanks.",
            b: "Hey {first}, it's {you}... congrats again. No pressure as you ramp, but if one early hire is keeping you up at night, that's exactly what I'm good at. Five minutes whenever. Thanks." },
          { d: 10, ch: "vm", t: "Voicemail drop",
            body: "Hi {first}, it's {you} at {firm}. Congrats again on the {company} role. I sent over an engineer who'd be a great early hire... no pressure, just call me back when you surface for air. Thanks so much.",
            b: "Hi {first}, {you} here at {firm}. Congrats on the new seat. When you're ready to move on a key hire, I've got people warm. Quick call back whenever. Thanks." },
          { d: 13, ch: "email", t: "Second candidate + news", subj: "saw the team's growing at {company}",
            body: "Hi {first},\n\nSaw {company} is opening more engineering roles, congrats on getting moving. Since timing's right, a second person who thrives in exactly this build-out phase:\n\n• Ex-{peer}, deep in {discipline}; builds and mentors, a force-multiplier on a young team\n\nWorth a quick call while you're scoping the team?\n\nThanks,\n{you}",
            aSubj: "people who love a build-out phase",
            aBody: "Hi {first}, saw {company} is opening more roles. I've got people who specifically thrive in a new-leader build-out, here's one: ex-{peer}, deep {discipline}, a force-multiplier. Quick call?" },
          { d: 17, ch: "email", t: "Break-up", subj: "when you're ready",
            body: "Hi {first}, you're heads-down, so I'll keep this short. When you're ready to move on a key hire, reply and we'll grab a quick call.\n\nThanks,\n{you}",
            aSubj: "no rush, standing offer",
            aBody: "Hi {first}, I'll leave it here. When a key hire becomes the priority, reply and I'll bring a shortlist to a first call. Congrats again on {company}." }
        ] },

      { id: "velocity-spike", motion: "bd", accent: "a", name: "Hiring Velocity Spike", signal: "Many roles opened", persona: "In-house talent lead",
        goal: "Become the overflow partner when a team opens more roles than it can pipeline.",
        touches: [
          { d: 0, ch: "email", t: "Take the hardest off your plate", subj: "{n} roles open at {company} — the two that are stuck?",
            body: "Hi {first},\n\n{company} opened {n} roles in a few weeks, that's a lot of pipeline for one team. I work as overflow: you keep your process, I keep candidates flowing for the roles that are stuck. To prove it rather than promise it, one I've already got:\n\n• {achv}; ready to interview this week\n\nWant a quick call, and I'll take your hardest req?\n\nThanks,\n{you}",
            aSubj: "keeping up with {n} open roles",
            aBody: "Hi {first}, {company}'s hiring page jumped to {n} roles. When volume spikes, the hardest reqs stall while the easy ones fill. I can take the two hardest, starting with candidates this week. Open to fifteen minutes?",
            cSubj: "which 2 of your {n} roles are stuck?",
            cBody: "Hi {first}, with {n} roles open, two are probably dragging while the rest fill. Tell me which two and I'll bring candidates for exactly those, no retainer. Quick call?" },
          { d: 2, ch: "liconn", t: "Connect, ref the email",
            body: "Hi {first}, emailed about overflow help with {n} roles open at {company}. Connecting so it's easy to reply.",
            b: "Hi {first}, reached out about taking your two hardest reqs off your plate. Connecting here too." },
          { d: 4, ch: "lidm", t: "Start with one role",
            body: "{first}, I've already got candidates ready. Happy to start with just one role to prove it out, the one slowing you down most. Which is it?",
            b: "{first}, no big commitment, give me your single hardest req and I'll bring candidates this week. Which one?" },
          { d: 6, ch: "livoice", t: "Voice note: not taking over",
            body: "Hey {first}, it's {you}... I know {n} open roles is a lot to carry. I'm not trying to take over your process, just keep candidates flowing on the two that are stuck. I've already got people ready. Worth a quick call? Thanks.",
            b: "Hey {first}, it's {you}... with {n} roles open, the hardest ones tend to stall. Let me take two off your plate. Five minutes and I'll show you who I've got. Reply here. Thanks." },
          { d: 9, ch: "vm", t: "Voicemail drop",
            body: "Hi {first}, {you} here. Saw how much {company} is hiring right now... I help teams handle the overflow without changing your process, and I've already got strong people ready. Quick call back if that's useful. Thanks a lot.",
            b: "Hi {first}, {you} here. With all those open roles, happy to take the two hardest off your plate. Call me back and I'll show you who's ready. Thanks." },
          { d: 12, ch: "email", t: "Which two are stuck?", subj: "which two are stuck?",
            body: "Hi {first}, simple question: which two of those {n} roles are dragging? Tell me and I'll bring candidates for exactly those this week, no retainer to find out if I'm useful.\n\nThanks,\n{you}",
            aSubj: "name your hardest req",
            aBody: "Hi {first}, just name your single hardest of the {n} open roles and I'll have candidates for it on a call this week. No retainer to see if I'm worth it." },
          { d: 16, ch: "email", t: "Break-up", subj: "one role to start",
            body: "Hi {first}, I'll stop here. If even one of those {n} roles is dragging, reply and we'll grab fifteen minutes.\n\nThanks,\n{you}",
            aSubj: "I'll leave it with you",
            aBody: "Hi {first}, last note. When one of those roles becomes the bottleneck, reply and I'll bring candidates to a quick call." }
        ] },

      { id: "competitor-layoff", motion: "bd", accent: "v", name: "Competitor Layoff · Talent Freed", signal: "Layoff at a peer", persona: "Eng leader / Talent",
        goal: "Move fast on suddenly-available talent and pitch the companies that are still hiring.",
        touches: [
          { d: 0, ch: "email", t: "A short window", subj: "{discipline} talent just freed up near {company}",
            body: "Hi {first},\n\nThere's been a round of cuts at {peer}, which means a pocket of strong {discipline} people are on the market, briefly. One I've already spoken with:\n\n• {achv}\n• A top performer at {peer}, not a casualty of performance; wants somewhere stable and growing, like {company}\n\nThese windows close fast. Worth a quick call before they're gone?\n\nThanks,\n{you}",
            aSubj: "a short window on {discipline} talent",
            aBody: "Hi {first}, the {peer} layoffs put some genuinely good {discipline} engineers in play this week. These windows close fast. Want the strongest one who fits {company}?",
            cSubj: "good people from {peer}, this week only",
            cBody: "Hi {first}, the {peer} cuts freed up a few strong {discipline} engineers, top performers, not casualties. They'll be gone in two weeks. Five-minute call and I'll send the best fit for {company}?" },
          { d: 2, ch: "livoice", t: "Voice note: it won't last",
            body: "Hey {first}, it's {you}. With what just happened at {peer}, a really strong person is available right now, and that won't last. Worth a quick call and I'll tell you why they'd fit {company}. Reply here. Thanks.",
            b: "Hey {first}, it's {you}. Those {peer} folks won't be around long. Give me five minutes and I'll walk you through the best one for {company}. Thanks." },
          { d: 3, ch: "liconn", t: "Connect, grab them fast",
            body: "{first}, emailed about a strong {discipline} person who just came free near {company}. Connecting so it's easy to grab them before the market does.",
            b: "{first}, reached out about {peer} talent that just came available. Connecting here too, these move fast." },
          { d: 4, ch: "sms", t: "Time-sensitive nudge",
            body: "{first}, {you}, that {discipline} talent from {peer} is moving fast. Want a quick call before they're gone?",
            b: "{first}, {you} here. The {peer} folks are getting snapped up. Five minutes today and I'll send the best fit for {company}?" },
          { d: 6, ch: "vm", t: "Voicemail drop",
            body: "Hi {first}, {you} here. That {discipline} person from {peer}... still available, but not for long, and I'd hate for you to miss them. Quick call back and I'll talk you through them. Thanks so much.",
            b: "Hi {first}, {you} here. Those {peer} engineers are going fast. Call me back today and I'll line up the best one for {company}. Thanks." },
          { d: 8, ch: "lidm", t: "Second person, last easy nudge",
            body: "{first}, last easy nudge: there's a second {discipline} person from {peer} too. Worth a quick call before the rest of the market gets to them? Just say yes.",
            b: "{first}, two strong {peer} people, closing window. Five minutes this week? Yes or no is fine." },
          { d: 11, ch: "email", t: "Break-up", subj: "window's closing",
            body: "Hi {first}, last note, most of the {peer} folks will be off the market within two weeks. If you want a quick call, reply today and I'll move.\n\nThanks,\n{you}",
            aSubj: "they'll be gone soon",
            aBody: "Hi {first}, I'll leave it. The {peer} talent won't last the month. If you want intros, reply today and we'll grab five minutes." }
        ] },

      { id: "stale-req", motion: "bd", accent: "a", name: "Stale Req Rescue", signal: "Role open 60+ days", persona: "Frustrated hiring manager",
        goal: "Win a role the company has struggled to fill by reframing the pitch, not just re-searching.",
        touches: [
          { d: 0, ch: "email", t: "Positioning, plus one person", subj: "the {role} role — still open?",
            body: "Hi {first},\n\n{role} has been open at {company} for a couple of months. After sixty days it's usually positioning, not sourcing, the pitch isn't landing with the people who'd be great. One who'd land it:\n\n• {achv}\n• Wouldn't have applied to the post, but would take the call\n\nWorth a quick call on the candidate and a reframed pitch?\n\nThanks,\n{you}",
            aSubj: "60 days on {role} — a second angle",
            aBody: "Hi {first}, {role} looks like it's been a tough fill. I tend to win the roles other people give up on by selling the mission, not the checklist. One profile ready. Worth a quick call?",
            cSubj: "why {role} hasn't closed (it's not sourcing)",
            cBody: "Hi {first}, a role open sixty days is rarely a sourcing problem, it's how it's being told. I've got someone who'd land it and a sharper way to pitch it. Five minutes?" },
          { d: 2, ch: "liconn", t: "Connect, ref the email",
            body: "Hi {first}, reached out about {role} and someone who'd land it. Connecting here too so it's easy to reply.",
            b: "Hi {first}, emailed about a fresh angle on {role}. Connecting here too." },
          { d: 4, ch: "lidm", t: "Change the story",
            body: "{first}, I've filled a few 'impossible' reqs by changing the story, not the search. Two people in mind for {role}. Worth a quick call?",
            b: "{first}, the {role} pitch may just need reframing. I've got people who'd respond to it. Five minutes to compare notes?" },
          { d: 6, ch: "livoice", t: "Voice note: let me reframe it",
            body: "Hey {first}, it's {you}... about the {role} search. Genuinely, I think the role's stronger than the post makes it sound, and I've got people who'd see that immediately. Worth a quick call so I can reframe it for you. Reply here. Thanks.",
            b: "Hey {first}, it's {you}... I think {role} is a better role than its post suggests. Give me five minutes and I'll show you a sharper pitch plus two people who'd take it. Thanks." },
          { d: 8, ch: "vm", t: "Voicemail drop",
            body: "Hi {first}, {you} here, about the {role} search. I think the role's better than its post makes it sound, and I've got two people who'd get it. Quick call back and I'll talk you through it. Thanks so much.",
            b: "Hi {first}, {you} here on {role}. I've got a reframed pitch and two people who'd respond to it. Five minutes? Call me back. Thanks." },
          { d: 11, ch: "email", t: "A reframed pitch", subj: "a reframed {role} pitch",
            body: "Hi {first},\n\nHere's the way I'd pitch {role} to the people I mentioned, a different angle than the current post: lead with the scope and the problem, not the checklist.\n\nWorth a quick call to talk through it and the two candidates?\n\nThanks,\n{you}",
            aSubj: "the {role} pitch, rewritten",
            aBody: "Hi {first}, I rewrote how I'd pitch {role}, scope and mission first, checklist last. Two people would respond to it. Want to compare notes on a call?" },
          { d: 15, ch: "email", t: "Break-up", subj: "last note on {role}",
            body: "Hi {first}, I'll leave it. If {role} is still open in two weeks, reply and we'll grab fifteen minutes on the reframe and the candidates.\n\nThanks,\n{you}",
            aSubj: "closing out {role}",
            aBody: "Hi {first}, last note. When {role} becomes the priority again, reply and I'll bring a reframed pitch and two people to a quick call." }
        ] },

      { id: "winback-client", motion: "bd", accent: "g", name: "Win Back a Churned Client", signal: "Past client hiring again", persona: "Former client contact",
        goal: "Re-earn a former client now hiring again, starting with a single role to rebuild trust.",
        touches: [
          { d: 0, ch: "email", t: "Show what's changed", subj: "good to see {company} hiring again",
            body: "Hi {first},\n\nSaw {company} is hiring again, good sign. It's been a while since we worked together, and I've sharpened a lot since then, especially on {discipline} roles. To show it rather than say it, one person I've already got:\n\n• {achv}\n\nI'd love another shot, even one role to start. Worth a quick call?\n\nThanks,\n{you}",
            aSubj: "another shot at a {company} role?",
            aBody: "Hi {first}, {company}'s back in hiring mode. I know our last engagement was a while ago, and I'd value the chance to show what's changed. Happy to take just one role to start. Worth a quick catch-up?",
            cSubj: "I've gotten a lot better since we worked together",
            cBody: "Hi {first}, good to see {company} hiring. I won't relitigate last time, I'll just say I've sharpened a lot on {discipline}, and I've already got someone strong. Give me one role and a quick call to prove it?" },
          { d: 2, ch: "liconn", t: "Connect, ref the email",
            body: "Hi {first}, good to see {company} hiring. Sent you a note about earning back a search, even one role. Connecting here too.",
            b: "Hi {first}, great to see {company} growing again. Reached out about reconnecting. Connecting here too." },
          { d: 4, ch: "lidm", t: "Warm reconnect",
            body: "{first}, good to see {company} growing again. Would love to reconnect and earn back a search, even one role to start. Worth a quick call?",
            b: "{first}, it's been too long. Give me your one hardest role and a quick call, and I'll show you what's changed." },
          { d: 6, ch: "livoice", t: "Voice note: give me one role",
            body: "Hey {first}, it's {you}... I know it's been a while since we worked together, and I'd genuinely value another shot. I've gotten a lot sharper, especially on {discipline}. Give me one role and a quick call and I'll prove it. Reply whenever. Thanks.",
            b: "Hey {first}, it's {you}... no hard feelings about last time, I've just gotten better. Five minutes and one role is all I'm asking. Reply here. Thanks." },
          { d: 8, ch: "vm", t: "Voicemail drop",
            body: "Hi {first}, it's {you}. Saw {company} is hiring again, and since we've worked together before I'd love another shot, just one role to prove it. Quick call back when you can. Thanks.",
            b: "Hi {first}, {you} here. Great to see {company} hiring. I've sharpened a lot, give me one role and five minutes. Call me back. Thanks." },
          { d: 11, ch: "email", t: "One role, no risk", subj: "one role, no risk",
            body: "Hi {first}, simple offer: pick the one role that matters most right now and I'll work it personally, no retainer to see if I've earned it back. Worth a quick call?\n\nThanks,\n{you}",
            aSubj: "let me earn it on one role",
            aBody: "Hi {first}, no retainer, no big ask, just your single most important role and a quick call. If I deliver, we go from there. Want to?" },
          { d: 15, ch: "email", t: "Door open", subj: "door open at {firm}",
            body: "Hi {first}, I'll leave the ball in your court. Whenever a role comes up where you want a second pipeline, reply and we'll grab a few minutes.\n\nThanks,\n{you}",
            aSubj: "whenever you're ready",
            aBody: "Hi {first}, I'll stop here. The offer stands: one role, a quick call, no risk, whenever the timing's right." }
        ] },

      /* ===================== RECRUITING ===================== */
      { id: "passive-engineer", motion: "recruiting", accent: "c", name: "Passive Engineer · Signal-Led", signal: "Reorg / layoff nearby", persona: "Happily-employed senior engineer",
        goal: "Open a conversation with someone not looking, on the strength of their actual work.",
        touches: [
          { d: 0, ch: "lidm", t: "Substance-led opener",
            body: "Hi {first}, this isn't a spray-and-pray message, I actually read your work on {achv}. I'm hiring for a {role} where that exact experience is the whole job, not a line item. I'm not asking you to leave anything. Worth a fifteen-minute look? If it's not for you, I'll happily send it to someone you rate.",
            b: "Hi {first}, your {achv} is the rare thing this {role} is actually built around. Not a cold pitch, I went looking for the person who'd done it, and it's you. Open to a quick, no-pressure look?",
            c: "Hi {first}, quick one: I've got a {role} that's basically your {achv} as a full-time mandate. Worth fifteen minutes? Even a 'not now' is a fair answer." },
          { d: 3, ch: "email", t: "The why-now, and why you", subj: "the {role} role, built around what you do",
            body: "Hi {first},\n\nFollowing up here. What makes this {role} different: {achv-context}. Small team, real scope, comp in the {band} range.\n\nWhy you specifically: {achv}. That's rare, and it's the heart of this role.\n\nNo pressure, but if you're even passively curious, fifteen minutes and you'll know if it's real.\n\nThanks,\n{you}",
            aSubj: "{achv} — as the whole job",
            aBody: "Hi {first}, the short version: a {role} where {achv} is the mandate, not a bullet. {achv-context}. Comp's in the {band} range. Worth fifteen minutes to see if it's real?",
            cSubj: "not looking? read this anyway",
            cBody: "Hi {first}, I know you're not looking, that's exactly why I reached out. This {role} is the kind of thing people leave a good job for: {achv-context}. If you're even a little curious, I'll keep it low-key." },
          { d: 6, ch: "livoice", t: "Voice note: compliment + low-key",
            body: "Hey {first}, it's {you}... I know you're not looking, and that's exactly why I reached out about the {role}. It's the kind of thing people leave a good job for. What you did with {achv} is genuinely impressive, and it's the whole game in this role. If you're even a little curious, reply here and I'll keep it low-key. Thanks.",
            b: "Hey {first}, it's {you}... no pitch, I promise. I just don't reach out to many people for this {role}, and your {achv} is exactly why I reached out to you. Five minutes whenever, reply here. Thanks." },
          { d: 9, ch: "vm", t: "Voicemail drop",
            body: "Hi {first}, {you} here. I reached out about a {role} that's built around exactly what you're great at... no pressure at all. Give me a call back if you're curious. Thanks so much.",
            b: "Hi {first}, {you} here. Quick voicemail about a {role} that lines up with your {achv}... totally low-key, call me back whenever. Thanks." },
          { d: 12, ch: "email", t: "Soft close + referral", subj: "either way",
            body: "Hi {first}, last note from me on this. If the timing's wrong, I completely understand. But is there someone you respect who'd be perfect for a {role}? A name is just as valuable as a yes. Thanks either way.\n\n{you}",
            aSubj: "a name is as good as a yes",
            aBody: "Hi {first}, I'll leave it here. If it's not the right time, no worries at all, but if someone you rate comes to mind for a {role}, send them my way. I'll treat them well. Thanks either way." } ] },

      { id: "speed-to-lead", motion: "recruiting", accent: "g", name: "Inbound Applicant · Speed to Lead", signal: "Just applied", persona: "Fresh applicant",
        goal: "Reach an applicant within minutes, while they still remember applying.",
        touches: [
          { d: 0, ch: "email", t: "Fast human reply", subj: "got your application for {role}",
            body: "Hi {first},\n\nThanks for applying for the {role}, real person here. I've read it, and I'd love to learn what you're after next. Grab any slot that works: {link}. If none fit, just reply with two times and I'll make it work.\n\nThanks,\n{you}",
            aSubj: "real person, 30 seconds",
            aBody: "Hi {first}, real person on the other end, thanks for applying to the {role}. I read your application. Want to grab fifteen minutes so I can tell you what it's actually like? {link}",
            cSubj: "you applied {role} — here's the fast track",
            cBody: "Hi {first}, you applied for the {role} and I want to move quickly while it's fresh. Two clicks to grab time: {link}. Or reply with when's good." },
          { d: 0, ch: "sms", t: "Same-hour text",
            body: "Hi {first}, it's {you} at {firm}, thanks for applying to the {role}. Picked a couple of times to chat here: {link}. Talk soon!",
            b: "Hi {first}, {you} from {firm} here, got your {role} application. Free for a quick chat? Grab a slot: {link}" },
          { d: 2, ch: "email", t: "Nudge with substance", subj: "15 min on the {role}?",
            body: "Hi {first}, still keen to connect on the {role}. Quick context: {achv-context}. If now's not great, tell me when and I'll work around you.\n\nThanks,\n{you}",
            aSubj: "what the {role} is really like",
            aBody: "Hi {first}, before you decide if it's worth your time: {achv-context}. Happy to give you the honest picture on a quick call. When works?" },
          { d: 3, ch: "livoice", t: "Voice note: a real conversation",
            body: "Hey {first}, it's {you}... thanks again for applying for the {role}. I'd genuinely love to hear what you're looking for, not just run you through a process. Grab any time that works, or reply here. Thanks.",
            b: "Hey {first}, it's {you}... putting a voice to the name. Thanks for applying to the {role}. No interrogation, just a real chat about what you want next. Grab a time whenever. Thanks." },
          { d: 5, ch: "email", t: "Last nudge", subj: "keeping your spot warm",
            body: "Hi {first}, I'll keep your application warm either way. If you're still interested in the {role}, grab a time and we'll talk: {link}.\n\nThanks,\n{you}",
            aSubj: "still interested in {role}?",
            aBody: "Hi {first}, no chase, just a yes/no: still want to talk about the {role}? If yes, {link}. If the timing changed, totally fine, just let me know." } ] },

      { id: "silver-medalist", motion: "recruiting", accent: "v", name: "Silver-Medalist Re-engage", signal: "Past finalist, new role", persona: "Strong past candidate",
        goal: "Bring back a candidate who came close last time, before the role goes public.",
        touches: [
          { d: 0, ch: "email", t: "Better fit than last time", subj: "a {role} that fits better than last time",
            body: "Hi {first},\n\nYou came close on the {prev-role} last year and it stuck with me, you were a strong finalist. A {role} just opened that fits what you actually wanted: {achv-context}.\n\nWant first look before it's public?\n\nThanks,\n{you}",
            aSubj: "you were the one that got away",
            aBody: "Hi {first}, honestly you were the finalist I hated to lose on the {prev-role}. A {role} just opened that's an even better fit: {achv-context}. First look before it goes public?",
            cSubj: "round two?",
            cBody: "Hi {first}, quick one, a {role} opened that's more 'you' than the {prev-role} was. Want the details before anyone else sees it?" },
          { d: 3, ch: "lidm", t: "Warm DM",
            body: "{first}, the moment this {role} opened I pulled your name, you came that close on the {prev-role} last time. Want me to send the details before I post it anywhere?",
            b: "{first}, this {role} fits you even better than the {prev-role} you nearly landed. Want first look before it's public?" },
          { d: 6, ch: "livoice", t: "Voice note: the one that got away",
            body: "Hey {first}, it's {you}... this {role} just opened and I went straight to your file. You were a finalist on the {prev-role} last time, honestly the one that got away, and this one fits you even better. Reply here and I'll send it over. Thanks.",
            b: "Hey {first}, it's {you}... no pressure, but this {role} is a better version of the one you nearly landed. I'd love to get it right this time. Reply whenever. Thanks." },
          { d: 9, ch: "vm", t: "Voicemail drop",
            body: "Hi {first}, {you} here. That {role} I mentioned, I really think it's the right one this time, even more than the {prev-role}... give me a call back and I'll walk you through it. Thanks.",
            b: "Hi {first}, {you} here. Quick voicemail about a {role} you'd want, you were a finalist with me on the {prev-role} last time. Call me back and I'll give you first look. Thanks." },
          { d: 12, ch: "email", t: "Soft close", subj: "no rush",
            body: "Hi {first}, no pressure at all. The {role} is yours to look at first if you want it. Reply anytime and I'll send everything over.\n\nThanks,\n{you}",
            aSubj: "holding it for you",
            aBody: "Hi {first}, I'll hold off going public for a bit in case you want first look at the {role}. No pressure, just reply when you have a minute." } ] },

      { id: "niche-headhunt", motion: "recruiting", accent: "a", name: "Niche Specialist Headhunt", signal: "Rare skill match", persona: "Hard-to-find specialist",
        goal: "Cold-reach a genuinely rare specialist with a role built around their exact strength.",
        touches: [
          { d: 0, ch: "lidm", t: "Specific and short",
            body: "Hi {first}, you're one of maybe a few dozen people who've actually {achv}. I have a {role} built around exactly that. Worth a fifteen-minute look? Even if it's a no, I'd value your read on the market.",
            b: "Hi {first}, I went looking for people who've genuinely {achv}, and the list is short. You're on it. Got a {role} built around it. Quick look?",
            c: "Hi {first}, rare-skill outreach, not a blast: this {role} needs someone who's {achv}. That's you. Worth fifteen minutes?" },
          { d: 4, ch: "email", t: "The honest pitch", subj: "built for someone who's {achv}",
            body: "Hi {first},\n\nThis {role} isn't a generalist seat, it needs someone who's {achv}, which is genuinely rare. {achv-context}. Comp's in the {band} range.\n\nI'm not casting a wide net here, I reached out to you specifically. Fifteen minutes and you'll know if it's real.\n\nThanks,\n{you}",
            aSubj: "the short list for this {role}",
            aBody: "Hi {first}, I'll be straight: very few people can do this {role}, and you're one of them ({achv}). {achv-context}. Comp in the {band} range. Worth a look?",
            cSubj: "your read on the market?",
            cBody: "Hi {first}, even if this {role} isn't for you, you'd know the market for {achv} better than almost anyone. Fifteen minutes? I'll make it worth your time either way." },
          { d: 7, ch: "livoice", t: "Voice note: you specifically",
            body: "Hey {first}, it's {you}... I don't reach out to many people for this role, because not many people can do it. You can, what you did with {achv} proved that. If you're even a little curious, reply here. Thanks.",
            b: "Hey {first}, it's {you}... genuinely, the shortlist for this {role} is tiny and you're on it. No pressure, but I'd kick myself if I didn't reach out. Reply whenever. Thanks." },
          { d: 11, ch: "email", t: "Referral fallback", subj: "or who else?",
            body: "Hi {first}, if it's not for you, no worries. Given how niche this is, is there one person you'd trust with a {role}? I'd owe you one.\n\n{you}",
            aSubj: "one name?",
            aBody: "Hi {first}, last note. If the {role} isn't for you, who's the one person you'd point me to? People who've {achv} tend to know each other. I'll owe you." } ] },

      { id: "counter-offer-proof", motion: "recruiting", accent: "c", name: "Counter-Offer-Proof Close", signal: "Candidate in final stages", persona: "Finalist candidate",
        goal: "Keep a finalist anchored to their real reason for leaving, through offer and counter.",
        touches: [
          { d: 0, ch: "email", t: "Reconnect to the why", subj: "why this still matters",
            body: "Hi {first},\n\nAs we get close, it's worth grounding in why you started looking: {motivation}. This role solves that directly. Anything making you hesitate? Better we talk it through now than later.\n\nThanks,\n{you}",
            aSubj: "remember why you started",
            aBody: "Hi {first}, quick gut-check before the offer stage: you started looking because of {motivation}. This role fixes that. What, if anything, is still on your mind? Let's talk it through." },
          { d: 2, ch: "call", t: "Manager-fit call task",
            body: "Schedule a casual fifteen-minute call between {first} and the hiring manager, no agenda, just chemistry. Finalists who connect with their future manager rarely get pulled back by a counter.",
            b: "Set up an informal {first}-and-manager chat, no eval, just rapport. The stronger that human connection, the more counter-proof the candidate becomes." },
          { d: 4, ch: "email", t: "Pre-empt the counter", subj: "about the counter-offer",
            body: "Hi {first},\n\nYour current employer may counter, that's normal. Worth asking: why did it take you leaving for them to act, and does it actually fix {motivation}? You're not leaving for money, you're leaving for {motivation}. I'm here to talk it through, no spin.\n\nThanks,\n{you}",
            aSubj: "if they counter",
            aBody: "Hi {first}, when the counter comes, and it might, one question cuts through it: does more money fix {motivation}? If it did, you wouldn't have started looking. Happy to think it through together, no pressure." },
          { d: 5, ch: "livoice", t: "Voice note: feel solid",
            body: "Hey {first}, it's {you}... quick one before the offer lands. I just want you to feel solid about this. You started looking for a real reason, {motivation}, and this role delivers it. Whatever comes up, call me first and we'll think it through together. Thanks.",
            b: "Hey {first}, it's {you}... no agenda here. I just want you walking into this decision clear-headed. You've got good instincts, {motivation} is real. Call me anytime before you respond to anything. Thanks." },
          { d: 6, ch: "sms", t: "Day-of-offer text",
            body: "{first}, big day. However it lands, I've got your back. Call me before you respond to anything. {you}",
            b: "{first}, today's the day. Whatever they say, call me first and we'll think it through, no pressure. {you}" } ] },

      { id: "contractor-to-perm", motion: "recruiting", accent: "g", name: "Contractor to Perm", signal: "Contract ending", persona: "Proven contractor",
        goal: "Convert a contractor who's already delivering into a permanent hire.",
        touches: [
          { d: 0, ch: "email", t: "The case for perm", subj: "a perm seat with your name on it",
            body: "Hi {first},\n\nYou've been delivering as a contractor, and a perm {role} just opened that fits you exactly. The upside: equity, ownership, and you already know the work.\n\nWant me to walk you through what perm looks like here?\n\nThanks,\n{you}",
            aSubj: "you already do this job",
            aBody: "Hi {first}, the perm {role} that just opened is basically what you're already doing, plus equity and ownership. You'd skip the ramp entirely. Worth a quick look at the numbers?",
            cSubj: "contract → perm, your call",
            cBody: "Hi {first}, no pressure to leave contracting, but there's a perm {role} with your name on it if you want the equity and stability. Want the side-by-side?" },
          { d: 3, ch: "lidm", t: "Casual nudge",
            body: "{first}, that {role} I mentioned is the perm version of what you're already great at. Fifteen minutes to compare it to staying contract?",
            b: "{first}, quick one, want me to lay out the perm {role} next to your current contract so you can see the trade clearly? No pressure either way." },
          { d: 6, ch: "livoice", t: "Voice note: the equity question",
            body: "Hey {first}, it's {you}... about that permanent {role}. You're already doing the work better than most full-timers, so this is really just about whether you want the equity and the ownership. No pressure, but I think it's worth a look. Reply here. Thanks.",
            b: "Hey {first}, it's {you}... the perm {role} is the same work you're crushing, with a real stake in the outcome. Five minutes to talk the numbers? Reply whenever. Thanks." },
          { d: 9, ch: "vm", t: "Voicemail drop",
            body: "Hi {first}, {you} here. There's a permanent {role} basically built around what you've been doing... call me back when you can and I'll lay it out. Thanks a lot.",
            b: "Hi {first}, {you} here. Quick voicemail on that perm {role}, same work, more upside. Call me back and I'll walk you through it. Thanks." },
          { d: 12, ch: "email", t: "Soft close", subj: "no rush, just options",
            body: "Hi {first}, whatever you decide, I want you to have the full picture. Reply when you've got fifteen minutes and I'll put the perm offer side by side with contracting.\n\nThanks,\n{you}",
            aSubj: "the side-by-side, whenever",
            aBody: "Hi {first}, no agenda, I just think you should see the perm offer and your contract side by side before you decide anything. Reply when you've got fifteen minutes." } ] },

      { id: "boomerang", motion: "recruiting", accent: "v", name: "Boomerang · Alumni", signal: "Alum of a client, now open", persona: "Former employee of the client",
        goal: "Bring back a high-performer who left, now that what made them leave has changed.",
        touches: [
          { d: 0, ch: "email", t: "Come back around", subj: "{client} would take you back in a heartbeat",
            body: "Hi {first},\n\nYour name still comes up at {client}, in the good way. They've got a {role} that's a level up from when you left, and the things that made you go have changed: {whats-changed}.\n\nWorth hearing them out?\n\nThanks,\n{you}",
            aSubj: "{client} misses you (genuinely)",
            aBody: "Hi {first}, you left {client} for good reasons, and most of them have changed: {whats-changed}. There's a {role} a level up from your old one. Worth a no-pressure conversation?",
            cSubj: "a different {client} than you left",
            cBody: "Hi {first}, {client} isn't the place you left, {whats-changed}. And there's a {role} with your name on it. Curious enough to hear more?" },
          { d: 4, ch: "lidm", t: "Warm DM",
            body: "{first}, {client}'s in a different place than when you left, and there's a {role} with your name on it. Want the details? No pressure.",
            b: "{first}, the stuff that made you leave {client}? Changed. {whats-changed}. And there's a {role} that's a step up. Want the story?" },
          { d: 7, ch: "livoice", t: "Voice note: it's different now",
            body: "Hey {first}, it's {you}... I know you left {client} for good reasons. A lot's changed there, {whats-changed}, and they'd genuinely love you back for a {role}. If you're curious how it's different now, reply here. Thanks.",
            b: "Hey {first}, it's {you}... no spin, {client} really is different now, {whats-changed}. They'd take you back in a heartbeat for a {role}. Curious? Reply whenever. Thanks." },
          { d: 11, ch: "email", t: "Door open", subj: "whenever",
            body: "Hi {first}, no rush. The {role} at {client} is there if you want to explore it. Reply anytime and I'll set up a no-pressure chat.\n\nThanks,\n{you}",
            aSubj: "standing invite",
            aBody: "Hi {first}, I'll leave it with you. The {role} at {client} is open and you'd walk in known and trusted. Reply whenever and I'll set up a low-key chat." } ] },

      { id: "referral-engine", motion: "recruiting", accent: "a", name: "Referral Activation", signal: "Recent happy placement", persona: "Recently placed candidate",
        goal: "Turn a freshly-placed, happy candidate into a steady source of referrals.",
        touches: [
          { d: 0, ch: "email", t: "Ask while it's warm", subj: "who's as good as you?",
            body: "Hi {first},\n\nNow that you're settled into {newco}, I have one ask: who are the two best people you've worked with? I'm hiring for {role}-type seats and I'd much rather talk to people you rate than strangers. Intros are gold, and I look after the people you send.\n\nThanks,\n{you}",
            aSubj: "a quick favor (worth your while)",
            aBody: "Hi {first}, hope {newco}'s great. One ask: the two best engineers you've worked with, who are they? I treat referrals like VIPs, and there's a thank-you in it for you. Names or profiles, either works.",
            cSubj: "who should I talk to?",
            cBody: "Hi {first}, settling in at {newco}? Quick one, I'd rather hire people you'd vouch for than cold-source. Anyone come to mind for a {role}? Even one name helps." },
          { d: 3, ch: "sms", t: "Light text",
            body: "{first}, hope {newco}'s going great! Quick one, anyone you'd vouch for that I should know? {you}",
            b: "{first}, {you} here, hope {newco}'s treating you well! Got two minutes to point me at someone good for a {role}?" },
          { d: 6, ch: "livoice", t: "Voice note: I trust your taste",
            body: "Hey {first}, it's {you}... hope the new role's treating you well. No agenda here, I just trust your taste in people. If one or two names come to mind for a {role}, send them my way and I'll take great care of them. Thanks {first}.",
            b: "Hey {first}, it's {you}... you turned out to be a great hire, so I trust who you'd vouch for. Anyone good for a {role}? Send them over and I'll look after them. Thanks." },
          { d: 9, ch: "email", t: "Make it easy", subj: "even one name",
            body: "Hi {first}, no pressure, even one name helps. Forward me a profile or just a name and I'll take it from there. Thank you!\n\n{you}",
            aSubj: "forward this to one person?",
            aBody: "Hi {first}, easiest version of my ask: is there one person who should see a {role} like this? Forward them this, or send me a name. That's it. Thank you!" } ] }
    ];
  }
  function pbTouchTeaser(t) {
    var s = (t.subj ? t.subj + " — " : "") + t.body;
    s = s.replace(/\s+/g, " ").trim();
    return s.length > 100 ? s.slice(0, 100) + "…" : s;
  }
  // Expand a sequence's linear touches into the actual run order, inserting the
  // conditional branches. Today: after every LinkedIn connection request, a
  // warm SMS that fires ONLY if the request is still pending. It leans on the
  // lead's *previous* company (last_company) from deep enrichment for warmth.
  // Enrichment runs for everyone we send to, so last_company is reliably present
  // (the branch is gated on it as a failsafe). Truthful by design: it references
  // a real prior employer, it does NOT invent a referral.
  function pbExpand(s) {
    var out = [];
    s.touches.forEach(function (t) {
      out.push(t);
      if (t.ch === "liconn") {
        out.push({ d: t.d + 1, ch: "sms", t: "If not connected, warm SMS",
          cond: "the LinkedIn request is still pending",
          req: "last_company (from deep enrichment)",
          body: "Hi {first}, this is {you} with {firm}. I came across your background from your time at {last_company}, so I figured I'd reach out directly rather than wait on LinkedIn. Open to a few quick details?" });
      }
    });
    return out;
  }
  function pbCondNote(t) {
    if (!t.cond) return "";
    return '<div class="pb-note"><span class="i">⛓</span><span><b>Conditional branch.</b> Fires only if ' + esc(t.cond) +
      "." + (t.req ? " Requires <b>" + esc(t.req) + "</b>." : "") +
      " Enrichment runs for everyone we send to, so this stays fail-proof.</span></div>";
  }

  /* Response intelligence. When a prospect replies, the Response pipeline
     classifies the sentiment and an LLM drafts a tailored answer from this
     sequence plus the original hiring signal. Trust first, calendar second.
     These are the patterns it follows, motion-aware (BD prospect vs candidate). */
  function pbReplyData(motion) {
    if (motion === "recruiting") {
      return {
        pos: { rl: "😊 POSITIVE", title: "They're curious", teaser: "Give the real picture, respect their time, make the call easy.",
          reply: "Love it, {first}. Quick call so I can give you the real picture, the team, the scope, the comp, not a job-spec dump? Grab whatever works: {link}. I'll send the key details first so you can decide if it's even worth your time.",
          strategy: "Match their interest, lead with the information that respects their time, and make the next step a low-effort yes.",
          failsafe: "Always send the substance first, so a call is their choice, not a hoop." },
        neu: { rl: "😐 NEUTRAL / NOT NOW", title: "Maybe later", teaser: "Honor the timing, stay useful, ask to check back.",
          reply: "All good, {first}, no rush at all. I'll keep this one in mind and only reach out if something lands that actually fits what you said you wanted. Mind if I check in down the line?",
          strategy: "Respect the 'not now', and earn a welcome for the next touch by promising relevance, not volume.",
          failsafe: "Schedules a soft re-touch later; nothing in between, so you're never a pest." },
        neg: { rl: "🙅 NEGATIVE / PASS", title: "Not looking", teaser: "Gracious exit, leave the door open, honor the no.",
          reply: "Totally understood, {first}. I'll leave it here. If anything changes, or you ever just want an honest read on the market, I'm easy to reach. Best of luck.",
          strategy: "A graceful no earns more long-term goodwill than any rebuttal. People remember how you exit.",
          failsafe: "Auto-suppresses the contact and stops every channel, no further touches, ever." }
      };
    }
    return {
      pos: { rl: "😊 POSITIVE", title: "They're in", teaser: "Confirm, lead with value, offer a call AND an easy alternative.",
        reply: "Great, thanks {first}. Quickest version: I keep a small bench of senior people warm for exactly your stack, and I'd rather earn your trust than pitch you. Fifteen minutes this week to walk through who I've got and hear what you're hiring for? And if a call's overkill, just say the word and I'll send the one-pager.",
        strategy: "Match their energy, lead with value, and make the next step frictionless, a call or just send it, their choice.",
        failsafe: "Never hard-sell a warm reply; always offer the low-effort path too." },
      neu: { rl: "😐 NEUTRAL / NOT NOW", title: "Not right now", teaser: "Respect it, leave value, set a soft future trigger.",
        reply: "Totally fair, {first}, timing is everything. I'll get out of your inbox. One thing before I go: I'll keep a quiet eye on the market for the kind of people you'd want, and only ping you if someone genuinely exceptional comes free. Sound okay to check back in a quarter?",
        strategy: "Honor the 'not now', then give a concrete reason to welcome the next touch. Nurture, don't push.",
        failsafe: "Auto-schedules a soft re-touch; no pressure in between." },
      neg: { rl: "🙅 NEGATIVE / PASS", title: "Pass", teaser: "Gracious exit, one line of standing value, honor the no.",
        reply: "Understood, {first}, and I appreciate you telling me straight. I'll stop reaching out. If it's ever useful, I'm a good person to know when a hard role lands or talent shakes loose near {company}. Either way, best of luck with the team you're building.",
        strategy: "A graceful no builds more reputation than a pushy maybe, and the door stays open on their terms.",
        failsafe: "Auto-suppresses the lead and stops the sequence, protecting both your sending reputation and their goodwill." }
    };
  }
  function pbReplyCards(motion) {
    var d = pbReplyData(motion);
    var defs = [["pos", "g"], ["neu", "a"], ["neg", "r"]];
    return '<p class="pb-section-label">When they reply · the LLM responds</p>' +
      '<div class="pb-reply-grid">' + defs.map(function (x) {
        var r = d[x[0]];
        return '<div class="pb-reply" data-reply="' + x[0] + '" data-acc="' + x[1] + '">' +
          '<div class="rl">' + r.rl + '</div><div class="rt">' + esc(r.title) + "</div>" +
          "<p>" + esc(r.teaser) + '</p><span class="pb-go">See the reply <span class="arr">→</span></span></div>';
      }).join("") + "</div>" +
      '<div class="pb-note"><span class="i">🤖</span><span>Replies are auto-classified by the Response pipeline, then an LLM drafts a tailored answer from this sequence and the original hiring signal. Trust first, calendar second. A negative reply auto-suppresses the lead, that is the failsafe.</span></div>';
  }
  function pbReplyModal(motion, kind) {
    var r = pbReplyData(motion)[kind];
    var acc = kind === "pos" ? ["ok", "POSITIVE"] : kind === "neu" ? ["warn", "NEUTRAL"] : ["hot", "NEGATIVE"];
    var icon = kind === "pos" ? "😊" : kind === "neu" ? "😐" : "🙅";
    pbOpenModal(icon, r.title, "LLM reply · trust-first", "" +
      pbArt("The reply it sends", acc, pbIM(r.reply)) +
      '<div class="pb-note"><span class="i">🎯</span><span><b>Why it works.</b> ' + esc(r.strategy) + "</span></div>" +
      '<div class="pb-note"><span class="i">🛡️</span><span><b>Trust failsafe.</b> ' + esc(r.failsafe) + "</span></div>" +
      '<div class="pb-note"><span class="i">🤖</span><span>Drafted live by the LLM from the actual reply plus the hiring signal, then held for one-click approval. The end goal is trust; a meeting is the byproduct.</span></div>');
  }
  // The set of copy variants for a touch. From t.v (array of {subj?, body}),
  // else back-compat from the email A/B fields, else a single version.
  function pbTouchVariants(t) {
    if (t.v && t.v.length) return t.v;
    if (t.ch === "email") {
      var arr = [{ subj: t.subj, body: t.body }];
      if (t.aBody) arr.push({ subj: t.aSubj || t.subj, body: t.aBody });
      if (t.cBody) arr.push({ subj: t.cSubj || t.subj, body: t.cBody });
      return arr;
    }
    if (t.b) { var o = [{ body: t.body }, { body: t.b }]; if (t.c) o.push({ body: t.c }); return o; }
    return [{ body: t.body }];
  }
  function pbVariantPane(t, v, i) {
    var m = PB_CH[t.ch];
    var inner;
    if (t.ch === "email") inner = pbMail("From you · to {first}", v.subj || t.subj, v.body);
    else if (t.ch === "vm" || t.ch === "livoice") inner = '<div style="font-style:italic">' + pbNl(v.body) + "</div>";
    else if (t.ch === "call") inner = pbNl(v.body);
    else inner = pbIM(v.body);
    var label = "Variant " + String.fromCharCode(65 + i) + (i ? "" : " (control)");
    return '<div class="pb-vpane' + (i ? "" : " active") + '" data-vpane="' + i + '">' + pbArt(m.label + " · " + label, null, inner) + "</div>";
  }
  function pbTouchBody(t) {
    var cond = pbCondNote(t);
    var vs = pbTouchVariants(t);
    var tabs = vs.length > 1
      ? '<div class="pb-tabs2">' + vs.map(function (v, i) {
          return '<button class="' + (i ? "" : "active") + '" data-vtab="' + i + '">' + String.fromCharCode(65 + i) + "</button>";
        }).join("") + "</div>"
      : "";
    var panes = vs.map(function (v, i) { return pbVariantPane(t, v, i); }).join("");
    var foot;
    if (t.ch === "vm" || t.ch === "livoice") foot = '<div class="pb-note"><span class="i">🎤</span><span>Rendered in your consented voice clone, formatted for natural speech. ' + (t.ch === "vm" ? "Premium AMD drops it only after the voicemail beep." : "Delivered as a LinkedIn voice note.") + "</span></div>";
    else if (t.ch === "sms") foot = '<div class="pb-note"><span class="i">📱</span><span>Sent only with consent on file, inside the lead\'s local-time window.</span></div>';
    else if (t.ch === "call") foot = '<div class="pb-note"><span class="i">☎️</span><span>A human task in your queue, not an automated send.</span></div>';
    else foot = '<div class="pb-note"><span class="i">▸</span><span>Tokens like {first}, {company}, {role} and {last_company} auto-fill per prospect.</span></div>';
    var vnote = vs.length > 1 ? '<div class="pb-note"><span class="i">🔀</span><span><b>' + vs.length + ' variants.</b> The engine rotates and A/B-tests them, then promotes the winner automatically.</span></div>' : "";
    return cond + tabs + panes + vnote + foot;
  }
  /* legacy single-channel body kept for reference */
  function pbTouchBodyOld(t) {
    var m = PB_CH[t.ch];
    var tokenNote = '<div class="pb-note"><span class="i">▸</span><span>Tokens like {first}, {company} and {role} auto-fill per prospect from the signal and enrichment.</span></div>';
    if (t.ch === "email") {
      var a = pbArt(m.label + (t.aBody ? " · Variant A (control)" : ""), t.aBody ? ["ok", "A"] : null, pbMail("From you · to {first}", t.subj, t.body));
      var b = t.aBody ? pbArt(m.label + " · Variant B (test)", ["warn", "B"], pbMail("From you · to {first}", t.aSubj || t.subj, t.aBody)) : "";
      return a + b + tokenNote;
    }
    if (t.ch === "vm" || t.ch === "livoice") {
      return pbArt(m.label + " · spoken in your cloned voice", null, '<div style="font-style:italic">' + pbNl(t.body) + "</div>") +
        '<div class="pb-note"><span class="i">🎤</span><span>Rendered in your consented voice clone, formatted for natural speech. ' +
        (t.ch === "vm" ? "Premium AMD drops it only after the voicemail beep." : "Delivered as a LinkedIn voice note.") + "</span></div>";
    }
    if (t.ch === "sms") {
      return pbArt(m.label, null, pbIM(t.body)) +
        '<div class="pb-note"><span class="i">📱</span><span>Sent only with consent on file, inside the lead\'s local-time window.</span></div>';
    }
    if (t.ch === "call") {
      return pbArt(m.label + " · task for you", null, pbNl(t.body)) +
        '<div class="pb-note"><span class="i">☎️</span><span>A human task in your queue, not an automated send.</span></div>';
    }
    return pbArt(m.label, null, pbIM(t.body)) + tokenNote;
  }

  /* The Sequence Library deep view: filter by motion, browse a sequence's full
     timeline, click any touch to read the exact copy that goes out. */
  // The sequence id deep-linked in the hash (#playbooks/sequences/<id>), if any.
  function pbSeqSeg() {
    var h = (location.hash || "").replace(/^#/, "").split("/");
    if (h[0] === "bd" || h[0] === "recruiting") h.shift();
    return (h[0] === "playbooks" && h[1] === "sequences" && h[2]) ? h[2] : null;
  }
  function pbSeqLibrary(el) {
    var SEQS = PB_SEQS();
    var st = { motion: "all", open: pbSeqSeg() };
    el.innerHTML =
      '<div class="pb-wrap">' +
        '<span class="pb-back" data-go="playbooks"><span>←</span> All playbooks</span>' +
        '<div class="pb-d-head"><div class="pb-ico">📚</div>' +
          '<div><div class="pb-tag">The outbound models</div><h2>Sequence Library</h2></div></div>' +
        '<div class="pb-mission-band">' + esc("Sixteen battle-ready outbound workflows, eight for Recruiting and eight for Business Development. Each one is a real multi-channel sequence — email, LinkedIn, voice notes, voicemail drops and SMS — with the exact copy that goes out. Open a sequence to see every touch, then click a touch to read the message.") + "</div>" +
        '<div id="pbSeqHost"></div>' +
      "</div>";
    var host = el.querySelector("#pbSeqHost");

    function paintGrid() {
      var cnt = { all: SEQS.length, recruiting: 0, bd: 0 };
      SEQS.forEach(function (s) { cnt[s.motion]++; });
      var filters = [["all", "All (" + cnt.all + ")"], ["recruiting", "👤 Recruiting (" + cnt.recruiting + ")"], ["bd", "🏢 BD (" + cnt.bd + ")"]];
      var bar = '<div class="pb-tabs2" style="margin-bottom:18px">' + filters.map(function (f) {
        return '<button class="' + (st.motion === f[0] ? "active" : "") + '" data-mot="' + f[0] + '">' + esc(f[1]) + "</button>";
      }).join("") + "</div>";
      var list = SEQS.filter(function (s) { return st.motion === "all" || s.motion === st.motion; });
      var cards = list.map(function (s) {
        var chs = []; s.touches.forEach(function (t) { if (chs.indexOf(t.ch) < 0) chs.push(t.ch); });
        var chRow = chs.map(function (c) { return '<span class="n" title="' + esc(PB_CH[c].label) + '">' + PB_CH[c].icon + "</span>"; }).join('<span class="ar">·</span>');
        var motChip = s.motion === "bd"
          ? '<span class="pb-chip" style="color:var(--pb-c);border-color:rgba(77,208,255,.4)">🏢 BD</span>'
          : '<span class="pb-chip" style="color:var(--pb-g);border-color:rgba(56,224,166,.4)">👤 Recruiting</span>';
        return '<div class="pb-card" data-accent="' + s.accent + '" data-seq="' + s.id + '">' +
          '<div style="display:flex;align-items:center;gap:7px;margin-bottom:11px;flex-wrap:wrap">' + motChip + '<span class="pb-chip">📡 ' + esc(s.signal) + "</span></div>" +
          "<h3>" + esc(s.name) + "</h3>" +
          '<p class="pb-mission">' + esc(s.goal) + "</p>" +
          '<div class="pb-mini">' + chRow + "</div>" +
          '<span class="pb-go">' + s.touches.length + " touches · read the copy <span class=\"arr\">→</span></span></div>";
      }).join("");
      host.innerHTML = bar + '<div class="pb-grid">' + cards + "</div>";
    }

    function paintSeq(s) {
      var run = pbExpand(s);
      var chs = []; run.forEach(function (t) { if (chs.indexOf(t.ch) < 0) chs.push(t.ch); });
      var hasBranch = run.some(function (t) { return !!t.cond; });
      var motChip = s.motion === "bd"
        ? '<span class="pb-chip" style="color:var(--pb-c);border-color:rgba(77,208,255,.4)">🏢 Business Development</span>'
        : '<span class="pb-chip" style="color:var(--pb-g);border-color:rgba(56,224,166,.4)">👤 Recruiting</span>';
      var prevDay = 0;
      var items = run.map(function (t, i) {
        var m = PB_CH[t.ch];
        var wait = (i && !t.cond) ? ("wait " + Math.max(0, t.d - prevDay) + "d") : "";
        prevDay = t.d;
        var nv = pbTouchVariants(t).length;
        return { icon: m.icon, channel: m.label, accent: PB_CH_ACC[t.ch] || "v", day: "Day " + t.d,
          title: t.t, teaser: pbTouchTeaser(t), wait: wait, cond: t.cond,
          cta: nv > 1 ? ("Read · " + nv + " variants") : "Read the message" };
      });
      host.innerHTML =
        '<span class="pb-back" data-seqback="1"><span>←</span> Back to library</span>' +
        '<div style="display:flex;align-items:center;gap:7px;margin:14px 0 6px;flex-wrap:wrap">' + motChip +
          '<span class="pb-chip">📡 Trigger · ' + esc(s.signal) + '</span><span class="pb-chip">🎯 ' + esc(s.persona) + "</span>" +
          (hasBranch ? '<span class="pb-chip" style="color:var(--pb-a);border-color:rgba(255,194,77,.4)">⛓ if / then</span>' : "") + "</div>" +
        '<h2 style="margin:6px 0 2px;font-size:24px;font-weight:800;letter-spacing:-.02em">' + esc(s.name) + "</h2>" +
        '<div class="pb-mission-band" style="margin:14px 0 24px">' + esc(s.goal) + "</div>" +
        '<p class="pb-section-label">The sequence · ' + run.length + " steps across " + chs.length + " channels" + (hasBranch ? " · amber = conditional" : "") + "</p>" +
        pbBoard(items, "Scroll to follow the whole sequence · amber cards are if/then branches · click any step to read the exact message") +
        pbReplyCards(s.motion) +
        '<div class="pb-note" style="margin-top:6px"><span class="i">⚡</span><span><b>This is a template, not a script.</b> Point it at any hiring signal and the engine tailors every touch, the opener, the bullets, the timing, to that exact company, role and reason, then runs it. "Use this sequence on these signals" is one instruction.</span></div>';
    }

    function paint() {
      if (st.open) {
        var s = SEQS.filter(function (x) { return x.id === st.open; })[0];
        if (s) return paintSeq(s);
      }
      paintGrid();
    }
    paint();

    el.querySelector(".pb-wrap").addEventListener("click", function (e) {
      // Open/close a sequence via the hash so every sequence has a shareable URL
      // (#playbooks/sequences/<id>); the router re-renders us with the right state.
      if (e.target.closest("[data-seqback]")) { location.hash = "playbooks/sequences"; return; }
      var card = e.target.closest("[data-seq]"); if (card) { location.hash = "playbooks/sequences/" + card.getAttribute("data-seq"); return; }
      var go = e.target.closest("[data-go]"); if (go) { location.hash = go.getAttribute("data-go"); return; }
      var mot = e.target.closest("[data-mot]"); if (mot) { st.motion = mot.getAttribute("data-mot"); paint(); return; }
      var sqOpen = st.open ? SEQS.filter(function (x) { return x.id === st.open; })[0] : null;
      var rep = e.target.closest("[data-reply]");
      if (rep && sqOpen) { pbReplyModal(sqOpen.motion, rep.getAttribute("data-reply")); return; }
      var tch = e.target.closest(".pb-bcard");
      if (tch && sqOpen) {
        var t = pbExpand(sqOpen)[+tch.getAttribute("data-idx")];
        var m = PB_CH[t.ch];
        var sub = (t.cond ? "Branch" : "Day " + t.d) + " · " + m.label;
        pbOpenModal(m.icon, t.t, sub, pbTouchBody(t));
      }
    });
  }

  // Step through a flow's stages, lighting each node and revealing its output.
  function pbRun(wrap) {
    var btn = wrap.querySelector(".pb-run");
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="ic">●</span> Running…'; }
    // Works for both the vertical step flow (.pb-node) and the board canvas (.pb-bcard).
    var nodes = wrap.querySelectorAll(".pb-bcard, .pb-node");
    Array.prototype.forEach.call(wrap.querySelectorAll(".pb-stage"), function (s) { s.classList.remove("revealed"); });
    Array.prototype.forEach.call(nodes, function (n) { n.classList.remove("active", "done"); });
    var i = 0;
    (function step() {
      if (!document.body.contains(wrap)) return; // navigated away
      if (i > 0) { nodes[i - 1].classList.remove("active"); nodes[i - 1].classList.add("done"); }
      if (i >= nodes.length) { if (btn) { btn.disabled = false; btn.innerHTML = '<span class="ic">↻</span> Run again'; } return; }
      nodes[i].classList.add("active");
      var st = nodes[i].closest(".pb-stage"); if (st) st.classList.add("revealed");
      if (nodes[i].classList.contains("pb-bcard")) nodes[i].scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
      i++;
      setTimeout(step, 920);
    })();
  }
  // The five approaches, as a data table the gallery + deep views read from.
  function pbData() {
    var sigRow = function (dot, a, b) {
      return '<div class="pb-skel" style="display:flex;align-items:center;gap:12px">' +
        '<span style="width:9px;height:9px;border-radius:50%;flex:none;background:' + dot + ';box-shadow:0 0 10px ' + dot + '"></span>' +
        '<div style="flex:1"><div class="bar md" style="margin:0 0 7px"></div><div class="bar sm" style="margin:0"></div></div>' +
        '<span class="pb-chip">' + esc(a) + "</span><span class=\"pb-chip\">" + esc(b) + "</span></div>";
    };
    var candRow = function (pct, n) {
      return '<div class="pb-skel"><div style="display:flex;align-items:center;gap:10px;margin-bottom:9px">' +
        '<span style="width:30px;height:30px;border-radius:50%;flex:none;background:linear-gradient(135deg,#7c5cff,#4dd0ff)"></span>' +
        '<div style="flex:1"><div class="bar md" style="margin:0 0 6px"></div><div class="bar sm" style="margin:0"></div></div>' +
        '<b style="color:var(--pb-c);font-size:13px;font-family:monospace">' + pct + '%</b></div>' +
        '<div class="pb-meter"><span style="width:' + pct + '%"></span></div></div>';
    };
    var toggle = function (label, on) {
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0">' +
        '<span style="font-size:12px;color:var(--text-muted)">' + esc(label) + "</span>" +
        '<span style="width:34px;height:19px;border-radius:99px;position:relative;background:' + (on ? "linear-gradient(135deg,#7c5cff,#4dd0ff)" : "var(--border-strong)") + '">' +
        '<span style="position:absolute;top:2px;' + (on ? "right:2px" : "left:2px") + ';width:15px;height:15px;border-radius:50%;background:#fff"></span></span></div>';
    };

    return {
      "flip-the-script": {
        icon: "🔁", accent: "v", title: "Flip the Script", tag: "Business Development · candidate → prospect",
        oneLiner: "Reach out to a great person as a candidate, then flip them into a client when they're not moving but they are hiring.",
        mini: ["✉️", "🎙️", "🔀", "🎯"],
        board: true,
        mission: "Flip the Script is a BD play that starts as candidate outreach. You approach a strong, senior person about a role. The best ones usually are not moving, they are happy, or senior enough to be doing the hiring themselves. So you flip the script: turn the candidate into a prospect. They move from your Candidates pipeline into BD, and now you help them hire. Here it is worked end to end. Click any step to read the exact message.",
        extra:
          '<p class="pb-section-label">The flip</p>' +
          '<div class="pb-vs">' +
            '<div class="vs-card bad"><div class="vs-lbl">✕ Standard BD</div>' +
              '<div class="pb-bubble">"Hi, are you hiring? I place senior engineers. Open to a quick call?"</div>' +
              '<div class="vs-out">→ Ignored. Just another vendor.</div></div>' +
            '<div class="pb-vs-arrow">➜</div>' +
            '<div class="vs-card good"><div class="vs-lbl">✓ Flipped</div>' +
              '<div class="pb-bubble">Approached as a candidate about a VP role. He is not moving, but he is hiring. So: "Are you building your own team? That is exactly what I am best at."</div>' +
              '<div class="vs-out">→ A dead candidate thread becomes a client.</div></div>' +
          "</div>" +
          '<p class="pb-section-label">Candidate → Prospect, where it resides</p>' +
          pbArt("How it moves through RecruitersOS", null,
            '<div class="pb-list">' +
              '<div class="row"><span class="b c"></span>Starts in <b>Candidates</b>: you reach out about a role for them</div>' +
              '<div class="row"><span class="b a"></span>They are senior and happy, but clearly hiring for their own team</div>' +
              '<div class="row"><span class="b p"></span>The flip: promote <b>Candidate → Prospect</b>, into the BD motion</div>' +
              '<div class="row"><span class="b g"></span>Now you sell into their team: the MPC play takes over</div>' +
            "</div>") +
          '<div class="pb-note"><span class="i">▸</span><span>Even though the first touch is candidate-style, this whole sequence lives in the BD model, because the goal is a client, not a placement.</span></div>',
        stages: [
          { icon: "✉️", when: "DAY 0 · EMAIL", title: "Approach as a candidate",
            body: "Reach out about a role that would genuinely be a step up for them. Real, specific, flattering, and low-pressure.",
            out: "<b>SENT</b> · approached as a candidate for a VP Eng role",
            peek: { icon: "✉️", title: "Touch 1 · the candidate approach", sub: "Day 0 · Email · to Marcus Lee", cta: "Read the email",
              body: pbMail("From you · to Marcus Lee, Vela", "a VP Engineering seat that's a real step up",
                "Hi Marcus,\n\nI came across your work scaling the platform team at Vela, genuinely impressive. I'm working a VP Engineering role that's a real step up in scope, and that platform-scaling track record is exactly what it needs.\n\nI'm not pushing you to leave anything. Just worth a fifteen-minute look? If it's not for you, no harm at all.\n\nThanks,\n{you}") +
                '<div class="pb-note"><span class="i">▸</span><span>He enters as a Candidate. The opener is a real role, anchored to his actual work, not a pretext.</span></div>' } },
          { icon: "➕", when: "DAY 2 · LINKEDIN CONNECT", title: "Connect, referencing the role",
            body: "A short connection note that ties back to the email, so you become a familiar name.",
            out: "<b>REQUEST SENT</b> · 'emailed you about a VP Eng role'",
            peek: { icon: "➕", title: "Touch 2 · connection request", sub: "Day 2 · LinkedIn", cta: "Read the note",
              body: pbArt("LinkedIn connection note", null, pbIM("Hi Marcus, just emailed you about a VP Eng role that lines up with your platform work at Vela. Connecting here too, no pressure.")) } },
          { icon: "📱", when: "DAY 3 · SMS", accent: "a", title: "If the connect is still pending, a warm SMS",
            cond: "the LinkedIn connection is still pending",
            body: "A branch, not a step. Fires only if Marcus hasn't accepted by day 3. Warm, truthful, uses his previous company, and teases both angles, a role for him and help hiring.",
            out: "<b>IF</b> connect pending → warm SMS referencing {last_company}",
            peek: { icon: "📱", title: "Branch · warm SMS", sub: "fires only if the connect is still pending", cta: "Read the SMS",
              body: pbCondNote({ cond: "the LinkedIn connection is still pending", req: "last_company (from deep enrichment)" }) +
                pbArt("SMS · warm, last-company context", null, pbIM("Hi Marcus, this is {you} with {firm}. Came across your background from your time at {last_company}, figured I'd reach out directly. I've got a leadership role you might like, and either way I keep strong engineers warm. Worth a quick call?")) +
                '<div class="pb-note"><span class="i">📱</span><span>Truthful: references a real prior employer, no invented referral. Consent and local-time window enforced.</span></div>' } },
          { icon: "🎙️", when: "DAY 4 · LINKEDIN VOICE NOTE", accent: "p", title: "The flip: are you hiring?",
            body: "He's not moving, that's expected. So flip it in your own voice: pivot from recruiting him to helping him hire. This is the moment the candidate becomes a prospect.",
            out: "<b>THE FLIP</b> · he's not moving, but he's hiring → pivot to BD",
            peek: { icon: "🔀", title: "Touch 4 · the flip", sub: "Day 4 · voice note · candidate → prospect", cta: "Hear the flip",
              body: pbArt("Voice note · spoken in your cloned voice", null, '<div style="font-style:italic">' + pbNl("Hi Marcus, it's {you}... totally understand if a move isn't on your radar. Honestly I expected that, people running teams as well as you usually aren't looking. So let me flip it. Are you hiring on your own team right now? That's actually what I'm best at. I keep a bench of senior engineers warm, and I could line up a couple who'd fit what you're building at Vela. Worth a quick call either way? Thanks Marcus.") + "</div>") +
                '<div class="pb-note"><span class="i">🔀</span><span><b>Promotes Marcus from Candidates → Prospects (BD motion).</b> From here the sequence runs as business development.</span></div>' } },
          { icon: "✉️", when: "DAY 6 · EMAIL", title: "Now a prospect: someone for his team",
            body: "Having flipped, be useful the other way. Lead with one strong candidate for his team and ask what he's trying to fill.",
            out: "<b>FLIPPED</b> · candidate → prospect (BD) · now offering a candidate for his team",
            peek: { icon: "🎯", title: "Touch 5 · sell into his team", sub: "Day 6 · Email · now BD", cta: "Read the email",
              body: pbMail("From you · to Marcus Lee, Vela", "switching gears — someone for your team",
                "Hi Marcus,\n\nSince a move isn't the priority, let me be useful the other way. Here's a senior engineer worth your time as you scale the platform group:\n\n• Scaled a payments platform past ten thousand requests a second; deep in Go and event-driven systems\n• Passive, but would fit exactly what you're building\n\nYou're clearly hiring as Vela grows, and that's where I'm at my best. Worth fifteen minutes on what you're trying to fill this quarter?\n\nThanks,\n{you}") +
                '<div class="pb-note"><span class="i">🎯</span><span>The MPC play takes over: one standout candidate, one ask, aimed at his team.</span></div>' } },
          { icon: "📞", when: "DAY 9 · VOICEMAIL DROP", title: "BD follow-up, in your voice",
            body: "A short voicemail that follows up on the candidate you offered and asks for a few minutes on his hiring.",
            out: "<b>VOICEMAIL</b> · follow-up on the candidate offered",
            peek: { icon: "📞", title: "Touch 6 · voicemail drop", sub: "Day 9 · spoken in your cloned voice · ~0:16", cta: "Hear the voicemail",
              body: pbArt("Voicemail · spoken in your cloned voice", null, '<div style="font-style:italic">' + pbNl("Hi Marcus, it's {you} at {firm}. Quick follow-up on the engineer I sent for your team... strong, and won't be around long. I'd love five minutes on who you're hiring this quarter. Call me back when you can. Thanks.") + "</div>") +
                '<div class="pb-note"><span class="i">🛡️</span><span>Consent on file, inside his local-time window, dropped only after the voicemail beep.</span></div>' } },
          { icon: "✉️", when: "DAY 13 · EMAIL", title: "Leave the door open, both ways",
            body: "A clean close that keeps both doors open: the leadership role for him later, or help hiring for his team now.",
            out: "<b>SENT</b> · door open both ways",
            peek: { icon: "✉️", title: "Touch 7 · the close", sub: "Day 13 · Email", cta: "Read the email",
              body: pbMail("From you · to Marcus Lee, Vela", "I'll leave it with you",
                "Hi Marcus,\n\nI'll stop here. Whether it's the leadership role for you down the line, or help hiring for your team now, just reply and I'll jump on it.\n\nEither way, great work at Vela.\n\nThanks,\n{you}") } },
        ],
        wire: pbWireChrome("recruitersos · candidate → prospect",
          '<div style="display:flex;align-items:center;gap:14px;justify-content:center;flex-wrap:wrap">' +
            '<div class="pb-skel" style="text-align:center;min-width:160px"><div class="cap">Candidates</div><div style="font-size:13px;font-weight:600;margin-top:4px">Marcus · approached for a VP role</div></div>' +
            '<span style="color:var(--pb-p);font-size:20px;font-weight:800">🔀 FLIP</span>' +
            '<div class="pb-skel" style="text-align:center;min-width:160px;border-color:var(--pb-c)"><div class="cap" style="color:var(--pb-c)">Prospects · BD</div><div style="font-size:13px;font-weight:600;margin-top:4px">Now hiring for his own team</div></div>' +
          "</div>"),
        outcome: { em: "🔀", title: "A 'no' becomes a client.", text: "The best candidates rarely move, but they're often the ones doing the hiring. Flip the script and a dead candidate thread becomes a BD relationship." },
        cta: [["📚 Browse the Sequence Library", "playbooks/sequences"], ["🎯 Build a campaign", "campaigns"]],
      },

      "jd-sourcing": {
        icon: "🧲", accent: "c", title: "JD Sourcing", tag: "Recruiting",
        oneLiner: "A job description in. A ranked, real shortlist out, staged and ready to promote.",
        mini: ["📋", "🔍", "📊", "⬆️"],
        mission: "Paste a job description and get a ranked shortlist of real people, scored against the role with the reasons shown. No fabricated candidates, ever. Stage them under a name, then promote the best straight into your Candidates pipeline.",
        stages: [
          { icon: "📋", title: "Drop in a JD", auto: "you", title2: "", body: "Paste the job description or pick an open role. That text becomes the target the search and ranking are measured against." },
          { icon: "🔍", title: "Search runs", auto: "bot", body: "A people-search finds matching profiles, then a first-pass enrichment pass fills in the gaps automatically, so each result is a real, reachable person." },
          { icon: "📊", title: "Ranked and explained", auto: "bot", body: "Every candidate is scored against the JD with a match percentage and the reasons behind it, so you can trust the order, not just the list.",
            out: "<b>#1 · 94%</b> Maria Alvarez · Staff Backend Engineer · hits every must-have",
            peek: { icon: "📊", title: "Maria Alvarez · 94% match", sub: "ranked #1 of 168 · Staff Backend Engineer", cta: "Open a scored candidate",
              body: pbArt("Why this rank", ["ok", "STRONG"],
                '<div class="pb-sl"><span class="lab">7 yrs Go in production</span><span class="verdict pass">MUST ✓</span></div>' +
                '<div class="pb-sl"><span class="lab">Owned payments ledger · 12k rps · five nines</span><span class="verdict pass">MUST ✓</span></div>' +
                '<div class="pb-sl"><span class="lab">Kafka + Kubernetes</span><span class="verdict pass">NICE ✓</span></div>' +
                '<div class="pb-sl"><span class="lab">Remote (US)</span><span class="verdict pass">✓</span></div>') +
                pbKV([["Verified email", "m••••@•••.com", true], ["Source signal", "Open-to-work · 2 infra roles at her co"]]) +
                '<div class="pb-note"><span class="i">▸</span><span>Every candidate is a real, reachable person, scored against your JD. Nothing fabricated.</span></div>' } },
          { icon: "🗂️", title: "Staged under a name", auto: "you", body: "Save the shortlist as a named batch you can revisit, compare, and refine, without touching your live pipeline yet." },
          { icon: "⬆️", title: "Promote the best", auto: "you", body: "Move the strongest candidates into Candidates with one click, ready for outreach, vetting, or a campaign." },
        ],
        wire: pbWireChrome("recruitersos · jd sourcing", '<div class="pb-wire-cols">' +
          '<div class="pb-skel"><div class="cap">Job description</div><div class="bar lg"></div><div class="bar lg"></div><div class="bar md"></div><div class="bar lg"></div><div class="bar sm"></div><div style="margin-top:12px"><span class="pb-chip" style="background:linear-gradient(135deg,#7c5cff,#4dd0ff);color:#0a0a12;border:none">🔍 Find candidates</span></div></div>' +
          '<div style="display:grid;gap:12px"><div class="cap" style="font-size:11px;font-weight:700;color:var(--text-dim);letter-spacing:.08em;text-transform:uppercase">Ranked shortlist</div>' + candRow(94, 1) + candRow(88, 2) + candRow(81, 3) + "</div></div>"),
        outcome: { em: "⚡", title: "Hours of sourcing, compressed to minutes.", text: "A defensible, ranked shortlist of real people, every time, with the matching reasons in plain sight." },
        cta: [["🧲 Open JD Sourcing", "jdsourcing"], ["🗄️ See Candidates", "data"]],
      },

      "ai-vetting": {
        icon: "☎️", accent: "g", title: "AI Vetting", tag: "Recruiting",
        oneLiner: "Your cloned voice screens every candidate, around the clock, scored 1 to 100.",
        mini: ["🎙️", "🔢", "📨", "📈"],
        mission: "Bind a job description to a phone number and your cloned voice. Candidates opt in, call your line, and talk to an AI recruiter that sounds like you, it greets them by name, references their experience, asks your top qualifiers, and tells them the next step. Every call is recorded, transcribed, summarized, and scored 1 to 100.",
        stages: [
          { icon: "🎙️", title: "Build a vetting desk", auto: "you", body: "Attach the JD and your top three or four qualifiers, with what a pass looks like for each. This is the brief the AI recruiter screens against." },
          { icon: "🔢", title: "Bind a number and your voice", auto: "you", body: "Pick a real number from your Telnyx account and your consented cloned voice. The agent speaks the whole call in your voice." },
          { icon: "📨", title: "Candidates opt in", auto: "you", body: "Candidates consent, then call your line on their own time. No chasing, no scheduling tag, day or night." },
          { icon: "🤖", title: "The AI recruiter screens", auto: "bot", body: "It greets them by name, references their LinkedIn experience, asks your qualifiers, listens, and tells them the next step, sounding like you the whole way.",
            out: "<b>ON THE CALL</b> · greets by name · asks your 4 qualifiers · 6m 20s",
            peek: { icon: "🤖", title: "On the call", sub: "AI recruiter · your cloned voice", cta: "Read the transcript",
              body: pbArt("Transcript · excerpt", null, pbTrans([
                ["ai", "Alex", "Hi Maria, it's Alex from Northwind, thanks for calling in. You owned the ledger service, what kind of throughput were you running?"],
                ["cand", "Maria", "Peaked around twelve thousand requests a second, five nines of availability."],
                ["ai", "Alex", "And Go the whole way, or polyglot?"],
                ["cand", "Maria", "Go for the core, a little Rust on the hot path."],
                ["ai", "Alex", "Perfect. Last one, what's your timeline if an offer came together?"],
                ["cand", "Maria", "I could start in about four weeks."]
              ])) } },
          { icon: "📈", title: "Recorded, transcribed, scored", auto: "bot", body: "Each call comes back recorded, transcribed, summarized, and scored 1 to 100 against your qualifiers, so you only spend time on the ones worth it.",
            out: "<b>92 / 100</b> · Strong, advance to onsite · flag: prefers remote-first",
            peek: { icon: "📈", title: "Scored 92 / 100", sub: "auto-summarized · ready to book", cta: "See the score breakdown",
              body: '<div class="pb-art"><div class="pb-art-tag">Score<span class="pb-pill2 ok">92 / 100</span></div><div class="pb-art-body">' +
                '<div class="pb-bigscore"><span class="num">92</span><span class="of">/ 100 · Strong, advance to onsite</span></div>' +
                '<div class="pb-sl"><span class="lab">Q1 · 5+ yrs Go in production</span><span class="verdict pass">PASS</span></div>' +
                '<div class="pb-sl"><span class="lab">Q2 · Owned a service at scale</span><span class="verdict pass">PASS</span></div>' +
                '<div class="pb-sl"><span class="lab">Q3 · Comp in band ($180–220k)</span><span class="verdict pass">$195k</span></div>' +
                '<div class="pb-sl"><span class="lab">Q4 · Notice ≤ 6 weeks</span><span class="verdict pass">4 weeks</span></div>' +
                "</div></div>" +
                '<div style="margin-top:12px"><span class="pb-flag">⚑ Flag · prefers remote-first</span></div>' } },
        ],
        wire: pbWireChrome("recruitersos · ai vetting", '<div class="pb-wire-cols">' +
          '<div class="pb-skel"><div class="cap">Vetting desk</div><div class="bar md"></div>' +
            '<div style="margin-top:10px;display:grid;gap:8px">' +
            '<div style="display:flex;align-items:center;gap:8px"><span style="color:var(--pb-g)">✓</span><div class="bar md" style="flex:1;margin:0"></div><span class="pb-chip">must</span></div>' +
            '<div style="display:flex;align-items:center;gap:8px"><span style="color:var(--pb-g)">✓</span><div class="bar lg" style="flex:1;margin:0"></div></div>' +
            '<div style="display:flex;align-items:center;gap:8px"><span style="color:var(--pb-g)">✓</span><div class="bar sm" style="flex:1;margin:0"></div></div></div>' +
            '<div style="margin-top:12px"><span class="pb-chip">📞 +1 (415) •••</span> <span class="pb-chip">🎤 Your voice</span></div></div>' +
          '<div class="pb-skel"><div style="display:flex;align-items:center;justify-content:space-between"><div class="cap" style="margin:0">Call · scored</div><span class="pb-score">92</span></div>' +
            '<div class="pb-wave" style="margin:12px 0;height:30px">' +
              Array.apply(null, Array(18)).map(function (_, i) { var h = [8, 18, 26, 14, 22, 10, 28, 16, 6, 24, 12, 20, 9, 27, 15, 23, 11, 19][i]; return '<i style="height:' + h + 'px;animation-delay:' + (i * 0.06) + 's"></i>'; }).join("") +
            "</div><div class=\"bar lg\"></div><div class=\"bar lg\"></div><div class=\"bar md\"></div></div></div>"),
        outcome: { em: "🌙", title: "A screening recruiter that sounds like you, awake at 2am.", text: "Top candidates surface with a score and a transcript before you have had your coffee. The rest never eat your calendar." },
        cta: [["☎️ Open AI Vetting", "vetting"]],
      },

      "voice-drops": {
        icon: "📞", accent: "a", title: "Voice Drops", tag: "Recruiting + BD",
        oneLiner: "A personal voicemail, in your own voice, at scale, with consent and timezone guardrails.",
        mini: ["✍️", "🎤", "🛡️", "📥"],
        mission: "Leave a warm, personal voicemail in your own cloned voice on landlines and VoIP lines, at scale. Premium answering-machine detection drops it only when the voicemail picks up, and consent plus per-lead timezone windows keep every drop respectful and compliant.",
        stages: [
          { icon: "✍️", title: "Write the script", auto: "you", body: "Drafted for natural speech: short sentences, a beat where it matters, your name and theirs. The same script, personalized per lead.",
            out: "<b>SCRIPT</b> · 0:18 · formatted for natural speech in your voice",
            peek: { icon: "✍️", title: "The voicemail script", sub: "spoken in your cloned voice · 0:18", cta: "Read the spoken script",
              body: pbArt("Script · as spoken", null, '<div style="font-style:italic">' + pbNl("Hi Maria, it's Alex. I saw your work on payments infrastructure... and I think you'd be a great fit for a role I'm filling. No pressure at all. If you're curious, give me a call back. Thanks, and have a good one.") + "</div>") +
                '<div class="pb-note"><span class="i">🎤</span><span>Formatted for natural speech: short sentences, a beat on the ellipsis, your name and theirs. Premium AMD drops it only after the beep.</span></div>' } },
          { icon: "🎤", title: "Your cloned voice renders it", auto: "bot", body: "One consented voice clone speaks every drop, so a thousand voicemails still sound like you picked up the phone for each one." },
          { icon: "🛡️", title: "Guardrails check first", auto: "bot", body: "A consent gate, a per-lead timezone window, and a mobile-strip so it only lands where it should, when it should. Never an evasion, always above board." },
          { icon: "📞", title: "Premium AMD detects voicemail", auto: "bot", body: "The call connects and listens. It drops the message only once the voicemail greeting finishes, never while a person is on the line." },
          { icon: "📥", title: "It lands as a voicemail", auto: "bot", body: "No ring, no interruption. They see a missed voicemail in your voice, on their schedule, and call back warm." },
        ],
        wire: pbWireChrome("recruitersos · voice drops", '<div class="pb-wire-cols">' +
          '<div class="pb-skel"><div class="cap">Script · spoken in your voice</div><div class="bar lg"></div><div class="bar lg"></div><div class="bar md"></div>' +
            '<div style="margin-top:14px" class="cap">Guardrails</div>' + toggle("Consent on file", true) + toggle("Timezone window 9a–6p", true) + toggle("Mobile-strip", true) + "</div>" +
          '<div style="display:grid;place-items:center"><div class="pb-phone"><div class="notch"></div>' +
            '<div class="pb-vm"><span class="play">▶</span><div style="flex:1"><div class="pb-wave">' +
              Array.apply(null, Array(14)).map(function (_, i) { return '<i style="height:' + [6, 16, 22, 12, 20, 9, 18, 14, 24, 10, 19, 13, 21, 8][i] + 'px;animation-delay:' + (i * 0.07) + 's"></i>'; }).join("") +
            '</div></div><span style="font-size:11px;color:var(--text-dim);font-family:monospace">0:18</span></div>' +
            '<div style="text-align:center;font-size:11px;color:var(--text-dim);margin-top:10px">Voicemail · your voice</div></div></div></div>'),
        outcome: { em: "💜", title: "The intimacy of a personal voicemail, at the scale of a campaign.", text: "People call back a voice, not a template. And every drop stays consented, timed, and respectful." },
        cta: [["📞 Open Voice Drops", "voicedrops"]],
      },

      "campaign-models": {
        icon: "🎯", accent: "p", title: "Campaign Models", tag: "The daily loop",
        oneLiner: "The morning loop that runs your outreach for you, multi-channel, in your voice, on approval.",
        mini: ["📡", "📊", "✍️", "🚀"],
        mission: "A campaign is a standing instruction, not a one-off blast. Every morning it pulls fresh signals, scores and dedupes them, finds the right contacts, drafts a multi-channel touch in your voice, waits for your approval, then sends, and processes replies all day. You run a desk; the loop does the legwork.",
        stages: [
          { icon: "📡", when: "07:00", auto: "bot", title: "Pull signals", body: "Every active campaign runs its enabled signal sources for the last 24 hours, the fresh reasons to reach out today.",
            out: "<b>12 signals</b> pulled · funding, reposts, exec hires" },
          { icon: "📊", when: "07:15", auto: "bot", title: "Score, rank, dedupe", body: "A composite score per ICP, disqualifiers suppressed, deduped against your ATS. Only the top N for the day advance.",
            out: "<b>14 advanced</b> · top N by ICP score · 1 ATS duplicate suppressed" },
          { icon: "🔎", when: "07:30", auto: "bot", title: "Enrich", body: "An enrichment waterfall resolves the right contact and channel for each prospect that made the cut.",
            out: "<b>contacts resolved</b> · Director of Eng · verified email + LinkedIn" },
          { icon: "✍️", when: "07:45", auto: "bot", title: "Draft, multi-channel", body: "Claude drafts the email, the LinkedIn message, and the voice note per prospect, with your A/B variants applied, every line tied to the real signal.",
            out: "<b>3 drafts</b> · email + LinkedIn + voice note · variant A applied",
            peek: { icon: "✍️", title: "One prospect, three channels", sub: "variant A · touch 1 · drafted 07:45", cta: "See all three drafts",
              body: pbArt("Email", ["ok", "A"], pbMail("From you · to {first}", "the Go backend repost", "Hi {first}, saw the backend role is back up after the Series B. I've got two Go engineers who've scaled payments past ten thousand requests a second and aren't on the market. Worth a look this week?")) +
                pbArt("LinkedIn message", null, pbIM("{first} — quick one. The Go role's back open; I've got two people who fit your stack and aren't applying anywhere. Want me to send them?")) +
                pbArt("Voice note · your voice", null, '<div style="font-style:italic">' + pbNl("Hey {first}, it's Alex... saw the backend role reopened. I've got a couple of people in mind. No pressure, reply if you want the profiles. Thanks.") + "</div>") +
                '<div class="pb-note"><span class="i">▸</span><span>Same prospect, same signal, three channels, your voice, A/B variant applied, then it waits for your approval.</span></div>' } },
          { icon: "✅", when: "08:30", auto: "you", title: "You approve the batch", body: "Fifteen minutes: edit, kill, or approve the queue, and record the HOT-tier voice notes. Or flip on Autopilot and skip it entirely.",
            out: "<b>approved</b> in 12 min · or auto-approved on Autopilot" },
          { icon: "🚀", when: "09:00", auto: "bot", title: "Push to channels", body: "Emails, LinkedIn, and SMS go out on their channels, every send stamped with its campaign, variant, and touch, then replies route through Response all day.",
            out: "<b>sent</b> · stamped campaign=go-backend-q2 · variant=A · touch=1" },
        ],
        wire: pbWireChrome("recruitersos · campaign · multi-channel sequence", '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:center">' +
          [["Day 0", "✉️ Email"], ["Day 2", "in LinkedIn DM"], ["Day 3", "🎙️ Voice note"], ["Day 5", "📞 Voicemail drop"], ["Day 7", "💬 SMS"]].map(function (s, i) {
            return (i ? '<span style="color:var(--pb-c);font-size:16px">→</span>' : "") +
              '<div class="pb-skel" style="text-align:center;min-width:108px"><div class="pb-when" style="margin-bottom:6px">' + esc(s[0]) + '</div><div style="font-size:13px;font-weight:600">' + esc(s[1]) + "</div></div>";
          }).join("") + "</div>"),
        outcome: { em: "🔁", title: "Set the desk once. It runs every morning.", text: "Signal-led, multi-channel, in your voice, and either approved in minutes or fully hands-off on Autopilot." },
        cta: [["📚 Browse the Sequence Library", "playbooks/sequences"], ["🎯 Build a campaign", "campaigns"], ["🤖 Autopilot", "autopilot"]],
      },
    };
  }

  function renderPlaybooks(el) {
    var DATA = pbData();
    var detail = currentDetail();
    if (detail === "sequences") return pbSeqLibrary(el);
    if (detail && DATA[detail]) return pbDetail(el, DATA, detail);

    // ---- Gallery ----
    var order = ["flip-the-script", "jd-sourcing", "ai-vetting", "voice-drops", "campaign-models"];
    var cards = order.map(function (k) {
      var p = DATA[k];
      var mini = p.mini.map(function (m, i) {
        return (i ? '<span class="ar">→</span>' : "") + '<span class="n">' + m + "</span>";
      }).join("");
      return '<div class="pb-card" data-accent="' + p.accent + '" data-pb="' + k + '">' +
        '<div class="pb-ico">' + p.icon + "</div>" +
        "<h3>" + esc(p.title) + "</h3>" +
        '<p class="pb-mission">' + esc(p.oneLiner) + "</p>" +
        '<div class="pb-mini">' + mini + "</div>" +
        '<span class="pb-go">See the workflow <span class="arr">→</span></span></div>';
    }).join("");
    // Featured sixth card: the Sequence Library (16 real outbound workflows).
    var seqCount = PB_SEQS().length;
    cards +=
      '<div class="pb-card" data-accent="g" data-pb="sequences">' +
        '<div class="pb-ico">📚</div>' +
        "<h3>Sequence Library</h3>" +
        '<p class="pb-mission">' + esc(seqCount + " ready outbound workflows for Recruiting and BD. Every touch written out, across email, LinkedIn, voice notes, voicemail drops and SMS, real copy.") + "</p>" +
        '<div class="pb-mini"><span class="n">✉️</span><span class="ar">→</span><span class="n">💬</span><span class="ar">→</span><span class="n">🎙️</span><span class="ar">→</span><span class="n">📞</span></div>' +
        '<span class="pb-go">Browse the library <span class="arr">→</span></span></div>';

    el.innerHTML =
      '<div class="pb-wrap">' +
        '<div class="pb-hero">' +
          '<span class="pb-eyebrow"><span class="dot"></span>The vision, seen</span>' +
          "<h2>How RecruitersOS works.</h2>" +
          "<p>One idea, six ways to see it: stop interrupting strangers, start arriving at the right moment with a real reason. Open any workflow to watch it run step by step, then click a step to see the exact content it produces.</p>" +
        "</div>" +
        '<div class="pb-grid">' + cards + "</div>" +
      "</div>";

    el.querySelector(".pb-wrap").addEventListener("click", function (e) {
      var c = e.target.closest("[data-pb]");
      if (c) { location.hash = "playbooks/" + c.getAttribute("data-pb"); }
    });
  }

  function pbDetail(el, DATA, key) {
    var p = DATA[key];
    var hasPeeks = p.stages.some(function (s) { return !!s.peek; });
    var cta = (p.cta || []).map(function (b) {
      var route = b[1];
      // Only offer routes this user/motion can actually reach; otherwise drop it.
      if (ROUTES[route] && ROUTES[route].cap && !can(ROUTES[route].cap)) return "";
      return '<button class="btn btn-ghost btn-sm" data-go="' + esc(route) + '">' + esc(b[0]) + "</button>";
    }).join("");

    // Board layout (Miro-style canvas) for sequence-shaped playbooks; vertical
    // step flow for the conceptual ones.
    var flowHtml;
    if (p.board) {
      var prevDay = 0;
      var items = p.stages.map(function (s, i) {
        var parts = String(s.when || "").split("·");
        var day = (parts[0] || "").trim();
        var channel = (parts[1] || "").trim();
        var dnum = parseInt((day.match(/\d+/) || [0])[0], 10);
        var wait = (i && !s.cond) ? ("wait " + Math.max(0, dnum - prevDay) + "d") : "";
        prevDay = dnum;
        var chl = channel.toLowerCase();
        var acc = s.accent || (chl.indexOf("voice note") >= 0 ? "p" : chl.indexOf("voicemail") >= 0 ? "a" : chl.indexOf("sms") >= 0 ? "g" : (chl.indexOf("linkedin") >= 0 || chl.indexOf("connect") >= 0) ? "c" : "v");
        return { icon: s.icon, channel: channel, day: day, accent: acc,
          title: s.title, teaser: pbStripTags(s.out) || s.body, wait: wait, cond: s.cond,
          cta: s.peek ? (s.peek.cta || "Read the message") : "" };
      });
      flowHtml = pbBoard(items, "Scroll to follow the whole sequence · amber cards are if/then branches · click any step to read the exact message");
    } else {
      flowHtml = '<div class="pb-flow">' + p.stages.map(pbStage).join("") + "</div>";
    }

    el.innerHTML =
      '<div class="pb-wrap">' +
        '<span class="pb-back" data-go="playbooks"><span>←</span> All playbooks</span>' +
        '<div class="pb-d-head"><div class="pb-ico">' + p.icon + "</div>" +
          '<div><div class="pb-tag">' + esc(p.tag) + "</div><h2>" + esc(p.title) + "</h2></div></div>" +
        '<div class="pb-mission-band">' + esc(p.mission) + "</div>" +
        (p.extra || "") +
        // Board playbooks are self-explanatory (each card shows its channel, day
        // and a "read the message" affordance), so they skip the section header
        // and the run/tip chrome. Vertical concept flows keep a plain heading.
        (p.board ? "" :
          '<p class="pb-section-label">' + esc(p.flowLabel || "The workflow") + "</p>" +
          '<div class="pb-runbar"><button class="pb-run"><span class="ic">▶</span> Watch it run</button></div>') +
        flowHtml +
        // Sequence-shaped (board) playbooks get the live reply intelligence too.
        (p.board ? pbReplyCards(p.motion || "bd") : "") +
        '<p class="pb-section-label">What it looks like</p>' +
        p.wire +
        '<div class="pb-outcome"><span class="em">' + p.outcome.em + "</span>" +
          "<div><b>" + esc(p.outcome.title) + "</b><span>" + esc(p.outcome.text) + "</span></div></div>" +
        (cta ? '<div class="pb-d-cta">' + cta + "</div>" : "") +
      "</div>";

    var wrap = el.querySelector(".pb-wrap");
    wrap.addEventListener("click", function (e) {
      if (e.target.closest(".pb-run")) { pbRun(wrap); return; }
      var go = e.target.closest("[data-go]"); if (go) { location.hash = go.getAttribute("data-go"); return; }
      var rep = e.target.closest("[data-reply]");
      if (rep) { pbReplyModal(p.motion || "bd", rep.getAttribute("data-reply")); return; }
      var node = e.target.closest("[data-stage], .pb-bcard");
      if (node) {
        var idx = node.hasAttribute("data-stage") ? +node.getAttribute("data-stage") : +node.getAttribute("data-idx");
        var pk = p.stages[idx] && p.stages[idx].peek;
        if (pk) pbOpenModal(pk.icon, pk.title, pk.sub, pk.body);
      }
    });
  }

  function renderResponse(el) {
    var active = "all";
    el.innerHTML = head("Response, the unified inbox",
      "Every reply across email, LinkedIn and SMS, auto-classified by AI and routed by deterministic rules. Hottest first.");
    var filter = document.createElement("div");
    filter.className = "chan-filter";
    ["all", "email", "linkedin", "sms"].forEach(function (c) {
      filter.innerHTML += '<span class="cf ' + (c === "all" ? "active" : "") + '" data-c="' + c + '">' + (c === "all" ? "All channels" : c.toUpperCase()) + "</span>";
    });
    el.appendChild(filter);
    var listWrap = document.createElement("div");
    el.appendChild(listWrap);

    var inbox = [];        // loaded from the API
    var loaded = false;
    function paint() {
      if (!loaded) { listWrap.innerHTML = loading(); return; }
      var items = inbox.filter(function (r) { return active === "all" || r.channel === active; });
      listWrap.innerHTML = items.map(respItem).join("") ||
        '<div class="empty">No replies' + (active === "all" ? "" : " on " + active) + " yet. As your campaigns run, every reply lands here, auto-classified.</div>";
    }
    filter.addEventListener("click", function (e) {
      var cf = e.target.closest(".cf"); if (!cf) return;
      active = cf.dataset.c;
      Array.prototype.forEach.call(filter.children, function (x) { x.classList.toggle("active", x === cf); });
      paint();
    });
    paint();

    function load() {
      api("/response/list").then(function (d) {
        inbox = ((d && d.items) || []).map(mapProcessed);
        loaded = true; paint(); wireActions();
      }).catch(function () { loaded = true; paint(); });
    }
    load();

    // Working inbox actions: Book / Suppress persist via the API and reload.
    function wireActions() {
      Array.prototype.forEach.call(listWrap.querySelectorAll("[data-act]"), function (btn) {
        btn.addEventListener("click", function () {
          var act = btn.getAttribute("data-act"), pid = btn.getAttribute("data-pid");
          if (!pid) { toast("This reply isn't linked to a prospect yet."); return; }
          btn.disabled = true;
          send("/response/actions", "POST", { action: act, prospectId: pid })
            .then(function (r) {
              if (r.ok) { toast(act === "book" ? "Marked booked" : "Suppressed (do-not-contact)"); load(); refreshBadge(); }
              else { toast("Could not " + act + " (" + (r.data.error || r.status) + ")"); btn.disabled = false; }
            }).catch(function () { toast("Could not reach the server."); btn.disabled = false; });
        });
      });
    }

    // rules matrix (product reference: how every reply is classified + routed)
    var rows = REF.rules.map(function (r) {
      return "<tr><td><span class=\"cls cls-" + r.cls + "\">" + esc(r.label) + "</span></td>" +
        "<td>" + r.triggers.map(esc).join(", ") + "</td>" +
        '<td class="acts">' + r.actions.map(esc).join(" → ") + "</td>" +
        '<td><span class="sla">' + esc(r.sla) + "</span></td></tr>";
    }).join("");
    var matrix = document.createElement("div");
    matrix.className = "card";
    matrix.style.marginTop = "18px";
    matrix.innerHTML = "<h3>Classification &amp; routing rules</h3><div style=\"overflow:auto\"><table class=\"matrix\"><thead><tr><th>Class</th><th>Triggers</th><th>System action</th><th>SLA</th></tr></thead><tbody>" + rows + "</tbody></table></div>";
    el.appendChild(matrix);
  }

  function respItem(r) {
    var pid = r.prospectId ? ' data-pid="' + esc(r.prospectId) + '"' : "";
    return '<div class="resp-item"><div class="resp-top">' +
      '<span class="avatar" style="background:' + colorFor(r.name) + '">' + esc(initials(r.name)) + "</span>" +
      '<div><div class="resp-name">' + esc(r.name) + '</div><div class="resp-chan">' + esc(r.channel) + " · " + esc(r.source) + "</div></div>" +
      '<span class="cls cls-' + r.cls + '">' + esc(clsLabel(r.cls)) + "</span></div>" +
      '<div class="resp-text">"' + esc(r.text) + '"</div>' +
      '<div class="resp-actions">' + r.actions.map(function (a) { return '<span class="resp-act">' + esc(a) + "</span>"; }).join("") +
      '<button class="resp-btn" data-act="book"' + pid + '>📅 Book</button>' +
      '<button class="resp-btn ghost" data-act="suppress"' + pid + '>🚫 Suppress</button>' +
      "</div></div>";
  }

  /* ---------------- In-Market Leads (BD: who is hiring right now) ------------ */
  var inMarketResults = [];      // last search results (full lead objects)
  var imMode = "industry";       // "industry" | "company"
  var imSelectedIndustries = []; // multi-select industries
  var imSearchTimer = null;      // debounce for chip-driven searches
  var imMinScore = 0;            // narrow-down: minimum hiring-intent score shown
  var imPostedWithin = 0;        // date search: only roles posted within the last N days (0 = any)
  var imDmPerRole = 3;           // decision-makers shown per role (1 / 3 / 5), defaults to 3 for multi-touch
  var imSelectedSizes = [];      // company headcount bands to narrow by (multi-select)
  var imConfirmedSizeOnly = false; // size search: only authoritative (Wikidata) headcounts
  var imLabel = "";             // current result label, kept for re-renders
  var imTotal = 0;              // total companies available for this query in the pool (grows daily)
  var imStats = null;          // accumulation activity (added today, total, daily log)
  var imPicks = {};             // key -> { lead, manager } selected to push to Prospects

  // Industries + sub-sectors recruiters sell into. Drives the refined in-market search.
  // (Free job-board coverage is strongest for the tech-adjacent rows; traditional
  // verticals post on Workday/Taleo/iCIMS, so those return fewer free results, a paid
  // data feed fills them out. See the note rendered above the chips.)
  var IM_INDUSTRIES = [
    "Technology / SaaS", "AI / Machine Learning", "Cybersecurity", "Data / Analytics",
    "DevOps / Cloud", "Hardware / IoT", "Semiconductors", "Robotics", "Gaming",
    "Fintech", "Banking", "Insurance", "Investment / PE / VC", "Crypto / Web3",
    "Healthcare", "Biotech / Pharma", "Medical Devices", "Hospitals / Health Systems",
    "Manufacturing", "Aerospace / Defense", "Automotive", "Industrial / Automation",
    "Energy", "Oil & Gas", "Renewables / CleanTech", "Utilities", "Mining / Metals",
    "Construction", "Architecture / Engineering", "Real Estate", "PropTech",
    "Logistics / Supply Chain", "Freight / Transportation", "Warehousing",
    "Retail / eCommerce", "Consumer Goods (CPG)", "Fashion / Apparel", "Food & Beverage",
    "Agriculture / AgTech", "Hospitality", "Travel / Tourism", "Media / Entertainment",
    "Telecom", "Education", "EdTech", "Legal", "Accounting / Tax", "Consulting",
    "Marketing / Agency", "HR / Staffing", "Sales / GTM", "Government / Public", "Nonprofit"
  ];
  var IM_PLACEHOLDER = {
    industry: "Search an industry or market, e.g. fintech, healthcare, manufacturing",
    company: "Search a company by name, e.g. Stripe, Verla Health, Brightwave",
    title: "Search by job title (keywords), e.g. controller, backend engineer, account executive"
  };

  // Hiring-signal types you can filter the search by (company-side). Pulled from the
  // engine's signal catalog; these are what the free/open sources can surface.
  var IM_SIGNALS = [
    { t: "job_posting", l: "📋 New job posting" },
    { t: "hiring_velocity", l: "📈 Hiring surge" },
    { t: "job_repost", l: "🔁 Role reposted" },
    { t: "evergreen_role", l: "⏳ Long-open role" },
    { t: "headcount_growth", l: "👥 Headcount growth" },
    { t: "careers_page_launch", l: "🌐 Careers page launched" },
    { t: "ats_detected", l: "🧩 ATS adopted" },
    { t: "funding_round", l: "💰 Funding round" },
    { t: "ipo_or_s1", l: "🏛️ IPO / S-1" },
    { t: "acquisition", l: "🤝 Acquisition" },
    { t: "merger", l: "🔗 Merger" },
    { t: "revenue_milestone", l: "📊 Revenue milestone" },
    { t: "grant_or_contract", l: "📜 Grant / contract win" },
    { t: "exec_hire", l: "👔 New exec" },
    { t: "department_head_change", l: "🧭 New function lead" },
    { t: "exec_departure", l: "🚪 Exec departure" },
    { t: "board_change", l: "🪑 Board change" },
    { t: "office_expansion", l: "🏢 Expansion" },
    { t: "market_entry", l: "🌍 New market" },
    { t: "product_launch", l: "🚀 Product launch" },
    { t: "partnership", l: "🤝 Partnership" },
    { t: "tech_stack_change", l: "🛠️ Tech adoption" },
    { t: "layoff", l: "📉 Layoff" },
    { t: "warn_notice", l: "⚠️ WARN notice" }
  ];
  var imSelectedSignals = [];   // selected SignalType keys to filter the search by
  var imBreakdown = [];         // [{signalType,count}] over the full matched set (the "why they're hiring" counts)
  var imNeeds = [];             // [{function,label,companies,roles}] — "what they're hiring for"
  var imNeedFn = "";            // active "what they're hiring for" category filter (JobFunction)
  // A copyable, clearly-unverified best-guess email chip. Empty string when there's no guess
  // (no resolved name or no company domain yet — we never fabricate an address).
  function imEmailChip(email, pattern) {
    if (!email) return "";
    var t = "Best-guess work email — syntax only, UNVERIFIED. Every address is validated before any send." + (pattern ? " (pattern: " + pattern + ")" : "");
    return '<span class="im-mgr-email" title="' + esc(t) + '" data-email="' + esc(email) + '">✉️ ' + esc(email) +
      ' <span class="im-email-unv">guess</span></span>';
  }
  // SignalType -> human label (reuse the filter-chip labels), else prettify the key.
  function imSignalLabel(t) {
    for (var i = 0; i < IM_SIGNALS.length; i++) if (IM_SIGNALS[i].t === t) return IM_SIGNALS[i].l;
    return String(t || "other").replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  // The "Why they're hiring" panel: a count next to each actual signal + the total.
  function imBreakdownHtml() {
    var b = imBreakdown || [];
    if (!b.length) return "";
    var total = b.reduce(function (s, x) { return s + x.count; }, 0);
    var max = b.reduce(function (m, x) { return Math.max(m, x.count); }, 0) || 1;
    var rows = b.slice(0, 16).map(function (x) {
      var w = Math.max(Math.round((x.count / max) * 100), 5);
      return '<div style="display:flex;align-items:center;gap:10px;margin:5px 0;font-size:12.5px">' +
        '<span style="flex:0 0 210px;color:var(--text-muted)">' + esc(imSignalLabel(x.signalType)) + "</span>" +
        '<span style="flex:1;height:14px;background:var(--surface-2);border-radius:6px;overflow:hidden"><span style="display:block;height:100%;width:' + w + '%;background:var(--grad);border-radius:6px"></span></span>' +
        '<span style="flex:0 0 56px;text-align:right;font-weight:700">' + x.count.toLocaleString() + "</span></div>";
    }).join("");
    var more = b.length > 16 ? '<div class="muted" style="font-size:11px;margin-top:4px">+' + (b.length - 16) + " more reasons</div>" : "";
    return '<div style="border:1px solid var(--border);border-radius:14px;background:var(--surface);padding:16px 18px;margin:14px 0">' +
      '<div style="font-weight:700;margin-bottom:8px">Why they’re hiring <span class="muted" style="font-weight:500;font-size:12px">· ' +
        total.toLocaleString() + " signals across " + b.length + " reason" + (b.length === 1 ? "" : "s") + "</span></div>" +
      rows + more + "</div>";
  }
  // The "What they're hiring for" panel: the SPECIFIC hiring-need categories (by function)
  // behind this result set, each with the number of companies hiring for it AND the total open
  // roles. This is the actionable complement to "Why they're hiring" — it tells you which desk
  // to pitch. Clicking a category narrows the search to that function's roles.
  function needsBreakdownHtml() {
    var n = imNeeds || [];
    if (!n.length) return "";
    var maxC = n.reduce(function (m, x) { return Math.max(m, x.companies); }, 0) || 1;
    var totC = n.reduce(function (s, x) { return s + x.companies; }, 0);
    var totR = n.reduce(function (s, x) { return s + x.roles; }, 0);
    var rows = n.map(function (x) {
      var w = Math.max(Math.round((x.companies / maxC) * 100), 5);
      var active = imNeedFn === x.function;
      return '<button type="button" class="im-need-row' + (active ? " active" : "") + '" data-fn="' + esc(x.function) + '" title="Show only roles in ' + esc(x.label) + '">' +
        '<span class="im-need-lbl">' + esc(x.label) + "</span>" +
        '<span class="im-need-bar"><span style="width:' + w + '%"></span></span>' +
        '<span class="im-need-num"><b>' + x.companies.toLocaleString() + "</b> cos · " + x.roles.toLocaleString() + " roles</span></button>";
    }).join("");
    return '<div class="im-needs">' +
      '<div class="im-needs-h">What they’re hiring for <span class="muted">· ' + totR.toLocaleString() + " open roles across " + n.length + " need" + (n.length === 1 ? "" : "s") +
        (imNeedFn ? ' · <button type="button" class="im-need-clear" data-fn="">clear filter</button>' : "") + "</span></div>" +
      '<div class="im-needs-grid">' + rows + "</div></div>";
  }
  // Annotate EVERY signal FILTER chip with its live count, e.g. "💰 Funding round (12)" — and
  // "(0)" when none, so you can read the whole distribution at a glance and know which signals
  // to target. Chips with zero are dimmed; chips with hits are emphasized.
  function imUpdateSigChipCounts() {
    var counts = {};
    (imBreakdown || []).forEach(function (x) { counts[x.signalType] = x.count; });
    Array.prototype.forEach.call(document.querySelectorAll(".im-sigchip"), function (c) {
      var t = c.getAttribute("data-sig"); var n = counts[t] || 0;
      c.textContent = imSignalLabel(t) + " (" + n.toLocaleString() + ")";
      c.classList.toggle("im-sig-zero", n === 0);
      c.classList.toggle("im-sig-has", n > 0);
    });
  }

  function imPickKey(leadId, role) { return leadId + "::" + (role || "__company"); }
  // Unique key per hiring-manager option (role + manager title), so the two managers we
  // surface for a role can be selected independently.
  function imMgrKey(m) { return (m && m.role ? m.role : "") + "||" + (m && m.managerTitle ? m.managerTitle : ""); }
  // Company size bands (matches the backend headcountBand type) for the size-narrowing chips.
  var IM_SIZES = [
    { v: "1-10", l: "1-10" }, { v: "11-50", l: "11-50" }, { v: "51-200", l: "51-200" },
    { v: "201-500", l: "201-500" }, { v: "501-1000", l: "501-1K" },
    { v: "1001-5000", l: "1K-5K" }, { v: "5000+", l: "5K+" }
  ];
  // The decision-makers to show for a lead, grouped by role and sliced to imDmPerRole each,
  // so the 1/3/5 control gives one-click multi-touch without re-fetching. Order is preserved
  // (most-direct manager first), so "1" = the closest owner, "5" = the full ladder + recruiter.
  function imRoleManagers(l) {
    var all = (l && l.hiringManagers && l.hiringManagers.length) ? l.hiringManagers : null;
    if (!all) return null;
    var byRole = {}, order = [], out = [];
    all.forEach(function (m) {
      var r = m.role || "";
      if (!byRole[r]) { byRole[r] = []; order.push(r); }
      byRole[r].push(m);
    });
    order.forEach(function (r) { out = out.concat(byRole[r].slice(0, imDmPerRole)); });
    return out;
  }
  function imFindLead(id) { return inMarketResults.find(function (x) { return x.id === id; }); }
  function imVisibleLeads() {
    return inMarketResults.filter(function (l) {
      if (Math.round(l.score || 0) < imMinScore) return false;
      // "What they're hiring for" filter: keep only companies hiring for the chosen function.
      if (imNeedFn && !(l.needFunctions && l.needFunctions.indexOf(imNeedFn) >= 0)) return false;
      return true;
    });
  }

  function renderInMarket(el) {
    imPicks = {}; imMinScore = 0; imSelectedSignals = []; imSelectedIndustries = []; imSelectedSizes = []; imBreakdown = []; imNeeds = []; imNeedFn = "";
    el.innerHTML =
      '<div class="im-hero">' +
        '<div class="im-bar">' +
          '<h1 class="im-title">Who\'s hiring <span class="gradient-text">right now.</span></h1>' +
          '<div class="im-modes" id="imModes">' +
            '<button type="button" class="im-mode active" data-mode="industry">Industry / market</button>' +
            '<button type="button" class="im-mode" data-mode="company">Company name</button>' +
            '<button type="button" class="im-mode" data-mode="title">Job title</button>' +
          "</div>" +
        "</div>" +
        '<form class="im-search" id="imForm">' +
          '<span class="ico">⌕</span>' +
          '<input id="imQuery" type="text" autocomplete="off" placeholder="' + esc(IM_PLACEHOLDER[imMode]) + '" />' +
          '<button type="submit" class="btn btn-primary" id="imSearchBtn">Find companies</button>' +
        "</form>" +
        // Date search, filter to freshly-posted roles for warmer, more targeted outreach.
        '<div class="im-daterow">' +
          '<span class="im-datelbl">📅 Posted within</span>' +
          '<select id="imPosted" class="im-date">' +
            [["0", "Any time"], ["1", "Last 24 hours"], ["3", "Last 3 days"], ["7", "Last 7 days"], ["14", "Last 14 days"], ["30", "Last 30 days"]]
              .map(function (o) { return '<option value="' + o[0] + '"' + (String(imPostedWithin) === o[0] ? " selected" : "") + ">" + o[1] + "</option>"; }).join("") +
          "</select>" +
          '<button type="button" class="btn btn-primary btn-sm" id="imPostedGo">Search this range</button>' +
          '<span class="im-datehint muted">Fresher posts = warmer outreach</span>' +
        "</div>" +
        // Company size, narrow by headcount band (multi-select chips). Click to refine.
        '<div class="im-daterow im-sizerow">' +
          '<span class="im-datelbl">👥 Company size</span>' +
          IM_SIZES.map(function (s) { return '<button type="button" class="im-sizechip" data-size="' + esc(s.v) + '">' + esc(s.l) + "</button>"; }).join("") +
          '<button type="button" class="im-mini" data-clear="size">Clear</button>' +
          '<label class="im-confirmed" title="Show only companies with a confirmed (Wikidata) headcount, hide estimates"><input type="checkbox" id="imConfirmedSize"' + (imConfirmedSizeOnly ? " checked" : "") + "> Confirmed only</label>" +
        "</div>" +
        // Daily import read, populated on open so you see today's intake immediately.
        '<div id="imImportBanner" class="im-import"></div>' +
        // Entry to the curated decision-maker list (the daily database of real hiring managers).
        '<div class="im-curation-cta">' +
          '<button type="button" class="btn btn-primary btn-sm" id="imCurationBtn">🎯 Decision-maker list <span style="opacity:.8;font-weight:500">— real hiring managers, curated daily</span></button>' +
          '<span class="muted" style="font-size:12px;margin-left:8px">Reviewed by you, then pushed to BD Bulk</span>' +
        "</div>" +
        // Industries, multi-select with Select all / Clear, in a compact scroll area.
        '<div class="im-group" id="imIndGroup">' +
          '<div class="im-group-head"><span class="im-group-title">Industries</span>' +
            '<button type="button" class="im-mini" data-all="ind">Select all</button>' +
            '<button type="button" class="im-mini" data-clear="ind">Clear</button></div>' +
          '<div class="im-industries im-scroll" id="imIndustries">' +
            IM_INDUSTRIES.map(function (n) { return '<button type="button" class="im-chip" data-ind="' + esc(n) + '">' + esc(n) + "</button>"; }).join("") +
          "</div>" +
        "</div>" +
        // Hiring signals, collapsed by default to de-clutter; Select all / Clear inside.
        '<details class="im-group im-sig-details" id="imSigGroup">' +
          '<summary class="im-group-summary">Hiring signals <span class="muted">- optional filter</span></summary>' +
          '<div class="im-group-head im-group-head-sub">' +
            '<button type="button" class="im-mini" data-all="sig">Select all</button>' +
            '<button type="button" class="im-mini" data-clear="sig">Clear</button></div>' +
          '<div class="im-signals" id="imSignals">' +
            IM_SIGNALS.map(function (s) { return '<button type="button" class="im-sigchip" data-sig="' + esc(s.t) + '">' + esc(s.l) + "</button>"; }).join("") +
          "</div>" +
        "</details>" +
      "</div>" +
      '<div id="imSaved"></div>' +
      '<div id="imBody"><div class="empty">Pick one or more industries (or Select all) to see who\'s hiring, ranked by hiring intent.</div></div>';

    renderSavedSignals();
    loadImportBanner();
    var curBtn = $("#imCurationBtn");
    if (curBtn) curBtn.addEventListener("click", function () { renderCuration(); });
    var form = $("#imForm"), input = $("#imQuery");

    function syncChips() {
      Array.prototype.forEach.call(el.querySelectorAll(".im-chip"), function (c) {
        c.classList.toggle("active", imSelectedIndustries.indexOf(c.getAttribute("data-ind")) >= 0);
      });
    }
    function syncSigChips() {
      Array.prototype.forEach.call(el.querySelectorAll(".im-sigchip"), function (c) {
        c.classList.toggle("active", imSelectedSignals.indexOf(c.getAttribute("data-sig")) >= 0);
      });
    }

    // Build the active search from the current selections (multi-industry + signals + box).
    function currentSearch() {
      if (imMode === "company") {
        var cv = input.value.trim();
        return cv ? { criteria: { companyName: cv }, label: cv } : null;
      }
      if (imMode === "title") {
        var tv = input.value.trim();
        return tv ? { criteria: { roleQuery: tv }, label: 'hiring "' + tv + '"' } : null;
      }
      var crit = {}, labels = [];
      if (imSelectedIndustries.length) {
        crit.industries = imSelectedIndustries.slice();
        labels.push(imSelectedIndustries.length === IM_INDUSTRIES.length ? "all industries"
          : imSelectedIndustries.length === 1 ? imSelectedIndustries[0]
          : imSelectedIndustries.length + " industries");
      }
      var q = input.value.trim();
      if (q) { crit.query = q; labels.push(q); }
      if (imSelectedSignals.length) labels.push(imSelectedSignals.length + " signal" + (imSelectedSignals.length === 1 ? "" : "s"));
      if (!imSelectedIndustries.length && !q && !imSelectedSignals.length) return null;
      return { criteria: crit, label: labels.join(" · ") };
    }
    function runNow() {
      clearTimeout(imSearchTimer);
      var s = currentSearch();
      if (s) runSearch(s.criteria, s.label);
      else $("#imBody").innerHTML = '<div class="empty">' + (imMode === "company"
        ? "Type a company name above, then your date, size and confirmed-only filters apply to it too."
        : imMode === "title"
        ? "Type a job title (keywords) above, we'll surface every US company hiring that role, and show only the matching roles per company."
        : "Pick one or more industries (or Select all) to see who's hiring.") + "</div>";
    }
    function scheduleSearch() { clearTimeout(imSearchTimer); imSearchTimer = setTimeout(runNow, 350); }

    // Search mode toggle: industry/market OR company name.
    Array.prototype.forEach.call(el.querySelectorAll(".im-mode"), function (m) {
      m.addEventListener("click", function () {
        imMode = m.getAttribute("data-mode");
        Array.prototype.forEach.call(el.querySelectorAll(".im-mode"), function (x) { x.classList.toggle("active", x === m); });
        input.value = ""; input.placeholder = IM_PLACEHOLDER[imMode];
        $("#imIndGroup").style.display = (imMode === "industry") ? "" : "none";
        $("#imSigGroup").style.display = (imMode === "industry") ? "" : "none";
        $("#imBody").innerHTML = '<div class="empty">' + (imMode === "industry"
          ? "Pick one or more industries (or Select all) to see who's hiring."
          : imMode === "title"
          ? "Type a job title (keywords) to find every US company hiring that role, showing only the matching roles per company."
          : "Type a company name to check if they're hiring right now, and who owns the open roles.") + "</div>";
        input.focus();
      });
    });

    form.addEventListener("submit", function (e) { e.preventDefault(); runNow(); });

    // Date search: pick a timeframe in the dropdown, then press the button to run the
    // search for that range. The dropdown only stores the choice; the button triggers it,
    // so the action is explicit and you get a clear loading state + updated count.
    var postedSel = $("#imPosted"), postedGo = $("#imPostedGo");
    function applyPosted() {
      if (postedSel) imPostedWithin = parseInt(postedSel.value, 10) || 0;
      var s = currentSearch();
      if (s) runSearch(s.criteria, s.label);
      else $("#imBody").innerHTML = '<div class="empty">Pick one or more industries (or Select all) first, then choose a timeframe and press <b>Search this range</b>.</div>';
    }
    if (postedSel) postedSel.addEventListener("change", function () { imPostedWithin = parseInt(postedSel.value, 10) || 0; });
    if (postedGo) postedGo.addEventListener("click", applyPosted);

    // Company-size chips: multi-select toggle → re-run the search narrowed to those bands.
    function syncSizeChips() {
      Array.prototype.forEach.call(el.querySelectorAll(".im-sizechip"), function (c) {
        c.classList.toggle("active", imSelectedSizes.indexOf(c.getAttribute("data-size")) >= 0);
      });
    }
    Array.prototype.forEach.call(el.querySelectorAll(".im-sizechip"), function (c) {
      c.addEventListener("click", function () {
        var v = c.getAttribute("data-size");
        var i = imSelectedSizes.indexOf(v);
        if (i >= 0) imSelectedSizes.splice(i, 1); else imSelectedSizes.push(v);
        syncSizeChips(); scheduleSearch();
      });
    });
    var sizeClear = el.querySelector('[data-clear="size"]');
    if (sizeClear) sizeClear.addEventListener("click", function () { imSelectedSizes = []; syncSizeChips(); scheduleSearch(); });
    var confSize = $("#imConfirmedSize");
    if (confSize) confSize.addEventListener("change", function () { imConfirmedSizeOnly = confSize.checked; scheduleSearch(); });

    // Industry chips: multi-select toggle → debounced search.
    Array.prototype.forEach.call(el.querySelectorAll(".im-chip"), function (c) {
      c.addEventListener("click", function () {
        var ind = c.getAttribute("data-ind");
        var i = imSelectedIndustries.indexOf(ind);
        if (i >= 0) imSelectedIndustries.splice(i, 1); else imSelectedIndustries.push(ind);
        syncChips(); scheduleSearch();
      });
    });
    // Signal chips: multi-select toggle → debounced search.
    Array.prototype.forEach.call(el.querySelectorAll(".im-sigchip"), function (c) {
      c.addEventListener("click", function () {
        var t = c.getAttribute("data-sig");
        var i = imSelectedSignals.indexOf(t);
        if (i >= 0) imSelectedSignals.splice(i, 1); else imSelectedSignals.push(t);
        syncSigChips(); scheduleSearch();
      });
    });
    // Select all / Clear for each group.
    Array.prototype.forEach.call(el.querySelectorAll(".im-mini"), function (b) {
      b.addEventListener("click", function () {
        if (b.getAttribute("data-all") === "ind") imSelectedIndustries = IM_INDUSTRIES.slice();
        else if (b.getAttribute("data-clear") === "ind") imSelectedIndustries = [];
        else if (b.getAttribute("data-all") === "sig") imSelectedSignals = IM_SIGNALS.map(function (s) { return s.t; });
        else if (b.getAttribute("data-clear") === "sig") imSelectedSignals = [];
        syncChips(); syncSigChips(); scheduleSearch();
      });
    });

    function runSearch(criteria, label) {
      var body = $("#imBody"); body.innerHTML = loading();
      imPicks = {}; imMinScore = 0; imLabel = label || "";
      var payload = { limit: 500 };
      if (criteria.companyName) payload.companyName = criteria.companyName;
      if (criteria.industries) payload.industries = criteria.industries;
      if (criteria.query) payload.query = criteria.query;
      if (criteria.roleQuery) payload.roleQuery = criteria.roleQuery;
      if (imSelectedSignals.length) payload.signalTypes = imSelectedSignals.slice();
      if (imPostedWithin) payload.postedWithinDays = imPostedWithin;
      if (imSelectedSizes.length) payload.headcountBands = imSelectedSizes.slice();
      if (imConfirmedSizeOnly) payload.confirmedSizeOnly = true;
      send("/in-market", "POST", payload).then(function (r) {
        if (!r.ok) { body.innerHTML = needsSetup(); return; }
        inMarketResults = (r.data && r.data.leads) || [];
        imTotal = (r.data && typeof r.data.pulled === "number") ? r.data.pulled : inMarketResults.length;
        imStats = (r.data && r.data.stats) || null;
        imBreakdown = (r.data && r.data.signalBreakdown) || [];
        imNeeds = (r.data && r.data.needsBreakdown) || [];
        renderImResults();
      }).catch(function () { body.innerHTML = needsSetup(); });
    }
  }

  // Render the results region: a bulk toolbar (select-all + narrow-down) over the cards.
  function renderImResults() {
    var body = document.getElementById("imBody"); if (!body) return;
    if (!inMarketResults.length) {
      body.innerHTML = '<div class="empty">No in-market companies matched yet. Try another search, or connect more signal sources under <a href="#connected">Connected</a>.</div>' + imTickerHtml();
      wireTicker(body);
      return;
    }
    var leads = imVisibleLeads();
    var bands = [["0", "All"], ["50", "50+"], ["75", "75+"]];
    var toolbar =
      '<div class="im-toolbar">' +
        '<label class="im-checkall"><input type="checkbox" id="imAll"> <b>Select all</b> <span class="muted">companies + managers</span></label>' +
        '<button type="button" class="btn btn-ghost btn-sm" id="imClearSel" style="display:none">Clear</button>' +
        '<span class="im-count">' + leads.length + " shown · <b>" + Math.max(imTotal, inMarketResults.length) + "</b> companies hiring" + (imLabel ? " in " + esc(imLabel) : "") +
          (imPostedWithin ? ' <span class="im-date-active">📅 posted in last ' + imPostedWithin + " day" + (imPostedWithin === 1 ? "" : "s") + "</span>" : " <span class=\"muted\">(grows daily)</span>") + "</span>" +
        '<div class="im-narrow" title="Narrow by hiring-intent score">' +
          bands.map(function (b) { return '<button type="button" class="im-nbtn' + (String(imMinScore) === b[0] ? " active" : "") + '" data-min="' + b[0] + '">' + b[1] + "</button>"; }).join("") +
        "</div>" +
        '<div class="im-narrow im-dm" title="Decision-makers to contact per open role">' +
          '<span class="im-dm-lbl">👤 Per role:</span>' +
          [1, 3, 5].map(function (n) { return '<button type="button" class="im-nbtn' + (imDmPerRole === n ? " active" : "") + '" data-dm="' + n + '">' + n + "</button>"; }).join("") +
        "</div>" +
        '<button class="btn btn-ghost btn-sm" id="imSave" disabled>💾 Save as hiring signals</button>' +
        '<button class="btn btn-primary btn-sm" id="imBulk" disabled>Push selected to Prospects</button>' +
      "</div>";
    body.innerHTML = toolbar + needsBreakdownHtml() + imBreakdownHtml() + '<div id="imList">' + leads.map(leadCard).join("") + "</div>" + imTickerHtml();
    wireImResults(body);
    wireTicker(body);
    wireNeeds(body);
    imUpdateSigChipCounts();
    updateImBulk();
  }

  // Pinned bottom-right running feed: how many new hiring companies were added to the
  // pool, by day, and when it last updated. Always renders (shows a "building" state
  // while the pool fills) and is dismissible.
  function imTickerHtml() {
    var s = imStats || { total: 0, openPositions: 0, windowDays: 90, addedToday: 0, lastAddedAt: null, days: [] };
    var added = s.addedToday || 0, total = s.total || 0;
    var positions = s.openPositions || 0, win = s.windowDays || 90;
    var lastStr = "filling now";
    if (s.lastAddedAt) {
      try { lastStr = new Date(s.lastAddedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch (e) {}
    }
    var log = (s.days || []).map(function (d) {
      var lbl = d.date;
      try { lbl = new Date(d.date + "T00:00:00").toLocaleDateString([], { month: "short", day: "numeric" }); } catch (e) {}
      return '<div class="im-tick-row"><span>' + esc(lbl) + "</span><b>+" + (d.added || 0) + "</b></div>";
    }).join("");
    var main = total > 0
      ? '<b>' + positions.toLocaleString() + '</b> open positions · <b>' + total.toLocaleString() + '</b> companies (last ' + win + 'd) · <b>+' + added + '</b> today'
      : "Building your hiring pool, first companies land within ~15 min, then it grows daily.";
    return '<div class="im-ticker" id="imTicker">' +
      '<button class="im-ticker-x" id="imTickerX" title="Hide">✕</button>' +
      '<div class="im-ticker-h">📈 Hiring-signal feed <span class="muted">· updates ~90 min</span></div>' +
      '<div class="im-ticker-main">' + main + "</div>" +
      '<div class="im-ticker-sub">Last update: ' + esc(lastStr) + "</div>" +
      (log ? '<div class="im-ticker-log">' + log + "</div>" : "") +
      "</div>";
  }
  function wireTicker(body) {
    var x = body.querySelector("#imTickerX");
    if (x) x.addEventListener("click", function () { var t = body.querySelector("#imTicker"); if (t) t.style.display = "none"; });
  }
  // "What they're hiring for" category clicks → toggle the per-function filter and re-render
  // (client-side narrowing of the loaded result set; counts in the panel stay the full picture).
  function wireNeeds(body) {
    Array.prototype.forEach.call(body.querySelectorAll(".im-need-row, .im-need-clear"), function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault(); e.stopPropagation();
        var fn = b.getAttribute("data-fn") || "";
        imNeedFn = (fn && imNeedFn === fn) ? "" : fn;   // toggle off if re-clicked
        renderImResults();
      });
    });
    // Best-guess email chips: click to copy (without toggling the row's checkbox).
    Array.prototype.forEach.call(body.querySelectorAll(".im-mgr-email"), function (chip) {
      chip.addEventListener("click", function (e) {
        e.preventDefault(); e.stopPropagation();
        var em = chip.getAttribute("data-email") || "";
        if (!em) return;
        try { navigator.clipboard.writeText(em); } catch (x) {}
        chip.classList.add("im-email-copied");
        setTimeout(function () { chip.classList.remove("im-email-copied"); }, 1200);
      });
    });
  }

  /* ========================================================================
     Decision-maker curation view — the daily database of real hiring managers
     attached to specific open roles, with the review gate to BD Bulk.
     ======================================================================== */
  var curPicks = {};   // id -> true (selected curated rows for approve/enroll)

  var curPollTimer = null;
  var curLastTotal = 0;     // researched count last rendered — detects new leads arriving
  var curLastSyncMs = 0;    // when the backend last answered — drives the live/reconnecting label
  var curTick = 0;          // heartbeat counter; we fetch data every Nth tick, tick the label every tick
  var CUR_BEAT_MS = 4000;   // label ticks this often (so a frozen link is obvious within ~4s)
  var CUR_FETCH_EVERY = 5;  // pull fresh funnel data every 5th beat (~20s)

  // Repaint just the live-link pill from the client clock, every heartbeat. This is the visible proof
  // the front end is talking to the back end: it counts up "synced Ns ago" between data pulls and
  // flips to "reconnecting" the moment the backend stops answering — independent of the data refresh.
  function curPaintSync() {
    var el = document.getElementById("curSync"); if (!el) return;
    if (!curLastSyncMs) { el.innerHTML = "⚪ connecting…"; return; }
    var ago = Math.round((Date.now() - curLastSyncMs) / 1000);
    if (ago > 70) { el.innerHTML = "🔴 reconnecting…"; el.title = "lost contact with the lead engine — retrying"; return; }
    el.innerHTML = "🟢 live · synced " + (ago < CUR_BEAT_MS / 1000 ? "just now" : ago + "s ago");
    el.title = "live connection to the lead engine — auto-refreshing";
  }

  // LIVE heartbeat: every beat we repaint the sync label; every ~20s we pull the funnel/health so the
  // numbers climb on screen as the engine works. When NEW leads have come in AND the user isn't
  // mid-selection, we also pull them into the list so the database visibly grows. If they're selecting,
  // we leave the list alone (never lose their picks) — the stats still climb.
  function curHeartbeat() {
    var stats = document.getElementById("curStats");
    if (!stats) { if (curPollTimer) { clearInterval(curPollTimer); curPollTimer = null; } return; }
    curPaintSync();                 // tick the live label every beat, even on a backgrounded tab
    if (document.hidden) return;    // but don't hit the network for a tab nobody's looking at
    curTick++;
    if (curTick % CUR_FETCH_EVERY !== 0) return;
    send("/in-market", "POST", { action: "curation_funnel" }).then(function (r) {
      var d = r && r.data; if (!d || !d.funnel) return;
      curLastSyncMs = Date.now();   // backend answered → link is healthy
      var node = document.getElementById("curStats"); if (!node) return;
      node.innerHTML = curStatsInner(d.funnel, d.health || null, d.search || null);
      curPaintSync();               // the re-render reset the pill text; restore it immediately
      var rc = document.getElementById("curResearched");
      if (rc) rc.textContent = (d.funnel.total || 0).toLocaleString();
      var total = d.funnel.total || 0;
      var selecting = Object.keys(curPicks).length > 0;
      if (total !== curLastTotal && !selecting) renderCuration();   // new leads in → refresh the list
    }).catch(function () { /* leave curLastSyncMs — curPaintSync flips to reconnecting if it stays stale */ });
  }

  function renderCuration() {
    var body = $("#imBody"); if (!body) return;
    if (!document.getElementById("curStats")) body.innerHTML = loading(); // only spin on first entry
    curPicks = {};
    if (curPollTimer) { clearInterval(curPollTimer); curPollTimer = null; }
    Promise.all([
      send("/in-market", "POST", { action: "curation_funnel" }),
      // Populate the WHOLE researched database now — enriched-first (real person + email on top, then
      // named-email-pending, then title-only researching rows). The list fills immediately and climbs
      // as the engine works; each row's badge shows its enrichment state (valid / guess / pending).
      send("/in-market", "POST", { action: "curation_list", limit: 1000 }),
    ]).then(function (rs) {
      var funnel = (rs[0] && rs[0].data && rs[0].data.funnel) || null;
      var health = (rs[0] && rs[0].data && rs[0].data.health) || null;
      var search = (rs[0] && rs[0].data && rs[0].data.search) || null;
      var list = (rs[1] && rs[1].data && rs[1].data.curated) || [];
      curLastTotal = (funnel && funnel.total) || 0;
      curLastSyncMs = Date.now();   // first good answer from the backend → mark the link live
      body.innerHTML = curationHtml(funnel, list, health, search);
      wireCuration(body, list);
      curPaintSync();               // paint the live pill right away (don't wait a full beat)
      curPollTimer = setInterval(curHeartbeat, CUR_BEAT_MS); // live ongoing updates + link heartbeat
    }).catch(function () { body.innerHTML = '<div class="empty">⚠ Couldn\'t reach the lead engine. It builds the list continuously in the background — this is usually a brief blip right after a deploy. Retrying automatically; reopen this tab in a moment.</div>'; });
  }

  // Liveness strip: shows when the pool was last fed and when curation last ran, so a silently
  // stalled engine is visible at a glance instead of looking like a healthy-but-empty list.
  // Sustainability pill for the free name-scraping (DuckDuckGo/Bing). Green = healthy, amber =
  // slowing, red = throttled (resting under back-off). Hover shows the per-engine breakdown so we
  // can see at a glance whether the IP rotation is holding up while we run it hard.
  function curSearchPill(s) {
    if (!s) return "";
    var st = s.status || "idle";
    var icon = st === "healthy" ? "🟢" : st === "degraded" ? "🟡" : st === "throttled" ? "🔴" : "⚪";
    var label = st === "healthy" ? "scraping healthy" : st === "degraded" ? "scraping slowing"
      : st === "throttled" ? "scraping throttled" : "scraping idle";
    var tip = (s.engines || []).map(function (e) {
      return e.engine + ": " + e.status + " · " + Math.round((e.okRate || 0) * 100) + "% ok" +
        (e.backoffSec ? " · resting " + e.backoffSec + "s" : "") + " · " + (e.requests || 0) + " reqs";
    }).join("\n") || "no searches yet";
    return '<span class="cur-mini" title="' + esc(tip) + '">' + icon + " " + esc(label) + "</span>";
  }

  // The live link indicator. Its text is overwritten by the heartbeat every few seconds (see
  // curHeartbeat), so a stalled/disconnected backend shows "reconnecting" instead of looking healthy.
  function curSyncPill() {
    return '<span class="cur-mini" id="curSync" title="live connection to the lead engine">⚪ connecting…</span>';
  }

  function curEngineLine(h, search) {
    if (!h && !search) return '<div class="cur-sigs"><span class="muted">Engine:</span>' + curSyncPill() + "</div>";
    if (!h) return '<div class="cur-sigs"><span class="muted">Engine:</span>' + curSyncPill() + curSearchPill(search) + "</div>";
    function ago(s) {
      if (!s) return null;
      var t = Date.parse(String(s).replace(" ", "T")); if (isNaN(t)) return null;
      var m = Math.max(0, Math.round((Date.now() - t) / 60000));
      if (m < 1) return { txt: "just now", min: m };
      if (m < 60) return { txt: m + "m ago", min: m };
      var hr = Math.round(m / 60); if (hr < 24) return { txt: hr + "h ago", min: m };
      return { txt: Math.round(hr / 24) + "d ago", min: m };
    }
    function part(label, when, ok, staleMin) {
      var a = ago(when);
      var bad = !a || a.min > staleMin || ok === false;
      var dot = bad ? "🔴" : "🟢";
      return '<span class="cur-mini" title="' + (ok === false ? "last run errored" : "") + '">' + dot + " " +
        esc(label) + " <b>" + (a ? esc(a.txt) : "not yet") + "</b></span>";
    }
    // Pool cycle runs hourly (stale > 75m); curation ticks every 8m (stale > 20m).
    return '<div class="cur-sigs"><span class="muted">Engine:</span>' +
      curSyncPill() +
      part("pool fed", h.lastCycleAt, h.lastCycleOk, 75) +
      part("curated", h.lastCurationAt, h.lastCurationOk, 20) +
      curSearchPill(search) +
      "</div>";
  }

  // The live "N / 5,000 valid emails today" target bar — the headline consistency metric.
  function curDailyHtml(d) {
    if (!d) return "";
    var target = d.target || 5000;
    var pct = Math.min(100, Math.round(((d.validToday || 0) / target) * 100));
    var pace = d.onPace ? "🟢 on pace" : "🟡 below pace";
    return '<div style="margin:10px 0;padding:12px 14px;border:1px solid rgba(255,255,255,.08);border-radius:12px;background:rgba(124,92,255,.06)">' +
      '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:13px;margin-bottom:8px">' +
        '<span><b style="font-size:17px">' + (d.validToday || 0).toLocaleString() + "</b> / " + target.toLocaleString() + ' <span class="muted">valid emails today</span></span>' +
        '<span class="muted">' + (d.contactableToday || 0).toLocaleString() + " contactable · projected " + (d.projectedValid || 0).toLocaleString() + "/day · " + pace + "</span>" +
      "</div>" +
      '<div style="height:8px;border-radius:5px;background:rgba(255,255,255,.08);overflow:hidden"><i style="display:block;height:100%;width:' + pct + '%;background:linear-gradient(90deg,#7c5cff,#38e0a6)"></i></div>' +
    "</div>";
  }

  // The live-updating stats block (engine pills, daily target, funnel, signal slices). Rebuilt by
  // the poller every ~25s so the numbers climb on screen, WITHOUT touching the list/selection below.
  function curStatsInner(f, health, search) {
    var bs = f.byStatus || {};
    var stages = [
      ["sourced", "Sourced", "company + owning title"],
      ["named", "Named", "real person found"],
      ["contactable", "Contactable", "name + email"],
      ["queued", "Approved", "ready to send"],
      ["enrolled", "Enrolled", "in BD Bulk"],
    ];
    var funnelRow = stages.map(function (s) {
      return '<div class="cur-stage"><div class="cur-stage-n">' + ((bs[s[0]] || 0)).toLocaleString() + "</div>" +
        '<div class="cur-stage-l">' + esc(s[1]) + '</div><div class="cur-stage-h">' + esc(s[2]) + "</div></div>";
    }).join('<div class="cur-arrow">→</div>');
    var sigRows = (f.bySignal || []).slice(0, 8).map(function (x) {
      return '<div class="cur-mini"><span>' + esc(imSignalLabel(x.signalType)) + '</span><b>' + x.contactable.toLocaleString() + "</b><span class=\"muted\">/ " + x.total.toLocaleString() + "</span></div>";
    }).join("");
    return curEngineLine(health, search) +
      curDailyHtml(f.daily) +
      '<div class="cur-funnel">' + funnelRow + "</div>" +
      (sigRows ? '<div class="cur-sigs"><span class="muted">Contactable by hiring signal:</span>' + sigRows + "</div>" : "") +
      ((f.validated || f.invalid) ? '<div class="cur-sigs"><span class="muted">Email validation:</span><span class="cur-mini"><span class="cur-valid">✓ ' + (f.validated || 0).toLocaleString() + " valid</span></span>" + (f.invalid ? '<span class="cur-mini"><span class="cur-invalid">✕ ' + f.invalid.toLocaleString() + " invalid</span></span>" : "") + "</div>" : "");
  }

  function curationHtml(funnel, list, health, search) {
    var f = funnel || { total: 0, byStatus: {}, bySignal: [], byFunction: [], contactableRate: 0 };

    var head =
      '<div class="cur-head">' +
        '<button type="button" class="btn btn-ghost btn-sm" id="curBack">← Back to search</button>' +
        '<h2>Curated decision-makers <span class="muted">· <span id="curResearched">' + (f.total || 0).toLocaleString() + "</span> researched</span></h2>" +
        '<button type="button" class="btn btn-ghost btn-sm" id="curRefresh">↻ Research more now</button>' +
      "</div>" +
      '<div id="curStats">' + curStatsInner(f, health, search) + "</div>";

    if (!list.length) {
      return head + '<div class="empty" style="margin-top:14px">No decision-makers curated yet. The engine researches companies continuously (free: search, team pages, news, GitHub) and new leads appear here automatically as they come in. Hit <b>Research more now</b> to kick it.</div>';
    }

    var rows = list.map(curationRow).join("");
    var toolbar =
      '<div class="cur-toolbar">' +
        '<label><input type="checkbox" id="curAll"> <b>Select all</b></label>' +
        '<span class="muted" id="curCount">0 selected</span>' +
        '<button class="btn btn-primary btn-sm" id="curEnroll" disabled>✓ Approve &amp; push to BD Bulk</button>' +
      "</div>";

    return head + toolbar + '<div class="cur-list">' + rows + "</div>";
  }

  function curationRow(r) {
    var via = r.managerVia ? '<span class="cur-via cur-via-' + esc(r.managerVia) + '">' + esc(r.managerVia.replace("_", " ")) + "</span>" : "";
    var emailTag = r.emailValidated ? '<span class="cur-valid">✓ valid</span>'
      : r.emailInvalid ? '<span class="cur-invalid">✕ invalid</span>'
      : '<span class="im-email-unv">guess</span>';
    var email = r.likelyEmail
      ? '<span class="cur-email" data-email="' + esc(r.likelyEmail) + '" title="Best-guess work email — validated continuously, confirmed before send">✉️ ' + esc(r.likelyEmail) + ' ' + emailTag + "</span>"
      : '<span class="im-email-unv" title="Name found — email resolves in the enrichment pass">⏳ email pending</span>';
    var enrolled = r.status === "enrolled";
    // Visible in the list either way, but only rows that already have an email are selectable for
    // push — the "email pending" ones wait for the enrichment pass before they're ready to send.
    var selectable = !enrolled && !!r.likelyEmail;
    // Title-only (still-researching) rows show the owning title as the person line, with a soft hint,
    // so the database reads as "populated and enriching" rather than blank.
    var personName = r.managerName
      ? '<b>' + esc(r.managerName) + "</b>"
      : '<b class="muted">' + esc(r.managerTitle) + '</b> <span class="im-email-unv">🔍 finding name…</span>';
    return '<div class="cur-row' + (enrolled ? " cur-enrolled" : "") + '" data-id="' + esc(r.id) + '">' +
      '<input type="checkbox" class="cur-pick" data-id="' + esc(r.id) + '"' + (selectable ? "" : " disabled") + ">" +
      '<div class="cur-main">' +
        '<div class="cur-person">' + personName + " " +
          (r.managerName ? '<span class="cur-title">' + esc(r.managerTitle) + "</span> " : "") + via + "</div>" +
        '<div class="cur-ctx"><span class="cur-co">' + esc(r.company) + "</span>" +
          ' <span class="muted">owns</span> ' + esc(r.role) +
          ' · <span class="im-fn">' + esc(r.function) + "</span>" +
          ' · ' + esc(imSignalLabel(r.signalType)) + "</div>" +
        '<div class="cur-contact">' + email + (enrolled ? ' <span class="cur-badge">✓ enrolled</span>' : "") + "</div>" +
      "</div>" +
      '<span class="cls cls-' + (r.score >= 75 ? "positive" : "soft_yes") + ' im-score">' + (r.score || 0) + "</span>" +
      "</div>";
  }

  function wireCuration(body, list) {
    var back = body.querySelector("#curBack");
    if (back) back.addEventListener("click", function () {
      if (inMarketResults.length) renderImResults();
      else body.innerHTML = '<div class="empty">Pick one or more industries (or Select all) to see who\'s hiring, ranked by hiring intent.</div>';
    });
    var refresh = body.querySelector("#curRefresh");
    if (refresh) refresh.addEventListener("click", function () {
      refresh.disabled = true; refresh.textContent = "Researching…";
      send("/in-market", "POST", { action: "curate_now", limit: 60 }).then(function () { renderCuration(); }).catch(function () { renderCuration(); });
    });
    function sync() {
      var n = Object.keys(curPicks).length;
      var c = body.querySelector("#curCount"); if (c) c.textContent = n + " selected";
      var e = body.querySelector("#curEnroll"); if (e) e.disabled = !n;
    }
    Array.prototype.forEach.call(body.querySelectorAll(".cur-pick"), function (cb) {
      cb.addEventListener("change", function () {
        var id = cb.getAttribute("data-id");
        if (cb.checked) curPicks[id] = true; else delete curPicks[id];
        sync();
      });
    });
    var all = body.querySelector("#curAll");
    if (all) all.addEventListener("change", function () {
      Array.prototype.forEach.call(body.querySelectorAll(".cur-pick"), function (cb) {
        if (cb.disabled) return; cb.checked = all.checked;
        var id = cb.getAttribute("data-id");
        if (all.checked) curPicks[id] = true; else delete curPicks[id];
      });
      sync();
    });
    // Copy email on click.
    Array.prototype.forEach.call(body.querySelectorAll(".cur-email"), function (chip) {
      chip.addEventListener("click", function () {
        var em = chip.getAttribute("data-email"); if (!em) return;
        try { navigator.clipboard.writeText(em); } catch (x) {}
        chip.classList.add("im-email-copied"); setTimeout(function () { chip.classList.remove("im-email-copied"); }, 1000);
      });
    });
    var enroll = body.querySelector("#curEnroll");
    if (enroll) enroll.addEventListener("click", function () {
      var ids = Object.keys(curPicks);
      if (!ids.length) return;
      enroll.disabled = true; enroll.textContent = "Pushing…";
      resolveBdCampaign(function (campaignId) {
        if (!campaignId) { enroll.textContent = "✓ Approve & push to BD Bulk"; enroll.disabled = false; toast && toast("Couldn't resolve a BD campaign"); return; }
        // Review gate: approve, then enroll into the BD Bulk MPC sender.
        send("/in-market", "POST", { action: "curation_approve", ids: ids }).then(function () {
          return send("/in-market", "POST", { action: "curation_enroll", ids: ids, campaignId: campaignId });
        }).then(function (r) {
          var n = (r && r.data && r.data.enrolled) || 0;
          if (typeof toast === "function") toast("Pushed " + n + " decision-maker" + (n === 1 ? "" : "s") + " to BD Bulk");
          renderCuration();
        }).catch(function () { enroll.textContent = "✓ Approve & push to BD Bulk"; enroll.disabled = false; });
      });
    });
  }

  // Prominent daily-import banner at the top of Hire Signals, loads on open so today's
  // intake from the free APIs is visible before you even search.
  function loadImportBanner() {
    api("/in-market").then(function (d) { if (d && d.stats) { imStats = d.stats; renderImportBanner(); } }).catch(function () {});
    renderImportBanner(); // render whatever we have (or the "importing now" state) immediately
  }
  function renderImportBanner() {
    var el = document.getElementById("imImportBanner"); if (!el) return;
    var s = imStats || { total: 0, openPositions: 0, windowDays: 90, addedToday: 0, lastAddedAt: null, days: [] };
    var added = s.addedToday || 0, total = s.total || 0;
    var positions = s.openPositions || 0, win = s.windowDays || 90;
    var lastStr = "";
    if (s.lastAddedAt) { try { lastStr = " · updated " + new Date(s.lastAddedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } catch (e) {} }
    var log = (s.days || []).slice(0, 5).map(function (d) {
      var lbl = d.date; try { lbl = new Date(d.date + "T00:00:00").toLocaleDateString([], { month: "short", day: "numeric" }); } catch (e) {}
      return '<span class="im-import-day">' + esc(lbl) + " <b>+" + (d.added || 0) + "</b></span>";
    }).join("");
    if (total > 0) {
      el.innerHTML = '<div class="im-import-main">📈 <b>' + positions.toLocaleString() + '</b> open positions across <b>' + total.toLocaleString() + '</b> companies in your hiring pool (last ' + win + ' days) · <b>+' + added + '</b> companies imported today' + esc(lastStr) + "</div>" +
        (log ? '<div class="im-import-log">' + log + "</div>" : "");
    } else {
      el.innerHTML = '<div class="im-import-main">📈 Importing now from the free job APIs, first companies land within ~15 min, then this climbs every day.</div>';
    }
  }

  // Short relative time, e.g. "today", "2d ago", "3w ago", for the lead date stamps.
  function imRelTime(iso) {
    if (!iso) return "";
    var t = Date.parse(iso); if (isNaN(t)) return "";
    var days = Math.floor((Date.now() - t) / 86400000);
    if (days <= 0) return "today";
    if (days === 1) return "1d ago";
    if (days < 7) return days + "d ago";
    if (days < 30) return Math.floor(days / 7) + "w ago";
    if (days < 365) return Math.floor(days / 30) + "mo ago";
    return Math.floor(days / 365) + "y ago";
  }

  function leadCard(l) {
    var score = Math.round(l.score || 0);
    var scoreCls = score >= 75 ? "positive" : score >= 50 ? "soft_yes" : "unclassified";
    var src = l.sourceUrl ? ' · <a href="' + esc(l.sourceUrl) + '" target="_blank" rel="noopener">source</a>' : "";

    // Deep dive: each open role mapped to the hiring manager who would own it. Each row
    // is selectable as the prospect to push to Prospects + sequence.
    var mgrs = imRoleManagers(l);
    var rows;
    if (mgrs) {
      rows = mgrs.map(function (m) {
        var who = m.managerName
          ? '<b>' + esc(m.managerName) + "</b>"
          : '<span class="muted">resolve on push</span>';
        var roleLabel = m.roleUrl
          ? '<a class="im-mgr-rolelink" href="' + esc(m.roleUrl) + '" target="_blank" rel="noopener" title="Open this exact job posting" onclick="event.stopPropagation()">' + esc(m.role) + ' <span class="im-mgr-ext">↗</span></a>'
          : esc(m.role);
        return '<label class="im-mgr"><input type="checkbox" class="im-pick" data-id="' + esc(l.id) + '" data-mk="' + esc(imMgrKey(m)) + '" ' + (imPicks[imPickKey(l.id, imMgrKey(m))] ? "checked" : "") + ">" +
          '<span class="im-mgr-role">' + roleLabel +
            (m.postedAt && imRelTime(m.postedAt) ? ' <span class="im-mgr-posted" title="Posted on their board ' + esc(m.postedAt) + '">📅 ' + imRelTime(m.postedAt) + "</span>" : "") + "</span>" +
          '<span class="im-mgr-arrow">→</span>' +
          '<span class="im-mgr-title">' + esc(m.managerTitle) + "</span>" +
          '<span class="im-fn">' + esc(m.function) + "</span>" +
          '<span class="im-mgr-who">' + who + "</span>" +
          imEmailChip(m.likelyEmail, m.emailPattern) +
          (m.why ? '<span class="im-mgr-why" title="Why this owner">' + esc(m.why) + "</span>" : "") + "</label>";
      }).join("");
    } else {
      // No role breakdown: offer the company's buyer / decision-maker as the prospect.
      var who = l.buyerName ? '<b>' + esc(l.buyerName) + "</b>" : '<span class="muted">resolve on push</span>';
      rows = '<label class="im-mgr"><input type="checkbox" class="im-pick" data-id="' + esc(l.id) + '" data-mk="" ' + (imPicks[imPickKey(l.id, "")] ? "checked" : "") + ">" +
        '<span class="im-mgr-role">Decision-maker</span>' +
        '<span class="im-mgr-arrow">→</span>' +
        '<span class="im-mgr-title">' + esc(l.buyerTitle || "Hiring manager") + "</span>" +
        '<span class="im-mgr-who">' + who + "</span>" +
        imEmailChip(l.buyerLikelyEmail, l.buyerEmailPattern) + "</label>";
    }

    var renew = l.renewed
      ? '<div class="im-renew"><div class="im-renew-top">🔥 <b>' + esc(l.renewedReason || "Renewed demand") + "</b> " +
          '<span class="muted">- already taken, but hiring again. Re-engage:</span></div>' +
          '<div class="im-renew-msg">' + esc(l.renewedMessage || "") + "</div>" +
          '<button class="im-renew-copy" data-msg="' + esc(l.renewedMessage || "") + '">Copy follow-up message</button></div>'
      : "";

    var nRoles = mgrs ? mgrs.length : 1;
    // The company checkbox is "checked" when every one of its managers is selected.
    var allChecked = mgrs
      ? mgrs.every(function (m) { return imPicks[imPickKey(l.id, imMgrKey(m))]; })
      : !!imPicks[imPickKey(l.id, "")];
    var anyChecked = mgrs
      ? mgrs.some(function (m) { return imPicks[imPickKey(l.id, imMgrKey(m))]; })
      : !!imPicks[imPickKey(l.id, "")];
    var metaBits = [];
    if (l.headcountBand) {
      // Authoritative employee count when resolved (Wikidata); otherwise the band, marked
      // "~ est." when it's only a heuristic guess so it's never mistaken for a confirmed size.
      if (l.employeeCount) metaBits.push('<span class="im-size" title="Employees (Wikidata)">👥 ' + Number(l.employeeCount).toLocaleString() + " employees</span>");
      else if (l.sizeEstimated) metaBits.push('<span class="im-size im-size-est" title="Estimated from hiring footprint, confirmed size grows as Adzuna/enrichment fill in">👥 ~' + esc(l.headcountBand) + " est.</span>");
      else metaBits.push('<span class="im-size">👥 ' + esc(l.headcountBand) + "</span>");
    }
    if (l.location) metaBits.push(esc(l.location));
    metaBits.push(nRoles + " open role" + (nRoles === 1 ? "" : "s"));
    // Dates: when the role was posted online, and when we first added it to the database.
    var posted = imRelTime(l.postedAt || l.signalAt);
    if (posted) metaBits.push('<span class="im-date-tag" title="Posted online ' + esc(l.postedAt || l.signalAt || "") + '">📅 Posted ' + posted + "</span>");
    var added = imRelTime(l.addedAt);
    if (added) metaBits.push('<span class="im-date-tag im-date-added" title="Added to your database ' + esc(l.addedAt || "") + '">🆕 Added ' + added + "</span>");

    return '<div class="im-lead' + (l.renewed ? " im-lead-renew" : "") + '" data-id="' + esc(l.id) + '">' +
      '<div class="im-lead-head">' +
        '<input type="checkbox" class="im-co-check" data-id="' + esc(l.id) + '"' + (allChecked ? " checked" : "") + ' title="Select this company" />' +
        '<span class="avatar" style="background:' + colorFor(l.company) + '">' + esc(initials(l.company)) + "</span>" +
        '<div class="im-lead-id"><div class="im-lead-name">' + esc(l.company) +
          (l.renewed ? ' <span class="im-renew-badge">🔥 Renewed</span>' : "") +
          (l.inPipeline ? ' <span class="im-pipeline-badge" title="Already in your Prospects">✓ In pipeline</span>' : "") +
          (l.industry ? ' <span class="muted" style="font-weight:400">· ' + esc(l.industry) + "</span>" : "") + "</div>" +
        '<div class="im-lead-meta">' + metaBits.join(" · ") + "</div></div>" +
        '<span class="cls cls-' + scoreCls + ' im-score" title="Hiring-intent score">' + score + "</span></div>" +
      '<div class="im-reason">' + esc(l.reason) + src + "</div>" +
      renew +
      '<details class="im-managers-d"' + ((anyChecked || l.aiRefined) ? " open" : "") + '>' +
        '<summary class="im-mgr-summary">👤 ' + nRoles + " hiring manager" + (nRoles === 1 ? "" : "s") + " &amp; open role" + (nRoles === 1 ? "" : "s") +
          (l.allRoles ? ' <span class="im-ai-tag">🔎 full board' + (l.allRolesSource ? " · " + esc(l.allRolesSource) : "") + "</span>" : "") +
          (l.aiRefined ? ' <span class="im-ai-tag">🤖 AI-matched</span>' : "") + "</summary>" +
        '<div class="im-managers">' + rows +
          '<button type="button" class="im-all-roles" data-id="' + esc(l.id) + '">' + (l.allRoles ? "🔎 Roles refreshed" : "🔎 Find all open roles") + "</button>" +
          '<button type="button" class="im-ai-refine" data-id="' + esc(l.id) + '">' + (l.aiRefined ? "🤖 Re-run AI match" : "🤖 Refine with AI") + "</button>" +
        "</div></details>" +
      (l.scoreReasons && l.scoreReasons.length ? '<div class="im-lead-reasons">' + l.scoreReasons.slice(0, 3).map(esc).join(" · ") + "</div>" : "") +
      "</div>";
  }

  function wireImResults(body) {
    // Keep a company's header checkbox in sync with its manager rows.
    function syncCoCheck(card) {
      if (!card) return;
      var co = card.querySelector(".im-co-check"); if (!co) return;
      var picks = card.querySelectorAll(".im-pick");
      var checked = card.querySelectorAll(".im-pick:checked").length;
      co.checked = picks.length > 0 && checked === picks.length;
      co.indeterminate = checked > 0 && checked < picks.length;
    }
    // Per-manager selection.
    Array.prototype.forEach.call(body.querySelectorAll(".im-pick"), function (cb) {
      cb.addEventListener("change", function () {
        var id = cb.getAttribute("data-id"), mk = cb.getAttribute("data-mk");
        var lead = imFindLead(id); if (!lead) return;
        var mgr = mk ? (lead.hiringManagers || []).find(function (m) { return imMgrKey(m) === mk; }) : null;
        var key = imPickKey(id, mk);
        if (cb.checked) imPicks[key] = { lead: lead, manager: mgr || null };
        else delete imPicks[key];
        syncCoCheck(cb.closest(".im-lead"));
        updateImBulk();
      });
    });
    // Per-company checkbox: select/clear all of that company's managers at once.
    Array.prototype.forEach.call(body.querySelectorAll(".im-co-check"), function (co) {
      co.addEventListener("change", function () {
        var card = co.closest(".im-lead"); if (!card) return;
        Array.prototype.forEach.call(card.querySelectorAll(".im-pick"), function (cb) {
          if (cb.checked !== co.checked) { cb.checked = co.checked; cb.dispatchEvent(new Event("change")); }
        });
      });
    });
    // Select all / clear, operates directly on imPicks (fast for hundreds of cards),
    // then reflects into every checkbox so it's visibly selected.
    function setAllSelection(on) {
      imVisibleLeads().forEach(function (l) {
        var mgrs = imRoleManagers(l);
        if (mgrs) mgrs.forEach(function (m) {
          var k = imPickKey(l.id, imMgrKey(m));
          if (on) imPicks[k] = { lead: l, manager: m }; else delete imPicks[k];
        });
        else { var k = imPickKey(l.id, ""); if (on) imPicks[k] = { lead: l, manager: null }; else delete imPicks[k]; }
      });
      Array.prototype.forEach.call(body.querySelectorAll(".im-pick"), function (cb) { cb.checked = on; });
      Array.prototype.forEach.call(body.querySelectorAll(".im-co-check"), function (co) { co.checked = on; co.indeterminate = false; });
      updateImBulk();
    }
    var all = body.querySelector("#imAll");
    if (all) all.addEventListener("change", function () { setAllSelection(all.checked); });
    var clr = body.querySelector("#imClearSel");
    if (clr) clr.addEventListener("click", function () { if (all) all.checked = false; setAllSelection(false); });
    // Narrow-down by score, and the one-click 1/3/5 decision-makers-per-role control.
    Array.prototype.forEach.call(body.querySelectorAll(".im-nbtn"), function (b) {
      b.addEventListener("click", function () {
        if (b.hasAttribute("data-dm")) imDmPerRole = parseInt(b.getAttribute("data-dm"), 10) || 1;
        else imMinScore = parseInt(b.getAttribute("data-min"), 10) || 0;
        renderImResults();
      });
    });
    // Bulk push.
    var bulk = body.querySelector("#imBulk");
    if (bulk) bulk.addEventListener("click", bulkPushToProspects);
    // Save selected as hiring signals (a staging step before Prospects).
    var save = body.querySelector("#imSave");
    if (save) save.addEventListener("click", saveSelectedSignals);
    // Copy the auto-generated renewed-demand follow-up message.
    Array.prototype.forEach.call(body.querySelectorAll(".im-renew-copy"), function (btn) {
      btn.addEventListener("click", function () {
        var msg = btn.getAttribute("data-msg") || "";
        var done = function () { btn.textContent = "✓ Copied"; setTimeout(function () { btn.textContent = "Copy follow-up message"; }, 1800); };
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(msg).then(done).catch(done); }
        else { try { var ta = document.createElement("textarea"); ta.value = msg; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta); } catch (e) {} done(); }
      });
    });
    // Dive into the company's own public ATS board → EVERY open role they're hiring for.
    Array.prototype.forEach.call(body.querySelectorAll(".im-all-roles"), function (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        var id = btn.getAttribute("data-id");
        var lead = imFindLead(id); if (!lead) return;
        btn.disabled = true; btn.textContent = "🔎 Scanning their board…";
        send("/in-market", "POST", { action: "company_roles", company: lead.company, domain: lead.domain }).then(function (r) {
          if (r.ok && r.data && r.data.hiringManagers && r.data.hiringManagers.length) {
            // Merge the full board's roles + managers into the lead, de-duped by role::title.
            var have = {};
            (lead.hiringManagers || []).forEach(function (m) { have[imMgrKey(m)] = 1; });
            var merged = (lead.hiringManagers || []).slice();
            r.data.hiringManagers.forEach(function (m) { if (!have[imMgrKey(m)]) { have[imMgrKey(m)] = 1; merged.push(m); } });
            lead.hiringManagers = merged;
            lead.roles = (r.data.roles || []).slice();
            lead.allRoles = true; lead.allRolesSource = r.data.source || "";
            var y = window.scrollY; renderImResults(); window.scrollTo(0, y);
            toast(lead.company + ": " + (r.data.total || 0) + " open role" + ((r.data.total === 1) ? "" : "s") + (r.data.source ? " via " + r.data.source : ""));
          } else {
            btn.disabled = false; btn.textContent = "🔎 Find all open roles";
            toast("No public job board found for " + lead.company + ".");
          }
        }).catch(function () { btn.disabled = false; btn.textContent = "🔎 Find all open roles"; toast("Could not reach the server."); });
      });
    });

    // AI decision-maker refinement for a single company (on demand, uses the LLM key).
    Array.prototype.forEach.call(body.querySelectorAll(".im-ai-refine"), function (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        var id = btn.getAttribute("data-id");
        var lead = imFindLead(id); if (!lead) return;
        btn.disabled = true; btn.textContent = "🤖 Thinking…";
        var roles = (lead.roles && lead.roles.length) ? lead.roles
          : (lead.hiringManagers || []).map(function (m) { return m.role; }).filter(function (v, i, a) { return v && a.indexOf(v) === i; });
        send("/in-market", "POST", { action: "refine_managers", lead: { company: lead.company, industry: lead.industry, headcountBand: lead.headcountBand, roles: roles } }).then(function (r) {
          if (r.ok && r.data && r.data.hiringManagers && r.data.hiringManagers.length) {
            lead.hiringManagers = r.data.hiringManagers; lead.aiRefined = true;
            Object.keys(imPicks).forEach(function (k) { if (k.indexOf(id + "::") === 0) delete imPicks[k]; });
            var y = window.scrollY; renderImResults(); window.scrollTo(0, y);
            toast("AI matched the decision-makers for " + lead.company);
          } else {
            btn.disabled = false; btn.textContent = "🤖 Refine with AI";
            toast((r.data && r.data.error) === "ai_unavailable" ? "Add ANTHROPIC_API_KEY to enable AI matching." : "Couldn't refine right now.");
          }
        }).catch(function () { btn.disabled = false; btn.textContent = "🤖 Refine with AI"; toast("Could not reach the server."); });
      });
    });
  }

  function updateImBulk() {
    var n = Object.keys(imPicks).length;
    var btn = document.getElementById("imBulk");
    if (btn) { btn.disabled = n === 0; btn.textContent = n ? ("Push " + n + " to Prospects →") : "Push selected to Prospects"; }
    var save = document.getElementById("imSave");
    if (save) { save.disabled = n === 0; save.textContent = n ? ("💾 Save " + n + " as hiring signals") : "💾 Save as hiring signals"; }
    var clr = document.getElementById("imClearSel");
    if (clr) clr.style.display = n ? "" : "none";
    var all = document.getElementById("imAll");
    var picks = document.querySelectorAll(".im-pick");
    if (all && picks.length) {
      var checked = document.querySelectorAll(".im-pick:checked").length;
      all.checked = checked === picks.length;
      all.indeterminate = checked > 0 && checked < picks.length;
    }
  }

  /* ---- Saved hiring signals: a staging shelf between search and Prospects ---- */
  function loadSavedSignals() { try { return JSON.parse(localStorage.getItem("ros_saved_signals") || "[]"); } catch (e) { return []; } }
  function storeSavedSignals(arr) { try { localStorage.setItem("ros_saved_signals", JSON.stringify(arr)); } catch (e) {} }

  // Save the currently-selected hiring managers to the shelf (deduped), without
  // touching Prospects yet, the recruiter reviews them first.
  function saveSelectedSignals() {
    var picks = Object.keys(imPicks).map(function (k) { return imPicks[k]; });
    if (!picks.length) return;
    var saved = loadSavedSignals();
    var seen = {};
    saved.forEach(function (s) { seen[imPickKey(s.lead.id, s.manager ? s.manager.role : "")] = true; });
    var added = 0;
    picks.forEach(function (p) {
      var key = imPickKey(p.lead.id, p.manager ? p.manager.role : "");
      if (!seen[key]) { saved.push({ lead: p.lead, manager: p.manager || null }); seen[key] = true; added++; }
    });
    storeSavedSignals(saved);
    toast("Saved " + added + " hiring signal" + (added === 1 ? "" : "s") + (added !== picks.length ? " (" + (picks.length - added) + " already saved)" : ""));
    imPicks = {}; renderImResults(); renderSavedSignals();
  }

  // Render the saved-signals shelf at the top of the In-Market view.
  function renderSavedSignals() {
    var box = document.getElementById("imSaved"); if (!box) return;
    var saved = loadSavedSignals();
    if (!saved.length) { box.innerHTML = ""; return; }
    box.innerHTML =
      '<div class="im-saved"><div class="im-saved-head">' +
        '<b>💾 Saved hiring signals</b> <span class="muted">(' + saved.length + ")</span>" +
        '<button class="btn btn-primary btn-sm" id="imSavedPush">Push all to Prospects →</button>' +
        '<button class="btn btn-ghost btn-sm" id="imSavedClear">Clear</button>' +
      "</div><div class=\"im-saved-list\">" +
        saved.map(function (s, i) {
          var who = (s.manager && s.manager.managerName) || s.lead.buyerName || (s.manager && s.manager.managerTitle) || "Hiring manager";
          var role = (s.manager && s.manager.role) ? s.manager.role : "Decision-maker";
          return '<div class="im-saved-row"><span class="im-saved-co">' + esc(s.lead.company) + "</span>" +
            '<span class="muted">' + esc(role) + " → " + esc(who) + "</span>" +
            '<button class="im-saved-x" data-rm="' + i + '" title="Remove">✕</button></div>';
        }).join("") +
      "</div></div>";
    var pushBtn = box.querySelector("#imSavedPush");
    if (pushBtn) pushBtn.addEventListener("click", pushSavedToProspects);
    var clearBtn = box.querySelector("#imSavedClear");
    if (clearBtn) clearBtn.addEventListener("click", function () { storeSavedSignals([]); renderSavedSignals(); });
    Array.prototype.forEach.call(box.querySelectorAll("[data-rm]"), function (x) {
      x.addEventListener("click", function () {
        var arr = loadSavedSignals(); arr.splice(parseInt(x.getAttribute("data-rm"), 10), 1);
        storeSavedSignals(arr); renderSavedSignals();
      });
    });
  }

  // Promote every saved signal into Prospects (paired to its company), then clear the shelf.
  function pushSavedToProspects() {
    var saved = loadSavedSignals(); if (!saved.length) return;
    var btn = document.getElementById("imSavedPush"); if (btn) btn.disabled = true;
    resolveBdCampaign(function (campaignId) {
      if (!campaignId) { toast("Create a campaign first."); if (btn) btn.disabled = false; return; }
      var done = 0;
      (function next(i) {
        if (i >= saved.length) {
          toast(done + " prospect" + (done === 1 ? "" : "s") + " pushed to Prospects");
          storeSavedSignals([]); renderSavedSignals();
          return;
        }
        if (btn) btn.textContent = "Pushing " + (i + 1) + "/" + saved.length + "…";
        var payload = { action: "promote", campaignId: campaignId, lead: saved[i].lead };
        if (saved[i].manager) payload.manager = saved[i].manager;
        send("/in-market", "POST", payload)
          .then(function (r) { if (r.ok) done++; next(i + 1); })
          .catch(function () { next(i + 1); });
      })(0);
    });
  }

  // Resolve (or create) the BD campaign that holds promoted in-market prospects.
  function resolveBdCampaign(cb) {
    var saved = [];
    try { saved = JSON.parse(localStorage.getItem("ros_campaigns") || "[]"); } catch (e) {}
    var camp = saved.filter(function (c) { return c.motion === motion; })[0] || saved[0];
    if (camp && camp.id) { cb(camp.id); return; }
    var c = { id: "camp_" + Math.random().toString(36).slice(2), name: "In-Market Pipeline", motion: motion, goal: "Hiring managers promoted from In-Market Leads.", status: "active", dailyCap: 25, steps: [] };
    send("/campaigns", "PUT", c).then(function () {
      try { var l = JSON.parse(localStorage.getItem("ros_campaigns") || "[]"); l.unshift(c); localStorage.setItem("ros_campaigns", JSON.stringify(l)); } catch (e) {}
      cb(c.id);
    }).catch(function () { cb(null); });
  }

  // "Push selected to Prospects" → first show an estimated cost to enrich (email + phone +
  // LinkedIn ID) and run the outreach sequence, with Approve / Cancel. Nothing is spent until
  // Approve. On approve we promote the batch, then kick the orchestrator (n8n) so the whole
  // enrich → LLM-draft → email/LinkedIn/voicemail/voice-drop process starts.
  // Persisted Hire Signals setting: opt-in to fetch verified person-direct landline/VoIP
  // numbers ($0.10/found) on push. Off by default, never runs automatically.
  function imDirectDialOn() { try { return localStorage.getItem("ros_im_directdial") === "1"; } catch (e) { return false; } }
  function setImDirectDial(on) { try { localStorage.setItem("ros_im_directdial", on ? "1" : "0"); } catch (e) {} }

  function bulkPushToProspects() {
    var picks = Object.keys(imPicks).map(function (k) { return imPicks[k]; });
    if (!picks.length) return;
    var n = picks.length;
    var dd = imDirectDialOn();
    var body =
      '<div class="pc">' +
        '<div class="pc-head">Run <b>' + n + "</b> " + (n === 1 ? "person" : "people") + " through third-party enrichment + the outreach sequence.</div>" +
        '<label class="pc-voice" title="Resolve each contact\'s OWN direct line, a landline/VoIP only (never a switchboard, never a mobile). $0.10 per number found; a no-find is free.">' +
          '<input type="checkbox" id="pcDirectDial"' + (dd ? " checked" : "") + "> Find verified direct dials " +
          '<span class="muted">(person-direct landline/VoIP · $0.10/found, no-find free)</span></label>' +
        '<div id="pcLines" class="pc-lines">' + loading() + "</div>" +
        '<div class="pc-total" id="pcTotal"></div>' +
        '<div id="pcCond"></div>' +
        '<div class="pc-notes muted" id="pcNotes"></div>' +
        '<div class="modal-foot">' +
          '<button class="btn btn-ghost btn-sm" id="pcCancel">Cancel</button>' +
          '<button class="btn btn-primary btn-sm" id="pcApprove" disabled>Approve &amp; launch</button>' +
        "</div>" +
      "</div>";
    openModal("Launch outreach", "Estimated cost, approve to start", body, function (root, closeFn) {
      var approve = root.querySelector("#pcApprove");
      var ddCb = root.querySelector("#pcDirectDial");
      function fetchEst() {
        approve.disabled = true;
        root.querySelector("#pcLines").innerHTML = loading();
        send("/in-market", "POST", { action: "estimate", count: n, directDial: ddCb.checked }).then(function (r) {
          if (!r.ok || !r.data || !r.data.estimate) { root.querySelector("#pcLines").innerHTML = '<div class="empty">Could not estimate cost.</div>'; return; }
          var est = r.data.estimate;
          root.querySelector("#pcLines").innerHTML = (est.perPersonLines || []).map(function (l) {
            return '<div class="pc-line"><span>' + esc(l.label) + ' <span class="muted">×' + l.qty + "</span></span><span>$" + l.costUsd.toFixed(2) + "</span></div>";
          }).join("");
          root.querySelector("#pcTotal").innerHTML = "Estimated total: <b>$" + (est.firmTotalUsd || 0).toFixed(2) + "</b> <span class=\"muted\">(firm · ~$" + (est.perPersonUsd || 0).toFixed(3) + "/person)</span>";
          var cond = est.conditional || [];
          root.querySelector("#pcCond").innerHTML = cond.length
            ? '<div class="pc-cond-h">Per-hit / conditional <span class="muted">- pay-per-use, not in the firm total</span></div>' +
              cond.map(function (c) {
                return '<div class="pc-line pc-cond"><span>' + esc(c.label) + ' <span class="muted">' + esc(c.basis) + "</span></span><span>$" + (c.unitUsd || 0).toFixed(3) + "</span></div>";
              }).join("")
            : "";
          root.querySelector("#pcNotes").innerHTML = (est.notes || []).map(function (x) { return "• " + esc(x); }).join("<br>");
          approve.disabled = false;
        }).catch(function () { root.querySelector("#pcLines").innerHTML = '<div class="empty">Could not estimate cost.</div>'; });
      }
      ddCb.addEventListener("change", function () { setImDirectDial(ddCb.checked); fetchEst(); });
      root.querySelector("#pcCancel").addEventListener("click", closeFn);
      approve.addEventListener("click", function () { closeFn(); runBulkPush(picks, ddCb.checked); });
      fetchEst();
    });
  }

  // Approved: promote each selected person to Prospects, then nudge the orchestrator (n8n)
  // to start the enrich → LLM-draft → email/LinkedIn/voicemail/voice-drop run immediately.
  function runBulkPush(picks, findDirectDial) {
    var btn = document.getElementById("imBulk"); if (btn) btn.disabled = true;
    resolveBdCampaign(function (campaignId) {
      if (!campaignId) { toast("Create a campaign first."); if (btn) btn.disabled = false; return; }
      var done = 0;
      (function next(i) {
        if (i >= picks.length) {
          if (btn) { btn.disabled = false; btn.textContent = "Push selected to Prospects"; }
          // Kick the omnichannel orchestrator so the whole process starts now.
          send("/in-market", "POST", { action: "launch_outreach", campaignId: campaignId, count: done }).catch(function () {});
          toast(done + " pushed, outreach launching" + (findDirectDial ? " (+ direct-dial reveal)" : ""));
          imPicks = {}; renderImResults();
          return;
        }
        if (btn) btn.textContent = "Pushing " + (i + 1) + "/" + picks.length + "…";
        var payload = { action: "promote", campaignId: campaignId, lead: picks[i].lead };
        if (picks[i].manager) payload.manager = picks[i].manager;
        if (findDirectDial) payload.findDirectDial = true;
        send("/in-market", "POST", payload)
          .then(function (r) { if (r.ok) done++; next(i + 1); })
          .catch(function () { next(i + 1); });
      })(0);
    });
  }

  function renderProspects(el) {
    el.innerHTML = head("Prospects", "Your live pipeline, synced bidirectionally with the ATS.") +
      '<div class="btn-row" style="margin-bottom:12px">' +
      '<button class="btn btn-primary btn-sm" id="enrichAllBtn">⚡ Enrich all contacts</button>' +
      '<button class="btn btn-ghost btn-sm" id="importBtn">⇪ Import (CSV / paste)</button>' +
      '<button class="btn btn-ghost btn-sm" id="liSearchBtn">🔗 Enrich LinkedIn searches</button>' +
      '<button class="btn btn-ghost btn-sm" id="prListsBtn">📁 Saved lists</button>' +
      '<select id="prSavedSelect" title="Open a saved search / list" style="margin-left:auto;background:var(--surface-2,#16161f);color:var(--text,#f4f4f8);border:1px solid var(--border,#2a2a36);border-radius:8px;padding:6px 11px;font-size:13px;max-width:240px"><option value="">📂 Saved searches…</option></select>' +
      '</div>' +
      '<div id="liProgress"></div>' +
      '<div class="pr-searchbar"><span class="ico">⌕</span>' +
      '<input id="prSearch" type="text" autocomplete="off" placeholder="Search by name, job title, company, or keyword…" /></div>' +
      '<div id="prBody">' + loading() + "</div>";

    $("#importBtn").addEventListener("click", importProspects);
    $("#liSearchBtn").addEventListener("click", importLinkedInSearch);
    $("#enrichAllBtn").addEventListener("click", function () { enrichAllProspects(this); });
    $("#prListsBtn").addEventListener("click", openListsModal);

    var prAll = [], prLifecycle = REF.lifecycle, prFilter = "", prSel = {};
    // Saved-search view: when a saved list is chosen, only its prospects show.
    var prListIds = null, prListId = "", prListName = "";
    var savedSelect = $("#prSavedSelect");
    if (savedSelect) savedSelect.addEventListener("change", function () { selectSavedList(savedSelect.value); });
    function selectSavedList(id) {
      var l = id && listStore().all().filter(function (x) { return x.id === id; })[0];
      if (!l) { prListIds = null; prListId = ""; prListName = ""; }
      else { prListIds = {}; (l.prospectIds || []).forEach(function (pid) { prListIds[pid] = true; }); prListId = l.id; prListName = l.name; }
      if (savedSelect) savedSelect.value = prListId;
      paint();
    }
    // Rebuild the dropdown options from the saved lists for this motion.
    function refreshSavedDropdown() {
      if (!savedSelect) return;
      var lists = listStore().all().filter(function (l) { return !l.motion || l.motion === motion; });
      savedSelect.innerHTML = '<option value="">📂 Saved searches…</option>' +
        lists.map(function (l) { return '<option value="' + esc(l.id) + '">' + esc(l.name) + " · " + (l.prospectIds || []).length + "</option>"; }).join("");
      savedSelect.value = prListId;
    }
    var searchEl = $("#prSearch");
    if (searchEl) searchEl.addEventListener("input", function () { prFilter = (searchEl.value || "").toLowerCase().trim(); paint(); });

    // Keyword filter over name (incl. first name), job title, company, email, source.
    function matches(p) {
      // Motion bucket: Recruiting and BD pipelines are separate. Legacy prospects
      // with no motion default into Recruiting.
      if ((p.motion || "recruiting") !== motion) return false;
      if (prListIds && !prListIds[p.id]) return false;   // viewing a saved search
      if (!prFilter) return true;
      var hay = ((p.fullName || "") + " " + (p.title || "") + " " + (p.company || "") + " " +
        (p.email || "") + " " + (p.category || "")).toLowerCase();
      return prFilter.split(/\s+/).every(function (t) { return hay.indexOf(t) >= 0; });
    }

    function rowHtml(p, lifecycle) {
      var opts = lifecycle.map(function (l) {
        return '<option value="' + esc(l.status) + '"' + (l.status === p.status ? " selected" : "") + ">" + esc(l[motion] || l.status) + "</option>";
      }).join("");
      var exp = p.experienceSummary || p.experience || p.summary || "";
      // A "role placeholder" prospect: the hiring manager's real name isn't researched yet.
      var pending = !p.linkedinUrl && (/ [--] /.test(p.fullName || "") || /hiring manager/i.test(p.fullName || ""));
      var name = pending
        ? esc(p.title || "Hiring manager") + ' <span class="pr-pending">name pending</span>'
        : esc(p.fullName);
      var avatar = '<span class="avatar pr-av" style="position:relative;background:' + colorFor(p.fullName) + '">' + esc(initials(pending ? (p.company || "?") : p.fullName)) +
        (p.photoUrl && !pending ? '<img src="' + esc(p.photoUrl) + '" alt="" onerror="this.remove()" />' : "") + "</span>";
      var expToggle = exp ? ' <button type="button" class="pr-exp-toggle" data-exp="' + esc(p.id) + '">Experience ▾</button>' : "";
      var li = p.linkedinUrl ? '<a class="pr-li" href="' + esc(p.linkedinUrl) + '" target="_blank" rel="noopener" title="View LinkedIn profile">in</a>' : '<span class="pr-na">-</span>';
      var enrichLbl = pending ? "🔎" : (p.email && p.phone) ? "↻" : "⚡";
      var enrichTitle = pending ? "Find hiring manager" : (p.email && p.phone) ? "Re-enrich contact" : "Enrich contact";
      var cell = function (v) { return v ? esc(v) : '<span class="pr-na">-</span>'; };
      var tr = '<tr class="pr-row' + (prSel[p.id] ? " pr-selected" : "") + '" data-pid="' + esc(p.id) + '">' +
        '<td class="pr-c-check"><input type="checkbox" class="pr-check" data-pid="' + esc(p.id) + '"' + (prSel[p.id] ? " checked" : "") + ' /></td>' +
        '<td class="pr-c-name">' + avatar + '<span class="pr-name-t">' + name + expToggle +
          (p.sequenceName ? '<span class="pr-seqtag" title="Assigned sequence">▸ ' + esc(p.sequenceName) + "</span>" : "") + "</span></td>" +
        "<td>" + cell(p.title) + "</td>" +
        "<td>" + cell(p.company) + "</td>" +
        '<td class="pr-c-email">' + (p.email ? '<a href="mailto:' + esc(p.email) + '">' + esc(p.email) + "</a>" : '<span class="pr-na">-</span>') + "</td>" +
        '<td class="pr-c-li">' + li + "</td>" +
        "<td>" + cell(p.phone) + "</td>" +
        "<td>" + cell(p.location) + "</td>" +
        '<td><select class="stage-select cls cls-' + statusCls(p.status) + '" data-pid="' + esc(p.id) + '">' + opts + "</select></td>" +
        '<td class="pr-c-act"><button class="pr-enrich" data-enrich="' + esc(p.id) + '" data-pending="' + (pending ? "1" : "") + '" title="' + enrichTitle + '">' + enrichLbl + "</button></td>" +
        "</tr>";
      if (exp) tr += '<tr class="pr-exp-row" id="exp_' + esc(p.id) + '" hidden><td></td><td colspan="9" class="pr-exp">' + esc(exp) + "</td></tr>";
      return tr;
    }

    function paint() {
      var body = $("#prBody"); if (!body) return;
      var lifecycle = prLifecycle;
      var list = prAll.filter(matches);
      var counts = list.reduce(function (m, p) { m[p.status] = (m[p.status] || 0) + 1; return m; }, {});
      var stages = lifecycle.map(function (l) {
        return '<div class="stage"><b>' + (counts[l.status] || 0) + "</b><span>" + esc(l[motion] || l.status) + "</span></div>";
      }).join("");
      var rows = list.map(function (p) { return rowHtml(p, lifecycle); }).join("");
      var countLbl = prFilter ? (list.length + " of " + prAll.length) : String(prAll.length);
      var selIds = list.filter(function (p) { return prSel[p.id]; }).map(function (p) { return p.id; });
      var allOn = list.length > 0 && selIds.length === list.length;
      var statusOpts = '<option value="">Set status…</option>' + lifecycle.map(function (l) {
        return '<option value="' + esc(l.status) + '">' + esc(l[motion] || l.status) + "</option>";
      }).join("");
      var seqs = seqStore().all().filter(function (s) { return (s.motion || "recruiting") === motion; });
      var seqOpts = '<option value="">Assign sequence…</option>' + seqs.map(function (s) {
        var c = (CHANNELS[s.channel] || {}).label || s.channel;
        return '<option value="' + esc(s.id) + '">' + esc(s.name) + " · " + esc(c) + "</option>";
      }).join("");
      var bulk = selIds.length
        ? '<div class="pr-bulk"><span class="pr-selcount">' + selIds.length + " selected</span>" +
            '<span class="pr-bulk-actions">' +
              '<span class="pr-enrich-grp">⚡ Enrich' +
                '<label><input type="checkbox" id="prEnrEmail" checked /> Email</label>' +
                '<label><input type="checkbox" id="prEnrPhone" checked /> Phone</label>' +
                '<button class="btn btn-primary btn-sm" id="prEnrichSel">Run</button></span>' +
              '<select class="pr-bulk-sel" id="prBulkStatus">' + statusOpts + "</select>" +
              '<span class="pr-seq-grp"><select class="pr-bulk-sel" id="prBulkSeq">' + seqOpts + "</select>" +
                '<button class="btn btn-ghost btn-sm" id="prSeqAssign">Assign</button></span>' +
              '<button class="btn btn-ghost btn-sm" id="prSaveList">💾 Save as list</button>' +
              '<button class="btn btn-ghost btn-sm" id="prDelSel">🗑 Delete</button>' +
              '<button class="btn btn-ghost btn-sm" id="prClearSel">Clear</button></span></div>'
        : "";
      var listBanner = prListName
        ? '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;padding:8px 12px;border:1px solid var(--border,#2a2a36);border-radius:10px;font-size:13px;background:rgba(124,92,255,.08)">' +
          '📂 Viewing saved search: <b>' + esc(prListName) + "</b> · " + list.length + " shown" +
          '<button class="btn btn-ghost btn-sm" id="prShowAll" style="margin-left:auto">Show all prospects</button></div>'
        : "";
      var tableHead = '<thead><tr>' +
        '<th class="pr-c-check"><input type="checkbox" id="prSelAll"' + (allOn ? " checked" : "") + ' title="Select all' + (prFilter ? " (filtered)" : "") + '" /></th>' +
        "<th>Name</th><th>Job Title</th><th>Company</th><th>Email</th><th>LinkedIn</th><th>Phone</th><th>Location</th><th>Status</th><th></th></tr></thead>";
      var table = rows
        ? '<div class="pr-table-wrap"><table class="pr-table">' + tableHead + "<tbody>" + rows + "</tbody></table></div>"
        : '<div class="empty">' + (prListName
          ? "This saved search has no matching prospects in your current pipeline."
          : prFilter
          ? "No " + prospectNoun() + "s match “" + esc(prFilter) + "”."
          : "No " + prospectNoun() + "s yet. Import, pull from a LinkedIn search above" + (motion === "recruiting" ? "." : ", or promote from Hire Signals.")) + "</div>";
      body.innerHTML = '<div class="pipe">' + stages + "</div>" +
        '<div class="card" style="padding:0;overflow:hidden"><div class="pr-card-h"><h3>Pipeline <span class="muted" style="font-weight:400;font-size:13px">· ' + countLbl + "</span></h3>" +
        listBanner + bulk + "</div>" + table + "</div>";
      var showAll = $("#prShowAll"); if (showAll) showAll.addEventListener("click", function () { selectSavedList(""); });

      // Selection wiring
      var selAll = $("#prSelAll");
      if (selAll) selAll.addEventListener("change", function () {
        list.forEach(function (p) { if (selAll.checked) prSel[p.id] = true; else delete prSel[p.id]; });
        paint();
      });
      Array.prototype.forEach.call(body.querySelectorAll(".pr-check"), function (cb) {
        cb.addEventListener("change", function () {
          var pid = cb.getAttribute("data-pid");
          if (cb.checked) prSel[pid] = true; else delete prSel[pid];
          paint();
        });
      });
      var saveBtn = $("#prSaveList"); if (saveBtn) saveBtn.addEventListener("click", function () { saveSelectedAsList(selIds); });
      var enrSelBtn = $("#prEnrichSel"); if (enrSelBtn) enrSelBtn.addEventListener("click", function () { enrichSelected(selIds, enrSelBtn); });
      var stSel = $("#prBulkStatus"); if (stSel) stSel.addEventListener("change", function () { if (stSel.value) bulkSetStatus(selIds, stSel.value); });
      var seqAssignBtn = $("#prSeqAssign"); if (seqAssignBtn) seqAssignBtn.addEventListener("click", function () {
        var sel = $("#prBulkSeq"); if (!sel || !sel.value) { toast("Pick a sequence to assign."); return; }
        assignSequence(selIds, sel.value, sel.options[sel.selectedIndex].text.split(" · ")[0]);
      });
      var delBtn = $("#prDelSel"); if (delBtn) delBtn.addEventListener("click", function () { deleteSelected(selIds); });
      var clrBtn = $("#prClearSel"); if (clrBtn) clrBtn.addEventListener("click", function () { prSel = {}; paint(); });

      // Expand / collapse a prospect's experience summary (hidden by default).
      Array.prototype.forEach.call(body.querySelectorAll(".pr-exp-toggle"), function (t) {
        t.addEventListener("click", function () {
          var box = body.querySelector("#exp_" + (window.CSS && CSS.escape ? CSS.escape(t.getAttribute("data-exp")) : t.getAttribute("data-exp")));
          if (!box) return;
          var open = box.hasAttribute("hidden");
          if (open) box.removeAttribute("hidden"); else box.setAttribute("hidden", "");
          t.textContent = open ? "Experience ▴" : "Experience ▾";
        });
      });

      // Stage transitions: change the dropdown -> persist via the API.
      Array.prototype.forEach.call(body.querySelectorAll(".stage-select"), function (sel) {
        sel.addEventListener("change", function () {
          var pid = sel.getAttribute("data-pid"), status = sel.value;
          sel.disabled = true;
          send("/prospects", "POST", { action: "transition", prospectId: pid, status: status })
            .then(function (r) {
              if (r.ok) { toast("Moved to " + statusLabel(status, lifecycle)); load(); }
              else { toast("Could not update (" + (r.data.error || r.status) + ")"); sel.disabled = false; }
            }).catch(function () { toast("Could not reach the server."); sel.disabled = false; });
        });
      });

      // Enrich a prospect's outreach contact (company email + phone), cheapest-first.
      Array.prototype.forEach.call(body.querySelectorAll(".pr-enrich"), function (btn) {
        btn.addEventListener("click", function () {
          var pid = btn.getAttribute("data-enrich");
          var researching = btn.getAttribute("data-pending") === "1";
          var old = btn.textContent; btn.disabled = true; btn.textContent = researching ? "…" : "…";
          send("/prospects", "POST", { action: "enrich", prospectId: pid }).then(function (r) {
            if (r.ok) {
              var f = (r.data && r.data.found) || {};
              var pr = (r.data && r.data.prospect) || {};
              var bits = [];
              if (f.name) bits.push("hiring manager: " + (pr.fullName || "name"));
              if (f.email) bits.push("email");
              if (f.phone) bits.push("phone");
              toast(bits.length ? ("Found " + bits.join(" + "))
                : (researching ? "Couldn’t resolve a name yet, connect a LinkedIn account (Accounts → LinkedIn) so it can research the manager."
                  : "No new contact found, add a provider under Connected, or enter manually."));
              load();
            } else { btn.disabled = false; btn.textContent = old; toast("Could not enrich (" + (r.data.error || r.status) + ")"); }
          }).catch(function () { btn.disabled = false; btn.textContent = old; toast("Could not reach the server."); });
        });
      });
    }

    function load() {
      api("/prospects").then(function (d) {
        prAll = (d && d.prospects) || [];
        prLifecycle = (d && d.lifecycle) || REF.lifecycle;
        paint();
      }).catch(function () { var b = $("#prBody"); if (b) b.innerHTML = needsSetup(); });
      // Populate the Saved searches dropdown (local cache first, then merge server).
      refreshSavedDropdown();
      api("/prospect-lists?motion=" + encodeURIComponent(motion)).then(function (d) {
        var server = (d && d.lists) || [];
        if (!server.length) return;
        try { localStorage.setItem("ros_prospect_lists", JSON.stringify(server.concat(listStore().all().filter(function (l) { return !server.some(function (s) { return s.id === l.id; }); })))); } catch (e) {}
        refreshSavedDropdown();
      }).catch(function () {});
    }

    /* ---- saved prospect lists (named audiences) ---- */
    function listStore() {
      function all() { try { return JSON.parse(localStorage.getItem("ros_prospect_lists") || "[]"); } catch (e) { return []; } }
      return {
        all: all,
        save: function (l) {
          var arr = all().filter(function (x) { return x.id !== l.id; }); arr.unshift(l);
          localStorage.setItem("ros_prospect_lists", JSON.stringify(arr));
          send("/prospect-lists", "PUT", l).catch(function () {});
        },
        remove: function (id) {
          localStorage.setItem("ros_prospect_lists", JSON.stringify(all().filter(function (x) { return x.id !== id; })));
          fetch(API + "/prospect-lists?id=" + encodeURIComponent(id), { method: "DELETE", credentials: "include" }).catch(function () {});
        }
      };
    }
    function saveSelectedAsList(ids) {
      if (!ids.length) return;
      var name = prompt("Name this list (" + ids.length + " prospect" + (ids.length === 1 ? "" : "s") + "):");
      if (!name) return;
      var list = { id: "plist_" + Date.now(), name: name.trim(), prospectIds: ids.slice(), motion: motion === "bd" ? "bd" : "recruiting", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      listStore().save(list);
      refreshSavedDropdown();   // surface it in the Saved searches dropdown immediately
      toast('Saved "' + list.name + '" · ' + ids.length + " prospect" + (ids.length === 1 ? "" : "s"));
    }
    function deleteSelected(ids) {
      if (!ids.length) return;
      if (!confirm("Delete " + ids.length + " prospect" + (ids.length === 1 ? "" : "s") + " from your pipeline? This can't be undone.")) return;
      send("/prospects", "POST", { action: "delete", ids: ids }).then(function (r) {
        if (r.ok) { toast("Deleted " + (r.data.deleted != null ? r.data.deleted : ids.length) + " prospect(s)"); prSel = {}; load(); }
        else toast("Could not delete (" + (r.data.error || r.status) + ")");
      }).catch(function () { toast("Could not reach the server."); });
    }
    // Bulk-enrich the selected prospects, cheapest-first, one at a time (so we
    // stay within provider rate limits) with live progress on the button.
    // The Email / Phone checkboxes choose which field(s) to enrich individually.
    function enrichSelected(ids, btn) {
      if (!ids.length) return;
      var doEmail = $("#prEnrEmail") ? $("#prEnrEmail").checked : true;
      var doPhone = $("#prEnrPhone") ? $("#prEnrPhone").checked : true;
      if (!doEmail && !doPhone) { toast("Check Email and/or Phone first."); return; }
      var field = (doEmail && doPhone) ? null : (doEmail ? "email" : "phone");
      var total = ids.length, found = 0;
      btn.disabled = true;
      (function next(i) {
        if (i >= total) {
          btn.disabled = false; btn.textContent = "Run";
          toast("Enriched " + found + " of " + total + (field ? " (" + field + ")" : ""));
          load();
          return;
        }
        btn.textContent = (i + 1) + "/" + total + "…";
        var payload = { action: "enrich", prospectId: ids[i] };
        if (field) payload.field = field;
        send("/prospects", "POST", payload)
          .then(function (r) { var f = r.ok && r.data && r.data.found; if (f && (f.email || f.phone || f.name)) found++; next(i + 1); })
          .catch(function () { next(i + 1); });
      })(0);
    }
    // Bulk-set a lifecycle status on the selected prospects.
    function bulkSetStatus(ids, status) {
      if (!ids.length || !status) return;
      send("/prospects", "POST", { action: "bulk-update", ids: ids, status: status }).then(function (r) {
        if (r.ok) { toast("Moved " + (r.data.updated != null ? r.data.updated : ids.length) + " to " + statusLabel(status, prLifecycle)); load(); }
        else toast("Could not update (" + (r.data.error || r.status) + ")");
      }).catch(function () { toast("Could not reach the server."); });
    }
    // Bulk-assign a saved sequence (from the Campaign Sequences Library) to the
    // selected prospects, and move them into the sequence.
    function assignSequence(ids, seqId, seqName) {
      if (!ids.length || !seqId) return;
      send("/prospects", "POST", { action: "bulk-update", ids: ids, sequenceId: seqId, sequenceName: seqName }).then(function (r) {
        if (r.ok) { toast("Assigned " + (r.data.updated != null ? r.data.updated : ids.length) + " to “" + (seqName || "sequence") + "”"); load(); }
        else toast("Could not assign (" + (r.data.error || r.status) + ")");
      }).catch(function () { toast("Could not reach the server."); });
    }
    function openListsModal() {
      openModal("Saved prospect lists", "Pull these up in Campaign Studio to assign as a campaign's audience.",
        '<div id="plBody">' + loading() + '</div><div class="modal-foot"><button class="btn btn-ghost btn-sm" data-x>Close</button></div>',
        function (rootEl, close) {
          rootEl.querySelector("[data-x]").addEventListener("click", close);
          function paintLists(lists) {
            var host = rootEl.querySelector("#plBody"); if (!host) return;
            if (!lists.length) { host.innerHTML = '<div class="empty">No saved lists yet. Select prospects and click “Save as list”.</div>'; return; }
            host.innerHTML = lists.map(function (l) {
              return '<div class="integ"><span class="dot3" style="background:var(--brand-2)"></span><div class="meta"><b>' + esc(l.name) + "</b><small>" + (l.prospectIds || []).length + " prospects · " + esc(l.motion || "recruiting") + "</small></div>" +
                '<button class="btn btn-ghost btn-sm" data-del-list="' + esc(l.id) + '">Delete</button></div>';
            }).join("");
            Array.prototype.forEach.call(host.querySelectorAll("[data-del-list]"), function (b) {
              b.addEventListener("click", function () { if (!confirm("Delete this list? (The prospects themselves are not deleted.)")) return; listStore().remove(b.getAttribute("data-del-list")); loadLists(); });
            });
          }
          function loadLists() {
            paintLists(listStore().all());
            api("/prospect-lists?motion=" + encodeURIComponent(motion)).then(function (d) {
              var server = (d && d.lists) || [];
              if (server.length) {
                try { localStorage.setItem("ros_prospect_lists", JSON.stringify(server.concat(listStore().all().filter(function (l) { return !server.some(function (s) { return s.id === l.id; }); })))); } catch (e) {}
                paintLists(listStore().all());
              }
            }).catch(function () {});
          }
          loadLists();
        });
    }

    load();
    prospectsReload = load;
  }
  var prospectsReload = null;

  // Bulk-enrich every prospect missing a work email or phone, cheapest-first, in sequence.
  function enrichAllProspects(btn) {
    api("/prospects").then(function (d) {
      var list = ((d && d.prospects) || []).filter(function (p) { return !(p.email && p.phone); });
      if (!list.length) { toast("Every prospect already has an email and phone."); return; }
      btn.disabled = true; var done = 0;
      (function next(i) {
        if (i >= list.length) {
          btn.disabled = false; btn.textContent = "⚡ Enrich all contacts";
          toast("Enriched " + done + " of " + list.length + " prospect" + (list.length === 1 ? "" : "s"));
          if (prospectsReload) prospectsReload();
          return;
        }
        btn.textContent = "Enriching " + (i + 1) + "/" + list.length + "…";
        send("/prospects", "POST", { action: "enrich", prospectId: list[i].id })
          .then(function (r) { var f = r.ok && r.data && r.data.found; if (f && (f.email || f.phone)) done++; next(i + 1); })
          .catch(function () { next(i + 1); });
      })(0);
    }).catch(function () { toast("Could not reach the server."); });
  }

  /* ---------------- Campaigns (channel sequence builder) ----------------
     Campaigns is where you AUTHOR the message sequences, one per channel
     (Email / LinkedIn / SMS). Each opens a step-by-step editor modelled on a
     dedicated outreach sequencer: a named sequence, ordered steps with delays,
     merge fields + reusable custom variables, and a live overview. Assigning a
     prospect list and deploying happens in Campaign Studio. */

  var CHANNELS = {
    email: { label: "Email", icon: "✉️", blurb: "Subject + body touches with merge fields and open/click tracking.", unit: "emails" },
    linkedin: { label: "LinkedIn", icon: "🔗", blurb: "Connection requests, messages, InMail, and voice notes.", unit: "touches" },
    sms: { label: "SMS", icon: "💬", blurb: "Short, compliant post-engagement texts.", unit: "texts" },
    voice: { label: "Voice", icon: "📞", blurb: "Cloned-voice voicemail drops to landline / VoIP.", unit: "drops" },
    multi: { label: "Multi-channel", icon: "🔀", blurb: "One cadence that mixes email, LinkedIn and voicemail-drop touches.", unit: "touches" }
  };
  // Per-step channels selectable inside a multi-channel sequence.
  var STEP_CHANNELS = ["email", "linkedin", "voice"];
  var STD_VARS = [
    { key: "first_name", label: "First name" }, { key: "last_name", label: "Last name" },
    { key: "company", label: "Company" }, { key: "title", label: "Job title" },
    { key: "industry", label: "Industry" },
    { key: "role", label: "Role hiring for" }, { key: "signal", label: "Trigger signal" },
    { key: "sender_name", label: "Your name" }
  ];
  var LI_ACTIONS = [
    { v: "connect", label: "Connection request" }, { v: "message", label: "Message" },
    { v: "inmail", label: "InMail" }, { v: "voice_note", label: "Voice note" }
  ];
  function seqTemplate(channel) {
    if (channel === "email") return [
      { id: sid(), day: 0, tracking: true, subject: "{{role}} at {{company}}, quick idea", body: "Hi {{first_name}},\n\nNoticed {{signal}}. I work with people who'd be a strong fit for the {{role}} role, worth a short call this week?\n\nBest,\n{{sender_name}}" },
      { id: sid(), day: 3, tracking: true, subject: "Re: {{role}}", body: "Following up, {{first_name}}, happy to send a couple of profiles if it's useful." },
      { id: sid(), day: 5, tracking: true, subject: "Should I close the file?", body: "No worries if the timing's off, {{first_name}}, just let me know and I'll step back." }
    ];
    if (channel === "linkedin") return [
      { id: sid(), day: 0, action: "connect", text: "" },
      { id: sid(), day: 2, action: "message", text: "Thanks for connecting, {{first_name}}! Reaching out about {{signal}}, open to a quick chat?" },
      { id: sid(), day: 5, action: "message", text: "Circling back in case this got buried, happy to share details whenever works." }
    ];
    if (channel === "voice") return [
      { id: sid(), day: 0, voiceScriptId: "", text: "Hi {{first_name}}, this is {{sender_name}}, I work with people on the {{role}} side and had a quick idea for {{company}}. I'll follow up by email, but feel free to call me back. Thanks!" }
    ];
    if (channel === "multi") return [
      // A generic, industry-agnostic cross-channel cadence: warm on LinkedIn,
      // open + follow up by email, and break the pattern with a voicemail drop.
      { id: sid(), day: 0, channel: "linkedin", action: "connect", text: "" },
      { id: sid(), day: 2, channel: "email", tracking: true, subject: "{{role}} at {{company}}, quick idea", body: "Hi {{first_name}},\n\nNoticed {{signal}}. I work with people who'd be a strong fit for the {{role}} role, worth a short call this week?\n\nBest,\n{{sender_name}}" },
      { id: sid(), day: 2, channel: "linkedin", action: "message", text: "Thanks for connecting, {{first_name}}! Just sent a note over email about {{role}}, happy to share a couple of profiles if useful." },
      { id: sid(), day: 3, channel: "voice", voiceScriptId: "", text: "Hi {{first_name}}, it's {{sender_name}}, left you a note on email and LinkedIn about the {{role}} search. 30 seconds is all I need; call me back whenever works." },
      { id: sid(), day: 3, channel: "email", tracking: true, subject: "Re: {{role}}", body: "Following up, {{first_name}}, happy to send a couple of profiles if it's useful. Want me to?" },
      { id: sid(), day: 4, channel: "email", tracking: true, subject: "Should I close the file?", body: "No worries if the timing's off, {{first_name}}, just let me know and I'll step back." }
    ];
    return [
      { id: sid(), day: 0, text: "Hi {{first_name}}, it's {{sender_name}} following up on {{role}} at {{company}}. Got 10 min this week? Reply STOP to opt out." }
    ];
  }
  // A job-title + industry-specialist multi-channel cadence. Leans on {{title}}
  // and {{industry}} throughout, and intentionally uses BOTH a LinkedIn voice
  // note (a linkedin step with the voice_note action) and a cloned-voice
  // voicemail drop (a voice step) as the two highest-converting touches.
  function seqTemplateSpecialist() {
    return [
      { id: sid(), day: 0, channel: "linkedin", action: "connect", text: "Hi {{first_name}}, I focus on {{title}} talent across {{industry}} and kept coming across your name. Would love to connect." },
      { id: sid(), day: 2, channel: "email", tracking: true, subject: "{{title}} in {{industry}}, worth a quick word?", body: "Hi {{first_name}},\n\nI specialise in {{title}} roles across {{industry}}, so {{company}} is squarely on my radar. I work with a short list of people who'd raise the bar for a team like yours.\n\nOpen to a 10-minute call this week to compare notes on the {{industry}} market?\n\nBest,\n{{sender_name}}" },
      { id: sid(), day: 2, channel: "linkedin", action: "message", text: "Thanks for connecting, {{first_name}}! Just emailed you, I run a {{title}} desk in {{industry}} and had a couple of people in mind for {{company}}. Worth a quick chat?" },
      { id: sid(), day: 3, channel: "linkedin", action: "voice_note", text: "Hi {{first_name}}, it's {{sender_name}}, recording this quick voice note rather than typing. I work the {{title}} side of {{industry}} and genuinely think there's a conversation worth having for {{company}}. Reply whenever suits." },
      { id: sid(), day: 3, channel: "voice", voiceScriptId: "", text: "Hi {{first_name}}, it's {{sender_name}}, I left a note on email and LinkedIn. I specialise in {{title}} talent in {{industry}} and had a couple of names in mind for {{company}}. 30 seconds is all I need, give me a call back whenever works." },
      { id: sid(), day: 4, channel: "email", tracking: true, subject: "Re: {{title}} in {{industry}}", body: "Following up, {{first_name}}, happy to send over two or three {{title}} profiles I think are a strong fit for {{industry}}. Want me to?" },
      { id: sid(), day: 5, channel: "email", tracking: true, subject: "Should I close the file?", body: "No problem if the timing's off, {{first_name}}. I'll keep {{company}} on my {{industry}} list and circle back next quarter unless you'd like me to hold." }
    ];
  }
  function sid() { return "s_" + Math.random().toString(36).slice(2, 9); }

  // Sequence persistence: server is the source of truth, localStorage is a fast
  // mirror so the list paints instantly and survives offline (same pattern as
  // the Studio store).
  function seqStore() {
    function all() { try { return JSON.parse(localStorage.getItem("ros_sequences") || "[]"); } catch (e) { return []; } }
    return {
      all: all,
      save: function (s) {
        var l = all().filter(function (x) { return x.id !== s.id; }); l.unshift(s);
        localStorage.setItem("ros_sequences", JSON.stringify(l));
        send("/sequences", "PUT", s).catch(function () {});
      },
      remove: function (id) {
        localStorage.setItem("ros_sequences", JSON.stringify(all().filter(function (x) { return x.id !== id; })));
        // Return the promise so callers can wait for the server to drop it
        // before re-fetching (otherwise a reload's GET can race the DELETE and
        // momentarily re-add the row from the server copy).
        return fetch(API + "/sequences?id=" + encodeURIComponent(id), { method: "DELETE", credentials: "include" }).catch(function () {});
      }
    };
  }

  var cmpEdit = null; // null = home; else the sequence object being edited

  // One home for the whole campaign workflow: see everything (Library), build a
  // sequence (Build), and assign + launch it for a recruiter (Deploy). Three
  // sub-tabs over the existing renderers, same pattern as the Setup hub, so an
  // admin creates and deploys campaigns in one place. The studio/content routes
  // stay registered for deep links.
  var CAMPAIGN_SECTIONS = [
    { key: "", label: "Library", icon: "📚" },
    { key: "build", label: "Build", icon: "🎯" },
    { key: "deploy", label: "Deploy", icon: "🚀" }
  ];
  function renderCampaignsHub(el) {
    var detail = currentDetail();
    if (cmpEdit && detail !== "deploy") detail = "build"; // an open editor lives in Build
    var tabs = '<div class="setup-tabs">' + CAMPAIGN_SECTIONS.map(function (s) {
      return '<a class="setup-tab' + (s.key === detail ? " active" : "") + '" href="#campaigns' + (s.key ? "/" + s.key : "") + '">' +
        '<span class="ni">' + s.icon + '</span> ' + esc(s.label) + '</a>';
    }).join("") + '</div>';
    el.innerHTML = setupStyles() + tabs + '<div id="campHubBody"></div>';
    var body = el.querySelector("#campHubBody");
    if (detail === "build") return renderCampaigns(body);
    if (detail === "deploy") return renderStudio(body);
    return renderContent(body);
  }

  function renderCampaigns(el) {
    if (cmpEdit) { renderSeqEditor(el, cmpEdit); return; }
    renderSeqHome(el);
  }

  function seqDuration(s) { return (s.steps || []).reduce(function (a, st) { return a + (parseInt(st.day, 10) || 0); }, 0); }

  function renderSeqHome(el) {
    var store = seqStore();
    var cards = Object.keys(CHANNELS).map(function (ch) {
      var c = CHANNELS[ch];
      var n = store.all().filter(function (s) { return s.channel === ch && s.motion === motion; }).length;
      return '<button class="seq-new" data-new="' + ch + '"><span class="seq-new-ic">' + c.icon + "</span>" +
        '<span class="seq-new-t">' + c.label + " sequence</span>" +
        '<span class="seq-new-b">' + esc(c.blurb) + "</span>" +
        '<span class="seq-new-f">' + (n ? n + " saved · " : "") + "＋ New " + c.label + " sequence</span></button>";
    }).join("");

    el.innerHTML = head("Campaigns",
      "Build your outreach sequences here, one per channel. Pick a channel to create the message steps; assign prospects and deploy from Campaign Studio.") +
      '<div class="seq-new-grid">' + cards + "</div>" +
      '<div class="v-head" style="margin-top:8px"><h2 style="font-size:16px">Your sequences</h2></div>' +
      '<div id="seqList">' + loading() + "</div>";

    el.querySelector(".seq-new-grid").addEventListener("click", function (e) {
      var b = e.target.closest("[data-new]"); if (!b) return;
      openEditor(newSequence(b.getAttribute("data-new")));
    });

    paintList();

    function paintList() {
      // Local mirror first, then reconcile with the server.
      render(store.all());
      api("/sequences?motion=" + encodeURIComponent(motion)).then(function (d) {
        var server = (d && d.sequences) || [];
        if (server.length) {
          // Server wins; refresh the local mirror so both stay in sync.
          try { localStorage.setItem("ros_sequences", JSON.stringify(server.concat(store.all().filter(function (l) { return !server.some(function (s) { return s.id === l.id; }); })))); } catch (e) {}
          render(store.all());
        }
      }).catch(function () {});
    }

    function render(list) {
      var lb = $("#seqList"); if (!lb) return;
      var mine = list.filter(function (s) { return s.motion === motion; });
      if (!mine.length) { lb.innerHTML = '<div class="empty">No sequences yet. Pick a channel above to create your first one.</div>'; return; }
      lb.innerHTML = mine.map(function (s) {
        var c = CHANNELS[s.channel] || CHANNELS.email;
        var n = (s.steps || []).length;
        return '<div class="seq-row" data-edit="' + esc(s.id) + '"><span class="seq-ic">' + c.icon + "</span>" +
          '<div class="seq-meta"><div class="seq-name">' + esc(s.name) + "</div>" +
          '<div class="seq-sub"><span class="seq-chip ' + s.channel + '">' + c.label + "</span> " + n + " step" + (n === 1 ? "" : "s") + " · " + seqDuration(s) + " day" + (seqDuration(s) === 1 ? "" : "s") + "</div></div>" +
          '<button class="btn btn-ghost btn-sm" data-deploy="' + esc(s.id) + '">Deploy in Studio</button>' +
          '<button class="seq-del" data-del="' + esc(s.id) + '" title="Delete">🗑</button></div>';
      }).join("");
      Array.prototype.forEach.call(lb.querySelectorAll(".seq-row"), function (row) {
        row.addEventListener("click", function (e) {
          if (e.target.closest("[data-del]")) {
            var id = e.target.closest("[data-del]").getAttribute("data-del");
            if (!confirm("Delete this sequence?")) return;
            store.remove(id); toast("Deleted"); paintList(); return;
          }
          if (e.target.closest("[data-deploy]")) { location.hash = "campaigns/deploy"; return; }
          var eid = row.getAttribute("data-edit");
          var seq = store.all().filter(function (x) { return x.id === eid; })[0];
          if (seq) openEditor(seq);
        });
      });
    }
  }

  function newSequence(channel) {
    return { id: "seq_" + Date.now(), channel: channel, name: "New " + (CHANNELS[channel] || {}).label + " sequence",
      motion: motion === "bd" ? "bd" : "recruiting", owner: (ctx.user && ctx.user.name) || "You", status: "inactive",
      steps: seqTemplate(channel), tags: [], variables: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), _isNew: true };
  }
  function openEditor(seq) {
    // Work on a deep copy so Cancel discards cleanly. The editor lives in the
    // Campaigns hub's Build tab, so jump there if we're opening from elsewhere.
    cmpEdit = JSON.parse(JSON.stringify(seq));
    if (currentRoute() !== "campaigns" || currentDetail() !== "build") location.hash = "campaigns/build";
    else render();
  }

  function renderSeqEditor(el, seq) {
    var C = CHANNELS[seq.channel] || CHANNELS.email;
    var isMulti = seq.channel === "multi";
    var lastField = null; // last focused input/textarea, for merge-field insertion
    var voiceScripts = []; // populated async; bound to voice steps via a picker

    // The effective channel for a single step: its own (in a multi sequence) or
    // the sequence's channel for single-channel sequences / legacy steps.
    function stepCh(st) { return (isMulti && st.channel) ? st.channel : (st.channel || seq.channel); }

    el.innerHTML =
      '<div class="seq-top">' +
        '<button class="seq-back" id="seqBack">← Sequences</button>' +
        '<span class="seq-edit-lbl">' + (seq._isNew ? "NEW" : "EDIT") + " · " + C.label.toUpperCase() + "</span>" +
        '<div class="seq-top-actions"><button class="btn btn-ghost btn-sm" id="seqDeploy">Assign in Studio</button>' +
        '<button class="btn btn-primary btn-sm" id="seqSave">Save changes</button></div>' +
      "</div>" +
      '<div class="seq-edit-grid">' +
        '<div class="seq-main">' +
          '<input class="seq-title" id="seqTitle" value="' + esc(seq.name) + '" placeholder="Sequence name" />' +
          '<div class="seq-steps-h"><b>Steps</b> <span class="muted" id="seqStepCount"></span></div>' +
          '<div class="seq-enroll">▷ Enrollment starts</div>' +
          '<div id="seqSteps"></div>' +
          '<button class="seq-add" id="seqAdd">＋ Add step</button>' +
        "</div>" +
        '<aside class="seq-rail">' +
          '<div class="rail-card"><div class="rail-h">OVERVIEW</div><div class="rail-stats" id="seqOverview"></div></div>' +
          '<div class="rail-card"><div class="rail-h">TAGS</div><div id="seqTags" class="rail-tags"></div></div>' +
          '<div class="rail-card"><div class="rail-h">CUSTOM VARIABLES <button class="rail-add" id="seqAddVar">＋ Add</button></div>' +
            '<div class="muted" style="font-size:11px;margin:2px 0 8px">Click any field to place your cursor, then click a variable to insert it.</div>' +
            '<div id="seqVars" class="rail-vars"></div></div>' +
          '<div class="rail-card"><div class="rail-h">MERGE FIELDS</div><div id="seqMerge" class="rail-vars"></div></div>' +
        "</aside>" +
      "</div>";

    $("#seqBack").addEventListener("click", function () { cmpEdit = null; render(); });
    $("#seqDeploy").addEventListener("click", function () { saveSeq(true); });
    $("#seqSave").addEventListener("click", function () { saveSeq(false); });
    function blankStep(ch) {
      if (ch === "email") return { id: sid(), day: 3, channel: isMulti ? "email" : undefined, tracking: true, subject: "", body: "" };
      if (ch === "linkedin") return { id: sid(), day: 2, channel: isMulti ? "linkedin" : undefined, action: "message", text: "" };
      if (ch === "voice") return { id: sid(), day: 2, channel: isMulti ? "voice" : undefined, voiceScriptId: "", text: "" };
      return { id: sid(), day: 2, channel: isMulti ? "sms" : undefined, text: "" };
    }
    $("#seqAdd").addEventListener("click", function (e) {
      if (!isMulti) { seq.steps.push(blankStep(seq.channel)); paintSteps(); return; }
      // Multi-channel: pick which channel the new step runs on.
      openStepChannelMenu(e.currentTarget);
    });
    function openStepChannelMenu(anchor) {
      var old = document.getElementById("seqAddMenu"); if (old) old.remove();
      var menu = document.createElement("div"); menu.id = "seqAddMenu"; menu.className = "seq-varmenu";
      menu.innerHTML = STEP_CHANNELS.map(function (ch) {
        var c = CHANNELS[ch];
        return '<button data-ch="' + ch + '"><code>' + c.icon + "</code><span>" + esc(c.label) + " step</span></button>";
      }).join("");
      document.body.appendChild(menu);
      var r = anchor.getBoundingClientRect();
      menu.style.top = (r.bottom + 4) + "px"; menu.style.left = Math.min(r.left, window.innerWidth - 280) + "px";
      function close() { menu.remove(); document.removeEventListener("click", outside, true); }
      function outside(ev) { if (!menu.contains(ev.target) && ev.target !== anchor) close(); }
      setTimeout(function () { document.addEventListener("click", outside, true); }, 0);
      menu.addEventListener("click", function (ev) {
        var b = ev.target.closest("[data-ch]"); if (!b) return;
        seq.steps.push(blankStep(b.getAttribute("data-ch"))); close(); paintSteps(); updateOverview();
      });
    }
    $("#seqAddVar").addEventListener("click", function () {
      var label = prompt("What does this variable hold? (e.g. Candidate A sell-in)");
      if (!label) return;
      var n = (seq.variables || []).length + 1;
      seq.variables = seq.variables || [];
      seq.variables.push({ key: "custom_variable" + n, label: label });
      paintVars();
    });

    // Track focus so a merge/variable click inserts at the cursor.
    el.addEventListener("focusin", function (e) {
      if (e.target.matches("input.seq-f, textarea.seq-f")) lastField = e.target;
    });

    paintSteps(); paintVars(); paintMerge(); paintTags(); updateOverview();

    /* ---- steps ---- */
    function paintSteps() {
      var host = $("#seqSteps"); if (!host) return;
      host.innerHTML = seq.steps.map(function (st, i) { return stepCard(st, i); }).join("");
      // wire each step
      Array.prototype.forEach.call(host.querySelectorAll(".seq-step"), function (cardEl) {
        var i = parseInt(cardEl.getAttribute("data-i"), 10);
        cardEl.querySelector("[data-del-step]").addEventListener("click", function () {
          seq.steps.splice(i, 1); paintSteps(); updateOverview();
        });
        var coll = cardEl.querySelector("[data-collapse]");
        if (coll) coll.addEventListener("click", function () { cardEl.classList.toggle("collapsed"); });
        // field bindings
        Array.prototype.forEach.call(cardEl.querySelectorAll("[data-f]"), function (f) {
          var key = f.getAttribute("data-f");
          var ev = (f.type === "checkbox") ? "change" : "input";
          f.addEventListener(ev, function () {
            if (f.type === "checkbox") seq.steps[i][key] = f.checked;
            else seq.steps[i][key] = (key === "day") ? (parseInt(f.value, 10) || 0) : f.value;
            if (key === "day") updateOverview();
            if (key === "text" && stepCh(seq.steps[i]) === "sms") { var cc = cardEl.querySelector("[data-sms-count]"); if (cc) cc.textContent = smsCount(f.value); }
            if (key === "action") paintSteps(); // LinkedIn fields depend on the action
          });
        });
        var mt = cardEl.querySelector("[data-manual]");
        if (mt) mt.addEventListener("click", function () { seq.steps[i].manualSend = !seq.steps[i].manualSend; mt.classList.toggle("on", seq.steps[i].manualSend); });
      });
      var sc = $("#seqStepCount"); if (sc) sc.textContent = "· " + seq.steps.length + " total";
    }

    function stepCard(st, i) {
      var ch = stepCh(st), cc = CHANNELS[ch] || CHANNELS.email;
      var delayLbl = i === 0 ? "days after enrollment" : "days after previous step";
      var head = '<div class="seq-step-h"><span class="seq-grip">≡</span><b>Step ' + (i + 1) + "</b>" +
        '<span class="seq-chip ' + ch + '">' + cc.icon + " " + cc.label + "</span>" +
        (ch === "email" ? '<label class="seq-manual"><span class="muted">Manual send</span><button type="button" class="or-sw' + (st.manualSend ? " on" : "") + '" data-manual></button></label>' : "") +
        '<button class="seq-mini" data-collapse title="Collapse">▾</button>' +
        '<button class="seq-mini" data-del-step title="Delete step">🗑</button></div>';
      var delay = '<div class="seq-delay"><label>Delay</label><input class="seq-f seq-day" type="number" min="0" data-f="day" value="' + (st.day || 0) + '" /><span class="muted">' + delayLbl + "</span></div>";
      return '<div class="seq-step" data-i="' + i + '">' + head + '<div class="seq-step-b">' + delay + channelFields(st) + "</div></div>";
    }

    function channelFields(st) {
      var ch = stepCh(st);
      if (ch === "voice") {
        var opts = '<option value="">- No bound script (use text below) -</option>' +
          voiceScripts.map(function (v) { return '<option value="' + esc(v.id) + '"' + (st.voiceScriptId === v.id ? " selected" : "") + ">" + esc(v.name) + "</option>"; }).join("");
        return fieldLabel("Voicemail script") +
          '<select class="seq-f seq-input" data-f="voiceScriptId">' + opts + "</select>" +
          '<div class="muted" style="font-size:11px;margin:4px 0">Bind a reusable Voice Drops script (cloned voice), or just write the talking points below. Drops to landline / VoIP only; mobiles are filtered.</div>' +
          fieldLabel("Talking points") +
          '<textarea class="seq-f seq-area" data-f="text" rows="4" placeholder="What the voicemail should say… {{first_name}} / {{role}} splice in like an email merge.">' + esc(st.text || "") + "</textarea>";
      }
      if (ch === "email") {
        return fieldLabel("Subject") +
          '<input class="seq-f seq-input" data-f="subject" value="' + esc(st.subject || "") + '" placeholder="Subject line" />' +
          fieldLabel("Body") + bodyToolbar() +
          '<textarea class="seq-f seq-area" data-f="body" rows="7" placeholder="Write your email… use merge fields like {{first_name}}">' + esc(st.body || "") + "</textarea>" +
          '<label class="seq-check"><input class="seq-f" type="checkbox" data-f="tracking"' + (st.tracking ? " checked" : "") + " /> Enable open &amp; click tracking</label>";
      }
      if (ch === "linkedin") {
        var opts = LI_ACTIONS.map(function (a) { return '<option value="' + a.v + '"' + (st.action === a.v ? " selected" : "") + ">" + a.label + "</option>"; }).join("");
        var sel = fieldLabel("Action") + '<select class="seq-f seq-input" data-f="action">' + opts + "</select>";
        if (st.action === "inmail") {
          return sel + fieldLabel("Subject") + '<input class="seq-f seq-input" data-f="subject" value="' + esc(st.subject || "") + '" placeholder="InMail subject" />' +
            fieldLabel("Message") + '<textarea class="seq-f seq-area" data-f="text" rows="6" placeholder="InMail body…">' + esc(st.text || "") + "</textarea>";
        }
        var lbl = st.action === "connect" ? "Connection note (optional)" : st.action === "voice_note" ? "Voice note script" : "Message";
        var ph = st.action === "connect" ? "Short note sent with the request, empty often accepts higher." : "Write your message… merge fields like {{first_name}} work here.";
        return sel + fieldLabel(lbl) + '<textarea class="seq-f seq-area" data-f="text" rows="5" placeholder="' + esc(ph) + '">' + esc(st.text || "") + "</textarea>";
      }
      // sms
      return fieldLabel("Message") +
        '<textarea class="seq-f seq-area" data-f="text" rows="4" placeholder="Short text… keep it under 160 chars. Include an opt-out.">' + esc(st.text || "") + "</textarea>" +
        '<div class="muted" style="font-size:11px;margin-top:4px" data-sms-count>' + smsCount(st.text || "") + "</div>";
    }

    function fieldLabel(t) { return '<div class="seq-flabel">' + esc(t) + ' <button type="button" class="seq-insert" data-insert>{} Insert merge field</button></div>'; }
    function bodyToolbar() {
      return '<div class="seq-toolbar"><button type="button" data-fmt="b"><b>B</b></button><button type="button" data-fmt="i"><i>I</i></button>' +
        '<button type="button" data-fmt="ul">• List</button><button type="button" data-fmt="ol">1. List</button>' +
        '<button type="button" class="seq-insert" data-insert>{} Insert merge field</button></div>';
    }

    /* ---- variables / merge fields ---- */
    function paintVars() {
      var host = $("#seqVars"); if (!host) return;
      var vars = seq.variables || [];
      host.innerHTML = vars.length ? vars.map(function (v) {
        return '<div class="var-chip" data-ins-key="' + esc(v.key) + '"><code>{{' + esc(v.key) + "}}</code><span>" + esc(v.label) + "</span>" +
          '<button class="var-x" data-del-var="' + esc(v.key) + '" title="Remove">×</button></div>';
      }).join("") : '<div class="muted" style="font-size:12px">None yet. Add reusable values like "Candidate A sell-in".</div>';
      Array.prototype.forEach.call(host.querySelectorAll(".var-chip"), function (chip) {
        chip.addEventListener("click", function (e) {
          if (e.target.closest("[data-del-var]")) {
            var k = e.target.closest("[data-del-var]").getAttribute("data-del-var");
            seq.variables = seq.variables.filter(function (v) { return v.key !== k; }); paintVars(); return;
          }
          insertToken(chip.getAttribute("data-ins-key"));
        });
      });
    }
    function paintMerge() {
      var host = $("#seqMerge"); if (!host) return;
      host.innerHTML = STD_VARS.map(function (v) {
        return '<div class="var-chip" data-ins-key="' + v.key + '"><code>{{' + v.key + "}}</code><span>" + esc(v.label) + "</span></div>";
      }).join("");
      Array.prototype.forEach.call(host.querySelectorAll(".var-chip"), function (chip) {
        chip.addEventListener("click", function () { insertToken(chip.getAttribute("data-ins-key")); });
      });
    }
    function paintTags() {
      var host = $("#seqTags"); if (!host) return;
      var tags = seq.tags || [];
      host.innerHTML = tags.map(function (t, i) { return '<span class="tag-chip">' + esc(t) + '<button data-del-tag="' + i + '">×</button></span>'; }).join("") +
        '<button class="tag-add" id="seqAddTag">＋ Add tag</button>';
      var add = $("#seqAddTag");
      if (add) add.addEventListener("click", function () {
        if ((seq.tags || []).length >= 10) { toast("Up to 10 tags."); return; }
        var t = prompt("Tag:"); if (!t) return; seq.tags = (seq.tags || []).concat(t.trim()); paintTags();
      });
      Array.prototype.forEach.call(host.querySelectorAll("[data-del-tag]"), function (b) {
        b.addEventListener("click", function () { seq.tags.splice(parseInt(b.getAttribute("data-del-tag"), 10), 1); paintTags(); });
      });
    }

    function insertToken(key) {
      var token = "{{" + key + "}}";
      if (!lastField) { toast("Click into a subject or body first."); return; }
      var f = lastField, start = f.selectionStart || 0, end = f.selectionEnd || 0, v = f.value;
      f.value = v.slice(0, start) + token + v.slice(end);
      var pos = start + token.length; f.focus(); try { f.setSelectionRange(pos, pos); } catch (e) {}
      f.dispatchEvent(new Event("input", { bubbles: true })); // sync into seq
    }

    function updateOverview() {
      var host = $("#seqOverview"); if (!host) return;
      var dur = seqDuration(seq), n = seq.steps.length;
      var cells = [["DURATION", dur + (dur === 1 ? " day" : " days")], ["STEPS", n]];
      if (isMulti) {
        ["email", "linkedin", "voice"].forEach(function (ch) {
          var k = seq.steps.filter(function (s) { return stepCh(s) === ch; }).length;
          if (k) cells.push([CHANNELS[ch].label.toUpperCase(), k]);
        });
      } else if (seq.channel === "email") {
        cells.push([C.unit.toUpperCase(), seq.steps.length]);
        cells.push(["TASKS", seq.steps.filter(function (s) { return s.manualSend; }).length]);
      } else cells.push([C.unit.toUpperCase(), n]);
      host.innerHTML = cells.map(function (c) { return '<div class="rail-stat"><b>' + c[1] + "</b><span>" + c[0] + "</span></div>"; }).join("");
    }

    // Load reusable Voice Drops scripts so voice steps can bind one. Repaints the
    // steps once they arrive (the picker starts with just the text-only option).
    (function loadEditorVoiceScripts() {
      if (!isMulti && seq.channel !== "voice") return;
      api("/voice/scripts?motion=" + encodeURIComponent(seq.motion || motion)).then(function (d) {
        voiceScripts = (d && d.scripts) || [];
        if (voiceScripts.length) paintSteps();
      }).catch(function () {});
    })();

    // formatting toolbar (basic), wrap selection / prefix lines in the focused body
    el.addEventListener("click", function (e) {
      var fmt = e.target.closest("[data-fmt]"); if (!fmt) return;
      var f = lastField; if (!f || f.tagName !== "TEXTAREA") { toast("Click into the body first."); return; }
      applyFormat(f, fmt.getAttribute("data-fmt"));
    });

    // Inline "{} Insert merge field", focus the field this label/toolbar owns,
    // then open a small picker of custom + standard variables.
    el.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-insert]"); if (!btn) return;
      var step = btn.closest(".seq-step"); if (!step) return;
      // The owned field is the next text input/textarea after this button.
      var fields = Array.prototype.slice.call(step.querySelectorAll("input.seq-f, textarea.seq-f"));
      var after = null, seen = false, walker = step.querySelectorAll("*");
      Array.prototype.forEach.call(walker, function (node) {
        if (node === btn) seen = true;
        else if (seen && !after && (node.matches("input.seq-f") || node.matches("textarea.seq-f"))) after = node;
      });
      lastField = after || fields[fields.length - 1];
      if (lastField) { lastField.focus(); }
      openVarMenu(btn, seq.variables || []);
    });

    function openVarMenu(anchor, vars) {
      var old = document.getElementById("seqVarMenu"); if (old) old.remove();
      var menu = document.createElement("div"); menu.id = "seqVarMenu"; menu.className = "seq-varmenu";
      var items = (vars || []).concat(STD_VARS);
      menu.innerHTML = items.map(function (v) { return '<button data-k="' + esc(v.key) + '"><code>{{' + esc(v.key) + "}}</code><span>" + esc(v.label) + "</span></button>"; }).join("");
      document.body.appendChild(menu);
      var r = anchor.getBoundingClientRect();
      menu.style.top = (r.bottom + 4) + "px"; menu.style.left = Math.min(r.left, window.innerWidth - 280) + "px";
      function close() { menu.remove(); document.removeEventListener("click", outside, true); }
      function outside(ev) { if (!menu.contains(ev.target) && ev.target !== anchor) close(); }
      setTimeout(function () { document.addEventListener("click", outside, true); }, 0);
      menu.addEventListener("click", function (ev) { var b = ev.target.closest("[data-k]"); if (!b) return; insertToken(b.getAttribute("data-k")); close(); });
    }

    function saveSeq(toStudio) {
      var title = $("#seqTitle"); if (title) seq.name = (title.value || "").trim() || seq.name;
      if (!seq.steps.length) { toast("Add at least one step."); return; }
      delete seq._isNew;
      seq.updatedAt = new Date().toISOString();
      seqStore().save(seq);
      toast("Sequence saved");
      cmpEdit = null;
      if (toStudio) location.hash = "campaigns/deploy"; else render();
    }
  }

  function smsCount(t) {
    var len = (t || "").length, seg = Math.max(1, Math.ceil(len / 160));
    return len + " chars · " + seg + " segment" + (seg === 1 ? "" : "s");
  }
  function applyFormat(f, kind) {
    var s = f.selectionStart || 0, e = f.selectionEnd || 0, v = f.value, sel = v.slice(s, e);
    var out, caret;
    if (kind === "b" || kind === "i") {
      var w = kind === "b" ? "**" : "_"; out = v.slice(0, s) + w + (sel || "text") + w + v.slice(e); caret = s + w.length + (sel || "text").length + w.length;
    } else {
      var pre = kind === "ul" ? "- " : "1. ";
      var lines = (sel || "item").split("\n").map(function (l) { return pre + l; }).join("\n");
      out = v.slice(0, s) + lines + v.slice(e); caret = s + lines.length;
    }
    f.value = out; f.focus(); try { f.setSelectionRange(caret, caret); } catch (x) {}
    f.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /* ---------------- Campaign Studio (embedded drag-and-drop builder) ---------------- */
  var studioOpenId = null; // set when opening a saved campaign from the Campaigns view

  // Persistence the Studio writes through: it upserts to the backend (the source
  // of truth) and mirrors to localStorage as a fast local cache for instant load.
  function studioStore() {
    function all() { try { return JSON.parse(localStorage.getItem("ros_campaigns") || "[]"); } catch (e) { return []; } }
    return {
      all: all,
      save: function (c) {
        var l = all().filter(function (x) { return x.id !== c.id; }); l.unshift(c);
        localStorage.setItem("ros_campaigns", JSON.stringify(l));
        send("/campaigns", "PUT", c).catch(function () {});
      },
      remove: function (id) {
        localStorage.setItem("ros_campaigns", JSON.stringify(all().filter(function (x) { return x.id !== id; })));
        fetch(API + "/campaigns?id=" + encodeURIComponent(id), { method: "DELETE", credentials: "include" }).catch(function () {});
      }
    };
  }

  /* ---------------- Autopilot command center ----------------
     One screen: pull every hiring signal -> enrich -> run approved, sequenced
     campaigns hands-off. The "set it and forget it" surface. Backed by
     /api/autopilot. Works for BD (auto-pull hiring signals) and Recruiting
     (sequence candidates sourced in JD Sourcing); the approve-once model gate is
     identical for both motions. */
  function apEvery(ms) {
    var s = Math.round(ms / 1000);
    if (s < 90) return s + "s";
    var m = Math.round(s / 60); if (m < 90) return "every " + m + "m";
    var h = Math.round(m / 60); return "every " + h + "h";
  }
  function apWhen(iso) {
    if (!iso) return "";
    var d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 60) return "just now"; if (d < 3600) return Math.floor(d / 60) + "m ago";
    if (d < 86400) return Math.floor(d / 3600) + "h ago"; return Math.floor(d / 86400) + "d ago";
  }
  var AP_CH = { email: "✉️", linkedin: "💼", voice: "📞" };

  function renderAutopilot(el) {
    el.innerHTML = head("Autopilot",
      "Pull every hiring signal, enrich it, and let approved campaigns run themselves. Draft the outreach with AI, approve it once, then set it and forget it.") +
      '<div id="apWrap">' + loading() + "</div>";
    load();

    function load() {
      api("/autopilot").then(function (d) {
        if (!d) { $("#apWrap").innerHTML = '<div class="empty">Could not load Autopilot. Try refreshing.</div>'; return; }
        paint(d);
      });
    }

    function paint(d) {
      var camps = d.campaigns || [];
      var live = camps.filter(function (c) { return c.autoRun && c.outreachApproved && c.status === "active"; });
      var sig = d.signals || null;

      // ---- engine status strip ----
      var engineOn = d.enabled && d.armed;
      var statusCard =
        '<div class="ap-engine ' + (engineOn ? "on" : "off") + '">' +
          '<div class="ap-engine-main">' +
            '<span class="ap-dot ' + (engineOn ? "on" : "off") + '"></span>' +
            '<div><div class="ap-engine-t">Automation engine ' + (engineOn ? "is running" : "is off") + "</div>" +
            '<div class="ap-engine-s">' + (engineOn
              ? live.length + " campaign" + (live.length === 1 ? "" : "s") + " live on Autopilot · the portal is its own clock, no n8n"
              : (d.enabled ? "Enabled, arming on next boot." : "Set AUTOMATION_ENABLED=on on the server, then redeploy, to arm the clock.")) +
            "</div></div>" +
          "</div>" +
          '<div class="ap-ticks">' + (d.ticks || []).map(function (t) {
            return '<span class="ap-tick" title="' + esc(t.label) + '"><b>' + esc(t.label) + "</b>" + apEvery(t.everyMs) + "</span>";
          }).join("") + "</div>" +
          '<button class="btn btn-primary btn-sm" id="apRunNow">▶ Run a cycle now</button>' +
        "</div>";

      // ---- pipeline visual ----
      var poolTotal = sig ? (sig.total || 0) : 0;
      var poolPos = sig ? (sig.openPositions || 0) : 0;
      var queuedAll = camps.reduce(function (a, c) { return a + (c.counts.queued || 0); }, 0);
      var inSeqAll = camps.reduce(function (a, c) { return a + (c.counts.inSequence || 0); }, 0);
      var pipeline =
        '<div class="ap-pipe">' +
          apStage("📡", "Hiring signals", poolTotal.toLocaleString() + " companies", poolPos ? poolPos.toLocaleString() + " open roles" : "live pool") +
          '<span class="ap-arrow">→</span>' +
          apStage("✨", "Enrich + draft", "email · phone · LinkedIn", "AI personalization") +
          '<span class="ap-arrow">→</span>' +
          apStage("🎯", "Sequenced campaigns", live.length + " live", queuedAll + " queued · " + inSeqAll + " in sequence") +
        "</div>";

      // ---- signals pull panel (BD) ----
      var bdCamps = camps.filter(function (c) { return c.motion === "bd"; });
      var sigPanel =
        '<div class="card ap-card"><div class="ap-card-h"><h3>📡 Pull from hiring signals</h3>' +
          '<span class="muted">' + (sig ? ("Updated " + (apWhen(sig.lastAddedAt) || "recently") + " · " + (sig.addedToday || 0) + " added today · " + (sig.windowDays || 90) + "-day window") : "Pool warms in the background") + "</span></div>" +
          (sig && sig.breakdown && sig.breakdown.length
            ? '<div class="ap-sigchips">' + sig.breakdown.slice(0, 14).map(function (b) {
                return '<label class="ap-sigchip"><input type="checkbox" class="apSig" value="' + esc(b.signalType) + '"> ' + esc(prettySignal(b.signalType)) + ' <b>' + b.count + "</b></label>";
              }).join("") + "</div>"
            : '<div class="muted" style="margin:6px 0 10px">No signals pooled yet — the background accumulator fills this within a day of deploy (needs a database).</div>') +
          '<div class="ap-pullform">' +
            '<label>Stage onto<select id="apTarget">' +
              (bdCamps.length ? bdCamps.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + (c.autoRun && c.outreachApproved ? " · live" : "") + "</option>"; }).join("") : '<option value="">— create a BD campaign first —</option>') +
            "</select></label>" +
            '<label>How many<input type="number" id="apLimit" value="50" min="1" max="500"></label>' +
            '<label>Contacts / company<select id="apPer"><option value="1">1 (decision-maker)</option><option value="3">3 (manager + dept)</option><option value="5">5 (full ladder)</option></select></label>' +
            '<label class="ap-check"><input type="checkbox" id="apDial"> Find direct dials <span class="muted">(+cost)</span></label>' +
            '<button class="btn btn-primary" id="apPull">Pull, enrich &amp; stage</button>' +
          "</div>" +
          '<div id="apPullMsg" class="muted" style="margin-top:8px"></div>' +
        "</div>";

      // ---- campaigns workflow table ----
      var campRows = camps.length ? camps.map(campRow).join("") :
        '<div class="empty">No campaigns yet. Create one to draft a model and arm Autopilot.</div>';
      var campPanel =
        '<div class="card ap-card"><div class="ap-card-h"><h3>🎯 Campaigns &amp; workflows</h3>' +
          '<button class="btn btn-ghost btn-sm" id="apNew">＋ New campaign</button></div>' +
          '<div class="ap-camps">' + campRows + "</div>" +
          '<p class="muted" style="margin:10px 2px 0">Workflow: <b>Draft model</b> (AI writes the sequence) → <b>Review &amp; approve</b> the outreach → <b>Autopilot on</b>. Ongoing prospects then flow through the approved templates automatically.</p>' +
        "</div>";

      // ---- activity feed ----
      var acts = d.activity || [];
      var actPanel =
        '<div class="card ap-card"><div class="ap-card-h"><h3>📜 Recent activity</h3></div>' +
          (acts.length ? '<div class="ap-acts">' + acts.slice(0, 25).map(function (a) {
            return '<div class="ap-act"><span class="ap-act-ic">' + (AP_CH[a.channel] || "•") + "</span>" +
              '<div class="ap-act-m"><b>' + esc(a.type || "event") + "</b> " + esc(a.summary || "") + "</div>" +
              '<span class="ap-act-t">' + apWhen(a.at) + "</span></div>";
          }).join("") + "</div>" : '<div class="muted">No sends yet. Approve a campaign and run a cycle.</div>') +
        "</div>";

      $("#apWrap").innerHTML = statusCard + pipeline +
        '<div class="ap-grid">' + sigPanel + campPanel + "</div>" + actPanel;

      bind(d);
    }

    function campRow(c) {
      var motionBadge = '<span class="ap-badge ' + c.motion + '">' + (c.motion === "bd" ? "BD" : "Recruiting") + "</span>";
      var stageBtn, stageCls;
      if (!c.hasModel) { stageBtn = '<button class="btn btn-primary btn-sm" data-ap="draft" data-id="' + c.id + '">✨ Draft model</button>'; stageCls = "todraft"; }
      else if (!c.outreachApproved) { stageBtn = '<button class="btn btn-primary btn-sm" data-ap="review" data-id="' + c.id + '">👀 Review &amp; approve</button>'; stageCls = "toreview"; }
      else {
        stageCls = "approved";
        stageBtn = '<span class="ap-approved">✓ Model approved</span>' +
          '<label class="ap-toggle"><input type="checkbox" class="apAuto" data-id="' + c.id + '"' + (c.autoRun ? " checked" : "") + '> Autopilot</label>' +
          '<button class="btn btn-ghost btn-sm" data-ap="review" data-id="' + c.id + '">View</button>';
      }
      var cc = c.counts;
      return '<div class="ap-camp ' + stageCls + '">' +
        '<div class="ap-camp-meta"><div class="ap-camp-n">' + esc(c.name) + " " + motionBadge +
          (c.autoRun && c.outreachApproved && c.status === "active" ? ' <span class="ap-live">● LIVE</span>' : "") + "</div>" +
          '<div class="ap-camp-s">' + esc(c.methodology || "") + (c.modelTouches ? " · " + c.modelTouches + " touches" : "") +
          (c.modelEngine ? ' · <span class="muted">' + esc(c.modelEngine === "library" ? "template draft" : "AI-drafted") + "</span>" : "") + "</div></div>" +
        '<div class="ap-camp-counts">' +
          apCount(cc.queued, "queued") + apCount(cc.inSequence, "in seq") + apCount(cc.nurture, "nurture") + apCount(cc.replied, "replied") +
        "</div>" +
        '<div class="ap-camp-act">' + stageBtn + "</div>" +
      "</div>";
    }

    function bind(d) {
      var run = $("#apRunNow"); if (run) run.addEventListener("click", function () {
        run.disabled = true; run.textContent = "Running…";
        send("/autopilot", "POST", { action: "run-now" }).then(function (r) {
          if (r.ok) toast("Ran a cycle: " + (r.data.sent || 0) + " sent across " + (r.data.campaigns || 0) + " campaign(s)");
          else toast("Run failed: " + (r.data && r.data.error || "error"));
          load();
        });
      });

      var nw = $("#apNew"); if (nw) nw.addEventListener("click", apCreateCampaign);

      var pull = $("#apPull"); if (pull) pull.addEventListener("click", function () {
        var target = $("#apTarget").value;
        if (!target) { toast("Create a BD campaign first"); return; }
        var sigs = Array.prototype.map.call(document.querySelectorAll(".apSig:checked"), function (x) { return x.value; });
        var payload = { action: "pull", campaignId: target, limit: parseInt($("#apLimit").value, 10) || 50,
          contactsPerCompany: parseInt($("#apPer").value, 10) || 1, findDirectDial: $("#apDial").checked };
        if (sigs.length) payload.signalTypes = sigs;
        pull.disabled = true; var msg = $("#apPullMsg"); msg.textContent = "Pulling and enriching…";
        send("/autopilot", "POST", payload).then(function (r) {
          pull.disabled = false;
          if (r.ok) { msg.innerHTML = "✓ Staged <b>" + r.data.promoted + "</b> prospects (" + r.data.withEmail + " with email, " + r.data.withPhone + " with phone) from " + r.data.pulled + " companies."; toast("Staged " + r.data.promoted + " prospects"); load(); }
          else { msg.textContent = "Pull failed: " + (r.data && r.data.detail || r.data && r.data.error || "error"); }
        });
      });

      Array.prototype.forEach.call(document.querySelectorAll(".apAuto"), function (cb) {
        cb.addEventListener("change", function () {
          send("/autopilot", "POST", { action: "set-autorun", campaignId: cb.getAttribute("data-id"), autoRun: cb.checked }).then(function (r) {
            if (r.ok) toast(cb.checked ? "Autopilot on 🤖" : "Autopilot off");
            else { toast((r.data && r.data.detail) || "Could not toggle"); cb.checked = !cb.checked; }
            load();
          });
        });
      });

      Array.prototype.forEach.call(document.querySelectorAll("[data-ap]"), function (b) {
        var act = b.getAttribute("data-ap"), id = b.getAttribute("data-id");
        if (act === "draft") b.addEventListener("click", function () { apDraftModel(id, b); });
        if (act === "review") b.addEventListener("click", function () { apReviewModel(id); });
      });
    }

    function apDraftModel(id, btn) {
      if (btn) { btn.disabled = true; btn.textContent = "Drafting…"; }
      send("/autopilot", "POST", { action: "draft-model", campaignId: id }).then(function (r) {
        if (r.ok) { toast("Model drafted — review it"); apShowModel(id, r.data.model); }
        else { toast("Draft failed: " + (r.data && r.data.detail || r.data && r.data.error || "error")); load(); }
      });
    }

    function apReviewModel(id) {
      // Fetch the STORED model (no re-draft — that would burn an LLM call and reset
      // approval). If none exists yet, draft one.
      send("/autopilot", "POST", { action: "get-model", campaignId: id }).then(function (r) {
        if (r.ok && r.data.model && r.data.model.touches && r.data.model.touches.length) apShowModel(id, r.data.model);
        else apDraftModel(id);
      });
    }

    function apShowModel(id, model) {
      var touches = (model && model.touches) || [];
      var rows = touches.map(function (t, i) {
        return '<div class="ap-touch" data-i="' + i + '">' +
          '<div class="ap-touch-h"><span class="ap-touch-ic">' + (AP_CH[t.channel] || "•") + "</span>" +
            '<input class="ap-t-label" value="' + esc(t.label || "") + '">' +
            '<span class="ap-t-day">day <input type="number" class="ap-t-dayv" value="' + (t.day || 0) + '" min="0"></span>' +
            '<span class="ap-t-ch">' + esc(t.channel) + (t.action ? " · " + esc(t.action) : "") + "</span></div>" +
          (t.channel === "email" ? '<input class="ap-t-subj" placeholder="Subject" value="' + esc(t.subject || "") + '">' : "") +
          '<textarea class="ap-t-body" rows="4">' + esc(t.body || "") + "</textarea>" +
        "</div>";
      }).join("");
      var bodyHtml =
        '<div class="ap-model">' +
          '<p class="muted">' + esc(model && model.summary || "Review the sequence. Edit any step, then approve to arm Autopilot.") +
            (model && model.engine === "library" ? " (Template draft — set ANTHROPIC_API_KEY for AI-written copy.)" : "") + "</p>" +
          '<div class="ap-touches">' + rows + "</div>" +
          '<div class="ap-model-foot">' +
            '<button class="btn btn-ghost" id="apSaveModel">Save edits</button>' +
            '<button class="btn btn-primary" id="apApprove">✓ Approve &amp; arm Autopilot</button>' +
          "</div>" +
        "</div>";
      openModal("Review the outreach model", "Approve once — then ongoing prospects run on these templates automatically.", bodyHtml, function (root, close) {
        function collect() {
          return Array.prototype.map.call(root.querySelectorAll(".ap-touch"), function (n) {
            var subj = n.querySelector(".ap-t-subj");
            return { key: touches[+n.getAttribute("data-i")] && touches[+n.getAttribute("data-i")].key,
              label: n.querySelector(".ap-t-label").value, day: parseInt(n.querySelector(".ap-t-dayv").value, 10) || 0,
              channel: touches[+n.getAttribute("data-i")].channel, action: touches[+n.getAttribute("data-i")].action,
              subject: subj ? subj.value : undefined, body: n.querySelector(".ap-t-body").value };
          });
        }
        root.querySelector("#apSaveModel").addEventListener("click", function () {
          send("/autopilot", "POST", { action: "update-model", campaignId: id, touches: collect() }).then(function (r) {
            toast(r.ok ? "Edits saved" : "Save failed");
          });
        });
        root.querySelector("#apApprove").addEventListener("click", function () {
          // Save edits first, then approve, then arm Autopilot — the one-click "deploy".
          send("/autopilot", "POST", { action: "update-model", campaignId: id, touches: collect() }).then(function () {
            return send("/autopilot", "POST", { action: "approve-model", campaignId: id });
          }).then(function (r) {
            if (!r.ok) { toast("Approve failed"); return; }
            return send("/autopilot", "POST", { action: "set-autorun", campaignId: id, autoRun: true });
          }).then(function (r) {
            if (r && r.ok) toast("Approved & live on Autopilot 🤖");
            close(); load();
          });
        });
      });
    }

    function apCreateCampaign() {
      var bodyHtml =
        '<div class="ap-newform">' +
          '<label>Campaign name<input id="apcName" placeholder="e.g. Q3 Fintech hiring surge"></label>' +
          '<label>Motion<select id="apcMotion"><option value="bd">Business Development (reach hiring companies)</option><option value="recruiting">Recruiting (reach candidates)</option></select></label>' +
          '<label>Sequence style<select id="apcMethod">' +
            '<option value="seven_touch_drip">7-touch multi-channel drip</option>' +
            '<option value="voice_first">Voice-first (warm, high-touch)</option>' +
            '<option value="hiring_manager_outreach">LinkedIn-led</option>' +
          "</select></label>" +
          '<label>Daily cap<input type="number" id="apcCap" value="25" min="1" max="500"></label>' +
          '<button class="btn btn-primary" id="apcCreate">Create &amp; draft model</button>' +
        "</div>";
      openModal("New Autopilot campaign", "Create it, then AI drafts the sequence for your review.", bodyHtml, function (root, close) {
        root.querySelector("#apcCreate").addEventListener("click", function () {
          var name = root.querySelector("#apcName").value.trim();
          if (!name) { toast("Name it first"); return; }
          var payload = { action: "create-campaign", name: name, motion: root.querySelector("#apcMotion").value,
            methodology: root.querySelector("#apcMethod").value, dailyCap: parseInt(root.querySelector("#apcCap").value, 10) || 25 };
          send("/autopilot", "POST", payload).then(function (r) {
            if (!r.ok) { toast("Create failed"); return; }
            var id = r.data.campaign.id; close();
            toast("Created — drafting the model…");
            apDraftModel(id);
          });
        });
      });
    }
  }

  function prettySignal(s) {
    return String(s || "other").replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function apStage(ic, t, a, b) {
    return '<div class="ap-stage"><div class="ap-stage-ic">' + ic + "</div><div><div class=\"ap-stage-t\">" + esc(t) +
      '</div><div class="ap-stage-a">' + esc(a) + '</div><div class="ap-stage-b muted">' + esc(b) + "</div></div></div>";
  }
  function apCount(n, label) {
    return '<span class="ap-c' + (n ? " has" : "") + '"><b>' + (n || 0) + "</b>" + label + "</span>";
  }

  function renderStudio(el) {
    if (typeof CampaignStudio === "undefined") { el.innerHTML = '<div class="empty">Campaign Studio failed to load.</div>'; return; }
    var root = document.createElement("div");
    el.appendChild(root);
    var openId = studioOpenId;
    studioOpenId = null; // consumed

    function mount(assignees, accounts, sequences, prospectLists) {
      CampaignStudio.mount(root, {
        motion: motion === "bd" ? "bd" : "recruiting",
        embedded: true,
        openId: openId,
        toast: toast,
        assignees: assignees,
        accounts: accounts,
        sequences: sequences,
        prospectLists: prospectLists,
        store: studioStore(),
        sendTestSms: function (to, body, done) {
          send("/sms/send", "POST", { to: to, text: body })
            .then(function (r) { done(r.ok ? "Test SMS sent to " + to : "Could not send. Check SMS setup in Connected."); })
            .catch(function () { done("Could not reach the server."); });
        }
      });
    }

    // Assignees = the workspace team; sending accounts = connected LinkedIn
    // handles; sequences = the named micro-sequences authored under Campaigns,
    // so they can be dropped onto the canvas by name.
    Promise.all([
      api("/team").catch(function () { return null; }),
      api("/accounts").catch(function () { return null; }),
      api("/sequences?motion=" + encodeURIComponent(motion)).catch(function () { return null; }),
      api("/prospect-lists?motion=" + encodeURIComponent(motion)).catch(function () { return null; })
    ]).then(function (res) {
      var members = (res[0] && res[0].members) || [];
      var team = members.map(function (m) { return m.userId === ctx.user.id ? "You" : m.name; });
      var assignees = team.concat(["Round-robin team", "Unassigned"]).filter(function (v, i, a) { return v && a.indexOf(v) === i; });
      if (assignees.length === 0) assignees = ["You", "Unassigned"];
      var li = (res[1] && res[1].linkedin) || [];
      var accounts = li.map(function (a) { return a.handle; }).concat(["auto-rotate"]);
      // Server sequences, merged with the local mirror (covers just-saved ones),
      // scoped to the current motion.
      var server = (res[2] && res[2].sequences) || [];
      var local = []; try { local = JSON.parse(localStorage.getItem("ros_sequences") || "[]"); } catch (e) {}
      var byId = {}; server.concat(local).forEach(function (s) { if (s && s.id && !byId[s.id]) byId[s.id] = s; });
      var sequences = Object.keys(byId).map(function (k) { return byId[k]; })
        .filter(function (s) { return (s.motion === motion) || (!s.motion && motion === "recruiting"); });
      // Saved prospect lists, server + local mirror, scoped to motion.
      var serverL = (res[3] && res[3].lists) || [];
      var localL = []; try { localL = JSON.parse(localStorage.getItem("ros_prospect_lists") || "[]"); } catch (e) {}
      var lById = {}; serverL.concat(localL).forEach(function (l) { if (l && l.id && !lById[l.id]) lById[l.id] = l; });
      var prospectLists = Object.keys(lById).map(function (k) { return lById[k]; })
        .filter(function (l) { return !l.motion || l.motion === motion; });
      mount(assignees, accounts, sequences, prospectLists);
    });
  }

  /* ---------------- Target Builder (in-portal) ----------------
     The signal -> target -> filter -> launch wizard, embedded inside the portal
     chrome via an iframe so it lives in the tool, not as a standalone web page. */
  function renderBuilder(el) {
    el.innerHTML = head("Target Builder", "Search the market, pull live hiring signals, filter by ICP, and launch a campaign, all inside your workspace.") +
      '<div class="card" style="padding:0;overflow:hidden">' +
      '<iframe src="/campaign-builder?embed=1" title="Target Builder" ' +
      'style="width:100%;height:calc(100vh - 220px);min-height:560px;border:0;border-radius:12px;background:var(--bg)"></iframe>' +
      "</div>";
  }

  /* ---------------- Data ----------------
     The people-data warehouse. Import the CSV you export from the provider's own
     portal (or pull via the official API once a key is configured) -> records land
     here, deduped + persisted -> search/browse manually, enrich email/phone, and
     send to Candidates. Backend: /api/data + lib/data/*. */
  var DATA_FIELDS = [
    ["ignore", "- ignore -"], ["fullName", "Full name"], ["firstName", "First name"],
    ["lastName", "Last name"], ["title", "Job title"], ["company", "Company"],
    ["companyDomain", "Company domain"], ["industry", "Industry"], ["email", "Email"],
    ["email2", "Email (secondary)"], ["phone", "Phone / mobile"], ["directPhone", "Direct phone"],
    ["companyPhone", "Company phone"], ["linkedinUrl", "LinkedIn URL"], ["city", "City"],
    ["state", "State"], ["country", "Country"], ["seniority", "Seniority"],
    ["stage", "Pipeline stage"], ["tags", "Tags / skills"], ["bio", "Notes / summary"],
    ["compensation", "Compensation"], ["owner", "Owner / recruiter"], ["recordType", "Record type"],
    ["origin", "Source / origin"], ["lastActivityAt", "Last activity date"], ["providerId", "Provider id"]
  ];

  // Quote-aware delimited parse -> { headers, rows(objects keyed by header) }.
  function parseDelimited(text) {
    var s = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!s.trim()) return { headers: [], rows: [] };
    var delim = s.indexOf("\t") >= 0 && (s.indexOf("\t") < (s.indexOf(",") < 0 ? 1e9 : s.indexOf(","))) ? "\t" : ",";
    var recs = [], field = "", row = [], inQ = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (inQ) {
        if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === delim) { row.push(field); field = ""; }
      else if (ch === "\n") { row.push(field); recs.push(row); row = []; field = ""; }
      else field += ch;
    }
    if (field.length || row.length) { row.push(field); recs.push(row); }
    recs = recs.filter(function (r) { return r.some(function (c) { return String(c).trim(); }); });
    if (!recs.length) return { headers: [], rows: [] };
    var headers = recs[0].map(function (h) { return String(h).trim(); });
    var rows = recs.slice(1).map(function (r) {
      var o = {}; headers.forEach(function (h, j) { o[h] = (r[j] != null ? String(r[j]).trim() : ""); }); return o;
    });
    return { headers: headers, rows: rows };
  }

  /* ============================ Candidates (Data warehouse) ============================
     Full Loxo-style People view: a faceted left rail, stage tabs with live counts, a
     bulk action toolbar, a select-all header, and a candidate-card feed. All filtering
     is client-side over the loaded set (the warehouse is small + already in memory),
     so tabs/facets/search are instant. Cards render ONLY real fields, never invented
     experience, skills, or stages. */
  var DT_STAGE_ORDER = ["Applied", "Longlist", "Shortlist", "Outbound", "Screening", "Submitted", "Interviewing", "Rejected", "Hired"];
  // Each facet: [field key, label, value-extractor(record) -> string[]].
  var DT_FACETS = [
    ["title", "Title", function (r) { return r.title ? [r.title] : []; }],
    ["company", "Company", function (r) { return r.company ? [r.company] : []; }],
    ["location", "Location", function (r) { var v = [r.city, r.state].filter(Boolean).join(", "); return v ? [v] : []; }],
    ["owner", "Owner", function (r) { return r.owner ? [r.owner] : []; }],
    ["origin", "Source", function (r) { return r.origin ? [r.origin] : []; }],
    ["recordType", "Type", function (r) { return r.recordType ? [r.recordType] : []; }],
    ["stage", "Job Stage", function (r) { return r.stage ? [r.stage] : []; }],
    ["tags", "Tags", function (r) { return Array.isArray(r.tags) ? r.tags : []; }]
  ];

  // ---- BD "Companies", book-of-business CRM list (Crelate-style) -------------
  // Seeded from the Lume Search Partners company export. No backend store yet, so
  // rows live in-memory; Add Company persists for the session only. Real attributes
  // only, Jobs is 0 until wired to an openings count (we never fabricate counts).
  function renderCompanies(el) {
    var SEED = [
      ["Arbor Infusion", "https://arborinfusion.com/", "", "Josh Gurin", "5/27/2026"],
      ["CFO Squad LLC", "", "", "Josh Gurin", "11/3/2025"],
      ["David Lawrence Centers", "", "", "Josh Gurin", "11/30/2025"],
      ["Deepgram", "", "", "Josh Gurin", "6/4/2026"],
      ["Eastern Healthcare Group", "ehg.care", "Clifton, NJ", "Noah Wilkowski", "5/26/2026"],
      ["Everest", "", "", "Josh Gurin", "12/4/2025"],
      ["Everest Reinsurance Company", "", "", "Josh Gurin", "12/4/2025"],
      ["Everside Capital Partners", "", "", "Josh Gurin", "6/3/2026"],
      ["Family Office", "", "", "Josh Gurin", "11/4/2025"],
      ["Garden Springs Healthcare", "gardenspringshc.com", "Cleveland, OH", "Noah Wilkowski", "6/3/2026"],
      ["JonesTrading", "", "", "Noah Wilkowski", "6/1/2026"],
      ["MDManage", "mdmanage.com", "", "Noah Wilkowski", "5/26/2026"],
      ["Mitek Systems", "", "", "Josh Gurin", "5/26/2026"],
      ["Paragon Management SNF, LLC", "paragonmanagementsnf.com", "City of Glen Cove, NY", "Noah Wilkowski", "5/26/2026"],
      ["Piping Rock Health Products", "", "", "Josh Gurin", "12/25/2025"],
      ["Ralph Lauren", "", "", "Josh Gurin", "11/16/2025"],
      ["Ramp", "", "", "Josh Gurin", "10/31/2025"],
      ["Sunshine Lighting", "sunshinelighting.com", "Brooklyn, NY", "Noah Wilkowski", "6/3/2026"],
      ["Teachers Federal Credit Union", "", "", "Ariel Grosser", "5/1/2026"],
      ["Templeton & Company", "", "", "Josh Gurin", "1/2/2026"],
      ["The Perfect Child ABA", "http://tpcaba.com", "", "Josh Gurin", "4/17/2026"],
      ["Therapy Management Solutions", "https://therapyms.com/", "", "Josh Gurin", "5/26/2026"],
      ["Wunderkind", "", "", "Josh Gurin", "6/1/2026"],
      ["iCapital", "", "", "Josh Gurin", "12/23/2025"],
      ["reap", "https://getreap.com/", "", "Josh Gurin", "6/8/2026"]
    ];
    // Status tabs mirror the CRM pipeline; tabs are functional, set a company's
    // status from the bulk bar and it moves under the matching tab.
    var TABS = [
      ["total", "Total"], ["in_progress", "In Progress"], ["active_opportunity", "Active Opportunity"],
      ["current_client", "Current Client"], ["dead_opportunity", "Dead Opportunity"],
      ["do_not_prospect", "Do Not Prospect"], ["uncontacted", "Uncontacted"]
    ];
    // Columns the table renders (Jobs/Type/Tags aren't sortable). Status is an
    // inline picker per row, pick a status and the company moves under that tab.
    var COLS = [
      { key: "name", label: "Name", sort: true }, { key: "jobs", label: "Jobs", sort: false },
      { key: "url", label: "URL", sort: true }, { key: "location", label: "Location", sort: true },
      { key: "owner", label: "Creator", sort: true }, { key: "created", label: "Created Date", sort: true },
      { key: "type", label: "Company Type", sort: false }, { key: "status", label: "Status", sort: true },
      { key: "tags", label: "Tags", sort: false }
    ];
    var GRAD = ["#7c5cff,#4dd0ff", "#ff7ac6,#7c5cff", "#4dd0ff,#38e0a6", "#ffc24d,#ff7ac6", "#38e0a6,#4dd0ff", "#ff6b6b,#ffc24d"];
    // Per-status accent, drives the inline picker + status pill colors.
    var STATUS_COLOR = {
      in_progress: "#ffc24d", active_opportunity: "#4dd0ff", current_client: "#38e0a6",
      dead_opportunity: "#ff6b6b", do_not_prospect: "#8a8aa0", uncontacted: "#7c5cff"
    };
    function statusLabel(k) { for (var i = 0; i < TABS.length; i++) if (TABS[i][0] === k) return TABS[i][1]; return ""; }

    // Persistence: no backend store yet, so tags, status, added rows and deletions
    // survive in localStorage keyed by company name. SEED stays the source of truth
    // for base rows; we persist only user-contributed overrides.
    var STORE_KEY = "ros_companies_v1";
    var store = (function () { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; } })();
    var meta = store.meta || {}, deleted = store.deleted || [];
    var companies = [];
    SEED.forEach(function (r) {
      if (deleted.indexOf(r[0]) >= 0) return;
      var m = meta[r[0]] || {};
      // Seed rows are all Type=Client, so default their pipeline status to Current
      // Client (real attribute, not invented). User can re-tab any row inline.
      companies.push({ name: r[0], url: r[1], location: r[2], owner: r[3], created: r[4], type: "Client", status: m.status || "current_client", jobs: 0, tags: (m.tags || []).slice(), added: false });
    });
    (store.added || []).forEach(function (a) {
      companies.unshift({ name: a.name, url: a.url || "", location: a.location || "", owner: a.owner || "You", created: a.created || "", type: a.type || "Client", status: a.status || "", jobs: 0, tags: (a.tags || []).slice(), added: true });
    });
    function persist() {
      var m = {};
      companies.forEach(function (c) {
        if (c.added) return;
        if ((c.tags && c.tags.length) || c.status) m[c.name] = { tags: c.tags, status: c.status };
      });
      var added = companies.filter(function (c) { return c.added; }).map(function (c) {
        return { name: c.name, url: c.url, location: c.location, owner: c.owner, created: c.created, type: c.type, status: c.status, tags: c.tags };
      });
      try { localStorage.setItem(STORE_KEY, JSON.stringify({ meta: m, added: added, deleted: deleted })); } catch (e) {}
    }

    var state = { q: "", tab: "total", sel: {}, tags: [], sort: { key: null, dir: 1 } };

    // Backend write-through: rows synced from the ATS carry a server id (_id).
    // User edits to their status/tags persist to the server too, so the next
    // Loxo sync (which never touches status/tags) keeps them.
    function pushRemote(c) {
      if (!c || !c._id) return;
      send("/companies", "POST", { action: "patch", id: c._id, status: c.status, tags: c.tags, owner: c.owner, type: c.type }).catch(function () {});
    }
    function mergeTags(a, b) { var out = (a || []).slice(); (b || []).forEach(function (t) { if (out.indexOf(t) < 0) out.push(t); }); return out; }
    function fmtDate(s) {
      if (!s) return "";
      var d = new Date(s); if (isNaN(d.getTime())) return String(s);
      return (d.getMonth() + 1) + "/" + d.getDate() + "/" + d.getFullYear();
    }

    function findByName(n) { for (var i = 0; i < companies.length; i++) if (companies[i].name === n) return companies[i]; return null; }
    function selected() { return companies.filter(function (c) { return state.sel[c.name]; }); }
    function initials(name) {
      var p = String(name || "").trim().split(/\s+/).filter(Boolean);
      return ((p.length > 1 ? p[0][0] + p[p.length - 1][0] : (p[0] || "?").slice(0, 1))).toUpperCase();
    }
    function gradFor(name) {
      var h = 0, s = String(name || "");
      for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
      return GRAD[h % GRAD.length];
    }
    // Deterministic per-tag color so a given tag always reads the same hue.
    function tagStyle(t) {
      var h = 0; for (var i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
      var hue = h % 360;
      return "background:hsla(" + hue + ",70%,55%,.16);color:hsl(" + hue + ",75%,74%);border:1px solid hsla(" + hue + ",70%,55%,.34)";
    }
    function href(u) { return /^https?:\/\//i.test(u) ? u : "https://" + u; }
    function allTags() {
      var set = {};
      companies.forEach(function (c) { (c.tags || []).forEach(function (t) { set[t] = (set[t] || 0) + 1; }); });
      return Object.keys(set).sort().map(function (t) { return [t, set[t]]; });
    }
    function countFor(key) {
      if (key === "total") return companies.length;
      return companies.filter(function (c) { return c.status === key; }).length;
    }
    function dateNum(s) { var p = String(s || "").split("/"); return p.length === 3 ? (+p[2] * 10000 + +p[0] * 100 + +p[1]) : 0; }
    function sortVal(c, k) {
      if (k === "created") return dateNum(c.created);
      if (k === "status") return statusLabel(c.status).toLowerCase();
      return String(c[k] || "").toLowerCase();
    }
    function visible() {
      var q = state.q.trim().toLowerCase();
      var list = companies.filter(function (c) {
        if (state.tab !== "total" && c.status !== state.tab) return false;
        if (state.tags.length && !state.tags.some(function (t) { return (c.tags || []).indexOf(t) >= 0; })) return false;
        if (!q) return true;
        return (c.name + " " + c.url + " " + c.location + " " + c.owner + " " + (c.tags || []).join(" ")).toLowerCase().indexOf(q) >= 0;
      });
      if (state.sort.key) {
        var k = state.sort.key, d = state.sort.dir;
        list = list.slice().sort(function (a, b) { var x = sortVal(a, k), y = sortVal(b, k); return x < y ? -d : x > y ? d : 0; });
      }
      return list;
    }

    el.innerHTML = head("Companies", "Your book of business, target accounts and active clients for the BD motion.") +
      '<style>' +
      '.co-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}' +
      '.co-search{flex:1;min-width:220px;display:flex;align-items:center;gap:9px;padding:9px 13px;border-radius:10px;border:1px solid var(--border);background:var(--bg-soft)}' +
      '.co-search span{color:var(--text-dim);font-size:14px}' +
      '.co-search input{flex:1;border:0;background:transparent;color:inherit;font:inherit;outline:none}' +
      '.co-search input::placeholder{color:var(--text-dim)}' +
      '.co-tool{display:grid;place-items:center;width:38px;height:38px;border-radius:10px;border:1px solid var(--border);background:var(--bg-soft);color:var(--text-muted);cursor:pointer;font-size:15px}' +
      '.co-tool:hover{color:var(--text);border-color:var(--border-strong)}' +
      '.co-pill{display:inline-flex;align-items:center;gap:7px;height:38px;padding:0 14px;border-radius:10px;border:1px solid var(--border);background:var(--bg-soft);color:var(--text-muted);cursor:pointer;font-weight:600;font-size:13px}' +
      '.co-pill:hover{color:var(--text);border-color:var(--border-strong)}' +
      '.co-tabs{display:flex;gap:2px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--border);margin-top:16px}' +
      '.co-tab{display:inline-flex;align-items:center;gap:7px;padding:11px 14px;cursor:pointer;color:var(--text-muted);font-weight:600;font-size:13.5px;border-bottom:2px solid transparent;margin-bottom:-1px}' +
      '.co-tab:hover{color:var(--text)}' +
      '.co-tab.on{color:var(--text);border-bottom-color:var(--brand)}' +
      '.co-ct{font-size:11px;font-weight:700;min-width:20px;height:18px;padding:0 6px;border-radius:9px;background:var(--surface-2);color:var(--text-muted);display:inline-grid;place-items:center}' +
      '.co-tab.on .co-ct{background:var(--brand);color:#fff}' +
      '.co-wrap{overflow-x:auto}' +
      '.co-table{width:100%;border-collapse:collapse;font-size:13.5px;min-width:880px}' +
      '.co-table thead th{text-align:left;padding:12px 14px;color:var(--text-dim);font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;font-weight:700;border-bottom:1px solid var(--border);white-space:nowrap}' +
      '.co-sort{margin-left:5px;opacity:.45}' +
      '.co-table tbody td{padding:12px 14px;border-bottom:1px solid var(--border);vertical-align:middle;color:var(--text-muted);white-space:nowrap}' +
      '.co-table tbody tr:hover{background:var(--bg-soft)}' +
      '.co-name{display:flex;align-items:center;gap:11px;min-width:0}' +
      '.co-logo{position:relative;overflow:hidden;flex:0 0 auto;width:34px;height:34px;border-radius:9px;display:grid;place-items:center;font-weight:700;font-size:13px;color:#fff;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}' +
      '.co-logo-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit;background:#fff}' +
      '.co-nm{font-weight:600;color:var(--text);text-decoration:none}' +
      '.co-nm:hover{color:var(--brand-2)}' +
      '.co-ext{color:var(--text-dim);text-decoration:none;font-size:12px}' +
      '.co-ext:hover{color:var(--brand-2)}' +
      '.co-jobs{display:inline-grid;place-items:center;min-width:30px;height:24px;padding:0 8px;border-radius:7px;background:var(--surface-2);color:var(--text-muted);font-weight:700;font-size:12px}' +
      '.co-url{color:var(--text-muted);text-decoration:none}.co-url:hover{color:var(--brand-2)}' +
      '.co-type{display:inline-block;padding:3px 10px;border-radius:7px;background:rgba(56,224,166,.14);color:var(--accent-green);font-size:12px;font-weight:600}' +
      '.co-miss{color:var(--text-dim)}' +
      '.co-pick{width:15px;height:15px;cursor:pointer;accent-color:var(--brand)}' +
      '.co-empty{padding:40px;text-align:center;color:var(--text-dim)}' +
      '.co-table tbody tr.sel{background:rgba(124,92,255,.07)}' +
      /* ---- tags ---- */
      '.co-tags{display:flex;align-items:center;gap:5px;flex-wrap:wrap}' +
      '.co-tag{display:inline-flex;align-items:center;gap:3px;font-size:11.5px;font-weight:600;padding:3px 5px 3px 9px;border-radius:7px;white-space:nowrap}' +
      '.co-tagx{border:0;background:transparent;color:inherit;cursor:pointer;font-size:13px;line-height:1;opacity:.55;padding:0 1px}' +
      '.co-tagx:hover{opacity:1}' +
      '.co-tagadd{border:1px dashed var(--border-strong);background:transparent;color:var(--text-dim);cursor:pointer;border-radius:7px;min-width:22px;height:22px;padding:0 6px;display:inline-grid;place-items:center;font-size:12px}' +
      '.co-tagadd:hover{color:var(--text);border-color:var(--brand)}' +
      /* ---- tag filter bar + bulk bar ---- */
      '.co-filter{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:12px;font-size:12px;color:var(--text-dim)}' +
      '.co-fchip{cursor:pointer;padding:4px 11px;border-radius:999px;border:1px solid var(--border);background:var(--bg-soft);color:var(--text-muted);font-size:12px;font-weight:600}' +
      '.co-fchip:hover{color:var(--text)}' +
      '.co-fchip.on{background:var(--surface-2);color:var(--text);border-color:var(--border-strong)}' +
      '.co-bulk{display:none;align-items:center;gap:9px;flex-wrap:wrap;margin-top:12px;padding:10px 13px;border:1px solid var(--border);border-radius:10px;background:var(--bg-soft)}' +
      '.co-bulk b{color:var(--text);font-size:13px}' +
      '.co-bulk select{background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:6px 9px;font:inherit;font-size:12.5px;cursor:pointer}' +
      /* ---- inline status picker ---- */
      '.co-status{appearance:none;-webkit-appearance:none;border:1px solid currentColor;border-radius:999px;padding:4px 24px 4px 22px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;background:transparent;position:relative;outline:none}' +
      '.co-status option{background:var(--surface);color:var(--text)}' +
      '.co-statusw{position:relative;display:inline-block}' +
      '.co-statusw::before{content:"";position:absolute;left:9px;top:50%;width:7px;height:7px;border-radius:50%;background:currentColor;transform:translateY(-50%);pointer-events:none}' +
      '.co-statusw::after{content:"▾";position:absolute;right:9px;top:50%;transform:translateY(-50%);font-size:9px;opacity:.7;pointer-events:none}' +
      '</style>' +
      '<div class="card">' +
        '<div class="co-bar">' +
          '<div class="co-search"><span>🔍</span><input type="search" id="coQ" placeholder="Search Companies…" autocomplete="off"></div>' +
          '<button class="co-pill" id="coLists">☰ Lists</button>' +
          '<button class="co-tool" title="Filter">⛃</button>' +
          '<button class="co-tool" title="Sort">⇅</button>' +
          '<button class="co-tool" title="Columns">⚙</button>' +
          (can("ats:manage") ? '<button class="co-pill" id="coSync" title="Pull companies from your connected ATS">⟳ Sync Loxo</button>' : '') +
          '<button class="btn btn-primary btn-sm" id="coAdd">＋ Add Company</button>' +
        '</div>' +
        '<div class="co-tabs" id="coTabs"></div>' +
        '<div class="co-filter" id="coFilter" style="display:none"></div>' +
        '<div class="co-bulk" id="coBulk">' +
          '<b id="coSelN">0 selected</b>' +
          '<button class="btn btn-sm" id="coTagSel">＋ Tag</button>' +
          '<select id="coStatusSel"><option value="">Set status…</option>' +
            TABS.slice(1).map(function (t) { return '<option value="' + t[0] + '">' + esc(t[1]) + '</option>'; }).join("") +
          '</select>' +
          '<button class="btn btn-ghost btn-sm" id="coClearSel">Clear tags</button>' +
          '<button class="btn btn-ghost btn-sm" id="coDelSel">🗑 Delete</button>' +
        '</div>' +
        '<div class="co-wrap"><table class="co-table">' +
          '<thead><tr id="coHead"></tr></thead>' +
          '<tbody id="coRows"></tbody>' +
        '</table></div>' +
      '</div>';

    function paintTabs() {
      $("#coTabs", el).innerHTML = TABS.map(function (t) {
        return '<div class="co-tab' + (state.tab === t[0] ? " on" : "") + '" data-tab="' + t[0] + '">' +
          esc(t[1]) + '<span class="co-ct">' + countFor(t[0]) + '</span></div>';
      }).join("");
    }
    function paintFilter() {
      var tags = allTags(), f = $("#coFilter", el);
      if (!tags.length) { f.style.display = "none"; f.innerHTML = ""; state.tags = []; return; }
      f.style.display = "flex";
      f.innerHTML = '<span>Filter by tag:</span>' + tags.map(function (t) {
        var on = state.tags.indexOf(t[0]) >= 0;
        return '<span class="co-fchip' + (on ? " on" : "") + '" data-ftag="' + esc(t[0]) + '">' + esc(t[0]) + ' · ' + t[1] + '</span>';
      }).join("") + (state.tags.length ? ' <span class="co-fchip" data-ftag="__clear">✕ Clear</span>' : "");
    }
    function paintHead() {
      var vis = visible(), allOn = vis.length > 0 && vis.every(function (c) { return state.sel[c.name]; });
      $("#coHead", el).innerHTML =
        '<th style="width:34px"><input type="checkbox" class="co-pick" id="coAll"' + (allOn ? " checked" : "") + '></th>' +
        COLS.map(function (col) {
          var arrow = col.sort
            ? '<span class="co-sort' + (state.sort.key === col.key ? " on" : "") + '">' + (state.sort.key === col.key ? (state.sort.dir > 0 ? "↑" : "↓") : "⇅") + '</span>'
            : "";
          return '<th' + (col.sort ? ' data-sort="' + col.key + '" style="cursor:pointer"' : "") + '>' + esc(col.label) + arrow + '</th>';
        }).join("");
    }
    function tagsCell(c) {
      var chips = (c.tags || []).map(function (t, j) {
        return '<span class="co-tag" style="' + tagStyle(t) + '">' + esc(t) +
          '<button class="co-tagx" data-untag="' + esc(c.name) + '" data-tagi="' + j + '" title="Remove">×</button></span>';
      }).join("");
      return '<div class="co-tags">' + chips + '<button class="co-tagadd" data-tagadd="' + esc(c.name) + '" title="Add tag">＋</button></div>';
    }
    function statusCell(c) {
      var color = STATUS_COLOR[c.status] || "var(--text-dim)";
      var opts = TABS.slice(1).map(function (t) {
        return '<option value="' + t[0] + '"' + (c.status === t[0] ? " selected" : "") + '>' + esc(t[1]) + '</option>';
      }).join("");
      return '<span class="co-statusw" style="color:' + color + '">' +
        '<select class="co-status" data-statusfor="' + esc(c.name) + '" style="color:' + color + '">' +
          (c.status ? "" : '<option value="" selected>- Set status</option>') + opts +
        '</select></span>';
    }
    function rowHtml(c) {
      var ext = c.url ? ' <a class="co-ext" href="' + esc(href(c.url)) + '" target="_blank" rel="noopener" title="Open site">↗</a>' : '';
      var urlCell = c.url
        ? '<a class="co-url" href="' + esc(href(c.url)) + '" target="_blank" rel="noopener">' + esc(c.url) + '</a>'
        : '<span class="co-miss">-</span>';
      return '<tr' + (state.sel[c.name] ? ' class="sel"' : "") + '>' +
        '<td><input type="checkbox" class="co-pick" data-pick="' + esc(c.name) + '"' + (state.sel[c.name] ? " checked" : "") + '></td>' +
        '<td><div class="co-name">' +
          '<div class="co-logo" style="background:linear-gradient(135deg,' + gradFor(c.name) + ')">' + esc(initials(c.name)) +
            (function () { var L = companyLogo(c); return L ? '<img class="co-logo-img" src="' + esc(L.src) + '"' + (L.fb ? ' data-fb="' + esc(L.fb) + '"' : '') + ' alt="" loading="lazy" referrerpolicy="no-referrer" onerror="window.__imgCascade(this)">' : ''; })() +
          '</div>' +
          '<a class="co-nm" href="#prospects">' + esc(c.name) + '</a>' + ext +
        '</div></td>' +
        '<td><span class="co-jobs">' + (Number(c.jobs) || 0) + '</span></td>' +
        '<td>' + urlCell + '</td>' +
        '<td>' + (c.location ? esc(c.location) : '<span class="co-miss">-</span>') + '</td>' +
        '<td>' + esc(c.owner || "-") + '</td>' +
        '<td>' + esc(c.created || "-") + '</td>' +
        '<td><span class="co-type">' + esc(c.type) + '</span></td>' +
        '<td>' + statusCell(c) + '</td>' +
        '<td>' + tagsCell(c) + '</td>' +
      '</tr>';
    }
    function paintRows() {
      var rows = visible();
      $("#coRows", el).innerHTML = rows.length
        ? rows.map(rowHtml).join("")
        : '<tr><td colspan="10"><div class="co-empty">No companies in this view.</div></td></tr>';
    }
    function refreshBulk() {
      var n = selected().length;
      $("#coBulk", el).style.display = n ? "flex" : "none";
      $("#coSelN", el).textContent = n + " selected";
    }
    function paint() { paintTabs(); paintFilter(); paintHead(); paintRows(); refreshBulk(); }
    paint();

    // Merge in companies synced from the connected ATS (Loxo, etc.). These are
    // the durable, server-side rows; the SEED + localStorage above is the offline
    // demo fallback. A matching name is enriched in place; new names are added.
    function mergeRemote(remote) {
      (remote || []).forEach(function (r) {
        var existing = findByName(r.name);
        if (existing) {
          existing._id = r.id; existing._remote = true; existing.source = r.source;
          if (r.status) existing.status = r.status;
          if (r.url && !existing.url) existing.url = r.url;
          if (r.location && !existing.location) existing.location = r.location;
          if (r.owner) existing.owner = r.owner;
          if (typeof r.jobs === "number") existing.jobs = r.jobs;
          if (r.type) existing.type = r.type;
          if (r.tags && r.tags.length) existing.tags = mergeTags(existing.tags, r.tags);
        } else {
          companies.unshift({
            name: r.name, url: r.url || "", location: r.location || "", owner: r.owner || "",
            created: fmtDate(r.created || r.createdAt), type: r.type || "Company",
            status: r.status || "uncontacted", jobs: r.jobs || 0, tags: (r.tags || []).slice(),
            added: false, _id: r.id, _remote: true, source: r.source
          });
        }
      });
      paint();
    }
    api("/companies").then(function (resp) { mergeRemote((resp && resp.companies) || []); }).catch(function () {});

    var syncBtn = $("#coSync", el);
    if (syncBtn) syncBtn.onclick = function () {
      syncBtn.disabled = true; var label = syncBtn.textContent; syncBtn.textContent = "Syncing…";
      send("/companies", "POST", { action: "sync" }).then(function (r) {
        syncBtn.disabled = false; syncBtn.textContent = label;
        if (r.ok && r.data && r.data.report) {
          var c = r.data.report.companies || {};
          toast("Loxo sync: +" + (c.added || 0) + " new, " + (c.updated || 0) + " updated");
          api("/companies").then(function (resp) { mergeRemote((resp && resp.companies) || []); });
        } else {
          toast((r.data && r.data.error) === "ats_not_connected" ? "Connect Loxo in the ATS tab first." : "Sync failed, check the ATS connection.");
        }
      }).catch(function () { syncBtn.disabled = false; syncBtn.textContent = label; toast("Sync failed."); });
    };

    function addTagsTo(list, label) {
      if (!list.length) return;
      var input = window.prompt("Add tag(s) for " + label + ", separate multiple with commas:", "");
      if (input == null) return;
      var tags = input.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      if (!tags.length) return;
      list.forEach(function (c) { tags.forEach(function (t) { if (c.tags.indexOf(t) < 0) c.tags.push(t); }); pushRemote(c); });
      persist(); paint();
    }

    var qEl = $("#coQ", el);
    qEl.oninput = function () { state.q = qEl.value; paint(); };
    $("#coTabs", el).addEventListener("click", function (e) {
      var t = e.target.closest(".co-tab"); if (!t) return;
      state.tab = t.getAttribute("data-tab"); paint();
    });
    $("#coFilter", el).addEventListener("click", function (e) {
      var c = e.target.closest("[data-ftag]"); if (!c) return;
      var t = c.getAttribute("data-ftag");
      if (t === "__clear") state.tags = [];
      else { var i = state.tags.indexOf(t); if (i >= 0) state.tags.splice(i, 1); else state.tags.push(t); }
      paint();
    });
    var headEl = $("#coHead", el);
    headEl.addEventListener("change", function (e) {
      if (e.target.id !== "coAll") return;
      var chk = e.target.checked;
      visible().forEach(function (c) { state.sel[c.name] = chk; });
      paint();
    });
    headEl.addEventListener("click", function (e) {
      var th = e.target.closest("th[data-sort]"); if (!th) return;
      var k = th.getAttribute("data-sort");
      if (state.sort.key === k) state.sort.dir = -state.sort.dir; else { state.sort.key = k; state.sort.dir = 1; }
      paint();
    });
    var rowsEl = $("#coRows", el);
    rowsEl.addEventListener("change", function (e) {
      var ss = e.target.closest("[data-statusfor]");
      if (ss) { var c = findByName(ss.getAttribute("data-statusfor")); if (c) { c.status = ss.value; pushRemote(c); persist(); paint(); } return; }
      var cb = e.target.closest("[data-pick]"); if (!cb) return;
      state.sel[cb.getAttribute("data-pick")] = cb.checked;
      paintRows(); paintHead(); refreshBulk();
    });
    rowsEl.addEventListener("click", function (e) {
      var add = e.target.closest("[data-tagadd]");
      if (add) { var c = findByName(add.getAttribute("data-tagadd")); if (c) addTagsTo([c], c.name); return; }
      var rm = e.target.closest("[data-untag]");
      if (rm) {
        var co = findByName(rm.getAttribute("data-untag"));
        if (co) { co.tags.splice(+rm.getAttribute("data-tagi"), 1); pushRemote(co); persist(); paint(); }
      }
    });
    $("#coTagSel", el).onclick = function () { addTagsTo(selected(), selected().length + " selected"); };
    $("#coClearSel", el).onclick = function () { selected().forEach(function (c) { c.tags = []; pushRemote(c); }); persist(); paint(); };
    $("#coStatusSel", el).onchange = function () {
      var v = this.value; if (!v) return;
      selected().forEach(function (c) { c.status = v; pushRemote(c); });
      this.value = ""; persist(); paint();
    };
    $("#coDelSel", el).onclick = function () {
      var sel = selected(); if (!sel.length) return;
      if (!window.confirm("Delete " + sel.length + " compan" + (sel.length > 1 ? "ies" : "y") + "? This can't be undone.")) return;
      var remoteIds = sel.filter(function (c) { return c._id; }).map(function (c) { return c._id; });
      if (remoteIds.length) send("/companies", "POST", { action: "delete", ids: remoteIds }).catch(function () {});
      sel.forEach(function (c) { if (!c.added && !c._remote && deleted.indexOf(c.name) < 0) deleted.push(c.name); });
      companies = companies.filter(function (c) { return !state.sel[c.name]; });
      state.sel = {}; persist(); paint();
    };
    $("#coAdd", el).onclick = function () {
      var name = (window.prompt("Company name") || "").trim(); if (!name) return;
      if (findByName(name)) { toast("That company already exists."); return; }
      var url = (window.prompt("Website URL (optional)") || "").trim();
      var now = new Date();
      companies.unshift({
        name: name, url: url, location: "", owner: (ctx.user && ctx.user.name) || "You",
        created: (now.getMonth() + 1) + "/" + now.getDate() + "/" + now.getFullYear(),
        type: "Client", status: "uncontacted", jobs: 0, tags: [], added: true
      });
      persist(); paint();
      // Persist server-side too (durable + pushes to Loxo when connected). The
      // next mergeRemote() attaches the backend id; failure just leaves it local.
      send("/companies", "POST", { action: "upsert", companies: [{ name: name, url: url, owner: (ctx.user && ctx.user.name) || "You", type: "Client", status: "uncontacted", source: "manual" }] })
        .then(function (r) {
          if (r && r.ok && r.data && r.data.pushed) toast("Added · pushed to Loxo");
          api("/companies").then(function (resp) { mergeRemote((resp && resp.companies) || []); }).catch(function () {});
        }).catch(function () {});
    };
    $("#coLists", el).onclick = function () { toast("Lists are coming soon."); };
  }

  // In the BD motion this route is the book of business (Companies); in recruiting
  // it is the people database below.
  function renderData(el) {
    if (motion === "bd") return renderCompanies(el);
    el.innerHTML = head("Candidates", "Your people database. Filter by stage, owner, title and more on the left; email, enrich, submit, or export the people you select.") +
      '<style>' +
      '.dt-sub{color:var(--muted,#8b93a1);font-size:12px}' +
      '.dt-prov{font-size:12px;color:var(--muted,#8b93a1);margin-bottom:10px}' +
      '.cd-wrap{display:grid;grid-template-columns:232px 1fr;gap:18px;align-items:start}' +
      '@media(max-width:900px){.cd-wrap{grid-template-columns:1fr}}' +
      '.cd-facets{position:sticky;top:8px;background:var(--panel,#16181d);border:1px solid var(--line,#262a33);border-radius:12px;padding:8px 10px;max-height:calc(100vh - 120px);overflow:auto}' +
      '.cd-search{width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line,#262a33);background:var(--bg,#0e0f13);color:inherit;margin:4px 0 6px}' +
      '.cd-facet{border-bottom:1px solid var(--line,#20242c)}.cd-facet:last-child{border-bottom:0}' +
      '.cd-fhead{display:flex;align-items:center;gap:6px;padding:10px 4px;cursor:pointer;font-size:13px;font-weight:600;user-select:none}' +
      '.cd-fhead .cd-fc{font-size:11px;color:#fff;background:var(--accent,#3b82f6);border-radius:10px;padding:1px 7px}' +
      '.cd-fcaret{margin-left:auto;color:var(--muted,#8b93a1);font-size:11px;transition:transform .15s}' +
      '.cd-facet.open .cd-fcaret{transform:rotate(180deg)}' +
      '.cd-fbody{padding:0 2px 10px}' +
      '.cd-fopt{display:flex;align-items:center;gap:8px;font-size:12.5px;padding:4px 2px;cursor:pointer}' +
      '.cd-fopt input{margin:0;flex:0 0 auto}' +
      '.cd-fopt .cd-ol{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.cd-fopt .cd-oc{color:var(--muted,#8b93a1);font-size:11px}' +
      '.cd-more{font-size:12px;color:var(--accent,#3b82f6);cursor:pointer;padding:5px 2px}' +
      '.cd-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:12px}' +
      '.cd-tbtn{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;padding:7px 11px;border-radius:8px;border:1px solid var(--line,#262a33);background:var(--panel,#16181d);color:inherit;cursor:pointer}' +
      '.cd-tbtn:hover:not(:disabled){border-color:var(--accent,#3b82f6)}' +
      '.cd-tbtn.primary{background:var(--accent,#3b82f6);border-color:transparent;color:#fff}' +
      '.cd-tbtn:disabled{opacity:.4;cursor:not-allowed}' +
      '.cd-tsep{width:1px;align-self:stretch;background:var(--line,#262a33);margin:2px 4px}' +
      '.cd-spacer{flex:1}' +
      '.cd-tabs{display:flex;gap:2px;flex-wrap:wrap;border-bottom:1px solid var(--line,#262a33);margin-bottom:12px}' +
      '.cd-tab{display:inline-flex;align-items:center;gap:7px;padding:9px 12px;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;color:var(--muted,#8b93a1)}' +
      '.cd-tab.active{color:inherit;border-bottom-color:var(--accent,#3b82f6);font-weight:600}' +
      '.cd-tab .cd-tc{font-size:11px;background:var(--line,#20242c);color:var(--muted,#8b93a1);border-radius:10px;padding:1px 7px}' +
      '.cd-tab.active .cd-tc{background:var(--accent,#3b82f6);color:#fff}' +
      '.cd-selbar{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--muted,#8b93a1);margin-bottom:10px}' +
      '.cd-link{color:var(--accent,#3b82f6);cursor:pointer}' +
      '.dt-list{display:flex;flex-direction:column;gap:14px}' +
      '.dt-card{position:relative;background:var(--panel,#16181d);border:1px solid var(--line,#262a33);border-radius:16px;padding:18px 22px;transition:border-color .15s,box-shadow .15s,transform .15s}' +
      '.dt-card:hover{border-color:var(--border-strong,#323845);box-shadow:0 14px 34px -20px rgba(0,0,0,.75);transform:translateY(-1px)}' +
      '.dt-card.sel{border-color:var(--accent,#3b82f6);box-shadow:inset 0 0 0 1px var(--accent,#3b82f6)}' +
      '.dt-pick{position:absolute;top:18px;right:20px;width:16px;height:16px;cursor:pointer;accent-color:var(--accent,#3b82f6)}' +
      '.cd-act{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--muted,#8b93a1);margin-bottom:14px}' +
      '.cd-act b{color:var(--text,#e7eaf0);font-weight:600}' +
      '.dt-head{display:flex;align-items:flex-start;gap:15px;padding-right:28px}' +
      '.dt-avatar{position:relative;overflow:hidden;flex:0 0 auto;width:54px;height:54px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:18px;color:#fff;background:linear-gradient(135deg,#7c5cff,#4dd0ff);box-shadow:inset 0 0 0 1px rgba(255,255,255,.10)}' +
      '.dt-avatar-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit}' +
      '.dt-id{flex:1;min-width:0}' +
      '.dt-name{display:flex;align-items:center;gap:7px;font-size:16.5px;font-weight:700;line-height:1.25;letter-spacing:-.01em}' +
      '.dt-name a.dt-li{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:4px;background:#0a66c2;color:#fff;font-size:11px;font-weight:800;text-decoration:none;flex:0 0 auto}' +
      '.dt-title{font-size:13px;margin-top:3px;color:var(--text,#cfd4dd)}' +
      '.dt-loc{font-size:12px;color:var(--muted,#8b93a1);margin-top:2px;display:flex;align-items:center;gap:5px}' +
      '.dt-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto}' +
      // Clean, visible contact chips (email + phone shown in full).
      '.dt-contactlist{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}' +
      '.dt-cn{display:inline-flex;align-items:center;gap:7px;max-width:100%;font-size:12.5px;font-weight:600;color:var(--text,#e7eaf0);text-decoration:none;padding:6px 11px;border:1px solid var(--line,#262a33);border-radius:9px;background:var(--bg-soft,rgba(255,255,255,.02));transition:border-color .15s,background .15s,color .15s}' +
      '.dt-cn:hover{border-color:var(--accent,#3b82f6);background:rgba(124,92,255,.10)}' +
      '.dt-cn-ic{flex:0 0 auto;opacity:.6;font-size:13px}' +
      '.dt-cn-v{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.dt-cn-off{cursor:pointer;color:var(--muted,#8b93a1);border-style:dashed}' +
      '.dt-cn-off:hover{color:var(--accent,#3b82f6)}' +
      '.dt-stage{font-size:11.5px;font-weight:600;padding:6px 13px;border-radius:999px;white-space:nowrap;border:1px solid transparent}' +
      '.dt-add{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;padding:7px 14px;border-radius:9px;border:1px solid var(--line,#262a33);cursor:pointer;background:var(--bg-soft,rgba(255,255,255,.03));color:var(--text,#e7eaf0);transition:border-color .15s,background .15s}' +
      '.dt-add:hover{border-color:var(--accent,#3b82f6);background:color-mix(in srgb,var(--accent,#3b82f6) 12%,transparent);color:var(--accent,#3b82f6)}' +
      '.dt-body{display:grid;grid-template-columns:1.4fr 1fr;gap:24px;margin-top:18px;padding-top:16px;border-top:1px solid var(--line,#20242c)}' +
      '@media(max-width:720px){.dt-body{grid-template-columns:1fr}.dt-actions{margin-left:0}}' +
      '.dt-seclbl{font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted,#8b93a1);margin-bottom:9px;font-weight:600}' +
      '.dt-exp-row{display:flex;gap:11px;align-items:flex-start}' +
      '.dt-exp-ic{flex:0 0 auto;width:32px;height:32px;border-radius:8px;display:grid;place-items:center;background:color-mix(in srgb,var(--accent,#3b82f6) 14%,transparent);color:var(--accent,#3b82f6);font-size:14px}' +
      '.dt-exp-t{font-weight:600;font-size:13px}' +
      '.dt-exp-c{font-size:12px;color:var(--muted,#8b93a1);margin-top:1px}' +
      '.dt-side-row{display:flex;gap:10px;align-items:center;font-size:13px;margin-bottom:9px}' +
      '.dt-side-ic{flex:0 0 auto;width:28px;height:28px;border-radius:7px;display:grid;place-items:center;background:color-mix(in srgb,var(--accent,#3b82f6) 14%,transparent);color:var(--accent,#3b82f6);font-size:12px}' +
      '.dt-skills{margin-top:16px}' +
      '.dt-tag{display:inline-block;font-size:11.5px;font-weight:500;padding:4px 11px;border-radius:999px;background:transparent;border:1px solid var(--line,#2a2f3a);color:var(--muted,#9aa3b2);margin:0 6px 6px 0}' +
      '.cd-showmore{text-align:center;border-top:1px solid var(--line,#20242c);margin-top:14px;padding-top:10px;font-size:12px;color:var(--accent,#3b82f6);cursor:pointer}' +
      '.cd-bio{font-size:12.5px;color:var(--muted,#9aa3b2);line-height:1.55;white-space:pre-wrap;margin-top:12px;padding-top:12px;border-top:1px solid var(--line,#20242c)}' +
      '</style>' +
      '<div id="dtProv" class="dt-prov"></div>' +
      '<div class="cd-wrap">' +
        '<aside class="cd-facets"><input type="search" class="cd-search" id="cdSearch" placeholder="Search name, title, company…" autocomplete="off"><div id="cdFacets"></div></aside>' +
        '<div class="cd-main">' +
          '<div class="cd-toolbar" id="cdToolbar"></div>' +
          '<div class="cd-tabs" id="cdTabs"></div>' +
          '<div class="cd-selbar" id="cdSelbar"></div>' +
          '<div id="dtBody">' + loading() + '</div>' +
        '</div>' +
      '</div>';

    // all = everything loaded; sel = picked ids; stage = active tab; facets = {field:[vals]}
    var state = { all: [], q: "", stage: "", facets: {}, sel: {}, open: {}, showAll: {}, bios: {}, providers: [] };
    var bodyEl = $("#dtBody", el), searchTimer = null;

    function load() {
      api("/data?limit=1000").then(function (d) {
        d = d || {};
        state.all = d.records || [];
        state.providers = d.providers || [];
        paintProv();
        renderAll();
      }).catch(function () { bodyEl.innerHTML = '<div class="empty">Could not load the database.</div>'; });
    }
    function paintProv() {
      var prov = (state.providers || []).map(function (p) {
        return (p.configured ? "🟢 " : "⚪ ") + esc(p.label) + (p.configured ? " · live" : " · awaiting key");
      }).join(" &nbsp;·&nbsp; ");
      $("#dtProv", el).innerHTML = prov ? ("Providers: " + prov) : "";
    }

    /* ---- filtering ---- */
    function matchesQ(r) {
      if (!state.q) return true;
      var hay = (r.fullName + " " + (r.title || "") + " " + (r.company || "") + " " + (r.email || "") + " " + ((r.tags || []).join(" "))).toLowerCase();
      return hay.indexOf(state.q.toLowerCase()) >= 0;
    }
    function facetFn(field) { for (var i = 0; i < DT_FACETS.length; i++) if (DT_FACETS[i][0] === field) return DT_FACETS[i][2]; return function () { return []; }; }
    // Filter `all` by search + stage-tab + every facet, optionally skipping one facet
    // (so that facet's own option counts reflect "what you could still add").
    function filtered(exceptField, applyStage) {
      return state.all.filter(function (r) {
        if (!matchesQ(r)) return false;
        if (applyStage !== false && state.stage) { if (state.stage === "__none__" ? r.stage : (r.stage || "") !== state.stage) return false; }
        for (var f in state.facets) {
          if (f === exceptField) continue;
          var sel = state.facets[f]; if (!sel || !sel.length) continue;
          var vals = facetFn(f)(r);
          var hit = false; for (var i = 0; i < vals.length; i++) if (sel.indexOf(vals[i]) >= 0) { hit = true; break; }
          if (!hit) return false;
        }
        return true;
      });
    }
    function view() { return filtered(null, true); }

    function renderAll() { paintFacets(); paintTabs(); paintToolbar(); paintFeed(); }

    /* ---- facets ---- */
    function paintFacets() {
      var host = $("#cdFacets", el);
      host.innerHTML = DT_FACETS.map(function (f) {
        var field = f[0], label = f[1];
        var base = filtered(field, true);
        var counts = {};
        base.forEach(function (r) { f[2](r).forEach(function (v) { counts[v] = (counts[v] || 0) + 1; }); });
        var opts = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || (a < b ? -1 : 1); });
        if (!opts.length) return "";
        var sel = state.facets[field] || [];
        var open = !!state.open[field];
        var limit = state.showAll[field] ? opts.length : 8;
        var body = opts.slice(0, limit).map(function (v) {
          var on = sel.indexOf(v) >= 0;
          return '<label class="cd-fopt"><input type="checkbox" data-facet="' + esc(field) + '" data-val="' + esc(v) + '"' + (on ? " checked" : "") + '>' +
            '<span class="cd-ol" title="' + esc(v) + '">' + esc(v) + '</span><span class="cd-oc">' + counts[v] + '</span></label>';
        }).join("");
        if (opts.length > limit) body += '<div class="cd-more" data-more="' + esc(field) + '">Show ' + (opts.length - limit) + ' more</div>';
        else if (state.showAll[field] && opts.length > 8) body += '<div class="cd-more" data-more="' + esc(field) + '">Show less</div>';
        return '<div class="cd-facet' + (open ? " open" : "") + '">' +
          '<div class="cd-fhead" data-fhead="' + esc(field) + '">' + esc(label) +
            (sel.length ? '<span class="cd-fc">' + sel.length + '</span>' : '') +
            '<span class="cd-fcaret">▾</span></div>' +
          (open ? '<div class="cd-fbody">' + body + '</div>' : '') +
        '</div>';
      }).join("");

      Array.prototype.forEach.call(host.querySelectorAll("[data-fhead]"), function (h) {
        h.addEventListener("click", function () { var f = h.getAttribute("data-fhead"); state.open[f] = !state.open[f]; paintFacets(); });
      });
      Array.prototype.forEach.call(host.querySelectorAll("[data-facet]"), function (cb) {
        cb.addEventListener("change", function () {
          var f = cb.getAttribute("data-facet"), v = cb.getAttribute("data-val");
          var arr = state.facets[f] || (state.facets[f] = []);
          var i = arr.indexOf(v);
          if (cb.checked) { if (i < 0) arr.push(v); } else if (i >= 0) arr.splice(i, 1);
          if (!arr.length) delete state.facets[f];
          renderAll();
        });
      });
      Array.prototype.forEach.call(host.querySelectorAll("[data-more]"), function (m) {
        m.addEventListener("click", function () { var f = m.getAttribute("data-more"); state.showAll[f] = !state.showAll[f]; paintFacets(); });
      });
    }

    /* ---- stage tabs ---- */
    function paintTabs() {
      var base = filtered(null, false); // everything except the stage selection
      var counts = {}; var noStage = 0;
      base.forEach(function (r) { if (r.stage) counts[r.stage] = (counts[r.stage] || 0) + 1; else noStage++; });
      // Always show the full canonical pipeline (even at 0), then any extra
      // stages present in the data, then a No-stage bucket, all clickable.
      var ordered = DT_STAGE_ORDER.slice();
      Object.keys(counts).forEach(function (s) { if (ordered.indexOf(s) < 0) ordered.push(s); });
      var tabs = [["", "Total", base.length]];
      ordered.forEach(function (s) { tabs.push([s, s, counts[s] || 0]); });
      if (noStage) tabs.push(["__none__", "No stage", noStage]);
      $("#cdTabs", el).innerHTML = tabs.map(function (t) {
        return '<div class="cd-tab' + (state.stage === t[0] ? " active" : "") + '" data-stage="' + esc(t[0]) + '">' + esc(t[1]) + '<span class="cd-tc">' + t[2] + '</span></div>';
      }).join("");
      Array.prototype.forEach.call($("#cdTabs", el).querySelectorAll("[data-stage]"), function (t) {
        t.addEventListener("click", function () { state.stage = t.getAttribute("data-stage"); renderAll(); });
      });
    }

    /* ---- toolbar ---- */
    function paintToolbar() {
      var n = Object.keys(state.sel).length, dis = n ? "" : " disabled";
      $("#cdToolbar", el).innerHTML =
        '<button class="cd-tbtn primary" id="cdAdd">＋ Add people ▾</button>' +
        '<span class="cd-tsep"></span>' +
        '<button class="cd-tbtn" id="cdDelete"' + dis + '>🗑 Delete</button>' +
        '<span class="cd-tsep"></span>' +
        '<button class="cd-tbtn" id="cdEmail"' + dis + '>✉️ Email</button>' +
        '<button class="cd-tbtn" id="cdSms"' + dis + '>📱 SMS</button>' +
        '<button class="cd-tbtn" id="cdFind"' + dis + '>🔎 Find contact</button>' +
        '<button class="cd-tbtn" id="cdSubmit"' + dis + '>➤ Submit candidates</button>' +
        '<span class="cd-spacer"></span>' +
        '<button class="cd-tbtn" id="cdAddTo"' + dis + '>＋ Add to…</button>' +
        (can("ats:manage") ? '<button class="cd-tbtn" id="cdLoxo" title="Pull people from your connected ATS into Candidates">⟳ Sync Loxo</button>' : '') +
        '<button class="cd-tbtn" id="cdExport">⬇ Export</button>';
      var sel = function () { return Object.keys(state.sel); };
      $("#cdAdd", el).addEventListener("click", function () { openDataImport(load); });
      $("#cdDelete", el).addEventListener("click", function () { if (n) delSel(); });
      $("#cdEmail", el).addEventListener("click", function () { if (n) bulkEmail(); });
      $("#cdSms", el).addEventListener("click", function () { if (n) bulkSms(); });
      $("#cdFind", el).addEventListener("click", function () { if (n) enrichSel($("#cdFind", el)); });
      $("#cdSubmit", el).addEventListener("click", function () { if (n) promote(sel()); });
      $("#cdAddTo", el).addEventListener("click", function () { if (n) promote(sel()); });
      $("#cdExport", el).addEventListener("click", function () { exportCsv(); });
      var loxoBtn = $("#cdLoxo", el);
      if (loxoBtn) loxoBtn.addEventListener("click", function () {
        loxoBtn.disabled = true; var t = loxoBtn.textContent; loxoBtn.textContent = "Syncing…";
        send("/ats", "POST", { action: "sync", vendor: "loxo" }).then(function (r) {
          loxoBtn.disabled = false; loxoBtn.textContent = t;
          if (r.ok && r.data && r.data.report) {
            var p = r.data.report.people || {};
            toast("Loxo: +" + (p.added || 0) + " new candidates, " + (p.updated || 0) + " updated");
            load();
          } else {
            toast((r.data && r.data.error) === "missing_credentials" ? "Connect Loxo in the ATS tab first." : "Sync failed, check the ATS connection.");
          }
        }).catch(function () { loxoBtn.disabled = false; loxoBtn.textContent = t; toast("Sync failed."); });
      });
    }

    /* ---- select-all header ---- */
    function paintSelbar(rows) {
      var n = Object.keys(state.sel).length;
      var allSel = rows.length && rows.every(function (r) { return state.sel[r.id]; });
      $("#cdSelbar", el).innerHTML =
        '<span class="cd-link" id="cdUnsel">Unselect all</span><span>|</span>' +
        '<span class="cd-link" id="cdSelAll">' + (allSel ? "Deselect" : "Select all") + " " + rows.length + '</span>' +
        '<span>(' + n + ' selected)</span>';
      $("#cdUnsel", el).addEventListener("click", function () { state.sel = {}; paintFeed(); paintToolbar(); });
      $("#cdSelAll", el).addEventListener("click", function () {
        if (allSel) rows.forEach(function (r) { delete state.sel[r.id]; });
        else rows.forEach(function (r) { state.sel[r.id] = true; });
        paintFeed(); paintToolbar();
      });
    }

    /* ---- card rendering ---- */
    function initials(name) {
      var p = String(name || "").trim().split(/\s+/).filter(Boolean);
      return ((p[0] || "?")[0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
    }
    function sourceLabel(s) { return s === "zoominfo-api" ? "API" : s === "manual" ? "Manual" : "Imported"; }
    function stageMeta(s) {
      var map = { applied: ["#0ea5e9", "rgba(14,165,233,.16)"], longlist: ["#94a3b8", "rgba(148,163,184,.16)"], shortlist: ["#a855f7", "rgba(168,85,247,.16)"],
        outbound: ["#e0961f", "rgba(245,158,11,.16)"], screening: ["#3b82f6", "rgba(59,130,246,.16)"], submitted: ["#e0961f", "rgba(245,158,11,.16)"],
        interviewing: ["#22c55e", "rgba(34,197,94,.16)"], rejected: ["#ef4444", "rgba(239,68,68,.16)"], hired: ["#16a34a", "rgba(22,163,74,.2)"], contact: ["#94a3b8", "rgba(148,163,184,.16)"] };
      return map[String(s || "").toLowerCase()] || ["#e0961f", "rgba(245,158,11,.16)"];
    }
    function relTime(s) {
      if (!s) return "";
      var t = Date.parse(String(s).replace(" ", "T")); if (isNaN(t)) return "";
      var d = Math.max(0, Date.now() - t), m = Math.round(d / 60000);
      if (m < 1) return "just now"; if (m < 60) return m + " min ago";
      var h = Math.round(m / 60); if (h < 24) return h + " hr ago";
      var dd = Math.round(h / 24); if (dd < 30) return dd + " day" + (dd === 1 ? "" : "s") + " ago";
      var mo = Math.round(dd / 30); if (mo < 12) return mo + " mo ago";
      return Math.round(mo / 12) + " yr ago";
    }

    function card(r) {
      var loc = [r.city, r.state, r.country].filter(Boolean).join(", ");
      var phone = r.phone || r.directPhone || r.companyPhone;
      var li = r.linkedinUrl ? ' <a class="dt-li" href="' + esc(r.linkedinUrl) + '" target="_blank" rel="noopener" title="LinkedIn">in</a>' : '';

      // Avatar: real photo when present (ATS image, else a free email-based headshot
      // lookup), initials underneath as the fallback. The <img> sits over the
      // initials; if it fails to load it removes itself and the initials show through.
      var photo = personPhoto(r);
      var avatar = '<div class="dt-avatar">' + esc(initials(r.fullName)) +
        (photo ? '<img class="dt-avatar-img" src="' + esc(photo) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : '') +
        '</div>';

      // Contact: show the actual email + phone as clean, clickable chips; fall back
      // to an enrich action only when the value is missing.
      var emailCn = r.email
        ? '<a class="dt-cn" href="mailto:' + esc(r.email) + '" title="Email"><span class="dt-cn-ic">✉</span><span class="dt-cn-v">' + esc(r.email) + '</span></a>'
        : '<button class="dt-cn dt-cn-off" data-enrich="email" data-id="' + esc(r.id) + '"><span class="dt-cn-ic">✉</span><span class="dt-cn-v">Find email</span></button>';
      var phoneCn = phone
        ? '<a class="dt-cn" href="tel:' + esc(phone) + '" title="Call"><span class="dt-cn-ic">✆</span><span class="dt-cn-v">' + esc(phone) + '</span></a>'
        : '<button class="dt-cn dt-cn-off" data-enrich="phone" data-id="' + esc(r.id) + '"><span class="dt-cn-ic">✆</span><span class="dt-cn-v">Find phone</span></button>';
      var contact = '<div class="dt-contactlist">' + emailCn + phoneCn + '</div>';

      var sm = stageMeta(r.stage || r.recordType);
      var stageLabel = r.stage || r.recordType || sourceLabel(r.source);
      var stageBadge = '<span class="dt-stage" style="color:' + sm[0] + ';background:' + sm[1] + '">' + esc(stageLabel) + '</span>';

      // Activity meta line (real owner + real last-activity time; never fabricated).
      var rel = relTime(r.lastActivityAt);
      var actBits = [];
      if (r.stage) actBits.push('<b>' + esc(r.stage) + '</b>'); else if (r.recordType) actBits.push('<b>' + esc(r.recordType) + '</b>');
      if (rel) actBits.push(esc(rel));
      if (r.owner) actBits.push((r.recordType === "Contact" ? "owned by " : "with ") + esc(r.owner));
      var act = actBits.length ? '<div class="cd-act">📋 ' + actBits.join(" · ") + '</div>' : '';

      // EXPERIENCE: only the current role, we never invent prior history.
      var exp = (r.title || r.company)
        ? '<div class="dt-exp-row"><div class="dt-exp-ic">🏢</div><div>' +
            (r.title ? '<div class="dt-exp-t">' + esc(r.title) + '</div>' : '') +
            (r.company ? '<div class="dt-exp-c">' + esc(r.company) + '</div>' : '') +
          '</div></div>'
        : '<div class="dt-sub">No role on file.</div>';

      var side = "";
      if (r.company) side += '<div class="dt-side-row"><span class="dt-side-ic">🏢</span><span>' + esc(r.company) + (r.companyDomain ? ' · <span class="dt-sub">' + esc(r.companyDomain) + '</span>' : '') + '</span></div>';
      if (loc) side += '<div class="dt-side-row"><span class="dt-side-ic">📍</span><span>' + esc(loc) + '</span></div>';
      if (r.compensation) side += '<div class="dt-side-row"><span class="dt-side-ic">💰</span><span>' + esc(r.compensation) + '</span></div>';
      if (!side) side = '<div class="dt-sub">-</div>';

      // Skills/tags row -> real tags from the export (fallback to industry/seniority).
      var tagList = (Array.isArray(r.tags) && r.tags.length) ? r.tags : [r.industry, r.seniority].filter(Boolean);
      var tagHtml = tagList.map(function (t) { return '<span class="dt-tag">' + esc(t) + '</span>'; }).join("");
      var skills = tagHtml ? '<div class="dt-skills"><div class="dt-seclbl">Skills &amp; tags</div>' + tagHtml + '</div>' : "";

      // Bio / intake notes behind a SHOW MORE toggle.
      var bioOpen = !!state.bios[r.id];
      var bio = r.bio
        ? '<div class="cd-showmore" data-bio="' + esc(r.id) + '">' + (bioOpen ? "Hide notes ▴" : "Show notes ▾") + '</div>' +
          (bioOpen ? '<div class="cd-bio">' + esc(r.bio) + '</div>' : '')
        : '';

      return '<div class="dt-card' + (state.sel[r.id] ? ' sel' : '') + '" data-card="' + esc(r.id) + '">' +
        '<input class="dt-pick" type="checkbox" data-pick="' + esc(r.id) + '"' + (state.sel[r.id] ? " checked" : "") + '>' +
        act +
        '<div class="dt-head">' +
          avatar +
          '<div class="dt-id">' +
            '<div class="dt-name">' + esc(r.fullName) + li + '</div>' +
            (r.title ? '<div class="dt-title">' + esc(r.title) + '</div>' : '') +
            (loc ? '<div class="dt-loc">' + esc(loc) + '</div>' : '') +
            contact +
          '</div>' +
          '<div class="dt-actions">' +
            stageBadge +
            '<button class="dt-add" data-add="' + esc(r.id) + '">＋ Add to…</button>' +
          '</div>' +
        '</div>' +
        '<div class="dt-body">' +
          '<div><div class="dt-seclbl">Experience</div>' + exp + skills + '</div>' +
          '<div>' + side + '</div>' +
        '</div>' + bio +
      '</div>';
    }

    function paintFeed() {
      var rows = view();
      paintSelbar(rows);
      if (!state.all.length) {
        bodyEl.innerHTML = '<div class="empty">No people yet.<br><br>' +
          '<button class="cd-tbtn primary" id="cdSeed">⬇ Load Lume Search Partners export</button> &nbsp; ' +
          '<button class="cd-tbtn" id="cdImport2">⬆ Import a CSV</button></div>';
        var seed = $("#cdSeed", el); if (seed) seed.addEventListener("click", function () { seedLume(seed); });
        var imp = $("#cdImport2", el); if (imp) imp.addEventListener("click", function () { openDataImport(load); });
        return;
      }
      if (!rows.length) { bodyEl.innerHTML = '<div class="empty">No people match these filters.</div>'; return; }
      bodyEl.innerHTML = '<div class="dt-list">' + rows.map(card).join("") + '</div>';

      Array.prototype.forEach.call(bodyEl.querySelectorAll("[data-pick]"), function (cb) {
        cb.addEventListener("change", function () {
          var id = cb.getAttribute("data-pick");
          if (cb.checked) state.sel[id] = true; else delete state.sel[id];
          var c = bodyEl.querySelector('[data-card="' + id + '"]'); if (c) c.classList.toggle("sel", cb.checked);
          paintSelbar(rows); paintToolbar();
        });
      });
      Array.prototype.forEach.call(bodyEl.querySelectorAll("[data-enrich]"), function (b) {
        b.addEventListener("click", function () { enrichOne(b.getAttribute("data-id"), b.getAttribute("data-enrich"), b); });
      });
      Array.prototype.forEach.call(bodyEl.querySelectorAll("[data-mail]"), function (b) {
        b.addEventListener("click", function () { location.href = "mailto:" + b.getAttribute("data-mail"); });
      });
      Array.prototype.forEach.call(bodyEl.querySelectorAll("[data-tel]"), function (b) {
        b.addEventListener("click", function () { location.href = "tel:" + b.getAttribute("data-tel"); });
      });
      Array.prototype.forEach.call(bodyEl.querySelectorAll("[data-add]"), function (b) {
        b.addEventListener("click", function () { promote([b.getAttribute("data-add")]); });
      });
      Array.prototype.forEach.call(bodyEl.querySelectorAll("[data-bio]"), function (b) {
        b.addEventListener("click", function () { var id = b.getAttribute("data-bio"); state.bios[id] = !state.bios[id]; paintFeed(); });
      });
    }

    /* ---- record actions ---- */
    function enrichOne(id, field, btn) {
      if (btn) { btn.disabled = true; btn.textContent = "…"; }
      send("/data", "POST", { action: "enrich", id: id, field: field }).then(function (res) {
        if (res.ok && res.data && res.data.record) {
          var i = state.all.findIndex(function (r) { return r.id === id; });
          if (i >= 0) state.all[i] = res.data.record;
          var f = res.data.found || {};
          toast((f.email || f.phone) ? "Enriched ✓" : "Nothing new found");
          paintFeed();
        } else { toast("Enrich failed"); if (btn) { btn.disabled = false; btn.textContent = "↻"; } }
      }).catch(function () { toast("Could not reach the server."); if (btn) { btn.disabled = false; btn.textContent = "↻"; } });
    }
    function enrichSel(btn) {
      var ids = Object.keys(state.sel); if (!ids.length) return;
      if (btn) { btn.disabled = true; }
      var done = 0;
      (function next(i) {
        if (i >= ids.length) { if (btn) { btn.disabled = false; } toast("Enriched " + done + " record" + (done === 1 ? "" : "s")); load(); return; }
        if (btn) btn.textContent = "Finding… " + (i + 1) + "/" + ids.length;
        send("/data", "POST", { action: "enrich", id: ids[i] }).then(function (res) {
          if (res.ok && res.data && res.data.found && (res.data.found.email || res.data.found.phone)) done++;
          next(i + 1);
        }).catch(function () { next(i + 1); });
      })(0);
    }
    function delSel() {
      var ids = Object.keys(state.sel); if (!ids.length) return;
      send("/data", "POST", { action: "delete", ids: ids }).then(function (res) {
        if (res.ok) { toast("Deleted " + (res.data.deleted || ids.length)); state.sel = {}; load(); } else toast("Delete failed");
      });
    }
    function promote(ids) {
      if (!ids || !ids.length) return;
      resolveBdCampaign(function (campaignId) {
        if (!campaignId) { toast("Create a campaign first."); return; }
        send("/data", "POST", { action: "promote", ids: ids, campaignId: campaignId, motion: motion }).then(function (res) {
          if (res.ok) {
            toast("Submitted " + (res.data.added || ids.length) + " to " + prospectsLabel());
            ids.forEach(function (id) { delete state.sel[id]; });
            renderAll();
          } else toast("Submit failed");
        });
      });
    }
    function bulkEmail() {
      var emails = Object.keys(state.sel).map(function (id) { var r = state.all.find(function (x) { return x.id === id; }); return r && r.email; }).filter(Boolean);
      if (!emails.length) { toast("None of the selected have an email yet."); return; }
      location.href = "mailto:?bcc=" + encodeURIComponent(emails.join(","));
    }
    function bulkSms() {
      var phones = Object.keys(state.sel).map(function (id) { var r = state.all.find(function (x) { return x.id === id; }); return r && (r.phone || r.directPhone); }).filter(Boolean);
      if (!phones.length) { toast("None of the selected have a phone yet."); return; }
      location.href = "sms:" + phones[0];
    }
    function exportCsv() {
      var rows = view(); if (!rows.length) { toast("Nothing to export."); return; }
      var cols = ["fullName", "title", "company", "email", "phone", "city", "state", "stage", "owner", "origin", "tags", "linkedinUrl"];
      var head2 = ["Name", "Title", "Company", "Email", "Phone", "City", "State", "Stage", "Owner", "Source", "Tags", "LinkedIn"];
      function cell(v) { v = v == null ? "" : (Array.isArray(v) ? v.join("; ") : String(v)); return '"' + v.replace(/"/g, '""') + '"'; }
      var csv = head2.join(",") + "\n" + rows.map(function (r) {
        return cols.map(function (c) { return cell(c === "phone" ? (r.phone || r.directPhone) : r[c]); }).join(",");
      }).join("\n");
      var blob = new Blob([csv], { type: "text/csv" }), url = URL.createObjectURL(blob);
      var a = document.createElement("a"); a.href = url; a.download = "candidates.csv"; a.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast("Exported " + rows.length + " row" + (rows.length === 1 ? "" : "s"));
    }
    function seedLume(btn) {
      if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
      send("/dev/seed-data", "POST", {}).then(function (res) {
        if (res.ok) { toast("Loaded " + (res.data.added || 0) + " new, updated " + (res.data.updated || 0)); load(); }
        else { toast("Load failed (" + (res.data.error || res.status) + ")"); if (btn) { btn.disabled = false; btn.textContent = "⬇ Load Lume Search Partners export"; } }
      }).catch(function () { toast("Could not reach the server."); if (btn) { btn.disabled = false; btn.textContent = "⬇ Load Lume Search Partners export"; } });
    }

    // search wiring
    $("#cdSearch", el).addEventListener("input", function (e) {
      if (searchTimer) clearTimeout(searchTimer);
      var v = e.target.value.trim();
      searchTimer = setTimeout(function () { state.q = v; renderAll(); }, 200);
    });

    load();
  }

  // Import modal: parse the exported CSV, auto-map columns (override per column), ingest.
  function openDataImport(onDone) {
    var bodyHtml =
      '<label>Upload the CSV you exported from the provider portal</label>' +
      '<input id="diFile" type="file" accept=".csv,.tsv,.txt" class="imp-file" />' +
      '<label>…or paste rows (CSV / TSV, first row = headers)</label>' +
      '<textarea id="diText" placeholder="Full Name,Job Title,Company,Email,Mobile Phone&#10;Jane Doe,VP Sales,Acme,jane@acme.com,+1..."></textarea>' +
      '<div id="diMap" class="imp-map"></div>' +
      '<div class="imp-preview" id="diPrev">Upload or paste an export to begin.</div>' +
      '<div class="modal-foot"><button class="btn btn-ghost btn-sm" id="diCancel">Cancel</button>' +
      '<button class="btn btn-primary btn-sm" id="diGo">Import</button></div>';
    openModal("Import data export", "Map the columns (auto-detected) and import. Re-importing updates existing records, nothing is duplicated.", bodyHtml, function (root, close) {
      var ta = root.querySelector("#diText"), fileEl = root.querySelector("#diFile");
      var mapEl = root.querySelector("#diMap"), prev = root.querySelector("#diPrev");
      var parsed = { headers: [], rows: [] }, mapping = {};

      function rebuild() {
        parsed = parseDelimited(ta.value);
        mapping = {};
        if (!parsed.headers.length) { mapEl.innerHTML = ""; prev.textContent = "Upload or paste an export to begin."; return; }
        mapEl.innerHTML = '<div class="imp-map-title">Map your columns (' + parsed.rows.length + ' rows)</div>' +
          parsed.headers.map(function (h, i) {
            var guess = guessDataField(h);
            mapping[h] = guess;
            var opts = DATA_FIELDS.map(function (f) { return '<option value="' + f[0] + '"' + (f[0] === guess ? " selected" : "") + ">" + esc(f[1]) + "</option>"; }).join("");
            return '<div class="imp-map-row"><span class="imp-col">' + esc(h) + '</span><select data-h="' + esc(h) + '">' + opts + "</select></div>";
          }).join("");
        Array.prototype.forEach.call(mapEl.querySelectorAll("select"), function (sel) {
          sel.addEventListener("change", function () { mapping[sel.getAttribute("data-h")] = sel.value; refresh(); });
        });
        refresh();
      }
      function refresh() {
        var named = parsed.rows.filter(function (r) {
          var hasName = false;
          for (var h in mapping) { if ((mapping[h] === "fullName" || mapping[h] === "firstName") && r[h]) hasName = true; }
          return hasName;
        }).length;
        prev.innerHTML = parsed.rows.length ? ("Ready to import <b>" + named + "</b> of " + parsed.rows.length + " rows (rows need a name).") : "Upload or paste an export to begin.";
      }
      ta.addEventListener("input", rebuild);
      fileEl.addEventListener("change", function () {
        var f = fileEl.files && fileEl.files[0]; if (!f) return;
        var reader = new FileReader();
        reader.onload = function () { ta.value = String(reader.result || ""); rebuild(); };
        reader.readAsText(f);
      });
      root.querySelector("#diCancel").addEventListener("click", close);
      root.querySelector("#diGo").addEventListener("click", function () {
        if (!parsed.rows.length) { toast("Nothing to import."); return; }
        var go = root.querySelector("#diGo"); go.disabled = true; go.textContent = "Importing…";
        send("/data", "POST", { action: "import", rows: parsed.rows, mapping: mapping }).then(function (res) {
          if (res.ok) {
            toast("Imported " + (res.data.added || 0) + " new, updated " + (res.data.updated || 0));
            close(); if (onDone) onDone();
          } else { toast("Import failed (" + (res.data.error || res.status) + ")"); go.disabled = false; go.textContent = "Import"; }
        }).catch(function () { toast("Could not reach the server."); go.disabled = false; go.textContent = "Import"; });
      });
    });
  }

  // Client mirror of the backend header→field guess (best-effort; user can override).
  function guessDataField(header) {
    var h = String(header || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    function has() { for (var i = 0; i < arguments.length; i++) if (h.indexOf(arguments[i]) >= 0) return true; return false; }
    if (has("linkedin")) return "linkedinUrl";
    if (has("fullname") || h === "name" || h === "contactname") return "fullName";
    if (has("firstname") || h === "first") return "firstName";
    if (has("lastname") || h === "last" || h === "surname") return "lastName";
    if (has("jobtitle", "title", "position")) return "title";
    if (has("companydomain", "website", "companyurl", "domain")) return "companyDomain";
    if (has("companyname") || h === "company" || h === "employer" || h === "account") return "company";
    if (has("industry", "sector")) return "industry";
    if (has("personalemail", "secondaryemail", "email2", "otheremail")) return "email2";
    if (has("emailaddress", "workemail", "businessemail") || h === "email") return "email";
    if (has("workphone")) return "companyPhone";
    if (has("personalphone")) return "phone";
    if (has("mobile", "cell")) return "phone";
    if (has("directphone", "directdial", "directnumber")) return "directPhone";
    if (has("companyphone", "hqphone", "mainphone", "officephone")) return "companyPhone";
    if (h === "phone" || has("phonenumber", "phone1")) return "phone";
    if (h === "city") return "city";
    if (h === "state" || has("region", "province")) return "state";
    if (h === "country") return "country";
    if (has("seniority", "managementlevel", "joblevel")) return "seniority";
    if (has("jobstage", "pipelinestage") || h === "stage" || h === "status") return "stage";
    if (h === "tags" || h === "tag" || has("labels", "skills")) return "tags";
    if (has("intake", "candidatesummary") || h === "notes" || h === "summary" || h === "bio" || h === "about") return "bio";
    if (has("compensation", "salary") || h === "comp") return "compensation";
    if (has("recordowner", "accountowner", "recruiter") || h === "owner") return "owner";
    if (has("recordtype") || h === "type") return "recordType";
    if (has("recentactivity", "lastactivity", "activitydate")) return "lastActivityAt";
    if (has("leadsource") || h === "source" || h === "origin") return "origin";
    if (has("zoominfoid", "contactid", "personid", "recordid") || h === "id") return "providerId";
    return "ignore";
  }

  // Pull modal: programmatic pull via the official provider API (dormant until keyed).
  function openDataPull(onDone) {
    var bodyHtml =
      '<label>Provider</label><select id="dpProvider"><option value="zoominfo">ZoomInfo (official API)</option></select>' +
      '<label>Job title</label><input id="dpTitle" placeholder="VP of Sales">' +
      '<label>Company</label><input id="dpCompany" placeholder="Acme">' +
      '<label>Location</label><input id="dpLoc" placeholder="United States">' +
      '<label>Max records</label><input id="dpLimit" type="number" value="50" min="1" max="100">' +
      '<div class="imp-note">Uses the provider\'s official, licensed API. Dormant until <code>ZOOMINFO_API_KEY</code> is set, until then, use <b>Import export</b>.</div>' +
      '<div class="modal-foot"><button class="btn btn-ghost btn-sm" id="dpCancel">Cancel</button>' +
      '<button class="btn btn-primary btn-sm" id="dpGo">Pull</button></div>';
    openModal("Pull via API", "Programmatic pull from the official provider API into your warehouse.", bodyHtml, function (root, close) {
      root.querySelector("#dpCancel").addEventListener("click", close);
      root.querySelector("#dpGo").addEventListener("click", function () {
        var go = root.querySelector("#dpGo"); go.disabled = true; go.textContent = "Pulling…";
        var query = {
          title: root.querySelector("#dpTitle").value.trim(),
          company: root.querySelector("#dpCompany").value.trim(),
          location: root.querySelector("#dpLoc").value.trim(),
          limit: parseInt(root.querySelector("#dpLimit").value, 10) || 50
        };
        send("/data", "POST", { action: "pull", provider: root.querySelector("#dpProvider").value, query: query }).then(function (res) {
          if (res.ok) { toast("Pulled " + (res.data.added || 0) + " new, updated " + (res.data.updated || 0)); close(); if (onDone) onDone(); }
          else if (res.status === 503) { toast("Provider not configured yet, use Import export."); go.disabled = false; go.textContent = "Pull"; }
          else { toast("Pull failed (" + (res.data.error || res.status) + ")"); go.disabled = false; go.textContent = "Pull"; }
        }).catch(function () { toast("Could not reach the server."); go.disabled = false; go.textContent = "Pull"; });
      });
    });
  }

  /* ---------------- Sending ----------------
     Owned cold-email infrastructure. Provision a Hetzner MTA server, then FEED IN
     DOMAINS, each one auto-generates DKIM, creates the Hetzner DNS zone, writes the
     full record set (SPF/DKIM/DMARC/MX/tracking/return-path), and sets PTR on the IP.
     The only manual step is a one-time nameserver delegation at the registrar.
     Backend: /api/sending + lib/sending/*. */
  function renderSending(el) {
    el.innerHTML = head("Email Sending", "Your owned cold-email infrastructure. Provision an MTA server, feed in domains, and every DNS record (SPF, DKIM, DMARC, MX, PTR, tracking) is set automatically on Hetzner.") +
      '<style>' +
      '.sd-card{margin-bottom:16px}' +
      '.sd-cfg{display:flex;gap:14px;flex-wrap:wrap;font-size:13px;margin-bottom:14px}' +
      '.sd-dot{display:inline-flex;align-items:center;gap:6px}' +
      '.sd-step{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted,#8b93a1);margin-bottom:8px}' +
      '.sd-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}' +
      '.sd-table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}' +
      '.sd-table th,.sd-table td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line,#20242c);vertical-align:top}' +
      '.sd-table th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,#8b93a1)}' +
      '.sd-badge{font-size:11px;padding:2px 8px;border-radius:20px;white-space:nowrap}' +
      '.sd-b-active{background:#10491f;color:#7ff0a0}.sd-b-wait{background:#4a3a10;color:#f0d27f}' +
      '.sd-b-err{background:#4a1414;color:#f08f8f}.sd-b-prov{background:#15324a;color:#7fc4f0}.sd-b-pending{background:#262a33;color:#9aa3b2}' +
      '.sd-chk{display:inline-flex;gap:5px;flex-wrap:wrap}' +
      '.sd-chip{font-size:10px;padding:2px 7px;border-radius:6px;border:1px solid var(--line,#2a2f3a)}' +
      '.sd-chip.ok{background:#10491f;color:#7ff0a0;border-color:transparent}' +
      '.sd-chip.no{background:#20242c;color:#6b7280}' +
      '.sd-ns{background:var(--bg,#0e0f13);border:1px dashed #f0d27f;border-radius:8px;padding:10px 12px;margin-top:8px;font-size:12px}' +
      '.sd-ns code{background:rgba(255,255,255,.06);padding:2px 6px;border-radius:4px;font-family:monospace}' +
      '.sd-mono{font-family:monospace;font-size:12px}' +
      '#sdDomains{width:100%;min-height:90px;font-family:monospace;font-size:13px;padding:10px;border-radius:8px;border:1px solid var(--line,#262a33);background:var(--bg,#0e0f13);color:inherit}' +
      '</style>' +
      '<div id="sdCfg" class="sd-cfg"></div>' +
      '<div class="card sd-card" style="border:1px solid var(--accent,#7c5cff)"><div class="sd-row" style="justify-content:space-between"><div class="sd-step" style="margin:0;color:var(--accent,#7c5cff)">⚡ One-click setup</div><span class="muted" style="font-size:11px">Provisions the MTA, DNS, and warming mailboxes, then the cron finishes it hands-off.</span></div>' +
        '<div id="sdSetup">' + loading() + '</div></div>' +
      '<div class="card sd-card"><div class="sd-step">Step 1 · MTA server (Hetzner)</div><div id="sdServers">' + loading() + '</div></div>' +
      '<div class="card sd-card"><div class="sd-step">Step 2 · Feed in domains</div>' +
        '<p class="muted" style="font-size:13px;margin:0 0 8px">Paste sending domains (one per line). Each is added and fully provisioned automatically, DKIM, zone, all records, PTR.</p>' +
        '<textarea id="sdDomains" placeholder="recruitco.io&#10;recruiters-co.com&#10;recruitersteam.com"></textarea>' +
        '<div class="sd-row" style="margin-top:8px"><button class="btn btn-primary btn-sm" id="sdAdd">⚡ Add &amp; auto-provision</button>' +
        '<span class="muted" style="font-size:12px">Needs an active MTA server + Hetzner tokens.</span></div>' +
      '</div>' +
      '<div class="card sd-card"><div class="sd-row" style="justify-content:space-between"><div class="sd-step" style="margin:0">Domains</div>' +
        '<div class="sd-row"><button class="btn btn-ghost btn-sm" id="sdTick">↻ Daily tick</button><button class="btn btn-ghost btn-sm" id="sdGov">🛡 Run governor</button></div></div>' +
        '<div id="sdList">' + loading() + '</div></div>' +
      '<div class="card sd-card"><div class="sd-step">Deliverability</div><div id="sdDeliv">' + loading() + '</div></div>' +
      '<div class="card sd-card"><div class="sd-step">Seed inboxes (placement testing)</div><div id="sdSeeds">' + loading() + '</div></div>';

    var state = { domains: [], servers: [], mailboxes: [], providers: { dns: false, cloud: false }, suppression: [], events: [], seeds: [], seedTests: [], stats: {}, health: { domains: [], mailboxes: [], overall: {} }, engagement: {} };

    function badge(s) {
      var m = { active: ["sd-b-active", "active"], awaiting_ns: ["sd-b-wait", "awaiting NS"], verifying: ["sd-b-prov", "verifying"],
        provisioning: ["sd-b-prov", "provisioning"], error: ["sd-b-err", "error"], pending: ["sd-b-pending", "pending"], paused: ["sd-b-err", "paused"] };
      var x = m[s] || ["sd-b-pending", s];
      return '<span class="sd-badge ' + x[0] + '">' + esc(x[1]) + '</span>';
    }

    function load() {
      api("/sending").then(function (d) {
        d = d || {};
        state.domains = d.domains || []; state.servers = d.servers || []; state.mailboxes = d.mailboxes || [];
        state.providers = d.providers || { dns: false, cloud: false };
        state.suppression = d.suppression || []; state.events = d.events || [];
        state.seeds = d.seeds || []; state.seedTests = d.seedTests || []; state.stats = d.stats || {};
        state.health = d.health || { domains: [], mailboxes: [], overall: {} };
        state.engagement = d.engagement || {};
        state.setup = d.setup || null; state.seedSummary = d.seedSummary || null;
        paintSetup(); paintCfg(); paintServers(); paintList(); paintDeliv(); paintSeeds();
      }).catch(function () { $("#sdList", el).innerHTML = '<div class="empty">Could not load sending infrastructure.</div>'; });
    }

    function paintSetup() {
      var body = $("#sdSetup", el); if (!body) return;
      var s = state.setup;
      var inp = 'padding:8px 10px;border-radius:8px;border:1px solid var(--line,#262a33);background:var(--bg,#0e0f13);color:inherit;font-size:13px';
      // Not started yet → show the single kickoff form.
      if (!s || !s.enabled) {
        body.innerHTML =
          '<p class="muted" style="font-size:13px;margin:6px 0 10px">Paste your sending domains and pick how many warming mailboxes per domain. We provision the Hetzner box (Postal), write every DNS record, and create the mailboxes. You do two small things when prompted: point each domain\'s nameservers at Hetzner, and (if auto-bootstrap doesn\'t catch it) paste the Postal key once.</p>' +
          '<textarea id="suDomains" placeholder="recruitco.io&#10;recruiters-co.com" style="width:100%;min-height:70px;font-family:monospace;' + inp + '"></textarea>' +
          '<div class="sd-row" style="margin-top:8px"><label class="muted" style="font-size:12px">Mailboxes/domain</label>' +
            '<input id="suPer" type="number" value="4" min="1" max="20" style="width:70px;' + inp + '">' +
            '<button class="btn btn-primary btn-sm" id="suGo">⚡ Set it up</button></div>';
        var go = $("#suGo", el); if (go) go.addEventListener("click", function () {
          var doms = $("#suDomains", el).value.split(/\s+/).map(function (x) { return x.trim(); }).filter(Boolean);
          if (!doms.length) { toast("Add at least one domain"); return; }
          go.disabled = true; go.textContent = "Setting up…";
          send("/sending", "POST", { action: "auto-setup", domains: doms, mailboxesPerDomain: parseInt($("#suPer", el).value, 10) || 4 }).then(function (r) {
            toast(r.ok ? "Setup started, the cron will carry it to the finish" : (r.data && r.data.error) || "Setup failed"); load();
          });
        });
        return;
      }
      // In progress / done → show the pipeline + the remaining gates.
      var steps = [];
      var srv = s.server;
      steps.push(stepRow(srv && srv.ip ? "done" : (srv ? "wait" : "todo"), "MTA server", srv ? (srv.hostname + (srv.ip ? " · " + srv.ip : " · provisioning…")) : "creating…"));
      steps.push(stepRow(srv && srv.postalReady ? "done" : (srv && srv.ip ? "wait" : "todo"), "Postal API", srv && srv.postalReady ? "connected" : "waiting for key (auto-bootstrap)"));
      var act = s.totals.active, dn = s.totals.domains;
      steps.push(stepRow(dn && act === dn ? "done" : (act ? "wait" : "todo"), "Domains verified", act + "/" + dn + " active"));
      steps.push(stepRow(s.totals.mailboxes >= s.totals.mailboxTarget && s.totals.mailboxTarget > 0 ? "done" : "wait", "Warming mailboxes", s.totals.mailboxes + "/" + s.totals.mailboxTarget + " created"));

      var gates = (s.gates || []).map(function (g) {
        var ns = g.detail && g.detail.nameservers ? (g.detail.nameservers || []).map(function (n) { return '<code>' + esc(n) + '</code>'; }).join(" ") : "";
        return '<div class="sd-ns"><b>' + esc(g.message) + '</b>' + (ns ? '<div style="margin-top:6px">Set these nameservers at your registrar: ' + ns + '</div>' : '') + '</div>';
      }).join("");

      body.innerHTML =
        (s.done ? '<div class="sd-badge sd-b-active" style="margin-bottom:10px">✓ Setup complete, warming can run</div>' : '<div class="muted" style="font-size:12px;margin-bottom:10px">In progress, the daily cron advances this automatically; nothing else to click unless a gate below asks.</div>') +
        '<div style="display:flex;flex-direction:column;gap:6px">' + steps.join("") + '</div>' +
        (gates ? '<div style="margin-top:10px">' + gates + '</div>' : "") +
        '<div class="sd-row" style="margin-top:12px"><button class="btn btn-ghost btn-sm" id="suAdvance">↻ Advance now</button>' +
          '<button class="btn btn-ghost btn-sm" id="suPause">Pause auto-setup</button></div>';
      var adv = $("#suAdvance", el); if (adv) adv.addEventListener("click", function () { adv.disabled = true; adv.textContent = "Advancing…"; send("/sending", "POST", { action: "advance-setup" }).then(function () { load(); }); });
      var pz = $("#suPause", el); if (pz) pz.addEventListener("click", function () { send("/sending", "POST", { action: "pause-setup" }).then(load); });
    }
    function stepRow(state2, label, detail) {
      var icon = state2 === "done" ? "✅" : state2 === "wait" ? "⏳" : "⬜";
      return '<div style="display:flex;align-items:center;gap:10px;font-size:13px"><span>' + icon + '</span><b style="min-width:150px">' + esc(label) + '</b><span class="muted">' + esc(detail) + '</span></div>';
    }

    function paintCfg() {
      var p = state.providers;
      function dot(on, label) { return '<span class="sd-dot">' + (on ? "🟢" : "⚪") + ' ' + label + '</span>'; }
      $("#sdCfg", el).innerHTML =
        dot(p.cloud, "Hetzner Cloud") + dot(p.dns, "Hetzner DNS") +
        dot(p.mta, "MTA send (SENDING_EMAIL_PROVIDER=mta)") + dot(p.snds, "MS SNDS") + dot(p.postmaster, "Google Postmaster");
    }

    function paintServers() {
      var body = $("#sdServers", el);
      var inp = 'padding:7px 10px;border-radius:8px;border:1px solid var(--line,#262a33);background:var(--bg,#0e0f13);color:inherit';
      var rows = state.servers.map(function (s) {
        var act = s.status === "active";
        var postal = s.postalReady ? '🟢 ready' : (s.postalApiKey ? '🟡 key set' : '⚪ not set');
        return '<tr><td><b>' + esc(s.name) + '</b><div class="muted sd-mono">' + esc(s.hostname) + '</div></td>' +
          '<td>' + (s.ip ? '<span class="sd-mono">' + esc(s.ip) + '</span>' : '<span class="muted">-</span>') + '</td>' +
          '<td>' + (s.ptr ? '✅ ' + esc(s.ptr) : '<span class="muted">no PTR</span>') + '</td>' +
          '<td>' + badge(s.status) + (s.lastError ? '<div class="muted" style="font-size:11px">' + esc(s.lastError) + '</div>' : '') + '</td>' +
          '<td><span class="sd-mono" style="font-size:11px">Postal: ' + postal + '</span></td>' +
          '<td>' + (act ? '<button class="btn btn-ghost btn-sm" data-postal="' + esc(s.id) + '">Postal creds</button>' : '<button class="btn btn-ghost btn-sm" data-prov-server="' + esc(s.id) + '">Provision</button>') + '</td></tr>' +
          '<tr id="sdPostal-' + esc(s.id) + '" style="display:none"><td colspan="6"><div class="sd-row" style="padding:6px 0">' +
            '<input data-phost="' + esc(s.id) + '" placeholder="https://' + esc(s.hostname) + '" value="' + esc(s.postalHost || ("https://" + s.hostname)) + '" style="flex:1;min-width:220px;' + inp + '">' +
            '<input data-pkey="' + esc(s.id) + '" placeholder="X-Server-API-Key from Postal" style="flex:1;min-width:200px;' + inp + '">' +
            '<button class="btn btn-sm" data-psave="' + esc(s.id) + '">Save</button>' +
          '</div><div class="muted" style="font-size:11px">After the box boots, create an org + mail server in Postal at the host above, then paste its server API key here.</div></td></tr>';
      }).join("");
      body.innerHTML =
        (state.servers.length ? '<table class="sd-table"><thead><tr><th>Server</th><th>IP</th><th>PTR / rDNS</th><th>Status</th><th>Postal</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' : '<p class="muted" style="font-size:13px;margin:0 0 10px">No MTA server yet. Add one, it becomes the MX target + PTR host for all domains.</p>') +
        '<div class="sd-row" style="margin-top:10px">' +
          '<input id="sdSrvName" placeholder="server name (e.g. mta-1)" style="' + inp + '">' +
          '<input id="sdSrvHost" placeholder="mail hostname (e.g. mail.recruitco.io)" style="flex:1;min-width:220px;' + inp + '">' +
          '<button class="btn btn-sm" id="sdAddSrv">＋ Add server</button>' +
        '</div>';
      Array.prototype.forEach.call(body.querySelectorAll("[data-prov-server]"), function (b) {
        b.addEventListener("click", function () { provisionServer(b.getAttribute("data-prov-server"), b); });
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-postal]"), function (b) {
        b.addEventListener("click", function () { var r = document.getElementById("sdPostal-" + b.getAttribute("data-postal")); if (r) r.style.display = r.style.display === "none" ? "" : "none"; });
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-psave]"), function (b) {
        b.addEventListener("click", function () {
          var id = b.getAttribute("data-psave");
          var host = body.querySelector('[data-phost="' + id + '"]').value.trim();
          var key = body.querySelector('[data-pkey="' + id + '"]').value.trim();
          if (!host || !key) { toast("Host + API key required"); return; }
          send("/sending", "POST", { action: "set-postal", id: id, host: host, apiKey: key }).then(function (r) {
            if (r.ok) { toast("Postal creds saved"); load(); } else toast("Save failed");
          });
        });
      });
      $("#sdAddSrv", el).addEventListener("click", function () {
        var name = $("#sdSrvName", el).value.trim(), host = $("#sdSrvHost", el).value.trim();
        if (!name || !host) { toast("Name + hostname required"); return; }
        send("/sending", "POST", { action: "add-server", name: name, hostname: host }).then(function (r) {
          if (r.ok) { toast("Server added, provision it to create the box + PTR"); load(); } else toast("Add failed (" + (r.data.error || r.status) + ")");
        });
      });
    }

    function provisionServer(id, btn) {
      if (btn) { btn.disabled = true; btn.textContent = "Provisioning…"; }
      send("/sending", "POST", { action: "provision-server", id: id }).then(function (r) {
        if (r.ok) toast("Server provisioned, IP + PTR set"); else toast(r.data.error || "Provision failed");
        load();
      }).catch(function () { toast("Server error"); load(); });
    }

    function paintList() {
      var body = $("#sdList", el);
      if (!state.domains.length) { body.innerHTML = '<div class="empty">No domains yet. Paste some above and hit auto-provision.</div>'; return; }
      body.innerHTML = state.domains.map(function (d) {
        var chk = (d.checklist || []).map(function (c) {
          return '<span class="sd-chip ' + (c.present ? "ok" : "no") + '">' + (c.present ? "✓ " : "") + esc(c.label) + '</span>';
        }).join("");
        var mboxes = state.mailboxes.filter(function (m) { return m.domainId === d.id; });
        var ns = (d.status === "awaiting_ns" || d.status === "verifying") && d.nameservers && d.nameservers.length
          ? '<div class="sd-ns">⚠️ One-time step: at your registrar, set this domain\'s nameservers to:<br>' +
            d.nameservers.map(function (n) { return '<code>' + esc(n) + '</code>'; }).join(" ") +
            '<br><span class="muted">Then click Verify. Everything else is already written into Hetzner DNS.</span></div>'
          : '';
        var m = d.metrics || { sent: 0, delivered: 0, bounced: 0, complained: 0 };
        var pct = function (p, w) { return w > 0 ? ((p / w) * 100).toFixed(1) + "%" : "0%"; };
        var metrics = m.sent ? '<div class="sd-chk" style="margin-top:6px">' +
          '<span class="sd-chip">📤 ' + m.sent + ' sent</span>' +
          '<span class="sd-chip ' + (m.bounced / m.sent > 0.02 ? "no" : "ok") + '">↩ ' + pct(m.bounced, m.sent) + ' bounce</span>' +
          '<span class="sd-chip ' + (m.complained / m.sent > 0.001 ? "no" : "ok") + '">🚩 ' + pct(m.complained, m.sent) + ' complaint</span>' +
          (d.reputation ? '<span class="sd-chip">⭐ rep: ' + esc(d.reputation.tier || "-") + '</span>' : '') +
          '</div>' : '';
        var warm = mboxes.length ? '<div class="muted" style="font-size:11px;margin-top:4px">warm-up: ' +
          mboxes.map(function (x) { return esc(x.address.split("@")[0]) + " d" + x.warmupDay + " (" + x.sentToday + "/" + x.dailyCap + ")"; }).join(" · ") + '</div>' : '';
        var paused = d.pausedReason ? '<div class="sd-chip no" style="margin-top:6px">⏸ paused: ' + esc(d.pausedReason) + '</div>' : '';
        return '<div style="border:1px solid var(--line,#20242c);border-radius:10px;padding:12px;margin-bottom:10px">' +
          '<div class="sd-row" style="justify-content:space-between">' +
            '<div><b class="sd-mono">' + esc(d.domain) + '</b> ' + badge(d.status) + '</div>' +
            '<div class="sd-row">' +
              '<button class="btn btn-ghost btn-sm" data-verify="' + esc(d.id) + '">Verify</button>' +
              '<button class="btn btn-ghost btn-sm" data-seedtest="' + esc(d.id) + '">Seed test</button>' +
              '<button class="btn btn-ghost btn-sm" data-psetup="' + esc(d.id) + '">Postal setup</button>' +
              '<button class="btn btn-ghost btn-sm" data-reprov="' + esc(d.id) + '">Re-provision</button>' +
              '<button class="btn btn-ghost btn-sm" data-del="' + esc(d.id) + '">Delete</button>' +
            '</div>' +
          '</div>' +
          '<div class="sd-chk" style="margin-top:8px">' + chk + '</div>' +
          metrics + paused + ns +
          '<div class="sd-row" style="margin-top:8px"><span class="muted" style="font-size:12px">' + mboxes.length + ' mailbox' + (mboxes.length === 1 ? '' : 'es') + '</span>' +
            '<input data-mbox-addr="' + esc(d.id) + '" placeholder="ryan@' + esc(d.domain) + '" style="padding:6px 9px;border-radius:7px;border:1px solid var(--line,#262a33);background:var(--bg,#0e0f13);color:inherit;font-size:12px">' +
            '<button class="btn btn-ghost btn-sm" data-add-mbox="' + esc(d.id) + '">＋ mailbox</button></div>' +
          warm +
          '<div id="sdSetup-' + esc(d.id) + '"></div>' +
          (d.lastError ? '<div class="muted" style="font-size:11px;margin-top:6px">' + esc(d.lastError) + '</div>' : '') +
          '</div>';
      }).join("");

      Array.prototype.forEach.call(body.querySelectorAll("[data-verify]"), function (b) {
        b.addEventListener("click", function () { act("verify-domain", b.getAttribute("data-verify"), b, "Verified"); });
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-reprov]"), function (b) {
        b.addEventListener("click", function () { act("provision-domain", b.getAttribute("data-reprov"), b, "Re-provisioned"); });
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-del]"), function (b) {
        b.addEventListener("click", function () { send("/sending", "POST", { action: "delete-domain", id: b.getAttribute("data-del") }).then(function () { load(); }); });
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-add-mbox]"), function (b) {
        b.addEventListener("click", function () {
          var id = b.getAttribute("data-add-mbox");
          var addr = body.querySelector('[data-mbox-addr="' + id + '"]').value.trim();
          if (!addr) { toast("Enter an address"); return; }
          send("/sending", "POST", { action: "add-mailbox", domainId: id, address: addr }).then(function (r) {
            if (r.ok) { toast("Mailbox added (warming)"); load(); } else toast("Add failed");
          });
        });
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-seedtest]"), function (b) {
        b.addEventListener("click", function () {
          b.disabled = true; b.textContent = "Sending…";
          send("/sending", "POST", { action: "seed-test", domainId: b.getAttribute("data-seedtest") }).then(function (r) {
            b.disabled = false; b.textContent = "Seed test";
            toast(r.ok ? "Seed probes sent, placement fills in as seeds report" : (r.data.error || "Need seed inboxes first"));
            load();
          });
        });
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-psetup]"), function (b) {
        b.addEventListener("click", function () {
          var id = b.getAttribute("data-psetup");
          var host = document.getElementById("sdSetup-" + id);
          if (host && host.innerHTML) { host.innerHTML = ""; return; }
          send("/sending", "POST", { action: "domain-setup", id: id }).then(function (r) {
            if (!r.ok || !r.data.setup) { toast("No setup available"); return; }
            var s = r.data.setup;
            host.innerHTML = '<div class="sd-ns" style="border-color:#7fc4f0">🔑 Postal config for this domain (paste once into Postal):<br>' +
              'Selector: <code>' + esc(s.selector) + '</code><br>' +
              '<div class="muted" style="margin:4px 0">' + esc(s.note) + '</div>' +
              (s.privateKeyPem ? '<details><summary style="cursor:pointer">Show DKIM private key</summary><textarea readonly style="width:100%;height:120px;font-family:monospace;font-size:11px;margin-top:4px">' + esc(s.privateKeyPem) + '</textarea></details>' : '') +
              '</div>';
          });
        });
      });
    }

    function paintDeliv() {
      var body = $("#sdDeliv", el); if (!body) return;
      var st = state.stats || {};
      var h = state.health || { domains: [], mailboxes: [], overall: {} };
      var ov = h.overall || {};
      var tot = state.domains.reduce(function (a, d) { var m = d.metrics || {}; return { sent: a.sent + (m.sent || 0) }; }, { sent: 0 });
      var num = function (n) { return (n == null ? "-" : Number(n).toLocaleString()); };
      var pc = function (n) { return (n == null ? "-" : (Math.round(n * 10) / 10) + "%"); };

      // healthy/warm -> green, watch/warming -> amber, at_risk/paused -> red, new/cold -> neutral
      function scorePill(label) {
        var m = { healthy: ["sd-b-active", "healthy"], warm: ["sd-b-active", "warm"], watch: ["sd-b-wait", "watch"],
          warming: ["sd-b-wait", "warming"], at_risk: ["sd-b-err", "at risk"], paused: ["sd-b-err", "paused"],
          "new": ["sd-b-pending", "new"], cold: ["sd-b-pending", "cold"] };
        var x = m[label] || ["sd-b-pending", label || "-"];
        return '<span class="sd-badge ' + x[0] + '">' + esc(x[1]) + '</span>';
      }
      function bar(score) {
        var s = Math.max(0, Math.min(100, Number(score) || 0));
        var cls = s >= 80 ? "ready" : s >= 55 ? "warming" : "action";
        return '<span class="or-bar" style="display:inline-block;width:58px;vertical-align:middle;margin-right:6px"><span class="' + cls + '" style="width:' + s + '%"></span></span>';
      }
      function tile(value, label, pillLabel) {
        return '<div class="dt-stat" style="background:var(--card,#14161c);border:1px solid var(--line,#1f232b);border-radius:9px;padding:9px 13px;min-width:92px">' +
          '<b style="display:block;font-size:21px;line-height:1.1">' + value + '</b>' +
          '<span class="muted" style="font-size:11px">' + esc(label) + '</span>' +
          (pillLabel ? ' ' + scorePill(pillLabel) : "") + '</div>';
      }

      var tiles = '<div class="dt-stats" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">' +
        tile(ov.healthScore != null ? ov.healthScore : "-", "domain health", ov.label) +
        tile(ov.warmthScore != null ? ov.warmthScore : "-", "mailbox warmth") +
        tile(ov.ipWarmthScore != null ? ov.ipWarmthScore : "-", "shared-IP warmth") +
        tile(ov.canSend ? "Yes" : "No", "sending now", ov.canSend ? "healthy" : "at_risk") +
        tile(num(ov.capacityToday), "sends left today") +
        tile((ov.activeMailboxes || 0) + "/" + (ov.mailboxes || 0), "mailboxes warm") +
        tile(num(tot.sent), "sent (lifetime)") +
        tile(num(st.suppressed || 0), "suppressed") +
        (ov.pausedDomains ? tile(ov.pausedDomains, "domains paused", "paused") : "") +
        '</div>';

      // Per-domain health
      var domRows = (h.domains || []).map(function (d) {
        var warn = (d.warnings && d.warnings.length) ? '<div class="or-mini" style="color:#ffa3a3;margin-top:2px;font-size:11px">⚠ ' + esc(d.warnings.join(" · ")) + '</div>' : "";
        return '<tr>' +
          '<td><b>' + esc(d.domain) + '</b>' + warn + '</td>' +
          '<td style="white-space:nowrap">' + bar(d.healthScore) + '<b>' + (d.healthScore != null ? d.healthScore : "-") + '</b> ' + scorePill(d.healthLabel) + '</td>' +
          '<td>' + pc(d.bounceRatePct) + '</td>' +
          '<td>' + pc(d.complaintRatePct) + '</td>' +
          '<td>' + (d.deliveryRatePct ? d.deliveryRatePct + "%" : "-") + '</td>' +
          '<td>' + (d.reputationTier ? esc(d.reputationTier) : "-") + '</td>' +
          '<td>' + (d.inboxRatePct != null ? d.inboxRatePct + "%" : "-") + '</td>' +
        '</tr>';
      }).join("") || '<tr><td colspan="7" class="muted" style="font-size:12px">No sending domains yet, add them in Configuration above.</td></tr>';
      var domTable = '<div class="sd-step" style="margin-top:8px">Domain health</div>' +
        '<table class="sd-table"><thead><tr><th>Domain</th><th>Health</th><th>Bounce</th><th>Complaint</th><th>Delivered</th><th>Reputation</th><th>Inbox</th></tr></thead><tbody>' + domRows + '</tbody></table>';

      // Per-mailbox warmth
      var mbRows = (h.mailboxes || []).map(function (m) {
        return '<tr>' +
          '<td><b>' + esc(m.address) + '</b></td>' +
          '<td style="white-space:nowrap">' + bar(m.warmthScore) + '<b>' + (m.warmthScore != null ? m.warmthScore : "-") + '</b> ' + scorePill(m.warmthLabel) + '</td>' +
          '<td>day ' + (m.warmupDay != null ? m.warmupDay : "-") + '</td>' +
          '<td>' + (m.sentToday != null ? m.sentToday : 0) + ' / ' + (m.dailyCap != null ? m.dailyCap : "-") + '</td>' +
          '<td>' + (m.capRemaining != null ? m.capRemaining : "-") + '</td>' +
        '</tr>';
      }).join("") || '<tr><td colspan="5" class="muted" style="font-size:12px">No mailboxes yet, add them to a verified domain.</td></tr>';
      var mbTable = '<div class="sd-step" style="margin-top:12px">Mailbox warmth</div>' +
        '<table class="sd-table"><thead><tr><th>Mailbox</th><th>Warmth</th><th>Warmup</th><th>Today</th><th>Left</th></tr></thead><tbody>' + mbRows + '</tbody></table>';

      // Warm-up engagement loop (B): bidirectional warming at real provider inboxes.
      var eng = state.engagement || {};
      var engBadge = eng.enabled ? scorePill("warm") : scorePill("cold");
      var engStat = function (v, l) { return '<span style="margin-right:14px"><b>' + (v != null ? v : 0) + '</b> <span class="muted" style="font-size:11px">' + l + '</span></span>'; };
      var engBlock = '<div class="sd-step" style="margin-top:12px">Warm-up engagement loop ' + engBadge + '</div>' +
        '<div style="font-size:12px;margin:4px 0 2px">' +
          engStat(eng.sent, "sent (24h)") + engStat(eng.opened, "opened") + engStat(eng.replied, "replied") + engStat(eng.rescued, "rescued from spam") +
        '</div>' +
        '<div class="muted" style="font-size:11px">' +
          (eng.enabled
            ? 'Warming mailboxes email your seed inboxes; the seed client opens, replies, and rescues from spam over IMAP/SMTP. Driven by <code class="sd-mono">/api/sending/warmup/cron</code> (run every few minutes). Add seed inboxes below.'
            : 'Off. Set <code class="sd-mono">SENDING_WARMUP_ENGAGE=1</code>, add Gmail/Outlook seed inboxes (with IMAP app-password creds) below, and schedule <code class="sd-mono">/api/sending/warmup/cron</code> to turn on the always-running loop.') +
        '</div>';

      var ev = (state.events || []).slice(0, 15).map(function (e) {
        var ic = { sent: "📤", delivered: "✅", bounce: "↩", complaint: "🚩", open: "👁" }[e.type] || "•";
        return '<div style="font-size:12px;padding:3px 0;border-bottom:1px solid var(--line,#1a1d24)">' + ic + ' <b>' + esc(e.type) + '</b> ' + esc(e.to || "") + (e.detail ? ' <span class="muted">' + esc(String(e.detail).slice(0, 60)) + '</span>' : '') + '</div>';
      }).join("") || '<p class="muted" style="font-size:12px">No delivery events yet. They flow in from the Postal webhook (/api/sending/webhook).</p>';

      body.innerHTML = tiles + domTable + mbTable + engBlock +
        '<div class="muted" style="font-size:11px;margin:10px 0 6px">Fail-safe: the governor auto-pauses a domain (and its mailboxes) at bounce&gt;2%, complaint&gt;0.1%, spam&gt;0.3%, or a "bad" reputation tier. The shared IP ramps on its own curve (50/day to ~1,000/day over ~3 weeks) so a cold IP is never slammed. Webhook: <code class="sd-mono">/api/sending/webhook</code> · daily tick: <code class="sd-mono">/api/sending/cron</code></div>' +
        '<div class="sd-step" style="margin-top:8px">Recent events</div>' + ev;
    }

    function paintSeeds() {
      var body = $("#sdSeeds", el); if (!body) return;
      var inp = 'padding:6px 9px;border-radius:7px;border:1px solid var(--line,#262a33);background:var(--bg,#0e0f13);color:inherit;font-size:12px';
      // Connector status per seed: green = server logged in over IMAP (drivable),
      // amber = creds saved but not yet verified, grey = no app password yet.
      var list = (state.seeds || []).map(function (s) {
        var badge = s.imapOk ? '<span title="' + esc(s.imapVerifiedAt || '') + '" style="color:#46d39a">● connected</span>'
          : s.hasCreds ? '<span title="' + esc(s.lastError || 'not verified yet') + '" style="color:#f0b34d">● ' + (s.lastError ? 'failed' : 'unverified') + '</span>'
          : '<span style="color:#7b8194">● no app password</span>';
        return '<div class="sd-chip" style="display:flex;align-items:center;gap:8px;margin:3px 0;justify-content:space-between">' +
          '<span>' + esc(s.provider) + ': ' + esc(s.address) + (s.addedBy ? ' <span class="muted" style="font-size:11px">· ' + esc(s.addedBy) + '</span>' : '') + '</span>' +
          '<span style="display:flex;align-items:center;gap:8px;font-size:11px">' + badge +
            (s.hasCreds ? ' <a href="#" data-testseed="' + esc(s.id) + '" style="color:#4dd0ff">test</a>' : '') +
            ' <a href="#" data-delseed="' + esc(s.id) + '" style="color:#f08f8f">✕</a></span></div>';
      }).join("") || '<span class="muted" style="font-size:12px">No seed inboxes yet. Add a few across Gmail/Outlook/Yahoo, or send staff the self-setup link below.</span>';
      var tests = (state.seedTests || []).slice(0, 5).map(function (t) {
        var done = t.status === "complete";
        var label = done ? (t.inboxRatePct != null ? ('<b>' + t.inboxRatePct + '% inbox</b>') : 'complete') : 'sending…';
        return '<div style="font-size:12px;padding:3px 0">' + esc(t.domainId) + ' · ' + label +
          ' <span class="muted">' + t.results.map(function (r) { return r.provider + ":" + r.placement; }).join(" ") + '</span></div>';
      }).join("");
      var portalLink = location.origin + "/seed-portal.html?token=YOUR_TOKEN";
      body.innerHTML =
        '<div style="margin-bottom:8px">' + list + '</div>' +
        '<div class="sd-row"><select id="sdSeedProv" style="' + inp + '"><option value="gmail">Gmail</option><option value="outlook">Outlook</option><option value="yahoo">Yahoo</option><option value="other">Other</option></select>' +
          '<input id="sdSeedAddr" placeholder="seed@gmail.com" style="flex:1;min-width:150px;' + inp + '">' +
          '<input id="sdSeedPass" placeholder="app password" style="flex:1;min-width:130px;' + inp + '">' +
          '<button class="btn btn-ghost btn-sm" id="sdAddSeed">＋ Add &amp; test</button></div>' +
        '<div class="muted" style="font-size:11px;margin-top:6px;line-height:1.5">Staff self-setup link (set <code class="sd-mono">SENDING_SEED_PORTAL_TOKEN</code>, then share with the token filled in): <code class="sd-mono">' + esc(portalLink) + '</code></div>' +
        (tests ? ('<div class="sd-step" style="margin-top:10px">Recent placement tests</div>' + tests) : '');
      Array.prototype.forEach.call(body.querySelectorAll("[data-delseed]"), function (a) {
        a.addEventListener("click", function (e) { e.preventDefault(); send("/sending", "POST", { action: "delete-seed", id: a.getAttribute("data-delseed") }).then(load); });
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-testseed]"), function (a) {
        a.addEventListener("click", function (e) {
          e.preventDefault(); a.textContent = "testing…";
          send("/sending", "POST", { action: "test-seed", id: a.getAttribute("data-testseed") }).then(function (r) {
            toast(r.ok && r.data.verified ? "Connected ✓" : (r.data && r.data.error) || "Login failed"); load();
          });
        });
      });
      $("#sdAddSeed", el).addEventListener("click", function () {
        var addr = $("#sdSeedAddr", el).value.trim(); if (!addr) { toast("Enter a seed address"); return; }
        var pass = $("#sdSeedPass", el).value.trim();
        send("/sending", "POST", { action: "add-seed", provider: $("#sdSeedProv", el).value, address: addr, appPassword: pass }).then(function (r) {
          if (r.ok) { toast(pass ? (r.data.verified ? "Seed added & connected ✓" : "Added, but login failed: " + (r.data.error || "")) : "Seed added (no app password, add one to connect)"); load(); } else toast("Add failed");
        });
      });
    }

    function act(action, id, btn, okMsg) {
      if (btn) { btn.disabled = true; var t = btn.textContent; btn.textContent = "…"; }
      send("/sending", "POST", { action: action, id: id }).then(function (r) {
        if (r.ok) toast(okMsg); else toast(r.data.error || "Failed");
        load();
      }).catch(function () { toast("Server error"); load(); });
    }

    $("#sdTick", el).addEventListener("click", function () {
      var b = $("#sdTick", el); b.disabled = true; b.textContent = "Running…";
      send("/sending", "POST", { action: "daily-tick" }).then(function (r) {
        b.disabled = false; b.textContent = "↻ Daily tick";
        if (r.ok) { var rep = r.data.report || {}; toast("Tick: " + (rep.warmup ? rep.warmup.advanced + " ramped" : "") + (rep.paused && rep.paused.length ? ", " + rep.paused.length + " paused" : "")); load(); } else toast("Tick failed");
      });
    });
    $("#sdGov", el).addEventListener("click", function () {
      send("/sending", "POST", { action: "run-governor" }).then(function (r) {
        if (r.ok) { var p = r.data.paused || []; toast(p.length ? ("Paused " + p.length + " domain(s)") : "All domains healthy"); load(); } else toast("Governor failed");
      });
    });

    $("#sdAdd", el).addEventListener("click", function () {
      var domains = $("#sdDomains", el).value.split(/[\s,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (!domains.length) { toast("Paste at least one domain"); return; }
      var btn = $("#sdAdd", el); btn.disabled = true; btn.textContent = "Provisioning " + domains.length + "…";
      send("/sending", "POST", { action: "add-domains", domains: domains }).then(function (r) {
        btn.disabled = false; btn.textContent = "⚡ Add & auto-provision";
        if (r.ok) {
          var res = r.data.results || [];
          var okN = res.filter(function (x) { return !x.error; }).length;
          var errs = res.filter(function (x) { return x.error; });
          toast("Provisioned " + okN + "/" + res.length + (errs.length ? ", " + (errs[0].error || "some errors") : ""));
          $("#sdDomains", el).value = "";
          load();
        } else { toast("Failed (" + (r.data.error || r.status) + ")"); }
      }).catch(function () { btn.disabled = false; btn.textContent = "⚡ Add & auto-provision"; toast("Could not reach server"); });
    });

    load();
  }

  /* ---------------- JD Sourcing ----------------
     Upload a job description -> parse an ideal-candidate profile -> generate Boolean /
     X-ray + LinkedIn searches -> run discovery (RapidAPI people-search) into a ranked,
     deduped candidate list -> save it under a NAME here (staging) -> send it to
     Candidates under that same name. Backend: /api/sourcing + lib/sourcing/*. */
  function renderJdSourcing(el) {
    var state = { jd: "", icp: null, queries: [], candidates: [], warnings: [], note: "", queue: [], runs: [], running: false, refineNote: "", location: "" };
    function jdbLoc() { var e = $("#jdbLocation"); return e ? e.value.trim() : ""; }
    function jdbRadius() { var e = $("#jdbRadius"); return e ? (parseInt(e.value, 10) || 0) : 0; }
    function jdLocLabel() { var loc = jdbLoc(); if (!loc) return ""; var r = jdbRadius(); return r > 0 ? (loc + " +" + r + "mi") : loc; }
    function jdLocPhrase() { var loc = jdbLoc(); if (!loc) return ""; var r = jdbRadius(); return r > 0 ? (loc + " (within ~" + r + " miles, include ALL surrounding metros and cities within that drive, not just " + loc + ")") : loc; }
    function jdWithLoc(jd) { var p = jdLocPhrase(); return p ? (jd + "\n\nBased in: " + p) : jd; }

    el.innerHTML =
      '<style>' +
      '.jd-chip{display:inline-block;background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:3px 11px;margin:2px 5px 2px 0;font-size:12px;color:var(--text-muted);transition:border-color .12s,color .12s}' +
      '.jd-chip:hover{border-color:var(--brand);color:var(--text)}' +
      '.jd-icp{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-top:12px}' +
      '.jd-icp>div b{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim);margin-bottom:7px;font-weight:700}' +
      '.jd-empty{font-size:13.5px;color:var(--text);background:var(--bg-soft);border:1px solid var(--border-strong);border-left:3px solid #e0a33e;border-radius:10px;padding:12px 14px;margin:6px 0 0;line-height:1.5}' +
      '.jd-hints{margin:10px 0 0;display:flex;flex-direction:column;gap:8px;max-width:760px}' +
      '.jd-hint{font-size:12px;color:var(--text-muted);margin:0;line-height:1.55;padding-left:11px;border-left:2px solid var(--border-strong)}' +
      '.jd-hint b{color:var(--text)}' +
      '.jd-help{margin:0 0 14px}' +
      '.jd-helpbody{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px 26px;margin-top:4px}' +
      '.jd-helpsec h5{margin:0 0 7px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim);font-weight:700}' +
      '.jd-helpsec p{margin:0 0 8px;font-size:12.5px;color:var(--text-muted);line-height:1.5}' +
      '.jd-helpsec p b{color:var(--text)}' +
      '.jd-steps{display:flex;gap:0;margin:0 0 14px;padding:0;list-style:none}' +
      '.jd-step{flex:1;position:relative;display:flex;flex-direction:column;align-items:center;text-align:center;padding:0 6px}' +
      '.jd-step:not(:last-child)::after{content:"";position:absolute;top:15px;left:calc(50% + 19px);right:calc(-50% + 19px);height:2px;background:var(--border-strong);transition:background .2s}' +
      '.jd-step.done::after{background:var(--brand)}' +
      '.jd-step-n{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;background:var(--bg-soft);border:2px solid var(--border-strong);color:var(--text-muted);position:relative;z-index:1;transition:all .2s}' +
      '.jd-step.active .jd-step-n{border-color:var(--brand);color:var(--brand-2);box-shadow:0 0 0 4px color-mix(in srgb,var(--brand) 16%,transparent)}' +
      '.jd-step.done .jd-step-n{background:var(--brand);border-color:var(--brand);color:#fff}' +
      '.jd-step-l{font-size:12px;font-weight:600;margin-top:7px;color:var(--text-muted)}' +
      '.jd-step.active .jd-step-l,.jd-step.done .jd-step-l{color:var(--text)}' +
      '.jd-step-s{font-size:11px;color:var(--text-dim);margin-top:2px;line-height:1.3}' +
      '@media(max-width:680px){.jd-step-s{display:none}.jd-step-l{font-size:11px}}' +
      '.jd-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:14px}' +
      '.jd-cap{font-size:12.5px;color:var(--text-muted);display:inline-flex;align-items:center;gap:6px}' +
      '.jd-cap input{width:62px;background:var(--bg-soft);border:1px solid var(--border-strong);border-radius:7px;color:var(--text);font:inherit;font-size:12.5px;padding:5px 7px;margin:0 2px}' +
      '.jd-cost{display:inline-block;margin-left:10px;padding:4px 12px;border-radius:999px;background:linear-gradient(135deg,rgba(124,92,255,.16),rgba(80,200,255,.12));border:1px solid rgba(124,92,255,.4);color:var(--text);font-size:12.5px;font-weight:600;vertical-align:middle;transition:transform .12s ease;white-space:nowrap}' +
      '.jd-cost.bump{transform:scale(1.06)}' +
      '.jd-cost b{color:var(--brand-2);font-variant-numeric:tabular-nums}' +
      '.jd-prog-head{display:flex;align-items:center;gap:9px;margin-bottom:9px;font-size:14px}' +
      '.jd-prog-head .jd-prog-pct{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:700;color:var(--brand-2)}' +
      '.jd-prog-dot{width:10px;height:10px;border-radius:50%;background:var(--brand-2);animation:jdpulse 1.3s infinite}' +
      '@keyframes jdpulse{0%{box-shadow:0 0 0 0 rgba(124,92,255,.55)}70%{box-shadow:0 0 0 9px rgba(124,92,255,0)}100%{box-shadow:0 0 0 0 rgba(124,92,255,0)}}' +
      '.jd-prog-track{height:11px;border-radius:999px;background:var(--bg-soft);border:1px solid var(--border);overflow:hidden}' +
      '.jd-prog-fill{height:100%;width:0;border-radius:999px;background:linear-gradient(90deg,var(--brand),var(--brand-2));background-size:200% 100%;animation:jdflow 1.1s linear infinite;transition:width .3s ease}' +
      '@keyframes jdflow{0%{background-position:0 0}100%{background-position:-200% 0}}' +
      '.jd-prog-meta{display:flex;justify-content:space-between;gap:10px;margin-top:8px;font-size:12px}' +
      '.jd-prog.done .jd-prog-dot{animation:none;background:#33d69f}' +
      '.jd-prog.done .jd-prog-fill{animation:none;background:#33d69f}' +
      '.jd-cardhead{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}' +
      '.jd-vetctl{display:inline-flex;align-items:center;gap:9px;font-size:13px;color:var(--text-muted)}' +
      '.jd-vetctl input{width:54px;background:var(--bg-soft);border:1px solid var(--border-strong);border-radius:7px;color:var(--text);font:inherit;font-size:13px;padding:5px 7px;text-align:center}' +
      '.jd-ratelink{background:none;border:0;color:var(--text-dim);font:inherit;font-size:12px;cursor:pointer;text-decoration:underline;text-underline-offset:2px;padding:0}' +
      '.jd-ratelink:hover{color:var(--brand-2)}' +
      '.jd-rates{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:11px 0 0;padding:10px 13px;background:var(--bg-soft);border:1px solid var(--border);border-radius:10px;font-size:12.5px;color:var(--text-muted)}' +
      '.jd-rates input{width:66px;background:var(--surface-2);border:1px solid var(--border-strong);border-radius:7px;color:var(--text);font:inherit;font-size:12.5px;padding:5px 7px;text-align:center}' +
      '.jd-sub{color:var(--text-muted);font-size:13px;line-height:1.55;margin:13px 0 15px}' +
      '.jd-refine{display:flex;gap:8px;align-items:center;margin-top:15px}' +
      '.jd-refine input{flex:1;background:var(--bg-soft);border:1px solid var(--border-strong);border-radius:10px;color:var(--text);font:inherit;font-size:13.5px;padding:10px 13px}' +
      '.jd-refine input::placeholder{color:var(--text-dim)}' +
      '.jd-refine input:focus{outline:0;border-color:var(--brand);box-shadow:0 0 0 3px rgba(124,92,255,.18)}' +
      '.jd-refine-note{margin:9px 0 0;font-size:12.5px;color:var(--brand-2)}' +
      '.jd-tips{margin-top:8px;padding:10px 14px;background:var(--bg-soft);border:1px solid var(--border);border-left:3px solid var(--brand);border-radius:11px;font-size:12.5px;color:var(--text-muted);line-height:1.5}' +
      '.jd-tips>.jd-tips-h{color:var(--text);font-weight:700}' +
      '.jd-tipgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:4px 18px;margin-top:7px}' +
      '.jd-tipgrid>span{display:block;position:relative;padding-left:15px}' +
      '.jd-tipgrid>span::before{content:"";position:absolute;left:0;top:6px;width:6px;height:6px;border-radius:50%;background:linear-gradient(135deg,#7c5cff,var(--brand-2))}' +
      '.jd-tipgrid b{color:var(--brand-2);font-weight:600}' +
      '.jd-builder{position:relative;padding:11px 14px;background:var(--bg-soft);border:1px solid var(--border-strong);border-radius:12px;margin-bottom:11px}' +
      '.jd-builder::after{content:none}' +
      '.jd-builder-h{position:relative;font-weight:700;font-size:13.5px;letter-spacing:.01em;margin-bottom:3px;color:var(--text)}' +
      '.jd-builder-sub{font-size:12px;color:var(--text-muted);margin-bottom:8px}' +
      '.jd-builder-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}' +
      '@media(max-width:640px){.jd-builder-row{grid-template-columns:1fr}}' +
      '.jd-lead{font-size:13.5px;margin-bottom:8px}.jd-lead b{color:var(--text)}' +
      '.jd-builder input{width:100%;background:var(--bg-soft);border:1px solid var(--border-strong);border-radius:9px;color:var(--text);font:inherit;font-size:13.5px;padding:9px 12px}' +
      '.jd-builder input::placeholder{color:var(--text-dim)}' +
      '.jd-builder input:focus{outline:0;border-color:var(--brand);box-shadow:0 0 0 3px rgba(124,92,255,.18)}' +
      '.jd-builder-act{display:flex;align-items:center;gap:11px;margin-top:10px}' +
      '.jd-builder-act .muted{font-size:12px}' +
      '.jd-or{display:flex;align-items:center;text-align:center;color:var(--text-dim);font-size:12px;letter-spacing:.04em;text-transform:uppercase;margin:4px 0 12px}' +
      '.jd-or::before,.jd-or::after{content:"";flex:1;height:1px;background:var(--border)}' +
      '.jd-or span{padding:0 12px}' +
      '.jd-buildbar{display:flex;align-items:center;gap:11px;flex-wrap:wrap;margin:12px 0 2px}' +
      '.jd-buildbar .muted{font-size:12px}' +
      '#jdName,#jdText,#jdbTitle,#jdbCompany,#jdbNotes,#jdbLocation{width:100%;background:var(--bg-soft);border:1px solid var(--border-strong);border-radius:10px;color:var(--text);font:inherit;font-size:14px;padding:11px 14px;margin:0;transition:border-color .12s,box-shadow .12s}' +
      '#jdText{line-height:1.55;resize:vertical;min-height:104px}' +
      '#jdName::placeholder,#jdText::placeholder,#jdbTitle::placeholder,#jdbCompany::placeholder,#jdbNotes::placeholder,#jdbLocation::placeholder{color:var(--text-dim)}' +
      '#jdName:focus,#jdText:focus,#jdbTitle:focus,#jdbCompany:focus,#jdbNotes:focus,#jdbLocation:focus,.jd-cap input:focus{outline:0;border-color:var(--brand);box-shadow:0 0 0 3px rgba(124,92,255,.18)}' +
      '.jd-field{margin-bottom:8px}' +
      '.jd-field>label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim);font-weight:700;margin-bottom:6px}' +
      '.jd-opt{font-weight:500;text-transform:none;letter-spacing:0;opacity:.75;margin-left:7px}' +
      '.jd-lead2{font-size:16px;font-weight:800;letter-spacing:.01em;margin:0 0 3px;background:linear-gradient(90deg,#7c5cff,var(--brand-2));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:var(--brand-2)}' +
      '.jd-lead-sub{font-size:12.5px;color:var(--text-muted);margin:0 0 12px}' +
      '.jd-locrow{display:flex;gap:8px}.jd-locrow #jdbLocation{flex:1}' +
      '#jdbRadius{background:var(--bg-soft);border:1px solid var(--border-strong);border-radius:10px;color:var(--text);font:inherit;font-size:13px;padding:0 9px;cursor:pointer;flex:0 0 auto}' +
      '#jdbRadius:focus{outline:0;border-color:var(--brand)}' +
      '.jd-tipsd{margin-top:10px;font-size:12.5px;color:var(--text-muted)}' +
      '.jd-tipsd>summary{cursor:pointer;color:var(--text);font-weight:600;font-size:13px;list-style:none;user-select:none;' +
        'display:flex;align-items:center;gap:8px;padding:9px 12px;border:1px solid var(--border-strong);border-radius:10px;' +
        'background:var(--bg-soft);transition:border-color .15s,background .15s}' +
      '.jd-tipsd>summary:hover{border-color:var(--brand);background:var(--bg)}' +
      '.jd-tipsd>summary::-webkit-details-marker{display:none}' +
      '.jd-tipsd>summary::before{content:"▾";color:var(--brand-2);font-size:11px;transition:transform .15s;flex:0 0 auto}' +
      '.jd-tipsd:not([open])>summary::before{transform:rotate(-90deg)}' +
      '.jd-tipsd>summary .muted{margin-left:auto;font-weight:500;font-size:11.5px;opacity:.7}' +
      '.jd-tipsd[open]>summary{margin-bottom:8px;border-color:var(--brand)}' +
      '.jd-fieldgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:8px}.jd-fieldgrid>.jd-field{margin-bottom:0}' +
      '@media(max-width:640px){.jd-fieldgrid{grid-template-columns:1fr;gap:0}.jd-fieldgrid>.jd-field{margin-bottom:8px}}' +
      '.jd-queries{max-height:240px;overflow:auto;border:1px solid var(--border);border-radius:10px;padding:6px 12px;background:var(--bg-soft)}' +
      '.jd-q{padding:8px 0;font-size:13px;border-bottom:1px solid var(--border)}.jd-q:last-child{border-bottom:0}' +
      '.jd-q-label{display:inline-block;min-width:260px;font-weight:600}' +
      '.jd-q a{color:var(--brand-2);text-decoration:none}.jd-q a:hover{text-decoration:underline}' +
      '.jd-tablewrap{max-height:460px;overflow:auto;border:1px solid var(--border);border-radius:12px;margin-top:10px}' +
      '.jd-table{width:100%;border-collapse:collapse;font-size:13px}' +
      '.jd-table th,.jd-table td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums}' +
      '.jd-table tbody tr:hover td{background:var(--surface-2)}' +
      '.jd-table th{position:sticky;top:0;background:var(--bg-soft);font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-dim);font-weight:700;white-space:nowrap}' +
      '.jd-table a{color:var(--brand-2);text-decoration:none}.jd-table a:hover{text-decoration:underline}' +
      '.jd-run{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--border)}.jd-run:last-child{border-bottom:0}' +
      '.jd-run-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}' +
      '.jd-enrich-grp{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text-muted);white-space:nowrap}' +
      '.jd-enrichn{width:62px;padding:5px 7px;border:1px solid var(--border);border-radius:8px;background:var(--bg-soft);color:var(--text);font:inherit;font-size:12.5px}' +
      '.jd-enrichn:focus{outline:0;border-color:var(--brand)}' +
      '</style>' +
      head("JD Sourcing", "Upload a job description → find & rank candidates by geography, role, and qualifications → save the list, then send it to Candidates under the same name.") +
      '<ol class="jd-steps" id="jdSteps"></ol>' +
      '<details class="jd-tipsd jd-help"><summary>How this works <span class="muted">what each step, setting, and button does</span></summary>' +
        '<div class="jd-helpbody">' +
          '<div class="jd-helpsec"><h5>The flow</h5>' +
            '<p><b>1 &middot; Build the brief</b>: Enter the role and anything you know. The AI refines your input into a strong, wide-net hiring brief and drops it in the Job description box.</p>' +
            '<p><b>2 &middot; Analyze JD</b>: Turns that brief into an ideal-candidate profile, the titles, companies, locations, and must-haves the search will use.</p>' +
            '<p><b>3 &middot; Find candidates</b>: Searches for real people matching the profile, scores each on fit, and returns a ranked list.</p>' +
            '<p><b>4 &middot; Save to JD Sourcing</b>: Stores the list here under its name so you can return to it and act on it.</p>' +
          '</div>' +
          '<div class="jd-helpsec"><h5>Search settings</h5>' +
            '<p><b>Min fit</b>: The match-strength bar, 0 to 100. Set 0 to see every profile found; raise it to keep only stronger matches (10 is wide, 40 and up is tight).</p>' +
            '<p><b>Scan up to</b>: The ceiling on how many candidates a run gathers. Not a minimum, you get however many qualified people the search finds, up to this number.</p>' +
            '<p><b>Dive deeper / Refine</b>: After Analyze, type a plain instruction (e.g. "only Director and up in medical devices, exclude agencies") to tighten or widen the profile, then search again.</p>' +
            '<p><b>Add to queue</b>: Line up several briefs and run them back to back instead of one at a time.</p>' +
          '</div>' +
          '<div class="jd-helpsec"><h5>On a saved list</h5>' +
            '<p><b>Excel (URLs)</b>: Download the list as an Excel (.xlsx) spreadsheet of LinkedIn profile URLs.</p>' +
            '<p><b>Deep-vet</b>: Reads the top candidates\' full work history against the role and gives each a verified score and a short verdict.</p>' +
            '<p><b>Enrich top N</b>: You choose how many of the top-ranked candidates to look up business email and phone for. Enrich as few or as many as you want, then push them into any campaign you like. Manual for now; you can wire it to run automatically once you have a campaign set up.</p>' +
            '<p><b>Send to Candidates</b>: Pushes the list into your Candidates pipeline under the same name, ready to drop into a campaign.</p>' +
            '<p><b>Delete</b>: Removes the saved list. The people themselves are not deleted.</p>' +
          '</div>' +
        '</div>' +
      '</details>' +
      '<div class="card">' +
        '<div class="jd-lead2">Start with the role</div>' +
        '<div class="jd-lead-sub">Fill in what you know and paste any JD. The AI refines it into a strong, wide-net search.</div>' +
        '<div class="jd-fieldgrid">' +
          '<div class="jd-field"><label>Job title</label><input id="jdbTitle" type="text" placeholder="e.g. VP of Sales, Director of Nursing" /></div>' +
          '<div class="jd-field"><label>Company</label><input id="jdbCompany" type="text" placeholder="Name or website (finds peers to poach)" /></div>' +
        '</div>' +
        '<div class="jd-fieldgrid">' +
          '<div class="jd-field"><label>City &amp; state <span class="jd-opt muted">+ radius</span></label>' +
            '<div class="jd-locrow"><input id="jdbLocation" type="text" placeholder="e.g. Fair Lawn, NJ" />' +
              '<select id="jdbRadius" title="Expand beyond the exact metro by estimated drive distance">' +
                '<option value="0">Exact</option><option value="25">+25mi</option><option value="50">+50mi</option><option value="100">+100mi</option><option value="250">+250mi</option>' +
              '</select></div></div>' +
          '<div class="jd-field"><label>List name</label><input id="jdName" type="text" placeholder="e.g. JAGGAER VP Sales · East" /></div>' +
        '</div>' +
        '<div class="jd-field"><label>Anything specific <span class="jd-opt muted">optional</span></label><input id="jdbNotes" type="text" placeholder="Seniority, certs/licenses, must-have experience, deal-breakers" /></div>' +
        '<div class="jd-field"><label>Job description <span class="jd-opt muted">optional, or let the AI write it</span></label>' +
          '<textarea id="jdText" rows="4" placeholder="Paste the job description here. The more real detail, the stronger the search."></textarea></div>' +
        '<div class="jd-builder"><div class="jd-buildbar" style="margin:0;justify-content:space-between;gap:10px">' +
          '<span class="jd-builder-sub" style="margin:0">The AI refines your input, fills the gaps, and widens the net. Run this first, then Analyze.</span>' +
          '<button class="btn btn-primary btn-sm" id="jdbBtn" style="flex:0 0 auto">✨ Build refined JD</button></div>' +
        '</div>' +
        '<details class="jd-tipsd"><summary>See what sharpens the search <span class="muted">Tap to expand</span></summary>' +
          '<div class="jd-tipgrid">' +
            '<span><b>Title &amp; level</b>: the exact role and seniority, and whether it leads a team</span>' +
            '<span><b>Skills, tools &amp; licenses</b>: required certs, licenses, or systems (e.g. RN, CPA, AWS, Epic, Salesforce)</span>' +
            '<span><b>Seniority &amp; scope</b>: years of experience, team size, or budget they have owned</span>' +
            '<span><b>Must-have experience</b>: what they have actually done, not nice-to-haves</span>' +
            '<span><b>Industry / domain</b>: where strong candidates come from</span>' +
            '<span><b>Target companies</b>: competitors or peers worth poaching from</span>' +
            '<span><b>Location &amp; radius</b>: the metros that matter (or remote), widened by the mileage you set</span>' +
            '<span><b>Proof of impact</b>: measurable results they can show (outcomes, scale, growth, metrics)</span>' +
            '<span><b>Deal-breakers</b>: what should rule a candidate out</span>' +
          '</div>' +
        '</details>' +
        '<div class="jd-actions">' +
          '<button class="btn btn-primary btn-sm" id="jdAnalyze">Analyze JD</button>' +
          '<button class="btn btn-ghost btn-sm" id="jdFind" disabled>Find candidates</button>' +
          '<span class="jd-cap muted">Scan up to <input id="jdCap" type="number" min="1" max="5000" value="500" title="Ceiling on candidates gathered per run. Not a minimum — runs return however many qualified people the search finds, up to this number."> · min fit <input id="jdMinFit" type="number" min="0" max="100" value="10" title="0 = show every profile the search finds (nothing filtered). Higher = keep only stronger matches. 10 is a wide net; 40+ is tight."></span>' +
          '<label class="jd-cap muted" title="Skip anyone this workspace already surfaced in past runs — surfaces fresh people (new market entrants) instead of repeats."><input type="checkbox" id="jdFresh" style="width:auto;margin:0 4px 0 0;vertical-align:middle"> Fresh only</label>' +
          '<span id="jdRunCost" class="jd-cost" style="display:none"></span>' +
          '<button class="btn btn-ghost btn-sm" id="jdSave" disabled>💾 Save to JD Sourcing</button>' +
          '<button class="btn btn-ghost btn-sm" id="jdQueueAdd">➕ Add to queue</button>' +
        '</div>' +
        '<div class="jd-hints">' +
          '<p class="jd-hint"><b>Min fit</b> &middot; the match-strength bar, from 0 to 100. Leave it at 0 to see every profile found, with nothing filtered. Raise it to keep only the strongest matches: 10 casts a wide net, 40 and up runs tight.</p>' +
          '<p class="jd-hint"><b>Scan up to</b> &middot; the ceiling on how many candidates a run gathers. Not a minimum: you get however many qualified people the search finds, up to this number.</p>' +
        '</div>' +
        '<div id="jdMsg" class="muted" style="margin-top:8px"></div>' +
      '</div>' +
      '<div class="card jd-prog" id="jdProgress" style="display:none"></div>' +
      '<div class="card" id="jdQueueCard" style="display:none"><h3>Queue <span class="muted" id="jdQueueCount"></span></h3>' +
        '<p class="muted" style="margin-top:-4px">Each queued JD runs in turn (search, rank, save) using the Max and min-fit set above. Keep this tab open while the queue runs; each finished list lands below with a downloadable CSV of LinkedIn URLs.</p>' +
        '<div id="jdQueueList"></div>' +
        '<div class="jd-actions">' +
          '<button class="btn btn-primary btn-sm" id="jdQueueRun">▶ Run queue</button>' +
          '<button class="btn btn-ghost btn-sm" id="jdQueueClear">Clear queue</button>' +
          '<span class="muted" id="jdQueueProg"></span>' +
        '</div>' +
      '</div>' +
      '<div id="jdPlan"></div>' +
      '<div id="jdResults"></div>' +
      '<div class="card">' +
        '<div class="jd-cardhead"><h3 style="margin:0">Your saved candidate lists</h3>' +
          '<span class="jd-vetctl">Deep-vet top <input id="jdVetTop" type="number" min="1" max="200" value="25">' +
            '<span id="jdVetCost" class="jd-cost"></span></span></div>' +
        '<p class="jd-sub">Reads each shortlisted candidate\'s full career history against the role and returns a verified fit score and verdict. It is the first-pass screen your team would do by hand, across the whole list in seconds. Run it on the top N you choose.</p>' +
        '<div id="jdRuns">' + loading() + '</div></div>';

    function msg(t) { var m = $("#jdMsg"); if (m) m.textContent = t || ""; }
    function chips(arr) { return (arr || []).map(function (x) { return '<span class="jd-chip">' + esc(x) + '</span>'; }).join("") || '<span class="muted">-</span>'; }

    // Visual progress: which of the four steps the user is on, derived from state.
    var JD_STEPS = [
      { n: 1, l: "Build the brief", s: "Refine the role" },
      { n: 2, l: "Analyze", s: "Build the profile" },
      { n: 3, l: "Find candidates", s: "Run the search" },
      { n: 4, l: "Save the list", s: "Send to Candidates" }
    ];
    function jdCurrentStep() {
      if (state.candidates && state.candidates.length) return 4;
      if (state.icp) return 3;
      var t = $("#jdText");
      if ((state.jd && state.jd.trim()) || (t && t.value.trim())) return 2;
      return 1;
    }
    function renderSteps() {
      var host = $("#jdSteps"); if (!host) return;
      var cur = jdCurrentStep();
      host.innerHTML = JD_STEPS.map(function (st) {
        var cls = st.n < cur ? "done" : st.n === cur ? "active" : "";
        return '<li class="jd-step ' + cls + '"><span class="jd-step-n">' + (st.n < cur ? "✓" : String(st.n)) + '</span>' +
          '<span class="jd-step-l">' + st.l + '</span><span class="jd-step-s">' + st.s + '</span></li>';
      }).join("");
    }

    function renderPlan() {
      var host = $("#jdPlan"); if (!host) return;
      if (!state.icp) { host.innerHTML = ""; return; }
      var i = state.icp;
      var coreEmpty = !(i.titles && i.titles.length) && !(i.targetCompanies && i.targetCompanies.length) && !(i.geos && i.geos.length);
      if (coreEmpty) {
        host.innerHTML = '<div class="card"><h3>Ideal candidate</h3>' +
          '<p class="jd-empty">⚠ ' + esc(state.note || "Couldn't read the brief into a profile. Click Analyze JD again, or add a clear job title, a few real example companies, and a location to the brief.") + '</p></div>';
        return;
      }
      // Role-adaptive columns: only show fields that apply (e.g. Sells to is sales-only).
      var cells = [
        '<div><b>Titles</b><br>' + chips(i.titles) + '</div>',
        '<div><b>Geos</b><br>' + chips(i.geos) + '</div>',
        '<div><b>Target companies</b><br>' + chips(i.targetCompanies) + '</div>',
        '<div><b>Industries</b><br>' + chips(i.industries) + '</div>'
      ];
      if (i.mustHave && i.mustHave.length) cells.push('<div><b>Must have</b><br>' + chips(i.mustHave) + '</div>');
      if (i.sellsTo && i.sellsTo.length) cells.push('<div><b>Sells to</b><br>' + chips(i.sellsTo) + '</div>');
      if (i.disqualifiers && i.disqualifiers.length) cells.push('<div><b>Disqualifiers</b><br>' + chips(i.disqualifiers) + '</div>');
      host.innerHTML = '<div class="card"><h3>Ideal candidate · ' + esc(i.label || "") + '</h3>' +
        '<div class="jd-icp">' + cells.join("") + '</div>' +
        '<div class="jd-refine"><input id="jdRefineInput" type="text" placeholder="Dive deeper: refine with AI, e.g. only Director+ who sold into manufacturing, exclude agencies" />' +
          '<button class="btn btn-primary btn-sm" id="jdRefineBtn">✨ Refine</button></div>' +
        (state.refineNote ? '<p class="jd-refine-note">✨ ' + esc(state.refineNote) + '</p>' : '') +
        '<h4 style="margin-top:14px">Generated searches (' + state.queries.length + ')</h4>' +
        '<div class="jd-queries">' + state.queries.map(function (q) {
          return '<div class="jd-q"><span class="jd-q-label">' + esc(q.label) + '</span>' +
            '<a href="' + esc(q.googleUrl) + '" target="_blank" rel="noopener">Google X-ray</a> · ' +
            '<a href="' + esc(q.linkedinUrl) + '" target="_blank" rel="noopener">LinkedIn</a></div>';
        }).join("") + '</div>' +
        (state.note ? '<p class="muted" style="margin-top:10px">' + esc(state.note) + '</p>' : '') +
      '</div>';
    }

    function renderResults() {
      var host = $("#jdResults"); if (!host) return;
      if (!state.candidates.length) { host.innerHTML = ""; return; }
      var rows = state.candidates.slice(0, 300).map(function (c) {
        return '<tr><td>' + c.fitScore + '</td><td>' + esc(c.fullName) + '</td><td>' + esc(c.title || c.headline || "") +
          '</td><td>' + esc(c.company || "") + '</td><td>' + esc(c.location || "") + '</td>' +
          '<td>' + (c.linkedinUrl ? '<a href="' + esc(c.linkedinUrl) + '" target="_blank" rel="noopener">view</a>' : '') + '</td></tr>';
      }).join("");
      host.innerHTML = '<div class="card"><h3>Ranked candidates · ' + state.candidates.length + '</h3>' +
        (state.warnings.length ? '<p class="muted">⚠ ' + esc(state.warnings.join(" · ")) + '</p>' : '') +
        '<div class="jd-tablewrap"><table class="jd-table"><thead><tr><th>Fit</th><th>Name</th><th>Title</th><th>Company</th><th>Location</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        (state.candidates.length > 300 ? '<p class="muted">Showing top 300 of ' + state.candidates.length + '. Save to keep the full set.</p>' : '') +
      '</div>';
    }

    function loadRuns() {
      api("/sourcing").then(function (d) {
        var host = $("#jdRuns"); if (!host) return;
        var runs = (d && d.runs) || [];
        state.runs = runs;
        // FAILSAFE: if the backend reports non-durable storage, warn LOUDLY before the user
        // saves work that won't survive a restart. durable===false should never happen in prod.
        var warn = (d && d.durable === false)
          ? '<div class="card" style="border-color:#c0392b;background:#2a1414"><b>⚠ Saved lists are NOT being stored durably.</b><br><span class="muted">The server is running in memory-only mode, so saved searches will be lost on the next restart. Don\'t rely on saving until this is fixed (check the /data volume / persistence config).</span></div>'
          : '';
        if (!runs.length) { host.innerHTML = warn + '<p class="muted">No saved lists yet. Analyze a JD, find candidates, then Save. Or queue several JDs above and run them with the Run queue button.</p>'; return; }
        host.innerHTML = warn + runs.map(function (r) {
          var n = r.candidates ? r.candidates.length : 0;
          var urls = (r.candidates || []).filter(function (c) { return c.linkedinUrl; }).length;
          var vetted = (r.candidates || []).filter(function (c) { return typeof c.verifiedScore === "number"; }).length;
          return '<div class="jd-run"><div><b>' + esc(r.name) + '</b> <span class="muted">· ' +
            (r.location ? (esc(r.location) + ' · ') : '') + n + ' candidates · ' + urls + ' with LinkedIn URL' +
            (vetted ? (' · ' + vetted + ' deep-vetted') : '') +
            (r.promotedCount ? (' · sent ' + r.promotedCount + ' to Candidates') : '') + '</span></div>' +
            '<div class="jd-run-actions">' +
              '<button class="btn btn-ghost btn-sm" data-csv="' + esc(r.id) + '">⬇ Excel (URLs)</button>' +
              '<button class="btn btn-ghost btn-sm" data-rerank="' + esc(r.id) + '" title="AI re-ranks the top 100 by true relevance to the role before you deep-vet — sharper than the rule score.">✨ Re-rank</button>' +
              '<button class="btn btn-ghost btn-sm" data-vet="' + esc(r.id) + '">🔬 Deep-vet</button>' +
              '<button class="btn btn-ghost btn-sm" data-laxis="' + esc(r.id) + '" title="First-pass enrichment through Laxis: uploads this list to app.laxis.tech, runs their enrichment, then fills any gaps with the in-house waterfall. Up to 1,000 contacts per pass.">🧬 Enrich via Laxis</button>' +
              '<button class="btn btn-primary btn-sm" data-promote="' + esc(r.id) + '">Send to Candidates →</button>' +
              '<span class="jd-enrich-grp">⚡ Enrich top <input type="number" class="jd-enrichn" min="1" max="' + Math.max(1, n) + '" value="' + Math.min(25, Math.max(1, n)) + '" title="Choose how many of the top-ranked candidates to enrich (business email + phone). You decide how many; costs apply per lookup."> ' +
                '<button class="btn btn-ghost btn-sm" data-enrich="' + esc(r.id) + '">Enrich</button></span>' +
              '<button class="btn btn-ghost btn-sm" data-del="' + esc(r.id) + '">Delete</button>' +
            '</div></div>';
        }).join("");
      }).catch(function () { var host = $("#jdRuns"); if (host) host.innerHTML = '<p class="muted">Could not load saved lists.</p>'; });
    }

    /* ---- Export (LinkedIn URLs only — enrichment happens in your own tool) ---- */
    function csvSlug(s) { return ((s || "list").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase()) || "list"; }
    // Force a true file save. Anchors that aren't in the DOM (and blob: links in some
    // embedded browsers) get ignored and open inline instead of downloading.
    function downloadBlob(blob, filename) {
      if (window.navigator && window.navigator.msSaveOrOpenBlob) { window.navigator.msSaveOrOpenBlob(blob, filename); return; }
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = filename; a.rel = "noopener"; a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
    }
    function csvDownload(filename, csv) {
      // UTF-8 BOM so Excel/Numbers open it as a real spreadsheet.
      downloadBlob(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" }), filename);
    }

    /* ---- Real .xlsx writer (no libraries) ----
       We export .xlsx (not .csv) so Windows opens it in Excel by default — .csv can be
       hijacked by another app (e.g. an editor) as its default program. An .xlsx file is a
       ZIP of a few XML parts; we build the ZIP by hand with stored (uncompressed) entries. */
    var _crcTable;
    function crc32(buf) {
      if (!_crcTable) {
        _crcTable = [];
        for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); _crcTable[n] = c >>> 0; }
      }
      var crc = 0xFFFFFFFF;
      for (var i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ _crcTable[(crc ^ buf[i]) & 0xFF];
      return (crc ^ 0xFFFFFFFF) >>> 0;
    }
    function zipStore(entries) {
      var enc = new TextEncoder(), chunks = [], central = [], offset = 0;
      function u16(v) { return [v & 0xff, (v >>> 8) & 0xff]; }
      function u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }
      entries.forEach(function (e) {
        var name = enc.encode(e.name), data = e.data, crc = crc32(data);
        var local = new Uint8Array([].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0)));
        chunks.push(local, name, data);
        central.push({ rec: new Uint8Array([].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset))), name: name });
        offset += local.length + name.length + data.length;
      });
      var cStart = offset, cSize = 0;
      central.forEach(function (c) { chunks.push(c.rec, c.name); cSize += c.rec.length + c.name.length; });
      chunks.push(new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cSize), u32(cStart), u16(0))));
      var total = chunks.reduce(function (s, c) { return s + c.length; }, 0), out = new Uint8Array(total), p = 0;
      chunks.forEach(function (c) { out.set(c, p); p += c.length; });
      return out;
    }
    function xlsxColName(i) { var s = ""; i += 1; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
    function xlsxEsc(v) { return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ""); }
    function xlsxDownload(filename, sheetName, matrix) {
      var enc = new TextEncoder();
      var sheetRows = matrix.map(function (cells, r) {
        return '<row r="' + (r + 1) + '">' + cells.map(function (v, ci) {
          return '<c r="' + xlsxColName(ci) + (r + 1) + '" t="inlineStr"><is><t xml:space="preserve">' + xlsxEsc(v) + '</t></is></c>';
        }).join("") + "</row>";
      }).join("");
      var sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + sheetRows + "</sheetData></worksheet>";
      var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>';
      var rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
      var workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="' + xlsxEsc((sheetName || "Sheet1").slice(0, 31)) + '" sheetId="1" r:id="rId1"/></sheets></workbook>';
      var wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
      var zip = zipStore([
        { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
        { name: "_rels/.rels", data: enc.encode(rootRels) },
        { name: "xl/workbook.xml", data: enc.encode(workbook) },
        { name: "xl/_rels/workbook.xml.rels", data: enc.encode(wbRels) },
        { name: "xl/worksheets/sheet1.xml", data: enc.encode(sheet) },
      ]);
      downloadBlob(new Blob([zip], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename);
    }
    function urlRows(cands) { return (cands || []).filter(function (c) { return c.linkedinUrl; }); }
    function downloadRun(id) {
      var run = state.runs.find(function (r) { return r.id === id; }); if (!run) { toast("List not loaded yet."); return; }
      var rows = urlRows(run.candidates); if (!rows.length) { toast("No LinkedIn URLs in this list."); return; }
      var cols = ["linkedinUrl", "fullName", "title", "company", "location", "fitScore", "sourceGroup"];
      var head2 = ["LinkedIn URL", "Name", "Title", "Company", "Location", "Fit", "Source"];
      var hasVet = rows.some(function (c) { return typeof c.verifiedScore === "number"; });
      if (hasVet) {
        // Lead with the deep-vetted, highest verified score first.
        rows = rows.slice().sort(function (a, c) {
          return (c.verifiedScore == null ? -1 : c.verifiedScore) - (a.verifiedScore == null ? -1 : a.verifiedScore);
        });
        cols = cols.concat(["verifiedScore", "verdict", "yearsRelevant", "vetFlags"]);
        head2 = head2.concat(["Verified", "Verdict", "Years", "Flags"]);
      }
      function cellVal(v) { return v == null ? "" : (Array.isArray(v) ? v.join("; ") : String(v)); }
      var matrix = [head2].concat(rows.map(function (c) { return cols.map(function (k) { return cellVal(c[k]); }); }));
      xlsxDownload(csvSlug(run.name) + "-linkedin-urls.xlsx", "Candidates", matrix);
      var dropped = (run.candidates || []).length - rows.length;
      toast("Downloaded " + rows.length + " URLs to Excel" + (hasVet ? " (with deep-vet columns)" : "") + (dropped ? (" · " + dropped + " rows had no URL") : ""));
    }

    /* ---- Live deep-vet cost estimate (updates as the toggle / rates move) ----
       Per candidate: one Claude Sonnet 4.6 call (~2.5k input + ~0.45k output, fixed)
       plus one RapidAPI profile lookup (rate you set — provider-specific). Plus a flat
       monthly RapidAPI plan cost. Sonnet rates: $3 / 1M input, $15 / 1M output. */
    /* Cost model, priced on the live tool (Linkedin Data Scraper API, Pro $50 / 10k
       requests ≈ $0.005 per call). One request = one call: a search call returns a
       batch; a profile lookup is one call per candidate. Claude Sonnet 4.6 = $3/$15 per
       1M tokens; a deep-vet call is ~2.5k in + ~0.45k out ≈ $0.0143. */
    var VET = { inTok: 2500, outTok: 450, inUsd: 3 / 1e6, outUsd: 15 / 1e6 };
    function vetLlmPer() { return VET.inTok * VET.inUsd + VET.outTok * VET.outUsd; }
    function numVal(id, dflt) { var e = $(id); var v = e ? parseFloat(e.value) : NaN; return isFinite(v) && v >= 0 ? v : dflt; }
    function bump(el) { if (!el) return; el.classList.add("bump"); setTimeout(function () { el.classList.remove("bump"); }, 130); }
    function updateVetCost() {
      var el = $("#jdVetCost"), topEl = $("#jdVetTop"); if (!el || !topEl) return;
      var n = Math.max(0, parseInt(topEl.value, 10) || 0);
      var prof = numVal("#jdProfUsd", 0.005);
      if (!n) { el.textContent = ""; return; }
      var run = n * (vetLlmPer() + prof);
      el.textContent = "≈ $" + run.toFixed(2) + " / run";
      el.title = "Top " + n + ": AI vetting $" + (n * vetLlmPer()).toFixed(2) + " + " + n + " profile lookups $" + (n * prof).toFixed(2);
      bump(el);
    }
    /** Search-run cost (people-search requests + the one Haiku JD parse), shown by Find. */
    function updateRunCost() {
      var el = $("#jdRunCost"); if (!el) return;
      if (!state.icp && !state.queries.length) { el.style.display = "none"; return; }
      var perReq = numVal("#jdProfUsd", 0.005);
      var capEl = $("#jdCap"); var cap = capEl ? (parseInt(capEl.value, 10) || 500) : 500;
      // One search request per query (batched results); estimate query count before Analyze.
      var reqs = state.queries.length || Math.max(8, Math.min(60, Math.ceil(cap / 100) + 10));
      var cost = reqs * perReq + 0.002; // + one Haiku JD parse
      el.style.display = "";
      el.textContent = "≈ $" + cost.toFixed(2) + " to run";
      el.title = "Estimated cost for one search run (" + reqs + " searches + AI parse)";
      bump(el);
    }
    /** Build a sourcing-ready JD from a title + company (+ notes) and drop it in the box. */
    function doBuildJd() {
      var titleEl = $("#jdbTitle"); if (!titleEl) return;
      var title = titleEl.value.trim();
      var companyEl = $("#jdbCompany"), notesEl = $("#jdbNotes"), ta = $("#jdText");
      var company = companyEl ? companyEl.value.trim() : "";
      var notes = notesEl ? notesEl.value.trim() : "";
      var loc = jdLocPhrase(); if (loc) notes = [notes, "Based in " + loc].filter(Boolean).join(". ");
      var base = ta ? ta.value.trim() : "";   // strengthen whatever's already in the box
      if (!title && !base) { titleEl.focus(); msg("Add a title, or paste a rough JD below, and we'll strengthen it."); return; }
      var btn = $("#jdbBtn"); if (btn) { btn.disabled = true; btn.textContent = "Working…"; }
      msg(base ? "Strengthening what you gave us into a sourcing brief…" : "Drafting a sourcing-ready JD…");
      send("/sourcing", "POST", { action: "draft", title: title, company: company, companyUrl: company, notes: notes, base: base }).then(function (r) {
        if (btn) { btn.disabled = false; btn.textContent = "✨ Build refined JD"; }
        if (!r.ok) { msg("Build failed: " + ((r.data && r.data.error) || r.status)); return; }
        var jd = (r.data && r.data.jd) || "";
        if (ta && jd) { ta.value = jd; ta.focus(); }
        state.jd = jd;
        var nameEl = $("#jdName"); if (nameEl && !nameEl.value.trim() && title) nameEl.value = title + (company ? (" · " + company) : "");
        renderSteps();
        msg(jd ? "Done — your refined brief is now in the Job description box just below. Review or tweak it, then click Analyze JD." : "Couldn't build it. Add a few more details and try again.");
      });
    }

    /** "Dive deeper" — refine the ICP with a natural-language instruction (LLM). */
    function doRefine() {
      var inp = $("#jdRefineInput"); if (!inp) return;
      var instruction = inp.value.trim();
      if (!instruction) { inp.focus(); return; }
      if (!state.icp) { msg("Analyze a JD first."); return; }
      var btn = $("#jdRefineBtn"); if (btn) { btn.disabled = true; btn.textContent = "Refining…"; }
      send("/sourcing", "POST", { action: "refine", jd: state.jd, icp: state.icp, instruction: instruction }).then(function (r) {
        if (btn) { btn.disabled = false; btn.textContent = "✨ Refine"; }
        if (!r.ok) { msg("Refine failed: " + ((r.data && r.data.error) || r.status)); return; }
        state.icp = r.data.icp || state.icp;
        state.queries = r.data.queries || state.queries;
        state.refineNote = r.data.changes || "Search refined.";
        state.candidates = []; state.warnings = [];
        $("#jdFind").disabled = false; $("#jdSave").disabled = true;
        renderPlan(); renderResults(); renderSteps(); updateRunCost();
        msg("Search refined. Review the updated profile, then Find candidates again.");
      });
    }

    /* ---- Real-time progress bar with live ETA ----
       Discovery is one request (no server-side progress events), so the bar eases
       toward 95% over an ETA estimated from the cap, then snaps to 100% on completion.
       Honest about being an estimate; the phase labels track the real pipeline steps. */
    var prog = { timer: null, start: 0, etaMs: 0 };
    function fmtSecs(ms) { var s = Math.max(0, Math.round(ms / 1000)); return s >= 60 ? (Math.floor(s / 60) + "m " + (s % 60) + "s") : (s + "s"); }
    function progTick() {
      var host = $("#jdProgress"); if (!host || !prog.timer) return;
      var fill = host.querySelector(".jd-prog-fill"), pct = host.querySelector(".jd-prog-pct"),
        phase = host.querySelector("#jdProgPhase"), eta = host.querySelector("#jdProgEta");
      var elapsed = Date.now() - prog.start;
      var shown = Math.min(0.95, 1 - Math.exp(-elapsed / (prog.etaMs * 0.6)));
      var p = Math.round(shown * 100);
      if (fill) fill.style.width = p + "%"; if (pct) pct.textContent = p + "%";
      if (phase && !host.dataset.staticPhase) phase.textContent = shown < 0.45 ? "Searching LinkedIn profiles…" : shown < 0.85 ? "Scoring & ranking candidates…" : "Almost done…";
      if (eta) eta.textContent = "~" + fmtSecs(Math.max(0, prog.etaMs - elapsed)) + " left · " + fmtSecs(elapsed) + " elapsed";
    }
    function showProgress(title, etaSec, phaseText) {
      var host = $("#jdProgress"); if (!host) return;
      host.classList.remove("done"); host.style.display = "";
      if (phaseText) host.dataset.staticPhase = "1"; else delete host.dataset.staticPhase;
      host.innerHTML =
        '<div class="jd-prog-head"><span class="jd-prog-dot"></span><b id="jdProgTitle">' + esc(title) + '</b>' +
          '<span class="jd-prog-pct">0%</span></div>' +
        '<div class="jd-prog-track"><div class="jd-prog-fill" style="width:0%"></div></div>' +
        '<div class="jd-prog-meta muted"><span id="jdProgPhase">' + esc(phaseText || "Starting…") + '</span><span id="jdProgEta"></span></div>';
      prog.start = Date.now(); prog.etaMs = Math.max(4, etaSec || 20) * 1000;
      if (prog.timer) clearInterval(prog.timer);
      prog.timer = setInterval(progTick, 200); progTick();
    }
    function setProgTitle(t) { var el = $("#jdProgTitle"); if (el) el.textContent = t; }
    function finishProgress(label) {
      if (prog.timer) { clearInterval(prog.timer); prog.timer = null; }
      var host = $("#jdProgress"); if (!host) return;
      host.classList.add("done");
      var fill = host.querySelector(".jd-prog-fill"), pct = host.querySelector(".jd-prog-pct"),
        phase = host.querySelector("#jdProgPhase"), eta = host.querySelector("#jdProgEta");
      if (fill) fill.style.width = "100%"; if (pct) pct.textContent = "100%";
      if (phase) phase.textContent = label || "Done"; if (eta) eta.textContent = "";
      setTimeout(function () { var h = $("#jdProgress"); if (h && !prog.timer) h.style.display = "none"; }, 1600);
    }
    function hideProgress() { if (prog.timer) { clearInterval(prog.timer); prog.timer = null; } var h = $("#jdProgress"); if (h) { h.style.display = "none"; h.innerHTML = ""; } }
    /** ETA seconds for a discovery run, estimated from the candidate cap. */
    function findEta(cap) { return Math.min(150, Math.max(8, Math.round((cap || 500) * 0.02))); }

    /* ---- Queue: run JD searches back-to-back, each saved + CSV-ready ---- */
    function renderQueue() {
      var card = $("#jdQueueCard"); if (!card) return;
      card.style.display = state.queue.length ? "" : "none";
      var cnt = $("#jdQueueCount"); if (cnt) cnt.textContent = state.queue.length ? ("· " + state.queue.length + " pending") : "";
      var list = $("#jdQueueList"); if (!list) return;
      list.innerHTML = state.queue.map(function (item, idx) {
        return '<div class="jd-run"><div><b>' + esc(item.name) + '</b> <span class="muted">· ' + esc(item.jd.slice(0, 90).replace(/\s+/g, " ")) + '…</span></div>' +
          '<div class="jd-run-actions"><button class="btn btn-ghost btn-sm" data-qrm="' + idx + '">Remove</button></div></div>';
      }).join("");
    }
    function addToQueue() {
      var name = $("#jdName").value.trim(), jd = $("#jdText").value.trim();
      if (!jd) { msg("Paste a job description to queue it."); return; }
      if (!name) name = "Sourcing list " + (state.queue.length + 1);
      state.queue.push({ name: name, jd: jd });
      $("#jdName").value = ""; $("#jdText").value = "";
      state.jd = ""; state.icp = null; state.queries = []; state.candidates = []; state.warnings = [];
      $("#jdFind").disabled = true; $("#jdSave").disabled = true; renderPlan(); renderResults(); renderSteps();
      msg("Added to queue (" + state.queue.length + "). Add more, then ▶ Run queue."); renderQueue();
    }
    function runQueue() {
      if (state.running) return;
      if (!state.queue.length) { msg("Queue is empty. Add a JD with the Add to queue button."); return; }
      var cap = parseInt($("#jdCap").value, 10) || 500;
      var minFit = parseInt($("#jdMinFit").value, 10); if (isNaN(minFit)) minFit = 10;
      state.running = true;
      var runBtn = $("#jdQueueRun"); if (runBtn) runBtn.disabled = true;
      var progEl = $("#jdQueueProg");
      var total = state.queue.length, done = 0, failed = 0;
      function finish() {
        state.running = false; if (runBtn) runBtn.disabled = false;
        if (progEl) progEl.textContent = "Done. Saved " + done + (failed ? (", " + failed + " failed") : "") + ". Download CSVs below.";
        finishProgress("Queue complete. Saved " + done + (failed ? (", " + failed + " failed") : ""));
        renderQueue(); loadRuns();
      }
      function next() {
        if (!state.queue.length) return finish();
        var item = state.queue[0];
        var idx = done + failed + 1;
        if (progEl) progEl.textContent = "Processing " + idx + "/" + total + ": " + item.name + " …";
        showProgress("Queue " + idx + "/" + total + ": " + item.name, findEta(cap));
        send("/sourcing", "POST", { action: "run", jd: item.jd, cap: cap, minFit: minFit, freshOnly: !!($("#jdFresh") && $("#jdFresh").checked) }).then(function (r) {
          if (!r.ok || !r.data) { failed++; state.queue.shift(); renderQueue(); return next(); }
          var cands = r.data.candidates || [];
          return send("/sourcing", "POST", { action: "save", name: item.name, jd: item.jd, icp: r.data.icp, queries: r.data.queries, candidates: cands, warnings: r.data.warnings }).then(function (s) {
            if (s.ok) done++; else failed++;
            state.queue.shift(); renderQueue(); next();
          });
        }).catch(function () { failed++; state.queue.shift(); renderQueue(); next(); });
      }
      next();
    }

    $("#jdAnalyze").addEventListener("click", function () {
      var jd = $("#jdText").value.trim(); if (!jd) { msg("Paste a job description first."); return; }
      state.location = jdLocLabel();
      state.jd = jd; msg("Analyzing…");
      send("/sourcing", "POST", { action: "plan", jd: jdWithLoc(jd) }).then(function (r) {
        if (!r.ok) { msg("Analyze failed: " + ((r.data && r.data.error) || r.status)); return; }
        state.icp = r.data.icp; state.queries = r.data.queries || []; state.note = r.data.note || ""; state.refineNote = "";
        $("#jdFind").disabled = false; msg(""); renderPlan(); renderSteps(); updateRunCost();
      });
    });

    $("#jdFind").addEventListener("click", function () {
      if (!state.jd) { msg("Analyze a JD first."); return; }
      var cap = parseInt($("#jdCap").value, 10) || 500;
      var minFit = parseInt($("#jdMinFit").value, 10); if (isNaN(minFit)) minFit = 10;
      var fresh = !!($("#jdFresh") && $("#jdFresh").checked);
      msg("");
      $("#jdFind").disabled = true;
      showProgress("Finding candidates", findEta(cap));
      send("/sourcing", "POST", { action: "run", jd: jdWithLoc(state.jd), cap: cap, minFit: minFit, freshOnly: fresh }).then(function (r) {
        $("#jdFind").disabled = false;
        if (!r.ok) { finishProgress("Search failed"); msg("Find failed: " + ((r.data && r.data.error) || r.status)); return; }
        state.icp = r.data.icp || state.icp; state.queries = r.data.queries || state.queries;
        state.candidates = r.data.candidates || []; state.warnings = r.data.warnings || [];
        $("#jdSave").disabled = !state.candidates.length;
        finishProgress("Found " + state.candidates.length + " candidates");
        msg("Found " + state.candidates.length + " candidates (scanned " + (r.data.scanned || 0) + ").");
        renderPlan(); renderResults(); renderSteps(); updateRunCost();
      });
    });

    $("#jdSave").addEventListener("click", function () {
      var name = $("#jdName").value.trim(); if (!name) { msg("Give the list a name to save it."); $("#jdName").focus(); return; }
      if (!state.icp) { msg("Analyze a JD first."); return; }
      msg("Saving…");
      send("/sourcing", "POST", { action: "save", name: name, jd: state.jd, location: state.location || jdLocLabel(), icp: state.icp, queries: state.queries, candidates: state.candidates, warnings: state.warnings }).then(function (r) {
        if (!r.ok) { msg("Save failed: " + ((r.data && r.data.error) || r.status)); return; }
        msg('Saved "' + name + '" to JD Sourcing. Review it below, then send to Candidates.'); loadRuns();
      });
    });

    $("#jdRuns").addEventListener("click", function (e) {
      var t = e.target; if (t.tagName !== "BUTTON") return;
      var id;
      if ((id = t.getAttribute("data-csv"))) { downloadRun(id); return; }
      if ((id = t.getAttribute("data-promote"))) {
        var prun = (state.runs || []).find(function (r) { return r.id === id; });
        var defName = (prun && prun.name) || "";
        var btn = t;
        openModal("Send to Candidates", "Choose the list these candidates land in. Add a tag to pull them back later by tag.",
          '<label class="fld"><span>Candidate list name</span>' +
            '<input id="promoteList" type="text" value="' + esc(defName) + '" placeholder="e.g. VP Operations — Alegria" /></label>' +
          '<label class="fld"><span>Tag <span class="muted">(optional, defaults to the list name)</span></span>' +
            '<input id="promoteTag" type="text" placeholder="e.g. q3-leadership" /></label>' +
          '<div class="modal-foot"><button class="btn btn-primary" id="promoteGo">Send to Candidates →</button></div>',
          function (card, close) {
            var nameEl = card.querySelector("#promoteList");
            if (nameEl) nameEl.focus();
            card.querySelector("#promoteGo").addEventListener("click", function () {
              var listName = (nameEl && nameEl.value.trim()) || defName;
              if (!listName) { nameEl.focus(); return; }
              var tag = (card.querySelector("#promoteTag").value || "").trim();
              close();
              btn.disabled = true; btn.textContent = "Sending…";
              send("/sourcing", "POST", { action: "promote", id: id, listName: listName, tag: tag }).then(function (r) {
                if (!r.ok) { btn.disabled = false; btn.textContent = "Send to Candidates →"; alert("Promote failed: " + ((r.data && r.data.error) || r.status)); return; }
                alert('Sent ' + r.data.added + ' to Candidates as "' + r.data.name + '"' + (tag ? (' · tag "' + tag + '"') : '') + (r.data.deduped ? (' (' + r.data.deduped + ' already in pipeline)') : '') + '.'); loadRuns();
              });
            });
          });
      } else if ((id = t.getAttribute("data-rerank"))) {
        var rrid = id;
        t.disabled = true; t.textContent = "Re-ranking…";
        send("/sourcing", "POST", { action: "rerank", id: rrid, top: 100 }).then(function (r) {
          t.disabled = false; t.textContent = "✨ Re-rank";
          if (!r.ok) { alert("Re-rank failed: " + ((r.data && r.data.error) || r.status)); return; }
          var w = r.data.warning ? ("\n\n" + r.data.warning) : "";
          alert("Re-ranked the top " + (r.data.ranked || 0) + " by AI relevance — the list is re-sorted with the strongest matches on top." + w);
          loadRuns();
        });
      } else if ((id = t.getAttribute("data-vet"))) {
        var topEl = $("#jdVetTop"); var top = topEl ? (parseInt(topEl.value, 10) || 25) : 25;
        var vid = id;
        var pendingCacheHits = 0; // profile lookups served from cache at submit time
        t.disabled = true; t.textContent = "Vetting top " + top + "…";
        showProgress("Deep-vetting top " + top, top * 3, "Reading work histories & scoring against the JD…");
        // Final alert + reset, shared by the batch and synchronous paths.
        function vetDone(d) {
          t.disabled = false; t.textContent = "🔬 Deep-vet";
          finishProgress("Deep-vetted " + (d.vetted || 0));
          var warn = (d.warnings || []).length ? ("\n\n" + d.warnings.slice(0, 3).join("\n")) : "";
          var cacheNote = (d.profileCacheHits ? " " + d.profileCacheHits + " profile(s) reused from cache (no charge)." : "");
          alert("Deep-vetted " + (d.vetted || 0) + " candidate" + ((d.vetted === 1) ? "" : "s") +
            (d.deep ? " against full work history." : " on surface fields only. Add the deep-vet profile endpoint in Setup to read full work history.") +
            cacheNote +
            " Ranked by verified score; download the Excel for the verdicts." +
            (d.batched ? " (Ran as a 50%-cheaper batch.)" : "") + warn);
          loadRuns();
        }
        // Poll the in-flight batch every 10s until it ends, then ingest + finish.
        function pollVet(batched) {
          send("/sourcing", "POST", { action: "vetStatus", id: vid }).then(function (s) {
            if (!s.ok) { t.disabled = false; t.textContent = "🔬 Deep-vet"; finishProgress("Deep-vet failed"); alert("Deep-vet status check failed: " + ((s.data && s.data.error) || s.status)); return; }
            if (!s.data.done) {
              var c = s.data.counts || {}; var got = (c.succeeded || 0) + (c.errored || 0);
              showProgress("Deep-vetting (batch)", top * 3, got ? (got + " of " + top + " scored…") : "Batch queued — scoring in the background…");
              setTimeout(function () { pollVet(batched); }, 10000); return;
            }
            vetDone({ vetted: s.data.vetted, deep: s.data.deep, warnings: s.data.warnings, profileCacheHits: pendingCacheHits, batched: true });
          });
        }
        send("/sourcing", "POST", { action: "vet", id: vid, top: top }).then(function (r) {
          if (!r.ok) { t.disabled = false; t.textContent = "🔬 Deep-vet"; finishProgress("Deep-vet failed"); alert("Deep-vet failed: " + ((r.data && r.data.error) || r.status)); return; }
          if (r.data.batched) {
            pendingCacheHits = r.data.profileCacheHits || 0;
            showProgress("Deep-vetting (batch)", top * 3, "Batch submitted — scoring " + (r.data.submitted || top) + " in the background…");
            setTimeout(function () { pollVet(true); }, 8000);
          } else {
            vetDone({ vetted: r.data.vetted, deep: r.data.deep, warnings: r.data.warnings, profileCacheHits: r.data.profileCacheHits || 0, batched: false });
          }
        });
      } else if ((id = t.getAttribute("data-laxis"))) {
        // First-pass enrichment via the Laxis browser worker. Async (a headless browser
        // job), so it mirrors deep-vet: submit, then poll laxisStatus until done. Big lists
        // go in 1,000-row chunks; we AUTO-CONTINUE to the next chunk (the backend resumes by
        // offset and never re-grabs a chunk already pulled), so the whole pull is hands-off
        // and safe to re-run if the tab is closed mid-way.
        var lid = id;
        var lxT = { emails: 0, phones: 0, matched: 0, gap: 0, chunks: 0, skipped: 0, warns: [] };
        t.disabled = true; t.textContent = "Laxis: starting…";
        function laxisReset() { t.disabled = false; t.textContent = "🧬 Enrich via Laxis"; }
        function finishLaxis() {
          laxisReset();
          alert("Laxis enriched " + lxT.emails + " email" + (lxT.emails === 1 ? "" : "s") +
            " and " + lxT.phones + " phone" + (lxT.phones === 1 ? "" : "s") +
            " across " + lxT.matched + " matched contact" + (lxT.matched === 1 ? "" : "s") +
            (lxT.chunks > 1 ? (" over " + lxT.chunks + " batches") : "") + "." +
            (lxT.gap ? (" The in-house waterfall then filled " + lxT.gap + " more.") : "") +
            (lxT.skipped ? ("\n\n" + lxT.skipped + " row(s) were skipped — no LinkedIn URL or email for Laxis to key off.") : "") +
            (lxT.warns.length ? ("\n\n" + lxT.warns.slice(0, 3).join("\n")) : ""));
          loadRuns();
        }
        function pollLaxis() {
          send("/sourcing", "POST", { action: "laxisStatus", id: lid }).then(function (s) {
            if (!s.ok) { laxisReset(); alert("Laxis status check failed: " + ((s.data && s.data.error) || s.status)); return; }
            if (!s.data.done) {
              t.textContent = "Laxis: " + (s.data.stage || s.data.status || "working") + "…";
              setTimeout(pollLaxis, 10000); return;
            }
            if (s.data.status === "error") {
              laxisReset();
              alert("Laxis enrichment failed:\n" + ((s.data.warnings || []).join("\n") || "unknown error") +
                "\n\nIf this mentions a selector (CALIBRATE), the Laxis UI changed and the worker needs re-calibrating." +
                "\n\nAlready-enriched batches are saved — click Enrich via Laxis again to resume from where it stopped."); loadRuns(); return;
            }
            var lx = s.data.laxis || {}; var gf = s.data.gapFill || {};
            lxT.emails += lx.emails || 0; lxT.phones += lx.phones || 0; lxT.matched += lx.matched || 0; lxT.gap += gf.enriched || 0;
            (s.data.warnings || []).forEach(function (w) { lxT.warns.push(w); });
            // More chunks left? Auto-continue — the backend skips done offsets, never re-grabs.
            if (s.data.nextStart != null) { startChunk(s.data.nextStart); return; }
            finishLaxis();
          });
        }
        function startChunk(startOffset) {
          var body = { action: "laxisEnrich", id: lid };
          if (startOffset != null) body.start = startOffset;
          t.textContent = "Laxis: starting" + (lxT.chunks ? (" batch " + (lxT.chunks + 1)) : "") + "…";
          send("/sourcing", "POST", body).then(function (r) {
            if (!r.ok) {
              laxisReset();
              var err = (r.data && r.data.error) || r.status;
              if (err === "laxis_worker_not_configured") {
                alert("Laxis isn't connected yet.\n\nOn the server, set LAXIS_EMAIL and LAXIS_PASSWORD in .env.production (the laxis-worker logs into Laxis with them), confirm LAXIS_WORKER_URL is set on the app, then redeploy."); return;
              }
              alert("Laxis enrich failed: " + err + ((r.data && r.data.detail) ? ("\n" + r.data.detail) : "")); return;
            }
            // Chunk already enriched (resume landed on a done offset) → skip ahead or finish.
            if (r.data.alreadyDone) {
              if (r.data.nextStart != null) { startChunk(r.data.nextStart); } else { finishLaxis(); }
              return;
            }
            lxT.chunks++; lxT.skipped += r.data.skipped || 0;
            t.textContent = "Laxis: uploading " + (r.data.sent || "") + "…";
            setTimeout(pollLaxis, 8000);
          });
        }
        startChunk(null); // null → backend resumes from the first un-enriched chunk (or 0 fresh)
      } else if ((id = t.getAttribute("data-enrich"))) {
        var grp = t.closest(".jd-run");
        var nEl = grp ? grp.querySelector(".jd-enrichn") : null;
        var topN = nEl ? Math.max(1, parseInt(nEl.value, 10) || 25) : 25;
        t.disabled = true; t.textContent = "Enriching " + topN + "…";
        send("/sourcing", "POST", { action: "enrich", id: id, top: topN }).then(function (r) {
          t.disabled = false; t.textContent = "Enrich";
          if (!r.ok) { alert("Enrich failed: " + ((r.data && r.data.error) || r.status)); return; }
          var hits = r.data.cacheHits || 0;
          alert("Enriched " + r.data.enriched + " contacts" +
            (hits ? " (" + hits + " reused from cache — no charge)" : "") +
            ". They are ready to push into a campaign whenever you want."); loadRuns();
        });
      } else if ((id = t.getAttribute("data-del"))) {
        if (!confirm("Delete this saved list?")) return;
        send("/sourcing", "POST", { action: "delete", id: id }).then(loadRuns);
      }
    });

    $("#jdQueueAdd").addEventListener("click", addToQueue);
    $("#jdQueueRun").addEventListener("click", runQueue);
    $("#jdQueueClear").addEventListener("click", function () { if (state.running) { msg("Queue is running. Let it finish."); return; } state.queue = []; renderQueue(); });
    $("#jdQueueList").addEventListener("click", function (e) {
      var t = e.target; if (t.tagName !== "BUTTON") return;
      var i = t.getAttribute("data-qrm");
      if (i != null) { state.queue.splice(parseInt(i, 10), 1); renderQueue(); }
    });
    var vetTopEl = $("#jdVetTop"); if (vetTopEl) vetTopEl.addEventListener("input", updateVetCost);
    var capEl2 = $("#jdCap"); if (capEl2) capEl2.addEventListener("input", updateRunCost);
    var planHost = $("#jdPlan");
    if (planHost) {
      planHost.addEventListener("click", function (e) { if (e.target && e.target.id === "jdRefineBtn") doRefine(); });
      planHost.addEventListener("keydown", function (e) { if (e.target && e.target.id === "jdRefineInput" && (e.key === "Enter" || e.keyCode === 13)) { e.preventDefault(); doRefine(); } });
    }
    var jdbBtn = $("#jdbBtn"); if (jdbBtn) jdbBtn.addEventListener("click", doBuildJd);
    ["#jdbTitle", "#jdbCompany", "#jdbNotes"].forEach(function (sel) {
      var e = $(sel); if (e) e.addEventListener("keydown", function (ev) { if (ev.key === "Enter" || ev.keyCode === 13) { ev.preventDefault(); doBuildJd(); } });
    });
    var jdTextEl = $("#jdText"); if (jdTextEl) jdTextEl.addEventListener("input", renderSteps);
    updateVetCost();
    renderSteps();
    loadRuns();
  }

  /* ---------------- OS Text (taltxt), single sign-on embed ----------------
     OS Text loads right inside the Command Center panel (the sidebar stays), so
     it populates in the tab like every other view. The iframe loads the portal's
     /api/ostext/enter endpoint, which (server-side, session-gated) signs you into
     taltxt and lands you straight in the app, no second login. The same app is
     also available full-screen at /text.

     Local dev: set window.RECRUITEROS_OSTEXT_URL to a taltxt URL to embed it
     directly (bypassing the SSO endpoint). */
  var OSTEXT_SRC = (typeof window !== "undefined" && window.RECRUITEROS_OSTEXT_URL) || "/api/ostext/enter";

  function ostextFrame(src) {
    return '<div class="card" style="padding:0;overflow:hidden">' +
      '<iframe src="' + esc(src) + '" title="OS Text" ' +
      'style="width:100%;height:calc(100vh - 160px);min-height:620px;border:0;border-radius:12px;background:var(--bg)" ' +
      'allow="clipboard-read; clipboard-write; microphone"></iframe>' +
      "</div>";
  }

  // OS Text is gated behind a one-time setup so a recruiting company can stand up
  // compliant business texting (10DLC brand + number + consent) before sending.
  // Once launched, the taltxt engine embeds as before. If the setup endpoint isn't
  // present (e.g. the real backend hasn't shipped it), we fall back to embedding
  // the engine directly so OS Text is never blocked in production.
  function renderOstext(el) {
    el.innerHTML = head("OS Text", "Stand up compliant business texting for your recruiters, register your number, set consent rules, then send right inside your workspace.") +
      '<div id="osxBody">' + loading() + "</div>";
    api("/ostext/setup").then(function (d) {
      var st = osxNormalize((d && d.ostext) || {});
      var host = $("#osxBody"); if (!host) return;
      if (osxReady(st)) renderOstextEngine(host, st);
      else renderOstextWizard(host, st);
    }).catch(function () {
      // No setup backend → don't block; embed the engine as before.
      var host = $("#osxBody"); if (host) host.innerHTML = ostextFrame(OSTEXT_SRC);
    });
  }

  function osxNormalize(st) {
    st = st || {};
    st.business = st.business || {};
    st.brand = st.brand || { status: "not_started" };
    st.number = st.number || { value: "" };
    st.consent = st.consent || { optOut: "STOP", quietStart: "08:00", quietEnd: "21:00" };
    st.candidatesConnected = !!st.candidatesConnected;
    st.launched = !!st.launched;
    return st;
  }
  function osxStates(st) {
    var b = st.business || {};
    return {
      business: (b.legalName && b.ein && b.address) ? "ready" : "action",
      brand: st.brand.status === "approved" ? "ready" : st.brand.status === "pending" ? "progress" : "action",
      number: st.number.value ? "ready" : "action",
      consent: st.consent.optIn ? "ready" : "action",
      candidates: st.candidatesConnected ? "ready" : "action"
    };
  }
  function osxAllReady(st) {
    var s = osxStates(st);
    return s.business === "ready" && s.brand === "ready" && s.number === "ready" && s.consent === "ready" && s.candidates === "ready";
  }
  function osxReady(st) { return osxAllReady(st) && st.launched; }

  function osxSave(patch, msg) {
    send("/ostext/setup", "POST", patch).then(function (r) {
      if (r && r.ok) { if (msg) toast(msg); renderOstext($("#view")); }
      else toast("Could not save, try again.");
    }).catch(function () { toast("Could not reach the server."); });
  }

  function osxStyles() {
    return '<style>' +
      '.osx-form{margin-top:11px;display:grid;gap:11px;max-width:640px}' +
      '.osx-fld{display:grid;gap:6px}' +
      '.osx-fld>span{font-size:12.5px;color:var(--text-muted);font-weight:600}' +
      '.osx-fld input,.osx-fld textarea{width:100%;background:var(--surface-2);border:1px solid var(--border);border-radius:9px;color:var(--text);padding:9px 11px;font:inherit;font-size:14px}' +
      '.osx-fld textarea{min-height:62px;resize:vertical;line-height:1.45}' +
      '.osx-fld input:focus,.osx-fld textarea:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px rgba(124,92,255,.18)}' +
      '.osx-two{display:grid;grid-template-columns:1fr 1fr;gap:11px}' +
      '.osx-launch{margin-top:18px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}' +
      '.osx-num{font-family:var(--mono,monospace);font-weight:700}' +
      '</style>';
  }

  function renderOstextEngine(host, st) {
    host.innerHTML = osxStyles() +
      '<div class="setup-banner ok" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
        '✓ OS Text is live on <span class="osx-num">' + esc(st.number.value || "your number") + '</span>' +
        '<button class="btn btn-ghost btn-sm" id="osxSettings" style="margin-left:auto">⚙ Settings</button></div>' +
      ostextFrame(OSTEXT_SRC);
    var sb = host.querySelector("#osxSettings");
    if (sb) sb.addEventListener("click", function () { osxSave({ launched: false }); });
  }

  function renderOstextWizard(host, st) {
    var s = osxStates(st), ready = osxAllReady(st);
    var doneN = ["business", "brand", "number", "consent", "candidates"].filter(function (k) { return s[k] === "ready"; }).length;
    function osxFld(label, id, value, ph) { return '<label class="osx-fld"><span>' + esc(label) + '</span><input id="' + id + '" value="' + esc(value || "") + '" placeholder="' + esc(ph || "") + '" autocomplete="off"/></label>'; }
    function osxArea(label, id, value) { return '<label class="osx-fld"><span>' + esc(label) + '</span><textarea id="' + id + '">' + esc(value || "") + '</textarea></label>'; }
    function pill(state) { var m = { ready: "Ready", progress: "In review", action: "To do" }; return '<span class="s-pill ' + (state === "progress" ? "progress" : state === "ready" ? "ready" : "action") + '">' + (m[state] || state) + '</span>'; }
    function card(n, key, title, desc, formHtml) {
      var state = s[key];
      return '<div class="setup-step s-' + state + '"><div class="setup-num">' + (state === "ready" ? "✓" : n) + '</div>' +
        '<div class="setup-main"><div class="setup-row"><span class="setup-title">' + esc(title) + '</span>' + pill(state) + '</div>' +
        '<div class="setup-desc">' + esc(desc) + '</div>' + formHtml + '</div></div>';
    }

    var b = st.business;
    var businessForm = '<div class="osx-form">' +
      osxFld("Legal business name", "osxLegal", b.legalName, "Acme Talent LLC") +
      '<div class="osx-two">' + osxFld("EIN / Tax ID", "osxEin", b.ein, "12-3456789") + osxFld("Website", "osxWeb", b.website, "https://acme.com") + '</div>' +
      osxFld("Business address", "osxAddr", b.address, "123 Main St, Austin, TX") +
      osxFld("Support email", "osxEmail", b.supportEmail, "help@acme.com") +
      '<div><button class="btn btn-primary btn-sm" data-osx="business">Save business profile</button></div></div>';

    var br = st.brand, brandForm;
    if (br.status === "approved") {
      brandForm = '<div class="osx-form"><div class="setup-metric">✓ Brand &amp; campaign approved by the carriers, you can send A2P traffic.</div></div>';
    } else if (br.status === "pending") {
      brandForm = '<div class="osx-form"><div class="setup-metric">Submitted, carriers typically review A2P 10DLC in 1-3 business days.</div>' +
        '<div><button class="btn btn-ghost btn-sm" data-osx="brand-approve">Mark approved (demo)</button></div></div>';
    } else {
      brandForm = '<div class="osx-form">' +
        osxArea("Use case", "osxUse", br.useCase || "Recruiting outreach to candidates who opted in to be contacted about roles.") +
        osxArea("Sample message", "osxSample", br.sample || "Hi {{first_name}}, it's {{recruiter}} at {{company}} about the {{role}} role. Open to a quick chat? Reply STOP to opt out.") +
        '<div><button class="btn btn-primary btn-sm" data-osx="brand-submit">Submit for carrier registration</button></div></div>';
    }

    var numForm = st.number.value
      ? '<div class="osx-form"><div class="setup-metric">Your texting number: <span class="osx-num">' + esc(st.number.value) + '</span></div>' +
        '<div><button class="btn btn-ghost btn-sm" data-osx="number-release">Release &amp; choose another</button></div></div>'
      : '<div class="osx-form">' + osxFld("Preferred area code", "osxArea", "", "512") +
        '<div><button class="btn btn-primary btn-sm" data-osx="number">Provision a 10DLC number</button></div></div>';

    var c = st.consent;
    var consentForm = '<div class="osx-form">' +
      osxArea("Opt-in / consent language", "osxOptIn", c.optIn || "By providing your number you agree to receive recruiting texts from {{company}}. Msg & data rates may apply. Reply STOP to opt out, HELP for help.") +
      '<div class="osx-two">' + osxFld("Opt-out keyword", "osxOptOut", c.optOut || "STOP", "STOP") +
        '<label class="osx-fld"><span>Quiet hours (local)</span><div class="osx-two"><input id="osxQs" type="time" value="' + esc(c.quietStart || "08:00") + '"/><input id="osxQe" type="time" value="' + esc(c.quietEnd || "21:00") + '"/></div></label></div>' +
      '<div><button class="btn btn-primary btn-sm" data-osx="consent">Save consent rules</button></div></div>';

    var candForm = st.candidatesConnected
      ? '<div class="osx-form"><div class="setup-metric">✓ OS Text is reading from your Candidates pipeline.</div></div>'
      : '<div class="osx-form"><div class="setup-metric">Let OS Text pull names &amp; numbers from your Candidates so you can text them directly.</div>' +
        '<div><button class="btn btn-primary btn-sm" data-osx="candidates">Connect to Candidates</button></div></div>';

    var banner = ready
      ? '<div class="setup-banner ok">✓ All five steps complete, switch OS Text on to start texting candidates.</div>'
      : '<div class="setup-banner warn">' + doneN + ' of 5 steps complete. Finish the steps below to turn on OS Text for your team.</div>';
    var launch = '<div class="osx-launch"><button class="btn btn-primary" data-osx="launch"' + (ready ? "" : " disabled") + '>🚀 Turn on OS Text</button>' +
      (ready ? '' : '<span class="muted" style="font-size:13px">Finish all five steps to enable.</span>') + '</div>';

    host.innerHTML = osxStyles() + setupStyles() + banner +
      '<div class="setup-steps">' +
        card(1, "business", "Your business profile", "Carriers require your business details to register you for A2P 10DLC texting.", businessForm) +
        card(2, "brand", "Register your texting brand (A2P 10DLC)", "Submit your brand + campaign so US carriers approve your recruiting texts.", brandForm) +
        card(3, "number", "Get a texting number", "Provision a 10DLC-registered number to send and receive texts.", numForm) +
        card(4, "consent", "Consent & compliance", "Set the opt-in language, opt-out keyword and quiet hours every text must honor.", consentForm) +
        card(5, "candidates", "Connect your candidates", "Point OS Text at your Candidates pipeline so you can text them in a click.", candForm) +
      '</div>' + launch;

    function val(id) { var e = document.getElementById(id); return e ? (e.value || "").trim() : ""; }
    host.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-osx]"); if (!btn) return;
      var act = btn.getAttribute("data-osx");
      if (act === "business") {
        var legalName = val("osxLegal"), ein = val("osxEin");
        if (!legalName || !ein) { toast("Add at least the legal name and EIN."); return; }
        osxSave({ business: { legalName: legalName, ein: ein, website: val("osxWeb"), address: val("osxAddr"), supportEmail: val("osxEmail") } }, "Business profile saved");
      } else if (act === "brand-submit") {
        osxSave({ brand: { status: "pending", useCase: val("osxUse"), sample: val("osxSample") } }, "Submitted for carrier registration");
      } else if (act === "brand-approve") {
        osxSave({ brand: { status: "approved" } }, "Brand approved");
      } else if (act === "number") {
        var area = (val("osxArea") || "512").replace(/\D/g, "").slice(0, 3) || "512";
        var num = "+1 (" + area + ") 555-0" + ("00" + (parseInt(area, 10) % 1000)).slice(-3);
        osxSave({ number: { value: num } }, "Number provisioned");
      } else if (act === "number-release") {
        osxSave({ number: { value: "" } });
      } else if (act === "consent") {
        var optIn = val("osxOptIn"); if (!optIn) { toast("Add your opt-in language."); return; }
        osxSave({ consent: { optIn: optIn, optOut: val("osxOptOut") || "STOP", quietStart: val("osxQs") || "08:00", quietEnd: val("osxQe") || "21:00" } }, "Consent rules saved");
      } else if (act === "candidates") {
        osxSave({ candidatesConnected: true }, "Connected to Candidates");
      } else if (act === "launch") {
        if (!osxAllReady(st)) { toast("Finish all five steps first."); return; }
        osxSave({ launched: true }, "OS Text is live");
      }
    });
  }

  /* ---------------- Voice Drops ----------------
     Compliant landline/VoIP voicemail outreach. Premium AMD detects the voicemail
     and drops a cloned-voice message with the first name + role spliced in. Mobiles
     are filtered out and never dialed; each lead is dialed only inside its own local
     window (default 7-9 PM). Three tabs: Campaigns, Voice & Consent, Test. Talks to
     /api/voice/*. Shared by BD + Recruiting (the active motion tags the campaign). */
  var VD_DEFAULT_SCRIPT =
    "Hi {first_name}... this is {agent_name}, with {agent_company}. I came across your {role} search, and wanted to reach out. We help teams hire faster. If it’s useful, give me a call back, at this number. Thanks {first_name}.";
  var VD_CONSENT_TEXT =
    "I consent to the creation and use of a synthetic copy of my voice for outreach that I authorize.";
  /* Shown under the script box so anyone writing a custom script formats it for
     natural cloned-voice delivery (same pause structure as the default). */
  var VD_PAUSE_GUIDE =
    '<div style="margin-top:10px;padding:10px 12px;border:1px solid #2a2440;border-radius:8px;background:#171327;font-size:12px;line-height:1.55">' +
      '<div style="color:#b9a6ff;font-weight:600;margin-bottom:6px">🗣️ Format custom scripts the same way</div>' +
      '<div class="muted" style="margin-bottom:8px">The voice reads your punctuation literally. Pacing comes from how you write it, so match this structure:</div>' +
      '<ul style="margin:0 0 8px 18px;padding:0">' +
        '<li><b style="color:#e6e1f5">...</b> &nbsp;= one short beat (a held pause). Drop it after the greeting and before the ask.</li>' +
        '<li>One thought per <b style="color:#e6e1f5">sentence</b>. End each with a period so it lands, then breathes.</li>' +
        '<li>Use <b style="color:#e6e1f5">commas</b> for tiny breaths, including around their name (Hi {first_name}...) and before the phone-number line.</li>' +
        '<li>Keep sentences <b style="color:#e6e1f5">short</b>. No dashes, no numerals (write "two", not "2"), keep contractions ("it\'s", "we\'ll").</li>' +
      "</ul>" +
      '<div class="muted" style="margin-bottom:3px">Reads like this:</div>' +
      '<div style="font-style:italic;color:#cdc6e6;background:#0f0c1c;border-radius:6px;padding:7px 9px">' +
        'Hi {first_name}<b style="color:#7c5cff">...</b> this is {agent_name}<b style="color:#7c5cff">,</b> with {agent_company}<b style="color:#7c5cff">.</b> ' +
        'I came across your {role} search<b style="color:#7c5cff">,</b> and wanted to reach out<b style="color:#7c5cff">.</b> ' +
        'We help teams hire faster<b style="color:#7c5cff">.</b> If it’s useful<b style="color:#7c5cff">,</b> give me a call back<b style="color:#7c5cff">,</b> at this number<b style="color:#7c5cff">.</b> Thanks {first_name}<b style="color:#7c5cff">.</b>' +
      "</div>" +
    "</div>";

  function renderVoiceDrops(el) {
    var vd = { tab: "campaigns", creating: false, scripts: [], prefill: null };
    el.innerHTML = head("Voice Drops",
      "Cloned-voice voicemail to verified business landlines. Mobiles are filtered out and never dialed; each lead is dialed only inside its own local window (default 7-9 PM).") +
      '<div class="vd-summary" style="margin:0 0 14px;padding:12px 14px;border-radius:12px;background:rgba(255,255,255,.04);font-size:12.5px;line-height:1.55">' +
      '<b style="font-size:13px">How it works</b>' +
      '<div class="muted" style="margin-top:6px">' +
      'Your script is just an <b>example</b>. Pick your engine: <b>Placeholders</b> merge first name &amp; role into one shared script (cheapest, the voice is synthesized once, reused free), or <b>AI-customize</b> lets the LLM rewrite each lead’s drop. Either way it follows the same rules:' +
      '</div>' +
      '<div class="muted" style="margin-top:6px">' +
      '• <b>Length</b>, 15-25s for AMD voicemail, 20-45s for LinkedIn voice notes.<br>' +
      '• <b>After-hours</b>, sent 7-9 PM in each lead’s OWN local time, clamped to a lawful 8 AM-9 PM envelope.<br>' +
      '• <b>Landline/VoIP only</b>, every number is line-checked; mobiles are stripped and never dialed.<br>' +
      '• <b>Honest + natural</b>, always states your real name &amp; firm, formatted for natural speech, never invents referrals or claims.<br>' +
      '• <b>Estimated spend</b>, the campaign builder shows live cost for both models before you launch.' +
      '</div></div>' +
      '<div class="vd-tabs" style="display:flex;flex-wrap:wrap"></div>' +
      '<div id="vdBody">' + loading() + "</div>";

    function tabBar() {
      var tabs = [["campaigns", "📞 Campaigns"], ["scripts", "📝 Scripts"], ["voice", "🎙️ Voice"], ["test", "🧪 Test"]];
      $(".vd-tabs", el).innerHTML = tabs.map(function (t) {
        return '<button class="vd-tab' + (vd.tab === t[0] ? " active" : "") + '" data-vdtab="' + t[0] + '">' + t[1] + "</button>";
      }).join("");
    }
    $(".vd-tabs", el).addEventListener("click", function (e) {
      var b = e.target.closest("[data-vdtab]"); if (!b) return;
      vd.tab = b.getAttribute("data-vdtab"); tabBar(); paint();
    });

    function paint() {
      var body = $("#vdBody"); if (!body) return;
      if (vd.tab === "campaigns") return paintCampaigns(body);
      if (vd.tab === "scripts") return paintScripts(body);
      if (vd.tab === "voice") return paintVoice(body);
      return paintTest(body);
    }

    /* ---- shared bits ---- */
    function fieldChips(targetId) {
      return ["first_name", "role", "company", "agent_name", "agent_company"].map(function (f) {
        return '<button type="button" class="btn btn-sm" data-chip="' + f + '" data-target="' + targetId + '">{' + f + "}</button>";
      }).join(" ");
    }
    function wireChips(scope) {
      Array.prototype.forEach.call(scope.querySelectorAll("[data-chip]"), function (b) {
        b.addEventListener("click", function () {
          var ta = $("#" + b.getAttribute("data-target")); if (!ta) return;
          var ins = "{" + b.getAttribute("data-chip") + "}";
          var s = ta.selectionStart || ta.value.length;
          ta.value = ta.value.slice(0, s) + ins + ta.value.slice(ta.selectionEnd || s);
          ta.focus();
        });
      });
    }
    function statRow(stats) {
      stats = stats || {};
      var order = [["voicemail_delivered", "VM dropped", "#34d399"], ["dialing", "Dialing", "#ffc24d"],
        ["scheduled", "Scheduled", "#8aa0c6"], ["queued", "Queued", "#8aa0c6"],
        ["human_answered", "Human", "#b9a6ff"], ["no_answer", "No answer", "#8aa0c6"],
        ["filtered_mobile", "Mobiles filtered", "#ff7a90"], ["suppressed", "Suppressed", "#ff7a90"]];
      var shown = order.filter(function (o) { return (stats[o[0]] || 0) > 0; });
      if (!shown.length) return '<div class="muted" style="font-size:12px;margin-top:8px">No activity yet.</div>';
      return '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px">' + shown.map(function (o) {
        return '<span style="font-size:13px"><b style="color:' + o[2] + '">' + (stats[o[0]] || 0) + "</b> <span class='muted'>" + o[1] + "</span></span>";
      }).join("") + "</div>";
    }

    /* Listen to the assembled voicemail in-browser before launching. Fetches the
       saved/cached audio clips for a script+voice and plays them in sequence. */
    function previewInto(mount, payload) {
      if (!mount) return;
      mount.innerHTML = loading();
      send("/voice/preview", "POST", payload).then(function (r) {
        if (!r.ok) { mount.innerHTML = '<span class="muted">Preview failed.</span>'; return; }
        var d = r.data || {};
        if (d.dryRun || !((d.playlist || []).length)) {
          mount.innerHTML = '<span class="muted">Connect a voice provider and add a voice id to hear it, currently dry-run (no audio).</span>';
          return;
        }
        var urls = d.playlist;
        var secs = Math.max(1, Math.round((String(d.rendered || "").split(/\s+/).filter(Boolean).length) / 2.5));
        var label = d.clips + ' clips · ~' + secs + 's';
        mount.innerHTML = '<button class="btn btn-sm btn-primary" id="pvPlay">▶ Play voicemail</button> ' +
          '<button class="btn btn-sm btn-ghost" id="pvDl">⬇ Download</button> ' +
          '<span class="muted" id="pvStat">' + label + '</span>';
        var btn = mount.querySelector("#pvPlay"), stat = mount.querySelector("#pvStat");
        var dl = mount.querySelector("#pvDl");
        var au = null, i = 0, playing = false;
        function stop() { if (au) { try { au.pause(); } catch (e) {} } playing = false; if (btn) btn.textContent = "▶ Play voicemail"; if (stat) stat.textContent = label; }
        function step() {
          if (!playing || i >= urls.length) { stop(); return; }
          au = new Audio(urls[i]);
          if (stat) stat.textContent = "playing " + (i + 1) + "/" + urls.length;
          au.onended = function () { i++; step(); };
          au.onerror = function () { if (stat) stat.textContent = "audio error"; stop(); };
          au.play().catch(function () { if (stat) stat.textContent = "tap Play to allow audio"; stop(); });
        }
        btn.addEventListener("click", function () {
          if (playing) { stop(); return; }
          playing = true; i = 0; btn.textContent = "■ Stop"; step();
        });
        // Save the assembled voicemail as one MP3. The clips are same-origin,
        // same-encoder segments, so concatenating the bytes yields a single
        // playable file. If a fetch is blocked we fall back to opening the clips.
        if (dl) dl.addEventListener("click", function () {
          if (dl.disabled) return;
          stop();
          var orig = dl.textContent; dl.disabled = true; dl.textContent = "downloading…";
          Promise.all(urls.map(function (u) {
            return fetch(u).then(function (r) { if (!r.ok) throw new Error("http"); return r.blob(); });
          })).then(function (blobs) {
            var one = new Blob(blobs, { type: (blobs[0] && blobs[0].type) || "audio/mpeg" });
            var href = URL.createObjectURL(one);
            var a = document.createElement("a");
            a.href = href; a.download = "voicemail-" + urls.length + "clips.mp3";
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(function () { URL.revokeObjectURL(href); }, 2000);
            dl.disabled = false; dl.textContent = orig;
          }).catch(function () {
            dl.disabled = false; dl.textContent = orig;
            if (stat) stat.textContent = "couldn't bundle, opening clips…";
            urls.forEach(function (u) { window.open(u, "_blank"); });
          });
        });
      }).catch(function () { mount.innerHTML = '<span class="muted">Could not reach the server.</span>'; });
    }

    /* Ask the backend LLM to customize the script in a textarea, following the
       channel window (AMD 15-25s) + the speech/compliance rules, then drop the
       result back into the box. Seeded by whatever's already typed. */
    function aiCustomizeInto(taId, outId, opts) {
      opts = opts || {};
      var ta = $("#" + taId); if (!ta) return;
      var out = outId ? $("#" + outId) : null;
      var seed = (ta.value || "").trim();
      if (out) out.textContent = "✨ customizing…";
      send("/voice/draft", "POST", {
        channel: opts.channel || "amd",
        templated: opts.templated !== false,
        seed: seed,
        persona: opts.persona,
        firstName: opts.firstName, role: opts.role, company: opts.company,
      }).then(function (r) {
        if (!r.ok || !r.data) { if (out) out.textContent = "AI customize failed."; return; }
        var d = r.data;
        if (d.dryRun || !d.text) {
          if (out) out.innerHTML = '<span class="muted">' + esc((d.warnings && d.warnings[0]) || "Connect an Anthropic API key to use AI customize.") + "</span>";
          if (d.text) ta.value = d.text;
          if (typeof renderEstimate === "function") renderEstimate();
          return;
        }
        ta.value = d.text;
        if (out) out.innerHTML = '<span class="muted">✨ AI · ~' + d.seconds + "s" +
          (d.withinWindow ? ", in window" : ", outside window") + (d.identifies ? "" : " · ⚠ add your name/firm") + "</span>";
        if (typeof renderEstimate === "function") renderEstimate();
      }).catch(function () { if (out) out.textContent = "Could not reach the server."; });
    }

    /* ---- Scripts tab: a saved library of reusable voicemail scripts ----
       The database of cloned-voice voicemails. Save as many as you like, listen to
       any one BEFORE deploying, then pick one when you build a campaign. Talks to
       /api/voice/scripts (shared with the Campaign Sequences Library) so the same
       scripts show in both the admin and recruiter portals. */
    function loadScripts(cb) {
      api("/voice/scripts?motion=" + motion).then(function (d) {
        vd.scripts = (d && d.scripts) || [];
        if (cb) cb();
      }).catch(function () { vd.scripts = vd.scripts || []; if (cb) cb(); });
    }
    function scriptPickerOptions() {
      var opts = '<option value="">- start from scratch, or pick a saved script -</option>';
      (vd.scripts || []).forEach(function (s) {
        opts += '<option value="' + esc(s.id) + '">' + esc(s.name) + " (~" + (s.estSeconds || 0) + "s)</option>";
      });
      return opts;
    }
    function scriptPerfBadge(p) {
      // "Learn from responses" signal: how this script actually performs once dialed.
      if (!p || !p.dialed) return '<span class="muted" style="font-size:12px">· no drops yet</span>';
      var pct = Math.round((p.connectRate || 0) * 100);
      var col = pct >= 35 ? "#34d399" : pct >= 15 ? "#ffc24d" : "#9aa4b2";
      return '<span style="font-size:12px;color:' + col + '">· ' + pct + "% connect (" +
        (p.voicemail_delivered || 0) + " VM / " + (p.human_answered || 0) + " live, " + p.dialed + " dialed)</span>";
    }
    function scriptCard(s) {
      var dot = s.withinSweetSpot ? "#34d399" : "#ffc24d";
      var len = "~" + (s.estSeconds || 0) + "s" + (s.withinSweetSpot ? " · in the 15-25s sweet spot" : " · outside the 15-25s sweet spot");
      return '<div class="card" data-sid="' + esc(s.id) + '" style="margin-top:12px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px">' +
        "<h3 style='margin:0'>" + esc(s.name) + ' <span class="muted" style="font-size:12px">· ' + esc(s.motion || motion) + "</span></h3>" +
        '<span style="font-size:12px;color:' + dot + '">' + esc(len) + "</span></div>" +
        '<div style="margin:4px 0 2px">' + scriptPerfBadge(s.performance) + "</div>" +
        '<div class="muted" style="font-size:13px;margin:8px 0">“' + esc(s.preview || s.template || "") + '”</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
        '<button class="btn btn-sm btn-primary" data-sact="use" data-sid="' + esc(s.id) + '">Use in a campaign</button>' +
        '<button class="btn btn-ghost btn-sm" data-sact="listen" data-sid="' + esc(s.id) + '">🔊 Listen first</button>' +
        '<button class="btn btn-ghost btn-sm" data-sact="edit" data-sid="' + esc(s.id) + '">✎ Edit</button>' +
        '<span style="flex:1"></span>' +
        '<button class="btn btn-ghost btn-sm" data-sact="del" data-sid="' + esc(s.id) + '">🗑</button></div>' +
        '<div class="muted" data-spv="' + esc(s.id) + '" style="font-size:12px;margin-top:8px"></div></div>';
    }
    function paintScripts(body) {
      body.innerHTML = loading();
      loadScripts(function () {
        var rows = vd.scripts || [];
        var toolbar = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
          '<span class="muted" style="font-size:13px">' + rows.length + " saved script" + (rows.length === 1 ? "" : "s") +
          " · listen to any one before you deploy it, then pick it when you build a campaign</span>" +
          '<button class="btn btn-primary btn-sm" id="vsbNew">＋ New script</button></div>';
        if (!rows.length) {
          body.innerHTML = toolbar + '<div class="card"><p class="muted" style="font-size:13px">No saved scripts yet. ' +
            "Build a library of reusable cloned-voice voicemails here, first name &amp; role splice in like an email merge, " +
            "then pick one when you create a campaign. Sweet spot is 15-25s.</p></div>";
        } else {
          body.innerHTML = toolbar + rows.map(scriptCard).join("");
        }
        var nb = $("#vsbNew", body); if (nb) nb.addEventListener("click", function () { scriptEditor(null); });
        Array.prototype.forEach.call(body.querySelectorAll("[data-sact]"), function (b) {
          b.addEventListener("click", function () {
            var act = b.getAttribute("data-sact"), id = b.getAttribute("data-sid");
            var s = (vd.scripts || []).filter(function (x) { return x.id === id; })[0];
            if (act === "del") {
              if (!confirm("Delete this script from your library?")) return;
              send("/voice/scripts?id=" + encodeURIComponent(id), "DELETE").then(function () { toast("Deleted"); paintScripts(body); });
              return;
            }
            if (!s) return;
            if (act === "listen") { previewInto($('[data-spv="' + id + '"]'), { scriptTemplate: s.template }); return; }
            if (act === "edit") { scriptEditor(s); return; }
            if (act === "use") {
              vd.prefill = { name: s.name, template: s.template };
              vd.creating = true; vd.tab = "campaigns"; tabBar(); paint();
              return;
            }
          });
        });
      });
    }
    /* Create/edit one saved script, with a Listen button so the operator hears the
       cloned voicemail BEFORE saving or deploying it. */
    function scriptEditor(s) {
      var isEdit = !!s;
      openModal(isEdit ? "Edit voice script" : "New voice script",
        "First name & role splice in like an email merge. Sweet spot is 15-25s, listen before you save.",
        '<input id="seName" placeholder="Script name (e.g. Q3 VP Sales, warm)" style="width:100%" value="' + esc(isEdit ? s.name : "") + '"/>' +
        '<div style="margin:8px 0">' + fieldChips("seTpl") + "</div>" +
        '<textarea id="seTpl" rows="5" style="width:100%">' + esc(isEdit ? s.template : VD_DEFAULT_SCRIPT) + "</textarea>" +
        VD_PAUSE_GUIDE +
        '<div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
        '<button class="btn btn-sm" id="seAi">✨ AI customize</button>' +
        '<button class="btn btn-sm" id="seListen">🔊 Listen</button><span class="muted" id="seListenOut" style="font-size:12px"></span></div>' +
        // Place a REAL cloned-voice call to a landline/VoIP you control, straight from
        // this modal, so you can hear the drop on an actual phone before saving. Same
        // path as the Test tab (/voice/test-drop): skips the time window, every other
        // safeguard stays on, and your own number is exempt from the mobile filter.
        '<div style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.07)">' +
        '<label style="display:block;font-size:12px;color:#8aa0c6;margin-bottom:4px">Test it on a real phone <span style="color:#6b7a99">- landline or VoIP number you control (E.164)</span></label>' +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
        '<input id="seTestTo" type="tel" placeholder="+13105551234" style="flex:1;min-width:180px" />' +
        '<button class="btn btn-sm" id="seTestCall">📞 Test call</button></div>' +
        '<div class="muted" id="seTestOut" style="font-size:12px;margin-top:6px"></div></div>' +
        '<div class="modal-foot" style="margin-top:10px"><button class="btn btn-primary btn-sm" id="seSave">Save script</button></div>',
        function (root, close) {
          wireChips(root);
          $("#seAi", root).addEventListener("click", function () {
            aiCustomizeInto("seTpl", "seListenOut", { templated: true });
          });
          $("#seListen", root).addEventListener("click", function () {
            var tpl = ($("#seTpl", root).value || "").trim();
            if (!tpl) { toast("Write a script first"); return; }
            previewInto($("#seListenOut", root), { scriptTemplate: tpl });
          });
          $("#seTestCall", root).addEventListener("click", function () {
            var tpl = ($("#seTpl", root).value || "").trim();
            var to = ($("#seTestTo", root).value || "").trim();
            if (!tpl) { toast("Write a script first"); return; }
            if (!to) { toast("Enter a landline/VoIP number to test"); return; }
            var out = $("#seTestOut", root); if (out) out.innerHTML = loading();
            send("/voice/test-drop", "POST", { to: to, scriptTemplate: tpl, motion: motion }).then(function (r) {
              if (!out) return;
              if (!r.ok) { out.innerHTML = '<span style="color:#ff7a90">Test failed: ' + esc((r.data && r.data.detail) || (r.data && r.data.error) || r.status) + "</span>"; return; }
              var d = r.data || {};
              out.innerHTML = '<b style="color:#34d399">Rendered (~' + d.estSeconds + "s" +
                (d.withinSweetSpot ? ", in the 15-25s sweet spot" : ", outside sweet spot") + "):</b> “" + esc(d.rendered || "") + "” · " +
                (d.dialError ? '<span style="color:#ff7a90">dial failed (' + esc(d.dialError) + ")</span>" : d.dryRun ? "dry-run (no Telnyx/clone keys, nothing dialed)" : "dialing " + esc(d.callControlId || "")) +
                ((d.warnings && d.warnings.length) ? ' · <span style="color:#ffc24d">⚠ ' + d.warnings.map(esc).join(" · ") + "</span>" : "");
            }).catch(function () { if (out) out.innerHTML = '<span style="color:#ff7a90">Could not reach the server.</span>'; });
          });
          $("#seSave", root).addEventListener("click", function () {
            var name = ($("#seName", root).value || "").trim();
            var tpl = ($("#seTpl", root).value || "").trim();
            if (!name || !tpl) { toast("Name + script required"); return; }
            var payload = { name: name, template: tpl, motion: motion };
            if (isEdit) payload.id = s.id;
            send("/voice/scripts", "PUT", payload).then(function (r) {
              close();
              if (r.ok) { toast("Saved"); if (vd.tab === "scripts") paintScripts($("#vdBody")); }
              else toast("Save failed");
            });
          });
        });
    }

    /* ---- Campaigns tab ---- */
    function newCampaignForm() {
      return '<div class="vd-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
        inp("vdName", "Campaign name", "Q3 VP Sales, landlines") +
        '<div class="vd-field" id="vdCallerField"><label>Approved 10DLC caller-ID (E.164)</label>' +
        '<input id="vdCaller" type="text" placeholder="+13105551234" /></div>' +
        inp("vdAgentName", "Your name (stated on the call)", "Ryan") +
        inp("vdAgentCompany", "Your firm (stated on the call)", "Executive Search") +
        hourSelect("vdWinStart", "Send window, start (local time)", 19) +
        hourSelect("vdWinEnd", "Send window, end (local time)", 21) +
        inp("vdDailyCap", "Daily cap", "100", "number") +
        inp("vdFreq", "Min days between attempts", "30", "number") +
        "</div>" +
        '<div class="vd-note"><span class="vd-note-ico">🌙</span><span>Drops land after hours, in each lead’s <b>own local time</b> (default 7–9 PM), so the line rolls to voicemail. Always clamped to a lawful 8 AM–9 PM envelope.</span></div>' +
        '<div class="vd-section-label">Delivery &amp; safeguards</div>' +
        '<div class="vd-toggles">' +
        vdToggle("vdTestMode", "Test mode", "Ignore the calling window. Testing only — every other safeguard stays on.") +
        vdToggle("vdAiCustomize", "AI-customize per lead", "The AI rewrites each drop from your script below, kept to 15–25s and the speech rules. More natural, but each lead synthesizes fresh (a little more spend).") +
        vdToggle("vdAutoPilot", "Always-on autopilot", "Keep this campaign running and auto-send to leads as they’re fed in (email-sent trigger or import). Turns on AI-customize so every incoming lead gets a fresh, in-window drop. Consent + all safeguards still required.") +
        "</div>" +
        '<div class="vd-section-label" style="margin-top:20px">Voicemail script</div>' +
        '<div class="vd-field vd-script" style="margin-top:0"><label>Start from a saved script <span>— pick one from your library, or write your own below</span></label>' +
        '<select id="vdScriptPick" style="width:100%">' + scriptPickerOptions() + "</select></div>" +
        '<div class="vd-field vd-script"><label>Your script <span>— an example; the AI customizes the rest. First name &amp; role splice in like an email merge</span></label>' +
        '<div class="vd-chips">' + fieldChips("vdScript") + "</div>" +
        '<textarea id="vdScript" rows="4">' + esc(VD_DEFAULT_SCRIPT) + "</textarea>" +
        '<div class="vd-hint">Sweet spot is 15–25s. Human-answer sign-off: “' + esc("Sorry, wrong number. Thanks.") + '” (editable per campaign).</div></div>' +
        '<div class="vd-actions" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn btn-primary btn-sm" id="vdCreate">Create campaign</button>' +
        '<button class="btn btn-sm" id="vdAi">✨ AI customize</button>' +
        '<button class="btn btn-sm" id="vdListen">🔊 Listen first</button>' +
        '<span class="muted" id="vdListenOut" style="font-size:12px"></span></div>' +
        '<div id="vdEst" class="vd-est" style="margin-top:12px"></div>';
    }
    function inp(id, label, ph, type) {
      return '<div class="vd-field"><label>' + esc(label) + "</label>" +
        '<input id="' + id + '" type="' + (type || "text") + '" placeholder="' + esc(ph) + '" /></div>';
    }
    /* A clean option card: title + description with an iOS-style toggle. The
       checkbox keeps its original id so all existing wiring reads it unchanged. */
    function vdToggle(id, title, desc) {
      return '<label class="vd-toggle" for="' + id + '">' +
        '<input type="checkbox" id="' + id + '" class="vd-toggle-cb" />' +
        '<span class="vd-toggle-sw" aria-hidden="true"></span>' +
        '<span class="vd-toggle-txt"><b>' + esc(title) + "</b><span>" + esc(desc) + "</span></span>" +
        "</label>";
    }
    /* AM/PM hour picker (cleaner than military time). Option values stay 0-23 so
       the backend window math is unchanged; labels read "7:00 PM". */
    function hourSelect(id, label, def) {
      var opts = "";
      for (var h = 0; h < 24; h++) opts += '<option value="' + h + '"' + (h === def ? " selected" : "") + ">" + esc(hrClock(h)) + "</option>";
      return '<div class="vd-field"><label>' + esc(label) + "</label><select id=\"" + id + "\">" + opts + "</select></div>";
    }
    function hrClock(h) { var n = ((h + 11) % 12) + 1; return n + ":00 " + (h < 12 ? "AM" : "PM"); }
    /* Real per-drop spend, straight from the cost catalog (lib/billing/rates.ts):
       Telnyx voice minute incl. Premium AMD ($0.007/min), the landline/VoIP line
       check ($0.0025/number), and — only when AI-customize is on — a fresh LLM
       script ($0.004/lead) plus fresh cloned-voice synthesis ($0.02/sentence).
       The cloned voice itself is a ONE-TIME setup (part of the TTS plan): in
       placeholder mode the whole script is synthesized once and reused free, so
       per-drop voice cost is ~$0. Premium AMD never lands every dial; ~2 of 3 roll
       to voicemail, so a toggle re-bases the number onto drops that actually land. */
    var VD_RATE = { voiceMinute: 0.007, synthPerSentence: 0.02, lineCheck: 0.0025, aiDraft: 0.004, callOverheadSec: 20 };
    var VD_LAND_RATE = 0.65;   // share of dialed calls that actually drop a voicemail (Premium AMD, in-window)
    var vdLandedView = false;  // headline toggle: false = every drop sent, true = per voicemail that lands
    function estimateScriptShape(text) {
      var words = String(text || "").split(/\s+/).filter(Boolean).length;
      var sentences = (String(text || "").match(/[^.!?]+[.!?]+/g) || []).length || (words ? 1 : 0);
      var seconds = Math.max(1, Math.round(words / 2.5));
      return { words: words, sentences: sentences, seconds: seconds };
    }
    function usd(n) { return "$" + (n < 1 ? (n === 0 ? "0.00" : n.toFixed(3).replace(/0+$/, "").replace(/\.$/, ".00")) : n.toFixed(2)); }
    /* One clean cost split, no jargon:
        · one-time — the cloned voice is set up once. In placeholder mode the whole
          script is synthesized once here and reused free for every lead.
        · per drop — the Telnyx call minute + line check on every dial, plus, in
          AI-customize mode, a fresh LLM script and fresh synthesis per lead. */
    function computeCost(cap, sentences, minutes, ai) {
      var callMin = minutes * VD_RATE.voiceMinute;
      var perDrop = callMin + VD_RATE.lineCheck + (ai ? sentences * VD_RATE.synthPerSentence + VD_RATE.aiDraft : 0);
      var oneTime = ai ? 0 : sentences * VD_RATE.synthPerSentence; // placeholders: synth once, reuse free
      return { perDrop: perDrop, oneTime: oneTime, running: cap * perDrop, total: oneTime + cap * perDrop, callMin: callMin };
    }
    function renderEstimate() {
      var box = $("#vdEst"); if (!box) return;
      var cap = Math.max(0, parseInt(val("vdDailyCap") || "0", 10) || 0);
      var ai = !!(($("#vdAiCustomize") || {}).checked);
      var shape = estimateScriptShape(val("vdScript"));
      var minutes = Math.max(1, Math.ceil((shape.seconds + VD_RATE.callOverheadSec) / 60));
      var c = computeCost(cap, shape.sentences, minutes, ai);
      var landed = Math.round(cap * VD_LAND_RATE);

      // The big number flips between "all drops sent" and "per voicemail that lands".
      var bigNum, bigCap;
      if (vdLandedView) {
        bigNum = usd(landed > 0 ? c.total / landed : 0);
        bigCap = "per voicemail that lands · about " + landed + " of " + cap + " land · " + usd(c.total) + " total";
      } else {
        bigNum = usd(c.total);
        bigCap = "to send " + cap + " drop" + (cap === 1 ? "" : "s") +
          (cap > 0 ? " · about " + usd(c.perDrop) + " each" : "");
      }

      var toggle =
        '<label style="display:inline-flex;align-items:center;gap:7px;font-size:12px;cursor:pointer;margin-top:9px;color:#8aa0c6">' +
        '<input type="checkbox" id="vdLandedToggle"' + (vdLandedView ? " checked" : "") + ' style="cursor:pointer"> ' +
        'Show cost per voicemail that lands <span style="opacity:.7">(~2 of 3 dials roll to voicemail)</span></label>';

      var lines =
        '<div class="muted" style="font-size:11.5px;margin-top:9px;line-height:1.6">' +
        '• One-time: cloned voice setup + first synthesis <b>' + usd(c.oneTime) + '</b> (then reused free)<br>' +
        '• Every drop: ' + minutes + ' min Telnyx call <b>' + usd(c.callMin) + '</b> + line check <b>' + usd(VD_RATE.lineCheck) + '</b>' +
        (ai ? '<br>• AI-customize adds, per lead: fresh script <b>' + usd(VD_RATE.aiDraft) + '</b> + fresh voice <b>' + usd(shape.sentences * VD_RATE.synthPerSentence) + '</b>' : '') +
        '</div>';

      box.innerHTML =
        '<div style="padding:13px 15px;border-radius:12px;background:rgba(52,211,153,.07);box-shadow:inset 0 0 0 1px rgba(52,211,153,.35)">' +
        '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">' +
        '<span style="font-size:27px;font-weight:800;color:#34d399;line-height:1">~' + bigNum + '</span>' +
        '<span class="muted" style="font-size:12.5px">' + bigCap + '</span></div>' +
        toggle + lines + '</div>';

      var lt = $("#vdLandedToggle");
      if (lt) lt.addEventListener("change", function () { vdLandedView = lt.checked; renderEstimate(); });
    }
    function campaignCard(c) {
      var win = "7-9 PM"; try { win = hr(c.window.startHour) + "-" + hr(c.window.endHour); } catch (e) {}
      var ready = c.consentAttested;
      var testOn = !!c.testMode;
      var testBadge = testOn ? ' <span style="font-size:11px;font-weight:700;color:#0b0b0b;background:#ffc24d;border-radius:4px;padding:1px 6px">⚠ TEST MODE, window ignored</span>' : "";
      var autoBadge = c.autoPilot ? ' <span style="font-size:11px;font-weight:700;color:#0b0b0b;background:#34d399;border-radius:4px;padding:1px 6px">♾ AUTOPILOT</span>' : "";
      var aiBadge = c.aiCustomize ? ' <span style="font-size:11px;font-weight:700;color:#cdd6ea;background:#2a2440;border-radius:4px;padding:1px 6px">✨ AI</span>' : "";
      // Show the actual voicemail wording on the card, with its length vs. the
      // 15-25s sweet spot and inline Edit / Listen, so the card explains itself.
      var shape = estimateScriptShape(c.scriptTemplate || "");
      var inSweet = shape.seconds >= 15 && shape.seconds <= 25;
      var lenDot = inSweet ? "#34d399" : "#ffc24d";
      var snip = String(c.scriptTemplate || "").replace(/\s+/g, " ").trim();
      var snipShort = snip.slice(0, 150) + (snip.length > 150 ? "…" : "");
      return '<div class="card" data-cid="' + c.id + '" style="margin-top:12px' + (testOn ? ";box-shadow:inset 0 0 0 1px #ffc24d" : "") + '">' +
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
        "<h3 style='margin:0'>" + esc(c.name) + ' <span class="muted" style="font-size:12px">· ' + esc(c.status) + "</span>" + autoBadge + aiBadge + testBadge + "</h3>" +
        '<span class="muted" style="font-size:12px">caller ' + esc(c.callerId || "-") + " · window " + esc(win) + " local · " + esc(c.motion) + "</span></div>" +
        statRow(c.stats) +
        // The script, front and centre: what it says + how long + edit/listen.
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin-top:12px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.03)">' +
        '<div class="muted" style="font-size:12.5px;line-height:1.55;flex:1">“' + (snipShort ? esc(snipShort) : "No script yet.") + '”' +
        '<div style="font-size:11px;color:' + lenDot + ';margin-top:5px">~' + shape.seconds + "s · " + (inSweet ? "in the 15-25s sweet spot" : "outside the 15-25s sweet spot") + "</div></div>" +
        '<div style="display:flex;gap:6px;white-space:nowrap">' +
        '<button class="btn btn-sm" data-vdact="editscript" data-cid="' + c.id + '">✎ Edit script</button>' +
        '<button class="btn btn-ghost btn-sm" data-vdact="preview" data-cid="' + c.id + '">🔊 Listen</button></div></div>' +
        // Lifecycle actions on the left; test toggle + remove on the right.
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:center">' +
        '<button class="btn btn-sm btn-primary" data-vdact="launch" data-cid="' + c.id + '">▶ Launch</button>' +
        '<button class="btn btn-sm" data-vdact="run" data-cid="' + c.id + '">⏱ Run now</button>' +
        '<button class="btn btn-sm" data-vdact="import" data-cid="' + c.id + '">⬆ Import</button>' +
        '<span style="flex:1"></span>' +
        '<button class="btn btn-ghost btn-sm" data-vdact="testmode" data-cid="' + c.id + '" data-test="' + (testOn ? "1" : "0") + '">' + (testOn ? "🟡 Test: on" : "Test: off") + "</button>" +
        '<button class="btn btn-ghost btn-sm" data-vdact="del" data-cid="' + c.id + '">🗑</button></div>' +
        '<div class="vd-msg muted" data-msg="' + c.id + '" style="font-size:12px;margin-top:8px"></div></div>';
    }
    function hr(h) { var n = ((h + 11) % 12) + 1; return n + (h < 12 ? " AM" : " PM"); }

    function paintCampaigns(body) {
      body.innerHTML = loading();
      // Load the saved-script library first so the create form's picker is populated.
      loadScripts(function () {
      api("/voice/campaigns?motion=" + motion).then(function (d) {
        var camps = (d && d.campaigns) || [];
        vd.camps = camps; // so the card's "Edit script" action can read the current template/persona
        var showForm = vd.creating || camps.length === 0;
        var toolbar = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
          '<span class="muted" style="font-size:13px">' + camps.length + " voice campaign" + (camps.length === 1 ? "" : "s") + "</span>" +
          (showForm ? "" : '<button class="btn btn-primary btn-sm" id="vdNew">＋ New campaign</button>') + "</div>";
        var form = showForm
          ? '<div class="card"><h3>New voice campaign</h3>' + newCampaignForm() +
            (camps.length ? '<div style="margin-top:8px"><button class="btn btn-ghost btn-sm" id="vdCancel">Cancel</button></div>' : "") + "</div>"
          : "";
        body.innerHTML = toolbar + form + camps.map(campaignCard).join("") +
          '<div class="muted" style="margin-top:14px;padding:10px;border-radius:8px;background:rgba(255,255,255,.03);font-size:12px">' +
          'Only landline/VoIP leads are dialed (mobiles stripped on import). Each lead is dialed inside its local window (default 7-9 PM). Launch requires a consent attestation and an identifying script.</div>';
        wireChips(body);
        var nb = $("#vdNew"); if (nb) nb.addEventListener("click", function () { vd.creating = true; paint(); });
        var cb = $("#vdCancel"); if (cb) cb.addEventListener("click", function () { vd.creating = false; paint(); });
        var cr = $("#vdCreate"); if (cr) cr.addEventListener("click", createCampaign);
        // Saved-script picker → drop the chosen template into the script box.
        var pick = $("#vdScriptPick");
        if (pick) pick.addEventListener("change", function () {
          var s = (vd.scripts || []).filter(function (x) { return x.id === pick.value; })[0];
          if (!s) return;
          var ta = $("#vdScript"); if (ta) ta.value = s.template;
          var nm = $("#vdName"); if (nm && !nm.value.trim()) nm.value = s.name + ", campaign";
          // Remember which library script was chosen so the campaign's drops are
          // attributed to it (per-script performance). Cleared the moment the
          // operator edits the text away from the named script, below.
          vd.pickedScript = { id: s.id, template: s.template };
          renderEstimate();
        });
        // Listen to the assembled cloned voicemail before creating/launching.
        var lb = $("#vdListen");
        if (lb) lb.addEventListener("click", function () {
          var tpl = val("vdScript"); if (!tpl) { toast("Write or pick a script first"); return; }
          previewInto($("#vdListenOut"), {
            scriptTemplate: tpl,
            persona: { agentName: val("vdAgentName") || "Ryan", agentCompany: val("vdAgentCompany") || "Executive Search" },
          });
        });
        // AI-customize the script in place (preview the LLM rewrite before saving).
        var aib = $("#vdAi");
        if (aib) aib.addEventListener("click", function () {
          aiCustomizeInto("vdScript", "vdListenOut", { templated: true,
            persona: { agentName: val("vdAgentName") || "Ryan", agentCompany: val("vdAgentCompany") || "Executive Search" } });
        });
        // Live spend estimate, recompute as the cap, script, or model changes.
        ["vdDailyCap", "vdScript"].forEach(function (id) {
          var e = $("#" + id); if (e) e.addEventListener("input", renderEstimate);
        });
        var aic = $("#vdAiCustomize"); if (aic) aic.addEventListener("change", renderEstimate);
        // Autopilot implies AI-customize (every incoming lead gets a fresh drop).
        var apc = $("#vdAutoPilot");
        if (apc) apc.addEventListener("change", function () {
          if (apc.checked && aic) aic.checked = true;
          renderEstimate();
        });
        renderEstimate();
        // Prefill from a library "Use in a campaign" action.
        if (vd.prefill) {
          var pta = $("#vdScript"); if (pta && vd.prefill.template) pta.value = vd.prefill.template;
          var pnm = $("#vdName"); if (pnm && vd.prefill.name && !pnm.value.trim()) pnm.value = vd.prefill.name + ", campaign";
          vd.prefill = null;
        }
        // Upgrade the caller-ID text box to a dropdown of the operator's real
        // Telnyx numbers (falls back to manual entry when none / not keyed).
        if ($("#vdCallerField")) upgradeCaller();
        Array.prototype.forEach.call(body.querySelectorAll("[data-vdact]"), function (b) {
          b.addEventListener("click", function () { campaignAction(b.getAttribute("data-vdact"), b.getAttribute("data-cid")); });
        });
      }).catch(function () { body.innerHTML = needsSetup(); });
      });
    }
    function val(id) { var e = $("#" + id); return e ? e.value.trim() : ""; }
    /* Swap the caller-ID text input for a dropdown of the operator's approved
       Telnyx numbers. Keeps the same #vdCaller id so val()/createCampaign read it
       unchanged. If the account has no numbers (not keyed / dry-run / shim), the
       plain text input is left in place so a number can still be typed. The
       dropdown's "type manually" option restores the text input on demand. */
    function upgradeCaller() {
      var field = $("#vdCallerField"); if (!field) return;
      api("/voice/numbers").then(function (d) {
        var nums = (d && d.numbers) || [];
        if (!nums.length) return; // keep the manual text input
        var cur = val("vdCaller");
        var opts = nums.map(function (n) {
          return '<option value="' + esc(n.phoneNumber) + '"' + (n.phoneNumber === cur ? " selected" : "") + ">" +
            esc(n.phoneNumber) + (n.label ? " · " + esc(n.label) : "") + "</option>";
        }).join("");
        field.innerHTML = "<label>Approved 10DLC caller-ID</label>" +
          '<select id="vdCaller"><option value="">- pick a number -</option>' + opts +
          '<option value="__manual__">- type a number manually -</option></select>' +
          '<div class="vd-hint">' + nums.length + " number" + (nums.length === 1 ? "" : "s") + " on your Telnyx account.</div>";
        var sel = $("#vdCaller");
        if (sel) sel.addEventListener("change", function () {
          if (sel.value !== "__manual__") return;
          field.innerHTML = "<label>Approved 10DLC caller-ID (E.164)</label>" +
            '<input id="vdCaller" type="text" placeholder="+13105551234" />';
          var t = $("#vdCaller"); if (t) t.focus();
        });
      }).catch(function () { /* keep the manual text input */ });
    }
    function createCampaign() {
      // Attribute drops to the chosen library script only while the text is still
      // that script verbatim — once edited, the campaign owns its own copy and
      // carries no scriptId (so per-script stats stay honest).
      var picked = vd.pickedScript;
      var scriptId = (picked && val("vdScript") === String(picked.template).trim()) ? picked.id : undefined;
      var payload = {
        name: val("vdName"), motion: motion, callerId: val("vdCaller"),
        scriptTemplate: val("vdScript"), scriptId: scriptId,
        persona: { agentName: val("vdAgentName") || "Ryan", agentCompany: val("vdAgentCompany") || "Executive Search" },
        window: { startHour: parseInt(val("vdWinStart") || "19", 10), endHour: parseInt(val("vdWinEnd") || "21", 10) },
        dailyCap: parseInt(val("vdDailyCap") || "100", 10), frequencyCapDays: parseInt(val("vdFreq") || "30", 10),
        testMode: !!(($("#vdTestMode") || {}).checked),
        aiCustomize: !!(($("#vdAiCustomize") || {}).checked),
        autoPilot: !!(($("#vdAutoPilot") || {}).checked)
      };
      if (!payload.name) { toast("Name the campaign first."); return; }
      send("/voice/campaigns", "PUT", payload).then(function (r) {
        if (!r.ok) { toast("Create failed"); return; }
        toast("Campaign created"); vd.creating = false; paint();
      });
    }
    function setMsg(cid, t) { var m = $('[data-msg="' + cid + '"]'); if (m) m.innerHTML = t; }
    function campaignAction(act, cid) {
      if (act === "del") { send("/voice/campaigns?id=" + cid, "DELETE").then(function () { toast("Deleted"); paint(); }); return; }
      if (act === "editscript") return editCampaignScript(cid);
      if (act === "preview") { previewInto($('[data-msg="' + cid + '"]'), { campaignId: cid }); return; }
      if (act === "testmode") {
        var tb = $('[data-vdact="testmode"][data-cid="' + cid + '"]');
        var on = tb && tb.getAttribute("data-test") === "1";
        send("/voice/campaigns", "PUT", { id: cid, testMode: !on }).then(function (r) {
          if (r.ok) { toast(!on ? "Test mode ON, calling window ignored" : "Test mode off, back to 7-9 PM local"); paint(); }
          else { toast("Could not toggle test mode"); }
        });
        return;
      }
      if (act === "import") return importModal(cid);
      if (act === "attest") {
        send("/voice/campaigns", "POST", { action: "attest", campaignId: cid }).then(function (r) {
          if (r.ok) { toast("Consent attested"); paint(); }
        });
        return;
      }
      if (act === "launch") {
        send("/voice/campaigns", "POST", { action: "launch", campaignId: cid }).then(function (r) {
          if (r.ok) { toast("Launched"); paint(); }
          else { var errs = (r.data && r.data.errors) || ["Not ready"]; setMsg(cid, "⚠ " + errs.map(esc).join(" · ")); }
        });
        return;
      }
      if (act === "run") {
        setMsg(cid, "Running this window…");
        send("/voice/campaigns", "POST", { action: "run", campaignId: cid }).then(function (r) {
          if (!r.ok) { setMsg(cid, "Run failed"); return; }
          var s = r.data.summary || {};
          setMsg(cid, "Dialed " + s.dialed + " · scheduled " + s.scheduled + " (outside window) · skipped " + s.skipped + " · synthesized " + s.synthesized + " / cached " + s.cached + (s.dryRun ? " · dry-run (no Telnyx/clone keys)" : ""));
          paint();
        });
        return;
      }
    }
    /* Quick in-place script edit straight from a campaign card: tweak the
       voicemail wording so it sounds better, AI-customize it, listen to it, or
       ring a real landline/VoIP to hear how it lands, then save it back onto the
       campaign (partial PUT, leaves every other setting untouched). */
    function editCampaignScript(cid) {
      var c = (vd.camps || []).filter(function (x) { return x.id === cid; })[0] || {};
      var persona = c.persona || {};
      openModal("Edit voice script · " + (c.name || "campaign"),
        "Tweak the wording so it sounds better. First name & role splice in like an email merge. Sweet spot is 15-25s, listen before you save.",
        '<div style="margin:2px 0 8px">' + fieldChips("ceTpl") + "</div>" +
        '<textarea id="ceTpl" rows="5" style="width:100%">' + esc(c.scriptTemplate || VD_DEFAULT_SCRIPT) + "</textarea>" +
        '<div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
        '<button class="btn btn-sm" id="ceAi">✨ AI customize</button>' +
        '<button class="btn btn-sm" id="ceListen">🔊 Listen</button><span class="muted" id="ceListenOut" style="font-size:12px"></span></div>' +
        '<div style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.07)">' +
        '<label style="display:block;font-size:12px;color:#8aa0c6;margin-bottom:4px">Test it on a real phone <span style="color:#6b7a99">- landline or VoIP you control (E.164), let it roll to voicemail to hear the drop</span></label>' +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
        '<input id="ceTestTo" type="tel" placeholder="+13105551234" style="flex:1;min-width:180px" />' +
        '<button class="btn btn-sm" id="ceTestCall">📞 Test call</button></div>' +
        '<div class="muted" id="ceTestOut" style="font-size:12px;margin-top:6px"></div></div>' +
        '<div class="modal-foot" style="margin-top:10px"><button class="btn btn-primary btn-sm" id="ceSave">Save script</button></div>',
        function (root, close) {
          wireChips(root);
          var personaOpt = { agentName: persona.agentName || "Ryan", agentCompany: persona.agentCompany || "Executive Search" };
          $("#ceAi", root).addEventListener("click", function () {
            aiCustomizeInto("ceTpl", "ceListenOut", { templated: true, persona: personaOpt });
          });
          $("#ceListen", root).addEventListener("click", function () {
            var tpl = ($("#ceTpl", root).value || "").trim();
            if (!tpl) { toast("Write a script first"); return; }
            previewInto($("#ceListenOut", root), { scriptTemplate: tpl, persona: personaOpt });
          });
          $("#ceTestCall", root).addEventListener("click", function () {
            var tpl = ($("#ceTpl", root).value || "").trim();
            var to = ($("#ceTestTo", root).value || "").trim();
            if (!tpl) { toast("Write a script first"); return; }
            if (!to) { toast("Enter a landline/VoIP number to test"); return; }
            var out = $("#ceTestOut", root); if (out) out.innerHTML = loading();
            send("/voice/test-drop", "POST", { to: to, scriptTemplate: tpl, motion: c.motion || motion, persona: personaOpt }).then(function (r) {
              if (!out) return;
              if (!r.ok) { out.innerHTML = '<span style="color:#ff7a90">Test failed: ' + esc((r.data && r.data.detail) || (r.data && r.data.error) || r.status) + "</span>"; return; }
              var d = r.data || {};
              out.innerHTML = '<b style="color:#34d399">Rendered (~' + d.estSeconds + "s" +
                (d.withinSweetSpot ? ", in the 15-25s sweet spot" : ", outside sweet spot") + "):</b> “" + esc(d.rendered || "") + "” · " +
                (d.dialError ? '<span style="color:#ff7a90">dial failed (' + esc(d.dialError) + ")</span>" : d.dryRun ? "dry-run (no Telnyx/clone keys, nothing dialed)" : "dialing " + esc(d.callControlId || "")) +
                ((d.warnings && d.warnings.length) ? ' · <span style="color:#ffc24d">⚠ ' + d.warnings.map(esc).join(" · ") + "</span>" : "");
            }).catch(function () { if (out) out.innerHTML = '<span style="color:#ff7a90">Could not reach the server.</span>'; });
          });
          $("#ceSave", root).addEventListener("click", function () {
            var tpl = ($("#ceTpl", root).value || "").trim();
            if (!tpl) { toast("Write a script first"); return; }
            // If this campaign was attributed to a library script and the operator
            // edited the text away from it, detach the attribution ("") so per-script
            // stats only count the script as it was actually written.
            var camp = (vd.camps || []).filter(function (x) { return x.id === cid; })[0] || {};
            var lib = (vd.scripts || []).filter(function (x) { return x.id === camp.scriptId; })[0];
            var payload = { id: cid, scriptTemplate: tpl };
            if (camp.scriptId && !(lib && tpl === String(lib.template).trim())) payload.scriptId = "";
            send("/voice/campaigns", "PUT", payload).then(function (r) {
              close();
              if (r.ok) { toast("Script updated"); paint(); }
              else toast("Save failed");
            });
          });
        });
    }
    function importModal(cid) {
      openModal("Import leads", "Paste rows: first_name, role, company, phone, location (one per line, header optional). Mobiles are auto-stripped, only landline/VoIP get dialed.",
        '<textarea id="vdCsv" rows="8" style="width:100%" placeholder="Hector,VP Sales,Jaggaer,+18015551234,Salt Lake City UT"></textarea>' +
        '<div class="modal-foot" style="margin-top:10px"><button class="btn btn-primary btn-sm" id="vdImportGo">Classify &amp; import</button></div>',
        function (root, close) {
          $("#vdImportGo", root).addEventListener("click", function () {
            var leads = parseCsv($("#vdCsv", root).value);
            if (!leads.length) { toast("No rows parsed"); return; }
            send("/voice/campaigns", "POST", { action: "import", campaignId: cid, leads: leads }).then(function (r) {
              close();
              if (!r.ok) { toast("Import failed"); return; }
              var s = r.data.summary || {};
              toast("Imported " + s.imported + " · dialable " + s.dialable + " · mobiles stripped " + s.filteredMobile);
              setMsg(cid, "Imported " + s.imported + ", " + s.dialable + " dialable landline/VoIP, " + s.filteredMobile + " mobiles stripped" + (s.noTimezone ? ", " + s.noTimezone + " missing a resolvable location" : ""));
              paint();
            });
          });
        });
    }
    function parseCsv(text) {
      var lines = String(text || "").split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
      if (!lines.length) return [];
      var out = [];
      var first = lines[0].toLowerCase();
      var hasHeader = /first|phone|role|name/.test(first) && /,/.test(first);
      var start = hasHeader ? 1 : 0;
      for (var i = start; i < lines.length; i++) {
        var c = lines[i].split(",").map(function (x) { return x.trim(); });
        if (!c.length) continue;
        var phone = c[3] || c.find(function (x) { return /\+?\d{7,}/.test(x); }) || "";
        if (!phone) continue;
        out.push({ firstName: c[0] || "", role: c[1] || "", company: c[2] || "", phone: phone, location: c[4] || "" });
      }
      return out;
    }

    /* ---- Voice tab: bring-your-own ElevenLabs / Cartesia / Hume voice id ---- */
    function paintVoice(body) {
      body.innerHTML = loading();
      api("/voice/clones").then(function (d) {
        d = d || {};
        var cache = d.cache || { total: 0, byKind: {} };
        var provs = d.providers || [];
        function ok(id) { var p = provs.filter(function (x) { return x.id === id; })[0]; return !!(p && p.configured); }
        var elOk = ok("elevenlabs"), caOk = ok("cartesia"), huOk = ok("hume");
        var kinds = Object.keys(cache.byKind || {}).map(function (k) { return "<b>" + (cache.byKind[k]) + "</b> " + esc(k); }).join(" · ") || "none yet";
        var provLabel = { elevenlabs: "ElevenLabs", cartesia: "Cartesia", hume: "Hume" };
        var provOk = { elevenlabs: elOk, cartesia: caOk, hume: huOk };
        var PROV_IDS = ["elevenlabs", "cartesia", "hume"];
        // The engine + voice explicitly chosen for tests AND sends. The PROVIDER
        // is the prominent choice; the voice used is the one that resolves for it.
        var activeId = d.activeVoiceId || null;
        var consent = d.consent || [];
        var lastVoice = consent.filter(function (c) { return c.voiceId; }).slice(-1)[0] || null;
        var pinnedVoice = consent.filter(function (c) { return c.id === activeId; })[0] || null;
        var activeProvider = d.activeProvider || (pinnedVoice && pinnedVoice.provider) || (lastVoice && lastVoice.provider) || null;
        // Which saved voice actually plays for a given engine (pinned if it matches,
        // else that engine's most recent saved voice).
        function voiceForProvider(pid) {
          if (pinnedVoice && (pinnedVoice.provider || "elevenlabs") === pid) return pinnedVoice;
          return consent.filter(function (c) { return c.voiceId && (c.provider || "elevenlabs") === pid; }).slice(-1)[0] || null;
        }
        var resolvedVoice = activeProvider ? voiceForProvider(activeProvider) : (pinnedVoice || lastVoice);
        // Scoped styles for the engine picker (this tab doesn't load setupStyles).
        // Lives at the top of body.innerHTML, so exactly one copy exists per paint.
        var vdEngineCss =
          "<style>" +
          ".veng{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:2px}" +
          ".veng-tile{position:relative;border:1.5px solid var(--border);border-radius:12px;padding:12px 13px 11px;background:var(--bg-soft);cursor:pointer;text-align:left;display:flex;flex-direction:column;gap:8px;font:inherit;transition:border-color .15s,box-shadow .15s,background .15s}" +
          ".veng-tile:hover{border-color:var(--brand)}" +
          ".veng-tile.on{border-color:var(--brand);background:color-mix(in srgb,var(--brand) 9%,var(--bg-soft));box-shadow:0 0 0 1px var(--brand)}" +
          ".veng-name{font-size:13.5px;font-weight:700;color:var(--text)}" +
          ".veng-check{position:absolute;top:9px;right:11px;color:var(--brand);font-weight:800;font-size:13px;line-height:1}" +
          ".veng-stat{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--text-dim)}" +
          ".veng-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}" +
          ".veng-info{display:flex;align-items:flex-start;gap:9px;font-size:12.5px;line-height:1.5;margin-top:11px;padding:10px 12px;border-radius:10px;background:var(--bg-soft);border:1px solid var(--border)}" +
          ".veng-info .ic{flex:0 0 auto;font-size:14px;line-height:1.3}" +
          ".vrow{display:flex;align-items:center;gap:9px;padding:9px 11px;border:1px solid var(--border);border-radius:10px;background:var(--bg-soft);margin-top:8px}" +
          ".vrow.on{border-color:var(--brand);background:color-mix(in srgb,var(--brand) 7%,var(--bg-soft))}" +
          ".vrow-pill{font-size:10.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;padding:3px 9px;border-radius:999px;background:color-mix(in srgb,var(--brand) 16%,transparent);color:var(--brand);white-space:nowrap}" +
          "</style>";
        // Prominent engine picker: one selectable tile per provider, with a live
        // connection dot. Clicking sets the active engine for tests + sends.
        var engineTiles = '<div class="veng">' + PROV_IDS.map(function (pid) {
          var on = activeProvider === pid, conn = provOk[pid];
          return '<button type="button" class="veng-tile' + (on ? " on" : "") + '" data-vcprov="' + pid + '">' +
            (on ? '<span class="veng-check">✓</span>' : "") +
            '<span class="veng-name">' + esc(provLabel[pid]) + "</span>" +
            '<span class="veng-stat"><span class="veng-dot" style="background:' + (conn ? "var(--accent-green)" : "var(--text-dim)") + '"></span>' + (conn ? "Connected" : "Not connected") + "</span>" +
          "</button>";
        }).join("") + "</div>";
        var infoStrip = activeProvider
          ? '<div class="veng-info"><span class="ic">' + (provOk[activeProvider] && resolvedVoice && resolvedVoice.voiceId ? "🎙️" : "⚠️") + "</span><div>" +
              (resolvedVoice && resolvedVoice.voiceId
                ? "Using <b>" + esc(provLabel[activeProvider]) + "</b> · voice <b>" + esc(resolvedVoice.agentName) + '</b> <span class="muted">(' + esc(resolvedVoice.voiceId) + ")</span>"
                : "Engine <b>" + esc(provLabel[activeProvider]) + "</b> selected, but no voice id for it yet — add one below.") +
              (provOk[activeProvider] ? "" : '<br><span style="color:var(--accent-amber)">' + esc(provLabel[activeProvider]) + " key not connected — runs as a safe dry-run until you connect it in Setup.</span>") +
            "</div></div>"
          : '<div class="veng-info"><span class="ic">👆</span><div>No engine chosen yet — pick one above, or add a voice below and it auto-selects.</div></div>';
        var voices = consent.map(function (c) {
          var pid = c.provider || "elevenlabs";
          var isActive = resolvedVoice && c.id === resolvedVoice.id;
          var control = isActive
            ? '<span class="vrow-pill" style="margin-left:auto">✓ In use</span>'
            : '<button class="btn btn-ghost btn-sm" data-vcact="' + esc(c.id) + '" title="Use this voice (and its engine) for tests and sends" style="margin-left:auto">Use this</button>';
          return '<div class="vrow' + (isActive ? " on" : "") + '">🎙️ <b>' + esc(c.agentName) + "</b>" +
            '<span class="muted" style="font-size:12px">' + esc(provLabel[pid] || pid) + (c.voiceId ? " · " + esc(c.voiceId) : " · (no id)") + "</span>" +
            control +
            '<button class="btn btn-ghost btn-sm" data-vcdel="' + esc(c.id) + '" title="Delete this voice">🗑️</button></div>';
        }).join("") || '<p class="muted">No voices yet, add one above.</p>';
        body.innerHTML =
          vdEngineCss +
          '<div class="card" style="border-color:var(--brand-2)"><h3>🎙️ Voice engine — used for tests &amp; sends</h3>' +
          '<p class="muted" style="font-size:13px;margin:0 0 10px">Pick which provider every test drop, “Listen first” preview, and live campaign uses (unless a campaign sets its own). Choose once and it is defined.</p>' +
          engineTiles + infoStrip + "</div>" +
          '<div class="card" style="margin-top:14px"><h3>Your voices</h3>' +
          '<p class="muted" style="font-size:13px">Paste a voice id from ElevenLabs, Cartesia or Hume and you are ready — no cloning or approval here. Connect each provider\'s API key in <b>Setup → Voice</b>.</p>' +
          '<div class="vd-grid" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">' +
          '<div class="vd-field"><label>Provider</label><select id="vcProvider"><option value="elevenlabs">ElevenLabs</option><option value="cartesia">Cartesia</option><option value="hume">Hume</option></select></div>' +
          inp("vcVoiceId", "Voice ID", "paste your voice id") +
          inp("vcName", "Name (whose voice)", "Ryan") + "</div>" +
          '<p class="muted" style="font-size:12px;margin:10px 0 0">No voice id yet? Create one and copy its id from <a href="https://elevenlabs.io/app/voice-lab" target="_blank" rel="noopener" style="color:var(--brand-2)">ElevenLabs ↗</a>, <a href="https://play.cartesia.ai" target="_blank" rel="noopener" style="color:var(--brand-2)">Cartesia ↗</a> or <a href="https://platform.hume.ai" target="_blank" rel="noopener" style="color:var(--brand-2)">Hume ↗</a>.</p>' +
          '<div style="margin-top:10px"><button class="btn btn-primary btn-sm" id="vcSave">Add voice</button></div></div>' +
          '<div class="card" style="margin-top:14px"><h3>Reused audio, no re-charge</h3>' +
          '<p class="muted" style="font-size:13px">Every word, name and role is synthesized once and saved, then reused for free, you are never charged twice for the same word in the same voice. Saved segments: <b>' + (cache.total || 0) + "</b> (" + kinds + ").</p>" +
          '<div>' + voices + "</div></div>";
        $("#vcSave").addEventListener("click", function () {
          var payload = { agentName: val("vcName"), voiceId: val("vcVoiceId") || undefined, provider: (($("#vcProvider") || {}).value) || "elevenlabs" };
          if (!payload.agentName) { toast("Add a name"); return; }
          if (!payload.voiceId) { toast("Paste a voice id"); return; }
          send("/voice/clones", "POST", payload).then(function (r) {
            if (r.ok) { toast("Voice added"); paint(); }
            else { toast("Save failed"); }
          });
        });
        Array.prototype.forEach.call(body.querySelectorAll("[data-vcprov]"), function (btn) {
          btn.addEventListener("click", function () {
            var pid = btn.getAttribute("data-vcprov");
            send("/voice/clones", "POST", { action: "set-provider", provider: pid }).then(function (r) {
              if (r.ok) { toast("Voice engine set to " + pid); paint(); }
              else { toast("Could not set the engine"); }
            });
          });
        });
        Array.prototype.forEach.call(body.querySelectorAll("[data-vcact]"), function (btn) {
          btn.addEventListener("click", function () {
            var id = btn.getAttribute("data-vcact");
            send("/voice/clones", "POST", { action: "set-active", id: id }).then(function (r) {
              if (r.ok) { toast("Active voice set"); paint(); }
              else { toast("Could not set active voice"); }
            });
          });
        });
        Array.prototype.forEach.call(body.querySelectorAll("[data-vcdel]"), function (btn) {
          btn.addEventListener("click", function () {
            var id = btn.getAttribute("data-vcdel");
            if (!confirm("Delete this voice from your list? It is not removed from ElevenLabs, Cartesia or Hume.")) return;
            send("/voice/clones", "POST", { action: "delete", id: id }).then(function (r) {
              if (r.ok) { toast("Voice deleted"); paint(); }
              else { toast("Delete failed"); }
            });
          });
        });
      }).catch(function () { body.innerHTML = needsSetup(); });
    }

    /* ---- Test tab ---- */
    // Saved tests live in localStorage (same pattern as saved signals/campaigns),
    // so you can park a configured drop, reload, and keep re-testing it before you
    // approve it. Each row is the full form: number, prospect, persona, script.
    function vtTestsLoad() { try { return JSON.parse(localStorage.getItem("ros_voice_tests") || "[]"); } catch (e) { return []; } }
    function vtTestsStore(arr) { try { localStorage.setItem("ros_voice_tests", JSON.stringify(arr)); } catch (e) {} }
    function vtTestOpts() {
      var list = vtTestsLoad();
      if (!list.length) return '<option value="">- no saved tests yet -</option>';
      return '<option value="">- pick a saved test -</option>' + list.map(function (t) {
        return '<option value="' + esc(t.id) + '">' + esc(t.name) + "</option>";
      }).join("");
    }
    function vtRefreshSaved() { var s = $("#vtSaved"); if (s) s.innerHTML = vtTestOpts(); }
    function vtSetVal(id, v) { var e = $("#" + id); if (e) e.value = (v == null ? "" : v); }
    function vtSnapshot() {
      return {
        to: val("vtTo"), first: val("vtFirst"), role: val("vtRole"), company: val("vtCompany"),
        agentName: val("vtAgentName"), agentCompany: val("vtAgentCompany"), script: val("vtScript")
      };
    }
    function paintTest(body) {
      var grpLabel = function (t) {
        return '<div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin:14px 0 6px">' + t + "</div>";
      };
      body.innerHTML =
        '<div class="card"><h3>Test a single drop</h3>' +
        '<p class="muted" style="font-size:13px">Fire one personalized drop to a number YOU control, so you can hear the path end to end (render → assemble cloned voicemail → dial with AMD). The time window is skipped; everything else matches production.</p>' +
        '<div id="vtEngine" class="muted" style="font-size:12px;margin:-4px 0 4px">Voice engine: <span class="muted">…</span></div>' +

        grpLabel("Saved tests") +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
        '<select id="vtSaved" style="min-width:220px;max-width:100%">' + vtTestOpts() + "</select>" +
        '<button class="btn btn-sm" id="vtLoad">Load</button>' +
        '<button class="btn btn-sm" id="vtDelete">Delete</button>' +
        '<button class="btn btn-sm" id="vtSaveAs">💾 Save current</button></div>' +
        '<p class="muted" style="font-size:12px;margin:6px 0 0">Saved on this browser. Park a configured drop here, reload anytime, and keep re-testing the same one before you approve it. Saving under an existing name updates it.</p>' +

        grpLabel("1 · Where to send the test") +
        '<div style="max-width:360px">' + inp("vtTo", "Your test number (E.164)", "+13105551234") + "</div>" +

        grpLabel("2 · The prospect (the call is personalized for them)") +
        '<div class="vd-grid" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">' +
        inp("vtFirst", "First name", "Hector") +
        inp("vtRole", "Role", "VP of Sales") +
        inp("vtCompany", "Company", "Jaggaer") + "</div>" +

        grpLabel("3 · You (the voice and firm heard on the voicemail)") +
        '<div class="vd-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
        inp("vtAgentName", "Your name", "Ryan") +
        inp("vtAgentCompany", "Your firm", "Executive Search") + "</div>" +

        grpLabel("4 · Script") +
        '<div><div style="margin:4px 0">' + fieldChips("vtScript") + "</div>" +
        '<textarea id="vtScript" rows="4" style="width:100%">' + esc(VD_DEFAULT_SCRIPT) + "</textarea></div>" +
        '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-primary btn-sm" id="vtGo">📞 Send test drop</button>' +
        '<button class="btn btn-sm" id="vtAi">✨ AI customize</button>' +
        '<button class="btn btn-sm" id="vtListen">🔊 Listen first</button></div>' +
        '<div id="vtResult" style="margin-top:12px"></div></div>';
      wireChips(body);
      // Show which cloned voice this test will actually use (the active engine),
      // so "Send test drop" / "Listen first" are never ambiguous. Links to the
      // Voice & Consent tab where it's chosen.
      api("/voice/clones").then(function (d) {
        d = d || {}; var el = $("#vtEngine"); if (!el) return;
        var consent = d.consent || [], pl = { elevenlabs: "ElevenLabs", cartesia: "Cartesia", hume: "Hume" };
        var pinned = consent.filter(function (c) { return c.id === d.activeVoiceId; })[0] || null;
        var lastV = consent.filter(function (c) { return c.voiceId; }).slice(-1)[0] || null;
        var prov = d.activeProvider || (pinned && pinned.provider) || (lastV && lastV.provider) || null;
        var av = prov
          ? (pinned && (pinned.provider || "elevenlabs") === prov ? pinned
             : consent.filter(function (c) { return c.voiceId && (c.provider || "elevenlabs") === prov; }).slice(-1)[0] || null)
          : (pinned || lastV);
        el.innerHTML = prov
          ? 'Voice engine: <b style="color:var(--brand-2)">' + esc(pl[prov] || prov) + '</b>' +
            (av && av.voiceId ? ' · ' + esc(av.agentName) + ' <span class="muted">(' + esc(av.voiceId) + ')</span>' : ' <span style="color:var(--accent-amber)">· no voice id for this engine yet</span>') +
            ' <span class="muted">— change in Voice &amp; Consent</span>'
          : 'Voice engine: <span class="muted">none set — pick one in Voice &amp; Consent (runs as a safe dry-run until then)</span>';
      }).catch(function () {});
      $("#vtSaveAs").addEventListener("click", function () {
        var def = val("vtFirst") ? (val("vtFirst") + (val("vtCompany") ? " · " + val("vtCompany") : "")) : "My test";
        var name = (window.prompt("Name this test", def) || "").trim();
        if (!name) return;
        var list = vtTestsLoad(), snap = vtSnapshot(), existing = null;
        for (var i = 0; i < list.length; i++) { if (list[i].name.toLowerCase() === name.toLowerCase()) { existing = list[i]; break; } }
        if (existing) { snap.name = name; snap.id = existing.id; for (var k in snap) existing[k] = snap[k]; }
        else { snap.name = name; snap.id = "vt_" + Date.now() + "_" + Math.floor(Math.random() * 1e6); list.unshift(snap); }
        vtTestsStore(list); vtRefreshSaved();
        var sel = $("#vtSaved"); if (sel) sel.value = existing ? existing.id : list[0].id;
        toast(existing ? "Test updated" : "Test saved");
      });
      $("#vtLoad").addEventListener("click", function () {
        var id = ($("#vtSaved") || {}).value;
        if (!id) { toast("Pick a saved test"); return; }
        var t = vtTestsLoad().filter(function (x) { return x.id === id; })[0];
        if (!t) { toast("Saved test not found"); vtRefreshSaved(); return; }
        vtSetVal("vtTo", t.to); vtSetVal("vtFirst", t.first); vtSetVal("vtRole", t.role); vtSetVal("vtCompany", t.company);
        vtSetVal("vtAgentName", t.agentName); vtSetVal("vtAgentCompany", t.agentCompany); vtSetVal("vtScript", t.script);
        toast("Loaded “" + t.name + "”");
      });
      $("#vtDelete").addEventListener("click", function () {
        var id = ($("#vtSaved") || {}).value;
        if (!id) { toast("Pick a saved test"); return; }
        var list = vtTestsLoad(), t = list.filter(function (x) { return x.id === id; })[0];
        if (!t) { vtRefreshSaved(); return; }
        if (!confirm("Delete saved test “" + t.name + "”? This only removes it from this browser.")) return;
        vtTestsStore(list.filter(function (x) { return x.id !== id; })); vtRefreshSaved();
        toast("Deleted");
      });
      $("#vtAi").addEventListener("click", function () {
        aiCustomizeInto("vtScript", "vtResult", {
          templated: false, firstName: val("vtFirst"), role: val("vtRole"), company: val("vtCompany"),
          persona: { agentName: val("vtAgentName") || "Ryan", agentCompany: val("vtAgentCompany") || "Executive Search" },
        });
      });
      $("#vtListen").addEventListener("click", function () {
        var tpl = val("vtScript");
        if (!tpl) { toast("Write a script first"); return; }
        previewInto($("#vtResult"), {
          scriptTemplate: tpl, firstName: val("vtFirst"), role: val("vtRole"), company: val("vtCompany"),
          persona: { agentName: val("vtAgentName") || "Ryan", agentCompany: val("vtAgentCompany") || "Executive Search" },
        });
      });
      $("#vtGo").addEventListener("click", function () {
        var payload = {
          to: val("vtTo"), firstName: val("vtFirst"), role: val("vtRole"), company: val("vtCompany"),
          scriptTemplate: val("vtScript"), motion: motion,
          persona: { agentName: val("vtAgentName") || "Ryan", agentCompany: val("vtAgentCompany") || "Executive Search" }
        };
        if (!payload.to) { toast("Enter your test number"); return; }
        $("#vtResult").innerHTML = loading();
        send("/voice/test-drop", "POST", payload).then(function (r) {
          if (!r.ok) {
            var why = (r.data && r.data.detail) || (r.data && r.data.error) || ("HTTP " + r.status);
            $("#vtResult").innerHTML =
              '<div style="padding:10px;border-radius:8px;background:rgba(255,122,144,.08);border:1px solid rgba(255,122,144,.25)">' +
              '<b style="color:#ff7a90">Test failed.</b> <span style="font-size:13px">' + esc(why) + "</span></div>";
            return;
          }
          var d = r.data;
          var status = d.dialError
            ? '<span style="color:#ff7a90">dial failed (' + esc(d.dialError) + ")</span>"
            : d.dryRun
              ? '<span style="color:#ffc24d">dry-run — no Telnyx/clone keys set, nothing was dialed</span>'
              : '<span style="color:#34d399">dialing now → ' + esc(d.callControlId) + "</span>";
          $("#vtResult").innerHTML = '<div style="padding:10px;border-radius:8px;background:rgba(255,255,255,.03)">' +
            "<div style='font-size:13px'><b>Rendered (~" + d.estSeconds + "s" + (d.withinSweetSpot ? ", in the 15-25s sweet spot" : ", outside the 15-25s sweet spot") + "):</b></div>" +
            '<div style="font-size:13px;margin:6px 0">“' + esc(d.rendered) + "”</div>" +
            '<div style="font-size:12px;margin-top:6px">' + status + "</div>" +
            '<div class="muted" style="font-size:12px;margin-top:2px">segments ' + d.playlistLength + " · synthesized " + d.synthesized + " · cached " + d.cached + "</div>" +
            ((d.warnings && d.warnings.length) ? '<div style="font-size:12px;color:#ffc24d;margin-top:4px">⚠ ' + d.warnings.map(esc).join(" · ") + "</div>" : "") +
            "</div>";
        });
      });
    }

    tabBar(); paint();
  }

  /* ---------------- AI Vetting (inbound conversational screening) --------------
     A "vetting desk" binds one Job Description to one phone number and the
     recruiter's cloned voice. Candidates opt in (a short form), then CALL the
     number; a human-sounding AI recruiter greets them by name, references their
     LinkedIn experience, asks the top 3-4 qualifiers, and tells them the next
     step. Every call is recorded, transcribed, summarized, and scored 1-100 on
     the recruiter rubric. Talks to /api/vetting. */
  function renderVetting(el) {
    var vt = { tab: "desks", deskId: null, editing: null, creating: false };
    el.innerHTML = head("AI Vetting",
      "Bind a job description to a phone number and your cloned voice. Candidates opt in, then call in and talk to an AI recruiter that sounds like you, it greets them by name, references their LinkedIn experience, asks your top 3-4 qualifiers, and tells them the next step. Each call is recorded, transcribed, summarized, and scored 1-100.") +
      '<div class="vt-view"><div class="vt-tabs"></div><div id="vtBody">' + loading() + "</div></div>";

    function tabBar() {
      var tabs = [["desks", "🎙️ Vetting Desks"], ["calls", "📋 Calls & Scores"], ["bookings", "🗓️ Bookings"]];
      $(".vt-tabs", el).innerHTML = tabs.map(function (t) {
        return '<button class="vt-tab' + (vt.tab === t[0] ? " active" : "") + '" data-vttab="' + t[0] + '">' + t[1] + "</button>";
      }).join("");
    }
    $(".vt-tabs", el).addEventListener("click", function (e) {
      var b = e.target.closest("[data-vttab]"); if (!b) return;
      vt.tab = b.getAttribute("data-vttab"); tabBar(); paint();
    });

    function paint() {
      var body = $("#vtBody"); if (!body) return;
      if (vt.tab === "desks") return paintDesks(body);
      if (vt.tab === "bookings") return paintBookings(body);
      return paintCalls(body);
    }

    /* ---- small field helpers ---- */
    function fld(id, label, ph, type) {
      return '<div class="vt-field"><label>' + esc(label) + "</label>" +
        '<input id="' + id + '" type="' + (type || "text") + '" placeholder="' + esc(ph || "") + '" /></div>';
    }
    function vget(id) { var e = $("#" + id); return e ? e.value.trim() : ""; }
    function statusPill(s) { return '<span class="vt-pill ' + esc(s) + '">' + esc(s) + "</span>"; }
    // Phone-number picker, populated from the operator's real Telnyx numbers
    // (vt.numbers, fetched in paintDesks). A number already bound to a DIFFERENT
    // desk is shown disabled so two JDs can't accidentally claim one line -
    // detach it from that desk first to swap it over.
    function numberSelect(d) {
      var cur = d.phoneNumber || "";
      var nums = vt.numbers || [];
      var opts = '<option value="">- no number yet -</option>';
      var hasCur = false;
      nums.forEach(function (n) {
        var mine = (n.deskId && d.id && n.deskId === d.id);
        var takenElsewhere = n.assigned && !mine;
        if (n.phoneNumber === cur) hasCur = true;
        var tag = mine ? " (this desk)" : takenElsewhere ? (" → " + (n.deskName || "another desk")) : (n.label ? (" · " + n.label) : "");
        opts += '<option value="' + esc(n.phoneNumber) + '"' + (n.phoneNumber === cur ? " selected" : "") +
          (takenElsewhere ? " disabled" : "") + ">" + esc(n.phoneNumber) + esc(tag) + "</option>";
      });
      if (cur && !hasCur) opts += '<option value="' + esc(cur) + '" selected>' + esc(cur) + " (current)</option>";
      var hint = vt.numbersDry ? "Dry-run: no Telnyx key, showing only bound numbers."
        : vt.numbersErr ? ("Couldn’t reach Telnyx (" + esc(vt.numbersErr) + ").")
        : (nums.length + " number" + (nums.length === 1 ? "" : "s") + " on your Telnyx account.");
      return '<div class="vt-field"><label>Inbound number (from your Telnyx account)</label>' +
        '<select id="vtfPhone">' + opts + "</select>" +
        '<div class="vt-hint">' + hint + "</div></div>";
    }
    // Cloned-voice picker, REQUIRED to go live. Populated from the operator's
    // own consented cloned voices (Voice Drops → Voice & Consent). The agent
    // speaks the whole call in whichever voice is selected here.
    function voiceSelect(d) {
      var cur = d.voiceId || "";
      var voices = vt.voices || [];
      var opts = '<option value="">- select your cloned voice -</option>';
      var hasCur = false;
      voices.forEach(function (v) {
        if (v.voiceId === cur) hasCur = true;
        opts += '<option value="' + esc(v.voiceId) + '"' + (v.voiceId === cur ? " selected" : "") + ">" + esc(v.agentName || v.voiceId) + "</option>";
      });
      if (cur && !hasCur) opts += '<option value="' + esc(cur) + '" selected>' + esc(cur) + "</option>";
      var hint = voices.length
        ? "Required, the voice the agent speaks in on every call."
        : "No cloned voices yet. Record one in Voice Drops → Voice &amp; Consent, then pick it here.";
      return '<div class="vt-field"><label>Your cloned voice <span style="color:var(--vt-bad)">*</span></label>' +
        '<select id="vtfVoice">' + opts + "</select>" +
        '<div class="vt-hint">' + hint + "</div></div>";
    }

    /* ============ Desks tab ============ */
    function deskForm(d) {
      d = d || {};
      var q = d.questions || [];
      function qrow(i) {
        var qq = q[i] || {};
        return '<div class="vt-qrow">' +
          '<input id="vtQp' + i + '" placeholder="Qualifier ' + (i + 1) + ' (e.g. Years owning a $5M quota)" value="' + esc(qq.prompt || "") + '" />' +
          '<input id="vtQc' + i + '" placeholder="What a PASS looks like" value="' + esc(qq.passCriteria || "") + '" />' +
          '<label class="vt-must"><input id="vtQm' + i + '" type="checkbox" ' + (qq.mustHave ? "checked" : "") + " /> must-have</label></div>";
      }
      return '<div class="vt-card"><h3>' + (d.id ? "Edit desk" : "New vetting desk") + "</h3>" +
        '<div class="vt-section">The role</div>' +
        '<div class="vt-form-grid">' +
        fld("vtfName", "Desk name (internal)", "VP Sales, East") +
        fld("vtfRole", "Role title (spoken on the call)", "VP of Sales") +
        fld("vtfCompany", "Hiring company (blank = confidential search)", "Acme Corp, or leave blank to keep it confidential") +
        numberSelect(d) +
        "</div>" +
        '<div class="vt-field vt-field-full" style="margin-top:14px"><label>Job description</label>' +
        '<textarea id="vtfJd" rows="6" placeholder="Paste the full job description here. The agent uses this as its source of truth, it won\'t read it aloud.">' + esc(d.jobDescription || "") + "</textarea></div>" +
        '<div class="vt-section">Your voice on the call</div>' +
        '<div class="vt-form-grid">' +
        fld("vtfAgentName", "Your name (the agent introduces itself as)", "Ryan") +
        fld("vtfAgentCompany", "Your firm", "Executive Search") +
        voiceSelect(d) +
        fld("vtfThreshold", "Pass threshold (0-100)", "70", "number") +
        "</div>" +
        '<div class="vt-section">Top qualifiers <span style="color:var(--text-dim);font-weight:500;text-transform:none;letter-spacing:0">- auto-pulled from the JD; you don\'t need to fill these</span></div>' +
        '<div class="vt-hint" style="margin:-2px 2px 8px">Leave these blank and we\'ll generate the top 3-4 from your job description when you save. Or generate now to review and tweak.</div>' +
        '<div style="margin-bottom:8px"><button type="button" class="vt-btn" id="vtGenQ">✨ Generate from JD</button></div>' +
        qrow(0) + qrow(1) + qrow(2) + qrow(3) +
        '<div class="vt-section">Next step <span style="color:var(--text-dim);font-weight:500;text-transform:none;letter-spacing:0">- auto-filled; leave blank to use the friendly defaults</span></div>' +
        '<div class="vt-hint" style="margin:-2px 2px 8px">Leave blank and the agent will, in its own natural words, <b>if qualified:</b> tell them they\'re a strong fit, that you\'ll send the full JD, and ask for an updated resume tailored to what you discussed. <b>If not a fit:</b> let them down kindly and say you\'ll keep them in mind for roles that better suit their background.</div>' +
        '<div class="vt-form-grid">' +
        '<div class="vt-field"><label>If QUALIFIED</label><textarea id="vtfNextYes" rows="3" placeholder="Leave blank to use the default above, or write your own.">' + esc(d.nextStepQualified || "") + "</textarea></div>" +
        '<div class="vt-field"><label>If NOT qualified</label><textarea id="vtfNextNo" rows="3" placeholder="Leave blank to use the default above, or write your own.">' + esc(d.nextStepUnqualified || "") + "</textarea></div>" +
        "</div>" +
        '<div class="vt-formactions">' +
        '<button class="vt-btn vt-btn-primary" id="vtSave">' + (d.id ? "Save changes" : "Create desk") + "</button>" +
        '<button class="vt-btn vt-btn-ghost" id="vtCancel">Cancel</button>' +
        "</div></div>";
    }
    function collectDesk() {
      var qs = [];
      for (var i = 0; i < 4; i++) {
        var p = vget("vtQp" + i), c = vget("vtQc" + i);
        if (p && c) {
          var mEl = $("#vtQm" + i);
          qs.push({ prompt: p, passCriteria: c, mustHave: mEl && mEl.checked });
        }
      }
      var payload = {
        name: vget("vtfName"), motion: motion, roleTitle: vget("vtfRole"), clientCompany: vget("vtfCompany"),
        phoneNumber: vget("vtfPhone"), jobDescription: $("#vtfJd") ? $("#vtfJd").value : "",
        voiceId: vget("vtfVoice"), passThreshold: parseInt(vget("vtfThreshold") || "70", 10),
        persona: { agentName: vget("vtfAgentName") || "Ryan", agentCompany: vget("vtfAgentCompany") || "Executive Search" },
        questions: qs
      };
      var ny = $("#vtfNextYes"), nn = $("#vtfNextNo");
      if (ny && ny.value.trim()) payload.nextStepQualified = ny.value.trim();
      if (nn && nn.value.trim()) payload.nextStepUnqualified = nn.value.trim();
      if (vt.editing) payload.id = vt.editing;
      return payload;
    }
    function deskCard(d) {
      var optinUrl = location.origin + "/vetting-optin?desk=" + d.id;
      var actions = '<button class="vt-btn" data-vtact="edit" data-id="' + d.id + '">✎ Edit</button>';
      if (d.status === "live") {
        actions += '<button class="vt-btn" data-vtact="pause" data-id="' + d.id + '">⏸ Pause</button>';
      } else if (d.status === "paused") {
        actions += '<button class="vt-btn vt-btn-primary" data-vtact="resume" data-id="' + d.id + '">▶ Resume</button>';
      } else {
        actions += '<button class="vt-btn vt-btn-primary" data-vtact="provision" data-id="' + d.id + '">📡 Go live</button>';
      }
      if (d.phoneNumber) actions += '<button class="vt-btn" data-vtact="detach" data-id="' + d.id + '">⛓️‍💥 Detach #</button>';
      actions += '<button class="vt-btn" data-vtact="copy" data-id="' + d.id + '" data-url="' + esc(optinUrl) + '">🔗 Opt-in link</button>' +
        '<button class="vt-btn" data-vtact="viewcalls" data-id="' + d.id + '">📋 Calls (' + (d.callCount || 0) + ")</button>" +
        '<button class="vt-btn vt-btn-danger" data-vtact="del" data-id="' + d.id + '">🗑</button>';
      var chips =
        '<span class="vt-chip">📞 <b>' + esc(d.phoneNumber || "no number") + "</b></span>" +
        '<span class="vt-chip">' + (d.questions ? d.questions.length : 0) + " qualifiers</span>" +
        '<span class="vt-chip"><b>' + (d.candidateCount || 0) + "</b> opted in</span>" +
        '<span class="vt-chip">pass ≥ <b>' + d.passThreshold + "</b></span>" +
        '<span class="vt-chip">🎙️ ' + esc(d.voiceId || "default voice") + "</span>";
      return '<div class="vt-desk" data-id="' + d.id + '">' +
        '<div class="vt-desk-head">' +
        '<h3 class="vt-desk-title">' + esc(d.name) + " <span>· " + esc(d.roleTitle || "no role title") + "</span></h3>" +
        statusPill(d.status) + "</div>" +
        '<div class="vt-meta">' + chips + "</div>" +
        (d.jobDescription ? "" : '<div class="vt-warn">⚠ Add a job description before going live.</div>') +
        '<div class="vt-actions">' + actions + "</div>" +
        '<div class="vt-msg" data-msg="' + d.id + '"></div></div>';
    }
    function paintDesks(body) {
      body.innerHTML = loading();
      // Load the number pick-list, cloned voices, and the desk list, but NEVER
      // let any one of them block the form. safe() turns a failed call into null
      // so the create form always renders and a desk can always be made, even if
      // Telnyx/voice/desk endpoints hiccup.
      function safe(p) { return p.then(function (d) { return d; }, function () { return null; }); }
      Promise.all([
        safe(api("/vetting/numbers")),
        safe(api("/voice/clones")),
        safe(api("/vetting/desks?motion=" + motion))
      ]).then(function (res) {
        var nd = res[0] || {}, vd = res[1] || {}, data = res[2] || {};
        vt.numbers = nd.numbers || [];
        vt.numbersDry = !!nd.dryRun;
        vt.numbersErr = nd.error || (res[0] ? null : "unreachable");
        vt.voices = ((vd.consent) || []).filter(function (c) { return c.voiceId; });

        var list = data.desks || [];
        var editing = vt.editing ? list.filter(function (x) { return x.id === vt.editing; })[0] : null;
        // Once you have desks the list leads and the form is revealed on demand;
        // with none yet, the form is shown by default so first-run lands on it.
        var showForm = !!(vt.creating || editing) || list.length === 0;
        var toolbar = '<div class="vt-toolbar"><span class="vt-count">' +
          list.length + " vetting desk" + (list.length === 1 ? "" : "s") + "</span>" +
          (showForm ? "" : '<button class="vt-btn vt-btn-primary" id="vtNew">＋ New vetting desk</button>') +
          "</div>";
        body.innerHTML = toolbar +
          (showForm ? (editing ? deskForm(editing) : deskForm(null)) : "") +
          (list.length ? list.map(deskCard).join("") : "");
        wireDesks(body);
      });
    }
    function wireDesks(body) {
      var newBtn = $("#vtNew");
      if (newBtn) newBtn.addEventListener("click", function () { vt.creating = true; vt.editing = null; paintDesks(body); });
      var saveBtn = $("#vtSave");
      if (saveBtn) saveBtn.addEventListener("click", function () {
        var p = collectDesk();
        if (!p.name) { toast("Name the desk first."); return; }
        send("/vetting/desks", "PUT", p).then(function (r) {
          if (!r.ok) { toast("Save failed"); return; }
          toast(vt.editing ? "Desk updated" : "Desk created"); vt.editing = null; vt.creating = false; paintDesks(body);
        });
      });
      var cancel = $("#vtCancel");
      if (cancel) cancel.addEventListener("click", function () { vt.editing = null; vt.creating = false; paintDesks(body); });
      var genQ = $("#vtGenQ");
      if (genQ) genQ.addEventListener("click", function () {
        var jd = $("#vtfJd") ? $("#vtfJd").value.trim() : "";
        if (!jd) { toast("Paste the job description first."); return; }
        genQ.disabled = true; genQ.textContent = "✨ Generating…";
        send("/vetting/desks", "POST", { action: "generate-questions", jobDescription: jd, roleTitle: vget("vtfRole"), clientCompany: vget("vtfCompany") }).then(function (r) {
          genQ.disabled = false; genQ.textContent = "✨ Generate from JD";
          if (!r.ok) { toast((r.data && r.data.detail) || "Couldn’t generate, add ANTHROPIC_API_KEY."); return; }
          var qs = (r.data && r.data.questions) || [];
          for (var i = 0; i < 4; i++) {
            var q = qs[i] || { prompt: "", passCriteria: "", mustHave: false };
            if ($("#vtQp" + i)) $("#vtQp" + i).value = q.prompt || "";
            if ($("#vtQc" + i)) $("#vtQc" + i).value = q.passCriteria || "";
            if ($("#vtQm" + i)) $("#vtQm" + i).checked = !!q.mustHave;
          }
          toast("Pulled " + qs.length + " qualifier" + (qs.length === 1 ? "" : "s") + " from the JD, tweak if you like.");
        }).catch(function () { genQ.disabled = false; genQ.textContent = "✨ Generate from JD"; toast("Couldn’t reach the server."); });
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-vtact]"), function (b) {
        b.addEventListener("click", function () { deskAction(b.getAttribute("data-vtact"), b.getAttribute("data-id"), b, body); });
      });
    }
    function deskMsg(id, text, warn) {
      var m = document.querySelector('[data-msg="' + id + '"]');
      if (m) { m.textContent = text; m.classList.toggle("warn", !!warn); }
    }
    function deskAction(act, id, btn, body) {
      if (act === "edit") { vt.editing = id; paintDesks(body); return; }
      if (act === "copy") {
        var url = btn.getAttribute("data-url");
        if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { toast("Opt-in link copied"); });
        else { window.prompt("Opt-in link", url); }
        return;
      }
      if (act === "viewcalls") { vt.tab = "calls"; vt.deskId = id; tabBar(); paint(); return; }
      if (act === "detach") {
        if (!confirm("Unbind this number from the desk? The number stops answering for this JD and frees up to assign elsewhere.")) return;
        deskMsg(id, "Detaching number…");
        send("/vetting/desks", "POST", { action: "detach", deskId: id }).then(function () { toast("Number detached"); paintDesks(body); });
        return;
      }
      if (act === "del") {
        if (!confirm("Delete this vetting desk? Its number is unbound and call history is removed.")) return;
        send("/vetting/desks?id=" + encodeURIComponent(id), "DELETE").then(function () { toast("Desk deleted"); paintDesks(body); });
        return;
      }
      if (act === "provision") {
        deskMsg(id, "Provisioning the agent and binding the number…");
        send("/vetting/desks", "POST", { action: "provision", deskId: id }).then(function (r) {
          if (!r.ok) { deskMsg(id, "Could not go live: " + ((r.data && r.data.detail) || (r.data && r.data.error) || r.status), true); return; }
          if (r.data && r.data.dryRun) deskMsg(id, "Live in dry-run (no Telnyx key, the desk is configured but won’t take real calls until TELNYX_API_KEY is set).", true);
          paintDesks(body);
        });
        return;
      }
      if (act === "pause" || act === "resume") {
        send("/vetting/desks", "POST", { action: act, deskId: id }).then(function () { paintDesks(body); });
      }
    }

    /* ============ Calls tab ============ */
    var SCORE_CATS = [
      ["communication", "Communication", 20], ["responseLength", "Response length", 10],
      ["interpersonalPresence", "Interpersonal presence", 15], ["selfAwareness", "Self-awareness", 15],
      ["achievementOrientation", "Achievement", 15], ["problemSolving", "Problem-solving", 10],
      ["motivation", "Motivation", 10], ["culturalFit", "Cultural fit", 5]
    ];
    function band(total) {
      if (total >= 90) return ["Exceptional candidate", "#34d399"];
      if (total >= 80) return ["Strong hire", "#34d399"];
      if (total >= 70) return ["Worth advancing", "#7fd1ff"];
      if (total >= 60) return ["Borderline", "#ffc24d"];
      return ["Do not advance", "#ff7a90"];
    }
    function scoreRing(total) {
      var b = band(total || 0);
      return '<span class="vt-ring" style="--pct:' + (total || 0) + ';--ring:' + b[1] + '">' + (total != null ? total : "-") + "</span>";
    }
    function callRow(c) {
      var b = band(c.totalScore || 0);
      var name = (c.candidate ? (c.candidate.firstName + " " + c.candidate.lastName) : (c.callerName || c.callerPhone));
      var qual = c.qualified === true ? '<span class="vt-qual-yes">✓ Qualified</span>' : c.qualified === false ? '<span class="vt-qual-no">✗ Not qualified</span>' : '<span style="color:var(--text-dim)">pending</span>';
      var mkt = c.marketabilityScore != null ? (" · market " + c.marketabilityScore + "/10") : "";
      return '<div class="vt-call" data-call="' + c.id + '">' +
        '<div class="vt-call-top">' + scoreRing(c.totalScore) +
        '<div style="flex:1;min-width:0">' +
        '<div class="vt-call-name">' + esc(name) + " <span>· " + esc(c.callerPhone) + "</span></div>" +
        '<div class="vt-call-sub" style="color:' + b[1] + '">' + b[0] + " · " + qual + mkt + (c.durationSec ? (" · " + Math.round(c.durationSec / 60) + "m") : "") + " · " + (c.status === "scored" ? "scored" : esc(c.status)) + "</div>" +
        (c.summary ? '<div class="vt-call-summary">' + esc(c.summary) + "</div>" : "") +
        "</div></div>" +
        '<div class="vt-call-detail vt-detail" data-detail="' + c.id + '" style="display:none"></div></div>';
    }
    function paintCalls(body) {
      body.innerHTML = loading();
      api("/vetting/desks?motion=" + motion).then(function (dd) {
        var desks = (dd && dd.desks) || [];
        var opts = '<option value="">All desks</option>' + desks.map(function (d) {
          return '<option value="' + d.id + '"' + (vt.deskId === d.id ? " selected" : "") + ">" + esc(d.name) + "</option>";
        }).join("");
        var qs = vt.deskId ? ("?deskId=" + encodeURIComponent(vt.deskId)) : "";
        api("/vetting/calls" + qs).then(function (cd) {
          var calls = (cd && cd.calls) || [];
          body.innerHTML = '<div class="vt-card"><div class="vt-select-wrap"><label>Desk</label>' +
            '<select id="vtDeskSel">' + opts + "</select></div></div>" +
            (calls.length ? calls.map(callRow).join("") : '<div class="vt-empty">No calls yet. Share a desk’s opt-in link, then have a candidate call its number.</div>');
          $("#vtDeskSel").addEventListener("change", function () { vt.deskId = this.value || null; paintCalls(body); });
          Array.prototype.forEach.call(body.querySelectorAll(".vt-call"), function (row) {
            row.addEventListener("click", function (e) {
              if (e.target.closest(".vt-call-detail")) return;
              toggleCall(row.getAttribute("data-call"));
            });
          });
        }).catch(function () { body.innerHTML = needsSetup(); });
      }).catch(function () { body.innerHTML = needsSetup(); });
    }
    function toggleCall(id) {
      var det = document.querySelector('[data-detail="' + id + '"]');
      if (!det) return;
      if (det.style.display !== "none") { det.style.display = "none"; det.innerHTML = ""; return; }
      det.style.display = "block"; det.innerHTML = loading();
      api("/vetting/calls?id=" + encodeURIComponent(id)).then(function (d) {
        var c = d && d.call; if (!c) { det.innerHTML = '<p class="muted">Not found.</p>'; return; }
        det.innerHTML = callDetail(c);
      }).catch(function () { det.innerHTML = '<p class="muted">Could not load.</p>'; });
    }
    function bar(label, v, max) {
      var pct = max ? Math.round((v / max) * 100) : 0;
      return '<div class="vt-bar"><div class="vt-bar-h"><span>' + esc(label) + "</span><span>" + v + "/" + max + "</span></div>" +
        '<div class="vt-bar-track"><div class="vt-bar-fill" style="width:' + pct + '%"></div></div></div>';
    }
    function callDetail(c) {
      var html = "";
      if (c.scores) {
        html += '<div class="vt-scores">' +
          SCORE_CATS.map(function (s) { return bar(s[1], c.scores[s[0]] || 0, s[2]); }).join("") + "</div>";
      }
      if (c.marketabilityScore != null || c.agentRealism) {
        html += '<div class="vt-substat">' +
          (c.marketabilityScore != null ? "<span><b>Marketability:</b> " + c.marketabilityScore + "/10 <span style='color:var(--text-dim)'>(client-interview likelihood)</span></span>" : "") +
          (c.agentRealism ? "<span><b>Agent realism:</b> " + c.agentRealism.score + "/100</span>" : "") + "</div>";
        if (c.agentRealism && c.agentRealism.notes) html += '<div class="vt-substat" style="margin-top:4px">' + esc(c.agentRealism.notes) + "</div>";
      }
      if (c.qualifyRationale) html += '<div class="vt-rationale"><b>Why ' + (c.qualified ? "they qualify" : "they don’t qualify") + ":</b> " + esc(c.qualifyRationale) + "</div>";
      if (c.verdicts && c.verdicts.length) {
        html += '<div class="vt-verdicts"><h4>Qualifiers</h4>' + c.verdicts.map(function (v) {
          return '<div class="vt-verdict">' + (v.pass ? "✅" : "❌") + ' <span class="vt-q-ans">' + esc(v.answer) + '</span> <span class="vt-q-rat">- ' + esc(v.rationale) + "</span></div>";
        }).join("") + "</div>";
      }
      if (c.nextStepGiven) html += '<div class="vt-next"><b>Next step told to candidate:</b> ' + esc(c.nextStepGiven) + "</div>";
      if (c.recordingUrl) html += '<div style="margin-top:12px"><a class="vt-btn" href="' + esc(c.recordingUrl) + '" target="_blank" rel="noopener">▶ Recording</a></div>';
      if (c.transcript && c.transcript.length) {
        html += '<div class="vt-transcript"><div class="vt-tr-h">Transcript</div><div class="vt-tr-body">' +
          c.transcript.map(function (t) {
            var who = t.role === "agent" ? "You (AI)" : "Candidate";
            return '<div class="vt-turn ' + (t.role === "agent" ? "agent" : "candidate") + '"><b>' + who + ":</b> " + esc(t.text) + "</div>";
          }).join("") + "</div></div>";
      }
      return html || '<p style="color:var(--text-muted)">Call recorded; analysis pending.</p>';
    }

    /* ============ Bookings tab (TidyCal) ============ */
    function bkWhen(s) {
      if (!s) return "";
      try { return new Date(s).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
      catch (e) { return esc(s); }
    }
    function bookingCard(b) {
      var pill = b.status === "ready" ? ["live", "Ready"]
        : b.status === "no_phone" ? ["paused", "Needs phone #"]
        : b.status === "no_linkedin" ? ["paused", "Needs LinkedIn"]
        : ["paused", "No matching desk"];
      var deskChip = b.deskName
        ? '<span class="vt-chip">→ <b>' + esc(b.deskName) + "</b></span>"
        : '<span class="vt-chip">⚠ no desk matches “' + esc(b.jobTitle || "-") + "”</span>";
      var phoneChip = b.phone ? '<span class="vt-chip">📞 <b>' + esc(b.phone) + "</b></span>" : '<span class="vt-chip">📞 none on booking</span>';
      var liChip = b.linkedinUrl ? '<span class="vt-chip">🔗 LinkedIn ✓</span>' : '<span class="vt-chip">🔗 no LinkedIn</span>';
      return '<div class="vt-desk">' +
        '<div class="vt-desk-head"><h3 class="vt-desk-title">' + esc(b.name || "Unknown") + ' <span>· ' + esc(b.jobTitle || "no role title") + "</span></h3>" +
        '<span class="vt-pill ' + pill[0] + '">' + pill[1] + "</span></div>" +
        '<div class="vt-meta">' + deskChip + phoneChip + liChip +
        (b.startsAt ? '<span class="vt-chip">🕒 ' + esc(bkWhen(b.startsAt)) + "</span>" : "") + "</div></div>";
    }
    function bookingsView(r) {
      r = r || {};
      if (!r.configured) {
        return '<div class="vt-card"><h3>Connect TidyCal</h3>' +
          '<div class="vt-hint" style="margin-top:8px">Add your TidyCal token on the server (<code>TIDYCAL_API_TOKEN</code>) and bookings will appear here. Each is routed to the matching vetting desk, the candidate\'s LinkedIn is researched before they call, and their phone is matched when they dial in. Add three questions to your TidyCal booking type so we can route and prep: <b>Job title</b> (matched to a desk), <b>LinkedIn URL</b>, and <b>phone number</b>.</div></div>';
      }
      var head = '<div class="vt-card"><div class="vt-toolbar" style="margin:0">' +
        '<span class="vt-count">' + (r.pulled || 0) + " upcoming booking" + ((r.pulled === 1) ? "" : "s") +
        " · <span style=\"color:var(--vt-good)\">" + (r.ready || 0) + " ready</span>" +
        (r.unmatched ? " · <span style=\"color:var(--vt-warn)\">" + r.unmatched + " no desk</span>" : "") +
        (r.noPhone ? " · <span style=\"color:var(--vt-warn)\">" + r.noPhone + " need phone</span>" : "") +
        (r.noLinkedin ? " · <span style=\"color:var(--vt-warn)\">" + r.noLinkedin + " need LinkedIn</span>" : "") + "</span>" +
        '<button class="vt-btn vt-btn-primary" id="vtBkSync">↻ Sync now</button></div>' +
        (r.error ? '<div class="vt-warn" style="margin-top:10px">⚠ TidyCal said: ' + esc(r.error) + ', an MCP-scoped token may be rejected by the REST API; generate a personal access token at tidycal.com/integrations/oauth.</div>' : "") +
        '<div class="vt-hint" style="margin-top:8px">“Sync now” pulls upcoming bookings, files each candidate under the matching desk, and researches their LinkedIn so the agent is ready when they call. Wire it to a schedule to run automatically.</div></div>';
      var list = (r.bookings || []).map(bookingCard).join("") ||
        '<div class="vt-empty">No upcoming bookings. New TidyCal bookings show up here on the next sync.</div>';
      return head + list;
    }
    function wireBookings(body) {
      var sync = $("#vtBkSync");
      if (sync) sync.addEventListener("click", function () {
        sync.disabled = true; sync.textContent = "↻ Syncing…";
        send("/vetting/tidycal", "POST", { action: "sync" }).then(function (r) {
          if (!r.ok) { sync.disabled = false; sync.textContent = "↻ Sync now"; toast("Sync failed"); return; }
          var d = r.data || {};
          toast("Synced, " + (d.ready || 0) + " ready, " + (d.pulled || 0) + " pulled");
          body.innerHTML = bookingsView(d); wireBookings(body);
        }).catch(function () { sync.disabled = false; sync.textContent = "↻ Sync now"; toast("Couldn’t reach the server."); });
      });
    }
    function paintBookings(body) {
      body.innerHTML = loading();
      api("/vetting/tidycal").then(function (r) {
        body.innerHTML = bookingsView(r); wireBookings(body);
      }).catch(function () { body.innerHTML = needsSetup(); });
    }

    tabBar(); paint();
  }

  /* ---------------- Outreach (sending readiness control panel) ----------------
     The working interface for everything you need wired before you can send:
     ATS, SMS (TalTxt), the enrichment waterfall + its credit balance, Job
     Search (the white-labelled signal feed), sending domains down to each
     inbox, and the LinkedIn accounts, each with live status, the switch to
     turn it on, and a path to connect what's missing. Talks to /api/outreach. */
  var orSnap = null;       // last /outreach snapshot
  var orPanel = null;      // expanded drill-down: 'domains' | 'linkedin' | null

  function renderOutreach(el) {
    var canInteg = can("integrations:manage");
    var canAts = can("ats:manage");
    var canAcct = can("accounts:manage");

    el.innerHTML = head("Outreach",
      "Your sending readiness in one place. Connect what's missing, watch your domains and LinkedIn warm up, top up enrichment credits, and switch the engine on.") +
      '<div id="orBody">' + loading() + "</div>";

    // One delegated listener for the whole panel, survives repaints.
    $("#orBody").addEventListener("click", function (e) {
      var t;
      if ((t = e.target.closest("[data-toggle]"))) { doToggle(t.getAttribute("data-toggle"), t); return; }
      if ((t = e.target.closest("[data-topup]"))) { topUpModal(); return; }
      if ((t = e.target.closest("[data-connect]"))) { howToModal(t.getAttribute("data-connect")); return; }
      if ((t = e.target.closest("[data-panel]"))) { var p = t.getAttribute("data-panel"); orPanel = (orPanel === p ? null : p); paint(); return; }
      if ((t = e.target.closest("[data-go]"))) {
        var route = t.getAttribute("data-go");
        if (ROUTES[route] && ROUTES[route].cap && !can(ROUTES[route].cap)) { toast("Ask a workspace admin to set this up."); return; }
        location.hash = route; return;
      }
    });

    load();

    function load() {
      api("/outreach?motion=" + encodeURIComponent(motion))
        .then(function (d) { orSnap = d || {}; paint(); })
        .catch(function () { var b = $("#orBody"); if (b) b.innerHTML = needsSetup(); });
    }

    function doToggle(key, btn) {
      if (!canInteg) { toast("Ask a workspace admin to change this."); return; }
      var action = key === "enrichment" ? "toggle-enrichment" : "toggle-jobsearch";
      var nowOn = !btn.classList.contains("on");
      btn.classList.toggle("on", nowOn); // optimistic
      send("/outreach", "POST", { action: action, on: nowOn, motion: motion }).then(function (r) {
        if (r.ok) { orSnap = r.data; paint(); toast((key === "enrichment" ? "Enrichment" : "Job Search") + (nowOn ? " turned on" : " turned off")); }
        else { btn.classList.toggle("on", !nowOn); toast("Could not update (" + (r.data.error || r.status) + ")"); }
      }).catch(function () { btn.classList.toggle("on", !nowOn); toast("Could not reach the server."); });
    }

    function topUpModal() {
      if (!canInteg) { toast("Ask a workspace admin to manage credits."); return; }
      var amts = [1000, 5000, 10000];
      var btns = amts.map(function (a) { return '<button class="btn btn-ghost" data-amt="' + a + '">+ ' + a.toLocaleString() + " credits</button>"; }).join("");
      openModal("Add enrichment credits", "Credits are spent finding work emails and direct dials. They top up instantly for this demo.",
        '<div class="btn-row" style="flex-wrap:wrap;gap:10px">' + btns + "</div>" +
        '<div class="modal-foot"><button class="btn btn-ghost btn-sm" data-x>Close</button></div>',
        function (root, close) {
          root.querySelector("[data-x]").addEventListener("click", close);
          Array.prototype.forEach.call(root.querySelectorAll("[data-amt]"), function (b) {
            b.addEventListener("click", function () {
              b.disabled = true;
              send("/outreach", "POST", { action: "topup-credits", amount: parseInt(b.getAttribute("data-amt"), 10), motion: motion })
                .then(function (r) { if (r.ok) { orSnap = r.data; paint(); toast("Credits added"); close(); } else { b.disabled = false; toast("Could not add credits"); } })
                .catch(function () { b.disabled = false; toast("Could not reach the server."); });
            });
          });
        });
    }

    function howToModal(which) {
      var ats = which === "ats";
      var title = ats ? "Connect your ATS" : "Connect SMS (TalTxt)";
      var sub = ats ? "Loxo is the verified, primary ATS. Every reply, touch, and placement syncs once it's connected."
        : "Add compliant post-engagement texting and opt-outs to your sequences.";
      var steps = ats
        ? ["Open the ATS tab and choose Loxo as your system of record.",
           "Under Accounts → API key, add your Loxo API key (service: Loxo).",
           "Go to Connected and press Test on Loxo until it turns green."]
        : ["Get your TalTxt API key from your TalTxt dashboard.",
           "Under Accounts → API key, add it (service: TalTxt).",
           "Go to Connected and press Test on TalTxt until it turns green."];
      var goRoute = ats ? "ats" : "connected";
      var goCap = ats ? canAts : canInteg;
      var foot = goCap
        ? '<div class="modal-foot"><button class="btn btn-ghost btn-sm" data-x>Close</button><button class="btn btn-primary btn-sm" data-open>' + (ats ? "Open ATS settings" : "Open Connected") + "</button></div>"
        : '<div class="modal-foot"><span class="muted" style="margin-right:auto">You don\'t have access, ask a workspace admin.</span><button class="btn btn-ghost btn-sm" data-x>Close</button></div>';
      openModal(title, sub,
        "<ol class=\"or-steps\">" + steps.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") + "</ol>" + foot,
        function (root, close) {
          root.querySelector("[data-x]").addEventListener("click", close);
          var op = root.querySelector("[data-open]");
          if (op) op.addEventListener("click", function () { close(); location.hash = goRoute; });
        });
    }

    function pill(state) {
      var m = { ready: ["ready", "Ready"], warming: ["warming", "Warming up"], action: ["action", "Action needed"], off: ["off", "Off"] };
      var x = m[state] || m.action;
      return '<span class="or-pill ' + x[0] + '">' + x[1] + "</span>";
    }
    function bar(pct, cls) { return '<div class="or-bar"><span class="' + (cls || "") + '" style="width:' + Math.max(0, Math.min(100, pct || 0)) + '%"></span></div>'; }
    function sw(on, key) { return '<button class="or-sw' + (on ? " on" : "") + '" role="switch" aria-checked="' + (on ? "true" : "false") + '" data-toggle="' + key + '"' + (canInteg ? "" : " disabled title='Admin only'") + "><span></span></button>"; }
    function fmt(n) { return (n || 0).toLocaleString(); }

    function card(opts) {
      // opts: { icon, name, state, body, foot }
      return '<div class="or-card or-' + (opts.state || "action") + '">' +
        '<div class="or-card-h"><span class="or-ic">' + opts.icon + "</span>" +
        '<div class="or-name">' + esc(opts.name) + "</div>" + pill(opts.state) + "</div>" +
        '<div class="or-card-b">' + opts.body + "</div>" +
        (opts.foot ? '<div class="or-card-f">' + opts.foot + "</div>" : "") + "</div>";
    }

    function paint() {
      var body = $("#orBody"); if (!body || !orSnap) return;
      var s = orSnap;
      var pf = s.preflight || { ok: false, blocking: [] };
      var gate = pf.ok
        ? '<div class="or-gate ok">✓ All required tools are green, you can activate ' + esc(motion === "bd" ? "Business Development" : "Recruiting") + " campaigns.</div>"
        : '<div class="or-gate warn">⚠ ' + ((pf.blocking || []).length) + " required tool(s) not ready yet. Connect the cards marked <b>Action needed</b> to activate " + esc(motion === "bd" ? "Business Development" : "Recruiting") + " campaigns.</div>";

      // ATS
      var ats = s.ats || {};
      var atsCard = card({
        icon: "🗂️", name: ats.label || "ATS", state: ats.state,
        body: '<p class="or-detail">' + esc(ats.detail || "") + "</p>",
        foot: ats.connected
          ? '<button class="btn btn-ghost btn-sm" data-go="ats">Manage ATS</button>'
          : '<button class="btn btn-primary btn-sm" data-connect="ats">How to connect</button>'
      });

      // SMS
      var sms = s.sms || {};
      var smsCard = card({
        icon: "💬", name: sms.label || "SMS", state: sms.state,
        body: '<p class="or-detail">' + esc(sms.detail || "") + "</p>",
        foot: sms.connected
          ? '<button class="btn btn-ghost btn-sm" data-go="connected">Manage</button>'
          : '<button class="btn btn-primary btn-sm" data-connect="sms">How to connect</button>'
      });

      // Enrichment + credits
      var en = s.enrichment || {}, cr = en.credits || {};
      var enCard = card({
        icon: "🧪", name: "Enrichment waterfall", state: en.state,
        body: '<p class="or-detail">' + esc(en.detail || "") + "</p>" +
          '<div class="or-credits"><div class="or-credit-top"><b>' + fmt(cr.remaining) + "</b> <span class=\"muted\">/ " + fmt(cr.included) + " credits</span></div>" +
          bar(cr.pct, cr.low ? "warn" : "ok") + "</div>",
        foot: '<div class="or-foot-row"><label class="or-swrap"><span class="muted">' + (en.enabled ? "On" : "Off") + "</span>" + sw(en.enabled, "enrichment") + "</label>" +
          '<button class="btn btn-ghost btn-sm" data-topup' + (canInteg ? "" : " disabled") + ">Top up credits</button></div>"
      });

      // Job Search (white-labelled)
      var js = s.jobSearch || {};
      var jsCard = card({
        icon: "🛰️", name: js.label || "Job Search", state: js.state,
        body: '<p class="or-detail">' + esc(js.detail || "") + "</p>",
        foot: '<label class="or-swrap"><span class="muted">' + (js.enabled ? "On" : "Off") + "</span>" + sw(js.enabled, "jobSearch") + "</label>"
      });

      // Domains
      var dm = s.domains || { list: [] };
      var dmCard = card({
        icon: "📧", name: "Warm sending domains", state: dm.state,
        body: '<p class="or-detail">' + (dm.total
          ? "<b>" + dm.total + "</b> domain" + (dm.total === 1 ? "" : "s") + " · <b>" + (dm.inboxesWarm || 0) + "</b> of " + (dm.inboxesTotal || 0) + " inboxes warm" + (dm.inboxesWarming ? ", " + dm.inboxesWarming + " warming" : "")
          : "No sending domains yet. Add one to start warming inboxes.") + "</p>",
        foot: '<div class="or-foot-row">' +
          (dm.total ? '<button class="btn btn-ghost btn-sm" data-panel="domains">' + (orPanel === "domains" ? "Hide details" : "Manage domains") + "</button>" : "") +
          (canAcct ? '<button class="btn ' + (dm.total ? "btn-ghost" : "btn-primary") + ' btn-sm" data-go="accounts">＋ Add domain</button>' : "") + "</div>"
      });

      // LinkedIn
      var li = s.linkedin || { list: [] };
      var liCard = card({
        icon: "🔗", name: "Warm LinkedIn accounts", state: li.state,
        body: '<p class="or-detail">' + (li.total
          ? "<b>" + li.warmed + "</b> of " + li.total + " warmed" + (li.flagged ? ' · <span style="color:var(--accent-red)">' + li.flagged + " flagged</span>" : "")
          : "No LinkedIn accounts yet. Connect one to start warming it.") + "</p>",
        foot: '<div class="or-foot-row">' +
          (li.total ? '<button class="btn btn-ghost btn-sm" data-panel="linkedin">' + (orPanel === "linkedin" ? "Hide details" : "View accounts") + "</button>" : "") +
          (canAcct ? '<button class="btn ' + (li.total ? "btn-ghost" : "btn-primary") + ' btn-sm" data-go="accounts">＋ Add account</button>' : "") + "</div>"
      });

      var panel = "";
      if (orPanel === "domains") panel = domainsPanel(dm);
      else if (orPanel === "linkedin") panel = linkedinPanel(li);

      body.innerHTML = gate +
        '<div class="or-grid">' + atsCard + smsCard + enCard + jsCard + dmCard + liCard + "</div>" +
        panel + playbook();

      // reflect the on/off label live as the switch is clicked (handled in doToggle repaint)
    }

    function domainsPanel(dm) {
      var rows = (dm.list || []).map(function (d) {
        var hp = d.state === "ready" ? "ready" : d.state === "action" ? "action" : "warming";
        var inboxes = (d.inboxes || []).map(function (ib) {
          var ip = ib.state === "warm" ? "ready" : ib.state === "paused" ? "action" : "warming";
          return '<div class="or-inbox"><span class="or-dot ' + ip + '"></span><span class="or-email">' + esc(ib.email) + "</span>" +
            '<span class="or-mini">' + (ib.state === "warm" ? "Warm" : ib.state === "paused" ? "Paused" : "Warming · " + ib.warmupPct + "%") + "</span>" +
            '<div class="or-bar mini">' + '<span class="' + ip + '" style="width:' + ib.warmupPct + '%"></span></div></div>';
        }).join("");
        return '<div class="or-dom"><div class="or-dom-h"><b>' + esc(d.domain) + "</b>" + pill(d.state) +
          '<span class="or-mini">bounce ' + ((d.bounceRate || 0) * 100).toFixed(1) + "% · " + esc(d.health) + "</span></div>" +
          '<div class="or-inboxes">' + inboxes + "</div></div>";
      }).join("");
      return '<div class="card or-panel"><h3>Sending domains &amp; inboxes</h3>' +
        '<p class="muted" style="margin-top:-4px">Each inbox warms on its own ramp. Keep volume low until every inbox is green; paused inboxes are auto-held when bounce climbs.</p>' +
        (rows || '<div class="empty">No domains.</div>') + "</div>";
    }

    function linkedinPanel(li) {
      var rows = (li.list || []).map(function (a) {
        return '<div class="or-li"><div class="or-li-h"><b>' + esc(a.handle) + "</b>" + pill(a.state) +
          '<span class="or-mini">' + a.warmupPct + "% warmed</span></div>" +
          '<div class="or-bar">' + '<span class="' + (a.state === "ready" ? "ready" : a.state === "action" ? "action" : "warming") + '" style="width:' + a.warmupPct + '%"></span></div>' +
          '<div class="or-mini" style="margin-top:6px">' + (a.limits.connects || 0) + " connects · " + (a.limits.dms || 0) + " DMs · " + (a.limits.profileViews || 0) + " views / day</div>" +
          (a.issue ? '<div class="or-issue">' + esc(a.issue) + "</div>" : "") + "</div>";
      }).join("");
      return '<div class="card or-panel"><h3>LinkedIn accounts</h3>' +
        '<p class="muted" style="margin-top:-4px">Daily limits ramp automatically as each account warms. Flagged accounts are paused until they recover.</p>' +
        (rows || '<div class="empty">No accounts.</div>') + "</div>";
    }

    function playbook() {
      var phases = REF.phases.map(function (p) {
        return '<div class="phase"><div class="phase-h"><span class="phase-n">' + p.n + "</span><h4>" + esc(p.title) + '</h4><span class="phase-time">' + esc(p.time) + "</span></div>" +
          "<ul>" + p.items.map(function (i) { return "<li>" + esc(i) + "</li>"; }).join("") + "</ul>" +
          '<div class="done">✓ Done when: ' + esc(p.done) + "</div></div>";
      }).join("");
      var touches = REF.touches.map(function (t) {
        return '<div class="touch"><div class="day">Day ' + t.day + '</div><div><div class="tn">' + esc(t.name) +
          '<span class="chip-c">' + esc(t.channel) + "</span></div>" +
          '<div class="ti">' + esc(t.intent) + (t.constraints ? ' <span class="spark">(' + esc(t.constraints) + ")</span>" : "") + "</div></div></div>";
      }).join("");
      return '<details class="or-playbook"><summary>Deployment playbook, 7 phases &amp; the 28-day sequence</summary>' +
        '<div class="two-col" style="margin-top:14px"><div><h3 style="margin-bottom:10px">Deploy a campaign</h3>' + phases + "</div>" +
        '<div><div class="card"><h3>Sequence anatomy (28 days)</h3>' + touches + "</div>" +
        '<div class="card" style="margin-top:14px"><h3>Decision rules</h3><ul class="phase" style="border:0;padding:0;margin:0">' +
        REF.seqRules.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul></div></div></div></details>";
    }
  }

  /* ---------------- LinkedIn Automation ----------------
     Drives the LinkedIn cadence engine from the portal: enroll prospects into
     account-safe sequences, run the cadence on demand, and watch every touch
     (connect, message, follow-up) advance through the daily limits. Talks to
     the session-authed /api/automation façade over the engine. */
  var autoState = null; // last /automation snapshot, so the enroll modal can read it

  function renderAutomation(el) {
    el.innerHTML = head("LinkedIn Automation",
      "Enroll prospects into account-safe LinkedIn cadences. The engine paces every touch, connect, message, accept-triggered follow-up, inside each account's daily limits, and pauses the instant someone replies.") +
      '<div class="btn-row" style="margin-bottom:14px">' +
        '<button class="btn btn-primary btn-sm" id="autoEnroll">＋ Enroll a prospect</button>' +
        '<button class="btn btn-ghost btn-sm" id="autoTick">▶ Run cadence now</button>' +
      "</div>" +
      '<div id="autoBody">' + loading() + "</div>";

    $("#autoEnroll").addEventListener("click", function () { openEnrollModal(); });
    $("#autoTick").addEventListener("click", function () {
      var b = $("#autoTick"); b.disabled = true; b.textContent = "Running…";
      send("/automation", "POST", { action: "tick" }).then(function (r) {
        b.disabled = false; b.textContent = "▶ Run cadence now";
        if (r.ok) { toast("Cadence ran · " + (r.data.processed || 0) + " step(s) processed"); load(); }
        else toast("Could not run cadence (" + (r.data.error || r.status) + ")");
      }).catch(function () { b.disabled = false; b.textContent = "▶ Run cadence now"; toast("Could not reach the server."); });
    });

    // Delegated, attached once: #autoBody persists across reloads, so wiring it
    // inside paint() would stack a fresh handler on every reload.
    $("#autoBody").addEventListener("click", function (e) {
      var go = e.target.closest("[data-go]");
      if (go) { location.hash = go.getAttribute("data-go"); return; }
      var act = e.target.closest("[data-enr-act]"); if (!act) return;
      var id = act.getAttribute("data-enr"), action = act.getAttribute("data-enr-act");
      act.disabled = true;
      send("/automation", "POST", { action: action, enrollmentId: id }).then(function (r) {
        if (r.ok) { toast(action === "stop" ? "Enrollment stopped" : "Enrollment resumed"); load(); }
        else { act.disabled = false; toast("Could not " + action + " (" + (r.data.error || r.status) + ")"); }
      }).catch(function () { act.disabled = false; toast("Could not reach the server."); });
    });

    load();

    function load() {
      api("/automation").then(function (d) { autoState = d || {}; paint(); })
        .catch(function () { var b = $("#autoBody"); if (b) b.innerHTML = needsSetup(); });
    }

    function paint() {
      var body = $("#autoBody"); if (!body) return;
      var s = autoState.stats || {};
      var statCells = [
        ["Connected accounts", s.accounts || 0, "accounts"],
        ["Active enrollments", s.active || 0],
        ["Replied (handed off)", s.replied || 0, "response"],
        ["Completed", s.completed || 0],
        ["Invites/day", s.invitesPerDay || 0, "accounts"]
      ].map(function (k) {
        var go = k[2] && (!ROUTES[k[2]] || !ROUTES[k[2]].cap || can(ROUTES[k[2]].cap)) ? ' data-go="' + k[2] + '"' : "";
        return '<div class="stat' + (go ? " clickable" : "") + '"' + go + '><div class="sv">' + k[1] + '</div><div class="sl">' + esc(k[0]) + "</div></div>";
      }).join("");

      body.innerHTML =
        '<div class="stat-grid" style="margin-bottom:18px">' + statCells + "</div>" +
        '<div class="two-col">' +
          '<div class="card"><h3>Live enrollments</h3>' + enrollmentsHtml() + "</div>" +
          '<div><div class="card"><h3>Sending accounts</h3>' + accountsHtml() + "</div>" +
          '<div class="card" style="margin-top:14px"><h3>Cadences</h3>' + sequencesHtml() + "</div></div>" +
        "</div>" +
        '<div class="card" style="margin-top:18px"><h3>Recent activity</h3>' + eventsHtml() + "</div>";
    }

    function enrollmentsHtml() {
      var list = autoState.enrollments || [];
      if (!list.length) {
        return '<div class="empty">No one enrolled yet. Click ＋ Enroll a prospect to start an account-safe LinkedIn cadence.</div>';
      }
      return list.map(function (e) {
        var step = (e.currentStepOrder || 0) + (e.totalSteps ? " / " + e.totalSteps : "");
        var next = e.status === "active" && e.nextRunAt ? "Next: " + fmtWhen(e.nextRunAt) : autoEnrStatusLabel(e.status);
        var canStop = e.status === "active" || e.status === "paused_replied";
        var btn = canStop
          ? '<button class="resp-btn ghost" data-enr-act="stop" data-enr="' + esc(e.id) + '">Stop</button>'
          : (e.status === "stopped" ? '<button class="resp-btn" data-enr-act="resume" data-enr="' + esc(e.id) + '">Resume</button>' : "");
        return '<div class="list-row"><span class="avatar" style="width:28px;height:28px;font-size:11px;background:' + colorFor(e.prospectName) + '">' + esc(initials(e.prospectName || "?")) + "</span>" +
          '<div><div class="lr-main">' + esc(e.prospectName || e.prospectId) + (e.company ? ' <span class="muted" style="font-weight:400">· ' + esc(e.company) + "</span>" : "") + "</div>" +
          '<div class="lr-sub">' + esc(e.sequenceName || "Sequence") + " · step " + esc(step) + "</div></div>" +
          '<span class="cls cls-' + autoEnrCls(e.status) + '" style="margin-left:auto">' + esc(autoEnrStatusLabel(e.status)) + "</span>" +
          '<div class="lr-right" style="min-width:120px;text-align:right">' + esc(next) + " " + btn + "</div></div>";
      }).join("");
    }

    function accountsHtml() {
      var list = autoState.accounts || [];
      if (!list.length) {
        return '<div class="empty">No LinkedIn sending accounts yet. Connect one under <a href="#accounts">Accounts</a> to enroll prospects.</div>';
      }
      return list.map(function (a) {
        var lim = a.limits || {};
        return '<div class="list-row"><div><div class="lr-main">' + esc(a.displayName) + '</div>' +
          '<div class="lr-sub">' + (lim.invitesPerDay || 0) + " invites · " + (lim.messagesPerDay || 0) + " msgs · " + (lim.profileViewsPerDay || 0) + " views /day</div></div>" +
          '<span class="cls cls-' + autoAcctCls(a.status) + '" style="margin-left:auto">' + esc(a.status) + "</span></div>";
      }).join("");
    }

    function sequencesHtml() {
      var list = autoState.sequences || [];
      if (!list.length) return '<div class="empty">No cadences yet.</div>';
      return list.map(function (sq) {
        var steps = (sq.steps || []).slice().sort(function (a, b) { return a.order - b.order; })
          .map(function (st) { return esc(autoActionLabel(st.action)); }).join(" → ");
        return '<div class="list-row"><div><div class="lr-main">' + esc(sq.name) + '</div>' +
          '<div class="lr-sub">' + steps + "</div></div>" +
          '<div class="lr-right">' + (sq.steps || []).length + " steps</div></div>";
      }).join("");
    }

    function eventsHtml() {
      var list = autoState.events || [];
      if (!list.length) return '<div class="empty">No activity yet. Enroll a prospect, then Run cadence now to fire the first touch.</div>';
      return list.slice(0, 20).map(function (ev) {
        var what = autoKindLabel(ev.kind) + (ev.action ? " · " + autoActionLabel(ev.action) : "");
        return '<div class="list-row"><div class="lr-main">' + esc(what) + "</div>" +
          '<div class="lr-right">' + esc(fmtWhen(ev.at)) + "</div></div>";
      }).join("");
    }

    function openEnrollModal() {
      var st = autoState || {};
      var accts = st.accounts || [], seqs = st.sequences || [], pros = st.prospects || [];
      if (!accts.length) { toast("Connect a LinkedIn account under Accounts first."); location.hash = "accounts"; return; }
      if (!pros.length) { toast("Add a prospect first."); location.hash = "prospects"; return; }
      var prosOpts = pros.map(function (p) {
        var tag = p.enrolled ? " (enrolled)" : (p.hasLinkedin ? "" : " (no LinkedIn URL)");
        return '<option value="' + esc(p.id) + '"' + (p.enrolled ? " disabled" : "") + ">" + esc(p.fullName) + (p.company ? " · " + esc(p.company) : "") + esc(tag) + "</option>";
      }).join("");
      var seqOpts = seqs.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.name) + "</option>"; }).join("");
      var acctOpts = accts.map(function (a) {
        return '<option value="' + esc(a.id) + '"' + (a.status === "ok" || a.status === "warming" ? "" : " disabled") + ">" + esc(a.displayName) + " (" + esc(a.status) + ")</option>";
      }).join("");
      var bodyHtml =
        "<label>Prospect</label><select id=\"enrPros\">" + prosOpts + "</select>" +
        "<label>Cadence</label><select id=\"enrSeq\">" + seqOpts + "</select>" +
        "<label>Sending account</label><select id=\"enrAcct\">" + acctOpts + "</select>" +
        '<div class="imp-preview">The first step runs on the next cadence tick, then the engine paces the rest within this account\'s daily limits.</div>' +
        '<div class="modal-foot"><button class="btn btn-ghost btn-sm" id="enrCancel">Cancel</button>' +
        '<button class="btn btn-primary btn-sm" id="enrGo">Enroll</button></div>';
      openModal("Enroll into a LinkedIn cadence", "Pick who to reach, the cadence, and which account sends.", bodyHtml, function (root, close) {
        root.querySelector("#enrCancel").addEventListener("click", close);
        root.querySelector("#enrGo").addEventListener("click", function () {
          var prospectId = root.querySelector("#enrPros").value;
          var sequenceId = root.querySelector("#enrSeq").value;
          var accountId = root.querySelector("#enrAcct").value;
          if (!prospectId || !sequenceId || !accountId) { toast("Pick a prospect, cadence and account."); return; }
          var go = root.querySelector("#enrGo"); go.disabled = true; go.textContent = "Enrolling…";
          send("/automation", "POST", { action: "enroll", prospectId: prospectId, sequenceId: sequenceId, accountId: accountId })
            .then(function (r) {
              if (r.ok) { toast("Enrolled · cadence starts on the next tick"); close(); load(); }
              else { go.disabled = false; go.textContent = "Enroll"; toast("Could not enroll (" + (r.data.error || r.status) + ")"); }
            }).catch(function () { go.disabled = false; go.textContent = "Enroll"; toast("Could not reach the server."); });
        });
      });
    }
  }

  // enrollment + engine vocabulary, mapped onto the shared classification colors
  function autoEnrCls(s) { var m = { active: "soft_yes", paused_replied: "positive", completed: "unclassified", stopped: "stop", failed: "not_interested" }; return m[s] || "unclassified"; }
  function autoEnrStatusLabel(s) { var m = { active: "Active", paused_replied: "Replied", completed: "Completed", stopped: "Stopped", failed: "Failed" }; return m[s] || s; }
  function autoAcctCls(s) { var m = { ok: "positive", warming: "timing_objection", restricted: "not_interested", disconnected: "stop" }; return m[s] || "unclassified"; }
  function autoActionLabel(a) { var m = { profile_view: "Profile view", endorse: "Endorse", connect: "Connect", message: "Message", inmail: "InMail", voice_note: "Voice note", withdraw_invite: "Withdraw invite" }; return m[a] || a; }
  function autoKindLabel(k) { var m = { step_sent: "Step sent", step_deferred: "Step deferred", step_failed: "Step failed", invite_accepted: "Invite accepted", reply_received: "Reply received", reply_classified: "Reply classified", sequence_completed: "Sequence completed", enrollment_paused: "Paused", enrollment_stopped: "Stopped" }; return m[k] || k; }
  // Compact relative/absolute timestamp for cadence schedule + activity.
  function fmtWhen(iso) {
    if (!iso) return "";
    var t = Date.parse(iso); if (isNaN(t)) return "";
    var diff = t - Date.now(), abs = Math.abs(diff), mins = Math.round(abs / 60000);
    if (mins < 1) return "now";
    var s = mins < 60 ? mins + "m" : mins < 1440 ? Math.round(mins / 60) + "h" : Math.round(mins / 1440) + "d";
    return diff >= 0 ? "in " + s : s + " ago";
  }

  /* ---------------- Campaign Sequences Library ----------------
     The master list of every sequence in the workspace (table layout). Shares
     one store (ros_sequences + /api/sequences) with Campaigns (which creates
     them) and Campaign Studio (which drops + assigns them), so all three work
     off the same data. Create / Edit here open the same channel editor. */
  function newSequenceFlow() {
    openModal("New sequence", "Pick a channel to build.",
      '<div class="seq-new-grid">' + Object.keys(CHANNELS).map(function (ch) {
        var c = CHANNELS[ch];
        return '<button class="seq-new" data-ch="' + ch + '"><span class="seq-new-ic">' + c.icon + "</span>" +
          '<span class="seq-new-t">' + c.label + " sequence</span><span class=\"seq-new-b\">" + esc(c.blurb) + "</span></button>";
      }).join("") + "</div>",
      function (root, close) {
        root.querySelector(".seq-new-grid").addEventListener("click", function (e) {
          var b = e.target.closest("[data-ch]"); if (!b) return;
          close(); openEditor(newSequence(b.getAttribute("data-ch")));
        });
      });
  }

  function renderContent(el) {
    var store = seqStore();
    var meName = (ctx.user && ctx.user.name) || "You";
    var filter = "", mineOnly = false, tagFilter = "", ownerFilter = "";
    function fmtDate(iso) { try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); } catch (e) { return ""; } }
    function allTags() { var set = {}; store.all().forEach(function (s) { (s.tags || []).forEach(function (t) { set[t] = 1; }); }); return Object.keys(set).sort(); }
    // Every recruiter who owns a sequence in this motion, drives the owner filter
    // so an admin can pull up all campaigns set up by any one recruiter.
    function allOwners() {
      var set = {};
      store.all().forEach(function (s) { if ((!s.motion || s.motion === motion) && s.owner) set[s.owner] = 1; });
      return Object.keys(set).sort();
    }

    el.innerHTML = head("Sequences", "Every " + (motion === "bd" ? "BD" : "recruiting") + " campaign your recruiters set up lands here, one shared workspace library. Build in Campaigns, then assign + deploy in Campaign Studio.") +
      '<div class="seqlib-tools">' +
        '<button class="sl-fbtn" id="slMine"><span>👤</span> My Sequences</button>' +
        '<span class="sl-tagwrap"><button class="sl-fbtn" id="slOwnerBtn"><span>🧑‍💼</span> Recruiter <b id="slOwnerLbl"></b></button>' +
          '<select id="slOwner" class="sl-tagsel"><option value="">All recruiters</option></select></span>' +
        '<span class="sl-tagwrap"><button class="sl-fbtn" id="slTagBtn"><span>🏷</span> Tags <b id="slTagLbl"></b></button>' +
          '<select id="slTag" class="sl-tagsel"><option value="">All tags</option></select></span>' +
        '<label class="seqlib-search"><span>⌕</span><input id="slSearch" placeholder="Search…" autocomplete="off"/></label>' +
        '<span class="sl-count" id="slCount"></span>' +
      "</div>" +
      '<div id="slBody">' + loading() + "</div>" +
      '<div id="slVoice" style="margin-top:18px"></div>';

    $("#slSearch").addEventListener("input", function () { filter = (this.value || "").toLowerCase().trim(); paint(); });
    $("#slMine").addEventListener("click", function () { mineOnly = !mineOnly; this.classList.toggle("active", mineOnly); if (mineOnly) { ownerFilter = ""; var os = $("#slOwner"); if (os) os.value = ""; $("#slOwnerBtn").classList.remove("active"); var ol = $("#slOwnerLbl"); if (ol) ol.textContent = ""; } paint(); });
    var ownerSel = $("#slOwner");
    ownerSel.addEventListener("change", function () { ownerFilter = this.value; var lbl = $("#slOwnerLbl"); if (lbl) lbl.textContent = ownerFilter ? "· " + ownerFilter : ""; $("#slOwnerBtn").classList.toggle("active", !!ownerFilter); if (ownerFilter) { mineOnly = false; $("#slMine").classList.remove("active"); } paint(); });
    $("#slOwnerBtn").addEventListener("click", function () { try { ownerSel.focus(); ownerSel.click(); } catch (e) {} });
    var tagSel = $("#slTag");
    tagSel.addEventListener("change", function () { tagFilter = this.value; var lbl = $("#slTagLbl"); if (lbl) lbl.textContent = tagFilter ? "· " + tagFilter : ""; $("#slTagBtn").classList.toggle("active", !!tagFilter); paint(); });
    $("#slTagBtn").addEventListener("click", function () { try { tagSel.focus(); tagSel.click(); } catch (e) {} });

    function syncTagOptions() {
      var tags = allTags();
      tagSel.innerHTML = '<option value="">All tags</option>' + tags.map(function (t) { return '<option value="' + esc(t) + '"' + (t === tagFilter ? " selected" : "") + ">" + esc(t) + "</option>"; }).join("");
      var owners = allOwners();
      ownerSel.innerHTML = '<option value="">All recruiters</option>' + owners.map(function (o) { return '<option value="' + esc(o) + '"' + (o === ownerFilter ? " selected" : "") + ">" + esc(o) + "</option>"; }).join("");
    }
    function matchesF(s) {
      // Scope to the active motion (Recruiting / BD), like the rest of the app.
      // Legacy sequences with no motion stay visible in both.
      if (s.motion && s.motion !== motion) return false;
      if (mineOnly && (s.owner || "") !== meName) return false;
      if (ownerFilter && (s.owner || "") !== ownerFilter) return false;
      if (tagFilter && (s.tags || []).indexOf(tagFilter) < 0) return false;
      if (!filter) return true;
      return ((s.name || "") + " " + (s.owner || "") + " " + (s.tags || []).join(" ") + " " + (s.channel || "")).toLowerCase().indexOf(filter) >= 0;
    }
    function emptyCreate(msg) {
      return '<div class="card" style="text-align:center;padding:34px 22px">' +
        '<p class="muted" style="margin-bottom:18px">' + msg + "</p>" +
        '<div class="seq-new-grid" id="slCreate" style="max-width:760px;margin:0 auto">' +
        Object.keys(CHANNELS).map(function (ch) { var c = CHANNELS[ch]; return '<button class="seq-new" data-ch="' + ch + '"><span class="seq-new-ic">' + c.icon + "</span><span class=\"seq-new-t\">" + c.label + " sequence</span><span class=\"seq-new-b\">" + esc(c.blurb) + "</span></button>"; }).join("") +
        "</div></div>";
    }
    function paint() {
      var list = store.all();
      // Sequences in the active motion (the Library is motion-scoped, like the
      // rest of the app). Legacy no-motion sequences count toward the current one.
      var inMotion = list.filter(function (s) { return !s.motion || s.motion === motion; });
      var body = $("#slBody"); if (!body) return;
      syncTagOptions();
      var rows = list.filter(matchesF).sort(function (a, b) { return (b.updatedAt || "") < (a.updatedAt || "") ? -1 : 1; });
      var cn = $("#slCount"); if (cn) cn.textContent = rows.length + " of " + inMotion.length;
      if (!inMotion.length) { body.innerHTML = emptyCreate("No " + (motion === "bd" ? "BD" : "recruiting") + " sequences yet, pick a channel to build your first one. It'll appear here and in Campaign Studio."); wireCreate(); return; }
      if (!rows.length) { body.innerHTML = '<div class="empty">No sequences match that filter.</div>'; return; }
      var trs = rows.map(function (s) {
        var c = CHANNELS[s.channel] || CHANNELS.email;
        var n = (s.steps || []).length;
        var tags = (s.tags || []).map(function (t) { return '<span class="sl-tag">' + esc(t) + "</span>"; }).join("") || '<span class="muted">-</span>';
        var active = s.status === "active";
        var chip = '<span class="seq-chip ' + s.channel + '">' + (c.icon ? c.icon + " " : "") + c.label + "</span>";
        if (s.channel === "multi") {
          var mix = {};
          (s.steps || []).forEach(function (st) { var k = st.channel || "email"; mix[k] = 1; });
          var icons = Object.keys(mix).map(function (k) { return (CHANNELS[k] || {}).icon || ""; }).join(" ");
          chip += ' <span class="muted" style="font-size:11px">' + icons + "</span>";
        }
        return '<tr data-id="' + esc(s.id) + '">' +
          '<td class="sl-name">' + chip + " " + esc(s.name) + "</td>" +
          "<td>" + esc(s.owner || "-") + "</td>" +
          '<td class="sl-c">' + n + "</td>" +
          "<td>" + tags + "</td>" +
          '<td><button class="sl-status ' + (active ? "on" : "off") + '" data-status="' + esc(s.id) + '">' + (active ? "● Active" : "● Inactive") + "</button></td>" +
          '<td class="muted">' + esc(fmtDate(s.createdAt)) + "</td>" +
          '<td class="sl-actions"><button class="btn btn-ghost btn-sm" data-edit="' + esc(s.id) + '">Edit</button>' +
            '<button class="btn btn-ghost btn-sm" data-dup="' + esc(s.id) + '">Duplicate</button>' +
            '<button class="btn btn-ghost btn-sm" data-go="campaigns/deploy" title="Assign + deploy">Deploy</button>' +
            '<button class="btn btn-ghost btn-sm sl-del" data-del="' + esc(s.id) + '" title="Delete this sequence">Delete</button></td></tr>';
      }).join("");
      body.innerHTML = '<div class="card" style="padding:0;overflow:auto"><table class="seqlib"><thead><tr>' +
        "<th>Sequence</th><th>Owner</th><th>Steps</th><th>Tags</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead><tbody>" + trs + "</tbody></table></div>";
      Array.prototype.forEach.call(body.querySelectorAll("[data-edit]"), function (b) {
        b.addEventListener("click", function () { var s = store.all().filter(function (x) { return x.id === b.getAttribute("data-edit"); })[0]; if (s) openEditor(s); });
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-go]"), function (b) {
        b.addEventListener("click", function () { location.hash = b.getAttribute("data-go"); });
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-dup]"), function (b) {
        b.addEventListener("click", function () {
          var s = store.all().filter(function (x) { return x.id === b.getAttribute("data-dup"); })[0]; if (!s) return;
          var copy = JSON.parse(JSON.stringify(s));
          copy.id = "seq_" + Date.now(); copy.name = "Copy of " + s.name; copy.status = "inactive"; copy.owner = meName;
          copy.createdAt = new Date().toISOString(); copy.updatedAt = copy.createdAt; delete copy._isNew;
          store.save(copy); toast("Duplicated"); reload();
        });
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-status]"), function (b) {
        b.addEventListener("click", function () {
          var s = store.all().filter(function (x) { return x.id === b.getAttribute("data-status"); })[0]; if (!s) return;
          s.status = (s.status === "active") ? "inactive" : "active"; s.updatedAt = new Date().toISOString();
          store.save(s); reload();
        });
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-del]"), function (b) {
        b.addEventListener("click", function () {
          var id = b.getAttribute("data-del");
          var s = store.all().filter(function (x) { return x.id === id; })[0]; if (!s) return;
          if (!confirm("Delete “" + (s.name || "this sequence") + "”? This removes it from the Library, Campaigns and Campaign Studio for everyone, and can't be undone.")) return;
          var p = store.remove(id); toast("Deleted"); paint(); // instant local removal
          (p && p.then ? p : Promise.resolve()).then(reload); // then reconcile once the server has dropped it
        });
      });
    }
    function wireCreate() {
      var grid = $("#slCreate"); if (!grid) return;
      grid.addEventListener("click", function (e) { var b = e.target.closest("[data-ch]"); if (b) openEditor(newSequence(b.getAttribute("data-ch"))); });
    }
    // One-time starter sequences so the Library + Studio dropdown show the
    // connection on a brand-new (empty) workspace. Guarded so it never
    // re-seeds after the user edits/deletes them. Saved through the shared
    // store, so they appear in Campaigns + Campaign Studio (by name) too.
    function seedExamples() {
      if (localStorage.getItem("ros_seq_seeded")) return;
      try { localStorage.setItem("ros_seq_seeded", "1"); } catch (e) {}
      var now = new Date().toISOString();
      [["email", "Job-Board Lead Chase", ["job board"], "active"],
       ["linkedin", "Connect → Signal Nurture", ["sourcing"], "inactive"],
       ["sms", "Post-Reply Booking", ["hot"], "active"]].forEach(function (e, i) {
        store.save({ id: "seq_ex" + Date.now() + i, channel: e[0], name: e[1], tags: e[2], status: e[3],
          motion: motion === "bd" ? "bd" : "recruiting", owner: meName, variables: [], steps: seqTemplate(e[0]),
          createdAt: now, updatedAt: now });
      });
    }
    // The generic, industry-agnostic cross-channel template the team builds off
    // of: Email + LinkedIn connect + voicemail drop in one cadence. Stable id so
    // every browser converges on one record (no duplicates); own guard so a
    // user who deletes it won't see it re-seed. Saved through the shared store,
    // so it shows in the Library, Campaigns and Campaign Studio alike.
    function seedTemplate() {
      // Self-healing cleanup: earlier we seeded a Recruiting AND a BD copy of
      // each template, which showed as two identical Library rows. Drop the
      // redundant BD copies wherever they still linger. Runs every load (cheap)
      // so it converges even if a stale browser re-pushes one.
      ["seq_tpl_multichannel_bd", "seq_tpl_specialist_bd"].forEach(function (id) {
        if (store.all().some(function (s) { return s.id === id; })) store.remove(id);
      });

      // One-time migration: these templates belong to the BD motion, not
      // Recruiting. Flip any existing recruiting-seeded copy over to BD (guarded
      // so it won't fight a deliberate later change).
      if (!localStorage.getItem("ros_seq_tpl_bdmove")) {
        try { localStorage.setItem("ros_seq_tpl_bdmove", "1"); } catch (e) {}
        ["seq_tpl_multichannel", "seq_tpl_specialist"].forEach(function (id) {
          var s = store.all().filter(function (x) { return x.id === id; })[0];
          if (s && s.motion !== "bd") { s.motion = "bd"; s.updatedAt = new Date().toISOString(); store.save(s); }
        });
      }

      // Exactly ONE record per template (stable id), seeded under the BD motion.
      var seeds = [
        { id: "seq_tpl_multichannel",
          name: "Multi-channel outreach, Email · LinkedIn · Voicemail",
          tags: ["template", "multi-channel"], steps: seqTemplate("multi") },
        // Job-title + industry specialist cadence, with a LinkedIn voice note AND
        // a cloned-voice voicemail drop built in.
        { id: "seq_tpl_specialist",
          name: "Job-title & industry specialist, Voice Note + Voicemail",
          tags: ["template", "multi-channel", "job title", "industry", "voice"], steps: seqTemplateSpecialist() }
      ];
      if (localStorage.getItem("ros_seq_tpl_multi") === "5") return;
      try { localStorage.setItem("ros_seq_tpl_multi", "5"); } catch (e) {}
      var now = new Date().toISOString();
      seeds.forEach(function (sd) {
        if (store.all().some(function (s) { return s.id === sd.id; })) return;
        store.save({ id: sd.id, channel: "multi", name: sd.name,
          tags: sd.tags, status: "active", motion: "bd",
          owner: IS_HOUSE ? "RecruitersOS Templates" : "Platform Templates", variables: [], steps: sd.steps,
          createdAt: now, updatedAt: now });
      });
    }
    function reload() {
      paint();
      api("/sequences").then(function (d) {
        var server = (d && d.sequences) || [];
        if (server.length) {
          try { localStorage.setItem("ros_sequences", JSON.stringify(server.concat(store.all().filter(function (l) { return !server.some(function (s) { return s.id === l.id; }); })))); } catch (e) {}
        }
        if (!store.all().length) seedExamples();
        seedTemplate();
        paint();
      }).catch(function () { if (!store.all().length) seedExamples(); seedTemplate(); paint(); });
    }
    reload();
    loadVoiceScripts();
  }

  /* Voice Drops scripts inside the Library: reusable cloned-voice voicemails,
     managed here or in the Voice Drops panel, deployable as a "Voice drop" step in
     Campaign Studio. A separate section (not the sequence table) since the data
     shape + editor differ. Talks to /api/voice/scripts. */
  function loadVoiceScripts() {
    var host = $("#slVoice"); if (!host) return;
    host.innerHTML = '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center">' +
      '<h3 style="margin:0">📞 Voice Drops scripts <span class="muted" style="font-size:12px">· reusable cloned-voice voicemails</span></h3>' +
      '<button class="btn btn-sm btn-primary" id="vsNew">＋ New voice script</button></div>' +
      '<div id="vsList" style="margin-top:10px">' + loading() + "</div></div>";
    $("#vsNew").addEventListener("click", function () { voiceScriptModal(null); });
    paintVoiceScripts();
  }
  function paintVoiceScripts() {
    var list = $("#vsList"); if (!list) return;
    api("/voice/scripts?motion=" + motion).then(function (d) {
      var rows = (d && d.scripts) || [];
      if (!rows.length) {
        list.innerHTML = '<p class="muted" style="font-size:13px">No voice scripts yet. Create one here or in the <a href="#voicedrops">Voice Drops</a> panel, then add it to a sequence as a “Voice drop” step in Campaign Studio.</p>';
        return;
      }
      list.innerHTML = '<table class="seqlib"><thead><tr><th>Script</th><th>Preview</th><th>Length</th><th>Actions</th></tr></thead><tbody>' +
        rows.map(function (s) {
          var dot = s.withinSweetSpot ? "#34d399" : "#ffc24d";
          return "<tr><td class=\"sl-name\"><span class=\"seq-chip\" style=\"background:#2a2440;color:#b9a6ff\">Voice</span> " + esc(s.name) + "</td>" +
            '<td class="muted" style="max-width:340px">' + esc((s.preview || "").slice(0, 90)) + "…</td>" +
            '<td><span style="color:' + dot + '">~' + (s.estSeconds || 0) + "s</span></td>" +
            '<td class="sl-actions"><button class="btn btn-ghost btn-sm" data-vsedit="' + esc(s.id) + '">Edit</button>' +
            '<button class="btn btn-ghost btn-sm" data-vsgo="studio" title="Add as a Voice drop step in Studio">Deploy</button>' +
            '<button class="btn btn-ghost btn-sm" data-vsdel="' + esc(s.id) + '">Delete</button></td></tr>';
        }).join("") + "</tbody></table>";
      Array.prototype.forEach.call(list.querySelectorAll("[data-vsedit]"), function (b) {
        b.addEventListener("click", function () { var s = rows.filter(function (x) { return x.id === b.getAttribute("data-vsedit"); })[0]; if (s) voiceScriptModal(s); });
      });
      Array.prototype.forEach.call(list.querySelectorAll("[data-vsdel]"), function (b) {
        b.addEventListener("click", function () { send("/voice/scripts?id=" + b.getAttribute("data-vsdel"), "DELETE").then(function () { toast("Deleted"); paintVoiceScripts(); }); });
      });
      Array.prototype.forEach.call(list.querySelectorAll("[data-vsgo]"), function (b) {
        b.addEventListener("click", function () { location.hash = b.getAttribute("data-vsgo"); });
      });
    }).catch(function () { list.innerHTML = '<p class="muted" style="font-size:13px">Voice Drops scripts unavailable.</p>'; });
  }
  function voiceScriptModal(s) {
    var isEdit = !!s;
    var chips = ["first_name", "role", "company", "agent_name", "agent_company"].map(function (f) {
      return '<button type="button" class="btn btn-sm" data-vschip="' + f + '">{' + f + "}</button>";
    }).join(" ");
    openModal(isEdit ? "Edit voice script" : "New voice script", "First name & role splice in like an email merge. Sweet spot 15-25s.",
      '<input id="vsName" placeholder="Script name" style="width:100%" value="' + esc(isEdit ? s.name : "") + '"/>' +
      '<div style="margin:8px 0">' + chips + "</div>" +
      '<textarea id="vsTpl" rows="4" style="width:100%">' + esc(isEdit ? s.template : VD_DEFAULT_SCRIPT) + "</textarea>" +
      VD_PAUSE_GUIDE +
      // Ring a real landline/VoIP you control with this script so you can pick up,
      // let it roll to voicemail, and confirm the drop actually lands. Uses the
      // same /voice/test-drop path as the Voice Drops Test tab: skips the calling
      // window for the manual test, every other safeguard stays on.
      '<div style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.07)">' +
      '<label style="display:block;font-size:12px;color:#8aa0c6;margin-bottom:4px">Test it on a real phone <span style="color:#6b7a99">- landline or VoIP number you control (E.164), let it roll to voicemail to check the drop</span></label>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
      '<input id="vsTestTo" type="tel" placeholder="+13105551234" style="flex:1;min-width:180px" />' +
      '<button class="btn btn-sm" id="vsTestCall">📞 Test call</button></div>' +
      '<div class="muted" id="vsTestOut" style="font-size:12px;margin-top:6px"></div></div>' +
      '<div class="modal-foot" style="margin-top:10px"><button class="btn btn-primary btn-sm" id="vsSave">Save to Library</button></div>',
      function (root, close) {
        Array.prototype.forEach.call(root.querySelectorAll("[data-vschip]"), function (b) {
          b.addEventListener("click", function () {
            var ta = $("#vsTpl", root); var ins = "{" + b.getAttribute("data-vschip") + "}";
            var p = ta.selectionStart || ta.value.length;
            ta.value = ta.value.slice(0, p) + ins + ta.value.slice(ta.selectionEnd || p); ta.focus();
          });
        });
        $("#vsTestCall", root).addEventListener("click", function () {
          var tpl = ($("#vsTpl", root).value || "").trim();
          var to = ($("#vsTestTo", root).value || "").trim();
          if (!tpl) { toast("Write a script first"); return; }
          if (!to) { toast("Enter a landline/VoIP number to test"); return; }
          var out = $("#vsTestOut", root); if (out) out.innerHTML = loading();
          send("/voice/test-drop", "POST", { to: to, scriptTemplate: tpl, motion: motion }).then(function (r) {
            if (!out) return;
            if (!r.ok) { out.innerHTML = '<span style="color:#ff7a90">Test failed: ' + esc((r.data && r.data.detail) || (r.data && r.data.error) || r.status) + "</span>"; return; }
            var d = r.data || {};
            out.innerHTML = '<b style="color:#34d399">Rendered (~' + d.estSeconds + "s" +
              (d.withinSweetSpot ? ", in the 15-25s sweet spot" : ", outside sweet spot") + "):</b> “" + esc(d.rendered || "") + "” · " +
              (d.dryRun ? "dry-run (no Telnyx/clone keys, nothing dialed)" : "dialing " + esc(d.callControlId || "")) +
              ((d.warnings && d.warnings.length) ? ' · <span style="color:#ffc24d">⚠ ' + d.warnings.map(esc).join(" · ") + "</span>" : "");
          }).catch(function () { if (out) out.innerHTML = '<span style="color:#ff7a90">Could not reach the server.</span>'; });
        });
        $("#vsSave", root).addEventListener("click", function () {
          var name = ($("#vsName", root).value || "").trim();
          var tpl = ($("#vsTpl", root).value || "").trim();
          if (!name || !tpl) { toast("Name + script required"); return; }
          var payload = { name: name, template: tpl, motion: motion };
          if (isEdit) payload.id = s.id;
          send("/voice/scripts", "PUT", payload).then(function (r) { close(); if (r.ok) { toast("Saved to Library"); paintVoiceScripts(); } else toast("Save failed"); });
        });
      });
  }

  /* ---------------- Analytics (signal → placement, live) ---------------- */
  // The operational dashboard the marketing site promises: which signals create
  // meetings, which channels and messages earn replies, which industries and
  // recruiters convert, and the full funnel end to end. Motion-aware: recruiting
  // measures placements, BD measures job orders. Reads /analytics, renders from
  // the local seed when no backend is connected.
  // Stage buckets for the live pipeline funnel. Status vocabularies differ
  // between the local shim (queued/discovery_booked/placed) and the real backend
  // (new/booked/won), so each bucket lists every synonym it should count.
  var FN_CONTACTED = ["in_sequence", "contacted", "replied", "discovery_booked", "booked", "meeting", "won", "placed", "nurture"];
  var FN_REPLIED = ["replied", "discovery_booked", "booked", "meeting", "won", "placed"];
  var FN_MEETING = ["discovery_booked", "booked", "meeting", "won", "placed"];
  var FN_WON = ["won", "placed"];

  // Normalizers that read either response shape (real backend nests under
  // inbound/classification; the local shim is flat).
  function rChannel(p) { return (p.inbound && p.inbound.channel) || p.channel || "other"; }
  function rClass(p) { return (p.classification && p.classification.class) || p.cls || "unclassified"; }

  // Spending scenario planner, a live what-if cost model anyone can play with.
  // The model + UI live in the self-contained spending-calc.js module so the
  // underlying tools stay generic (no vendor names exposed here).
  function renderSpending(el) {
    if (!window.SpendingCalc) { el.innerHTML = '<div class="empty">Spending module did not load, refresh and try again.</div>'; return; }
    // Recruiting motion models the AI Vetting tool (cloned voice + telephony per
    // hour); BD keeps the full outreach scenario planner. Same look either way.
    if (motion === "recruiting" && window.SpendingCalc.mountVetting) window.SpendingCalc.mountVetting(el);
    else window.SpendingCalc.mount(el);
  }

  function renderAnalytics(el) {
    var detail = currentDetail();
    if (detail) return renderAnalyticsDetail(el, detail);
    var bd = motion === "bd";
    el.innerHTML = head("Analytics",
      "A live operational view of the whole motion, from signal to " + (bd ? "job order" : "placement") +
      ". KPIs, funnel, channels and appointments are computed from your live workspace; benchmark cards layer in once an analytics source is connected.") +
      '<div class="an-tools" style="display:flex;align-items:center;gap:12px;margin-bottom:14px">' +
        '<span style="display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600">' +
          '<span style="width:8px;height:8px;border-radius:50%;background:var(--accent-green);box-shadow:0 0 0 0 rgba(56,224,166,.6);animation:anPulse 2s infinite"></span>Live</span>' +
        '<span id="anUpdated" class="muted" style="font-size:12px"></span>' +
        '<span style="flex:1"></span>' +
        '<button class="btn btn-ghost btn-sm" id="anRefresh">↻ Refresh</button>' +
      "</div>" +
      '<style>@keyframes anPulse{0%{box-shadow:0 0 0 0 rgba(56,224,166,.55)}70%{box-shadow:0 0 0 7px rgba(56,224,166,0)}100%{box-shadow:0 0 0 0 rgba(56,224,166,0)}}</style>' +
      '<div id="anBody">' + loading() + "</div>";

    // Horizontal bar chart: rows scaled so the largest value fills the track.
    function bars(items, suffix) {
      items = items || [];
      var max = items.reduce(function (mx, it) { return Math.max(mx, it.pct); }, 0) || 1;
      return items.map(function (it) {
        var w = Math.max(Math.round((it.pct / max) * 100), 8);
        return '<div class="bar-row"><span class="blabel">' + esc(it.label) + '</span>' +
          '<span class="btrack"><span class="bfill" style="width:' + w + '%">' + esc(it.pct) + (suffix || "") + "</span></span></div>";
      }).join("") || '<div class="empty">No data yet.</div>';
    }
    // Tag a card title as live-computed or a curated benchmark.
    function tag(kind) {
      return kind === "live"
        ? ' <span style="font-size:10.5px;font-weight:700;color:var(--accent-green);vertical-align:middle">● LIVE</span>'
        : ' <span class="muted" style="font-size:10.5px;font-weight:700;vertical-align:middle">BENCHMARK</span>';
    }
    function notConnected(what) {
      return '<div class="empty">No ' + esc(what) + " yet. Connect an analytics source (or let campaign data accrue) and this fills in.</div>";
    }
    // A subtle "see who →" link in a card header that opens the matching drill-down.
    function anMore(slug) {
      return ' <a class="an-more clickable" data-go="analytics/' + slug + '" style="float:right;font-size:11.5px;font-weight:700">See who →</a>';
    }
    function tally(list, keyFn, labelFn) {
      var counts = {}, total = list.length;
      list.forEach(function (x) { var k = keyFn(x); counts[k] = (counts[k] || 0) + 1; });
      return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).map(function (k) {
        return { label: labelFn ? labelFn(k) : k, pct: total ? Math.round((counts[k] / total) * 100) : 0 };
      });
    }

    var first = true;

    function load() {
      // Pull live operational data + (optional) curated benchmarks in parallel.
      // Each call degrades to null so one missing endpoint never blanks the page.
      Promise.all([
        api("/overview").catch(function () { return null; }),
        api("/prospects").catch(function () { return null; }),
        api("/response/list").catch(function () { return null; }),
        api("/analytics").catch(function () { return null; })
      ]).then(function (res) {
        var body = $("#anBody"); if (!body) return;
        var ov = res[0] || {};
        var prospects = (res[1] && res[1].prospects) || [];
        var replies = (res[2] && res[2].items) || [];
        var curated = ((res[3] || {})[bd ? "bd" : "recruiting"]) || {};

        if (!ov.activeProspects && !prospects.length && !replies.length) {
          body.innerHTML = needsSetup(); return;
        }

        // KPIs, live from /overview (same shape in shim + real backend).
        // Period/performance KPIs only, no "today" counts (those live on the
        // Dashboard). Positive-reply rate is computed live from the inbox.
        var hotReplies = replies.filter(function (r) { var c = rClass(r); return c === "positive" || c === "referral"; }).length;
        var positiveRate = replies.length ? Math.round((hotReplies / replies.length) * 100) : 0;
        // Each KPI drills into a full who's-who sub-view (#analytics/<slug>).
        var kpiDefs = [
          { v: ov.activeProspects || 0, l: "Active prospects", s: "in sequence", go: "active-prospects" },
          { v: ov.appointmentsThisWeek || 0, l: "Meetings this week", s: "qualified meetings", go: "meetings" },
          { v: positiveRate + "%", l: "Positive reply rate", s: hotReplies + " of " + replies.length + " replies", go: "warm-conversations" },
          { v: ov.wonAccounts || 0, l: bd ? "Won accounts" : "Placements", s: "closed this period", go: "won" }
        ];
        var kpis = kpiDefs.map(function (k) {
          return '<div class="rstat clickable" data-go="analytics/' + k.go + '" title="See who these are">' +
            '<div class="big gradient-text">' + esc(k.v) + '</div><div class="lbl">' + esc(k.l) + "</div>" +
            '<div class="delta up" style="color:var(--text-dim)">' + esc(k.s) + "</div></div>";
        }).join("");

        // Pipeline funnel, live from /prospects (portable status buckets).
        function cnt(set) { return prospects.filter(function (p) { return set.indexOf(p.status) >= 0; }).length; }
        var fn = [
          { label: "Sourced", value: prospects.length },
          { label: "Contacted", value: cnt(FN_CONTACTED) },
          { label: "Replied", value: cnt(FN_REPLIED) },
          { label: "Meetings", value: cnt(FN_MEETING) },
          { label: bd ? "Won accounts" : "Placements", value: cnt(FN_WON) }
        ];
        var top = fn[0].value || 1;
        var funnel = prospects.length ? fn.map(function (s, i) {
          var w = Math.max(Math.round((s.value / top) * 100), 6);
          var conv = i > 0 && fn[i - 1].value ? Math.round((s.value / fn[i - 1].value) * 100) + "%" : "";
          return '<div class="bar-row"><span class="blabel">' + esc(s.label) + '</span>' +
            '<span class="btrack"><span class="bfill" style="width:' + w + '%">' + esc(s.value) + "</span></span>" +
            '<span class="bval">' + esc(conv) + "</span></div>";
        }).join("") : notConnected("pipeline data");

        // Replies by channel + reply-quality mix, live from /response/list.
        var byChannel = replies.length ? bars(tally(replies, rChannel, function (c) { return c === "sms" ? "SMS" : c.charAt(0).toUpperCase() + c.slice(1); }), "%") : notConnected("replies");
        var byQuality = replies.length ? bars(tally(replies, rClass, clsLabel), "%") : notConnected("replies");

        // Curated benchmark cards (no live source): signal types, industries,
        // message variants, recruiter efficiency. Absent against the real backend
        // until an /analytics source is wired, they show a connect hint then.
        var bySignal = (curated.bySignal && curated.bySignal.length) ? bars(curated.bySignal, "%") : notConnected("signal attribution");
        var industries = (curated.industries && curated.industries.length) ? bars(curated.industries, "%") : notConnected("industry data");
        var variants = (curated.variants || []).map(function (v) {
          return '<div class="list-row"><div><div class="lr-main">' + esc(v.name) + '</div><div class="lr-sub">' +
            esc(v.channel || "") + " · " + (v.sent || 0) + " sent</div></div>" +
            '<div class="lr-right">' + esc(v.reply) + "% reply · " + esc(v.meeting) + "% mtg</div></div>";
        }).join("") || notConnected("message variants tested");
        var winLabel = bd ? "job orders" : "placements";
        var recruiters = (curated.recruiters || []).map(function (r) {
          return '<div class="list-row"><span class="avatar" style="background:' + colorFor(r.name) + '">' + esc(initials(r.name)) + "</span>" +
            '<div><div class="lr-main">' + esc(r.name) + '</div><div class="lr-sub">' + (r.meetings || 0) + " meetings · " + (r.replies || 0) + " replies</div></div>" +
            '<div class="lr-right">' + (r.wins || 0) + " " + winLabel + "</div></div>";
        }).join("") || notConnected("per-recruiter output");

        // Recent appointments, an outcome, so it lives here in Analytics (not on
        // the Dashboard, which tracks only the sending engine).
        var apRowGo = (!ROUTES.prospects.cap || can(ROUTES.prospects.cap)) ? ' data-go="prospects" class="list-row clickable"' : ' class="list-row"';
        var appts = (ov.recentAppointments || []).map(function (ap) {
          return "<div" + apRowGo + '><div><div class="lr-main">' + esc(ap.name) + '</div><div class="lr-sub">' +
            esc(ap.channel || "") + (ap.company ? " · " + esc(ap.company) : "") + "</div></div>" +
            '<div class="lr-right">' + esc(ap.at || "") + "</div></div>";
        }).join("") || '<div class="empty">No appointments booked yet.</div>';

        body.innerHTML =
          '<div class="report-stats">' + kpis + "</div>" +
          '<div class="report-cols">' +
            '<div class="report-card"><h3>' + (bd ? "Signal → job-order funnel" : "Signal → placement funnel") + tag("live") + "</h3>" + funnel + "</div>" +
            '<div class="report-card"><h3>Replies by channel' + tag("live") + "</h3>" + byChannel + "</div>" +
          "</div>" +
          '<div class="two-col" style="margin-top:16px">' +
            '<div class="card"><h3>Reply quality mix' + tag("live") + anMore("warm-conversations") + "</h3>" + byQuality + "</div>" +
            '<div class="card"><h3>Meetings booked by signal type' + tag("benchmark") + "</h3>" + bySignal + "</div>" +
          "</div>" +
          '<div class="two-col" style="margin-top:16px">' +
            '<div class="card"><h3>Best industries by conversion' + tag("benchmark") + "</h3>" + industries + "</div>" +
            '<div class="card"><h3>Top message variants' + tag("benchmark") + "</h3>" + variants + "</div>" +
          "</div>" +
          '<div class="two-col" style="margin-top:16px">' +
            '<div class="card"><h3>Recruiter leaderboard' + tag("benchmark") + "</h3>" + recruiters + "</div>" +
            '<div class="card"><h3>Recent appointments' + tag("live") + anMore("meetings") + "</h3>" + appts + "</div>" +
          "</div>";

        // Delegated navigation: appointment rows jump into the pipeline.
        body.addEventListener("click", function (e) {
          var t = e.target.closest("[data-go]"); if (!t) return;
          location.hash = t.getAttribute("data-go");
        });

        var stamp = $("#anUpdated");
        if (stamp) stamp.textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        first = false;
      }).catch(function () { if (first) { var b = $("#anBody"); if (b) b.innerHTML = needsSetup(); } });
    }

    load();
    var rb = $("#anRefresh"); if (rb) rb.addEventListener("click", load);
    // Auto-refresh every 15s while this view is open; render() clears it on nav.
    viewTimers.push(setInterval(load, 15000));
  }

  // ===== Outreach Statistics =================================================
  // Admin-only deep view: the full send -> reply -> meeting funnel plus the
  // breakdowns that say what's landing and who's responding (message, segment,
  // channel, touch, send-time, deliverability), and a promote-winners panel that
  // pins the best config onto a campaign (with a hands-off auto-pilot toggle).
  function renderOutreachStats(el) {
    var since = "30";   // 7 | 30 | 90 | all
    var chan = "";      // "" | email | linkedin | voice | sms

    function rangeBtns() {
      return [["7", "7d"], ["30", "30d"], ["90", "90d"], ["all", "All"]].map(function (r) {
        return '<button class="btn btn-sm os-range ' + (r[0] === since ? "btn-primary" : "btn-ghost") + '" data-since="' + r[0] + '">' + r[1] + "</button>";
      }).join("");
    }
    function chanSel() {
      return '<select id="osChan" class="os-sel" style="background:var(--surface-2);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:6px 8px;font-size:12.5px">' +
        [["", "All channels"], ["email", "Email"], ["linkedin", "LinkedIn"], ["voice", "Voice"], ["sms", "SMS"]].map(function (c) {
          return '<option value="' + c[0] + '"' + (c[0] === chan ? " selected" : "") + ">" + c[1] + "</option>";
        }).join("") + "</select>";
    }

    el.innerHTML = head("Outreach Statistics",
      "What's landing and who's responding. The full funnel from send to reply to meeting, broken down by message, segment, channel, touch and send-time, computed live from your sends and classified replies. Promote what's working into a campaign at the bottom.") +
      '<div class="an-tools" style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">' +
        '<span style="display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600">' +
          '<span style="width:8px;height:8px;border-radius:50%;background:var(--accent-green);animation:anPulse 2s infinite"></span>Live</span>' +
        '<span id="osUpdated" class="muted" style="font-size:12px"></span>' +
        '<span style="flex:1"></span>' +
        '<span id="osRange" style="display:inline-flex;gap:6px">' + rangeBtns() + "</span>" +
        chanSel() +
        '<button class="btn btn-ghost btn-sm" id="osRefresh">↻</button>' +
      "</div>" +
      '<style>@keyframes anPulse{0%{box-shadow:0 0 0 0 rgba(56,224,166,.55)}70%{box-shadow:0 0 0 7px rgba(56,224,166,0)}100%{box-shadow:0 0 0 0 rgba(56,224,166,0)}}' +
      '.os-heat{display:flex;gap:3px;align-items:flex-end;height:54px}.os-heat .hb{flex:1;background:var(--surface-2);border-radius:3px 3px 0 0;position:relative}.os-heat .hb i{position:absolute;left:0;right:0;bottom:0;background:var(--grad);border-radius:3px 3px 0 0;display:block}</style>' +
      '<div id="osBody">' + loading() + "</div>";

    function bars(items, suffix) {
      items = items || [];
      var max = items.reduce(function (m, it) { return Math.max(m, it.pct || 0); }, 0) || 1;
      return items.map(function (it) {
        var w = Math.max(Math.round(((it.pct || 0) / max) * 100), 6);
        var inside = it.disp != null ? it.disp : (it.pct + (suffix || ""));
        return '<div class="bar-row"><span class="blabel">' + esc(it.label) + '</span>' +
          '<span class="btrack"><span class="bfill" style="width:' + w + '%">' + esc(inside) + "</span></span>" +
          (it.right != null ? '<span class="bval">' + esc(it.right) + "</span>" : "") + "</div>";
      }).join("") || '<div class="empty">No data yet.</div>';
    }
    function dimRows(list) {
      return (list || []).slice(0, 8).map(function (d) {
        var badge = d.confident
          ? ' <span class="cls-pill positive" title="Significant vs your average">▲ significant</span>'
          : (d.contacted < 8 ? ' <span class="cls-pill" style="color:var(--text-dim);background:rgba(255,255,255,.05)">low volume</span>' : "");
        var liftTxt = d.lift > 0 ? '<span style="color:var(--accent-green)">+' + d.lift + "</span>" : (d.lift < 0 ? '<span style="color:var(--accent-red)">' + d.lift + "</span>" : "0");
        return '<div class="list-row"><div><div class="lr-main">' + esc(d.label) + badge + '</div>' +
          '<div class="lr-sub">' + d.contacted + " contacted · " + d.sent + " sent · " + d.replyRate + "% reply · " + liftTxt + " pts</div></div>" +
          '<div class="lr-right"><b>' + d.positiveRate + "%</b><div style=\"font-size:10.5px;color:var(--text-dim)\">positive</div></div></div>";
      }).join("") || '<div class="empty">No data yet.</div>';
    }
    function spark(series, color) {
      var n = (series || []).length; if (!n) return "";
      var max = Math.max.apply(null, series.concat([1]));
      var w = 320, h = 42, step = n > 1 ? w / (n - 1) : w;
      var pts = series.map(function (v, i) { return (i * step).toFixed(1) + "," + (h - (v / max) * (h - 6) - 3).toFixed(1); }).join(" ");
      return '<svg width="100%" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none" style="display:block;height:42px"><polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>';
    }

    var first = true;
    function load() {
      Promise.all([
        api("/analytics/outreach?since=" + since + "&motion=" + motion + (chan ? "&channel=" + chan : "")).catch(function () { return null; }),
        api("/campaigns").catch(function () { return null; })
      ]).then(function (res) {
        var body = $("#osBody"); if (!body) return;
        var s = res[0];
        var camps = ((res[1] && res[1].campaigns) || []).filter(function (c) { return (c.motion || "recruiting") === motion; });
        if (!s) { body.innerHTML = needsSetup(); return; }
        var t = s.totals;
        if (!t.prospectsContacted) {
          body.innerHTML = '<div class="empty">No outreach sent in this window yet. Once the daily cadence pushes touches (or you wire your sending providers), this fills in with the live funnel and what is converting.</div>';
          stamp(); first = false; return;
        }

        // KPIs.
        var kpiDefs = [
          { v: t.prospectsContacted, l: "Contacted", s: t.touchesSent + " touches sent" },
          { v: t.replyRate + "%", l: "Reply rate", s: t.replied + " replied" },
          { v: t.positiveRate + "%", l: "Positive rate", s: t.positive + " positive" },
          { v: t.bookRate + "%", l: motion === "bd" ? "Meeting rate" : "Submit rate", s: t.booked + " booked" },
          { v: (t.medianHoursToReply != null ? t.medianHoursToReply + "h" : "-"), l: "Median time to reply", s: "first response" }
        ];
        var kpis = kpiDefs.map(function (k) {
          return '<div class="rstat"><div class="big gradient-text">' + esc(k.v) + '</div><div class="lbl">' + esc(k.l) + "</div>" +
            '<div class="delta" style="color:var(--text-dim)">' + esc(k.s) + "</div></div>";
        }).join("");

        // Funnel.
        var top = (s.funnel[0] && s.funnel[0].value) || 1;
        var funnel = s.funnel.map(function (f, i) {
          var w = Math.max(Math.round((f.value / top) * 100), 6);
          var conv = i > 0 && s.funnel[i - 1].value ? Math.round((f.value / s.funnel[i - 1].value) * 100) + "%" : "";
          return '<div class="bar-row"><span class="blabel">' + esc(f.label) + '</span>' +
            '<span class="btrack"><span class="bfill" style="width:' + w + '%">' + esc(f.value) + "</span></span>" +
            '<span class="bval">' + esc(conv) + "</span></div>";
        }).join("");

        // Channels.
        var chBars = bars(s.byChannel.map(function (c) {
          return { label: c.channel === "sms" ? "SMS" : c.channel.charAt(0).toUpperCase() + c.channel.slice(1), pct: c.positiveRate, right: c.sent + " sent · " + c.replyRate + "% reply" };
        }), "%");

        // Reply quality + touches.
        var qBars = bars(s.replyQuality.map(function (q) { return { label: clsLabel(q.class), pct: q.pct, right: q.count }; }), "%");
        var tBars = bars(s.byTouch.slice(0, 10).map(function (x) { return { label: x.touch + " · " + x.channel, pct: x.replyRate, right: x.sent + " sent" }; }), "%");

        // Industry + send-hour heatmap.
        var indBars = bars(s.byIndustry.slice(0, 10).map(function (d) { return { label: d.label, pct: d.positiveRate, right: d.contacted }; }), "%");
        var hmax = s.bySendHour.reduce(function (m, h) { return Math.max(m, h.sent); }, 0) || 1;
        var heat = '<div class="os-heat">' + s.bySendHour.map(function (h) {
          var ht = Math.round((h.sent / hmax) * 100);
          var rr = Math.min(h.replyRate, 100);
          return '<span class="hb" style="height:' + Math.max(ht, 4) + '%" title="' + (h.hour < 10 ? "0" : "") + h.hour + ":00, " + h.sent + " sent · " + h.replyRate + '% reply"><i style="height:' + rr + '%"></i></span>';
        }).join("") + "</div><div class=\"muted\" style=\"font-size:11px;margin-top:6px\">Bar height = volume; fill = reply rate. Hover for the hour. Times in " + esc(s.meta.sendHourTimezone) + ".</div>";

        // Deliverability.
        var deliv = s.deliverability;
        var delivHtml = deliv ? (
          bars([
            { label: "Open rate", pct: deliv.openRate, right: "" },
            { label: "Bounce rate", pct: deliv.bounceRate, right: "" },
            { label: "Spam rate", pct: deliv.spamRate, right: "" }
          ], "%") +
          '<div style="margin-top:10px">' + deliv.domains.map(function (d) {
            return '<div class="list-row"><span class="rag ' + d.status + '"></span><div><div class="lr-main">' + esc(d.domain) + '</div>' +
              '<div class="lr-sub">' + d.delivered + " delivered · " + d.openRate + "% open</div></div>" +
              '<div class="lr-right">' + d.bounceRate + "% bounce · " + d.spamRate + "% spam</div></div>";
          }).join("") + "</div>"
        ) : '<div class="empty">No sending-domain metrics yet. Deliverability fills in once your owned MTA domains start sending.</div>';

        // Trend sparklines.
        var sent = s.trend.map(function (d) { return d.sent; });
        var reps = s.trend.map(function (d) { return d.replies; });
        var trendHtml =
          '<div style="font-size:12px;color:var(--text-muted);margin-bottom:2px">Sent</div>' + spark(sent, "var(--brand)") +
          '<div style="font-size:12px;color:var(--text-muted);margin:8px 0 2px">Replies</div>' + spark(reps, "var(--accent-green)");

        // Recruiter leaderboard (only if owners are present).
        var owners = (s.byOwner || []).filter(function (o) { return o.key; });
        var ownerHtml = owners.length ? owners.slice(0, 8).map(function (o) {
          return '<div class="list-row"><span class="avatar" style="background:' + colorFor(o.label) + '">' + esc(initials(o.label)) + "</span>" +
            '<div><div class="lr-main">' + esc(o.label) + '</div><div class="lr-sub">' + o.sent + " sent · " + o.replyRate + "% reply</div></div>" +
            '<div class="lr-right"><b>' + o.positiveRate + "%</b> positive</div></div>";
        }).join("") : "";

        // Promote-winners panel.
        var recs = (s.recommendations || []).map(function (r) {
          var b = r.confident
            ? ' <span class="cls-pill positive">confident</span>'
            : ' <span class="cls-pill" style="color:var(--accent-amber);background:rgba(245,158,11,.14)">needs volume</span>';
          return '<div class="list-row"><div><div class="lr-main">' + esc(r.title) + b + '</div><div class="lr-sub">' + esc(r.detail) + "</div></div>" +
            '<div class="lr-right">' + esc(r.metric) + "</div></div>";
        }).join("") || '<div class="empty">Not enough outreach yet to recommend winners. Keep sending and check back.</div>';
        var campOpts = camps.map(function (c) {
          var on = c.autopilot && c.autopilot.enabled;
          return '<option value="' + esc(c.id) + '" data-auto="' + (on ? "1" : "0") + '">' + esc(c.name) + (on ? ", autopilot ON" : "") + "</option>";
        }).join("") || '<option value="">No campaigns yet</option>';
        var winners = '<div class="card" style="margin-top:16px;border-color:var(--brand)"><h3>🤖 Promote winners into a campaign</h3>' +
          '<p class="muted" style="margin:.2em 0 12px;font-size:12.5px">Pin the best message, segments, channel and send-time onto a campaign. Turn on Auto-pilot and the daily cadence re-applies it on every run, so the campaign keeps tracking whatever is converting. Hands off.</p>' +
          recs +
          '<div style="display:flex;gap:10px;align-items:center;margin-top:14px;flex-wrap:wrap">' +
            '<select id="osCampaign" style="min-width:240px;background:var(--surface-2);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:7px 9px;font-size:13px">' + campOpts + "</select>" +
            '<button class="btn btn-primary btn-sm" id="osApply">Apply winners</button>' +
            '<button class="btn btn-ghost btn-sm" id="osAuto">Toggle auto-pilot</button>' +
            '<span id="osAutoState" class="muted" style="font-size:12px"></span>' +
          "</div></div>";

        var lowBanner = s.meta && s.meta.lowVolume
          ? '<div class="empty" style="border:1px solid var(--accent-amber);background:rgba(245,158,11,.08);color:var(--text-muted);margin-bottom:14px;text-align:left">' +
            '⚠ Low volume, fewer than ' + s.meta.minForConfidence + ' contacts in this view, so these rates are <b>directional, not yet statistically reliable</b>. “Confident” badges and auto-pilot winners only appear once a group clears that bar.</div>'
          : "";
        body.innerHTML =
          lowBanner +
          '<div class="report-stats">' + kpis + "</div>" +
          '<div class="report-cols" style="margin-top:16px">' +
            '<div class="report-card"><h3>Funnel: send → reply → meeting</h3>' + funnel + "</div>" +
            '<div class="report-card"><h3>Channel performance</h3>' + chBars + "</div>" +
          "</div>" +
          '<div class="two-col" style="margin-top:16px">' +
            '<div class="card"><h3>What’s landing, message performance</h3>' + dimRows(s.byVariant) + "</div>" +
            '<div class="card"><h3>Who’s responding, top segments</h3>' + dimRows(s.bySegment) + "</div>" +
          "</div>" +
          '<div class="two-col" style="margin-top:16px">' +
            '<div class="card"><h3>Reply quality mix</h3>' + qBars + "</div>" +
            '<div class="card"><h3>Which touch earns the reply</h3>' + tBars + "</div>" +
          "</div>" +
          '<div class="two-col" style="margin-top:16px">' +
            '<div class="card"><h3>Best industries by positive rate</h3>' + indBars + "</div>" +
            '<div class="card"><h3>Best time to send</h3>' + heat + "</div>" +
          "</div>" +
          '<div class="two-col" style="margin-top:16px">' +
            '<div class="card"><h3>Deliverability by domain <span class="muted" style="font-weight:500;font-size:11px">· ' + esc((s.meta && s.meta.deliverabilityWindow) || "per domain") + '</span></h3>' + delivHtml + "</div>" +
            '<div class="card"><h3>30-day trend</h3>' + trendHtml + "</div>" +
          "</div>" +
          (ownerHtml ? '<div class="card" style="margin-top:16px"><h3>Recruiter leaderboard</h3>' + ownerHtml + "</div>" : "") +
          winners;

        wireWinners();
        stamp(); first = false;
      }).catch(function () { if (first) { var b = $("#osBody"); if (b) b.innerHTML = needsSetup(); } });
    }

    function wireWinners() {
      var sel = $("#osCampaign"), apply = $("#osApply"), auto = $("#osAuto"), state = $("#osAutoState");
      function syncState() {
        if (!sel || !state) return;
        var opt = sel.options[sel.selectedIndex];
        var on = opt && opt.getAttribute("data-auto") === "1";
        state.textContent = on ? "Auto-pilot is ON for this campaign." : "Auto-pilot is off.";
        if (auto) auto.textContent = on ? "Turn auto-pilot off" : "Turn auto-pilot on";
      }
      if (sel) sel.addEventListener("change", syncState);
      syncState();
      if (apply) apply.addEventListener("click", function () {
        if (!sel || !sel.value) return;
        apply.disabled = true;
        send("/analytics/outreach", "POST", { action: "apply", campaignId: sel.value }).then(function (r) {
          apply.disabled = false;
          var note = r && r.data && r.data.autopilot && r.data.autopilot.note;
          toast(note ? "Applied: " + note : "Winners applied to campaign.");
        }).catch(function () { apply.disabled = false; toast("Could not apply. Try again."); });
      });
      if (auto) auto.addEventListener("click", function () {
        if (!sel || !sel.value) return;
        var opt = sel.options[sel.selectedIndex];
        var enable = !(opt && opt.getAttribute("data-auto") === "1");
        auto.disabled = true;
        send("/analytics/outreach", "POST", { action: "autopilot", campaignId: sel.value, enabled: enable }).then(function () {
          auto.disabled = false;
          if (opt) opt.setAttribute("data-auto", enable ? "1" : "0");
          syncState();
          toast(enable ? "Auto-pilot on, the campaign now self-tunes daily." : "Auto-pilot off.");
        }).catch(function () { auto.disabled = false; toast("Could not change auto-pilot."); });
      });
    }

    function stamp() { var u = $("#osUpdated"); if (u) u.textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }

    // Filter controls.
    el.addEventListener("click", function (e) {
      var r = e.target.closest(".os-range"); if (!r) return;
      since = r.getAttribute("data-since");
      var box = $("#osRange"); if (box) box.innerHTML = rangeBtns();
      load();
    });
    var cs = $("#osChan"); if (cs) cs.addEventListener("change", function () { chan = cs.value; load(); });
    var rf = $("#osRefresh"); if (rf) rf.addEventListener("click", load);
    load();
    viewTimers.push(setInterval(load, 30000));
  }

  // ---- Analytics drill-downs (full sub-views under #analytics/<slug>) ----
  // Each KPI on Analytics opens one of these: the actual people behind the
  // number, every one traceable back to the recruiter who runs the campaign. The
  // warm-conversations view goes a step further and renders the message thread.
  var AN_DETAILS = {
    "active-prospects": { title: "Active prospects", sub: "Everyone in a live sequence right now, who they are and whose campaign they sit in." },
    "meetings": { title: "Meetings this week", sub: "Qualified meetings booked this week and who they were with." },
    "warm-conversations": { title: "Warm conversations", sub: "Prospects who replied with interest, read the thread and trace it back to the campaign." },
    "won": { title: "Closed this period", sub: "Deals closed this period and the campaign that earned them." }
  };

  function renderAnalyticsDetail(el, detail) {
    var meta = AN_DETAILS[detail];
    if (!meta) { location.hash = "analytics"; return; }
    var bd = motion === "bd";
    var title = detail === "won" ? (bd ? "Won accounts" : "Placements")
      : detail === "active-prospects" ? "Active " + prospectsLabel().toLowerCase()
      : meta.title;
    el.innerHTML =
      '<div class="v-head" style="display:flex;align-items:baseline;gap:12px">' +
        '<a class="back-link clickable" data-go="analytics"><span class="arr">←</span> Back to Analytics</a>' +
        '<p style="margin:0">' + esc(meta.sub) + "</p></div>" +
      '<h2 style="margin:6px 0 14px">' + esc(title) + "</h2>" +
      '<div id="anDetailBody">' + loading() + "</div>";

    // Delegated nav: rows jump to the pipeline; the campaign chip opens Campaigns;
    // "Open thread" opens the Response inbox; the back link returns to Analytics.
    el.addEventListener("click", function (e) {
      var t = e.target.closest("[data-go]"); if (!t) return;
      location.hash = t.getAttribute("data-go");
    });

    Promise.all([
      api("/overview").catch(function () { return null; }),
      api("/prospects").catch(function () { return null; }),
      api("/response/list").catch(function () { return null; })
    ]).then(function (res) {
      var host = $("#anDetailBody"); if (!host) return;
      var ov = res[0] || {};
      var prospects = (res[1] && res[1].prospects) || [];
      var replies = (res[2] && res[2].items) || [];
      host.innerHTML = anDetailHtml(detail, ov, prospects, replies, bd);
    }).catch(function () {
      var host = $("#anDetailBody"); if (host) host.innerHTML = needsSetup();
    });
  }

  // Right-hand "campaign · recruiter" block; the campaign chip is itself a link
  // into Campaigns so a number can be chased down to one recruiter's sequence.
  function anCampaignCol(campaign, owner) {
    var camp = campaign
      ? '<a class="an-camp clickable" data-go="campaigns" title="Open this campaign">' + esc(campaign) + "</a>"
      : '<span class="muted">Unassigned</span>';
    return '<div class="lr-right" style="text-align:right">' + camp +
      (owner ? '<div class="lr-sub">' + esc(owner) + "</div>" : "") + "</div>";
  }

  // One prospect/person row: avatar, name, title·company, campaign·recruiter.
  function anPersonRow(name, sub, campaign, owner, go) {
    return '<div class="list-row clickable" data-go="' + (go || "prospects") + '">' +
      '<span class="avatar" style="background:' + colorFor(name || "?") + '">' + esc(initials(name || "?")) + "</span>" +
      '<div><div class="lr-main">' + esc(name || "Unknown") + '</div><div class="lr-sub">' + esc(sub || "") + "</div></div>" +
      anCampaignCol(campaign, owner) + "</div>";
  }

  function anDetailHtml(detail, ov, prospects, replies, bd) {
    function pSub(p) { return [p.title, p.company].filter(Boolean).join(" · "); }
    function inSet(set, p) { return set.indexOf(p.status) >= 0; }

    if (detail === "active-prospects") {
      // In a sequence but not yet closed/won, the live working set.
      var active = prospects.filter(function (p) { return inSet(FN_CONTACTED, p) && !inSet(FN_WON, p); });
      var rows = active.map(function (p) {
        var sub = pSub(p) + (p.dripStage ? " · Touch " + p.dripStage : "");
        return anPersonRow(p.fullName, sub, p.campaign, p.owner);
      }).join("") || '<div class="empty">No active ' + esc(prospectNoun()) + "s in sequence right now.</div>";
      return '<div class="card"><div class="lr-sub" style="margin-bottom:6px">' + active.length + " in a live sequence</div>" + rows + "</div>";
    }

    if (detail === "meetings") {
      // Recent appointments (named, with a time) joined to any prospect record so
      // the company/recruiter/campaign fill in even when the appointment is thin.
      function findP(n) { for (var i = 0; i < prospects.length; i++) { if ((prospects[i].fullName || "").toLowerCase() === (n || "").toLowerCase()) return prospects[i]; } return null; }
      var appts = (ov.recentAppointments || []).map(function (ap) {
        var p = findP(ap.name) || {};
        var company = ap.company || p.company || "";
        var sub = [ap.channel, company].filter(Boolean).join(" · ");
        var owner = ap.owner || p.owner;
        var campaign = ap.campaign || p.campaign;
        return '<div class="list-row clickable" data-go="prospects">' +
          '<span class="avatar" style="background:' + colorFor(ap.name) + '">' + esc(initials(ap.name || "?")) + "</span>" +
          '<div><div class="lr-main">' + esc(ap.name || "Unknown") + '</div><div class="lr-sub">' + esc(sub) + "</div></div>" +
          '<div class="lr-right" style="text-align:right">' +
            (campaign ? '<a class="an-camp clickable" data-go="campaigns">' + esc(campaign) + "</a>" : '<span class="muted">-</span>') +
            '<div class="lr-sub">' + esc(ap.at || "") + (owner ? " · " + esc(owner) : "") + "</div></div></div>";
      }).join("") || '<div class="empty">No meetings booked yet.</div>';
      var booked = prospects.filter(function (p) { return inSet(FN_MEETING, p); });
      var more = booked.map(function (p) { return anPersonRow(p.fullName, pSub(p) + " · Meeting booked", p.campaign, p.owner); }).join("");
      return '<div class="card"><h3>This week’s meetings</h3>' + appts + "</div>" +
        (more ? '<div class="card" style="margin-top:14px"><h3>All booked in pipeline</h3>' + more + "</div>" : "");
    }

    if (detail === "warm-conversations") {
      // Positive / soft-yes / referral replies, the warm ones. Each renders the
      // thread inline (dive deeper) plus a jump into the full Response inbox.
      var WARM = ["positive", "referral", "soft_yes"];
      var warm = replies.filter(function (r) { return WARM.indexOf(rClass(r)) >= 0; });
      var rows = warm.map(function (r) {
        var cls = rClass(r), ch = rChannel(r);
        var line = [ch === "sms" ? "SMS" : (ch.charAt(0).toUpperCase() + ch.slice(1)), r.source, r.owner].filter(Boolean).join(" · ");
        var thread = (r.thread || []).map(function (m) {
          return '<div class="an-msg ' + (m.from === "in" ? "in" : "out") + '"><span class="an-msg-at">' + esc(m.at || "") + "</span>" + esc(m.text || "") + "</div>";
        }).join("") || '<div class="an-msg in">' + esc(r.text || "") + "</div>";
        return '<div class="an-conv">' +
          '<div class="an-conv-head">' +
            '<span class="avatar" style="background:' + colorFor(r.name) + '">' + esc(initials(r.name || "?")) + "</span>" +
            '<div style="flex:1"><div class="lr-main">' + esc(r.name || "Unknown") +
              ' <span class="cls-pill ' + esc(cls) + '">' + esc(clsLabel(cls)) + "</span></div>" +
              '<div class="lr-sub">' + esc(line) + "</div></div>" +
            (r.source ? '<a class="an-camp clickable" data-go="campaigns" title="Open campaign">' + esc(r.source) + "</a>" : "") +
            '<a class="btn btn-ghost btn-sm clickable" data-go="response" style="margin-left:8px">Open thread →</a>' +
          "</div>" +
          '<div class="an-conv-body">' + thread + "</div></div>";
      }).join("") || '<div class="empty">No warm conversations yet. They appear here as prospects reply with interest.</div>';
      return '<div class="card"><div class="lr-sub" style="margin-bottom:10px">' + warm.length + " warm " + (warm.length === 1 ? "conversation" : "conversations") + ", click a campaign to see the recruiter’s sequence, or open the full thread.</div>" + rows + "</div>";
    }

    if (detail === "won") {
      var won = prospects.filter(function (p) { return inSet(FN_WON, p); });
      var rows = won.map(function (p) { return anPersonRow(p.fullName, pSub(p), p.campaign, p.owner); }).join("") ||
        '<div class="empty">Nothing closed this period yet.</div>';
      return '<div class="card"><div class="lr-sub" style="margin-bottom:6px">' + won.length + (bd ? " won this period" : " placed this period") + "</div>" + rows + "</div>";
    }

    return '<div class="empty">Nothing to show.</div>';
  }

  // ===== Nurture (the 24-month A/B drip) =====================================
  // Admin BD view: the two-strategy A/B (Authority Engine vs Inner Circle) head to
  // head on book-rate, the mpc/consultative framing axis underneath it, and every
  // enrollment with its stage, next-due touch, queued signal triggers and staged
  // LinkedIn touches — with pause / resume / complete / requeue controls. Reads the
  // session-authed /analytics/nurture rollup.
  function renderNurture(el) {
    el.innerHTML = head("Nurture",
      "The 24-month authority drip, running two strategies head to head on one engine. Approach A (the Authority Engine) keeps a regular value cadence so we stay top of mind; Approach B (the Inner Circle) is mostly trigger-only with a quarterly floor. Job changes, company news and notable posts override the cadence with an immediate, event-anchored touch. Book-rate per strategy picks the winner.") +
      '<div class="an-tools" style="display:flex;align-items:center;gap:10px;margin-bottom:14px">' +
        '<span style="display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600">' +
          '<span style="width:8px;height:8px;border-radius:50%;background:var(--accent-green);animation:anPulse 2s infinite"></span>Live</span>' +
        '<span id="nuUpdated" class="muted" style="font-size:12px"></span>' +
        '<span style="flex:1"></span>' +
        '<select id="nuFilter" class="os-sel" style="background:var(--surface-2);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:6px 8px;font-size:12.5px">' +
          [["", "All states"], ["active", "Active"], ["needs_review", "Needs review"], ["dormant", "Dormant"], ["paused", "Paused"], ["completed", "Completed"]].map(function (o) {
            return '<option value="' + o[0] + '">' + o[1] + "</option>";
          }).join("") + "</select>" +
        '<button class="btn btn-ghost btn-sm" id="nuRefresh">↻</button>' +
      "</div>" +
      '<style>@keyframes anPulse{0%{box-shadow:0 0 0 0 rgba(56,224,166,.55)}70%{box-shadow:0 0 0 7px rgba(56,224,166,0)}100%{box-shadow:0 0 0 0 rgba(56,224,166,0)}}' +
      '.nu-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px}@media(max-width:760px){.nu-grid{grid-template-columns:1fr}}' +
      '.nu-fcard{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:14px 16px}' +
      '.nu-fcard.win{border-color:var(--accent-green);box-shadow:0 0 0 1px rgba(56,224,166,.35)}' +
      '.nu-fnums{display:flex;gap:18px;margin-top:8px}.nu-fnums .n{font-size:20px;font-weight:800}.nu-fnums .l{font-size:10.5px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.04em}' +
      '.nu-tbl{width:100%;border-collapse:collapse;font-size:12.5px}.nu-tbl th{text-align:left;color:var(--text-dim);font-weight:600;padding:6px 8px;border-bottom:1px solid var(--border)}' +
      '.nu-tbl td{padding:7px 8px;border-bottom:1px solid rgba(255,255,255,.05);vertical-align:top}' +
      '.nu-strat{font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:999px;background:rgba(255,255,255,.06)}' +
      '.nu-strat.authority{color:#8ab4ff}.nu-strat.inner_circle{color:#f0a5ff}</style>' +
      '<div id="nuBody">' + loading() + "</div>";

    function statusPill(s) {
      var m = { active: "positive", paused: "not_interested", completed: "soft_yes", dormant: "timing_objection", needs_review: "unclassified" };
      var lbl = { active: "Active", paused: "Paused", completed: "Completed", dormant: "Dormant", needs_review: "Needs review" };
      return '<span class="cls-pill ' + (m[s] || "unclassified") + '">' + (lbl[s] || esc(s)) + "</span>";
    }
    function stratPill(s) {
      var lbl = { authority: "Authority", inner_circle: "Inner Circle" };
      return '<span class="nu-strat ' + esc(s || "") + '">' + (lbl[s] || esc(s || "-")) + "</span>";
    }
    function fmtDue(iso) {
      if (!iso) return "-";
      var d = new Date(iso); if (isNaN(d.getTime())) return "-";
      var days = Math.round((d.getTime() - Date.now()) / 86400000);
      var when = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
      var rel = days <= 0 ? "due now" : ("in " + days + "d");
      return when + ' <span class="muted">(' + rel + ")</span>";
    }
    function fcard(name, blurb, rep, isWinner) {
      rep = rep || { enrolled: 0, engaged: 0, booked: 0, engageRatePct: 0, bookRatePct: 0 };
      return '<div class="nu-fcard' + (isWinner ? " win" : "") + '">' +
        '<div style="display:flex;align-items:center;gap:8px"><b style="font-size:14px">' + esc(name) + "</b>" +
          (isWinner ? ' <span style="font-size:10.5px;font-weight:700;color:var(--accent-green)">▲ WINNING</span>' : "") + "</div>" +
        '<div class="muted" style="font-size:11.5px;margin-top:2px">' + esc(blurb) + "</div>" +
        '<div class="nu-fnums">' +
          '<div><div class="n gradient-text">' + rep.enrolled + '</div><div class="l">Enrolled</div></div>' +
          '<div><div class="n">' + rep.engaged + '</div><div class="l">Engaged</div></div>' +
          '<div><div class="n">' + rep.booked + '</div><div class="l">Booked</div></div>' +
          '<div><div class="n">' + rep.bookRatePct + '%</div><div class="l">Book rate</div></div>' +
        "</div></div>";
    }

    function actionsFor(e) {
      var btn = function (act, label) {
        return '<button class="btn btn-ghost btn-sm nu-act" data-act="' + act + '" data-pid="' + esc(e.prospectId) + '" style="padding:3px 8px;font-size:11px">' + label + "</button>";
      };
      if (e.status === "active" || e.status === "needs_review") return btn("pause", "Pause") + (e.status === "needs_review" ? btn("resume", "Approve") : "");
      if (e.status === "paused") return btn("resume", "Resume");
      if (e.status === "dormant") return btn("requeue", "Requeue") + btn("complete", "Complete");
      if (e.status === "completed") return btn("requeue", "Requeue");
      return "";
    }

    function paint(d) {
      var body = $("#nuBody"); if (!body) return;
      if (!d) { body.innerHTML = '<div class="empty">Could not load nurture. The drip fills in once prospects are enrolled from the BD funnel.</div>'; return; }
      var sr = (d.strategyReport && d.strategyReport.strategies) || {};
      var vr = (d.variantReport && d.variantReport.variants) || {};
      var sWin = d.strategyReport && d.strategyReport.winner;
      var vWin = d.variantReport && d.variantReport.winner;
      var enrollments = d.enrollments || [];
      var eligible = d.eligible || 0;
      var auto = d.automation || {};
      var filter = ($("#nuFilter") && $("#nuFilter").value) || "";
      var rows = enrollments.filter(function (e) { return !filter || e.status === filter; });

      // Hands-off status: is the in-process clock running the drip (no n8n needed)?
      var running = auto.enabled && auto.armed;
      var banner =
        '<div class="card" style="margin-bottom:12px;display:flex;align-items:center;gap:10px;border-left:3px solid ' +
          (running ? "var(--accent-green)" : "#ffc24d") + '">' +
          '<span style="font-size:16px">' + (running ? "🟢" : "🟡") + "</span>" +
          '<div style="font-size:12.5px">' +
            (running
              ? "<b>Running hands-off, in-process.</b> No n8n. Due touches, signal triggers and auto-enrollment all run on the internal clock; replies pause instantly."
              : (auto.enabled
                  ? "<b>Clock enabled but not armed in this server yet.</b> It arms on the next deploy or restart; touches flow then."
                  : "<b>Automation is OFF.</b> Set <code>AUTOMATION_ENABLED=on</code> and turn on a campaign's Autopilot so the drip sends and auto-enrolls with no n8n. You can still enroll below; touches send once it is on.")) +
          "</div></div>";

      // The "push it live" control: enroll every eligible BD prospect into the drip.
      var activate =
        '<div class="card" style="margin-bottom:14px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">' +
          '<div style="flex:1;min-width:230px">' +
            '<div style="font-weight:700;font-size:13.5px">🌱 Launch the 24-month drip</div>' +
            '<div class="muted" style="font-size:12px;margin-top:3px">' +
              (eligible
                ? '<b>' + eligible + '</b> eligible BD prospect' + (eligible === 1 ? "" : "s") + ' (in-market, not opted out, not already enrolled) ready to enroll. Each is split 50/50 across Authority vs Inner Circle and starts month one.'
                : "No eligible prospects right now. Promote in-market BD leads into Prospects and they show up here to enroll.") +
            "</div></div>" +
            '<button class="btn btn-primary nu-activate"' + (eligible ? "" : " disabled") + '>Enroll ' + eligible + " &amp; activate</button>" +
        "</div>";

      var strategyCards =
        '<div class="lr-sub" style="margin:2px 0 8px;font-weight:700">A/B Strategy — the headline test (book-rate decides)' +
          (sWin && sWin !== "insufficient_data" ? "" : ' <span class="muted" style="font-weight:500">· needs 30+ enrolled per arm to call</span>') + "</div>" +
        '<div class="nu-grid">' +
          fcard("A · Authority Engine", "Regular ~2x/month value cadence. Top-of-mind through volume of insight.", sr.authority, sWin === "authority") +
          fcard("B · Inner Circle", "Trigger-only + quarterly floor. Precision and intimacy on higher-value contacts.", sr.inner_circle, sWin === "inner_circle") +
        "</div>";

      var variantCards =
        '<div class="lr-sub" style="margin:2px 0 8px;font-weight:700">Message framing — the secondary axis (orthogonal)</div>' +
        '<div class="nu-grid">' +
          fcard("MPC", "Leads with a specific placeable candidate.", vr.mpc, vWin === "mpc") +
          fcard("Consultative", "Earns attention with role/industry insight.", vr.consultative, vWin === "consultative") +
        "</div>";

      var counts = d.counts || {};
      var countChips = ["active", "needs_review", "dormant", "paused", "completed"].filter(function (k) { return counts[k]; }).map(function (k) {
        return statusPill(k) + ' <b>' + counts[k] + "</b>";
      }).join(" &nbsp; ") || '<span class="muted">No enrollments yet.</span>';

      var tbl = '<table class="nu-tbl"><thead><tr>' +
        "<th>Prospect</th><th>State</th><th>Strategy</th><th>Framing</th><th>Stage</th><th>Next touch</th><th>Queue</th><th></th>" +
        "</tr></thead><tbody>" +
        rows.map(function (e) {
          var who = esc(e.fullName || e.firstName || e.prospectId);
          var sub = [e.title, e.company].filter(Boolean).map(esc).join(" · ");
          var trg = (e.triggered || []).length, pend = (e.pending || []).length;
          var queue = (trg ? '<span title="signal triggers waiting" style="color:var(--accent-green)">⚡' + trg + "</span> " : "") +
            (pend ? '<span title="staged LinkedIn touches" class="muted">✎' + pend + "</span>" : "") || "-";
          var stageNum = (e.status === "dormant") ? "floor" : ((e.nextTouchIndex != null ? e.nextTouchIndex : 0) + "/" + (e.planLength || "-"));
          return "<tr><td><div class='lr-main'>" + who + "</div>" + (sub ? "<div class='lr-sub'>" + sub + "</div>" : "") + "</td>" +
            "<td>" + statusPill(e.status) + (e.hold ? ' <span class="muted" style="font-size:10px">' + esc(e.hold) + "</span>" : "") + "</td>" +
            "<td>" + stratPill(e.strategy) + "</td>" +
            "<td class='muted'>" + esc(e.variant || "-") + "</td>" +
            "<td>" + esc(String(stageNum)) + ' <span class="muted">· ' + (e.touchesSent || 0) + " sent</span></td>" +
            "<td>" + fmtDue(e.nextDueAt) + "</td>" +
            "<td>" + queue + "</td>" +
            "<td style='white-space:nowrap'>" + actionsFor(e) + "</td></tr>";
        }).join("") +
        "</tbody></table>";
      if (!rows.length) tbl = '<div class="empty">No enrollments' + (filter ? " in this state" : "") + " yet.</div>";

      body.innerHTML = banner + activate + strategyCards + variantCards +
        '<div class="card" style="margin-top:6px"><div class="lr-sub" style="margin-bottom:10px">' + countChips + "</div>" + tbl + "</div>";

      var ab = body.querySelector(".nu-activate");
      if (ab) ab.addEventListener("click", function () {
        ab.disabled = true; ab.textContent = "Enrolling…";
        send("/analytics/nurture", "POST", { action: "enroll_eligible" }).then(function (r) {
          if (r.ok && r.data) { toast("Enrolled " + (r.data.enrolled || 0) + " into the drip"); load(); }
          else { toast("Enroll failed"); ab.disabled = false; ab.textContent = "Enroll " + eligible + " & activate"; }
        }).catch(function () { toast("Enroll failed"); ab.disabled = false; ab.textContent = "Enroll " + eligible + " & activate"; });
      });

      Array.prototype.forEach.call(body.querySelectorAll(".nu-act"), function (b) {
        b.addEventListener("click", function () {
          var act = b.getAttribute("data-act"), pid = b.getAttribute("data-pid");
          b.disabled = true;
          send("/analytics/nurture", "POST", { action: act, prospectId: pid }).then(function (r) {
            if (r.ok) { toast("Updated"); load(); }
            else { toast("Update failed"); b.disabled = false; }
          }).catch(function () { toast("Update failed"); b.disabled = false; });
        });
      });
    }

    function load() {
      api("/analytics/nurture").then(function (d) {
        paint(d);
        var u = $("#nuUpdated"); if (u) u.textContent = "updated " + new Date().toLocaleTimeString();
      }).catch(function () { paint(null); });
    }

    var fb = $("#nuRefresh"); if (fb) fb.addEventListener("click", load);
    var ff = $("#nuFilter"); if (ff) ff.addEventListener("change", load);
    load();
  }

  function renderAccounts(el) {
    el.innerHTML = head("Accounts", "API keys for your connected services. Health auto-syncs nightly.") +
      '<div class="btn-row" style="margin-bottom:14px">' +
      '<button class="btn btn-primary btn-sm" data-add="apikey">＋ API key</button></div>' +
      '<div id="acBody">' + loading() + "</div>";

    function load() {
      api("/accounts").then(function (d) {
        d = d || {};
        var keys = (d.apiKeys || []).map(function (k) {
          return '<div class="integ"><span class="dot3" style="background:var(--accent-green)"></span><div class="meta"><b>' + esc(k.service) + "</b><small>" + esc(k.masked) + "</small></div></div>";
        }).join("") || '<div class="empty">No API keys stored yet.</div>';
        var body = $("#acBody"); if (!body) return;
        body.innerHTML = '<div class="card"><h3>API keys</h3>' + keys + "</div>";
      }).catch(function () { var b = $("#acBody"); if (b) b.innerHTML = needsSetup(); });
    }
    load();

    Array.prototype.forEach.call(el.querySelectorAll("[data-add]"), function (btn) {
      btn.addEventListener("click", function () {
        var svc = prompt("Service (Instantly, Telnyx, Loxo, ...):"); if (!svc) return;
        var key = prompt("API key for " + svc + ":"); if (!key) return;
        var payload = { type: "apikey", service: svc, key: key };
        send("/accounts", "POST", payload).then(function (r) {
          toast(r.ok ? "Added" : "Could not add (" + (r.data.error || r.status) + ")"); if (r.ok) load();
        }).catch(function () { toast("Could not reach the server."); });
      });
    });
  }

  /* ---------------- Setup (admin launch hub) ----------------
     One tab that consolidates everything an admin must stand up before the
     workspace can launch: integrations, the ATS, owned email-sending infra and
     outreach readiness. The default view is an ordered launch-readiness
     checklist; each row drills into the real config screen via a sub-tab
     (#setup/<section>), which delegates to that section's existing renderer. */
  var SETUP_SECTIONS = [
    { key: "", label: "Launch readiness", icon: "🚀" },
    { key: "connected", label: "Integrations", icon: "🔌" },
    { key: "email", label: "Email sending", icon: "✉️" },
    { key: "ats", label: "ATS", icon: "🗂️" },
    { key: "voicedrops", label: "Voice Drops", icon: "📞" },
    { key: "vetting", label: "AI Vetting", icon: "☎️" },
    { key: "branding", label: "Branding", icon: "🎨" },
    { key: "domain", label: "Custom domain", icon: "🌐" }
  ];

  function setupStyles() {
    return '<style>' +
      '.setup-tabs{display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--line,#1f232b);margin:0 0 16px}' +
      '.setup-tab{display:inline-flex;align-items:center;gap:6px;padding:8px 13px;border-radius:8px 8px 0 0;color:var(--muted,#8b93a1);font-size:13px;font-weight:500;text-decoration:none;border:1px solid transparent;border-bottom:none;margin-bottom:-1px}' +
      '.setup-tab:hover{color:var(--text,#e6e9ef)}' +
      '.setup-tab.active{color:var(--text,#e6e9ef);background:var(--card,#14161c);border-color:var(--line,#1f232b)}' +
      '.setup-tab .ni{font-size:14px}' +
      '.setup-banner{border-radius:11px;padding:13px 16px;margin:0 0 16px;font-size:13.5px;font-weight:600}' +
      '.setup-banner.ok{background:rgba(56,224,166,.1);border:1px solid rgba(56,224,166,.4);color:var(--accent-green,#38e0a6)}' +
      '.setup-banner.warn{background:rgba(255,194,77,.08);border:1px solid rgba(255,194,77,.4);color:#f0d27f}' +
      '.setup-steps{display:flex;flex-direction:column;gap:12px}' +
      '.setup-step{display:flex;gap:14px;background:var(--card,#14161c);border:1px solid var(--line,#1f232b);border-radius:11px;padding:15px 17px}' +
      '.setup-step.s-ready{border-color:rgba(56,224,166,.32)}' +
      '.setup-step.s-action{border-color:rgba(240,120,120,.32)}' +
      '.setup-num{flex:0 0 auto;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;background:var(--bg,#0e0f13);border:1px solid var(--line,#1f232b)}' +
      '.setup-step.s-ready .setup-num{background:#10491f;color:#7ff0a0;border-color:transparent}' +
      '.setup-main{flex:1;min-width:0}' +
      '.setup-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}' +
      '.setup-title{font-weight:600;font-size:15px}' +
      '.setup-desc{color:var(--muted,#8b93a1);font-size:13px;margin:5px 0 7px;line-height:1.45}' +
      '.setup-metric{font-size:12.5px;color:var(--text-dim,#9aa3b2)}' +
      '.setup-track{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}' +
      '.setup-chip{font-size:11px;padding:3px 9px;border-radius:20px;background:var(--bg,#0e0f13);border:1px solid var(--line,#2a2f3a);color:var(--muted,#8b93a1)}' +
      '.setup-open{margin-left:auto;white-space:nowrap}' +
      '.s-pill{font-size:11px;padding:2px 10px;border-radius:20px;font-weight:600}' +
      '.s-pill.ready{background:#10491f;color:#7ff0a0}.s-pill.progress{background:#4a3a10;color:#f0d27f}' +
      '.s-pill.action{background:#4a1414;color:#f08f8f}.s-pill.pending{background:#262a33;color:#9aa3b2}' +
      /* ---- Premium setup chrome (branding / domain / voice) ---- */
      '.sx-hero{position:relative;overflow:hidden;border:1px solid var(--border);border-radius:18px;padding:20px 22px;margin:0 0 18px;display:flex;gap:16px;align-items:flex-start;background:radial-gradient(130% 150% at 0% 0%,rgba(124,92,255,.20),transparent 52%),radial-gradient(120% 150% at 100% 0%,rgba(77,208,255,.13),transparent 52%),var(--surface)}' +
      '.sx-hero::after{content:"";position:absolute;left:0;right:0;bottom:0;height:1px;background:linear-gradient(90deg,transparent,rgba(124,92,255,.5),rgba(77,208,255,.35),transparent)}' +
      '.sx-hero .sx-ic{flex:0 0 auto;width:48px;height:48px;border-radius:14px;display:grid;place-items:center;font-size:24px;background:linear-gradient(145deg,rgba(124,92,255,.25),rgba(77,208,255,.18));border:1px solid var(--border-strong);box-shadow:inset 0 1px 0 rgba(255,255,255,.12)}' +
      '.sx-hero h2{font-size:21px;letter-spacing:-.02em;margin:0;background:var(--grad-text);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}' +
      '.sx-hero p{color:var(--text-muted);font-size:13.5px;margin:5px 0 0;max-width:72ch;line-height:1.5}' +
      '.sx-cols{display:grid;grid-template-columns:minmax(0,1.18fr) minmax(0,.82fr);gap:16px;align-items:start}' +
      '@media(max-width:860px){.sx-cols{grid-template-columns:1fr}}' +
      '.sx-card{position:relative;background:linear-gradient(180deg,var(--surface),var(--bg-soft));border:1px solid var(--border);border-radius:16px;padding:18px 20px}' +
      '.sx-card+.sx-card{margin-top:14px}' +
      '.sx-card h3{font-size:14px;letter-spacing:.01em;margin:0 0 3px;display:flex;align-items:center;gap:8px}' +
      '.sx-card>.sx-sub{color:var(--text-dim);font-size:12.5px;margin:0 0 14px;line-height:1.45}' +
      '.sx-eyebrow{font-size:10.5px;text-transform:uppercase;letter-spacing:.12em;color:var(--text-dim);font-weight:700;margin:0 0 11px;display:flex;align-items:center;gap:7px}' +
      '.sx-eyebrow::before{content:"";width:14px;height:2px;border-radius:2px;background:var(--grad)}' +
      '.sx-swatches{display:flex;gap:9px;flex-wrap:wrap;align-items:center}' +
      '.sx-sw{width:28px;height:28px;border-radius:9px;cursor:pointer;border:2px solid transparent;box-shadow:inset 0 0 0 1px rgba(255,255,255,.12);transition:transform .1s ease}' +
      '.sx-sw:hover{transform:scale(1.12)}' +
      '.sx-sw.on{border-color:#fff;box-shadow:0 0 0 2px var(--bg),0 6px 18px -6px rgba(0,0,0,.7)}' +
      '.sx-colorrow{display:flex;align-items:center;gap:12px;flex-wrap:wrap}' +
      '.sx-hex{font-family:var(--mono);font-size:12px;color:var(--text-muted);background:var(--bg-soft);border:1px solid var(--border);border-radius:7px;padding:5px 9px;letter-spacing:.04em;text-transform:uppercase}' +
      /* form fields (self-contained so the panel never depends on another view\'s styles) */
      '.sx-card .cn-fld{display:block;margin-bottom:18px}' +
      '.sx-card .cn-fld:last-child{margin-bottom:0}' +
      '.sx-card .cn-fld .lab{display:block;font-size:12.5px;font-weight:600;color:var(--text);margin-bottom:7px}' +
      '.sx-card .cn-fld .hint{display:block;font-size:11.5px;color:var(--text-dim);margin-top:7px;line-height:1.5;max-width:52ch}' +
      '.sx-card .cn-fld input[type="text"]{width:100%;max-width:340px;background:var(--bg-soft);border:1px solid var(--border);border-radius:9px;padding:9px 12px;color:var(--text);font:inherit;font-size:13px;transition:border-color .15s,box-shadow .15s}' +
      '.sx-card .cn-fld input[type="text"]:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 22%,transparent)}' +
      '.sx-card .cn-fld input[type="range"]{display:block;margin:2px 0}' +
      '.sx-uprow{display:flex;gap:8px;margin-top:10px}' +
      '.cn-acts{display:flex;gap:9px;align-items:center;flex-wrap:wrap}' +
      /* voice-clone provider cards (Step 2) */
      '.vp-list{display:flex;flex-direction:column;gap:10px}' +
      '.vp{border:1px solid var(--border);border-radius:12px;padding:13px 15px;background:var(--bg-soft);transition:border-color .15s}' +
      '.vp.on{border-color:var(--accent-green);box-shadow:0 0 0 1px rgba(56,224,166,.25)}' +
      '.vp-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap}' +
      '.vp-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}' +
      '.vp-name{font-size:13.5px;font-weight:700;color:var(--text)}' +
      '.vp-state{font-size:12px;color:var(--text-dim)}' +
      '.vp-chip{font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;padding:2px 8px;border-radius:999px;background:rgba(56,224,166,.16);color:var(--accent-green)}' +
      '.vp-row{display:flex;gap:8px;margin-top:11px}' +
      '.vp-key{flex:1;min-width:0;background:var(--bg);border:1px solid var(--border);border-radius:9px;padding:9px 12px;color:var(--text);font:inherit;font-size:13px;transition:border-color .15s,box-shadow .15s}' +
      '.vp-key:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 22%,transparent)}' +
      '.vp-msg{font-size:11.5px;color:var(--text-dim);margin-top:7px;line-height:1.45}' +
      '.vp-msg a{color:var(--brand-2);text-decoration:none}.vp-msg a:hover{text-decoration:underline}' +
      '.vc{display:flex;align-items:center;gap:10px;padding:9px 11px;border:1px solid var(--border);border-radius:10px;background:var(--bg-soft);margin-top:8px}' +
      '.vc.on{border-color:var(--accent-green);background:rgba(56,224,166,.06)}' +
      '.vc-name{font-size:13px;font-weight:600;color:var(--text)}' +
      '.vc-meta{font-size:11.5px;color:var(--text-dim)}' +
      /* live brand preview */
      '.sx-prev{position:sticky;top:14px;border:1px solid var(--border);border-radius:16px;overflow:hidden;background:var(--bg)}' +
      '.sx-prev-bar{font-size:10.5px;text-transform:uppercase;letter-spacing:.1em;color:var(--text-dim);font-weight:700;padding:10px 14px;border-bottom:1px solid var(--border);background:var(--surface)}' +
      '.sx-prev-body{padding:16px;background:radial-gradient(120% 80% at 100% 0%,rgba(124,92,255,.10),transparent 60%)}' +
      '.sx-prev-side{background:var(--surface);border:1px solid var(--border);border-radius:13px;padding:13px;display:flex;flex-direction:column;gap:11px}' +
      '.sx-prev-logo{display:flex;align-items:center;gap:9px;font-weight:800;font-size:15px;letter-spacing:-.01em}' +
      '.sx-prev-logo .dot{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;font-size:14px;color:#fff;font-weight:800}' +
      '.sx-prev-logo img{max-height:30px;max-width:150px;object-fit:contain;display:block}' +
      '.sx-prev-nav{display:flex;flex-direction:column;gap:5px}' +
      '.sx-prev-nav span{display:flex;align-items:center;gap:9px;font-size:12px;color:var(--text-muted);padding:7px 9px;border-radius:8px}' +
      '.sx-prev-nav span.on{color:#fff;font-weight:600}' +
      '.sx-prev-nav span i{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.6;font-style:normal}' +
      '.sx-prev-btn{margin-top:2px;align-self:flex-start;color:#fff;font-size:12px;font-weight:700;padding:8px 15px;border-radius:9px;border:none}' +
      '.sx-prev-cap{font-size:11px;color:var(--text-dim);margin-top:11px;text-align:center}' +
      '.sx-logo-frame{display:inline-flex;align-items:center;justify-content:center;min-width:120px;height:62px;padding:0 16px;border-radius:11px;border:1px solid var(--border)}' +
      '.sx-logo-frame img{max-height:42px;max-width:190px;object-fit:contain;display:block}' +
      '.sx-logo-empty{font-size:12px;color:var(--text-dim)}' +
      /* status header for domain / readiness */
      '.sx-status{display:flex;align-items:center;gap:14px;flex-wrap:wrap}' +
      '.sx-status .dot{width:11px;height:11px;border-radius:50%;flex:0 0 auto}' +
      '.sx-status .dot.ok{background:var(--accent-green);box-shadow:0 0 12px var(--accent-green)}' +
      '.sx-status .dot.warn{background:var(--accent-amber);box-shadow:0 0 12px var(--accent-amber)}' +
      '.sx-status .dot.off{background:var(--text-dim)}' +
      '.sx-status .lab{font-size:15px;font-weight:700}' +
      '.sx-status .sub{font-size:12.5px;color:var(--text-dim)}' +
      '.sx-mono{font-family:var(--mono);font-size:13px;color:var(--text)}' +
      /* dns records */
      '.sx-dns{display:flex;flex-direction:column;gap:10px;margin-top:6px}' +
      '.sx-rec{border:1px solid var(--border);border-radius:12px;padding:13px 15px;background:var(--bg-soft)}' +
      '.sx-rec-top{display:flex;align-items:center;gap:9px;margin-bottom:9px}' +
      '.sx-rec-type{font-family:var(--mono);font-size:11px;font-weight:700;padding:2px 9px;border-radius:6px;background:rgba(124,92,255,.16);color:#b9a6ff;letter-spacing:.06em}' +
      '.sx-rec-host{font-family:var(--mono);font-size:12.5px;color:var(--text-muted)}' +
      '.sx-rec-val{display:flex;align-items:center;gap:10px;background:var(--bg);border:1px solid var(--border);border-radius:9px;padding:9px 11px}' +
      '.sx-rec-val code{font-family:var(--mono);font-size:12.5px;color:var(--text);word-break:break-all;flex:1;min-width:0}' +
      '.sx-copy{flex:0 0 auto;cursor:pointer;font-size:11px;font-weight:700;color:var(--text-muted);background:var(--surface);border:1px solid var(--border-strong);border-radius:7px;padding:5px 11px;transition:all .12s}' +
      '.sx-copy:hover{color:var(--text);border-color:var(--brand)}' +
      '.sx-rec-note{font-size:11.5px;color:var(--text-dim);margin-top:7px}' +
      /* readiness checklist */
      '.sx-checks{display:flex;flex-direction:column;gap:9px;margin-top:4px}' +
      '.sx-chk{display:flex;align-items:center;gap:11px;font-size:13px;color:var(--text-muted)}' +
      '.sx-chk .mk{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:800;flex:0 0 auto}' +
      '.sx-chk.done .mk{background:rgba(56,224,166,.18);color:var(--accent-green)}' +
      '.sx-chk.todo .mk{background:var(--bg-soft);border:1px solid var(--border-strong);color:var(--text-dim)}' +
      '.sx-chk.done{color:var(--text)}' +
      '.sx-ring{position:relative;width:54px;height:54px;flex:0 0 auto}' +
      /* guided stepper (custom domain) */
      '.sx-steps{display:flex;align-items:flex-start;margin:2px 0 4px}' +
      '.sx-step{flex:1;display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;position:relative}' +
      '.sx-step .n{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-size:13px;font-weight:800;font-family:var(--mono);background:var(--bg-soft);border:1.5px solid var(--border-strong);color:var(--text-dim);transition:all .2s;position:relative;z-index:1}' +
      '.sx-step .t{font-size:12px;font-weight:700;color:var(--text-dim);line-height:1.2}' +
      '.sx-step::before,.sx-step::after{content:"";position:absolute;top:14px;height:2px;background:var(--border-strong);z-index:0}' +
      '.sx-step::before{left:0;right:50%;margin-right:19px}' +
      '.sx-step::after{left:50%;right:0;margin-left:19px}' +
      '.sx-step:first-child::before{display:none}.sx-step:last-child::after{display:none}' +
      '.sx-step.active .n{background:var(--grad);border-color:transparent;color:#fff;box-shadow:0 0 0 4px rgba(124,92,255,.18)}' +
      '.sx-step.active .t{color:var(--text)}' +
      '.sx-step.done .n{background:rgba(46,204,113,.16);border-color:var(--accent-green);color:var(--accent-green)}' +
      '.sx-step.done .t{color:var(--text-muted)}' +
      '.sx-step.done::before,.sx-step.done::after{background:var(--accent-green);opacity:.45}' +
      /* per-record name/value fields + provider tip + success banner */
      '.sx-rec-purpose{font-size:11.5px;color:var(--text-dim)}' +
      '.sx-rec-field{display:flex;align-items:center;gap:11px;margin-top:8px}' +
      '.sx-rec-k{flex:0 0 44px;font-size:10.5px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:.06em}' +
      '.sx-tip{display:flex;gap:10px;align-items:flex-start;background:rgba(77,208,255,.06);border:1px solid var(--border);border-radius:11px;padding:11px 13px;margin-top:13px;font-size:12px;color:var(--text-muted);line-height:1.55}' +
      '.sx-tip .ti{flex:0 0 auto;font-size:14px;line-height:1.3}' +
      '.sx-tip b{color:var(--text)}.sx-tip code{font-family:var(--mono);font-size:11.5px;background:var(--bg-soft);border:1px solid var(--border);border-radius:5px;padding:1px 5px}' +
      '.sx-done{display:flex;align-items:center;gap:13px;background:linear-gradient(135deg,rgba(46,204,113,.12),rgba(46,204,113,.03));border:1px solid rgba(46,204,113,.3);border-radius:14px;padding:14px 16px;margin-bottom:14px}' +
      '.sx-done .ic{flex:0 0 auto;width:38px;height:38px;border-radius:11px;display:grid;place-items:center;font-size:18px;background:rgba(46,204,113,.18);border:1px solid rgba(46,204,113,.35)}' +
      '</style>';
  }

  function renderSetup(el) {
    var detail = currentDetail();
    // Lume (our own tenant) manages its custom domain on the backend, hide the
    // self-service Custom domain tab there. All other workspaces keep it.
    var sections = SETUP_SECTIONS.filter(function (s) {
      return !(s.key === "domain" && isLumeWorkspace());
    });
    // Guard direct navigation to #setup/domain when the tab is hidden.
    if (detail === "domain" && isLumeWorkspace()) detail = "";
    var tabs = '<div class="setup-tabs">' + sections.map(function (s) {
      return '<a class="setup-tab' + (s.key === detail ? " active" : "") + '" href="#setup' + (s.key ? "/" + s.key : "") + '">' +
        '<span class="ni">' + s.icon + '</span> ' + esc(s.label) + '</a>';
    }).join("") + '</div>';
    el.innerHTML = setupStyles() + tabs + '<div id="setupBody"></div>';
    var body = el.querySelector("#setupBody");
    if (detail === "connected") return renderConnected(body);
    if (detail === "email") return renderSending(body);
    if (detail === "ats") return renderAts(body);
    if (detail === "voicedrops") return renderVoiceSetup(body, "voicedrops");
    if (detail === "vetting") return renderVoiceSetup(body, "vetting");
    if (detail === "branding") return renderBranding(body);
    if (detail === "domain") return renderDomain(body);
    return renderSetupOverview(body);
  }

  /* Logo-fit adjuster: drag + zoom the uploaded image onto the sidebar's logo
     frame so it sits naturally and never skews (aspect ratio is always preserved).
     Previews on the chosen appearance background; exports a TRANSPARENT PNG so the
     same logo overlays whatever theme is active. Calls onDone(dataUrl). */
  function openLogoAdjuster(file, opts, onDone) {
    opts = opts || {};
    var bg = opts.bg === "light" ? "#f6f7fc" : "#181822";
    var img = new Image();
    var reader = new FileReader();
    reader.onload = function () {
      img.onload = build;
      img.onerror = function () { toast("That image couldn't be read."); };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);

    function build() {
      // The export frame follows the LOGO'S OWN aspect ratio, so at zoom 1 it is
      // exactly the uploaded logo, nothing is forced into a fixed shape, padded,
      // or stretched. Zoom > 1 crops in tighter; zoom < 1 adds breathing room.
      var aspect = img.width / img.height;
      // High export resolution keeps the logo crisp on hi-DPI screens.
      var EX_H = 480, EX_W = Math.round(EX_H * aspect);
      if (EX_W > 2400) { EX_W = 2400; EX_H = Math.round(2400 / aspect); }
      var base = EX_H / img.height; // at zoom 1 the logo fills the frame exactly
      var st = { zoom: 1, x: 0, y: 0 };
      var ov = document.createElement("div");
      ov.className = "logo-adj-ov";
      ov.innerHTML =
        '<div class="logo-adj" role="dialog" aria-label="Adjust logo">' +
        '<h3 style="margin:0 0 4px">Adjust logo' + (opts.label ? " · " + esc(opts.label) : "") + '</h3>' +
        '<p class="muted" style="margin:0 0 12px;font-size:13px">This is exactly how it appears in the sidebar, at your logo\'s real proportions. It\'s ready as-is; drag to nudge and zoom to crop tighter if you want.</p>' +
        '<div class="logo-adj-stage" style="background:' + bg + '"><canvas class="la-cv"></canvas></div>' +
        '<label class="la-zoom">🔍 <input type="range" id="laZoom" min="0.1" max="5" step="0.01" value="1"></label>' +
        '<div class="la-acts"><button class="btn btn-sm" id="laReset">Reset</button><span style="flex:1"></span><button class="btn btn-ghost btn-sm" id="laCancel">Cancel</button><button class="btn btn-primary btn-sm" id="laUse">Use logo</button></div>' +
        '</div>';
      document.body.appendChild(ov);

      var cv = ov.querySelector(".la-cv");
      cv.width = EX_W; cv.height = EX_H;
      var cx = cv.getContext("2d");
      function compose(ctx, withBg) {
        ctx.clearRect(0, 0, EX_W, EX_H);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high"; // crisp downscale
        if (withBg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, EX_W, EX_H); }
        var dw = img.width * base * st.zoom, dh = img.height * base * st.zoom;
        ctx.drawImage(img, (EX_W - dw) / 2 + st.x, (EX_H - dh) / 2 + st.y, dw, dh);
      }
      function draw() { compose(cx, true); }
      draw();

      var dragging = false, lastX = 0, lastY = 0;
      function ratio() { return EX_W / (cv.clientWidth || EX_W); }
      function onMove(e) { if (!dragging) return; var r = ratio(); st.x += (e.clientX - lastX) * r; st.y += (e.clientY - lastY) * r; lastX = e.clientX; lastY = e.clientY; draw(); }
      cv.addEventListener("mousedown", function (e) { dragging = true; lastX = e.clientX; lastY = e.clientY; e.preventDefault(); });
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", function () { dragging = false; });
      cv.addEventListener("touchstart", function (e) { var t = e.touches[0]; dragging = true; lastX = t.clientX; lastY = t.clientY; }, { passive: true });
      cv.addEventListener("touchmove", function (e) { if (!dragging) return; var t = e.touches[0], r = ratio(); st.x += (t.clientX - lastX) * r; st.y += (t.clientY - lastY) * r; lastX = t.clientX; lastY = t.clientY; draw(); e.preventDefault(); }, { passive: false });
      cv.addEventListener("touchend", function () { dragging = false; });

      var zoom = ov.querySelector("#laZoom");
      zoom.addEventListener("input", function () { st.zoom = parseFloat(zoom.value) || 1; draw(); });
      ov.querySelector("#laReset").addEventListener("click", function () { st = { zoom: 1, x: 0, y: 0 }; zoom.value = "1"; draw(); });
      function close() { window.removeEventListener("mousemove", onMove); ov.remove(); }
      ov.querySelector("#laCancel").addEventListener("click", close);
      ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
      ov.querySelector("#laUse").addEventListener("click", function () {
        var out = document.createElement("canvas"); out.width = EX_W; out.height = EX_H;
        compose(out.getContext("2d"), false); // transparent export
        var url = out.toDataURL("image/png");
        close(); onDone(url);
      });
    }
  }

  /* ---- Branding (admin): make the portal the customer's own ----
     Logo, brand name and accent color, all writing the per-workspace branding
     store. Changes apply to the live chrome immediately via __rosApplyBrand. */
  function renderBranding(el) {
    // First-run after signup: a one-time welcome that frames branding as step one
    // of making this their own white-label portal. Cleared once shown.
    var onboarding = false;
    try { onboarding = localStorage.getItem("ros_onboard") === "1"; } catch (e) {}
    if (onboarding) { try { localStorage.removeItem("ros_onboard"); } catch (e) {} }
    var welcome = onboarding
      ? '<div class="card" style="border-color:var(--brand);margin-bottom:14px">' +
        '<h3 style="margin:0 0 4px">👋 Welcome, let\'s make this portal yours</h3>' +
        '<p class="setup-metric" style="margin:0">Set your brand name, logo and accent color below. This is what you and your whole team see everywhere, including your sign-in page.' +
        (isLumeWorkspace() ? "" : ' When you\'re ready to run it on your own web address, head to <a href="#setup/domain">Custom domain →</a> (you can do that anytime).') + '</p></div>'
      : "";
    el.innerHTML =
      '<div class="sx-hero"><div class="sx-ic">🎨</div><div><h2>Branding</h2>' +
      '<p>Make the portal yours, your logo, your name, your accent color. Your team and your customers see this everywhere, including your sign-in page.</p></div></div>' +
      welcome +
      '<div id="brBody">' + loading() + '</div>';

    // Accent presets, curated, on-brand options plus the platform default.
    var ACCENTS = ["#7c5cff", "#4dd0ff", "#38e0a6", "#ff7ac6", "#ffc24d", "#ff6b6b", "#5b8def", "#a78bfa", "#10b981"];

    function refreshChrome(b) { if (window.__rosApplyBrand) window.__rosApplyBrand(b || {}); }
    function brLogoFrame(url, bg) {
      var bgc = bg === "light" ? "#f6f7fc" : "#13131c";
      if (!url) return '<div class="sx-logo-frame" style="background:' + bgc + '"><span class="sx-logo-empty">No ' + bg + ' logo' + (bg === "light" ? ", uses dark" : "") + '</span></div>';
      return '<div class="sx-logo-frame" style="background:' + bgc + '"><img src="' + esc(url) + '"></div>';
    }

    function load() {
      api("/branding").then(function (d) {
        var b = (d && d.branding) || {};
        var box = $("#brBody"); if (!box) return;
        var accent = b.accentColor || "#7c5cff";
        // A workspace with ANY branding set is white-label, never surface the
        // house brand here, even if host/workspace detection was inconclusive.
        var houseBrand = IS_HOUSE && !(b.brandName || b.logoUrl || b.logoLightUrl || b.accentColor);
        var defName = houseBrand ? HOUSE_BRAND : "your brand";
        var swHtml = ACCENTS.map(function (c) {
          return '<span class="sx-sw' + (c.toLowerCase() === accent.toLowerCase() ? " on" : "") + '" data-c="' + c + '" style="background:' + c + '" title="' + c + '"></span>';
        }).join("");
        box.innerHTML = '<div class="sx-cols">' +
          /* ---- left: controls ---- */
          '<div>' +
          '<div class="sx-card"><div class="sx-eyebrow">Identity</div>' +
          '<div class="cn-fld"><span class="lab">Brand name</span><input id="brName" type="text" placeholder="' + esc(defName) + '" value="' + esc(b.brandName || "") + '"><span class="hint">Used as the wordmark when there\'s no logo, in the browser tab, and on your login page.</span></div>' +
          '<div class="cn-fld" style="margin-bottom:4px"><span class="lab">Accent color</span>' +
          '<div class="sx-colorrow"><input id="brAccent" type="color" value="' + esc(accent) + '" style="width:46px;height:34px;padding:2px;border-radius:9px;cursor:pointer;border:1px solid var(--border);background:var(--bg-soft)">' +
          '<span class="sx-hex" id="brHex">' + esc(accent) + '</span>' +
          '<div class="sx-swatches" id="brSwatches">' + swHtml + '</div></div>' +
          '<span class="hint">Primary color for buttons and highlights across the portal.</span></div>' +
          '</div>' +
          '<div class="sx-card"><div class="sx-eyebrow">Logo</div>' +
          '<div class="cn-fld"><span class="lab">Sidebar logo size</span><input id="brScale" type="range" min="0.4" max="3" step="0.02" value="' + (b.logoScale || 1) + '" style="width:100%;max-width:280px;accent-color:var(--brand)"><span class="hint">Drag for a live preview, release to save.</span></div>' +
          '<div class="cn-fld"><span class="lab">Dark appearance</span>' +
          brLogoFrame(b.logoUrl, "dark") +
          '<div class="sx-uprow"><label class="btn btn-sm" style="cursor:pointer">📤 Upload &amp; fit<input class="brLogoFile" data-key="logoUrl" data-bg="dark" type="file" accept="image/*" hidden></label>' +
          (b.logoUrl ? '<button class="btn btn-ghost btn-sm brLogoRemove" data-key="logoUrl">Remove</button>' : "") +
          '</div><span class="hint">A transparent or light logo that reads on the dark sidebar.</span></div>' +
          '<div class="cn-fld" style="margin-bottom:0"><span class="lab">Light appearance</span>' +
          brLogoFrame(b.logoLightUrl, "light") +
          '<div class="sx-uprow"><label class="btn btn-sm" style="cursor:pointer">📤 Upload &amp; fit<input class="brLogoFile" data-key="logoLightUrl" data-bg="light" type="file" accept="image/*" hidden></label>' +
          (b.logoLightUrl ? '<button class="btn btn-ghost btn-sm brLogoRemove" data-key="logoLightUrl">Remove</button>' : "") +
          '</div><span class="hint">A colored logo for Light appearance. Falls back to the dark logo if empty.</span></div>' +
          '</div>' +
          '<div class="cn-acts" style="margin-top:14px"><button class="btn btn-primary btn-sm" id="brSave">Save branding</button><button class="btn btn-ghost btn-sm" id="brReset">' + (houseBrand ? "Reset to RecruitersOS" : "Reset to default") + '</button></div>' +
          '<p class="cn-msg" id="brMsg"></p>' +
          '</div>' +
          /* ---- right: live preview ---- */
          '<div class="sx-prev"><div class="sx-prev-bar">Live preview</div><div class="sx-prev-body">' +
          '<div class="sx-prev-side" id="brPrevSide">' +
          '<div class="sx-prev-logo" id="brPrevLogo"></div>' +
          '<div class="sx-prev-nav"><span class="on" id="brPrevNav"><i></i> Dashboard</span><span><i></i> Campaigns</span><span><i></i> Candidates</span></div>' +
          '<button class="sx-prev-btn" id="brPrevBtn">New campaign</button>' +
          '</div><div class="sx-prev-cap">This is what your team & login page see.</div>' +
          '</div></div>' +
          '</div>';

        var msg = $("#brMsg");
        function say(t, kind) { if (msg) { msg.textContent = t; msg.style.color = kind === "err" ? "var(--accent-red)" : kind === "ok" ? "var(--accent-green)" : "var(--text-dim)"; } }

        // Live preview painter, reflects the current (unsaved) name/color/logo.
        function paintPreview() {
          var nm = ($("#brName").value || "").trim() || defName;
          var col = $("#brAccent").value || "#7c5cff";
          var logo = $("#brPrevLogo"); if (!logo) return;
          logo.innerHTML = b.logoUrl
            ? '<img src="' + esc(b.logoUrl) + '">'
            : '<span class="dot" style="background:linear-gradient(145deg,' + col + ',' + col + 'cc)">' + esc(nm.charAt(0).toUpperCase() || "R") + '</span><span>' + esc(nm) + '</span>';
          var nav = $("#brPrevNav"); if (nav) { nav.style.background = col + "22"; nav.style.color = col; }
          var btn = $("#brPrevBtn"); if (btn) btn.style.background = "linear-gradient(135deg," + col + "," + col + "cc)";
          var hex = $("#brHex"); if (hex) hex.textContent = col;
        }
        paintPreview();

        $("#brName").addEventListener("input", paintPreview);
        function setAccent(c) {
          $("#brAccent").value = c;
          Array.prototype.forEach.call($("#brSwatches").querySelectorAll(".sx-sw"), function (s) {
            s.classList.toggle("on", s.getAttribute("data-c").toLowerCase() === c.toLowerCase());
          });
          paintPreview();
        }
        $("#brAccent").addEventListener("input", function () { setAccent($("#brAccent").value); });
        Array.prototype.forEach.call($("#brSwatches").querySelectorAll(".sx-sw"), function (s) {
          s.addEventListener("click", function () { setAccent(s.getAttribute("data-c")); });
        });

        $("#brSave").addEventListener("click", function () {
          var patch = { brandName: ($("#brName").value || "").trim(), accentColor: $("#brAccent").value };
          say("Saving…");
          send("/branding", "POST", patch).then(function (r) {
            if (r && r.ok && r.data && r.data.branding) { refreshChrome(r.data.branding); toast("Branding saved"); load(); }
            else say("Couldn't save branding.", "err");
          }).catch(function () { say("Couldn't reach the server.", "err"); });
        });

        $("#brReset").addEventListener("click", function () {
          if (!confirm(houseBrand ? "Reset to the default RecruitersOS branding?" : "Reset to the default branding?")) return;
          send("/branding", "POST", { action: "reset" }).then(function (r) {
            refreshChrome((r && r.data && r.data.branding) || {}); toast(houseBrand ? "Reset to RecruitersOS" : "Branding reset"); load();
          });
        });

        var scaleEl = $("#brScale");
        if (scaleEl) {
          scaleEl.addEventListener("input", function () {
            refreshChrome(Object.assign({}, b, { logoScale: parseFloat(scaleEl.value) || 1 }));
          });
          scaleEl.addEventListener("change", function () {
            var v = parseFloat(scaleEl.value) || 1;
            send("/branding", "POST", { logoScale: v }).then(function (r) {
              if (r && r.ok && r.data && r.data.branding) { b = r.data.branding; refreshChrome(b); toast("Logo size saved"); }
            });
          });
        }

        Array.prototype.forEach.call(box.querySelectorAll(".brLogoFile"), function (input) {
          input.addEventListener("change", function () {
            var f = input.files && input.files[0]; if (!f) return;
            if (!/^image\//.test(f.type)) { say("Please choose an image file.", "err"); return; }
            var key = input.getAttribute("data-key"), bgk = input.getAttribute("data-bg");
            openLogoAdjuster(f, { bg: bgk, label: bgk === "light" ? "light mode" : "dark mode" }, function (dataUrl) {
              var patch = {}; patch[key] = dataUrl;
              say("Uploading…");
              send("/branding", "POST", patch).then(function (r) {
                if (r && r.ok && r.data && r.data.branding) { refreshChrome(r.data.branding); toast("Logo updated"); load(); }
                else say(r && r.data && r.data.error === "logo_too_large" ? "That logo is too large. Try a smaller image." : "Couldn't save the logo.", "err");
              });
            });
            input.value = "";
          });
        });
        Array.prototype.forEach.call(box.querySelectorAll(".brLogoRemove"), function (btn) {
          btn.addEventListener("click", function () {
            var patch = {}; patch[btn.getAttribute("data-key")] = "";
            send("/branding", "POST", patch).then(function (r) { if (r && r.ok && r.data && r.data.branding) { refreshChrome(r.data.branding); toast("Logo removed"); load(); } });
          });
        });
      }).catch(function () { var box = $("#brBody"); if (box) box.innerHTML = needsSetup(); });
    }
    load();
  }

  /* ---- Custom domain (admin): run the portal on the customer's own domain ----
     Add a domain, publish two DNS records (CNAME to point traffic at us + a TXT
     token to prove ownership), then Verify. The host->workspace serving + TLS is
     wired at the edge/deploy layer; this screen owns the domain record + proof. */
  function renderDomain(el) {
    el.innerHTML =
      '<div class="sx-hero"><div class="sx-ic">🌐</div><div><h2>Custom domain</h2>' +
      '<p>Run your portal on your own domain, your recruiters sign in at your URL, fully branded. Add it, drop in two DNS records, then Verify. Until then your workspace stays on ' + esc(PLATFORM_HOST) + '.</p></div></div>' +
      '<div id="domBody">' + loading() + '</div>';

    function steps3(status) {
      if (status === "live") return ["done", "done", "done"];
      if (status === "verified") return ["done", "done", "active"];
      if (status === "pending") return ["done", "active", "todo"];
      return ["active", "todo", "todo"];
    }
    function stepNode(n, t, cls) {
      return '<div class="sx-step ' + cls + '"><div class="n">' + (cls === "done" ? "✓" : n) + '</div><div class="t">' + t + '</div></div>';
    }

    function load() {
      api("/branding/domain").then(function (d) {
        var b = (d && d.branding) || {};
        var ins = (d && d.instructions) || null;
        var domain = b.customDomain || "";
        var status = b.domainStatus || "none";
        var dom = $("#domBody"); if (!dom) return;
        var st = steps3(status);
        var html = "";

        // Success / verified banner up top, the win is the first thing they see.
        if (status === "live") {
          html += '<div class="sx-done"><div class="ic">🎉</div><div style="min-width:0;flex:1">' +
            '<div style="font-weight:800;font-size:15px">You’re live on <span class="sx-mono">' + esc(domain) + '</span></div>' +
            '<div style="font-size:12px;color:var(--text-dim);margin-top:2px">Your portal is serving on your own domain over HTTPS.</div></div>' +
            '<a class="btn btn-primary btn-sm" href="https://' + esc(domain) + '" target="_blank" rel="noopener">Visit portal →</a></div>';
        } else if (status === "verified") {
          html += '<div class="sx-done"><div class="ic">✓</div><div style="min-width:0;flex:1">' +
            '<div style="font-weight:800;font-size:15px">Verified, finishing up</div>' +
            '<div style="font-size:12px;color:var(--text-dim);margin-top:2px">Ownership confirmed. Your HTTPS certificate is issued automatically the first time someone opens <span class="sx-mono">' + esc(domain) + '</span>, nothing to install.</div></div></div>';
        }

        // Card 1, guided stepper + the domain field.
        html += '<div class="sx-card"><div class="sx-steps">' +
          stepNode("1", "Add your domain", st[0]) +
          stepNode("2", "Add DNS records", st[1]) +
          stepNode("3", "Verify &amp; go live", st[2]) +
          '</div>' +
          '<div style="height:1px;background:var(--border);margin:6px 0 16px"></div>' +
          '<div class="cn-fld"><span class="lab">Your domain</span>' +
          '<input id="domInput" type="text" placeholder="app.yourcompany.com" value="' + esc(domain) + '"><span class="hint">A subdomain you control, e.g. <code>app.yourcompany.com</code> or <code>portal.yourcompany.com</code>. The records below only point this name at us; the rest of your domain is untouched.</span></div>' +
          '<div class="cn-acts">' +
          '<button class="btn btn-primary btn-sm" id="domSave">' + (domain ? "Update domain" : "Add domain") + '</button>' +
          (domain ? '<button class="btn btn-ghost btn-sm danger" id="domRemove" style="margin-left:auto">Remove</button>' : "") +
          '</div><p class="cn-msg" id="domMsg"></p></div>';

        // Card 2, DNS records, with both Name and Value individually copyable.
        if (ins && ins.records && ins.records.length) {
          var txt = null, i;
          for (i = 0; i < ins.records.length; i++) { if (ins.records[i].type === "TXT") { txt = ins.records[i]; break; } }
          var fullHost = txt ? txt.host : ("_recruiteros." + domain);
          var parts = domain.split("."); var root = parts.length > 2 ? parts.slice(-2).join(".") : domain;
          var shortHost = fullHost.indexOf("." + root) > -1 ? fullHost.replace("." + root, "") : fullHost;

          html += '<div class="sx-card"><div class="sx-eyebrow">Step 2 · DNS records</div>' +
            '<h3>Add these two records at your DNS provider</h3>' +
            '<p class="sx-sub">Copy each field into your domain’s DNS settings, then hit <b>Verify</b>. New records usually propagate within a few minutes.</p>' +
            '<div class="sx-dns">' +
            ins.records.map(function (r) {
              var purpose = r.type === "CNAME" ? "Points your domain to us" : r.type === "TXT" ? "Proves you own it" : "";
              return '<div class="sx-rec"><div class="sx-rec-top"><span class="sx-rec-type">' + esc(r.type) + '</span><span class="sx-rec-purpose">' + purpose + '</span></div>' +
                '<div class="sx-rec-field"><span class="sx-rec-k">Name</span><div class="sx-rec-val"><code>' + esc(r.host) + '</code><button class="sx-copy" data-copy="' + esc(r.host) + '">Copy</button></div></div>' +
                '<div class="sx-rec-field"><span class="sx-rec-k">Value</span><div class="sx-rec-val"><code>' + esc(r.value) + '</code><button class="sx-copy" data-copy="' + esc(r.value) + '">Copy</button></div></div>' +
                '</div>';
            }).join("") + '</div>' +
            '<div class="sx-tip"><span class="ti">💡</span><div>Some providers (GoDaddy, Namecheap, Cloudflare) add your domain to the <b>Name</b> automatically. If yours does, enter just <code>' + esc(shortHost) + '</code> for the TXT record instead of the full name, otherwise paste exactly what’s shown.</div></div>' +
            (status !== "live" ? '<div class="cn-acts" style="margin-top:15px;align-items:center"><button class="btn btn-primary btn-sm" id="domVerify">Verify DNS</button><span style="font-size:11.5px;color:var(--text-dim)">🔒 HTTPS is set up automatically, no certificate to install.</span></div>' : "") +
            '</div>';
        }

        dom.innerHTML = html;

        Array.prototype.forEach.call(dom.querySelectorAll(".sx-copy"), function (btn) {
          btn.addEventListener("click", function () {
            var v = btn.getAttribute("data-copy");
            try {
              if (navigator.clipboard) navigator.clipboard.writeText(v);
            } catch (e) {}
            var was = btn.textContent; btn.textContent = "Copied ✓"; btn.style.color = "var(--accent-green)";
            setTimeout(function () { btn.textContent = was; btn.style.color = ""; }, 1400);
          });
        });

        var msg = $("#domMsg");
        function say(t, kind) { if (msg) { msg.textContent = t; msg.style.color = kind === "err" ? "var(--accent-red)" : kind === "ok" ? "var(--accent-green)" : "var(--text-dim)"; } }

        var save = $("#domSave");
        if (save) save.addEventListener("click", function () {
          var v = ($("#domInput").value || "").trim();
          if (!v) { say("Enter a domain first.", "err"); return; }
          save.disabled = true; say("Saving…");
          send("/branding/domain", "POST", { action: "set", domain: v }).then(function (r) {
            if (r && r.ok) { toast("Domain added. Add the DNS records below."); load(); }
            else { say((r && r.data && r.data.error === "invalid_domain") ? "That doesn't look like a valid domain." : "Couldn't save the domain.", "err"); save.disabled = false; }
          }).catch(function () { say("Couldn't reach the server.", "err"); save.disabled = false; });
        });

        var verify = $("#domVerify");
        if (verify) verify.addEventListener("click", function () {
          verify.disabled = true; say("Checking DNS…");
          send("/branding/domain", "POST", { action: "verify" }).then(function (r) {
            if (r && r.ok && r.data && r.data.verified) { toast("Domain verified ✓"); load(); }
            else { say(r && r.data && r.data.error === "txt_not_found" ? "TXT record not found yet. Add it and give DNS a few minutes." : "Couldn't verify yet. Check the records and retry.", "err"); verify.disabled = false; }
          }).catch(function () { say("Couldn't reach the server.", "err"); verify.disabled = false; });
        });

        var remove = $("#domRemove");
        if (remove) remove.addEventListener("click", function () {
          if (!confirm("Remove this custom domain? Your portal goes back to " + hostLabel + ".")) return;
          send("/branding/domain", "POST", { action: "remove" }).then(function () { toast("Domain removed"); load(); });
        });
      }).catch(function () { var b = $("#domBody"); if (b) b.innerHTML = needsSetup(); });
    }
    load();
  }

  /* ---- Voice setup (admin): telephony provider + cloned voice ----
     Both Voice Drops and AI Vetting run on the same two dependencies, Telnyx as
     the telephony provider, and the operator's consented cloned voice. This panel
     stands both up in the Setup hub: connect/Test Telnyx inline (reusing the
     Integrations Connect dialog), record a consented voice clone, and see a
     readiness gate. Running campaigns / desks stays in the feature tab. */
  function renderVoiceSetup(el, which) {
    var cfg = which === "vetting"
      ? { title: "AI Vetting setup", icon: "☎️", featureRoute: "vetting", featureLabel: "Open AI Vetting →",
          intro: "AI Vetting answers inbound candidate calls with an AI recruiter in your cloned voice. It needs Telnyx for the phone number + call handling, and a consented cloned voice. Bind a job description to a number inside AI Vetting once both are green.",
          extra: "Each vetting desk binds one job description to one of your Telnyx numbers and this voice, set that up per-desk in AI Vetting." }
      : { title: "Voice Drops setup", icon: "📞", featureRoute: "voicedrops", featureLabel: "Open Voice Drops →",
          intro: "Voice Drops leaves a personalized cloned-voice voicemail on verified business landlines/VoIP. It needs Telnyx (Premium AMD + outbound calling) and a consented cloned voice. Mobiles are filtered and never dialed.",
          extra: "Launching a drop also requires a per-campaign consent attestation and an identifying script, done inside Voice Drops." };

    el.innerHTML =
      '<div class="sx-hero"><div class="sx-ic">' + cfg.icon + '</div><div><h2>' + esc(cfg.title.replace(" setup", "")) + '</h2>' +
      '<p>' + esc(cfg.intro) + '</p></div></div>' +
      '<div id="vsReady" style="margin-bottom:16px"></div>' +
      '<div class="sx-card"><div class="sx-eyebrow">Step 1 · Telephony</div><h3>📞 Telnyx</h3>' +
      '<p class="sx-sub">The calling engine behind Voice Drops, it places the calls and uses Premium AMD to find the voicemail. Connect your Telnyx API key and a caller-ID number, then Test. New to Telnyx? Follow the <a href="/helpcenter#telephony" target="_blank" rel="noopener" style="color:var(--brand-2)">10DLC setup guide</a> to register your brand &amp; campaign so your calls connect.</p>' +
      '<div id="vsTel">' + loading() + '</div></div>' +
      '<div class="sx-card"><div class="sx-eyebrow">Step 2 · Voice</div><h3>🎙️ Your voice</h3>' +
      '<p class="sx-sub">Two quick steps: connect a voice provider (ElevenLabs, Cartesia or Hume) with its API key, then add the voice id you cloned in that provider\'s portal and mark it as the one to use.</p>' +
      '<div id="vsVoice">' + loading() + '</div></div>' +
      '<div class="sx-card"><p class="sx-sub" style="margin:0">' + esc(cfg.extra) + '</p>' +
      '<div style="margin-top:12px"><a class="btn btn-primary btn-sm" href="#' + cfg.featureRoute + '">' + esc(cfg.featureLabel) + '</a></div></div>';

    var st = { telnyx: null, clones: [], provConfigured: false, providerConfigured: {} };
    function paintReady() {
      var telOk = st.telnyx && st.telnyx.status === "green";
      // A voice only counts if a voice is on file AND its clone provider's key is
      // verified, otherwise it would deploy into a silent dry-run. When an engine
      // is explicitly chosen, judge readiness against THAT engine (its key
      // connected + a voice that resolves for it); otherwise "any usable voice".
      var pc = st.providerConfigured || {};
      var voiceOk = st.activeProvider
        ? (Boolean(pc[st.activeProvider]) && Boolean(st.active))
        : st.active
          ? Boolean(pc[(st.active.provider || "elevenlabs")])
          : (st.clones || []).some(function (c) { return pc[(c.provider || "elevenlabs")]; });
      var ready = telOk && voiceOk;
      var b = $("#vsReady"); if (!b) return;
      var done = (telOk ? 1 : 0) + (voiceOk ? 1 : 0);
      function chk(ok, label) {
        return '<div class="sx-chk ' + (ok ? "done" : "todo") + '"><span class="mk">' + (ok ? "✓" : "·") + '</span>' + esc(label) + '</div>';
      }
      b.innerHTML = '<div class="sx-card" style="' + (ready ? "border-color:rgba(56,224,166,.4)" : "border-color:rgba(255,194,77,.32)") + '">' +
        '<div class="sx-status"><span class="dot ' + (ready ? "ok" : "warn") + '"></span>' +
        '<div><div class="lab">' + (ready ? cfg.title.replace(" setup", "") + " is ready" : "Almost there, " + done + " of 2 done") + '</div>' +
        '<div class="sub">' + (ready ? "Telnyx connected and a voice provider in place." : "Finish both steps below to go live.") + '</div></div>' +
        '<span class="s-pill ' + (ready ? "ready" : "progress") + '" style="margin-left:auto">' + (ready ? "Ready ✓" : done + "/2") + '</span></div>' +
        '<div class="sx-checks" style="margin-top:14px">' + chk(telOk, "Telnyx connected & tested") + chk(voiceOk, "Voice provider connected + voice on file") + '</div>' +
        '</div>';
    }
    function loadTelnyx() {
      api("/connected").then(function (d) {
        var ints = (d && d.integrations) || [];
        st.telnyx = ints.filter(function (x) { return x.id === "telnyx"; })[0] || null;
        var box = $("#vsTel"); if (!box) return;
        if (!st.telnyx) { box.innerHTML = '<p class="muted">Telnyx integration unavailable.</p>'; return; }
        var sm = cnStatusMeta(st.telnyx.status);
        box.innerHTML = '<div class="cn-grid"><button class="cn-v" id="vsTelBtn">' +
          '<span class="dot3" style="background:' + sm.color + '"></span>' +
          '<div class="meta"><b>Telnyx</b><small>' + (st.telnyx.error ? esc(st.telnyx.error) : "Outbound calling + Premium AMD voicemail detection") + '</small></div>' +
          '<span class="cn-badge" style="' + sm.badge + '">' + sm.label + '</span><span class="cn-go">›</span></button></div>';
        $("#vsTelBtn").addEventListener("click", function () { openIntegrationSetup(st.telnyx, loadTelnyx); });
        paintReady();
      }).catch(function () { var b = $("#vsTel"); if (b) b.innerHTML = needsSetup(); });
    }
    // The three cloned-voice providers. Each is set up on its own card: paste the
    // key, Save & test, and the card reflects its real verified state.
    var VOICE_PROVS = [
      { id: "elevenlabs", label: "ElevenLabs", env: "VOICE_CLONE_API_KEY", ph: "sk_…", docs: "https://elevenlabs.io/app/settings/api-keys", lab: "https://elevenlabs.io/app/voice-lab" },
      { id: "cartesia", label: "Cartesia", env: "CARTESIA_API_KEY", ph: "sk_car_…", docs: "https://play.cartesia.ai/keys", lab: "https://play.cartesia.ai" },
      { id: "hume", label: "Hume", env: "HUME_API_KEY", ph: "paste your Hume API key", docs: "https://platform.hume.ai/settings/keys", lab: "https://platform.hume.ai" },
    ];
    // Turn a raw verify error code into a plain-English fix. The most common one
    // is a scope-restricted ElevenLabs key: valid for TTS but missing read access.
    function voiceErrText(code) {
      if (!code) return "the key was rejected";
      if (code === "elevenlabs_invalid_key")
        return "ElevenLabs rejected this key — it's invalid or revoked. Copy it again from your ElevenLabs profile → API Keys (and check it's the right account).";
      if (code === "elevenlabs_unauthorized" || code === "elevenlabs_401" || code === "elevenlabs_403")
        return "key rejected or missing read access — in ElevenLabs, give the key permission to read User or Voices (or create a key with full access), then paste it again";
      if (code === "no_api_key") return "no key saved yet";
      return code;
    }
    function loadVoice() {
      // Two reads: the saved voices + which one is active (voice module), and the
      // per-provider connection status (green=verified / yellow=saved-not-verified
      // / red=no key) from the integrations catalog — so the dots tell the truth,
      // not just "a key is present".
      Promise.all([api("/voice/clones"), api("/connected")]).then(function (res) {
        var d = res[0] || {}, cd = res[1] || {};
        st.clones = d.consent || [];
        st.activeVoiceId = d.activeVoiceId || null;
        st.activeProvider = d.activeProvider || null;
        var ints = (cd && cd.integrations) || [];
        function pstat(id) { var x = ints.filter(function (i) { return i.id === id; })[0]; return (x && x.status) || "red"; }
        function perr(id) { var x = ints.filter(function (i) { return i.id === id; })[0]; return (x && x.error) || ""; }
        var pstatus = { elevenlabs: pstat("elevenlabs"), cartesia: pstat("cartesia"), hume: pstat("hume") };
        st.providerConfigured = { elevenlabs: pstatus.elevenlabs === "green", cartesia: pstatus.cartesia === "green", hume: pstatus.hume === "green" };
        st.provConfigured = st.providerConfigured.elevenlabs || st.providerConfigured.cartesia || st.providerConfigured.hume;

        // The active ENGINE is the prominent choice. The voice actually used on a
        // drop is the one that resolves for that engine: the pinned voice if it
        // belongs to the engine, else the engine's most recent saved voice.
        var pinned = st.clones.filter(function (c) { return c.id === st.activeVoiceId; })[0] || null;
        var lastVoice = st.clones.length ? st.clones[st.clones.length - 1] : null;
        var usedProvider = st.activeProvider || (pinned && pinned.provider) || (lastVoice && lastVoice.provider) || null;
        function voiceForProvider(pid) {
          if (pinned && (pinned.provider || "elevenlabs") === pid) return pinned;
          return st.clones.filter(function (c) { return c.voiceId && (c.provider || "elevenlabs") === pid; }).slice(-1)[0] || null;
        }
        var active = usedProvider ? voiceForProvider(usedProvider) : (pinned || lastVoice);
        st.active = active;

        function provCard(p) {
          var s = pstatus[p.id], ok = s === "green", saved = s !== "red", inUse = usedProvider === p.id;
          var dotc = ok ? "var(--accent-green)" : saved ? "var(--accent-amber)" : "var(--text-dim)";
          var stateTxt = ok ? "connected" : saved ? "saved · not verified" : "not connected";
          var savedErr = saved ? perr(p.id) : "";
          var msgHtml = ok ? "Key saved in your portal and verified — ready to deploy."
            : saved ? '<span style="color:var(--accent-amber)">' + esc(savedErr ? voiceErrText(savedErr) : "Key saved, but the live test didn't pass. Paste it again, or hit Test.") + "</span>"
            : '<a href="' + p.docs + '" target="_blank" rel="noopener">Get your ' + p.label + ' API key ↗</a>';
          return '<div class="vp' + (inUse ? " on" : "") + '">' +
            '<div class="vp-head">' +
              '<span class="vp-dot" data-vpdot="' + p.id + '" style="background:' + dotc + '"></span>' +
              '<span class="vp-name">' + p.label + '</span>' +
              '<span class="vp-state" data-vpstate="' + p.id + '">' + stateTxt + '</span>' +
              '<span style="margin-left:auto;display:flex;gap:7px;align-items:center">' +
                (inUse
                  ? '<span class="vp-chip">✓ in use</span>'
                  : '<button class="btn btn-ghost btn-sm" data-vsprov="' + p.id + '" title="Use this engine for tests and sends" style="padding:3px 11px">Use this engine</button>') +
                (saved ? '<button class="btn btn-ghost btn-sm" data-vptest="' + p.id + '" style="padding:3px 11px">Test</button>' : "") +
              '</span>' +
            '</div>' +
            '<div class="vp-row">' +
              '<input class="vp-key" data-vpkey="' + p.id + '" type="password" autocomplete="off" placeholder="' + (saved ? "paste a new key to replace it" : p.ph) + '">' +
              '<button class="btn btn-primary btn-sm" data-vpsave="' + p.id + '">Save &amp; test</button>' +
            '</div>' +
            '<div class="vp-msg" data-vpmsg="' + p.id + '">' + msgHtml + '</div>' +
          '</div>';
        }

        function voiceRow(c) {
          var pid = c.provider || "elevenlabs", isActive = active && c.id === active.id, provOk = st.providerConfigured[pid];
          return '<div class="vc' + (isActive ? " on" : "") + '">' +
            '<span class="vp-dot" style="background:' + (provOk ? "var(--accent-green)" : "var(--accent-amber)") + '"></span>' +
            '<div style="min-width:0"><div class="vc-name">🎙️ ' + esc(c.agentName) + '</div>' +
            '<div class="vc-meta">' + esc(pid) + (c.voiceId ? " · " + esc(c.voiceId) : " · no voice id") + (provOk ? "" : " · connect " + esc(pid) + " above to use") + '</div></div>' +
            '<span style="margin-left:auto;display:flex;gap:7px;align-items:center;flex:0 0 auto">' +
              (isActive ? '<span class="vp-chip">in use</span>' : '<button class="btn btn-ghost btn-sm" data-vsuse="' + esc(c.id) + '" style="padding:3px 11px">Use this</button>') +
              '<button class="btn btn-ghost btn-sm" data-vsdel="' + esc(c.id) + '" title="Remove from your list" style="padding:3px 9px">🗑️</button>' +
            '</span>' +
          '</div>';
        }

        var voices = st.clones.length
          ? st.clones.map(voiceRow).join("")
          : '<p class="muted" style="font-size:12.5px;margin:4px 0 0">No voices added yet. Paste a cloned voice id below to add one.</p>';

        var box = $("#vsVoice"); if (!box) return;
        box.innerHTML =
          '<div class="sx-eyebrow" style="margin:2px 0 9px">Pick &amp; connect your voice engine</div>' +
          '<p class="muted" style="font-size:12.5px;margin:0 0 12px">You only need one. Paste that provider\'s API key and hit <b>Save &amp; test</b> (verified live so you know it will deploy), then hit <b>Use this engine</b> to make it the one every test drop and live send uses. The card marked <b>✓ in use</b> is the active engine. Cloning itself happens inside the provider\'s own portal.</p>' +
          '<div class="vp-list">' + VOICE_PROVS.map(provCard).join("") + '</div>' +
          '<div class="sx-eyebrow" style="margin:20px 0 9px">Your voice</div>' +
          '<p class="muted" style="font-size:12.5px;margin:0 0 10px">Add a cloned voice id, then pick which one is used for drops with <b>Use this</b>. The voice in use must have its provider connected above.</p>' +
          '<div class="vd-grid" style="display:grid;grid-template-columns:0.9fr 1.4fr 1fr auto;gap:10px;align-items:end">' +
          '<label class="cn-fld"><span class="lab">Provider</span><select id="vsProvider"><option value="elevenlabs">ElevenLabs</option><option value="cartesia">Cartesia</option><option value="hume">Hume</option></select></label>' +
          '<label class="cn-fld"><span class="lab">Voice ID</span><input id="vsVoiceId" type="text" placeholder="paste your voice id"></label>' +
          '<label class="cn-fld"><span class="lab">Name (whose voice)</span><input id="vsName" type="text" placeholder="Josh"></label>' +
          '<button class="btn btn-primary btn-sm" id="vsSave">Add voice</button></div>' +
          '<p class="muted" style="font-size:11.5px;margin:8px 0 0">No voice id yet? Copy it from <a href="https://elevenlabs.io/app/voice-lab" target="_blank" rel="noopener" style="color:var(--brand-2)">ElevenLabs ↗</a>, <a href="https://play.cartesia.ai" target="_blank" rel="noopener" style="color:var(--brand-2)">Cartesia ↗</a> or <a href="https://platform.hume.ai" target="_blank" rel="noopener" style="color:var(--brand-2)">Hume ↗</a>.</p>' +
          '<div style="margin-top:12px">' + voices + '</div>';

        // Per-provider Save & test: save the key as a workspace credential, then
        // verify it live so the card flips to its true state (green/amber).
        Array.prototype.forEach.call(box.querySelectorAll("[data-vpsave]"), function (btn) {
          btn.addEventListener("click", function () {
            var id = btn.getAttribute("data-vpsave");
            var p = VOICE_PROVS.filter(function (x) { return x.id === id; })[0];
            var input = box.querySelector('[data-vpkey="' + id + '"]');
            var msg = box.querySelector('[data-vpmsg="' + id + '"]');
            var key = ((input && input.value) || "").trim();
            if (!key) { if (msg) msg.innerHTML = '<span style="color:var(--accent-amber)">Paste your API key first.</span>'; if (input) input.focus(); return; }
            var keys = {}; keys[p.env] = key;
            var lbl = btn.textContent; btn.disabled = true; btn.textContent = "Saving…";
            if (msg) msg.textContent = "Saving the key…";
            send("/connected", "POST", { action: "save", id: id, keys: keys }).then(function (r) {
              if (!r.ok || !(r.data && r.data.result && r.data.result.ok)) {
                if (msg) msg.innerHTML = '<span style="color:#ff7a90">Could not save the key — try again.</span>';
                return null;
              }
              if (msg) msg.textContent = "Testing the key live…";
              // Test via /connected so the result is PERSISTED (markTested -> green),
              // not just checked — otherwise the card would stay "saved · not verified".
              return send("/connected", "POST", { action: "test", id: id });
            }).then(function (r) {
              btn.disabled = false; btn.textContent = lbl;
              if (!r) return;
              var okk = r.ok && r.data && r.data.result && r.data.result.status === "green";
              if (input) input.value = "";
              if (okk) { toast("✓ " + p.label + " connected & saved"); }
              else { toast(p.label + " saved, but the test failed"); }
              loadVoice(); // re-render shows the persisted state + reason on the card
            }).catch(function () { btn.disabled = false; btn.textContent = lbl; if (msg) msg.innerHTML = '<span style="color:#ff7a90">Could not reach the server.</span>'; });
          });
        });

        // Add a bring-your-own voice id to the list.
        $("#vsSave").addEventListener("click", function () {
          var payload = { agentName: ($("#vsName").value || "").trim(), voiceId: ($("#vsVoiceId").value || "").trim() || undefined, provider: (($("#vsProvider") || {}).value) || "elevenlabs" };
          if (!payload.agentName) { toast("Add a name"); return; }
          if (!payload.voiceId) { toast("Paste a voice id"); return; }
          send("/voice/clones", "POST", payload).then(function (r) {
            if (r.ok) { toast("Voice added"); loadVoice(); }
            else toast("Save failed");
          }).catch(function () { toast("Could not reach the server."); });
        });

        // Re-test an already-saved provider.
        Array.prototype.forEach.call(box.querySelectorAll("[data-vptest]"), function (btn) {
          btn.addEventListener("click", function () {
            var id = btn.getAttribute("data-vptest");
            var msg = box.querySelector('[data-vpmsg="' + id + '"]');
            var dot = box.querySelector('[data-vpdot="' + id + '"]');
            var stateEl = box.querySelector('[data-vpstate="' + id + '"]');
            if (msg) msg.textContent = "Testing…";
            // /connected test persists the verified result (green) so it survives reload.
            send("/connected", "POST", { action: "test", id: id }).then(function (r) {
              var rr = (r.data && r.data.result) || {};
              var okk = r.ok && rr.status === "green";
              if (dot) dot.style.background = okk ? "var(--accent-green)" : "var(--accent-amber)";
              if (stateEl) stateEl.textContent = okk ? "connected" : "key rejected";
              if (msg) msg.innerHTML = okk ? '<span style="color:var(--accent-green)">✓ Verified — ready to deploy.</span>' : '<span style="color:var(--accent-amber)">✗ ' + esc(voiceErrText(rr.error)) + '</span>';
              loadVoice();
            }).catch(function () { if (msg) msg.textContent = "Could not reach the server."; });
          });
        });

        // Pick which ENGINE (provider) is used on drops — the prominent choice.
        Array.prototype.forEach.call(box.querySelectorAll("[data-vsprov]"), function (btn) {
          btn.addEventListener("click", function () {
            var pid = btn.getAttribute("data-vsprov");
            send("/voice/clones", "POST", { action: "set-provider", provider: pid }).then(function (r) {
              if (r.ok) { toast("Voice engine set to " + pid); loadVoice(); }
              else toast("Could not set the engine");
            }).catch(function () { toast("Could not reach the server."); });
          });
        });

        // Pin which saved voice is the one used on drops (also flips the engine).
        Array.prototype.forEach.call(box.querySelectorAll("[data-vsuse]"), function (btn) {
          btn.addEventListener("click", function () {
            var id = btn.getAttribute("data-vsuse");
            send("/voice/clones", "POST", { action: "set-active", id: id }).then(function (r) {
              if (r.ok) { toast("Voice set as in use"); loadVoice(); }
              else toast("Could not set the active voice");
            }).catch(function () { toast("Could not reach the server."); });
          });
        });

        Array.prototype.forEach.call(box.querySelectorAll("[data-vsdel]"), function (btn) {
          btn.addEventListener("click", function () {
            var id = btn.getAttribute("data-vsdel");
            if (!confirm("Remove this voice from your list? It is not deleted from ElevenLabs, Cartesia or Hume.")) return;
            send("/voice/clones", "POST", { action: "delete", id: id }).then(function (r) {
              if (r.ok) { toast("Voice removed"); loadVoice(); }
              else toast("Delete failed");
            }).catch(function () { toast("Could not reach the server."); });
          });
        });
        paintReady();
      }).catch(function () { var b = $("#vsVoice"); if (b) b.innerHTML = needsSetup(); });
    }
    loadTelnyx(); loadVoice();
  }

  // The ordered launch checklist. Reads the same backends the sub-screens use and
  // derives a Red/Amber/Green status + a one-line metric per step, so an admin
  // sees at a glance what's left to stand up before going live.
  function renderSetupOverview(body) {
    var motionLabel = motion === "bd" ? "Business Development" : "Recruiting";
    body.innerHTML = head("Setup",
      "Everything an admin stands up before launch, in order. Connect your tools and choose your system of record, then switch the engine on.") +
      '<div id="setupOv">' + loading() + '</div>';

    // Step copy lives here so the loaded and error branches stay in sync.
    // The full go-live path in dependency order: stand up the back office, then
    // add recruiters, an audience, and a campaign to assign. `link` is where each
    // step's "Set up →" jumps (a sub-tab for infra, a route for the rest).
    var META = {
      connected: { title: "Connect your tools", desc: "Integration pre-flight, every required tool must turn green before campaigns can activate.",
        track: ["Each integration green", "API keys valid", "Telnyx / SMS reachable"], link: "setup/connected" },
      email: { title: "Stand up email sending", desc: "Add your sending domains, each is auto-provisioned (DKIM, DNS, PTR), warmed, and placement-tested before it sends.",
        track: ["≥1 MTA server active", "Domains provisioned", "Mailboxes warming"], link: "setup/email" },
      ats: { title: "Connect your ATS", desc: "Pick your system of record (Loxo is the verified primary). Replies, touches and placements sync once it's live.",
        track: ["Vendor verified", "Object mapping reviewed", "Two-way sync confirmed"], link: "setup/ats" },
      team: { title: "Add your recruiters", desc: "Invite the recruiters you'll assign campaigns to. They work the inbox, pipeline and dialer, never the back office.",
        track: ["≥1 recruiter invited", "Roles set", "Assignable in Campaigns"], link: "team" },
      audience: { title: "Load an audience", desc: "Import or source the people your campaigns will reach, so there's someone to enroll.",
        track: ["≥1 prospect / candidate", "Lists ready to enroll"], link: "data" },
      campaign: { title: "Build & assign a campaign", desc: "Create a sequence, then deploy it to a recruiter, all in the Campaigns hub.",
        track: ["≥1 sequence built", "Assigned to a recruiter", "Launched"], link: "campaigns" }
    };
    function mk(key, state, metric) { var m = META[key]; return { key: key, title: m.title, desc: m.desc, track: m.track, link: m.link, state: state, metric: metric }; }
    function grab(path) { return api(path).then(function (d) { return d; }, function () { return null; }); }

    function stepConnected(d) {
      if (!d) return mk("connected", "pending", "Couldn't load integration status.");
      var ints = d.integrations || [];
      var req = ints.filter(function (i) { return (i.requiredFor || []).indexOf(motion) >= 0; });
      var green = req.filter(function (i) { return i.status === "green"; }).length;
      var state = !req.length ? "pending" : green === req.length ? "ready" : green > 0 ? "progress" : "action";
      var metric = req.length ? (green + " of " + req.length + " required integrations green") : "No required integrations for this motion.";
      return mk("connected", state, metric);
    }
    function stepEmail(d) {
      if (!d) return mk("email", "pending", "Couldn't load email-sending status.");
      var domains = d.domains || [];
      var active = domains.filter(function (x) { return x.status === "active"; }).length;
      var state = !domains.length ? "action" : active > 0 ? (active < domains.length ? "progress" : "ready") : "progress";
      var metric = !domains.length ? "No sending domains yet, add your first to auto-provision."
        : active + " of " + domains.length + " domain" + (domains.length === 1 ? "" : "s") + " active";
      return mk("email", state, metric);
    }
    function stepAts(d) {
      if (!d) return mk("ats", "pending", "Couldn't load ATS status.");
      var active = d.active, av = (d.vendors || []).filter(function (v) { return v.vendor === active; })[0];
      var state = !active ? "action" : (av && av.status === "verified") ? "ready" : "progress";
      var metric = !active ? "No system of record chosen yet."
        : "Active: " + ((av && av.label) || active) + (av && av.status === "verified" ? " · verified" : " · not verified yet");
      return mk("ats", state, metric);
    }
    function stepTeam(d) {
      if (!d) return mk("team", "pending", "Couldn't load the team.");
      var recs = (d.members || []).filter(function (m) { return m.role === "member"; }).length;
      return mk("team", recs > 0 ? "ready" : "action", recs > 0 ? (recs + " recruiter" + (recs === 1 ? "" : "s") + " ready to assign") : "No recruiters yet, invite your first.");
    }
    function stepAudience(d) {
      if (!d) return mk("audience", "pending", "Couldn't load your audience.");
      var n = (d.prospects || []).length;
      return mk("audience", n > 0 ? "ready" : "action", n > 0 ? (n + " in your pipeline ready to enroll") : "No prospects or candidates loaded yet.");
    }
    function stepCampaign(camps, seqs) {
      var nc = (camps && camps.campaigns) ? camps.campaigns.length : 0;
      var ns = (seqs && seqs.sequences) ? seqs.sequences.length : 0;
      var state = nc > 0 ? "ready" : ns > 0 ? "progress" : "action";
      var metric = nc > 0 ? (nc + " campaign" + (nc === 1 ? "" : "s") + " built & assigned")
        : ns > 0 ? (ns + " sequence" + (ns === 1 ? "" : "s") + " built, deploy one to a recruiter")
        : "No campaigns yet, build your first sequence.";
      return mk("campaign", state, metric);
    }
    function sPill(state) {
      var m = { ready: "Ready", progress: "In progress", action: "Action needed", pending: "-" };
      return '<span class="s-pill ' + state + '">' + (m[state] || state) + '</span>';
    }

    Promise.all([grab("/connected"), grab("/ats"), grab("/team"), grab("/prospects"), grab("/campaigns"), grab("/sequences"), grab("/sending")])
      .then(function (res) {
        var steps = [stepConnected(res[0]), stepEmail(res[6]), stepAts(res[1]), stepTeam(res[2]), stepAudience(res[3]), stepCampaign(res[4], res[5])];
        var ready = steps.filter(function (s) { return s.state === "ready"; }).length;
        var banner = (ready === steps.length)
          ? '<div class="setup-banner ok">✓ All systems are go, your ' + esc(motionLabel) + ' workspace is ready to launch.</div>'
          : '<div class="setup-banner warn">' + ready + ' of ' + steps.length + ' setup steps ready. Finish the steps marked below to launch ' + esc(motionLabel) + '.</div>';
        var rows = steps.map(function (s, i) {
          return '<div class="setup-step s-' + s.state + '">' +
            '<div class="setup-num">' + (s.state === "ready" ? "✓" : (i + 1)) + '</div>' +
            '<div class="setup-main">' +
              '<div class="setup-row"><span class="setup-title">' + esc(s.title) + '</span>' + sPill(s.state) +
                '<a class="btn btn-ghost btn-sm setup-open" href="#' + s.link + '">' + (s.state === "ready" ? "Review" : "Set up") + ' →</a></div>' +
              '<div class="setup-desc">' + esc(s.desc) + '</div>' +
              '<div class="setup-metric">' + esc(s.metric) + '</div>' +
              '<div class="setup-track">' + s.track.map(function (t) { return '<span class="setup-chip">' + esc(t) + '</span>'; }).join("") + '</div>' +
            '</div></div>';
        }).join("");
        var ov = document.getElementById("setupOv"); if (ov) ov.innerHTML = banner + '<div class="setup-steps">' + rows + '</div>';
      });
  }

  function cnStatusMeta(status) {
    if (status === "green") return { color: "var(--accent-green)", label: "Connected", badge: "background:rgba(56,224,166,.16);color:var(--accent-green)" };
    if (status === "yellow") return { color: "var(--accent-amber)", label: "Saved · test it", badge: "background:rgba(255,194,77,.16);color:var(--accent-amber)" };
    return { color: "var(--text-dim)", label: "Not connected", badge: "background:var(--surface-2);color:var(--text-dim)" };
  }

  function renderConnected(el) {
    el.innerHTML = head("Integrations", "Connect every tool right here, enter its keys, follow the steps, then Test. Red → Yellow → Green; all required must be green to activate campaigns.") +
      '<style>' +
      '.cn-grid{display:flex;flex-direction:column;gap:8px}' +
      '.cn-v{display:flex;align-items:center;gap:12px;padding:13px 15px;border:1px solid var(--border);border-radius:11px;background:var(--bg-soft);cursor:pointer;text-align:left;width:100%}' +
      '.cn-v:hover{border-color:var(--border-strong);background:var(--surface-2)}' +
      '.cn-v .meta{flex:1;min-width:0}.cn-v .meta b{color:var(--text);display:block}.cn-v .meta small{color:var(--text-dim);display:block;margin-top:1px}' +
      '.cn-badge{font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;white-space:nowrap}' +
      '.cn-go{color:var(--text-dim);font-size:18px}' +
      '.cn-fld{display:block;margin-bottom:12px}.cn-fld span.lab{display:block;font-size:12px;color:var(--text-muted);margin-bottom:5px;font-weight:600}' +
      '.cn-fld input{width:100%;box-sizing:border-box;padding:9px 12px;border-radius:9px;border:1px solid var(--border);background:var(--surface);color:var(--text);font:inherit}' +
      '.cn-fld .hint{display:block;font-size:11px;color:var(--text-dim);margin-top:4px}' +
      '.cn-steps{margin:0 0 14px;padding-left:18px;font-size:13px;color:var(--text-dim);line-height:1.6}' +
      '.cn-acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}' +
      '.cn-msg{min-height:18px;font-size:13px;margin:10px 0 0}' +
      '.req-tag{font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;background:rgba(255,194,77,.14);color:var(--accent-amber)}' +
      '.acc-tag{font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;margin-right:4px;white-space:nowrap}' +
      '.acc-tag.granted{background:rgba(124,92,255,.16);color:#b9a6ff}' +
      '.acc-tag.own{background:rgba(56,224,166,.14);color:var(--accent-green)}' +
      '</style>' +
      '<div id="cnBody">' + loading() + "</div>";

    function load() {
      api("/connected").then(function (d) {
        var ints = (d && d.integrations) || [];
        var rows = ints.map(function (i) {
          var sm = cnStatusMeta(i.status);
          var req = (i.requiredFor || []).indexOf(motion) >= 0 ? '<span class="req-tag">required</span>' : "";
          // Where this workspace's key comes from: its own, operator-provided
          // (billed), or, for the operator's own house workspace, nothing shown.
          var acc = i.access === "granted" ? '<span class="acc-tag granted">via ' + esc(PLATFORM_LABEL) + ' · billed</span>'
            : i.access === "own" ? '<span class="acc-tag own">your key</span>' : "";
          var sub = i.error ? esc(i.error) : esc(i.blurb || "");
          return '<button class="cn-v" data-id="' + esc(i.id) + '">' +
            '<span class="dot3" style="background:' + sm.color + '"></span>' +
            '<div class="meta"><b>' + esc(i.label) + '</b><small>' + sub + '</small></div>' +
            acc + req + '<span class="cn-badge" style="' + sm.badge + '">' + sm.label + '</span><span class="cn-go">›</span></button>';
        }).join("") || '<div class="empty">No integrations available.</div>';
        var pre = ints.filter(function (i) { return (i.requiredFor || []).indexOf(motion) >= 0 && i.status !== "green"; });
        var gate = pre.length ? '<div class="card" style="border-color:rgba(255,194,77,0.4);margin-bottom:14px"><b class="muted">⚠ ' + pre.length + " required integration(s) not green yet. Campaign activation is blocked for " + motion + ". Click each below to set it up.</b></div>"
          : '<div class="card" style="border-color:rgba(56,224,166,0.4);margin-bottom:14px"><b style="color:var(--accent-green)">✓ All required integrations are green. You can activate ' + motion + " campaigns.</b></div>";
        var body = $("#cnBody"); if (!body) return;
        body.innerHTML = gate + '<div class="card"><div class="cn-grid">' + rows + "</div></div>";
        Array.prototype.forEach.call(body.querySelectorAll(".cn-v"), function (btn) {
          btn.addEventListener("click", function () {
            var id = btn.getAttribute("data-id");
            if (id === "loxo") { location.hash = "setup/ats"; return; }
            openIntegrationSetup(ints.filter(function (x) { return x.id === id; })[0], load);
          });
        });
      }).catch(function () { var b = $("#cnBody"); if (b) b.innerHTML = needsSetup(); });
    }
    load();
    connectedReload = load; // let the "Test all" header button refresh
  }
  var connectedReload = null;

  // Per-integration Connect dialog: shows the setup steps, takes the keys, saves
  // them to this workspace (no redeploy), then runs the real provider.verify().
  // Mirrors the Loxo/ATS flow so every tool is stood up the same way.
  function openIntegrationSetup(integ, onChange) {
    if (!integ) return;
    var present = integ.present || [];
    var fields = (integ.fields || []).map(function (f) {
      var saved = present.indexOf(f.key) >= 0;
      var ph = saved && f.secret ? "•••••••• saved" : (f.placeholder || "");
      var lab = esc(f.label) + (f.required ? ' <span style="color:var(--accent-red)">*</span>' : ' <span class="muted">(optional)</span>') +
        (saved && f.secret ? ' <span class="muted">- saved, leave blank to keep</span>' : '');
      return '<label class="cn-fld"><span class="lab">' + lab + '</span>' +
        '<input data-key="' + esc(f.key) + '" type="' + (f.secret ? "password" : "text") + '" placeholder="' + esc(ph) + '" autocomplete="off">' +
        (f.hint ? '<span class="hint">' + esc(f.hint) + '</span>' : '') + '</label>';
    }).join("");
    var steps = (integ.steps || []).length
      ? '<ol class="cn-steps">' + integ.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join("") + '</ol>' : '';
    var docs = integ.docsUrl ? '<p class="muted" style="margin:12px 0 0;font-size:12px">Where to find these: <a href="' + esc(integ.docsUrl) + '" target="_blank" rel="noopener">' + esc(integ.docsLabel || "Provider docs ↗") + '</a></p>' : '';
    var hasSaved = present.length > 0;
    var hasFields = (integ.fields || []).length > 0;
    var body = steps + fields +
      '<p class="cn-msg" id="cnMsg">' + (integ.error ? '<span style="color:var(--accent-red)">' + esc(integ.error) + '</span>' : '') + '</p>' +
      (hasFields ? '<div class="cn-acts">' +
        '<button class="btn btn-primary btn-sm" id="cnSave">Save</button>' +
        '<button class="btn btn-sm" id="cnTest">Test connection</button>' +
        (hasSaved ? '<button class="btn btn-ghost btn-sm" id="cnDisc" style="margin-left:auto;color:var(--accent-red)">Disconnect</button>' : '') +
      '</div>' : '') + docs;

    openModal("Connect " + integ.label, integ.blurb || "Integration setup", body, function (root, close) {
      var msg = root.querySelector("#cnMsg");
      function say(t, kind) { msg.innerHTML = '<span style="color:' + (kind === "err" ? "var(--accent-red)" : kind === "ok" ? "var(--accent-green)" : "var(--text-muted)") + '">' + esc(t) + "</span>"; }
      function collect() {
        var keys = {};
        Array.prototype.forEach.call(root.querySelectorAll("[data-key]"), function (inp) {
          var v = (inp.value || "").trim();
          if (v) keys[inp.getAttribute("data-key")] = v;
        });
        return keys;
      }
      function saveFirst() { return send("/connected", "POST", { action: "save", id: integ.id, keys: collect() }); }
      var saveBtn = root.querySelector("#cnSave");
      if (saveBtn) saveBtn.onclick = function () {
        say("Saving…");
        saveFirst().then(function (r) {
          if (r.ok) { say("Saved. Now test the connection.", "ok"); if (onChange) onChange(); }
          else say((r.data && r.data.error) || "Could not save.", "err");
        }).catch(function () { say("Could not reach the server.", "err"); });
      };
      var testBtn = root.querySelector("#cnTest");
      if (testBtn) testBtn.onclick = function () {
        say("Saving + testing…");
        saveFirst().then(function () { return send("/connected", "POST", { action: "test", id: integ.id }); }).then(function (r) {
          var res = r.data && r.data.result;
          if (r.ok && res && res.status === "green") say("Connected ✓, verified.", "ok");
          else say(cnTestErr(res), "err");
          if (onChange) onChange();
        }).catch(function () { say("Could not reach the server.", "err"); });
      };
      var disc = root.querySelector("#cnDisc");
      if (disc) disc.onclick = function () {
        if (!window.confirm("Disconnect " + integ.label + "? The saved keys for this workspace are removed.")) return;
        send("/connected", "POST", { action: "disconnect", id: integ.id }).then(function () { close(); toast(integ.label + " disconnected"); if (onChange) onChange(); });
      };
    });
  }

  function cnTestErr(res) {
    if (!res) return "Test failed, could not reach the provider.";
    if (res.error === "not_configured") return "Add the required key(s) above and Save before testing.";
    if (res.error === "no_client") return "No client available for this integration.";
    if (res.error === "connect_on_ats_tab") return "Connect Loxo on the ATS tab.";
    if (res.error === "elevenlabs_invalid_key") return "ElevenLabs rejected this key — it's invalid or revoked. Copy it again from elevenlabs.io → Profile → API Keys (make sure it's from the right account).";
    if (res.error === "elevenlabs_unauthorized") return "ElevenLabs rejected this key. If the key is correct, give it read access to User or Voices (or use a key with no restrictions), then paste it again.";
    return "Connection failed" + (res.error ? ", " + res.error : "") + ". Check the key and try again.";
  }

  function renderAts(el) {
    el.innerHTML = head("ATS", "Your system of record. Connect Loxo to populate Candidates & Companies and keep them in sync.") +
      '<style>' +
      '.ats-grid{display:flex;flex-direction:column;gap:8px}' +
      '.ats-v{display:flex;align-items:center;gap:12px;padding:13px 15px;border:1px solid var(--border);border-radius:11px;background:var(--bg-soft);cursor:pointer;text-align:left;width:100%}' +
      '.ats-v:hover{border-color:var(--border-strong);background:var(--surface-2)}' +
      '.ats-v .meta{flex:1;min-width:0}.ats-v .meta b{color:var(--text);display:block}.ats-v .meta small{color:var(--text-dim)}' +
      '.ats-badge{font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px}' +
      '.ats-go{color:var(--text-dim);font-size:18px}' +
      '.ats-fld{display:block;margin-bottom:12px}.ats-fld span{display:block;font-size:12px;color:var(--text-muted);margin-bottom:5px;font-weight:600}' +
      '.ats-fld input{width:100%;box-sizing:border-box;padding:9px 12px;border-radius:9px;border:1px solid var(--border);background:var(--surface);color:var(--text);font:inherit}' +
      '.ats-acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}' +
      '.ats-msg{min-height:18px;font-size:13px;margin:10px 0 0}' +
      '</style><div id="atBody">' + loading() + "</div>";
    function atsAgo(s) {
      var t = Date.parse(s); if (isNaN(t)) return "recently";
      var m = Math.floor((Date.now() - t) / 60000);
      if (m < 1) return "just now"; if (m < 60) return m + "m ago";
      var h = Math.floor(m / 60); if (h < 24) return h + "h ago";
      return Math.floor(h / 24) + "d ago";
    }
    api("/ats").then(function (d) {
      d = d || {};
      var cfgByVendor = {};
      (d.config || []).forEach(function (c) { cfgByVendor[c.vendor] = c; });
      var vendors = (d.vendors || []).map(function (v) {
        var c = cfgByVendor[v.vendor] || {};
        var st = c.status || (v.status === "verified" ? "red" : "red");
        var connected = st === "green";
        var badge = connected
          ? '<span class="ats-badge" style="background:rgba(56,224,166,.16);color:var(--accent-green)">Connected</span>'
          : st === "yellow"
            ? '<span class="ats-badge" style="background:rgba(255,194,77,.16);color:var(--accent-amber)">Saved · test it</span>'
            : (v.status === "verified"
                ? '<span class="ats-badge" style="background:var(--surface-2);color:var(--text-dim)">Not connected</span>'
                : '<span class="ats-badge" style="background:var(--surface-2);color:var(--text-dim)">Soon</span>');
        var sub = connected && c.lastSyncAt ? "Last sync " + atsAgo(c.lastSyncAt)
          : v.vendor === d.active ? "Active system of record"
          : v.status === "verified" ? "Click to set up" : "Coming soon";
        return '<button class="ats-v" data-vendor="' + esc(v.vendor) + '" data-status="' + esc(v.status) + '">' +
          '<span class="dot3" style="background:' + (connected ? "var(--accent-green)" : st === "yellow" ? "var(--accent-amber)" : "var(--text-dim)") + '"></span>' +
          '<div class="meta"><b>' + esc(v.label) + (v.vendor === d.active ? ' · active' : '') + '</b><small>' + esc(sub) + '</small></div>' +
          badge + '<span class="ats-go">›</span></button>';
      }).join("") || '<div class="empty">No ATS vendors available.</div>';
      var map = (d.objectMap || []).map(function (m) {
        return '<div class="list-row"><div><div class="lr-main">' + esc(m.concept) + '</div><div class="lr-sub">' + esc(m.how) + '</div></div><div class="lr-right">' + esc(m.object) + "</div></div>";
      }).join("");
      var body = $("#atBody"); if (!body) return;
      body.innerHTML = '<div class="two-col"><div class="card"><h3>Choose your ATS</h3><p class="muted" style="margin:0 0 12px;font-size:13px">Click a provider to enter its credentials. Candidates flow into the Candidates database; companies into the BD Companies tab.</p><div class="ats-grid">' + vendors + "</div></div>" +
        '<div class="card"><h3>Loxo object mapping</h3>' + map + "</div></div>";
      Array.prototype.forEach.call(body.querySelectorAll(".ats-v"), function (btn) {
        btn.addEventListener("click", function () {
          openAtsSetup(btn.getAttribute("data-vendor"), cfgByVendor[btn.getAttribute("data-vendor")] || {}, btn.getAttribute("data-status"), d.vendors, el);
        });
      });
    }).catch(function () { var b = $("#atBody"); if (b) b.innerHTML = needsSetup(); });
  }

  // Per-vendor connection dialog: enter domain/slug/API key, test, sync, and
  // subscribe to the real-time feed. Loxo is fully wired; other vendors save
  // credentials but verification/sync land as each adapter ships.
  function openAtsSetup(vendor, cfg, vstatus, vendors, host) {
    var refresh = function () { renderAts(host || $("#view")); };
    var label = (vendors || []).reduce(function (a, v) { return v.vendor === vendor ? v.label : a; }, vendor);
    var isLoxo = vendor === "loxo";
    var docLink = isLoxo ? '<a href="https://loxo.readme.io/reference/loxo-api" target="_blank" rel="noopener">Loxo API reference ↗</a>' : '';
    var body =
      (isLoxo ? '<div class="ats-help" style="margin:0 0 14px;padding:11px 13px;border:1px solid var(--border);border-radius:9px;background:var(--bg-soft);font-size:12.5px;line-height:1.55;color:var(--text-muted)">' +
        '<b style="color:var(--text)">Where to find these</b><br>' +
        '<b>Domain</b>, the host you log into Loxo on, e.g. <code>app.loxo.co</code> (no https://).<br>' +
        '<b>Slug</b>, the agency id in your Loxo URL after <code>/agencies/</code> (no spaces).<br>' +
        '<b>API key</b>, Loxo → Settings → API Keys (admin only). If it\'s missing, ask Loxo Support to enable Open API.' +
        '</div>' : '<p class="muted" style="margin:0 0 12px;font-size:13px">' + esc(label) + ' verification & sync are on the roadmap. You can save credentials now; the live pull turns on when the adapter ships.</p>') +
      '<label class="ats-fld"><span>Agency domain</span><input id="atsDomain" placeholder="app.loxo.co" value="' + esc(cfg.domain || "") + '" autocomplete="off"></label>' +
      '<label class="ats-fld"><span>Agency slug</span><input id="atsSlug" placeholder="your-agency" value="' + esc(cfg.slug || "") + '" autocomplete="off"></label>' +
      '<label class="ats-fld"><span>API key (Bearer token)' + (cfg.hasApiKey ? ', saved, leave blank to keep' : '') + '</span><input id="atsKey" type="password" placeholder="' + (cfg.hasApiKey ? "•••••••• saved" : "paste from Loxo → Settings → API Keys") + '" autocomplete="off"></label>' +
      '<p class="ats-msg" id="atsMsg">' + (cfg.error ? '<span style="color:var(--accent-red)">' + esc(cfg.error) + '</span>' : '') + '</p>' +
      '<div class="ats-acts">' +
        '<button class="btn btn-primary btn-sm" id="atsSave">Save</button>' +
        (isLoxo ? '<button class="btn btn-sm" id="atsTest">Test connection</button>' : '') +
        (isLoxo ? '<button class="btn btn-sm" id="atsSync">Sync now</button>' : '') +
        (isLoxo ? '<button class="btn btn-ghost btn-sm" id="atsHook">Enable real-time</button>' : '') +
        (cfg.hasApiKey ? '<button class="btn btn-ghost btn-sm" id="atsDisc" style="margin-left:auto;color:var(--accent-red)">Disconnect</button>' : '') +
      '</div>' +
      (docLink ? '<p class="muted" style="margin:12px 0 0;font-size:12px">Need help finding these? ' + docLink + ' · domain & slug come from Loxo Support.</p>' : '');

    openModal("Connect " + label, "System of record", body, function (root, close) {
      var msg = root.querySelector("#atsMsg");
      function say(t, kind) { msg.innerHTML = '<span style="color:' + (kind === "err" ? "var(--accent-red)" : kind === "ok" ? "var(--accent-green)" : "var(--text-muted)") + '">' + esc(t) + "</span>"; }
      function payload(extra) {
        return Object.assign({ vendor: vendor, domain: root.querySelector("#atsDomain").value.trim(), slug: root.querySelector("#atsSlug").value.trim(), apiKey: root.querySelector("#atsKey").value.trim() }, extra || {});
      }
      function saveFirst() {
        return send("/ats", "POST", payload({ action: "save" }));
      }
      root.querySelector("#atsSave").onclick = function () {
        say("Saving…");
        saveFirst().then(function (r) {
          if (r.ok) { say("Saved. " + (isLoxo ? "Now test the connection." : "Credentials stored."), "ok"); cfg.hasApiKey = true; refresh(); }
          else say((r.data && r.data.error) || "Could not save.", "err");
        }).catch(function () { say("Could not reach the server.", "err"); });
      };
      var testBtn = root.querySelector("#atsTest");
      if (testBtn) testBtn.onclick = function () {
        say("Saving + testing…");
        saveFirst().then(function () { return send("/ats", "POST", { action: "test", vendor: vendor }); }).then(function (r) {
          if (r.ok && r.data && r.data.ok) { say("Connected ✓, Loxo responded.", "ok"); refresh(); }
          else say((r.data && r.data.error) || "Connection failed.", "err");
        }).catch(function () { say("Could not reach the server.", "err"); });
      };
      var syncBtn = root.querySelector("#atsSync");
      if (syncBtn) syncBtn.onclick = function () {
        say("Pulling from Loxo… this can take a moment for large databases.");
        saveFirst().then(function () { return send("/ats", "POST", { action: "sync", vendor: vendor }); }).then(function (r) {
          if (r.ok && r.data && r.data.report) {
            var p = r.data.report.people || {}, c = r.data.report.companies || {};
            say("Synced ✓, Candidates +" + (p.added || 0) + "/" + (p.updated || 0) + " upd · Companies +" + (c.added || 0) + "/" + (c.updated || 0) + " upd.", "ok");
            refresh();
          } else say((r.data && r.data.error) || "Sync failed, test the connection first.", "err");
        }).catch(function () { say("Sync failed.", "err"); });
      };
      var hookBtn = root.querySelector("#atsHook");
      if (hookBtn) hookBtn.onclick = function () {
        say("Registering webhooks with Loxo…");
        saveFirst().then(function () { return send("/ats", "POST", { action: "register-webhooks", vendor: vendor }); }).then(function (r) {
          if (r.ok && r.data && r.data.registered) say("Real-time on ✓, " + r.data.registered + " webhooks registered. Changes in Loxo now sync automatically.", "ok");
          else say((r.data && r.data.error) === "loxo_rejected_webhooks" ? "Loxo rejected the webhooks, confirm webhooks are enabled for your account." : ((r.data && r.data.error) || "Could not register webhooks."), "err");
        }).catch(function () { say("Could not reach the server.", "err"); });
      };
      var discBtn = root.querySelector("#atsDisc");
      if (discBtn) discBtn.onclick = function () {
        if (!window.confirm("Disconnect " + label + "? Stored credentials are removed. Synced records stay.")) return;
        send("/ats", "POST", { action: "disconnect", vendor: vendor }).then(function () { close(); toast(label + " disconnected"); refresh(); });
      };
    });
  }

  /* ---------------- Team (admin sub-accounts) ---------------- */
  function renderTeam(el) {
    el.innerHTML = head("Team",
      "Add recruiters to this workspace and set what they can touch. Recruiters work the inbox, pipeline, sourcing, outreach and the dialer, but never see the Telnyx account, API keys, sending domains, the ATS connection, billing, or the team.");

    // Permission matrix, so an admin sees exactly where the wall is.
    var caps = [
      ["Response inbox + act", true, true, true], ["Prospects + pipeline", true, true, true],
      ["Sourcing + outreach", true, true, true], ["Voice dialer (use)", true, true, true],
      ["Create campaigns", true, true, true], ["Activate campaigns", true, true, false],
      ["LinkedIn accounts + domains", true, true, false], ["API keys", true, true, false],
      ["Telnyx / SMS account", true, true, false], ["Integrations (Connected)", true, true, false],
      ["ATS connection", true, true, false], ["Manage team", true, true, false],
      ["Billing", true, false, false]
    ];
    var matrix = '<div class="card" style="margin-bottom:16px;overflow:auto"><h3>What each role can do</h3><table class="matrix"><thead><tr><th>Capability</th><th>Owner</th><th>Admin</th><th>Recruiter</th></tr></thead><tbody>' +
      caps.map(function (r) {
        return "<tr><td>" + esc(r[0]) + "</td>" + [1, 2, 3].map(function (i) {
          return '<td>' + (r[i] ? '<span style="color:var(--accent-green)">✓</span>' : '<span class="muted">-</span>') + "</td>";
        }).join("") + "</tr>";
      }).join("") + "</tbody></table></div>";

    el.innerHTML += matrix + '<div class="card"><h3>Members</h3><div id="tmBody">' + loading() + "</div></div>" +
      '<div class="card" style="margin-top:14px"><h3>Pending invites</h3><div id="tmInvites"><div class="empty">None.</div></div></div>';

    api("/team").then(function (d) {
      var members = (d && d.members) || [];
      var rows = members.map(function (m) {
        var you = m.userId === ctx.user.id;
        var ctrl = (!you && (d.assignableRoles || []).length)
          ? '<button class="btn btn-ghost btn-sm" data-remove="' + esc(m.userId) + '">Remove</button>' : "";
        return '<div class="integ"><span class="avatar" style="width:30px;height:30px;font-size:11px;background:' + colorFor(m.name) + '">' + esc(initials(m.name)) + "</span>" +
          '<div class="meta"><b>' + esc(m.name) + (you ? ' <span class="muted">(you)</span>' : "") + "</b><small>" + esc(m.email) + (m.emailVerified ? "" : " · unverified") + "</small></div>" +
          '<span class="cls cls-' + (m.role === "owner" ? "positive" : m.role === "admin" ? "soft_yes" : "unclassified") + '">' + esc(m.role) + "</span>" + ctrl + "</div>";
      }).join("") || '<div class="empty">No teammates yet. Invite your first recruiter with the button above.</div>';
      var body = $("#tmBody"); if (body) body.innerHTML = rows;
      var invs = ((d && d.invites) || []).map(function (i) {
        var copy = i.link ? '<button class="btn btn-ghost btn-sm" data-invlink="' + esc(i.link) + '">Copy link</button>' : "";
        return '<div class="integ"><span class="dot3" style="background:var(--accent-amber)"></span><div class="meta"><b>' + esc(i.email) + "</b><small>invited as " + esc(i.role) + "</small></div>" + copy + "</div>";
      }).join("");
      var ib = $("#tmInvites"); if (ib) ib.innerHTML = invs || '<div class="empty">None.</div>';
      if (ib) Array.prototype.forEach.call(ib.querySelectorAll("[data-invlink]"), function (btn) {
        btn.addEventListener("click", function () {
          var link = btn.getAttribute("data-invlink");
          try { navigator.clipboard.writeText(link); } catch (e) {}
          var t = btn.textContent; btn.textContent = "Copied ✓";
          setTimeout(function () { btn.textContent = t; }, 1500);
        });
      });
      if (body) Array.prototype.forEach.call(body.querySelectorAll("[data-remove]"), function (btn) {
        btn.addEventListener("click", function () {
          if (!confirm("Remove this teammate?")) return;
          send("/team", "POST", { action: "remove", userId: btn.getAttribute("data-remove") })
            .then(function (r) { toast(r.ok ? "Removed" : "Could not remove"); if (r.ok) renderTeam($("#view")); });
        });
      });
    }).catch(function () { var b = $("#tmBody"); if (b) b.innerHTML = needsSetup(); });
  }

  function inviteRecruiter() {
    // Owners may also mint admins; admins can only add recruiters. The session's
    // assignableRoles (from /api/team) is authoritative, fall back to recruiter.
    var canMintAdmin = ctx.role === "owner";
    var roleField = canMintAdmin
      ? '<label class="fld"><span>Role</span><select id="invRole">' +
          '<option value="member" selected>Recruiter, works the inbox, pipeline, sourcing, outreach &amp; dialer</option>' +
          '<option value="admin">Admin, full control, manages tools &amp; the team</option>' +
        '</select></label>'
      : '<input type="hidden" id="invRole" value="member" />';
    var foot = '<div class="modal-foot"><button class="btn btn-ghost" id="invCancel">Cancel</button>' +
      '<button class="btn btn-primary" id="invSend">Send invite →</button></div>';
    var bodyHtml =
      '<p class="muted" style="margin:0 0 14px">They join <b>' + esc((ctx.workspace && ctx.workspace.name) || "this workspace") +
        '</b> through an emailed link and land in the Recruiter Portal. They inherit the tools you\'ve configured here, they can use them but never manage them.</p>' +
      '<label class="fld"><span>Work email</span><input id="invEmail" type="email" placeholder="recruiter@company.com" autocomplete="off" /></label>' +
      roleField +
      '<p class="auth-msg" id="invMsg" style="min-height:18px"></p>' + foot;

    openModal("Invite a recruiter", "Add someone to this workspace", bodyHtml, function (root, close) {
      var emailEl = root.querySelector("#invEmail");
      var roleEl = root.querySelector("#invRole");
      var sendBtn = root.querySelector("#invSend");
      var msgEl = root.querySelector("#invMsg");
      if (emailEl) emailEl.focus();
      root.querySelector("#invCancel").addEventListener("click", close);
      function submit() {
        var email = (emailEl.value || "").trim();
        var role = (roleEl && roleEl.value) === "admin" ? "admin" : "member";
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msgEl.textContent = "Enter a valid email."; msgEl.className = "auth-msg err"; return; }
        sendBtn.disabled = true; msgEl.textContent = "Creating invite..."; msgEl.className = "auth-msg busy";
        send("/team", "POST", { action: "invite", email: email, role: role })
          .then(function (r) {
            if (r.ok) {
              renderTeam($("#view")); // refresh the list underneath
              showInviteLink(root, email, role, (r.data && r.data.link) || "");
            }
            else { sendBtn.disabled = false; msgEl.textContent = inviteErr((r.data && r.data.error) || r.status); msgEl.className = "auth-msg err"; }
          })
          .catch(function () { sendBtn.disabled = false; msgEl.textContent = "Could not reach the server."; msgEl.className = "auth-msg err"; });
      }
      sendBtn.addEventListener("click", submit);
      if (emailEl) emailEl.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
    });
  }

  function inviteErr(code) {
    var map = {
      already_member: "They're already on this team.",
      role_not_assignable: "You can't assign that role.",
      missing_fields: "Fill in the email and role."
    };
    return map[code] || ("Could not invite (" + code + ")");
  }

  // After an invite is created, show a copyable join link so the admin can send
  // it themselves (the link also goes by email when a provider is configured).
  function showInviteLink(root, email, role, link) {
    var msgEl = root.querySelector("#invMsg");
    if (!msgEl) return;
    var label = role === "admin" ? "admin" : "recruiter";
    msgEl.className = "auth-msg";
    msgEl.innerHTML = '<div style="text-align:left">' +
      '<p style="color:var(--accent-green);font-weight:600;margin:0 0 8px">✓ Invite created for ' + esc(email) + ' (' + label + ').</p>' +
      '<p class="muted" style="font-size:12px;margin:0 0 6px">Send them this link to join, it works even if email isn\'t set up yet:</p>' +
      '<div style="display:flex;gap:6px"><input id="invLinkBox" readonly value="' + esc(link) + '" style="flex:1;min-width:0;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);font:inherit;font-size:12px"/>' +
      '<button class="btn btn-sm" id="invCopyBtn" type="button">Copy</button></div></div>';
    var box = root.querySelector("#invLinkBox");
    var copyBtn = root.querySelector("#invCopyBtn");
    if (copyBtn) copyBtn.onclick = function () {
      if (box) box.select();
      try { navigator.clipboard.writeText(link); } catch (e) { try { document.execCommand("copy"); } catch (e2) {} }
      copyBtn.textContent = "Copied ✓";
      setTimeout(function () { copyBtn.textContent = "Copy"; }, 1500);
    };
    var sb = root.querySelector("#invSend");
    if (sb) { sb.disabled = false; sb.textContent = "Invite another"; }
    var em = root.querySelector("#invEmail");
    if (em) { em.value = ""; em.focus(); }
  }

  /* Admin "view as recruiter": pick a recruiter and drop straight into their
     Recruiter Portal, exactly what they see, no password. Lists the workspace's
     members (recruiters only) and mints a per-tab impersonation session for the
     chosen one via /api/team/impersonate. */
  function openRecruiterPicker() {
    var bodyHtml =
      '<p class="muted" style="margin:0 0 12px">Dive into a recruiter\'s portal exactly as they see it, no login needed. Pick who to view.</p>' +
      '<div id="rpList">' + loading() + "</div>" +
      '<div class="modal-foot"><button class="btn btn-ghost" id="rpSelf">Preview the empty Recruiter Portal (as yourself)</button></div>';
    openModal("Open a recruiter's portal", "Admin view-as", bodyHtml, function (root, close) {
      root.querySelector("#rpSelf").addEventListener("click", function () { close(); window.open("/recruiter", "ros-recruiter"); });
      api("/team").then(function (d) {
        var recruiters = ((d && d.members) || []).filter(function (m) { return m.role === "member"; });
        var listEl = root.querySelector("#rpList");
        if (!listEl) return;
        if (!recruiters.length) {
          listEl.innerHTML = '<div class="empty">No recruiters in this workspace yet. Invite one from the Team tab, then dive into their portal here.</div>';
          return;
        }
        listEl.innerHTML = recruiters.map(function (m) {
          return '<button type="button" class="integ rp-row" data-uid="' + esc(m.userId) + '" ' +
            'style="width:100%;text-align:left;cursor:pointer;background:none;border:1px solid var(--border);border-radius:10px;margin-bottom:8px;padding:8px 10px">' +
            '<span class="avatar" style="width:30px;height:30px;font-size:11px;background:' + colorFor(m.name) + '">' + esc(initials(m.name)) + "</span>" +
            '<div class="meta"><b>' + esc(m.name) + (m.emailVerified ? "" : " · unverified") + "</b><small>" + esc(m.email) + "</small></div>" +
            '<span class="cls cls-unclassified">Enter →</span></button>';
        }).join("");
        Array.prototype.forEach.call(listEl.querySelectorAll(".rp-row"), function (btn) {
          btn.addEventListener("click", function () {
            var uid = btn.getAttribute("data-uid");
            btn.disabled = true; btn.style.opacity = ".6";
            send("/team/impersonate", "POST", { userId: uid }).then(function (r) {
              if (!r.ok || !r.data || !r.data.token) {
                btn.disabled = false; btn.style.opacity = "";
                toast("Could not open portal (" + ((r.data && r.data.error) || r.status) + ")");
                return;
              }
              var handoff = {
                token: r.data.token,
                ctx: { user: r.data.user, workspace: r.data.workspace, role: r.data.role, capabilities: r.data.capabilities, session: r.data.session }
              };
              var b64 = btoa(unescape(encodeURIComponent(JSON.stringify(handoff))));
              close();
              window.open("/recruiter#imp=" + encodeURIComponent(b64), "ros-rec-" + uid);
            }).catch(function () { btn.disabled = false; btn.style.opacity = ""; toast("Could not reach the server."); });
          });
        });
      }).catch(function () { var l = root.querySelector("#rpList"); if (l) l.innerHTML = needsSetup(); });
    });
  }

  /* ---------------- primary actions ---------------- */
  function primaryAction(key) {
    if (key === "team") { inviteRecruiter(); return; }
    if (key === "campaigns") { newSequenceFlow(); return; }
    if (key === "prospects") { addProspect(); return; }
    if (key === "content") { newSequenceFlow(); return; }
    if (key === "connected") {
      toast("Testing all connections...");
      send("/connected", "POST", { action: "test-all" })
        .then(function (r) { toast(r.ok ? "Tested all connections" : "Could not test"); if (connectedReload) connectedReload(); })
        .catch(function () { toast("Could not reach the server."); });
      return;
    }
  }

  function addProspect() {
    // Pull real campaigns from the API so this works on any device.
    api("/campaigns").then(function (d) {
      var camps = ((d && d.campaigns) || []).filter(function (c) { return c.motion === motion; });
      if (!camps.length) { toast("Create a campaign first (＋ New campaign)."); location.hash = "campaigns"; return; }
      var name = prompt("Prospect full name:"); if (!name) return;
      var email = prompt("Email (optional):") || undefined;
      var company = prompt("Company (optional):") || undefined;
      var campaignId;
      if (camps.length === 1) campaignId = camps[0].id;
      else {
        var menu = camps.map(function (c, i) { return (i + 1) + ". " + c.name; }).join("\n");
        var pick = prompt("Add to which campaign?\n" + menu + "\n\nEnter a number:", "1");
        var idx = parseInt(pick, 10) - 1;
        if (isNaN(idx) || !camps[idx]) return;
        campaignId = camps[idx].id;
      }
      send("/prospects", "POST", { fullName: name, email: email, company: company, campaignId: campaignId, motion: motion })
        .then(function (r) {
          if (r.ok) { toast("Prospect added"); if (prospectsReload) prospectsReload(); else renderProspects($("#view")); }
          else toast("Could not add (" + (r.data.error || r.status) + ")");
        })
        .catch(function () { toast("Could not reach the server."); });
    }).catch(function () { toast("Could not reach the server."); });
  }

  /* Bulk import: paste CSV / TSV / lines. Header optional; recognizes
     name,email,company,title,linkedin,phone in any order. Dedupe handled server-side. */
  // CSV/paste import with file upload + explicit column → field mapping. No campaign
  // gate, a holding BD campaign is auto-created on import if none is chosen.
  var IMP_FIELDS = [
    ["", "- Ignore -"], ["fullName", "Full name"], ["firstName", "First name"],
    ["lastName", "Last name"], ["email", "Email"], ["company", "Company"],
    ["title", "Job title"], ["linkedinUrl", "LinkedIn URL"], ["phone", "Phone"]
  ];
  function guessField(header) {
    var h = (header || "").toLowerCase();
    if (/first\s*name|^first$|fname/.test(h)) return "firstName";
    if (/last\s*name|^last$|lname|surname/.test(h)) return "lastName";
    if (/full\s*name|^name$|contact/.test(h)) return "fullName";
    if (/e-?mail/.test(h)) return "email";
    if (/company|organization|org|employer|account/.test(h)) return "company";
    if (/title|role|position|job/.test(h)) return "title";
    if (/linkedin|profile|url/.test(h)) return "linkedinUrl";
    if (/phone|mobile|cell|tel/.test(h)) return "phone";
    return "";
  }

  function importProspects() {
    api("/campaigns").then(function (d) {
      openImpModal(((d && d.campaigns) || []).filter(function (c) { return c.motion === motion; }));
    }).catch(function () { openImpModal([]); });
  }

  function openImpModal(camps) {
    var campField = (camps && camps.length)
      ? '<label>Add to campaign</label><select id="impCamp">' +
          camps.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + "</option>"; }).join("") + "</select>"
      : '<div class="imp-note">Imported prospects go to an auto-created <b>Imported prospects</b> campaign.</div>';
    var bodyHtml =
      campField +
      '<label>Upload a CSV file</label>' +
      '<input id="impFile" type="file" accept=".csv,.tsv,.txt" class="imp-file" />' +
      '<label>…or paste rows (CSV / TSV)</label>' +
      '<textarea id="impText" placeholder="name, email, company, title&#10;Jane Doe, jane@acme.com, Acme, VP Engineering"></textarea>' +
      '<label class="imp-check"><input type="checkbox" id="impHeader" checked> First row is a header</label>' +
      '<div id="impMap" class="imp-map"></div>' +
      '<div class="imp-preview" id="impPrev">Upload a CSV or paste rows, then map each column to a field below.</div>' +
      '<div class="modal-foot"><button class="btn btn-ghost btn-sm" id="impCancel">Cancel</button>' +
      '<button class="btn btn-primary btn-sm" id="impGo">Import</button></div>';

    openModal("Import prospects", "Upload a CSV (or paste), map the columns, and import.", bodyHtml, function (root, close) {
      var ta = root.querySelector("#impText"), prev = root.querySelector("#impPrev");
      var fileEl = root.querySelector("#impFile"), headerEl = root.querySelector("#impHeader");
      var mapEl = root.querySelector("#impMap");
      var mapping = null;    // array of field keys per column, set once columns are known

      function delim(line) { return line.indexOf("\t") >= 0 ? "\t" : ","; }
      function lines() { return ta.value.split(/\r?\n/).map(function (l) { return l.replace(/\s+$/, ""); }).filter(function (l) { return l.trim(); }); }
      function columns() {
        var ls = lines(); if (!ls.length) return [];
        return ls[0].split(delim(ls[0])).map(function (s) { return s.trim(); });
      }

      function renderMap() {
        var cols = columns();
        if (cols.length < 2) { mapEl.innerHTML = ""; mapping = null; refreshPreview(); return; }
        var hdr = headerEl.checked;
        mapping = cols.map(function (c, i) { return hdr ? guessField(c) : ""; });
        // positional fallback default when no header
        if (!hdr) { var pos = ["fullName", "email", "company", "title"]; mapping = cols.map(function (_, i) { return pos[i] || ""; }); }
        mapEl.innerHTML = '<div class="imp-map-title">Map your columns</div>' + cols.map(function (c, i) {
          var sample = hdr ? c : ("col " + (i + 1));
          var opts = IMP_FIELDS.map(function (f) { return '<option value="' + f[0] + '"' + (f[0] === mapping[i] ? " selected" : "") + ">" + esc(f[1]) + "</option>"; }).join("");
          return '<div class="imp-map-row"><span class="imp-col">' + esc(sample) + '</span><select data-col="' + i + '">' + opts + "</select></div>";
        }).join("");
        Array.prototype.forEach.call(mapEl.querySelectorAll("select"), function (sel) {
          sel.addEventListener("change", function () { mapping[parseInt(sel.getAttribute("data-col"), 10)] = sel.value; refreshPreview(); });
        });
      }

      function buildRows() {
        var ls = lines(); if (!ls.length) return [];
        var hdr = headerEl.checked, cols = columns();
        var dataLines = (hdr && cols.length >= 2) ? ls.slice(1) : ls;
        return dataLines.map(function (line) {
          var parts = line.split(delim(line)).map(function (s) { return s.trim(); });
          var row = {};
          if (mapping && cols.length >= 2) {
            mapping.forEach(function (field, i) { if (field && parts[i]) row[field] = parts[i]; });
            if (!row.fullName && (row.firstName || row.lastName)) row.fullName = [row.firstName, row.lastName].filter(Boolean).join(" ");
          } else {
            // single column → treat as full name
            row.fullName = parts[0];
          }
          delete row.firstName; delete row.lastName;
          return row;
        }).filter(function (r) { return r.fullName; });
      }

      function refreshPreview() {
        var n = buildRows().length;
        prev.innerHTML = n ? "Ready to import <b>" + n + "</b> prospect" + (n === 1 ? "" : "s") + "."
          : (columns().length ? "Map at least the name column to import." : "Upload a CSV or paste rows above.");
      }

      ta.addEventListener("input", renderMap);
      headerEl.addEventListener("change", renderMap);
      fileEl.addEventListener("change", function () {
        var f = fileEl.files && fileEl.files[0]; if (!f) return;
        var reader = new FileReader();
        reader.onload = function () { ta.value = String(reader.result || ""); renderMap(); };
        reader.readAsText(f);
      });

      root.querySelector("#impCancel").addEventListener("click", close);
      root.querySelector("#impGo").addEventListener("click", function () {
        var rows = buildRows();
        if (!rows.length) { toast("Nothing to import, map the name column."); return; }
        var sel = root.querySelector("#impCamp");
        var go = root.querySelector("#impGo"); go.disabled = true; go.textContent = "Importing…";
        function send_rows(cid) {
          if (!cid) { toast("Could not prepare a campaign."); go.disabled = false; go.textContent = "Import"; return; }
          rows.forEach(function (r) { r.campaignId = cid; r.motion = motion; });
          send("/prospects", "POST", { action: "bulk", rows: rows }).then(function (res) {
            if (res.ok) {
              var added = res.data && res.data.added != null ? res.data.added : rows.length;
              var dup = res.data && res.data.deduped ? " (" + res.data.deduped + " already existed)" : "";
              toast("Imported " + added + " prospect" + (added === 1 ? "" : "s") + dup);
              close(); if (prospectsReload) prospectsReload();
            } else { toast("Import failed (" + (res.data.error || res.status) + ")"); go.disabled = false; go.textContent = "Import"; }
          }).catch(function () { toast("Could not reach the server."); go.disabled = false; go.textContent = "Import"; });
        }
        if (sel && sel.value) send_rows(sel.value);
        else resolveBdCampaign(send_rows);
      });
    });
  }

  /* Enrich LinkedIn searches: paste a Sales Navigator / LinkedIn search URL; the
     connected LinkedIn account pulls every matching member into the pipeline
     (name, company, title, profile). Contact data (email / phone / cell) is then
     enriched per-prospect on demand via the ⚡ Enrich button, discovery is free. */
  function importLinkedInSearch() {
    // Load campaigns to offer a target, but NEVER block on it, the URL input must
    // always show. If the user has no campaign, we auto-create one on submit.
    api("/campaigns").then(function (d) {
      var camps = ((d && d.campaigns) || []).filter(function (c) { return c.motion === motion; });
      openLiModal(camps);
    }).catch(function () { openLiModal([]); });
  }

  function openLiModal(camps) {
    var campField = (camps && camps.length)
      ? '<label>Add to campaign</label><select id="liCamp">' +
          camps.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + "</option>"; }).join("") +
        "</select>"
      : '<div class="imp-note" id="liCampNote">New prospects will be added to an auto-created <b>LinkedIn Imports</b> campaign.</div>';
    var extHtml =
      '<div class="li-ext"><div class="li-ext-h">🧩 Pull real profiles with the Chrome extension <span class="li-ext-tag">recommended</span></div>' +
        '<div id="liExtStatus" style="font-size:13px;margin:6px 0">Checking for the extension…</div>' +
        '<div id="liExtActions" class="btn-row" style="margin:8px 0"></div>' +
        '<div class="muted" style="font-size:12px;margin-top:4px">Once connected, run your Sales Navigator search and click <b>Scrape this search</b> in the extension, it pages through slowly and posts every profile (photo, title, company) straight into Prospects.</div>' +
        '<details style="margin-top:8px"><summary style="cursor:pointer;font-size:12.5px;color:var(--text-muted,#aab)">Manual setup (advanced)</summary>' +
          '<div class="li-ext-row" style="margin-top:6px"><label>Ingest token</label><span class="li-copy"><code id="liTok">loading…</code><button class="btn btn-ghost btn-sm" id="liTokCopy">Copy</button></span></div>' +
          '<div class="li-ext-row"><label>Backend URL</label><span class="li-copy"><code id="liBase">loading…</code><button class="btn btn-ghost btn-sm" id="liBaseCopy">Copy</button></span></div>' +
        '</details>' +
      "</div>" +
      '<div class="li-or">- or quick-pull from a URL (needs the extension connected) -</div>';
    var bodyHtml =
      extHtml +
      campField +
      '<label>Engine</label>' +
      '<select id="liEngine">' +
        '<option value="unipile">Unipile API, paste a people-search URL</option>' +
        '<option value="scraper">Open-source scraper, li_at cookie, profile or search URL</option>' +
      '</select>' +
      '<label>Sales Navigator or LinkedIn search URL</label>' +
      '<input id="liUrl" type="url" autocomplete="off" placeholder="https://www.linkedin.com/sales/search/people?query=…" />' +
      '<label>Max profiles to pull</label>' +
      '<input id="liLimit" type="number" min="1" max="500" value="100" />' +
      '<div class="imp-preview" id="liPrev">Run a search in Sales Navigator (or regular LinkedIn), copy the URL from the address bar, paste it above, and hit <b>Pull profiles</b>. ' +
      "We'll pull each member into Prospects, then you enrich business email, phone &amp; cell per prospect from the pipeline.</div>" +
      '<div class="modal-foot"><button class="btn btn-ghost btn-sm" id="liCancel">Cancel</button>' +
      '<button class="btn btn-primary btn-sm" id="liGo">Pull profiles</button></div>';

    openModal("Pull LinkedIn profiles", "Use the Chrome extension to scrape a Sales Navigator search into Prospects (recommended), or quick-pull from a URL.", bodyHtml, function (root, close) {
      // Fill the extension token + backend URL (manual fallback) and wire copy buttons.
      var extTokenData = null;
      api("/ext-token").then(function (d) {
        extTokenData = d || {};
        var tok = root.querySelector("#liTok"), base = root.querySelector("#liBase");
        if (tok) tok.textContent = (d && d.token) || "-";
        if (base) base.textContent = (d && d.backendBaseUrl) || (location.origin + "/api/linkedin");
      }).catch(function () {});
      function copyFrom(id, btn) {
        var node = root.querySelector(id); if (!node) return;
        navigator.clipboard.writeText(node.textContent).then(function () { var b = root.querySelector(btn); if (b) { var o = b.textContent; b.textContent = "Copied ✓"; setTimeout(function () { b.textContent = o; }, 1200); } });
      }
      var tc = root.querySelector("#liTokCopy"); if (tc) tc.addEventListener("click", function () { copyFrom("#liTok", "#liTokCopy"); });
      var bc = root.querySelector("#liBaseCopy"); if (bc) bc.addEventListener("click", function () { copyFrom("#liBase", "#liBaseCopy"); });

      // --- one-click extension detect + connect (no copy/paste) ---
      function paintExt() {
        var st = root.querySelector("#liExtStatus"), acts = root.querySelector("#liExtActions");
        if (!st || !acts || !document.body.contains(root)) return;
        if (extState.installed) {
          st.innerHTML = '✅ Extension installed' + (extState.version ? ' <span class="muted">(v' + esc(extState.version) + ")</span>" : "");
          acts.innerHTML = '<button class="btn btn-primary btn-sm" id="liExtConnect">🔗 Connect this workspace</button>';
          root.querySelector("#liExtConnect").addEventListener("click", function () {
            var b = this;
            var token = extTokenData && extTokenData.token;
            if (!token) { toast("Loading your ingest token, try again in a second."); return; }
            b.disabled = true; b.textContent = "Connecting…";
            extConfigure((extTokenData && extTokenData.backendBaseUrl) || (location.origin + "/api/linkedin"), token);
          });
        } else {
          st.innerHTML = "⬇ Extension not detected.";
          acts.innerHTML = (EXT_STORE_URL
            ? '<a class="btn btn-primary btn-sm" href="' + esc(EXT_STORE_URL) + '" target="_blank" rel="noopener">➕ Add to Chrome</a> '
            : '<span class="muted" style="font-size:12.5px">Install it (Chrome → Extensions → Developer mode → Load unpacked → the <code>extension/</code> folder). </span>') +
            '<button class="btn btn-ghost btn-sm" id="liExtRecheck">Re-check</button>';
          var rc = root.querySelector("#liExtRecheck"); if (rc) rc.addEventListener("click", extPing);
        }
      }
      function onExtConfigured(e) {
        if (!document.body.contains(root)) return;
        var c = root.querySelector("#liExtConnect");
        if (e.detail && e.detail.ok) { toast("Extension connected ✅, searches run here automatically now."); if (c) { c.disabled = true; c.textContent = "✅ Connected"; } }
        else { if (c) { c.disabled = false; c.textContent = "🔗 Connect this workspace"; } toast("Could not connect the extension" + (e.detail && e.detail.error ? " (" + e.detail.error + ")" : ".")); }
      }
      document.addEventListener("ros-ext-present", paintExt);
      document.addEventListener("ros-ext-configured", onExtConfigured);
      paintExt(); extPing();

      var urlEl = root.querySelector("#liUrl"), prev = root.querySelector("#liPrev");
      var engineEl = root.querySelector("#liEngine");
      if (urlEl.focus) try { urlEl.focus(); } catch (e) {}
      function engine() { return engineEl && engineEl.value === "scraper" ? "scraper" : "unipile"; }
      function isProfileUrl(u) { return /linkedin\.com\/in\//i.test(u); }
      function valid() { return /^https?:\/\/(www\.)?linkedin\.com\//i.test((urlEl.value || "").trim()); }
      function repaintPrev() {
        var u = (urlEl.value || "").trim();
        if (!u) { prev.innerHTML = engine() === "scraper"
          ? "Paste a <b>profile URL</b> (linkedin.com/in/…) for a reliable single pull, or a people-search URL for a best-effort list."
          : "Paste a LinkedIn / Sales Navigator search URL above."; return; }
        if (!valid()) { prev.innerHTML = "That doesn't look like a linkedin.com URL."; return; }
        if (engine() === "scraper") {
          prev.innerHTML = isProfileUrl(u)
            ? "✓ Ready to scrape this profile (cookie engine). Pulls slowly to stay under LinkedIn's radar."
            : "✓ Ready, best-effort: the scraper pages through this search with delays. List markup can be brittle; a profile URL is more reliable.";
        } else {
          prev.innerHTML = "✓ Ready to pull profiles from this search.";
        }
      }
      urlEl.addEventListener("input", repaintPrev);
      if (engineEl) engineEl.addEventListener("change", repaintPrev);
      root.querySelector("#liCancel").addEventListener("click", close);
      root.querySelector("#liGo").addEventListener("click", function () {
        var url = (urlEl.value || "").trim();
        if (!valid()) { toast("Paste a LinkedIn or Sales Navigator search URL."); urlEl.focus(); return; }
        var limit = parseInt(root.querySelector("#liLimit").value, 10) || 100;
        var eng = engine();
        var sel = root.querySelector("#liCamp");
        var chosen = (sel && sel.value) ? sel.value : null;
        close();   // dismiss the popup right away; progress shows in the Prospects view
        if (chosen) startLinkedInPull(chosen, url, limit, eng);
        else resolveBdCampaign(function (cid) {
          if (!cid) { toast("Could not prepare a campaign."); return; }
          startLinkedInPull(cid, url, limit, eng);
        });
      });
    });
  }

  // Drive the LinkedIn pull with a live progress bar in the Prospects view, then
  // populate the pipeline. (Date.now() is fine here, this is browser code.)
  function startLinkedInPull(cid, url, limit, engine) {
    engine = engine || "unipile";
    var slow = engine === "scraper";
    var box = document.getElementById("liProgress");
    if (!box) { location.hash = "prospects"; box = document.getElementById("liProgress"); }
    if (!box) return;
    var started = Date.now();
    box.innerHTML =
      '<div class="li-prog running"><div class="li-prog-top">' +
        '<span class="li-prog-title">🔗 ' + (slow ? "Scraping LinkedIn (cookie engine)…" : "Pulling LinkedIn profiles…") + '</span>' +
        '<span class="li-prog-meta" id="liProgMeta">target ' + limit + " · 0s</span></div>" +
        '<div class="li-bar"><span class="li-bar-fill indet"></span></div>' +
        '<div class="li-prog-sub">' + (slow
          ? "Paging through slowly with human-like delays so the account stays safe, this can take a few minutes."
          : "Running your search and adding members to Prospects, this can take a moment.") + "</div></div>";
    var meta = document.getElementById("liProgMeta");
    var tick = setInterval(function () {
      var s = Math.round((Date.now() - started) / 1000);
      if (meta) meta.textContent = "target " + limit + " · " + s + "s";
    }, 1000);
    viewTimers.push(tick);

    send("/prospects", "POST", { action: "linkedin_search", campaignId: cid, url: url, limit: limit, motion: motion, engine: engine }).then(function (res) {
      clearInterval(tick);
      if (res.ok) { finishLinkedInPull(box, (res.data || {}).added || 0, (res.data || {}).deduped || 0, (res.data || {}).warnings); if (prospectsReload) prospectsReload(); }
      else {
        var err = res.data && res.data.error;
        var isUnavail = /^search_unavailable|^search_failed/.test(err || "");
        var isScrape = /^scrape_/.test(err || "");
        errorLinkedInPull(box, err === "no_linkedin_account" ? "Connect a LinkedIn account first (Accounts → LinkedIn)."
          : err === "scraper_not_configured" ? "The scraper engine needs a LinkedIn session cookie. Set LINKEDIN_LI_AT (and SCRAPER_TOKEN) in the server env, or switch the engine to Unipile."
          : /^scrape_429/.test(err || "") ? "LinkedIn rate-limited the scraper, it cools down automatically. Try again later or pull fewer profiles."
          : /^scrape_401/.test(err || "") ? "The li_at cookie was rejected (expired or invalid). Refresh it from a logged-in browser."
          : /^scrape_503/.test(err || "") ? "The scraper service is unreachable (still booting or not deployed). Try again shortly."
          : isScrape ? "The scraper couldn't pull this URL (" + err + "). A profile URL (/in/…) is the most reliable."
          : err === "not_a_search_url" ? "That's not a search URL, copy a people-search URL from Sales Navigator/LinkedIn."
          : err === "not_a_linkedin_url" ? "That wasn't a linkedin.com URL."
          : isUnavail ? "No server-side LinkedIn provider is connected, so this URL can't be pulled directly. Use the Chrome extension’s “Scrape this search” button above, it pages through the search slowly and posts real profiles (with photos) straight into Prospects."
          : "Could not pull profiles (" + (err || res.status) + ").");
      }
    }).catch(function () { clearInterval(tick); errorLinkedInPull(box, "Could not reach the server."); });
  }

  function finishLinkedInPull(box, added, deduped, warnings) {
    var dup = deduped ? " · " + deduped + " already in pipeline" : "";
    var warn = (warnings && warnings.length)
      ? '<div class="li-prog-sub" style="color:var(--warn,#c80)">⚠ ' + esc(warnings.join(" ")) + "</div>" : "";
    box.innerHTML =
      '<div class="li-prog done"><div class="li-prog-top">' +
        '<span class="li-prog-title">✓ LinkedIn pull complete</span>' +
        '<span class="li-prog-meta"><b id="liCount">0</b> profiles added' + dup + "</span></div>" +
        '<div class="li-bar"><span class="li-bar-fill" style="width:100%"></span></div>' +
        warn +
        '<div class="li-prog-sub">New prospects are in your pipeline below. <a href="#" id="liDismiss">Dismiss</a></div></div>';
    var el = document.getElementById("liCount"), n = 0, step = Math.max(1, Math.round(added / 30));
    var t = setInterval(function () { n = Math.min(added, n + step); if (el) el.textContent = n; if (n >= added) clearInterval(t); }, 30);
    viewTimers.push(t);
    var dz = document.getElementById("liDismiss");
    if (dz) dz.addEventListener("click", function (e) { e.preventDefault(); box.innerHTML = ""; });
  }

  function errorLinkedInPull(box, msg) {
    box.innerHTML =
      '<div class="li-prog error"><div class="li-prog-top">' +
        '<span class="li-prog-title">⚠ Could not pull profiles</span>' +
        '<a href="#" id="liDismiss" class="li-prog-meta">Dismiss</a></div>' +
        '<div class="li-prog-sub">' + esc(msg) + "</div></div>";
    var dz = document.getElementById("liDismiss");
    if (dz) dz.addEventListener("click", function (e) { e.preventDefault(); box.innerHTML = ""; });
  }

  function addAsset() {
    var name = prompt("Asset name:"); if (!name) return;
    var type = (prompt("Type: case_study, comp_benchmark, value_prop, video_script", "case_study") || "case_study");
    var bodyText = prompt("Content / text:") || "";
    send("/content", "POST", { name: name, type: type, body: bodyText })
      .then(function (r) { if (r.ok) { toast("Asset added"); renderContent($("#view")); } else toast("Could not add (" + (r.data.error || r.status) + ")"); })
      .catch(function () { toast("Could not reach the server."); });
  }

  /* ---------------- helpers ---------------- */
  function initials(n) { return (n || "?").split(/\s+/).map(function (x) { return x[0]; }).slice(0, 2).join("").toUpperCase(); }
  function colorFor(n) { var c = ["#7c5cff", "#4dd0ff", "#ff7ac6", "#38e0a6", "#ffc24d"]; var s = 0; for (var i = 0; i < (n || "").length; i++) s += n.charCodeAt(i); return c[s % c.length]; }
  function clsLabel(c) { var m = { positive: "Positive", soft_yes: "Soft yes", referral: "Referral", timing: "Timing", timing_objection: "Timing", fit: "Fit", fit_objection: "Fit", not_interested: "Not interested", stop: "STOP", unclassified: "Review" }; return m[c] || c; }
  function statusCls(s) { var m = { booked: "positive", won: "positive", replied: "soft_yes", in_sequence: "soft_yes", nurture: "timing_objection", queued: "unclassified", closed_lost: "not_interested", do_not_contact: "stop" }; return m[s] || "unclassified"; }
  function statusLabel(s, lifecycle) {
    var l = (lifecycle || REF.lifecycle).find(function (x) { return x.status === s; });
    return l ? (l[motion] || l.status) : s;
  }
  function mapProcessed(p) {
    return { name: (p.inbound.fromName || "Unknown"), channel: p.inbound.channel, source: p.inbound.source, text: p.inbound.text, cls: p.classification.class, actions: p.actionsTaken, prospectId: p.prospectId || (p.prospect && p.prospect.id) || null };
  }
  // shared UI states
  /* ============================ BD Bulk ============================
     The 200K/month top-of-funnel engine. Upload hiring-manager CSV ->
     LLM derives (role one rung below, same-size competitor, 50-200mi
     relocation) -> deterministic MPC email -> send through the warmed
     owned sending pool (lib/sending). BD motion only.
     Backend: /api/bdbulk (parse | preview | launch). Engine: lib/bd/bulkMpc. */
  function renderBdBulk(el) {
    var state = { csv: "", name: "", info: null, sending: false, step: 1 };

    el.innerHTML = '<style>' + BDB_STYLE + '</style>'
      + '<div class="bdb-wrap">'
      + '<div class="bdb-hero"><div class="bdb-hero-row">'
      + '<div class="bdb-hero-cap">200K<small>emails / month · top of funnel</small></div>'
      + '<div class="bdb-hero-desc">Upload hiring managers. We derive the role one rung below them, a competitor your size, and a believable relocation, then send a short MPC email through your warmed sending pool.</div>'
      + '<div class="bdb-gauge"><span id="bdbReady" class="bdb-ready bdb-muted">Checking pool…</span></div>'
      + '</div></div>'
      + '<div class="bdb-stepper" id="bdbStepper"></div>'
      + '<div id="bdbBody"></div>'
      + '</div>';

    var bodyEl = $("#bdbBody", el);
    renderStepper();
    api("/bdbulk").then(paintReady).catch(function () { var r = $("#bdbReady", el); if (r) r.style.display = "none"; });
    paintUpload();

    function setStep(n) { state.step = n; renderStepper(); }
    function renderStepper() {
      var steps = ["Upload", "Map", "Preview", "Launch"], h = "";
      for (var i = 0; i < steps.length; i++) {
        var n = i + 1, cls = n < state.step ? "done" : (n === state.step ? "active" : "");
        h += '<div class="bdb-snode ' + cls + '"><div class="bdb-sdot">' + (n < state.step ? "✓" : n) + '</div><div class="bdb-slabel">' + steps[i] + '</div></div>';
        if (i < steps.length - 1) h += '<div class="bdb-sline ' + (n < state.step ? "done" : "") + '"></div>';
      }
      $("#bdbStepper", el).innerHTML = h;
    }

    function paintReady(d) {
      var r = $("#bdbReady", el); if (!r) return;
      r.className = "bdb-ready";
      if (!d.mtaPreferred) { r.classList.add("bdb-warn"); r.innerHTML = "◌ Pool off"; r.title = "Set SENDING_EMAIL_PROVIDER=mta and warm mailboxes to enable launch. Preview still works."; return; }
      if (!d.ready) { r.classList.add("bdb-warn"); r.innerHTML = "◌ No warm mailboxes"; r.title = d.setupHint || ""; return; }
      r.classList.add("bdb-ok");
      r.innerHTML = '<i class="bdb-live"></i> Pool live · ~' + (d.pool.remainingToday || 0).toLocaleString() + " today";
      r.title = d.pool.sendableMailboxes + " mailboxes across " + d.pool.activeDomains + " domains";
    }

    /* ---- step 1: upload ---- */
    function paintUpload() {
      setStep(1);
      bodyEl.innerHTML =
        '<div class="bdb-card">'
        + '<div class="bdb-h">Upload your list</div>'
        + '<p class="bdb-sub">CSV with first name, title, company, and location (or city + state). Optional: an email column to send to, plus candidate columns (candidate from / role / proof point) to unlock the named-competitor hook.</p>'
        + '<div class="bdb-drop" id="bdbDrop"><div class="bdb-drop-ico">📥</div><div class="bdb-drop-t">Drop your CSV here</div><div class="bdb-drop-s">or click to browse</div><input type="file" id="bdbFile" accept=".csv,text/csv" hidden /></div>'
        + '<div id="bdbChip"></div>'
        + '<div class="bdb-paste-toggle" id="bdbPasteToggle">▸ or paste CSV text</div>'
        + '<textarea id="bdbPaste" class="bdb-ta" style="display:none" placeholder="First Name,Title,Company,City,State,Email&#10;Ryan,CFO,Acme,Austin,TX,ryan@acme.com"></textarea>'
        + '<div class="bdb-actions"><div class="bdb-spacer"></div><button class="btn btn-primary" id="bdbParse">Analyze list →</button></div>'
        + '</div>';

      var drop = $("#bdbDrop", el), file = $("#bdbFile", el);
      function readFile(f) {
        if (!f) return;
        state.name = f.name;
        var rd = new FileReader();
        rd.onload = function () { state.csv = String(rd.result || ""); $("#bdbChip", el).innerHTML = '<span class="bdb-filechip">📄 ' + esc(f.name) + ' · ready</span>'; };
        rd.readAsText(f);
      }
      drop.addEventListener("click", function () { file.click(); });
      drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("drag"); });
      drop.addEventListener("dragleave", function () { drop.classList.remove("drag"); });
      drop.addEventListener("drop", function (e) { e.preventDefault(); drop.classList.remove("drag"); readFile(e.dataTransfer.files && e.dataTransfer.files[0]); });
      file.addEventListener("change", function () { readFile(file.files && file.files[0]); });
      $("#bdbPasteToggle", el).addEventListener("click", function () {
        var ta = $("#bdbPaste", el); var open = ta.style.display !== "none";
        ta.style.display = open ? "none" : "block"; this.innerHTML = (open ? "▸" : "▾") + " or paste CSV text";
        if (!open) ta.focus();
      });
      $("#bdbParse", el).addEventListener("click", function () {
        var pasted = $("#bdbPaste", el).value.trim();
        if (pasted) state.csv = pasted;
        if (!state.csv.trim()) { toast("Add a CSV first"); return; }
        doParse();
      });
    }

    function doParse() {
      bodyEl.innerHTML = '<div class="bdb-card">' + loading() + '</div>';
      send("/bdbulk", "POST", { action: "parse", csv: state.csv }).then(function (r) {
        if (!r.ok) { toast((r.data && r.data.error) || "Could not parse"); paintUpload(); return; }
        state.info = r.data;
        paintMapping();
      });
    }

    /* ---- step 2: confirm mapping ---- */
    function paintMapping() {
      setStep(2);
      var d = state.info, m = d.mapping || {};
      var locMapped = !!(m.companyLocation || m.city || m.state);
      function field(key, label, required) {
        var src = key === "companyLocation"
          ? (m.companyLocation || [m.city ? "city" : "", m.state ? "state" : ""].filter(Boolean).map(function (k) { return m[k]; }).join(" + "))
          : m[key];
        var ok = key === "companyLocation" ? locMapped : !!src;
        var cls = ok ? "ok" : (required ? "miss" : "opt");
        return '<div class="bdb-field ' + cls + '"><span class="fd"></span><span class="bdb-field-l">' + esc(label) + '</span>'
          + '<span class="bdb-field-v">' + (src ? esc(src) : (required ? "missing" : "—")) + '</span></div>';
      }
      var required = [["firstName", "First name"], ["title", "Title"], ["company", "Company"], ["companyLocation", "Location"]];
      var optional = [["email", "Email"], ["candFrom", "Candidate from"], ["candRole", "Candidate role"], ["candProof", "Proof point"]];
      var cards = required.map(function (f) { return field(f[0], f[1], true); }).join("")
        + optional.filter(function (f) { return m[f[0]]; }).map(function (f) { return field(f[0], f[1], false); }).join("");
      var miss = (d.missingRequired || []);
      var warn = miss.length
        ? '<div class="bdb-banner warn" style="margin:14px 0 4px">⚠ Missing required: ' + esc(miss.join(", ")) + '. Rename a column or include city + state.</div>'
        : "";
      bodyEl.innerHTML =
        '<div class="bdb-card">'
        + '<div class="bdb-h">Confirm the columns</div>'
        + '<p class="bdb-sub">We auto-mapped your headers. Green is matched, amber needs a fix.</p>'
        + '<div class="bdb-tiles">' + tile(d.count.toLocaleString(), "rows", "accent") + tile((d.withEmail || 0).toLocaleString(), "with email", "") + '</div>'
        + '<div class="bdb-fields">' + cards + '</div>'
        + warn
        + '<div class="bdb-actions"><button class="btn" id="bdbBack">← Re-upload</button><div class="bdb-spacer"></div>'
        + '<button class="btn btn-primary" id="bdbPreview"' + (miss.length ? " disabled" : "") + '>Generate preview →</button></div>'
        + '</div>';
      $("#bdbBack", el).addEventListener("click", paintUpload);
      if (!miss.length) $("#bdbPreview", el).addEventListener("click", doPreview);
    }

    /* ---- step 3: preview emails ---- */
    function doPreview() {
      setStep(3);
      bodyEl.innerHTML = '<div class="bdb-card">' + loading() + '<p class="bdb-sub" style="text-align:center;margin-top:10px">Enriching a sample · one cheap model call per lead…</p></div>';
      send("/bdbulk", "POST", { action: "preview", csv: state.csv, sample: 8 }).then(function (r) {
        if (!r.ok) { toast((r.data && r.data.error) || "Preview failed"); paintMapping(); return; }
        paintPreview(r.data.previews || []);
      });
    }

    function paintPreview(previews) {
      var cards = previews.map(function (p) {
        var e = p.email, en = p.enrichment || {};
        var to = [(p.row && p.row.firstName) || "", (p.row && p.row.title) || "", (p.row && p.row.company) || ""].filter(Boolean).join(" · ");
        var chips = [chip("↳ " + (en.subordinateRole || "?"), "role"),
          chip(en.nameCompetitor ? en.competitor : "competitor your size", en.nameCompetitor ? "named" : "soft"),
          en.originCity ? chip("📍 " + en.originCity, "geo") : "",
          en.proofPoint ? chip("✦ proof", "named") : "",
          chip(e.wordCount + " words", "len")].join("");
        return '<div class="bdb-mail">'
          + '<div class="bdb-mail-bar"><i class="bdb-dot-r"></i><i class="bdb-dot-y"></i><i class="bdb-dot-g"></i><em>' + esc(to) + '</em></div>'
          + '<div class="bdb-mail-body"><div class="bdb-mail-meta"><b>Subject:</b> ' + esc(e.subject) + '</div>'
          + '<div class="bdb-bodytxt">' + esc(e.body) + '</div>'
          + '<div class="bdb-chips">' + chips + '</div></div>'
          + '</div>';
      }).join("");
      bodyEl.innerHTML =
        '<div class="bdb-card">'
        + '<div class="bdb-h">Review the copy</div>'
        + '<p class="bdb-sub">A live sample, rendered exactly as it will send. Every row varies, no two share a skeleton. Competitors are named only where a real candidate is attached, otherwise we say a competitor your size.</p>'
        + '<div class="bdb-inrow"><label>Reply-to / sender<input id="bdbSender" class="bdb-in" placeholder="you@yourdomain.com" /></label>'
        + '<label>From name<input id="bdbFromName" class="bdb-in" placeholder="Ryan" /></label></div>'
        + cards
        + '<div class="bdb-actions"><button class="btn" id="bdbBack2">← Columns</button><div class="bdb-spacer"></div>'
        + '<button class="btn btn-primary bdb-cta" id="bdbLaunch">🚀 Launch to ' + state.info.count.toLocaleString() + ' prospects</button></div>'
        + '</div>';
      $("#bdbBack2", el).addEventListener("click", paintMapping);
      $("#bdbLaunch", el).addEventListener("click", doLaunch);
    }

    /* ---- step 4: launch — drain the list in batches through the pool ---- */
    function doLaunch() {
      if (state.sending) return;
      var sender = ($("#bdbSender", el) || {}).value, fromName = ($("#bdbFromName", el) || {}).value;
      state.sending = true; setStep(4);
      var total = state.info.count, offset = 0;
      var totals = { sent: 0, suppressed: 0, noCapacity: 0, errors: 0 };
      bodyEl.innerHTML =
        '<div class="bdb-card">'
        + '<div class="bdb-h">🚀 Launching to ' + total.toLocaleString() + ' prospects</div>'
        + '<p class="bdb-sub">Sending through your warmed pool. It self-throttles to protect deliverability and pauses when today’s ceiling is hit.</p>'
        + '<div class="bdb-bigbar"><span id="bdbBar" style="width:0%"></span></div>'
        + '<div class="bdb-progline"><span id="bdbCount">0</span> / ' + total.toLocaleString() + '</div>'
        + '<div class="bdb-ltiles">' + ltile("bdbSent", "Sent", "sent") + ltile("bdbSupp", "Suppressed", "") + ltile("bdbCap", "No capacity", "") + ltile("bdbErr", "Errors", "err") + '</div>'
        + '<div id="bdbBanner"></div>'
        + '</div>';

      function upd() {
        var ids = { bdbSent: totals.sent, bdbSupp: totals.suppressed, bdbCap: totals.noCapacity, bdbErr: totals.errors };
        for (var k in ids) { var n = $("#" + k, el); if (n) n.textContent = ids[k].toLocaleString(); }
        var pct = total ? Math.min(100, Math.round(offset / total * 100)) : 100;
        var bar = $("#bdbBar", el); if (bar) bar.style.width = pct + "%";
        var c = $("#bdbCount", el); if (c) c.textContent = offset.toLocaleString();
      }
      function step() {
        send("/bdbulk", "POST", {
          action: "launch", csv: state.csv, offset: offset, limit: 200,
          sender: (sender || "").trim() || undefined, fromName: (fromName || "").trim() || undefined
        }).then(function (r) {
          if (!r.ok) {
            state.sending = false;
            $("#bdbBanner", el).innerHTML = '<div class="bdb-banner warn">⚠ ' + esc((r.data && r.data.error) || "Launch failed") + ' <button class="btn btn-sm" id="bdbRetry">Retry</button></div>';
            $("#bdbRetry", el).addEventListener("click", function () { if (state.sending) return; state.sending = true; $("#bdbBanner", el).innerHTML = ""; step(); });
            return;
          }
          var d = r.data;
          totals.sent += d.sent; totals.suppressed += d.suppressed; totals.noCapacity += d.noCapacity; totals.errors += d.errors;
          offset = d.processed; upd();
          if (d.capacityHit) {
            state.sending = false;
            $("#bdbBanner", el).innerHTML = '<div class="bdb-banner warn">⏸ Pool hit today’s ceiling. It ramps as your IPs and mailboxes warm. <button class="btn btn-sm" id="bdbResume">Resume</button></div>';
            $("#bdbResume", el).addEventListener("click", function () { if (state.sending) return; state.sending = true; $("#bdbBanner", el).innerHTML = ""; step(); });
            return;
          }
          if (offset >= total) {
            state.sending = false;
            $("#bdbBanner", el).innerHTML = '<div class="bdb-banner ok">✅ Complete · ' + totals.sent.toLocaleString() + ' sent <button class="btn btn-sm" id="bdbNew">New upload</button></div>';
            $("#bdbNew", el).addEventListener("click", function () { state.csv = ""; state.info = null; state.name = ""; paintUpload(); });
            toast("Done. Sent " + totals.sent);
            return;
          }
          step();
        });
      }
      step();
    }

    function tile(n, l, k) { return '<div class="bdb-tile ' + (k || "") + '"><b>' + n + '</b><span>' + esc(l) + '</span></div>'; }
    function ltile(id, l, k) { return '<div class="bdb-ltile ' + (k || "") + '"><b id="' + id + '">0</b><span>' + esc(l) + '</span></div>'; }
    function chip(t, k) { return '<span class="bdb-chip bdb-chip-' + k + '">' + esc(t) + '</span>'; }
  }

  var BDB_STYLE =
    '.bdb-wrap{max-width:920px}'
    + '.bdb-hero{position:relative;overflow:hidden;border:1px solid var(--border);border-radius:16px;padding:22px 24px;margin-bottom:18px;background:linear-gradient(135deg,rgba(124,92,255,.16),rgba(77,208,255,.05));box-shadow:var(--shadow)}'
    + '.bdb-hero::after{content:"";position:absolute;right:-70px;top:-70px;width:240px;height:240px;border-radius:50%;background:radial-gradient(circle,rgba(124,92,255,.30),transparent 70%);pointer-events:none}'
    + '.bdb-hero-row{display:flex;align-items:center;gap:24px;flex-wrap:wrap;position:relative;z-index:1}'
    + '.bdb-hero-cap{font-size:42px;font-weight:800;line-height:.9;letter-spacing:-1.5px;background:linear-gradient(135deg,#7c5cff,#4dd0ff);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;flex:none}'
    + '.bdb-hero-cap small{display:block;font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--text-dim);-webkit-text-fill-color:var(--text-dim);margin-top:7px}'
    + '.bdb-hero-desc{flex:1;min-width:240px;font-size:13.5px;color:var(--text-muted);line-height:1.55}'
    + '.bdb-gauge{margin-left:auto}'
    + '.bdb-ready{display:inline-flex;align-items:center;gap:7px;padding:8px 13px;border-radius:999px;font-size:12.5px;font-weight:600;border:1px solid var(--border);white-space:nowrap}'
    + '.bdb-muted{color:var(--text-dim)}'
    + '.bdb-ok{color:var(--accent-green,#38e0a6);background:rgba(56,224,166,.12);border-color:rgba(56,224,166,.4)}'
    + '.bdb-warn{color:var(--accent-amber,#ffc24d);background:rgba(255,194,77,.12);border-color:rgba(255,194,77,.4)}'
    + '.bdb-live{width:8px;height:8px;border-radius:50%;background:var(--accent-green,#38e0a6);box-shadow:0 0 0 0 rgba(56,224,166,.6);animation:bdbPulse 1.8s infinite}'
    + '@keyframes bdbPulse{0%{box-shadow:0 0 0 0 rgba(56,224,166,.5)}70%{box-shadow:0 0 0 7px rgba(56,224,166,0)}100%{box-shadow:0 0 0 0 rgba(56,224,166,0)}}'
    + '.bdb-stepper{display:flex;align-items:center;margin:0 0 20px}'
    + '.bdb-snode{display:flex;align-items:center;gap:10px;flex:0 0 auto}'
    + '.bdb-sdot{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-size:13px;font-weight:700;border:2px solid var(--border);color:var(--text-dim);background:var(--surface);transition:all .25s}'
    + '.bdb-slabel{font-size:12.5px;font-weight:600;color:var(--text-dim)}'
    + '.bdb-sline{flex:1;height:2px;background:var(--border);margin:0 12px;border-radius:2px;transition:background .35s}'
    + '.bdb-snode.active .bdb-sdot{border-color:var(--brand,#7c5cff);color:#fff;background:var(--brand,#7c5cff);box-shadow:0 0 0 4px rgba(124,92,255,.18)}'
    + '.bdb-snode.active .bdb-slabel{color:var(--text)}'
    + '.bdb-snode.done .bdb-sdot{border-color:var(--accent-green,#38e0a6);background:var(--accent-green,#38e0a6);color:#04150f}'
    + '.bdb-snode.done .bdb-slabel{color:var(--text-muted)}'
    + '.bdb-sline.done{background:linear-gradient(90deg,var(--accent-green,#38e0a6),var(--brand,#7c5cff))}'
    + '.bdb-card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:22px;box-shadow:var(--shadow)}'
    + '.bdb-h{font-size:17px;font-weight:700;margin:0 0 4px}.bdb-sub{font-size:13px;color:var(--text-muted);margin:0 0 18px;line-height:1.55}'
    + '.bdb-drop{border:2px dashed var(--border-strong);border-radius:14px;padding:40px 20px;text-align:center;cursor:pointer;transition:all .18s;background:var(--bg-soft)}'
    + '.bdb-drop:hover{border-color:var(--brand,#7c5cff);background:rgba(124,92,255,.05)}'
    + '.bdb-drop.drag{border-color:var(--brand,#7c5cff);background:rgba(124,92,255,.1);transform:scale(1.01)}'
    + '.bdb-drop-ico{font-size:40px;line-height:1}.bdb-drop-t{font-weight:700;font-size:15px;margin-top:8px}.bdb-drop-s{font-size:12.5px;color:var(--text-dim);margin-top:3px}'
    + '.bdb-filechip{display:inline-flex;align-items:center;gap:8px;margin-top:14px;padding:8px 14px;border-radius:10px;background:rgba(56,224,166,.12);color:var(--accent-green,#38e0a6);font-size:13px;font-weight:600;border:1px solid rgba(56,224,166,.35)}'
    + '.bdb-paste-toggle{display:inline-block;margin-top:14px;font-size:12.5px;color:var(--text-muted);cursor:pointer;user-select:none}'
    + '.bdb-ta{width:100%;min-height:96px;margin-top:10px;background:var(--bg-soft);border:1px solid var(--border);border-radius:10px;color:var(--text);padding:11px;font-family:var(--mono);font-size:12px;resize:vertical}'
    + '.bdb-actions{margin-top:20px;display:flex;gap:10px;align-items:center}.bdb-spacer{flex:1}'
    + '.bdb-cta{font-size:14px;padding:10px 18px}'
    + '.bdb-tiles{display:flex;gap:14px;margin:2px 0 18px;flex-wrap:wrap}'
    + '.bdb-tile{flex:1;min-width:130px;background:var(--bg-soft);border:1px solid var(--border);border-radius:12px;padding:14px 16px}'
    + '.bdb-tile b{display:block;font-size:26px;font-weight:800;line-height:1}.bdb-tile span{font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.06em}'
    + '.bdb-tile.accent b{color:var(--brand,#7c5cff)}'
    + '.bdb-fields{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}'
    + '.bdb-field{display:flex;align-items:center;gap:10px;padding:11px 13px;border:1px solid var(--border);border-radius:11px;background:var(--bg-soft)}'
    + '.bdb-field .fd{width:9px;height:9px;border-radius:50%;flex:none}'
    + '.bdb-field.ok .fd{background:var(--accent-green,#38e0a6);box-shadow:0 0 8px var(--accent-green,#38e0a6)}'
    + '.bdb-field.miss .fd{background:var(--accent-amber,#ffc24d);box-shadow:0 0 8px var(--accent-amber,#ffc24d)}'
    + '.bdb-field.opt .fd{background:var(--text-dim)}'
    + '.bdb-field-l{font-size:13px;font-weight:600}.bdb-field-v{font-size:11.5px;color:var(--text-dim);font-family:var(--mono);margin-left:auto;max-width:48%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.bdb-mail{border:1px solid var(--border);border-radius:13px;margin:12px 0;background:var(--surface);overflow:hidden;box-shadow:0 8px 24px -18px rgba(0,0,0,.5)}'
    + '.bdb-mail-bar{display:flex;align-items:center;gap:6px;padding:9px 13px;background:var(--bg-soft);border-bottom:1px solid var(--border)}'
    + '.bdb-mail-bar i{width:10px;height:10px;border-radius:50%;display:inline-block}.bdb-dot-r{background:#ff5f57}.bdb-dot-y{background:#febc2e}.bdb-dot-g{background:#28c840}'
    + '.bdb-mail-bar em{margin-left:8px;font-style:normal;font-size:11.5px;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.bdb-mail-body{padding:14px 16px}.bdb-mail-meta{font-size:12.5px;color:var(--text-muted);margin-bottom:10px}.bdb-mail-meta b{color:var(--text)}'
    + '.bdb-bodytxt{font-size:13.5px;line-height:1.6;white-space:pre-wrap;color:var(--text)}'
    + '.bdb-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}'
    + '.bdb-chip{font-size:11px;font-weight:600;padding:3px 9px;border-radius:999px;background:var(--surface-2);color:var(--text-muted);border:1px solid var(--border)}'
    + '.bdb-chip-named{background:rgba(56,224,166,.14);color:var(--accent-green,#38e0a6);border-color:rgba(56,224,166,.3)}'
    + '.bdb-chip-soft{background:rgba(255,194,77,.14);color:var(--accent-amber,#ffc24d);border-color:rgba(255,194,77,.3)}'
    + '.bdb-chip-role{background:rgba(124,92,255,.14);color:var(--brand,#7c5cff);border-color:rgba(124,92,255,.3)}'
    + '.bdb-chip-geo{background:rgba(77,208,255,.14);color:var(--brand-2,#4dd0ff);border-color:rgba(77,208,255,.3)}'
    + '.bdb-inrow{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:4px}.bdb-inrow label{font-size:12px;color:var(--text-muted);font-weight:600;display:block}'
    + '.bdb-in{width:100%;background:var(--bg-soft);border:1px solid var(--border);border-radius:10px;color:var(--text);padding:10px 12px;font-size:13px;margin-top:5px}.bdb-in:focus{outline:none;border-color:var(--brand,#7c5cff)}'
    + '.bdb-bigbar{height:14px;background:var(--bg-soft);border:1px solid var(--border);border-radius:999px;overflow:hidden;margin:16px 0 8px}'
    + '.bdb-bigbar span{display:block;height:100%;width:0;background:linear-gradient(90deg,#7c5cff,#4dd0ff);background-size:200% 100%;animation:bdbShimmer 1.4s linear infinite;transition:width .4s ease;border-radius:999px}'
    + '@keyframes bdbShimmer{0%{background-position:0 0}100%{background-position:200% 0}}'
    + '.bdb-progline{text-align:center;font-size:12.5px;color:var(--text-muted);margin-bottom:14px}.bdb-progline span{font-weight:800;color:var(--text)}'
    + '.bdb-ltiles{display:flex;gap:12px}.bdb-ltile{flex:1;background:var(--bg-soft);border:1px solid var(--border);border-radius:12px;padding:12px;text-align:center}'
    + '.bdb-ltile b{display:block;font-size:24px;font-weight:800;line-height:1}.bdb-ltile span{font-size:10.5px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em}'
    + '.bdb-ltile.sent b{color:var(--accent-green,#38e0a6)}.bdb-ltile.err b{color:var(--accent-red,#ff6b6b)}'
    + '.bdb-banner{margin-top:16px;padding:11px 14px;border-radius:11px;font-size:13px;font-weight:600;display:flex;gap:10px;align-items:center;justify-content:center;flex-wrap:wrap}'
    + '.bdb-banner.ok{background:rgba(56,224,166,.12);color:var(--accent-green,#38e0a6);border:1px solid rgba(56,224,166,.35)}'
    + '.bdb-banner.warn{background:rgba(255,194,77,.12);color:var(--accent-amber,#ffc24d);border:1px solid rgba(255,194,77,.35)}'
    + '@media(max-width:640px){.bdb-inrow{grid-template-columns:1fr}.bdb-ltiles{flex-wrap:wrap}.bdb-slabel{display:none}}';

  function loading() { return '<div class="empty">Loading…</div>'; }
  function emptyCard(msg) { return '<div class="empty">' + esc(msg) + "</div>"; }
  function needsSetup() {
    return '<div class="empty">Couldn\'t load this yet. If you just created your workspace, connect your tools under <a href="#connected">Connected</a> to get started.</div>';
  }

  render();

  /* ---------------- reference content (product knowledge, NOT customer data) -- */
  // Everything here is how the product WORKS (rules, schedule, sequence anatomy,
  // ATS mapping). All real customer data is fetched live from the API.
  function ref() {
    return {
      rules: [
        { cls: "positive", label: "Positive", triggers: ["yes", "tell me more", "booking-link click"], actions: ["push notification", "pause all sequences", "status replied"], sla: "same day" },
        { cls: "soft_yes", label: "Soft yes", triggers: ["asks a question", "requests an asset"], actions: ["send asset", "tag engaged", "advance +1 touch"], sla: "4 hours" },
        { cls: "timing_objection", label: "Timing", triggers: ["not now", "next quarter"], actions: ["capture timing", "90-day nurture"], sla: "same day" },
        { cls: "fit_objection", label: "Fit", triggers: ["recruit internally", "happy with current"], actions: ["6-month nurture", "suppress signals"], sla: "same day" },
        { cls: "referral", label: "Referral", triggers: ["talk to X", "not me, but"], actions: ["capture referral", "tag advocate", "notify"], sla: "same day" },
        { cls: "stop", label: "STOP", triggers: ["stop", "unsubscribe", "remove me"], actions: ["suppress all channels", "do-not-contact"], sla: "immediate" }
      ],
      lifecycle: [
        { status: "queued", bd: "Queued", recruiting: "Queued" },
        { status: "in_sequence", bd: "In sequence", recruiting: "In sequence" },
        { status: "replied", bd: "Replied", recruiting: "Replied" },
        { status: "booked", bd: "Discovery booked", recruiting: "Submitted" },
        { status: "won", bd: "Mandate signed", recruiting: "Placed" },
        { status: "nurture", bd: "Nurture", recruiting: "Nurture" }
      ],
      phases: [
        { n: 1, title: "Infrastructure pre-flight", time: "one-time", done: "Overview capacity strip is green", items: ["≥1 warmed LinkedIn account", "≥5 warmed domains", "Job Search signal feed", "Enrichment waterfall", "ATS connected", "TalTxt + Telnyx 10DLC"] },
        { n: 2, title: "Create campaign shell", time: "5 min", done: "Draft with ICP + signals", items: ["Name + one-line goal", "ICP definition", "≥1 signal enabled"] },
        { n: 3, title: "Search & discovery", time: "5 min", done: "Preview shows the right people", items: ["Role hiring for", "Persona title", "Decision-maker target", "Live query preview"] },
        { n: 4, title: "Connect channels", time: "3 min", done: "All channels show ✓", items: ["Instantly campaign id", "LinkedIn account", "TalTxt toggle", "Loxo list id"] },
        { n: 5, title: "Sequence methodology", time: "3 min", done: "Methodology + assets locked", items: ["Methodology", "Voice-note threshold (80)", "LLM personalization", "Content assets"] },
        { n: 6, title: "A/B variants", time: "2 min", done: "2+ variants, weights = 100%", items: ["≥2 variants", "Traffic weights 50/50", "ONE variable differs"] },
        { n: 7, title: "Soft launch & activate", time: "5 min", done: "Status = Active, first 25 live", items: ["Daily cap = 25", "Build prospect list", "Activate campaign", "Day-1 approval review"] }
      ],
      touches: [
        { channel: "email", day: 0, name: "Signal Opener", intent: "Hook on the trigger; ask 'worth sending?'", constraints: "subject ≤8 words, body ≤90 words" },
        { channel: "linkedin", day: 0, name: "Profile view", intent: "Passive warmup." },
        { channel: "linkedin", day: 1, name: "Follow", intent: "Lower commitment than a connect." },
        { channel: "email", day: 3, name: "Value Drop", intent: "Case study or comp benchmark, no ask." },
        { channel: "linkedin", day: 3, name: "Connect, no note", intent: "Empty requests accept higher." },
        { channel: "linkedin", day: 5, name: "Engage with a post", intent: "Manual comment, signals attention." },
        { channel: "email", day: 7, name: "Comparable Proof", intent: "Numbers + timeline." },
        { channel: "linkedin", day: 7, name: "Signal-anchored DM", intent: "Same trigger as email touch 1.", constraints: "≤45 words" },
        { channel: "email", day: 12, name: "Interactive Question", intent: "One sharp question." },
        { channel: "voice", day: 14, name: "Voice note (HOT)", intent: "One point, ask for a thumbs-up.", constraints: "25-30 sec" },
        { channel: "email", day: 18, name: "Market View", intent: "Three sector bullets." },
        { channel: "linkedin", day: 21, name: "Direct DM ask", intent: "Calendar link, 15 min." },
        { channel: "email", day: 24, name: "Direct Ask", intent: "Reference prior drops.", constraints: "subject '15 min next week?'" },
        { channel: "email", day: 28, name: "Break-up", intent: "Highest reply rate.", constraints: "subject 'Should I close the file?'" }
      ],
      seqRules: [
        "Reply on ANY channel → pause ALL, notify, status = replied.",
        "LinkedIn connect not accepted by Day 5 → skip DM, email-only.",
        "Warmth ≥ 80 → voice note enabled Day 14.",
        "Email bounce on Touch 1 → suppress + re-enrich.",
        "STOP / unsubscribe → suppress all channels + DNC.",
        "Day 28 no reply → 90-day nurture."
      ],
      cadence: [
        { at: "07:00", name: "Pull signals", automated: true, detail: "Run enabled signal sources (last 24h)." },
        { at: "07:15", name: "Score & dedupe", automated: true, detail: "Composite score per ICP; dedupe vs ATS; top N advance." },
        { at: "07:30", name: "Enrich", automated: true, detail: "Enrichment waterfall finds work emails and direct dials." },
        { at: "07:45", name: "LLM draft", automated: true, detail: "Claude drafts email + LinkedIn + voice; A/B applied." },
        { at: "08:30", name: "Approval queue", automated: false, detail: "Edit / kill / approve; record HOT voice notes." },
        { at: "09:00", name: "Push to channels", automated: true, detail: "Instantly / Unipile / TalTxt; person_events logged." }
      ],
      assets: [
        { name: "Fintech placement case study", type: "case_study", campaignIds: ["c1"] },
        { name: "EU eng comp benchmark 2026", type: "comp_benchmark", campaignIds: ["c1", "c2"] },
        { name: "Why signal-based outreach", type: "value_prop", campaignIds: [] }
      ],
      accounts: {
        linkedin: [
          { handle: "jamie@yourfirm.com", platform: "unipile", warmup: "warmed", quotas: { connects: 20 } },
          { handle: "bd@yourfirm.com", platform: "salesrobot", warmup: "in_warmup", quotas: { connects: 12 } }
        ],
        domains: [
          { domain: "go-yourfirm.com", inboxes: 3, health: "healthy", bounceRate: 0.004 },
          { domain: "try-yourfirm.com", inboxes: 3, health: "healthy", bounceRate: 0.009 },
          { domain: "hey-yourfirm.com", inboxes: 3, health: "warming", bounceRate: 0.0 }
        ]
      },
      integrations: [
        { id: "instantly", label: "Instantly (email)", status: "green", requiredFor: ["bd", "recruiting"] },
        { id: "unipile", label: "Unipile (LinkedIn)", status: "green", requiredFor: ["bd", "recruiting"] },
        { id: "rapidapi", label: "Job Search (signal feed)", status: "green", requiredFor: ["bd", "recruiting"] },
        { id: "fresh_linkedin", label: "Profile enrichment", status: "green", requiredFor: ["bd", "recruiting"] },
        { id: "tomba", label: "Email finder", status: "yellow", requiredFor: ["bd"] },
        { id: "loxo", label: "Loxo (ATS)", status: "green", requiredFor: ["bd", "recruiting"] },
        { id: "taltxt", label: "TalTxt (SMS)", status: "green", requiredFor: ["recruiting"] },
        { id: "telnyx", label: "Telnyx 10DLC", status: "green", requiredFor: ["recruiting"] }
      ],
      atsVendors: [
        { vendor: "loxo", label: "Loxo", status: "verified" }, { vendor: "bullhorn", label: "Bullhorn", status: "placeholder" },
        { vendor: "crelate", label: "Crelate", status: "placeholder" }, { vendor: "greenhouse", label: "Greenhouse", status: "placeholder" },
        { vendor: "lever", label: "Lever", status: "placeholder" }
      ],
      atsActive: "loxo",
      team: [
        { name: (ctx.user && ctx.user.name) || "You", email: (ctx.user && ctx.user.email) || "you@company.com", role: ctx.role || "owner", isYou: true },
        { name: "Sam Carter", email: "sam@company.com", role: "admin", isYou: false },
        { name: "Riley Chen", email: "riley@company.com", role: "member", isYou: false }
      ],
      objectMap: [
        { concept: "BD prospect", object: "Person + list", how: "POST /people/update_by_email" },
        { concept: "Activity (any touch)", object: "person_event", how: "POST /people/{id}/person_events" },
        { concept: "BD opportunity", object: "Deal", how: "one per pitch → Job when signed" },
        { concept: "Candidate in mandate", object: "Person↔Job", how: "POST /jobs/{id}/apply" },
        { concept: "Mandate", object: "Job", how: "job_type_id, company_id" },
        { concept: "Placement", object: "Placement", how: "triggers billing" }
      ]
    };
  }

  /* The ATS object map is also exposed by GET /api/ats; this local copy is only a
     fallback so the ATS screen renders if that call is briefly unavailable. */

  /* ============================================================
     Account menu (upper right): logo upload + enterprise dropdown
     ============================================================ */
  // White-label workspace logo: swap the sidebar "RecruitersOS" wordmark for the
  // workspace's own logo. Renders for everyone; only admins (accounts:manage) get
  // the upload/reset controls. Cached locally for a flash-free reload, then
  // refreshed from /api/branding (authoritative + cross-device).
  (function workspaceBrand() {
    var link = $("#brandLink");
    if (!link) return;
    var word = link.querySelector(".brand-word");
    var wsId = (ctx.workspace && ctx.workspace.id) || "ws";
    var CACHE = "ros_brand_" + wsId;

    var lastBranding = {};
    function currentTheme() { return document.documentElement.getAttribute("data-theme") || "dark"; }
    function render(b) {
      b = b || {};
      lastBranding = b;
      // Un-hide the wordmark the instant we have a brand to paint (the white-label
      // head guard hides it on a custom domain to avoid a house-brand flash).
      try { document.documentElement.classList.remove("wl-hide"); } catch (e) {}
      // Pick the logo for the current appearance: a transparent/light logo for the
      // dark theme, a colored logo for the light theme. Either falls back to the
      // other if only one is set.
      var theme = currentTheme();
      var logo = theme === "light" ? (b.logoLightUrl || b.logoUrl) : (b.logoUrl || b.logoLightUrl);
      var existing = link.querySelector(".brand-logo");
      if (logo) {
        if (word) word.style.display = "none";
        var img = existing || document.createElement("img");
        img.className = "brand-logo";
        img.alt = b.brandName || "Workspace logo";
        img.src = logo;
        img.style.height = Math.round(44 * (b.logoScale || 1)) + "px"; // user logo-size control
        if (!existing) link.appendChild(img);
      } else {
        if (existing) existing.remove();
        if (word) {
          if (b.brandName) { word.style.display = ""; word.textContent = b.brandName; }
          // No logo and no brand name: only the house domain may show the house
          // wordmark. On a white-label domain leave it blank, the preset/logo
          // fallback below fills it, and we never flash the house brand.
          else if (IS_HOUSE) { word.style.display = ""; word.innerHTML = 'Recruiters<span class="os">OS</span>'; }
          else { word.textContent = ""; }
        }
      }
      // Accent color -> primary brand variable (recolors buttons, highlights, …).
      var root = document.documentElement;
      if (b.accentColor) {
        root.style.setProperty("--brand", b.accentColor);
        if (window.__wlTheme) window.__wlTheme(b.accentColor); // full palette recolor (grad/aurora)
      } else root.style.removeProperty("--brand");
      // Product name -> page title; logo/preset mark -> favicon.
      if (b.brandName) document.title = b.brandName + " · Command Center";
      var favHref = b.faviconUrl || logo;
      if (favHref) {
        var fav = document.querySelector('link[rel="icon"]');
        if (!fav) { fav = document.createElement("link"); fav.rel = "icon"; document.head.appendChild(fav); }
        fav.setAttribute("href", favHref);
      }
      // Quick-upload label reflects which appearance's logo it will set.
      var ul = document.getElementById("brandUploadLabel");
      if (ul) ul.textContent = "Change " + (theme === "light" ? "light" : "dark") + " logo";
    }
    function cache(b) { try { localStorage.setItem(CACHE, JSON.stringify(b || {})); } catch (e) {} }
    // Let the Setup → Branding screen push live changes back to the chrome.
    window.__rosApplyBrand = function (b) { render(b); cache(b); };

    // 1) Paint instantly from the last-known branding (no flash on reload).
    var cached = null; try { cached = JSON.parse(localStorage.getItem(CACHE) || "null"); } catch (e) {}
    if (cached) render(cached);

    // 2) Refresh from the server (authoritative).
    send("/branding", "GET").then(function (r) {
      var b = r && r.ok && r.data && r.data.branding;
      var configured = b && (b.logoUrl || b.logoLightUrl || b.brandName || b.accentColor);
      if (configured) { render(b); cache(b); return; }
      // Workspace hasn't set its own branding yet. On a white-label custom domain,
      // fall back to the host's built-in brand preset so the portal still shows the
      // customer's identity (never the house "RecruitersOS" wordmark).
      var host = location.host || "";
      var houseHost = /(^|\.)recruitersos\.co$|localhost|127\.0\.0\.1|^$/.test(host);
      if (houseHost) return;
      var base = (window.RECRUITEROS_API_BASE || "") + "/api";
      fetch(base + "/branding/resolve?host=" + encodeURIComponent(host))
        .then(function (res) { return res.json(); })
        .then(function (d) { var pb = d && d.branding; if (pb && (pb.logoUrl || pb.brandName)) { render(pb); cache(pb); } })
        .catch(function () {});
    }).catch(function () {});

    // 2b) Swap the dark/light logo live when the appearance toggle flips data-theme.
    try {
      new MutationObserver(function () { render(lastBranding); })
        .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    } catch (e) {}

    // 3) Admin-only controls.
    var canEdit = (typeof can === "function") ? can("accounts:manage") : (ctx.role !== "member");
    if (!canEdit) return;
    var up = $("#brandUpload"), file = $("#brandFile");
    if (up) up.hidden = false;

    function persist(patch, okMsg) {
      send("/branding", "POST", patch).then(function (r) {
        if (r && r.ok && r.data && r.data.branding) {
          render(r.data.branding); cache(r.data.branding);
          if (okMsg) toast(okMsg);
        } else { toast((r && r.data && r.data.error === "logo_too_large") ? "That logo is too large. Try a smaller image." : "Couldn't save the logo."); }
      }).catch(function () { toast("Couldn't reach the server."); });
    }

    if (file) file.addEventListener("change", function () {
      var f = file.files && file.files[0];
      if (!f) return;
      if (!/^image\//.test(f.type)) { toast("Please choose an image file."); return; }
      // Theme-aware: this sets the logo for the CURRENT appearance, the
      // transparent logo in dark mode, the colored logo in light mode. Toggle
      // appearance and upload again to set the other.
      var isLight = document.documentElement.getAttribute("data-theme") === "light";
      var key = isLight ? "logoLightUrl" : "logoUrl";
      openLogoAdjuster(f, { bg: isLight ? "light" : "dark", label: isLight ? "light theme" : "dark theme" }, function (dataUrl) {
        var patch = {}; patch[key] = dataUrl;
        persist(patch, (isLight ? "Light" : "Dark") + " logo updated");
      });
      file.value = ""; // allow re-picking the same file later
    });
  })();

  (function accountMenu() {
    var btn = $("#acctBtn"), menu = $("#acctMenu"), acct = $("#acct");
    if (!btn || !menu) return;

    var name = (ctx.user && ctx.user.name) || "You";
    var email = (ctx.user && ctx.user.email) || "you@company.com";
    var plan = (ctx.workspace && ctx.workspace.plan) ? ctx.workspace.plan : "Workspace";
    var inits = initials(name);
    var LOGO_KEY = "ros_logo_" + ((ctx.workspace && ctx.workspace.id) || "ws");

    var avatar = $("#acctAvatar"), avatarLg = $("#acctAvatarLg");
    $("#acctName").textContent = name;
    $("#acctEmail").textContent = email;
    $("#acctPlan").textContent = plan;

    function applyImg(dataUrl) {
      [avatar, avatarLg].forEach(function (a) {
        if (!a) return;
        a.textContent = inits;
        if (dataUrl) { a.style.backgroundImage = "url(" + dataUrl + ")"; a.style.backgroundSize = "cover"; a.style.backgroundPosition = "center"; a.classList.add("has-img"); }
        else { a.style.backgroundImage = ""; a.classList.remove("has-img"); }
      });
    }
    var saved = null; try { saved = localStorage.getItem(LOGO_KEY); } catch (e) {}
    applyImg(saved);

    function setOpen(o) { menu.hidden = !o; btn.setAttribute("aria-expanded", String(o)); }
    btn.addEventListener("click", function (e) { e.stopPropagation(); setOpen(menu.hidden); });
    document.addEventListener("click", function (e) { if (!acct.contains(e.target)) setOpen(false); });
    window.addEventListener("keydown", function (e) { if (e.key === "Escape") setOpen(false); });

    // Image upload, any size, downscaled to a 256px square data URL (cover-fit).
    var fileInput = $("#logoFile");
    if (fileInput) {
      fileInput.addEventListener("change", function () {
        var f = fileInput.files && fileInput.files[0];
        if (!f) return;
        if (!/^image\//.test(f.type)) { toast("Please choose an image file."); return; }
        var reader = new FileReader();
        reader.onload = function () {
          var img = new Image();
          img.onload = function () {
            var S = 256, cv = document.createElement("canvas"); cv.width = cv.height = S;
            var c = cv.getContext("2d");
            var scale = Math.max(S / img.width, S / img.height);
            var w = img.width * scale, h = img.height * scale;
            c.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
            var out = cv.toDataURL("image/png");
            try { localStorage.setItem(LOGO_KEY, out); } catch (e) { toast("Image too large to save."); return; }
            applyImg(out); toast("Logo updated");
          };
          img.src = reader.result;
        };
        reader.readAsDataURL(f);
      });
    }
    var rm = $("#logoRemove");
    if (rm) rm.addEventListener("click", function () {
      try { localStorage.removeItem(LOGO_KEY); } catch (e) {}
      applyImg(null); toast("Reset to initials");
    });

    Array.prototype.forEach.call(menu.querySelectorAll("[data-route]"), function (a) {
      a.addEventListener("click", function () { setOpen(false); location.hash = a.getAttribute("data-route"); });
    });
    var billing = $("#billingLink");
    if (billing) billing.addEventListener("click", function () { setOpen(false); location.hash = "accounts"; });

    var ownerLink = $("#ownerLink");
    if (ownerLink && (ctx.role === "owner" || can("workspace:delete"))) {
      ownerLink.hidden = false;
      // Gated doorway: the server confirms owner access, then forwards to the
      // single clean console URL (/owner-console). Non-owners get a 404 here.
      ownerLink.addEventListener("click", function () { location.href = "/api/owner/enter"; });
    }

    // Portal switch (owner/admin only): jump between the Admin and Recruiter
    // portals. Opens in a new tab so both stay live at once on one login, this
    // is how the owner edits/previews both side by side. Real recruiters never
    // see this group (they only have the Recruiter Portal).
    var switchGroup = $("#portalSwitch");
    if (switchGroup && ctx.role !== "member") {
      switchGroup.hidden = false;
      var openAdmin = $("#openAdminPortal");
      var openRecruiter = $("#openRecruiterPortal");
      if (openAdmin) openAdmin.addEventListener("click", function () { window.open("/admin", "ros-admin"); });
      // Pick WHICH recruiter to dive into (view-as), no password needed.
      if (openRecruiter) openRecruiter.addEventListener("click", function () { setOpen(false); openRecruiterPicker(); });
    }
    var so = $("#acctSignOut");
    if (so) so.addEventListener("click", signOut);

    // Appearance: light/dark theme toggle. Persists + applies to <html> (the
    // pre-paint script in command.html sets it on load so there's no flash).
    var themeSeg = $("#themeSeg");
    if (themeSeg) {
      var applyTheme = function (t) {
        t = (t === "light") ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", t);
        try { localStorage.setItem("ros_theme", t); } catch (e) {}
        Array.prototype.forEach.call(themeSeg.querySelectorAll(".ts"), function (b) {
          b.classList.toggle("active", b.getAttribute("data-theme") === t);
        });
      };
      var saved = null; try { saved = localStorage.getItem("ros_theme"); } catch (e) {}
      applyTheme(saved || document.documentElement.getAttribute("data-theme") || "dark");
      Array.prototype.forEach.call(themeSeg.querySelectorAll(".ts"), function (b) {
        b.addEventListener("click", function (e) { e.stopPropagation(); applyTheme(b.getAttribute("data-theme")); });
      });
    }
  })();
})();
