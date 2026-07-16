/**
 * RecruitersOS · Loxo sync engine
 *
 * Pulls People → the Data warehouse (as Candidates) and Companies → the BD
 * company book, for one workspace, using that workspace's stored Loxo
 * credentials. Driven two ways:
 *   - the polling cron (app/api/loxo/cron) for a full/incremental sweep, and
 *   - the webhook receiver (app/api/loxo/webhook) for single-record updates.
 *
 * Pagination uses Loxo's scroll cursor when present, else stops at the first
 * short page. A hard page cap keeps any single run bounded.
 */

import { upsertRecords, getRecord, saveRecord } from "../data";
import { upsertCompanies, getCompany, setCompanyProvider } from "../companies";
import {
  getVendorConfig,
  markTested,
  markSynced,
  setWebhookIds,
  type AtsVendorConfig,
} from "./credentials";
import { LoxoClient } from "./loxoClient";
import { syncLoxoActivity } from "./activity";
import {
  loxoPersonToDataRecord,
  loxoCompanyToRecord,
  dataRecordToLoxoPerson,
  companyToLoxoCompany,
} from "./map";
import type { DataRecord } from "../data";

/**
 * Mirror Loxo-flagged DNC people into the durable suppression list. Idempotent:
 * a person already suppressed by any handle is skipped, so daily syncs don't
 * grow duplicate entries.
 */
async function suppressDncRecords(workspaceId: string, records: DataRecord[]): Promise<number> {
  const flagged = records.filter((r) => r.doNotContact && (r.email || r.phone || r.linkedinUrl));
  if (!flagged.length) return 0;
  const { isSuppressed, suppress } = await import("../response/suppression");
  let n = 0;
  for (const r of flagged) {
    const primary = r.email || r.phone || r.linkedinUrl;
    if (await isSuppressed(workspaceId, primary)) continue;
    await suppress(
      workspaceId,
      [r.email, r.email2, r.phone, r.directPhone, r.linkedinUrl],
      r.dncReason || "loxo_dnc",
      new Date().toISOString(),
    );
    n++;
  }
  return n;
}

const MAX_PAGES = 50; // 50 * 100 = up to 5,000 records per object per run
const PER_PAGE = 100;

export interface SyncReport {
  ok: boolean;
  people: { added: number; updated: number; scanned: number };
  companies: { added: number; updated: number; scanned: number };
  /** Communication-history pull (person_events + email_tracking + sms). */
  activity?: { scanned: number; touches: number; peopleUpdated: number; error?: string };
  /** People whose Loxo DNC signal was mirrored into the suppression list. */
  dncSuppressed?: number;
  error?: string;
}

function clientFor(cfg: AtsVendorConfig | null): LoxoClient | null {
  if (!cfg || !cfg.domain || !cfg.slug || !cfg.apiKey) return null;
  return new LoxoClient({ domain: cfg.domain, slug: cfg.slug, apiKey: cfg.apiKey });
}

/** Verify a workspace's Loxo connection and record the result. */
export async function testLoxo(workspaceId: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = await getVendorConfig(workspaceId, "loxo");
  const client = clientFor(cfg);
  if (!client) {
    await markTested(workspaceId, "loxo", false, "missing_credentials");
    return { ok: false, error: "Enter domain, agency slug, and API key first." };
  }
  const res = await client.ping();
  await markTested(workspaceId, "loxo", res.ok, res.error || (res.ok ? undefined : `loxo_${res.status}`));
  if (!res.ok) {
    const hint =
      res.status === 403
        ? "403 Forbidden — check the API key, the agency slug (no extra spaces), and that Open API is enabled for the account."
        : res.status === 401
          ? "401 Unauthorized — the API key is invalid or expired."
          : res.error || `Loxo returned ${res.status}.`;
    return { ok: false, error: hint };
  }
  return { ok: true };
}

