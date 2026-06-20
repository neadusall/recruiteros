/* Prototype: validate the capture+encode pipeline (Playwright + pngjs + gifenc) on a
   real company-careers page. Mirrors lib/inmarket/roleShot.ts capture path.
   Run: node scripts/shot-test.mjs "<url>" */
import { chromium } from "playwright";
import { PNG } from "pngjs";
import gifencPkg from "gifenc";
const { GIFEncoder, quantize, applyPalette } = gifencPkg;
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", ".data", "shots");
const URL_ = process.argv[2] || "https://careers.airbnb.com/positions/7995153?gh_jid=7995153";
const W = 1000, H = 620, FPS = 12, SECS = 7, HOLD = 1100, MAX = 140;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const HIDE = `[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],#onetrust-banner-sdk,[class*="intercom" i],[class*="drift" i],[id*="hubspot-messages" i]{display:none!important;visibility:hidden!important;}`;
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

const t0 = Date.now();
const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: W, height: H }, deviceScaleFactor: 1, locale: "en-US" });
await ctx.route("**/*", (r) => (r.request().resourceType() === "media" ? r.abort() : r.continue()));
const page = await ctx.newPage();

const res = await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 25000 });
console.log("status:", res?.status(), "final url:", page.url());
await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
await page.addStyleTag({ content: HIDE }).catch(() => {});
await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const h = document.documentElement.scrollHeight;
  for (let y = 0; y < h; y += Math.max(200, Math.round(window.innerHeight * 0.9))) { window.scrollTo(0, y); await sleep(40); }
  window.scrollTo(0, 0); await sleep(120);
});
await page.waitForTimeout(250);

const txt = (await page.evaluate(() => document.body?.innerText || "")).toLowerCase();
console.log("body text length:", txt.length, "| has 'airbnb':", txt.includes("airbnb"), "| has 'manager':", txt.includes("manager"));

await mkdir(OUT, { recursive: true });
const png = await page.screenshot({ type: "png", fullPage: true });
await writeFile(join(OUT, "test.png"), png);

const scrollH = await page.evaluate(() => document.documentElement.scrollHeight);
const distance = Math.max(0, scrollH - H);
const n = Math.max(2, Math.min(MAX, Math.round(FPS * SECS)));
const per = Math.round(1000 / FPS);
const frames = [], delays = [];
for (let i = 0; i < n; i++) {
  const t = i / (n - 1);
  await page.evaluate((y) => window.scrollTo(0, y), Math.round(ease(t) * distance));
  await page.waitForTimeout(16);
  frames.push(await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: W, height: H } }));
  delays.push(i === 0 || i === n - 1 ? HOLD : per);
}

const decoded = frames.map((b) => PNG.sync.read(b));
const w = decoded[0].width, h = decoded[0].height;
const pick = decoded.filter((_, i) => i % Math.ceil(decoded.length / 12) === 0).slice(0, 12);
const chunks = [];
for (const d of pick) for (let i = 0; i + 4 <= d.data.length; i += 64) chunks.push(d.data[i], d.data[i + 1], d.data[i + 2], 255);
const palette = quantize(Uint8Array.from(chunks), 256, { format: "rgb565" });
const gif = GIFEncoder();
decoded.forEach((d, i) => {
  const idx = applyPalette(d.data, palette, "rgb565");
  gif.writeFrame(idx, w, h, { palette: i === 0 ? palette : undefined, delay: delays[i], repeat: 0 });
});
gif.finish();
const gbytes = Buffer.from(gif.bytes());
await writeFile(join(OUT, "test.gif"), gbytes);

console.log(`scrollHeight: ${scrollH}px | frames: ${n} | png: ${(png.length / 1024).toFixed(0)}KB | gif: ${(gbytes.length / 1024 / 1024).toFixed(2)}MB | total ${(Date.now() - t0) / 1000}s`);
await browser.close();
