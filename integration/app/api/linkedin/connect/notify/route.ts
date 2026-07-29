/**
 * POST /api/linkedin/connect/notify
 * Hosted sign-in callback for per-recruiter LinkedIn connections.
 *
 * The provider's wizard calls this when a recruiter finishes (or fails) the
 * hosted LinkedIn sign-in started by /api/linkedin/connect. The request is
 * unauthenticated by design, so the ONLY thing trusted here is the single-use
 * correlation token we minted at start time (`name`): it is unguessable,
 * burns on first use, expires after 2 hours, and resolves to exactly one
 * `${workspace}:${user}`. No token, no binding.
 */

import { NextResponse } from "next/server";
import { withWorkspaceCreds } from "../../../../../lib/connected";
import { unipileRequest, UnipileError } from "../../../../../lib/linkedin/provider";
import { takePending, upsertSeat, removeSeat } from "../../../../../lib/linkedin/seats";

export async function POST(req: Request) {
  let p: Record<string, any>;
  try {
    p = JSON.parse(await req.text());
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const token = String(p?.name ?? "").trim();
  if (!token) return NextResponse.json({ error: "missing_token" }, { status: 400 });

  const pending = await takePending(token);
  if (!pending) return NextResponse.json({ error: "unknown_token" }, { status: 404 });

  const status = String(p?.status ?? "");
  const accountId = String(p?.account_id ?? "").trim();
  // Failure callbacks (wizard abandoned, checkpoint failed) burn the token and
  // change nothing: the recruiter's card still shows Connect, they just retry.
  if (!accountId || !/SUCCESS|RECONNECT/i.test(status)) {
    return NextResponse.json({ ok: true, bound: false });
  }

  await upsertSeat(pending.workspaceId, pending.userId, { accountId, status: "ok" });

  // Best-effort enrich + verify: pull the account's display name for the card
  // label, and unbind again if the provider says the account doesn't actually
  // exist (a forged callback can then never plant a phantom seat).
  await withWorkspaceCreds(pending.workspaceId, async () => {
    try {
      const a = await unipileRequest<{ name?: string }>(`/accounts/${encodeURIComponent(accountId)}`);
      if (a?.name) {
        await upsertSeat(pending.workspaceId, pending.userId, { accountId, label: a.name, status: "ok" });
      }
    } catch (err) {
      if (err instanceof UnipileError && (err.status === 404 || err.status === 422)) {
        await removeSeat(pending.workspaceId, pending.userId);
      }
      // Anything else (provider blip): keep the binding, the label back-fills
      // on the next status probe.
    }
  });

  console.info(`[linkedin:connect] seat bound ws=${pending.workspaceId} user=${pending.userId} (${pending.mode})`);
  return NextResponse.json({ ok: true, bound: true });
}
