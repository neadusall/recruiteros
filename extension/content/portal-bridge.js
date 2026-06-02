/* ============================================================
   Portal bridge — runs ONLY on the RecruiterOS web app origins.

   Lets the portal (1) detect that the extension is installed and
   (2) auto-configure it in one click — pushing the backend URL +
   ingest token straight into the extension, so the user never has
   to copy/paste anything.

   Page  →  window.postMessage({ source:'ros-portal', ... })  →  here
   here  →  chrome.runtime.sendMessage(...)                    →  background
   here  →  window.postMessage({ source:'ros-ext', ... })      →  page
   ============================================================ */
(function () {
  'use strict';
  if (window.__rosPortalBridge) return;            // guard against double-inject
  window.__rosPortalBridge = true;

  var EXT = 'ros-ext';      // messages FROM the extension to the page
  var PORTAL = 'ros-portal'; // messages FROM the page to the extension

  function announce(type, extra) {
    var msg = { source: EXT, type: type };
    if (extra) for (var k in extra) msg[k] = extra[k];
    try { window.postMessage(msg, window.location.origin); } catch (e) {}
  }
  function version() {
    try { return chrome.runtime.getManifest().version; } catch (e) { return ''; }
  }

  // Announce presence on load (so a portal already open lights up "installed ✓").
  announce('present', { version: version() });

  window.addEventListener('message', function (e) {
    // Only trust messages from THIS page, addressed to the extension.
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.source !== PORTAL) return;

    if (d.type === 'ping') {
      announce('present', { version: version() });
      return;
    }

    if (d.type === 'configure') {
      // The portal hands us its backend URL + ingest token; persist them as
      // settings. With both set, the agent polls the backend bridge directly.
      var settings = {
        backendBaseUrl: d.backendBaseUrl || '',
        backendApiKey: d.token || '',
        backendMotion: d.motion === 'bd' ? 'bd' : 'recruiting',
      };
      try {
        chrome.runtime.sendMessage({ type: 'ros.updateSettings', settings: settings }, function () {
          // Kick an immediate poll so a just-queued search runs without waiting
          // for the next alarm tick.
          try { chrome.runtime.sendMessage({ type: 'ros.pokeAgent' }, function () {}); } catch (e2) {}
          var err = chrome.runtime.lastError;
          announce('configured', { ok: !err, error: err ? err.message : undefined });
        });
      } catch (e3) {
        announce('configured', { ok: false, error: String(e3 && e3.message || e3) });
      }
      return;
    }
  });
})();
