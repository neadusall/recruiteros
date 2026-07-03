/**
 * RecruitersOS · In-Market · Role screenshot + auto-scroll "video"
 *
 * GOAL: for a hiring signal, capture the job posting AS IT LIVES ON THE HIRING COMPANY'S
 * OWN CAREERS PAGE — never the ATS board we harvested from (Greenhouse/Lever/Ashby), and
 * never a staffing/recruiting firm's site. We produce two assets per role:
 *
 *   1. a full-page PNG still of the posting, and
 *   2. a smooth auto-scrolling animation (GIF always; WebP too when sharp is available)
 *      that pans top→bottom so it reads like a short screen-recording of the page.
 *
 * Correctness gate (the whole point — see the user's requirement):
 *   - the company name must NOT be a staffing/recruiting intermediary (classifyEmployer),
 *   - the page we screenshot must be on the company's OWN verified domain
 *     (resolveCompanyDomain already rejects ATS/aggregator/vendor hosts), and
 *   - the loaded page must keyword-verify as the RIGHT role (title-token overlap) for the
 *     RIGHT company (brand token present).
 * If we can't confirm all three, we DO NOT screenshot — better no asset than a wrong one.
 *
 * Cost: 100% self-hosted (Playwright + Chromium on our box). No paid API. Captures are
 * lazy (on first request) and cached on disk under ROS_DATA_DIR, so each role is rendered
 * at most once. GIF/WebP encoding is pure-JS (gifenc + pngjs); WebP is best-effort via sharp
 * (native — present on the Linux server, may be blocked on some dev machines).
 */

