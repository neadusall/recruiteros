/**
 * RecruitersOS · Signal Engine
 * Signal-grounded outreach generation.
 *
 * Turns a campaign target (a company/person + the signal that surfaced them) into a
 * multi-touch sequence whose every message is anchored to that real signal. This is the
 * docs/playbooks/copywriting-playbook.md (Bernays) made executable: each touch plays a rapport-first rung
 * (recognize → relate → invite → pitch → release) and the first line is the signal
 * itself, so outreach "arrives on time" instead of interrupting.
 *
 * Deterministic by default: it builds copy from templates keyed on signal type + channel
 * + rung, so it runs with no API key and produces stable output (testable, cache-safe).
 * Pass an optional `personalize` hook to upgrade any draft with the LLM personalizer in
 * ../linkedin/personalize without changing the flow.
 *
 * Governing rule (from the playbook): persuasion is anchored to a REAL observed signal
 * and TRUE claims. The signal supplies the circumstance; we never invent one.
 */

import type { Signal, Motion } from "./types";
import { getDefinition } from "./registry";
import { classifyTitle, titleOf } from "./filters";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type Channel = "email" | "linkedin" | "sms" | "voice_note";
export type Rung = "recognize" | "relate" | "invite" | "pitch" | "release";

/** The contact + role context a message is written to. */
export interface MessageContext {
  firstName?: string;
  fullName?: string;
  company?: string;
  /** Title we are targeting (their role, or the role they are hiring for). */
  title?: string;
  /** Optional concrete role being pitched (recruiting motion). */
  role?: { title: string; comp?: string; remote?: boolean; stack?: string[] };
  /** Sender name for the signoff. */
  sender?: string;
}

/** One drafted touch. */
export interface DraftedMessage {
  step: number;
  channel: Channel;
  rung: Rung;
  /** Wait after the previous step before sending (hours); 0 = immediate. */
  delayHours: number;
  subject?: string;       // email only
  body: string;
  /** The signal-derived phrase the touch is grounded in (for audit/UI). */
  groundedIn: string;
}

export interface DraftedSequence {
  motion: Motion;
  signalType: Signal["type"];
  /** The one-line reason that opens the whole sequence. */
  hook: string;
  steps: DraftedMessage[];
}

/* ------------------------------------------------------------------ */
/* House phrases (the cliché bank from docs/playbooks/copywriting-playbook.md) */
/* ------------------------------------------------------------------ */

const HOUSE = {
  batches: "Great talent hits the market in batches.",
  firstRelevant: "be the first relevant message they read",
};

/* ------------------------------------------------------------------ */
/* Signal → circumstance line (the "relate" beat, stated as fact)      */
/* ------------------------------------------------------------------ */

/**
 * The factual circumstance line, drawn straight from the signal's evidence. This is the
 * "make outreach feel inevitable" move (technique 5): we report a real event, we do not
 * manufacture one. Returns null only if the signal carries no usable specifics.
 */
export function circumstanceLine(signal: Signal): string {
  const e = signal.evidence as Record<string, unknown>;
  const co = signal.company?.name ?? "your team";
  switch (signal.type) {
    case "hiring_velocity":
      return `${co} has posted ${e.rolesPosted ?? "several"} roles in a short window`;
    case "job_repost":
      return `${co} has reposted the ${e.roleTitle ?? "role"} more than once`;
    case "job_posting":
    case "evergreen_role":
      return `${co} is hiring for ${e.roleTitle ?? "a role on your team"}`;
    case "funding_round":
      return e.amountUsd ? `${co} just raised ${fmtUsd(Number(e.amountUsd))}` : `${co} just announced a raise`;
    case "ipo_or_s1":
      return `${co} just filed to go public`;
    case "exec_hire":
    case "department_head_change":
      return `${co} just brought on a new ${e.title ?? "leader"}`;
    case "office_expansion":
      return `${co} is opening ${e.location ?? "a new location"}`;
    case "market_entry":
      return `${co} is expanding into ${e.market ?? "a new market"}`;
    case "product_launch":
      return `${co} just launched ${e.product ?? "a new product"}`;
    case "acquisition":
    case "merger":
      return `${co} is going through an acquisition`;
    case "grant_or_contract":
      return `${co} just won ${e.amountUsd ? fmtUsd(Number(e.amountUsd)) : "a major award"}`;
    case "layoff":
    case "warn_notice":
    case "office_closure":
      return `${co} just announced a reduction`;
    case "open_to_work":
      return `you flagged that you're open to new opportunities`;
    case "tenure_milestone":
      return `you've been at ${co} for a while now`;
    case "employer_distress":
      return `things have been turbulent at ${co} lately`;
    default:
      return getDefinition(signal.type).rationale.replace(/\.$/, "");
  }
}

