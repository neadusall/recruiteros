/* ============================================================
   RecruitersOS · Campaign Builder (interactive, standalone)
   Forefront SEARCH (by industry or company) -> pulls hundreds of
   prospects (hiring manager + company + signal) -> refine -> review.
   Mirrors integration/lib/signals (freeSources -> filters ->
   campaignBuilder) but generates a large client-side pool so the
   search returns real volume with no backend.
   ============================================================ */
(function () {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
  const rnd = (a) => a[Math.floor(Math.random() * a.length)];
  const rint = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

  /* ---- inline stroke icons (replace emoji glyphs) ---- */
  const icn = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em;vertical-align:-0.125em">' + p + '</svg>';
  const ICON = {
    dollar: icn('<line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
    trendUp: icn('<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>'),
    user: icn('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
    globe: icn('<circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a15 15 0 0 1 4 9 15 15 0 0 1-4 9 15 15 0 0 1-4-9 15 15 0 0 1 4-9z"/>'),
    trendDown: icn('<polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/>'),
    compass: icn('<circle cx="12" cy="12" r="9"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>'),
    activity: icn('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>'),
    search: icn('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  };

  /* ---- signal types grouped by category (mirror registry.publicCategories) ---- */
  const SIGNAL_CATALOG = [
    { category: "Capital & growth", motion: "business_dev", ic: ICON.dollar, types: [
      { type: "funding_round", label: "Funding round", why: "New capital, new headcount, budget to fill it" },
      { type: "ipo_or_s1", label: "IPO / S-1", why: "Public-company readiness, aggressive hiring" },
      { type: "acquisition", label: "Acquisition", why: "Integration hiring + retention churn" },
      { type: "grant_or_contract", label: "Grant / contract win", why: "Must staff up to deliver" },
    ] },
    { category: "Hiring intent", motion: "business_dev", ic: ICON.trendUp, types: [
      { type: "hiring_velocity", label: "Hiring surge", why: "A team stretched past capacity" },
      { type: "job_repost", label: "Role reposted", why: "Struggling to fill, warm for help" },
      { type: "job_posting", label: "New job posting", why: "A role is open right now" },
    ] },
    { category: "Leadership change", motion: "business_dev", ic: ICON.user, types: [
      { type: "exec_hire", label: "New executive", why: "Rebuilds their org within 90 days" },
      { type: "department_head_change", label: "New function lead", why: "Kicks off a team build-out" },
    ] },
    { category: "Footprint & strategy", motion: "business_dev", ic: ICON.globe, types: [
      { type: "office_expansion", label: "Expansion", why: "Greenfield local team to build" },
      { type: "market_entry", label: "New market", why: "Needs people who know the market" },
      { type: "product_launch", label: "Product launch", why: "A team to build and sell it" },
    ] },
    { category: "Contraction", motion: "recruiting", ic: ICON.trendDown, types: [
      { type: "layoff", label: "Layoffs", why: "Great talent hits the market in batches" },
      { type: "warn_notice", label: "WARN notice", why: "Dated, named, precise releases" },
    ] },
    { category: "Talent availability", motion: "recruiting", ic: ICON.compass, types: [
      { type: "open_to_work", label: "Open to work", why: "The warmest candidate signal" },
      { type: "tenure_milestone", label: "Tenure milestone", why: "When people quietly start looking" },
      { type: "employer_distress", label: "Employer distress", why: "Their employer hit turbulence" },
    ] },
  ];
  const typesForMotion = (m) => SIGNAL_CATALOG.filter(c => c.motion === m).flatMap(c => c.types.map(t => t.type));

  /* ---- generator banks ---- */
  const ROOTS = ["North","Bright","Vela","Quanta","Cobalt","Lumen","Apex","Solis","Drift","Marlin","Nimbus","Vertex","Helio","Orbit","Cinder","Forge","Vantage","Pinnacle","Aria","Zephyr","Onyx","Juniper","Slate","Tessera","Cardinal","Beacon","Halcyon","Ember","Sable","Lattice","Fathom","Kestrel","Aether","Meridian","Stride","Cascade","Polaris","Verde","Lyra","Atlas","Cobble","Sienna","Torch","Glade","Harbor","Crest","Anchor","Bloom","Pivot","Nova","Sol","Terra","Vireo","Wren","Cypress","Dune","Echo","Flint","Gale","Haven"];
  const MODS = ["", "", "", "io", "ly", "X", "HQ", "One", "Labs"];
  function suffixesFor(ind) {
    const k = ind.toLowerCase();
    if (/fintech|bank|payment|lend|capital|financ|insur|trad|crypto/.test(k)) return ["Pay","Capital","Bank","Financial","Ledger","Fund","Credit","Wallet"];
    if (/health|bio|pharma|medical|clinic|care|genom|wellness/.test(k)) return ["Health","Bio","Care","Med","Clinic","Therapeutics","Labs","Genomics"];
    if (/\bai\b|machine learning|intelligence|data|analytic|robot/.test(k)) return ["AI","Labs","Intelligence","Neural","Data","Analytics","Robotics","Compute"];
    if (/secur|cyber/.test(k)) return ["Security","Defense","Shield","Sec","Guard"];
    if (/energy|solar|wind|climate|clean|carbon|battery/.test(k)) return ["Energy","Power","Grid","Solar","Climate","Volt"];
    if (/logist|supply|freight|transport|mobility|fleet/.test(k)) return ["Logistics","Freight","Mobility","Cargo","Transit"];
    if (/real estate|prop|construct/.test(k)) return ["Properties","Realty","Build","Spaces","Homes"];
    if (/retail|commerce|consumer|fashion|food|beverage|cpg/.test(k)) return ["Goods","Market","Shop","Brands","Foods","Supply"];
    if (/edu|learn|tutor/.test(k)) return ["Learn","Academy","Ed","Campus","Scholar"];
    if (/game|gaming|media|entertain|music|film/.test(k)) return ["Studios","Games","Media","Play","Pictures"];
    if (/saas|software|cloud|platform|developer|api/.test(k)) return ["Labs","Cloud","Software","Systems","Stack","App","Platform"];
    return ["Labs","Systems","Works","Technologies","Group","Networks","Global","Solutions","Co"];
  }

  const ROLES = {
    engineering: ["VP of Engineering","Head of Engineering","Director of Engineering","Engineering Manager","Principal Engineer","Staff Software Engineer","Senior Backend Engineer","CTO"],
    product: ["VP of Product","Head of Product","Director of Product","Group Product Manager","Senior Product Manager","CPO"],
    data: ["VP of Data","Head of Data","Director of Data Science","Analytics Lead","Staff Data Scientist","Senior Data Engineer"],
    design: ["Head of Design","Design Director","Principal Designer","Senior Product Designer","UX Lead"],
    sales: ["VP of Sales","Head of Sales","Sales Director","Regional Sales Manager","Senior Account Executive","CRO"],
    marketing: ["VP of Marketing","Head of Growth","Marketing Director","Demand Gen Lead","CMO"],
    operations: ["VP of Operations","Head of Ops","Operations Director","Senior Program Manager","COO"],
    people_hr: ["VP of People","Head of Talent","Director of Recruiting","Talent Acquisition Lead","CHRO"],
    executive: ["CEO","Founder","President","Chief of Staff"],
  };
  const FUNCS = Object.keys(ROLES);
  const CITIES = ["San Francisco, US","New York, US","Austin, US","Boston, US","Seattle, US","Denver, US","Chicago, US","Atlanta, US","Los Angeles, US","Miami, US","Remote, US","London, UK","Berlin, DE","Amsterdam, NL","Paris, FR","Dublin, IE","Toronto, CA","Remote, EU","Singapore","Sydney, AU","Bengaluru, IN","Tel Aviv, IL"];
  const FIRST = ["Anja","Marco","Lena","Tomas","Yuki","Priya","Oskar","Clara","Diego","Sara","Liam","Noah","Maya","Ivan","Zoe","Omar","Hana","Leo","Nina","Raj","Eva","Paul","Mia","Sam","Aisha","Ben","Lucia","Theo","Ada","Kofi","Ravi","Elsa","Jon","Tara","Cole","Iris","Dev","Nora","Ace","Vera"];
  const LAST = ["Kohler","Silva","Dietrich","Berg","Tanaka","Nair","Wendt","Moreau","Rossi","Park","Novak","Haas","Mehta","Costa","Lund","Reyes","Adler","Frost","Cruz","Patel","Bauer","Klein","Okafor","Singh","Romano","Vance","Marsh","Doyle","Quinn","Ferro","Mraz","Dolan","Ibarra","Sato","Weiss","Lowe","Grant","Hale","Boon","Vega"];

  const SCORE_BASE = { funding_round:82, ipo_or_s1:78, acquisition:70, grant_or_contract:74, hiring_velocity:88, job_repost:80, job_posting:72, exec_hire:80, department_head_change:74, office_expansion:66, market_entry:62, product_launch:60, layoff:85, warn_notice:90, open_to_work:90, tenure_milestone:58, employer_distress:70 };

  /* ---- name makers ---- */
  const usedCo = new Set(), usedPp = new Set();
  function makeCompany(ind) {
    for (let i = 0; i < 12; i++) {
      const n = rnd(ROOTS) + (Math.random() < .5 ? "" : rnd(MODS)) + (Math.random() < .35 ? "" : " " + rnd(suffixesFor(ind)));
      if (!usedCo.has(n)) { usedCo.add(n); return n.trim(); }
    }
    return rnd(ROOTS) + rint(1, 999);
  }
  function makePerson() {
    for (let i = 0; i < 12; i++) { const n = rnd(FIRST) + " " + rnd(LAST); if (!usedPp.has(n)) { usedPp.add(n); return n; } }
    return rnd(FIRST) + " " + rnd(LAST) + " " + rint(1, 99);
  }

  /* ---- title intelligence (mirror filters.ts) ---- */
  const SENIORITY_ORDER = ["intern","junior","mid","senior","lead","manager","director","vp","c_level","founder"];
  function classifyTitle(raw) {
    const t = (raw || "").toLowerCase();
    const fn = /engineer|developer|devops|platform|swe|cto/.test(t) ? "engineering"
      : /product/.test(t) ? "product" : /data|scientist|analytics/.test(t) ? "data"
      : /design|ux|ui/.test(t) ? "design" : /sales|account executive|revenue|cro/.test(t) ? "sales"
      : /market|growth|cmo/.test(t) ? "marketing" : /recruit|talent|people|hr|chro/.test(t) ? "people_hr"
      : /ops|operation|program|coo/.test(t) ? "operations"
      : /ceo|chief|founder|president/.test(t) ? "executive" : "other";
    const sen = /founder/.test(t) ? "founder" : /chief|cto|ceo|cfo|cmo|coo|cro|cpo|chro/.test(t) ? "c_level"
      : /\bvp\b|vice president/.test(t) ? "vp" : /director|head of/.test(t) ? "director"
      : /manager/.test(t) ? "manager" : /lead|principal|staff/.test(t) ? "lead"
      : /senior|sr\.?/.test(t) ? "senior" : "mid";
    return { function: fn, seniority: sen, isDecisionMaker: ["manager","director","vp","c_level","founder"].includes(sen) };
  }

  /* ---- the pool generator: hundreds-to-thousands of prospects per industry ---- */
  const PER_INDUSTRY = 850;   // base volume per industry (jittered per run)
  function genEntity(industry, motion) {
    const fn = rnd(FUNCS.filter(f => f !== "executive").concat(["engineering","sales","product"])); // weight common funcs
    const roles = ROLES[fn];
    // weight toward decision-maker roles (front of the list)
    const role = roles[Math.min(roles.length - 1, Math.floor(Math.abs(gauss()) * 3))] || rnd(roles);
    const types = typesForMotion(motion);
    const type = rnd(types);
    const company = makeCompany(industry);
    const person = makePerson();
    const city = rnd(CITIES);
    const ev = { roleTitle: role, location: city, function: fn, remote: /remote/i.test(city) };
    if (type === "funding_round") { ev.amountUsd = rint(3, 180) * 1e6; ev.stage = rnd(["seed","series_a","series_b","series_c"]); }
    if (type === "hiring_velocity") ev.rolesPosted = rint(3, 18);
    if (type === "grant_or_contract") ev.amountUsd = rint(2, 60) * 1e6;
    if (type === "exec_hire" || type === "department_head_change") ev.title = role;
    if (type === "layoff") { ev.reductionPct = rint(8, 45); }
    if (type === "warn_notice") { ev.affectedCount = rint(30, 600); ev.effectiveDate = "2026-0" + rint(6, 9) + "-15"; }
    if (type === "office_expansion" || type === "market_entry") ev.market = city;
    const score = Math.max(58, Math.min(98, (SCORE_BASE[type] || 70) + rint(-8, 12)));
    return { type, motion, evidence: ev, person: { name: person, title: role }, company: { name: company, industry: industry, location: city }, score: { value: score } };
  }
  // crude gaussian-ish for DM weighting
  function gauss() { return (Math.random() + Math.random() + Math.random()) / 3 - 0.5; }

  function generatePool() {
    // Prefer the REAL harvested database (public ATS boards) when available
    // and we're in the business-development motion it covers.
    if (REAL.db && state.motion === "business_dev") return poolFromReal();
    usedCo.clear(); usedPp.clear();
    const pool = [];
    if (state.mode === "company" && state.companies.size) {
      [...state.companies].forEach(co => {
        const ind = "Selected";
        const n = rint(4, 9);
        for (let i = 0; i < n; i++) { const e = genEntity(ind, state.motion); e.company.name = co; pool.push(e); }
      });
    } else {
      const inds = state.industries.size ? [...state.industries] : ["SaaS", "Fintech", "Healthcare", "AI & Machine Learning"];
      inds.forEach(ind => { const n = PER_INDUSTRY + rint(-150, 350); for (let i = 0; i < n; i++) pool.push(genEntity(ind, state.motion)); });
    }
    return pool;
  }

  /* ---- REAL data: expand harvested companies into per-role prospects ---- */
  const REAL = { db: null };
  function poolFromReal() {
    let companies = REAL.db.signals.slice();
    if (state.mode === "company" && state.companies.size) {
      const want = [...state.companies].map(c => c.toLowerCase());
      companies = companies.filter(s => want.some(w => s.company.toLowerCase().includes(w)));
    } else if (state.industries.size) {
      companies = companies.filter(s => state.industries.has(s.industry));
    }
    const pool = [];
    companies.forEach(s => {
      const roles = (s.sampleRoles && s.sampleRoles.length) ? s.sampleRoles : [{ title: "Open roles", function: "other", location: (s.locations || [])[0] }];
      roles.forEach(r => {
        pool.push({
          type: s.type, motion: "business_dev", real: true, ats: s.ats,
          evidence: { roleTitle: r.title, location: r.location || (s.locations || [])[0] || "Multiple", function: r.function, applyUrl: r.url, rolesPosted: s.rolesOpen },
          person: { name: s.company, title: r.title },     // contact (hiring manager) revealed on enrichment
          company: { name: s.company, industry: s.industry, location: r.location },
          score: { value: s.score },
        });
      });
    });
    return pool;
  }

  /* ---- state ---- */
  const state = { step: 1, mode: "industry", motion: "business_dev",
    signalTypes: new Set(typesForMotion("business_dev")),
    industries: new Set(), companies: new Set(),
    functions: new Set(), minSeniority: "", dmOnly: true, wantPhone: false,
    pool: [], draft: null };

  /* ---- forefront search: combobox ---- */
  const searchInput = $("#searchInput"), searchDrop = $("#searchDrop");
  // Full grouped dropdown: every industry, grouped by sector, multi-select,
  // with "+ all" to target an entire sector at once. Stays open while picking.
  function renderDrop(q) {
    if (state.mode === "company") { searchDrop.classList.remove("open"); return; }
    const all = window.ROS_INDUSTRIES || [];
    const sectors = window.ROS_SECTORS || [];
    const ql = (q || "").trim().toLowerCase();
    const matches = ql ? all.filter(i => i.name.toLowerCase().includes(ql) || i.sector.toLowerCase().includes(ql)) : all;
    if (!matches.length) { searchDrop.innerHTML = `<div class="combo-sec">No matches for "${q}"</div>`; searchDrop.classList.add("open"); return; }
    const bySec = {};
    matches.forEach(m => { (bySec[m.sector] = bySec[m.sector] || []).push(m); });
    let html = "";
    sectors.filter(s => bySec[s]).forEach(sec => {
      html += `<div class="combo-sec">${sec}<span class="sec-all" data-sec="${sec}">+ all (${bySec[sec].length})</span></div>`;
      bySec[sec].forEach(m => {
        const on = state.industries.has(m.name);
        html += `<div class="combo-opt${on ? " sel" : ""}" data-ind="${m.name}"><span>${on ? "✓ " : ""}${m.name}</span></div>`;
      });
    });
    searchDrop.innerHTML = html;
    searchDrop.classList.add("open");
    $$(".combo-opt", searchDrop).forEach(o => o.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const n = o.dataset.ind;
      if (state.industries.has(n)) state.industries.delete(n); else state.industries.add(n);
      renderSearchChips(); renderDrop(searchInput.value);   // keep open, reflect selection
    }));
    $$(".sec-all", searchDrop).forEach(s => s.addEventListener("mousedown", (e) => {
      e.preventDefault(); e.stopPropagation();
      (window.ROS_INDUSTRIES || []).filter(i => i.sector === s.dataset.sec).forEach(i => state.industries.add(i.name));
      renderSearchChips(); renderDrop(searchInput.value);
    }));
  }
  function addSelection(val) {
    const v = val.trim(); if (!v) return;
    (state.mode === "company" ? state.companies : state.industries).add(v);
    renderSearchChips();
  }
  function renderSearchChips() {
    const wrap = $("#searchChips"); wrap.innerHTML = "";
    const set = state.mode === "company" ? state.companies : state.industries;
    set.forEach(v => {
      const chip = el("span", "schip", `<b>${v}</b><span class="x" title="remove">✕</span>`);
      chip.querySelector(".x").addEventListener("click", () => { set.delete(v); renderSearchChips(); renderEcho(); });
      wrap.appendChild(chip);
    });
    renderEcho();
  }
  function renderEcho() {
    const echo = $("#searchEcho"); if (!echo) return;
    const set = state.mode === "company" ? state.companies : state.industries;
    echo.innerHTML = set.size ? [...set].map(v => `<span class="chip on">${v}</span>`).join("")
      : `<span class="chip on">${state.mode === "company" ? "all companies" : "popular industries"}</span>`;
  }

  searchInput.addEventListener("input", (e) => renderDrop(e.target.value));
  searchInput.addEventListener("focus", (e) => renderDrop(e.target.value));
  searchInput.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== searchInput) searchDrop.classList.remove("open"); }, 150));
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (state.mode === "company" && searchInput.value.trim()) { addSelection(searchInput.value); searchInput.value = ""; }
      else { const first = $(".combo-opt", searchDrop); if (first) { addSelection(first.dataset.ind); searchInput.value = ""; renderDrop(""); } }
    }
  });
  $$("#searchSeg .seg-btn").forEach(b => b.addEventListener("click", () => {
    $$("#searchSeg .seg-btn").forEach(x => x.classList.toggle("active", x === b));
    state.mode = b.dataset.mode;
    searchInput.placeholder = state.mode === "company"
      ? "Type a company name and press Enter, e.g. Stripe"
      : "Search 250+ industries, e.g. Fintech, Healthcare, AI...";
    renderSearchChips(); searchDrop.classList.remove("open");
  }));
  // "All industries ▾", open the full grouped dropdown without typing
  $("#browseBtn").addEventListener("click", () => {
    if (state.mode === "company") {
      $$("#searchSeg .seg-btn").forEach(x => x.classList.toggle("active", x.dataset.mode === "industry"));
      state.mode = "industry"; renderSearchChips();
    }
    if (searchDrop.classList.contains("open")) { searchDrop.classList.remove("open"); }
    else { searchInput.value = ""; searchInput.focus(); renderDrop(""); }
  });
  $("#pullBtn").addEventListener("click", runSearch);

  function runSearch() {
    state.pool = generatePool();
    state.draft = buildDraft();
    showStep(3);
    toast(state.pool.length + " prospects pulled across " +
      (state.mode === "company" ? state.companies.size + " companies" : (state.industries.size || 4) + " industries"));
  }

  /* ---- step 1: signal-type picker ---- */
  function renderSignalPicker() {
    const g = $("#srcGrid"); g.innerHTML = "";
    SIGNAL_CATALOG.filter(c => c.motion === state.motion).forEach(cat => {
      g.appendChild(el("div", null,
        `<div style="display:flex;align-items:center;gap:8px;margin:14px 0 8px"><span style="font-size:16px">${cat.ic}</span><b style="font-size:14px">${cat.category}</b><span class="free" style="margin-left:auto">always-on</span></div>`));
      const grid = el("div", "src-grid");
      cat.types.forEach(t => {
        const card = el("div", "src" + (state.signalTypes.has(t.type) ? " on" : ""));
        card.innerHTML = `<span class="ic">${ICON.activity}</span><div><b>${t.label}</b><span>${t.why}</span></div>`;
        card.addEventListener("click", () => {
          state.signalTypes.has(t.type) ? state.signalTypes.delete(t.type) : state.signalTypes.add(t.type);
          card.classList.toggle("on");
        });
        grid.appendChild(card);
      });
      g.appendChild(grid);
    });
  }

  /* ---- step 2: chips ---- */
  function renderChips(wrap, items, set) {
    wrap.innerHTML = "";
    items.forEach(i => {
      const c = el("span", "chip" + (set.has(i) ? " on" : ""), i.replace(/_/g, " "));
      c.addEventListener("click", () => { set.has(i) ? set.delete(i) : set.add(i); c.classList.toggle("on"); });
      wrap.appendChild(c);
    });
  }
  function wireToggle(id, key) { $(id).addEventListener("click", () => { state[key] = !state[key]; $(id).classList.toggle("on", state[key]); }); }

  /* ---- build draft (filter the generated pool) ---- */
  function buildDraft() {
    const titleInc = ($("#titleIncludes").value || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    const locs = ($("#locations").value || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    const minSen = $("#minSeniority").value;
    const pulled = state.pool.filter(s => state.signalTypes.has(s.type));
    const matched = pulled.filter(s => {
      if (s.motion !== state.motion) return false;
      const title = s.evidence.roleTitle || s.person.title || "";
      const intel = classifyTitle(title);
      if (state.functions.size && !state.functions.has(intel.function)) return false;
      if (titleInc.length && !titleInc.some(t => title.toLowerCase().includes(t))) return false;
      if (state.dmOnly && !intel.isDecisionMaker) return false;
      if (minSen && SENIORITY_ORDER.indexOf(intel.seniority) < SENIORITY_ORDER.indexOf(minSen)) return false;
      if (locs.length) { const loc = (s.evidence.location || "").toLowerCase(); if (!locs.some(l => loc.includes(l))) return false; }
      return true;
    });
    const targets = matched.map(s => {
      const intel = classifyTitle(s.evidence.roleTitle || s.person.title || "");
      return { name: s.person.name, company: s.company.name, title: s.person.title, function: intel.function,
        seniority: intel.seniority, industry: s.company.industry, location: s.evidence.location,
        score: s.score.value, reason: reasonFor(s), type: s.type, real: !!s.real, ats: s.ats,
        applyUrl: s.evidence.applyUrl, needs: { email: true, phone: state.wantPhone } };
    }).sort((a, b) => b.score - a.score);

    const segCount = {};
    targets.forEach(t => { segCount[t.function] = (segCount[t.function] || 0) + 1; });
    const emails = targets.length, phones = state.wantPhone ? targets.length : 0;
    const cost = { emailsToFind: emails, phonesToFind: phones, estEmail: round(emails * 0.006), estPhone: round(phones * 0.25) };
    cost.total = round(cost.estEmail + cost.estPhone);
    return { pulled: pulled.length, matched: matched.length, targets,
      companies: new Set(targets.map(t => t.company)).size, people: targets.length, segments: segCount, cost };
  }

  function reasonFor(s) {
    const e = s.evidence;
    switch (s.type) {
      case "hiring_velocity": return `${s.company.name} posted ${e.rolesPosted} roles recently`;
      case "funding_round": return `${s.company.name} just raised ${fmtUsd(e.amountUsd)}`;
      case "ipo_or_s1": return `${s.company.name} filed to go public`;
      case "acquisition": return `${s.company.name} is in an acquisition`;
      case "warn_notice": case "layoff": return `${s.company.name} announced a reduction, talent is reachable`;
      case "exec_hire": case "department_head_change": return `${s.company.name} added a new leader rebuilding the team`;
      case "job_repost": return `${s.company.name} reposted the role, struggling to fill`;
      case "office_expansion": return `${s.company.name} is opening ${e.location}`;
      case "market_entry": return `${s.company.name} is entering a new market`;
      case "product_launch": return `${s.company.name} just launched a product`;
      case "grant_or_contract": return `${s.company.name} won ${fmtUsd(e.amountUsd)}, staffing to deliver`;
      case "open_to_work": return `flagged open to work`;
      case "tenure_milestone": return `hit a tenure milestone`;
      case "employer_distress": return `${s.company.name} hit turbulence`;
      default: return `${s.company.name} is hiring`;
    }
  }

  /* ---- review + summary ---- */
  const RENDER_CAP = 200;   // cap DOM rows for speed; full total shown in stats
  function renderReview() {
    const d = state.draft; const list = $("#targetList"); list.innerHTML = "";
    if (!d.targets.length) {
      list.innerHTML = `<div class="empty"><div class="big">${ICON.search}</div><b>No prospects yet</b><p>Search an industry or company above, then loosen the refine filters.</p></div>`;
      return;
    }
    if (d.targets.length > RENDER_CAP) {
      list.appendChild(el("div", null, `<p class="sub" style="margin:0 0 12px">Showing the top ${RENDER_CAP} of <b>${d.targets.length}</b> prospects by signal strength. Refine to narrow, or launch the full set.</p>`));
    }
    d.targets.slice(0, RENDER_CAP).forEach(t => {
      const sc = t.score >= 85 ? "hi" : t.score >= 75 ? "mid" : "lo";
      const card = el("div", "target");
      const line = t.real
        ? `${cap(t.reason)}. Open role: <b>${t.title}</b> (${t.function})${t.location ? " · " + t.location : ""}. Enrich to reveal the hiring manager.`
        : `${cap(t.reason)}, reach <b>${t.name}</b>, ${t.title} at ${t.company}.`;
      card.innerHTML = `<div class="top"><span class="nm">${t.company}</span>
        <span class="badge">${t.title}</span><span class="badge">${(t.industry || "").toString()}</span>
        ${t.real ? `<span class="badge" style="color:#38e0a6;border:1px solid rgba(56,224,166,.4)">● live${t.ats ? " · " + t.ats : ""}</span>` : ""}
        <span class="score ${sc}">${t.score}</span></div>
        <div class="reason">${line}</div>
        <div class="badges"><span class="badge">${t.type}</span><span class="badge">${t.function}</span>
          <span class="badge">${t.location || ""}</span>
          ${t.needs.email ? '<span class="badge need">needs email</span>' : ""}
          ${t.needs.phone ? '<span class="badge need">needs phone</span>' : ""}
          ${t.real && t.applyUrl ? `<a class="badge" href="${t.applyUrl}" target="_blank" rel="noopener" style="text-decoration:none">view role ↗</a>` : ""}</div>`;
      list.appendChild(card);
    });
  }
  function renderSummary() {
    const d = state.draft;
    $("#sPulled").textContent = d ? d.pulled : "-";
    $("#sMatched").textContent = d ? d.matched : "-";
    $("#sTargets").textContent = d ? d.targets.length : "-";
    $("#sCompanies").textContent = d ? d.companies : "-";
    $("#sPeople").textContent = d ? d.people : "-";
    const segWrap = $("#segWrap"); segWrap.innerHTML = "";
    if (d && Object.keys(d.segments).length) {
      segWrap.appendChild(el("div", null, `<div style="font-size:12px;color:var(--text-dim);margin-bottom:4px">Segments</div>`));
      Object.entries(d.segments).sort((a, b) => b[1] - a[1]).forEach(([k, v]) =>
        segWrap.appendChild(el("div", "seg", `<span>${k.replace(/_/g, " ")}</span><b>${v}</b>`)));
    }
    if (d && state.step === 3) {
      $("#costPanel").style.display = "block"; $("#launchBtn").style.display = "block";
      $("#costBig").textContent = "$" + d.cost.total.toFixed(2);
      $("#costBreak").innerHTML = `${d.cost.emailsToFind} emails ~$${d.cost.estEmail.toFixed(2)}` +
        (state.wantPhone ? ` · ${d.cost.phonesToFind} phones ~$${d.cost.estPhone.toFixed(2)}` : "") +
        `<br>cheapest-first waterfall + verify`;
    } else { $("#costPanel").style.display = "none"; $("#launchBtn").style.display = "none"; }
  }

  /* ---- stepper ---- */
  function showStep(n) {
    state.step = n;
    $$(".cb-step").forEach(s => s.style.display = +s.dataset.step === n ? "block" : "none");
    $$("#stepper .step").forEach(s => { const sn = +s.dataset.step; s.classList.toggle("active", sn === n); s.classList.toggle("done", sn < n); });
    $("#backBtn").style.display = n > 1 ? "inline-flex" : "none";
    $("#nextBtn").textContent = n === 1 ? "Next: refine →" : n === 2 ? "Build target list →" : "Rebuild list";
    if (n === 3) { state.draft = buildDraft(); renderReview(); }
    renderSummary();
  }
  $("#nextBtn").addEventListener("click", () => {
    if (!state.pool.length) { runSearch(); return; }
    if (state.step < 3) showStep(state.step + 1);
    else { state.draft = buildDraft(); renderReview(); renderSummary(); toast(state.draft.targets.length + " prospects after refine"); }
  });
  $("#backBtn").addEventListener("click", () => showStep(Math.max(1, state.step - 1)));
  $("#motion").addEventListener("change", e => {
    state.motion = e.target.value;
    state.signalTypes = new Set(typesForMotion(state.motion));
    renderSignalPicker();
    if (state.pool.length) runSearch();
  });
  $("#minSeniority").addEventListener("change", e => { state.minSeniority = e.target.value; });
  $("#launchBtn").addEventListener("click", () => {
    const d = state.draft;
    const btn = $("#launchBtn");
    btn.disabled = true; const restore = btn.textContent; btn.textContent = "Launching…";
    const API = (window.RECRUITEROS_API_BASE || "") + "/api";
    const motion = state.motion === "business_dev" ? "bd" : "recruiting";
    const cid = "camp_" + Date.now().toString(36);
    const term = (state.industries && state.industries.size ? Array.from(state.industries).join(", ") : "") || ($("#searchInput") && $("#searchInput").value) || "Signal";
    const name = term + " · " + (motion === "bd" ? "BD" : "Talent");

    fetch(API + "/campaigns", {
      method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: cid, name: name, motion: motion, status: "active", dailyCap: 25,
        goal: "Reach " + d.targets.length + " signal-matched prospects." }),
    }).then((r) => r.json().then((j) => ({ ok: r.ok, data: j }))).then((res) => {
      if (!res.ok) { toast("Sign in to launch a campaign."); btn.disabled = false; btn.textContent = restore; return; }
      const rows = (d.targets || []).slice(0, 500).map((t) => ({
        campaignId: cid, fullName: t.name, title: t.title, company: t.company, category: t.type,
      }));
      return fetch(API + "/prospects", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bulk", rows: rows }),
      }).then((r) => r.json()).then((pr) => {
        const added = pr && pr.added != null ? pr.added : rows.length;
        toast("Launched " + name + " · " + added + " prospects added. Opening pipeline…");
        setTimeout(() => {
          if (window.top !== window.self) { try { window.top.location.hash = "prospects"; } catch (e) {} }
          else { location.href = "/command#prospects"; }
        }, 1000);
      });
    }).catch(() => { toast("Could not reach the server."); btn.disabled = false; btn.textContent = restore; });
  });

  /* ---- toast ---- */
  let tT;
  function toast(msg) {
    let t = $("#cbToast");
    if (!t) { t = el("div", "toast"); t.id = "cbToast"; document.body.appendChild(t); }
    t.textContent = "✓ " + msg; t.classList.add("show");
    clearTimeout(tT); tT = setTimeout(() => t.classList.remove("show"), 2800);
  }
  function fmtUsd(n) { return n >= 1e9 ? "$" + (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? "$" + (n / 1e6).toFixed(0) + "M" : n >= 1e3 ? "$" + (n / 1e3).toFixed(0) + "k" : "$" + n; }
  function round(n) { return Math.round(n * 100) / 100; }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  /* ---- live-data banner ---- */
  function showLiveBanner() {
    if (!REAL.db) return;
    const hero = document.querySelector(".search-hero");
    if (!hero || document.getElementById("liveBanner")) return;
    const b = el("div", null,
      `<div id="liveBanner" style="display:flex;align-items:center;gap:8px;font-size:13px;color:#38e0a6;font-weight:600;margin:-4px 0 12px">
         <span style="width:8px;height:8px;border-radius:50%;background:#38e0a6;box-shadow:0 0 8px #38e0a6"></span>
         Live database: <b>${REAL.db.companies.toLocaleString()}</b> companies hiring,
         <b>${REAL.db.totalOpenRoles.toLocaleString()}</b> open roles, pulled from public job boards.
       </div>`);
    hero.parentNode.insertBefore(b, hero.nextSibling);
  }

  /* ---- init: load the REAL harvested database, then open full ---- */
  renderSignalPicker();
  renderChips($("#functionChips"), FUNCS, state.functions);
  wireToggle("#dmOnly", "dmOnly");
  wireToggle("#wantPhone", "wantPhone");
  renderSearchChips();

  fetch("assets/data/hiring-signals.json")
    .then((r) => (r.ok ? r.json() : null))
    .then((db) => {
      if (db && db.signals && db.signals.length) {
        REAL.db = db;
        // map real industry tags onto the search list so they're discoverable
        showLiveBanner();
      }
    })
    .catch(() => { /* file:// or offline → synthetic generator is the fallback */ })
    .finally(() => runSearch());  // opens full either way (real DB if loaded, else samples)
})();
