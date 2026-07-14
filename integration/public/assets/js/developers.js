/* ============================================================
   RecruitersOS · Developer console (interactive demo)
   Mirrors the real API in integration/api + the signals engine.
   Self-contained, no backend: simulates responses so an integrator
   can see exact request/response shapes before wiring their app.
   ============================================================ */
(function () {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };

  /* ---------- mock state (shapes match integration/api/types.ts) ---------- */
  const SCOPES = ["signals:read", "signals:write", "enrich:read", "campaigns:write", "config:write", "admin"];
  const EVENTS = ["signal.created", "signal.triggered", "enrichment.completed", "campaign.created"];

  const state = {
    keys: [
      { id: "rk_live_8f3a91c0d22b", label: "Production server", scopes: ["admin"], createdAt: "2026-05-20", lastUsedAt: "2026-05-29" },
    ],
    pickedScopes: new Set(["signals:read", "enrich:read"]),
    pickedEvents: new Set(["signal.triggered"]),
    // The enrichment waterfall, cheapest-first (mirrors rapidapi.ts ordering)
    providers: [
      { providerId: "email_pattern", label: "Email permutation (local)", cost: "$0", status: "on", order: 0 },
      { providerId: "icypeas_email", label: "Icypeas email finder", cost: "~$0.003/email", status: "on", order: 1 },
      { providerId: "rapidapi_email", label: "RapidAPI email finder", cost: "~$0.008/call", status: "key-needed", order: 2 },
      { providerId: "email_verify", label: "Email verification", cost: "~$0.0025/check", status: "on", order: 3 },
      { providerId: "rapidapi_phone", label: "RapidAPI phone lookup", cost: "~$0.01/call", status: "key-needed", order: 4 },
      { providerId: "apollo", label: "Apollo (premium backup)", cost: "~$0.10/credit", status: "off", order: 5 },
    ],
    hooks: [],
  };

  // The signal catalog (condensed mirror of integration/lib/signals/registry.ts)
  const CATALOG = [
    { type: "hiring_velocity", label: "Hiring surge", weight: 0.88, half: "14d", motion: "business_dev" },
    { type: "open_to_work", label: "Open to work", weight: 0.9, half: "2d", motion: "recruiting" },
    { type: "warn_notice", label: "WARN notice", weight: 0.9, half: "30d", motion: "recruiting" },
    { type: "layoff", label: "Layoff", weight: 0.85, half: "14d", motion: "recruiting" },
    { type: "funding_round", label: "Funding round", weight: 0.82, half: "30d", motion: "business_dev" },
    { type: "exec_hire", label: "New exec", weight: 0.8, half: "60d", motion: "business_dev" },
    { type: "job_repost", label: "Role reposted", weight: 0.8, half: "14d", motion: "business_dev" },
    { type: "job_posting", label: "New job posting", weight: 0.75, half: "21d", motion: "business_dev" },
    { type: "employer_distress", label: "Employer distress", weight: 0.7, half: "21d", motion: "recruiting" },
    { type: "office_expansion", label: "Expansion", weight: 0.66, half: "30d", motion: "business_dev" },
    { type: "tenure_milestone", label: "Tenure milestone", weight: 0.55, half: "60d", motion: "recruiting" },
    { type: "tech_stack_change", label: "Tech adoption", weight: 0.5, half: "45d", motion: "business_dev" },
  ];

  const ENDPOINTS = [
    { verb: "GET", path: "/v1/signals/catalog", body: null },
    { verb: "POST", path: "/v1/enrich", body: { subject: { firstName: "Jamie", lastName: "Rao", companyName: "Verla Health" } } },
    { verb: "POST", path: "/v1/signals/ingest", body: { type: "funding_round", anchor: "verla.health", title: "Verla Health raised a $40M Series B", detail: "Plans to triple engineering.", evidence: { amountUsd: 40000000, stage: "series_b" } } },
    { verb: "POST", path: "/v1/signals/collect", body: { icp: { id: "icp_1", motion: "business_dev", titles: ["VP Engineering"], autoTriggerThreshold: 75 }, limit: 50, triggerTopN: 10 } },
  ];

  let toastTimer;
  function toast(msg) {
    let t = $("#devToast");
    if (!t) { t = el("div", "toast"); t.id = "devToast"; document.body.appendChild(t); }
    t.textContent = "✓ " + msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
  }

  /* ---------------- tabs ---------------- */
  $$(".dev-side button").forEach((b) =>
    b.addEventListener("click", () => {
      $$(".dev-side button").forEach((x) => x.classList.toggle("active", x === b));
      $$(".dev-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + b.dataset.tab));
    })
  );

  /* ---------------- keys ---------------- */
  function renderKeys() {
    const list = $("#keyList"); list.innerHTML = "";
    state.keys.forEach((k) => {
      const row = el("div", "key-row");
      row.innerHTML = `<code>${k.id}…</code>
        <span class="scopes">${k.scopes.map((s) => `<span class="scope-chip">${s}</span>`).join("")}</span>
        <span style="margin-left:auto;color:var(--text-dim);font-size:12px">used ${k.lastUsedAt || "never"}</span>
        <button class="btn btn-ghost btn-sm" data-revoke="${k.id}">Revoke</button>`;
      list.appendChild(row);
    });
    $$("[data-revoke]").forEach((b) => b.addEventListener("click", () => {
      state.keys = state.keys.filter((k) => k.id !== b.dataset.revoke);
      renderKeys(); toast("Key revoked");
    }));
  }
  function renderScopePicker() {
    const wrap = $("#scopePick"); wrap.innerHTML = "";
    SCOPES.forEach((s) => {
      const chip = el("span", "scope-chip", s);
      chip.style.cursor = "pointer";
      const on = () => chip.style.background = state.pickedScopes.has(s) ? "color-mix(in srgb, var(--brand) 40%, transparent)" : "var(--surface-2)";
      on();
      chip.addEventListener("click", () => { state.pickedScopes.has(s) ? state.pickedScopes.delete(s) : state.pickedScopes.add(s); on(); });
      wrap.appendChild(chip);
    });
  }
  $("#newKey").addEventListener("click", () => {
    const label = $("#keyLabel").value.trim() || "Untitled key";
    const id = "rk_live_" + Math.random().toString(16).slice(2, 14);
    const secret = id + "." + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    state.keys.push({ id, label, scopes: [...state.pickedScopes], createdAt: "today", lastUsedAt: null });
    renderKeys();
    $("#keyLabel").value = "";
    // Show the secret once, exactly like the real issueKey() contract.
    const out = el("div", "card");
    out.style.borderColor = "color-mix(in srgb, var(--ok) 40%, transparent)";
    out.innerHTML = `<h3>Copy your secret now</h3><p class="sub">Shown once. RecruitersOS stores only a hash, you cannot retrieve it again.</p>
      <div class="codeblock">${secret}</div>`;
    $("#keyList").parentElement.insertBefore(out, $("#keyList").nextSibling);
    toast("Key created, copy the secret");
  });

  /* ---------------- providers (waterfall) ---------------- */
  function renderProviders() {
    const list = $("#provList"); list.innerHTML = "";
    state.providers.sort((a, b) => a.order - b.order).forEach((p, i) => {
      const badge = p.status === "on" ? `<span class="pill green">active</span>`
        : p.status === "key-needed" ? `<span class="pill amber">add key</span>`
        : `<span class="pill dim">off</span>`;
      const row = el("div", "prov-row");
      row.innerHTML = `<span style="color:var(--text-dim);font-family:'JetBrains Mono',monospace">${i + 1}</span>
        <b>${p.label}</b>
        <span class="scope-chip">${p.cost}</span>
        ${badge}
        <button class="btn btn-ghost btn-sm" style="margin-left:auto" data-prov="${p.providerId}">${p.status === "on" ? "Disable" : "Enable"}</button>`;
      list.appendChild(row);
    });
    $$("[data-prov]").forEach((b) => b.addEventListener("click", () => {
      const p = state.providers.find((x) => x.providerId === b.dataset.prov);
      p.status = p.status === "on" ? "off" : "on";
      renderProviders(); toast(p.label + " " + (p.status === "on" ? "enabled" : "disabled"));
    }));
  }

  /* ---------------- webhooks ---------------- */
  function renderEventPicker() {
    const wrap = $("#eventPick"); wrap.innerHTML = "";
    EVENTS.forEach((e) => {
      const chip = el("span", "scope-chip", e); chip.style.cursor = "pointer";
      const on = () => chip.style.background = state.pickedEvents.has(e) ? "color-mix(in srgb, var(--brand) 40%, transparent)" : "var(--surface-2)";
      on();
      chip.addEventListener("click", () => { state.pickedEvents.has(e) ? state.pickedEvents.delete(e) : state.pickedEvents.add(e); on(); });
      wrap.appendChild(chip);
    });
  }
  function renderHooks() {
    const list = $("#hookList"); list.innerHTML = "";
    if (!state.hooks.length) { list.innerHTML = `<p class="sub">No webhooks yet.</p>`; return; }
    state.hooks.forEach((h) => {
      const row = el("div", "hook-row");
      row.innerHTML = `<code>${h.url}</code>
        <span class="scopes">${h.events.map((e) => `<span class="scope-chip">${e}</span>`).join("")}</span>
        <span class="pill green" style="margin-left:auto">active</span>`;
      list.appendChild(row);
    });
  }
  $("#newHook").addEventListener("click", () => {
    const url = $("#hookUrl").value.trim();
    if (!/^https:\/\//.test(url)) { toast("URL must be https"); return; }
    const secret = "whsec_" + Math.random().toString(36).slice(2, 14);
    state.hooks.push({ url, events: [...state.pickedEvents], secret });
    renderHooks(); $("#hookUrl").value = "";
    const out = el("div", "card"); out.style.borderColor = "color-mix(in srgb, var(--ok) 40%, transparent)";
    out.innerHTML = `<h3>Signing secret</h3><p class="sub">Verify each delivery's <code>X-Signature-256</code> with this. Shown once.</p><div class="codeblock">${secret}</div>`;
    $("#hookList").parentElement.insertBefore(out, $("#hookList").nextSibling);
    toast("Webhook registered");
  });

  /* ---------------- catalog ---------------- */
  function renderCatalog() {
    const list = $("#catList"); list.innerHTML = "";
    CATALOG.sort((a, b) => b.weight - a.weight).forEach((c) => {
      const row = el("div", "catrow");
      row.innerHTML = `<span><b>${c.label}</b> <span class="cattype">${c.type}</span> <span class="scope-chip">${c.motion}</span></span>
        <span class="bar"><i style="width:${c.weight * 100}%"></i></span>
        <span style="color:var(--text-dim);font-size:12px">½-life ${c.half}</span>`;
      list.appendChild(row);
    });
  }

  /* ---------------- test console ---------------- */
  let activeEp = ENDPOINTS[1];
  function renderEndpoints() {
    const list = $("#epList"); list.innerHTML = "";
    ENDPOINTS.forEach((e) => {
      const row = el("div", "endpoint");
      row.innerHTML = `<span class="verb ${e.verb.toLowerCase()}">${e.verb}</span> ${e.path}`;
      row.addEventListener("click", () => { activeEp = e; selectEndpoint(); });
      list.appendChild(row);
    });
    selectEndpoint();
  }
  function selectEndpoint() {
    $$("#epList .endpoint").forEach((r, i) => r.style.borderColor = ENDPOINTS[i] === activeEp ? "color-mix(in srgb, var(--brand) 40%, transparent)" : "var(--border)");
    $("#reqBody").value = activeEp.body ? JSON.stringify(activeEp.body, null, 2) : "";
    $("#reqBody").disabled = !activeEp.body;
  }
  function simulate(ep, body) {
    if (ep.path === "/v1/signals/catalog") return { count: CATALOG.length, signals: CATALOG };
    if (ep.path === "/v1/enrich") {
      return {
        resolved: {
          domain: { value: "verla.health", confidence: 0.45, providerId: "domain_heuristic", cost: 0 },
          email: { value: "jamie.rao@verla.health", confidence: 0.97, providerId: "email_verify", cost: 0.6 },
        },
        totalCost: 0.6,
        budgetExhausted: false,
        trace: [
          { field: "email", attempts: [
            { providerId: "email_pattern", status: "hit", confidence: 0.35, cost: 0 },
            { providerId: "icypeas_email", status: "hit", confidence: 0.75, cost: 0.3 },
            { providerId: "email_verify", status: "hit", confidence: 0.97, cost: 0.3 },
          ] },
        ],
      };
    }
    if (ep.path === "/v1/signals/ingest") return { accepted: true, signal: { id: "sig_webhook_" + Math.random().toString(16).slice(2, 8), status: "raw", ...body } };
    if (ep.path === "/v1/signals/collect") return { pulled: 64, deduped: 41, ranked: 41, triggered: ["sig_velocity_verla_health"], warnings: [] };
    return { ok: true };
  }
  $("#sendReq").addEventListener("click", () => {
    let body = null;
    if (activeEp.body) { try { body = JSON.parse($("#reqBody").value); } catch { toast("Body is not valid JSON"); return; } }
    const out = $("#respOut");
    out.innerHTML = `<div class="codeblock"><span class="c">// ${activeEp.verb} ${activeEp.path} · 200 OK</span>\n` +
      JSON.stringify(simulate(activeEp, body), null, 2).replace(/[<>]/g, "") + `</div>`;
    toast("200 OK");
  });

  $("#openapiLink").addEventListener("click", (e) => {
    e.preventDefault();
    toast("Spec at /v1/openapi.json (see integration/api/openapi.ts)");
  });

  /* ---------------- init ---------------- */
  renderKeys(); renderScopePicker();
  renderProviders();
  renderEventPicker(); renderHooks();
  renderCatalog();
  renderEndpoints();
})();
