/**
 * RecruitersOS · Sending connections config
 *
 * Portal-managed credentials for the owned sending stack, so the whole thing is
 * configured from the Mailbox Ops console instead of server env / SSH. Secrets
 * are encrypted at rest when SENDING_SECRET_KEY is set (same as seed passwords),
 * plaintext otherwise. Every provider reader prefers a portal-set value and
 * falls back to the matching env var, so nothing that already worked via env
 * breaks. Read paths are synchronous (providerStatus, token getters), so the
 * config hydrates eagerly at import and callers that can await do so first.
 */

import { loadSnapshot, debouncedSaver } from "../db";
import { encryptSecret, decryptSecret, encryptionEnabled } from "./secrets";

interface SendingConfigState {
  hetznerDnsToken?: string; // encrypted at rest (legacy DNS automation)
  hcloudToken?: string;     // encrypted at rest (legacy cloud automation)
  smartleadApiKey?: string; // encrypted at rest (warm-up engine)
  mailServerUrl?: string;   // owned mail server admin base URL (not secret)
  mailServerKey?: string;   // encrypted at rest (mail server API key)
  mtaEnabled?: boolean;     // route real cold sends through the owned MTA
}

const KEY = "sending_config_v1";
let state: SendingConfigState = {};
let hydrated = false;
let hydrating: Promise<void> | null = null;

const save = debouncedSaver(KEY, () => state);

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<SendingConfigState>(KEY);
      if (snap) state = { ...snap };
      hydrated = true;
    })();
  }
  return hydrating;
}

/** Await before reading config in an async path (route GET, provisioning, sync). */
export async function ensureConfig(): Promise<void> { return hydrate(); }

export interface SendingConfigPatch {
  hetznerDnsToken?: string | null;
  hcloudToken?: string | null;
  smartleadApiKey?: string | null;
  mailServerUrl?: string | null;
  mailServerKey?: string | null;
  mtaEnabled?: boolean;
}

/**
 * Save a config patch. An empty-string secret is ignored (leaves the stored
 * value untouched, so the UI can send blanks for "unchanged"); an explicit null
 * clears it. Secrets are encrypted before they touch the snapshot.
 */
export async function setSendingConfig(patch: SendingConfigPatch): Promise<void> {
  await hydrate();
  const setSecret = (k: "hetznerDnsToken" | "hcloudToken" | "smartleadApiKey" | "mailServerKey", v: unknown) => {
    if (v === null) { delete state[k]; return; }
    if (typeof v !== "string") return;
    const t = v.trim();
    if (!t) return; // empty = leave unchanged
    state[k] = encryptSecret(t) ?? t;
  };
  setSecret("hetznerDnsToken", patch.hetznerDnsToken);
  setSecret("hcloudToken", patch.hcloudToken);
  setSecret("smartleadApiKey", patch.smartleadApiKey);
  setSecret("mailServerKey", patch.mailServerKey);
  // The base URL is not a secret; stored plain. null clears, blank leaves unchanged.
  if (patch.mailServerUrl === null) delete state.mailServerUrl;
  else if (typeof patch.mailServerUrl === "string" && patch.mailServerUrl.trim()) {
    state.mailServerUrl = patch.mailServerUrl.trim().replace(/\/+$/, "");
  }
  if (typeof patch.mtaEnabled === "boolean") state.mtaEnabled = patch.mtaEnabled;
  save();
}

function stored(k: "hetznerDnsToken" | "hcloudToken" | "smartleadApiKey" | "mailServerKey"): string | undefined {
  const v = state[k];
  return v ? (decryptSecret(v) ?? undefined) : undefined;
}

// Portal value first (decrypted), then env fallback.
export function dnsToken(): string | undefined { return stored("hetznerDnsToken") || process.env.HETZNER_DNS_TOKEN || undefined; }
export function cloudToken(): string | undefined { return stored("hcloudToken") || process.env.HCLOUD_TOKEN || undefined; }
export function smartleadKey(): string | undefined { return stored("smartleadApiKey") || (process.env.SMARTLEAD_API_KEY || "").trim() || undefined; }
export function mailServerUrl(): string | undefined { return state.mailServerUrl || (process.env.MAILCOW_API_BASE_URL || "").trim().replace(/\/+$/, "") || undefined; }
export function mailServerKey(): string | undefined { return stored("mailServerKey") || (process.env.MAILCOW_API_KEY || "").trim() || undefined; }
export function mailServerConnected(): boolean { return !!(mailServerUrl() && mailServerKey()); }
export function mtaEnabled(): boolean {
  if (typeof state.mtaEnabled === "boolean") return state.mtaEnabled;
  return (process.env.SENDING_EMAIL_PROVIDER || "").toLowerCase() === "mta";
}

/** Public status for the UI: which connections are set (never the secret). */
export interface SendingConfigStatus {
  dns: boolean;
  cloud: boolean;
  smartlead: boolean;
  server: boolean;          // owned mail server connection (URL + API key)
  serverUrl?: string;       // shown in the Connections dialog (not a secret)
  mtaEnabled: boolean;
  secretsEncrypted: boolean;
  source: { dns: "portal" | "env" | "none"; cloud: "portal" | "env" | "none"; smartlead: "portal" | "env" | "none"; server: "portal" | "env" | "none" };
}

export function sendingConfigStatus(): SendingConfigStatus {
  const src = (portalVal: string | undefined, envVal: string | undefined): "portal" | "env" | "none" =>
    portalVal ? "portal" : envVal ? "env" : "none";
  return {
    dns: !!dnsToken(),
    cloud: !!cloudToken(),
    smartlead: !!smartleadKey(),
    server: mailServerConnected(),
    serverUrl: mailServerUrl(),
    mtaEnabled: mtaEnabled(),
    secretsEncrypted: encryptionEnabled(),
    source: {
      dns: src(stored("hetznerDnsToken"), process.env.HETZNER_DNS_TOKEN),
      cloud: src(stored("hcloudToken"), process.env.HCLOUD_TOKEN),
      smartlead: src(stored("smartleadApiKey"), (process.env.SMARTLEAD_API_KEY || "").trim() || undefined),
      server: src(stored("mailServerKey"), (process.env.MAILCOW_API_KEY || "").trim() || undefined),
    },
  };
}

// Hydrate eagerly so the synchronous getters see stored values as soon as
// possible after boot; async callers still await ensureConfig() for correctness.
void hydrate();
