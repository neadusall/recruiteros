/**
 * RecruitersOS · Companies store
 *
 * Workspace-scoped table of CompanyRecords, held in memory for fast search and
 * snapshotted to the durable backend (ros_kv / file volume) so the BD company
 * book survives a redeploy. Same hydrate-once / debounced-snapshot pattern as
 * the data warehouse (lib/data/store.ts).
 *
 * De-dupe priority: provider id → domain → name. A Loxo re-sync therefore
 * updates the same row rather than duplicating it, and a user edit (status,
 * tags) made through the tab is preserved on the next sync (incoming non-empty
 * fields win, but Loxo never sends status/tags so user state is safe).
 */

import { rid, nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver } from "../db";
import type { CompanyRecord, CompanyInput, CompanyQuery, CompanyStatus } from "./types";

const KEY = "companies_v1";

let store: CompanyRecord[] = [];
let hydrated = false;
let hydrating: Promise<void> | null = null;

const save = debouncedSaver(KEY, () => store);

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<CompanyRecord[]>(KEY);
      if (Array.isArray(snap)) store = snap;
      hydrated = true;
    })();
  }
  return hydrating;
}

function domainOf(urlOrDomain?: string): string | undefined {
  if (!urlOrDomain) return undefined;
  return urlOrDomain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .trim() || undefined;
}

/** provider id → domain → name. */
function dedupeKey(c: { providerId?: string; domain?: string; url?: string; name?: string }): string {
  if (c.providerId) return "pid:" + c.providerId.toLowerCase().trim();
  const d = c.domain || domainOf(c.url);
  if (d) return "dom:" + d;
  return "nm:" + (c.name || "").toLowerCase().trim();
}

/** Merge non-empty incoming fields, but never clobber user-owned status/tags. */
function mergeInto(prev: CompanyRecord, next: CompanyInput): CompanyRecord {
  for (const [k, v] of Object.entries(next)) {
    if (k === "raw" || k === "tags" || k === "status") continue;
    if (v !== undefined && v !== null && v !== "") (prev as unknown as Record<string, unknown>)[k] = v;
  }
  // Tags: union (don't drop user tags, add any new source tags).
  if (next.tags && next.tags.length) {
    prev.tags = Array.from(new Set([...(prev.tags || []), ...next.tags]));
  }
  if (next.raw) prev.raw = { ...(prev.raw || {}), ...next.raw };
  prev.updatedAt = nowIso();
  return prev;
}

export async function listCompanies(workspaceId: string, q: CompanyQuery = {}): Promise<{ companies: CompanyRecord[]; total: number }> {
  await hydrate();
  const term = (q.q || "").toLowerCase().trim();
  let rows = store.filter((c) => c.workspaceId === workspaceId);
  if (q.status) rows = rows.filter((c) => c.status === q.status);
  if (q.source) rows = rows.filter((c) => c.source === q.source);
  if (term) {
    rows = rows.filter((c) =>
      [c.name, c.url, c.location, c.owner, c.type, (c.tags || []).join(" ")]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(term),
    );
  }
  rows = rows.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  const total = rows.length;
  const offset = q.offset ?? 0;
  const limit = q.limit ?? rows.length;
  return { companies: rows.slice(offset, offset + limit), total };
}

export async function getCompany(workspaceId: string, id: string): Promise<CompanyRecord | null> {
  await hydrate();
  return store.find((c) => c.workspaceId === workspaceId && c.id === id) ?? null;
}

/** Batch upsert. Returns counts. Dedupe within the batch and against the store. */
export async function upsertCompanies(workspaceId: string, inputs: CompanyInput[]): Promise<{ added: number; updated: number }> {
  await hydrate();
  let added = 0;
  let updated = 0;
  const index = new Map<string, CompanyRecord>();
  for (const c of store) {
    if (c.workspaceId === workspaceId) index.set(dedupeKey(c), c);
  }
  for (const input of inputs) {
    const norm: CompanyInput = { ...input, domain: input.domain || domainOf(input.url), tags: input.tags || [] };
    const key = dedupeKey(norm);
    const existing = index.get(key);
    if (existing) {
      mergeInto(existing, norm);
      updated++;
    } else {
      const rec: CompanyRecord = {
        id: rid("co"),
        workspaceId,
        name: norm.name || "(unknown)",
        url: norm.url,
        domain: norm.domain,
        location: norm.location,
        owner: norm.owner,
        type: norm.type,
        status: norm.status || "uncontacted",
        jobs: norm.jobs ?? 0,
        tags: norm.tags || [],
        source: norm.source || "manual",
        providerId: norm.providerId,
        raw: norm.raw,
        created: norm.created,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      store.push(rec);
      index.set(key, rec);
      added++;
    }
  }
  if (added || updated) save();
  return { added, updated };
}

/** Patch one company's user-owned fields (status / tags / owner / type). */
export async function patchCompany(
  workspaceId: string,
  id: string,
  patch: { status?: CompanyStatus; tags?: string[]; owner?: string; type?: string },
): Promise<CompanyRecord | null> {
  await hydrate();
  const rec = store.find((c) => c.workspaceId === workspaceId && c.id === id);
  if (!rec) return null;
  if (patch.status) rec.status = patch.status;
  if (patch.tags) rec.tags = patch.tags;
  if (patch.owner !== undefined) rec.owner = patch.owner;
  if (patch.type !== undefined) rec.type = patch.type;
  rec.updatedAt = nowIso();
  save();
  return rec;
}

/** Stamp the Loxo (source) id onto a company after a successful create push. */
export async function setCompanyProvider(workspaceId: string, id: string, providerId: string, source = "loxo"): Promise<void> {
  await hydrate();
  const rec = store.find((c) => c.workspaceId === workspaceId && c.id === id);
  if (!rec) return;
  rec.providerId = providerId;
  rec.source = source as CompanyRecord["source"];
  rec.updatedAt = nowIso();
  save();
}

export async function deleteCompanies(workspaceId: string, ids: string[]): Promise<number> {
  await hydrate();
  const set = new Set(ids);
  const before = store.length;
  store = store.filter((c) => !(c.workspaceId === workspaceId && set.has(c.id)));
  const removed = before - store.length;
  if (removed) save();
  return removed;
}

/** Delete by the source system's own id — used when a Loxo `destroy` arrives. */
export async function deleteByProviderId(workspaceId: string, providerId: string): Promise<number> {
  await hydrate();
  const pid = String(providerId);
  const before = store.length;
  store = store.filter((c) => !(c.workspaceId === workspaceId && c.providerId === pid));
  const removed = before - store.length;
  if (removed) save();
  return removed;
}

/** Remove every company sourced from a given system (e.g. on disconnect). */
export async function deleteBySource(workspaceId: string, source: string): Promise<number> {
  await hydrate();
  const before = store.length;
  store = store.filter((c) => !(c.workspaceId === workspaceId && c.source === source));
  const removed = before - store.length;
  if (removed) save();
  return removed;
}

export async function companyStats(workspaceId: string): Promise<{ total: number; byStatus: Record<string, number>; bySource: Record<string, number> }> {
  await hydrate();
  const rows = store.filter((c) => c.workspaceId === workspaceId);
  const byStatus: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const c of rows) {
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    bySource[c.source] = (bySource[c.source] || 0) + 1;
  }
  return { total: rows.length, byStatus, bySource };
}
