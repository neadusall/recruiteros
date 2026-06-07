/**
 * RecruiterOS · Hetzner Cloud API client
 * https://docs.hetzner.cloud — provisions the MTA server and (critically) sets
 * the PTR / reverse DNS on its IPv4, which is NOT a zone record and must be set
 * on the IP itself. Auth: HCLOUD_TOKEN. Dormant until the token is set.
 */

import { HetznerNotConfigured } from "./hetznerDns";

const BASE = "https://api.hetzner.cloud/v1";

function token(): string {
  const t = process.env.HCLOUD_TOKEN;
  if (!t) throw new HetznerNotConfigured("HCLOUD_TOKEN");
  return t;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw Object.assign(new Error(`hcloud_${res.status}: ${txt.slice(0, 200)}`), { status: res.status });
  }
  return (await res.json().catch(() => ({}))) as T;
}

export interface HcloudServer {
  id: number;
  name: string;
  status: string;
  public_net?: { ipv4?: { ip: string; dns_ptr?: string } };
}
interface ServerResp { server: HcloudServer }

/**
 * Create a server. `userData` is cloud-init run on first boot (used later to
 * install Postal automatically). Returns the server (poll for its IP).
 */
export async function createServer(input: {
  name: string;
  serverType: string;   // e.g. "cx22"
  image: string;        // e.g. "ubuntu-24.04"
  location: string;     // e.g. "ash" (US East) / "nbg1"
  sshKeys?: string[];
  userData?: string;
}): Promise<HcloudServer> {
  const r = await call<ServerResp>("POST", "/servers", {
    name: input.name,
    server_type: input.serverType,
    image: input.image,
    location: input.location,
    ssh_keys: input.sshKeys,
    user_data: input.userData,
    start_after_create: true,
  });
  return r.server;
}

export async function getServer(id: number): Promise<HcloudServer> {
  const r = await call<ServerResp>("GET", `/servers/${id}`);
  return r.server;
}

/** Set reverse DNS (PTR) on the server's IPv4 so it matches the MTA hostname. */
export async function setReverseDns(serverId: number, ip: string, ptr: string): Promise<void> {
  await call("POST", `/servers/${serverId}/actions/change_dns_ptr`, { ip, dns_ptr: ptr });
}

export function cloudConfigured(): boolean {
  return !!process.env.HCLOUD_TOKEN;
}
