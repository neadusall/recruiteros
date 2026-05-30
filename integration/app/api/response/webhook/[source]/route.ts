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

const SOURCES: ResponseSource[] = ["instantly", "unipile", "salesrobot", "taltxt"];

export async function POST(req: Request, { params }: { params: { source: string } }) {
  const source = params.source as ResponseSource;
  if (!SOURCES.includes(source)) return NextResponse.json({ error: "unknown_source" }, { status: 404 });

  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("ws") ?? req.headers.get("x-workspace-id") ?? "";
  if (!workspaceId) return NextResponse.json({ error: "missing_workspace" }, { status: 422 });

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // TODO(prod): verify the provider signature per source before processing.
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
