/**
 * GET  /api/senders            -> { inboxes (public), pools (per recruiter), stats }
 *        ?ownerId=<userId>      -> only that recruiter's inboxes
 * POST /api/senders            -> manage inboxes (require team:manage):
 *   { action: "add", email, smtpHost, smtpPass, ... , ownerId? }
 *   { action: "delete", id }
 *   { action: "assign", ids:[], ownerId, ownerName? }     bulk assign a pool to a recruiter
 *   { action: "setStatus", ids:[], status, pausedReason? }
 *   { action: "test", id }                                verify SMTP login
 *   { action: "setCap", id|ids, dailyCap }                set daily cold cap, single or bulk (clamped 1..MAX)
 *   { action: "domainHealth", refresh? }                  per-domain SPF/DKIM/DMARC/MX + bounce (cached; refresh forces live DNS)
 *
 * GET ?health=1&secret=<cron>  -> refresh every workspace's domain-health cache (timer endpoint)
 *
 * Inboxes are scoped to the caller's workspace (= portal), so RecruitersOS and Lume
 * pools never mix. Secrets are encrypted at rest and never returned.
 */
import { requireSession, requireCapability, body, ok, fail } from "../../../lib/api";
import { requireCronAuth } from "../../../lib/linkedin/auth";
import {
  listInboxes, toPublic, addInbox, deleteInbox, getInbox, saveInbox,
  assignOwner, setStatus, recruiterPools, stats, verifyInbox,
  clampCap, ensureSendersHealth, peekSendersHealth, sweepSendersHealth,
} from "../../../lib/senders";
import type { SenderProvider, SenderStatus } from "../../../lib/senders";

export async function GET(req: Request) {
  const url = new URL(req.url);

  // Cron-authed fleet-wide health sweep (?health=1&secret=...) so a timer can
  // keep every workspace's domain-health cache fresh without a session.
  if (url.searchParams.get("health") === "1") {
    const c = requireCronAuth(req);
    if (!c.ok) return c.response;
    return ok(await sweepSendersHealth());
  }

  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const ownerId = url.searchParams.get("ownerId") || undefined;
  const [inboxes, pools, s, health] = await Promise.all([
    listInboxes(ws, { ownerId }),
    recruiterPools(ws),
    stats(ws),
    peekSendersHealth(ws),   // cache-first; kicks a background refresh when stale
  ]);
  return ok({ inboxes: inboxes.map(toPublic), pools, stats: s, health });
}

interface SenderBody {
  action?: string;
  email?: string; displayName?: string; provider?: SenderProvider;
  smtpHost?: string; smtpPort?: number; smtpSecure?: boolean; smtpUser?: string; smtpPass?: string;
  imapHost?: string; imapPort?: number; imapUser?: string; imapPass?: string;
  dailyCap?: number; ownerId?: string; ownerName?: string;
  id?: string; ids?: string[]; status?: SenderStatus; pausedReason?: string;
  refresh?: boolean;
}

export async function POST(req: Request) {
  const g = requireCapability(req, "team:manage");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<SenderBody>(req);
  try {
    switch (b?.action) {
      case "add": {
        if (!b.email || !b.smtpHost || !b.smtpPass) {
          return fail("missing_fields", 422, { detail: "email, smtpHost, smtpPass required" });
        }
        const m = await addInbox(ws, {
          email: b.email, displayName: b.displayName, provider: b.provider,
          smtpHost: b.smtpHost, smtpPort: b.smtpPort, smtpSecure: b.smtpSecure, smtpUser: b.smtpUser, smtpPass: b.smtpPass,
          imapHost: b.imapHost, imapPort: b.imapPort, imapUser: b.imapUser, imapPass: b.imapPass,
          dailyCap: b.dailyCap, ownerId: b.ownerId, ownerName: b.ownerName,
        });
        return ok({ inbox: toPublic(m) }, 201);
      }
      case "delete":
        if (!b.id) return fail("missing_id", 422);
        return ok({ deleted: await deleteInbox(ws, b.id) });
      case "assign":
        if (!b.ids?.length || !b.ownerId) return fail("missing_fields", 422);
        return ok({ assigned: await assignOwner(ws, b.ids, b.ownerId, b.ownerName) });
      case "setStatus":
        if (!b.ids?.length || !b.status) return fail("missing_fields", 422);
        return ok({ updated: await setStatus(ws, b.ids, b.status, b.pausedReason) });
      case "test": {
        if (!b.id) return fail("missing_id", 422);
        const m = await getInbox(ws, b.id);
        if (!m) return fail("not_found", 404);
        const r = await verifyInbox(m);
        if (r.ok && m.status === "error") m.status = "warming";
        if (!r.ok) m.status = "error";
        m.lastError = r.ok ? undefined : r.error;
        await saveInbox(m);
        return ok({ ok: r.ok, error: r.error });
      }
      case "setCap": {
        // Single inbox (id) or bulk (ids) — a 75-inbox fleet is one call, not 75.
        const ids = Array.isArray(b.ids) && b.ids.length ? b.ids : b.id ? [b.id] : [];
        if (!ids.length) return fail("missing_id", 422);
        const cap = clampCap(b.dailyCap);   // never above the absolute hard ceiling
        const updated = [];
        for (const id of ids) {
          const m = await getInbox(ws, id);
          if (!m) continue;
          m.dailyCap = cap;
          await saveInbox(m);
          updated.push(toPublic(m));
        }
        if (!updated.length) return fail("not_found", 404);
        return ok({ updated: updated.length, dailyCap: cap, inboxes: updated });
      }
      case "domainHealth": {
        // Cache-first with TTL; { refresh: true } forces a live DNS re-check.
        const h = await ensureSendersHealth(ws, !!b.refresh);
        return ok({ checkedAt: h.checkedAt, domains: h.domains });
      }
      default:
        return fail("unknown_action", 400);
    }
  } catch (e: any) {
    return fail(e?.message || "senders_action_failed", e?.status || 400);
  }
}
