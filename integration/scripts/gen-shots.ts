/**
 * RecruitersOS · Hiring-signal screenshot generator (server CLI)
 *
 * Generates, ON THE SERVER, the job-post assets used for outreach: a full-page PNG still +
 * an auto-scrolling GIF (and WebP where sharp is available) of each role AS IT LIVES ON THE
 * HIRING COMPANY'S OWN careers page. Reuses the real capture pipeline (lib/inmarket/roleShot),
 * so the company-site / not-a-staffing-firm / right-role keyword gate is enforced — nothing is
 * captured unless it's verified.
 *
 * No UI: run it on the box, point email/video outreach at the files it writes. Assets land in
 *   $ROS_DATA_DIR/shots/<key>.{png,gif,webp}
 * and a human-readable index is written to
 *   $ROS_DATA_DIR/shots/manifest.json   ({ key -> {company, roleTitle, pageUrl, files, status} })
 *
 * Run (from integration/):
 *   npm run shots -- --company "Airbnb"          # one company
 *   npm run shots -- --limit 50 --roles 2        # first 50 pool companies, 2 roles each
 *   npm run shots -- --company "Stripe" --force  # re-capture even if assets exist
 *
 * Source of roles: the bundled in-market seed pool (lib/inmarket/seed-pool.json), which the
 * harvest fills with per-role URLs. Already-captured roles are skipped unless --force.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureRoleShot,
  shotKey,
  shotsDir,
  readShotAsset,
  shutdownBrowser,
  type ShotResult,
} from "../lib/inmarket/roleShot.ts";

/* ---------- args ---------- */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

const companyFilter = (arg("company") || "").toLowerCase();
const companyLimit = Number(arg("limit") || "0") || 0;          // 0 = no limit
const rolesPerCompany = Number(arg("roles") || "3") || 3;
const force = hasFlag("force");

/* ---------- seed-pool lead shape (only the bits we use) ---------- */
interface SeedLead {
  company: string;
  domain?: string;
  roleDetails?: Array<{ title: string; url?: string; postedAt?: string; location?: string }>;
  roles?: string[];
  sourceUrl?: string;
}

const here = fileURLToPath(new URL(".", import.meta.url));
const SEED = join(here, "..", "lib", "inmarket", "seed-pool.json");

async function loadLeads(): Promise<SeedLead[]> {
  const raw = JSON.parse(await readFile(SEED, "utf8")) as { leads?: SeedLead[] };
  let leads = raw.leads ?? [];
  if (companyFilter) leads = leads.filter((l) => l.company.toLowerCase().includes(companyFilter));
  if (companyLimit > 0) leads = leads.slice(0, companyLimit);
  return leads;
}

interface ManifestEntry {
  company: string;
  roleTitle: string;
  pageUrl?: string;
  status: ShotResult["status"];
  files?: ShotResult["files"];
  reason?: string;
  at?: string;
}

