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
    backendBaseUrl: '',            // e.g. 'http://localhost:5173/api/linkedin'
    backendApiKey: '',             // sent as Authorization: Bearer <key>

    // Real LinkedIn actions (clicks). OFF by default: actions are simulated
    // until you turn Live on in the popup AND selectors are confirmed.
    liveActions: false,

    // Safe-by-default daily caps (mirror the Alfred engine).
    dailyLimits: { connect: 20, message: 50, inmail: 10, view: 80, follow: 30, endorse: 20, like: 40 },

    // Human-like pacing between outreach actions (seconds) + working window.
    pacing: { minSeconds: 35, maxSeconds: 140 },
    workingHours: { start: 9, end: 18 },
    weekendsOff: true,

    // Sales Navigator scraping.
    scrape: {
      pageDelayMin: 1200,          // ms between pages (jitter added) — keep humane
      pageDelayMax: 3200,
      defaultMaxPages: 10,         // 25 leads/page -> 250 leads; raise as needed
      hardMaxPages: 100,           // LinkedIn caps Sales Nav search near 2500 results
    },

    tickMinutes: 1,
    brand: { name: 'RecruiterOS Outreach', accent: '#7c5cff' },
  };
})(typeof self !== 'undefined' ? self : this);
