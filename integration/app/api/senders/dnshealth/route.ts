/**
 * GET /api/senders/dnshealth -> live DNS posture (MX/SPF/DKIM/DMARC) for every
 * sending domain in THIS portal's Zapmail account.
 *
 * Freshness without a cron dependency: the sweep result is persisted per
 * workspace and served instantly. If the snapshot is older than STALE_MS the
 * route kicks a background refresh (fire-and-forget) and still returns the
 * current data, so opening the Senders tab keeps it self-healing on ~hourly
 * cadence. The automation scheduler runs the same sweep on a timer for boxes
 * where nobody is looking. ?refresh=1 forces a synchronous re-check.
 *
 * Tenant-scoped: the workspace id comes from the session (host-resolved), so a
 * portal only ever sees its own account's domains. Read-only — no secrets.
 */
import { requireSession, ok } from "../../../../lib/api";
import { zapmailConfigured, getDnsHealth, refreshDnsHealth, snapshotAgeMs } from "../../../../lib/senders/dnsHealth";

export const dynamic = "force-dynamic";

const STALE_MS = 55 * 60 * 1000;      // refresh when older than ~an hour
const FIRST_POPULATE_TIMEBOX_MS = 12_000; // don't hang the first-ever request

function timebox<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;

  if (!zapmailConfigured()) {
    return ok({ configured: false, checkedAt: null, stale: false, totals: null, domains: [], incomplete: [] });
  }

  const workspaceId = g.ctx.workspace.id;
  const force = new URL(req.url).searchParams.get("refresh") === "1";

  let snap = await getDnsHealth(workspaceId);

  if (force) {
    snap = (await refreshDnsHealth(workspaceId)) || snap;
  } else if (!snap) {
    // First ever view: try to populate within a timebox; if it runs long the
    // background sweep keeps going (inflight-guarded) and the next poll gets it.
    snap = await timebox(refreshDnsHealth(workspaceId), FIRST_POPULATE_TIMEBOX_MS, null);
  } else if (snapshotAgeMs(snap) > STALE_MS) {
    // Serve the stale snapshot now, refresh in the background for next time.
    void refreshDnsHealth(workspaceId);
  }

  if (!snap) {
    return ok({ configured: true, pending: true, checkedAt: null, stale: true, totals: null, domains: [], incomplete: [] });
  }

  return ok({
    configured: true,
    pending: false,
    checkedAt: snap.checkedAt,
    stale: snapshotAgeMs(snap) > STALE_MS,
    ageMinutes: Math.round(snapshotAgeMs(snap) / 60000),
    totals: snap.totals,
    domains: snap.domains,
    incomplete: snap.incomplete,
  });
}
