/**
 * Live probe for the X-ray people finder.
 *   npx tsx scripts/xray-probe.ts
 *   npx tsx scripts/xray-probe.ts "Stripe" "CTO" stripe.com
 *
 * Hits real search engines (DuckDuckGo/Bing/Mojeek), so results depend on live availability.
 */
import { findContactByTitle } from "../lib/inmarket/xray";

type Case = { company: string; title: string; domain?: string };

const args = process.argv.slice(2);
const cases: Case[] = args.length
  ? [{ company: args[0], title: args[1], domain: args[2] }]
  : [
      { company: "Stripe", title: "Chief Technology Officer", domain: "stripe.com" },
      { company: "Notion", title: "Head of Sales", domain: "notion.so" },
      { company: "Ramp", title: "VP of Engineering", domain: "ramp.com" },
      { company: "Vercel", title: "Head of Marketing", domain: "vercel.com" },
    ];

function line(s = "") { process.stdout.write(s + "\n"); }

(async () => {
  const t0 = Date.now();
  let named = 0;
  for (const c of cases) {
    line("─".repeat(70));
    line(`QUERY  ${c.company}  ·  "${c.title}"${c.domain ? `  ·  ${c.domain}` : ""}`);
    const r = await findContactByTitle(c.company, c.title, { domain: c.domain });

    line("queries:");
    for (const q of r.queries) line(`   • ${q}`);

    line("engine log:");
    for (const l of r.log) {
      line(`   [${l.engine.padEnd(11)}] found=${l.found} ${l.throttled ? "THROTTLED" : "ok"}`);
    }

    if (r.person) {
      named++;
      const p = r.person;
      line(`\n  ✅ PERSON  ${p.fullName}   (score ${p.score})`);
      line(`     first/last: ${p.firstName ?? "?"} / ${p.lastName ?? "?"}`);
      line(`     title:      ${p.title ?? "(none parsed)"}`);
      line(`     company:    ${p.companyName ?? "?"}`);
      line(`     linkedin:   ${p.linkedinUrl ?? "(no url captured)"}`);
      line(`     via:        ${p.via}`);
      if (r.email) {
        line(`     EMAIL:      ${r.email.email}  [${r.email.pattern}, conf ${r.email.confidence}]`);
        line(`     verify:     ${r.emailCheck ? `${r.emailCheck.verdict} (${r.emailCheck.reason})` : "n/a"}`);
        line(`     alternates: ${r.email.alternates.slice(0, 4).join(", ")}`);
      } else {
        line(`     EMAIL:      (no domain provided → no guess)`);
      }
    } else {
      line(`\n  ❌ no person resolved (free X-ray miss)`);
    }

    if (r.candidates.length > 1) {
      line(`  other candidates:`);
      for (const c2 of r.candidates.slice(1, 4)) {
        line(`     - ${c2.fullName} (${c2.score}) ${c2.title ?? ""} @ ${c2.companyName ?? ""}`);
      }
    }
    line("");
  }
  line("─".repeat(70));
  line(`RESULT: named ${named}/${cases.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})().catch((e) => { line("FATAL " + (e?.stack || e)); process.exit(1); });
