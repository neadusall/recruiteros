/* ============================================================
   Single integration seam. Edit THIS file to embed the
   extension into a different outreach tool or repoint the
   backend. Nothing else needs to change.
   ============================================================ */
(function (g) {
  'use strict';
  g.ROS_CONFIG = {
    // Host outreach tool this extension reports to. Captured leads, scraped
    // datasets, and action results POST here. Leave '' to stay local-only.
    // For RecruitersOS this points at the live backend; paste your ingest token
    // from the app (Prospects -> 🔗 Connect extension) into backendApiKey.
    backendBaseUrl: 'https://recruitersos.co/api/linkedin',
    backendApiKey: '',             // paste your ext-token (sent as Authorization: Bearer <token>)

    // Real LinkedIn actions (clicks). OFF by default: actions are simulated
    // until you turn Live on in the popup AND selectors are confirmed.
    liveActions: false,

    // Safe-by-default daily caps (mirror the Alfred engine).
    dailyLimits: { connect: 20, message: 50, inmail: 10, view: 80, follow: 30, endorse: 20, like: 40 },

    // Human-like pacing between outreach actions (seconds) + working window.
    pacing: { minSeconds: 35, maxSeconds: 140 },
    workingHours: { start: 9, end: 18 },
    weekendsOff: true,

    // Sales Navigator scraping. Pacing is deliberately SLOW + randomized to look
    // human and stay well under LinkedIn's radar (account safety > speed).
    scrape: {
      pageDelayMin: 20000,         // dwell 20–50s on each page (randomized), reading
      pageDelayMax: 50000,         //   + gentle scrolling, before moving to the next
      defaultMaxPages: 40,         // 25 leads/page -> up to 1000 leads per run
      hardMaxPages: 100,           // LinkedIn caps Sales Nav search near 2500 results
    },

    // Browser-execution bridge (closes the backend -> browser seam).
    // The backend's internalProvider posts actions to the bridge; this
    // extension drains them. Set the URL/token, the account id, and enable
    // it in the popup Settings (or here).
    bridge: {
      url: 'http://localhost:8787',   // where bridge/outreach-bridge.cjs runs
      token: 'dev-outreach-token',    // must match the bridge AGENT_TOKEN
    },

    tickMinutes: 1,
    brand: { name: 'RecruitersOS Outreach', accent: '#7c5cff' },
  };
})(typeof self !== 'undefined' ? self : this);
