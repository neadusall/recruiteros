/* ============================================================
   RosBackend, portal client for the RecruiterOS Next.js backend
   (the integration/ OS). Session-authenticated: the portal runs in
   the same browser the user logged into, so same-origin fetches carry
   the ros_session cookie.

   Reaches these backend routes (see integration/app/api):
     GET  /api/auth/session      who am I / workspace
     GET  /api/accounts          connected LinkedIn accounts (+ quotas, warmup)
     POST /api/prospects         add leads (single or { action:'bulk', rows:[] })
     POST /api/campaigns         create a campaign
     GET  /api/response/list     unified inbox

   Degrades gracefully: if the backend is not running or the user is
   not signed in, env()/calls return { ok:false, info } and the UI
   explains how to connect. Base URL is configurable (default '' =
   same origin; set it when the portal and backend are on different
   hosts and the backend allows that origin via CORS).
   ============================================================ */
(function (g) {
  'use strict';
  const LS_BASE = 'alfred:studio:backendBase';
  let base = '';
  try { base = localStorage.getItem(LS_BASE) || ''; } catch (_) {}

  function url(path) { return (base.replace(/\/$/, '')) + path; }

  async function req(path, opts) {
    opts = opts || {};
    try {
      const res = await fetch(url(path), {
        method: opts.method || 'GET',
        credentials: 'include',
        headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      let data = null;
      try { data = await res.json(); } catch (_) {}
      if (res.status === 401) return { ok: false, status: 401, info: 'Not signed in to RecruiterOS. Open the portal logged in (or sign in at /api/auth/login).' };
      if (!res.ok) return { ok: false, status: res.status, info: (data && data.error) || ('HTTP ' + res.status) };
      return { ok: true, status: res.status, data };
    } catch (e) {
      return { ok: false, info: 'Backend not reachable (' + e.message + '). Is the Next.js app running, and is this origin allowed?' };
    }
  }

  let cachedSession = null;
  g.RosBackend = {
    getBase: () => base,
    setBase(b) { base = (b || '').trim(); try { localStorage.setItem(LS_BASE, base); } catch (_) {} },
    async session() {
      const r = await req('/api/auth/session');
      if (r.ok && r.data && (r.data.user || r.data.workspace)) { cachedSession = r.data; return r; }
      // Fall back to the portal's local session (set by login + local-backend shim),
      // so the Backend tab connects standalone without the Next server running.
      try {
        const raw = (typeof localStorage !== 'undefined') && (localStorage.getItem('ros_ctx') || localStorage.getItem('ros_session'));
        if (raw) {
          const ctx = JSON.parse(raw);
          const data = { user: ctx.user || (ctx.email ? ctx : null), workspace: ctx.workspace || (ctx.workspaceName ? { name: ctx.workspaceName } : null) };
          if (data.user || data.workspace) { cachedSession = data; return { ok: true, status: 200, data }; }
        }
      } catch (_) {}
      cachedSession = null; return r;
    },
    isAuthed: () => !!cachedSession,
    accounts: () => req('/api/accounts'),
    responses: () => req('/api/response/list'),
    campaigns: () => req('/api/campaigns'),
    createCampaign: (payload) => req('/api/campaigns', { method: 'POST', body: payload }),
    addProspect: (row) => req('/api/prospects', { method: 'POST', body: row }),
    addProspectsBulk: (rows) => req('/api/prospects', { method: 'POST', body: { action: 'bulk', rows } }),
    // map a scraped Sales Nav record -> the backend's NewProspectInput
    toProspectRow(rec, campaignId) {
      return {
        campaignId: campaignId || undefined,
        fullName: rec.fullName,
        firstName: rec.firstName || (rec.fullName || '').split(' ')[0],
        company: rec.company || '',
        title: rec.title || rec.headline || '',
        linkedinUrl: rec.profileUrl || rec.salesNavUrl || '',
        email: rec.email || undefined,
      };
    },
  };
})(typeof self !== 'undefined' ? self : this);
