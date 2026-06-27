/**
 * RecruitersOS · Senders · CSV bulk import
 * Parse a pasted/uploaded inbox CSV (hundreds of rows) and map columns to inbox
 * fields. Tolerant of the common vendor / Smartlead / Sending.ac export headers.
 */
import type { SenderProvider } from "./types";
import type { NewInboxInput } from "./store";

/** Minimal RFC-4180-ish CSV parser (handles quotes, escaped quotes, commas, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  const s = (text || "").replace(/\r\n?/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const ALIASES = {
  email: ["email", "email id", "email_address", "from email", "from_email", "from", "username", "user", "login"],
  firstName: ["first name", "first_name", "firstname", "first"],
  lastName: ["last name", "last_name", "lastname", "last"],
  displayName: ["display name", "display_name", "from name", "from_name", "name", "sender name"],
  smtpHost: ["smtp host", "smtp_host", "smtp server", "smtp_server", "host", "server", "outgoing server"],
  smtpPort: ["smtp port", "smtp_port", "port"],
  smtpUser: ["smtp user", "smtp_user", "smtp username", "smtp_username"],
  smtpPass: ["smtp pass", "smtp_pass", "smtp password", "smtp_password", "password", "pass", "app password", "app_password"],
  imapHost: ["imap host", "imap_host", "imap server", "imap_server", "incoming server"],
  imapPort: ["imap port", "imap_port"],
  imapUser: ["imap user", "imap_user", "imap username", "imap_username"],
  imapPass: ["imap pass", "imap_pass", "imap password", "imap_password"],
  dailyCap: ["daily cap", "daily_cap", "daily limit", "daily_limit", "limit", "max per day"],
  recruiter: ["recruiter", "owner", "assigned to", "assigned_to", "recruiter name"],
} as const;

type Field = keyof typeof ALIASES;
export type ColumnMap = Partial<Record<Field, number>>;

/** Auto-detect a column map from a header row. */
export function detectColumns(header: string[]): ColumnMap {
  const norm = (header || []).map((h) => h.toLowerCase().trim());
  const map: ColumnMap = {};
  (Object.keys(ALIASES) as Field[]).forEach((field) => {
    for (const alias of ALIASES[field]) {
      const idx = norm.indexOf(alias);
      if (idx >= 0) { map[field] = idx; break; }
    }
  });
  return map;
}

export interface MapRowsResult {
  inboxes: NewInboxInput[];
  skipped: { row: number; reason: string }[];
}

/** Turn data rows + a column map into NewInboxInput[]. */
export function rowsToInboxes(
  rows: string[][],
  map: ColumnMap,
  defaults: { provider?: SenderProvider; dailyCap?: number; ownerId?: string; ownerName?: string } = {},
): MapRowsResult {
  const inboxes: NewInboxInput[] = [];
  const skipped: { row: number; reason: string }[] = [];
  const get = (r: string[], k: Field): string => {
    const i = map[k];
    return i === undefined ? "" : (r[i] ?? "").trim();
  };
  rows.forEach((r, n) => {
    const email = get(r, "email");
    const smtpHost = get(r, "smtpHost");
    const smtpPass = get(r, "smtpPass");
    if (!email || !email.includes("@")) { skipped.push({ row: n, reason: "no email" }); return; }
    if (!smtpHost) { skipped.push({ row: n, reason: "no smtp host" }); return; }
    if (!smtpPass) { skipped.push({ row: n, reason: "no smtp password" }); return; }
    const first = get(r, "firstName");
    const last = get(r, "lastName");
    const display = get(r, "displayName") || [first, last].filter(Boolean).join(" ") || undefined;
    const portStr = get(r, "smtpPort");
    const imapPortStr = get(r, "imapPort");
    const capStr = get(r, "dailyCap");
    inboxes.push({
      email,
      displayName: display,
      provider: defaults.provider || "own-smtp",
      smtpHost,
      smtpPort: portStr ? Number(portStr) : undefined,
      smtpUser: get(r, "smtpUser") || undefined,
      smtpPass,
      imapHost: get(r, "imapHost") || undefined,
      imapPort: imapPortStr ? Number(imapPortStr) : undefined,
      imapUser: get(r, "imapUser") || undefined,
      imapPass: get(r, "imapPass") || undefined,
      dailyCap: capStr ? Number(capStr) : defaults.dailyCap,
      ownerId: defaults.ownerId,
      ownerName: defaults.ownerName,
      warmExternal: true,
    });
  });
  return { inboxes, skipped };
}
