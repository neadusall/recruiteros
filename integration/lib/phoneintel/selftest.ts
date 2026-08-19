/* Phase-1 self-test for the deterministic Phone Intelligence core.
 * Run: npx tsx lib/phoneintel/selftest.ts
 * No network, no Telnyx — proves keypad + classifier + navigation planner across
 * the full catalog of corporate IVR variations, benchmarked on the target name. */
import { toDtmf, directoryInput, type DirectorySpec } from "./keypad";
import {
  classifyAnswer, extractMenuOptions, parseDirectoryInstruction, matchName, soundex,
  matchNamedOptions, parseConfirmation, detectConnecting, detectExtensionInvite,
  detectContinueGate, departmentForTitle, matchDepartmentOption,
} from "./classify";
import { planIvrMove } from "./navigation";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`  FAIL ${label}\n    got  ${g}\n    want ${w}`); }
}
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) pass++; else { fail++; console.log(`  FAIL ${label} ${detail ?? ""}`); }
}

const TARGET = { first: "John", last: "Smith", full: "John Smith", title: "VP of Sales" };

console.log("· keypad DTMF encoding");
eq("SMI -> 764", toDtmf("SMI"), "764");
eq("NEAD -> 6323", toDtmf("Nead"), "6323");
eq("O'Brien letters -> 627436", toDtmf("OBrien"), "627436");
eq("directory last-3 of Smith", directoryInput({ field: "last", length: 3, input: "dtmf" }, { last: "Smith" }), { dtmf: "764" });
eq("spell full last + #", directoryInput({ field: "last", length: "full", input: "dtmf", terminator: "#" }, { last: "Nead" }), { dtmf: "6323#" });
eq("speech firstlast", directoryInput({ field: "firstlast", length: "full", input: "speech" }, { full: "Ryan Nead" }), { speak: "Ryan Nead" });
eq("lastfirst dtmf Smith John", directoryInput({ field: "lastfirst", length: "full", input: "dtmf" }, { first: "John", last: "Smith" }), { dtmf: toDtmf("SmithJohn") });

console.log("· answer classification (every answer type)");
ok("IVR menu", classifyAnswer("Thank you for calling. For sales press 1, for our company directory press 3.").class === "ivr");
ok("generic voicemail", classifyAnswer("The person you are trying to reach is unavailable. Please leave a message after the tone.").class === "voicemail_generic");
{
  const c = classifyAnswer("Hi, you've reached John Smith, Vice President of Sales. Leave a message after the beep.", true);
  ok("named voicemail class", c.class === "voicemail_named", c.class);
  ok("named voicemail name", (c.detectedName ?? "").toLowerCase().includes("john smith"), c.detectedName);
}
ok("named VM 'office of'", classifyAnswer("You've reached the office of Jane Doe.", true).class === "voicemail_named");
ok("receptionist", classifyAnswer("ABC Corporation, this is Sarah, how may I direct your call?", false).class === "human_receptionist");
ok("hold queue", classifyAnswer("Your call is important to us. Please continue to hold for the next available agent.").class === "hold_queue");
ok("after hours", classifyAnswer("Thank you for calling. Our office is currently closed. Our regular business hours are 9 to 5.").class === "after_hours");
ok("security gate", classifyAnswer("To prove you are a human, press 1 to continue.").class === "security_gate");

console.log("· menu option extraction (phrasing variations)");
eq("press N for X", extractMenuOptions("Press 1 for sales.").find((o) => o.digit === "1")?.digit, "1");
eq("for X press N", extractMenuOptions("For billing, press 4.").find((o) => o.digit === "4")?.digit, "4");
eq("to reach X press N", extractMenuOptions("To reach customer service, press 2.").find((o) => o.digit === "2")?.digit, "2");
eq("press N to be connected to X", extractMenuOptions("Press 5 to be connected to the sales team.").find((o) => o.digit === "5")?.digit, "5");
eq("dial N for X", extractMenuOptions("Dial 6 for support.").find((o) => o.digit === "6")?.digit, "6");
eq("digit word", extractMenuOptions("Press seven for new business.").find((o) => o.digit === "7")?.digit, "7");
eq("pound key option", extractMenuOptions("For the directory, press pound.").find((o) => o.isDirectory)?.digit, "#");
{
  const opts = extractMenuOptions("For sales press 1. For support, press 2. For the company directory press 3.");
  eq("directory digit", opts.find((o) => o.isDirectory)?.digit, "3");
  ok("three options", opts.length === 3, String(opts.length));
}
eq("operator digit", extractMenuOptions("Press zero for the operator.").find((o) => o.isOperator)?.digit, "0");
eq("directory option digit helper", extractMenuOptions("For the dial by name directory press 9.").find((o) => o.isDirectory)?.digit, "9");

