/**
 * RecruiterOS · Preflight / readiness
 *
 * One honest answer to "is the system ready, and what's left for ME to do?".
 * Each item reports whether it's wired (by env presence only — never the secret
 * value), whether it's REQUIRED for the core email → voice loop, the exact env
 * vars that are missing, and the one manual step the owner must take.
 *
 * This is the "besides the things I need to do" surface: code is done; this lists
 * the account signups / keys / DNS steps that only the owner can perform.
 */

const has = (...names: string[]) => names.every((n) => Boolean((process.env[n] || "").trim()));
const any = (...names: string[]) => names.some((n) => Boolean((process.env[n] || "").trim()));
const missing = (...names: string[]) => names.filter((n) => !(process.env[n] || "").trim());

export type ReadinessGroup = "core" | "email" | "voice" | "enrichment" | "channels" | "deliverability" | "security";

export interface ReadinessItem {
  key: string;
  label: string;
  group: ReadinessGroup;
  required: boolean;          // required for the core email → voice loop
  ok: boolean;
  missingEnv: string[];
  manualStep?: string;        // the owner action when not ok
  note?: string;
}

export interface Readiness {
  ready: boolean;             // every REQUIRED item is satisfied
  generatedAt: string;
  summary: { required: number; requiredOk: number; optional: number; optionalOk: number };
  todo: string[];            // ordered manual steps still outstanding (required first)
  items: ReadinessItem[];
}

function item(
  key: string, label: string, group: ReadinessGroup, required: boolean,
  ok: boolean, missingEnv: string[], manualStep?: string, note?: string,
): ReadinessItem {
  return { key, label, group, required, ok, missingEnv, manualStep, note };
}

