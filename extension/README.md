# RecruitersOS Outreach — Chrome Extension (wireframe)

A Manifest V3 Chrome extension that does what the MeetAlfred extension does:
**capture LinkedIn profiles** and **perform outreach actions from the user's own
browser session** (connect / message / follow / view…), paced by safe daily caps.

It is built as a **host-agnostic wireframe**. The extension owns the queue, the
scheduler, the safety limiter, and the LinkedIn DOM layer. Your existing outreach
tool plugs in through **one message API** and **one adapter file** — no need to read
the internals.

> ⚠️ **Safe by default.** The content script ships with `SAFE_MODE = true`: actions
> are *simulated* (no real clicks) so you can wire and test the whole pipeline with
> zero account risk. Real automation requires you to fill in LinkedIn selectors and
> flip the flag — and to respect LinkedIn's Terms of Service and the daily caps.

---

## Load it (unpacked)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this `extension/` folder
3. Copy the generated **Extension ID** (you'll need it for the bridge)
4. Open **linkedin.com**, log in. A floating **“Capture”** button appears bottom-right.
5. Click the toolbar icon → the **popup** shows connection status, queue, daily-cap
   meters, and settings. Hit **Start** to let the worker drain the queue.

---

## How it fits together

```
 ┌─────────────────────────┐   ros.* messages   ┌──────────────────────┐
 │  Host outreach tool      │ ◀───────────────▶ │  background.js (SW)   │
 │  (RecruitersOS Studio,    │                    │  queue · limiter ·   │
 │   or any other tool)     │   alfred-bridge.js │  scheduler · relay   │
 │  + Alfred engine         │                    └─────────┬────────────┘
 └─────────────────────────┘                              │ chrome.tabs
                                                           ▼
                                              ┌──────────────────────────┐
                                              │ content/linkedin.js      │
                                              │ scrape + act on the page │
                                              └──────────────────────────┘
```

### Files
| File | Role |
|---|---|
| `manifest.json` | MV3 config, permissions, `externally_connectable` (host origins) |
| `config.js` | **The seam to edit** — backend URL, daily caps, pacing, hours |
| `lib/messaging.js` | The shared message protocol (`ROS.TYPE`, action shape) |
| `lib/limiter.js` | Daily caps, working hours, weekend pause, human-like gaps |
| `lib/alfred-bridge.js` | **Drop-in Alfred channel adapter** for the host tool |
| `background.js` | Queue, counters, tick alarm, dispatch, backend relay |
| `content/linkedin.js` | Profile scrape, action executors, capture overlay (`SAFE_MODE`) |
| `popup/*` | Control panel: status, queue, cap meters, settings |

---

## Integrating into an existing tool — two paths

### A. You run the Alfred engine (recommended)
The engine in `../assets/js/alfred/alfred-core.js` already models sequences, limits,
warm-up, and the connect→accept→message rule. Make the **extension** its LinkedIn sender:

```html
<script src="/assets/js/alfred/alfred-core.js"></script>
<script src="/extension/lib/alfred-bridge.js"></script>
<script>
  const engine = Alfred.Engine({ seed: 1 });
  engine.setAdapter('linkedin', AlfredExtensionBridge({
    extensionId: 'YOUR_UNPACKED_EXTENSION_ID',   // from chrome://extensions
    mode: 'queue',                                // or 'direct' for one-off sends
  }));
  // engine.enroll(...) then engine.tick() → real LinkedIn actions, safely paced.
</script>
```
Add your tool's origin to `manifest.json → externally_connectable.matches`.

### B. You have your own engine / tool
Talk to the extension directly with the message API. Every call is
`chrome.runtime.sendMessage(extensionId, { type, ... })`:

| `type` | Payload | Returns |
|---|---|---|
| `ros.ping` | — | `{ ok, version, account, connected }` |
| `ros.getState` | — | `{ state: { queue, counts, settings, done } }` |
| `ros.enqueue` | `{ action }` | `{ ok, queued }` |
| `ros.enqueueBatch` | `{ actions:[] }` | `{ ok, queued }` |
| `ros.setRunning` | `{ running }` | `{ ok, running }` |
| `ros.updateSettings` | `{ settings }` | `{ ok }` |
| `ros.clearQueue` | — | `{ ok }` |

**Action shape** (what you enqueue):
```js
{ type: 'connect',                 // view|follow|endorse|connect|message|inmail|like
  target: { profileUrl, name },
  payload: { note, subject, body } // already personalized
}
```

Captured leads and action results are **relayed to your backend** if you set
`config.js → backendBaseUrl` (POSTed as `POST <base>/captureLead`, `POST <base>/actionResult`).
The Next.js scaffold in `../integration/` already exposes matching routes.

---

## Going live (checklist)
1. Update the selectors in `content/linkedin.js → SEL` (LinkedIn changes them often).
2. Set `SAFE_MODE = false` in `content/linkedin.js`.
3. Keep `config.js` caps conservative; warm new accounts up gradually.
4. Add real toolbar icons under `icons/` (`icon16/48/128.png`) and reference them in
   `manifest.json` (optional — Chrome shows a default otherwise).
5. Confirm your host origin is in `externally_connectable`.

**Compliance:** automating LinkedIn can violate its ToS and risk the account. Use only
for the account owner's own authorized outreach, keep volumes human, and honor opt-outs.
