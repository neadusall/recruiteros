/* Copies the static site (../*.html + ../assets) into public/ so Next serves
   the real pages alongside the API from one origin. Runs on prebuild. */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), pub = path.join(__dirname, 'public');
fs.mkdirSync(pub, { recursive: true });
for (const f of fs.readdirSync(root)) {
  if (f.endsWith('.html')) fs.copyFileSync(path.join(root, f), path.join(pub, f));
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
