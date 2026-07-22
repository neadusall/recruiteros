/**
 * /api/phone/numbers
 *   GET  -> connected lines + (admin) the Telnyx account's numbers + infra
 *   POST -> { action, ... }
 *     provision                          create/adopt the Telnyx app + WebRTC connection
 *     connect     { e164, telnyxNumberId?, label?, motion? }   add a number as a line
 *     update      { lineId, label?, assignedUserIds?, inboundEnabled? }
 *     disconnect  { lineId }
 *     set-active  { lineId }             the caller's own outbound line (member-allowed)
 *
 * Managing numbers is admin-gated (telnyx:manage); choosing your own active
 * outbound line needs only voice:dial.
 */

import { requireCapability, ok, fail, body } from "../../../../lib/api";
import { withWorkspaceCreds } from "../../../../lib/connected";
import { telnyx } from "../../../../lib/providers";
import { toE164 } from "../../../../lib/voice/phone";
import {
  listLines, linesForUser, upsertLine, patchLine, deleteLine, getLine,
  getUserState, patchUserState, getInfra, resetInfra, ensurePhoneReady,
} from "../../../../lib/phone/store";
import { ensureInfra, phoneWebhookUrl } from "../../../../lib/phone/infra";
import { listMembers } from "../../../../lib/auth/team";
import type { Motion } from "../../../../lib/core/types";

export async function GET(req: Request) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  await ensurePhoneReady();
  const ws = g.ctx.workspace.id;
  const isAdmin = g.ctx.capabilities.includes("telnyx:manage");
  const url = new URL(req.url);
  const motion: Motion = url.searchParams.get("motion") === "recruiting" ? "recruiting" : "bd";

  const mine = linesForUser(ws, g.ctx.user.id, isAdmin, motion);
  const state = getUserState(ws, g.ctx.user.id);
  const base: any = {
    lines: isAdmin ? listLines(ws, motion) : mine,
    myLines: mine,
    activeLineId: state.activeLineId && mine.some((l) => l.id === state.activeLineId)
      ? state.activeLineId
      : mine[0]?.id,
  };
  if (!isAdmin) return ok(base);

  // Admin extras: provisioning status, account numbers, team roster.
  const infra = getInfra(ws);
  base.infra = {
    provisioned: Boolean(infra.appId && infra.credentialConnectionId),
    appId: infra.appId,
    webhookUrl: phoneWebhookUrl(),
    lastError: infra.lastError,
  };
  try {
    const nums = await withWorkspaceCreds(ws, () => telnyx.listPhoneNumbers(100));
    base.telnyxNumbers = nums?.dryRun
      ? []
      : (nums?.data ?? []).map((n: any) => ({
          id: String(n?.id ?? ""),
          e164: String(n?.phone_number ?? ""),
          connectionId: n?.connection_id ? String(n.connection_id) : "",
          status: String(n?.status ?? ""),
        }));
    base.telnyxConfigured = !nums?.dryRun;
  } catch (e: any) {
    base.telnyxNumbers = [];
    base.telnyxConfigured = false;
    base.telnyxError = String(e?.message ?? e).slice(0, 200);
  }
  try {
    base.team = listMembers(ws, g.ctx.user.id).map((m) => ({
      userId: m.userId, name: m.name, email: m.email, role: m.role, isYou: m.isYou,
    }));
  } catch {
    base.team = [];
  }
  return ok(base);
}

