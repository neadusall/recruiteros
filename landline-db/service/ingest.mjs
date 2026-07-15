// Server-side ingester: pulls every free source straight into landlinedb.
// Streams to Postgres in batches (no giant in-memory file, no memory ceiling).
// Idempotent via ON CONFLICT DO NOTHING. Safe to re-run to grow the DB.
import pg from 'pg';
import fs from 'fs';

const pool = new pg.Pool({ connectionString: process.env.LANDLINEDB_URL || 'postgres://recruiteros@db:5432/landlinedb', max: 6 });
const e164 = (raw) => { if (!raw) return null; let d = String(raw).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); if (d.length !== 10) return null; if (/^(\d)\1{9}$/.test(d)) return null; if (d[0] === '0' || d[0] === '1') return null; return '+1' + d; };
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const AA = '%27A%27';

async function jr(u, tries = 4) {
  for (let t = 0; t < tries; t++) {
    try { const r = await fetch(u, { signal: AbortSignal.timeout(60000) }); if (r.ok) return await r.json(); } catch (e) {}
    await sleep(1200 * (t + 1));
  }
  return null;
}

const cols = ['source', 'source_id', 'company', 'person', 'title', 'phone_e164', 'cell_e164', 'email', 'city', 'state', 'zip', 'industry', 'dial_class', 'domain'];
let buf = [];
let inserted = 0;
// Single-writer mutex: concurrent source tasks share one table with a unique
// index; serializing inserts eliminates ON CONFLICT deadlocks (no lost batches).
let writeChain = Promise.resolve();
function insertBatch(batch) {
  const vals = [], params = [];
  batch.forEach((r, k) => {
    const base = k * cols.length;
    vals.push('(' + cols.map((_, j) => '$' + (base + j + 1)).join(',') + ')');
    params.push(r.source, r.source_id, r.company, r.person, r.title, r.phone_e164, r.cell_e164, r.email, r.city, r.state ? String(r.state).toUpperCase().slice(0, 2) : null, r.zip, r.industry, r.dial_class, r.domain || null);
  });
  const sql = `INSERT INTO records (${cols.join(',')}) VALUES ${vals.join(',')} ON CONFLICT DO NOTHING`;
  writeChain = writeChain.then(async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try { const res = await pool.query(sql, params); inserted += res.rowCount; return; }
      catch (e) { if (/deadlock/i.test(e.message) && attempt < 3) { await sleep(200 * (attempt + 1)); continue; } log('insert err', e.message); return; }
    }
  });
  return writeChain;
}
async function flush() { if (!buf.length) return; const batch = buf; buf = []; await insertBatch(batch); }
async function push(r) { if (!r.phone_e164) return; buf.push(r); if (buf.length >= 1000) await flush(); }

async function fmcsa() {
  let n = 0;
  for (let off = 0; off < 4400000; off += 47000) {
    const u = 'https://data.transportation.gov/resource/az4n-8mr2.json?$limit=47000&$offset=' + off + '&$select=dot_number,legal_name,dba_name,phone,cell_phone,company_officer_1,phy_city,phy_state,phy_zip,email_address&$where=phone%20IS%20NOT%20NULL%20AND%20status_code=' + AA;
    const d = await jr(u);
    if (!d) { log('fmcsa page fail', off); continue; }
    if (!d.length) break;
    for (const x of d) await push({ source: 'FMCSA Carriers', source_id: 'fmcsa', company: x.legal_name || x.dba_name, person: x.company_officer_1 || null, title: x.company_officer_1 ? 'Company Officer' : null, phone_e164: e164(x.phone), cell_e164: e164(x.cell_phone), email: x.email_address || null, city: x.phy_city, state: x.phy_state, zip: x.phy_zip, industry: 'Transportation', dial_class: 'owner_main' });
    n += d.length; if ((off / 47000) % 10 === 0) { await flush(); log('fmcsa', n, 'inserted', inserted); }
  }
  await flush(); log('fmcsa done', n);
}

