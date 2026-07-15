// Shared ingestion helpers for LandlineDB workers.
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import readline from 'node:readline';
import pg from 'pg';

export function db() {
  return new pg.Pool({
    connectionString: process.env.LANDLINEDB_URL || 'postgres://landline:landline@localhost:5433/landlinedb',
    max: 4,
  });
}

// Normalize any US phone string to E.164; returns null if not a plausible 10-digit US number.
export function e164(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  if (d.length !== 10) return null;
  if (/^([0-9])\1{9}$/.test(d)) return null;         // 0000000000 etc.
  if (d[0] === '0' || d[0] === '1') return null;      // invalid NANP area code
  if (d.slice(3, 6) === '555' && d.slice(6, 8) === '01') return null; // 555-01xx
  return '+1' + d;
}

// Extract "x123" style extensions before normalizing.
export function splitExt(raw) {
  if (!raw) return { phone: null, ext: null };
  const m = String(raw).match(/(?:x|ext\.?|extension)\s*(\d{1,6})\s*$/i);
  return { phone: m ? raw.slice(0, m.index) : raw, ext: m ? m[1] : null };
}

// Minimal CSV line parser handling quoted fields.
export function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// Stream a CSV file line-by-line: cb(rowObject) per record, header auto-detected.
export async function streamCsv(path, cb, { headerless = null } = {}) {
  const rl = readline.createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let header = headerless, buf = null, n = 0;
  for await (let line of rl) {
    if (buf !== null) line = buf + '\n' + line;
    // Unbalanced quotes => record continues on next line
    if ((line.match(/"/g) || []).length % 2 === 1) { buf = line; continue; }
    buf = null;
    if (!header) { header = parseCsvLine(line).map(h => h.trim().replace(/^﻿/, '')); continue; }
    const cells = parseCsvLine(line);
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = cells[i];
    await cb(row, ++n);
  }
  return n;
}

// Batched upsert into records.
export function makeBatcher(pool, sourceId, batchSize = 1000) {
  let batch = [];
  const cols = ['source_id','source_record_id','company_name','dba_name','person_name','person_title',
    'phone_raw','phone_e164','cell_raw','cell_e164','fax_raw','email','website',
    'address1','city','state','zip','industry','dial_class','company_size_hint','extra'];
  async function flush() {
    if (!batch.length) return;
    const rows = batch; batch = [];
    const vals = [], params = [];
    rows.forEach((r, i) => {
      const base = i * cols.length;
      vals.push('(' + cols.map((_, j) => '$' + (base + j + 1)).join(',') + ')');
      params.push(...cols.map(c => c === 'extra' ? JSON.stringify(r.extra || {}) : (r[c] ?? null)));
    });
    await pool.query(
      `INSERT INTO records (${cols.join(',')}) VALUES ${vals.join(',')}
       ON CONFLICT (source_id, source_record_id) DO UPDATE SET
         company_name=EXCLUDED.company_name, dba_name=EXCLUDED.dba_name,
         person_name=EXCLUDED.person_name, person_title=EXCLUDED.person_title,
         phone_raw=EXCLUDED.phone_raw, phone_e164=EXCLUDED.phone_e164,
         cell_raw=EXCLUDED.cell_raw, cell_e164=EXCLUDED.cell_e164,
         fax_raw=EXCLUDED.fax_raw, email=EXCLUDED.email, website=EXCLUDED.website,
         address1=EXCLUDED.address1, city=EXCLUDED.city, state=EXCLUDED.state, zip=EXCLUDED.zip,
         industry=EXCLUDED.industry, dial_class=EXCLUDED.dial_class,
         company_size_hint=EXCLUDED.company_size_hint, extra=EXCLUDED.extra,
         retrieved_at=now()`,
      params
    );
  }
  return {
    async add(rec) { batch.push({ source_id: sourceId, ...rec }); if (batch.length >= batchSize) await flush(); },
    flush,
  };
}

// Refresh the phones summary + source bookkeeping after an ingest.
export async function finalizeSource(pool, sourceId, name, url) {
  await pool.query(
    `INSERT INTO sources (source_id, source_name, official_url, last_ingest_at, last_status, record_count)
     VALUES ($1,$2,$3,now(),'ok',(SELECT count(*) FROM records WHERE source_id=$1))
     ON CONFLICT (source_id) DO UPDATE SET last_ingest_at=now(), last_status='ok',
       record_count=(SELECT count(*) FROM records WHERE source_id=$1)`,
    [sourceId, name, url]
  );
  await pool.query(`
    INSERT INTO phones (e164, best_dial_class, support_count, first_seen, last_seen)
    SELECT phone_e164, min(dial_class), count(DISTINCT source_id), now(), now()
    FROM records WHERE phone_e164 IS NOT NULL GROUP BY phone_e164
    ON CONFLICT (e164) DO UPDATE SET
      support_count = EXCLUDED.support_count,
      best_dial_class = LEAST(phones.best_dial_class, EXCLUDED.best_dial_class),
      last_seen = now()`);
}

export async function download(url, dest, opts = {}) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const ua = opts.ua || 'Mozilla/5.0 (LandlineDB ingest; contact neadusall@gmail.com)';
  await run('curl', ['-sSL', '--retry', '3', '--max-time', '7200', '-A', ua, '-o', dest, url], { maxBuffer: 1024 * 1024 });
  return dest;
}
