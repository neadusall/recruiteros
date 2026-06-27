const { chromium } = require("playwright");
const path = require("path");
const { pathToFileURL } = require("url");
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1.5 });
  const f = pathToFileURL(path.resolve(".preview/landing-light.html")).href;
  await page.goto(f, { waitUntil: "load", timeout: 30000 }).catch((e) => console.log("nav:", e.message));
  await page.waitForTimeout(5000);
  await page.screenshot({ path: ".preview/landing-light.png" });
  await browser.close();
  console.log("shot done");
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