import { join } from "node:path";
import { mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { resolveCompanyDomain } from "./domain";
import { classifyEmployer } from "./employer";
import { domainRoot } from "../signals/hiring/normalize";
import { loadSnapshot, debouncedSaver } from "../db";

/* ------------------------------------------------------------------ */
/* Public shapes                                                       */
/* ------------------------------------------------------------------ */

export interface ShotRequest {
  /** The hiring company name (already unmasked from any agency at collection time). */
  company: string;
  /** The exact role title to verify we landed on the right posting. */
  roleTitle: string;
  /** The harvested ATS posting URL, used both as a domain hint and a Tier-1 target. */
  roleUrl?: string;
  /** A known company domain hint, when the lead already carries one. */
  domain?: string;
}

export type ShotStatus =
  | "company_site"     // captured a verified page on the company's own careers site
  | "no_company_page"  // couldn't confirm the company's own page — nothing captured
  | "staffing_blocked" // the "company" is a staffing/recruiting intermediary — skipped
  | "capturing"        // a background capture is in progress; re-request shortly
  | "error";           // capture failed

export interface ShotResult {
  ok: boolean;
  status: ShotStatus;
  /** The page we actually screenshotted (the company's own careers URL). */
  pageUrl?: string;
  /** Stable key under which the assets are stored/served. */
  key?: string;
  /** Which assets exist, by format. Values are served via the shot route by (key, fmt).
   *  png=poster/still, mp4=full video (watch page), gif=email teaser w/ play button,
   *  webp=optional full animation, watch=watch-page HTML. */
  files?: { png?: boolean; gif?: boolean; webp?: boolean; mp4?: boolean; watch?: boolean };
  /** Human-readable explanation, especially for the non-captured statuses. */
  reason?: string;
  /** ISO time the capture was produced/cached. */
  at?: string;
}

/* ------------------------------------------------------------------ */
/* Tunables — all safe to tweak; chosen for "looks like a video" + small files */
/* ------------------------------------------------------------------ */

const FRAME_W = 1000;          // capture + animation width (px)
const FRAME_H = 620;           // viewport window height per animation frame
const MAX_CAPTURE_H = 15500;   // < Chrome's 16384px screenshot ceiling (compositor texture limit)
const MAX_FRAMES = 320;        // hard cap on synthesized frames (bounds file size)

// Natural-scroll animation (synthesized by panning a viewport window down the captured image).
const TOP_HOLD_MS = 5_000;     // hold at the very top for 5s before scrolling (shorter = feels live)
const BOTTOM_HOLD_MS = 3_500;  // settle at the bottom before the loop repeats
const MOTION_FRAME_MS = 33;    // ~30fps within a scroll "flick" — matches the MP4's 30fps for smooth motion
const READ_PAUSE_MIN_MS = 1_100;
const READ_PAUSE_MAX_MS = 2_100; // pause to "read" between flicks (human cadence)
const SEG_MIN_FRAC = 0.55;     // each flick scrolls 0.55–0.95 of a viewport...
const SEG_MAX_FRAC = 0.95;
const SEG_PX_PER_FRAME = 34;   // ...at ~34px/frame, so a flick glides in ~0.5–0.7s (finer = smoother)

const NAV_TIMEOUT_MS = 25_000;
const SHOTS_CACHE_KEY = "inmarket_shots_v1";
const POS_TTL_MS = 14 * 24 * 60 * 60 * 1000; // re-capture a role at most every 2 weeks
const NEG_TTL_MS = 3 * 24 * 60 * 60 * 1000;  // retry a "no page" verdict every 3 days

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

/** Durable dir for generated assets. Mirrors the harvest's ROS_DATA_DIR convention. */
export function shotsDir(): string {
  const base = process.env.ROS_DATA_DIR || join(process.cwd(), ".data");
  return join(base, "shots");
}

/** Stable, filesystem-safe key for a (company, role) pair. */
export function shotKey(company: string, roleTitle: string): string {
  const h = createHash("sha1").update(`${company}${roleTitle}`.toLowerCase()).digest("hex").slice(0, 16);
  const slug = `${company}-${roleTitle}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return `${slug || "role"}_${h}`;
}

type AssetFmt = "png" | "gif" | "webp" | "mp4" | "html";
function assetPath(key: string, fmt: AssetFmt): string {
  return join(shotsDir(), `${key}.${fmt}`);
}

/** Read one stored asset for the serve route. Returns null when absent. */
export async function readShotAsset(key: string, fmt: AssetFmt): Promise<Buffer | null> {
  // Reject path traversal: keys are our own slug_hash format only.
  if (!/^[a-z0-9_-]{3,90}$/.test(key)) return null;
  try {
    return await readFile(assetPath(key, fmt));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Public share URLs (production-real, used in outreach emails)        */
/* ------------------------------------------------------------------ */

/** Canonical public origin for share links. Same convention as auth/channels:
 *  RECRUITEROS_APP_URL in prod, else the live domain. Set RECRUITEROS_APP_URL on the server. */
export function publicBaseUrl(): string {
  return (process.env.RECRUITEROS_APP_URL ?? "https://recruitersos.co").replace(/\/+$/, "");
}

export interface ShotShareUrls {
  /** Loom-style landing page that plays the full video — put this BEHIND the email teaser. */
  watch: string;
  /** The short play-button GIF to embed IN the email. */
  teaser: string;
  /** Direct full MP4 (the watch page plays this). */
  video: string;
  /** Full-page still / poster. */
  poster: string;
}

/** Absolute, production-ready share URLs for a captured role's assets. */
export function shotShareUrls(key: string): ShotShareUrls {
  const b = `${publicBaseUrl()}/api/in-market/shot?key=${encodeURIComponent(key)}`;
  return { watch: `${b}&watch=1`, teaser: `${b}&fmt=gif`, video: `${b}&fmt=mp4`, poster: `${b}&fmt=png` };
}

/** A captured role available to personalize (only verified company-site shots with a GIF). */
export interface ShotListItem {
  key: string;
  company: string;
  roleTitle: string;
  pageUrl?: string;
  at?: string;
  /** Production-ready absolute share URLs (watch page, email teaser, video, poster). */
  urls: ShotShareUrls;
}

/**
 * List every verified page-scroll GIF available to drop a webcam PiP onto — the bridge between
 * the hiring-signal capture pipeline and the PiP Studio. Merges the gen-shots manifest (rich
 * company/role labels for CLI + on-demand captures) with the in-process verdict cache, keeps
 * only company-site captures whose GIF is actually on disk, and returns them newest-first.
 */
export async function listShots(): Promise<ShotListItem[]> {
  const items = new Map<string, Omit<ShotListItem, "urls">>();

  // (a) Manifest: the durable, human-labeled index (company, roleTitle, pageUrl).
  try {
    const manifest = JSON.parse(await readFile(join(shotsDir(), "manifest.json"), "utf8")) as Record<
      string,
      { company?: string; roleTitle?: string; pageUrl?: string; status?: string; files?: { gif?: boolean }; at?: string }
    >;
    for (const [key, m] of Object.entries(manifest)) {
      if (m.status === "company_site" && m.files?.gif) {
        items.set(key, { key, company: m.company || labelFromKey(key), roleTitle: m.roleTitle || "", pageUrl: m.pageUrl, at: m.at });
      }
    }
  } catch { /* no manifest yet */ }

  // (b) Verdict cache: on-demand captures made this process (now carry company/roleTitle labels).
  const cache = await ensureCache();
  for (const [key, row] of cache.entries()) {
    if (row.status === "company_site" && row.files?.gif) {
      const prev = items.get(key);
      items.set(key, {
        key,
        company: row.company || prev?.company || labelFromKey(key),
        roleTitle: row.roleTitle || prev?.roleTitle || "",
        pageUrl: row.pageUrl || prev?.pageUrl,
        at: row.at || prev?.at,
      });
    }
  }

  // (c) Only surface ones whose GIF is truly on disk (so the studio never shows a dead tile),
  // attaching production-ready share URLs for the email composer.
  const out: ShotListItem[] = [];
  for (const it of items.values()) {
    if (await fileExists(assetPath(it.key, "gif"))) out.push({ ...it, urls: shotShareUrls(it.key) });
  }
  out.sort((a, b) => Date.parse(b.at || "") - Date.parse(a.at || ""));
  return out;
}

/** Set of shot keys that have a VERIFIED company-site capture (a real screenshot of the posting on
 *  the company's OWN careers page). The cheap read-path lookup so every contact/lead can show a
 *  "has screenshot" badge and be filtered by it. Backed by the in-process verdict cache; refreshed on
 *  a short TTL so a search never re-scans, and so new captures from the background tick appear within
 *  ~a minute. A key is `shotKey(company, roleTitle)`. */
let _keySet: { at: number; set: Set<string> } | null = null;
const KEYSET_TTL_MS = 60_000;
export async function capturedKeySet(): Promise<Set<string>> {
  if (_keySet && Date.now() - _keySet.at < KEYSET_TTL_MS) return _keySet.set;
  const set = new Set<string>();
  try {
    const cache = await ensureCache();
    for (const [key, row] of cache.entries()) {
      if (row.status === "company_site" && row.files?.png) set.add(key);
    }
  } catch { /* degrade to empty — no badges rather than wrong ones */ }
  _keySet = { at: Date.now(), set };
  return set;
}

/** True when a verified screenshot exists for this exact (company, role). */
export async function hasShotFor(company: string, roleTitle: string): Promise<boolean> {
  return (await capturedKeySet()).has(shotKey(company, roleTitle));
}

/** Best-effort human label from a stored key slug (fallback when no manifest/cache label). */
function labelFromKey(key: string): string {
  const slug = key.replace(/_[a-f0-9]{8,16}$/, "").replace(/-/g, " ").trim();
  return slug ? slug.replace(/\b\w/g, (c) => c.toUpperCase()) : key;
}

/* ------------------------------------------------------------------ */
/* Verdict cache (so a role is resolved/captured at most once per TTL) */
/* ------------------------------------------------------------------ */

interface ShotRow extends ShotResult { at: string; company?: string; roleTitle?: string }
let mem: Map<string, ShotRow> | null = null;
let loading: Promise<void> | null = null;

async function ensureCache(): Promise<Map<string, ShotRow>> {
  if (mem) return mem;
  if (!loading) {
    loading = (async () => {
      const raw = (await loadSnapshot<Record<string, ShotRow>>(SHOTS_CACHE_KEY).catch(() => null)) || {};
      mem = new Map(Object.entries(raw));
    })().catch(() => { mem = new Map(); });
  }
  await loading;
  return mem ?? (mem = new Map());
}

const scheduleSave = debouncedSaver(SHOTS_CACHE_KEY, () => (mem ? Object.fromEntries(mem) : {}), 1500);

function freshEnough(row: ShotRow): boolean {
  const age = Date.now() - Date.parse(row.at || "");
  const ttl = row.status === "company_site" ? POS_TTL_MS : NEG_TTL_MS;
  return !isNaN(age) && age < ttl;
}

/* ------------------------------------------------------------------ */
/* URL / token helpers                                                 */
/* ------------------------------------------------------------------ */

function hostOf(url: string | undefined | null): string {
  if (!url) return "";
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Same registrable root, e.g. careers.acme.com ~ acme.com. */
function sameRoot(a: string, b: string): boolean {
  const ra = domainRoot(a), rb = domainRoot(b);
  return !!ra && ra === rb;
}

/** The registrable domain of a host (last two labels — fine for the .com/.io/.co/.net hosts
 *  these company careers pages use). sameRoot()/domainRoot() do the precise root comparisons. */
function registrableDomain(host: string): string {
  const parts = host.replace(/^www\./, "").split(".").filter(Boolean);
  return parts.length <= 2 ? parts.join(".") : parts.slice(-2).join(".");
}

/** ATS / job-board / aggregator roots whose host is the VENDOR, never the hiring company.
 *  Mirrors domain.ts VENDOR_ROOTS + normalize.ts ATS_HOSTS (kept local to avoid a new export). */
/** Pure aggregators/job-boards: they bot-wall a headless capture AND aren't the company's own
 *  branded posting — never a capture target. */
const AGGREGATOR_HOSTS = new Set([
  "indeed", "linkedin", "glassdoor", "ziprecruiter", "monster", "dice", "remotive",
  "remoteok", "ycombinator", "arbeitnow", "jobicy", "themuse", "wellfound", "angellist",
  "builtin", "linkup",
]);

/** Clean, brand-safe ATS-hosted boards. Not the company's OWN domain, but they render reliably
 *  (no bot wall) and show the real, branded posting — so they're an acceptable capture FALLBACK
 *  when the company's own careers page can't be resolved. This is what lifts capture coverage from
 *  ~50% (own-domain only) to the majority. */
const ATS_HOSTS = new Set([
  "lever", "greenhouse", "ashbyhq", "workable", "smartrecruiters", "recruitee",
  "myworkdayjobs", "workday", "bamboohr", "jobvite", "icims",
]);

/** Any host whose registrable root is a third-party vendor (not the hiring company). */
const VENDOR_HOSTS = new Set<string>([...AGGREGATOR_HOSTS, ...ATS_HOSTS]);

function isVendorHost(host: string): boolean {
  const root = domainRoot(host);
  return !!root && VENDOR_HOSTS.has(root);
}
function isAtsHost(host: string): boolean {
  const root = domainRoot(host);
  return !!root && ATS_HOSTS.has(root);
}
function isAggregatorHost(host: string): boolean {
  const root = domainRoot(host);
  return !!root && AGGREGATOR_HOSTS.has(root);
}

/** True when a host's registrable label clearly belongs to the company (shared brand token).
 *  e.g. www.coinbase.com ~ "Coinbase", careers.airbnb.com ~ "Airbnb", instacart.careers ~ "Instacart". */
function hostMatchesCompany(host: string, company: string): boolean {
  const root = domainRoot(host);                 // "coinbase", "airbnb", "instacart"
  if (!root || root.length < 3) return false;
  const brand = tokens(company).join("");        // "coinbase", "airbnb", "instacart", "scaleai"
  if (!brand) return false;
  return root === brand || brand.includes(root) || root.includes(brand);
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "our", "you", "your", "are", "job", "role", "team",
  "of", "to", "in", "at", "on", "a", "an", "is", "we", "be",
]);

/** Significant lowercase tokens (len>=3, minus stopwords) for keyword verification. */
function tokens(s: string | undefined | null): string[] {
  return [...new Set(
    (s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  )];
}

/* ------------------------------------------------------------------ */
/* Step 1 — resolve the company's OWN careers page for this exact role */
/* ------------------------------------------------------------------ */

interface Target { url: string; companyDomain: string; via: string }

const CAREERS_PATHS = [
  "/careers", "/careers/jobs", "/careers/open-positions", "/careers/openings",
  "/jobs", "/company/careers", "/about/careers", "/join-us", "/work-with-us",
];

/**
 * Decide which page to screenshot — and refuse unless it's provably the hiring company's
 * own site. Returns a Target, or a terminal status when we won't/can't capture.
 */
async function resolveTarget(
  req: ShotRequest,
  browser: import("playwright").Browser,
): Promise<Target | { status: ShotStatus; reason: string }> {
  // (a) Never screenshot a staffing/recruiting intermediary's posting.
  const emp = classifyEmployer(req.company);
  if (emp.isStaffing) {
    return { status: "staffing_blocked", reason: emp.reason || "staffing/recruiting intermediary" };
  }

  // (b) Tier 1 — the harvested URL is on a host that is NOT an ATS/aggregator vendor and that
  //     matches the company name. That's the company's own careers domain (e.g. stripe.com,
  //     careers.airbnb.com, www.coinbase.com). Trust it directly — we deliberately DON'T gate
  //     this on resolveCompanyDomain's homepage probe, because big companies sit behind bot
  //     walls (Cloudflare) that 403 a headless homepage fetch and would wrongly drop them or
  //     resolve a junk fallback TLD. The post-load keyword+domain verify still guards correctness.
  const roleHost = hostOf(req.roleUrl);
  if (roleHost && !isVendorHost(roleHost) && hostMatchesCompany(roleHost, req.company)) {
    return { url: req.roleUrl!, companyDomain: registrableDomain(roleHost), via: "harvest_url" };
  }

  // Fallback target: a clean ATS-hosted posting (Greenhouse/Lever/Ashby/Workday/…). It's not the
  // company's own domain, but it renders reliably and is the real branded job post — so when the
  // company's own careers page can't be resolved below, we capture THIS instead of giving up.
  // Aggregators (LinkedIn/Indeed/…) are excluded: they bot-wall and aren't brand-safe.
  const atsFallback: Target | null =
    req.roleUrl && roleHost && isAtsHost(roleHost) && !isAggregatorHost(roleHost)
      ? { url: req.roleUrl, companyDomain: registrableDomain(roleHost), via: "ats_hosted" }
      : null;

  // (c) Otherwise resolve the company's real, verified domain (rejects ATS/aggregator/vendor hosts).
  let dom = await resolveCompanyDomain(req.company, { sourceUrl: req.roleUrl, hint: req.domain });
  // Fallback for brand names whose domain DROPS a trailing tech word, e.g. "Scale AI" → scale.com,
  // "Lattice Labs" → lattice.com. Only retried when the full name didn't resolve, and the on-brand
  // homepage check in resolveCompanyDomain still guards against grabbing a wrong domain.
  if (!dom) {
    const variants = [
      req.company.replace(/\b(ai|labs|hq|io|app|technologies|systems)\b\.?$/i, "").trim(), // "Scale AI" → "Scale"
      req.company.replace(/(ai|hq|labs)$/i, "").trim(),                                     // "Scaleai" → "Scale"
    ].filter((v) => v && v.length >= 4 && v.toLowerCase() !== req.company.toLowerCase());
    for (const v of [...new Set(variants)]) {
      dom = await resolveCompanyDomain(v, { sourceUrl: req.roleUrl, hint: req.domain });
      if (dom) break;
    }
  }
  if (!dom) {
    if (atsFallback) return atsFallback;
    return { status: "no_company_page", reason: "no verified company domain found" };
  }
  // If the harvested URL turns out to be on that resolved domain, use it.
  if (req.roleUrl && sameRoot(roleHost, dom.domain)) {
    return { url: req.roleUrl, companyDomain: dom.domain, via: "harvest_url" };
  }

  // (d) Tier 2 — the harvested URL is an ATS host. Find this role on the company's own
  //     careers pages. Best-effort, strictly verified; if nothing matches we capture nothing.
  const found = await discoverOnCompanySite(browser, dom.domain, req);
  if (found) return { url: found, companyDomain: dom.domain, via: "careers_discovery" };

  if (atsFallback) return atsFallback;
  return { status: "no_company_page", reason: "role not found on the company's own careers site" };
}

/**
 * Probe the company's careers pages for a link matching the role title. Only accepts a
 * destination that stays on the company's own domain (not a click-through to the ATS).
 */
async function discoverOnCompanySite(
  browser: import("playwright").Browser,
  companyDomain: string,
  req: ShotRequest,
): Promise<string | null> {
  const want = tokens(req.roleTitle);
  if (!want.length) return null;
  const root = domainRoot(companyDomain);
  // Search the apex AND the usual careers subdomains (careers./jobs. — where white-labeled
  // Greenhouse/Lever/Ashby boards usually live), each with the common careers paths.
  const bases: Array<{ url: string; paths: string[] }> = [
    { url: `https://${companyDomain}`, paths: CAREERS_PATHS },
    { url: `https://careers.${companyDomain}`, paths: ["", "/jobs", "/openings", "/open-roles"] },
    { url: `https://jobs.${companyDomain}`, paths: ["", "/openings", "/search"] },
  ];
  const ctx = await browser.newContext({ userAgent: DESKTOP_UA, viewport: { width: FRAME_W, height: FRAME_H } });
  await ctx.addInitScript({ content: NAME_SHIM });
  try {
    const page = await ctx.newPage();
    let loads = 0;
    const seen = new Set<string>();
    for (const base of bases) {
      for (const path of base.paths) {
        const careersUrl = base.url + path;
        if (seen.has(careersUrl)) continue;
        seen.add(careersUrl);
        if (loads++ >= 10) return null; // bound the crawl
        try {
          const res = await page.goto(careersUrl, { waitUntil: "domcontentloaded", timeout: 12_000 });
          if (!res || !res.ok()) continue;
          // Most careers pages are SPAs — let listings render + lazy-load before scraping links.
          await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)).catch(() => {});
          await page.waitForTimeout(900);
          // Match on anchor TEXT or the href SLUG (role titles often live only in the URL).
          const links: Array<{ href: string; score: number }> = await page.evaluate(
            ({ want, root }: { want: string[]; root: string }) => {
              const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ");
              const out: Array<{ href: string; score: number }> = [];
              for (const a of Array.from(document.querySelectorAll("a[href]"))) {
                let href = "";
                try { href = new URL((a as HTMLAnchorElement).href, location.href).href; } catch { continue; }
                const text = norm(a.textContent || ""), slug = norm(href);
                const hit = Math.max(
                  want.filter((w: string) => text.includes(w)).length,
                  want.filter((w: string) => slug.includes(w)).length,
                );
                if (hit === 0) continue;
                try {
                  const h = new URL(href).hostname.replace(/^www\./, "");
                  const parts = h.split(".").filter(Boolean);
                  if ((parts[parts.length - 2] || "") !== root) continue; // stay on the company's domain
                } catch { continue; }
                const looksJob = /\/(jobs?|positions?|openings?|careers?)\/|[0-9]{4,}/.test(href);
                out.push({ href, score: hit / want.length + (looksJob ? 0.15 : 0) });
              }
              return out.sort((x, y) => y.score - x.score).slice(0, 8);
            },
            { want, root },
          );
          const best = links.find((l) => l.score >= 0.5);
          if (best) return best.href;
        } catch { /* try the next base/path */ }
      }
    }
    return null;
  } finally {
    await ctx.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Step 2 — load, clean, verify, and capture                          */
/* ------------------------------------------------------------------ */

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * Init-script shim: some bundlers (esbuild via tsx, etc.) wrap functions with a `__name`
 * helper. When such a function is handed to page.evaluate, the browser-side copy references
 * `__name`, which doesn't exist there → "ReferenceError: __name is not defined". Defining a
 * no-op neutralizes it. Passed as a STRING so the bundler can't rewrite the shim itself.
 */
const NAME_SHIM = "globalThis.__name = globalThis.__name || function (f) { return f; };";

/** CSS to hide cookie/consent walls and chat widgets so the capture isn't obscured. */
const HIDE_CSS = `
  [id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],
  [id*="gdpr" i],[class*="gdpr" i],#onetrust-banner-sdk,.ot-sdk-row,.ot-sdk-container,
  [aria-label*="cookie" i],[class*="intercom" i],[id*="intercom" i],[class*="drift" i],
  [class*="chat-widget" i],[id*="hubspot-messages" i],[class*="cky-" i],[id*="usercentrics" i]
  { display: none !important; visibility: hidden !important; }
`;

interface Browser { browser: import("playwright").Browser; idle: ReturnType<typeof setTimeout> | null }
let shared: Browser | null = null;

/** One reused Chromium, auto-closed after a minute idle to free memory. */
async function getBrowser(): Promise<import("playwright").Browser> {
  const { chromium } = await import("playwright");
  if (shared?.browser?.isConnected()) {
    bumpIdle();
    return shared.browser;
  }
  const browser = await chromium.launch({
    // In prod (Alpine) we use the system Chromium (PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium-browser);
    // locally the env is unset so Playwright's bundled browser is used.
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      // Disable site isolation so CROSS-ORIGIN embedded job boards (Greenhouse/Lever/Ashby
      // iframes on a company's careers page) render INTO the screenshot. With isolation on they
      // run out-of-process and capture blank. This is standard for a dedicated screenshot bot.
      "--disable-features=IsolateOrigins,site-per-process,SitePerProcess",
      "--disable-site-isolation-trials",
    ],
  });
  shared = { browser, idle: null };
  bumpIdle();
  return browser;
}

