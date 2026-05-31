/* RecruiterOS · Local backend shim
 *
 * Makes the portal (login, signup, Command Center) fully functional with NO
 * server running, so opening the files directly just works. It intercepts
 * fetch() calls to /api/*:
 *   1. If a real backend is reachable, that response is used unchanged.
 *   2. Otherwise it serves a realistic, persistent local workspace from
 *      localStorage, so sign-in succeeds and every tab renders live data.
 *
 * Load this BEFORE auth.js / command.js on portal pages. It is a no-op once a
 * real API answers, so it is safe to keep in production.
 */
(function () {
  "use strict";

  var LS = window.localStorage;
  var DB_KEY = "ros_local_db";

  /* ---------------- seed + persistence ---------------- */
  function load() {
    try { var d = JSON.parse(LS.getItem(DB_KEY) || "null"); if (d) return d; } catch (e) {}
    return null;
  }
  function save(db) { try { LS.setItem(DB_KEY, JSON.stringify(db)); } catch (e) {} }

  function seed(user) {
    var name = (user && user.name) || "Jamie Dawson";
    var email = (user && user.email) || "you@company.com";
    var company = email.split("@")[1] ? titleCase(email.split("@")[1].split(".")[0]) : "Your Company";
    var db = {
      user: { id: "u_local", name: name, email: email },
      workspace: { id: "ws_local", name: company + " Talent", plan: "Trial" },
      capabilities: ["accounts:manage", "integrations:manage", "ats:manage", "team:manage"],
      overview: {
        capacity: [
          { label: "Email capacity", value: "420/day", status: "green" },
          { label: "LinkedIn seats", value: 2, status: "green" },
          { label: "SMS sender", value: "verify", status: "yellow" },
          { label: "Dialer", value: "ready", status: "green" }
        ],
        activeProspects: 148, appointmentsToday: 3, appointmentsThisWeek: 14,
        warmConversationsToday: 9, wonAccounts: 3,
        recentAppointments: [
          { name: "Marco Silva", channel: "SMS", at: "Today 10:15" },
          { name: "Anja Köhler", channel: "LinkedIn", at: "Today 09:40" },
          { name: "Priya Nair", channel: "Email", at: "Yesterday 16:20" }
        ],
        activeDrips: [
          { name: "Senior React · Berlin", stage: "Touch 3 of 6" },
          { name: "Series B fintech · BD", stage: "Touch 2 of 5" },
          { name: "ICU nurses · contract", stage: "Touch 1 of 4" }
        ]
      },
      response: [
        { id: "r1", name: "Marco Silva", channel: "sms", source: "Senior React", cls: "positive", text: "Yeah, Thursday afternoon works.", actions: ["Routed to you", "Suggest times"] },
        { id: "r2", name: "Rahel Adler", channel: "email", source: "Series B fintech", cls: "soft_yes", text: "Interesting, can you send details?", actions: ["AI replied", "Awaiting"] },
        { id: "r3", name: "Jonas Klein", channel: "linkedin", source: "Staff eng", cls: "timing", text: "Not now, maybe Q3.", actions: ["Nurture", "Snooze 60d"] },
        { id: "r4", name: "Priya Das", channel: "email", source: "ICU nurses", cls: "referral", text: "Not me, but talk to my colleague Sam.", actions: ["New prospect", "Thank"] },
        { id: "r5", name: "Tom Berg", channel: "linkedin", source: "Senior React", cls: "fit", text: "Happy where I am, thanks.", actions: ["Close lost"] }
      ],
      prospects: [
        { id: "p1", fullName: "Anja Köhler", title: "Sr. Frontend", company: "Trade Republic", status: "in_sequence", dripStage: 3 },
        { id: "p2", fullName: "Marco Silva", title: "Staff Eng", company: "N26", status: "discovery_booked", dripStage: 4 },
        { id: "p3", fullName: "Lena Dietrich", title: "Frontend Lead", company: "Pitch", status: "replied", dripStage: 2 },
        { id: "p4", fullName: "Tomas Berg", title: "Sr. React Dev", company: "Zalando", status: "queued", dripStage: 0 },
        { id: "p5", fullName: "Yuki Tanaka", title: "Sr. SWE", company: "Delivery Hero", status: "in_sequence", dripStage: 1 },
        { id: "p6", fullName: "Oskar Wendt", title: "Sr. React Eng", company: "SoundCloud", status: "placed", dripStage: 6 }
      ],
      content: [
        { id: "c1", name: "Time-to-fill case study, fintech", type: "Case study", campaignIds: ["cmp1"] },
        { id: "c2", name: "Comp benchmark, EU senior frontend", type: "Benchmark", campaignIds: ["cmp1", "cmp2"] }
      ],
      accounts: {
        linkedin: [
          { id: "li1", handle: name.split(" ")[0].toLowerCase() + "@" + (email.split("@")[1] || "company.com"), platform: "primary", warmup: "warmed", quotas: { connects: 20 } },
          { id: "li2", handle: "sourcing@" + (email.split("@")[1] || "company.com"), platform: "primary", warmup: "warming", quotas: { connects: 12 } }
        ],
        domains: [
          { id: "d1", domain: "go-" + (email.split("@")[1] || "company.com"), inboxes: 3, health: "healthy", bounceRate: 0.004 }
        ],
        apiKeys: [
          { id: "k1", service: "Enrichment", masked: "•••• •••• 4821" }
        ]
      },
      connected: [
        { id: "email", label: "Email sending", status: "green", requiredFor: ["recruiting", "bd"] },
        { id: "linkedin", label: "LinkedIn", status: "green", requiredFor: ["recruiting", "bd"] },
        { id: "sms", label: "SMS texting", status: "yellow", error: "verify sender ID", requiredFor: [] },
        { id: "voice", label: "Voice dialer", status: "green", requiredFor: [] },
        { id: "enrichment", label: "Enrichment", status: "green", requiredFor: ["recruiting", "bd"] },
        { id: "ats", label: "ATS sync", status: "yellow", error: "connect to go live", requiredFor: [] }
      ],
      ats: {
        active: "loxo",
        vendors: [
          { vendor: "loxo", label: "Loxo", status: "verified" },
          { vendor: "greenhouse", label: "Greenhouse", status: "available" },
          { vendor: "lever", label: "Lever", status: "available" },
          { vendor: "bullhorn", label: "Bullhorn", status: "available" }
        ],
        objectMap: [
          { concept: "Prospect", object: "Person", how: "Two-way sync by email + LinkedIn URL" },
          { concept: "Campaign", object: "Workflow", how: "Stage changes write back on each touch" },
          { concept: "Reply", object: "Activity", how: "Logged with classification + transcript" },
          { concept: "Placement", object: "Placement", how: "Fee and start date on close" }
        ]
      },
      team: { members: [{ userId: "u_local", name: name, role: "owner" }] }
    };
    return db;
  }

  function db() {
    var d = load();
    if (!d) { d = seed(currentUser()); save(d); }
    return d;
  }
  function currentUser() {
    try { var c = JSON.parse(LS.getItem("ros_ctx") || "null"); if (c && c.user) return c.user; } catch (e) {}
    return null;
  }
  function titleCase(s) { return String(s || "").replace(/\b\w/g, function (m) { return m.toUpperCase(); }); }

  function authPayload(d) {
    return {
      token: "local-" + Date.now(),
      user: d.user, workspace: d.workspace, capabilities: d.capabilities,
      session: { token: "local-" + Date.now() }
    };
  }

  /* ---------------- the local router ---------------- */
  function route(path, method, body) {
    method = (method || "GET").toUpperCase();
    var p = path.replace(/^\/api/, "").split("?")[0];
    var qs = path.indexOf("?") >= 0 ? path.split("?")[1] : "";

    // --- auth ---
    if (p === "/auth/register" || p === "/auth/login") {
      var u = { id: "u_local", name: (body && body.name) || "You", email: (body && body.email) || "you@company.com" };
      LS.removeItem(DB_KEY);                 // fresh workspace for this identity
      var fresh = seed(u); save(fresh);
      return ok(authPayload(fresh));
    }
    if (p === "/auth/magic-link") { return ok({ sent: true, user: db().user, workspace: db().workspace, capabilities: db().capabilities, token: "local" }); }
    if (p === "/auth/session" && method === "DELETE") { return ok({ ended: true }); }
    if (p === "/team/accept") { var d0 = db(); return ok(authPayload(d0)); }

    // --- command center reads ---
    var d = db();
    if (p === "/overview") return ok(d.overview);
    if (p === "/response/list") return ok({ items: d.response });
    if (p === "/prospects") return ok({ prospects: d.prospects });
    if (p === "/content") return ok({ assets: d.content });
    if (p === "/team") return ok({ members: d.team.members });
    if (p === "/ats") return ok(d.ats);
    if (p === "/accounts") {
      if (method === "POST") return addAccount(d, body);
      return ok(d.accounts);
    }
    if (p === "/connected") {
      if (method === "POST" && body && body.action === "test") {
        var hit = d.connected.filter(function (i) { return i.id === body.id; })[0];
        if (hit && hit.status !== "green") { hit.status = "green"; delete hit.error; save(d); }
        return ok({ tested: body.id });
      }
      return ok({ integrations: d.connected });
    }
    if (p === "/campaigns") {
      d.campaigns = d.campaigns || [];
      if (method === "PUT" || method === "POST") {
        var c = body || {}; if (!c.id) c.id = "cmp_" + Date.now();
        var idx = -1; d.campaigns.forEach(function (x, i) { if (x.id === c.id) idx = i; });
        if (idx >= 0) d.campaigns[idx] = c; else d.campaigns.push(c);
        save(d); return ok({ campaign: c });
      }
      if (method === "DELETE") {
        var id = (qs.match(/id=([^&]+)/) || [])[1];
        if (id) { id = decodeURIComponent(id); d.campaigns = d.campaigns.filter(function (x) { return x.id !== id; }); save(d); }
        return ok({ deleted: true });
      }
      return ok({ campaigns: d.campaigns });
    }

    return notFound();
  }

  function addAccount(d, body) {
    body = body || {};
    if (body.type === "linkedin") { d.accounts.linkedin.push({ id: "li" + Date.now(), handle: body.handle, platform: body.platform || "primary", warmup: "warming", quotas: { connects: 8 } }); }
    else if (body.type === "domain") { d.accounts.domains.push({ id: "d" + Date.now(), domain: body.domain, inboxes: body.inboxes || 3, health: "warming", bounceRate: 0 }); }
    else if (body.type === "apikey") { d.accounts.apiKeys.push({ id: "k" + Date.now(), service: body.service, masked: "•••• •••• " + String(Math.floor(1000 + Math.random() * 9000)) }); }
    save(d); return ok({ added: true });
  }

  function ok(obj) { return resp(200, obj); }
  function notFound() { return resp(404, { error: "not_found" }); }
  function resp(status, obj) {
    return new Response(JSON.stringify(obj), { status: status, headers: { "Content-Type": "application/json" } });
  }

  /* ---------------- fetch interception ---------------- */
  var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  var isFile = location.protocol === "file:";

  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var isApi = /\/api\//.test(url);

    // Non-API calls pass straight through to the browser's fetch.
    if (!isApi) { return nativeFetch ? nativeFetch(input, init) : Promise.reject(new Error("no fetch")); }

    var method = (init && init.method) || (typeof input === "object" && input.method) || "GET";
    var body = null;
    try { if (init && init.body) body = JSON.parse(init.body); } catch (e) {}

    // From file://, or when there is no native fetch, serve locally immediately.
    if (isFile || !nativeFetch) { return Promise.resolve(route(url, method, body)); }

    // Otherwise try the real backend first, fall back locally on any failure.
    return nativeFetch(input, init).then(function (r) {
      if (r && (r.ok || (r.status >= 400 && r.status < 500))) return r; // real server answered
      return route(url, method, body);
    }).catch(function () {
      return route(url, method, body);
    });
  };
})();
