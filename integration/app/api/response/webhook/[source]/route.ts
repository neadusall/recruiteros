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

  // The GLOBAL reply stop: a reply on ANY channel pauses the person's
  // automation everywhere. This wires the router's pause_all_sequences action
  // (previously a no-op through this path) to the LinkedIn OS engine, which
  // cancels pending LinkedIn actions, releases reserved capacity, pauses
  // enrollments and flips the core prospect off the cadence engines.
  const channelBySource: Record<ResponseSource, string> = {
    instantly: "email", unipile: "linkedin", salesrobot: "linkedin", taltxt: "sms",
  };
  const pauseSequences = async (prospectId: string) => {
    const { replyStopByProspectId } = await import("../../../../../lib/linkedin/os/outreachState");
    await replyStopByProspectId(workspaceId, prospectId, channelBySource[source] ?? "email");
  };

  const processed = await processInbound(source, workspaceId, payload, pauseSequences);
  if (!processed) return NextResponse.json({ ok: true, ignored: true });

  // Belt and braces: whatever the reply classified as, an inbound from a known
  // person always pauses their automated outreach (the rules matrix only
  // attaches pause_all_sequences to some classes; the spec wants ANY reply).
  if (processed.inbound.prospectId) {
    try { await pauseSequences(processed.inbound.prospectId); } catch { /* stop is idempotent + best-effort */ }
  }

  return NextResponse.json({
    ok: true,
    class: processed.classification.class,
    sla: processed.rule.sla,
    escalate: processed.rule.escalate,
    actions: processed.actionsTaken,
  });
}
