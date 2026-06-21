# Video Studio — Cloned-voice + lip-synced name personalization

This is the Sendspark-style "record once, render many" engine for RecruitersOS role videos. One base
recording becomes a personalized video per recipient: it opens with **"Hey {FirstName},"** spoken in
**your own cloned voice**, with the **mouth lip-synced** to that name, over the company's
auto-scrolling careers page, then plays your real recorded body. Everything after the greeting is
your genuine voice and footage.

We deliberately **beat Sendspark's #1 weakness**: they can only splice a name into one recording and
can't attach a real personalized intro to a longer generic body. We concatenate a real
greeting segment onto the base take, so the personalization is a true spoken+visual intro.

---

## How it works (pipeline)

1. **Record once** — the operator records one webcam clip (`/api/in-market/clip`).
2. **Clone the voice** — we pull the audio from that clip and mint an ElevenLabs **Instant Voice
   Clone** (`lib/inmarket/voiceClone.ts`). One voice id is stored per workspace and reused forever.
3. **Per recipient:**
   - **Name audio** — `lib/inmarket/nameAudio.ts` synthesizes `Hey {name},` in the cloned voice.
     **Cached per (voice, name)** so each name is synthesized exactly once, ever — the credit-saver.
   - **Lip-sync** — `lib/inmarket/lipSync.ts` sends a short face driver (first ~4s of the clip) +
     the name audio to a self-hosted lip-sync microservice, which re-renders the mouth to match the
     spoken name. **Cached per (clip, voice, name)** — lip-sync is the expensive step, so we never
     re-render a name we've already synced.
   - **Composite** — `lib/inmarket/roleVideo.ts` overlays the lip-synced face bubble over a hold of
     the careers-page scroll, then concatenates `[greeting] + [your real body take]` into the final
     MP4, and derives the inbox GIF teaser.
4. **Bulk** — `lib/inmarket/bulkVideo.ts` + `POST /api/in-market/bulk` render one video per name in a
   recipient list (up to 1,000 per request), behind a concurrency gate, non-blocking with polling.

**Graceful degradation** at every step: no lip-sync service → frozen-frame greeting (still your
cloned voice); no voice key → default voice or no spoken name; nothing breaks the base video.

---

## Setup

### 1. ElevenLabs (cloned voice) — required for the spoken name

Instant Voice Cloning is the right tool: it clones from a short (~15–60s) sample in seconds.
(Professional Voice Cloning needs 30+ minutes of audio and is overkill for a greeting.)

```
VOICE_CLONE_PROVIDER=elevenlabs        # default
VOICE_CLONE_API_KEY=<your elevenlabs api key>
VOICE_CLONE_VOICE_ID=<optional fallback voice id>   # used when a workspace hasn't cloned its own
RECRUITEROS_INTRO_VOICE_ID=<optional>  # overrides the default intro voice
```

- Plan: IVC is available on ElevenLabs **Starter ($5/mo)** and up (free tier for testing).
- Cost: minting a clone is free; only the per-name TTS bills (~1 credit/char; "Hey Sarah," ≈ a
  fraction of a cent), and our cache means each name bills **once**.
- Consent: you may only clone a voice you own or are authorized to use. The "Clone my voice" button
  uses the operator's own recording.

Cartesia and Hume adapters also ship (`VOICE_CLONE_PROVIDER=cartesia|hume`) but are bring-your-own
voice id (no clone-from-recording); ElevenLabs is the path for cloning from the clip.

### 2. Lip-sync microservice — optional but recommended

Lip-sync runs on a **self-hosted open-source model** (no per-video API spend). We don't bake one in —
you run a small inference service and point us at it:

```
LIPSYNC_URL=https://<your-lipsync-host>/sync   # unset = feature off (frozen-frame greeting)
LIPSYNC_API_KEY=<optional bearer/x-api-key>
LIPSYNC_MODEL=musetalk                          # informational, passed through to your service
LIPSYNC_TIMEOUT_MS=180000
```

**Service contract** (`POST {LIPSYNC_URL}`, `multipart/form-data`):

| field   | value                                            |
|---------|--------------------------------------------------|
| `face`  | the driving face video (mp4)                     |
| `audio` | the speech to sync to (mp3)                       |
| `model` | optional model hint (`LIPSYNC_MODEL`)            |

