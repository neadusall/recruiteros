/*
 * Two things, both of which were broken in production while every test passed.
 *
 * 1. THE BUNDLING TRAP. `const { createRequire } = await import("node:module")` works
 *    perfectly under tsx and yields `undefined` in the compiled server bundle, because
 *    webpack builds an external's namespace by copying the export's own property names and
 *    that loop only runs for an OBJECT export. `node:module` exports the Module *function*,
 *    so the namespace ends up with one key: `default`. Calling the undefined binding threw
 *    "x is not a function", `renderShot` filed that as a render failure, and every PDF
 *    invoice in the vault showed "no image" with the document sitting readable on disk.
 *    This replays webpack's own namespace helper so a dev-only pass can never hide it again.
 *
 * 2. THE REPAIR. A picture that failed to render must be recoverable from the document,
 *    because the document is the thing that matters and it is already on disk.
 *
 * Run: cd integration && npx tsx scripts/test-receipt-shot-repair.mts
 */
import { chromium } from "playwright";
import { mkdtemp, unlink, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ROS_DATA_DIR = await mkdtemp(join(tmpdir(), "rcpt-repair-"));
const { addManualReceipt, renderMissingShots, listReceipts } = await import("../lib/owner/receipts");

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) { console.log("  ok   " + name); return; }
  failures += 1;
  console.log("  FAIL " + name + (detail === undefined ? "" : " — " + JSON.stringify(detail)));
}

/* ---------- 1. the namespace webpack actually hands the bundle ---------- */

console.log("webpack namespace for a function-exporting builtin");

/** Verbatim shape of webpack 5's `__webpack_require__.t(value, 23)`. */
function webpackNamespace(value: unknown): Record<string, unknown> {
  const getProto = Object.getPrototypeOf.bind(Object);
  const leaf = [null, getProto({}), getProto([]), getProto(getProto)];
  const ns: Record<string, unknown> = Object.create(null);
  const def: Record<string, () => unknown> = {};
  for (let cur: any = value; typeof cur === "object" && cur && !~leaf.indexOf(cur); cur = getProto(cur)) {
    Object.getOwnPropertyNames(cur).forEach((k) => { def[k] = () => (value as any)[k]; });
  }
  def.default = () => value;
  for (const k of Object.keys(def)) Object.defineProperty(ns, k, { enumerable: true, get: def[k] });
  return ns;
}

const modNs = webpackNamespace(await import("node:module").then((m) => (m as any).default ?? m));
check("the bare `createRequire` key is dropped, exactly as in production",
  typeof modNs.createRequire !== "function", Object.keys(modNs));
check("`default.createRequire` survives, which is what the fix reads",
  typeof (modNs.default as any)?.createRequire === "function");

/* The fix, spelled out: nobody may reintroduce the destructure. Comments are stripped
   first, because the explanation of the bug quotes the broken line verbatim. */
const src = await import("node:fs/promises").then((fs) =>
  fs.readFile(new URL("../lib/owner/receipts.ts", import.meta.url), "utf8"));
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
check("receipts.ts never destructures node:module off a dynamic import",
  !/\{\s*createRequire\s*\}\s*=\s*await import\(\s*["']node:module["']/.test(code));

/* ---------- 2. a real PDF invoice, its picture destroyed, then repaired ---------- */

console.log("render, destroy the picture, repair from the document");

const INVOICE = `<div style="font:14px system-ui;padding:40px">
<h1>RapidAPI</h1><h2>Receipt 4821-77</h2><p>24 July 2026</p>
<table style="width:100%"><tr><td>JSearch — Pro</td><td style="text-align:right">$75.00</td></tr></table></div>`;

const b = await chromium.launch({ args: ["--no-sandbox"] });
const p = await b.newPage();
await p.setContent(INVOICE);
const pdf = Buffer.from(await p.pdf({ format: "A4" }));
await b.close();

const r = await addManualReceipt({
  vendor: "RapidAPI", period: "2026-07", amountUsd: 75, chargedAt: "2026-07-24",
  invoiceNumber: "4821-77",
  file: { bytes: pdf, mime: "application/pdf", name: "rapidapi-2026-07-24-jsearch.pdf" },
});
check("the PDF rendered on the way in", r.hasShot === true, r.shotError);

const dir = join(process.env.ROS_DATA_DIR!, "receipts");
check("the vendor's own document is on disk", await size(join(dir, `${r.id}.src.pdf`)) > 0);

/* Reproduce the production state: document filed, picture gone, flag lying about it. */
await unlink(join(dir, `${r.id}.png`));
await unlink(join(dir, `${r.id}.thumb.png`)).catch(() => {});

const repair = await renderMissingShots();
check("the repair rendered exactly the one that lost its picture",
  repair.rendered === 1 && repair.failed === 0, repair);
check("the PNG is back on disk", await size(join(dir, `${r.id}.png`)) > 0);
check("the thumbnail is back too", await size(join(dir, `${r.id}.thumb.png`)) > 0);
check("hasShot says so", (await listReceipts()).find((x) => x.id === r.id)?.hasShot === true);

/* Cheap when there is nothing to do: no re-render of a receipt that already has its PNG. */
const again = await renderMissingShots();
check("a second pass renders nothing", again.rendered === 0 && again.alreadyOk === 1, again);

/* A flag claiming a picture that is not there must be corrected, not trusted. */
console.log("the flag is settled against the disk, both ways");
await unlink(join(dir, `${r.id}.png`));
await unlink(join(dir, `${r.id}.src.pdf`));
const orphan = await renderMissingShots();
check("no document left, so the row stops claiming an image",
  orphan.noSource === 1 && (await listReceipts()).find((x) => x.id === r.id)?.hasShot === false, orphan);

console.log("artifacts:", (await readdir(dir)).join(", ") || "(none)");
console.log(failures ? `\n${failures} FAILED` : "\nall good");
process.exit(failures ? 1 : 0);

async function size(path: string): Promise<number> {
  try { return (await stat(path)).size; } catch { return 0; }
}
