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

// Claude's document-block API accepts application/pdf (up to 32MB).
// Other document types (doc, docx, txt) are not supported as inline
// Claude inputs — those would require OCR or text extraction first.
const ALLOWED_DOCUMENT_MIMETYPES = new Set([
  "application/pdf",
]);

function extFromMimetype(mimetype: string): string {
  switch (mimetype) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "application/pdf":
      return "pdf";
    default:
      throw new Error(`Unsupported mimetype for S3 upload: ${mimetype}`);
  }
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
 * Uploads an attachment (image or PDF) from an inbound WhatsApp message
 * to `home/messages/inbound/<uuid>.<ext>`. Returns the full S3 key. Used
 * by the async pipeline — the bot writes the bytes here, creates a
 * homeAttachment row pointing to the key, then invokes the agent.
 */
export async function uploadInboundAttachment(
  buffer: Buffer,
  mimetype: string
): Promise<string> {
  const isImage = ALLOWED_IMAGE_MIMETYPES.has(mimetype);
  const isDocument = ALLOWED_DOCUMENT_MIMETYPES.has(mimetype);
  if (!isImage && !isDocument) {
    throw new Error(
      `Unsupported attachment mimetype ${mimetype} ` +
        `(images: ${[...ALLOWED_IMAGE_MIMETYPES].join(",")}; ` +
        `documents: ${[...ALLOWED_DOCUMENT_MIMETYPES].join(",")})`
    );
  }
  const ext = extFromMimetype(mimetype);
  const key = `${MESSAGES_INBOUND_PREFIX}/${randomUUID()}.${ext}`;
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
