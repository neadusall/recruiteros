/*
 * Object-storage origin for PiP Studio's served artifacts.
 *
 * WHY: the per-recipient composites (.mp4 watch video, .gif email teaser) and the source
 * webcam clips are the only assets that scale with send volume — at 200k personalized videos
 * that's ~1.4–1.8 TB, which must NOT live on the 75 GB app server. Role-shot backgrounds stay
 * local: they're a small, bounded, regenerable per-role cache, not per-recipient.
 *
 * This is a thin S3-compatible wrapper (works with Hetzner Object Storage, AWS S3, MinIO, R2).
 * It is INERT until configured: when ROS_S3_BUCKET is unset, s3Enabled() is false and every
 * caller transparently falls back to the existing local-disk behavior — so deploying this code
 * with no env set changes nothing. Set the env (see below) + redeploy to switch the origin over.
 *
 * Required env to activate:
 *   ROS_S3_BUCKET            bucket name, e.g. "ros-pip-assets"
 *   ROS_S3_ENDPOINT          S3 endpoint, e.g. "https://fsn1.your-objectstorage.com" (Hetzner FSN1)
 *   ROS_S3_ACCESS_KEY_ID     access key
 *   ROS_S3_SECRET_ACCESS_KEY secret key
 * Optional:
 *   ROS_S3_REGION            default "auto" (Hetzner ignores it; AWS needs the real region)
 *   ROS_S3_FORCE_PATH_STYLE  "1" to force path-style URLs (needed by MinIO; Hetzner = leave unset)
 */

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

const BUCKET = process.env.ROS_S3_BUCKET;

/** True only when object storage is fully configured. Callers branch on this. */
export function s3Enabled(): boolean {
  return !!(BUCKET && process.env.ROS_S3_ENDPOINT && process.env.ROS_S3_ACCESS_KEY_ID && process.env.ROS_S3_SECRET_ACCESS_KEY);
}

let _client: S3Client | null = null;
function client(): S3Client {
  if (_client) return _client;
  _client = new S3Client({
    region: process.env.ROS_S3_REGION || "auto",
    endpoint: process.env.ROS_S3_ENDPOINT,
    forcePathStyle: process.env.ROS_S3_FORCE_PATH_STYLE === "1",
    credentials: {
      accessKeyId: process.env.ROS_S3_ACCESS_KEY_ID as string,
      secretAccessKey: process.env.ROS_S3_SECRET_ACCESS_KEY as string,
    },
  });
  return _client;
}

/** Upload bytes under `key` (e.g. "videos/abc.mp4"). Throws on failure so callers can keep the local copy. */
export async function s3Put(key: string, body: Buffer, contentType: string): Promise<void> {
  await client().send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
}

/** Fetch bytes for `key`, or null if absent / on any error. */
export async function s3Get(key: string): Promise<Buffer | null> {
  try {
    const out = await client().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    if (!out.Body) return null;
    const chunks: Buffer[] = [];
    // Body is a Node Readable stream in the Node runtime.
    for await (const chunk of out.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

/** True if `key` exists in the bucket. */
export async function s3Head(key: string): Promise<boolean> {
  try {
    await client().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Best-effort delete; swallows "not found". */
export async function s3Del(key: string): Promise<void> {
  try {
    await client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch {
    /* best-effort */
  }
}

export interface S3Entry {
  key: string;
  size: number;
  /** LastModified as epoch ms (0 when the store omits it). */
  at: number;
}

/**
 * List every object under `prefix` (paginated to completion). Used by the retention sweeper,
 * which must see the WHOLE prefix to age objects out — a truncated listing would silently
 * strand the tail forever. Returns [] on any error so a flaky store never crashes a tick.
 */
export async function s3List(prefix: string): Promise<S3Entry[]> {
  const out: S3Entry[] = [];
  try {
    let token: string | undefined;
    do {
      const page = await client().send(new ListObjectsV2Command({
        Bucket: BUCKET, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000,
      }));
      for (const o of page.Contents ?? []) {
        if (!o.Key) continue;
        out.push({ key: o.Key, size: o.Size ?? 0, at: o.LastModified ? o.LastModified.getTime() : 0 });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  } catch {
    return [];
  }
  return out;
}
