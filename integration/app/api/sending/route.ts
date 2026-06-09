/**
 * GET  /api/sending  -> domains + servers + mailboxes + deliverability + config status
 * POST /api/sending
 *   { action: "add-domains", domains: [] }       -> add + auto-provision each (the "feed me domains" path)
 *   { action: "provision-domain", id }            -> (re)write DNS for one domain
 *   { action: "verify-domain", id }               -> DoH-verify records, flip to active
 *   { action: "delete-domain", id }
 *   { action: "add-server", name, hostname, serverType?, location? }
 *   { action: "provision-server", id }            -> create Hetzner box (Postal cloud-init) + set PTR
 *   { action: "set-postal", id, host, apiKey }    -> store Postal creds on a server
 *   { action: "add-mailbox", domainId, address, displayName?, dailyCap? }
 *   { action: "add-seed", provider, address, imapHost?, imapUser?, imapPass? }
 *   { action: "delete-seed", id }
 *   { action: "seed-test", domainId }             -> start an inbox-placement test
 *   { action: "daily-tick" }                      -> reset caps + warmup + reputation + governor
 *   { action: "run-governor" }                    -> evaluate + pause bad domains now
 */

import { requireSession, body, ok, fail } from "../../../lib/api";
import {
  listDomains, getDomain, addDomain, findDomainByName, deleteDomain,
  listServers, getServer, addServer, saveServer,
  listMailboxes, addMailbox, stats,
  provisionDomainDns, verifyDomain, provisionServer,
  checklist, providerStatus, HetznerNotConfigured,
  listSuppression, recentEvents, listSeeds, addSeed, deleteSeed, listSeedTests,
  runSeedTest, runSendingDaily, runGovernor, domainSetup, sendingHealth,
  listWarmupThreads, engagementSummary, engagementEnabled, runEngagement,
} from "../../../lib/sending";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const domains = await listDomains(ws);
  const mailboxes = await listMailboxes(ws);
  const servers = await listServers(ws);
  const seedTests = await listSeedTests(ws);
  const warmupThreads = await listWarmupThreads(ws, 200);
  return ok({
    domains: domains.map((d) => ({ ...d, dkimPrivateKeyPem: undefined, checklist: checklist(d.records) })),
    servers: servers.map((s) => ({ ...s, postalApiKey: s.postalApiKey ? "set" : undefined })),
    mailboxes,
    stats: await stats(ws),
    providers: providerStatus(),
    suppression: (await listSuppression()).slice(0, 50),
    events: await recentEvents(50),
    seeds: await listSeeds(),
    seedTests,
    // Computed warmth (per mailbox + shared IP) + health (per domain) + roll-up.
    health: sendingHealth(domains, mailboxes, seedTests, servers),
    // Warm-up engagement loop status (B): always-running inbox-to-inbox warming.
    engagement: { enabled: engagementEnabled(), ...engagementSummary(warmupThreads) },
  });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<any>(req);

  if (b?.action === "add-domains" && Array.isArray(b.domains)) {
    const names = b.domains.map((s: string) => String(s).toLowerCase().trim()).filter(Boolean);
    const results: Array<{ domain: string; status: string; error?: string; id?: string }> = [];
    for (const name of names) {
      try {
        let d = await findDomainByName(ws, name);
        if (!d) d = await addDomain(ws, name, { serverId: b.serverId });
        try {
          d = await provisionDomainDns(ws, d.id);
          results.push({ domain: name, status: d.status, id: d.id });
        } catch (e: any) {
          results.push({ domain: name, status: d.status, id: d.id, error: e?.message });
        }
      } catch (e: any) {
        results.push({ domain: name, status: "error", error: e?.message });
      }
    }
    return ok({ results });
  }

  if (b?.action === "provision-domain") {
    if (!b.id) return fail("missing_fields", 422);
    try { return ok({ domain: await provisionDomainDns(ws, b.id) }); } catch (e: any) { return guard(e); }
  }

  if (b?.action === "verify-domain") {
    if (!b.id) return fail("missing_fields", 422);
    try { return ok({ domain: await verifyDomain(ws, b.id) }); } catch (e: any) { return guard(e); }
  }

  if (b?.action === "delete-domain") {
    if (!b.id) return fail("missing_fields", 422);
    return ok({ deleted: await deleteDomain(ws, b.id) });
  }

  if (b?.action === "add-server") {
    if (!b.name || !b.hostname) return fail("missing_fields", 422, { detail: "name + hostname required" });
    return ok({ server: await addServer(ws, { name: b.name, hostname: b.hostname, serverType: b.serverType, location: b.location }) }, 201);
  }

  if (b?.action === "provision-server") {
    if (!b.id) return fail("missing_fields", 422);
    try { return ok({ server: await provisionServer(ws, b.id) }); } catch (e: any) { return guard(e); }
  }

  if (b?.action === "set-postal") {
    if (!b.id || !b.host || !b.apiKey) return fail("missing_fields", 422, { detail: "id + host + apiKey required" });
    const s = await getServer(ws, b.id);
    if (!s) return fail("not_found", 404);
    s.postalHost = String(b.host).trim();
    s.postalApiKey = String(b.apiKey).trim();
    s.postalReady = false;
    await saveServer(s);
    return ok({ ok: true });
  }

  if (b?.action === "add-mailbox") {
    if (!b.domainId || !b.address) return fail("missing_fields", 422);
    const d = await getDomain(ws, b.domainId);
    if (!d) return fail("domain_not_found", 404);
    return ok({ mailbox: await addMailbox(ws, { domainId: b.domainId, address: b.address, displayName: b.displayName, dailyCap: b.dailyCap }) }, 201);
  }

  if (b?.action === "add-seed") {
    if (!b.address) return fail("missing_fields", 422);
    return ok({ seed: await addSeed({ provider: b.provider || "other", address: String(b.address).trim(), imapHost: b.imapHost, imapUser: b.imapUser, imapPass: b.imapPass }) }, 201);
  }

  if (b?.action === "delete-seed") {
    if (!b.id) return fail("missing_fields", 422);
    await deleteSeed(b.id);
    return ok({ ok: true });
  }

  if (b?.action === "seed-test") {
    if (!b.domainId) return fail("missing_fields", 422);
    try { return ok({ test: await runSeedTest(ws, b.domainId) }); } catch (e: any) { return guard(e); }
  }

  // Owner pulls the Postal domain-config (incl. DKIM private key) on demand —
  // shown once to paste into Postal, never returned in the bulk list.
  if (b?.action === "domain-setup") {
    if (!b.id) return fail("missing_fields", 422);
    const d = await getDomain(ws, b.id);
    if (!d) return fail("not_found", 404);
    return ok({ setup: domainSetup(d) });
  }

  if (b?.action === "daily-tick") {
    return ok({ report: await runSendingDaily(ws) });
  }

  if (b?.action === "run-governor") {
    return ok({ paused: await runGovernor(ws) });
  }

  if (b?.action === "run-engagement") {
    return ok({ report: await runEngagement(ws) });
  }

  return fail("unknown_action", 400);
}

function guard(e: any) {
  if (e instanceof HetznerNotConfigured) return fail(e.message + " — add the token to enable automatic provisioning.", 503);
  return fail(e?.message ?? "failed", e?.status ?? 400);
}
