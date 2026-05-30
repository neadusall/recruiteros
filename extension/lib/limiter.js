/* ============================================================
   Client-side safety limiter for the extension worker.
   Same rules as the Alfred engine (daily caps, working hours,
   weekend pause, human-like pacing) so browser-driven actions
   stay within safe bounds even if the host queues too much.
   ============================================================ */
(function (g) {
  'use strict';

  function dateKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function isWeekend(ts) { const d = new Date(ts).getDay(); return d === 0 || d === 6; }

  function Limiter(cfg) {
    cfg = cfg || {};
    const limits = cfg.dailyLimits || {};
    const wh = cfg.workingHours || { start: 9, end: 18 };
    const weekendsOff = cfg.weekendsOff !== false;
    const pacing = cfg.pacing || { minSeconds: 35, maxSeconds: 140 };

    return {
      dateKey, isWeekend,
      // counts: { 'YYYY-MM-DD|action': n }
      remaining(counts, action, now) {
        const cap = limits[action];
        if (cap == null) return Infinity;
        return Math.max(0, cap - (counts[dateKey(now) + '|' + action] || 0));
      },
      withinWorkingWindow(now) {
        if (weekendsOff && isWeekend(now)) return false;
        const h = new Date(now).getHours();
        return h >= wh.start && h < wh.end;
      },
      // next timestamp an action may run (defers past nights/weekends)
      nextAllowed(now) {
        let t = now;
        for (let i = 0; i < 14; i++) {
          const d = new Date(t), h = d.getHours();
          if (weekendsOff && isWeekend(t)) { d.setDate(d.getDate() + 1); d.setHours(wh.start, 0, 0, 0); t = d.getTime(); continue; }
          if (h < wh.start) { d.setHours(wh.start, 0, 0, 0); return d.getTime(); }
          if (h >= wh.end) { d.setDate(d.getDate() + 1); d.setHours(wh.start, 0, 0, 0); t = d.getTime(); continue; }
          return t;
        }
        return t;
      },
      // random human-like gap before the next action (ms)
      nextGapMs() {
        const span = pacing.maxSeconds - pacing.minSeconds;
        return (pacing.minSeconds + Math.random() * span) * 1000;
      },
    };
  }

  g.ROS_Limiter = Limiter;
})(typeof self !== 'undefined' ? self : this);
