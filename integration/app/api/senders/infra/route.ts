/**
 * GET  /api/senders/infra -> live SMTP infrastructure health for THIS portal.
 *        Servers (every distinct smtpHost:port in the pool + env watch-hosts)
 *        with reachability probes, per-server inbox rollups, auth-sweep state,
 *        and the owned mail server's inventory when its API is configured.
 *        Each GET also advances the background auth sweep a few logins, so the
 *        pool re-proves itself continuously just by the panel being open.
 * POST /api/senders/infra { action: "sweep" } -> bigger on-demand sweep now
 *        (team:manage), for the "Test logins now" button.
 *
 * Tenant-split like /api/senders/warmup: watch-hosts carry a portal token so a
 * tenant's mail server only ever shows on that tenant's portal.
 */
import { requireSession, requireCapability, body, ok } from "../../../../lib/api";
import { smtpServerFleet, sweepSmtpAuth, mailcowConfigured, mailcowSummary, serverDailyCapacity, WARMED_PER_MAILBOX_PER_DAY } from "../../../../lib/senders/infra";
import { requestHost, tenantWorkspaceForHost } from "../../../../lib/branding/portal";
import { presetForHost } from "../../../../lib/branding/presets";

export const dynamic = "force-dynamic";

function portalToken(req: Request): string {
  const host = requestHost(req);
  if (!tenantWorkspaceForHost(host)) return "house";
  const brand = presetForHost(host)?.brandName || "";
  return (brand.split(/\s+/)[0] || "tenant").toLowerCase();
}

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const token = portalToken(req);

  const [servers, sweep] = await Promise.all([
    smtpServerFleet(ws, token),
    sweepSmtpAuth(ws, 8),
  ]);

  // The owned mail server inventory belongs to ONE portal (default the Lume
  // white-label, override with MAILCOW_PORTAL=house etc.).
  const mailcowPortal = (process.env.MAILCOW_PORTAL || "lume").toLowerCase();
  const mailcow = token === mailcowPortal && mailcowConfigured() ? await mailcowSummary() : null;

  // Fill in the owned mail server's fully-ramped daily send capacity from its
  // live inventory (mailboxes × per-mailbox ceiling), unless a dailyCap was
  // already pinned via SMTP_WATCH_HOSTS. Matches the Sending-infrastructure
  // "at full ramp" figure (75 mailboxes × 20/day = ~1,500/day on the Lume portal).
  if (mailcow && mailcow.mailboxes != null) {
    const mailcowHost = mailcow.baseUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
    for (const s of servers) {
      if (s.capacityPerDay == null && s.host.toLowerCase() === mailcowHost) {
        s.capacityPerDay = serverDailyCapacity(mailcow.mailboxes);
        s.capacityBasis = `${mailcow.mailboxes} warmed mailboxes × ~${WARMED_PER_MAILBOX_PER_DAY}/day`;
      }
    }
  }

  return ok({ servers, sweep, mailcow, updatedAt: new Date().toISOString() });
}

export async function POST(req: Request) {
  const g = requireCapability(req, "team:manage");
  if ("response" in g) return g.response;
  const b = await body<{ action?: string }>(req);
  if (b?.action !== "sweep") return ok({ error: "unknown_action" }, 422);
  const report = await sweepSmtpAuth(g.ctx.workspace.id, 30);
  return ok({ sweep: report });
}
