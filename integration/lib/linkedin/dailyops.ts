/**
 * RecruitersOS · LinkedIn Daily Ops
 *
 * The daily non-negotiables behind the LinkedIn content engine: every day the
 * two LinkedIn tabs (#linkedin outreach, #linkedinposter content) carry a short
 * task list that must reach zero. Tasks auto-complete from live engine signals
 * (poster publishes, action ledger, inbox state) and can also be ticked by hand
 * for work done natively on LinkedIn; open tasks light up the nav tabs until
 * they are done.
 *
 * Model (research-backed defaults from the 2026 content plan):
 *  content  · publish today's post, keep the next post approved, work the
 *             nurture window right after publishing.
 *  outreach · 10 quality comments on the addressable market, hit the daily
 *             touch target (invites + messages), clear the LinkedIn inbox.
 */

import { loadSnapshot, debouncedSaver } from "../db";
import { workspaceTz } from "../outbound/rollup";
import { localDay } from "../outbound/goals";
import { getState as posterGetState } from "./poster";
import { listLedger } from "./os/ledger";
import { USED_STATUSES } from "./os/types";
import { accounts, conversations } from "./os/store";

export interface LiOpsTask {
  id: string;
  group: "content" | "outreach";
  title: string;
  /** What to do when the task is open; short confirmation when it is not. */
  action: string;
  target: string;
  current: string;
  /** Auto signal from the engine; done = met || manually ticked. */
  met: boolean;
  done: boolean;
  link?: string;
  order: number;
}

export interface LiOpsDay {
  day: string;
  tasks: LiOpsTask[];
  openContent: number;
  openOutreach: number;
  completed: number;
  total: number;
}

interface OpsState {
  /** `${ws}|${userId}|${day}` -> manually ticked task ids */
  ticks: Record<string, string[]>;
}
const KEY = "linkedin_dailyops_v1";
let state: OpsState = { ticks: {} };
let hydrated = false;
let hydrating: Promise<void> | null = null;
const save = debouncedSaver(KEY, () => state);

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<OpsState>(KEY);
      if (snap && snap.ticks) state = snap;
      hydrated = true;
    })();
  }
  return hydrating;
}

export async function setOpsTick(workspaceId: string, userId: string, day: string, taskId: string, done: boolean): Promise<void> {
  await hydrate();
  const k = `${workspaceId}|${userId}|${day}`;
  const list = new Set(state.ticks[k] ?? []);
  if (done) list.add(taskId); else list.delete(taskId);
  state.ticks[k] = [...list];
  // Prune old days.
  const cutoff = localDay("UTC", new Date(Date.now() - 8 * 86_400_000));
  for (const key of Object.keys(state.ticks)) {
    const d = key.split("|")[2];
    if (d && d < cutoff) delete state.ticks[key];
  }
  save();
}

/** Accounts this user works: unowned seats count for everyone (matches capacity.ts). */
async function userAccountIds(workspaceId: string, userId: string): Promise<Set<string>> {
  const all = await accounts.all();
  return new Set(
    all
      .filter((a) => a.workspaceId === workspaceId && (!a.ownerUserId || a.ownerUserId === userId))
      .map((a) => a.accountId),
  );
}

