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
      outreach: { enrichmentEnabled: true, jobSearchEnabled: true, creditsIncluded: 2000, creditsUsed: 420 },
      sequences: [
        {
          id: "seq_demo1", channel: "email", name: "Job-board lead chase", motion: "recruiting",
          tags: ["job board"],
          variables: [
            { key: "custom_variable1", label: "Role title" },
            { key: "custom_variable2", label: "Candidate A sell-in" }
          ],
          steps: [
            { id: "s1", day: 0, subject: "{{custom_variable1}} — two candidates ready", tracking: true,
              body: "Hi {{first_name}},\n\nNoticed the {{custom_variable1}} role at {{company}}. I'm working with a couple of strong candidates based on the JD:\n\n{{custom_variable2}}\n\nWorth a quick call this week?\n\nBest,\n{{sender_name}}" },
            { id: "s2", day: 3, subject: "Re: {{custom_variable1}}", tracking: true,
              body: "Following up, {{first_name}} — happy to share full profiles if helpful." }
          ],
          createdAt: new Date(Date.now() - 864e5).toISOString(), updatedAt: new Date(Date.now() - 864e5).toISOString()
        }
      ],
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
      // Cost estimate for the push approval gate (mirrors lib/inmarket/launch.ts).
      if (method === "POST" && body && body.action === "estimate") {
        var n = parseInt(body.count, 10) || 0;
        var cap = 0.03;
        // Firm per-person legs (every prospect) — cheapest-first resolution.
        var firm = [
          ["Email — multi-provider waterfall (deep, 80-95%)", 0.006],
          ["Email verification", 0.001],
          ["LinkedIn profile ID + data", 0.005],
          ["Phone classify (route mobile vs landline)", 0.0025],
          ["Phone lookup (cheap-first)", 0.015],
          ["AI personalization (LLM, house voice)", 0.004]
        ];
        var perPersonLines = firm.map(function (l) { return { key: l[0], label: l[0], qty: n, unitUsd: l[1], costUsd: +(n * l[1]).toFixed(4) }; });
        var perPersonUsd = +firm.reduce(function (s, l) { return s + l[1]; }, 0).toFixed(4);
        return ok({ estimate: {
          count: n, perPersonLines: perPersonLines, perPersonUsd: perPersonUsd,
          firmTotalUsd: +(n * perPersonUsd).toFixed(2),
          conditional: [
            { key: "deep_dial", label: "Deep direct-dial reveal (premium fail-safe · Apify + PDL)", unitUsd: 0.1, basis: "per number FOUND when we dial/voicemail — no-find is free; needs the dial cap ≥ $0.10 (now $0.03)" },
            { key: "voicemail", label: "Voicemail / voice-drop (Telnyx AMD → landline/VoIP)", unitUsd: 0.0095, basis: "per HOT-tier prospect (warmth ≥ 80) only" }
          ],
          dialCapUsd: cap,
          notes: [
            "Per-person total is the FIRM cheapest-first resolution charged for every prospect (email waterfall + LinkedIn + cheap phone + AI).",
            "Email is already the blended multi-provider waterfall (80-95%) — its fail-safe is baked into the $0.006.",
            "The DEEP direct-dial reveal is the $0.10 premium fail-safe — it fires only when we actually dial/voicemail a contact, and a no-find lookup is free. It honors RECRUITEROS_MAX_DIAL_USD (now $0.03); raise it to $0.10 to let the reveal run.",
            "Voicemail/voice-drops fire only for HOT-tier prospects (warmth ≥ 80). Email sends use your own warmed inboxes — no per-email charge."
          ]
        } });
      }
      if (method === "POST" && body && body.action === "launch_outreach") {
        return ok({ launch: { triggered: false, queued: true, detail: "demo: prospects flow on next queue poll" } });
      }
      d.inmarket = d.inmarket || inMarketSeed();
      // Stamp demo dates once: vary "posted online" and "added to database" across the seed
      // so the date filter and the per-lead date stamps have something to show.
      if (d.inmarket.length && !d.inmarket[0].postedAt) {
        d.inmarket.forEach(function (l, i) {
          var pd = new Date(); pd.setDate(pd.getDate() - (i % 21)); l.postedAt = pd.toISOString(); l.signalAt = l.signalAt || l.postedAt;
          var ad = new Date(); ad.setDate(ad.getDate() - (i % 6)); l.addedAt = ad.toISOString();
        });
        save(d);
      }
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
      // Default: a market search, filtered by company name OR industry/market,
      // plus optional signal-type filter.
      var leads = d.inmarket.slice();
      var cn = ((body && body.companyName) || "").toLowerCase().trim();
      var inds = (body && body.industries) || null;
      var q = ((body && body.query) || "").toLowerCase().trim();
      var sigTypes = (body && body.signalTypes) || null;
      function indTokens(labels) {
        var stop = { and: 1, or: 1, the: 1, of: 1, services: 1 };
        var out = [];
        labels.forEach(function (l) {
          String(l).toLowerCase().split(/[^a-z0-9]+/).forEach(function (t) { if (t.length >= 3 && !stop[t]) out.push(t); });
        });
        return out;
      }
      if (cn) {
        var byName = leads.filter(function (l) { return l.company.toLowerCase().indexOf(cn) >= 0; });
        leads = byName.length ? byName : leads;
      } else if (inds && inds.length) {
        var toks = indTokens(inds);
        leads = leads.filter(function (l) {
          var hay = (l.company + " " + l.reason + " " + (l.industry || "") + " " + (l.industryKey || "")).toLowerCase();
          return toks.some(function (t) { return hay.indexOf(t) >= 0; });
        });
      } else if (q) {
        var terms = q.split(/\s+/).filter(function (t) { return t.length > 2; });
        var byQ = leads.filter(function (l) {
          var hay = (l.company + " " + l.reason + " " + (l.industry || "") + " " + (l.industryKey || "")).toLowerCase();
          return terms.some(function (t) { return hay.indexOf(t) >= 0; });
        });
        leads = byQ.length ? byQ : leads;
      }
      if (sigTypes && sigTypes.length) {
        var bySig = leads.filter(function (l) { return sigTypes.indexOf(l.signalType) >= 0; });
        leads = bySig.length ? bySig : leads;
      }
      // Date search: only roles posted online within the last N days.
      var pw = body && parseInt(body.postedWithinDays, 10);
      if (pw) {
        var cutoff = Date.now() - pw * 86400000;
        leads = leads.filter(function (l) { var t = Date.parse(l.postedAt || l.signalAt || ""); return !isNaN(t) && t >= cutoff; });
      }
      // Give every company a size reading even if it's a guess (heuristic from open roles).
      leads = leads.map(function (l) {
        if (l.headcountBand) return l;
        var n = (l.roles && l.roles.length) || 0;
        var band = n >= 12 ? "201-500" : n >= 6 ? "51-200" : "11-50";
        return Object.assign({}, l, { headcountBand: band, sizeEstimated: true });
      });
      // Confirmed-only: drop heuristic estimates, keep authoritative sizes.
      if (body && body.confirmedSizeOnly) {
        leads = leads.filter(function (l) { return l.headcountBand && !l.sizeEstimated; });
      }
      // Company-size narrow: only leads whose headcount band is selected.
      var sizes = body && body.headcountBands;
      if (sizes && sizes.length) {
        leads = leads.filter(function (l) { return l.headcountBand && sizes.indexOf(l.headcountBand) >= 0; });
      }
      // Suppress companies already taken into this workspace's Prospects (no dup outreach).
      var taken = {};
      (d.prospects || []).forEach(function (p) { if (p.company) taken[String(p.company).toLowerCase().trim()] = 1; });
      leads = leads.filter(function (l) { return !taken[String(l.company || "").toLowerCase().trim()]; });
      return ok({ leads: leads, pulled: d.inmarket.length, warnings: [], stats: imDemoStats(d) });
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
          var hadE = !!pe.email, hadP = !!pe.phone, fld = body.field;
          if (fld !== "phone" && !pe.email) pe.email = localEmail(pe.fullName, pe.companyDomain || pe.company);
          if (fld !== "email" && !pe.phone) pe.phone = localPhone();
          save(d);
          return ok({ prospect: pe, found: { email: !hadE && !!pe.email, phone: !hadP && !!pe.phone } });
        }
        if (body.action === "bulk-update" && body.ids) {
          var u = {}; body.ids.forEach(function (x) { u[x] = 1; });
          var nu = 0;
          d.prospects.forEach(function (x) {
            if (!u[x.id]) return;
            if (body.status) x.status = body.status;
            if (body.sequenceId !== undefined) { x.sequenceId = body.sequenceId || undefined; x.sequenceName = body.sequenceName || undefined; if (body.sequenceId && !body.status) x.status = "in_sequence"; }
            nu++;
          });
          save(d); return ok({ updated: nu });
        }
        if (body.action === "delete" && body.ids) {
          var del = {}; body.ids.forEach(function (x) { del[x] = 1; });
          var before = d.prospects.length;
          d.prospects = d.prospects.filter(function (x) { return !del[x.id]; });
          save(d); return ok({ deleted: before - d.prospects.length });
        }
        if (body.action === "bulk") { return ok({ added: (body.rows || []).length, deduped: 0 }); }
        if (body.action === "linkedin_search") {
          var people = linkedinSearchSeed(body.limit);
          var newPros = people.map(function (m) {
            return { id: "p_" + Date.now() + "_" + Math.floor(Math.random() * 9999), fullName: m.fullName, title: m.title, headline: m.headline, company: m.company, location: m.location, photoUrl: m.photoUrl, linkedinUrl: m.linkedinUrl, status: "queued", dripStage: 0, category: "linkedin_search", motion: (body.motion === "bd" ? "bd" : "recruiting") };
          });
          d.prospects = newPros.concat(d.prospects); save(d);
          return ok({ added: newPros.length, deduped: 0, found: newPros.length, account: "demo-linkedin" });
        }
        if (body.fullName) {
          var np = { id: "p_" + Date.now(), fullName: body.fullName, title: body.title || "", company: body.company || "", companyDomain: body.companyDomain, email: body.email, phone: body.phone, status: "queued", dripStage: 0, category: body.category, motion: (body.motion === "bd" ? "bd" : "recruiting") };
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
    if (p === "/outreach") {
      d.outreach = d.outreach || { enrichmentEnabled: true, jobSearchEnabled: true, creditsIncluded: 2000, creditsUsed: 420 };
      var mo = (qs.match(/motion=([^&]+)/) || [])[1] || "recruiting";
      if (method === "POST" && body) {
        if (body.action === "toggle-enrichment") d.outreach.enrichmentEnabled = body.on !== false;
        else if (body.action === "toggle-jobsearch") d.outreach.jobSearchEnabled = body.on !== false;
        else if (body.action === "topup-credits") d.outreach.creditsIncluded += Math.max(0, parseInt(body.amount, 10) || 1000);
        save(d);
        return ok(buildOutreach(d, body.motion || mo));
      }
      return ok(buildOutreach(d, decodeURIComponent(mo)));
    }
    if (p === "/ext-token") {
      if (!d.extToken) { d.extToken = "ext_demo_" + Math.random().toString(36).slice(2, 12); save(d); }
      return ok({ token: d.extToken, backendBaseUrl: location.origin + "/api/linkedin" });
    }
    if (p === "/prospect-lists") {
      d.prospectLists = d.prospectLists || [];
      if (method === "PUT" || method === "POST") {
        var pl = body || {}; if (!pl.id) pl.id = "plist_" + Date.now();
        pl.prospectIds = pl.prospectIds || []; pl.updatedAt = new Date().toISOString(); if (!pl.createdAt) pl.createdAt = pl.updatedAt;
        var pli = -1; d.prospectLists.forEach(function (x, i) { if (x.id === pl.id) pli = i; });
        if (pli >= 0) d.prospectLists[pli] = pl; else d.prospectLists.unshift(pl);
        save(d); return ok({ list: pl });
      }
      if (method === "DELETE") {
        var lid = (qs.match(/id=([^&]+)/) || [])[1];
        if (lid) { lid = decodeURIComponent(lid); d.prospectLists = d.prospectLists.filter(function (x) { return x.id !== lid; }); save(d); }
        return ok({ ok: true });
      }
      var lmo = (qs.match(/motion=([^&]+)/) || [])[1];
      var ll = lmo ? d.prospectLists.filter(function (x) { return !x.motion || x.motion === decodeURIComponent(lmo); }) : d.prospectLists;
      return ok({ lists: ll });
    }
    if (p === "/sequences") {
      d.sequences = d.sequences || [];
      if (method === "PUT" || method === "POST") {
        var sq = body || {}; if (!sq.id) sq.id = "seq_" + Date.now();
        sq.steps = sq.steps || []; sq.tags = sq.tags || []; sq.variables = sq.variables || [];
        sq.updatedAt = new Date().toISOString(); if (!sq.createdAt) sq.createdAt = sq.updatedAt;
        var si = -1; d.sequences.forEach(function (x, i) { if (x.id === sq.id) si = i; });
        if (si >= 0) d.sequences[si] = sq; else d.sequences.unshift(sq);
        save(d); return ok({ sequence: sq });
      }
      if (method === "DELETE") {
        var sid = (qs.match(/id=([^&]+)/) || [])[1];
        if (sid) { sid = decodeURIComponent(sid); d.sequences = d.sequences.filter(function (x) { return x.id !== sid; }); save(d); }
        return ok({ ok: true });
      }
      var mo2 = (qs.match(/motion=([^&]+)/) || [])[1];
      var list = mo2 ? d.sequences.filter(function (x) { return x.motion === decodeURIComponent(mo2); }) : d.sequences;
      return ok({ sequences: list });
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

    // --- JD Sourcing (offline demo) -------------------------------------------
    // Mirrors /api/sourcing so the JD Sourcing tab is fully clickable with no
    // server + no API keys. Data is clearly labeled SAMPLE/demo; once the real
    // backend answers, this shim is a no-op (real /api/sourcing wins).
    if (p === "/sourcing") {
      d.sourcingRuns = d.sourcingRuns || [];
      if (method === "GET") return ok({ runs: d.sourcingRuns });
      var act = (body && body.action) || "plan";

      function srcIcp(jd) {
        var t = String(jd || "").toLowerCase();
        var sales = /sales|account executive|revenue|quota|gtm|bookings/.test(t);
        var vp = /\bvp\b|vice president|head of|director|chief|svp/.test(t);
        var east = /east coast|new york|boston|atlanta|nyc|philadelphia|charlotte|d\.?c\.?/.test(t);
        return {
          label: (sales ? "Sales leadership" : "Leadership") + " — demo profile",
          seniority: vp ? "vp" : "director", managesTeam: true,
          titles: sales ? ["VP Sales", "Regional Vice President", "Area Vice President", "Enterprise Sales Director", "Regional Sales Director"]
                        : ["Vice President", "Head of", "Senior Director", "Director"],
          geos: east ? ["New York", "Boston", "Washington DC", "Atlanta", "Philadelphia", "Charlotte", "Miami"]
                     : ["New York", "San Francisco", "Chicago", "Austin", "Remote"],
          remoteOk: true,
          industries: sales ? ["Enterprise SaaS", "Procurement / Source-to-Pay", "Spend management", "Supply chain"] : ["Enterprise software"],
          targetCompanies: sales ? ["Coupa", "Ivalua", "GEP", "SAP Ariba", "Zycus", "Zip", "Tropic", "Icertis"]
                                  : ["(set ANTHROPIC_API_KEY for real company targeting)"],
          sellsTo: sales ? ["CFO", "CPO", "CIO", "COO"] : [],
          verticals: ["Manufacturing", "Public Sector", "Higher Education", "Life Sciences", "Financial Services"],
          mustHave: ["Enterprise SaaS sales leadership", "Team management", "Complex deal cycles"],
          niceToHave: ["Procurement domain", "East Coast network"],
          disqualifiers: ["Individual contributor only", "SMB-only experience"]
        };
      }
      function srcQ(s) { return /\s/.test(s) ? '"' + s + '"' : s; }
      function srcOr(a, c) { a = a.slice(0, c).map(srcQ); return a.length ? "(" + a.join(" OR ") + ")" : ""; }
      function srcG(x) { return "https://www.google.com/search?q=" + encodeURIComponent(x); }
      function srcLi(k) { return "https://www.linkedin.com/search/results/people/?keywords=" + encodeURIComponent(k) + "&origin=GLOBAL_SEARCH_HEADER"; }
      function srcQueries(icp) {
        var tg = srcOr(icp.titles.length ? icp.titles : ["VP Sales"], 4), gg = srcOr(icp.geos, 6), ig = srcOr(icp.industries, 4);
        var lead = icp.titles[0] || "VP Sales", out = [];
        icp.targetCompanies.forEach(function (co) {
          var x = ["site:linkedin.com/in", tg, srcQ(co), gg].filter(Boolean).join(" ");
          out.push({ group: co, label: lead + " @ " + co, xray: x, googleUrl: srcG(x), linkedinUrl: srcLi(co + " " + lead) });
        });
        if (ig) { var xi = ["site:linkedin.com/in", tg, ig, gg].filter(Boolean).join(" "); out.push({ group: "broad: industry", label: lead + " across target industries", xray: xi, googleUrl: srcG(xi), linkedinUrl: srcLi(lead) }); }
        icp.geos.slice(0, 6).forEach(function (g) { var xg = ["site:linkedin.com/in", tg, ig, srcQ(g)].filter(Boolean).join(" "); out.push({ group: "broad: " + g, label: lead + " in " + g, xray: xg, googleUrl: srcG(xg), linkedinUrl: srcLi(lead + " " + g) }); });
        return out;
      }
      function srcCandidates(icp) {
        var F = ["Alex", "Jordan", "Morgan", "Taylor", "Casey", "Riley", "Jamie", "Avery", "Quinn", "Drew", "Cameron", "Reese", "Parker", "Skyler", "Hayden", "Rowan"];
        var L = ["Bennett", "Carter", "Donovan", "Ellis", "Fletcher", "Greer", "Hale", "Ingram", "Jansen", "Keller", "Lawson", "Mercer", "Novak", "Osborne", "Pruitt", "Reyes"];
        var rows = [], n = 0, cos = icp.targetCompanies.length ? icp.targetCompanies : ["Acme"];
        for (var i = 0; i < cos.length; i++) {
          for (var j = 0; j < 2; j++) {
            var nm = F[(i * 2 + j) % F.length] + " " + L[(i * 3 + j) % L.length];
            var ti = icp.titles[(i + j) % icp.titles.length];
            var ge = icp.geos[(i + j) % icp.geos.length];
            rows.push({ fullName: nm + " (sample)", title: ti, company: cos[i], location: ge, linkedinUrl: "https://www.linkedin.com/in/sample-" + (n + 1), fitScore: Math.max(46, 96 - n * 2), fitReasons: ['Title matches "' + ti + '"', "At target company " + cos[i], "In-target geo (" + ge + ")"], sourceGroup: cos[i], provider: "demo" });
            n++;
          }
        }
        return rows.sort(function (a, b) { return b.fitScore - a.fitScore; });
      }

      if (act === "plan") { var ip = srcIcp(body && body.jd); return ok({ icp: ip, queries: srcQueries(ip), note: "Demo preview (offline shim): sample profile + searches. Real parsing uses your Anthropic key; real discovery uses RapidAPI people-search." }); }
      if (act === "run") { var ir = srcIcp(body && body.jd); var cr = srcCandidates(ir); return ok({ icp: ir, queries: srcQueries(ir), candidates: cr, scanned: cr.length * 7, warnings: ["Demo mode (offline): showing " + cr.length + " SAMPLE candidates. Connect RapidAPI people-search + Anthropic to source real people."] }); }
      if (act === "save") {
        var run = { id: (body && body.id) || "srun_" + Date.now(), workspaceId: d.workspace.id, name: (body && body.name) || "Untitled sourcing list", motion: (body && body.motion) || "recruiting", jd: (body && body.jd) || "", icp: (body && body.icp) || {}, queries: (body && body.queries) || [], candidates: (body && body.candidates) || [], warnings: (body && body.warnings) || [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        var ei = -1; d.sourcingRuns.forEach(function (x, k) { if (x.id === run.id) ei = k; });
        if (ei >= 0) d.sourcingRuns[ei] = run; else d.sourcingRuns.unshift(run);
        save(d); return ok({ run: run });
      }
      if (act === "promote") {
        var rp = null; d.sourcingRuns.forEach(function (x) { if (x.id === (body && body.id)) rp = x; });
        if (!rp) return notFound();
        d.prospects = d.prospects || []; d.prospectLists = d.prospectLists || [];
        var added = 0, ids = [];
        (rp.candidates || []).forEach(function (c) {
          if ((body && body.minFit) && c.fitScore < body.minFit) return;
          var pid = "p_src_" + Date.now() + "_" + added;
          d.prospects.unshift({ id: pid, fullName: c.fullName, title: c.title, company: c.company, location: c.location, linkedinUrl: c.linkedinUrl, email: c.email, phone: c.phone, category: rp.name, motion: rp.motion, status: "queued", dripStage: 0, warmth: Math.max(50, c.fitScore || 50) });
          ids.push(pid); added++;
        });
        var listId = "plist_" + Date.now();
        d.prospectLists.unshift({ id: listId, name: rp.name, prospectIds: ids, motion: rp.motion, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        rp.promotedCount = added; rp.promotedListId = listId; save(d);
        return ok({ campaignId: "cmp_src_" + Date.now(), listId: listId, added: added, deduped: 0, name: rp.name });
      }
      if (act === "enrich") {
        var re = null; d.sourcingRuns.forEach(function (x) { if (x.id === (body && body.id)) re = x; });
        if (!re) return notFound();
        var top = Math.min((body && body.top) || 50, (re.candidates || []).length), en = 0;
        for (var z = 0; z < top; z++) { var cc = re.candidates[z]; if (cc && !cc.email) { cc.email = cc.fullName.toLowerCase().replace(/\(sample\)/g, "").replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "") + "@" + (String(cc.company || "company").toLowerCase().replace(/[^a-z0-9]/g, "") || "company") + ".com"; en++; } }
        save(d); return ok({ enriched: en, run: re });
      }
      if (act === "delete") { d.sourcingRuns = d.sourcingRuns.filter(function (x) { return x.id !== (body && body.id); }); save(d); return ok({ ok: true }); }
      return ok({});
    }

    return notFound();
  }

  /* Build the Outreach readiness snapshot the Command Center expects, from the
     local seed (accounts + connected + outreach flags). Mirrors the real
     /api/outreach shape so the static demo behaves identically. */
  function buildOutreach(d, motion) {
    var f = d.outreach;
    var conn = function (id) { return (d.connected || []).filter(function (i) { return i.id === id; })[0] || {}; };
    var locals = ["outreach", "hello", "team", "talent", "intro", "hi", "connect", "reach"];

    // ATS + SMS from the generic connected entries.
    var atsGreen = conn("ats").status === "green";
    var smsI = conn("sms"), smsGreen = smsI.status === "green", smsYellow = smsI.status === "yellow";
    var enGreen = conn("enrichment").status === "green";

    var ats = { connected: atsGreen, label: "ATS (system of record)", state: atsGreen ? "ready" : "action",
      detail: atsGreen ? "Connected — every reply and touch logs to your ATS." : "Not connected. Connect your ATS so prospects, replies, and placements sync automatically." };
    var sms = { connected: smsGreen, label: "SMS (TalTxt)", state: smsGreen ? "ready" : smsYellow ? "warming" : "action",
      detail: smsGreen ? "Connected — post-engagement texts and opt-outs are live." : smsYellow ? "Key added — run a test to verify your TalTxt connection." : "Not connected. Connect TalTxt to add compliant SMS to your sequences." };

    var remaining = Math.max(0, f.creditsIncluded - f.creditsUsed);
    var pct = f.creditsIncluded > 0 ? Math.round((remaining / f.creditsIncluded) * 100) : 0;
    var low = remaining <= Math.max(50, Math.round(f.creditsIncluded * 0.1));
    var enState = !f.enrichmentEnabled ? "off" : remaining <= 0 ? "action" : (low || !enGreen) ? "warming" : "ready";
    var enrichment = { enabled: f.enrichmentEnabled, state: enState, healthy: enGreen,
      credits: { included: f.creditsIncluded, used: f.creditsUsed, remaining: remaining, low: low, pct: pct },
      detail: !f.enrichmentEnabled ? "Off. Turn on the waterfall to auto-find work emails and direct dials for new prospects."
        : remaining <= 0 ? "Out of credits. Top up to keep finding contacts."
        : low ? "Running low — " + remaining.toLocaleString() + " credits left."
        : remaining.toLocaleString() + " of " + f.creditsIncluded.toLocaleString() + " credits available." };

    var jobSearch = { enabled: f.jobSearchEnabled, label: "Job Search", state: f.jobSearchEnabled ? "ready" : "off", healthy: true,
      detail: !f.jobSearchEnabled ? "Off. Turn on Job Search to pull live hiring signals into your campaigns." : "On — live hiring signals feed your daily cadence." };

    // Domains down to the inbox.
    var domList = (d.accounts.domains || []).map(function (x) {
      var n = Math.max(1, x.inboxes || 1), paused = x.health === "blacklisted" || (x.bounceRate || 0) >= 0.02;
      var inboxes = [];
      for (var i = 0; i < n; i++) {
        var st, wp;
        if (paused) { st = "paused"; wp = 0; }
        else if (x.health === "healthy") { st = "warm"; wp = 100; }
        else { var warm = i < Math.ceil(n / 2); st = warm ? "warm" : "warming"; wp = warm ? 100 : Math.min(100, 45 + i * 10); }
        inboxes.push({ email: locals[i % locals.length] + "@" + x.domain, state: st, warmupPct: wp });
      }
      var dstate = paused ? "action" : x.health === "healthy" ? "ready" : "warming";
      return { id: x.id, domain: x.domain, health: x.health, bounceRate: x.bounceRate || 0, state: dstate, inboxes: inboxes };
    });
    var allIn = domList.reduce(function (a, x) { return a.concat(x.inboxes); }, []);
    var warm = allIn.filter(function (i) { return i.state === "warm"; }).length;
    var warming = allIn.filter(function (i) { return i.state === "warming"; }).length;
    var dmState = !domList.length ? "action" : domList.some(function (x) { return x.state === "action"; }) ? "action" : warm > 0 ? (warming > 0 ? "warming" : "ready") : "warming";
    var domains = { total: domList.length, inboxesTotal: allIn.length, inboxesWarm: warm, inboxesWarming: warming, state: dmState, list: domList };

    // LinkedIn accounts.
    var liList = (d.accounts.linkedin || []).map(function (a) {
      var flagged = a.warmup === "flagged", warmed = a.warmup === "warmed";
      var state = flagged ? "action" : warmed ? "ready" : "warming";
      var wp = flagged ? 0 : warmed ? 100 : Math.min(95, Math.round(((a.quotas && a.quotas.connects) || 0) / 20 * 100));
      var issue = flagged ? "Flagged by LinkedIn and paused. Lower daily actions and let it re-warm for a few days before resuming."
        : warmed ? "" : "Warming up — daily limits are ramping automatically. Keep activity gentle until it's green.";
      return { id: a.id, handle: a.handle, channel: "LinkedIn", warmup: a.warmup, warmupPct: wp, state: state,
        limits: { connects: (a.quotas && a.quotas.connects) || 0, dms: (a.quotas && a.quotas.dms) || 25, profileViews: (a.quotas && a.quotas.profileViews) || 40 }, issue: issue };
    });
    var liWarmed = liList.filter(function (a) { return a.warmup === "warmed"; }).length;
    var liFlagged = liList.filter(function (a) { return a.warmup === "flagged"; }).length;
    var liState = !liList.length ? "action" : liFlagged > 0 ? "action" : liWarmed > 0 ? (liWarmed < liList.length ? "warming" : "ready") : "warming";
    var linkedin = { total: liList.length, warmed: liWarmed, flagged: liFlagged, state: liState, list: liList };

    // Pre-flight gate: required = ATS + SMS(recruiting) + enrichment + domains + LinkedIn ready.
    var blocking = [];
    if (!atsGreen) blocking.push("ats");
    if (motion === "recruiting" && !smsGreen) blocking.push("sms");
    if (enState === "action" || enState === "off") blocking.push("enrichment");
    if (dmState === "action") blocking.push("domains");
    if (liState === "action") blocking.push("linkedin");

    return { ats: ats, sms: sms, enrichment: enrichment, jobSearch: jobSearch, domains: domains, linkedin: linkedin,
      preflight: { ok: blocking.length === 0, blocking: blocking } };
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

  // Synthesize a list of LinkedIn search hits for the demo (no contact data yet —
  // the recruiter enriches each prospect's email/phone/cell on demand afterwards).
  function linkedinSearchSeed(limit) {
    var firsts = ["Ava", "Liam", "Maya", "Noah", "Zoe", "Ethan", "Iris", "Owen", "Lena", "Theo", "Nina", "Cole", "Priya", "Marco", "Sara", "Dev"];
    var lasts = ["Bennett", "Castillo", "Okafor", "Nguyen", "Rosales", "Fischer", "Haddad", "Park", "Larsson", "Mehta", "Romano", "Walsh", "Abe", "Costa"];
    var titles = ["VP Engineering", "Head of Talent", "Director of Product", "CTO", "Engineering Manager", "Head of People", "VP Sales", "Chief of Staff"];
    var cos = ["Verla Health", "Brightwave", "Northwind Robotics", "Lumen Retail", "Cumulus Logistics", "Halcyon AI", "Forge Labs", "Meridian Bank"];
    var locs = ["San Francisco, CA", "New York, NY", "Austin, TX", "Remote (US)", "London, UK", "Berlin, DE", "Toronto, CA", "Boston, MA"];
    var n = Math.max(1, Math.min(parseInt(limit, 10) || 12, 500));
    var out = [];
    for (var i = 0; i < n; i++) {
      var f = firsts[i % firsts.length], l = lasts[(i * 3 + Math.floor(i / firsts.length)) % lasts.length];
      var title = titles[i % titles.length], co = cos[(i * 2) % cos.length];
      out.push({
        fullName: f + " " + l,
        title: title, headline: title + " at " + co,
        company: co,
        location: locs[i % locs.length],
        photoUrl: "https://i.pravatar.cc/96?u=" + encodeURIComponent(f + l + i),
        linkedinUrl: "https://www.linkedin.com/in/" + f.toLowerCase() + "-" + l.toLowerCase() + "-" + (i + 1),
      });
    }
    return out;
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
  // Demo accumulation stats for the Hire Signals activity feed.
  function imDemoStats(d) {
    var total = (d.inmarket || []).length;
    var days = [];
    for (var i = 0; i < 5; i++) {
      var dt = new Date(); dt.setDate(dt.getDate() - i);
      days.push({ date: dt.toISOString().slice(0, 10), added: 40 + Math.floor(Math.random() * 90) });
    }
    return { total: total, addedToday: days[0].added, lastAddedAt: new Date().toISOString(), days: days };
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
