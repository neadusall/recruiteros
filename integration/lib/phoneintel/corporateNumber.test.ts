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
