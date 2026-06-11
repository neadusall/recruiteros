/**
 * /api/owner/email-health   (OWNER ONLY)
 *   GET  -> { configured, from } — is outbound email wired, and from whom.
 *   POST -> send a real test email to the signed-in owner and report the exact
 *           result (sent / rejected with Resend's reason / no provider).
 *
 * Lets the operator confirm password-reset & verification deliverability — and
 * see the precise failure (e.g. unverified sender domain) — without guessing.
 */

import { requireOwner, ok } from "../../../../lib/api";
import { emailConfig, sendDiagnosticEmail } from "../../../../lib/auth";

export async function GET(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  return ok(emailConfig());
}

export async function POST(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const result = await sendDiagnosticEmail(g.ctx.user.email);
  return ok(result);
}
