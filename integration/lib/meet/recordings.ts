/**
 * RecruitersOS · Meeting recordings -> summary + role brief
 *
 * The self-hosted meet server's recorder (Jibri) finalizes every call by
 * POSTing an audio-only copy to /api/meet/recording (cron-secret guarded).
 * This module stores the audio in the durable data dir, matches the room back
 * to its booking (rooms embed the booking id's first 8 chars), and a 5-minute
 * automation tick processes each pending recording in two stages:
 *
 *   Stage 1 (Gemini flash): audio -> verbatim transcript. Claude models cannot
 *     ingest audio, so the speech-to-text leg stays on Gemini; flash audio is
 *     already the cheapest tier for it. Audio over the inline limit is pushed
 *     through the Gemini Files API so long recordings still transcribe, and a
 *     transcript cut short by the output-token cap is continued in follow-up
 *     rounds until the whole call is on paper. The transcript is kept on disk
 *     beside the audio as a permanent text record of the call.
 *   Stage 2 (Claude Opus): transcript -> summary + action items + role brief.
 *     Call summaries are read by people making commitments off them, so this
 *     leg runs the strong model; volume is a handful of calls a day. Very long
 *     transcripts are summarized map-reduce style (notes per chunk, one merge
 *     pass) so nothing is silently truncated. If ANTHROPIC_API_KEY is absent,
 *     the tick falls back to the original single Gemini call that listens and
 *     summarizes in one shot, so summaries never stop over a missing key.
 *
 * The write-up is emailed to the workspace's booking mailbox:
 *
 *   1. a plain-language call summary + action items, and
 *   2. a "role brief": what the client actually wants, in a form a recruiter
 *      can use when presenting the job to candidates.
 *
 * No Gemini key on the server = recordings queue up untouched and process the
 * moment the key lands. Truth rule: the brief only contains what was said.
 */

import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { randomBytes } from "crypto";
import { loadSnapshot, debouncedSaver } from "../db";

export interface MeetRecording {
  id: string;
  room: string;
  /** File name inside the recordings dir. */
  file: string;
  mime: string;
  bytes: number;
  receivedAt: string;
  workspaceId?: string;
  bookingId?: string;
  guestName?: string;
  status: "pending" | "done" | "failed";
  attempts: number;
  summaryEmailedTo?: string;
  /** Transcript file name inside the recordings dir, once stage 1 has run. */
  transcriptFile?: string;
  /** Which model wrote the summary (for the audit trail in the store). */
  summaryModel?: string;
  error?: string;
}

interface Store { items: MeetRecording[] }

const SNAP_KEY = "meet_recordings_v1";
let store: Store = { items: [] };
let loaded: Promise<void> | null = null;
const persist = debouncedSaver(SNAP_KEY, () => store);

async function ensureLoaded(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      const snap = await loadSnapshot<Store>(SNAP_KEY);
      if (snap && Array.isArray(snap.items)) store = snap;
    })();
  }
  return loaded;
}

function dir(): string {
  if (process.env.ROS_DATA_DIR) return path.join(process.env.ROS_DATA_DIR, "meet-recordings");
  if (process.env.NODE_ENV === "production") return "/data/meet-recordings";
  return path.join(os.tmpdir(), "ros-meet-recordings");
}

const MAX_BYTES = 60 * 1024 * 1024;

