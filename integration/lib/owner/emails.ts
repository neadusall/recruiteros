/**
 * RecruitersOS · Owner identity (leaf module)
 *
 * Just the OWNER_EMAIL allow-list, split out of lib/owner so low-level modules
 * (auth, connected credentials) can ask "is this the operator?" without
 * importing the whole owner back office (which itself imports auth — a cycle
 * otherwise).
 */

/**
 * The owner allow-list. Set OWNER_EMAIL (comma-separated for >1) in the
 * environment. With nothing set we fall back to the build owner so the console
 * is reachable on first boot, then you lock it down via env.
 */
const FALLBACK_OWNER = "neadusall@gmail.com";

export function ownerEmails(): string[] {
  const raw = process.env.OWNER_EMAIL || FALLBACK_OWNER;
  return raw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}

export function isOwnerEmail(email?: string | null): boolean {
  if (!email) return false;
  return ownerEmails().includes(email.trim().toLowerCase());
}
