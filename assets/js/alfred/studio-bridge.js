/* ============================================================
   Studio ⇆ Extension bridge (portal side).
   Lets the RecruiterOS portal drive the browser extension:
   connect the real LinkedIn account, kick off Sales Navigator
   scrapes, pull datasets, and route outreach through the user's
   own session.

   Reaching the extension requires:
     • a Chromium browser with the extension loaded, AND
     • the portal served from an allowed origin (http://localhost or
       *.recruitersos.co, see manifest externally_connectable).
   Opened from file:// it degrades gracefully (env().canReach=false)
   and the UI explains how to enable it.
   ============================================================ */
(function (g) {
  'use strict';
  const LS_ID = 'alfred:studio:extId';
  const TYPE = {
    PING: 'ros.ping', GET_STATE: 'ros.getState', CONNECT_ACCOUNT: 'ros.connectAccount',
    SET_LIVE: 'ros.setLive', SCRAPE_START: 'ros.scrapeStart',
    GET_DATASETS: 'ros.getDatasets', GET_DATASET: 'ros.getDataset', EXPORT_CSV: 'ros.exportCsv',
  };

  let extId = '';
  try { extId = localStorage.getItem(LS_ID) || ''; } catch (_) {}

  function env() {
    const hasChrome = !!(g.chrome && g.chrome.runtime && g.chrome.runtime.sendMessage);
    const proto = (g.location && g.location.protocol) || '';
    const okOrigin = proto === 'http:' || proto === 'https:';
    if (!hasChrome) return { canReach: false, reason: proto === 'file:' ? 'Open the portal at http://localhost (run START-STUDIO.ps1), not from a file. Then load the extension.' : 'No Chromium extension API found. Use Chrome/Edge with the RecruiterOS extension installed.' };
    if (!okOrigin) return { canReach: false, reason: 'Serve the portal over http(s) so it can reach the extension.' };
    if (!extId) return { canReach: false, reason: 'Paste the extension ID from chrome://extensions.' };
    return { canReach: true };
  }

  function call(msg) {
    return new Promise((resolve) => {
      const e = env();
      if (!e.canReach) return resolve({ ok: false, info: e.reason });
      try {
        g.chrome.runtime.sendMessage(extId, msg, (res) => {
          if (g.chrome.runtime.lastError) resolve({ ok: false, info: g.chrome.runtime.lastError.message + ' (is the extension ID correct and the portal origin allowed?)' });
          else resolve(res || { ok: false, info: 'no response' });
        });
      } catch (err) { resolve({ ok: false, info: err.message }); }
    });
  }

  g.StudioExt = {
    env,
    getExtId: () => extId,
    setExtId(id) { extId = (id || '').trim(); try { localStorage.setItem(LS_ID, extId); } catch (_) {} },
    ping: () => call({ type: TYPE.PING }),
    getState: () => call({ type: TYPE.GET_STATE }),
    connectAccount: () => call({ type: TYPE.CONNECT_ACCOUNT }),
    setLive: (live) => call({ type: TYPE.SET_LIVE, live: !!live }),
    startScrape: (url, name, maxPages) => call({ type: TYPE.SCRAPE_START, url, name, maxPages }),
    getDatasets: () => call({ type: TYPE.GET_DATASETS }),
    getDataset: (id) => call({ type: TYPE.GET_DATASET, id }),
    exportCsv: (id) => call({ type: TYPE.EXPORT_CSV, id }),
  };
})(typeof self !== 'undefined' ? self : this);
