/**
 * GET /api/owner/accounts/[id]/mailbox   (OWNER ONLY)
 *
 * Deliverability health for one hosted account's OWN mailbox (the SMTP the
 * white-label transport uses to send that tenant's auth + candidate mail). A
 * broken tenant mailbox used to silently drop password resets and lock users
 * out; auth mail now fails over to the house sender, but the owner still needs
 * to SEE the breakage and fix the tenant's creds. This is that read.
 *
 * For a non-white-label (house) account the tenant mailbox is irrelevant, so we
 * report whiteLabel:false and the console shows nothing.
 */

import { requireOwner, ok } from "../../../../../../lib/api";
import { checkWorkspaceMailbox } from "../../../../../../lib/auth";
import { notifyBrand } from "../../../../../../lib/outbound/brand";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;

  let whiteLabel = false;
  try {
    whiteLabel = (await notifyBrand(params.id)).whiteLabel;
  } catch { /* treat as house on resolve failure */ }

  if (!whiteLabel) return ok({ whiteLabel: false });

  const mailbox = await checkWorkspaceMailbox(params.id);
  return ok({ whiteLabel: true, ...mailbox });
}
