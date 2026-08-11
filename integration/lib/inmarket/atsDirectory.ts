/**
 * RecruitersOS · In-Market · ATS board directory (the unlimited free volume lever)
 *
 * Public ATS boards (Greenhouse / Lever / Ashby / Workable / SmartRecruiters / Recruitee) are
 * company-owned, keyless, and have no documented rate limit: ONE request per slug returns a
 * company's ENTIRE open-role list. So the ceiling on free volume isn't the boards — it's how
 * many real company slugs we know to probe. This module is that directory.
 *
 * Two feeders keep it growing toward 10–20K companies/day at $0:
 *   1. This curated seed of known real boards (bootstraps breadth immediately).
 *   2. Self-feeding: every company name the aggregator feeds surface gets slugified and probed
 *      (poolCompanySlugs in pool.ts), so the directory compounds on its own.
 *
 * The accumulator pulls a rotating batch each cycle through collectLeads({ companyNames }),
 * which runs the SAME pipeline as everything else — staffing gate, US filter, scoring, dedupe —
 * so directory companies are held to the identical quality bar. Wrong/stale slugs simply 404
 * and are skipped, so the list is safe to grow aggressively.
 */

/**
 * Curated real public-ATS slugs (Greenhouse + Lever + Ashby), deduped into one flat set —
 * resolveCompanyRoles tries every ATS shape per slug, so grouping by vendor isn't needed here.
 * Grow this freely; the self-feeding path expands it automatically from live results.
 */
const SEED_SLUGS: string[] = [
  // Fintech / payments
  "stripe", "plaid", "brex", "ramp", "mercury", "affirm", "sofi", "chime", "marqeta", "upstart",
  "robinhood", "carta", "betterment", "wealthfront", "lithic", "unit", "increase", "moov", "finix",
  "highnote", "tala", "petal", "monarch", "rocketmoney", "metronome", "orum", "tremendous", "public",
  "sardine", "middesk", "alloy", "checkout", "modern-treasury", "column",
  // AI / ML
  "anthropic", "openai", "cohere", "huggingface", "scaleai", "perplexityai", "glean", "mistral",
  "runwayml", "together", "baseten", "groq", "lambdalabs", "labelbox", "weaviate", "pinecone",
  "writer", "jasper", "adept", "imbue", "contextual", "humanloop", "langchain", "llamaindex",
  "cursor", "anysphere", "codeium", "cognition", "harvey", "sourcegraph", "modal", "replicate",
  // Dev tools / infra / SaaS
  "databricks", "gitlab", "hashicorp", "retool", "vercel", "netlify", "notion", "figma", "linear",
  "airtable", "asana", "webflow", "supabase", "replit", "posthog", "launchdarkly", "datadog",
  "fastly", "newrelic", "pagerduty", "render", "planetscale", "cockroachlabs", "clickhouse",
  "temporal", "postman", "kong", "apollographql", "statsig", "split", "amplitude", "mixpanel",
  "fivetran", "airbyte", "census", "hightouch", "atlan", "hex", "deepnote", "mode", "dbt",
  "rippling", "gusto", "deel", "lattice", "remote", "pilot", "rho", "digits",
  "dropbox", "twilio", "benchling", "samsara", "verkada", "gem", "squarespace",
  // Security
  "snyk", "cloudflare", "vanta", "drata", "secureframe", "wiz", "lacework", "sysdig", "semgrep",
  "1password", "tailscale", "teleport", "persona", "stytch", "workos", "clerk", "frontegg", "descope",
  "chainguard", "oso", "sprinto", "safebase",
  // Health / bio
  "whoop", "oura", "calm", "headspace", "noom", "ro", "hims", "cerebral", "devoted", "cityblock",
  "tempus", "flatiron", "abridge", "commure", "spring", "lyra", "modernhealth", "talkspace",
  "hingehealth", "swordhealth", "headway", "alma", "cedar", "includedhealth", "memora",
  // Commerce / consumer / marketplace
  "airbnb", "doordash", "instacart", "faire", "flexport", "veho", "shippo", "easypost", "whatnot",
  "poshmark", "depop", "gorgias", "warbyparker", "allbirds", "glossier", "everlane", "rothys", "figs",
  "sweetgreen", "cava", "toasttab", "opendoor", "compass", "ankorstore", "fabric", "bigcommerce",
  "pinterest", "reddit", "discord", "substack", "patreon", "cameo", "duolingo", "grammarly", "canva",
  "miro", "loom", "calendly", "clickup", "monday", "coda", "zapier", "make", "workato",
  // GTM / sales tech
  "clari", "outreach", "gong", "apollo", "6sense", "drift", "zoominfo", "lusha", "instantly", "clay",
  // Logistics / industrial / other
  "anduril", "navan", "tripactions", "hopper", "getaround", "turo", "intercom", "zendesk", "freshworks",
  "front", "kustomer", "assembled", "forethought", "contentful", "sanity", "storyblok", "builderio",
  // --- Finance-heavy employers (added to widen the FREE finance-role footprint; every one runs a
  //     real accounting/FP&A/controller team, so their $0 ATS boards feed the finance gate). ---
  // More fintech / payments / lending / crypto (big finance orgs)
  "gusto", "justworks", "wise", "revolut", "monzo", "n26", "current", "dave", "mercuryfinancial",
  "bill", "billtrust", "melio", "routable", "tipalti", "airbase", "brexinc", "pry", "puzzl",
  "coinbase", "kraken", "gemini", "circle", "anchorage", "fireblocks", "paxos", "bitgo", "chainalysis",
  "addepar", "vise", "altruist", "facet", "wealthsimple", "stash", "acorns", "moneylion",
  "gemini-trust", "figure", "blend", "morty", "valon", "kin", "hippo", "root", "lemonade",
  "clearcover", "pie", "coalition", "nextinsurance", "newfront", "at-bay", "counterpart",
  // Insurtech / real estate / proptech (finance-ops heavy)
  "022", "flyhomes", "orchard", "ribbon", "knock", "sundae", "pacaso", "kindred", "landis",
  "vts", "cherre", "juniper-square", "cadre", "fundrise", "roofstock", "arrived",
  // Health systems / bio (large finance/accounting teams)
  "carbonhealth", "forward", "onemedical", "cricketa", "maven", "kindbody", "carrot", "progyny",
  "recursion", "insitro", "genesistherapeutics", "generate", "eikontx", "xaira",
  // Climate / energy / industrials / logistics
  "watershed", "persefoni", "crusoe", "redwoodmaterials", "form-energy", "commonwealthfusion",
  "sila", "electrichydrogen", "antora", "twelve", "charm", "arcadia", "palmetto", "aurorasolar",
  "flexport-inc", "project44", "flock-freight", "convoy", "sennder", "einride", "gatik", "nuro",
  // Broad scaleups with heavy G&A/finance orgs
  "ramp-inc", "airtable-inc", "gong-io", "attentive", "iterable", "braze", "movable-ink",
  "vimeo", "sprig", "airtable-com", "webflow-com", "vanta-com", "notion-so", "sourcegraph-com",
];