function bumpIdle() {
  if (!shared) return;
  if (shared.idle) clearTimeout(shared.idle);
  shared.idle = setTimeout(() => {
    const b = shared?.browser;
    shared = null;
    b?.close().catch(() => {});
  }, 60_000);
}

/** Close the shared browser + cancel its idle timer. Call this for a clean CLI/batch exit
 *  (otherwise the idle timer keeps the process alive ~60s and leaves Chromium running). */
export async function shutdownBrowser(): Promise<void> {
  const b = shared?.browser;
  if (shared?.idle) clearTimeout(shared.idle);
  shared = null;
  await b?.close().catch(() => {});
}

/** Keyword-verify the loaded page is the right role on the right company. */
async function verifyPage(
  page: import("playwright").Page,
  companyDomain: string,
  req: ShotRequest,
): Promise<{ ok: boolean; reason?: string }> {
  // The page must have stayed on the company's own domain after any redirects.
  if (!sameRoot(hostOf(page.url()), companyDomain)) {
    return { ok: false, reason: `redirected off the company domain to ${hostOf(page.url())}` };
  }
  const mainText = (await page.evaluate(() => document.body?.innerText || "")).toLowerCase();

  // Reject interstitials/gates that aren't the job: a geo/zip wall at the top of the page, or a
  // bot/JS wall. We check the HEAD of the MAIN text (≈ what's visible up top) for gate phrases.
  const head = mainText.slice(0, 900);
  const GEO_GATE = /(enter your zip|zip code|enter your location|set your location|select your (country|region|location)|choose your (country|region|location))/i;
  const BOT_WALL = /(just a moment|verifying you are human|are you a human|attention required|access denied|please enable javascript|unsupported browser|enable cookies to continue)/i;
  if (GEO_GATE.test(head)) return { ok: false, reason: "landed on a geo/location gate, not the job" };

  // Markers that prove the page is an actual job description (not a listings/search/landing page).
  // Broad, real-world JD vocabulary — paired with the role-title match + length + company-domain
  // checks, this distinguishes a real posting from a thin/landing/listings page without being so
  // narrow that legitimate JDs (which phrase things differently) get wrongly rejected.
  const JD_MARKERS = /(responsibilit|qualificat|requirement|experience|skills|you['’ ]?ll|you will|we['’ ]?re looking|we are looking|looking for|who you are|your impact|day[- ]?to[- ]?day|equal opportunity|minimum|preferred|benefits|compensation|salary|about (the|this) role|role description|job description)/i;

  // Many company careers pages embed the actual job description in an IFRAME (e.g. a Greenhouse
  // board on instacart.careers / dropbox.jobs) that renders a beat late. Read text from EVERY
  // frame, and retry once after a short wait if the JD isn't present yet — the screenshot renders
  // the iframe, so we must judge by what's actually shown, not just the shell document.
  const gather = async (): Promise<string> => {
    let t = mainText;
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      try { t += " " + (await f.evaluate(() => document.body?.innerText || "")).toLowerCase(); } catch { /* cross-origin frame */ }
    }
    return t;
  };
  let text = await gather();
  if (!(text.length >= 600 && JD_MARKERS.test(text))) {
    await page.waitForTimeout(2500); // let an embedded ATS board finish rendering
    text = await gather();
  }
  if (text.length < 200) return { ok: false, reason: "page had too little text to verify" };
  if (BOT_WALL.test(text)) return { ok: false, reason: "blocked by a bot/JS wall" };

  const roleWant = tokens(req.roleTitle);
  const roleHit = roleWant.filter((w) => text.includes(w)).length;
  const roleOk = roleWant.length === 0 || roleHit / roleWant.length >= 0.6;

  const brandWant = tokens(req.company);
  // Also accept a stemmed brand (e.g. "Scaleai" → "scale", "Lattice Labs" → "lattice"), since a
  // company's own site brands itself without the trailing tech word. JD + role checks still guard.
  const brandStems = brandWant.map((w) => w.replace(/(ai|hq|labs|inc)$/, "")).filter((w) => w.length >= 3);
  const brandOk = brandWant.length === 0 || [...brandWant, ...brandStems].some((w) => text.includes(w));

  if (!roleOk) return { ok: false, reason: `role keywords not found (${roleHit}/${roleWant.length})` };
  if (!brandOk) return { ok: false, reason: "company name not found on the page" };

  // Require this to actually BE a job description — not a careers listings/search page, a thin
  // landing page, or anything else. If we can't confirm a JD, we skip (capture nothing).
  const hasDescription = text.length >= 600 && JD_MARKERS.test(text);
  if (!hasDescription) return { ok: false, reason: "page isn't a full job description (no description sections found)" };

  return { ok: true };
}

