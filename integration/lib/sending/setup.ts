/**
 * RecruiterOS · One-click sending setup orchestrator
 *
 * Turns the half-day of manual clicking (provision VPS → install Postal → DNS →
 * create mailboxes) into a single "Set it up" call that the daily cron then drives
 * to completion. Every step is idempotent and resumable: the function derives the
 * current state from the registry and only does the next missing piece, so it is
 * safe to call repeatedly (the UI button AND the cron both call it).
 *
 * Two steps depend on the outside world and can't be fully code-automated; the
 * orchestrator shrinks them to a prompt and then auto-continues once they clear:
 *   1. Registrar NS delegation — point each domain's nameservers at Hetzner
 *      (we surface the exact NS; verifyDomain polls until they resolve).
 *   2. Postal API key — the booting box best-effort POSTs its key back via
 *      /api/sending/bootstrap; if that fails, the owner pastes host+key once.
 */

import { nowIso, rid } from "../core/ids";
import {
  listServers, addServer, getServer,
  listDomains, findDomainByName, addDomain,
  listMailboxes, addMailbox, saveServer,
  getAutoSetup, setAutoSetup,
} from "./store";
import { provisionServer, provisionDomainDns, verifyDomain } from "./provision";
import { dnsConfigured } from "./providers/hetznerDns";
import { cloudConfigured as cloudOk } from "./providers/hetznerCloud";
import { postalConfigured } from "./postal";
import type { MtaServer, SendingDomain, Mailbox } from "./types";

const DEFAULT_MAILBOXES_PER_DOMAIN = Number(process.env.SENDING_MAILBOXES_PER_DOMAIN || 4);

/** Believable first-name local-parts for warming mailboxes (no "test123"). */
const NAMES = [
  "ava", "noah", "mia", "liam", "ella", "lucas", "zoe", "ryan", "nora", "owen",
  "leah", "evan", "ivy", "cole", "maya", "jack", "ruby", "luke", "sage", "finn",
  "tara", "reed", "june", "wade", "lana", "neil", "gwen", "dean", "remy", "vera",
];

export interface SetupGate {
  step: "tokens" | "ns" | "postal";
  message: string;
  detail?: Record<string, unknown>;
}

export interface SetupStatus {
  enabled: boolean;
  mailboxesPerDomain: number;
  server?: { id: string; hostname: string; status: string; ip?: string; postalReady: boolean };
  domains: Array<{ id: string; domain: string; status: string; coreResolved: boolean; nameservers?: string[]; mailboxes: number }>;
  totals: { domains: number; active: number; mailboxes: number; mailboxTarget: number };
  gates: SetupGate[];        // what still needs a human (or just time)
  done: boolean;             // every domain active + mailbox target met + postal ready
}

/** Count how many core (mx/spf/dkim/dmarc) records have resolved for a domain. */
function coreResolved(d: SendingDomain): boolean {
  const core = d.records.filter((r) => ["mx", "spf", "dkim", "dmarc"].includes(r.purpose));
  return core.length > 0 && core.every((r) => r.present);
}

/** Generate up to `count` warming mailbox addresses for a domain, skipping any that exist. */
async function ensureWarmingMailboxes(workspaceId: string, domain: SendingDomain, count: number): Promise<number> {
  const existing = await listMailboxes(workspaceId, domain.id);
  if (existing.length >= count) return 0;
  const taken = new Set(existing.map((m) => m.address.split("@")[0]));
  let created = 0;
  for (let i = 0; i < NAMES.length && existing.length + created < count; i++) {
    // Vary the local-part deterministically by index so re-runs don't collide.
    const base = NAMES[i];
    const local = taken.has(base) ? `${base}.${domain.dkimSelector.slice(-2)}${i}` : base;
    if (taken.has(local)) continue;
    taken.add(local);
    await addMailbox(workspaceId, { domainId: domain.id, address: `${local}@${domain.domain}`, displayName: base[0].toUpperCase() + base.slice(1) });
    created++;
  }
  return created;
}

/**
 * Advance the whole setup one step for everything that's ready. Idempotent.
 * Called by both the "Set it up" button and the daily cron.
 */
export async function advanceAutoSetup(workspaceId: string): Promise<SetupStatus> {
  const cfg = (await getAutoSetup(workspaceId)) || { enabled: true, mailboxesPerDomain: DEFAULT_MAILBOXES_PER_DOMAIN };
  const target = cfg.mailboxesPerDomain || DEFAULT_MAILBOXES_PER_DOMAIN;

  // 1) Ensure a server exists and is provisioned (box + PTR + Postal cloud-init).
  let server = (await listServers(workspaceId)).find((s) => s.status !== "error") || (await listServers(workspaceId))[0];
  if (server && server.status !== "active" && !server.ip && cloudOk()) {
    try { server = await provisionServer(workspaceId, server.id); } catch { /* surfaced as a gate below */ }
  }

  // 2) For each domain: provision DNS if still pending, then verify (DoH poll).
  const domains = await listDomains(workspaceId);
  for (const d of domains) {
    try {
      if (d.status === "pending") await provisionDomainDns(workspaceId, d.id);
    } catch { /* gate */ }
    if (["awaiting_ns", "verifying", "provisioning"].includes(d.status)) {
      try { await verifyDomain(workspaceId, d.id); } catch { /* keep polling next tick */ }
    }
  }

  // 3) Create the warming mailboxes for every domain (registry now; they only send
  //    once DNS is active + Postal is live, so creating early just means ready sooner).
  for (const d of await listDomains(workspaceId)) {
    try { await ensureWarmingMailboxes(workspaceId, d, target); } catch { /* best-effort */ }
  }

  return setupStatus(workspaceId);
}

