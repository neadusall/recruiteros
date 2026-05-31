/* ============================================================
   RecruiterOS · Campaign Builder (interactive, standalone)
   Mirrors integration/lib/signals: freeSources → filters →
   campaignBuilder. Runs entirely client-side on seed signals so
   the free "organize before launch" flow is tangible with no backend.
   ============================================================ */
(function () {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };

  /* ---- signal types grouped by category (mirror registry.publicCategories) ----
     Note: we expose WHAT the signals are, never WHICH sources provide them. ---- */
  const SIGNAL_CATALOG = [
    { category: "Capital & growth", motion: "business_dev", ic: "💰", types: [
      { type: "funding_round", label: "Funding round", why: "New capital, new headcount, budget to fill it" },
      { type: "ipo_or_s1", label: "IPO / S-1", why: "Public-company readiness, aggressive hiring" },
      { type: "acquisition", label: "Acquisition", why: "Integration hiring + retention churn" },
      { type: "grant_or_contract", label: "Grant / contract win", why: "Must staff up to deliver" },
    ] },
    { category: "Hiring intent", motion: "business_dev", ic: "📈", types: [
      { type: "hiring_velocity", label: "Hiring surge", why: "A team stretched past capacity" },
      { type: "job_repost", label: "Role reposted", why: "Struggling to fill, warm for help" },
      { type: "job_posting", label: "New job posting", why: "A role is open right now" },
    ] },
    { category: "Leadership change", motion: "business_dev", ic: "👔", types: [
      { type: "exec_hire", label: "New executive", why: "Rebuilds their org within 90 days" },
      { type: "department_head_change", label: "New function lead", why: "Kicks off a team build-out" },
    ] },
    { category: "Footprint & strategy", motion: "business_dev", ic: "🌍", types: [
      { type: "office_expansion", label: "Expansion", why: "Greenfield local team to build" },
      { type: "market_entry", label: "New market", why: "Needs people who know the market" },
      { type: "product_launch", label: "Product launch", why: "A team to build and sell it" },
    ] },
    { category: "Contraction", motion: "recruiting", ic: "📉", types: [
      { type: "layoff", label: "Layoffs", why: "Great talent hits the market in batches" },
      { type: "warn_notice", label: "WARN notice", why: "Dated, named, precise releases" },
    ] },
    { category: "Talent availability", motion: "recruiting", ic: "🧭", types: [
      { type: "open_to_work", label: "Open to work", why: "The warmest candidate signal" },
      { type: "tenure_milestone", label: "Tenure milestone", why: "When people quietly start looking" },
      { type: "employer_distress", label: "Employer distress", why: "Their employer hit turbulence" },
    ] },
  ];

  const INDUSTRIES = ["healthcare", "fintech", "saas", "ai_ml", "ecommerce", "cybersecurity", "edtech", "logistics", "climate"];
  const FUNCTIONS = ["engineering", "product", "design", "data", "sales", "marketing", "operations", "people_hr", "executive"];

  /* ---- seed signal pool (shapes match types.ts Signal) ---- */
  const SIGNALS = [
    sig("hiring_velocity", "business_dev", "Verla Health posted 9 roles recently", "Healthcare AI scaling engineering fast.", { rolesPosted: 9, roleTitle: "VP Engineering", location: "Remote, US", function: "engineering", remote: true }, "Verla Health", "healthcare", 92),
    sig("funding_round", "business_dev", "Brightwave raised a $40M Series B", "Fintech infra, tripling the team.", { amountUsd: 40000000, stage: "series_b", roleTitle: "Head of Engineering", location: "New York, US" }, "Brightwave", "fintech", 89),
    sig("exec_hire", "business_dev", "Cobalt hired a new VP of Engineering", "Ex-Datadog, rebuilds platform teams.", { title: "VP Engineering", roleTitle: "Director of Platform", location: "Berlin, DE", function: "engineering" }, "Cobalt", "saas", 87),
    sig("job_repost", "business_dev", "Northwind reposted Director of Data", "Reposted twice, struggling to fill.", { roleTitle: "Director of Data", location: "Remote, US", function: "data", remote: true }, "Northwind", "ai_ml", 84),
    sig("office_expansion", "business_dev", "Lumen opening a London hub", "Greenfield go-to-market team.", { location: "London, UK", roleTitle: "Head of Sales", function: "sales" }, "Lumen", "saas", 78),
    sig("layoff", "recruiting", "Pitch announced a 40% reduction", "Strong frontend talent on the market.", { reductionPct: 40, roleTitle: "Senior Frontend Engineer", location: "Berlin, DE", function: "engineering" }, "Pitch", "saas", 86),
    sig("warn_notice", "recruiting", "Helio filed a WARN in California", "120 roles affected, effective soon.", { affectedCount: 120, effectiveDate: "2026-06-20", roleTitle: "Staff Engineer", location: "San Francisco, US", function: "engineering" }, "Helio", "cybersecurity", 90),
    sig("job_posting", "business_dev", "Quanta is hiring a Product Manager", "Greenfield product line.", { roleTitle: "Senior Product Manager", location: "Remote, US", function: "product", remote: true }, "Quanta", "fintech", 74),
    sig("hiring_velocity", "business_dev", "Driftwell posted 6 sales roles", "Expanding the revenue org.", { rolesPosted: 6, roleTitle: "VP Sales", location: "Austin, US", function: "sales" }, "Driftwell", "ecommerce", 80),
    sig("grant_or_contract", "business_dev", "Apex Robotics won a $12M federal award", "Staffing to deliver on a clock.", { amountUsd: 12000000, roleTitle: "Director of Engineering", location: "Boston, US", function: "engineering" }, "Apex Robotics", "logistics", 76),
    sig("exec_hire", "business_dev", "Solis named a new CTO", "New technical leadership, team rebuild incoming.", { title: "CTO", roleTitle: "VP Engineering", location: "Remote, US", function: "engineering", remote: true }, "Solis", "climate", 83),
    sig("job_posting", "recruiting", "Marlin hiring a Senior Data Scientist", "ML team growth.", { roleTitle: "Senior Data Scientist", location: "London, UK", function: "data" }, "Marlin", "ai_ml", 72),
  ];

  function sig(type, motion, title, detail, evidence, company, industry, score) {
    return { type, motion, title, detail, evidence, company: { name: company, industry }, score: { value: score }, sources: 1 };
  }

  /* ---- job-title intelligence (mirror filters.ts) ---- */
  const SENIORITY_ORDER = ["intern", "junior", "mid", "senior", "lead", "manager", "director", "vp", "c_level", "founder"];
  function classifyTitle(raw) {
    const t = (raw || "").toLowerCase();
    const fn = /engineer|developer|devops|platform|swe/.test(t) ? "engineering"
      : /product manager|product owner|product/.test(t) ? "product"
      : /data|scientist|ml|analytics/.test(t) ? "data"
      : /design|ux|ui/.test(t) ? "design"
      : /sales|account executive|revenue/.test(t) ? "sales"
      : /market|growth/.test(t) ? "marketing"
      : /recruit|talent|people|hr/.test(t) ? "people_hr"
      : /ceo|cto|cfo|chief|founder|president/.test(t) ? "executive" : "other";
    const sen = /founder/.test(t) ? "founder" : /chief|cto|ceo|cfo/.test(t) ? "c_level"
      : /vp|vice president/.test(t) ? "vp" : /director|head of/.test(t) ? "director"
      : /manager/.test(t) ? "manager" : /lead|principal|staff/.test(t) ? "lead"
      : /senior|sr\.?/.test(t) ? "senior" : "mid";
    const dm = ["manager", "director", "vp", "c_level", "founder"].includes(sen);
    return { function: fn, seniority: sen, isDecisionMaker: dm };
  }

  /* ---- all signal types for a motion (flat) ---- */
  const typesForMotion = (motion) =>
    SIGNAL_CATALOG.filter(c => c.motion === motion).flatMap(c => c.types.map(t => t.type));

  /* ---- state ---- */
  const state = { step: 1, motion: "business_dev",
    signalTypes: new Set(typesForMotion("business_dev")), // default: all signals for the motion
    industries: new Set(), functions: new Set(["engineering"]),
    minSeniority: "vp", dmOnly: true, wantPhone: false, draft: null };

  /* ---- step 1: signal-type picker (grouped by category, motion-aware) ---- */
  function renderSignalPicker() {
    const g = $("#srcGrid"); g.innerHTML = "";
    SIGNAL_CATALOG.filter(c => c.motion === state.motion).forEach(cat => {
      const head = el("div", null,
        `<div style="display:flex;align-items:center;gap:8px;margin:14px 0 8px">
           <span style="font-size:16px">${cat.ic}</span>
           <b style="font-size:14px">${cat.category}</b>
           <span class="free" style="margin-left:auto">always-on</span>
         </div>`);
      g.appendChild(head);
      const grid = el("div", "src-grid");
      cat.types.forEach(t => {
        const on = state.signalTypes.has(t.type);
        const card = el("div", "src" + (on ? " on" : ""));
        card.innerHTML = `<span class="ic">📡</span><div><b>${t.label}</b><span>${t.why}</span></div>`;
        card.addEventListener("click", () => {
          state.signalTypes.has(t.type) ? state.signalTypes.delete(t.type) : state.signalTypes.add(t.type);
          card.classList.toggle("on");
        });
        grid.appendChild(card);
      });
      g.appendChild(grid);
    });
  }

  /* ---- step 2: filter chips ---- */
  function renderChips(wrap, items, set) {
    wrap.innerHTML = "";
    items.forEach(i => {
      const c = el("span", "chip" + (set.has(i) ? " on" : ""), i.replace(/_/g, " "));
      c.addEventListener("click", () => { set.has(i) ? set.delete(i) : set.add(i); c.classList.toggle("on"); });
      wrap.appendChild(c);
    });
  }
  function wireToggle(id, key) {
    $(id).addEventListener("click", () => { state[key] = !state[key]; $(id).classList.toggle("on", state[key]); });
  }

  /* ---- the builder (mirror campaignBuilder.buildCampaign) ---- */
  function buildDraft() {
    const titleInc = $("#titleIncludes").value.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    const locs = $("#locations").value.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    const minSen = $("#minSeniority").value;
    const pulled = SIGNALS.filter(s => state.signalTypes.has(s.type)); // selected signal types
    const matched = pulled.filter(s => {
      if (s.motion !== state.motion) return false;
      if (state.industries.size && !state.industries.has(s.company.industry)) return false;
      const title = s.evidence.roleTitle || "";
      const intel = classifyTitle(title);
      if (state.functions.size && !state.functions.has(intel.function)) return false;
      if (titleInc.length && !titleInc.some(t => title.toLowerCase().includes(t))) return false;
      if (state.dmOnly && !intel.isDecisionMaker) return false;
      if (minSen && SENIORITY_ORDER.indexOf(intel.seniority) < SENIORITY_ORDER.indexOf(minSen)) return false;
      if (locs.length) { const loc = (s.evidence.location || "").toLowerCase(); if (!locs.some(l => loc.includes(l))) return false; }
      return true;
    });
    const targets = matched.map(s => {
      const intel = classifyTitle(s.evidence.roleTitle || "");
      return { name: s.company.name, title: s.evidence.roleTitle, function: intel.function, seniority: intel.seniority,
        industry: s.company.industry, location: s.evidence.location, score: s.score.value,
        reason: reasonFor(s), type: s.type, needs: { email: true, phone: state.wantPhone, name: true } };
    }).sort((a, b) => b.score - a.score);

    const segCount = {};
    targets.forEach(t => { segCount[t.function] = (segCount[t.function] || 0) + 1; });
    const emailsToFind = targets.length, phonesToFind = state.wantPhone ? targets.length : 0;
    const cost = { emailsToFind, phonesToFind,
      estEmail: round(emailsToFind * 0.006), estPhone: round(phonesToFind * 0.25) };
    cost.total = round(cost.estEmail + cost.estPhone);
    return { pulled: pulled.length, matched: matched.length, targets,
      companies: new Set(targets.map(t => t.name)).size, people: 0, segments: segCount, cost };
  }

  function reasonFor(s) {
    const e = s.evidence;
    switch (s.type) {
      case "hiring_velocity": return `posted ${e.rolesPosted} roles recently`;
      case "funding_round": return `just raised ${fmtUsd(e.amountUsd)}`;
      case "warn_notice": case "layoff": return "a reduction puts strong people on the market";
      case "exec_hire": return `a new ${e.title} is rebuilding the team`;
      case "job_repost": return `reposted "${e.roleTitle}", struggling to fill`;
      case "office_expansion": return `is opening ${e.location}`;
      case "grant_or_contract": return `won ${fmtUsd(e.amountUsd)}, staffing to deliver`;
      default: return `is hiring for ${e.roleTitle}`;
    }
  }

  /* ---- render review + summary ---- */
  function renderReview() {
    const d = state.draft; const list = $("#targetList"); list.innerHTML = "";
    if (!d.targets.length) {
      list.innerHTML = `<div class="empty"><div class="big">🗂️</div><b>No targets match yet</b><p>Loosen the filter, add an industry, or include more functions.</p></div>`;
      return;
    }
    d.targets.forEach(t => {
      const sc = t.score >= 85 ? "hi" : t.score >= 75 ? "mid" : "lo";
      const card = el("div", "target");
      card.innerHTML = `<div class="top"><span class="nm">${t.name}</span>
        <span class="badge">${(t.industry || "").replace(/_/g, " ")}</span>
        <span class="score ${sc}">${t.score}</span></div>
        <div class="reason">${t.name} ${t.reason} — targeting <b>${t.title}</b>.</div>
        <div class="badges">
          <span class="badge">${t.type}</span>
          <span class="badge">${t.function}</span>
          <span class="badge">${t.location || ""}</span>
          ${t.needs.email ? '<span class="badge need">needs email</span>' : ""}
          ${t.needs.phone ? '<span class="badge need">needs phone</span>' : ""}
        </div>`;
      list.appendChild(card);
    });
  }
  function renderSummary() {
    const d = state.draft;
    $("#sPulled").textContent = d ? d.pulled : "—";
    $("#sMatched").textContent = d ? d.matched : "—";
    $("#sTargets").textContent = d ? d.targets.length : "—";
    $("#sCompanies").textContent = d ? d.companies : "—";
    $("#sPeople").textContent = d ? d.people : "—";
    const segWrap = $("#segWrap"); segWrap.innerHTML = "";
    if (d && Object.keys(d.segments).length) {
      segWrap.appendChild(el("div", null, `<div style="font-size:12px;color:var(--text-dim);margin-bottom:4px">Segments</div>`));
      Object.entries(d.segments).sort((a, b) => b[1] - a[1]).forEach(([k, v]) =>
        segWrap.appendChild(el("div", "seg", `<span>${k.replace(/_/g, " ")}</span><b>${v}</b>`)));
    }
    if (d && state.step === 3) {
      $("#costPanel").style.display = "block";
      $("#launchBtn").style.display = "block";
      $("#costBig").textContent = "$" + d.cost.total.toFixed(2);
      $("#costBreak").innerHTML = `${d.cost.emailsToFind} emails ~$${d.cost.estEmail.toFixed(2)}` +
        (state.wantPhone ? ` · ${d.cost.phonesToFind} phones ~$${d.cost.estPhone.toFixed(2)}` : "") +
        `<br>cheapest-first waterfall (Icypeas/RapidAPI + verify)`;
    } else {
      $("#costPanel").style.display = "none"; $("#launchBtn").style.display = "none";
    }
  }

  /* ---- stepper nav ---- */
  function showStep(n) {
    state.step = n;
    $$(".cb-step").forEach(s => s.style.display = +s.dataset.step === n ? "block" : "none");
    $$("#stepper .step").forEach(s => {
      const sn = +s.dataset.step;
      s.classList.toggle("active", sn === n);
      s.classList.toggle("done", sn < n);
    });
    $("#backBtn").style.display = n > 1 ? "inline-flex" : "none";
    $("#nextBtn").textContent = n === 1 ? "Next: set filters →" : n === 2 ? "Build target list →" : "Rebuild";
    if (n === 3) { state.draft = buildDraft(); renderReview(); }
    renderSummary();
  }

  $("#nextBtn").addEventListener("click", () => {
    if (state.step < 3) showStep(state.step + 1);
    else { state.draft = buildDraft(); renderReview(); renderSummary(); toast("Target list rebuilt"); }
  });
  $("#backBtn").addEventListener("click", () => showStep(Math.max(1, state.step - 1)));
  $("#motion").addEventListener("change", e => {
    state.motion = e.target.value;
    state.signalTypes = new Set(typesForMotion(state.motion)); // select all for the new motion
    renderSignalPicker();
  });
  $("#minSeniority").addEventListener("change", e => { state.minSeniority = e.target.value; });
  $("#launchBtn").addEventListener("click", () => {
    const d = state.draft;
    toast(`Launching: ${d.targets.length} targets → enrichment + outreach. Est ${"$" + d.cost.total.toFixed(2)}.`);
  });

  /* ---- toast ---- */
  let tT;
  function toast(msg) {
    let t = $("#cbToast");
    if (!t) { t = el("div", "toast"); t.id = "cbToast"; document.body.appendChild(t); }
    t.textContent = "✓ " + msg; t.classList.add("show");
    clearTimeout(tT); tT = setTimeout(() => t.classList.remove("show"), 2800);
  }

  function fmtUsd(n) { return n >= 1e6 ? "$" + (n / 1e6).toFixed(0) + "M" : n >= 1e3 ? "$" + (n / 1e3).toFixed(0) + "k" : "$" + n; }
  function round(n) { return Math.round(n * 100) / 100; }

  /* ---- init ---- */
  renderSignalPicker();
  renderChips($("#industryChips"), INDUSTRIES, state.industries);
  renderChips($("#functionChips"), FUNCTIONS, state.functions);
  wireToggle("#dmOnly", "dmOnly");
  wireToggle("#wantPhone", "wantPhone");
  showStep(1);
})();