/** Full/incremental pull of People + Companies for one workspace. */
export async function syncLoxo(workspaceId: string, opts: { full?: boolean } = {}): Promise<SyncReport> {
  const cfg = await getVendorConfig(workspaceId, "loxo");
  const client = clientFor(cfg);
  if (!client) {
    return { ok: false, people: zero(), companies: zero(), error: "missing_credentials" };
  }
  const updatedAfter = opts.full ? undefined : cfg?.cursor;
  const report: SyncReport = { ok: true, people: zero(), companies: zero() };

  try {
    // People → warehouse (Candidates)
    let scrollId: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await client.listPeople({ perPage: PER_PAGE, scrollId, updatedAfter });
      if (!res.items.length) break;
      report.people.scanned += res.items.length;
      // Loxo's LIST endpoint returns summary records WITHOUT emails/phones — those
      // live only on the per-person detail endpoint (GET /people/{id}). Hydrate each
      // record's full detail so contact info actually lands in the warehouse. Falls
      // back to the list item if a detail fetch fails.
      const full = await hydrate(res.items, (id) => client.getPerson(id));
      const inputs = full.map(loxoPersonToDataRecord);
      const r = await upsertRecords(workspaceId, inputs);
      report.people.added += r.added;
      report.people.updated += r.updated;
      // Anyone Loxo marks do-not-contact goes onto the durable suppression list
      // (the same list the email + LinkedIn gates already check), so a Loxo DNC
      // blocks every channel here, not just the warehouse row.
      report.dncSuppressed = (report.dncSuppressed || 0) + (await suppressDncRecords(workspaceId, r.records));
      scrollId = res.scrollId;
      if (!scrollId && res.items.length < PER_PAGE) break;
      if (!scrollId) break; // no cursor and a full page: avoid re-fetching page 1 forever
    }

    // Companies → BD company book
    scrollId = undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await client.listCompanies({ perPage: PER_PAGE, scrollId, updatedAfter });
      if (!res.items.length) break;
      report.companies.scanned += res.items.length;
      // Same as people: the list is a summary; fetch each company's detail so the
      // full record (contacts, address, etc.) comes through.
      const full = await hydrate(res.items, (id) => client.getCompany(id));
      const inputs = full.map(loxoCompanyToRecord);
      const r = await upsertCompanies(workspaceId, inputs);
      report.companies.added += r.added;
      report.companies.updated += r.updated;
      scrollId = res.scrollId;
      if (!scrollId && res.items.length < PER_PAGE) break;
      if (!scrollId) break;
    }

    await markSynced(workspaceId, "loxo", new Date().toISOString());

    // Communication history (person_events + email_tracking + sms) -> the
    // warehouse `lastContactedAt` stamps the no-double-contact guard reads.
    // Same client, so the adaptive rate gate carries over. A failure here is
    // reported but never fails the record sync that already landed.
    const act = await syncLoxoActivity(workspaceId, client, cfg);
    report.activity = { scanned: act.scanned, touches: act.touches, peopleUpdated: act.peopleUpdated, error: act.error };

    return report;
  } catch (e: any) {
    // Surface Loxo's own explanation (the response body) alongside the status code,
    // so a 4xx like 422 tells us WHICH field/param Loxo rejected instead of a bare
    // "loxo_422". Without this the real cause is invisible in the UI.
    const detail = e?.detail ? String(e.detail).replace(/\s+/g, " ").trim() : "";
    const msg = e?.message ?? "sync_failed";
    return {
      ok: false,
      people: report.people,
      companies: report.companies,
      error: detail ? `${msg}: ${detail}` : msg,
    };
  }
}

/** Pull and upsert a SINGLE person by id (webhook create/update). */
export async function syncOnePerson(workspaceId: string, personId: string): Promise<boolean> {
  const client = clientFor(await getVendorConfig(workspaceId, "loxo"));
  if (!client) return false;
  const person = await client.getPerson(personId);
  if (!person) return false;
  await upsertRecords(workspaceId, [loxoPersonToDataRecord(person)]);
  return true;
}

/** Pull and upsert a SINGLE company by id (webhook create/update). */
export async function syncOneCompany(workspaceId: string, companyId: string): Promise<boolean> {
  const client = clientFor(await getVendorConfig(workspaceId, "loxo"));
  if (!client) return false;
  const company = await client.getCompany(companyId);
  if (!company) return false;
  await upsertCompanies(workspaceId, [loxoCompanyToRecord(company)]);
  return true;
}

/* ============================================================
   Write-back: RecruitersOS -> Loxo (the PUSH direction).

   Called ONLY from user-initiated API actions (a status edit, an
   enrichment), never from the sync/webhook code paths — so a push that
   makes Loxo fire a webhook back at us just re-pulls the same data
   idempotently and stops. No echo loop.
   ============================================================ */

export interface PushResult { ok: boolean; created?: boolean; providerId?: string; error?: string; skipped?: boolean }

/** Push one warehouse record (Candidate) to Loxo: update if linked, else create. */
export async function pushPersonToLoxo(workspaceId: string, recordId: string): Promise<PushResult> {
  const client = clientFor(await getVendorConfig(workspaceId, "loxo"));
  if (!client) return { ok: false, skipped: true, error: "missing_credentials" };
  const rec = await getRecord(workspaceId, recordId);
  if (!rec) return { ok: false, error: "not_found" };
  const body = dataRecordToLoxoPerson(rec);
  if (rec.providerId) {
    const r = await client.updatePerson(rec.providerId, body);
    return r.ok ? { ok: true, providerId: rec.providerId } : { ok: false, error: r.error || `loxo_${r.status}` };
  }
  const r = await client.createPerson(body);
  if (!r.ok) return { ok: false, error: r.error || `loxo_${r.status}` };
  if (r.id) { rec.providerId = r.id; rec.source = "loxo"; await saveRecord(rec); }
  return { ok: true, created: true, providerId: r.id };
}

