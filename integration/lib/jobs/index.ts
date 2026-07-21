/**
 * RecruitersOS · Job Library + candidate-JD pairing
 *
 * The single home for EVERY job description in the workspace, and the answer
 * to "which job is this person for?". Two records:
 *
 *   JobDescription  - one JD, uploaded/pasted once, referenced everywhere
 *                     (AI Vetting desks, JD Sourcing runs, OS Text pushes).
 *   Pairing         - one candidate contact (email and/or phone) tied to one
 *                     JD, with where the tie came from. The pairing follows
 *                     the person across every surface: Candidates tab, the
 *                     vetting call, the resume inbox, OS Text campaigns. The
 *                     point: no candidate is ever floating with no job.
 *
 * Dedupe rules keep it self-healing:
 *   - JDs dedupe by content hash: uploading the same JD twice returns the
 *     existing record instead of a twin.
 *   - Pairings dedupe per (jd, contact): re-pairing refreshes the timestamp
 *     and fills blanks instead of duplicating.
 *
 * Same in-memory + debounced-snapshot durability contract as lib/vetting.
 */

import { rid, nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";

/* ---------------- types ---------------- */

export type JdStatus = "open" | "closed";
export type JdSource = "upload" | "paste" | "vetting" | "sourcing";
export type PairingSource = "vetting" | "resume_inbox" | "jdsourcing" | "ostext" | "manual";

export interface JobDescription {
  id: string;
  workspaceId: string;
  title: string;
  company?: string;
  /** The full JD text, verbatim. */
  text: string;
  status: JdStatus;
  source: JdSource;
  /** Original filename when uploaded. */
  fileName?: string;
  /** Content hash for dedupe (djb2 of normalized text). */
  hash: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pairing {
  id: string;
  workspaceId: string;
  jdId: string;
  /** Lowercased email, "" when unknown. */
  email: string;
  /** Digits-only phone, "" when unknown. */
  phoneDigits: string;
  /** Display phone as provided. */
  phone: string;
  name?: string;
  source: PairingSource;
  /** Human context: desk name, list/campaign name, etc. */
  note?: string;
  createdAt: string;
  updatedAt: string;
}

/* ---------------- store + durability ---------------- */

const store = {
  jds: [] as JobDescription[],
  pairings: [] as Pairing[],
};

const SNAP_KEY = "job_library";
const persist = debouncedSaver(SNAP_KEY, () => store);

let hydrated: Promise<void> | null = null;
export function ensureJobsReady(): Promise<void> {
  if (!hydrated) {
    hydrated = dbEnabled()
      ? loadSnapshot<any>(SNAP_KEY).then((s) => {
          if (!s) return;
          store.jds = s.jds ?? [];
          store.pairings = s.pairings ?? [];
        }).catch(() => {})
      : Promise.resolve();
  }
  return hydrated;
}
void ensureJobsReady();

/* ---------------- helpers ---------------- */

function normEmail(e?: string): string {
  return (e ?? "").trim().toLowerCase();
}
function normPhone(p?: string): string {
  return (p ?? "").replace(/\D/g, "");
}
/** Compare phones by their last 10 digits (tolerates +1 prefixes). */
function samePhone(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.slice(-10) === b.slice(-10);
}

/** djb2 over whitespace-normalized text: cheap, stable content identity. */
function contentHash(text: string): string {
  const s = text.replace(/\s+/g, " ").trim().toLowerCase();
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}:${(h >>> 0).toString(36)}`;
}

/** A usable title from raw JD text: the first substantial line. */
export function titleFromJdText(text: string): string {
  const line = (text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length >= 4 && l.length <= 120);
  return (line || "Untitled role").slice(0, 90);
}

/* ---------------- job descriptions ---------------- */

const JD_TEXT_CAP = 30000;

export function listJds(workspaceId: string): JobDescription[] {
  return store.jds
    .filter((j) => j.workspaceId === workspaceId)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function getJd(workspaceId: string, id: string): JobDescription | undefined {
  return store.jds.find((j) => j.workspaceId === workspaceId && j.id === id);
}

export function getJdById(id: string): JobDescription | undefined {
  return store.jds.find((j) => j.id === id);
}

/**
 * Create-or-reuse a JD. Content-identical text returns the existing record
 * (blanks filled from the new input), so every surface can call this freely
 * without ever creating twins. Returns the canonical record.
 */
export function upsertJd(
  workspaceId: string,
  input: { id?: string; title?: string; company?: string; text: string; source?: JdSource; fileName?: string },
): JobDescription {
  const text = (input.text || "").trim().slice(0, JD_TEXT_CAP);
  const now = nowIso();

  // Explicit-id update path (edits from the library UI).
  if (input.id) {
    const j = getJd(workspaceId, input.id);
    if (j) {
      if (input.title?.trim()) j.title = input.title.trim().slice(0, 90);
      if (input.company !== undefined) j.company = input.company.trim().slice(0, 90) || undefined;
      if (text && text !== j.text) { j.text = text; j.hash = contentHash(text); }
      j.updatedAt = now;
      persist();
      return j;
    }
  }

  const hash = contentHash(text);
  const existing = store.jds.find((j) => j.workspaceId === workspaceId && j.hash === hash);
  if (existing) {
    if (!existing.company && input.company?.trim()) existing.company = input.company.trim().slice(0, 90);
    if (existing.title === "Untitled role" && input.title?.trim()) existing.title = input.title.trim().slice(0, 90);
    existing.updatedAt = now;
    persist();
    return existing;
  }

  const rec: JobDescription = {
    id: rid("jd"),
    workspaceId,
    title: (input.title?.trim() || titleFromJdText(text)).slice(0, 90),
    company: input.company?.trim().slice(0, 90) || undefined,
    text,
    status: "open",
    source: input.source ?? "paste",
    fileName: input.fileName,
    hash,
    createdAt: now,
    updatedAt: now,
  };
  store.jds.push(rec);
  persist();
  return rec;
}

export function setJdStatus(workspaceId: string, id: string, status: JdStatus): JobDescription | undefined {
  const j = getJd(workspaceId, id);
  if (!j) return undefined;
  j.status = status;
  j.updatedAt = nowIso();
  persist();
  return j;
}

/** Delete a JD and its pairings (the UI confirms first). */
export function deleteJd(workspaceId: string, id: string): boolean {
  const before = store.jds.length;
  store.jds = store.jds.filter((j) => !(j.workspaceId === workspaceId && j.id === id));
  store.pairings = store.pairings.filter((p) => !(p.workspaceId === workspaceId && p.jdId === id));
  persist();
  return store.jds.length < before;
}

/* ---------------- pairings ---------------- */

const PAIRING_CAP = 50000;

/**
 * Tie a contact to a JD. Idempotent per (jd, contact): the same person paired
 * to the same job refreshes rather than duplicates, and blanks (name, the
 * missing one of email/phone) are filled in as later surfaces learn them.
 * A contact with neither email nor phone is unpairable and ignored.
 */
export function recordPairing(
  workspaceId: string,
  input: { jdId: string; email?: string; phone?: string; name?: string; source: PairingSource; note?: string },
): Pairing | undefined {
  const email = normEmail(input.email);
  const phoneDigits = normPhone(input.phone);
  if (!email && !phoneDigits) return undefined;
  if (!getJdById(input.jdId)) return undefined;
  const now = nowIso();

  const existing = store.pairings.find((p) =>
    p.workspaceId === workspaceId && p.jdId === input.jdId &&
    ((email && p.email === email) || (phoneDigits && samePhone(p.phoneDigits, phoneDigits))));
  if (existing) {
    if (!existing.email && email) existing.email = email;
    if (!existing.phoneDigits && phoneDigits) { existing.phoneDigits = phoneDigits; existing.phone = input.phone?.trim() || existing.phone; }
    if (!existing.name && input.name?.trim()) existing.name = input.name.trim().slice(0, 80);
    if (input.note?.trim()) existing.note = input.note.trim().slice(0, 120);
    existing.updatedAt = now;
    persist();
    return existing;
  }

  const rec: Pairing = {
    id: rid("pair"),
    workspaceId,
    jdId: input.jdId,
    email,
    phoneDigits,
    phone: input.phone?.trim() || "",
    name: input.name?.trim().slice(0, 80) || undefined,
    source: input.source,
    note: input.note?.trim().slice(0, 120) || undefined,
    createdAt: now,
    updatedAt: now,
  };
  store.pairings.push(rec);
  if (store.pairings.length > PAIRING_CAP) store.pairings = store.pairings.slice(-PAIRING_CAP);
  persist();
  return rec;
}

export function listPairings(workspaceId: string, jdId?: string): Pairing[] {
  return store.pairings
    .filter((p) => p.workspaceId === workspaceId && (!jdId || p.jdId === jdId))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function deletePairing(workspaceId: string, id: string): boolean {
  const before = store.pairings.length;
  store.pairings = store.pairings.filter((p) => !(p.workspaceId === workspaceId && p.id === id));
  persist();
  return store.pairings.length < before;
}

/** Paired-candidate counts per JD, for the library cards. */
export function pairingCounts(workspaceId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of store.pairings) {
    if (p.workspaceId !== workspaceId) continue;
    out[p.jdId] = (out[p.jdId] ?? 0) + 1;
  }
  return out;
}

/** Every job a contact is paired with, newest tie first. */
export function jobsForContact(
  workspaceId: string,
  contact: { email?: string; phone?: string },
): Array<{ jdId: string; title: string; company?: string; status: JdStatus; source: PairingSource; pairedAt: string }> {
  const email = normEmail(contact.email);
  const phoneDigits = normPhone(contact.phone);
  if (!email && !phoneDigits) return [];
  return store.pairings
    .filter((p) => p.workspaceId === workspaceId &&
      ((email && p.email === email) || (phoneDigits && samePhone(p.phoneDigits, phoneDigits))))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .map((p) => {
      const jd = getJdById(p.jdId);
      return jd ? { jdId: jd.id, title: jd.title, company: jd.company, status: jd.status, source: p.source, pairedAt: p.updatedAt } : null;
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x));
}

/**
 * Batch lookup for list surfaces (the Candidates tab): one call, chips for
 * everyone visible. Keys results by the caller-provided `key` so the client
 * can map them straight back onto its rows.
 */
export function lookupJobs(
  workspaceId: string,
  contacts: Array<{ key: string; email?: string; phone?: string }>,
): Record<string, Array<{ jdId: string; title: string }>> {
  const out: Record<string, Array<{ jdId: string; title: string }>> = {};
  for (const c of contacts.slice(0, 500)) {
    const jobs = jobsForContact(workspaceId, c);
    if (jobs.length) out[c.key] = jobs.slice(0, 3).map((j) => ({ jdId: j.jdId, title: j.title }));
  }
  return out;
}
