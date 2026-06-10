/**
 * POST /api/loxo/webhook?ws={workspaceId}&secret={webhookSecret}
 *
 * Loxo's real-time feed. We register one subscription per (item_type, action)
 * on connect (see registerLoxoWebhooks); each fires here. We authenticate by the
 * per-workspace shared secret carried on the callback URL, then re-fetch the
 * changed record by id (the payload may be slim) and upsert/delete it locally —
 * so the warehouse and company book track Loxo without polling.
 *
 * item_type we act on: person / candidate -> warehouse; company -> company book.
 * action: create|update -> pull & upsert; destroy -> delete by provider id.
 *
 * No session: this is a server-to-server call from Loxo. Always 200 on
 * recognised-but-ignored events so Loxo doesn't disable the subscription.
 */

import { NextResponse } from "next/server";
import { getVendorConfig, syncOnePerson, syncOneCompany } from "../../../../lib/ats";
import { deleteByProviderId as deletePerson } from "../../../../lib/data";
import { deleteByProviderId as deleteCompany } from "../../../../lib/companies";

const PERSON_TYPES = new Set(["person", "candidate", "person_job_profile", "person_education_profile", "person_event"]);
const COMPANY_TYPES = new Set(["company"]);

export async function POST(req: Request) {
  const url = new URL(req.url);
  const ws = url.searchParams.get("ws") ?? req.headers.get("x-workspace-id") ?? "";
  if (!ws) return NextResponse.json({ error: "missing_workspace" }, { status: 422 });

  // Authenticate by the per-workspace secret we minted at connect time.
  const provided = url.searchParams.get("secret") ?? req.headers.get("x-loxo-secret") ?? "";
  const cfg = await getVendorConfig(ws, "loxo");
  if (!cfg) return NextResponse.json({ error: "not_connected" }, { status: 404 });
  if (!cfg.webhookSecret || provided !== cfg.webhookSecret) {
    return NextResponse.json({ error: "bad_secret" }, { status: 401 });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const itemType = String(
    payload?.item_type ?? payload?.itemType ?? payload?.type ?? payload?.object_type ?? "",
  ).toLowerCase();
  const action = String(payload?.action ?? payload?.event ?? "").toLowerCase();
  const itemId = extractId(payload);

  if (!itemType || !itemId) return NextResponse.json({ ok: true, ignored: "no_item" });

  try {
    if (PERSON_TYPES.has(itemType)) {
      if (action === "destroy") {
        const removed = await deletePerson(ws, itemId);
        return NextResponse.json({ ok: true, type: "person", action, removed });
      }
      const synced = await syncOnePerson(ws, itemId);
      return NextResponse.json({ ok: true, type: "person", action, synced });
    }

    if (COMPANY_TYPES.has(itemType)) {
      if (action === "destroy") {
        const removed = await deleteCompany(ws, itemId);
        return NextResponse.json({ ok: true, type: "company", action, removed });
      }
      const synced = await syncOneCompany(ws, itemId);
      return NextResponse.json({ ok: true, type: "company", action, synced });
    }

    return NextResponse.json({ ok: true, ignored: itemType });
  } catch (e: any) {
    // Swallow to a 200 so Loxo retries on its own schedule rather than disabling.
    return NextResponse.json({ ok: true, error: e?.message ?? "handler_failed" });
  }
}

/** Loxo payloads carry the id in several places depending on item_type. */
function extractId(p: any): string | null {
  const candidates = [
    p?.item_id,
    p?.object_id,
    p?.id,
    p?.person_id,
    p?.company_id,
    p?.person?.id,
    p?.company?.id,
    p?.candidate?.id,
    p?.data?.id,
    p?.payload?.id,
  ];
  for (const c of candidates) {
    if (c !== undefined && c !== null && String(c).trim()) return String(c);
  }
  return null;
}
