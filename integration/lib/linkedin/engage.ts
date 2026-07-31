/**
 * RecruitersOS · LinkedIn BD Engagement Assist
 *
 * The execution layer behind the daily outreach tasks: every day, for the BD
 * addressable market ALREADY being emailed (the correlation rule: LinkedIn
 * touches only land on people the email engine has touched, so the two
 * channels reinforce each other), build a queue of
 *
 *   - comment drafts on the prospect's most recent LinkedIn post, and
 *   - connection-note / message drafts,
 *
 * written by the LLM in a deliberately human voice. NOTHING sends on its own:
 * every item waits for one-tap approval in the LinkedIn tab, and an approved
 * item goes through requestLinkedInAction (the shared engine), so account
 * caps, health, suppression and the ledger all apply. Executed actions then
 * auto-complete the Daily Ops counters.
 *
 * STANDBY BY DESIGN: the assist arms itself only when (a) email sending is
 * live in the workspace (a first email went out in the last 7 days) and (b) a
 * LinkedIn account is connected to the engine. Until both are true the queue
 * does not build and the UI shows why.
 */

import { loadSnapshot, debouncedSaver } from "../db";
import { nowIso, rid } from "../core/ids";
import { getCore } from "../core/repository";
import { workspaceTz } from "../outbound/rollup";
import { localDay } from "../outbound/goals";
import { checkContactable } from "../outreach/contactGuard";
import { requestLinkedInAction } from "./os/engine";
import { resolveIdentity } from "./os/identity";
import { listAccounts } from "./os/health";
import type { Prospect } from "../core/types";
import type { LiAccountState } from "./os/types";

const COMMENT_TARGET = 10;
const TOUCH_TARGET = 10;
const SCAN_CAP = 400;          // prospects examined per build
const POSTS_PER_PERSON = 3;    // recent posts fetched per comment candidate
const EMAIL_LIVE_WINDOW_MS = 7 * 86_400_000;

export interface EngageItem {
  id: string;
  workspaceId: string;
  day: string;
  kind: "comment" | "touch";
  prospectId: string;
  fullName: string;
  company?: string;
  title?: string;
  linkedinUrl?: string;
  /** comment items: the target post (id/url as the provider returns it) + what it said. */
  postUrl?: string;
  postExcerpt?: string;
  touchType?: "connect_note" | "message";
  text: string;
  status: "suggested" | "approved" | "skipped" | "blocked";
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EngageStatus {
  active: boolean;
  emailLive: boolean;
  engineReady: boolean;
  aiReady: boolean;
  /** Plain-language blockers shown on the standby card. */
  reasons: string[];
}

interface EngageState {
  items: EngageItem[];
  /** ws -> last day a build ran (idempotence). */
  builtDay: Record<string, string>;
}
const KEY = "linkedin_engage_v1";
let state: EngageState = { items: [], builtDay: {} };
let hydrated = false;
let hydrating: Promise<void> | null = null;
const save = debouncedSaver(KEY, () => state);

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<EngageState>(KEY);
      if (snap && Array.isArray(snap.items)) state = { items: snap.items, builtDay: snap.builtDay ?? {} };
      hydrated = true;
    })();
  }
  return hydrating;
}

