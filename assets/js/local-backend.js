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
      inmarket: inMarketSeed(),
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
      team: { members: [{ userId: "u_local", name: name, role: "owner" }] },
      analytics: analyticsSeed(name)
    };
    return db;
  }

  // Operational analytics for the Command Center dashboard. Split by motion so
  // recruiting measures placements and BD measures job orders. Kept as its own
  // function so the /analytics route can backfill workspaces seeded before this
  // shipped.
  function analyticsSeed(name) {
    name = name || "Jamie Dawson";
    return {
      range: "This week",
      recruiting: {
        kpis: [
          { label: "Targets sourced", value: 142, delta: "+38 this week", dir: "up" },
          { label: "Reply rate", value: "31%", delta: "+12% vs cold", dir: "up" },
          { label: "Meetings booked", value: 14, delta: "+5 this week", dir: "up" },
          { label: "Placements · $84k", value: 3, delta: "best month", dir: "up" }
        ],
        bySignal: [
          { label: "Layoff", pct: 42 }, { label: "Funding", pct: 31 },
          { label: "New exec", pct: 27 }, { label: "Hiring surge", pct: 22 }
        ],
        byChannel: [
          { label: "SMS", pct: 38 }, { label: "Email", pct: 24 },
          { label: "LinkedIn", pct: 19 }, { label: "Phone", pct: 11 }
        ],
        industries: [
          { label: "Fintech", pct: 34 }, { label: "Healthcare", pct: 29 },
          { label: "SaaS", pct: 26 }, { label: "Manufacturing", pct: 18 }
        ],
        funnel: [
          { label: "Sourced", value: 142 }, { label: "Contacted", value: 128 },
          { label: "Replied", value: 40 }, { label: "Meetings", value: 14 },
          { label: "Placements", value: 3 }
        ],
        variants: [
          { name: "Comp benchmark drop", channel: "SMS", sent: 140, reply: 41, meeting: 14 },
          { name: "Layoff empathy open", channel: "Email", sent: 320, reply: 34, meeting: 11 },
          { name: "Mutual connection intro", channel: "LinkedIn", sent: 210, reply: 22, meeting: 7 },
          { name: "Cold value prop", channel: "Email", sent: 180, reply: 18, meeting: 5 }
        ],
        recruiters: [
          { name: name, meetings: 6, replies: 18, wins: 2 },
          { name: "Priya Nair", meetings: 5, replies: 15, wins: 1 },
          { name: "Marco Reyes", meetings: 3, replies: 7, wins: 0 }
        ],
        appointments: [
          { name: "Marco Silva", channel: "SMS", company: "N26", at: "Today 10:15" },
          { name: "Anja Köhler", channel: "LinkedIn", company: "Trade Republic", at: "Today 09:40" },
          { name: "Priya Das", channel: "Email", company: "Charité", at: "Yesterday 16:20" }
        ]
      },
      bd: {
        kpis: [
          { label: "Accounts sourced", value: 86, delta: "+21 this week", dir: "up" },
          { label: "Reply rate", value: "27%", delta: "+9% vs cold", dir: "up" },
          { label: "Meetings booked", value: 11, delta: "+4 this week", dir: "up" },
          { label: "Job orders", value: 7, delta: "+3 this week", dir: "up" }
        ],
        bySignal: [
          { label: "Funding", pct: 38 }, { label: "New exec", pct: 31 },
          { label: "Hiring surge", pct: 26 }, { label: "Layoff", pct: 19 }
        ],
        byChannel: [
          { label: "Email", pct: 29 }, { label: "LinkedIn", pct: 22 },
          { label: "Phone", pct: 17 }, { label: "SMS", pct: 12 }
        ],
        industries: [
          { label: "Fintech", pct: 31 }, { label: "SaaS", pct: 27 },
          { label: "Logistics", pct: 22 }, { label: "Healthcare", pct: 16 }
        ],
        funnel: [
          { label: "Sourced", value: 86 }, { label: "Contacted", value: 79 },
          { label: "Replied", value: 21 }, { label: "Meetings", value: 11 },
          { label: "Job orders", value: 7 }
        ],
        variants: [
          { name: "Funding congrats angle", channel: "Email", sent: 210, reply: 33, meeting: 12 },
          { name: "New-exec mandate hook", channel: "LinkedIn", sent: 150, reply: 26, meeting: 9 },
          { name: "Hiring-surge capacity offer", channel: "Phone", sent: 90, reply: 21, meeting: 8 },
          { name: "Cold agency intro", channel: "Email", sent: 160, reply: 14, meeting: 4 }
        ],
        recruiters: [
          { name: name, meetings: 5, replies: 12, wins: 3 },
          { name: "Sofia Brandt", meetings: 4, replies: 9, wins: 2 },
          { name: "Lukas Mayer", meetings: 2, replies: 5, wins: 1 }
        ],
        appointments: [
          { name: "Daniel Roth", channel: "Phone", company: "Solaris SE", at: "Today 11:05" },
          { name: "Clara Nguyen", channel: "Email", company: "Forto", at: "Today 09:15" },
          { name: "Erik Sjöberg", channel: "LinkedIn", company: "Personio", at: "Yesterday 15:30" }
        ]
      }
    };
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
    if (p === "/analytics") return ok(d.analytics || analyticsSeed(d.user && d.user.name));
    if (p === "/response/list") return ok({ items: d.response });

    // --- In-Market Leads: who is hiring right now (search + promote) ---
    if (p === "/in-market") {
      d.inmarket = d.inmarket || inMarketSeed();
      if (method === "POST" && body && body.action === "promote") {
        var lead = body.lead || {}, mgr = body.manager || null;
        var person = (mgr && mgr.managerName) || lead.buyerName;
        var pros = {
          id: "p_im_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
          fullName: person || (lead.company + " — " + ((mgr && mgr.managerTitle) || "hiring manager")),
          title: (mgr && mgr.managerTitle) || lead.buyerTitle || "",
          company: lead.company,
          companyDomain: lead.domain,
          linkedinUrl: (mgr && mgr.managerLinkedin) || lead.buyerLinkedin,
          category: "in_market",
          status: "queued", dripStage: 0,
          warmth: Math.max(50, Math.round(lead.score || 50))
        };
        d.prospects = d.prospects || [];
        d.prospects.unshift(pros); save(d);
        return ok({ prospect: pros });
      }
      // Default: a market search, filtered by company name OR industry/market.
      var leads = d.inmarket.slice();
      var cn = ((body && body.companyName) || "").toLowerCase().trim();
      var inds = (body && body.industries) || null;
      var q = ((body && body.query) || "").toLowerCase().trim();
      if (cn) {
        var byName = leads.filter(function (l) { return l.company.toLowerCase().indexOf(cn) >= 0; });
        leads = byName.length ? byName : leads;
      } else if (inds && inds.length) {
        var want = inds.map(function (x) { return String(x).toLowerCase(); });
        var byInd = leads.filter(function (l) { return want.indexOf(String(l.industryKey || "").toLowerCase()) >= 0; });
        leads = byInd.length ? byInd : leads;
      } else if (q) {
        var terms = q.split(/\s+/).filter(function (t) { return t.length > 2; });
        var byQ = leads.filter(function (l) {
          var hay = (l.company + " " + l.reason + " " + (l.industry || "") + " " + (l.industryKey || "")).toLowerCase();
          return terms.some(function (t) { return hay.indexOf(t) >= 0; });
        });
        leads = byQ.length ? byQ : leads;
      }
      return ok({ leads: leads, pulled: d.inmarket.length, warnings: [] });
    }

    if (p === "/prospects") {
      d.prospects = d.prospects || [];
      if (method === "POST" && body) {
        if (body.action === "transition") {
          var ph = d.prospects.filter(function (x) { return x.id === body.prospectId; })[0];
          if (!ph) return notFound();
          ph.status = body.status; save(d); return ok({ prospect: ph });
        }
        if (body.action === "enrich") {
          var pe = d.prospects.filter(function (x) { return x.id === body.prospectId; })[0];
          if (!pe) return notFound();
          var hadE = !!pe.email, hadP = !!pe.phone;
          if (!pe.email) pe.email = localEmail(pe.fullName, pe.companyDomain || pe.company);
          if (!pe.phone) pe.phone = localPhone();
          save(d);
          return ok({ prospect: pe, found: { email: !hadE && !!pe.email, phone: !hadP && !!pe.phone } });
        }
        if (body.action === "bulk") { return ok({ added: (body.rows || []).length, deduped: 0 }); }
        if (body.fullName) {
          var np = { id: "p_" + Date.now(), fullName: body.fullName, title: body.title || "", company: body.company || "", companyDomain: body.companyDomain, email: body.email, phone: body.phone, status: "queued", dripStage: 0, category: body.category };
          d.prospects.unshift(np); save(d); return ok({ prospect: np });
        }
      }
      return ok({ prospects: d.prospects });
    }
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

  /* ---------------- In-Market Leads seed + enrichment shims ---------------- */
  // A realistic "who's hiring right now" dataset, each company carrying the open
  // roles and the hiring manager who would own filling them (the deep dive).
  function inMarketSeed() {
    return [
      {
        id: "im1", company: "Verla Health", domain: "verlahealth.com", industry: "Digital health",
        industryKey: "healthcare", headcountBand: "51-200", location: "Boston, MA",
        reason: "Posted 9 engineering roles in 7 days after a $40M Series B — scaling the platform team fast.",
        signalType: "hiring_velocity", score: 91, scoreReasons: ["Series B fit", "9 roles in 7d", "healthcare ICP"],
        buyerName: "Priya Raman", buyerTitle: "VP Engineering", buyerLinkedin: "https://www.linkedin.com/in/example-praman",
        roles: ["Senior Backend Engineer", "Staff Platform Engineer", "Engineering Manager, Data", "Product Designer"],
        hiringManagers: [
          { role: "Senior Backend Engineer", function: "engineering", managerTitle: "VP / Head of Engineering", managerName: "Priya Raman", managerLinkedin: "https://www.linkedin.com/in/example-praman" },
          { role: "Staff Platform Engineer", function: "engineering", managerTitle: "VP / Head of Engineering", managerName: "Priya Raman" },
          { role: "Engineering Manager, Data", function: "data", managerTitle: "Head of Data / Analytics" },
          { role: "Product Designer", function: "design", managerTitle: "Head of Design" }
        ],
        sourceUrl: "https://boards.greenhouse.io/verlahealth"
      },
      {
        id: "im2", company: "Brightwave", domain: "brightwave.io", industry: "Fintech / payments",
        industryKey: "fintech", headcountBand: "201-500", location: "New York, NY",
        reason: "New VP Engineering (ex-Datadog) started 5 weeks ago — typically rebuilds platform teams within 90 days.",
        signalType: "exec_hire", score: 84, scoreReasons: ["New exec <90d", "fintech ICP", "rebuild window"],
        buyerName: "Daniel Cho", buyerTitle: "VP Engineering", buyerLinkedin: "https://www.linkedin.com/in/example-dcho",
        roles: ["Senior Platform Engineer", "Engineering Manager", "Security Engineer", "Account Executive"],
        hiringManagers: [
          { role: "Senior Platform Engineer", function: "engineering", managerTitle: "VP / Head of Engineering", managerName: "Daniel Cho", managerLinkedin: "https://www.linkedin.com/in/example-dcho" },
          { role: "Engineering Manager", function: "engineering", managerTitle: "VP / Head of Engineering", managerName: "Daniel Cho" },
          { role: "Security Engineer", function: "engineering", managerTitle: "VP / Head of Engineering", managerName: "Daniel Cho" },
          { role: "Account Executive", function: "sales", managerTitle: "VP Sales / Revenue" }
        ],
        sourceUrl: "https://jobs.lever.co/brightwave"
      },
      {
        id: "im3", company: "Northwind Robotics", domain: "northwindrobotics.com", industry: "Industrial automation",
        industryKey: "manufacturing", headcountBand: "51-200", location: "Detroit, MI",
        reason: "Opened a second facility and posted 6 controls + mechanical roles — greenfield local team to build.",
        signalType: "office_expansion", score: 76, scoreReasons: ["Expansion", "6 roles", "greenfield team"],
        buyerName: null, buyerTitle: null, buyerLinkedin: null,
        roles: ["Controls Engineer", "Mechanical Engineer", "Manufacturing Operations Manager", "Supply Chain Analyst"],
        hiringManagers: [
          { role: "Controls Engineer", function: "engineering", managerTitle: "VP / Head of Engineering" },
          { role: "Mechanical Engineer", function: "engineering", managerTitle: "VP / Head of Engineering" },
          { role: "Manufacturing Operations Manager", function: "operations", managerTitle: "VP / Head of Operations" },
          { role: "Supply Chain Analyst", function: "operations", managerTitle: "VP / Head of Operations" }
        ],
        sourceUrl: "https://northwindrobotics.com/careers"
      },
      {
        id: "im4", company: "Lumen Retail", domain: "lumenretail.com", industry: "Retail / eCommerce",
        industryKey: "Retail / eCommerce", headcountBand: "501-1000", location: "Austin, TX",
        reason: "Reposted a Head of Growth role twice in 30 days — struggling to fill a senior GTM seat.",
        signalType: "job_repost", score: 72, scoreReasons: ["Reposted role", "senior GTM", "fill pain"],
        buyerName: "Mara Lindgren", buyerTitle: "CMO", buyerLinkedin: "https://www.linkedin.com/in/example-mlindgren",
        roles: ["Head of Growth", "Lifecycle Marketing Manager", "Senior Data Analyst"],
        hiringManagers: [
          { role: "Head of Growth", function: "marketing", managerTitle: "Head of Marketing / CMO", managerName: "Mara Lindgren", managerLinkedin: "https://www.linkedin.com/in/example-mlindgren" },
          { role: "Lifecycle Marketing Manager", function: "marketing", managerTitle: "Head of Marketing / CMO", managerName: "Mara Lindgren" },
          { role: "Senior Data Analyst", function: "data", managerTitle: "Head of Data / Analytics" }
        ],
        sourceUrl: "https://boards.greenhouse.io/lumenretail"
      },
      {
        id: "im5", company: "Cumulus Logistics", domain: "cumuluslogistics.com", industry: "Logistics / supply chain",
        industryKey: "Logistics / Supply Chain", headcountBand: "201-500", location: "Chicago, IL",
        reason: "Won a large 3PL contract — staffing up operations and engineering to deliver on a deadline.",
        signalType: "grant_or_contract", score: 69, scoreReasons: ["Contract win", "deadline staffing"],
        buyerName: "Tom Becker", buyerTitle: "Head of Operations", buyerLinkedin: "https://www.linkedin.com/in/example-tbecker",
        roles: ["Operations Manager", "Logistics Engineer", "Backend Engineer"],
        hiringManagers: [
          { role: "Operations Manager", function: "operations", managerTitle: "VP / Head of Operations", managerName: "Tom Becker", managerLinkedin: "https://www.linkedin.com/in/example-tbecker" },
          { role: "Logistics Engineer", function: "engineering", managerTitle: "VP / Head of Engineering" },
          { role: "Backend Engineer", function: "engineering", managerTitle: "VP / Head of Engineering" }
        ],
        sourceUrl: "https://cumuluslogistics.com/jobs"
      },
      {
        id: "im6", company: "Atlas Cloud", domain: "atlascloud.dev", industry: "Technology / SaaS",
        industryKey: "Technology / SaaS", headcountBand: "51-200", location: "Remote (US)",
        reason: "Hiring surge: 12 open roles across engineering and product after launching a new platform tier.",
        signalType: "hiring_velocity", score: 88, scoreReasons: ["Hiring surge", "SaaS ICP", "12 roles"],
        buyerName: "Sofia Alvarez", buyerTitle: "Head of Engineering", buyerLinkedin: "https://www.linkedin.com/in/example-salvarez",
        roles: ["Senior Full-Stack Engineer", "DevOps Engineer", "Product Manager", "Engineering Manager"],
        hiringManagers: [
          { role: "Senior Full-Stack Engineer", function: "engineering", managerTitle: "VP / Head of Engineering", managerName: "Sofia Alvarez", managerLinkedin: "https://www.linkedin.com/in/example-salvarez" },
          { role: "DevOps Engineer", function: "engineering", managerTitle: "VP / Head of Engineering", managerName: "Sofia Alvarez" },
          { role: "Product Manager", function: "product", managerTitle: "Head of Product / CPO" },
          { role: "Engineering Manager", function: "engineering", managerTitle: "VP / Head of Engineering", managerName: "Sofia Alvarez" }
        ],
        sourceUrl: "https://jobs.ashbyhq.com/atlascloud"
      },
      {
        id: "im7", company: "Solara Energy", domain: "solaraenergy.com", industry: "Renewable energy",
        industryKey: "Energy", headcountBand: "201-500", location: "Denver, CO",
        reason: "Entered two new states this quarter — building regional sales and field-ops teams from scratch.",
        signalType: "market_entry", score: 67, scoreReasons: ["New market", "regional build-out"],
        buyerName: "Grace Okafor", buyerTitle: "VP Sales", buyerLinkedin: "https://www.linkedin.com/in/example-gokafor",
        roles: ["Regional Sales Manager", "Field Operations Lead", "Solar Project Engineer"],
        hiringManagers: [
          { role: "Regional Sales Manager", function: "sales", managerTitle: "VP Sales / Revenue", managerName: "Grace Okafor", managerLinkedin: "https://www.linkedin.com/in/example-gokafor" },
          { role: "Field Operations Lead", function: "operations", managerTitle: "VP / Head of Operations" },
          { role: "Solar Project Engineer", function: "engineering", managerTitle: "VP / Head of Engineering" }
        ],
        sourceUrl: "https://solaraenergy.com/careers"
      },
      {
        id: "im8", company: "Meridian Bank", domain: "meridianbank.com", industry: "Fintech / banking",
        industryKey: "fintech", headcountBand: "1001-5000", location: "Charlotte, NC",
        reason: "S-1 filed last week — public-company readiness is driving aggressive finance, legal, and risk hiring.",
        signalType: "ipo_or_s1", score: 79, scoreReasons: ["IPO/S-1", "compliance hiring", "fintech ICP"],
        buyerName: "Henry Walsh", buyerTitle: "CFO", buyerLinkedin: "https://www.linkedin.com/in/example-hwalsh",
        roles: ["Senior Financial Analyst", "Compliance Counsel", "Risk Manager", "Backend Engineer"],
        hiringManagers: [
          { role: "Senior Financial Analyst", function: "finance", managerTitle: "VP Finance / CFO", managerName: "Henry Walsh", managerLinkedin: "https://www.linkedin.com/in/example-hwalsh" },
          { role: "Compliance Counsel", function: "legal", managerTitle: "General Counsel" },
          { role: "Risk Manager", function: "operations", managerTitle: "VP / Head of Operations" },
          { role: "Backend Engineer", function: "engineering", managerTitle: "VP / Head of Engineering" }
        ],
        sourceUrl: "https://www.sec.gov/cgi-bin/browse-edgar"
      }
    ];
  }

  // Synthesize a plausible work email + phone for the demo's enrichment step.
  function localEmail(name, domainOrCompany) {
    var parts = String(name || "").toLowerCase().trim().split(/\s+/);
    var dom = String(domainOrCompany || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
    if (!dom || dom.indexOf(".") < 0) dom = (String(domainOrCompany || "company").toLowerCase().replace(/[^a-z0-9]/g, "") || "company") + ".com";
    var local = parts.length >= 2 ? (parts[0][0] + parts[parts.length - 1]) : (parts[0] || "contact");
    return local.replace(/[^a-z0-9.]/g, "") + "@" + dom;
  }
  function localPhone() {
    return "+1 (415) " + String(200 + Math.floor(Math.random() * 799)) + "-" + String(1000 + Math.floor(Math.random() * 8999));
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
