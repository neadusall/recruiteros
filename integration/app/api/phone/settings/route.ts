/**
 * GET/POST /api/phone/settings
 * Per-workspace, per-motion phone settings: the recording policy and the
 * operator's lawful-consent attestation.
 *
 * Reading is open to any dialer (the phone UI needs to know whether recording
 * is on and whether the manual toggle is available). Changing the policy or
 * attesting consent is an admin action (telnyx:manage), mirroring the Voice
 * Drops consent gate: recording stays off until an admin attests that consent
 * is obtained per the jurisdictions they call.
 */

import { requireCapability, requireSession, ok, fail, body } from "../../../../lib/api";
import { getPhoneSettings, savePhoneSettings, ensurePhoneReady } from "../../../../lib/phone/store";
import { nowIso } from "../../../../lib/core/ids";
import type { Motion } from "../../../../lib/core/types";
import type { PhoneSettings, RecordingMode } from "../../../../lib/phone/types";

export const dynamic = "force-dynamic";

const RECORDING_MODES: RecordingMode[] = ["all", "outbound", "inbound", "off"];

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  await ensurePhoneReady();
  const url = new URL(req.url);
  const motion: Motion = url.searchParams.get("motion") === "recruiting" ? "recruiting" : "bd";
  return ok({ settings: getPhoneSettings(g.ctx.workspace.id, motion) });
}

export async function POST(req: Request) {
  const g = requireCapability(req, "telnyx:manage");
  if ("response" in g) return g.response;
  await ensurePhoneReady();

  const b = await body<{
    motion?: Motion;
    recordingMode?: RecordingMode;
    manualRecordingToggle?: boolean;
    transcriptionEnabled?: boolean;
    recordingConsentAttested?: boolean;
  }>(req);
  if (!b) return fail("bad_request", 400);

  const motion: Motion = b.motion === "recruiting" ? "recruiting" : "bd";
  const patch: Partial<PhoneSettings> = {};

  if (b.recordingMode !== undefined) {
    if (!RECORDING_MODES.includes(b.recordingMode)) return fail("invalid_recording_mode", 400);
    patch.recordingMode = b.recordingMode;
  }
  if (typeof b.manualRecordingToggle === "boolean") patch.manualRecordingToggle = b.manualRecordingToggle;
  if (typeof b.transcriptionEnabled === "boolean") patch.transcriptionEnabled = b.transcriptionEnabled;

  // Consent attestation: stamp who attested and when so the gate is auditable.
  // Clearing it revokes the attestation, which turns recording off (shouldRecord).
  if (typeof b.recordingConsentAttested === "boolean") {
    patch.recordingConsentAttested = b.recordingConsentAttested;
    patch.recordingConsentAttestedBy = b.recordingConsentAttested ? g.ctx.user.email : undefined;
    patch.recordingConsentAttestedAt = b.recordingConsentAttested ? nowIso() : undefined;
  }

  const settings = savePhoneSettings(g.ctx.workspace.id, motion, patch);
  return ok({ settings });
}
