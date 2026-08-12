/**
 * RecruitersOS · In-Market · who actually watched.
 *
 * Two jobs, both about telling a PERSON from a MACHINE:
 *
 * 1. classifyViewer() — email security gateways (Microsoft Defender Safe Links, Proofpoint,
 *    Barracuda, Mimecast) and preview bots fetch every link in a cold email within seconds of
 *    delivery. They load the watch page, fire the same beacon a prospect would, and never press
 *    play. Counted as viewers they inflate every rate on the dashboard and, worse, would trigger
 *    a LinkedIn connection request to someone who never saw the video. We judge on the
 *    user-agent plus a reverse-DNS lookup of the caller (keyless, cached), because scanner IPs
 *    resolve to their operator: *.outbound.protection.outlook.com, *.compute.amazonaws.com,
 *    *.pphosted.com and friends.
 *
 * 2. identifyViewer() — turn whatever the beacon carried into a real person. The link builders
 *    disagree about `rcpt` (the app writes a prospect id, the MPC video sender writes an email
 *    address), so we accept either. When a watch carries no rcpt at all, we fall back to the
 *    video itself: if a videoKey was only ever sent to one person, that watch is theirs.
 */

import type { Prospect } from "../core/types";

/* ------------------------------------------------------------------ */
/* 1. Machine or person                                                */
/* ------------------------------------------------------------------ */

/** Self-declared automation. Honest crawlers say so in the user-agent. */
const BOT_UA = /bot\b|crawler|crawl\b|spider|slurp|curl\/|wget|python-requests|httpx|go-http|java\/|okhttp|scrapy|headless|phantomjs|puppeteer|playwright|lighthouse|pingdom|uptime|monitor|probe|preview|facebookexternal|slackbot|twitterbot|linkedinbot|whatsapp|telegrambot|discordbot|skypeuripreview|bingpreview|google(-inspectiontool|other)|apis-google|duckduckbot|proofpoint|barracuda|mimecast|symantec|forcepoint|zscaler|netskope/i;

/** Hosts that scanners and cloud fetchers resolve to. A real prospect at their desk does not. */
const MACHINE_HOST = /(^|\.)(outbound\.protection\.outlook\.com|protection\.outlook\.com|mail\.protection\.outlook\.com|pphosted\.com|ppops\.net|proofpoint\.com|barracuda(networks)?\.com|mimecast\.com|messagelabs\.com|symanteccloud\.com|trendmicro\.com|forcepoint\.net|zscaler(two|three)?\.net|compute(-1)?\.amazonaws\.com|googleusercontent\.com|bc\.googleusercontent\.com|azure\.com|cloudapp\.azure\.com|cloudapp\.net|digitalocean\.com|linode\.com|vultr\.com|hetzner\.(com|de)|ovh\.net|contabo\.net|scaleway\.com|oraclecloud\.com|1e100\.net)$/i;

export type ViewerKind = "person" | "machine";

export interface ViewerVerdict {
  kind: ViewerKind;
  /** Short, human-readable reason, shown in the UI so the call is never a black box. */
  reason?: string;
}

const rdnsCache = new Map<string, string>();
const RDNS_CACHE_MAX = 5000;

/** Reverse DNS with a hard timeout. Empty string when it fails or times out. */
async function reverseDns(ip: string): Promise<string> {
  const hit = rdnsCache.get(ip);
  if (hit !== undefined) return hit;
  let host = "";
  try {
    const dns = await import("node:dns/promises");
    host = await Promise.race([
      dns.reverse(ip).then((names) => names[0] || ""),
      new Promise<string>((res) => setTimeout(() => res(""), 1500)),
    ]);
  } catch { /* no PTR record, or the lookup failed: treat as unknown */ }
  if (rdnsCache.size >= RDNS_CACHE_MAX) rdnsCache.clear();
  rdnsCache.set(ip, host);
  return host;
}

/**
 * Is this beacon a person or a machine? The user-agent decides on its own when it self-declares;
 * otherwise the caller's reverse-DNS name does. Unknown stays "person" ON PURPOSE — a real
 * prospect on an unusual network must never be discarded to make a number look tidy.
 */
export async function classifyViewer(ua?: string, ip?: string): Promise<ViewerVerdict> {
  const agent = (ua || "").trim();
  if (!agent) return { kind: "machine", reason: "no user-agent" };
  const botMatch = BOT_UA.exec(agent);
  if (botMatch) return { kind: "machine", reason: `automated client (${botMatch[0].toLowerCase()})` };

  const addr = (ip || "").trim();
  if (addr && !addr.includes(":")) {
    const host = await reverseDns(addr);
    if (host && MACHINE_HOST.test(host)) {
      const owner = host.split(".").slice(-3).join(".");
      return { kind: "machine", reason: `scanner or cloud network (${owner})` };
    }
  }
  return { kind: "person" };
}

/** The first address in X-Forwarded-For: the original client, not our proxy. */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0]?.trim();
  return first || headers.get("x-real-ip") || "";
}

