// One-off: prove the Gmail cold lane can actually submit mail from this host.
// Sends ONE self-addressed test message from one active Zapmail box (no recipient
// outside our own fleet is touched). Run in the app container:
//   docker run --rm -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro \
//     --entrypoint node recruiteros-app /tools/gmail-lane-test.mjs
import { readFileSync } from "node:fs";
import { createDecipheriv, scryptSync } from "node:crypto";
import { createRequire } from "node:module";

const nodemailer = createRequire("/app/integration/package.json")("nodemailer");
const key = scryptSync(process.env.SENDERS_ENCRYPTION_KEY || process.env.APP_ENCRYPTION_KEY || "ros-senders-dev-key-do-not-use-in-prod", "ros-senders-salt-v1", 32);
function decryptSecret(stored) {
  if (!stored) return "";
  if (!stored.startsWith("v1:")) return stored;
  const raw = Buffer.from(stored.slice(3), "base64");
  const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

const s = JSON.parse(readFileSync("/data/snap_senders_v1.json", "utf8"));
const rows = s.inboxes || s.state?.inboxes || [];
const box = rows.find((m) => m.status === "active" && m.smtpPassEnc && /^smtp\.gmail\.com$/i.test(m.smtpHost || ""));
if (!box) { console.log("no active gmail box found"); process.exit(1); }
const pass = decryptSecret(box.smtpPassEnc);
if (!pass) { console.log("password would not decrypt"); process.exit(1); }
console.log(`testing ${box.email} via ${box.smtpHost}:${box.smtpPort || 587}`);
const t = nodemailer.createTransport({ host: box.smtpHost, port: box.smtpPort || 587, secure: !!box.smtpSecure, auth: { user: box.smtpUser || box.email, pass }, connectionTimeout: 20_000, socketTimeout: 30_000 });
try {
  const info = await t.sendMail({ from: box.email, to: box.email, subject: "lane check", text: "Gmail cold lane submission check (self-addressed)." });
  console.log("SEND OK:", info.response || info.messageId);
} catch (e) {
  console.log("SEND FAILED:", String(e && e.message || e).slice(0, 300));
  process.exitCode = 1;
} finally { t.close(); }