/** Ingest one finished recording (already audio-only from the finalize hook). */
export async function saveRecording(room: string, mime: string, buf: Buffer): Promise<MeetRecording> {
  await ensureLoaded();
  if (!buf.length || buf.length > MAX_BYTES) throw Object.assign(new Error("bad_size"), { status: 400 });
  const cleanRoom = String(room || "").trim().slice(0, 120);
  if (!cleanRoom) throw Object.assign(new Error("room_required"), { status: 400 });
  const id = randomBytes(12).toString("hex");
  const ext = mime === "audio/ogg" ? ".ogg" : mime === "audio/mpeg" ? ".mp3" : mime === "audio/mp4" ? ".m4a" : ".bin";
  const file = id + ext;
  await fs.mkdir(dir(), { recursive: true });
  await fs.writeFile(path.join(dir(), file), buf);

  const rec: MeetRecording = {
    id, room: cleanRoom, file, mime, bytes: buf.length,
    receivedAt: new Date().toISOString(),
    status: "pending", attempts: 0,
  };
  // Rooms minted by the booking engine look like "<Brand>Call-<8 hex>".
  const m = /Call-([0-9a-f]{8})/i.exec(cleanRoom);
  if (m) {
    try {
      const { findBookingByRoomCode } = await import("../inmarket/booking");
      const hit = await findBookingByRoomCode(m[1]);
      if (hit) {
        rec.workspaceId = hit.workspaceId;
        rec.bookingId = hit.booking.id;
        rec.guestName = hit.booking.name;
      }
    } catch { /* unmatched rooms are still processed */ }
  }
  store.items.unshift(rec);
  if (store.items.length > 500) store.items.length = 500;
  persist();
  return rec;
}

/* ────────────────────────────── Models ────────────────────────────── */

const GEMINI_MODEL = () => process.env.RECRUITEROS_MEET_SUMMARY_MODEL || "gemini-3-flash-preview";
const geminiKey = () => (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
/** The summarizer. Claude cannot hear audio, so it reads the transcript. */
const CLAUDE_MODEL = () => process.env.RECRUITEROS_MEET_SUMMARY_CLAUDE_MODEL || "claude-opus-5";
const anthropicKey = () => (process.env.ANTHROPIC_API_KEY || "").trim();

/* ────────────────────────────── Prompts ────────────────────────────── */

const JSON_SHAPE = `Return ONLY strict JSON with these keys:
{
  "summary": "Plain-language summary of the call. 5-10 sentences for a short call; scale up to 20 sentences for a long one. Every decision, commitment, deadline, dollar figure, and named person that mattered must appear here or in the lists below; nothing important may be dropped no matter how long the call ran.",
  "action_items": ["each concrete follow-up that was agreed or implied, with owner and deadline if stated"],
  "role_brief": "If a job/role was discussed: what the client is looking for, written so a recruiter can present the role to candidates. Cover the mission of the role, must-haves, nice-to-haves, team and culture notes, compensation and benefits IF stated, and the genuine selling points. If no role was discussed, an empty string.",
  "objections_and_notes": ["hesitations, constraints, or context worth remembering"]
}

Absolute rule: use ONLY what is actually said on the call. Never invent names, numbers, compensation, or claims. No em-dashes in any text.`;

const TRANSCRIBE_PROMPT = `Transcribe this recorded business call verbatim. Label each turn "Speaker 1:", "Speaker 2:" and so on, keeping each speaker's label consistent. Return ONLY the transcript text, no preamble and no commentary.

If the audio contains no intelligible human speech (silence, tones, music, noise), return exactly NO_SPEECH and nothing else. Never invent dialogue that is not audibly present.`;

const AUDIO_SUMMARY_PROMPT = `You are a recruiting operations analyst. Listen to this recorded business call between a recruiter and a client or candidate.

If the audio contains no intelligible human speech (silence, tones, music, noise), return exactly NO_SPEECH instead of the JSON. Never invent dialogue that is not audibly present.

${JSON_SHAPE}`;

const TRANSCRIPT_SUMMARY_PROMPT = `You are a recruiting operations analyst. Below is the transcript of a recorded business call between a recruiter and a client or candidate.

${JSON_SHAPE}`;

/* ─────────────────────────── Model calls ─────────────────────────── */

interface SummaryShape { summary?: string; action_items?: string[]; role_brief?: string; objections_and_notes?: string[] }

/** Coerce model output into a safe shape and reject write-ups with no substance. */
function parseSummaryJson(out: string): SummaryShape {
  const a = out.indexOf("{"), z = out.lastIndexOf("}");
  if (a < 0 || z <= a) throw new Error("summary_parse");
  const raw = JSON.parse(out.slice(a, z + 1)) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
  const s: SummaryShape = {
    summary: str(raw.summary).trim(),
    action_items: list(raw.action_items),
    role_brief: str(raw.role_brief).trim(),
    objections_and_notes: list(raw.objections_and_notes),
  };
  if (!s.summary) throw new Error("summary_empty");
  return s;
}

/** Single-pass ceiling, ~150K tokens: far below Opus's 1M window but keeps one call sane. */
const MAX_TRANSCRIPT_CHARS = 600_000;
/** Map-reduce chunk size for transcripts beyond the single-pass ceiling. */
const CHUNK_CHARS = 400_000;
const GEMINI_TIMEOUT_MS = 180_000;
/** Above this, inline base64 audio is rejected by Gemini; use the Files API instead. */
const INLINE_AUDIO_LIMIT = 19 * 1024 * 1024;
/** 8 continuation rounds of transcript output covers calls far longer than any real meeting. */
const MAX_TRANSCRIBE_ROUNDS = 8;

interface GeminiResult { text: string; finishReason: string }

async function geminiGenerate(contents: Array<Record<string, unknown>>): Promise<GeminiResult> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL()}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey() },
      body: JSON.stringify({ contents, generationConfig: { temperature: 0 } }),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`gemini_${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as {
    candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>;
  };
  const cand = data.candidates?.[0];
  return {
    text: (cand?.content?.parts || []).map((p) => p.text || "").join(""),
    finishReason: cand?.finishReason || "",
  };
}

/** Push oversized audio through the Gemini Files API and wait until it is usable. */
async function uploadAudioToGemini(bytes: Buffer, mime: string): Promise<string> {
  const start = await fetch("https://generativelanguage.googleapis.com/upload/v1beta/files", {
    method: "POST",
    headers: {
      "x-goog-api-key": geminiKey(),
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
      "X-Goog-Upload-Header-Content-Type": mime,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: "meet-recording" } }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!start.ok) throw new Error(`gemini_upload_start_${start.status}`);
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("gemini_upload_no_url");

  const up = await fetch(uploadUrl, {
    method: "POST",
    headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(300_000),
  });
  if (!up.ok) throw new Error(`gemini_upload_${up.status}`);
  const meta = (await up.json()) as { file?: { name?: string; uri?: string; state?: string } };
  const name = meta.file?.name;
  const uri = meta.file?.uri;
  let state = meta.file?.state;
  if (!uri || !name) throw new Error("gemini_upload_no_uri");

  // Audio is processed server-side before it can be referenced in a prompt.
  for (let i = 0; i < 30 && state === "PROCESSING"; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const poll = await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}`, {
      headers: { "x-goog-api-key": geminiKey() },
      signal: AbortSignal.timeout(30_000),
    });
    if (!poll.ok) throw new Error(`gemini_file_poll_${poll.status}`);
    state = ((await poll.json()) as { state?: string }).state;
  }
  if (state !== "ACTIVE") throw new Error(`gemini_file_state_${state || "unknown"}`);
  return uri;
}

