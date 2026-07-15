/**
 * RecruitersOS · API · /api/outbound/export
 *
 * CSV report downloads (CSV opens natively in Excel). Admin-only.
 *   ?report=team | channels | history | user&user=<id>  [&since=<days>]
 */

import { fail, requireCapability } from "../../../../lib/api";
import { teamCsv, userCsv, channelsCsv, historyCsv } from "../../../../lib/outbound/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const g = requireCapability(req, "team:manage");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const url = new URL(req.url);
  const report = url.searchParams.get("report") || "team";
  const since = Number(url.searchParams.get("since")) || undefined;

  try {
    let csv = "";
    let name = "outbound-team";
    if (report === "team") csv = await teamCsv(ws);
    else if (report === "channels") { csv = await channelsCsv(ws); name = "outbound-channels"; }
    else if (report === "history") { csv = await historyCsv(ws, since ?? 90); name = "outbound-history"; }
    else if (report === "user") {
      const user = url.searchParams.get("user") || "";
      if (!user) return fail("missing_user", 400);
      csv = await userCsv(ws, user, since ?? 30);
      name = "outbound-user";
    } else return fail("unknown_report", 400);

    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : "export_failed", 500);
  }
}
