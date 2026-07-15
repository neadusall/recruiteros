// Load records.json into landlinedb. Idempotent (ON CONFLICT DO NOTHING).
// Usage: LANDLINEDB_URL=... node loader.mjs /path/to/records.json
import fs from 'fs';
import pg from 'pg';

const url = process.env.LANDLINEDB_URL || 'postgres://recruiteros@db:5432/landlinedb';
const file = process.argv[2] || './data/records.json';
const pool = new pg.Pool({ connectionString: url, max: 4 });

const cols = ['source', 'source_id', 'company', 'person', 'title', 'phone_e164', 'cell_e164', 'email', 'city', 'state', 'zip', 'industry', 'dial_class', 'domain'];

async function main() {
  await pool.query(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const R = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.error('loading', R.length, 'records');
  const B = 1000;
  let done = 0;
  for (let i = 0; i < R.length; i += B) {
    const batch = R.slice(i, i + B);
    const vals = [], params = [];
    batch.forEach((r, k) => {
      const base = k * cols.length;
      vals.push('(' + cols.map((_, j) => '$' + (base + j + 1)).join(',') + ')');
      params.push(r.source, r.source_id, r.company, r.person, r.title, r.phone_e164, r.cell_e164, r.email, r.city, r.state ? String(r.state).slice(0, 2) : null, r.zip, r.industry, r.dial_class, r.domain || null);
    });
    await pool.query(
      `INSERT INTO records (${cols.join(',')}) VALUES ${vals.join(',')} ON CONFLICT DO NOTHING`,
      params
    );
    done += batch.length;
    if (done % 50000 === 0) console.error('  loaded', done);
  }
  const c = await pool.query('SELECT count(*) n, count(DISTINCT phone_e164) u FROM records');
  console.error('DONE. rows', c.rows[0].n, 'unique phones', c.rows[0].u);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
