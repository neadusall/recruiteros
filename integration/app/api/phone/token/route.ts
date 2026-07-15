/**
 * POST /api/phone/token
 * Mint a short-lived Telnyx WebRTC login token for the signed-in user.
 *
 * The browser never sees the Telnyx API key: the server provisions (once) a
 * per-user telephony credential on the workspace's credential connection and
 * returns only the JWT + SIP username. Tokens are minted fresh on every
 * connect; the SDK reconnect path simply calls this again.
 */

import { requireCapability, ok, fail } from "../../../../lib/api";
import { withWorkspaceCreds } from "../../../../lib/connected";
import { issueUserToken } from "../../../../lib/phone/infra";
import { ensurePhoneReady } from "../../../../lib/phone/store";

export async function POST(req: Request) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  await ensurePhoneReady();
  const ws = g.ctx.workspace.id;
  try {
    const res = await withWorkspaceCreds(ws, () =>
      issueUserToken(ws, g.ctx.user.id, g.ctx.user.name),
    );
    if (!res.token) return fail("telnyx_not_configured", 409);
    return ok(res);
  } catch (e: any) {
    const status = Number(e?.status) || 502;
    return fail(String(e?.message ?? "token_failed").slice(0, 300), status);
  }
}
