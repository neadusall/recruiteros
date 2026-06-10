/* ============================================================
   Tiny zero-dependency static server for the RecruiterOS portal.
   Serving over http://localhost lets the Outreach Studio reach the
   browser extension (file:// cannot — see manifest externally_connectable).

   Run:  node server.cjs        (or use START-STUDIO.ps1)
   Then: http://localhost:5173/alfred.html
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 5173;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json', '.yaml': 'text/yaml',
};

// Clean-URL aliases that map to a shared file. The Admin and Recruiter portals
// are the SAME app (command.html); command.js reads the path to pick which
// portal to render. Mirrors the rewrites in integration/next.config.js.
const ALIASES = { '/admin': '/command.html', '/recruiter': '/command.html' };

// Resolve a URL path to a file on disk. Supports clean URLs (e.g. /alfred ->
// alfred.html) so the portal's extensionless nav links work locally, just like
// they will once deployed behind a host that rewrites clean URLs.
function resolveFile(urlPath, cb) {
  if (ALIASES[urlPath]) urlPath = ALIASES[urlPath];
  const base = path.normalize(path.join(ROOT, urlPath));
  if (!base.startsWith(ROOT)) return cb(null);
  const candidates = path.extname(base)
    ? [base]                                   // already has an extension
    : [base, base + '.html', path.join(base, 'index.html')];
  let i = 0;
  (function next() {
    if (i >= candidates.length) return cb(null);
    const p = candidates[i++];
    fs.stat(p, (err, st) => (!err && st.isFile()) ? cb(p) : next());
  })();
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  resolveFile(urlPath, (filePath) => {
    if (!filePath) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found: ' + urlPath); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log('\n  RecruiterOS portal serving at:');
  console.log('   → http://localhost:' + PORT + '/alfred.html   (Outreach Studio)');
  console.log('   → http://localhost:' + PORT + '/app.html      (Command Center)');
  console.log('\n  Opened over localhost so the Studio can talk to the browser extension.');
  console.log('  Stop with Ctrl+C.\n');
});
