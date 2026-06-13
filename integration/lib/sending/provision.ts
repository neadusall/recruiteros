/**
 * RecruitersOS · Sending provisioning orchestrator
 *
 * The "feed me domains, I do the rest" engine. For each domain:
 *   1. generate a DKIM keypair (in-app)
 *   2. ensure the Hetzner DNS zone exists (capture its nameservers)
 *   3. write the full record set (A/MX/SPF/DKIM/DMARC/tracking/return-path) via API
 *   4. mark awaiting_ns until the registrar delegates NS to Hetzner
 *   5. verify (DNS-over-HTTPS) until every core record resolves -> active
 *
 * For servers: create the Hetzner Cloud box and set PTR/rDNS on its IP (the one
 * deliverability record that is NOT a zone entry).
 *
 * Everything is token-gated: with no HETZNER_DNS_TOKEN / HCLOUD_TOKEN the calls
 * throw HetznerNotConfigured(503) rather than pretending to succeed.
 */

import { nowIso } from "../core/ids";
import { generateDkimKeypair } from "./dkim";
import { desiredRecords } from "./dns";
import { ensureZone, listRecords, upsertRecord } from "./providers/hetznerDns";
import { createServer, getServer, setReverseDns } from "./providers/hetznerCloud";
import { cloudInit } from "./postal";
import { getDomain, saveDomain, getServer as getStoredServer, saveServer, listServers } from "./store";
import type { SendingDomain, MtaServer, DesiredRecord } from "./types";

