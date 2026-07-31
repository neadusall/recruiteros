/**
 * RecruitersOS · Senders · warm-up fleet import sync
 *
 * "Get those emails in there so they can be tracked individually in each portal."
 * The whole mailbox fleet already lives upstream in Smartlead (warm-up); this
 * module mirrors it into the per-portal Email ID pools so every mailbox is a
 * tracked row on its OWN portal's Senders tab:
 *
 *   - domain starts with a white-label brand token ("lume…") -> that tenant's
 *     workspace (resolved exactly like the warm-up panel's portal split);
 *   - everything else ("tal…", house domains)               -> the house workspace.
 *
 * Provider + credentials, from what Smartlead knows about each account:
 *   - SMTP-type accounts carry real credentials -> imported ready to send from
 *     this platform ("own-smtp" when the host is the internal SMTP server).
 *   - OAuth accounts (OUTLOOK/GMAIL, the Sending.ac-provisioned fleet) carry no
 *     SMTP password -> imported WITHOUT credentials, tracked and counted, and
 *     the rotation skips them (they send their flat volume upstream).
 *
 * Idempotent: re-running refreshes credentials/health fields and NEVER clobbers
 * an operator's status or recruiter assignment. Safe to run on every tick.
 */

import { addInbox, findInboxByEmail, decodeBase64Password } from "./store";
import type { SenderProvider, SenderStatus } from "./types";

export interface FleetSyncReport {
  configured: boolean;
  accounts: number;
  imported: number;
  updated: number;
  withCreds: number;
  credsless: number;
  skippedNoWorkspace: number;
  byWorkspace: Record<string, number>;
  at: string;
}

function brandToken(name: string): string {
  return (name.split(/\s+/)[0] || "").toLowerCase();
}

/** Hostnames of the internal SMTP server(s), same sources as the warm-up panel. */
function internalSmtpHosts(): string[] {
  const hosts: string[] = [];
  try {
    const raw = process.env.SMTP_WATCH_HOSTS;
    if (raw) for (const w of JSON.parse(raw)) if (w?.host) hosts.push(String(w.host).toLowerCase());
  } catch { /* bad JSON: Mailcow host below still applies */ }
  try {
    const base = process.env.MAILCOW_API_BASE_URL;
    if (base) hosts.push(new URL(base).hostname.toLowerCase());
  } catch { /* unset/invalid */ }
  return hosts.filter(Boolean);
}

/** The house-side workspace new house-domain mailboxes land in: HOUSE_WORKSPACE_ID
 *  when set, else the oldest workspace that is not a white-label tenant. */
async function houseWorkspaceId(): Promise<string | null> {
  const explicit = (process.env.HOUSE_WORKSPACE_ID || "").trim();
  if (explicit) return explicit;
  try {
    const { devAuthStore } = await import("../auth");
    const { isTenantWorkspace } = await import("../branding/portal");
    const candidates = [...devAuthStore().workspaces.values()]
      .filter((w) => !isTenantWorkspace(w.id))
      .sort((a, b) => String((a as any).createdAt || "").localeCompare(String((b as any).createdAt || "")));
    return candidates[0]?.id || null;
  } catch {
    return null;
  }
}

function providerFor(accountType: string | undefined, smtpHost: string | undefined, internal: string[]): SenderProvider {
  const t = (accountType || "").toUpperCase();
  if (t === "OUTLOOK") return "sending-ac"; // Sending.ac provisions MS-based mailboxes
  if (t === "GMAIL") return "google";
  const h = (smtpHost || "").toLowerCase();
  if (h && internal.some((i) => h === i || h.endsWith("." + i))) return "own-smtp";
  return "other";
}

