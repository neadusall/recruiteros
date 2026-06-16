/* Fast local preview loop — the speed fix for "edit -> push -> deploy -> refresh".
 *
 * Run `node dev.cjs` (or `npm run dev:fast`) from the integration/ folder. It:
 *   1) syncs the static site (root *.html + ../assets) into public/ once,
 *   2) re-syncs automatically whenever you edit ../assets or a root *.html,
 *   3) starts `next dev` on http://localhost:3000.
 *
 * So the loop becomes: edit a file -> it re-syncs in ~200ms -> refresh the browser.
 * No GitHub push, no deploy, no server restart, no session drop. Push to main ONLY
 * once a batch is confirmed working locally.
 */
const { spawn, execFileSync } = require("child_process");
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");

function sync(reason) {
  try {
    execFileSync(process.execPath, ["sync-public.cjs"], { cwd: __dirname, stdio: "ignore" });
    console.log("[dev] synced" + (reason ? " (" + reason + ")" : ""));
  } catch (e) { console.error("[dev] sync failed:", e.message); }
}

sync("startup");

let timer = null;
function debouncedSync(file) {
  clearTimeout(timer);
  timer = setTimeout(() => sync(file), 200);
}

// Watch the source assets folder (recursive) + every root-level .html page.
try { fs.watch(path.join(root, "assets"), { recursive: true }, (_e, f) => debouncedSync("assets/" + f)); } catch (e) {}
for (const f of fs.readdirSync(root)) {
  if (!f.endsWith(".html")) continue;
  try { fs.watch(path.join(root, f), () => debouncedSync(f)); } catch (e) {}
}

console.log("[dev] watching ../assets + root *.html — edits re-sync automatically");
console.log("[dev] starting next dev on http://localhost:3000 …");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(npm, ["run", "dev"], { cwd: __dirname, stdio: "inherit" });
child.on("exit", (code) => process.exit(code || 0));
process.on("SIGINT", () => { try { child.kill("SIGINT"); } catch (e) {} process.exit(0); });
