/* ============================================================
   Single integration seam — edit THIS file to embed the
   extension into a different outreach tool. Nothing else
   needs to change to repoint it at another host/backend.
   ============================================================ */
(function (g) {
  'use strict';
  g.ROS_CONFIG = {
    // The host outreach tool this extension reports to. The background worker
    // POSTs captured leads + action results here (leave '' to stay local-only).
    backendBaseUrl: '',            // e.g. 'http://localhost:3000/api/linkedin'
    backendApiKey: '',             // sent as `Authorization: Bearer <key>`

    // Safe-by-default daily caps (mirrors the Alfred engine defaults).
    dailyLimits: { connect: 20, message: 50, inmail: 10, view: 80, follow: 30, endorse: 20, like: 40 },

    // Human-like pacing between actions (seconds) + working window (24h, local).
    pacing: { minSeconds: 35, maxSeconds: 140 },
    workingHours: { start: 9, end: 18 },
    weekendsOff: true,

    // How often the worker wakes to drain the queue (minutes).
    tickMinutes: 1,

    brand: { name: 'RecruiterOS Outreach', accent: '#7c5cff' },
  };
})(typeof self !== 'undefined' ? self : this);
