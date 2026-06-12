/**
 * POST /api/sending/bootstrap   (PUBLIC — authenticated by a one-time server token)
 *   { token, serverId, host, apiKey } -> store the Postal creds on the MTA server
 *
 * The freshly-provisioned Postal box calls this from its cloud-init once it has
 * minted an API key, so the owner never has to paste it. There is no session —
 * the box has none — so the guard is the one-time `bootstrapToken` we minted for
 * that exact server at setup time. A wrong/missing token is a 403.
 *
 * If auto-bootstrap doesn't fire (Postal version drift, no public app URL), the
 * owner pastes host+key via the normal /api/sending `set-postal` action instead.
 */

import { NextResponse } from "next/server";
import { body } from "../../../../lib/api";
import { listSendingWorkspaceIds, getServer, saveServer } from "../../../../lib/sending";

interface BootstrapBody { token?: string; serverId?: string; host?: string; apiKey?: string }

export async function POST(req: Request) {
  const b = await body<BootstrapBody>(req);
  const token = (b?.token || "").trim();
  const host = (b?.host || "").trim();
  const apiKey = (b?.apiKey || "").trim();
  if (!token || !apiKey || !host) return NextResponse.json({ error: "missing_fields" }, { status: 422 });

  // Find the server whose bootstrapToken matches (scan workspaces — no session).
  for (const ws of await listSendingWorkspaceIds()) {
    const server = b?.serverId ? await getServer(ws, b.serverId) : undefined;
    const match = server && server.bootstrapToken === token ? server : undefined;
    if (match) {
      match.postalHost = host;
      match.postalApiKey = apiKey;
      match.postalReady = false;       // a probe/first send will flip this true
      match.bootstrapToken = undefined; // single-use
      await saveServer(match);
      return NextResponse.json({ ok: true });
    }
  }
  return NextResponse.json({ error: "invalid_token" }, { status: 403 });
}