async function loadManifest(): Promise<Record<string, ManifestEntry>> {
  try {
    return JSON.parse(await readFile(join(shotsDir(), "manifest.json"), "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  const leads = await loadLeads();
  // Flatten to (company, roleTitle, url) jobs, capped per company.
  const jobs: Array<{ company: string; roleTitle: string; url?: string; domain?: string }> = [];
  for (const l of leads) {
    const details = (l.roleDetails && l.roleDetails.length ? l.roleDetails : (l.roles || []).map((t) => ({ title: t, url: undefined })))
      .filter((d) => d.title)
      .slice(0, rolesPerCompany);
    for (const d of details) jobs.push({ company: l.company, roleTitle: d.title, url: d.url || l.sourceUrl, domain: l.domain });
  }

  console.log(`Generating shots for ${jobs.length} roles across ${leads.length} companies${companyFilter ? ` (filter: "${companyFilter}")` : ""}...`);
  if (!jobs.length) { console.log("Nothing to do."); return; }

  await mkdir(shotsDir(), { recursive: true });
  const manifest = await loadManifest();
  const counts = { captured: 0, skipped: 0, no_page: 0, staffing: 0, error: 0 };

  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    const key = shotKey(j.company, j.roleTitle);
    const tag = `[${i + 1}/${jobs.length}] ${j.company} — ${j.roleTitle}`;

    // Skip when assets already exist on disk (unless --force).
    if (!force && (await readShotAsset(key, "png"))) {
      counts.skipped++;
      console.log(`  ⏭  ${tag} (already captured)`);
      continue;
    }

    process.stdout.write(`  …  ${tag} `);
    const r = await captureRoleShot({ company: j.company, roleTitle: j.roleTitle, roleUrl: j.url, domain: j.domain }, { force });
    manifest[key] = { company: j.company, roleTitle: j.roleTitle, pageUrl: r.pageUrl, status: r.status, files: r.files, reason: r.reason, at: r.at };

    if (r.status === "company_site") { counts.captured++; console.log(`✅ ${r.pageUrl}`); }
    else if (r.status === "staffing_blocked") { counts.staffing++; console.log(`🚫 staffing/recruiting firm — skipped`); }
    else if (r.status === "no_company_page") { counts.no_page++; console.log(`∅ no verified company page (${r.reason || ""})`); }
    else { counts.error++; console.log(`⚠️  ${r.reason || "error"}`); }

    // Persist the manifest incrementally so a long run is never lost.
    await writeFile(join(shotsDir(), "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  }

  await writeGallery(manifest);
  console.log(
    `\n✓ Done. captured ${counts.captured}, skipped ${counts.skipped}, no-page ${counts.no_page}, staffing ${counts.staffing}, errors ${counts.error}` +
    `\n  Assets + manifest in ${shotsDir()}` +
    `\n  Preview gallery: ${join(shotsDir(), "gallery.html")}  (open in a browser to watch the GIFs)`,
  );
}

/** Write a self-contained HTML gallery that plays every captured GIF inside a browser-window
 *  mockup (the address bar shows the real verified company URL). Open it in a browser. */
async function writeGallery(manifest: Record<string, ManifestEntry>) {
  const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
  const cards = Object.entries(manifest)
    .filter(([, m]) => m.status === "company_site" && m.files?.gif)
    .map(([key, m]) => `
    <figure class="card">
      <div class="chrome">
        <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
        <span class="addr">${esc(m.pageUrl || "")}</span>
      </div>
      <img loading="lazy" src="./${esc(key)}.gif" alt="${esc(m.company)} — ${esc(m.roleTitle)}" />
      <figcaption><b>${esc(m.company)}</b> — ${esc(m.roleTitle)} <a href="./${esc(key)}.png" target="_blank">still</a></figcaption>
    </figure>`).join("\n");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>RecruitersOS · Hiring-signal GIFs</title>
<style>
  body{margin:0;background:#0d1117;color:#e6edf3;font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif;padding:28px}
  h1{font-size:20px;margin:0 0 4px} p.sub{color:#8b949e;margin:0 0 24px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(440px,1fr));gap:24px}
  .card{margin:0;background:#161b22;border:1px solid #30363d;border-radius:12px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.4)}
  .chrome{display:flex;align-items:center;gap:7px;padding:9px 12px;background:#21262d;border-bottom:1px solid #30363d}
  .dot{width:11px;height:11px;border-radius:50%}.r{background:#ff5f56}.y{background:#ffbd2e}.g{background:#27c93f}
  .addr{margin-left:10px;flex:1;background:#0d1117;border-radius:6px;padding:4px 10px;font-size:12px;color:#8b949e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .card img{display:block;width:100%;background:#fff}
  figcaption{padding:10px 14px;font-size:13px;color:#c9d1d9}figcaption a{color:#58a6ff;margin-left:8px}
</style></head><body>
  <h1>Hiring-signal GIFs — captured from each company's own careers page</h1>
  <p class="sub">${Object.values(manifest).filter((m) => m.status === "company_site" && m.files?.gif).length} clips. Each plays an auto-scroll of the live job posting on the hiring company's own site.</p>
  <div class="grid">${cards}</div>
</body></html>`;
  await writeFile(join(shotsDir(), "gallery.html"), html, "utf8");
}

main()
  .catch((e) => { console.error("gen-shots failed:", e); process.exitCode = 1; })
  .finally(async () => { await shutdownBrowser(); });