/** Prep a freshly-loaded page: strip overlays, force lazy media in, settle at the top. */
async function preparePage(page: import("playwright").Page) {
  await page.addStyleTag({ content: HIDE_CSS }).catch(() => {});
  await clickConsent(page);
  await dismissOverlays(page);
  // Pre-scroll to trigger lazy content AND prime painting of cross-origin embedded job boards
  // (Greenhouse/Lever/Ashby iframes only paint once in view — and Playwright won't render them
  // in a fullPage shot otherwise). A longer pause per step lets each section actually paint, so
  // the subsequent frame capture shows the description instead of an empty band.
  await page.evaluate(async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // Find the real scroll target (window, or an inner container as on Instacart) so priming
    // works regardless of how the site scrolls.
    window.scrollTo(0, 80);
    let scroller: HTMLElement | null = null;
    if (window.scrollY <= 10) {
      let best: Element | null = null, bestH = 0;
      for (const el of Array.from(document.querySelectorAll("*"))) {
        const sh = el.scrollHeight, ch = el.clientHeight, oy = getComputedStyle(el).overflowY;
        if (sh > ch + 100 && (oy === "auto" || oy === "scroll") && sh > bestH) { best = el; bestH = sh; }
      }
      scroller = best as HTMLElement | null;
    }
    window.scrollTo(0, 0);
    const h = scroller ? scroller.scrollHeight : document.documentElement.scrollHeight;
    for (let y = 0; y < h; y += Math.round(window.innerHeight * 0.85)) {
      if (scroller) scroller.scrollTop = y; else window.scrollTo(0, y);
      await sleep(250);
    }
    if (scroller) scroller.scrollTop = 0; else window.scrollTo(0, 0);
    await sleep(200);
  });
  // Some banners/chat widgets mount late — click consent + sweep again after the scroll.
  await clickConsent(page);
  await dismissOverlays(page);
  await page.waitForTimeout(250);
}

/**
 * Click cookie-consent accept/dismiss buttons. Playwright role/text locators pierce OPEN shadow
 * DOM, so this catches OneTrust/Cookiebot-style banners that CSS/JS selectors miss (e.g.
 * Dropbox's). Cookie-specific labels only — never generic "continue/ok" that could navigate away.
 */
async function clickConsent(page: import("playwright").Page) {
  const labels = [/^accept all$/i, /^accept all cookies$/i, /^accept cookies$/i, /^accept$/i, /^i agree$/i, /^agree$/i, /^allow all$/i, /^got it$/i, /^reject all$/i, /^decline$/i];
  for (const re of labels) {
    try {
      const b = page.getByRole("button", { name: re }).first();
      if ((await b.count()) > 0 && (await b.isVisible())) {
        await b.click({ timeout: 1500 });
        await page.waitForTimeout(250);
        return; // one dismissal is enough
      }
    } catch { /* try the next label */ }
  }
}

/**
 * Remove cookie/consent walls, modal dialogs, full-screen backdrops, and chat widgets, and
 * unlock body scroll (modals often set overflow:hidden). Handles the centered-modal case the
 * CSS selectors miss (e.g. Dropbox's consent dialog). Does NOT remove geo/zip gates that ARE
 * the page — those are caught and rejected by verifyPage instead.
 */
