/**
 * RecruitersOS · In-Market seed pool
 *
 * A committed snapshot of real hiring companies (from the public-ATS harvester) bundled
 * with the app. The pool falls back to this whenever the live, accumulated pool is empty
 * — a fresh boot, no database, nothing run — so the Hiring Signals tab is NEVER empty on
 * first open. The background accumulator still builds and grows the real pool; once it has
 * entries, this fallback is bypassed automatically.
 *
 * Refresh it any time with:  node integration/scripts/harvest.mjs
 * (the harvester rewrites ./seed-pool.json). Curated to the 100-5,000 employee band.
 */

import type { InMarketLead } from "./index";
import seed from "./seed-pool.json";

interface SeedFile {
  generatedAt?: string;
  positions?: number;
  leads: InMarketLead[];
}

const FILE = seed as unknown as SeedFile;

/** The seeded hiring-company leads (real companies, curated to 100-5,000 employees). */
export const SEED_LEADS: InMarketLead[] = Array.isArray(FILE?.leads) ? FILE.leads : [];

/** When the seed was harvested (ISO), for the UI/banner. */
export const SEED_GENERATED_AT: string | null = FILE?.generatedAt ?? null;

/** Total open roles across the seed, summed at harvest time. */
export const SEED_POSITIONS: number =
  typeof FILE?.positions === "number"
    ? FILE.positions
    : SEED_LEADS.reduce((n, l) => n + (l.roleDetails?.length ?? l.roles?.length ?? 0), 0);

/** True when a usable seed is bundled. */
export function hasSeed(): boolean {
  return SEED_LEADS.length > 0;
}