export async function buildDailyOps(workspaceId: string, userId: string, authRole = "member"): Promise<LiOpsDay> {
  void authRole; // accepted for parity with the other worksheet builders; targets are role-independent today
  await hydrate();
  const tz = await workspaceTz(workspaceId);
  const day = localDay(tz);
  const ticks = new Set(state.ticks[`${workspaceId}|${userId}|${day}`] ?? []);

  const tasks: LiOpsTask[] = [];
  let order = 0;
  const add = (t: Omit<LiOpsTask, "order" | "done">) => {
    tasks.push({ ...t, order: ++order, done: t.met || ticks.has(t.id) });
  };

  /* ---------------- content signals (poster store) ---------------- */
  let postedToday = 0;
  let approvedReady = 0;
  let openDrafts = 0;
  try {
    const ps = await posterGetState(workspaceId);
    for (const d of ps.drafts) {
      if (d.status === "posted" && (d.postedAt || "").slice(0, 10) === day) postedToday++;
      if (d.status === "approved") approvedReady++;
      if (d.status === "draft") openDrafts++;
    }
  } catch { /* poster store unavailable: tasks still render as manual */ }

  add({
    id: "post_publish",
    group: "content",
    title: "Publish today's post",
    target: "1 post live",
    current: postedToday ? `${postedToday} published today` : "Nothing published yet",
    action: postedToday
      ? "Done. Consistency is the whole edge; under 2% of the market posts weekly."
      : openDrafts + approvedReady
        ? "Approve the next draft in the queue and publish it."
        : "Write or rewrite one from the inspiration inbox, approve it, publish.",
    met: postedToday >= 1,
    link: "#linkedinposter",
  });

  add({
    id: "post_queue",
    group: "content",
    title: "Keep the next post ready",
    target: "1 approved in queue",
    current: `${approvedReady} approved, ${openDrafts} draft${openDrafts === 1 ? "" : "s"} waiting`,
    action: approvedReady
      ? "Tomorrow is covered."
      : "Approve or schedule the next post so tomorrow never starts from zero.",
    met: approvedReady >= 1,
    link: "#linkedinposter",
  });

  if (postedToday >= 1) {
    add({
      id: "post_nurture",
      group: "content",
      title: "Work the nurture window",
      target: "Every comment answered",
      current: "Manual step after each post",
      action: "Reply to every comment in the first 30 minutes after posting; early conversation decides reach.",
      met: false,
      link: "#linkedinposter",
    });
  }

  /* ---------------- outreach signals (LinkedIn OS) ---------------- */
  const accIds = await userAccountIds(workspaceId, userId);
  let commentsToday = 0;
  let touchesToday = 0;
  let waiting = 0;
  try {
    const ledger = await listLedger(workspaceId);
    for (const r of ledger) {
      if (!accIds.has(r.accountId)) continue;
      if (!USED_STATUSES.includes(r.status)) continue;
      const onDay = r.capacityDay === day || (r.completedAt || "").slice(0, 10) === day;
      if (!onDay) continue;
      if (r.actionType === "comment_post") commentsToday++;
      if (r.actionType === "connect" || r.actionType === "connect_note" || r.actionType === "message" || r.actionType === "inmail" || r.actionType === "voice_note") touchesToday++;
    }
    const convos = await conversations.all();
    waiting = convos.filter((c) => c.workspaceId === workspaceId && accIds.has(c.accountId) && (c.unread || c.needsAttention)).length;
  } catch { /* engine store unavailable: tasks still render as manual */ }

  add({
    id: "li_comments",
    group: "outreach",
    title: "Comment on 10 target-market posts",
    target: "10 comments",
    current: `${commentsToday} tracked today`,
    action: commentsToday >= 10
      ? "Comment target met."
      : "Spend 15 minutes leaving real comments on posts from your addressable market (owners, TA leaders, hiring managers). Comments made directly on LinkedIn count too; tick this off when you have done 10.",
    met: commentsToday >= 10,
    link: "#linkedin",
  });

  add({
    id: "li_touches",
    group: "outreach",
    title: "Hit today's outreach touches",
    target: "10 touches",
    current: `${touchesToday} sent today`,
    action: touchesToday >= 10
      ? "Touch target met."
      : "Send connection requests and messages to your addressable market from the LinkedIn tool, or tick this off for touches made directly on LinkedIn.",
    met: touchesToday >= 10,
    link: "#linkedin",
  });

  add({
    id: "li_inbox",
    group: "outreach",
    title: "Clear the LinkedIn inbox",
    target: "0 waiting",
    current: `${waiting} conversation${waiting === 1 ? "" : "s"} waiting`,
    action: waiting
      ? "Answer every waiting conversation. Replies beat new outreach."
      : "Inbox clear.",
    met: waiting === 0,
    link: "#linkedin",
  });

  const openContent = tasks.filter((t) => t.group === "content" && !t.done).length;
  const openOutreach = tasks.filter((t) => t.group === "outreach" && !t.done).length;
  return {
    day,
    tasks,
    openContent,
    openOutreach,
    completed: tasks.filter((t) => t.done).length,
    total: tasks.length,
  };
}