/* ------------------------------------------------------------------ */
/* The "relate" inference — the stereotype/belief they already hold    */
/* ------------------------------------------------------------------ */

/** The shared-belief sentence (technique 9): something true they already accept. */
function relateLine(signal: Signal): string {
  switch (categoryOf(signal)) {
    case "capital":
      return "new capital usually means the team has to scale faster than it can hire";
    case "hiring_intent":
      return "a hiring surge is usually the point where the senior team quietly hits capacity";
    case "leadership":
      return "a new leader almost always rebuilds their team within the first 90 days";
    case "contraction":
      return HOUSE.batches;
    case "footprint":
      return "a new market needs people who already know it";
    default:
      return "timing is most of the battle in hiring";
  }
}

/* ------------------------------------------------------------------ */
/* Sequence templates                                                  */
/* ------------------------------------------------------------------ */

/** The channel + rung arc, shared across motions. Mirrors the LinkedIn Engine ladder. */
const ARC: Array<{ channel: Channel; rung: Rung; delayHours: number }> = [
  { channel: "email", rung: "recognize", delayHours: 0 },
  { channel: "linkedin", rung: "invite", delayHours: 48 },
  { channel: "sms", rung: "pitch", delayHours: 48 },
  { channel: "email", rung: "release", delayHours: 72 },
];

export interface DraftOptions {
  /** Optional async upgrade of a body via the LLM personalizer. */
  personalize?: (draft: DraftedMessage, ctx: MessageContext, signal: Signal) => Promise<string>;
}

/**
 * Draft the full multi-touch sequence for one target, grounded in its strongest signal.
 * Deterministic unless a `personalize` hook is supplied.
 */
export async function draftSequence(
  signal: Signal,
  ctx: MessageContext,
  opts: DraftOptions = {},
): Promise<DraftedSequence> {
  const circumstance = circumstanceLine(signal);
  const relate = relateLine(signal);
  const first = ctx.firstName ?? ctx.fullName?.split(/\s+/)[0] ?? "there";
  const sender = ctx.sender ?? "the RecruitersOS team";
  const recognition = recognitionLine(signal, ctx);

  const steps: DraftedMessage[] = [];
  for (let i = 0; i < ARC.length; i++) {
    const a = ARC[i];
    const body = renderBody(a.rung, a.channel, {
      first, sender, circumstance, relate, recognition, signal, ctx,
    });
    let finalBody = body;
    const draft: DraftedMessage = {
      step: i + 1,
      channel: a.channel,
      rung: a.rung,
      delayHours: a.delayHours,
      subject: a.channel === "email" ? subjectLine(a.rung, signal, ctx) : undefined,
      body: finalBody,
      groundedIn: circumstance,
    };
    if (opts.personalize) {
      try {
        draft.body = await opts.personalize(draft, ctx, signal);
      } catch {
        /* keep deterministic draft on failure */
      }
    }
    steps.push(draft);
  }

  return {
    motion: signal.motion,
    signalType: signal.type,
    hook: circumstance,
    steps,
  };
}

/* ------------------------------------------------------------------ */
/* Body rendering per rung                                             */
/* ------------------------------------------------------------------ */