/** Audio as a Gemini content part: inline when small, Files API when large. */
async function geminiAudioPart(bytes: Buffer, mime: string): Promise<Record<string, unknown>> {
  if (bytes.length <= INLINE_AUDIO_LIMIT) {
    return { inlineData: { mimeType: mime, data: bytes.toString("base64") } };
  }
  return { fileData: { mimeType: mime, fileUri: await uploadAudioToGemini(bytes, mime) } };
}

const TRANSCRIBE_CONTINUE_PROMPT =
  "Continue the transcript exactly where it stopped. Do not repeat lines already transcribed and do not add commentary.";

/** The models' "there is nothing to transcribe" marker, tolerant of punctuation. */
const NO_SPEECH_RE = /^\W*NO[_ ]?SPEECH\W*$/i;

/** Stage 1: Gemini flash turns the audio into a verbatim transcript, continuing past output caps. */
async function transcribeAudio(audioPart: Record<string, unknown>): Promise<string> {
  const contents: Array<Record<string, unknown>> = [
    { role: "user", parts: [audioPart, { text: TRANSCRIBE_PROMPT }] },
  ];
  let transcript = "";
  for (let round = 0; round < MAX_TRANSCRIBE_ROUNDS; round++) {
    const { text, finishReason } = await geminiGenerate(contents);
    transcript += (transcript && text.trim() ? "\n" : "") + text.trim();
    if (finishReason !== "MAX_TOKENS") {
      // Silence, tones, or music: fail loudly rather than let a model invent a call.
      if (NO_SPEECH_RE.test(transcript)) throw new Error("no_speech_detected");
      if (transcript.length < 10) throw new Error("transcript_empty");
      return transcript;
    }
    // The model ran out of output room mid-call: ask it to keep going.
    contents.push({ role: "model", parts: [{ text }] });
    contents.push({ role: "user", parts: [{ text: TRANSCRIBE_CONTINUE_PROMPT }] });
  }
  // Failing loudly beats mailing a summary that is missing the end of the call.
  throw new Error("transcript_incomplete_after_max_rounds");
}