async function dac() {
  let n = 0;
  for (let off = 0; off < 3400000; off += 1000) {
    const d = await jr('https://data.cms.gov/provider-data/api/1/datastore/query/mj5m-pzi6/0?limit=1000&offset=' + off);
    const rows = d && d.results || [];
    if (!d) continue;
    if (!rows.length) break;
    for (const x of rows) { const p = e164(x.telephone_number); if (!p) continue; await push({ source: 'CMS Clinicians', source_id: 'cms_dac', company: x.facility_name || null, person: [x.provider_first_name, x.provider_last_name].filter(Boolean).join(' '), title: x.pri_spec || 'Clinician', phone_e164: p, cell_e164: null, email: null, city: x.citytown, state: x.state, zip: x.zip_code, industry: 'Healthcare', dial_class: 'owner_main' }); n++; }
    if ((off / 1000) % 50 === 0) { await flush(); log('dac', n, 'inserted', inserted); }
  }
  await flush(); log('dac done', n);
}

async function cmsFac() {
  const sets = [['4pq5-n9py', 'Nursing Home', 'provider_name'], ['6jpm-sxkc', 'Home Health', 'provider_name'], ['yc9t-dgbk', 'Hospice', 'facility_name'], ['23ew-n7w9', 'Dialysis', 'facility_name'], ['xubh-q36u', 'Hospital', 'facility_name'], ['7t8x-u3ir', 'Rehab Facility', 'provider_name']];
  for (const [id, label, nf] of sets) {
    for (let off = 0; off < 20000; off += 1000) {
      const d = await jr('https://data.cms.gov/provider-data/api/1/datastore/query/' + id + '/0?limit=1000&offset=' + off);
      const rows = d && d.results || []; if (!rows.length) break;
      for (const x of rows) { const p = e164(x.telephone_number); if (!p) continue; await push({ source: 'CMS Facilities', source_id: 'cms_fac', company: x[nf] || x.provider_name || x.facility_name, person: null, title: label, phone_e164: p, cell_e164: null, email: null, city: x.citytown || x.city, state: x.state, zip: x.zip_code, industry: 'Healthcare', dial_class: 'switchboard' }); }
    }
  }
  await flush(); log('cmsFac done inserted', inserted);
}

async function pos() {
  for (let off = 0; off < 90000; off += 5000) {
    const d = await jr('https://data.cms.gov/data-api/v1/dataset/086e48c4-87a6-4be1-8823-29e8da8f225b/data?size=5000&offset=' + off);
    if (!d || !d.length) break;
    for (const x of d) { const p = e164(x.phne_num); if (!p) continue; await push({ source: 'CMS Provider of Services', source_id: 'cms_pos', company: x.fac_name, person: null, title: 'Facility', phone_e164: p, cell_e164: null, email: null, city: x.city_name, state: x.state_cd, zip: x.zip_cd, industry: 'Healthcare', dial_class: 'switchboard' }); }
  }
  await flush(); log('pos done inserted', inserted);
}

async function socrataSimple(dom, id, sel, map, source_id, source, industry, dial) {
  for (let off = 0; off < 60000; off += 40000) {
    const d = await jr(`https://${dom}/resource/${id}.json?$limit=40000&$offset=${off}&$select=${sel}`);
    if (!d || !d.length) break;
    for (const x of d) { const r = map(x); if (r && r.phone_e164) await push({ ...r, source_id, source, industry, dial_class: dial, domain: dom }); }
  }
  await flush(); log(source, 'done inserted', inserted);
}

