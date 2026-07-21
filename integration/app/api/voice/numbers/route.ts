/**
 * Voice Drops · Numbers API
 *   GET /api/voice/numbers  -> the Telnyx phone numbers on this workspace's
 *                              account, for the campaign caller-ID picker.
 *
 * A Voice Drops campaign dials FROM one consistent, approved 10DLC caller-ID.
 * This lists the numbers the operator actually owns so they pick one instead of
 * hand-typing an E.164. Session-gated; reads the live list inside the workspace's
 * own credential scope (white-label isolation). When Telnyx isn't keyed it
 * returns an empty list + dryRun so the UI falls back to a manual text field.
 */

import { ok, requireCapability } from "../../../../lib/api";
import { telnyx } from "../../../../lib/providers";
import { withWorkspaceCreds } from "../../../../lib/connected";

export async function GET(req: Request) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;

  let numbers: Array<{ phoneNumber: string; label?: string }> = [];
  let dryRun = false;
  let error: string | undefined;
  try {
    // Isolation: list THIS workspace's Telnyx numbers, not the operator's.
    const res: any = await withWorkspaceCreds(ws, () => telnyx.listPhoneNumbers(250, 1));
    if (res?.dryRun) {
      dryRun = true;
    } else {
      const data: any[] = Array.isArray(res?.data) ? res.data : [];
      numbers = data
        .map((n) => ({
          phoneNumber: String(n?.phone_number ?? ""),
          label: n?.phone_number_type || n?.connection_name || undefined,
        }))
        .filter((n) => n.phoneNumber);
    }
  } catch (e: any) {
    error = e?.message || "telnyx_error";
  }

  return ok({ numbers, dryRun, error });
}
