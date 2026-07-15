// Generic Socrata dataset ingester driven by a field map. Covers TX TDLR, WA L&I, OR CCB, TX HHSC and
// any future Discovery-API find without new code.
// Usage: node socrata.mjs <preset>   e.g. node socrata.mjs wa_lni
import { db, e164, splitExt, streamCsv, makeBatcher, finalizeSource, download } from './lib.mjs';

const PRESETS = {
  tx_tdlr: {
    domain: 'data.texas.gov', id: '7358-krk7', name: 'Texas TDLR All Licenses', industry: 'skilled_trades',
    map: r => ({
      source_record_id: r['LICENSE NUMBER'] || r.license_number,
      company_name: r['BUSINESS NAME'] || r.business_name,
      person_name: r['OWNER NAME'] || r.owner_name,
      person_title: 'Owner',
      phone_raw: r['BUSINESS TELEPHONE'] || r.business_telephone,
      cell_raw: null,
      address1: r['BUSINESS ADDRESS LINE1'] || r.business_address_line1,
      city_state_zip: r['BUSINESS CITY STATE ZIP'] || r.business_city_state_zip,
      state: 'TX',
      extra: { license_type: r['LICENSE TYPE'] || r.license_type, owner_phone: r['OWNER TELEPHONE'] || r.owner_telephone },
      dial_class: 'owner_main',
    }),
  },
  wa_lni: {
    domain: 'data.wa.gov', id: 'm8qx-ubtq', name: 'WA L&I Contractor Licenses', industry: 'construction',
    map: r => ({
      source_record_id: r.ContractorLicenseNumber || r.contractorlicensenumber,
      company_name: r.BusinessName || r.businessname,
      person_name: r.PrimaryPrincipalName || r.primaryprincipalname,
      person_title: 'Principal',
      phone_raw: r.PhoneNumber || r.phonenumber,
      address1: r.Address1 || r.address1,
      city: r.City || r.city, state: r.State || r.state || 'WA', zip: r.Zip || r.zip,
      extra: { ubi: r.UBI || r.ubi, specialty: r.SpecialtyCode1Desc || r.specialtycode1desc, status: r.ContractorLicenseStatus || r.contractorlicensestatus },
      dial_class: 'owner_main',
    }),
  },
  or_ccb: {
    domain: 'data.oregon.gov', id: 'g77e-6bhs', name: 'Oregon CCB Active Licenses', industry: 'construction',
    map: r => ({
      source_record_id: r['License Number'] || r.license_number,
      company_name: r['Full Name'] || r.full_name,
      person_name: r['RMI Name'] || r.rmi_name,
      person_title: 'Responsible Managing Individual',
      phone_raw: r['Phone Number'] || r.phone_number,
      address1: r.Address || r.address,
      city: r.City || r.city, state: r.State || r.state || 'OR', zip: r['Zip Code'] || r.zip_code,
      extra: { license_type: r['License Type'] || r.license_type, county: r['County Name'] || r.county_name },
      dial_class: 'owner_main',
    }),
  },
  tx_hhsc_childcare: {
    domain: 'data.texas.gov', id: 'bc5r-88dy', name: 'TX HHSC Daycare and Residential Operations', industry: 'childcare',
    map: r => ({
      source_record_id: r.OPERATION_NUMBER || r.operation_number || r.OPERATION_ID || r.operation_id,
      company_name: r.OPERATION_NAME || r.operation_name,
      person_name: r.ADMINISTRATOR || r.administrator || null,
      person_title: r.ADMINISTRATOR || r.administrator ? 'Administrator' : null,
      phone_raw: r.PHONE || r.phone || r.PHONE_NUMBER || r.phone_number,
      email: r.EMAIL_ADDRESS || r.email_address || null,
      address1: r.LOCATION_ADDRESS || r.location_address,
      city: r.CITY || r.city, state: 'TX', zip: r.ZIP || r.zip,
      extra: { type: r.OPERATION_TYPE || r.operation_type, county: r.COUNTY || r.county },
      dial_class: 'owner_main',
    }),
  },
};

const preset = PRESETS[process.argv[2]];
if (!preset) { console.error('Usage: node socrata.mjs <' + Object.keys(PRESETS).join('|') + '>'); process.exit(1); }

const url = `https://${preset.domain}/api/views/${preset.id}/rows.csv?accessType=DOWNLOAD`;
const sourceId = process.argv[2];
const pool = db();
const file = process.argv[3] || await download(url, `/tmp/${sourceId}.csv`);
const b = makeBatcher(pool, sourceId);
let kept = 0;

const n = await streamCsv(file, async (r) => {
  const m = preset.map(r);
  if (!m.source_record_id) return;
  const { phone, ext } = splitExt(m.phone_raw);
  const pe = e164(phone);
  if (!pe && !m.cell_raw) return;
  // TX TDLR packs "CITY, TX 75001" into one column
  if (m.city_state_zip && !m.city) {
    const mm = String(m.city_state_zip).match(/^(.*?),?\s*([A-Z]{2})\s+(\d{5})/);
    if (mm) { m.city = mm[1]; m.state = mm[2]; m.zip = mm[3]; }
    delete m.city_state_zip;
  }
  await b.add({
    ...m,
    phone_e164: pe,
    cell_e164: e164(m.cell_raw),
    industry: preset.industry,
    extra: { ...(m.extra || {}), ext },
  });
  kept++;
});
await b.flush();
await finalizeSource(pool, sourceId, preset.name, `https://${preset.domain}/d/${preset.id}`);
console.log(`${sourceId}: ${n} rows read, ${kept} with phones ingested`);
await pool.end();
