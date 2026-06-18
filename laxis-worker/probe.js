/**
 * Calibration probe runner. Logs into Laxis, opens prospect-search, and writes a
 * full-page screenshot + an element inventory to LAXIS_PROBE_DIR (default /data), so the
 * selectors in laxis-flow.js can be pinned to the real UI. Run on the server:
 *
 *   docker compose exec laxis-worker node probe.js
 *
 * Then pull /data/laxis-prospect-search.png + /data/laxis-inventory.json off the volume.
 */
"use strict";

const { probe } = require("./laxis-flow");

probe({ log: (l) => console.log(l) })
  .then((inv) => { console.log(JSON.stringify(inv, null, 2)); process.exit(0); })
  .catch((err) => { console.error("probe failed:", err.message); process.exit(1); });