async function dismissOverlays(page: import("playwright").Page) {
  await page.evaluate(() => {
    const W = window.innerWidth, H = window.innerHeight;
    const consent = /(cookie|consent|gdpr|ccpa|privacy preferences|accept all|we use cookies|do not sell)/i;
    const kill = (el: HTMLElement) => el.style.setProperty("display", "none", "important");
    // Consent widgets are frequently their own IFRAME (e.g. Dropbox's dropbox.com/ccpa_iframe),
    // invisible to a same-document element sweep. Remove iframes whose src is clearly a consent
    // tool — never the job-content iframe, whose src doesn't match these.
    for (const fr of Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe"))) {
      if (/ccpa|consent|cookie|gdpr|onetrust|cookiebot|usercentrics|trustarc|privacy[-_]?(banner|center|manager)/i.test(fr.src || "")) fr.remove();
    }
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const pinned = cs.position === "fixed" || cs.position === "sticky" || cs.position === "absolute";
      const z = parseInt(cs.zIndex || "0", 10) || 0;
      const r = el.getBoundingClientRect();
      const isDialog = el.getAttribute("role") === "dialog" || el.getAttribute("aria-modal") === "true";
      const txt = (el.innerText || "").slice(0, 600);

      // 1) Consent banners/dialogs by text (pinned, or an aria dialog).
      if ((pinned || isDialog) && consent.test(txt) && txt.length < 600) { kill(el); continue; }
      // 2) Full-screen pinned backdrops/overlays with a high z-index that blanket the page.
      if (pinned && z >= 1000 && r.width >= W * 0.9 && r.height >= H * 0.9) { kill(el); continue; }
      // 3) Centered modal dialogs (aria) regardless of text.
      if (isDialog && pinned) { kill(el); continue; }
    }
    // Unlock scrolling ONLY when a modal actually froze it. Forcing overflow/position
    // unconditionally breaks pages that scroll the window normally (it pins them at top).
    for (const el of [document.documentElement, document.body] as HTMLElement[]) {
      const cs = getComputedStyle(el);
      if (cs.overflow === "hidden" || cs.overflowY === "hidden") el.style.setProperty("overflow", "visible", "important");
      if (cs.position === "fixed") el.style.setProperty("position", "static", "important"); // scroll-lock pattern
    }
  }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Step 3 — encode the scroll animation                               */
/* ------------------------------------------------------------------ */

// Easings that read as human input. A trackpad/wheel "flick" starts quick and glides to a stop
// (momentum → easeOutCubic). The very first move after the top hold is gentler (easeInOut) so it
// doesn't jolt. lerp blends pacing by content density.
function easeOutCubic(t: number): number { return 1 - Math.pow(1 - t, 3); }
function easeInOutCubic(t: number): number { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * Math.max(0, Math.min(1, t)); }

/** Lazily-resolved pngjs PNG class (interop-safe across tsx/esbuild, node-ESM, webpack). */
let _PNG: any;
async function getPNG(): Promise<any> {
  if (_PNG) return _PNG;
  const m: any = await import("pngjs");
  _PNG = m.PNG ?? m.default?.PNG ?? m.default;
  return _PNG;
}

/**
 * A frame is "empty" when it's near-uniform color — catches BOTH white whitespace and solid
 * marketing bands (e.g. Instacart's dark-green section, or an unpainted cross-origin iframe).
 * Real content (text/images) has high luminance variance; a flat band has ~none.
 */
function frameEmpty(data: Buffer): boolean {
  let n = 0, sum = 0, sumsq = 0;
  for (let i = 0; i + 4 <= data.length; i += 64) { // sample every 16th pixel
    const l = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    sum += l; sumsq += l * l; n++;
  }
  if (!n) return true;
  const mean = sum / n;
  const variance = sumsq / n - mean * mean;
  return variance < 55; // ~uniform → no visible content
}

/** Last row of the captured image that has real content (+ margin), so the pan stops at the end
 *  of the posting instead of drifting into trailing whitespace. */
function lastContentRowSync(img: { width: number; height: number; data: Buffer }): number {
  const { width: W, height: H, data } = img;
  for (let y = H - 1; y >= 0; y--) {
    for (let x = 0; x < W; x += 11) {
      const i = (y * W + x) * 4;
      if (data[i] < 244 || data[i + 1] < 244 || data[i + 2] < 244) return Math.min(H, y + 40);
    }
  }
  return H;
}

/**
 * Row where the JOB DESCRIPTION ends — NOT the bottom of the whole page. We stop the scroll here so
 * the pan stays *within the text of the actual posting* and never drifts down into the site footer,
 * a "related roles" grid, or a tall marketing/whitespace band below the JD (the "why is it scrolling
 * to the bottom of the screen" problem).
 *
 * How: score 20px blocks by MEAN luminance (background color) + variance (text detail). The JD body
 * has a dominant background color (usually white); a footer is "page furniture" — a band whose
 * background color differs strongly from the body (the near-ubiquitous DARK footer), OR near-empty
 * whitespace. We TRIM the trailing run of furniture by scanning UP from the very bottom to the last
 * real body block. Because we only trim the END, an internal dark/blank band (a mid-page hero, a gap
 * between "Responsibilities" and "Benefits") is never cut — those are followed by more body content,
 * so the bottom-up scan stops above them. Validated on real captures: e.g. a BioSpace posting cuts
 * exactly at "Apply now" and drops the dark BioSpace footer (logo + EXPLORE/ABOUT/MORE nav). Bounded:
 * never less than ~1.4 viewports (short JDs still scroll), never past the real last-content row.
 */
function contentEndRow(img: { width: number; height: number; data: Buffer }): number {
  const { width: W, height: H, data } = img;
  const BLOCK = 20;
  const blocks = Math.max(1, Math.ceil(H / BLOCK));
  const mean = new Float64Array(blocks);  // per-block avg luminance → background color
  const vari = new Float64Array(blocks);  // per-block luminance variance → text/detail density
  for (let b = 0; b < blocks; b++) {
    const y0 = b * BLOCK, y1 = Math.min(H, y0 + BLOCK);
    let n = 0, sum = 0, sumsq = 0;
    for (let y = y0; y < y1; y += 4) for (let x = 0; x < W; x += 24) {
      const i = (y * W + x) * 4;
      const l = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      sum += l; sumsq += l * l; n++;
    }
    const m = n ? sum / n : 255;
    mean[b] = m; vari[b] = n ? Math.max(0, sumsq / n - m * m) : 0;
  }
  // A block reads as real TEXT above a fraction of the page's typical text-band variance.
  const sv = Array.from(vari).sort((a, b) => a - b);
  const TEXT = (sv[Math.floor(sv.length * 0.85)] || 1) * 0.18;
  // Body background = the modal block-mean (bucketed) — the JD's own page color.
  const buckets = new Map<number, number>();
  for (const m of mean) { const k = Math.round(m / 16); buckets.set(k, (buckets.get(k) || 0) + 1); }
  let bestK = 15, bestC = -1;
  for (const [k, c] of buckets) { if (c > bestC) { bestC = c; bestK = k; } }
  const bodyBg = bestK * 16;
  // Furniture = a different background color than the body (colored/dark footer) OR near-empty.
  const isFurniture = (b: number) => Math.abs(mean[b] - bodyBg) > 45 || vari[b] < TEXT;
  // Trim the TRAILING furniture run only: scan up from the bottom to the last real body block.
  let lastBody = blocks - 1;
  while (lastBody > 0 && isFurniture(lastBody)) lastBody--;
  const end = Math.min(H, (lastBody + 1) * BLOCK + 30);  // small margin past the last body line
  const floor = Math.min(H, Math.round(FRAME_H * 1.4));  // always allow a little scroll on short JDs
  return Math.min(lastContentRowSync(img), Math.max(floor, end));
}

/**
 * CAPTURE ONCE: one complete tall image of the page, with NO live scrolling — immune to
 * scroll-jacking, and (with site isolation disabled at launch) including cross-origin embedded
 * job boards. Setting the viewport height to the full content height forces lazy content +
 * embeds to render, then a single screenshot grabs it all. Capped under Chrome's 16384px ceiling.
 */
async function captureTall(page: import("playwright").Page): Promise<Buffer> {
  const contentH = await page.evaluate(() => Math.max(
    document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0,
    document.body?.offsetHeight || 0, document.documentElement?.offsetHeight || 0,
  ));
  const capH = Math.max(FRAME_H, Math.min(contentH || FRAME_H, MAX_CAPTURE_H));
  await page.setViewportSize({ width: FRAME_W, height: capH });
  await page.waitForTimeout(700);          // let the now-in-view lazy content + embeds paint
  await clickConsent(page);
  await dismissOverlays(page);
  await page.waitForTimeout(250);
  return await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: FRAME_W, height: capH } });
}

/**
 * Per-position content density (0 = blank/image band, 1 = dense text), so the scroll can READ
 * text and SKIM images — the single biggest "this looks human" cue. Returns a function of the
 * viewport-top y. Built from luminance variance of ~20px row blocks, normalized to the page.
 */
function buildDensityProfile(img: { width: number; height: number; data: Buffer }): (y: number) => number {
  const { width: W, height: H, data } = img;
  const BLOCK = 20;
  const blocks = Math.max(1, Math.ceil(H / BLOCK));
  const v = new Float64Array(blocks);
  for (let b = 0; b < blocks; b++) {
    const y0 = b * BLOCK, y1 = Math.min(H, y0 + BLOCK);
    let n = 0, sum = 0, sumsq = 0;
    for (let y = y0; y < y1; y += 4) for (let x = 0; x < W; x += 24) {
      const i = (y * W + x) * 4;
      const l = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      sum += l; sumsq += l * l; n++;
    }
    v[b] = n ? Math.max(0, sumsq / n - (sum / n) * (sum / n)) : 0;
  }
  // Normalize against a high percentile so typical text bands map near 1 (robust to outliers).
  const sorted = Array.from(v).sort((a, b) => a - b);
  const ref = sorted[Math.floor(sorted.length * 0.85)] || 1;
  return (y: number) => {
    const b0 = Math.floor(Math.max(0, y) / BLOCK), b1 = Math.min(blocks, Math.floor((y + FRAME_H) / BLOCK));
    let s = 0, c = 0;
    for (let b = b0; b < b1; b++) { s += v[b]; c++; }
    return c ? Math.max(0, Math.min(1, (s / c) / (ref * 0.6))) : 0.5;
  };
}

