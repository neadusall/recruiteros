/* ============================================================
   Content script — runs on linkedin.com.
   Two jobs:
     1) READ:  scrape the current profile / search results
     2) ACT:   perform queued actions (connect/message/…)
   Plus a floating "capture" overlay button.

   ⚠️ SAFE_MODE (default true): action executors DO NOT click real
   LinkedIn buttons — they no-op + return a simulated success so the
   whole pipeline is testable with zero account risk. To go live, an
   integrator fills in the real selectors below and sets SAFE_MODE=false.
   Respect LinkedIn's ToS and the daily caps in config.js.
   ============================================================ */
(function () {
  'use strict';
  const { TYPE, ACTION, send, makeAction } = window.ROS;
  const SAFE_MODE = true;   // ← integrator flips to false after wiring real selectors

  /* ---------- tiny DOM utils ---------- */
  const q = (s, r = document) => r.querySelector(s);
  const txt = (s, r = document) => { const e = q(s, r); return e ? e.textContent.trim() : ''; };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  // human-like: jitter before any interaction
  const humanPause = () => sleep(rand(600, 1800));

  /* ---------- SELECTORS (best-effort; LinkedIn changes these often) ----------
     Centralized so an integrator updates them in ONE place. */
  const SEL = {
    profileName: 'h1',
    profileHeadline: '.text-body-medium',
    profileLocation: '.text-body-small.inline.t-black--light',
    profileExperienceCompany: '[data-field="experience_company_logo"] span[aria-hidden="true"]',
    connectBtn: 'button[aria-label^="Invite"][aria-label*="connect"], button[aria-label^="Connect"]',
    addNoteBtn: 'button[aria-label="Add a note"]',
    noteTextarea: 'textarea[name="message"], #custom-message',
    sendInviteBtn: 'button[aria-label="Send now"], button[aria-label="Send invitation"]',
    messageBtn: 'button[aria-label^="Message"]',
    messageBox: '.msg-form__contenteditable[contenteditable="true"]',
    messageSendBtn: 'button.msg-form__send-button',
    followBtn: 'button[aria-label^="Follow"]',
    searchResultCard: 'li.reusable-search__result-container, .entity-result',
  };

  /* ---------- READ: scrape current profile ---------- */
  function isProfilePage() { return /\/in\//.test(location.pathname); }
  function scrapeProfile() {
    const name = txt(SEL.profileName) || document.title.replace(/\s*\|.*$/, '').trim();
    const headline = txt(SEL.profileHeadline);
    const location = txt(SEL.profileLocation);
    const company = txt(SEL.profileExperienceCompany);
    const profileUrl = location && location.href ? '' : (location.pathname ? location.origin + location.pathname : '');
    const url = window.location.origin + window.location.pathname;
    const [firstName, ...rest] = name.split(' ');
    return {
      firstName, lastName: rest.join(' '), fullName: name,
      headline, company, position: headline, location: txt(SEL.profileLocation),
      profileUrl: url, source: 'linkedin-extension', capturedAt: Date.now(),
      isSelf: /\/in\/me\/?$/.test(location.pathname) || isOwnProfile(),
    };
  }
  function isOwnProfile() {
    // heuristic: own profile shows an "Open to"/"Add profile section" affordance
    return !!q('button[aria-label="Add profile section"]');
  }
  function scrapeSearch() {
    const out = [];
    document.querySelectorAll(SEL.searchResultCard).forEach(card => {
      const a = q('a[href*="/in/"]', card);
      const name = a ? a.textContent.trim().split('\n')[0] : '';
      if (!name) return;
      out.push({ fullName: name, profileUrl: a ? a.href.split('?')[0] : '', headline: txt('.entity-result__primary-subtitle', card), source: 'linkedin-search', capturedAt: Date.now() });
    });
    return out;
  }

  /* ---------- ACT: execute one action ---------- */
  async function doAction(action) {
    await humanPause();
    if (SAFE_MODE) {
      // simulated path — no real clicks. Mirrors the engine's Simulated adapter.
      return { ok: true, status: 'sent', info: 'SAFE_MODE: simulated ' + action.type + ' (no real click)' };
    }
    try {
      switch (action.type) {
        case ACTION.VIEW:    return { ok: true, status: 'sent', info: 'profile viewed (page already loaded)' };
        case ACTION.FOLLOW:  return await clickFollow();
        case ACTION.CONNECT: return await sendConnect(action.payload && (action.payload.note || action.payload.body));
        case ACTION.MESSAGE: return await sendMessage(action.payload && action.payload.body);
        case ACTION.LIKE:    return { ok: false, info: 'like selector not wired' };
        case ACTION.ENDORSE: return { ok: false, info: 'endorse selector not wired' };
        case ACTION.INMAIL:  return { ok: false, info: 'inmail selector not wired' };
        default: return { ok: false, info: 'unknown action ' + action.type };
      }
    } catch (e) { return { ok: false, info: e.message }; }
  }

  async function sendConnect(note) {
    const btn = q(SEL.connectBtn); if (!btn) return { ok: false, info: 'connect button not found' };
    btn.click(); await humanPause();
    if (note) {
      const add = q(SEL.addNoteBtn); if (add) { add.click(); await humanPause();
        const ta = q(SEL.noteTextarea); if (ta) { setNativeValue(ta, note.slice(0, 300)); await humanPause(); } }
    }
    const send = q(SEL.sendInviteBtn); if (send) { send.click(); return { ok: true, status: 'sent', info: 'invite sent' }; }
    return { ok: false, info: 'send button not found' };
  }
  async function sendMessage(body) {
    const mb = q(SEL.messageBtn); if (mb) { mb.click(); await humanPause(); }
    const box = q(SEL.messageBox); if (!box) return { ok: false, info: 'message box not found' };
    box.focus(); document.execCommand('insertText', false, body || ''); await humanPause();
    const send = q(SEL.messageSendBtn); if (send) { send.click(); return { ok: true, status: 'sent', info: 'message sent' }; }
    return { ok: false, info: 'message send button not found' };
  }
  async function clickFollow() {
    const b = q(SEL.followBtn); if (!b) return { ok: false, info: 'follow button not found' };
    b.click(); return { ok: true, status: 'sent', info: 'followed' };
  }
  // React-friendly value setter
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc && desc.set && desc.set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /* ---------- message handler from background ---------- */
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    (async () => {
      if (msg.type === TYPE.SCRAPE_PROFILE) reply(scrapeProfile());
      else if (msg.type === TYPE.SCRAPE_SEARCH) reply(scrapeSearch());
      else if (msg.type === TYPE.DO_ACTION) reply(await doAction(msg.action));
      else reply({ ok: false, info: 'unknown' });
    })();
    return true;
  });

  /* ---------- overlay: floating capture button ---------- */
  function injectOverlay() {
    if (q('#ros-overlay')) return;
    const host = document.createElement('div');
    host.id = 'ros-overlay';
    host.innerHTML = `
      <button id="ros-capture" title="Capture this profile into RecruiterOS">
        <span class="ros-logo">R</span><span class="ros-label">Capture</span>
      </button>`;
    document.body.appendChild(host);
    q('#ros-capture').addEventListener('click', async () => {
      const profile = scrapeProfile();
      await send({ type: TYPE.CAPTURE_LEAD, profile });
      flash(profile.fullName ? 'Captured ' + profile.fullName : 'Captured profile');
    });
  }
  function flash(text) {
    const t = document.createElement('div'); t.id = 'ros-toast'; t.textContent = '✓ ' + text;
    document.body.appendChild(t); requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2200);
  }

  // announce ourselves + identify the logged-in user once
  function boot() {
    injectOverlay();
    if (isProfilePage()) {
      const p = scrapeProfile();
      if (p.isSelf) send({ type: TYPE.CAPTURE_LEAD, profile: p });
    }
  }
  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot);
  // LinkedIn is an SPA — re-inject the overlay on route changes
  let lastPath = location.pathname;
  setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; injectOverlay(); } }, 1500);
})();
