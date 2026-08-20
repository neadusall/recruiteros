/** Ad-hoc live probe for the free company-phone rung: npx tsx scripts/probe-company-phone.mts acme.com … */
import { resolveCompanyPhone } from "../lib/inmarket/companyPhone";
const domains = process.argv.slice(2);
let hits = 0;
for (const d of domains) {
  const t = Date.now();
  try {
    const r = await resolveCompanyPhone(d);
    if (r) hits++;
    console.log(`${d.padEnd(22)} ${r ? `${(r.display || "").padEnd(18)} via=${r.via.padEnd(11)} conf=${r.confidence}  ${r.sourceUrl}` : "(no published number)"}   ${Date.now() - t}ms`);
  } catch (e) { console.log(`${d.padEnd(22)} ERROR ${(e as Error).message}`); }
}
console.log(`\n${hits}/${domains.length} resolved`);
