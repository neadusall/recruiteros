/* ============================================================
   Content script — runs on linkedin.com.
   Jobs: detect the logged-in user, scrape/capture profiles, and
   perform queued outreach actions, plus a floating capture button.

   LIVE vs SIMULATE is a RUNTIME flag now (set in the popup), passed
   on each action as action.meta.live. When false, executors no-op and
   return a simulated success so the whole pipeline is testable with
   zero account risk. Respect LinkedIn ToS and the daily caps.
   ============================================================ */
(function () {
  'use strict';
  if (!window.ROS) return;
  const { TYPE, ACTION, send } = window.ROS;

  const q = (s, r = document) => r.querySelector(s);
  const txt = (s, r = document) => { const e = q(s, r); return e ? e.textContent.trim() : ''; };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const humanPause = () => sleep(rand(600, 1800));

  /* ---------- SELECTORS (centralized; LinkedIn changes these often) ---------- */
  const SEL = {
    profileName: 'h1',
    profileHeadline: '.text-body-medium.break-words, .text-body-medium',
    profileLocation: '.text-body-small.inline.t-black--light, .pv-text-details__left-panel .text-body-small',
    profileCompany: '[data-field="experience_company_logo"] span[aria-hidden="true"], button[aria-label*="Current company"] span',
    connectBtn: 'button[aria-label^="Invite"][aria-label*="connect"], button[aria-label^="Connect"]',
    moreBtn: 'button[aria-label="More actions"]',
    addNoteBtn: 'button[aria-label="Add a note"]',
    noteTextarea: 'textarea[name="message"], #custom-message',
    sendInviteBtn: 'button[aria-label="Send now"], button[aria-label="Send invitation"], button[aria-label="Send"]',
    messageBtn: 'button[aria-label^="Message"]',
    messageBox: '.msg-form__contenteditable[contenteditable="true"]',
    messageSendBtn: 'button.msg-form__send-button',
    followBtn: 'button[aria-label^="Follow"]',
    meNavPhoto: 'img.global-nav__me-photo',
  };

  /* ---------- IDENTITY: who is logged in ---------- */
  function csrfToken() {
    const m = /JSESSIONID="?([^";]+)"?/.exec(document.cookie || '');
    return m ? m[1] : null;
  }
  async function getLoggedInUser() {
    // Preferred: LinkedIn's own /voyager/api/me (read-only, your own account)
    try {
      const csrf = csrfToken();
      if (csrf) {
        const res = await fetch('https://www.linkedin.com/voyager/api/me', {
          headers: { 'csrf-token': csrf, accept: 'application/json', 'x-restli-protocol-version': '2.0.0' },
          credentials: 'include',
        });
        if (res.ok) {
          const data = await res.json();
          const mp = (data.included || []).find(x => x && (x.firstName || x.publicIdentifier)) ||
                     (data.data && data.data.miniProfile) || {};
          const name = [mp.firstName, mp.lastName].filter(Boolean).join(' ').trim();
          if (name) return { name, firstName: mp.firstName, lastName: mp.lastName, publicId: mp.publicIdentifier || '', occupation: mp.occupation || '', source: 'voyager' };
        }
      }
    } catch (_) { /* fall through to DOM */ }
    // Fallback: read the global-nav "Me" photo alt ("Photo of First Last")
    const photo = q(SEL.meNavPhoto);
    if (photo && photo.alt) {
      const name = photo.alt.replace(/^Photo of\s*/i, '').trim();
      if (name) return { name, source: 'dom' };
    }
    return null;
  }

  /* ---------- READ: scrape current profile ---------- */
  const isProfilePage = () => /\/in\//.test(location.pathname);
  function scrapeProfile() {
    const name = txt(SEL.profileName) || document.title.replace(/\s*[|(].*$/, '').trim();
    const [firstName, ...rest] = name.split(' ');
    return {
      firstName, lastName: rest.join(' '), fullName: name,
      headline: txt(SEL.profileHeadline), company: txt(SEL.profileCompany),
      position: txt(SEL.profileHeadline), location: txt(SEL.profileLocation),
      profileUrl: location.origin + location.pathname, source: 'linkedin-profile', capturedAt: Date.now(),
    };
  }

  /* ---------- ACT: execute one queued action ---------- */
  async function doAction(action) {
    await humanPause();
    const live = action && action.meta && action.meta.live === true;
    if (!live) return { ok: true, status: 'sent', info: 'simulated ' + action.type + ' (Live mode off)' };
    try {
      switch (action.type) {
        case ACTION.VIEW:    return { ok: true, status: 'sent', info: 'profile viewed' };
        case ACTION.FOLLOW:  return await clickFollow();
        case ACTION.CONNECT: return await sendConnect(action.payload && (action.payload.note || action.payload.body));
        case ACTION.MESSAGE: return await sendMessage(action.payload && action.payload.body);
        default: return { ok: false, info: action.type + ' executor not wired yet' };
      }
    } catch (e) { return { ok: false, info: e.message }; }
  }
  async function sendConnect(note) {
    let btn = q(SEL.connectBtn);
    if (!btn) { const more = q(SEL.moreBtn); if (more) { more.click(); await humanPause(); btn = q(SEL.connectBtn); } }
    if (!btn) return { ok: false, info: 'connect button not found' };
    btn.click(); await humanPause();
    if (note) { const add = q(SEL.addNoteBtn); if (add) { add.click(); await humanPause(); const ta = q(SEL.noteTextarea); if (ta) { setNativeValue(ta, String(note).slice(0, 300)); await humanPause(); } } }
    const sb = q(SEL.sendInviteBtn); if (sb) { sb.click(); return { ok: true, status: 'sent', info: 'invite sent' }; }
    return { ok: false, info: 'send button not found' };
  }
  async function sendMessage(body) {
    const mb = q(SEL.messageBtn); if (mb) { mb.click(); await humanPause(); }
    const box = q(SEL.messageBox); if (!box) return { ok: false, info: 'message box not found' };
    box.focus(); document.execCommand('insertText', false, body || ''); await humanPause();
    const sb = q(SEL.messageSendBtn); if (sb) { sb.click(); return { ok: true, status: 'sent', info: 'message sent' }; }
    return { ok: false, info: 'message send button not found' };
  }
  async function clickFollow() {
    const b = q(SEL.followBtn); if (!b) return { ok: false, info: 'follow button not found' };
    b.click(); return { ok: true, status: 'sent', info: 'followed' };
  }
  function setNativeValue(el, value) {
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    d && d.set && d.set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /* ---------- message handler from background ---------- */
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    (async () => {
      if (msg.type === TYPE.GET_IDENTITY) reply((await getLoggedInUser()) || { ok: false, info: 'not logged in' });
      else if (msg.type === TYPE.DO_ACTION) reply(await doAction(msg.action));
      else return; // not ours (salesnav.js may handle it)
    })();
    return true;
  });

  /* ---------- overlay: floating capture button ---------- */
  function injectOverlay() {
    if (q('#ros-overlay') || /\/sales\//.test(location.pathname)) return; // Sales Nav has its own banner
    const host = document.createElement('div');
    host.id = 'ros-overlay';
    host.innerHTML = '<button id="ros-capture" title="Capture this profile into RecruiterOS"><span class="ros-logo">R</span><span class="ros-label">Capture</span></button>';
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

  async function boot() {
    injectOverlay();
    const me = await getLoggedInUser();
    if (me) send({ type: TYPE.IDENTITY, identity: me });
  }
  if (document.readyState === 'complete') boot(); else window.addEventListener('load', boot);
  let lastPath = location.pathname;
  setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; injectOverlay(); } }, 1500);
})();