function prune(day: string): void {
  // Keep today + yesterday only; the queue is a daily worksheet, not an archive.
  state.items = state.items.filter((i) => i.day >= dayBefore(day));
}
function dayBefore(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Readiness gate                                                       */
/* ------------------------------------------------------------------ */

async function connectedAccounts(workspaceId: string): Promise<LiAccountState[]> {
  try {
    const all = await listAccounts(workspaceId);
    return all.filter((a) => a.providerAccountId && a.connected !== false && !a.killSwitch);
  } catch { return []; }
}

export async function engageStatus(workspaceId: string): Promise<EngageStatus> {
  let emailLive = false;
  try {
    const core = getCore();
    const acts = await core.listAllActivity(workspaceId);
    const cutoff = Date.now() - EMAIL_LIVE_WINDOW_MS;
    emailLive = acts.some((a) => a.type === "email_sent" && new Date(a.at).getTime() >= cutoff);
  } catch { /* store unavailable counts as not live */ }
  const engineReady = (await connectedAccounts(workspaceId)).length > 0;
  const aiReady = !!process.env.ANTHROPIC_API_KEY;
  const reasons: string[] = [];
  if (!emailLive) reasons.push("Email sending is not live yet. The queue arms itself once first emails are going out, so LinkedIn touches land on people your emails already reached.");
  if (!engineReady) reasons.push("No LinkedIn account is connected to the engine yet.");
  if (!aiReady) reasons.push("The AI drafting key is not configured on the server.");
  return { active: emailLive && engineReady && aiReady, emailLive, engineReady, aiReady, reasons };
}

/* ------------------------------------------------------------------ */
/* LLM drafting                                                         */
/* ------------------------------------------------------------------ */

const MODEL = () =>
  process.env.RECRUITEROS_ENGAGE_MODEL ?? process.env.RECRUITEROS_LLM_MODEL ?? "claude-opus-4-8";

/** House style: no long dashes, no smart quotes, no leftover code fences. */
function scrub(text: string): string {
  return text
    .replace(/[\u2014\u2013]/g, ",")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/^```[a-z]*\n?|```$/gm, "")
    .trim();
}

const COMMENT_RULES = `You write LinkedIn comments for a recruiting agency owner doing business development. The reader must never suspect a machine wrote it.
Rules:
- React to ONE specific point in the post. Never summarize the whole post back.
- Add something: a concrete observation from recruiting/staffing experience, a short counterpoint, or a sharp question. No praise sandwiches.
- 15 to 40 words. One or two sentences. Lowercase-normal punctuation, no exclamation marks, no emoji, no hashtags, no long dashes.
- Banned openers: "Great post", "Love this", "So true", "This resonates", "Couldn't agree more", "Spot on".
- Banned words: "insightful", "resonate", "game-changer", "leverage", "delve", "align".
- Never mention AI, never pitch, never link.
Return ONLY the comment text, nothing else.`;

const TOUCH_RULES = `You write short LinkedIn connection notes for a recruiting agency owner doing business development. The reader must never suspect a machine wrote it.
Rules:
- Max 270 characters. Two sentences at most.
- Reference who they are (role/company) in a natural way; no flattery, no "I came across your profile".
- No pitch, no links, no "synergies", no emoji, no long dashes. A soft reason to connect (same market, their company is hiring, shared audience) is enough.
- Never mention AI and never mention email outreach.
Return ONLY the note text, nothing else.`;

async function draft(system: string, user: string): Promise<string | null> {
  try {
    const { anthropicClient } = await import("../sourcing/anthropic");
    const res = await anthropicClient().messages.create({
      model: MODEL(),
      max_tokens: 300,
      system,
      messages: [{ role: "user", content: user }],
    });
    const block = res.content.find((b: { type: string }) => b.type === "text") as { text?: string } | undefined;
    const text = scrub(String(block?.text ?? ""));
    return text.length >= 8 ? text : null;
  } catch { return null; }
}

/* ------------------------------------------------------------------ */
/* Post discovery                                                       */
/* ------------------------------------------------------------------ */

