/* Screenshot Spend master against a COPY of the live data, with no owner session and no DB.
   ROS_DATA_DIR must point at that copy. Writes PNGs into SHOT_DIR. */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";

const DATA = process.env.ROS_DATA_DIR;
const SHOT_DIR = process.env.SHOT_DIR || ".";
if (!DATA) { console.error("set ROS_DATA_DIR"); process.exit(1); }

const ROOT = join(process.cwd(), "..");

const { listSpendItems, attachLive, rollupBurn } = await import("../lib/owner/spendRegister");
const { listReceipts, billingMailboxes, pullerStates, lastPullerReportAt, lastSweepAt, lastSweeps, harvestState, vaultHealth } = await import("../lib/owner/receipts");
const { buildSpendMatrix, sourcingStatus, withinRegister, REGISTER_START_MONTH } = await import("../lib/owner/spendMatrix");
const { VENDOR_SOURCES } = await import("../lib/owner/receiptSources");
const { spendRollup } = await import("../lib/billing/ledger");

const base = await listSpendItems();
const items = await attachLive(base, "30d");
const ledger = spendRollup("30d");
const BURN = {
  ...rollupBurn(items, "30d"), items,
  effectiveness: { rows: [] },
  metered: { totalCostUsd: ledger.totalCostUsd, events: ledger.events, byCategory: ledger.byCategory, bySource: ledger.bySource, byMotion: ledger.byMotion },
};

const all = await listReceipts();
const receipts = all.filter(withinRegister);
const boxes = billingMailboxes();
const pullers = pullerStates();
const RECEIPTS = {
  matrix: buildSpendMatrix(base, receipts, { months: 12, inboxConfigured: boxes.length > 0 }),
  vault: await vaultHealth().catch(() => ({ unlinked: 0, duplicates: 0, linkable: 0 })),
  close: JSON.parse(process.env.SHOT_CLOSE || '{"history":[],"judging":null,"notice":{"configured":true,"to":["neadusall@gmail.com"]}}'),
  registerStart: REGISTER_START_MONTH,
  sourcing: sourcingStatus(base, receipts, pullers),
  pullers: { lastReportAt: lastPullerReportAt(), count: pullers.length, states: pullers },
  receipts: receipts.slice(0, 500).map((r) => ({ ...r, excerptPreview: "" })),
  inbox: {
    configured: boxes.length > 0,
    mailboxes: boxes.map((b) => ({ user: b.user, host: b.host, port: b.port, inherited: !!b.inherited })),
    lastSweepAt: lastSweepAt(), harvest: harvestState(), sweeps: lastSweeps(),
    envKeys: ["BILLING_INBOX_USER"],
  },
  knownVendors: VENDOR_SOURCES.map((v) => ({ vendor: v.vendor, channel: v.channel, portal: v.portal, from: v.from })),
};

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };

/* `ok()` puts the payload at TOP LEVEL. Wrapping it in {ok,data} makes viewBurn render
   "Could not load this view" with no error in the page, which costs an hour to spot. */
const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://x");
  const p = url.pathname;
  const send = (o: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };

  if (p === "/api/owner/overview") return send({ owner: "neadusall@gmail.com", workspaces: [] });
  if (p === "/api/owner/burn") return send(BURN);
  if (p === "/api/owner/receipts") return send(RECEIPTS);
  if (p.startsWith("/api/owner/receipts/file/") || p.startsWith("/receipts/file/")) {
    const id = p.split("/").pop() || "";
    const png = join(DATA, "receipts", `${id.replace(/\.(png|thumb)$/, "")}.png`);
    if (existsSync(png)) { res.writeHead(200, { "content-type": "image/png" }); return res.end(await readFile(png)); }
    res.writeHead(404); return res.end();
  }
  if (p.startsWith("/api/")) return send({});

  const file = join(ROOT, p === "/" ? "index.html" : p.replace(/^\//, ""));
  if (existsSync(file) && !file.endsWith("/")) {
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    return res.end(await readFile(file));
  }
  res.writeHead(404); res.end("not found");
});
await new Promise<void>((r) => server.listen(4713, r));

const { chromium } = await import("playwright");
const browser = await chromium.launch({ channel: "msedge" });
for (const width of [1280, 1024, 500]) {
  const page = await browser.newPage({ viewport: { width, height: 1400 } });
  await page.goto("http://127.0.0.1:4713/owner-console.html#burn", { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  const row = page.locator(process.env.SHOT_AT || "text=Skip Tracing Working API").first();
  if (await row.count()) await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOT_DIR, `${process.env.SHOT_NAME || "burn"}-${width}.png`), fullPage: width === 1280 });
  console.log(`shot ${width}`);
  await page.close();
}
await browser.close();
server.close();
process.exit(0);
