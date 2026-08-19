/* Phase-1 self-test for the deterministic Phone Intelligence core.
 * Run: npx tsx lib/phoneintel/selftest.ts
 * No network, no Telnyx — proves keypad + classifier + name-match logic. */
import { toDtmf, directoryInput, type DirectorySpec } from "./keypad";
import {
  classifyAnswer, extractMenuOptions, parseDirectoryInstruction, matchName, soundex,
} from "./classify";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`  FAIL ${label}\n    got  ${g}\n    want ${w}`); }
}
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) pass++; else { fail++; console.log(`  FAIL ${label} ${detail ?? ""}`); }
}

console.log("· keypad DTMF encoding");
eq("SMI -> 764", toDtmf("SMI"), "764");
eq("NEAD -> 6323", toDtmf("Nead"), "6323");
eq("O'Brien letters -> 62743...", toDtmf("OBrien"), "627436");
{
  const spec: DirectorySpec = { field: "last", length: 3, input: "dtmf" };
  eq("directory last-3 of Smith", directoryInput(spec, { last: "Smith" }), { dtmf: "764" });
}
{
  const spec: DirectorySpec = { field: "last", length: "full", input: "dtmf", terminator: "#" };
  eq("spell full last + #", directoryInput(spec, { last: "Nead" }), { dtmf: "6323#" });
}
{
  const spec: DirectorySpec = { field: "firstlast", length: "full", input: "speech" };
  eq("speech firstlast", directoryInput(spec, { full: "Ryan Nead" }), { speak: "Ryan Nead" });
}

console.log("· answer classification");
ok("IVR menu", classifyAnswer("Thank you for calling. For sales press 1, for our company directory press 3.").class === "ivr");
ok("generic voicemail", classifyAnswer("The person you are trying to reach is unavailable. Please leave a message after the tone.").class === "voicemail_generic");
{
  const c = classifyAnswer("Hi, you've reached John Smith, Vice President of Sales. Leave a message after the beep.", true);
  ok("named voicemail class", c.class === "voicemail_named", c.class);
  ok("named voicemail name", (c.detectedName ?? "").toLowerCase().includes("john smith"), c.detectedName);
}
ok("receptionist", classifyAnswer("ABC Corporation, this is Sarah, how may I direct your call?", false).class === "human_receptionist");

console.log("· menu option extraction");
{
  const opts = extractMenuOptions("For sales press 1. For support, press 2. For the company directory press 3.");
  const dir = opts.find((o) => o.isDirectory);
  eq("directory digit", dir?.digit, "3");
  ok("three options", opts.length === 3, String(opts.length));
}
{
  const opts = extractMenuOptions("Press one for new patients, press two for billing, press zero for the operator.");
  const op = opts.find((o) => o.isOperator);
  eq("operator digit", op?.digit, "0");
}

console.log("· directory instruction parsing");
eq("first three letters last name",
  parseDirectoryInstruction("Please enter the first three letters of the person's last name."),
  { field: "last", length: 3, input: "dtmf" });
eq("first 4 letters",
  parseDirectoryInstruction("Enter the first 4 letters of the last name."),
  { field: "last", length: 4, input: "dtmf" });
eq("spell last name",
  parseDirectoryInstruction("Spell the person's last name."),
  { field: "last", length: "full", input: "dtmf" });
eq("say first and last",
  parseDirectoryInstruction("Say the first and last name of the person you are trying to reach."),
  { field: "firstlast", length: "full", input: "speech" });
eq("extension prompt",
  parseDirectoryInstruction("If you know your party's extension, you may dial it now."),
  { extension: true });

console.log("· fuzzy name matching");
{
  const m = matchName({ first: "Stephen", last: "McDonald" }, "Steven MacDonald");
  ok("Stephen/Steven McDonald >=0.85", m.score >= 0.85, `score=${m.score}`);
  ok("verdict match/probable", m.verdict !== "no_match", m.verdict);
}
{
  const m = matchName({ full: "John Smith" }, "John Smith");
  eq("exact match verdict", m.verdict, "match");
}
{
  const m = matchName({ first: "John", last: "Smith" }, "Robert Jones");
  eq("no match verdict", m.verdict, "no_match");
}
eq("soundex Robert/Rupert", soundex("Robert"), soundex("Rupert"));

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