const CHUNK_NOTES_PROMPT = `You are a recruiting operations analyst. Below is ONE PART of the transcript of a long recorded business call between a recruiter and a client or candidate. Write exhaustive plain-text notes on this part: every decision, commitment, date, deadline, dollar figure, name, role requirement, objection, and open question, in the order they occur. Use ONLY what is actually said; never invent anything. No em-dashes. Return the notes only, no preamble.`;

const MERGE_NOTES_PROMPT = `You are a recruiting operations analyst. Below are sequential notes covering the full transcript of one long recorded business call between a recruiter and a client or candidate, in order.

${JSON_SHAPE}`;

async function claudeText(content: string): Promise<string> {
  const { anthropicClient } = await import("../sourcing/anthropic");
  const msg = await anthropicClient().messages.create({
    model: CLAUDE_MODEL(),
    max_tokens: 16000,
    messages: [{ role: "user", content }],
  });
  // A refused or truncated reply cannot be trusted; throw so the Gemini fallback ships instead.
  // The installed SDK's stop_reason union predates "refusal", hence the widening cast.
  if ((msg.stop_reason as string) === "refusal") throw new Error("summary_refused");
  if (msg.stop_reason === "max_tokens") throw new Error("summary_truncated");
  return msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

/** Stage 2: Claude writes the summary + role brief from the transcript. */
async function summarizeTranscript(transcript: string): Promise<SummaryShape> {
  if (transcript.length <= MAX_TRANSCRIPT_CHARS) {
    return parseSummaryJson(
      await claudeText(`${TRANSCRIPT_SUMMARY_PROMPT}\n\nTranscript:\n${transcript}`),
    );
  }
  // Marathon transcript: notes per chunk, then one merge pass, so no part is dropped.
  const notes: string[] = [];
  for (let i = 0; i < transcript.length; i += CHUNK_CHARS) {
    const part = transcript.slice(i, i + CHUNK_CHARS);
    notes.push(await claudeText(`${CHUNK_NOTES_PROMPT}\n\nTranscript part ${notes.length + 1}:\n${part}`));
  }
  return parseSummaryJson(
    await claudeText(`${MERGE_NOTES_PROMPT}\n\n${notes.map((n, i) => `Notes for part ${i + 1}:\n${n}`).join("\n\n")}`),
  );
}

/** Fallback: the original single Gemini call that listens and summarizes. */
async function summarizeAudio(audioPart: Record<string, unknown>): Promise<SummaryShape> {
  const { text } = await geminiGenerate([
    { role: "user", parts: [audioPart, { text: AUDIO_SUMMARY_PROMPT }] },
  ]);
  if (NO_SPEECH_RE.test(text.trim())) throw new Error("no_speech_detected");
  return parseSummaryJson(text);
}

function block(title: string, items?: string[]): string {
  if (!items || !items.length) return "";
  return `\n${title}\n${items.map((x) => `- ${x}`).join("\n")}\n`;
}

/**
 * Get a transcript for the recording, paying for transcription at most once:
 * a transcript already on disk from an earlier attempt is reused as-is.
 */
async function ensureTranscript(
  r: MeetRecording,
  audioPart: () => Promise<Record<string, unknown>>,
): Promise<string> {
  if (r.transcriptFile) {
    try {
      const prev = (await fs.readFile(path.join(dir(), r.transcriptFile), "utf8")).trim();
      if (prev.length >= 10) return prev;
    } catch { /* transcript file lost: transcribe again below */ }
  }
  const transcript = await transcribeAudio(await audioPart());
  const tFile = r.file.replace(/\.[^.]+$/, "") + ".txt";
  try {
    await fs.writeFile(path.join(dir(), tFile), transcript, "utf8");
    r.transcriptFile = tFile;
  } catch { /* a failed disk write must not block the summary */ }
  return transcript;
}

/** One tick at a time: a slow model call must never overlap the next tick. */
let ticking = false;

/** The 5-minute tick: process pending recordings once a Gemini key exists. */
export async function processRecordingQueue(): Promise<number> {
  await ensureLoaded();
  if (!geminiKey()) return 0;
  if (ticking) return 0;
  ticking = true;
  try {
    return await runQueuePass();
  } finally {
    ticking = false;
  }
}

async function runQueuePass(): Promise<number> {
  let done = 0;
  const targets = store.items.filter((r) => r.status === "pending" && r.attempts < 3).slice(0, 3);
  for (const r of targets) {
    r.attempts += 1;
    try {
      const bytes = await fs.readFile(path.join(dir(), r.file));
      // Built (and, for large files, uploaded) only if a Gemini leg actually runs.
      let cachedPart: Record<string, unknown> | null = null;
      const audioPart = async () => (cachedPart ??= await geminiAudioPart(bytes, r.mime));

      // Two-stage when the Anthropic key is present (Gemini transcribes, Claude
      // writes); single Gemini listen-and-summarize call otherwise. A Claude
      // failure after a good transcript falls back to the one-shot Gemini call
      // in the same attempt, so a write-up still ships.
      let s: SummaryShape;
      if (anthropicKey()) {
        const transcript = await ensureTranscript(r, audioPart);
        try {
          s = await summarizeTranscript(transcript);
          r.summaryModel = CLAUDE_MODEL();
        } catch (claudeErr) {
          s = await summarizeAudio(await audioPart());
          r.summaryModel = `${GEMINI_MODEL()} (claude_failed: ${String((claudeErr as Error)?.message || claudeErr).slice(0, 80)})`;
        }
      } else {
        s = await summarizeAudio(await audioPart());
        r.summaryModel = GEMINI_MODEL();
      }

      // Route the write-up: the booking's workspace mailbox first, the global
      // fallback mailbox (env) for ad-hoc rooms.
      let to = (process.env.RECRUITEROS_MEET_SUMMARY_EMAIL || "").trim();
      let ws = r.workspaceId || "";
      if (ws) {
        try {
          const { getSettings } = await import("../inmarket/videoSettings");
          const vs = await getSettings(ws);
          if ((vs.bookingEmail || "").trim()) to = (vs.bookingEmail as string).trim();
        } catch { /* fall through to env fallback */ }
      }
      if (!to) throw new Error("no_summary_recipient: set RECRUITEROS_MEET_SUMMARY_EMAIL");

      const who = r.guestName ? `with ${r.guestName}` : `(room ${r.room})`;
      const body =
        `Call summary ${who}, recorded ${new Date(r.receivedAt).toLocaleString()}.\n\n` +
        `${(s.summary || "").trim()}\n` +
        block("Action items", s.action_items) +
        ((s.role_brief || "").trim()
          ? `\nRole brief, ready to present to candidates\n${(s.role_brief as string).trim()}\n`
          : "") +
        block("Worth remembering", s.objections_and_notes) +
        `\nThe full recording${r.transcriptFile ? " and transcript are" : " is"} stored on the server (${r.file}${r.transcriptFile ? `, ${r.transcriptFile}` : ""}).`;

      if (!ws) throw new Error("adhoc_room_unrouted: only booked-call rooms carry a workspace today");
      const { sendWorkspaceEmail } = await import("../auth");
      await sendWorkspaceEmail(to, `Call summary: ${r.guestName || r.room}`, body, ws);
      r.status = "done";
      r.summaryEmailedTo = to;
      r.error = undefined;
      done += 1;
    } catch (e) {
      r.error = String((e as Error)?.message || e).slice(0, 300);
      // Silent audio never becomes speech: fail now instead of burning retries.
      if (r.attempts >= 3 || r.error.startsWith("no_speech")) r.status = "failed";
    }
  }
  if (targets.length) persist();
  return done;
}
