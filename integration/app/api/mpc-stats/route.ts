/**
 * GET /api/mpc-stats  (session, tenant-scoped)
 *
 * The BD cockpit's finance-engine feed. Reads the single stats snapshot the MPC tools write
 * (snap_mpc_stats_v1.json) so the Dashboard can show real activity that runs outside the app's
 * native pipeline: sends, reply rate by variant (what's working), replies by sentiment, clean
 * supply ready, and free ATS boards. Returns { present:false } when there's nothing for this
 * workspace, so the card hides cleanly instead of showing zeros.
 *
 * BD vs Recruiting: the snapshot's `motions` field splits the MPC ledger by the motion stamped
 * on each send row. This route then folds the PORTAL-native sends (job blasts, campaign
 * cadences — recorded as `email_sent` ActivityEvents with the prospect's motion) into the same
 * two slices, so each Dashboard tab shows its own side's sends, replies, and per-recruiter
 * attribution even though both sides ride one mailbox fleet.
 */

import { requireSession, ok } from "../../../lib/api";
import { loadSnapshot } from "../../../lib/db";
import { getCore } from "../../../lib/core/repository";
import { recentResponses } from "../../../lib/response";
import { listMembers } from "../../../lib/auth/team";
import { today } from "../../../lib/core/ids";

interface RecruiterRow { name: string; sentToday: number; sentTotal: number; replies: number; replyRate: number }
interface MotionSlice {
  sentToday: number; sentTotal: number; repliesTotal: number; replyRate: number;
  repliesBySentiment: Record<string, number>;
  variants: Array<{ variant: string; sent: number; replied: number; rate: number }>;
  recruiters: RecruiterRow[];
}

const emptySlice = (): MotionSlice => ({
  sentToday: 0, sentTotal: 0, repliesTotal: 0, replyRate: 0,
  repliesBySentiment: {}, variants: [], recruiters: [],
});

/** The portal pipeline's own email sends + replies, split by prospect motion. */
async function appSlices(workspaceId: string): Promise<{ bd: MotionSlice; recruiting: MotionSlice }> {
  const core = getCore();
  const [acts, prospects, responses] = await Promise.all([
    core.listAllActivity(workspaceId),
    core.listProspects(workspaceId),
    recentResponses(workspaceId, 5000),
  ]);
  const members = listMembers(workspaceId);
  const nameOf = new Map(members.map((m) => [m.userId, m.name]));
  const byId = new Map(prospects.map((p) => [p.id, p]));
  const t = today();
  const out = { bd: emptySlice(), recruiting: emptySlice() };
  const recRows: Record<string, Map<string, RecruiterRow>> = { bd: new Map(), recruiting: new Map() };
  const recFor = (motion: "bd" | "recruiting", name: string) => {
    const m = recRows[motion];
    const row = m.get(name) ?? { name, sentToday: 0, sentTotal: 0, replies: 0, replyRate: 0 };
    m.set(name, row);
    return row;
  };
  const motionFor = (prospectId: string | null | undefined): "bd" | "recruiting" | null => {
    const p = prospectId ? byId.get(prospectId) : undefined;
    if (!p) return null;
    return (p.motion ?? "recruiting") === "bd" ? "bd" : "recruiting";
  };
  for (const a of acts) {
    if (a.type !== "email_sent") continue;
    const motion = motionFor(a.prospectId);
    if (!motion) continue;
    const p = byId.get(a.prospectId)!;
    const slice = out[motion];
    slice.sentTotal++;
    if ((a.at || "").slice(0, 10) === t) slice.sentToday++;
    const rec = recFor(motion, (p.ownerId && nameOf.get(p.ownerId)) || "Unattributed");
    rec.sentTotal++;
    if ((a.at || "").slice(0, 10) === t) rec.sentToday++;
  }
  for (const r of responses) {
    if (r.inbound.channel !== "email") continue;
    // MPC-bridged replies are already counted in the ledger snapshot; skip them here
    // or the BD slice double-counts.
    if (/^mpc-/.test(String(r.inbound.campaignId || ""))) continue;
    const motion = motionFor(r.inbound.prospectId);
    if (!motion) continue;
    const p = byId.get(r.inbound.prospectId!)!;
    const slice = out[motion];
    slice.repliesTotal++;
    const cls = r.classification?.class || "unclassified";
    slice.repliesBySentiment[cls] = (slice.repliesBySentiment[cls] || 0) + 1;
    if (p.ownerId && nameOf.get(p.ownerId)) recFor(motion, nameOf.get(p.ownerId)!).replies++;
  }
  for (const motion of ["bd", "recruiting"] as const) {
    out[motion].recruiters = [...recRows[motion].values()];
    out[motion].replyRate = out[motion].sentTotal
      ? Math.round((out[motion].repliesTotal / out[motion].sentTotal) * 1000) / 10 : 0;
  }
  return out;
}

