/**
 * RecruitersOS · Sending · per-recruiter email signature
 *
 * Cold emails sign off "{Thanks|Best}, {{Your_Name}}" and then jump straight to the
 * CAN-SPAM footer. This module adds the professional block in between — the thing a
 * real recruiter's mail always carries and template blasts usually don't:
 *
 *     Ryan Nead
 *     Director of Recruiting Operations
 *     Executive Recruiter | Lume Search Partners
 *     (929) 543-0608
 *
 * Deliverability-deliberate: plain text lines only. No links, no images, no vCards,
 * no social icons — the phone number is text, not a tel: anchor, so the signature
 * adds zero URLs to the message. The postal address is NOT here (the compliance
 * footer right below carries it); the two blocks never duplicate.
 *
 * Config: OUTREACH_SIGNATURES env JSON, keyed loosely so one entry matches however
 * the sender shows up (auth email, pool inbox address on a fleet domain, owner name):
 *
 *   {
 *     "ryan@lumesp.com": { "name": "Ryan Nead",
 *                          "lines": ["Director of Recruiting Operations",
 *                                    "Executive Recruiter | Lume Search Partners"],
 *                          "phone": "+19295430608" },
 *     "noah": { ... }
 *   }
 *
 * Lookup order for a send (first hit wins, all keys lowercased):
 *   1. the sending inbox's exact address        (ryan@talsearches.com)
 *   2. the inbox owner's id                     (usr_abc123)
 *   3. the inbox owner's display name           ("ryan nead", then its first word)
 *   4. the inbox address's local part, letters  ("ryan" from ryan2@talsearches.com)
 *   5. "default"
 * No match -> no signature (never invent an identity). Missing env -> no-op.
 */

export interface SignatureEntry {
  name: string;
  /** Title / company lines rendered under the name, in order. */
  lines?: string[];
  /** E.164 or already-formatted; E.164 US numbers render as (929) 543-0608. */
  phone?: string;
}

export interface SignatureBlock { html: string; text: string; }

const EMPTY: SignatureBlock = { html: "", text: "" };

function book(): Record<string, SignatureEntry> {
  try {
    const raw = process.env.OUTREACH_SIGNATURES;
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, SignatureEntry> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const e = v as SignatureEntry;
      if (e && typeof e.name === "string" && e.name.trim()) out[k.toLowerCase().trim()] = e;
    }
    return out;
  } catch {
    return {};
  }
}

/** (929) 543-0608 from +19295430608; anything non-E.164-US passes through untouched. */
export function formatPhone(phone: string): string {
  const m = (phone || "").trim().match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (phone || "").trim();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface SignatureSender {
  inboxEmail?: string;
  ownerId?: string;
  ownerName?: string;
}

/** Resolve the signature entry for a sender, or null when none is configured. */
export function signatureEntryFor(sender: SignatureSender): SignatureEntry | null {
  const b = book();
  if (!Object.keys(b).length) return null;
  const email = (sender.inboxEmail || "").toLowerCase().trim();
  const local = email.split("@")[0] || "";
  const localLetters = local.replace(/[^a-z]/g, "");
  const owner = (sender.ownerName || "").toLowerCase().trim();
  const keys = [
    email,
    (sender.ownerId || "").toLowerCase().trim(),
    owner,
    owner.split(/\s+/)[0] || "",
    localLetters,
    "default",
  ];
  for (const k of keys) if (k && b[k]) return b[k];
  return null;
}

/** Render the signature block for a sender. Appended after the body, BEFORE the
 *  compliance footer, on both parts. Empty (a clean no-op) when unconfigured. */
export function signatureFor(sender: SignatureSender): SignatureBlock {
  const e = signatureEntryFor(sender);
  if (!e) return EMPTY;
  const lines = [e.name, ...(e.lines || []), e.phone ? formatPhone(e.phone) : ""]
    .map((l) => (l || "").trim())
    .filter(Boolean);
  if (!lines.length) return EMPTY;
  const html =
    `<div style="margin-top:18px;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#444444">` +
    `<span style="font-weight:bold">${escapeHtml(lines[0])}</span>` +
    lines.slice(1).map((l) => `<br>${escapeHtml(l)}`).join("") +
    `</div>`;
  const text = `\n\n${lines.join("\n")}`;
  return { html, text };
}
