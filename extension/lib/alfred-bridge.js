/* ============================================================
   Alfred ⇆ Extension bridge — THE integration seam.

   Load this in the HOST outreach tool (the web page running the
   Alfred engine — e.g. RecruiterOS's Studio, or any other tool).
   It returns a LinkedIn channel adapter that satisfies the exact
   Alfred adapter interface:  { id, label, supports, connect, execute }
   …but instead of simulating, it forwards each action to THIS
   extension, which drives the user's real LinkedIn tab.

   Usage in the host tool:
     <script src=".../alfred-core.js"></script>
     <script src=".../alfred-bridge.js"></script>
     const engine = Alfred.Engine({ seed: 1 });
     engine.setAdapter('linkedin',
       AlfredExtensionBridge({ extensionId: 'YOUR_UNPACKED_EXT_ID' }));
     // now engine.tick() sends real LinkedIn actions through the extension.

   The host page's origin must be listed in the extension manifest's
   `externally_connectable.matches`.
   ============================================================ */
(function (g) {
  'use strict';

  // Mirror of messaging.js TYPE (kept inline so the host needs only this file).
  const TYPE = {
    PING: 'ros.ping', DO_ACTION: 'ros.doAction', ENQUEUE: 'ros.enqueue',
    GET_STATE: 'ros.getState', SET_RUNNING: 'ros.setRunning',
  };

  function call(extensionId, msg) {
    return new Promise((resolve) => {
      if (!(g.chrome && chrome.runtime && chrome.runtime.sendMessage)) {
        return resolve({ ok: false, info: 'chrome.runtime unavailable — not in a Chromium browser with the extension installed' });
      }
      try {
        chrome.runtime.sendMessage(extensionId, msg, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, info: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, info: 'no response' });
        });
      } catch (e) { resolve({ ok: false, info: e.message }); }
    });
  }

  /* Map an Alfred action → the extension's action shape. */
  function toExtAction(action, ctx) {
    const lead = ctx.lead || {};
    return {
      type: action.type,                       // view|follow|connect|message|inmail|like
      channel: 'linkedin',
      target: { profileUrl: lead.profileUrl, name: lead.fullName },
      payload: { note: action.note, subject: action.subject, body: action.body },
      meta: { leadId: lead.id, accountId: ctx.account && ctx.account.id },
    };
  }

  /* The adapter. `mode`:
       'queue'  (default) — push to the extension queue; it paces & drains itself
                            respecting its own limiter. Returns ok immediately.
       'direct' — ask the content script to perform the action right now and wait
                  for the real result (use for one-off, user-initiated sends). */
  function AlfredExtensionBridge(opts) {
    opts = opts || {};
    const extensionId = opts.extensionId || null;   // null = same-extension context
    const mode = opts.mode || 'queue';

    return {
      id: 'linkedin-extension',
      label: 'LinkedIn (browser extension)',
      supports: (channel) => channel === 'linkedin',
      async connect() {
        const res = await call(extensionId, { type: TYPE.PING });
        return res && res.ok
          ? { ok: true, status: 'connected', info: 'Extension v' + res.version + (res.account ? ' · ' + res.account.name : '') }
          : { ok: false, status: 'unconfigured', info: (res && res.info) || 'Extension not reachable' };
      },
      // Alfred engine calls execute(action, ctx) and uses the returned result.
      async execute(action, ctx) {
        const extAction = toExtAction(action, ctx);
        if (mode === 'direct') {
          const res = await call(extensionId, { type: TYPE.DO_ACTION, action: extAction });
          return normalize(res, action);
        }
        const res = await call(extensionId, { type: TYPE.ENQUEUE, action: extAction });
        // queued: report optimistic success; real outcome flows back via the
        // extension's backend relay / webhook the host already listens on.
        return res && res.ok
          ? { ok: true, status: 'sent', info: 'queued in extension (#' + res.queued + ')' }
          : { ok: false, status: 'failed', info: (res && res.info) || 'enqueue failed' };
      },
      // convenience passthroughs for the host UI
      ping: () => call(extensionId, { type: TYPE.PING }),
      getState: () => call(extensionId, { type: TYPE.GET_STATE }),
      setRunning: (running) => call(extensionId, { type: TYPE.SET_RUNNING, running }),
    };
  }
  function normalize(res, action) {
    if (!res) return { ok: false, status: 'failed', info: 'no response' };
    // connection requests open a relationship; the engine watches for accept later
    const opensRel = action.type === 'connect';
    return { ok: !!res.ok, status: res.ok ? (res.status || 'sent') : 'failed', info: res.info, opensRelationship: opensRel };
  }

  g.AlfredExtensionBridge = AlfredExtensionBridge;
  if (typeof module === 'object' && module.exports) module.exports = AlfredExtensionBridge;
})(typeof self !== 'undefined' ? self : this);
