/* Copies the static site (../*.html + ../assets) into public/ so Next serves
   the real pages alongside the API from one origin. Runs on prebuild.

   The OWNER CONSOLE is served at a single clean URL: /owner-console (rewritten
   to owner-console.html). The real lock is the owner-email API gate (requireOwner)
   on every /api/owner/* call — a logged-out or non-owner visitor just gets 403s
   and no data. /api/owner/enter is the gated doorway that forwards owners here. */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), pub = path.join(__dirname, 'public');
fs.mkdirSync(pub, { recursive: true });

// Copy every page, including the owner console at its clean name (owner-console.html).
for (const f of fs.readdirSync(root)) {
  if (!f.endsWith('.html')) continue;
  fs.copyFileSync(path.join(root, f), path.join(pub, f));
}

// Sweep out any legacy random-slug owner-console copies from older builds, so the
// console is reachable ONLY at /owner-console (no lingering unguessable aliases).
for (const f of fs.readdirSync(pub)) {
  if (/^owner-[0-9a-f]+\.html$/.test(f)) {
    try { fs.unlinkSync(path.join(pub, f)); } catch (e) {}
  }
}

function cpdir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) cpdir(s, d); else fs.copyFileSync(s, d);
  }
}
if (fs.existsSync(path.join(root, 'assets'))) cpdir(path.join(root, 'assets'), path.join(pub, 'assets'));
console.log('sync-public: pages + assets copied into integration/public');
console.log('sync-public: OWNER CONSOLE -> /owner-console (single clean URL)');
