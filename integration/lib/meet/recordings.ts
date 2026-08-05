/**
 * RecruitersOS · Meeting recordings -> summary + role brief
 *
 * The self-hosted meet server's recorder (Jibri) finalizes every call by
 * POSTing an audio-only copy to /api/meet/recording (cron-secret guarded).
 * This module stores the audio in the durable data dir, matches the room back
 * to its booking (rooms embed the booking id's first 8 chars), and a 5-minute
 * automation tick transcribes + summarizes each pending recording with Gemini
 * (audio understanding), then emails the workspace's booking mailbox:
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

const GEMINI_MODEL = () => process.env.RECRUITEROS_MEET_SUMMARY_MODEL || "gemini-3-flash-preview";
const geminiKey = () => (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();

const SUMMARY_PROMPT = `You are a recruiting operations analyst. Listen to this recorded business call between a recruiter and a client or candidate.

Return ONLY strict JSON with these keys:
{
  "summary": "5-10 sentence plain-language summary of the call",
  "action_items": ["each concrete follow-up that was agreed or implied, with owner if clear"],
  "role_brief": "If a job/role was discussed: what the client is looking for, written so a recruiter can present the role to candidates. Cover the mission of the role, must-haves, nice-to-haves, team and culture notes, compensation and benefits IF stated, and the genuine selling points. If no role was discussed, an empty string.",
  "objections_and_notes": ["hesitations, constraints, or context worth remembering"]
}

Absolute rule: use ONLY what is actually said on the call. Never invent names, numbers, compensation, or claims. No em-dashes in any text.`;

interface SummaryShape { summary?: string; action_items?: string[]; role_brief?: string; objections_and_notes?: string[] }

async function summarizeAudio(bytes: Buffer, mime: string): Promise<SummaryShape> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL()}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey() },
      body: JSON.stringify({
        contents: [{ parts: [
          { inlineData: { mimeType: mime, data: bytes.toString("base64") } },
          { text: SUMMARY_PROMPT },
        ] }],
        generationConfig: { temperature: 0 },
      }),
    },
  );
  if (!res.ok) throw new Error(`gemini_${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const out = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  const a = out.indexOf("{"), z = out.lastIndexOf("}");
  if (a < 0 || z <= a) throw new Error("summary_parse");
  return JSON.parse(out.slice(a, z + 1)) as SummaryShape;
}

function block(title: string, items?: string[]): string {
  if (!items || !items.length) return "";
  return `\n${title}\n${items.map((x) => `- ${x}`).join("\n")}\n`;
}

/** The 5-minute tick: process pending recordings once a Gemini key exists. */
export async function processRecordingQueue(): Promise<number> {
  await ensureLoaded();
  if (!geminiKey()) return 0;
  let done = 0;
  const targets = store.items.filter((r) => r.status === "pending" && r.attempts < 3).slice(0, 3);
  for (const r of targets) {
    r.attempts += 1;
    try {
      const bytes = await fs.readFile(path.join(dir(), r.file));
      if (bytes.length > 19 * 1024 * 1024) throw new Error("audio_too_large_for_inline");
      const s = await summarizeAudio(bytes, r.mime);

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
        `\nThe full recording is stored on the server (${r.file}).`;

      if (!ws) throw new Error("adhoc_room_unrouted: only booked-call rooms carry a workspace today");
      const { sendWorkspaceEmail } = await import("../auth");
      await sendWorkspaceEmail(to, `Call summary: ${r.guestName || r.room}`, body, ws);
      r.status = "done";
      r.summaryEmailedTo = to;
      r.error = undefined;
      done += 1;
    } catch (e) {
      r.error = String((e as Error)?.message || e).slice(0, 300);
      if (r.attempts >= 3) r.status = "failed";
    }
  }
  if (targets.length) persist();
  return done;
}
