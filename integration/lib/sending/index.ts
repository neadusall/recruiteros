/**
 * RecruiterOS · Sending infrastructure
 * Public barrel for the owned cold-email stack (domains, mailboxes, MTA servers,
 * DNS automation). Import from here.
 */

export type {
  SendingDomain, DomainStatus, MtaServer, ServerStatus, Mailbox, MailboxStatus,
  DesiredRecord, DnsRecordType, DnsPurpose,
} from "./types";

export type { SuppressionEntry, SendEvent, SeedAccount, SeedTest, SeedResult, Placement, DeliveryMetrics, Reputation } from "./types";

export {
  listDomains, getDomain, findDomainByName, addDomain, saveDomain, deleteDomain,
  listServers, getServer, addServer, saveServer,
  listMailboxes, addMailbox, saveMailbox, stats,
  listSuppression, suppress, isSuppressed, recentEvents,
  listSeeds, addSeed, deleteSeed, listSeedTests,
} from "./store";

export { generateDkimKeypair, dkimTxtValue } from "./dkim";
export { desiredRecords, checklist } from "./dns";
export { provisionDomainDns, verifyDomain, provisionServer } from "./provision";
export { dnsConfigured } from "./providers/hetznerDns";
export { cloudConfigured } from "./providers/hetznerCloud";
export { HetznerNotConfigured } from "./providers/hetznerDns";

// Deliverability + send path
export { domainSetup, cloudInit, postalConfigured, PostalNotReady } from "./postal";
export { mtaPreferred, sendEmail } from "../providers/mta";
export { runGovernor, evaluateDomain, THRESHOLDS } from "./governor";
export { refreshReputation, reputationConfigured } from "./reputation";
export { runSeedTest, recordSeedResult } from "./seedtest";
export { advanceWarmup, runWarmupRound } from "./warmup";
export { runSendingDaily } from "./daily";
export { applyDeliveryEvent, mapPostalEvent } from "./ingest";
export { pickMailbox } from "./caps";

/** One call for the UI: which automations are wired? */
export function providerStatus(): { dns: boolean; cloud: boolean; snds: boolean; postmaster: boolean; mta: boolean } {
  return {
    dns: !!process.env.HETZNER_DNS_TOKEN,
    cloud: !!process.env.HCLOUD_TOKEN,
    snds: !!process.env.SNDS_KEY,
    postmaster: !!(process.env.POSTMASTER_CLIENT_ID && process.env.POSTMASTER_REFRESH_TOKEN),
    mta: (process.env.SENDING_EMAIL_PROVIDER || "").toLowerCase() === "mta",
  };
}