/**
 * Kick off (or reconfigure) one-click setup: register the domains, persist the
 * target, then advance once immediately. The cron carries it the rest of the way.
 */
export async function startAutoSetup(
  workspaceId: string,
  opts: { domains: string[]; mailboxesPerDomain?: number; hostname?: string },
): Promise<SetupStatus> {
  const names = [...new Set(opts.domains.map((s) => String(s).toLowerCase().trim()).filter(Boolean))];
  if (!names.length) throw Object.assign(new Error("no_domains"), { status: 422 });
  const mailboxesPerDomain = opts.mailboxesPerDomain && opts.mailboxesPerDomain > 0 ? opts.mailboxesPerDomain : DEFAULT_MAILBOXES_PER_DOMAIN;

  // Ensure a server (so domains can be attached + DNS records point at its host).
  let server = (await listServers(workspaceId)).find((s) => s.status !== "error") || (await listServers(workspaceId))[0];
  if (!server) {
    const hostname = (opts.hostname || `mail.${names[0]}`).toLowerCase();
    server = await addServer(workspaceId, { name: `ros-mta-${names[0].split(".")[0]}`, hostname });
    // One-time token the box will use to POST its Postal key back (auto-bootstrap).
    server.bootstrapToken = rid("boot").replace("boot_", "");
    await saveServer(server);
  }

  // Register each domain against the server (no provisioning yet — advance does that).
  for (const name of names) {
    const existing = await findDomainByName(workspaceId, name);
    if (!existing) await addDomain(workspaceId, name, { serverId: server.id });
  }

  await setAutoSetup(workspaceId, { enabled: true, mailboxesPerDomain, startedAt: nowIso() });
  return advanceAutoSetup(workspaceId);
}

/** Pure read: derive the current setup state + the gates that remain. */
export async function setupStatus(workspaceId: string): Promise<SetupStatus> {
  const cfg = await getAutoSetup(workspaceId);
  const servers = await listServers(workspaceId);
  const server = servers.find((s) => s.status === "active") || servers[0];
  const domains = await listDomains(workspaceId);
  const target = cfg?.mailboxesPerDomain || DEFAULT_MAILBOXES_PER_DOMAIN;

  let mailboxTotal = 0;
  const domainRows = [] as SetupStatus["domains"];
  for (const d of domains) {
    const mbs = await listMailboxes(workspaceId, d.id);
    mailboxTotal += mbs.length;
    domainRows.push({ id: d.id, domain: d.domain, status: d.status, coreResolved: coreResolved(d), nameservers: d.nameservers, mailboxes: mbs.length });
  }

  const gates: SetupGate[] = [];
  if (!dnsConfigured() || !cloudOk()) {
    gates.push({ step: "tokens", message: "Add Hetzner API tokens to enable automatic provisioning.", detail: { HETZNER_DNS_TOKEN: dnsConfigured(), HCLOUD_TOKEN: cloudOk() } });
  }
  // NS delegation gate: any domain still waiting on the registrar to point NS at Hetzner.
  const awaitingNs = domains.filter((d) => d.status === "awaiting_ns" || d.status === "verifying");
  if (awaitingNs.length) {
    gates.push({
      step: "ns",
      message: `Point these domains' nameservers at Hetzner (one-time, at your registrar): ${awaitingNs.map((d) => d.domain).join(", ")}`,
      detail: { nameservers: awaitingNs[0]?.nameservers || [], domains: awaitingNs.map((d) => d.domain) },
    });
  }
  // Postal key gate: box provisioned but no API key yet (auto-bootstrap may still fill it).
  if (server && server.ip && !postalConfigured(server)) {
    gates.push({ step: "postal", message: "Finish Postal: the server is up — it will POST its API key back automatically, or paste host + key once.", detail: { host: server.postalHost, hostname: server.hostname } });
  }

  const active = domains.filter((d) => d.status === "active").length;
  const mailboxTarget = domains.length * target;
  const done = domains.length > 0 && active === domains.length && mailboxTotal >= mailboxTarget && postalConfigured(server);

  return {
    enabled: !!cfg?.enabled,
    mailboxesPerDomain: target,
    server: server ? { id: server.id, hostname: server.hostname, status: server.status, ip: server.ip, postalReady: postalConfigured(server) } : undefined,
    domains: domainRows,
    totals: { domains: domains.length, active, mailboxes: mailboxTotal, mailboxTarget },
    gates,
    done,
  };
}

/** Stop the cron from continuing to drive setup (does not tear anything down). */
export async function pauseAutoSetup(workspaceId: string): Promise<void> {
  const cfg = await getAutoSetup(workspaceId);
  if (cfg) await setAutoSetup(workspaceId, { ...cfg, enabled: false });
}
