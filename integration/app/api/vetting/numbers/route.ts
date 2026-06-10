/**
 * AI Vetting · Numbers API
 *   GET /api/vetting/numbers   -> the Telnyx numbers on this account, each tagged
 *                                 with the vetting desk it's currently bound to
 *                                 (so the operator can pick/swap numbers per JD).
 *
 * Session-gated. Reads the live list straight from Telnyx (GET /phone_numbers)
 * and cross-references this workspace's desks so the UI can show "available" vs
 * "assigned to <desk>". When Telnyx isn't keyed it returns the numbers already
 * referenced by desks plus a dryRun flag, so the picker still works in dev.
 */

import { requireSession, ok } from "../../../../lib/api";
import { telnyx } from "../../../../lib/providers";
import { withWorkspaceCreds } from "../../../../lib/connected";
import { listDesks } from "../../../../lib/vetting";

/** Normalize a phone to its last 10 digits for assignment matching. */
function last10(p?: string): string {
  const d = (p ?? "").replace(/\D/g, "");
  return d.slice(-10);
}

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;

  // Which desk (if any) owns each number in this workspace.
  const desks = listDesks(ws);
  const assignedBy = new Map<string, { deskId: string; deskName: string; status: string }>();
  for (const d of desks) {
    if (d.phoneNumber) {
      assignedBy.set(last10(d.phoneNumber), { deskId: d.id, deskName: d.name, status: d.status });
    }
  }

  let telnyxNumbers: Array<{ phoneNumber: string; label?: string }> = [];
  let dryRun = false;
  let error: string | undefined;
  try {
    // Isolation: list THIS workspace's Telnyx numbers, not the operator's.
    const res: any = await withWorkspaceCreds(ws, () => telnyx.listPhoneNumbers(250, 1));
    if (res?.dryRun) {
      dryRun = true;
    } else {
      const data: any[] = Array.isArray(res?.data) ? res.data : [];
      telnyxNumbers = data
        .map((n) => ({
          phoneNumber: String(n?.phone_number ?? ""),
          label: n?.phone_number_type || n?.connection_name || undefined,
        }))
        .filter((n) => n.phoneNumber);
    }
  } catch (e: any) {
    error = e?.message || "telnyx_error";
  }

  // Union of Telnyx-reported numbers and any already bound to a desk (so a number
  // assigned in dev / dry-run still shows up even without a live Telnyx list).
  const seen = new Set(telnyxNumbers.map((n) => last10(n.phoneNumber)));
  for (const d of desks) {
    if (d.phoneNumber && !seen.has(last10(d.phoneNumber))) {
      telnyxNumbers.push({ phoneNumber: d.phoneNumber, label: "bound" });
      seen.add(last10(d.phoneNumber));
    }
  }

  const numbers = telnyxNumbers.map((n) => {
    const a = assignedBy.get(last10(n.phoneNumber));
    return {
      phoneNumber: n.phoneNumber,
      label: n.label,
      assigned: Boolean(a),
      deskId: a?.deskId,
      deskName: a?.deskName,
      deskStatus: a?.status,
    };
  });

  return ok({ numbers, dryRun, error });
}
