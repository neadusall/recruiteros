/* Copies the static site (../*.html + ../assets) into public/ so Next serves
   the real pages alongside the API from one origin. Runs on prebuild.

   The OWNER CONSOLE is served at a single clean URL: /owner-console (rewritten
   to owner-console.html). The real lock is the owner-email API gate (requireOwner)
   on every /api/owner/* call — a logged-out or non-owner visitor just gets 403s
   and no data. /api/owner/enter is the gated doorway that forwards owners here. */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
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

// Cache-busting: stamp every local JS/CSS asset reference in the copied HTML with a
// short content hash (?v=…). The hash only changes when the file's bytes change, so
// browsers re-fetch exactly when an asset is updated and keep caching otherwise.
// Without this, command.js is cached indefinitely and UI changes don't appear post-deploy.
function assetHash(ref) {
  try { return crypto.createHash('md5').update(fs.readFileSync(path.join(pub, ref))).digest('hex').slice(0, 10); }
  catch (e) { return ''; }
}
let stamped = 0;
for (const f of fs.readdirSync(pub)) {
  if (!f.endsWith('.html')) continue;
  const p = path.join(pub, f);
  let html = fs.readFileSync(p, 'utf8');
  const next = html.replace(/(assets\/[\w./-]+\.(?:js|css))(?:\?v=[a-f0-9]+)?/g, (m, ref) => {
    const h = assetHash(ref);
    return h ? ref + '?v=' + h : ref;
  });
  if (next !== html) { fs.writeFileSync(p, next); stamped++; }
}

console.log('sync-public: pages + assets copied into integration/public (cache-busted ' + stamped + ' page(s))');
console.log('sync-public: OWNER CONSOLE -> /owner-console (single clean URL)');
