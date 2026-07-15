// NCES CCD public school directory: 102k schools, PHONE 100% populated (verified 2026-07-14).
// Usage: node nces.mjs [/path/to/ccd.csv]
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db, e164, streamCsv, makeBatcher, finalizeSource, download } from './lib.mjs';

const run = promisify(execFile);
const URL = 'https://nces.ed.gov/ccd/data/zip/ccd_sch_029_2324_w_1a_073124.zip';
const pool = db();

let file = process.argv[2];
if (!file) {
  await download(URL, '/tmp/ccd.zip');
  await run('unzip', ['-o', '-d', '/tmp/ccd', '/tmp/ccd.zip']);
  const { stdout } = await run('sh', ['-c', 'ls /tmp/ccd/ccd_sch_029*.csv | head -1']);
  file = stdout.trim();
}

const b = makeBatcher(pool, 'nces_ccd');
let kept = 0;
const n = await streamCsv(file, async (r) => {
  const pe = e164(r.PHONE);
  if (!pe || !r.NCESSCH) return;
  await b.add({
    source_record_id: r.NCESSCH,
    company_name: r.SCH_NAME,
    dba_name: r.LEA_NAME,
    phone_raw: r.PHONE, phone_e164: pe,
    address1: r.LSTREET1, city: r.LCITY, state: r.LSTATE, zip: r.LZIP,
    industry: 'education', dial_class: 'switchboard',
    extra: { leaid: r.LEAID, type: r.SCH_TYPE_TEXT, level: r.LEVEL },
  });
  kept++;
});
await b.flush();
await finalizeSource(pool, 'nces_ccd', 'NCES CCD Public School Directory 2023-24', URL);
console.log(`nces_ccd: ${n} read, ${kept} ingested`);
await pool.end();
