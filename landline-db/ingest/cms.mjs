// CMS provider-data ingester: DAC clinicians + the 7 facility registries + POS file.
// Usage: node cms.mjs <dac|facilities|pos>
import { db, e164, streamCsv, makeBatcher, finalizeSource, download } from './lib.mjs';

const pool = db();
const which = process.argv[2] || 'facilities';

async function ingestDatastore(sourceId, name, dsId, map, industry) {
  const url = `https://data.cms.gov/provider-data/api/1/datastore/query/${dsId}/0/download?format=csv`;
  const file = await download(url, `/tmp/${sourceId}.csv`);
  const b = makeBatcher(pool, sourceId);
  let kept = 0;
  const n = await streamCsv(file, async (r) => {
    const m = map(r);
    if (!m || !m.source_record_id) return;
    const pe = e164(m.phone_raw);
    if (!pe) return;
    await b.add({ ...m, phone_e164: pe, industry });
    kept++;
  });
  await b.flush();
  await finalizeSource(pool, sourceId, name, `https://data.cms.gov/provider-data/dataset/${dsId}`);
  console.log(`${sourceId}: ${n} read, ${kept} ingested`);
}

if (which === 'dac') {
  await ingestDatastore('cms_dac', 'CMS DAC National Downloadable File', 'mj5m-pzi6', r => ({
    source_record_id: `${r.npi}|${r.adrs_id}`,
    company_name: r.facility_name,
    person_name: [r.provider_first_name, r.provider_last_name].filter(Boolean).join(' '),
    person_title: r.pri_spec,
    phone_raw: r.telephone_number,
    address1: r.adr_ln_1, city: r.citytown, state: r.state, zip: r.zip_code,
    dial_class: (parseInt(r.num_org_mem, 10) || 99) < 10 ? 'owner_main' : 'switchboard',
    company_size_hint: parseInt(r.num_org_mem, 10) || null,
    extra: { npi: r.npi, cred: r.cred },
  }), 'healthcare');
} else if (which === 'pos') {
  const url = 'https://data.cms.gov/sites/default/files/2026-04/90983850-6dfe-4886-9dfa-1a3890a655b3/POS_File_iQIES_Q1_2026.csv';
  const file = await download(url, '/tmp/cms_pos.csv');
  const b = makeBatcher(pool, 'cms_pos');
  let kept = 0;
  const n = await streamCsv(file, async (r) => {
    const g = k => r[k] ?? r[k.toUpperCase()] ?? r[k.toLowerCase()];
    const pe = e164(g('phne_num'));
    if (!pe || !g('prvdr_num')) return;
    await b.add({
      source_record_id: g('prvdr_num'),
      company_name: g('fac_name'),
      phone_raw: g('phne_num'), phone_e164: pe, fax_raw: g('fax_phne_num'),
      address1: g('st_adr'), city: g('city_name'), state: g('state_cd'), zip: g('zip_cd'),
      industry: 'healthcare_facility', dial_class: 'switchboard',
      extra: { chain: g('mlt_fac_org_name'), type: g('gnrl_fac_type_cd') },
    });
    kept++;
  });
  await b.flush();
  await finalizeSource(pool, 'cms_pos', 'CMS Provider of Services (iQIES)', url);
  console.log(`cms_pos: ${n} read, ${kept} ingested`);
} else {
  const FACILITIES = [
    ['cms_nursing', 'CMS Nursing Homes', '4pq5-n9py', 'cms_certification_number_ccn', 'provider_name'],
    ['cms_homehealth', 'CMS Home Health', '6jpm-sxkc', 'cms_certification_number_ccn', 'provider_name'],
    ['cms_hospice', 'CMS Hospice', 'yc9t-dgbk', 'cms_certification_number_ccn', 'facility_name'],
    ['cms_dialysis', 'CMS Dialysis', '23ew-n7w9', 'cms_certification_number_ccn', 'facility_name'],
    ['cms_hospitals', 'CMS Hospitals', 'xubh-q36u', 'facility_id', 'facility_name'],
    ['cms_irf', 'CMS Inpatient Rehab', '7t8x-u3ir', 'cms_certification_number_ccn', 'provider_name'],
    ['cms_ltch', 'CMS Long-Term Care Hospitals', 'azum-44iv', 'cms_certification_number_ccn', 'provider_name'],
  ];
  for (const [sid, name, dsId, idField, nameField] of FACILITIES) {
    await ingestDatastore(sid, name, dsId, r => {
      const id = r[idField] || r.ccn || r.facility_id || r.provider_id;
      return id && {
        source_record_id: id,
        company_name: r[nameField] || r.provider_name || r.facility_name,
        phone_raw: r.telephone_number,
        address1: r.address || r.address_line_1 || r.provider_address,
        city: r.citytown || r.city, state: r.state, zip: r.zip_code,
        dial_class: 'switchboard',
        extra: { legal: r.legal_business_name, chain: r.chain_name, ownership: r.ownership_type || r.type_of_ownership },
      };
    }, 'healthcare_facility');
  }
}
await pool.end();