function env(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

/** Resolve the MTA server a domain should use (its own, or the first active one). */
async function serverFor(d: SendingDomain): Promise<MtaServer | undefined> {
  if (d.serverId) return getStoredServer(d.workspaceId, d.serverId);
  const servers = await listServers(d.workspaceId);
  return servers.find((s) => s.status === "active") || servers[0];
}

/**
 * Provision (or re-sync) a domain's DNS. Generates DKIM if missing, ensures the
 * zone, and writes every record. Idempotent — safe to re-run.
 */
export async function provisionDomainDns(workspaceId: string, domainId: string): Promise<SendingDomain> {
  const d = await getDomain(workspaceId, domainId);
  if (!d) throw Object.assign(new Error("not_found"), { status: 404 });
  const server = await serverFor(d);
  if (!server) throw Object.assign(new Error("no_mta_server"), { status: 409, detail: "Provision an MTA server first." });

  try {
    d.status = "provisioning";
    d.lastError = undefined;

    // 1. DKIM
    if (!d.dkimPublicKey || !d.dkimPrivateKeyPem) {
      const kp = generateDkimKeypair();
      d.dkimPublicKey = kp.publicKey;
      d.dkimPrivateKeyPem = kp.privateKeyPem;
    }
    if (!d.trackingHost) d.trackingHost = `track.${d.domain}`;
    if (!d.dmarcRua) d.dmarcRua = env("SENDING_DMARC_RUA", `mailto:dmarc@${d.domain}`);

    // 2. zone
    const zone = await ensureZone(d.domain);
    d.zoneId = zone.id;
    if (zone.ns?.length) d.nameservers = zone.ns;

    // 3. records
    const desired = desiredRecords(d, server, { dmarcPolicy: "quarantine" });
    const existing = await listRecords(zone.id);
    for (const rec of desired) {
      rec.providerRecordId = await upsertRecord(zone.id, rec, existing);
    }
    d.records = desired;

    // 4. await NS delegation (records exist in Hetzner; public resolution needs
    //    the registrar to point NS at Hetzner). Verify will promote to active.
    d.status = "awaiting_ns";
    await saveDomain(d);
    return d;
  } catch (e: any) {
    d.status = "error";
    d.lastError = e?.message || "provision_failed";
    await saveDomain(d);
    throw e;
  }
}

/** DNS-over-HTTPS lookup (Google), keyless. Returns answer data strings. */
async function dohResolve(name: string, type: string): Promise<string[]> {
  try {
    const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`, {
      headers: { accept: "application/dns-json" },
    });
    if (!res.ok) return [];
    const j = (await res.json()) as { Answer?: Array<{ data: string; type: number }> };
    return (j.Answer || []).map((a) => a.data.replace(/^"|"$/g, "").replace(/" "/g, ""));
  } catch {
    return [];
  }
}

function fqdn(name: string, domain: string): string {
  return name === "@" ? domain : `${name}.${domain}`;
}

function recordPresent(rec: DesiredRecord, answers: string[]): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\.$/, "").replace(/\s+/g, " ").trim();
  if (!answers.length) return false;
  if (rec.type === "MX") {
    const host = norm(rec.value);
    return answers.some((a) => norm(a).endsWith(host));
  }
  if (rec.type === "A" || rec.type === "CNAME") {
    const want = norm(rec.value);
    return answers.some((a) => norm(a) === want || norm(a).endsWith(want));
  }
  // TXT: providers may chunk; compare on a stable fragment (the value, spaces normalized)
  const want = norm(rec.value);
  return answers.some((a) => norm(a).includes(want.slice(0, Math.min(want.length, 40))));
}

/**
 * Verify a domain: resolve each desired record publicly and mark it present.
 * When all CORE records (MX/SPF/DKIM/DMARC) resolve, flip to active.
 */
export async function verifyDomain(workspaceId: string, domainId: string): Promise<SendingDomain> {
  const d = await getDomain(workspaceId, domainId);
  if (!d) throw Object.assign(new Error("not_found"), { status: 404 });
  if (!d.records.length) return d;

  for (const rec of d.records) {
    const answers = await dohResolve(fqdn(rec.name, d.domain), rec.type === "MX" ? "MX" : rec.type);
    rec.present = recordPresent(rec, answers);
  }

  const core = d.records.filter((r) => ["mx", "spf", "dkim", "dmarc"].includes(r.purpose));
  const allCore = core.length > 0 && core.every((r) => r.present);
  if (allCore) {
    d.status = "active";
    d.verifiedAt = nowIso();
  } else if (d.status !== "error") {
    d.status = "verifying";
  }
  await saveDomain(d);
  return d;
}

/**
 * Provision the Hetzner Cloud MTA server + set PTR/rDNS. Postal install runs via
 * cloud-init (passed as user_data) — left as a documented follow-up; this gets
 * the box + reverse DNS in place, which is the deliverability-critical part.
 */
export async function provisionServer(workspaceId: string, serverId: string): Promise<MtaServer> {
  const s = await getStoredServer(workspaceId, serverId);
  if (!s) throw Object.assign(new Error("not_found"), { status: 404 });
  try {
    s.status = "provisioning";
    s.lastError = undefined;
    await saveServer(s);

    // Best-effort auto-bootstrap of the Postal API key back to us (needs a public
    // app URL + the one-time token minted at setup; absent either, the box just
    // leaves the key for a one-time manual paste).
    const appUrl = (process.env.RECRUITEROS_APP_URL || process.env.SENDING_APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
    const callback = appUrl && s.bootstrapToken
      ? { callbackUrl: `${appUrl}/api/sending/bootstrap`, callbackToken: s.bootstrapToken, serverId: s.id }
      : undefined;

    const created = await createServer({
      name: s.name,
      serverType: s.serverType || env("SENDING_SERVER_TYPE", "cx22"),
      image: env("SENDING_IMAGE", "ubuntu-24.04"),
      location: s.location || env("SENDING_LOCATION", "ash"),
      userData: cloudInit(s.hostname, callback),   // installs Postal on first boot
    });
    s.hcloudServerId = created.id;

    // poll for the IPv4
    let ip = created.public_net?.ipv4?.ip;
    for (let i = 0; i < 10 && !ip; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const fresh = await getServer(created.id);
      ip = fresh.public_net?.ipv4?.ip;
    }
    if (!ip) throw new Error("no_ipv4_assigned");
    s.ip = ip;

    // PTR / rDNS must match the MTA hostname
    await setReverseDns(created.id, ip, s.hostname);
    s.ptr = s.hostname;
    s.status = "active";
    await saveServer(s);
    return s;
  } catch (e: any) {
    s.status = "error";
    s.lastError = e?.message || "server_provision_failed";
    await saveServer(s);
    throw e;
  }
}
