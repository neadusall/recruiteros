/**
 * RecruitersOS · Sending secrets at rest
 * Encrypts seed-inbox app passwords (and any other sending secret) before they hit
 * the KV snapshot, so a leaked snapshot doesn't hand over a pile of real mailbox
 * logins. AES-256-GCM, keyed by SENDING_SECRET_KEY.
 *
 * Backward + forward compatible by design:
 *   - No key set        -> values stored as plaintext (today's behavior; no break).
 *   - Key set           -> new writes are encrypted ("encv1:" prefix); old plaintext
 *                          values still decrypt (passthrough) until they're re-saved.
 *   - Encrypted, no key  -> decrypt returns undefined (can't read) rather than crash.
 */

import crypto from "crypto";

const PREFIX = "encv1:";

function key(): Buffer | null {
  const raw = (process.env.SENDING_SECRET_KEY || "").trim();
  if (!raw) return null;
  // Accept any-length passphrase; derive a stable 32-byte key.
  return crypto.createHash("sha256").update(raw).digest();
}

/** True if a stored value is one of our encrypted blobs. */
export function isEncrypted(v?: string): boolean {
  return typeof v === "string" && v.startsWith(PREFIX);
}

/** Encryption is actually active (a key is configured). */
export function encryptionEnabled(): boolean {
  return key() !== null;
}

/** Encrypt a secret for storage. Returns the value unchanged if no key is set or it's already encrypted/empty. */
export function encryptSecret(plain?: string): string | undefined {
  if (plain == null || plain === "") return plain;
  if (isEncrypted(plain)) return plain;
  const k = key();
  if (!k) return plain; // no key configured -> store as-is (unchanged behavior)
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + iv.toString("base64") + ":" + tag.toString("base64") + ":" + ct.toString("base64");
}

/** Decrypt a stored secret for use. Plaintext (legacy) values pass through unchanged. */
export function decryptSecret(stored?: string): string | undefined {
  if (stored == null || !isEncrypted(stored)) return stored;
  const k = key();
  if (!k) return undefined; // encrypted but no key -> unreadable (don't crash)
  try {
    const [ivB, tagB, ctB] = stored.slice(PREFIX.length).split(":");
    const iv = Buffer.from(ivB, "base64");
    const tag = Buffer.from(tagB, "base64");
    const ct = Buffer.from(ctB, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", k, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}
