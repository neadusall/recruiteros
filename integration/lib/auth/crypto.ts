/**
 * RecruitersOS · Auth
 * Password hashing + token generation built on node:crypto only (no deps).
 * PBKDF2-SHA512, 210k iterations (OWASP 2024 floor), random per-user salt.
 */

import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

const ITER = 210_000;
const KEYLEN = 64;
const DIGEST = "sha512";

/** "iterations:salt:hash", all hex. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, ITER, KEYLEN, DIGEST);
  return `${ITER}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [iterStr, saltHex, hashHex] = stored.split(":");
  if (!iterStr || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = pbkdf2Sync(password, Buffer.from(saltHex, "hex"), Number(iterStr), expected.length, DIGEST);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** URL-safe random token for sessions / magic links. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
