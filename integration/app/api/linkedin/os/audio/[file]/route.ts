/**
 * GET /api/linkedin/os/audio/[file]
 * Serves LinkedIn voice note audio (previews in the tool UI + the provider's
 * media fetch). Public by necessity, like /api/voice/audio: the provider has
 * no session. Only exposes opaque generated files from the voice dir.
 */

import { readAudioFile } from "../../../../../../lib/linkedin/os/voice";

export async function GET(_req: Request, { params }: { params: { file: string } }) {
  const bytes = await readAudioFile(params.file);
  if (!bytes) return new Response("not found", { status: 404 });
  const type = params.file.endsWith(".wav") ? "audio/wav" : "audio/mpeg";
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=86400",
    },
  });
}
