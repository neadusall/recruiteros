/**
 * RecruiterOS · Laxis worker — self-healing layer.
 *
 * Browser automation breaks when a site renames a button or moves a step. This module
 * makes every interaction "intent-based" so the worker repairs itself instead of dying:
 *
 *   1. FAST PATH — try the known label(s) for the step (+ any previously-learned override).
 *   2. LEARNED PATH — overrides that healed before live on /data/laxis-overrides.json and
 *      are tried first next time, so a given UI change is repaired ONCE.
 *   3. HEAL PATH — if all known labels fail, dump the page's interactive elements and ask
 *      Claude which one satisfies the step's plain-English intent, click it, and PERSIST
 *      the winner as an override.
 *
 * Net effect: a Laxis label/text change self-heals on the next run (and the canary in
 * server.js heals it pre-emptively, before a real job ever hits it). Only a deep
 * structural change (a brand-new multi-step flow) needs a human — and even then the
 * error names the exact step that couldn't be resolved.
 *
 * Uses the Anthropic API directly via fetch (ANTHROPIC_API_KEY is in the worker env);
 * no SDK dependency. Heal is best-effort: if the key is missing or the call fails, the
 * step throws its normal "CALIBRATE" error.
 */

"use strict";

const fs = require("fs");

const OVERRIDES_PATH = process.env.LAXIS_OVERRIDES_PATH || "/data/laxis-overrides.json";
const HEAL_MODEL = process.env.LAXIS_HEAL_MODEL || "claude-haiku-4-5-20251001";

function loadOverrides() {
  try { return JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf8")); } catch { return {}; }
}
function saveOverride(intentKey, value) {
  let o = {};
  try { o = loadOverrides(); } catch { /* ignore */ }
  o[intentKey] = { value, learnedAt: new Date().toISOString() };
  try { fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(o, null, 2)); } catch { /* best effort */ }
}

/** Visible, interactive elements on the page (buttons / links / menuitems / aria-labelled). */
async function dumpInteractive(page) {
  return page.evaluate(() => {
    const out = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = w.nextNode())) {
      const tag = n.tagName.toLowerCase();
      const role = n.getAttribute("role");
      const aria = n.getAttribute("aria-label") || "";
      const interactive = tag === "button" || tag === "a" || role === "button" || role === "menuitem" || role === "tab" || !!aria;
      if (!interactive) continue;
      const r = n.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const text = (n.innerText || n.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
      if (!text && !aria) continue;
      out.push({ kind: tag, role: role || "", text, aria });
    }
    const seen = new Set();
    return out.filter((o) => { const k = o.text + "|" + o.aria; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 70);
  });
}

/** Ask Claude which element's visible text best satisfies the intent. Returns text or null. */
async function llmPickText(intent, elements) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !elements.length) return null;
  const list = elements.map((c, i) => `${i}. [${c.kind}${c.role ? "/" + c.role : ""}] text=${JSON.stringify(c.text)} aria=${JSON.stringify(c.aria)}`).join("\n");
  const body = {
    model: HEAL_MODEL,
    max_tokens: 200,
    system: 'You repair a broken web-automation click. Given a GOAL and a numbered list of clickable elements currently on the page, choose the single element that best achieves the goal. Reply with ONLY a JSON object: {"text":"<the element\'s exact visible text, or its aria label if it has no text>"} — or {"text":null} if none fit. No prose, no markdown.',
    messages: [{ role: "user", content: `GOAL: ${intent}\n\nELEMENTS:\n${list}` }],
  };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const txt = (data.content || []).map((b) => b.text || "").join("");
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const pick = JSON.parse(m[0]).text;
    return pick && typeof pick === "string" ? pick : null;
  } catch { return null; }
}

/**
 * Try to click `text` — REAL interactive elements first (button, link, menuitem), plain
 * visible text only as the last resort. Order matters: a page can render a heading with
 * the same words as the button (Laxis's login screen gained an <h1>Sign In</h1> above
 * the Sign In button in July 2026), and clicking the heading is a silent no-op that
 * reads as success, which also stops the self-heal path from ever firing. Returns true
 * on success.
 */
async function tryClick(page, text, timeout = 5000) {
  const esc = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(esc, "i");
  for (const role of ["button", "link", "menuitem"]) {
    try {
      const loc = page.getByRole(role, { name: rx }).first();
      await loc.waitFor({ state: "visible", timeout: 2500 });
      await loc.click();
      return true;
    } catch { /* next role */ }
  }
  try {
    const loc = page.getByText(text, { exact: false }).first();
    await loc.waitFor({ state: "visible", timeout });
    await loc.click();
    return true;
  } catch { return false; }
}

/**
 * Resolve + click a step. intentKey identifies the step (for overrides); description is
 * the plain-English goal for the LLM; knownTexts are the labels we expect. Heals + persists
 * if all known labels fail.
 */
async function resolveClick(page, intentKey, description, knownTexts, log = () => {}) {
  const ov = loadOverrides();
  const tries = [];
  if (ov[intentKey] && ov[intentKey].value) tries.push(ov[intentKey].value);
  for (const t of knownTexts) if (!tries.includes(t)) tries.push(t);

  for (const t of tries) {
    if (await tryClick(page, t)) return t;
  }

  log(`heal: step '${intentKey}' failed on known labels — asking Claude to repair`);
  const els = await dumpInteractive(page);
  const picked = await llmPickText(description, els);
  if (picked && (await tryClick(page, picked, 6000))) {
    saveOverride(intentKey, picked);
    log(`heal: repaired '${intentKey}' -> "${picked}" (persisted to overrides)`);
    return picked;
  }
  throw new Error(`laxis_step_unresolved: '${intentKey}' (${description}) — Laxis UI changed and auto-repair could not find it. Run \`node probe.js\` to recalibrate.`);
}

/** Resolve a step WITHOUT clicking (canary / self-test): confirm a label is locatable, heal if not. */
async function resolveLocate(page, intentKey, description, knownTexts, log = () => {}) {
  const ov = loadOverrides();
  const tries = [];
  if (ov[intentKey] && ov[intentKey].value) tries.push(ov[intentKey].value);
  for (const t of knownTexts) if (!tries.includes(t)) tries.push(t);
  for (const t of tries) {
    try { await page.getByText(t, { exact: false }).first().waitFor({ state: "visible", timeout: 4000 }); return { ok: true, healed: false, text: t }; } catch { /* next */ }
  }
  log(`canary: '${intentKey}' not locatable on known labels — attempting repair`);
  const picked = await llmPickText(description, await dumpInteractive(page));
  if (picked) {
    try {
      await page.getByText(picked, { exact: false }).first().waitFor({ state: "visible", timeout: 4000 });
      saveOverride(intentKey, picked);
      log(`canary: pre-emptively healed '${intentKey}' -> "${picked}"`);
      return { ok: true, healed: true, text: picked };
    } catch { /* fall through */ }
  }
  return { ok: false, healed: false, text: null };
}

module.exports = { resolveClick, resolveLocate, loadOverrides, OVERRIDES_PATH };
