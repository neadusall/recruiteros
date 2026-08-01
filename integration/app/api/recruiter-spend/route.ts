/**
 * /api/recruiter-spend  (admin: team:manage)
 *
 * The per-recruiter spend roster for the account's own workspace. Distinct from
 * /api/portal-spend (the tool subscription + owner-pushed charges): this is what
 * each individual recruiter has run up in attributed usage cost, one row per
 * member. Powers the "Recruiters Spending" view in the account dropdown.
 *
 * Spend comes from the usage ledger grouped by the recruiter who triggered each
 * event (meta.userEmail/userId). Every current member is listed (even at $0), and
 * any attributed spend from someone no longer on the team is folded into a
 * trailing row so the rows always reconcile to the total.
 */

import { requireCapability, ok } from "../../../lib/api";
import { userSpendRollup, type SpendWindow } from "../../../lib/billing/ledger";
import { listMembers } from "../../../lib/auth/team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WINDOWS: SpendWindow[] = ["today", "7d", "30d", "all"];

export async function GET(req: Request): Promise<Response> {
  const g = requireCapability(req, "team:manage");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;

  const raw = new URL(req.url).searchParams.get("window") || "30d";
  const window: SpendWindow = WINDOWS.includes(raw as SpendWindow) ? (raw as SpendWindow) : "30d";

  const roll = userSpendRollup(ws, window);
  const spendByEmail = new Map(roll.rows.map((r) => [r.userEmail.toLowerCase(), r]));

  const members = listMembers(ws, g.ctx.user.id);
  const memberEmails = new Set(members.map((m) => (m.email || "").toLowerCase()));

  const rows = members.map((m) => {
    const s = spendByEmail.get((m.email || "").toLowerCase());
    return {
      userId: m.userId,
      name: m.name,
      email: m.email,
      role: String(m.role),
      isYou: !!m.isYou,
      costUsd: s ? s.costUsd : 0,
      events: s ? s.events : 0,
      quantity: s ? s.quantity : 0,
    };
  });

  // Attributed spend from people no longer on the team, plus a single bucket for
  // unattributed (shared/system) spend, so the rows reconcile to totalUsd.
  let orphanCost = 0;
  let orphanEvents = 0;
  for (const r of roll.rows) {
    const em = (r.userEmail || "").toLowerCase();
    if (em && memberEmails.has(em)) continue;
    if (em) {
      rows.push({
        userId: r.userId || "",
        name: r.userEmail,
        email: r.userEmail,
        role: "former",
        isYou: false,
        costUsd: r.costUsd,
        events: r.events,
        quantity: r.quantity,
      });
    } else {
      orphanCost = Math.round((orphanCost + r.costUsd) * 100) / 100;
      orphanEvents += r.events;
    }
  }
  if (orphanCost > 0) {
    rows.push({
      userId: "",
      name: "Unattributed / shared",
      email: "",
      role: "system",
      isYou: false,
      costUsd: orphanCost,
      events: orphanEvents,
      quantity: 0,
    });
  }

  rows.sort((a, b) => b.costUsd - a.costUsd);
  return ok({ rows, totalUsd: roll.totalUsd, window });
}
