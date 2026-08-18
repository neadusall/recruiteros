/**
 * /api/linkedin/connect
 * Per-recruiter LinkedIn connection for JD Sourcing's "Search from LinkedIn".
 *
 * Every recruiter connects THEIR OWN LinkedIn login through the provider's
 * hosted sign-in wizard (LinkedIn credentials never touch this app), and the
 * resulting provider account id is bound to `${workspace}:${user}` in the
 * durable seat store. Pasted Sales Navigator / Recruiter searches then pull
 * their members through the signed-in recruiter's own seat.
 *
 *   GET  -> the caller's connection status (drives the Sales Nav card UI)
 *   POST { action: "start" }      -> hosted sign-in URL (create or reconnect,
 *                                    picked automatically from seat state)
 *   POST { action: "disconnect" } -> unbind (and best-effort delete the
 *                                    provider account so nothing lingers)
 *
 * Needs the workspace's automation instance (UNIPILE_DSN + UNIPILE_API_KEY,
 * env or Setup-pasted) to be live; without it GET reports enabled:false and
 * start explains, recruiter-facing, that an admin has to switch it on.
 */

import { body, ok, fail, requireCapability } from "../../../../lib/api";
import { withWorkspaceCreds } from "../../../../lib/connected";
import { cred } from "../../../../lib/providers/http";
import { unipileRequest, UnipileError } from "../../../../lib/linkedin/provider";
import {
  seatForUser, beginConnect, removeSeat, markSeatChecked, type RecruiterSeat,
} from "../../../../lib/linkedin/seats";
import { notifyBrand } from "../../../../lib/outbound/brand";

/** Re-probe a seat's live health at most this often (GET is polled by the UI). */
const RECHECK_MS = 10 * 60 * 1000;

/** How long a recruiter has to finish the hosted wizard before the link dies. */
const LINK_TTL_MS = 60 * 60 * 1000;

const providerReady = () => Boolean(cred("UNIPILE_DSN") && cred("UNIPILE_API_KEY"));

interface ProviderAccount {
  id?: string;
  name?: string;
  sources?: Array<{ id?: string; status?: string }>;
}

/** True when any of the account's sources reports a signed-out/failed state. */
function accountNeedsRelogin(a: ProviderAccount): boolean {
  return (a.sources ?? []).some((s) => /CREDENTIALS|DISCONNECTED|ERROR|STOPPED/i.test(String(s.status ?? "")));
}

/**
 * Live-verify the seat against the provider, throttled by lastCheckedAt so the
 * UI's polling never turns into a probe storm. Flips status ok<->reconnect and
 * refreshes the label. Best-effort: a dead provider leaves the seat as-is.
 */
async function refreshSeatHealth(seat: RecruiterSeat): Promise<RecruiterSeat> {
  const last = seat.lastCheckedAt ? new Date(seat.lastCheckedAt).getTime() : 0;
  if (Date.now() - last < RECHECK_MS) return seat;
  try {
    const a = await unipileRequest<ProviderAccount>(`/accounts/${encodeURIComponent(seat.accountId)}`);
    const status = accountNeedsRelogin(a) ? "reconnect" : "ok";
    await markSeatChecked(seat.workspaceId, seat.userId, status, typeof a.name === "string" ? a.name : undefined);
    return { ...seat, status, label: a.name || seat.label };
  } catch (err) {
    // Account gone at the provider = the connection is dead; anything else
    // (network blip, provider down) leaves the stored state untouched.
    if (err instanceof UnipileError && (err.status === 404 || err.status === 422)) {
      await markSeatChecked(seat.workspaceId, seat.userId, "reconnect");
      return { ...seat, status: "reconnect" };
    }
    return seat;
  }
}

export async function GET(req: Request) {
  const g = requireCapability(req, "sourcing:run");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const userId = g.ctx.user.id;

  return ok(await withWorkspaceCreds(ws, async () => {
    const enabled = providerReady();
    let seat = await seatForUser(ws, userId);
    if (enabled && seat) seat = await refreshSeatHealth(seat);
    return {
      enabled,
      connected: Boolean(enabled && seat && seat.status === "ok"),
      needsReconnect: Boolean(enabled && seat && seat.status === "reconnect"),
      label: seat?.label || "",
      connectedAt: seat?.connectedAt,
    };
  }));
}

