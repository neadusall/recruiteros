/* Copies the static site (../*.html + ../assets) into public/ so Next serves
   the real pages alongside the API from one origin. Runs on prebuild.

   The OWNER CONSOLE is served at the clean URL /owner-console (rewritten to
   owner-console.html). The real lock is the owner-email API gate (requireOwner)
   on every /api/owner/* call — a logged-out or non-owner visitor just gets 403s
   and no data. We ALSO keep publishing it at the legacy private slug (from
   OWNER_CONSOLE_SLUG or .owner-console-slug) so old bookmarks keep working. */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.join(__dirname, '..'), pub = path.join(__dirname, 'public');
fs.mkdirSync(pub, { recursive: true });

const OWNER_FILE = 'owner-console.html';

function ownerSlug() {
  const fromEnv = (process.env.OWNER_CONSOLE_SLUG || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (fromEnv) return fromEnv;
  const f = path.join(__dirname, '.owner-console-slug');
  try { const s = fs.readFileSync(f, 'utf8').trim(); if (s) return s; } catch (e) {}
  const slug = 'owner-' + crypto.randomBytes(9).toString('hex'); // 18 hex chars, unguessable
  fs.writeFileSync(f, slug);
  return slug;
}
const slug = ownerSlug();

// Copy every page, including the owner console at its clean name (owner-console.html).
for (const f of fs.readdirSync(root)) {
  if (!f.endsWith('.html')) continue;
  fs.copyFileSync(path.join(root, f), path.join(pub, f));
}

// Drop stale random-slug copies from previous builds (keep the current one), then
// publish the console at the legacy private slug too, so old bookmarks still work.
for (const f of fs.readdirSync(pub)) {
  if (/^owner-[0-9a-f]+\.html$/.test(f) && f !== slug + '.html') {
    try { fs.unlinkSync(path.join(pub, f)); } catch (e) {}
  }
}
if (fs.existsSync(path.join(root, OWNER_FILE))) {
  fs.copyFileSync(path.join(root, OWNER_FILE), path.join(pub, slug + '.html'));
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
console.log('sync-public: OWNER CONSOLE -> /owner-console  (also /' + slug + '.html for old bookmarks)');
