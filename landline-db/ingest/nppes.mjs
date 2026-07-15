// NPPES full dissemination: ~9.2M NPIs. Type 2 org records carry authorized official
// (name + title + phone) = the direct-dial layer. Type 1 = practice phone per clinician.
// The zip is ~1.1GB / ~10GB CSV: run on the server, stream, never load into memory.
// Usage: node nppes.mjs /path/to/npidata_pfile_*.csv   (download+unzip handled by run-all.sh)
import { db, e164, streamCsv, makeBatcher, finalizeSource } from './lib.mjs';

const file = process.argv[2];
if (!file) { console.error('Usage: node nppes.mjs /path/to/npidata_pfile_*.csv'); process.exit(1); }

const pool = db();
const b = makeBatcher(pool, 'nppes', 2000);
let kept = 0;

const F = {
  npi: 'NPI',
  type: 'Entity Type Code',
  orgName: 'Provider Organization Name (Legal Business Name)',
  lastName: 'Provider Last Name (Legal Name)',
  firstName: 'Provider First Name',
  cred: 'Provider Credential Text',
  addr1: 'Provider First Line Business Practice Location Address',
  city: 'Provider Business Practice Location Address City Name',
  state: 'Provider Business Practice Location Address State Name',
  zip: 'Provider Business Practice Location Address Postal Code',
  phone: 'Provider Business Practice Location Address Telephone Number',
  fax: 'Provider Business Practice Location Address Fax Number',
  aoFirst: 'Authorized Official First Name',
  aoLast: 'Authorized Official Last Name',
  aoTitle: 'Authorized Official Title or Position',
  aoPhone: 'Authorized Official Telephone Number',
  deact: 'NPI Deactivation Date',
  taxonomy: 'Healthcare Provider Taxonomy Code_1',
};

const n = await streamCsv(file, async (r) => {
  if (r[F.deact]) return; // skip deactivated
  const isOrg = r[F.type] === '2';
  const locPhone = e164(r[F.phone]);
  const aoPhone = isOrg ? e164(r[F.aoPhone]) : null;
  if (!locPhone && !aoPhone) return;
  const person = isOrg
    ? [r[F.aoFirst], r[F.aoLast]].filter(Boolean).join(' ') || null
    : [r[F.firstName], r[F.lastName]].filter(Boolean).join(' ') || null;
  await b.add({
    source_record_id: r[F.npi],
    company_name: isOrg ? r[F.orgName] : null,
    person_name: person,
    person_title: isOrg ? (r[F.aoTitle] || 'Authorized Official') : (r[F.cred] || 'Provider'),
    phone_raw: r[F.aoPhone] && aoPhone ? r[F.aoPhone] : r[F.phone],
    phone_e164: aoPhone || locPhone,
    address1: r[F.addr1], city: r[F.city], state: r[F.state],
    zip: (r[F.zip] || '').slice(0, 5),
    industry: 'healthcare',
    dial_class: isOrg && aoPhone ? 'direct_dial' : 'switchboard',
    extra: { npi_type: r[F.type], taxonomy: r[F.taxonomy], loc_phone: locPhone, ao_phone: aoPhone },
  });
  kept++;
  if (kept % 500000 === 0) console.log(`  ...${kept} ingested`);
});
await b.flush();
await finalizeSource(pool, 'nppes', 'NPPES NPI Full Dissemination', 'https://download.cms.gov/nppes/NPI_Files.html');
console.log(`nppes: ${n} read, ${kept} ingested`);
await pool.end();