/* ------------------------------------------------------------------ */
/* 2. Which person                                                     */
/* ------------------------------------------------------------------ */

export interface ViewerIdentity {
  prospectId?: string;
  name?: string;
  email?: string;
  company?: string;
  title?: string;
  linkedinUrl?: string;
  /** How we knew: the link carried them, or we inferred it from a single-recipient video. */
  via: "rcpt_id" | "rcpt_email" | "sole_recipient";
}

function fromProspect(p: Prospect, via: ViewerIdentity["via"]): ViewerIdentity {
  return {
    prospectId: p.id,
    name: p.fullName,
    email: p.email,
    company: p.company,
    title: p.title,
    linkedinUrl: p.linkedinUrl,
    via,
  };
}

/**
 * Which workspace owns a video. The watch beacon is public and unauthenticated, so the owner has
 * to be recovered: the short-link ledger knows it for links the app minted, and the MPC video
 * lane records its own workspace on the watcher snapshot. Null when neither knows, in which case
 * we simply do not name the viewer (guessing a tenant would leak across the wall).
 */
export async function videoWorkspaceId(videoKey: string): Promise<string | null> {
  try {
    const { resolveShortLink, shortCodeFor } = await import("./shortLinks");
    const rec = await resolveShortLink(shortCodeFor(videoKey));
    if (rec?.workspaceId) return rec.workspaceId;
  } catch { /* fall through */ }
  try {
    const { loadSnapshot } = await import("../db");
    const snap = await loadSnapshot<{ workspaceId?: string }>("mpc_watchers_v1");
    if (snap?.workspaceId) return snap.workspaceId;
  } catch { /* fall through */ }
  const env = (process.env.MPC_WORKSPACE_ID || "").trim();
  return env || null;
}

/**
 * Resolve whoever watched. `rcpt` may be a prospect id (the app's own links) or an email address
 * (the MPC video sender) — both are accepted, so one watcher lane serves both builders.
 */
export async function identifyViewer(
  videoKey: string,
  rcpt?: string,
): Promise<ViewerIdentity | null> {
  const { getCore } = await import("../core/repository");
  const core = getCore();
  const tag = (rcpt || "").trim();
  const workspaceId = await videoWorkspaceId(videoKey);

  if (tag) {
    if (tag.includes("@")) {
      if (workspaceId) {
        try {
          const p = await core.findProspectByEmail(workspaceId, tag.toLowerCase());
          if (p) return fromProspect(p, "rcpt_email");
        } catch { /* fall through to the videoKey route */ }
      }
      // Even without a prospect record, the address itself names the watcher.
      return { email: tag.toLowerCase(), via: "rcpt_email" };
    }
    try {
      const p = await core.getProspect(tag);
      if (p) return fromProspect(p, "rcpt_id");
    } catch { /* fall through */ }
  }

  // No usable tag: a video sent to exactly one person can only have been watched by them.
  if (workspaceId) {
    const sole = await soleRecipientOf(workspaceId, videoKey);
    if (sole) return fromProspect(sole, "sole_recipient");
  }
  return null;
}

/**
 * Fill in the Company · Role label for videos whose watch link never carried it. The MPC video
 * sender builds its own short link and omits the labels, so those rows arrive blank; the answer
 * is on our side of the wall (the prospect the video was built for), not in the URL.
 * Returns how many rows got a label.
 */
export async function backfillVideoLabels(limit = 400): Promise<{ scanned: number; labeled: number }> {
  const { unlabeledVideoKeys, labelVideo } = await import("./videoStats");
  const keys = (await unlabeledVideoKeys()).slice(0, limit);
  let labeled = 0;
  const byWorkspace = new Map<string, Prospect[]>();
  for (const key of keys) {
    const ws = await videoWorkspaceId(key);
    if (!ws) continue;
    if (!byWorkspace.has(ws)) {
      try {
        const { getCore } = await import("../core/repository");
        byWorkspace.set(ws, await getCore().listProspects(ws));
      } catch { byWorkspace.set(ws, []); }
    }
    const owner = (byWorkspace.get(ws) || []).find((p) => (p as any)?.personalizedVideo?.videoKey === key);
    if (!owner) continue;
    const role = (owner as any)?.personalizedVideo?.roleTitle || owner.title;
    if (await labelVideo(key, owner.company, role)) labeled++;
  }
  return { scanned: keys.length, labeled };
}

/** The one prospect a videoKey was personalized for, or null when it is shared/ambiguous. */
export async function soleRecipientOf(workspaceId: string, videoKey: string): Promise<Prospect | null> {
  try {
    const { getCore } = await import("../core/repository");
    const all = await getCore().listProspects(workspaceId);
    const matches = all.filter((p) => (p as any)?.personalizedVideo?.videoKey === videoKey);
    return matches.length === 1 ? matches[0] : null;
  } catch {
    return null;
  }
}
