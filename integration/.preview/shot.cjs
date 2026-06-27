const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1.5 });
  const f = "file://" + process.cwd().replace(/\/g,"/") + "/.preview/landing-demo.html";
  await page.goto(f, { waitUntil: "load", timeout: 30000 }).catch(e=>console.log("nav:",e.message));
  await page.waitForTimeout(5000); // let the TidyCal iframe render
  await page.screenshot({ path: ".preview/landing-demo.png" });
  await browser.close();
  console.log("shot done");
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