export async function POST(req: Request) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  await ensurePhoneReady();
  const ws = g.ctx.workspace.id;
  const isAdmin = g.ctx.capabilities.includes("telnyx:manage");
  const b = await body<any>(req);
  if (!b?.action) return fail("missing_action", 400);

  // The one member-allowed action: pick which of MY lines dials out.
  if (b.action === "set-active") {
    const mine = linesForUser(ws, g.ctx.user.id, isAdmin);
    const line = mine.find((l) => l.id === String(b.lineId ?? ""));
    if (!line) return fail("line_not_assigned", 403);
    patchUserState(ws, g.ctx.user.id, { activeLineId: line.id });
    return ok({ activeLineId: line.id });
  }

  if (!isAdmin) return fail("forbidden", 403, { needs: "telnyx:manage" });

  switch (String(b.action)) {
    case "provision": {
      try {
        const infra = await withWorkspaceCreds(ws, () => ensureInfra(ws));
        return ok({
          provisioned: Boolean(infra.appId && infra.credentialConnectionId),
          appId: infra.appId,
          webhookUrl: phoneWebhookUrl(),
        });
      } catch (e: any) {
        return fail(String(e?.message ?? "provision_failed").slice(0, 300), Number(e?.status) || 502);
      }
    }

    case "reset-calling": {
      // Move calling to the workspace's current Telnyx account: drop the cached
      // app + credential connection and every user's cached credential, then
      // rebuild immediately so the app/connection land on the account the key
      // now points at. Recruiters re-mint their own credential on next connect.
      try {
        resetInfra(ws);
        const infra = await withWorkspaceCreds(ws, () => ensureInfra(ws));
        return ok({
          reset: true,
          provisioned: Boolean(infra.appId && infra.credentialConnectionId),
          appId: infra.appId,
          webhookUrl: phoneWebhookUrl(),
        });
      } catch (e: any) {
        return fail(String(e?.message ?? "reset_failed").slice(0, 300), Number(e?.status) || 502);
      }
    }

    case "connect": {
      const e164 = toE164(String(b.e164 ?? ""));
      if (!e164) return fail("invalid_number", 400);
      const motion: Motion = b.motion === "recruiting" ? "recruiting" : "bd";
      const infra = await withWorkspaceCreds(ws, () => ensureInfra(ws)).catch((e: any) => {
        throw e;
      });
      // Assign on connect so a number is tied to its agent in one step (their
      // calls AND their OS Text campaigns then use it). Validate against the
      // roster so a stray id can't be pinned to a line; default to the admin.
      const memberIds = new Set(listMembers(ws, g.ctx.user.id).map((m) => m.userId));
      const requested = Array.isArray(b.assignedUserIds)
        ? b.assignedUserIds.map((x: unknown) => String(x)).filter((id: string) => memberIds.has(id))
        : [];
      const line = upsertLine(ws, {
        e164,
        motion,
        label: String(b.label ?? "").trim() || e164,
        telnyxNumberId: b.telnyxNumberId ? String(b.telnyxNumberId) : undefined,
        assignedUserIds: requested.length ? requested.slice(0, 50) : [g.ctx.user.id],
      });
      // Same number texts too: attach it to the messaging profile so OS Text
      // sends from this line when it's someone's assigned number. Best-effort;
      // a number without messaging never blocks voice setup.
      if (line.telnyxNumberId) {
        await withWorkspaceCreds(ws, () =>
          telnyx.setNumberMessagingProfile(line.telnyxNumberId!),
        ).catch(() => {});
      }
      // Point the number's voice at our app so inbound rings the portal.
      if (line.telnyxNumberId && infra.appId) {
        try {
          await withWorkspaceCreds(ws, () =>
            telnyx.updateNumberConnection(line.telnyxNumberId!, infra.appId!),
          );
          patchLine(ws, line.id, { inboundEnabled: true, connectionId: infra.appId });
        } catch (e: any) {
          patchLine(ws, line.id, { inboundEnabled: false });
          return ok({
            line: getLine(ws, line.id),
            warning: `outbound ready, inbound routing failed: ${String(e?.message ?? e).slice(0, 160)}`,
          });
        }
      }
      return ok({ line: getLine(ws, line.id) });
    }

    case "update": {
      const line = getLine(ws, String(b.lineId ?? ""));
      if (!line) return fail("not_found", 404);
      const patch: any = {};
      if (typeof b.label === "string") patch.label = b.label.trim().slice(0, 60) || line.e164;
      if (Array.isArray(b.assignedUserIds)) {
        patch.assignedUserIds = b.assignedUserIds.map((x: unknown) => String(x)).slice(0, 50);
      }
      if (typeof b.inboundEnabled === "boolean") {
        const infra = getInfra(ws);
        if (b.inboundEnabled && line.telnyxNumberId && infra.appId) {
          await withWorkspaceCreds(ws, () =>
            telnyx.updateNumberConnection(line.telnyxNumberId!, infra.appId!),
          ).catch(() => {});
        }
        patch.inboundEnabled = b.inboundEnabled;
      }
      return ok({ line: patchLine(ws, line.id, patch) });
    }

    case "disconnect": {
      if (!deleteLine(ws, String(b.lineId ?? ""))) return fail("not_found", 404);
      return ok({ deleted: true });
    }

    default:
      return fail("unknown_action", 400);
  }
}
