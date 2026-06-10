/**
 * RecruiterOS · Auth · TOTP (RFC 6238) + recovery codes
 *
 * Dependency-free time-based one-time passwords on node:crypto only. Used to put
 * a second factor in front of sign-in: the user scans/enters a base32 secret
 * into an authenticator app (Google Authenticator, Authy, 1Password, …) and we
 * verify the rolling 6-digit code at login. Backup recovery codes are stored as
 * sha256 hashes and consumed once, so a lost phone never locks anyone out.
 */

import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";

const STEP = 30; // seconds per code
const DIGITS = 6;
const ISSUER = "RecruiterOS";

/* ---------------- base32 (RFC 4648, no padding) ---------------- */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str: string): Buffer {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/* ---------------- TOTP ---------------- */

/** A fresh random base32 secret (20 bytes / 160 bits — the RFC-recommended size). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The otpauth:// URI an authenticator app consumes (also encodable as a QR). */
export function otpauthUri(secret: string, account: string, issuer = ISSUER): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** The HOTP code for a specific counter. */
function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter (top 32 bits are 0 for any realistic time).
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (bin % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

/**
 * Verify a user-supplied code against the secret, tolerating ±`window` steps of
 * clock drift (default ±1 = a 90s window). Constant-time per-candidate compare.
 */
export function verifyTotp(secret: string, token: string, window = 1, nowSec = Date.now() / 1000): boolean {
  const code = (token || "").replace(/\D/g, "");
  if (code.length !== DIGITS) return false;
  const counter = Math.floor(nowSec / STEP);
  for (let i = -window; i <= window; i++) {
    if (safeEqualStr(hotp(secret, counter + i), code)) return true;
  }
  return false;
}

/* ---------------- recovery codes ---------------- */

/** N human-readable one-time codes (e.g. "k7m2q-9xa4r"). Shown to the user once. */
export function generateRecoveryCodes(n = 10): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const raw = base32Encode(randomBytes(7)).toLowerCase().slice(0, 10);
    out.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return out;
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.trim().toLowerCase().replace(/[^a-z0-9]/g, "")).digest("hex");
}

/** True (constant-time) if two strings are byte-equal. */
function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
