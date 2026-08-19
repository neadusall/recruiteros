/**
 * RecruitersOS · Phone Intelligence · Telnyx provisioning
 *
 * A DEDICATED Call Control application whose webhook points at
 * /api/phone-intel/webhook, kept separate from the browser phone's app (which
 * points at /api/phone/webhook) so IVR-navigation events never cross wires with
 * live recruiter calls — the same isolation the codebase already uses between
 * BD Phone and Voice Drops. Create-or-adopt and idempotent.
 */

import { telnyx } from "../providers";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";
import { nowIso } from "../core/ids";

const APP_NAME = "RecruitersOS Phone Intelligence";
const SNAP_KEY = "phone_intel_infra_v1";

interface IntelInfra {
  appId?: string;
  connectionId?: string; // Call Control connection used as the dial connection_id
  webhookUrl?: string;
  provisionedAt?: string;
  lastError?: string;
}

const store = { infra: {} as Record<string, IntelInfra> };
const persist = debouncedSaver(SNAP_KEY, () => store);

let hydrated: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  if (!hydrated) {
    hydrated = dbEnabled()
      ? loadSnapshot<any>(SNAP_KEY).then((s) => { if (s?.infra) store.infra = s.infra; }).catch(() => {})
      : Promise.resolve();
  }
  return hydrated;
}
void ensureReady();

function appUrl(): string {
  return process.env.RECRUITEROS_APP_URL ?? "https://recruitersos.co";
}
export function intelWebhookUrl(): string {
  return `${appUrl()}/api/phone-intel/webhook`;
}

function get(workspaceId: string): IntelInfra {
  return (store.infra[workspaceId] ??= {});
}

/**
 * Ensure the dedicated Call Control app exists and its webhook points here.
 * Must run inside withWorkspaceCreds(workspaceId, ...) so it provisions on the
 * workspace's own Telnyx account. Returns the app id used as connection_id.
 */
export async function ensureIntelInfra(workspaceId: string): Promise<IntelInfra> {
  await ensureReady();
  const infra = get(workspaceId);
  if (infra.appId) return infra;

  try {
    const list = await telnyx.listCallControlApps();
    const url = intelWebhookUrl();
    if (!list?.dryRun) {
      const existing = (list?.data ?? []).find((a: any) => a?.application_name === APP_NAME);
      if (existing?.id) {
        if (existing.webhook_event_url !== url) {
          await telnyx.updateCallControlApp(String(existing.id), {
            webhook_event_url: url, webhook_api_version: "2",
          }).catch(() => {});
        }
        infra.appId = String(existing.id);
        infra.connectionId = String(existing.id);
        infra.webhookUrl = url;
        infra.provisionedAt = nowIso();
        infra.lastError = undefined;
        persist();
        return infra;
      }
    }
    const created = await telnyx.createCallControlApp(APP_NAME, url);
    const id = created?.data?.id;
    if (!id) {
      // Dry-run (unconfigured) — leave unprovisioned; callers surface the remedy.
      infra.webhookUrl = url;
      persist();
      return infra;
    }
    infra.appId = String(id);
    infra.connectionId = String(id);
    infra.webhookUrl = url;
    infra.provisionedAt = nowIso();
    infra.lastError = undefined;
    persist();
    return infra;
  } catch (e: any) {
    infra.lastError = String(e?.message ?? e);
    persist();
    throw e;
  }
}
