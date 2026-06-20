/**
 * Offline proof of the X-ray model: injects a fake search fetcher returning real-shaped
 * DuckDuckGo/Bing result HTML, so we validate query-build → /in/ extraction → title parsing →
 * scoring → email guess → free verify WITHOUT depending on live (throttled) search access.
 *   npx tsx scripts/xray-fixture.ts
 */
import { findContactByTitle, parseLinkedInResult, expandTitle, buildXrayQueries } from "../lib/inmarket/xray";

function line(s = "") { process.stdout.write(s + "\n"); }

/** Build a DuckDuckGo-html result anchor with a uddg-encoded LinkedIn /in/ href. */
function ddgResult(slug: string, titleText: string): string {
  const target = `https://www.linkedin.com/in/${slug}`;
  const uddg = encodeURIComponent(target);
  return `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${uddg}&rut=x">${titleText}</a>`;
}

/** A realistic DDG html SERP for a company+title X-ray. */
function fixtureFor(company: string): string {
  if (/stripe/i.test(company)) {
    return `<html><body>
      ${ddgResult("davidsinghhh", "David Singh - Chief Technology Officer - Stripe | LinkedIn")}
      ${ddgResult("janedoe-eng", "Jane Doe - Staff Engineer - Stripe | LinkedIn")}
      ${ddgResult("someoneelse", "Privacy Policy - Stripe")}
    </body></html>`;
  }
  if (/notion/i.test(company)) {
    return `<html><body>
      ${ddgResult("maria-lopez-sales", "Maria Lopez – Head of Sales – Notion")}
      ${ddgResult("notion-careers", "Careers - Notion")}
    </body></html>`;
  }
  if (/ramp/i.test(company)) {
    // Bing-style h2>a with a direct linkedin href + company segment swapped to last.
    return `<html><body>
      <h2><a href="https://www.linkedin.com/in/kchen-eng?trk=x">Kevin Chen - VP of Engineering - Ramp - LinkedIn</a></h2>
      <h2><a href="https://www.linkedin.com/in/rando">Acme Corp - We're hiring | LinkedIn</a></h2>
    </body></html>`;
  }
  return `<html><body></body></html>`;
}

(async () => {
  // ── unit: title expansion + query build ───────────────────────────────
  line("TITLE EXPANSION");
  for (const t of ["VP of Engineering", "Chief Technology Officer", "Head of Sales"]) {
    line(`   "${t}"  →  ${expandTitle(t).map((x) => `"${x}"`).join(", ")}`);
  }
  line("\nQUERY BUILD  (Stripe / CTO)");
  for (const q of buildXrayQueries("Stripe", "Chief Technology Officer")) line(`   • ${q}`);

  // ── unit: parser across the real-world title shapes ───────────────────
  line("\nPARSER");
  const shapes = [
    ["Jane Doe - VP of Engineering - Acme | LinkedIn", "https://www.linkedin.com/in/janedoe"],
    ["John Smith – Chief Technology Officer – Stripe", undefined],
    ["Maria Lopez - Acme - Head of Sales - LinkedIn", undefined],
    ["Priya Patel - Acme | LinkedIn", "https://www.linkedin.com/in/priya"], // no title segment
    ["Some Company on LinkedIn: We're hiring engineers!", undefined], // post → reject
    ["Privacy Policy - Acme", undefined], // boilerplate → reject
  ] as const;
  for (const [t, u] of shapes) {
    const p = parseLinkedInResult(t, u as string | undefined);
    line(`   ${p ? "✓" : "✗"} ${JSON.stringify(t)}`);
    if (p) line(`        → name="${p.fullName}" title="${p.title ?? ""}" co="${p.company ?? ""}" url=${p.linkedinUrl ?? "-"}`);
  }

  // ── end-to-end with injected SERP fixtures (+ real MX verify) ─────────
  line("\nEND-TO-END  (injected SERP, real DNS verify)");
  const cases = [
    { company: "Stripe", title: "Chief Technology Officer", domain: "stripe.com" },
    { company: "Notion", title: "Head of Sales", domain: "notion.so" },
    { company: "Ramp", title: "VP of Engineering", domain: "ramp.com" },
  ];
  const fetchImpl = async (url: string) => {
    const company = decodeURIComponent(url).match(/"([^"]+)"/)?.[1] ?? "";
    return { status: 200, body: fixtureFor(company) };
  };
  let named = 0;
  for (const c of cases) {
    const r = await findContactByTitle(c.company, c.title, { domain: c.domain, fetchImpl });
    line("─".repeat(64));
    line(`${c.company} · "${c.title}"`);
    if (r.person) {
      named++;
      const p = r.person;
      line(`  ✅ ${p.fullName}  [first=${p.firstName} last=${p.lastName}]  score ${p.score}`);
      line(`     title: ${p.title}   linkedin: ${p.linkedinUrl ?? "-"}`);
      line(`     EMAIL: ${r.email?.email ?? "-"}  (${r.email?.pattern}, conf ${r.email?.confidence})`);
      line(`     VERIFY: ${r.emailCheck?.verdict} (${r.emailCheck?.reason})`);
      line(`     alts:  ${r.email?.alternates.slice(0, 3).join(", ")}`);
    } else line("  ❌ no person");
  }
  line("─".repeat(64));
  line(`MODEL RESULT: named ${named}/${cases.length} (offline fixtures)`);

  // ── SearXNG JSON backend path (the production-free upgrade) ───────────
  line("\nSEARXNG JSON BACKEND  (simulated instance)");
  process.env.INMARKET_SEARXNG_URL = "http://localhost:8080";
  const searxngFetch = async (_url: string) => ({
    status: 200,
    body: JSON.stringify({
      results: [
        { url: "https://www.linkedin.com/in/dsingh-cto", title: "David Singh - Chief Technology Officer - Stripe | LinkedIn" },
        { url: "https://stripe.com/about", title: "About Stripe - Our mission" }, // non-person → filtered
      ],
    }),
  });
  const sx = await findContactByTitle("Stripe", "Chief Technology Officer", { domain: "stripe.com", fetchImpl: searxngFetch });
  line(`  engine used: ${sx.log.map((l) => l.engine).join(", ")}`);
  line(`  ${sx.person ? `✅ ${sx.person.fullName} (${sx.person.score}) → ${sx.email?.email} [${sx.emailCheck?.verdict}]` : "❌ no person"}`);
  line(`  linkedin url captured from JSON: ${sx.person?.linkedinUrl ?? "-"}`);
  delete process.env.INMARKET_SEARXNG_URL;
})().catch((e) => { line("FATAL " + (e?.stack || e)); process.exit(1); });
