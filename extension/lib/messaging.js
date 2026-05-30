/* ============================================================
   Shared message protocol — the integration contract.
   Loaded in BOTH the content script (window scope) and the
   service worker (self scope, via importScripts). Defines the
   message types every layer agrees on, so a host outreach tool
   can talk to this extension without reading any other file.
   ============================================================ */
(function (g) {
  'use strict';

  // Message types. Direction noted as: who SENDS → who HANDLES.
  const TYPE = {
    // host page / popup → background
    PING:            'ros.ping',             // health check → { ok, version, account }
    GET_STATE:       'ros.getState',         // → { queue, counts, settings, connected }
    UPDATE_SETTINGS: 'ros.updateSettings',   // { settings }
    ENQUEUE:         'ros.enqueue',          // { action } push one action onto the queue
    ENQUEUE_BATCH:   'ros.enqueueBatch',     // { actions:[] }
    SET_RUNNING:     'ros.setRunning',       // { running:boolean }
    CLEAR_QUEUE:     'ros.clearQueue',

    // background → content script (active LinkedIn tab)
    SCRAPE_PROFILE:  'ros.scrapeProfile',    // → ProfileRecord
    SCRAPE_SEARCH:   'ros.scrapeSearch',     // → ProfileRecord[]
    DO_ACTION:       'ros.doAction',         // { action } → ActionResult

    // content script → background / host (events)
    CAPTURE_LEAD:    'ros.captureLead',      // user clicked "capture" overlay → ProfileRecord
    ACTION_RESULT:   'ros.actionResult',     // { action, result }
    LOG:             'ros.log',              // { level, msg }
  };

  // Canonical action shape the engine/adapter emit and the content script executes.
  //   { id, type, channel:'linkedin', target:{ profileUrl, name }, payload:{ note?, subject?, body? }, meta:{} }
  const CHANNEL = 'linkedin';

  // LinkedIn action verbs supported by the content script (maps 1:1 to Alfred engine).
  const ACTION = {
    VIEW: 'view', FOLLOW: 'follow', ENDORSE: 'endorse',
    CONNECT: 'connect', MESSAGE: 'message', INMAIL: 'inmail', LIKE: 'like',
  };

  function makeAction(type, target, payload, meta) {
    return {
      id: 'act_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
      type, channel: CHANNEL,
      target: target || {}, payload: payload || {}, meta: meta || {},
      status: 'queued', createdAt: Date.now(),
    };
  }

  // Promise wrapper over chrome.runtime.sendMessage (works in popup + content).
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res);
        });
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
  }

  g.ROS = { TYPE, ACTION, CHANNEL, makeAction, send, VERSION: '0.1.0' };
})(typeof self !== 'undefined' ? self : this);
