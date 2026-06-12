/**
 * RecruiterOS · Connected
 * Integration pre-flight + in-portal setup. Each integration is connected right
 * here: enter its keys, follow the steps, hit Test. Status walks Red
 * (unconfigured) -> Yellow (keys saved, unverified) -> Green (test passed).
 *
 * Keys are stored per-workspace (lib/connected/credentials.ts) so an admin
 * connects their own accounts in the portal with no redeploy; tests resolve them
 * through runWithCreds() so the real provider.verify() runs against THIS
 * workspace's credentials.
 *
 * Instantly (email) and SalesRobot (LinkedIn) are intentionally NOT in the
 * catalog: email sends through the self-hosted sending infrastructure (Setup ->
 * Email sending) and LinkedIn through the managed "LinkedIn Automation"
 * integration (Unipile-backed, RecruiterOS-provided — the admin connects a seat,
 * not a key). Their provider clients remain in the registry as optional
 * fallbacks, just not surfaced as setup steps.
 */

import { nowIso } from "../core/ids";
import { getProvider, providerStatuses } from "../providers";
import { runWithCreds } from "../providers/http";
import { saveKeys as storeSaveKeys, markTested, clearKeys, getKeys, resolvedKeys, statusOf } from "./credentials";
import { isHouseWorkspace, isGranted, listGrants } from "./access";
import { verifyVoiceProvider } from "../voice/provider";
import type { Motion } from "../core/types";

export type IntegrationId =
  | "instantly" | "salesrobot" | "unipile" | "rapidapi" | "fresh_linkedin"
  | "tomba" | "loxo" | "taltxt" | "telnyx" | "elevenlabs" | "cartesia";

export type ConnStatus = "red" | "yellow" | "green";

/** One credential field the admin enters in the portal. */
export interface IntegrationField {
  /** The env/key name this maps to, e.g. "UNIPILE_API_KEY". */
  key: string;
  label: string;
  /** Required to reach yellow. Optional fields refine behaviour but don't gate. */
  required: boolean;
  secret?: boolean;
  placeholder?: string;
  hint?: string;
}

export interface IntegrationMeta {
  id: IntegrationId;
  label: string;
  /** One line on what the tool does in the engine. */
  blurb: string;
  /** Which motions require this integration to be green to activate. */
  requiredFor: Motion[];
  /** Credential fields shown in the Connect dialog. */
  fields: IntegrationField[];
  /** Ordered "how to get connected" steps shown in the dialog. */
  steps: string[];
  /** Where to grab the key. */
  docsUrl?: string;
  docsLabel?: string;
}

export interface Integration extends IntegrationMeta {
  status: ConnStatus;
  /** Which required key fields already have a saved value. */
  present: string[];
  lastTestedAt?: string;
  error?: string;
  /** How this workspace reaches the key: house env, own saved, operator-granted, or none. */
  access: "house" | "own" | "granted" | "none";
  /** True when the operator has granted this customer house-key access (billable). */
  granted: boolean;
}

/**
 * The integrations an admin stands up in the portal. Loxo is connected on the
 * dedicated ATS tab (richer sync/webhook flow) but still pre-flighted here.
 */
