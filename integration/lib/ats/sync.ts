/**
 * RecruiterOS · Loxo sync engine
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

import { upsertRecords } from "../data";
import { upsertCompanies } from "../companies";
import {
  getVendorConfig,
  markTested,
  markSynced,
  setWebhookIds,
  type AtsVendorConfig,
} from "./credentials";
import { LoxoClient } from "./loxoClient";
import { loxoPersonToDataRecord, loxoCompanyToRecord } from "./map";

const MAX_PAGES = 50; // 50 * 100 = up to 5,000 records per object per run
const PER_PAGE = 100;

export interface SyncReport {
  ok: boolean;
  people: { added: number; updated: number; scanned: number };
  companies: { added: number; updated: number; scanned: number };
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
      const inputs = res.items.map(loxoPersonToDataRecord);
      const r = await upsertRecords(workspaceId, inputs);
      report.people.added += r.added;
      report.people.updated += r.updated;
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
      const inputs = res.items.map(loxoCompanyToRecord);
      const r = await upsertCompanies(workspaceId, inputs);
      report.companies.added += r.added;
      report.companies.updated += r.updated;
      scrollId = res.scrollId;
      if (!scrollId && res.items.length < PER_PAGE) break;
      if (!scrollId) break;
    }

    await markSynced(workspaceId, "loxo", new Date().toISOString());
    return report;
  } catch (e: any) {
    return { ok: false, people: report.people, companies: report.companies, error: e?.message ?? "sync_failed" };
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

  const ids: string[] = [];
  for (const w of wanted) {
    const created = await client.createWebhook(w.item_type, w.action, endpoint).catch(() => null);
    const id = created?.id ?? created?.webhook?.id;
    if (id) ids.push(String(id));
  }
  await setWebhookIds(workspaceId, "loxo", ids);
  if (!ids.length) return { registered: 0, error: "loxo_rejected_webhooks" };
  return { registered: ids.length };
}

function zero() {
  return { added: 0, updated: 0, scanned: 0 };
}