/** Build the full readiness report. `at` is injected so callers control timestamps. */
export function readiness(at: string): Readiness {
  const mtaMode = (process.env.SENDING_EMAIL_PROVIDER || "").toLowerCase() === "mta";

  const items: ReadinessItem[] = [
    // ---- core ----
    item(
      "persistence", "Durable persistence", "core", true,
      any("DATABASE_URL", "ROS_DATA_DIR"), missing("DATABASE_URL"),
      "Set DATABASE_URL (Postgres) or ROS_DATA_DIR (file volume) — otherwise data is memory-only and resets on restart.",
      any("DATABASE_URL", "ROS_DATA_DIR") ? undefined : "Currently MEMORY-ONLY — not safe for production.",
    ),
    item(
      "llm", "Anthropic (drafting + classification)", "core", true,
      has("ANTHROPIC_API_KEY"), missing("ANTHROPIC_API_KEY"),
      "Create an Anthropic API key and set ANTHROPIC_API_KEY.",
    ),
    item(
      "app", "App identity", "core", true,
      has("RECRUITEROS_APP_URL"), missing("RECRUITEROS_APP_URL"),
      "Set RECRUITEROS_APP_URL to the public origin (used for webhook callbacks).",
    ),

    // ---- email sender ----
    item(
      "email_sender", "Email sender", "email", true,
      mtaMode ? any("HCLOUD_TOKEN", "HETZNER_DNS_TOKEN") : has("INSTANTLY_API_KEY"),
      mtaMode ? missing("HCLOUD_TOKEN") : missing("INSTANTLY_API_KEY"),
      mtaMode
        ? "MTA mode: provision a Postal server (Hetzner) and paste its API creds in the Sending tab."
        : "Interim path: set INSTANTLY_API_KEY (or flip to self-hosted with SENDING_EMAIL_PROVIDER=mta).",
      mtaMode ? "Self-hosted MTA is selected (SENDING_EMAIL_PROVIDER=mta)." : "Using Instantly (interim sender).",
    ),
    item(
      "system_email", "Transactional email (auth)", "email", false,
      has("RESEND_API_KEY"), missing("RESEND_API_KEY"),
      "Set RESEND_API_KEY + EMAIL_FROM for password reset / magic-link mail (logs to console without it).",
    ),

    // ---- self-hosted deliverability ----
    item(
      "sending_dns", "Hetzner DNS automation", "deliverability", false,
      has("HETZNER_DNS_TOKEN"), missing("HETZNER_DNS_TOKEN"),
      "Create a Hetzner DNS API token and set HETZNER_DNS_TOKEN (auto-writes SPF/DKIM/DMARC).",
    ),
    item(
      "sending_cloud", "Hetzner Cloud (MTA provisioning)", "deliverability", false,
      has("HCLOUD_TOKEN"), missing("HCLOUD_TOKEN"),
      "Create a Hetzner Cloud API token and set HCLOUD_TOKEN (auto-creates the Postal box + PTR).",
    ),
    item(
      "reputation_snds", "Microsoft SNDS reputation", "deliverability", false,
      has("SNDS_KEY"), missing("SNDS_KEY"),
      "Enroll your sending IPs in SNDS and set SNDS_KEY (the automated-data URL).",
    ),
    item(
      "reputation_postmaster", "Google Postmaster reputation", "deliverability", false,
      has("POSTMASTER_CLIENT_ID", "POSTMASTER_REFRESH_TOKEN"),
      missing("POSTMASTER_CLIENT_ID", "POSTMASTER_REFRESH_TOKEN"),
      "Verify domains in Postmaster Tools, create an OAuth app, set POSTMASTER_CLIENT_ID + POSTMASTER_REFRESH_TOKEN.",
      "Stub today — SNDS covers Outlook reputation in the meantime.",
    ),

    // ---- enrichment ----
    item(
      "enrichment_email", "Email finding", "enrichment", false,
      any("ICYPEAS_API_KEY", "RAPIDAPI_KEY", "TOMBA_API_KEY"),
      missing("ICYPEAS_API_KEY"),
      "Set at least one email-finder key (ICYPEAS_API_KEY recommended, or RAPIDAPI_KEY).",
    ),
    item(
      "direct_dial", "Direct-dial finder (for voice)", "enrichment", false,
      has("APIFY_TOKEN", "PDL_API_KEY"), missing("APIFY_TOKEN", "PDL_API_KEY"),
      "Set APIFY_TOKEN + PDL_API_KEY to resolve a person's direct line.",
      "Gated by RECRUITEROS_MAX_DIAL_USD ($0.03 default); the $0.10 actor only runs if you raise the cap.",
    ),

    // ---- voice ----
    item(
      "voice_telnyx", "Telnyx voice dialer", "voice", false,
      has("TELNYX_API_KEY", "TELNYX_CONNECTION_ID", "TELNYX_FROM_NUMBER"),
      missing("TELNYX_API_KEY", "TELNYX_CONNECTION_ID", "TELNYX_FROM_NUMBER"),
      "Create a Telnyx account + 10DLC number + Call-Control connection; set TELNYX_API_KEY, TELNYX_CONNECTION_ID, TELNYX_FROM_NUMBER. Point the voice webhook at /api/voice/webhook.",
    ),
    item(
      "voice_clone", "Cloned voice (ElevenLabs)", "voice", false,
      has("VOICE_CLONE_API_KEY", "VOICE_CLONE_VOICE_ID"),
      missing("VOICE_CLONE_API_KEY", "VOICE_CLONE_VOICE_ID"),
      "Record consent audio, mint a voice, set VOICE_CLONE_API_KEY + VOICE_CLONE_VOICE_ID.",
    ),
    item(
      "voice_on_send", "Email-sent → voice-drop trigger", "voice", false,
      voiceOnSendConfigured(),
      voiceOnSendConfigured() ? [] : ["RECRUITEROS_VOICE_ON_SEND", "RECRUITEROS_VOICE_ON_SEND_CAMPAIGN"],
      "To auto-drop voicemail when an email sends: set RECRUITEROS_VOICE_ON_SEND=1 and RECRUITEROS_VOICE_ON_SEND_CAMPAIGN to a launched (consent-attested) voice campaign id.",
      "Off by default so enabling email never silently starts cold-calling.",
    ),

    // ---- other channels ----
    item(
      "linkedin", "LinkedIn", "channels", false,
      any("UNIPILE_API_KEY", "UNIPILE_DSN", "LINKEDIN_LI_AT"),
      missing("UNIPILE_API_KEY"),
      "Link a LinkedIn account via Unipile (UNIPILE_API_KEY + UNIPILE_DSN) or the scraper sidecar (LINKEDIN_LI_AT).",
    ),
    item(
      "sms", "SMS (OS Text)", "channels", false,
      any("QSTASH_TOKEN", "TALTXT_PUBLIC_KEY"),
      missing("QSTASH_TOKEN"),
      "Wire OS Text / taltxt (Telnyx 10DLC) and QStash for scheduled SMS.",
    ),

    // ---- security (recommended in prod) ----
    item(
      "session_secret", "Session secret", "security", true,
      has("RECRUITEROS_SESSION_SECRET"), missing("RECRUITEROS_SESSION_SECRET"),
      "Set RECRUITEROS_SESSION_SECRET to a long random string (sessions are insecure without it).",
    ),
    item(
      "webhook_secrets", "Webhook signature verification", "security", false,
      any("SENDING_WEBHOOK_SECRET", "INSTANTLY_WEBHOOK_SECRET", "TELNYX_PUBLIC_KEY"),
      missing("SENDING_WEBHOOK_SECRET", "TELNYX_PUBLIC_KEY"),
      "Set the per-provider webhook secrets so inbound webhooks are signature-verified in production.",
      "Verification is skipped (dev-safe) when a secret is unset — set them before going live.",
    ),
    item(
      "key_isolation", "White-label key isolation", "security", false,
      has("HOUSE_WORKSPACE_ID"), missing("HOUSE_WORKSPACE_ID"),
      "Set HOUSE_WORKSPACE_ID to your operator (house) workspace id BEFORE onboarding any external client. Until it is set, every workspace is treated as 'house' and a customer's saved keys mirror into the shared process.env — so customer credentials can ride the operator's env and bleed across workspaces.",
      has("HOUSE_WORKSPACE_ID")
        ? "Isolation ON — only the named house workspace uses env keys; every other workspace is sandboxed to its own/granted keys."
        : "ISOLATION OFF (single-operator default). Safe for a solo instance, NOT safe once a second/white-label workspace exists.",
    ),
  ];

  const required = items.filter((i) => i.required);
  const optional = items.filter((i) => !i.required);
  const requiredOk = required.filter((i) => i.ok).length;
  const optionalOk = optional.filter((i) => i.ok).length;

  const todo = [...required.filter((i) => !i.ok), ...optional.filter((i) => !i.ok)]
    .map((i) => i.manualStep)
    .filter((s): s is string => Boolean(s));

  return {
    ready: requiredOk === required.length,
    generatedAt: at,
    summary: { required: required.length, requiredOk, optional: optional.length, optionalOk },
    todo,
    items,
  };
}

/** True when the reactive email-sent → voice-drop trigger is fully configured. */
function voiceOnSendConfigured(): boolean {
  const on = ["1", "true", "yes", "on"].includes((process.env.RECRUITEROS_VOICE_ON_SEND || "").toLowerCase());
  return on && Boolean((process.env.RECRUITEROS_VOICE_ON_SEND_CAMPAIGN || "").trim());
}