const CATALOG: IntegrationMeta[] = [
  {
    id: "unipile",
    label: "LinkedIn Automation",
    blurb: "Sends connection invites, DMs and voice notes from your LinkedIn seats — fully managed for you, no API key to set up.",
    requiredFor: ["bd", "recruiting"],
    // Managed: RecruiterOS provides the underlying automation account (server-side
    // UNIPILE_API_KEY), so the admin never enters a key. They only connect their
    // own LinkedIn seat through the hosted sign-in. The optional account id lets a
    // workspace pin a specific connected seat once linked.
    fields: [
      { key: "UNIPILE_ACCOUNT_ID", label: "LinkedIn account id", required: false, placeholder: "auto-filled once you connect a seat", hint: "Optional — leave blank to use the seat you connect in LinkedIn Automation." },
    ],
    steps: [
      "LinkedIn Automation is provided for you on a managed account, so there's no Unipile key to enter.",
      "Open LinkedIn Automation in the sidebar and connect your LinkedIn profile through the secure hosted sign-in.",
      "Come back here and hit Test to confirm your seat is linked and ready to send.",
    ],
  },
  {
    id: "rapidapi",
    label: "Job Search (signal feed)",
    blurb: "Daily job-posting pull that powers Hire Signals and 'role they're hiring for'.",
    requiredFor: ["bd", "recruiting"],
    fields: [
      { key: "RAPIDAPI_KEY", label: "RapidAPI key", required: true, secret: true, placeholder: "paste your RapidAPI key" },
    ],
    steps: [
      "Sign in at RapidAPI and subscribe to the JSearch API.",
      "Open the JSearch dashboard → copy your X-RapidAPI-Key.",
      "Paste it below, Save, then Test.",
    ],
    docsUrl: "https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch",
    docsLabel: "JSearch on RapidAPI ↗",
  },
  {
    id: "fresh_linkedin",
    label: "Profile enrichment",
    blurb: "First rung of the enrichment waterfall: title, company, seniority, recent moves.",
    requiredFor: ["bd", "recruiting"],
    fields: [
      { key: "FRESH_LINKEDIN_API_KEY", label: "RapidAPI key", required: true, secret: true, placeholder: "paste your RapidAPI key" },
    ],
    steps: [
      "On RapidAPI, subscribe to 'Fresh LinkedIn Profile Data'.",
      "Copy the X-RapidAPI-Key from that API's dashboard (often the same key as JSearch).",
      "Paste it below, Save, then Test.",
    ],
    docsUrl: "https://rapidapi.com/freshdata-freshdata-default/api/fresh-linkedin-profile-data",
    docsLabel: "Fresh LinkedIn on RapidAPI ↗",
  },
  {
    id: "tomba",
    label: "Email finder",
    blurb: "Second rung of the waterfall: corporate email from a name + company domain.",
    requiredFor: ["bd"],
    fields: [
      { key: "TOMBA_API_KEY", label: "Tomba key", required: true, secret: true, placeholder: "ta_xxxx…" },
      { key: "TOMBA_SECRET", label: "Tomba secret", required: true, secret: true, placeholder: "ts_xxxx…" },
    ],
    steps: [
      "Create a Tomba account and open Dashboard → API.",
      "Copy both the Key (ta_…) and the Secret (ts_…).",
      "Paste both below, Save, then Test.",
    ],
    docsUrl: "https://tomba.io/dashboard/api",
    docsLabel: "Tomba API keys ↗",
  },
  {
    id: "taltxt",
    label: "TalTxt (SMS)",
    blurb: "Post-engagement SMS + opt-out mirror for the recruiting motion.",
    requiredFor: ["recruiting"],
    fields: [
      { key: "TALTXT_API_KEY", label: "API key", required: true, secret: true, placeholder: "paste your TalTxt API key" },
      { key: "TALTXT_API_URL", label: "API URL", required: false, placeholder: "https://api.taltxt.io", hint: "Optional — leave blank for the default endpoint." },
    ],
    steps: [
      "Connect your TalTxt workspace and provision a 10DLC number.",
      "Copy the API key from TalTxt settings (and the API URL if self-hosted).",
      "Paste below, Save, then Test.",
    ],
  },
  {
    id: "telnyx",
    label: "Telnyx (calling engine)",
    blurb: "The calling engine for Voice Drops. Add your API key and the number you call from.",
    requiredFor: ["recruiting"],
    fields: [
      { key: "TELNYX_API_KEY", label: "API key", required: true, secret: true, placeholder: "KEY01…" },
      { key: "TELNYX_FROM_NUMBER", label: "Caller-ID number (E.164)", required: false, placeholder: "+13105551234", hint: "The number you call from." },
      { key: "TELNYX_MESSAGING_PROFILE_ID", label: "Messaging profile id", required: false, placeholder: "optional", hint: "Optional — SMS only." },
    ],
    steps: [
      "Create an API key in Telnyx (Auth → API Keys).",
      "Add a 10DLC-registered number to call from.",
      "Paste below, Save, then Test.",
    ],
    docsUrl: "https://portal.telnyx.com/#/app/api-keys",
    docsLabel: "Telnyx API keys ↗",
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs (cloned voice)",
    blurb: "The cloned voice for Voice Drops and AI Vetting. Paste your ElevenLabs API key.",
    requiredFor: [],
    fields: [
      { key: "VOICE_CLONE_API_KEY", label: "API key", required: true, secret: true, placeholder: "sk_…" },
    ],
    steps: [
      "In ElevenLabs, open your profile, then API Keys.",
      "Create a key and copy it.",
      "Paste below, Save, then Test.",
    ],
    docsUrl: "https://elevenlabs.io/app/settings/api-keys",
    docsLabel: "ElevenLabs API keys",
  },
  {
    id: "cartesia",
    label: "Cartesia (cloned voice)",
    blurb: "Alternative cloned-voice provider for Voice Drops and AI Vetting. Paste your Cartesia API key.",
    requiredFor: [],
    fields: [
      { key: "CARTESIA_API_KEY", label: "API key", required: true, secret: true, placeholder: "sk_car_…" },
    ],
    steps: [
      "In Cartesia, open API Keys.",
      "Create a key and copy it.",
      "Paste below, Save, then Test.",
    ],
    docsUrl: "https://play.cartesia.ai/keys",
    docsLabel: "Cartesia API keys",
  },
  {
    id: "loxo",
    label: "Loxo (ATS)",
    blurb: "Your system of record. Connected on the ATS tab, pre-flighted here.",
    requiredFor: ["bd", "recruiting"],
    fields: [],
    steps: [
      "Loxo connects on the ATS tab (it has a richer sync + webhook flow).",
      "Save its domain, slug and API key there; this row turns green once it verifies.",
    ],
  },
];

