/* Copies the static site (../*.html + ../assets) into public/ so Next serves
   the real pages alongside the API from one origin. Runs on prebuild.

   The OWNER CONSOLE is special: it is NEVER served at a guessable path. Instead
   it is published only at a private, unguessable slug (from OWNER_CONSOLE_SLUG,
   or a stable random one persisted to .owner-console-slug). So the owner reaches
   it at /<slug>.html and nobody else can find it; the owner-email API gate is the
   second lock. */
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

// Copy every page EXCEPT the owner console (which must not exist at a known name).
for (const f of fs.readdirSync(root)) {
  if (!f.endsWith('.html') || f === OWNER_FILE) continue;
  fs.copyFileSync(path.join(root, f), path.join(pub, f));
}

// Scrub any stale/guessable owner-console copy + any previous slug page, then
// publish the console only at the current secret slug.
for (const f of fs.readdirSync(pub)) {
  if (f === OWNER_FILE || (/^owner-[0-9a-f]+\.html$/.test(f) && f !== slug + '.html')) {
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
console.log('sync-public: OWNER CONSOLE (private) -> /' + slug + '.html');
