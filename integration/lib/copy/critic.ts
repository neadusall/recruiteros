/**
 * RecruitersOS · Copy critic (the "check his work" layer)
 *
 * A cheap second LLM pass that runs on the AUTO-SEND path only, after the free
 * deterministic scanner has passed. It catches what regex can't: copy that dodged the
 * banned list but still reads generic, salesy, or bot-written. Returns pass / issues /
 * a corrected rewrite. Uses a small model (Haiku) so the safety net costs ~$0.001-0.002
 * per message and never gates throughput meaningfully.
 *
 * Fail-OPEN on infrastructure errors (no key, API hiccup): the deterministic scanner
 * already ran, so a critic outage must not block legitimate sends — it just means the
 * subtler check was skipped for that message.
 */

import { anthropicClient } from "../sourcing/anthropic";
import { CRITIC_SYSTEM } from "./guidelines";
import { sanitizeDashes } from "../bd/sanitize";

const CRITIC_MODEL = process.env.RECRUITEROS_CRITIC_MODEL ?? "claude-haiku-4-5";

export interface Critique {
  pass: boolean;
  issues: string[];
  rewrite?: string;
  /** True when the critic could not run (no key / error) — caller treats as a pass. */
  skipped?: boolean;
}

export interface CritiqueContext {
  channel?: string;
  /** A real referral source, if one is genuinely attached (lets intro language pass). */
  referralSource?: string;
  /** The current on-voice winning sample for this segment, as a positive reference. */
  winnerExample?: string;
}

/** Judge one message against the guidelines. Fails open on any infra error. */
export async function critique(text: string, ctx: CritiqueContext = {}): Promise<Critique> {
  const t = (text ?? "").trim();
  if (!t) return { pass: true, issues: [] };

  let client;
  try {
    client = anthropicClient();
  } catch {
    return { pass: true, issues: [], skipped: true }; // no key -> skip, don't block
  }

  const context = [
    ctx.channel ? `Channel: ${ctx.channel}` : null,
    ctx.referralSource ? `A REAL referral source IS attached: ${ctx.referralSource} (referral/intro language is allowed here).` : `No referral source is attached (any referral/intro language is fabricated and must fail).`,
    ctx.winnerExample ? `On-voice reference that currently wins for this segment (match this calibre, do not copy it):\n${ctx.winnerExample}` : null,
  ].filter(Boolean).join("\n");

  try {
    const resp = await client.messages.create({
      model: CRITIC_MODEL,
      max_tokens: 600,
      system: [{ type: "text", text: CRITIC_SYSTEM, cache_control: { type: "ephemeral" } }] as any,
      messages: [{ role: "user", content: `${context}\n\nCOPY TO JUDGE:\n${t}\n\nRespond as strict JSON only.` }],
    });
    const raw = resp.content.find((b) => b.type === "text");
    const out = raw && raw.type === "text" ? raw.text : "{}";
    let o: Record<string, unknown> = {};
    const s = out.indexOf("{");
    const e = out.lastIndexOf("}");
    if (s >= 0) o = JSON.parse(out.slice(s, e + 1));
    const pass = o.pass === true;
    const issues = Array.isArray(o.issues) ? (o.issues as unknown[]).map(String) : [];
    const rewrite = typeof o.rewrite === "string" && o.rewrite.trim() ? sanitizeDashes(o.rewrite.trim()) : undefined;
    return { pass, issues, rewrite };
  } catch {
    return { pass: true, issues: [], skipped: true }; // API error -> skip, don't block
  }
}
