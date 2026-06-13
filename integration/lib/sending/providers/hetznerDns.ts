/**
 * RecruitersOS · Hetzner DNS API client
 * https://dns.hetzner.com/api-docs — manages zones + records so the full
 * deliverability record set is written automatically (no DNS console clicks).
 *
 * Auth: HETZNER_DNS_TOKEN (create at dns.hetzner.com → API tokens). Dormant
 * (throws HetznerNotConfigured) until the token is set.
 */

import type { DesiredRecord } from "../types";

const BASE = "https://dns.hetzner.com/api/v1";

export class HetznerNotConfigured extends Error {
  status = 503;
  constructor(which: string) { super(`${which} not configured`); this.name = "HetznerNotConfigured"; }
}

function token(): string {
  const t = process.env.HETZNER_DNS_TOKEN;
  if (!t) throw new HetznerNotConfigured("HETZNER_DNS_TOKEN");
  return t;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Auth-API-Token": token(), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw Object.assign(new Error(`hetzner_dns_${res.status}: ${txt.slice(0, 200)}`), { status: res.status });
  }
  return (await res.json().catch(() => ({}))) as T;
}

export interface HetznerZone { id: string; name: string; ns?: string[]; status?: string }
interface ZonesResp { zones: HetznerZone[] }
interface ZoneResp { zone: HetznerZone }
export interface HetznerRecord { id: string; zone_id: string; type: string; name: string; value: string; ttl?: number }
interface RecordsResp { records: HetznerRecord[] }

/** Find a zone by apex name, or null. */
export async function findZone(name: string): Promise<HetznerZone | null> {
  const r = await call<ZonesResp>("GET", `/zones?name=${encodeURIComponent(name)}`);
  return r.zones?.find((z) => z.name === name) || null;
}

/** Ensure a zone exists; returns it (with its Hetzner nameservers). */
export async function ensureZone(name: string): Promise<HetznerZone> {
  const existing = await findZone(name);
  if (existing) return existing;
  const r = await call<ZoneResp>("POST", "/zones", { name });
  return r.zone;
}

export async function listRecords(zoneId: string): Promise<HetznerRecord[]> {
  const r = await call<RecordsResp>("GET", `/records?zone_id=${encodeURIComponent(zoneId)}`);
  return r.records || [];
}

/**
 * Upsert one desired record into a zone (create, or update if a same type+name
 * already exists). Hetzner stores MX priority inline in the value ("10 host").
 * Returns the provider record id.
 */
export async function upsertRecord(zoneId: string, rec: DesiredRecord, existing: HetznerRecord[]): Promise<string> {
  const value = rec.type === "MX" && rec.priority != null ? `${rec.priority} ${rec.value}` : rec.value;
  const payload = { zone_id: zoneId, type: rec.type, name: rec.name, value, ttl: rec.ttl };
  const match = existing.find((e) => e.type === rec.type && e.name === rec.name);
  if (match) {
    await call("PUT", `/records/${match.id}`, payload);
    return match.id;
  }
  const r = await call<{ record: HetznerRecord }>("POST", "/records", payload);
  return r.record.id;
}

export function dnsConfigured(): boolean {
  return !!process.env.HETZNER_DNS_TOKEN;
}