interface RenderArgs {
  first: string;
  sender: string;
  circumstance: string;
  relate: string;
  recognition: string;
  signal: Signal;
  ctx: MessageContext;
}

function renderBody(rung: Rung, channel: Channel, a: RenderArgs): string {
  const recruiting = a.signal.motion === "recruiting";
  const ask = recruiting
    ? "Worth a 15-minute call this week?"
    : `Open to a quick look at how we'd approach ${a.signal.company?.name ?? "your"} hiring?`;
  const pitch = recruiting
    ? rolePitch(a.ctx)
    : `We help teams in exactly this window fill roles before the backlog turns into attrition.`;

  // SMS / LinkedIn are short; email carries the full arc.
  if (channel === "sms") {
    return `Hi ${a.first}, ${a.sender.split(" ")[0]} here. Following up since ${lower(a.circumstance)}. ${ask} No pressure either way.`;
  }
  if (channel === "linkedin") {
    return `Hi ${a.first}, reaching out because ${lower(a.circumstance)}. ${a.recognition} Would love to connect, sharing details if the timing's right.`;
  }

  // email
  switch (rung) {
    case "recognize":
      return [
        `Hi ${a.first},`,
        ``,
        `Saw ${lower(a.circumstance)}. ${a.recognition}`,
        ``,
        `${cap(a.relate)}.`,
        ``,
        `${pitch} ${ask}`,
        ``,
        cap(a.sender),
      ].join("\n");
    case "release":
      return [
        `Hi ${a.first},`,
        ``,
        `I'll close the loop here. If the timing on ${lower(a.circumstance)} shifts, my door's open, ${HOUSE.firstRelevant} is the whole idea.`,
        ``,
        `Either way, wishing ${a.signal.company?.name ?? "the team"} the best with it.`,
        ``,
        cap(a.sender),
      ].join("\n");
    default:
      return `Hi ${a.first}, following up since ${lower(a.circumstance)}. ${ask}`;
  }
}

function subjectLine(rung: Rung, signal: Signal, ctx: MessageContext): string {
  const co = signal.company?.name ?? "your team";
  if (rung === "release") return `closing the loop, ${co}`;
  switch (signal.type) {
    case "funding_round": return `${co}'s raise, and the part most teams underestimate`;
    case "hiring_velocity": return `${co} is hiring fast, a thought`;
    case "exec_hire": return `congrats to ${co}'s new hire`;
    case "layoff": case "warn_notice": return `${co}, and the people now on the market`;
    default: return `${co}, ${signal.evidence.roleTitle ? `the ${signal.evidence.roleTitle} search` : "a quick thought"}`;
  }
}

/* ------------------------------------------------------------------ */
/* Recognition (technique 2: specific, true compliment)               */
/* ------------------------------------------------------------------ */

function recognitionLine(signal: Signal, ctx: MessageContext): string {
  const title = ctx.title ?? titleOf(signal);
  if (signal.person?.fullName && title) {
    const intel = classifyTitle(title);
    return `Your background in ${intel.function.replace(/_/g, " ")} stood out.`;
  }
  if (signal.type === "exec_hire") return "Strong addition to the leadership team.";
  if (signal.type === "funding_round") return "Big milestone, congratulations.";
  return "";
}

function rolePitch(ctx: MessageContext): string {
  if (!ctx.role) return "I'm working with a team building something you'd genuinely want to own from day one.";
  const bits = [`a ${ctx.role.title} role`];
  if (ctx.role.remote) bits.push("fully remote");
  if (ctx.role.comp) bits.push(ctx.role.comp);
  return `I'm working with a team on ${bits.join(", ")}, where you'd set the direction, not inherit it.`;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

type SigCategory = ReturnType<typeof getDefinition>["category"];
function categoryOf(signal: Signal): SigCategory {
  return getDefinition(signal.type).category;
}

function fmtUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${n}`;
}
function lower(s: string): string { return s.charAt(0).toLowerCase() + s.slice(1); }
function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