export async function POST(req: Request) {
  const g = requireCapability(req, "sourcing:run");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const userId = g.ctx.user.id;
  const b = await body<any>(req);
  const action = b?.action ?? "start";

  try {
    if (action === "start") {
      return await withWorkspaceCreds(ws, async () => {
        if (!providerReady()) {
          return fail("linkedin_connect_unavailable", 409, {
            detail: "LinkedIn connections are not switched on for this workspace yet. An admin can enable them under Connected, LinkedIn Automation; the Connect button then works for every recruiter.",
          });
        }
        const seat = await seatForUser(ws, userId);
        const mode: "create" | "reconnect" = seat ? "reconnect" : "create";
        const token = await beginConnect(ws, userId, mode);
        const brand = await notifyBrand(ws);
        const base = (brand.appUrl || "https://recruitersos.co").replace(/\/+$/, "");
        const payload: Record<string, unknown> = {
          type: mode === "reconnect" ? "reconnect" : "create",
          providers: ["LINKEDIN"],
          api_url: `https://${cred("UNIPILE_DSN")}`,
          expiresOn: new Date(Date.now() + LINK_TTL_MS).toISOString(),
          // The single-use correlation token: the notify callback redeems it to
          // bind the new account to exactly the recruiter who clicked Connect.
          name: token,
          notify_url: `${base}/api/linkedin/connect/notify`,
          success_redirect_url: `${base}/command?linkedin=connected#jdsourcing`,
          failure_redirect_url: `${base}/command?linkedin=failed#jdsourcing`,
        };
        if (mode === "reconnect") payload.reconnect_account = seat!.accountId;
        // LinkedIn Recruiter allows only ONE active session, so a hosted seat
        // that also holds a Recruiter session keeps booting the recruiter out
        // of Recruiter itself (LinkedIn's "multiple sign-ins" screen), and the
        // provider's automatic re-login then boots them again. Nothing in
        // RecruitersOS calls Recruiter APIs, so fresh connections never take
        // that session. Create-mode only: reconnect keeps existing settings,
        // and the hosted link API rejects the flag there.
        if (mode === "create") payload.disabled_features = ["linkedin_recruiter"];

        try {
          const out = await unipileRequest<{ url?: string }>("/hosted/accounts/link", {
            method: "POST",
            body: JSON.stringify(payload),
          });
          if (!out?.url) throw new Error("no_hosted_url");
          return ok({ url: out.url, mode });
        } catch (err) {
          // A reconnect against an account the provider no longer knows about
          // degrades to a fresh connect instead of a dead end.
          if (mode === "reconnect" && err instanceof UnipileError && (err.status === 404 || err.status === 422)) {
            const freshToken = await beginConnect(ws, userId, "create");
            const retry = { ...payload, type: "create", name: freshToken };
            delete (retry as any).reconnect_account;
            (retry as any).disabled_features = ["linkedin_recruiter"];
            const out = await unipileRequest<{ url?: string }>("/hosted/accounts/link", {
              method: "POST",
              body: JSON.stringify(retry),
            });
            if (!out?.url) throw new Error("no_hosted_url");
            return ok({ url: out.url, mode: "create" });
          }
          throw err;
        }
      });
    }

    if (action === "disconnect") {
      const seat = await removeSeat(ws, userId);
      if (seat) {
        // Best-effort: also drop the provider-side account so the recruiter's
        // LinkedIn session doesn't linger connected to infrastructure they
        // just asked to be disconnected from.
        await withWorkspaceCreds(ws, async () => {
          if (!providerReady()) return;
          try {
            await unipileRequest(`/accounts/${encodeURIComponent(seat.accountId)}`, { method: "DELETE" });
          } catch { /* already gone / provider down: local unbind is what matters */ }
        });
      }
      return ok({ disconnected: Boolean(seat) });
    }

    return fail("unknown_action", 400, { detail: String(action) });
  } catch (err) {
    console.error("[linkedin:connect]", (err as Error).message);
    // The provider rejecting our key (401/403) is a workspace-config problem, not
    // a blip: retrying can never succeed, so say what actually unblocks it.
    if (err instanceof UnipileError && (err.status === 401 || err.status === 403)) {
      return fail("linkedin_connect_auth", 502, {
        detail: "The LinkedIn connection service rejected this workspace's access key. Nothing changed on your end; an admin needs to re-save the LinkedIn Automation key under Connected, then you can connect normally.",
      });
    }
    return fail("linkedin_connect_failed", 502, {
      detail: "Could not reach the LinkedIn connection service. Nothing changed; try again in a minute.",
    });
  }
}
