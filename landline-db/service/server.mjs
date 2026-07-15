// LandlineDB standalone service: Postgres-backed API + live explorer.
// Isolated from the main app. Serves at whatever path Caddy routes here.
// Env: LANDLINEDB_URL, PORT (default 8090), BASE_PATH (default /client/data)
import http from 'node:http';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const PORT = parseInt(process.env.PORT || '8090', 10);
const BASE = process.env.BASE_PATH || '/client/data';
const pool = new pg.Pool({ connectionString: process.env.LANDLINEDB_URL || 'postgres://recruiteros@db:5432/landlinedb', max: 8 });

const HTML = readFileSync(new URL('./app.html', import.meta.url), 'utf8');

// aggregate stats cached for 60s (cheap resilience under load)
let statCache = null, statAt = 0;
async function stats() {
  if (statCache && Date.now() - statAt < 60000) return statCache;
  const [t, s] = await Promise.all([
    pool.query(`SELECT count(*) records, count(DISTINCT phone_e164) unique_phones,
      count(*) FILTER (WHERE person IS NOT NULL) person_linked,
      count(*) FILTER (WHERE phone_e164 IS NOT NULL) with_landline,
      count(*) FILTER (WHERE cell_e164 IS NOT NULL) with_cell,
      count(*) FILTER (WHERE email IS NOT NULL) with_email,
      count(DISTINCT state) states FROM records`),
    pool.query(`SELECT source_id, min(source) source, count(*) n FROM records GROUP BY source_id ORDER BY n DESC`),
  ]);
  const bySource = {}, sourceNames = {};
  s.rows.forEach(r => { bySource[r.source_id] = Number(r.n); sourceNames[r.source_id] = r.source; });
  const tr = t.rows[0];
  statCache = { totals: { records: +tr.records, uniquePhones: +tr.unique_phones, personLinked: +tr.person_linked, withLandline: +tr.with_landline, withCell: +tr.with_cell, withEmail: +tr.with_email, states: +tr.states }, bySource, sourceNames };
  statAt = Date.now();
  return statCache;
}

function buildWhere(q) {
  const w = ['(phone_e164 IS NOT NULL OR cell_e164 IS NOT NULL)'], p = [];
  const add = (clause, v) => { p.push(v); w.push(clause.replace('?', '$' + p.length)); };
  if (q.state) add('state = ?', String(q.state).toUpperCase().slice(0, 2));
  if (q.src) add('source_id = ?', q.src);
  if (q.industry) add('industry = ?', q.industry);
  if (q.dial) add('dial_class = ?', q.dial);
  // Phone type: landline lives in phone_e164, cell in cell_e164.
  if (q.phone === 'cell') w.push('cell_e164 IS NOT NULL');
  else if (q.phone === 'landline') w.push('phone_e164 IS NOT NULL');
  if (q.cell === '1') w.push('cell_e164 IS NOT NULL'); // legacy param
  if (q.person === '1') w.push('person IS NOT NULL');
  if (q.q) {
    const s = String(q.q).trim();
    if (/^\+?1?[\d\s().-]{7,}$/.test(s)) {
      p.push('+1' + s.replace(/\D/g, '').replace(/^1/, ''));
      const n = '$' + p.length;
      w.push(`(phone_e164 = ${n} OR cell_e164 = ${n})`);
    }
    else { p.push('%' + s.toLowerCase() + '%'); const n = '$' + p.length; w.push(`(lower(company) LIKE ${n} OR lower(person) LIKE ${n} OR lower(city) LIKE ${n})`); }
  }
  return { where: w.join(' AND '), params: p };
}

const SORTS = { company: 'company', person: 'person', phone_e164: 'phone_e164', cell_e164: 'cell_e164', city: 'city', state: 'state', industry: 'industry', source: 'source' };

async function search(q) {
  const { where, params } = buildWhere(q);
  const limit = Math.min(parseInt(q.limit || '50', 10) || 50, 200);
  const offset = Math.max(parseInt(q.offset || '0', 10) || 0, 0);
  const sort = SORTS[q.sort] || 'company';
  const dir = q.dir === 'desc' ? 'DESC' : 'ASC';
  const cnt = await pool.query(`SELECT count(*) n FROM records WHERE ${where}`, params);
  const rows = await pool.query(
    `SELECT source, source_id, company, person, title, phone_e164, cell_e164, email, city, state, zip, industry, dial_class, domain
     FROM records WHERE ${where} ORDER BY ${sort} ${dir} NULLS LAST LIMIT ${limit} OFFSET ${offset}`, params);
  return { total: Number(cnt.rows[0].n), rows: rows.rows, limit, offset };
}

function csvCell(v) { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    let path = u.pathname;
    if (path.startsWith(BASE)) path = path.slice(BASE.length) || '/';
    const q = Object.fromEntries(u.searchParams);
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };

    if (path === '/' || path === '') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML.replace(/__BASE__/g, BASE)); return; }
    if (path === '/api/stats') return json(await stats());
    if (path === '/api/search') return json(await search(q));
    if (path === '/api/export') {
      const { where, params } = buildWhere(q);
      const cols = ['source', 'company', 'person', 'title', 'phone_e164', 'cell_e164', 'email', 'city', 'state', 'zip', 'industry', 'dial_class'];
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="landline-db.csv"' });
      res.write(cols.join(',') + '\n');
      const client = await pool.connect();
      try {
        const cur = await client.query(`SELECT ${cols.join(',')} FROM records WHERE ${where} LIMIT 200000`, params);
        for (const r of cur.rows) res.write(cols.map(c => csvCell(r[c])).join(',') + '\n');
      } finally { client.release(); }
      res.end(); return;
    }
    if (path === '/api/health') return json({ ok: true });
    res.writeHead(404); res.end('not found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e && e.message || e) }));
  }
});
server.listen(PORT, () => console.error('landlinedb service on', PORT, 'base', BASE));