const META_BY_ID = new Map(CATALOG.map((c) => [c.id, c]));

/** The integrations an operator can resell (grant) to a customer. Excludes the
 *  managed LinkedIn automation (no key — the house provides it regardless). */
export function grantableIntegrations(): { id: IntegrationId; label: string }[] {
  return CATALOG.filter((c) => c.id !== "unipile").map((c) => ({ id: c.id, label: c.label }));
}

/** Required key names for an integration (gate red -> yellow). */
function requiredKeys(id: IntegrationId): string[] {
  return (META_BY_ID.get(id)?.fields ?? []).filter((f) => f.required).map((f) => f.key);
}

/**
 * The keys a workspace may actually use, and whether to run isolated. House
 * workspace = its own saved keys with the normal env fallback. Customer = its
 * own saved keys PLUS the house env keys for any integration the operator has
 * granted, run isolated so nothing else leaks from env.
 */
export async function effectiveKeysFor(
  workspaceId: string,
): Promise<{ keys: Record<string, string>; isolated: boolean }> {
  const own = await resolvedKeys(workspaceId);
  if (isHouseWorkspace(workspaceId)) return { keys: own, isolated: false };
  const keys: Record<string, string> = { ...own };
  for (const id of await listGrants(workspaceId)) {
    const meta = META_BY_ID.get(id);
    if (!meta) continue;
    for (const f of meta.fields) {
      const houseVal = process.env[f.key];
      if (!keys[f.key] && houseVal) keys[f.key] = houseVal; // lend the house key
    }
  }
  return { keys, isolated: true };
}

/**
 * Run `fn` with this workspace's effective, isolation-correct credentials. The
 * single helper every workspace-scoped engine path (sends, crons, tests) should
 * adopt so a customer can never ride the operator's keys uninvited.
 */
export async function withWorkspaceCreds<T>(
  workspaceId: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const { keys, isolated } = await effectiveKeysFor(workspaceId);
  return await runWithCreds(keys, fn, { isolated });
}

/** Build the full per-integration view (metadata + live status) for a workspace. */
export async function listIntegrations(workspaceId: string): Promise<Integration[]> {
  const out: Integration[] = [];
  const house = isHouseWorkspace(workspaceId);
  for (const meta of CATALOG) {
    const saved = await statusOf(workspaceId, meta.id);
    const keys = await getKeys(workspaceId, meta.id);
    const granted = !house && (await isGranted(workspaceId, meta.id));
    // The house keys (process.env) count as present ONLY for the house workspace
    // or a customer the operator has granted this integration to. A plain
    // customer must save its own key — it never inherits the operator's.
    const mayUseEnv = house || granted;
    const envOk = mayUseEnv && requiredKeys(meta.id).every((k) => Boolean(process.env[k]));
    const present = meta.fields
      .map((f) => f.key)
      .filter((k) => Boolean(keys[k]) || (mayUseEnv && Boolean(process.env[k])));
    let status: ConnStatus = saved?.status ?? (envOk ? "yellow" : "red");
    if (!saved && envOk) status = "yellow";
    const ownKeyPresent = meta.fields.some((f) => Boolean(keys[f.key]));
    const access: Integration["access"] = house ? "house" : granted ? "granted" : ownKeyPresent ? "own" : "none";
    out.push({
      ...meta,
      status,
      present,
      lastTestedAt: saved?.lastTestedAt,
      error: saved?.error,
      access,
      granted,
    });
  }
  return out;
}

