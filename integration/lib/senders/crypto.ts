/**
 * RecruitersOS · Senders · secret encryption
 * SMTP/IMAP passwords are encrypted at rest with AES-256-GCM. The key is derived
 * (scrypt) from SENDERS_ENCRYPTION_KEY (falls back to APP_ENCRYPTION_KEY). Set a
 * stable secret in prod; rotating it makes existing stored passwords undecryptable.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const PREFIX = "v1:";
let cached: Buffer | null = null;

function key(): Buffer {
  if (cached) return cached;
  const secret =
    process.env.SENDERS_ENCRYPTION_KEY ||
    process.env.APP_ENCRYPTION_KEY ||
    "ros-senders-dev-key-do-not-use-in-prod";
  cached = scryptSync(secret, "ros-senders-salt-v1", 32);
  return cached;
}

/** Encrypt a secret. Empty in -> empty out. */
export function encryptSecret(plain: string): string {
  if (!plain) return "";
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

/** Decrypt. Tolerates legacy plaintext (no prefix) so nothing hard-breaks. */
export function decryptSecret(stored: string): string {
  if (!stored) return "";
  if (!stored.startsWith(PREFIX)) return stored;
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const d = createDecipheriv("aes-256-gcm", key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  } catch {
    return "";
  }
}

/** True when a non-default encryption secret is configured (for a UI nudge). */
export function encryptionConfigured(): boolean {
  return !!(process.env.SENDERS_ENCRYPTION_KEY || process.env.APP_ENCRYPTION_KEY);
}