console.log("· directory instruction parsing (every format)");
eq("first three of last", parseDirectoryInstruction("Please enter the first three letters of the person's last name."), { field: "last", length: 3, input: "dtmf" });
eq("first 4 of last", parseDirectoryInstruction("Enter the first 4 letters of the last name."), { field: "last", length: 4, input: "dtmf" });
eq("first few of last", parseDirectoryInstruction("Enter the first few letters of the last name."), { field: "last", length: 3, input: "dtmf" });
eq("spell last", parseDirectoryInstruction("Spell the person's last name."), { field: "last", length: "full", input: "dtmf" });
eq("last then first", parseDirectoryInstruction("Enter the last name followed by the first name."), { field: "lastfirst", length: "full", input: "dtmf" });
eq("first then last", parseDirectoryInstruction("Enter the first name then the last name."), { field: "firstlast", length: "full", input: "dtmf" });
eq("say first and last", parseDirectoryInstruction("Say the first and last name of the person you are trying to reach."), { field: "firstlast", length: "full", input: "speech" });
eq("spell last + pound", parseDirectoryInstruction("Spell the last name followed by the pound sign."), { field: "last", length: "full", input: "dtmf", terminator: "#" });
eq("extension only", parseDirectoryInstruction("If you know your party's extension, you may dial it now."), { extension: true });

console.log("· dial-ahead + gates");
ok("extension invite", detectExtensionInvite("If you know your party's extension, you may dial it at any time."));
eq("continue gate digit", detectContinueGate("To be connected, press 1."), "1");
eq("continue gate 'press N to continue'", detectContinueGate("Press 1 to continue."), "1");

console.log("· connecting / progress");
{
  const c = detectConnecting("Please hold while I connect you to John Smith.");
  ok("connecting flagged", c.connecting);
  ok("connecting name", (c.name ?? "").toLowerCase().includes("john smith"), c.name);
}
ok("generic hold connecting", detectConnecting("One moment please.").connecting);

console.log("· confirmation read-back");
{
  const c = parseConfirmation("Did you say John Smith? Press 1 for yes, 2 for no.");
  ok("is confirmation", c.isConfirmation);
  ok("confirm name", (c.name ?? "").toLowerCase().includes("john smith"), c.name);
  eq("yes digit", c.yesDigit, "1");
  eq("no digit", c.noDigit, "2");
}

console.log("· department routing by title");
eq("VP Sales -> sales", departmentForTitle("VP of Sales"), "sales");
eq("Head of Talent -> hr", departmentForTitle("Head of Talent Acquisition"), "hr");
eq("dept option match", matchDepartmentOption(extractMenuOptions("Press 3 for sales, press 4 for support."), "sales"), "3");

console.log("· multi-match disambiguation (NAME BENCHMARK)");
{
  const opts = extractMenuOptions("For John Smith press 1. For John Smyth press 2. For Jane Anderson press 3.");
  const m = matchNamedOptions(opts, TARGET);
  eq("picks exact John Smith", m.digit, "1");
}
{
  // Target John Smith, list has a near-miss spelling first.
  const opts = extractMenuOptions("For Jon Smithe press 1. For John Smith press 2.");
  const m = matchNamedOptions(opts, TARGET);
  eq("picks better match digit 2", m.digit, "2");
}

