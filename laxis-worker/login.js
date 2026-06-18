/**
 * One-shot: log into Laxis and persist the session to LAXIS_STATE_PATH, without
 * running a job. Use this to seed (or re-seed) the cookie store after a password
 * change or session expiry, or to verify creds + selectors are right:
 *
 *   docker compose run --rm laxis-worker node login.js          # headless on the server
 *   LAXIS_HEADED=1 npm run login                                # watch it locally
 */
"use strict";

const { warmLogin } = require("./laxis-flow");

warmLogin({ log: (l) => console.log(l) })
  .then(() => { console.log("laxis: session ready"); process.exit(0); })
  .catch((err) => { console.error("laxis login failed:", err.message); process.exit(1); });
