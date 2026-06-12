/**
 * Seed-inbox staff portal API  (PUBLIC — no session, token-guarded)
 *   GET  /api/seed-portal?token=...                 -> { ok, org }  (validate the link)
 *   POST /api/seed-portal  { token, staffName, accounts:[{provider,address,appPassword}] }
 *        -> registers each inbox, runs the IMAP connector test, returns per-account result
 *
 * This is the sink for seed-portal.html, the page staff use to self-register the
 * Gmail/Outlook/Yahoo inboxes they create for warm-up + placement testing. It is
 * intentionally sessionless (staff have no console logins) and guarded by a single
 * shared invite token in SENDING_SEED_PORTAL_TOKEN — without that env set, the
 * portal is OFF (503). There is deliberately NO limit on how many accounts one
 * submission carries.
 *
 * The app password is stored server-side and used by the warm-up engine + seed
 * tester to hold the IMAP/SMTP session — so nothing ever stays logged in on a
 * staff laptop. The password is never returned by any endpoint.
 */

import { NextResponse } from "next/server";
import { body } from "../../../lib/api";
import { addSeed, setSeedVerification, verifySeedLogin } from "../../../lib/sending";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: CORS });
}
export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

const ORG = process.env.SEED_PORTAL_ORG || "Lume Search Partners";
function portalToken(): string | null {
  const t = (process.env.SENDING_SEED_PORTAL_TOKEN || "").trim();
  return t || null;
}
/** Constant-ish comparison; tokens are short shared secrets, not passwords. */
function tokenOk(given: unknown): boolean {
  const want = portalToken();
  if (!want) return false;
  return typeof given === "string" && given.trim() === want;
}

export function GET(req: Request) {
  if (!portalToken()) return json({ error: "portal_disabled" }, 503);
  const token = new URL(req.url).searchParams.get("token");
  if (!tokenOk(token)) return json({ error: "invalid_token" }, 403);
  return json({ ok: true, org: ORG });
}

const PROVIDERS = ["gmail", "outlook", "yahoo", "other"] as const;
type Provider = (typeof PROVIDERS)[number];

interface InAccount { provider?: string; address?: string; appPassword?: string }
interface PortalBody { token?: string; staffName?: string; accounts?: InAccount[] }

export async function POST(req: Request) {
  if (!portalToken()) return json({ error: "portal_disabled" }, 503);
  const b = await body<PortalBody>(req);
  if (!tokenOk(b?.token)) return json({ error: "invalid_token" }, 403);

  const staffName = (b?.staffName || "").trim();
  const accounts = Array.isArray(b?.accounts) ? b!.accounts! : [];
  if (!accounts.length) return json({ error: "no_accounts" }, 422);

  const results: Array<{ address: string; provider: string; ok: boolean; error?: string }> = [];
  for (const a of accounts) {
    const address = (a?.address || "").trim();
    const appPassword = (a?.appPassword || "").trim();
    const provider = (PROVIDERS as readonly string[]).includes(a?.provider || "")
      ? (a!.provider as Provider) : "other";

    if (!address || !appPassword) {
      results.push({ address, provider, ok: false, error: "Missing email address or app password." });
      continue;
    }
    // Register (upsert by address) then run the connector test so the staff member
    // gets instant pass/fail feedback and only good inboxes flow to placement testing.
    const seed = await addSeed({
      provider, address, imapUser: address, imapPass: appPassword,
      addedBy: staffName || undefined,
    });
    const v = await verifySeedLogin(seed);
    await setSeedVerification(seed.id, v.ok, v.error);
    results.push({ address, provider, ok: v.ok, error: v.ok ? undefined : v.error });
  }

  const verified = results.filter((r) => r.ok).length;
  return json({ ok: true, registered: results.length, verified, results });
}