console.log("· planIvrMove end-to-end (the decision engine)");
// 1. Directory option in the menu -> press it.
{
  const mv = planIvrMove("Thank you for calling Jaggaer. For sales press 1, for the company directory press 3.", TARGET);
  ok("opens directory", mv.kind === "dtmf" && (mv as any).digit === "3" && (mv as any).isDirectoryNav, JSON.stringify(mv));
}
// 2. Directory name-entry -> key first 3 of last name (Smith -> 764).
{
  const mv = planIvrMove("Enter the first three letters of the last name.", TARGET);
  ok("directory_enter last3", mv.kind === "directory_enter", JSON.stringify(mv));
  if (mv.kind === "directory_enter") eq("spec last3", directoryInput(mv.spec, TARGET), { dtmf: "764" });
}
// 3. Multi-match list -> pick the target.
{
  const mv = planIvrMove("For John Smith press 1. For Jane Smith press 2.", TARGET);
  ok("disambiguation picks 1", mv.kind === "dtmf" && (mv as any).digit === "1", JSON.stringify(mv));
}
// 4. Confirmation of the right name -> yes.
{
  const mv = planIvrMove("Did you say John Smith? Press 1 for yes, 2 for no.", TARGET);
  ok("confirm yes", mv.kind === "dtmf" && (mv as any).digit === "1", JSON.stringify(mv));
}
// 5. Confirmation of the WRONG name -> no/retry.
{
  const mv = planIvrMove("Did you say Bob Jones? Press 1 for yes, 2 for no.", TARGET);
  ok("confirm no on wrong name", mv.kind === "dtmf" && (mv as any).digit === "2", JSON.stringify(mv));
}
// 6. Connecting statement -> wait.
{
  const mv = planIvrMove("Please hold while I connect you to John Smith.", TARGET);
  ok("connecting waits", mv.kind === "wait", JSON.stringify(mv));
}
// 7. Extension dial-ahead with a known extension -> dial it.
{
  const mv = planIvrMove("If you know your party's extension, dial it now.", TARGET, { knownExtension: "4482" });
  ok("extension dialed", mv.kind === "extension" && (mv as any).digits === "4482", JSON.stringify(mv));
}
// 8. No directory, but a department that fits the title -> route there.
{
  const mv = planIvrMove("Press 1 for support, press 3 for sales, press 9 to repeat.", TARGET);
  ok("department route to sales(3)", mv.kind === "dtmf" && (mv as any).digit === "3", JSON.stringify(mv));
}
// 9. No directory, no department -> operator.
{
  const t2 = { first: "John", last: "Smith", full: "John Smith", title: "Chief People Officer" };
  const mv = planIvrMove("Press 1 for billing, press 2 for shipping, press 0 for the operator.", t2);
  ok("falls to operator(0)", mv.kind === "dtmf" && (mv as any).digit === "0" && (mv as any).isOperator, JSON.stringify(mv));
}
// 10. Continue gate -> press through.
{
  const mv = planIvrMove("To be connected, press 1.", TARGET);
  ok("passes gate", mv.kind === "dtmf" && (mv as any).digit === "1", JSON.stringify(mv));
}
// 11. Never loops a tried digit -> zero-out when the directory was already tried.
{
  const mv = planIvrMove("For the company directory press 3, or stay on the line.", TARGET, { triedDigits: ["3"] });
  ok("does not repeat digit 3", !(mv.kind === "dtmf" && (mv as any).digit === "3"), JSON.stringify(mv));
}

console.log("· fuzzy name matching");
{
  const m = matchName({ first: "Stephen", last: "McDonald" }, "Steven MacDonald");
  ok("Stephen/Steven McDonald >=0.85", m.score >= 0.85, `score=${m.score}`);
}
eq("exact match verdict", matchName({ full: "John Smith" }, "John Smith").verdict, "match");
eq("inverted order match", matchName({ first: "John", last: "Smith" }, "Smith, John").verdict, "match");
eq("no match verdict", matchName({ first: "John", last: "Smith" }, "Robert Jones").verdict, "no_match");
eq("soundex Robert/Rupert", soundex("Robert"), soundex("Rupert"));

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
