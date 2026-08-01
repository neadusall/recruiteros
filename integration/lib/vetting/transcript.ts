/**
 * RecruitersOS · AI Vetting · Transcript parsing (shape-tolerant, shared)
 *
 * ONE parser, used by BOTH scoring triggers:
 *   - the post-call webhook (`api/vetting/webhook`), and
 *   - the reconciler that pulls transcripts from the Telnyx Conversations API
 *     (`lib/vetting/reconcile.ts`).
 *
 * Telnyx's transcript/message field names vary across assistant versions and
 * between the insight payload and the Conversations API, so every extractor here
 * probes the common keys and degrades to an empty result rather than throwing.
 * Keeping this in one place guarantees the two paths score identical transcripts.
 */

import type { TranscriptTurn } from "./types";

/** Map an engine speaker label onto our two-role transcript model. */
export function toRole(label: unknown): "agent" | "candidate" {
  const s = String(label ?? "").toLowerCase();
  if (s.includes("assistant") || s.includes("agent") || s.includes("bot") || s.includes("ai")) return "agent";
  return "candidate";
}

/** Turn a loose array of message-ish objects into ordered transcript turns. */
export function turnsFromArray(raw: any[]): TranscriptTurn[] {
  return raw
    .map((t: any): TranscriptTurn | null => {
      const rawText = t?.content ?? t?.text ?? t?.message ?? t?.body ?? "";
      // `content` is sometimes a nested {text} or an array of parts.
      const text =
        typeof rawText === "string"
          ? rawText
          : typeof rawText?.text === "string"
            ? rawText.text
            : Array.isArray(rawText)
              ? rawText.map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).join(" ")
              : "";
      if (!text.trim()) return null;
      return {
        role: toRole(t?.role ?? t?.speaker ?? t?.participant ?? t?.sender),
        text: String(text),
        atSec: typeof t?.start === "number" ? Math.round(t.start) : undefined,
      };
    })
    .filter((t): t is TranscriptTurn => Boolean(t));
}

/**
 * Parse a transcript out of a webhook/insight payload (the `ev` object). Accepts
 * an array of turns under any of the common keys, or a single string blob.
 */
export function parseTranscript(ev: any): TranscriptTurn[] {
  const raw = ev?.transcript ?? ev?.transcription ?? ev?.messages ?? ev?.conversation;
  if (Array.isArray(raw)) return turnsFromArray(raw);
  if (typeof raw === "string" && raw.trim()) return [{ role: "candidate", text: raw.trim() }];
  return [];
}

/**
 * Parse the response of `GET /v2/ai/conversations/{id}/messages`. Telnyx wraps
 * the list under `data`; we tolerate a bare array or a `messages` key too.
 */
export function parseConversationMessages(res: any): TranscriptTurn[] {
  const arr = Array.isArray(res?.data)
    ? res.data
    : Array.isArray(res?.messages)
      ? res.messages
      : Array.isArray(res)
        ? res
        : [];
  return turnsFromArray(arr);
}
