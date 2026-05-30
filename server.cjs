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

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // prevent path traversal
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found: ' + urlPath); }
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