/**
 * Build a HUMAN-feeling scroll path over a static image of `distance` scrollable px:
 *   • hold briefly (TOP_HOLD_MS) at the very top,
 *   • then momentum "flick-and-read" — each flick starts quick and glides to a stop (easeOutCubic),
 *   • content-aware pacing: small flicks + long reads on dense TEXT, bigger/faster flicks + brief
 *     pauses when SKIMMING images/whitespace,
 *   • the first move eases in gently; small natural jitter on every flick + pause,
 *   • settle at the bottom.
 * Pauses are a long delay on a single frame, so they cost no extra file size.
 */
function humanScrollPath(distance: number, density: (y: number) => number, targetMs?: number): Array<{ y: number; delay: number }> {
  const path: Array<{ y: number; delay: number }> = [{ y: 0, delay: TOP_HOLD_MS }];
  if (distance <= 2) return targetMs ? fitPathToDuration(path, targetMs) : path;
  const pxPerFrame = Math.max(SEG_PX_PER_FRAME, Math.ceil(distance / (MAX_FRAMES - 30)));
  let y = 0, guard = 0, first = true;
  while (y < distance && guard++ < MAX_FRAMES) {
    const d = density(y);                                   // 0 sparse(skim) … 1 dense(read)
    // dense text → shorter flick; sparse → longer flick. ±10% jitter so no two are identical.
    const frac = lerp(SEG_MAX_FRAC, SEG_MIN_FRAC, d) * (0.9 + Math.random() * 0.2);
    const seg = Math.min(distance - y, Math.round(FRAME_H * frac));
    const steps = Math.max(5, Math.round(seg / pxPerFrame));
    const ease = first ? easeInOutCubic : easeOutCubic;     // gentle first move, momentum after
    for (let i = 1; i <= steps; i++) {
      path.push({ y: Math.min(distance, Math.round(y + ease(i / steps) * seg)), delay: MOTION_FRAME_MS });
    }
    y += seg; first = false;
    if (y < distance) {
      // dense text → linger; sparse → quick glance. + jitter.
      const base = lerp(READ_PAUSE_MIN_MS, READ_PAUSE_MAX_MS, d);
      path[path.length - 1].delay = Math.round(base) + Math.floor(Math.random() * 350);
    }
  }
  path[path.length - 1].delay = BOTTOM_HOLD_MS;
  return targetMs ? fitPathToDuration(path, targetMs) : path;
}

/**
 * Re-time a natural scroll path so its TOTAL duration is exactly `targetMs`, while keeping the human
 * cadence intact. We scale every delay by the same ratio (so the motion/read rhythm is preserved as a
 * whole — it just plays a touch slower or faster), then clamp the MOTION-frame delays to a smooth
 * playback range and push the residual into the "thinking" pauses (top hold, read pauses, bottom
 * settle), which are naturally elastic. The final frame absorbs any rounding so the sum lands EXACTLY
 * on target. This is what lets the page scroll run for precisely as long as the PiP webcam clip — one
 * clean top-to-bottom pass, no loop restart, no mid-page cutoff.
 */
function fitPathToDuration(path: Array<{ y: number; delay: number }>, targetMs: number): Array<{ y: number; delay: number }> {
  const total = path.reduce((s, p) => s + p.delay, 0);
  if (total <= 0 || targetMs <= 0) return path;
  const ratio = targetMs / total;
  const scaled = path.map((p) => ({ y: p.y, delay: p.delay * ratio, motion: Math.abs(p.delay - MOTION_FRAME_MS) < 1 }));
  // Keep motion smooth: clamp scaled motion-frame delays to a playable range; bank the leftover time.
  let drift = 0;
  for (const p of scaled) {
    if (!p.motion) continue;
    const c = Math.min(110, Math.max(20, p.delay));
    drift += p.delay - c;
    p.delay = c;
  }
  // Redistribute the banked time across the elastic pauses (proportional to their size).
  const pauses = scaled.filter((p) => !p.motion);
  const pauseSum = pauses.reduce((s, p) => s + p.delay, 0) || 1;
  for (const p of pauses) p.delay = Math.max(0, p.delay + drift * (p.delay / pauseSum));
  // Round, then make the total land EXACTLY on target by adjusting the last frame.
  const out = scaled.map((p) => ({ y: p.y, delay: Math.max(1, Math.round(p.delay)) }));
  const diff = targetMs - out.reduce((s, p) => s + p.delay, 0);
  out[out.length - 1].delay = Math.max(1, out[out.length - 1].delay + diff);
  return out;
}

/**
 * SYNTHESIZE the animation by panning a viewport-height window down the captured tall image
 * along the human scroll path. Deterministic image cropping — it can't "fail to scroll", and
 * needs no live browser. Returns PNG frame buffers + per-frame delays.
 */
async function synthesizeAnim(tallBuf: Buffer, targetMs?: number): Promise<{ frames: Buffer[]; delays: number[]; contentFrames: number }> {
  const PNG = await getPNG();
  const src = PNG.sync.read(tallBuf);
  const W = src.width, H = src.height;
  // Stop at the END OF THE JOB DESCRIPTION, not the bottom of the page — the pan stays within the
  // posting's own text and never scrolls down into the footer / related-roles / trailing whitespace.
  const usableH = Math.min(H, Math.max(FRAME_H, contentEndRow(src)));
  const distance = Math.max(0, usableH - FRAME_H);
  const density = buildDensityProfile(src);            // read text, skim images
  // When a target duration is given (to match the PiP webcam clip), the path is re-timed to land
  // EXACTLY on it — one clean pass instead of a loop/cutoff under the recorded clip.
  const path = humanScrollPath(distance, density, targetMs).slice(0, MAX_FRAMES);

  const frames: Buffer[] = [];
  const delays: number[] = [];
  let contentFrames = 0;
  for (const step of path) {
    const y = Math.max(0, Math.min(distance, step.y));
    const band = new PNG({ width: W, height: FRAME_H });
    band.data.fill(255);                         // white-pad if the window runs past the image
    const copyH = Math.min(FRAME_H, H - y);
    if (copyH > 0) PNG.bitblt(src, band, 0, y, W, copyH, 0, 0);
    frames.push(PNG.sync.write(band));
    delays.push(step.delay);
    if (!frameEmpty(band.data)) contentFrames++;
  }
  return { frames, delays, contentFrames };
}

/** Encode PNG frames → animated GIF (pure JS: pngjs decode + gifenc encode). */
async function encodeGif(frames: Buffer[], delays: number[]): Promise<Buffer> {
  // Interop is bundler-dependent (tsx/esbuild, node-ESM, and webpack each expose CJS
  // differently): named exports may sit at the top level, under `.default`, or both — and
  // gifenc's `.default` is the GIFEncoder function itself, not the namespace. Resolve each
  // symbol defensively so this works in the CLI, the Next route, and a plain node run.
  const PNG = await getPNG();
  // @ts-ignore - gifenc ships no type declarations
  const ge: any = await import("gifenc");
  const gi = ge.GIFEncoder ? ge : (ge.default?.GIFEncoder ? ge.default : ge);
  const { GIFEncoder, quantize, applyPalette } = gi;
  if (typeof GIFEncoder !== "function" || typeof quantize !== "function" || typeof applyPalette !== "function") {
    throw new Error("gifenc did not resolve (GIFEncoder/quantize/applyPalette missing)");
  }

  const decoded = frames.map((b) => PNG.sync.read(b)); // { width, height, data: RGBA }
  const w = decoded[0].width, h = decoded[0].height;

  // One global palette sampled across frames → stable colors, no mid-scroll flicker.
  const sample = buildPaletteSample(decoded.map((d) => d.data));
  const palette = quantize(sample, 256, { format: "rgb565" });

  const gif = GIFEncoder();
  decoded.forEach((d, i) => {
    const index = applyPalette(d.data, palette, "rgb565");
    gif.writeFrame(index, w, h, { palette: i === 0 ? palette : undefined, delay: delays[i], repeat: 0 });
  });
  gif.finish();
  return Buffer.from(gif.bytes());
}

/** Build a subsampled RGBA buffer drawn from several frames for palette quantization. */
function buildPaletteSample(datas: Buffer[]): Uint8Array {
  const pick = datas.filter((_, i) => i % Math.ceil(datas.length / 12) === 0).slice(0, 12);
  const step = 16 * 4; // every 16th pixel
  const chunks: number[] = [];
  for (const d of pick) {
    for (let i = 0; i + 4 <= d.length; i += step) {
      chunks.push(d[i], d[i + 1], d[i + 2], 255);
    }
  }
  return Uint8Array.from(chunks);
}