/** Push one company to Loxo: update if linked, else create (and link back). */
export async function pushCompanyToLoxo(workspaceId: string, companyId: string): Promise<PushResult> {
  const client = clientFor(await getVendorConfig(workspaceId, "loxo"));
  if (!client) return { ok: false, skipped: true, error: "missing_credentials" };
  const rec = await getCompany(workspaceId, companyId);
  if (!rec) return { ok: false, error: "not_found" };
  const body = companyToLoxoCompany(rec);
  if (rec.providerId) {
    const r = await client.updateCompany(rec.providerId, body);
    return r.ok ? { ok: true, providerId: rec.providerId } : { ok: false, error: r.error || `loxo_${r.status}` };
  }
  const r = await client.createCompany(body);
  if (!r.ok) return { ok: false, error: r.error || `loxo_${r.status}` };
  if (r.id) await setCompanyProvider(workspaceId, companyId, r.id);
  return { ok: true, created: true, providerId: r.id };
}

/** Is Loxo the active, connected ATS for this workspace? Gate for write-back. */
export async function loxoIsActive(workspaceId: string): Promise<boolean> {
  const cfg = await getVendorConfig(workspaceId, "loxo");
  return Boolean(cfg && cfg.domain && cfg.slug && cfg.apiKey);
}

/**
 * Register the real-time webhooks with Loxo so create/update/destroy on people
 * and companies stream into our receiver. Idempotent-ish: we delete any
 * webhooks we previously registered, then create the current set.
 *
 * `baseUrl` is the public origin of this deployment (e.g. https://app.example.com).
 */
export async function registerLoxoWebhooks(workspaceId: string, baseUrl: string): Promise<{ registered: number; error?: string }> {
  const cfg = await getVendorConfig(workspaceId, "loxo");
  const client = clientFor(cfg);
  if (!client) return { registered: 0, error: "missing_credentials" };
  if (!cfg?.webhookSecret) return { registered: 0, error: "missing_webhook_secret" };

  const origin = baseUrl.replace(/\/+$/, "");
  const endpoint = `${origin}/api/loxo/webhook?ws=${encodeURIComponent(workspaceId)}&secret=${encodeURIComponent(cfg.webhookSecret)}`;

  // Clean up anything we registered before (best-effort).
  for (const id of cfg.webhookIds || []) {
    await client.deleteWebhook(id).catch(() => false);
  }

  const wanted: Array<{ item_type: string; action: string }> = [];
  for (const item_type of ["person", "company"]) {
    for (const action of ["create", "update", "destroy"]) {
      wanted.push({ item_type, action });
    }
  }
  // New activity logged in Loxo -> near-real-time lastContactedAt update here,
  // so a recruiter's call in Loxo blocks our sequences within minutes, not at
  // the next nightly sync.
  wanted.push({ item_type: "person_event", action: "create" });

  const ids: string[] = [];
  let firstError = "";
  for (const w of wanted) {
    const created = await client
      .createWebhook(w.item_type, w.action, endpoint)
      .catch((e: any) => ({ ok: false, id: undefined, status: 0, error: e?.message ?? "network_error" }));
    if (created.ok && created.id) {
      ids.push(created.id);
    } else if (!firstError) {
      // Remember WHY Loxo rejected the first one, so the UI can show the real
      // reason (our payload vs. webhooks not enabled for the account) instead of
      // a bare "loxo_rejected_webhooks".
      const detail = created.error ? String(created.error).replace(/\s+/g, " ").trim() : "";
      firstError = `loxo_${created.status}${detail ? `: ${detail}` : ""}`;
    }
  }
  await setWebhookIds(workspaceId, "loxo", ids);
  if (!ids.length) return { registered: 0, error: firstError || "loxo_rejected_webhooks" };
  return { registered: ids.length };
}

function zero() {
  return { added: 0, updated: 0, scanned: 0 };
}

/** Max concurrent detail fetches — polite to Loxo's rate limits, still fast. */
const DETAIL_CONCURRENCY = 6;

/**
 * Replace each summary list item with its full detail record (which carries the
 * emails/phones the list omits). Bounded concurrency keeps us within Loxo's rate
 * limits; if a detail fetch fails or returns nothing, we keep the summary item so
 * the record still imports (just without the extra fields).
 */
async function hydrate(
  items: any[],
  fetchOne: (id: string | number) => Promise<any | null>,
): Promise<any[]> {
  const out: any[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const idx = next++;
      const item = items[idx];
      const id = item?.id;
      if (id == null) {
        out[idx] = item;
        continue;
      }
      const full = await fetchOne(id).catch(() => null);
      out[idx] = full || item;
    }
  }
  const workers = Array.from({ length: Math.min(DETAIL_CONCURRENCY, items.length) }, worker);
  await Promise.all(workers);
  return out;
}