/** Mirror the Smartlead fleet into the per-portal Email ID pools. Never throws. */
export async function syncFleetInboxes(): Promise<FleetSyncReport> {
  const at = new Date().toISOString();
  const report: FleetSyncReport = {
    configured: false, accounts: 0, imported: 0, updated: 0,
    withCreds: 0, credsless: 0, skippedNoWorkspace: 0, byWorkspace: {}, at,
  };
  try {
    const { smartleadConfigured, listSmartleadAccountsFull } = await import("../sending/smartlead");
    const { ensureConfig } = await import("../sending/config");
    await ensureConfig();
    if (!smartleadConfigured()) return report;
    report.configured = true;

    const accounts = await listSmartleadAccountsFull();
    report.accounts = accounts.length;
    if (!accounts.length) return report;

    const { allBrandPresets } = await import("../branding/presets");
    const { tenantWorkspaceForHost } = await import("../branding/portal");
    const tenants: Array<{ token: string; wsId: string }> = [];
    for (const p of allBrandPresets()) {
      const wsId = tenantWorkspaceForHost(p.appHost);
      const token = brandToken(p.brandName);
      if (wsId && token) tenants.push({ token, wsId });
    }
    const houseWs = await houseWorkspaceId();
    const internal = internalSmtpHosts();

    for (const a of accounts) {
      const domain = (a.email.split("@")[1] || "").toLowerCase();
      if (!domain) continue;
      const tenant = tenants.find((t) => domain.startsWith(t.token));
      const wsId = tenant ? tenant.wsId : houseWs;
      if (!wsId) { report.skippedNoWorkspace++; continue; }

      const hasCreds = !!(a.username && a.password && a.smtpHost);
      if (hasCreds) report.withCreds++; else report.credsless++;

      const provider = providerFor(a.accountType, a.smtpHost, internal);
      // The warm-up engine serves mailbox passwords base64-ENCODED. Decode here so
      // the mailbox is stored ready to authenticate; without this the sync
      // re-introduces the encoded password on every tick and clobbers the
      // hydrate-time self-heal. decodeBase64Password only touches values that are
      // unambiguously base64, so a plaintext password passes through untouched.
      //
      // Applies to every account that carries real credentials, not just own-smtp:
      // the encoding comes from the upstream export, so externally-hosted SMTP
      // accounts (provider "other", Google-hosted domains on smtp.gmail.com) arrive
      // encoded exactly the same way. Decoding only for own-smtp left those latched
      // in error, re-broken on every hourly tick even after a repair.
      const rawPass = hasCreds ? (a.password as string) : "";
      const smtpPass = decodeBase64Password(rawPass) ?? rawPass;

      const existing = await findInboxByEmail(wsId, a.email);
      const status: SenderStatus = existing?.status ?? "warming";
      await addInbox(wsId, {
        email: a.email,
        displayName: existing?.displayName || a.fromName,
        provider,
        smtpHost: a.smtpHost || (a.accountType === "OUTLOOK" ? "smtp.office365.com" : a.accountType === "GMAIL" ? "smtp.gmail.com" : "unknown"),
        smtpPort: a.smtpPort || 587,
        smtpUser: a.username || a.email,
        smtpPass,
        imapHost: a.imapHost,
        imapPort: a.imapPort,
        imapUser: a.imapUsername || a.username || undefined,
        imapPass: a.imapPassword || undefined,
        status,
        warmExternal: true,
        createdAt: a.warmupStartedAt || a.createdAt,
      });
      if (existing) report.updated++; else report.imported++;
      report.byWorkspace[wsId] = (report.byWorkspace[wsId] || 0) + 1;
    }
  } catch { /* best-effort by contract */ }
  return report;
}

/* ---- debounced auto-sync (fires from the Senders tab load, at most every 6h) ---- */

const AUTO_EVERY_MS = 6 * 60 * 60 * 1000;
let lastAutoAt = 0;
let inflight: Promise<FleetSyncReport> | null = null;

export function maybeAutoFleetSync(): void {
  const now = Date.now();
  if (inflight || now - lastAutoAt < AUTO_EVERY_MS) return;
  lastAutoAt = now;
  inflight = syncFleetInboxes().finally(() => { inflight = null; });
  void inflight.catch(() => {});
}
