/**
 * Which number Voice Drops / Phone Intel actually dials.
 *
 * The precedence rule this defends: a real DIRECT line always wins, and the employer's
 * switchboard is the fallback that makes the engine useful at all — because direct dials are
 * paid and rare, while published main lines are free and plentiful. Phone Intel is built to
 * call a switchboard and navigate the IVR to the person, so a front desk is a valid target
 * HERE, and only here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { corporateNumber } from "./roleVoicemail";
import type { Prospect } from "../core/types";

const base = { id: "p1", workspaceId: "ws", fullName: "Dana Whitfield" } as unknown as Prospect;

test("a direct landline outranks the switchboard", () => {
  const p = { ...base, landlinePhone: "+14159260123", companyPhone: "+18002886503" } as Prospect;
  assert.equal(corporateNumber(p), "+14159260123", "never route through an IVR when we can reach them directly");
});

test("an enriched phone outranks the switchboard", () => {
  const p = { ...base, phone: "+14159260123", companyPhone: "+18002886503" } as Prospect;
  assert.equal(corporateNumber(p), "+14159260123");
});

test("the switchboard is used when there is no direct line", () => {
  // The common case: direct dials are paid, switchboards are free.
  const p = { ...base, companyPhone: "+18002886503" } as Prospect;
  assert.equal(corporateNumber(p), "+18002886503");
});

test("no number at all yields empty, never a partial or a guess", () => {
  assert.equal(corporateNumber({ ...base } as Prospect), "");
});

/* ------------------------------------------------------------------ */
/* The silence gate                                                    */
/* ------------------------------------------------------------------ */

/**
 * The rule: never queue a voicemail we cannot actually speak.
 *
 * assembleSplicedDrop returns dryRun with placeholder audio when the workspace has no usable
 * voice (no clone on file, or no TTS credential). Queuing that would make Phone Intel dial the
 * switchboard, navigate the IVR, reach the person's mailbox, and play SILENCE — worse than not
 * calling, because it burns the contact and spends Telnyx minutes to sound broken.
 *
 * This is verified at the reason-code level: enqueueRoleVoicemail's own gate chain is what the
 * email path depends on, and "no_voice" is the refusal that keeps RECRUITEROS_ROLE_VM_ON_SEND
 * safe to leave switched on before a voice exists.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

test("enqueue refuses a dry-run (silent) voicemail instead of queuing dead air", () => {
  const src = readFileSync(join(__dirname, "roleVoicemail.ts"), "utf8");
  const fn = src.slice(src.indexOf("export async function enqueueRoleVoicemail"));
  const body = fn.slice(0, fn.indexOf("\n}"));

  // The guard must exist, and must sit BEFORE anything is enqueued.
  const guard = body.indexOf('reason: "no_voice"');
  const queued = body.indexOf("enqueue(workspaceId");
  assert.ok(guard > 0, "enqueueRoleVoicemail must refuse when the drop is dryRun");
  assert.ok(queued > 0, "sanity: the enqueue call is still there");
  assert.ok(guard < queued, "the silence gate must run BEFORE the item is queued");
  assert.ok(/dryRun \|\| !url/.test(body), "must gate on dryRun AND a missing url");
});

test("every refusal reason is surfaced in the pull summary, so a silent skip is never invisible", () => {
  const src = readFileSync(join(__dirname, "roleVoicemail.ts"), "utf8");
  for (const r of ["not_emailed", "no_number", "already_queued", "not_business_line", "no_voice"]) {
    assert.ok(src.includes(`=== "${r}"`), `pull summary must count "${r}"`);
  }
});
