// FMCSA Company Census: 4.43M carriers, phone/cell_phone/officer names.
// Usage: node fmcsa.mjs [/path/to/downloaded.csv]  (downloads if no path given)
import { db, e164, streamCsv, makeBatcher, finalizeSource, download } from './lib.mjs';

const URL = 'https://data.transportation.gov/api/views/az4n-8mr2/rows.csv?accessType=DOWNLOAD';
const pool = db();
const file = process.argv[2] || await download(URL, '/tmp/fmcsa_census.csv');
const b = makeBatcher(pool, 'fmcsa_census');
let kept = 0;

const n = await streamCsv(file, async (r) => {
  const phone = e164(r.PHONE ?? r.phone);
  const cell = e164(r.CELL_PHONE ?? r.cell_phone);
  if (!phone && !cell) return;
  const units = parseInt(r.POWER_UNITS ?? r.power_units, 10) || null;
  await b.add({
    source_record_id: r.DOT_NUMBER ?? r.dot_number,
    company_name: r.LEGAL_NAME ?? r.legal_name,
    dba_name: r.DBA_NAME ?? r.dba_name,
    person_name: r.COMPANY_OFFICER_1 ?? r.company_officer_1,
    person_title: 'Company Officer',
    phone_raw: r.PHONE ?? r.phone, phone_e164: phone,
    cell_raw: r.CELL_PHONE ?? r.cell_phone, cell_e164: cell,
    fax_raw: r.FAX ?? r.fax,
    email: (r.EMAIL_ADDRESS ?? r.email_address) || null,
    address1: r.PHY_STREET ?? r.phy_street,
    city: r.PHY_CITY ?? r.phy_city, state: r.PHY_STATE ?? r.phy_state, zip: r.PHY_ZIP ?? r.phy_zip,
    industry: 'transportation',
    dial_class: units !== null && units < 10 ? 'owner_main' : 'switchboard',
    company_size_hint: units,
    extra: { status: r.STATUS_CODE ?? r.status_code, officer2: r.COMPANY_OFFICER_2 ?? r.company_officer_2 },
  });
  kept++;
});
await b.flush();
await finalizeSource(pool, 'fmcsa_census', 'FMCSA Company Census File', URL);
console.log(`fmcsa: ${n} rows read, ${kept} with phones ingested`);
await pool.end();