/** Best-effort: the prospect's most recent original post via the provider. */
async function recentPost(account: LiAccountState, workspaceId: string, p: Prospect): Promise<{ postUrl: string; excerpt: string } | null> {
  try {
    const identity = await resolveIdentity(workspaceId, {
      linkedinUrl: p.linkedinUrl, email: p.email, fullName: `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || undefined,
      company: p.company, title: p.title, prospectId: p.id,
    });
    const pid = identity.providerIds.classic ?? identity.providerIds.salesNavigator ?? identity.providerIds.recruiter;
    if (!pid || !account.providerAccountId) return null;
    const { unipile } = await import("../providers");
    const raw: unknown = await unipile.listPosts(account.providerAccountId, pid, POSTS_PER_PERSON);
    const anyRaw = raw as { items?: unknown[]; data?: unknown[]; dryRun?: boolean } | unknown[] | null;
    if (!anyRaw || (typeof anyRaw === "object" && !Array.isArray(anyRaw) && anyRaw.dryRun)) return null;
    const list: unknown[] = Array.isArray(anyRaw) ? anyRaw : (anyRaw.items ?? anyRaw.data ?? []);
    for (const entry of list) {
      const post = entry as Record<string, unknown>;
      const id = post.social_id ?? post.share_url ?? post.url ?? post.id ?? post.post_id;
      const text = String(post.text ?? post.commentary ?? post.content ?? "").trim();
      if (id && text.length >= 40) return { postUrl: String(id), excerpt: text.slice(0, 700) };
    }
    return null;
  } catch { return null; }
}

/* ------------------------------------------------------------------ */
/* Queue building                                                       */
/* ------------------------------------------------------------------ */

export async function buildEngageQueue(workspaceId: string): Promise<{ built: number; skipped: string | null }> {
  await hydrate();
  const status = await engageStatus(workspaceId);
  if (!status.active) return { built: 0, skipped: "standby" };
  const day = localDay(await workspaceTz(workspaceId));
  if (state.builtDay[workspaceId] === day) return { built: 0, skipped: "already_built" };
  state.builtDay[workspaceId] = day;
  prune(day);
  save();

  const accounts = await connectedAccounts(workspaceId);
  const account = accounts[0];
  const core = getCore();
  const prospects = (await core.listProspects(workspaceId))
    .filter((p) => p.motion === "bd" && p.linkedinUrl)
    .slice(0, SCAN_CAP);

  const taken = new Set(state.items.filter((i) => i.day === day && i.workspaceId === workspaceId).map((i) => i.prospectId));
  let comments = state.items.filter((i) => i.day === day && i.workspaceId === workspaceId && i.kind === "comment").length;
  let touches = state.items.filter((i) => i.day === day && i.workspaceId === workspaceId && i.kind === "touch").length;
  let built = 0;

  for (const p of prospects) {
    if (comments >= COMMENT_TARGET && touches >= TOUCH_TARGET) break;
    if (taken.has(p.id)) continue;

    // Correlation rule: only people the email engine has already touched.
    let emailed = false;
    try { emailed = (await core.listActivity(p.id)).some((a) => a.type === "email_sent"); } catch { /* skip on error */ }
    if (!emailed) continue;

    const who = { email: p.email, linkedinUrl: p.linkedinUrl, fullName: `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim(), company: p.company };
    const fullName = who.fullName || p.email || "this prospect";
    const persona = `${fullName}${p.title ? `, ${p.title}` : ""}${p.company ? ` at ${p.company}` : ""}`;

    // Never comment on or touch anyone on the do-not-contact list; direct
    // touches additionally respect the cross-channel recency cooldown.
    const dnc = await checkContactable(workspaceId, who, { checkRecency: false });
    if (!dnc.ok) continue;

    // Prefer a comment when they have a fresh post; fall back to a touch.
    if (comments < COMMENT_TARGET && account) {
      const post = await recentPost(account, workspaceId, p);
      if (post) {
        const text = await draft(COMMENT_RULES, `The post below was written by ${persona}. Write the comment.\n\nPOST:\n${post.excerpt}`);
        if (text) {
          state.items.push({
            id: rid("eng"), workspaceId, day, kind: "comment", prospectId: p.id,
            fullName, company: p.company, title: p.title, linkedinUrl: p.linkedinUrl,
            postUrl: post.postUrl, postExcerpt: post.excerpt, text,
            status: "suggested", createdAt: nowIso(), updatedAt: nowIso(),
          });
          taken.add(p.id); comments++; built++; save();
          continue;
        }
      }
    }

    if (touches < TOUCH_TARGET) {
      const cooldown = await checkContactable(workspaceId, who, { checkRecency: true });
      if (!cooldown.ok) continue;
      const text = await draft(TOUCH_RULES, `Write a connection note to ${persona}.`);
      if (text) {
        state.items.push({
          id: rid("eng"), workspaceId, day, kind: "touch", prospectId: p.id,
          fullName, company: p.company, title: p.title, linkedinUrl: p.linkedinUrl,
          touchType: "connect_note", text,
          status: "suggested", createdAt: nowIso(), updatedAt: nowIso(),
        });
        taken.add(p.id); touches++; built++; save();
      }
    }
  }

  save();
  return { built, skipped: null };
}

/* ------------------------------------------------------------------ */
/* Reads + actions                                                      */
/* ------------------------------------------------------------------ */

export interface EngageView {
  day: string;
  status: EngageStatus;
  items: EngageItem[];
}

export async function engageView(workspaceId: string): Promise<EngageView> {
  await hydrate();
  const status = await engageStatus(workspaceId);
  const day = localDay(await workspaceTz(workspaceId));
  // Lazy build: first viewer of the day builds the queue (the scheduler tick
  // usually got there first; both paths are idempotent per day).
  if (status.active && state.builtDay[workspaceId] !== day) {
    try { await buildEngageQueue(workspaceId); } catch { /* view still renders */ }
  }
  const items = state.items
    .filter((i) => i.workspaceId === workspaceId && i.day === day)
    .sort((a, b) => (a.kind === b.kind ? a.createdAt.localeCompare(b.createdAt) : a.kind === "comment" ? -1 : 1));
  return { day, status, items };
}

function findItem(workspaceId: string, id: string): EngageItem | undefined {
  return state.items.find((i) => i.workspaceId === workspaceId && i.id === id);
}

export async function editEngageItem(workspaceId: string, id: string, text: string): Promise<EngageItem | null> {
  await hydrate();
  const item = findItem(workspaceId, id);
  if (!item || item.status !== "suggested") return null;
  item.text = scrub(text).slice(0, 1200);
  item.updatedAt = nowIso();
  save();
  return item;
}

export async function skipEngageItem(workspaceId: string, id: string): Promise<EngageItem | null> {
  await hydrate();
  const item = findItem(workspaceId, id);
  if (!item || item.status !== "suggested") return null;
  item.status = "skipped";
  item.updatedAt = nowIso();
  save();
  return item;
}

/** Approve: hand the item to the shared engine. Caps/health/suppression apply there. */
export async function approveEngageItem(
  workspaceId: string, userId: string, userEmail: string, id: string, editedText?: string,
): Promise<{ item: EngageItem | null; accepted: boolean; reason?: string }> {
  await hydrate();
  const item = findItem(workspaceId, id);
  if (!item || item.status !== "suggested") return { item: item ?? null, accepted: false, reason: "not_open" };
  if (editedText && scrub(editedText).length >= 2) item.text = scrub(editedText).slice(0, 1200);

  const accounts = await connectedAccounts(workspaceId);
  const account = accounts.find((a) => a.ownerUserId === userId) ?? accounts.find((a) => !a.ownerUserId) ?? accounts[0];
  if (!account) {
    item.status = "blocked"; item.reason = "No connected LinkedIn account."; item.updatedAt = nowIso(); save();
    return { item, accepted: false, reason: item.reason };
  }

  try {
    const result = await requestLinkedInAction({
      workspaceId,
      accountId: account.accountId,
      person: {
        linkedinUrl: item.linkedinUrl, fullName: item.fullName,
        company: item.company, title: item.title, prospectId: item.prospectId,
      },
      actionType: item.kind === "comment" ? "comment_post" : (item.touchType ?? "connect_note"),
      payload: item.kind === "comment"
        ? { postUrl: item.postUrl, text: item.text }
        : item.touchType === "message" ? { text: item.text } : { note: item.text },
      businessUnit: "bd",
      sourceType: "manual",
      approvedBy: userEmail,
      idempotencyKey: `engage_${item.id}`,
    });
    if (result.accepted) {
      item.status = "approved"; item.reason = undefined;
    } else {
      item.status = "blocked"; item.reason = result.reason || "The engine declined this action.";
    }
    item.updatedAt = nowIso(); save();
    return { item, accepted: result.accepted, reason: result.reason };
  } catch (e) {
    item.status = "blocked"; item.reason = e instanceof Error ? e.message : "engine_error";
    item.updatedAt = nowIso(); save();
    return { item, accepted: false, reason: item.reason };
  }
}

/* ------------------------------------------------------------------ */
/* Scheduler tick                                                       */
/* ------------------------------------------------------------------ */

/** Build today's queue for every workspace with a connected LinkedIn seat. */
export async function tickEngageQueues(): Promise<void> {
  await hydrate();
  const { accounts } = await import("./os/store");
  const all = await accounts.all();
  const workspaces = [...new Set(all.filter((a) => a.providerAccountId && a.connected !== false).map((a) => a.workspaceId))];
  for (const ws of workspaces) {
    try { await buildEngageQueue(ws); } catch { /* next workspace */ }
  }
}
