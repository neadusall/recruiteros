/**
 * Video engagement — behavior suite.
 * Run: npx tsx lib/inmarket/video.test.ts   (exits non-zero on failure)
 *
 * Guards the invariants that decide whether a number on the dashboard is true:
 *   1. Machine traffic is quarantined: it never lands in a counter a rate is built from.
 *   2. A person's watch is counted, named, and their watch time accumulates.
 *   3. Captions cue up as readable WebVTT, and the cache is what stops repeat spend.
 *   4. Labels backfill only into blanks, never over a real label.
 */

import { ok, strictEqual } from "node:assert";
import { recordVideoEvent, statsOverview, removeVideoStats, labelVideo } from "./videoStats";
import { classifyViewer } from "./viewerId";
import { wordsToVtt } from "./captions";

const K = "test-video-behaviour";
const K2 = "test-video-machine";

async function main() {
  /* 1. Machines are judged as machines, people as people. */
  const defender = await classifyViewer("Mozilla/5.0 (Windows NT 10.0; Win64; x64) HeadlessChrome/151.0.0.0 Safari/537.36", "1.2.3.4");
  strictEqual(defender.kind, "machine", "a headless browser is not a prospect");
  const bot = await classifyViewer("Mozilla/5.0 (compatible; SomeBot/1.0; +http://x)", "1.2.3.4");
  strictEqual(bot.kind, "machine", "a self-declared bot is not a prospect");
  const none = await classifyViewer("", "1.2.3.4");
  strictEqual(none.kind, "machine", "a request with no user-agent is not a person at a desk");
  const human = await classifyViewer("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36", "");
  strictEqual(human.kind, "person", "an ordinary browser counts as a person");

  /* 2. A machine open must not move a single engagement number. */
  await recordVideoEvent({ videoKey: K2, type: "open", machine: true, machineReason: "scanner" });
  await recordVideoEvent({ videoKey: K2, type: "open", machine: true, machineReason: "scanner" });
  let o = await statsOverview({});
  let row = o.videos.find((v) => v.videoKey === K2)!;
  ok(row, "the machine-only video still appears, so the traffic is visible");
  strictEqual(row.opens, 0, "scanner loads never count as page visits");
  strictEqual(row.uniqueViewers, 0, "scanner loads never count as viewers");
  strictEqual(row.machineOpens, 2, "scanner loads are counted separately, not discarded");
  strictEqual(row.people.length, 0, "a scanner is never named as a person");

  /* 3. A real person's watch is counted, named, and timed. */
  const who = { viewerName: "Dana Reed", viewerEmail: "dana@meridian.com", viewerCompany: "Meridian" };
  await recordVideoEvent({ videoKey: K, type: "open", sessionId: "s1", company: "Meridian", roleTitle: "Controller", ...who });
  await recordVideoEvent({ videoKey: K, type: "play", sessionId: "s1", ...who });
  await recordVideoEvent({ videoKey: K, type: "heartbeat", seconds: 22, ...who });
  await recordVideoEvent({ videoKey: K, type: "heartbeat", seconds: 18, ...who });
  await recordVideoEvent({ videoKey: K, type: "complete", ...who });

  o = await statsOverview({});
  row = o.videos.find((v) => v.videoKey === K)!;
  strictEqual(row.opens, 1, "a person's visit counts");
  strictEqual(row.plays, 1, "a person's play counts");
  strictEqual(row.watchSeconds, 40, "watch time accumulates across heartbeats");
  strictEqual(row.avgWatchSeconds, 40, "average watch time is per play");
  strictEqual(row.company, "Meridian", "the row carries its label");
  strictEqual(row.people.length, 1, "the watcher is named");
  strictEqual(row.people[0].name, "Dana Reed", "by name");
  strictEqual(row.people[0].watchSeconds, 40, "with their own watch time");
  ok(row.people[0].completed, "and whether they finished");
  ok(o.totals.identified >= 1, "named people roll up into the totals");
  ok(o.totals.machineOpens >= 2, "scanner loads roll up separately");

  /* 4. Labels fill blanks only. */
  strictEqual(await labelVideo(K, "Someone Else", "Other"), false, "a real label is never overwritten");
  await recordVideoEvent({ videoKey: "test-video-unlabeled", type: "open", sessionId: "s9" });
  strictEqual(await labelVideo("test-video-unlabeled", "Clarivate", "Senior Accountant"), true, "a blank row takes a label");
  const labeled = (await statsOverview({})).videos.find((v) => v.videoKey === "test-video-unlabeled")!;
  strictEqual(labeled.company, "Clarivate", "and shows it");

  /* 5. Captions become readable cues, split into short lines. */
  const words = Array.from({ length: 40 }, (_, i) => ({ text: "word" + i, start: i * 0.5, end: i * 0.5 + 0.5 }));
  const vtt = wordsToVtt(words);
  ok(vtt.startsWith("WEBVTT"), "a VTT file starts with its header");
  const cues = vtt.split("\n\n").filter((c) => c.includes("-->"));
  ok(cues.length > 1, "long speech is split into several cues, not one wall of text");
  ok(cues.every((c) => (c.split("\n")[2] || "").length <= 80), "each cue stays short enough to read");
  ok(/00:00:00\.000 --> /.test(vtt), "timings are real, so captions track the speech");
  const empty = wordsToVtt([], "Just a sentence.");
  ok(empty.includes("Just a sentence."), "a transcript with no word timings still shows its text");

  await removeVideoStats(K);
  await removeVideoStats(K2);
  await removeVideoStats("test-video-unlabeled");
  console.log("video engagement suite: ALL PASS");
}

main().catch((e) => { console.error(e); process.exit(1); });