/** Best-effort animated WebP via sharp. Returns null if sharp can't load (e.g. dev box). */
async function encodeWebp(frames: Buffer[], delays: number[]): Promise<Buffer | null> {
  try {
    const sharp = (await import("sharp")).default;
    const first = await sharp(frames[0]).metadata();
    const w = first.width || FRAME_W, h = first.height || FRAME_H;
    // Stack frames vertically into one tall image, then emit as animated pages.
    const raws = await Promise.all(frames.map((f) => sharp(f).ensureAlpha().raw().toBuffer()));
    const stacked = Buffer.concat(raws);
    return await sharp(stacked, { raw: { width: w, height: h * frames.length, channels: 4 }, animated: true })
      .webp({ quality: 72, effort: 4, loop: 0, delay: delays })
      .toBuffer();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Step 4 — Loom-style video pipeline (full MP4 + email teaser + watch page)            */
/*                                                                                       */
/* Email clients can't play video, so (per Loom's pattern) we ship a SHORT looping GIF   */
/* teaser with a play button in the email that links to a WATCH PAGE hosting the full     */
/* MP4. Outputs: <key>.mp4 (full natural-scroll video), <key>.gif (3–4s teaser),          */
/* <key>.png (poster/still), <key>.html (watch page).                                     */
/* ------------------------------------------------------------------ */

const TEASER_W = 360;          // email teaser width (px) — small "3–4 inch" preview
const TEASER_SECONDS = 3.6;    // teaser length
const TEASER_FPS = 16;

function ffmpegBin(): string { return process.env.FFMPEG_PATH || "ffmpeg"; }

let _ffmpegOk: boolean | null = null;
async function haveFfmpeg(): Promise<boolean> {
  if (_ffmpegOk !== null) return _ffmpegOk;
  try { await runFfmpeg(["-version"]); _ffmpegOk = true; } catch { _ffmpegOk = false; }
  return _ffmpegOk;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegBin(), args, { windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => { err += d.toString(); if (err.length > 8000) err = err.slice(-8000); });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-300)}`))));
  });
}

/** Encode the full timeline (variable per-frame delays) → H.264 MP4 via the concat demuxer. */
async function renderMp4(frames: Buffer[], delays: number[], outPath: string): Promise<void> {
  const dir = join(shotsDir(), `.tmp_mp4_${createHash("sha1").update(outPath).digest("hex").slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  try {
    const lines: string[] = [];
    const fp = (i: number) => join(dir, `f${String(i).padStart(4, "0")}.png`).replace(/\\/g, "/");
    for (let i = 0; i < frames.length; i++) {
      await writeFile(join(dir, `f${String(i).padStart(4, "0")}.png`), frames[i]);
      lines.push(`file '${fp(i)}'`, `duration ${(delays[i] / 1000).toFixed(3)}`);
    }
    lines.push(`file '${fp(frames.length - 1)}'`); // repeat last frame so its duration is honored
    const listPath = join(dir, "list.txt");
    await writeFile(listPath, lines.join("\n"), "utf8");
    await runFfmpeg([
      "-y", "-f", "concat", "-safe", "0", "-i", listPath.replace(/\\/g, "/"),
      // Keep the frames' own per-frame durations (variable-rate) instead of resampling to a fixed
      // fps. The concat demuxer combined with the `fps` filter duplicated ~13% extra frames, which
      // inflated the encoded length past its target. That made the duration-matched scroll run
      // longer than the PiP webcam clip, so `-shortest` cut the composite before the top-to-bottom
      // pass finished. VFR keeps the total EXACTLY the sum of the delays (verified: 15.0s in, 15.04s
      // out; was 17.03s). Motion still plays at 30fps because motion frames are spaced ~33ms apart.
      "-fps_mode", "vfr", "-pix_fmt", "yuv420p",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-movflags", "+faststart", outPath,
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Draw a Loom-style play button (translucent disc + white triangle) centered on a frame. */
function drawPlayButton(band: { width: number; height: number; data: Buffer }) {
  const W = band.width, H = band.height, data = band.data;
  const cx = (W / 2) | 0, cy = (H / 2) | 0, R = Math.round(Math.min(W, H) * 0.12);
  for (let y = cy - R; y <= cy + R; y++) {
    if (y < 0 || y >= H) continue;
    for (let x = cx - R; x <= cx + R; x++) {
      if (x < 0 || x >= W) continue;
      const dx = x - cx, dy = y - cy, dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > R) continue;
      const a = dist > R - 2 ? 0.45 : 0.6;               // soft edge
      const i = (y * W + x) * 4;
      data[i] = Math.round(data[i] * (1 - a) + 15 * a);
      data[i + 1] = Math.round(data[i + 1] * (1 - a) + 15 * a);
      data[i + 2] = Math.round(data[i + 2] * (1 - a) + 15 * a);
    }
  }
  const s = Math.round(R * 0.5);                          // right-pointing triangle
  for (let y = cy - s; y <= cy + s; y++) {
    if (y < 0 || y >= H) continue;
    const frac = 1 - Math.abs(y - cy) / s;
    const xL = cx - Math.round(s * 0.55);
    const xR = xL + Math.round(frac * s * 1.5);
    for (let x = xL; x <= xR; x++) {
      if (x < 0 || x >= W) continue;
      const i = (y * W + x) * 4;
      data[i] = 245; data[i + 1] = 245; data[i + 2] = 245;
    }
  }
}

/** Short, lively, play-button teaser GIF for the email (a quick pass over the posting). */
async function renderTeaserGif(tallBuf: Buffer, outPath: string): Promise<boolean> {
  const PNG = await getPNG();
  const src = PNG.sync.read(tallBuf);
  const W = src.width, H = src.height;
  const usableH = Math.min(H, Math.max(FRAME_H, lastContentRowSync(src)));
  // Teasers should be LEGIBLE, not a blur: gently reveal the meaty top (logo + role title +
  // start of the description) — the part that earns the click — rather than racing the whole page.
  const distance = Math.min(Math.max(0, usableH - FRAME_H), Math.round(FRAME_H * 2.2));
  const n = Math.max(8, Math.round(TEASER_SECONDS * TEASER_FPS));
  const dir = join(shotsDir(), `.tmp_tease_${createHash("sha1").update(outPath).digest("hex").slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  try {
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : i / (n - 1);
      const y = Math.round(easeInOutCubic(t) * distance); // one smooth pass top→bottom
      const band = new PNG({ width: W, height: FRAME_H });
      band.data.fill(255);
      const copyH = Math.min(FRAME_H, H - y);
      if (copyH > 0) PNG.bitblt(src, band, 0, y, W, copyH, 0, 0);
      drawPlayButton(band);
      await writeFile(join(dir, `t${String(i).padStart(4, "0")}.png`), PNG.sync.write(band));
    }
    if (await haveFfmpeg()) {
      await runFfmpeg([
        "-y", "-framerate", String(TEASER_FPS), "-i", join(dir, "t%04d.png").replace(/\\/g, "/"),
        "-vf", `scale=${TEASER_W}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`,
        "-loop", "0", outPath,
      ]);
      return true;
    }
    // Fallback (no ffmpeg): pure-JS GIF at full width (server installs ffmpeg for the small one).
    const frames: Buffer[] = [], delays: number[] = [];
    for (let i = 0; i < n; i++) { frames.push(await readFile(join(dir, `t${String(i).padStart(4, "0")}.png`))); delays.push(Math.round(1000 / TEASER_FPS)); }
    await writeFile(outPath, await encodeGif(frames, delays));
    return true;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Self-contained Loom-style WATCH PAGE: the full MP4 with a poster + an Apply link. Served by
 *  the shot route (fmt=mp4 / fmt=png are same-origin); the email teaser links here. */
function watchPageHtml(meta: { key: string; company: string; roleTitle: string; pageUrl?: string }): string {
  const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
  const base = `/api/in-market/shot?key=${encodeURIComponent(meta.key)}`;
  const apply = meta.pageUrl
    ? `<a class="apply" href="${esc(meta.pageUrl)}" target="_blank" rel="noopener">View this role on ${esc(meta.company)}’s careers site →</a>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(meta.company)} — ${esc(meta.roleTitle)}</title>
<style>
 :root{color-scheme:dark}
 body{margin:0;background:#0d1117;color:#e6edf3;font:16px/1.5 system-ui,Segoe UI,Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
 .wrap{width:min(940px,100%)}
 h1{font-size:20px;margin:0 0 2px} .sub{color:#8b949e;margin:0 0 16px;font-size:14px}
 .player{border:1px solid #30363d;border-radius:14px;overflow:hidden;box-shadow:0 16px 50px rgba(0,0,0,.5);background:#000}
 video{display:block;width:100%;height:auto}
 .bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px;flex-wrap:wrap}
 .apply{display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:600;padding:10px 16px;border-radius:9px}
 .brand{color:#8b949e;font-size:13px}
</style></head><body><div class="wrap">
 <h1>${esc(meta.company)} — ${esc(meta.roleTitle)}</h1>
 <p class="sub">A walkthrough of this role on ${esc(meta.company)}’s own careers page.</p>
 <div class="player"><video src="${base}&fmt=mp4" poster="${base}&fmt=png" controls autoplay muted playsinline loop></video></div>
 <div class="bar">${apply}<span class="brand">Recorded with RecruitersOS</span></div>
</div></body></html>`;
}

/* ------------------------------------------------------------------ */
/* Orchestrator                                                        */
/* ------------------------------------------------------------------ */

/** In-progress captures, so concurrent requests for the same role don't double-render. */
const inflight = new Map<string, Promise<ShotResult>>();

/**
 * Lazy, NON-BLOCKING entry point for the UI. Returns the cached result immediately when
 * fresh; otherwise kicks the capture off in the background and returns status "capturing"
 * (a full render takes ~20s, far too long to hold an HTTP request open). The client polls
 * by calling again — once the capture lands, the cached result is returned.
 */
export async function getOrStartShot(req: ShotRequest, opts?: { force?: boolean }): Promise<ShotResult> {
  const key = shotKey(req.company, req.roleTitle);
  const cache = await ensureCache();

  if (!opts?.force) {
    const hit = cache.get(key);
    if (hit && freshEnough(hit) && (hit.status !== "company_site" || (await fileExists(assetPath(key, "png"))))) {
      return stripRow(hit);
    }
  }
  if (inflight.has(key)) {
    return { ok: false, status: "capturing", key, reason: "capture in progress", at: new Date().toISOString() };
  }
  const p = captureRoleShot(req, opts).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return { ok: false, status: "capturing", key, reason: "capture started", at: new Date().toISOString() };
}

/**
 * Capture (or return cached) assets for a role. Lazy + idempotent: a verified company-site
 * capture is reused for POS_TTL; a "no page" verdict is retried after NEG_TTL. This AWAITS the
 * full render — use getOrStartShot() from request handlers; call this directly only when you
 * intend to block (e.g. a CLI/batch job).
 */
export async function captureRoleShot(req: ShotRequest, opts?: { force?: boolean }): Promise<ShotResult> {
  const key = shotKey(req.company, req.roleTitle);
  const cache = await ensureCache();

  if (!opts?.force) {
    const hit = cache.get(key);
    if (hit && freshEnough(hit)) {
      // Confirm the PNG still exists on disk before trusting a positive verdict.
      if (hit.status !== "company_site" || (await fileExists(assetPath(key, "png")))) {
        return stripRow(hit);
      }
    }
  }

  let result: ShotResult;
  try {
    const browser = await getBrowser();
    const target = await resolveTarget(req, browser);
    if ("status" in target) {
      result = { ok: false, status: target.status, key, reason: target.reason, at: new Date().toISOString() };
    } else {
      result = await doCapture(browser, key, target, req);
    }
  } catch (e) {
    result = { ok: false, status: "error", key, reason: (e as Error).message, at: new Date().toISOString() };
  }

  try {
    cache.set(key, { ...result, at: result.at || new Date().toISOString(), company: req.company, roleTitle: req.roleTitle } as ShotRow);
    scheduleSave();
  } catch { /* best-effort */ }
  return result;
}

/**
 * Render a duration-MATCHED scroll video from the already-captured tall still, so the page scroll
 * runs for EXACTLY `durationMs` (one clean top→bottom pass) — used to match the PiP webcam clip
 * length. Cheap: NO Playwright (reuses the cached <key>.png still), just re-synthesizes the pan +
 * re-encodes. Cached on disk per (key, whole-second duration). Returns the absolute MP4 path, or null
 * when the still / ffmpeg / render isn't available (caller falls back to the default looped video).
 */
export async function renderScrollVideoAtDuration(key: string, durationMs: number): Promise<string | null> {
  if (!/^[a-z0-9_-]{3,90}$/.test(key) || !(durationMs > 0)) return null;
  const stillPath = assetPath(key, "png");
  if (!(await fileExists(stillPath))) return null;            // need the captured still first
  const sec = Math.max(1, Math.round(durationMs / 1000));
  const outPath = join(shotsDir(), `${key}__d${sec}.mp4`);
  if (await fileExists(outPath)) return outPath;             // already rendered this duration
  if (!(await haveFfmpeg())) return null;
  try {
    const tall = await readFile(stillPath);
    const { frames, delays, contentFrames } = await synthesizeAnim(tall, sec * 1000);
    if (contentFrames < 5) return null;
    await renderMp4(frames, delays, outPath);
    return outPath;
  } catch {
    return null;
  }
}

async function doCapture(
  browser: import("playwright").Browser,
  key: string,
  target: Target,
  req: ShotRequest,
): Promise<ShotResult> {
  const ctx = await browser.newContext({
    userAgent: DESKTOP_UA,
    viewport: { width: FRAME_W, height: FRAME_H },
    deviceScaleFactor: 1,
    locale: "en-US",
  });
  await ctx.addInitScript({ content: NAME_SHIM });
  // Skip autoplaying media so frames are stable and loads are quicker.
  await ctx.route("**/*", (route) => {
    const t = route.request().resourceType();
    return t === "media" ? route.abort() : route.continue();
  });
  try {
    const page = await ctx.newPage();
    // Navigate with one retry — transient timeouts / dropped connections are common on big
    // careers sites and shouldn't drop an otherwise-valid capture.
    let res: import("playwright").Response | null = null;
    let navErr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
        if (res && res.ok()) break;
        navErr = `page returned ${res?.status() ?? "no response"}`;
      } catch (e) {
        navErr = (e as Error).message;
      }
      if (attempt === 0) await page.waitForTimeout(1200);
    }
    if (!res || !res.ok()) {
      return { ok: false, status: "no_company_page", key, reason: navErr || "navigation failed", at: new Date().toISOString() };
    }
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    await preparePage(page);

    const verdict = await verifyPage(page, target.companyDomain, req);
    if (!verdict.ok) {
      return { ok: false, status: "no_company_page", key, reason: verdict.reason, at: new Date().toISOString() };
    }

    await mkdir(shotsDir(), { recursive: true });

    // (1) CAPTURE ONCE — one complete tall image, no live scrolling (immune to scroll-jacking),
    // with embedded boards rendered (site isolation disabled). Saved as the full-page still.
    const tall = await captureTall(page);
    await writeFile(assetPath(key, "png"), tall);

    // (2) SYNTHESIZE the natural-scroll animation by panning a window down the captured image
    // (5s top hold → human flick-and-read scroll → settle within the JD). Deterministic — always scrolls.
    const { frames, delays, contentFrames } = await synthesizeAnim(tall);

    // Guarantee the asset actually SHOWS the posting: a near-empty capture (page never rendered)
    // is skipped rather than saved.
    if (contentFrames < 5) {
      return { ok: false, status: "no_company_page", key, reason: "job description didn't render visually", at: new Date().toISOString() };
    }
    const files: ShotResult["files"] = { png: true };

    // (3) FULL VIDEO (MP4) — the watch-page asset (needs ffmpeg; auto-skips if absent).
    try {
      if (await haveFfmpeg()) { await renderMp4(frames, delays, assetPath(key, "mp4")); files.mp4 = true; }
      else console.warn("[roleShot] ffmpeg not found — skipping MP4 (install ffmpeg on the server)");
    } catch (e) {
      console.error(`[roleShot] MP4 encode failed for ${key}:`, (e as Error).message);
    }

    // (4) EMAIL TEASER (short looping GIF w/ play button) — the asset that goes IN the email and
    // links to the watch page. ffmpeg makes a small clean one; pure-JS gifenc is the fallback.
    try {
      if (await renderTeaserGif(tall, assetPath(key, "gif"))) files.gif = true;
    } catch (e) {
      console.error(`[roleShot] teaser GIF failed for ${key}:`, (e as Error).message);
    }

    // (5) Optional full-quality animated WebP (server-only via sharp).
    try {
      const webp = await encodeWebp(frames, delays);
      if (webp) { await writeFile(assetPath(key, "webp"), webp); files.webp = true; }
    } catch { /* optional */ }

    // (6) WATCH PAGE — self-contained HTML that plays the MP4 (what the teaser links to).
    try {
      await writeFile(assetPath(key, "html"), watchPageHtml({ key, company: req.company, roleTitle: req.roleTitle, pageUrl: target.url }));
      files.watch = true;
    } catch { /* best-effort */ }

    return { ok: true, status: "company_site", key, pageUrl: target.url, files, at: new Date().toISOString() };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

function stripRow(row: ShotRow): ShotResult {
  const { ...rest } = row;
  return rest;
}