/** Save the keys an admin entered for one integration (-> yellow). */
export async function saveIntegration(
  workspaceId: string,
  id: IntegrationId,
  keys: Record<string, string>,
): Promise<{ ok: boolean; status: ConnStatus } | null> {
  if (!META_BY_ID.has(id)) return null;
  const cred = await storeSaveKeys(workspaceId, id, keys, requiredKeys(id));
  return { ok: true, status: cred.status };
}

/** Remove a saved connection. */
export async function disconnectIntegration(workspaceId: string, id: IntegrationId): Promise<boolean> {
  if (!META_BY_ID.has(id)) return false;
  await clearKeys(workspaceId, id);
  return true;
}

/**
 * Run the real verify endpoint for one integration against this workspace's
 * saved keys. Configured + verify passes -> green; configured but verify fails
 * -> yellow with the error; not configured -> red.
 */
export async function testConnection(
  workspaceId: string,
  id: IntegrationId,
): Promise<{ status: ConnStatus; error?: string } | null> {
  if (!META_BY_ID.has(id)) return null;
  // Isolation-correct keys: a customer tests only against its own (or granted)
  // keys, never the operator's env. `isolated` suppresses the env fallback.
  const { keys, isolated } = await effectiveKeysFor(workspaceId);

  // Make sure a stored row exists so the test result persists — including for
  // env-configured or Loxo setups that were never saved through the portal.
  const ensureRow = async () => {
    if (!(await statusOf(workspaceId, id))) await storeSaveKeys(workspaceId, id, {}, []);
  };

  // Loxo verifies via its ATS adapter; here we just reflect whether a key exists.
  if (id === "loxo") {
    // env counts only when not isolated (house); a granted customer has the key
    // lent into `keys` already, so this still passes for them.
    const ok = Boolean(keys.LOXO_API_KEY) || (!isolated && Boolean(process.env.LOXO_API_KEY));
    await ensureRow();
    await markTested(workspaceId, id, ok, ok ? undefined : "connect_on_ats_tab");
    return { status: ok ? "green" : "yellow", error: ok ? undefined : "connect_on_ats_tab" };
  }

  // Cloned-voice providers verify through the voice module (not the generic
  // provider registry), using this workspace's saved key.
  if (id === "elevenlabs" || id === "cartesia") {
    return runWithCreds(keys, async () => {
      const result = await verifyVoiceProvider(id);
      await ensureRow();
      const cred = await markTested(workspaceId, id, result.ok, result.error);
      return { status: cred?.status ?? (result.ok ? "green" : "yellow"), error: result.ok ? undefined : result.error };
    }, { isolated });
  }

  const provider = getProvider(id);
  if (!provider) {
    await ensureRow();
    await markTested(workspaceId, id, false, "no_client");
    return { status: "yellow", error: "no_client" };
  }

  return runWithCreds(keys, async () => {
    if (!provider.configured()) {
      const saved = await statusOf(workspaceId, id);
      const status: ConnStatus = saved && saved.status !== "red" ? "yellow" : "red";
      return { status, error: "not_configured" };
    }
    const result = await provider.verify();
    await ensureRow();
    const cred = await markTested(workspaceId, id, result.ok, result.error);
    return { status: cred?.status ?? (result.ok ? "green" : "yellow"), error: result.ok ? undefined : result.error };
  }, { isolated });
}

/**
 * Demo seed only: flip an integration green without live credentials, so a fresh
 * deployment shows a populated, launch-ready Connected tab. Creates an empty
 * (no-key) cred row and marks it tested-ok.
 */
export async function seedGreen(workspaceId: string, id: IntegrationId): Promise<void> {
  if (!META_BY_ID.has(id)) return;
  await storeSaveKeys(workspaceId, id, {}, []);
  await markTested(workspaceId, id, true);
}

/** Live configured-status straight from the provider registry (for diagnostics). */
export function providerHealth() {
  return providerStatuses();
}

/** Run a real verify() for every saved integration ("Test all"). */
export async function testAll(workspaceId: string): Promise<Integration[]> {
  const list = await listIntegrations(workspaceId);
  await Promise.all(
    list.filter((i) => i.status !== "red").map((i) => testConnection(workspaceId, i.id)),
  );
  return listIntegrations(workspaceId);
}

/** Pre-flight gate: can this motion's campaign activate? */
export async function preflight(
  workspaceId: string,
  motion: Motion,
): Promise<{ ok: boolean; blocking: IntegrationId[] }> {
  const list = await listIntegrations(workspaceId);
  const blocking = list
    .filter((i) => i.requiredFor.includes(motion) && i.status !== "green")
    .map((i) => i.id);
  return { ok: blocking.length === 0, blocking };
}
