import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";

// The agent Lambda has read-only access to the home/agent-uploads/ prefix
// (for legacy synchronous / web-UI uploads) and home/messages/ (for the
// async WhatsApp pipeline). Both prefixes are writable by the bot's ECS
// task role (see backend.ts).
const s3 = new S3Client({});
const BUCKET = process.env.HOME_HUB_BUCKET ?? "";
if (!BUCKET) {
  throw new Error("HOME_HUB_BUCKET env var must be set");
}
const AGENT_UPLOADS_PREFIX = "home/agent-uploads";
const MESSAGES_INBOUND_PREFIX = "home/messages/inbound";

// Claude's image-block API accepts jpeg/png/gif/webp only. HEIC (common on
// iPhone) would round-trip through WA as image/jpeg after the phone's
// share sheet, but if it ever arrives as image/heic the agent handler
// will choke — reject early here with a clear error.
const ALLOWED_IMAGE_MIMETYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// Inbound attachments beyond what Claude can read: PDFs go to Claude as
// document blocks; video/audio (ultrasound clips, voice notes) and other
// files are stored so the agent can attach_file them to a record. Keep in
// step with lib/attachment-types.ts in the web app.
const INBOUND_MIMETYPE_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/3gpp": "3gp",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/webm": "weba",
  "audio/flac": "flac",
  "audio/amr": "amr",
  "application/dicom": "dcm",
  "application/zip": "zip",
};

/** "audio/ogg; codecs=opus" → "audio/ogg". */
export function normalizeMimetype(mimetype: string): string {
  return (mimetype ?? "").split(";")[0].trim().toLowerCase();
}

export function isSupportedInboundMimetype(mimetype: string): boolean {
  return normalizeMimetype(mimetype) in INBOUND_MIMETYPE_EXT;
}

export function extFromMimetype(mimetype: string): string {
  const ext = INBOUND_MIMETYPE_EXT[normalizeMimetype(mimetype)];
  if (!ext) throw new Error(`Unsupported mimetype for S3 upload: ${mimetype}`);
  return ext;
}

/**
 * Uploads an image buffer to the agent-uploads prefix and returns the full
 * S3 key (e.g. `home/agent-uploads/<uuid>.jpg`). Legacy synchronous path
 * used for AppSync-mode invocations. New async path uses
 * `uploadInboundAttachment` instead.
 */
export async function uploadAgentImage(
  buffer: Buffer,
  mimetype: string
): Promise<string> {
  if (!ALLOWED_IMAGE_MIMETYPES.has(mimetype)) {
    throw new Error(
      `Unsupported image mimetype ${mimetype} (allowed: ${[...ALLOWED_IMAGE_MIMETYPES].join(", ")})`
    );
  }

  const ext = extFromMimetype(mimetype);
  const key = `${AGENT_UPLOADS_PREFIX}/${randomUUID()}.${ext}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimetype,
    })
  );

  return key;
}

/**
 * Uploads an attachment (image, PDF, video, audio…) from an inbound
 * WhatsApp message to `home/messages/inbound/<uuid>.<ext>`. Returns the
 * full S3 key. Used by the async pipeline — the bot writes the bytes
 * here, creates a homeAttachment row pointing to the key, then invokes
 * the agent.
 */
export async function uploadInboundAttachment(
  buffer: Buffer,
  mimetype: string
): Promise<string> {
  const type = normalizeMimetype(mimetype);
  if (!isSupportedInboundMimetype(type)) {
    throw new Error(
      `Unsupported attachment mimetype ${mimetype} (allowed: ${Object.keys(INBOUND_MIMETYPE_EXT).join(", ")})`
    );
  }
  const ext = extFromMimetype(type);
  const key = `${MESSAGES_INBOUND_PREFIX}/${randomUUID()}.${ext}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: type,
    })
  );
  return key;
}
