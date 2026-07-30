#!/usr/bin/env node
/**
 * RecruitersOS - build gate: every external package the built server requires
 * MUST resolve in the node_modules we are about to ship.
 *
 * WHY THIS EXISTS. On 2026-07-30 JD Sourcing was dead for hours in production.
 * `lib/net/egress.ts` imports "undici", but undici was never declared in
 * package.json - it only existed in the tree as a dev-only transitive dep of
 * jsdom. The build SUCCEEDED (undici was present at build time), then
 * `npm prune --omit=dev` deleted it, and 157 route bundles started throwing
 * MODULE_NOT_FOUND on their first request. Nothing caught it: the image built
 * clean, the container started clean, and the first signal was a recruiter
 * saying a search "disappeared". The same class of bug then took out resume
 * parsing (pdfjs resolving a worker path webpack had rewritten into .next).
 *
 * So this runs AFTER `npm prune --omit=dev` - pruning is the step that breaks
 * things, so checking before it would prove nothing - and fails the build.
 * A broken image never ships.
 *
 * Usage: node scripts/check-bundle-deps.mjs [--next-dir .next] [--modules node_modules]
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { builtinModules } from "node:module";

const args = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const ROOT = process.cwd();
const NEXT_SERVER = resolve(ROOT, argOf("--next-dir", ".next"), "server");
const MODULES = resolve(ROOT, argOf("--modules", "node_modules"));

/**
 * Packages that are genuinely optional at runtime: the bundler emits a require()
 * for them behind a feature check that never fires in our deployment. Each entry
 * needs a reason - an unexplained allowlist is how the next outage hides.
 */
const ALLOWED_MISSING = new Map([
  // node-fetch's optional charset decoder. Only loaded for exotic (non-UTF8)
  // response encodings, which none of our providers return.
  ["encoding", "optional charset decoder behind a runtime branch we never hit"],
  // Next's optional Partytown script strategy. We never set strategy="worker".
  ["@builder.io/partytown", "optional next/script worker strategy, unused"],
]);

/** A real npm package specifier, so we ignore webpack's dynamic-require artifacts. */
function isRealPackageName(spec) {
  if (!spec || spec.length > 214) return false;
  // Minified dynamic requires leave fragments like '+t+' or template soup.
  if (/[^a-zA-Z0-9@/._-]/.test(spec)) return false;
  if (spec.startsWith(".") || spec.startsWith("/")) return false;
  if (spec.startsWith("@")) return /^@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-~][a-z0-9-._~]*/i.test(spec);
  return /^[a-z0-9-~][a-z0-9-._~]*/i.test(spec);
}

/** "@scope/name/sub/path" -> "@scope/name"; "pkg/sub" -> "pkg". */
function packageOf(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function walkJs(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkJs(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

const builtins = new Set(builtinModules);
const REQUIRE_RE = /require\(\s*["']([^"']+)["']\s*\)/g;

if (!existsSync(NEXT_SERVER)) {
  console.error(`[bundle-deps] FATAL: ${NEXT_SERVER} does not exist. Run the build first.`);
  process.exit(2);
}

const files = walkJs(NEXT_SERVER);
if (files.length === 0) {
  console.error(`[bundle-deps] FATAL: no .js files under ${NEXT_SERVER}. Refusing to pass a vacuous check.`);
  process.exit(2);
}

/** package -> Set(bundle files that require it) */
const required = new Map();
for (const file of files) {
  let src;
  try { src = readFileSync(file, "utf8"); } catch { continue; }
  for (const m of src.matchAll(REQUIRE_RE)) {
    const spec = m[1];
    if (spec.startsWith("node:")) continue;
    if (!isRealPackageName(spec)) continue;
    const pkg = packageOf(spec);
    if (builtins.has(pkg)) continue;
    if (!required.has(pkg)) required.set(pkg, new Set());
    required.get(pkg).add(relative(NEXT_SERVER, file));
  }
}

/** Resolvable if the package directory exists AND has a package.json. */
function resolves(pkg) {
  const dir = join(MODULES, ...pkg.split("/"));
  try { return statSync(dir).isDirectory() && existsSync(join(dir, "package.json")); }
  catch { return false; }
}

const missing = [];
const allowed = [];
for (const [pkg, users] of [...required].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (resolves(pkg)) continue;
  (ALLOWED_MISSING.has(pkg) ? allowed : missing).push([pkg, [...users]]);
}

console.log(`[bundle-deps] scanned ${files.length} server bundles, ${required.size} external packages required`);
for (const [pkg, users] of allowed) {
  console.log(`[bundle-deps] allowed-missing: ${pkg} (${ALLOWED_MISSING.get(pkg)}) - ${users.length} bundle(s)`);
}

if (missing.length === 0) {
  console.log("[bundle-deps] OK - every required package resolves in the shipped node_modules");
  process.exit(0);
}

console.error("");
console.error("[bundle-deps] BUILD FAILED - packages required by the built server are MISSING from node_modules:");
for (const [pkg, users] of missing) {
  console.error(`  ${pkg}  (${users.length} bundle(s))`);
  for (const u of users.slice(0, 5)) console.error(`      ${u}`);
  if (users.length > 5) console.error(`      ... and ${users.length - 5} more`);
}
console.error("");
console.error("  This is almost always a runtime import that is not declared in");
console.error("  integration/package.json \"dependencies\". It survives the build via some");
console.error("  devDependency's transitive tree, then `npm prune --omit=dev` deletes it and");
console.error("  every route that imports it throws MODULE_NOT_FOUND at runtime.");
console.error("");
console.error("  Fix: npm install <pkg> --save   (then commit package.json + package-lock.json)");
console.error("  If it is genuinely optional at runtime, add it to ALLOWED_MISSING with a reason.");
console.error("");
process.exit(1);
