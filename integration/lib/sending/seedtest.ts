/**
 * RecruiterOS · Inbox-placement (seed) testing
 * Send a probe through a domain/mailbox to a panel of seed inboxes across
 * providers (Gmail/Outlook/Yahoo), then score where each landed
 * (inbox/promotions/spam/missing). Placement must pass before a domain ramps.
 *
 * The SEND uses our own MTA. Reading WHERE the probe landed needs IMAP access to
 * the seed inboxes — that runs in an external/worker reader that posts results
 * back via recordSeedResult (or the owner records them manually). We create the
 * test + send the probes here; results fill in as they arrive.
 */

import { rid, nowIso } from "../core/ids";
import { getDomain, listSeeds, addSeedTest, getSeedTest, saveSeedTest } from "./store";
import { pickMailbox } from "./caps";
import { getServer } from "./store";
import { sendMessage, postalConfigured } from "./postal";
import type { SeedTest, SeedResult, Placement } from "./types";

/**
 * Start a placement test for a domain: send a tagged probe to every seed inbox.
 * Returns the SeedTest (status "sending") with one pending result per seed.
 */
export async function runSeedTest(workspaceId: string, domainId: string): Promise<SeedTest> {
  const domain = await getDomain(workspaceId, domainId);
  if (!domain) throw Object.assign(new Error("not_found"), { status: 404 });
  const seeds = await listSeeds();
  if (!seeds.length) throw Object.assign(new Error("no_seeds"), { status: 409, detail: "Add seed inboxes first." });

  const pick = await pickMailbox(workspaceId, { domainId });
  const test: SeedTest = {
    id: rid("seedt"),
    workspaceId,
    domainId,
    mailboxId: pick?.mailbox.id,
    at: nowIso(),
    status: "sending",
    results: seeds.map((s) => ({ seedId: s.id, provider: s.provider, address: s.address, placement: "pending" as Placement })),
  };
  await addSeedTest(test);

  // Fire the probes (best-effort; a missing MTA leaves results pending for a
  // manual/IMAP reader). The subject carries the test id for the reader to match.
  if (pick) {
    const server = domain.serverId ? await getServer(workspaceId, domain.serverId) : undefined;
    if (server && postalConfigured(server)) {
      for (const s of seeds) {
        try {
          await sendMessage(server, {
            from: pick.mailbox.address,
            to: s.address,
            subject: `[seedtest ${test.id}] placement probe`,
            plainBody: `Inbox-placement probe for ${domain.domain}. Ref ${test.id}.`,
          });
        } catch { /* leave that seed pending */ }
      }
    }
  }
  return test;
}

/** A worker/IMAP reader (or the owner) posts where a probe landed. */
export async function recordSeedResult(testId: string, seedId: string, placement: Placement): Promise<SeedTest | null> {
  const test = await getSeedTest(testId);
  if (!test) return null;
  const r = test.results.find((x: SeedResult) => x.seedId === seedId);
  if (r) r.placement = placement;
  const settled = test.results.filter((x) => x.placement !== "pending");
  if (settled.length === test.results.length) {
    test.status = "complete";
    const inbox = settled.filter((x) => x.placement === "inbox" || x.placement === "promotions").length;
    test.inboxRatePct = Math.round((inbox / settled.length) * 100);
  }
  await saveSeedTest();
  return test;
}
