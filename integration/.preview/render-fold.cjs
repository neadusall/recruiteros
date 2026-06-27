const { chromium } = require("playwright");
const path = require("path");
const { pathToFileURL } = require("url");
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1.25 });
  const f = pathToFileURL(path.resolve("public/video-preview-light.html")).href;
  await page.goto(f, { waitUntil: "load", timeout: 30000 }).catch((e) => console.log("nav:", e.message));
  await page.waitForTimeout(5000);
  await page.screenshot({ path: ".preview/fold-light.png" });   // viewport only — shows exactly the fold
  await browser.close();
  console.log("shot done");
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