Respond `200` with the lip-synced video bytes (`video/mp4`). Any non-2xx makes us fall back to the
frozen-frame greeting.

#### Which model?

Only models that **edit an existing real video** (mouth inpainting/dubbing) fit here — single-image
"talking head" generators (SadTalker, Hallo, etc.) invent a new video and don't apply.
Of those, the **commercially licensable** options are:

| Model | License | Res | Speed / VRAM | Pick it when |
|-------|---------|-----|--------------|--------------|
| **MuseTalk 1.5** (recommended default) | MIT | 256px | Real-time (30fps+ on V100), runs on ~4GB | High volume, throughput, modest GPU |
| **LatentSync 1.6** | Apache-2.0 | 512px | Slow (diffusion), ~18GB | Best visual quality matters most |
| VideoReTalking | Apache-2.0 | 256px | Offline, ~8GB | Older fallback |

> ⚠️ **Do NOT use Wav2Lip (or its GFPGAN/HD forks) in production.** Its weights are **non-commercial
> only** ("personal/research/non-commercial purposes... commercial use is strictly prohibited"),
> doubled by the LRS2 data license. It's fine for a local demo, not for a paid product.

For our cold-outreach use case (thousands of ~1s greetings), **MuseTalk 1.5** is the default
recommendation — real-time, low VRAM, MIT. Use **LatentSync 1.6** on a 24GB GPU if you want 512px
sharpness. None run practically on CPU, so host the service on a GPU box (a single small GPU handles
the volume since greetings are short and cached per name).

A reference wrapper: containerize the model repo, expose one POST endpoint matching the contract
above (face + audio → mp4), set `LIPSYNC_URL` to it. The greeting is only ~1–1.5s, so inference is
fast and each name is cached after the first render.

---

## Recording for great lip-sync (operator guidance)

The lip-sync only re-renders the **first few seconds** (the name). To make it seamless:

1. **Start with your mouth closed / neutral**, looking at the camera. The model calibrates on the
   opening frames; a neutral closed-mouth start blends best.
2. **Good, even lighting on your face** — no harsh shadows across the mouth. Lips in clear focus.
3. **Hold still for the first second.** Minimal head motion at the start; big head movement during
   the name is the main source of artifacts.
4. **Record at 30fps, 720p+**, face filling a good part of the frame (it sits in the PiP bubble).
5. **Leave a tiny beat before you start talking** — that gives a clean seam between the spoken name
   and your body take.
6. **Quiet room, decent mic** — the same clip clones your voice, so background noise hurts both the
   clone and the sync. Aim for ~30–60s of clean speech for the best clone.

---

## Bulk personalization (thousands)

`POST /api/in-market/bulk` with `{ company, roleTitle, clipId, pip?, recipients:[{firstName,email?}] }`
(or `names:[]`). It returns each recipient's render status; **poll by re-POSTing** until all are
`ready`. Cache hits return instantly and never re-bill. Ready rows include signed `watch/gif/mp4`
share links (the watch page greets by name via `&n=`). Send larger lists in chunks of ≤1,000.

Concurrency is capped by `VIDEO_RENDER_CONCURRENCY` (default 2) so a big batch doesn't fork hundreds
of ffmpeg/GPU jobs at once.

---

## Files

| File | Role |
|------|------|
| `lib/voice/provider.ts` | Pluggable TTS/clone client (ElevenLabs `synthesize` + `createVoice`) |
| `lib/inmarket/voiceClone.ts` | Clone the operator's own voice from their clip; one voice/workspace |
| `lib/inmarket/nameAudio.ts` | "Hey {name}," synthesis, cached per (voice, name) |
| `lib/inmarket/lipSync.ts` | Pluggable self-hosted lip-sync microservice client |
| `lib/inmarket/roleVideo.ts` | Compositor: lip-synced greeting + body, over the page scroll |
| `lib/inmarket/bulkVideo.ts` | Bulk engine with concurrency gate + job tracking |
| `app/api/in-market/voice/route.ts` | Clone / forget / status |
| `app/api/in-market/bulk/route.ts` | Bulk render + poll |
| `app/api/in-market/video/route.ts` | Single render (resolves the workspace's cloned voice) |
