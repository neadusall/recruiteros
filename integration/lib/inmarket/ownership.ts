/**
 * In-Market · Personal-artifact access rules.
 *
 * Recordings, cloned voices, and the composites built from them are PERSONAL: they belong to
 * the recruiter who recorded the clip, not to the workspace. One teammate's face or voice must
 * never surface in (or send from) another teammate's account. Workspace owner/admin keeps the
 * full-workspace view for oversight; plain members see only their own.
 *
 * Composite ownership is derived, not stamped: a video belongs to whoever owns the webcam clip
 * inside it (with the studio's explicit /own registration as fallback). Artifacts that predate
 * ownership (no ownerEmail anywhere) are visible to admins only, so nothing unattributable ever
 * shows up in a recruiter's studio.
 */

import type { AuthResult } from "../auth/types";

export function isWorkspaceAdmin(ctx: AuthResult): boolean {
  return ctx.role === "owner" || ctx.role === "admin";
}

export function requesterEmail(ctx: AuthResult): string {
  return (ctx.user?.email || "").trim().toLowerCase();
}

/** May this session see/stream/attach a composite video? */
export async function canAccessVideo(ctx: AuthResult, videoKey: string): Promise<boolean> {
  const { videoOwnership } = await import("./roleVideo");
  const own = await videoOwnership(videoKey);
  // Never across workspaces, no matter the role.
  if (own.workspaceId && own.workspaceId !== ctx.workspace.id) return false;
  if (isWorkspaceAdmin(ctx)) return true;
  return !!own.ownerEmail && own.ownerEmail === requesterEmail(ctx);
}

/** May this session composite/caption/clone from this clip? (Own clip; legacy unowned allowed.) */
export async function canUseClip(ctx: AuthResult, clipId: string): Promise<boolean> {
  const { getClip } = await import("./roleVideo");
  const clip = await getClip(clipId);
  if (!clip) return true; // let the caller produce its own not-found error
  if (clip.workspaceId !== ctx.workspace.id) return false;
  if (isWorkspaceAdmin(ctx)) return true;
  return !clip.ownerEmail || clip.ownerEmail === requesterEmail(ctx);
}