/** Sum two slices: scalars add, sentiment maps add, recruiter rows merge by name. */
function mergeSlices(a: MotionSlice, b: MotionSlice): MotionSlice {
  const bySent: Record<string, number> = { ...a.repliesBySentiment };
  for (const [k, v] of Object.entries(b.repliesBySentiment)) bySent[k] = (bySent[k] || 0) + v;
  const recs = new Map<string, RecruiterRow>();
  for (const r of [...a.recruiters, ...b.recruiters]) {
    const row = recs.get(r.name) ?? { name: r.name, sentToday: 0, sentTotal: 0, replies: 0, replyRate: 0 };
    row.sentToday += r.sentToday; row.sentTotal += r.sentTotal; row.replies += r.replies;
    recs.set(r.name, row);
  }
  const recruiters = [...recs.values()]
    .map((r) => ({ ...r, replyRate: r.sentTotal ? Math.round((r.replies / r.sentTotal) * 1000) / 10 : 0 }))
    .sort((x, y) => y.sentToday - x.sentToday || y.sentTotal - x.sentTotal);
  const sentTotal = a.sentTotal + b.sentTotal;
  const repliesTotal = a.repliesTotal + b.repliesTotal;
  return {
    sentToday: a.sentToday + b.sentToday, sentTotal, repliesTotal,
    replyRate: sentTotal ? Math.round((repliesTotal / sentTotal) * 1000) / 10 : 0,
    repliesBySentiment: bySent,
    variants: [...a.variants, ...b.variants].sort((x, y) => y.rate - x.rate || y.replied - x.replied),
    recruiters,
  };
}

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const s = await loadSnapshot<Record<string, unknown>>("mpc_stats_v1");
  if (!s || s.workspaceId !== g.ctx.workspace.id) return ok({ present: false });
  // The AI advisor's recommendations (written daily), if present for this workspace.
  const adv = await loadSnapshot<Record<string, unknown>>("mpc_advisor_v1");
  const advisor = adv && adv.workspaceId === g.ctx.workspace.id ? adv : null;
  // The Growth Engine's campaign proposals + growth gap (the push-more-outbound layer).
  const gr = await loadSnapshot<Record<string, unknown>>("growth_proposals_v1");
  const growth = gr && gr.workspaceId === g.ctx.workspace.id ? gr : null;
  // Real, documented deliverability (acceptance, hard-fail, bounce, complaint, warm-up reputation
  // per sending domain, plus 30-day history). Global sending infra; only the owning workspace
  // reaches this line (gated above), so it's safe to attach without a per-workspace tag.
  const dl = await loadSnapshot<Record<string, unknown>>("mpc_deliverability_v1");

  // BD/Recruiting split = the MPC ledger's own split (snapshot.motions; a snapshot written
  // before the split reads as all-BD) + the portal pipeline's activity on each side.
  const snapMotions = (s.motions as { bd?: MotionSlice; recruiting?: MotionSlice } | undefined) ?? {
    bd: {
      sentToday: (s.sentToday as number) || 0, sentTotal: (s.sentTotal as number) || 0,
      repliesTotal: (s.repliesTotal as number) || 0, replyRate: (s.replyRate as number) || 0,
      repliesBySentiment: (s.repliesBySentiment as Record<string, number>) || {},
      variants: (s.variants as MotionSlice["variants"]) || [],
      recruiters: (s.recruiters as RecruiterRow[]) || [],
    },
    recruiting: emptySlice(),
  };
  let motions = { bd: snapMotions.bd ?? emptySlice(), recruiting: snapMotions.recruiting ?? emptySlice() };
  try {
    const app = await appSlices(g.ctx.workspace.id);
    motions = { bd: mergeSlices(motions.bd, app.bd), recruiting: mergeSlices(motions.recruiting, app.recruiting) };
  } catch { /* best-effort: the ledger split still renders */ }

  return ok({ present: true, ...s, motions, advisor, growth, deliverability: dl || null });
}
