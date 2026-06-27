const { chromium } = require("playwright");
const path = require("path");
const { pathToFileURL } = require("url");
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1.25 });
  const f = pathToFileURL(path.resolve("public/video-preview-light.html")).href;
  await page.goto(f, { waitUntil: "load", timeout: 30000 }).catch((e) => console.log("nav:", e.message));
  await page.waitForTimeout(4000);
  await page.click("#replyBtn").catch((e) => console.log("click:", e.message));
  await page.fill("#rMsg", "Yes, the VP of Engineering role is still open — happy to chat. How's Thursday?").catch(() => {});
  await page.waitForTimeout(800);
  await page.screenshot({ path: ".preview/modal-light.png" });
  await browser.close();
  console.log("shot done");
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