/** Deduped, lowercased SEED directory (the curated bootstrap; sync, always available). */
const SEED_DIRECTORY: string[] = [...new Set(SEED_SLUGS.map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 2))];

/** Back-compat export (seed only). Live probing uses hydrateDirectory() below. */
export const ATS_DIRECTORY: string[] = SEED_DIRECTORY;

/**
 * The DISCOVERED directory: thousands of real ATS slugs found + validated by the discovery tool
 * (`scripts/mpc/discover-ats-slugs.mjs`), persisted to a snapshot and merged with the seed here.
 * This is what lets the free volume lever scale to thousands of employers WITHOUT a code deploy:
 * the tool grows the snapshot, and each cycle picks it up. Cached with a short TTL so updates go
 * live within minutes; any load failure falls back to the seed so the free arm never breaks.
 */
const EXT_KEY = "inmarket_ats_slugs_ext_v1";
const HYDRATE_TTL_MS = 10 * 60 * 1000;
let cachedDir: string[] = SEED_DIRECTORY;
let cachedAt = 0;

async function hydrateDirectory(): Promise<string[]> {
  const now = Date.now();
  if (cachedAt && now - cachedAt < HYDRATE_TTL_MS) return cachedDir;
  try {
    const ext = await loadSnapshot<string[]>(EXT_KEY);
    cachedDir = Array.isArray(ext) && ext.length
      ? [...new Set([...SEED_DIRECTORY, ...ext.map((s) => String(s).trim().toLowerCase()).filter((s) => s.length >= 2)])]
      : SEED_DIRECTORY;
  } catch {
    cachedDir = SEED_DIRECTORY;
  }
  cachedAt = now;
  return cachedDir;
}

/** Live directory size (seed + discovered) — for monitoring how wide the free net is. */
export async function directorySize(): Promise<number> {
  return (await hydrateDirectory()).length;
}

/**
 * A rotating batch of directory slugs (seed + discovered), so each accumulator cycle probes a
 * fresh slice and the whole directory is covered over successive cycles (then loops to refresh).
 * `offset` advances across cycles; returns the next `size` slugs and the new offset to persist.
 */
export async function directoryBatch(offset: number, size: number): Promise<{ slugs: string[]; nextOffset: number; total: number }> {
  const dir = await hydrateDirectory();
  const total = dir.length;
  if (!total) return { slugs: [], nextOffset: 0, total: 0 };
  const slugs: string[] = [];
  for (let i = 0; i < Math.min(size, total); i++) {
    slugs.push(dir[(offset + i) % total]);
  }
  return { slugs, nextOffset: (offset + slugs.length) % total, total };
}