// discovery harvester (auto-find phone-column datasets)
async function harvest() {
  const rank = (fields, ps) => { for (const p of ps) { const f = fields.find(x => p.test(x)); if (f) return f; } return null; };
  const PHONE = [/^phone$/i, /^phone_?number$/i, /^telephone$/i, /^business_?phone$/i, /^contact_?phone$/i, /phone/i, /telephone/i];
  const COMPANY = [/^business_?name$/i, /^legal_?name$/i, /^company_?name$/i, /^dba/i, /^facility_?name$/i, /^operation_?name$/i, /^full_?name$/i, /^organization/i, /business.*name/i, /company/i, /^name$/i];
  const PERSON = [/owner_?name/i, /applicant_?name/i, /principal/i, /^contact_?name$/i, /agent_?name/i, /licensee/i];
  const CITY = [/^city$/i, /_city$/i, /city/i], STATE = [/^state$/i, /_state$/i, /state/i], ZIP = [/^zip$/i, /zip_?code/i, /zip/i], TITLE = [/license_?type/i, /^type$/i, /category/i, /credential/i];
  const variants = ['phone', 'phone_number', 'telephone', 'business_phone', 'contact_phone'];
  const cand = new Map();
  for (const v of variants) {
    const d = await jr(`https://api.us.socrata.com/api/catalog/v1?column_names=${v}&only=datasets&limit=140&order=page_views_total`);
    for (const r of (d && d.results || [])) { const rc = r.resource, dom = r.metadata.domain; if (!rc || !dom) continue; if (!cand.has(dom + rc.id)) cand.set(dom + rc.id, { dom, id: rc.id, name: rc.name, fields: rc.columns_field_name || [] }); }
  }
  log('harvest candidates', cand.size);
  let proc = 0;
  for (const c of cand.values()) {
    if (proc >= 70) break;
    const phoneF = rank(c.fields, PHONE), companyF = rank(c.fields, COMPANY);
    if (!phoneF || !companyF) continue;
    const personF = rank(c.fields.filter(f => f !== companyF), PERSON), cityF = rank(c.fields, CITY), stateF = rank(c.fields, STATE), zipF = rank(c.fields, ZIP), titleF = rank(c.fields, TITLE);
    const sid = (c.dom.replace(/^data\.|\.gov$|\.us$/g, '').replace(/\W/g, '_') + '_' + c.id).slice(0, 40);
    proc++;
    const sel = [companyF, personF, phoneF, cityF, stateF, zipF, titleF].filter(Boolean).join(',');
    const rows = await jr(`https://${c.dom}/resource/${c.id}.json?$limit=10000&$select=${sel}&$where=${phoneF}%20IS%20NOT%20NULL`);
    if (!rows || !rows.length) continue;
    let n = 0;
    for (const x of rows) { const p = e164(x[phoneF]); if (!p) continue; const company = x[companyF]; if (!company || String(company).length < 2) continue; await push({ source: (c.name || c.id).slice(0, 34), source_id: sid, company: String(company).slice(0, 120), person: personF && x[personF] ? String(x[personF]).slice(0, 120) : null, title: titleF && x[titleF] ? String(x[titleF]).slice(0, 60) : 'Licensed Business', phone_e164: p, cell_e164: null, email: null, city: cityF ? x[cityF] : null, state: stateF && x[stateF] ? String(x[stateF]).toUpperCase().slice(0, 2) : null, zip: zipF ? x[zipF] : null, industry: 'Local / Licensed', dial_class: personF ? 'owner_main' : 'switchboard', domain: c.dom }); n++; }
    await flush(); if (n > 50) log('harvest +', n, c.dom);
  }
  log('harvest done inserted', inserted);
}

async function main() {
  await pool.query(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  await Promise.all([
    fmcsa(),
    dac(),
    cmsFac(),
    pos(),
    socrataSimple('data.oregon.gov', 'g77e-6bhs', 'full_name,rmi_name,phone_number,city,state,zip_code,license_type', x => ({ company: x.full_name, person: x.rmi_name || null, title: 'Contractor', phone_e164: e164(x.phone_number), city: x.city, state: x.state, zip: x.zip_code }), 'or_ccb', 'OR Contractors', 'Construction', 'owner_main'),
    socrataSimple('data.wa.gov', 'm8qx-ubtq', 'businessname,primaryprincipalname,phonenumber,city,state,zip,specialtycode1desc', x => ({ company: x.businessname, person: x.primaryprincipalname, title: x.specialtycode1desc || 'Contractor', phone_e164: e164(x.phonenumber), city: x.city, state: x.state, zip: x.zip }), 'wa_lni', 'WA Contractors', 'Construction', 'owner_main'),
    socrataSimple('data.texas.gov', '7358-krk7', 'business_name,owner_name,business_telephone,business_city_state_zip,license_type', x => { let city = '', st = 'TX', zip = ''; const m = String(x.business_city_state_zip || '').match(/^(.*?),?\s*([A-Z]{2})\s+(\d{5})/); if (m) { city = m[1]; st = m[2]; zip = m[3]; } return { company: x.business_name, person: x.owner_name, title: x.license_type || 'Licensee', phone_e164: e164(x.business_telephone), city, state: st, zip }; }, 'tx_tdlr', 'TX TDLR Licenses', 'Skilled Trades', 'owner_main'),
    harvest(),
  ]);
  await flush();
  const c = await pool.query('SELECT count(*) n, count(DISTINCT phone_e164) u FROM records');
  log('=== ALL DONE. rows', c.rows[0].n, 'unique', c.rows[0].u);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
