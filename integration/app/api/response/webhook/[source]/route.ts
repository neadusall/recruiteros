/**
 * POST /api/response/webhook/[source]
 * Provider reply webhook ingest. source ∈ instantly | unipile | salesrobot | taltxt.
 *
 * Runs the full pipeline: normalize -> match prospect -> classify -> route ->
 * log. Idempotent on the provider message id. Point each provider's reply
 * webhook here (e.g. .../api/response/webhook/instantly?ws=<workspaceId>).
 */

import { NextResponse } from "next/server";
import { processInbound, type ResponseSource } from "../../../../../lib/response";
import { verifyWebhook } from "../../../../../lib/providers";

const SOURCES: ResponseSource[] = ["instantly", "unipile", "salesrobot", "taltxt"];

export async function POST(req: Request, { params }: { params: { source: string } }) {
  const source = params.source as ResponseSource;
  if (!SOURCES.includes(source)) return NextResponse.json({ error: "unknown_source" }, { status: 404 });

  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("ws") ?? req.headers.get("x-workspace-id") ?? "";
  if (!workspaceId) return NextResponse.json({ error: "missing_workspace" }, { status: 422 });

  // Read the raw body once so the signature is checked over exact bytes.
  const raw = await req.text();
  if (!verifyWebhook(source, req, raw)) {
    return NextResponse.json({ error: "bad_signature" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const processed = await processInbound(source, workspaceId, payload);
  if (!processed) return NextResponse.json({ ok: true, ignored: true });

  return NextResponse.json({
    ok: true,
    class: processed.classification.class,
    sla: processed.rule.sla,
    escalate: processed.rule.escalate,
    actions: processed.actionsTaken,
  });
}
